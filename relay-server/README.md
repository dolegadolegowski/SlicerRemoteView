# relay-server — session codes, WebSocket relay, static web-viewer hosting (Node.js 22 / Fastify / ws)

Part of **SlicerRemoteView**. Owned by the `server` workstream (branch `ws/server`, plan
`docs/plan/server.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

The relay accepts one 3D Slicer publisher per session, hands out a 5-character session code, lets up to 20
viewers (web-viewer, Quest) join with it and forwards the scene to them. Everything is held in memory only
(single replica); nothing is written to disk and codes, tokens and scene bytes never reach a log. Design:
`docs/architecture.md` §3–§5, §8–§9; task list: `docs/plan/server.md`.

## How to run

From the repository root (Node 22, `npm ci` once):

```bash
npm run dev -w relay-server        # tsx watch, sources of shared/ via tsconfig paths, http://localhost:8787
npm run build                      # shared/ first, then relay-server/dist (and the other workspaces)
npm start -w relay-server          # node dist/index.js (needs the build above)
```

The relay listens on `0.0.0.0:$PORT`. For local work with the Vite dev server, allow its origin and turn off
proxy trust (nothing sets `X-Forwarded-For` locally):

```bash
ALLOWED_ORIGINS=http://localhost:5173 TRUST_PROXY=false npm run dev -w relay-server
cp relay-server/.env.example relay-server/.env    # or keep settings in a git-ignored .env …
node --env-file=relay-server/.env relay-server/dist/index.js   # … and load it with Node's --env-file
```

## Configuration

Environment variables (`src/config.ts`, same names as `docs/architecture.md` §9). Every value is validated at
start-up; an invalid one stops the process with exit code 1 and a `fatal` log line naming the variable (never
its value). Empty values count as unset. `relay-server/.env.example` lists exactly these variables with their
defaults (a test keeps both in sync).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | listen port (Railway injects it) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `METRICS_TOKEN` | unset | Bearer for `GET /metrics` (≥ 32 printable characters, e.g. `openssl rand -base64 32`); unset disables `/metrics` |
| `SESSION_TTL_S` | `1800` | idle TTL while a session has no connected viewers (§4.4); at most the protocol value |
| `PUBLISHER_GRACE_S` | `120` | resume window after the publisher's socket is lost (§9.1); at most the protocol value |
| `SESSION_MAX_LIFETIME_S` | `43200` | hard cap on a session's lifetime; at most the protocol value |
| `CODE_QUARANTINE_S` | `600` | a released code is not reissued for this long (ADR 0008); at least `60` |
| `MAX_SNAPSHOT_BYTES` | `67108864` | per-snapshot cap, at most the protocol maximum (64 MiB) |
| `MAX_TOTAL_SNAPSHOT_BYTES` | `536870912` | cached + in-flight snapshots of all sessions; ≥ 2 × `MAX_SNAPSHOT_BYTES` |
| `MAX_TOTAL_BUFFERED_BYTES` | `167772160` | Σ of all viewer send buffers (≥ 8 MiB, the per-viewer hard watermark); slowest consumers closed `4010` above it |
| `MAX_VIEWERS` | `20` | viewers per session, at most the protocol maximum (20) |
| `MAX_SESSIONS` | `100` | live sessions (`CAPACITY` beyond) |
| `ALLOWED_ORIGINS` | `https://${RAILWAY_PUBLIC_DOMAIN}` | comma-separated browser origins allowed on `/ws` (exact match, no wildcards, `http:` only for `localhost`/`127.0.0.1`/`[::1]`); without both, only clients that send no `Origin` (Slicer, Unity) |
| `TRUST_PROXY` | `true` | client IP = the `X-Forwarded-For` entry added by the immediate peer (Railway edge), never a client-sent one; `false` = socket address (direct local access). `true` assumes the relay is reachable only through the Railway edge |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | SIGTERM → SIGKILL window for the `4008` drain on redeploy |

The three session timers are protocol maximums (§3.3, §14): a relay may run shorter, never longer.
`RELAY_TEST_FAST_TIMERS` is test-only: it is honoured only under `NODE_ENV=test` (SRV-21) and never set in
deployments. `NODE_OPTIONS` (`--max-old-space-size-percentage=75`, architecture §9) is set by the Dockerfile
(SRV-20) and read by Node, not by `config.ts`; `RAILWAY_PUBLIC_DOMAIN` is injected by Railway.

## HTTP endpoints

| Endpoint           | Answer                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /healthz`     | `200 {"status":"ok","uptimeS":…,"sessions":…,"version":"…"}` — no codes, IPs or memory figures      |
| `GET /api/version` | `200 {"name":"slicer-remote-view-relay","version":…,"protocolVersions":["1.0"],"limits":{…}}` (§10) |
| `GET /ws` (Upgrade) | WebSocket for both roles (§3): browser `Origin` must be in `ALLOWED_ORIGINS` (else HTTP 403), no `Origin` (Slicer, Unity) is fine; a plain HTTP `GET /ws` is a 404 |
| anything else      | `404 {"error":"NOT_FOUND"}` — no SPA fallback, the path is never echoed                             |

`GET /api/version` announces the effective `MAX_SNAPSHOT_BYTES` and `MAX_VIEWERS` (§14).

Logs are JSON lines (`level`, `time`, `message`) on stdout; per-request logging is disabled.

## Design notes

| Module | What it does |
| --- | --- |
| `src/config.ts` | environment → validated `Config` (fail fast, protocol maximums) |
| `src/codes.ts` | 5-symbol session codes (`crypto.randomInt` per symbol over `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, redraw on collision), the release quarantine (`CODE_QUARANTINE_S`, bounded), `pt_`/`vt_` tokens (256 bit, base64url), SHA-256 storage and constant-time comparison |
| `src/registry.ts` | in-memory sessions (architecture §3): phases `allocated → active → grace → closed/expired`, code index, quarantine, TTL sweep every 10 s (grace `PUBLISHER_GRACE_S`, idle `SESSION_TTL_S` only while no viewer is connected, lifetime `SESSION_MAX_LIFETIME_S`), `MAX_SESSIONS` → `CAPACITY`, `expiring`/`expired` events; releasing a session drops its snapshot buffers — nothing is written to disk. Each session also holds its publisher `Peer` and its viewers (`Viewer{id, peer}`, filled by SRV-07) and answers `ttl()` for `session.created`/`resumed`/`renewed`. |
| `src/clock.ts` | injectable time source; tests drive TTLs with `test/helpers/manual-clock.ts` |
| `src/app.ts` | Fastify factory: `/healthz`, `/api/version`, 404 handling, client-IP policy; starts/stops the registry sweep with the server. Wires the publisher handlers (create/close, publisher socket loss, expiry broadcast; the expiry listener is detached on close). |
| `src/ws/endpoint.ts` | `/ws` transport (§3): `maxPayload` 1 MiB + 64 KiB (`1009` before reading), no `permessage-deflate`, Origin check before the upgrade, `4012` when no session is bound 10 s after the upgrade, text limits 256 KiB / 16 KiB (the first message gets the limit of the role its type fixes; `PAYLOAD_TOO_LARGE` + `1009`), binary only from the publisher of a bound session (`UNAUTHORIZED` + `1008`), upgrades to any other route refused with 404 before the upgrade, every hook guarded against throws and rejected promises (`INTERNAL` + `1011`) |
| `src/ws/frame.ts` | each text frame is `JSON.parse`d exactly once (`readFrame`: value, peeked `type` and well-formed `id`); `checkEnvelope` applies `parseEnvelope`'s checks to the parsed value (a test compares both over every shared fixture) |
| `src/ws/dispatch.ts` | every text frame through the `parseEnvelope` checks (shared, schemas compiled at start-up): protocol major ≠ 1 → `UNSUPPORTED_VERSION` + `4000` (before the role gate, §2); first message fixes the role (`session.create`/`session.resume` → publisher, `viewer.join` → viewer, else `UNAUTHORIZED` + `1008`); a known type outside the role's §11 column → `UNAUTHORIZED` (before its schema is looked at); until a session is bound only handshake types and `ping` are accepted (anything else, unknown types included, is an `UNAUTHORIZED` offence), afterwards handshake types are; unknown type on a bound socket → `UNSUPPORTED_TYPE` (open); schema violation → `INVALID_MESSAGE{details.instancePath ≤ 128 chars}`, third → `4007`; second `UNAUTHORIZED` → `1008`; `type → handler` table; `ping` → `pong` |
| `src/ws/publisher.ts` | publisher lifecycle (§4): `session.create` → `session.created` (code, one-time `publisherToken`, `viewerLimit`, `ttl`, effective `limits`; `CAPACITY` + `4006` at `MAX_SESSIONS`); `session.close` → viewers get `session.closed{PUBLISHER_CLOSED}` + `4001`, publisher `1000`, code quarantined; publisher socket lost → grace + `session.publisherState{online:false, graceEndsAt}`; relay expiry → `session.expired{reason}` + `4002` to viewers and publisher |
| `src/ws/connection.ts` | one socket: role, envelope fields on send (`protocolVersion`, `ts`), `error` + close helpers, handshake timer. Implements the registry's `Peer` and carries the bound `session`. |
| `src/logger.ts` | pino JSON lines with redaction of codes and tokens |

## Test and lint commands

```bash
npm test -w relay-server             # vitest (all relay tests)
npm test -w relay-server -- app      # one file by name filter, e.g. `app`, `config`, `codes`
npm run lint -w relay-server         # eslint + prettier --check
npm run typecheck -w relay-server
npm run build -w relay-server        # tsc → relay-server/dist (needs `npm run build -w shared` first)
```

The root `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` run every workspace. The Docker image
(`docker build -f relay-server/Dockerfile .` from the repo root) arrives with SRV-20.
