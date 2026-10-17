# Research A2 — Relay server: Railway, `ws`, Fastify, fan-out patterns, security, observability

Status: research note (architect), 2026-10-17. Sources verified via official docs / source code on that
date; versions recorded next to each claim. Unverified statements are marked `[TODO verify]`.
Scope: the `server` and `deploy` components (relay on Railway, Node.js 22 LTS, TypeScript, `ws`, Fastify).

## Key findings for the design

- **Railway WebSockets have no edge timeout.** The edge closes idle HTTP/1.1 connections after 60 s and
  caps HTTP requests at 15 min, but "Websocket connections are exempt from these duration and inactivity
  limits, and can stay open indefinitely, even while idle" (Railway specs & limits, 2026-10). Keep our own
  ping/pong heartbeat anyway (NAT/mobile radios, half-open sockets). Limits that do apply: 32 KB combined
  headers, ~10,000 concurrent connections per domain, no documented request/response body size limit.
- **`railway.json` / `railway.toml` is deprecated.** New services can no longer opt in; existing files stop
  being read on **2026-12-01**. Replacement: Infrastructure as Code `.railway/railway.ts` (+ CLI
  `railway config plan/apply`) or dashboard settings. The `deploy` component must plan for IaC, not
  config-as-code (CLAUDE.md still lists `railway.*`; flag for `release`).
- **Railway injects `PORT`**; the app must listen on it (healthcheck uses it). Healthchecks run only at
  deploy time (default timeout 300 s, requests come from host `healthcheck.railway.app`), not continuously.
- **Redeploy = full in-memory state loss + all WebSockets dropped.** New deployment becomes Active after the
  healthcheck passes, then the old one receives SIGTERM with **0 s** grace by default (SIGKILL immediately);
  set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (e.g. 30) and handle SIGTERM by sending a close frame with a
  "relay restarting" code so clients reconnect. Sessions cannot survive a deploy without external storage,
  which we do not want; the protocol must make reconnection cheap (publisher re-creates the session with a
  resume token and preferably the same code; viewers retry the same code).
- **Single replica is mandatory** for an in-memory registry: Railway load-balances randomly across replicas
  and has no sticky sessions. Do not enable Serverless (app sleeping); the always-open Slicer socket and
  heartbeats produce outbound packets, which prevent sleep anyway.
- **Edge HTTP logs record method, path, host, status, client IP, user agent, bytes, timing** per request,
  retained 7 days (Hobby) / 30 days (Pro). Whether the query string is included is not documented
  `[TODO verify]` → treat path *and* query as logged: codes/tokens only in WebSocket message bodies (or a
  POST body), never in `GET /join/ABCDE` or `?code=`.
- **Costs (2026-10):** Hobby $5/month incl. $5 usage, Pro $20 incl. $20; usage $20/vCPU-month,
  $10/GB-RAM-month, egress $0.05/GB. A relay idling at 0.1 vCPU / 256 MB costs ~$4.5/month; egress of
  150 GB/month (1,000 sessions × 50 MB × 3 viewers) adds $7.50. EU region: "EU West Metal", Amsterdam,
  id `europe-west4-drams3a`; plan availability for Hobby is contradictory in sources `[TODO verify]`.
- **`ws` 8.22.0:** `maxPayload` default 100 MiB (we set it per socket class: publisher ~64 MiB, viewers
  ~64 KiB); `ws` never fragments outgoing messages and reassembles incoming fragments up to `maxPayload`;
  backpressure only via `socket.bufferedAmount` + `send()` callback; `perMessageDeflate` is **off** by
  default on the server and the maintainers advise against enabling it (zlib memory fragmentation).
- **Fastify 5.12.7 + `@fastify/websocket` 11.3.4** is the simplest integration: same HTTP server, same
  origin for the static viewer (`@fastify/static` 10.1.6), Fastify hooks (rate limit, auth) run before the
  upgrade, handler gets the raw `ws` socket. Trade-off: WebSocket errors bypass Fastify error handling and
  upgraded sockets must be closed in `preClose`.
- **Code space:** alphabet without `0 O 1 I L` has **31 symbols**, 31^5 = **28,629,151** codes (24.8 bits).
  Brute force is bounded by rate limiting, not entropy: at 10 attempts/min/IP, hitting one of 100 active
  sessions needs ~20 days on average (28,629,151 / 100 / 10 per min ≈ 28,629 min; corrected 2026-10-17, an earlier draft said 2.4 months); enforce per-IP limits with `@fastify/rate-limit` 11.2.1
  (`trustProxy` on, Railway edge sets `X-Forwarded-For`), bind the code to a per-session join nonce, expire
  codes (TTL), and invalidate on N failed attempts per session.
- **Observability:** pino 10.4.0 with `redact` paths (`code`, `token`, `*.code`, `req.headers.authorization`),
  log *sizes and counts* of GLB blobs never contents; Railway parses JSON lines with `message` + `level`;
  500 log lines/s/replica cap; protect `/metrics` with a bearer token or disable it (Railway gives
  CPU/RAM/network metrics per service, 30 days, no Prometheus scraping).
- **Node.js 22 "Jod"** is in Maintenance LTS since 2025-10-21 (EOL 2027-04-30); Node 24 is Active LTS. Native
  `WebSocket` client is stable since 22.4.0 (useful for `tools/fake-slicer` and tests). Set
  `NODE_OPTIONS=--max-old-space-size=<MiB>` to ~75 % of the Railway memory limit (or
  `--max-old-space-size-percentage=75`), because GLB buffers live on the heap (`Buffer` pool is off-heap, but
  retained copies and WS frame buffers count).
- **Docker:** `node:22-alpine` (61 MB compressed) vs `node:22-bookworm-slim` (80 MB). We have no native
  add-ons (skip `bufferutil`), so Alpine is fine; multi-stage build, `USER node`, `CMD ["node", ...]`
  (not `npm start`) so SIGTERM reaches the process; add `--init`/`dumb-init` if the process is PID 1.
- **Python/FastAPI alternative** works but needs more tuning for our payloads: uvicorn `--ws-max-size`
  default 16 MiB, python-websockets `max_size` default 1 MiB, permessage-deflate **on** by default
  (64 KiB/connection), no `bufferedAmount` API in Starlette; single process required anyway.

---

## 1. Railway

### 1.1 Deploying from a Dockerfile

- Railway auto-detects a file named exactly `Dockerfile` at the root of the service source directory
  ("Using detected Dockerfile!" in build logs); another path via service variable `RAILWAY_DOCKERFILE_PATH`
  (e.g. `relay-server/Dockerfile`). Railway "always builds with a Dockerfile if one exists" even when the
  builder setting is Railpack. Source: Railway docs, Dockerfiles guide (2026-10).
- Build-time variables (own and Railway-provided) are available only when declared with `ARG` in the
  stage that needs them. Cache mounts must use the id form
  `--mount=type=cache,id=s/<service id>-<target path>,target=<target path>`; env vars are not allowed in
  the id. The presence of `--mount=type=cache` implies BuildKit, but the docs do not say so `[TODO verify]`.
- **Build context:** not documented. For an isolated monorepo, the service's *Root Directory* setting
  makes Railway "only pull down files from that directory", which implies the context is the root
  directory `[TODO verify]`. For this monorepo the simplest option is Root Directory `/` with
  `RAILWAY_DOCKERFILE_PATH=relay-server/Dockerfile`, so the Dockerfile can `COPY shared/ relay-server/
  web-viewer/` (the relay serves the built viewer). Watch paths (gitignore-style) restrict which changes
  trigger deploys, e.g. `relay-server/**`, `shared/**`, `web-viewer/**`.
- `.dockerignore` support is not mentioned in the docs `[TODO verify]` (standard Docker behaviour expected).

### 1.2 Config as code → Infrastructure as Code

- `railway.json` / `railway.toml` keys (for reference, legacy): `build.builder` (`RAILPACK` | `DOCKERFILE`),
  `build.dockerfilePath`, `build.watchPatterns`, `deploy.startCommand`, `deploy.preDeployCommand`,
  `deploy.healthcheckPath`, `deploy.healthcheckTimeout`, `deploy.restartPolicyType`
  (`ON_FAILURE` | `ALWAYS` | `NEVER`), `deploy.restartPolicyMaxRetries`, `deploy.overlapSeconds`,
  `deploy.drainingSeconds`, `deploy.multiRegionConfig` (`{ "<region id>": { "numReplicas": n } }`),
  `environments.<name>` overrides; schema `https://railway.com/railway.schema.json`. The docs page states
  Config as Code "is deprecated. Existing files work for legacy services until 2026-12-01".
- Replacement: **Infrastructure as Code**, one file `.railway/railway.ts` (GA; `.py`/`.go` beta), project
  scoped: `service("relay", { build, start, healthcheck: "/health", env, replicas, ... })`. CLI:
  `railway config init | pull | plan | apply [--yes] [--confirm-destructive]`, migration
  `railway config migrate [--apply] [--delete-files]`. GitHub Action `railwayapp/config` plans on PRs
  touching `.railway/**` and applies on merge (needs `RAILWAY_TOKEN` project token). A service cannot be
  managed by both systems. Which IaC fields map to `drainingSeconds`, `overlapSeconds`, region, restart
  policy, Dockerfile path: not on the overview page `[TODO verify]` in the IaC reference before writing
  `deploy` tasks. Changelog (2026-08-20) ties the cut-off for new services to projects created from
  2026-08-28.
- Everything IaC can set can also be set in the dashboard or via Railway-provided variables
  (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`,
  `RAILWAY_DOCKERFILE_PATH`), which is a reasonable fallback for a single service.

### 1.3 `PORT`, networking, WebSockets, limits

- `PORT`: the healthcheck docs state "Railway injects a `PORT` variable, and health checks use its value";
  if you configure target ports manually you must set `PORT` yourself. Oddly the variables reference page
  does not list `PORT`; rely on the healthcheck/networking pages. Listen on `0.0.0.0:${PORT}`.
- Public networking: generated domain `<name>.up.railway.app` (not automatic — click "Generate Domain");
  if the app listens on one port it is detected, otherwise you pick the target port.
- Specs & limits page (2026-10): HTTP request up to 15 min while data flows, else closed after 5 min idle;
  request body upload must finish within 5 min; idle HTTP/1.1 connections closed after 60 s between requests
  (not applied to HTTP/2 or WebSockets); **WebSockets exempt from duration/inactivity limits**; max header
  size 32 KB combined; TLS 1.2/1.3 only; HTTP/2 and HTTP/1.1 (incl. WebSockets) supported; ~10,000 concurrent
  connections and ~11,000 req/s per domain, 10,000 requests per connection; **no body size limit stated**
  (community staff answers say "no max payload size" — not official). The 32 KB header cap is irrelevant
  for us as long as codes/tokens travel in the first WebSocket *message*, not in headers/cookies.
- Community reports of edge-side WebSocket drops (waves of close code 1006, ~50 min) exist without a
  confirmed cause; Railway staff state no guaranteed lifetime. Design consequence: automatic reconnect with
  backoff on every client, server tolerates publisher absence for a grace period.

### 1.4 Healthchecks

- `healthcheckPath` (e.g. `/health`) must return 2xx; default timeout 300 s (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`);
  requests originate from host `healthcheck.railway.app` (do not reject by Host header). Deploy-time only;
  for continuous monitoring use an external pinger. With a healthcheck configured, zero-downtime deploys wait
  until it passes before switching traffic; services with volumes get brief downtime (we have none).
- `/health` should not touch session data; return `{status:"ok", uptime, sessions:<count>}` at most.

### 1.5 Custom domains and TLS

- Let's Encrypt certificates (ECDSA), issued automatically within ~1 h of DNS being correct, 90-day validity,
  auto-renew at 30 days left; external certificates not supported. Custom domains require **both** CNAME and
  TXT records. Limits: Trial 1, Hobby 2 per service, Pro 20 per service. Cloudflare proxy: SSL mode must be
  "Full" (not Strict, not Flexible — Flexible causes a redirect loop because Railway redirects HTTP→HTTPS per
  the troubleshooting guide); proxied domains may fall back to the `*.up.railway.app` certificate. Railway
  does not publish a static edge IP (community/staff). The generated `*.up.railway.app` domain is sufficient
  for MVP; the viewer must be served over HTTPS anyway (WebXR and `wss://` require a secure context).

### 1.6 Regions

- Regions (2026-10): US West Metal `us-west2`, US East Metal `us-east4-eqdc4a`, **EU West Metal, Amsterdam,
  `europe-west4-drams3a`**, Southeast Asia Metal `asia-southeast1-eqsg3a`. Default = account's preferred
  region; region can be changed any time without downtime (no volume). Plan gating: an older docs version
  said EU is Pro-only, a 2025 moderator answer says Hobby can use EU metal (feature flag), the current page
  says nothing → `[TODO verify]` in the dashboard before choosing Hobby. For medical data in transit, the
  EU region is preferable (GDPR data-residency expectations), even though nothing is stored.

### 1.7 Plans, pricing, sleeping, replicas

- Plans (railway.com/pricing, 2026-10): Free $0 ($1 credit, 1 vCPU/0.5 GB, 1 replica, 3-day logs, 0 custom
  domains); Hobby $5 incl. $5 usage (48 vCPU/48 GB max per service, 6 replicas, 7-day logs, 3 seats);
  Pro $20/workspace incl. $20 usage (1,000 vCPU/1 TB, 42 replicas, 30-day logs, unlimited seats).
  Usage: $20/vCPU/month ($0.000463/min), $10/GB RAM/month ($0.000231/min), egress $0.05/GB, volumes
  $0.15/GB/month. Billing is by actual usage per second; Railway autoscales vertically up to the plan cap,
  so a memory leak costs money before it OOMs — set `--max-old-space-size` and a per-session memory budget.
- **Serverless / app sleeping** is opt-in per service; a service sleeps after ~5–10 min without *outbound*
  packets; first request after sleep may return 502. Not suitable for a relay; leave off.
- **Replicas:** manual count; traffic "randomly distributed" across replicas, "sticky sessions: not
  supported"; `RAILWAY_REPLICA_ID` identifies a replica. In-memory sessions → exactly 1 replica; document this
  as an explicit limit (ADR). Scaling out later requires Redis pub/sub or consistent routing by code, which
  Railway's edge cannot do.
- **Restart policy:** default On Failure, max 10 retries (paid plans can set any number); Always not on Free.
  OOM handling is not documented `[TODO verify]`; assume a crash → restart → empty registry.

### 1.8 Deploy/restart behaviour and in-memory state

- Lifecycle: Initializing → Building → Deploying (waits for healthcheck) → Active; the previous deployment is
  then Removed. "Once the new deployment is online, the old one receives SIGTERM. It gets 0 seconds to shut
  down by default before SIGKILL." `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` (default 0) keeps both running after
  switch-over; `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (default 0) is the SIGTERM→SIGKILL window.
- Consequences: every deploy (and every crash/restart) wipes sessions and closes all sockets. Mitigations:
  (a) draining 20–30 s + SIGTERM handler that broadcasts a `relay_restarting` close (custom close code 4xxx)
  so clients reconnect immediately rather than after a timeout; (b) publisher keeps its `sessionCode` and
  `resumeToken` and on reconnect sends `create_session { preferredCode, resumeToken }` — the relay honours
  `preferredCode` when it is free (fresh registry) or when the token matches an existing session; (c) viewers
  re-join with the same code and show "waiting for publisher"; (d) deploy during off-hours; (e) the
  overlap window does not help WebSockets (new connections already go to the new instance, old sockets die
  at SIGKILL).

### 1.9 Volumes

- Volumes are optional; one per service; Hobby 5 GB, Pro 50 GB (self-serve to 1 TB). We do **not** attach a
  volume (rule 6: nothing on disk) and note that services *with* volumes lose zero-downtime deploys. The
  container filesystem is ephemeral storage (100 GB on paid plans) — still, never write scene data there.

### 1.10 Logs: retention and what the edge records

- Log types: build, deploy (stdout/stderr), environment, **HTTP logs** (edge), DNS logs. HTTP logs record:
  request id, timestamp, method, **path**, host, status, client user agent, **source IP**, edge region,
  durations (total, TTFB, upstream), bytes tx/rx, and "response details" when the app fails to respond.
  Not documented: whether `path` includes the query string, whether headers/cookies are logged
  `[TODO verify]`. The upgrade request of a WebSocket is an HTTP request and will appear with its path.
- Retention: Free 3 d, Hobby 7 d, Pro 30 d, Enterprise ≤ 90 d. Structured logs: one JSON object per line,
  `message` required, `level` (debug/info/warn/error) parsed, other fields become searchable attributes
  (`@sessionId:...`). Rate limit 500 lines/s/replica (excess dropped). No log drains; export via a sidecar
  (Vector/Fluent Bit) or OpenTelemetry if ever needed. No way to disable capture → the application must not
  print sensitive values.
- Design rules: WebSocket endpoint at a fixed path (`/ws`), no code/token in path or query; HTTP join
  (if any) via POST body; do not log request bodies; pino `redact` as belt-and-braces.

## 2. Node.js `ws` library (8.22.0)

- Requirements: `ws@8` engines `node >= 10`; optional native peers `bufferutil`, `utf-8-validate`
  (not needed on Node ≥ 18.14; skip to keep Alpine builds pure-JS).
- `WebSocketServer` options: `maxPayload` (default 104857600 = 100 MiB; 0 = unlimited), `perMessageDeflate`
  (default **false** on server), `clientTracking` (populates `wss.clients`), `noServer`/`server`/`port`
  (exactly one), `handleProtocols`, `backlog`; `verifyClient` is discouraged — authenticate in the HTTP
  `upgrade` handler or Fastify hooks instead. Receiver options `maxFragments`/`maxBufferedChunks` bound
  fragment count and buffered chunks.
- **Max payload enforcement** (receiver.js): per-frame declared lengths are summed into
  `_totalPayloadLength`; exceeding `maxPayload` throws `RangeError` code `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`
  → the connection is closed with **1009**, before the payload is read. A second check runs after inflate, so
  compression bombs are caught. The limit is per *message* (all fragments), not per frame.
- **Fragmentation:** `send()` emits exactly one frame per call with `fin` from options (default `true`);
  `ws` does *not* split large messages. A 50 MB GLB therefore becomes one WebSocket frame (RFC 6455 allows
  64-bit lengths); TCP streams it. Manual fragmentation (`fin:false` … `fin:true`) is possible but browser
  clients only see the reassembled message anyway. Application-level chunking (separate messages with
  `snapshotId, index, total`) is only worth it for progress UI and for intermediate relays with smaller
  limits; otherwise prefer one message per snapshot — simpler and no reassembly buffers twice.
- **Backpressure:** `socket.bufferedAmount` = bytes queued by `send()` not yet written to the kernel (0 if
  written immediately; includes framing; with compression also bytes waiting to deflate). `send(data, cb)`:
  `cb` fires when Node's socket write reports the chunk written (or with an error). Relay policy: before
  fanning out a snapshot, skip viewers with `bufferedAmount > HIGH_WATER` (e.g. 2× snapshot size or
  64 MiB) and either queue "latest snapshot only" (coalesce) or close with 1008/4xxx "too slow". Pause
  reading from the publisher socket (`socket.pause()` on the underlying stream via `createWebSocketStream`,
  or simply by not acking) when aggregate buffered bytes exceed a global budget.
- **permessage-deflate:** off by default on the server because it "adds a significant overhead in terms of
  performance and memory consumption" and Node zlib can cause "catastrophic memory fragmentation" under
  concurrency; "enable it only if it is really needed". For GLB: geometry buffers are raw float32/uint16
  arrays, so deflate typically yields 20–40 % (my estimate, `[TODO verify]` on real Slicer exports) at
  significant CPU and memory cost on a 0.5–1 GB container; JSON state updates are tiny. Decision: keep it
  off; if bandwidth matters, compress at the *source* (Draco/meshopt in the plugin, or gzip the GLB once and
  relay opaque bytes) so the relay stays a byte pipe.
- **Heartbeat:** README pattern — server marks `isAlive=false`, `ping()`s every 30 s, `terminate()`s sockets
  that did not `pong` (pongs are automatic in browsers and `ws`). Client side: expect a ping within
  30 s + latency, else `terminate()` and reconnect. Browsers cannot send pings; the viewer can instead send
  an application-level `{type:"ping"}` or rely on server pings.
- Standalone `ws` on Fastify's server: `new WebSocketServer({ noServer: true })` + `fastify.server.on('upgrade',
  …)` routing by `pathname`, `handleUpgrade` → `emit('connection')`; destroy sockets for unknown paths. This
  bypasses Fastify hooks (rate limit, logging) for the upgrade — you re-implement them.
- `@fastify/websocket` 11.3.4 (Fastify ^5 since 11.0.1; built on `ws@8`): register before routes, pass `ws`
  options under `options` (`maxPayload`, `perMessageDeflate`, `clientTracking`, …; never `path`/`noServer`);
  routes declared with `{ websocket: true }` get handler `(socket, req)` where `socket` is a `ws` WebSocket;
  `onRequest`/`preValidation`/`preHandler` hooks **do** run (reject with `reply.code(429).send()`),
  `onSend`/`preSerialization` do not; plugin-level `errorHandler(error, socket, req, reply)` catches handler
  and socket errors but **not** errors thrown inside `message` listeners (wrap them); attach `message`
  listeners synchronously; unknown routes 404 unless a `/*` wildcard exists; default `preClose` closes all
  sockets (Fastify's `close()` otherwise hangs on upgraded connections). `fastify.websocketServer` is used in
  examples but undocumented `[TODO verify]` before relying on it for `wss.clients`.
- Recommendation: `@fastify/websocket` with per-route `maxPayload` not possible (server-wide) → set the
  server-wide limit to the publisher maximum and enforce a smaller viewer limit in the message handler
  (`data.length` check + close 1009) — or run two `WebSocketServer`s (`noServer`) on one HTTP server if a
  hard pre-read limit for viewers is required.

## 3. Relay / signaling patterns

- **Session registry:** `Map<code, Session>`; `Session = { code, publisher?: Socket, resumeTokenHash,
  viewers: Set<Socket>, latestSnapshot?: { id, bytes: Buffer, createdAt }, state: JSON, createdAt,
  lastActivity, expiresAt }`. TTL sweep every 10–30 s: remove sessions idle > `SESSION_TTL` (e.g. 30 min
  without publisher or activity) and hard-cap lifetime (e.g. 12 h). Removing a session sends close 4xxx
  to all viewers and drops the buffer (GC; no `Buffer` reuse pools to avoid retaining medical bytes).
- **Roles:** exactly one publisher per session (Slicer, outbound WSS); N viewers (phones, Quest). Viewers
  only send small control messages (join, ping, optional pointer/pose later); the relay rejects binary
  frames from viewers. Publisher messages: `snapshot` (binary GLB, possibly tens of MB), `state` (JSON).
- **Fan-out of large blobs:** keep **one** `Buffer` per snapshot and pass the same reference to every
  `send()`; `ws` frames it per socket but does not copy the payload in the uncompressed path (only prepends
  a header). Keep only the latest snapshot per session (late joiners get it immediately on join); a new
  snapshot replaces it atomically. Memory budget: `MAX_SNAPSHOT_BYTES` (e.g. 64 MiB) per session,
  `MAX_TOTAL_SNAPSHOT_BYTES` globally (e.g. 50 % of the container limit) → reject/creates fail with a
  protocol error when exceeded; `MAX_VIEWERS_PER_SESSION` (e.g. 10) and `MAX_SESSIONS` (e.g. 200).
  Slow consumers: coalescing — if a viewer still has the previous snapshot in `bufferedAmount`, skip
  intermediate snapshots and deliver only the newest when the buffer drains (`send` callback).
- **Late joiners:** on `join` → send `state` then `latestSnapshot` (if any), then live updates. For
  consistency tag snapshots with a monotonic `snapshotId` and have `state` reference the id it applies to.
- **Resume token for the publisher:** generated at `create_session` (≥ 128 bits, `crypto.randomBytes(16)`,
  base64url), stored hashed (SHA-256) in the session; on reconnect the publisher sends
  `resume { code, token }` within a grace period (`PUBLISHER_GRACE`, e.g. 120 s) during which the session
  is kept with `publisherOnline=false` and viewers are told "publisher reconnecting"; after the grace period
  the session expires. The token is never in URL/path/query/logs; only in the WebSocket message body.
  After a relay restart the registry is empty, so `create_session { preferredCode }` re-uses the old code if
  free — the viewers' displayed code stays valid.
- **Codes vs tokens:** the 5-char code is the human-shared *join* secret (low entropy, rate-limited,
  short-lived); per-connection session/resume tokens are high entropy. Optionally the relay can return a
  per-viewer `viewerToken` after a successful join to allow reconnect without re-rate-limiting.

## 4. Rate limiting, brute force, security headers

- **Entropy:** alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (26 letters − O,I,L = 23; 10 digits − 0,1 = 8)
  → **31 symbols**; 31^5 = **28,629,151** codes ≈ 24.77 bits (Crockford base32 would be 32^5 = 33.5 M;
  full alphanumeric 36^5 = 60.5 M). Generation: rejection sampling with `crypto.randomInt(31)` per symbol;
  collision probability with 1,000 live sessions is 3.5e-5 per draw — retry on collision. Input handling:
  uppercase the user's input, then reject any character outside the alphabet (since `0 O 1 I L` are all
  excluded there is nothing to disambiguate, and no typo-mapping is needed).
- **Guessing math:** probability that `k` random attempts hit one of `S` live sessions ≈ `1 − (1 − S/N)^k`:
  S=100, k=1,000 → 0.35 %; S=100, k=10,000 → 3.4 %; S=1,000, k=10,000 → 29 %. Scanning half the space
  takes 994 days at 10 attempts/min, 16.6 days at 600/min. Therefore: ≤ 10 join attempts per IP per minute
  with `ban` after repeated 429s (attackers rotate IPs, so this is a cost raiser, not a wall), plus a
  *global* failed-join budget as an alarm (e.g. > 1,000 failed joins/hour → log a warning and temporarily
  tighten the per-IP limit or fall back to a 6-character code). A per-session counter is of little use here,
  because attackers guess codes, not a specific session. Short TTL for unused codes (publisher idle without
  viewers → expire in 30 min) shrinks `S` further.
- `@fastify/rate-limit` 11.2.1 (Fastify ^5 needs ≥ 10.x): options `max` (default 1000), `timeWindow`
  (default 60 s), `ban` (count of 429s before 403; `0` = immediate 403), `keyGenerator` (default
  `normalizeIP(request.ip, ipv6Subnet=64)`), `allowList`, `continueExceeding`, `exponentialBackoff`,
  `hook` (default `onRequest` — runs before the WebSocket upgrade), per-route `config.rateLimit` with
  `groupId`, in-memory LRU store `cache` (default 5,000 clients) — enough for one replica, Redis only for
  multi-server. Headers `x-ratelimit-*`, `retry-after`. Fastify `trustProxy: true` is required so
  `request.ip` is the client IP from `X-Forwarded-For` set by Railway's edge; otherwise all clients share
  the edge IP and one phone can lock everyone out `[TODO verify]` that Railway's edge sets
  `X-Forwarded-For` (standard, not found in docs; check with a test deploy and log `request.ips` length).
  Because join happens *inside* the WebSocket (code in the first message), HTTP rate limiting only covers
  the upgrade; implement an in-process `Map<ip, {count, windowStart}>` for join attempts on the socket as
  well (or require join via `POST /api/join` returning a one-time ticket, then upgrade — cleaner
  rate-limiting, code never in URL; ticket in the first WS message).
- `@fastify/helmet` 13.2.0 (wraps `helmet` ^8.0.0; plugin ≥ 12.x for Fastify ^5): sets helmet's default
  headers incl. a default CSP (`useDefaults`); configure `contentSecurityPolicy.directives` for the viewer
  (`connect-src 'self' wss:`, `worker-src blob:` for three.js loaders/Draco, `img-src data: blob:`),
  `enableCSPNonces` if inline scripts are needed (Vite output usually has none), optionally
  `crossOriginEmbedderPolicy:false` if WebXR/third-party assets break. Same origin for viewer + WSS → no CORS
  plugin; still check the `Origin` header on upgrade against `RAILWAY_PUBLIC_DOMAIN`/custom domain for
  browser clients (Slicer/Quest send no Origin or a custom one — allow absent Origin, reject foreign ones).
- Fastify defaults worth setting: `bodyLimit` 1 MiB (fine; API bodies are tiny), `requestTimeout` (docs
  recommend non-zero without a reverse proxy; Railway's edge already enforces), `keepAliveTimeout` 72 s
  (> Railway's 60 s idle close, OK), `forceCloseConnections: "idle"` default, `genReqId` default
  incremental (do not trust `request-id` header).

## 5. Observability without logging content

- pino 10.4.0 `redact: { paths: ['code','token','resumeToken','*.code','*.token','req.headers.authorization',
  'req.headers.cookie'], censor: '[Redacted]' }` (or `remove: true`); paths are object key paths with `*`
  wildcards (wildcards cost ~50 % more; fixed paths ~2 %); redaction applies to object keys, not to text
  inside the `msg` string → never interpolate codes into messages. Fastify's default request logging
  (`req.url`) would log the upgrade path — fine for `/ws`, but disable per-request logging
  (`disableRequestLogging` / `logController`) or use a custom `req` serializer that drops `url` query.
  Log only metadata: `sessionId` (internal random id, not the code), byte sizes, counts, durations, close
  codes, hashed IP (HMAC with a per-boot key) for abuse analysis.
- Railway: emit JSON lines with `message` and `level`; attributes searchable in Log Explorer; ≤ 500 lines/s.
  Service metrics (CPU, memory, disk, network) kept ~30 days; no Prometheus scraping, no alerts → keep an
  optional `/metrics` (prom-client) behind a bearer token from env (`METRICS_TOKEN`) or bind it off by
  default; alternatively expose counters in a protected `/health?detail` for the operator only.
- Never log: GLB bytes, JSON state payloads (may contain node names/patient-identifying labels), codes,
  tokens, raw IPs beyond hashed form. Log *that* a snapshot of N bytes was relayed to M viewers.

## 6. Node.js 22 LTS specifics

- Release line "Jod": LTS 2024-10-29, **Maintenance since 2025-10-21, EOL 2027-04-30**; Node 24 "Krypton"
  is Active LTS until 2026-10-20 then Maintenance to 2028-04-30 (nodejs/Release schedule.json). Staying on
  22 is defensible for the project horizon; moving to 24 later is low-risk (ADR note).
- Native `WebSocket` global: added 21.0/20.10, unflagged in 22.0.0, no longer experimental in 22.4.0
  (browser-compatible, undici-based); `CloseEvent` global since 23.0 (so on Node 22 use `ws`'s client in
  `tools/fake-slicer` for `maxPayload`/ping control, or the native client for simple tests).
- V8 heap: `--max-old-space-size=<MiB>` (allowed in `NODE_OPTIONS`), `--max-old-space-size-percentage=<p>`
  (Node option, "percentage of available system memory"; takes precedence). Default heap size is not
  documented on the CLI page `[TODO verify]` (historically ~2–4 GiB on 64-bit, independent of small
  container limits → an unbounded heap can exceed a 512 MB container and be OOM-killed before V8 GCs
  aggressively). Set `NODE_OPTIONS=--max-old-space-size-percentage=75` in the Dockerfile and enforce the
  application-level snapshot budget. Node 22 raised default stream high-water mark 16→64 KiB.
- Docker (Docker Hub, 2026-10): `node:22-alpine` 60.7 MB compressed (Alpine/musl; "applications written
  for Debian (glibc) will not run under Alpine (musl)" — only matters for native add-ons, which we avoid),
  `node:22-bookworm-slim` = `node:22-slim` 79.8 MB, full `node:22` 410 MB. docker-node best practices:
  run as the provided `node` user (uid 1000, `USER node`), use `CMD ["node","dist/index.js"]` not
  `npm start` (npm swallows SIGTERM), use `--init`/`tini`/`dumb-init` because Node is not designed as PID 1.
  Railway runs the container's `CMD` directly `[TODO verify]` whether PID 1 is our process → include
  `dumb-init` in the image to be safe. Multi-stage: stage 1 `npm ci` + `tsc` + Vite build of `web-viewer`,
  stage 2 copy `dist/`, production `node_modules` (`npm ci --omit=dev`), `web-viewer/dist` → `public/`.
  `RAILWAY_RUN_UID` can force root (0); we do not need it.

## 7. Alternative stack (for the ADR): Python/FastAPI + uvicorn

- FastAPI 0.143.3 / Starlette WebSocket API: `accept`, `receive_bytes`/`send_bytes`, `iter_bytes`,
  `WebSocketDisconnect`; dependencies (`Depends`, `Cookie`, `Query`) usable in WS endpoints; FastAPI's own
  example `ConnectionManager` keeps connections in a dict and warns it works only in a single process
  (suggests `encode/broadcaster` + Redis otherwise). No `bufferedAmount`-style API at the Starlette level.
- uvicorn 0.54.0: `--ws auto|websockets|websockets-sansio|wsproto|none`; `--ws-max-size` default
  **16 MiB** (must be raised for GLB), `--ws-ping-interval`/`--ws-ping-timeout` 20 s, `--ws-per-message-deflate`
  default **True**, `--workers` default 1 (must stay 1), `--proxy-headers` honoured only for
  `--forwarded-allow-ips` (default `127.0.0.1`; set to the edge/`*`).
- python-websockets 17.2: `max_size` default 1 MiB; `max_queue` 16 frames (backpressure by pausing reads);
  `write_limit` high/low-water marks make `send()` await (true async backpressure, nicer than `ws`'s
  polling of `bufferedAmount`); ~64 KiB/connection with compression, ~14 KiB without; compression on by
  default.
- Assessment: feasible, and Python would align with the Slicer plugin language; but the web viewer toolchain
  (Vite/TS) and shared JSON-Schema→TS types already pull Node into the repo, the Node/`ws` relay is a thin
  byte pipe with lower per-message overhead and no GIL, Fastify's plugin set (rate-limit, helmet, static)
  maps 1:1 to our needs, and `ws` makes payload limits explicit. Recommend Node.js + Fastify + `ws`;
  record Python as the considered alternative.

## Open questions / `[TODO verify]` list

1. Railway Dockerfile build context = Root Directory? (docs silent) — test with the first deploy.
2. IaC (`railway.ts`) field names for draining/overlap seconds, region, restart policy, Dockerfile path.
3. Whether edge HTTP logs include query strings/headers — assume yes; design never puts secrets there.
4. EU region availability on the Hobby plan (docs vs forum conflict).
5. Does Railway's edge set `X-Forwarded-For` (needed for per-IP rate limiting with `trustProxy`)?
6. Node 22 default heap limit inside a cgroup-limited container; confirm `--max-old-space-size-percentage`
   reads the cgroup limit, not host RAM.
7. Real deflate ratio of Slicer GLB exports (decides whether source-side compression is worth it).
8. Meta Quest/Unity WebSocket client max message size for a single 50 MB frame (quest workstream).
9. Whether Railway runs `CMD` as PID 1 (include `dumb-init` regardless).

## Sources

- Railway — Dockerfiles: https://docs.railway.com/guides/dockerfiles ; https://docs.railway.com/builds/dockerfiles.md
- Railway — Config as Code (deprecated) : https://docs.railway.com/reference/config-as-code
- Railway — Infrastructure as Code: https://docs.railway.com/infrastructure-as-code ; changelog https://railway.com/changelog/2026-08-20-railway-anon
- Railway — Monorepo / root directory / watch paths: https://docs.railway.com/guides/monorepo
- Railway — Public networking, specs & limits: https://docs.railway.com/guides/public-networking ; https://docs.railway.com/networking/public-networking/specs-and-limits.md
- Railway — Domains & TLS: https://docs.railway.com/networking/domains/working-with-domains ; https://docs.railway.com/guides/troubleshooting-ssl
- Railway — Healthchecks: https://docs.railway.com/reference/healthchecks
- Railway — Variables (`RAILWAY_*`): https://docs.railway.com/reference/variables
- Railway — Regions: https://docs.railway.com/reference/regions ; https://docs.railway.com/reference/deployment-regions
- Railway — Plans & pricing: https://docs.railway.com/reference/pricing/plans ; https://railway.com/pricing
- Railway — Serverless / app sleeping: https://docs.railway.com/reference/app-sleeping
- Railway — Scaling / replicas: https://docs.railway.com/reference/scaling
- Railway — Deployments lifecycle: https://docs.railway.com/reference/deployments ; restart policy https://docs.railway.com/guides/restart-policy
- Railway — Volumes: https://docs.railway.com/reference/volumes
- Railway — Logging: https://docs.railway.com/reference/logging ; Metrics: https://docs.railway.com/reference/metrics
- Railway community (non-authoritative): https://station.railway.com/questions/is-there-a-concurrent-connection-limit-f-50f7c5d0 ; https://station.railway.com/questions/web-socket-connections-dropping-silently-da8600df ; https://station.railway.com/questions/eu-support-for-hobby-plan-e32b309f ; https://station.railway.com/questions/railway-toml-has-no-effect-what-replac-b623aa81
- `ws` 8.22.0 — API docs: https://github.com/websockets/ws/blob/master/doc/ws.md ; README: https://github.com/websockets/ws ; sender.js: https://github.com/websockets/ws/blob/master/lib/sender.js ; receiver.js: https://github.com/websockets/ws/blob/master/lib/receiver.js ; npm: https://registry.npmjs.org/ws/latest
- `@fastify/websocket` 11.3.4: https://github.com/fastify/fastify-websocket ; releases https://github.com/fastify/fastify-websocket/releases
- Fastify 5.12.7 server options: https://fastify.dev/docs/latest/Reference/Server/
- `@fastify/rate-limit` 11.2.1: https://github.com/fastify/fastify-rate-limit
- `@fastify/helmet` 13.2.0: https://github.com/fastify/fastify-helmet
- pino 10.4.0 redaction: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Node.js 22 release notes: https://nodejs.org/en/blog/announcements/v22-release-announce ; `WebSocket` global: https://nodejs.org/api/globals.html ; CLI options: https://nodejs.org/api/cli.html ; release schedule: https://github.com/nodejs/Release (schedule.json)
- docker-node README and best practices: https://github.com/nodejs/docker-node ; https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md ; image sizes: https://hub.docker.com/_/node (tags API, 2026-10)
- FastAPI WebSockets: https://fastapi.tiangolo.com/advanced/websockets/ ; Starlette: https://starlette.dev/websockets/
- uvicorn settings: https://github.com/encode/uvicorn/blob/master/docs/settings.md ; python-websockets memory & compression: https://websockets.readthedocs.io/en/stable/topics/memory.html ; https://websockets.readthedocs.io/en/stable/topics/compression.html
- Package versions: npm registry and PyPI JSON APIs, queried 2026-10-17.
