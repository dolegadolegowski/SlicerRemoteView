# ADR 0002: Relay and web-viewer stack — Node.js 22 / TypeScript / Fastify 5 / `ws`, Vite 8 / three.js r186, shared JSON Schema

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `server`, `web`, `protocol`
- **Related:** `CLAUDE.md` (default stack table), `docs/architecture.md`, `docs/protocol.md`, ADR 0006
  (viewer hosting), ADR 0007 (monorepo wiring), ADR 0008 (session codes)

## Context

The relay is a thin fan-out of WebSocket messages (one publisher, N viewers; ADR 0001/0004) that also serves the
mobile viewer (ADR 0006). It must enforce payload limits, rate limits and never log content (CLAUDE.md rule 6).
The web viewer must run without installation in Safari iOS and Chrome Android and optionally in Meta Quest
Browser (WebXR). A `shared/` package must hold the protocol contract as JSON Schema with generated types for
TypeScript (relay, viewer, `tools/fake-slicer`), Python (Slicer plugin) and C# (Unity).

Verified facts (`docs/research/relay.md`, `web.md`, `quest.md`, checked 2026-10-17):

- Node.js 22 "Jod": Active LTS 2024-10-29, **Maintenance LTS since 2025-10-21, EOL 2027-04-30**; Node 24
  "Krypton" is the current Active LTS (Maintenance from 2026-10-20, EOL 2028-04-30). The native `WebSocket`
  client is stable since 22.4.0. Vite 8 requires Node `^20.19.0 || >=22.12.0`.
- `ws` 8.22.0: `maxPayload` default 100 MiB, enforced per message before the payload is read (close 1009);
  no outgoing fragmentation; backpressure only via `socket.bufferedAmount` + `send()` callback;
  `perMessageDeflate` off by default and discouraged by the maintainers (zlib memory fragmentation).
- Fastify 5.12.7 + `@fastify/websocket` 11.3.4 (built on `ws@8`): `onRequest`/`preValidation`/`preHandler`
  hooks run before the upgrade (so `@fastify/rate-limit` 11.2.1 applies), handler receives the raw `ws`
  socket, `ws` options (`maxPayload`, …) are server-wide, default `preClose` closes upgraded sockets.
  `@fastify/static` 10.1.6, `@fastify/helmet` 13.2.0 cover static files and CSP.
- pino 10.4.0 `redact` removes values by object key path (`code`, `token`, `*.code`, `req.headers.authorization`);
  it does not scrub interpolated strings.
- three.js r186 (`three@0.186.1`): **WebGL 2 only** (`WebGLRenderer` throws for WebGL 1 since r163); Safari
  ships WebGL 2 by default from version 15 → iOS 15+ is the floor. Releases every 2–3 months with breaking
  changes → pin exact version.
- Vite 8.3.4 (Rolldown bundler): default `build.target` `baseline-widely-available` = Safari/iOS 16.4+;
  `server.proxy[...].ws = true` for dev WS proxying. Vitest 5.0.5 and Playwright 1.64.1 for tests.
- Python/FastAPI alternative: uvicorn 0.54.0 `--ws-max-size` default 16 MiB, python-websockets 17.2
  `max_size` default 1 MiB, permessage-deflate **on** by default (~64 KiB/connection), `--workers` must be 1,
  no `bufferedAmount`-style API in Starlette.
- Unity side needs Newtonsoft-annotated DTOs (`com.unity.nuget.newtonsoft-json` 3.2.1); NJsonSchema emits them;
  its JSON Schema draft coverage (2019-09 / 2020-12) is `[TODO verify]`.

## Decision

1. **Relay:** Node.js **22 LTS** + TypeScript + **Fastify 5** + **`@fastify/websocket`** (`ws` 8) +
   `@fastify/rate-limit` + `@fastify/helmet` + `@fastify/static` + **pino** with `redact`. Node 22 is kept for
   alignment with `CLAUDE.md` and Railway's `node:22-alpine` image; it is in Maintenance LTS, so **revisit at M4**
   (move to Node 24 or newer; low risk, no native add-ons).
2. **Relay policies fixed by this ADR:** server-wide `maxPayload` = publisher maximum (proposed 64 MiB) with a
   smaller viewer limit (64 KiB) enforced in the message handler (close 1009); `perMessageDeflate: false`;
   fan-out passes one shared `Buffer` per snapshot and skips/coalesces viewers whose `bufferedAmount` exceeds
   a high-water mark; `trustProxy: true` for per-IP rate limiting behind Railway's edge; application-level
   heartbeat because browsers cannot send pings.
3. **Web viewer:** **Vite 8** + TypeScript + **three.js r186** (exact pin), `GLTFLoader.parse` from the WS
   `ArrayBuffer`, `OrbitControls` with damping, render-on-demand, WebGL2 gate with a user-visible error. Minimum
   browsers: iOS/Safari 16.4+ (Vite default target; WebGL 2 requires ≥ 15 anyway), Chrome Android current.
   Optional WebXR mode via `XRButton` (ADR 0003).
4. **`shared/`:** JSON Schema is the single source of truth; generated TS types (relay, viewer, fake-slicer),
   Python dataclasses/TypedDicts (vendored into the plugin, ADR 0007) and C# Newtonsoft DTOs (ADR 0007).
   Schema draft: **draft-07 unless `docs/protocol.md` records that NJsonSchema handles 2020-12** `[TODO verify]`.

## Consequences

**Positive**

- One language/toolchain (TypeScript) for relay, viewer, simulator and type generation; one lockfile (ADR 0007).
- Payload limits, rate limiting, CSP and static hosting are verified Fastify plugins with Fastify 5 support —
  no custom upgrade handling, hooks run before the WebSocket upgrade.
- `ws` exposes `maxPayload` and `bufferedAmount`, which the relay's backpressure and DoS protections depend on.
- three.js has verified, dependency-free GLB parsing from memory and WebXR helpers; glTF extensions chosen in
  ADR 0001 need no decoder.

**Negative**

- Node 22 enters EOL on 2027-04-30; an upgrade is scheduled (M4) and must be tested against Fastify/ws majors.
- `@fastify/websocket` has one `maxPayload` for all routes; viewer limits are a second, in-handler check (or two
  `WebSocketServer`s in `noServer` mode if a pre-read limit becomes necessary).
- WebSocket handler errors bypass Fastify's error handler and `message` listeners must wrap their own errors.
- three.js has no LTS branch; every upgrade is a deliberate task with a migration-guide review.
- WebGL 2 only excludes iOS < 15 devices (acceptable per `docs/requirements.md` compatibility NFR).
- Python developers (Slicer plugin) must consume generated Python types rather than editing the schema in Python.

**Follow-ups**

- `server`: confirm Railway sets `X-Forwarded-For` (`[TODO verify]`, `relay.md` §4) with a first deploy; set
  `NODE_OPTIONS=--max-old-space-size-percentage=75`; disable per-request URL logging or drop query strings.
- `protocol`: pick the JSON Schema draft after a generator spike (NJsonSchema vs quicktype) — record in
  `docs/protocol.md`.
- `web`: measure GLB parse time on hardware; decide Web Worker parsing if > ~300 ms for 20 MB.
- `release`: schedule the Node 24+ upgrade task in `docs/plan/00-overview.md` at M4.

## Alternatives considered

- **Python / FastAPI + uvicorn.** Rejected: defaults work against our payloads (16 MiB `--ws-max-size`, 1 MiB
  `max_size`, deflate on by default, single worker), no `bufferedAmount` for fan-out backpressure, and Node is
  required anyway for Vite and TS type generation. Python alignment with the plugin is real but the relay shares
  only the schema with it, not code.
- **Hono.** Not evaluated in the research notes `[TODO verify]` WebSocket helper semantics per runtime; rejected
  on scope: Fastify's rate-limit/helmet/static/websocket plugins were verified 1:1 against our requirements.
- **Standalone `ws` on Fastify's HTTP server (`noServer`).** Kept as fallback for per-route `maxPayload`; not
  default because it bypasses Fastify hooks (rate limit, logging) on the upgrade.
- **Babylon.js.** Not evaluated in the research notes `[TODO verify]` bundle size and GLB-from-memory API;
  rejected because three.js facts (GLB parse, quantization, XR helpers, disposal rules) are verified and the
  team's web stack in `CLAUDE.md` already names three.js.
- **Plain WebGL / WebGPU.** Rejected: would re-implement glTF parsing, transparency sorting, controls and WebXR
  session handling; WebGPU is not available on the target iOS/Quest browsers for our use.

## Sources

- Node.js release schedule (`schedule.json`): https://github.com/nodejs/Release ; `WebSocket` global: https://nodejs.org/api/globals.html ; CLI options: https://nodejs.org/api/cli.html
- `ws` 8.22.0 docs, sender/receiver: https://github.com/websockets/ws/blob/master/doc/ws.md ; https://github.com/websockets/ws/blob/master/lib/receiver.js ; https://github.com/websockets/ws
- Fastify 5 server options: https://fastify.dev/docs/latest/Reference/Server/ ; `@fastify/websocket` 11.3.4: https://github.com/fastify/fastify-websocket
- `@fastify/rate-limit` 11.2.1: https://github.com/fastify/fastify-rate-limit ; `@fastify/helmet` 13.2.0: https://github.com/fastify/fastify-helmet ; `@fastify/static` 10.1.6: https://github.com/fastify/fastify-static
- pino redaction: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- three.js r186 release / npm: https://github.com/mrdoob/three.js/releases/tag/r186 ; https://registry.npmjs.org/three/latest ; `WebGLRenderer.js`: https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/WebGLRenderer.js ; caniuse WebGL 2: https://caniuse.com/webgl2
- Vite 8: https://registry.npmjs.org/vite/latest ; https://vite.dev/blog/announcing-vite8 ; https://vite.dev/config/build-options ; https://vite.dev/config/server-options
- Vitest 5: https://registry.npmjs.org/vitest/latest ; Playwright 1.64.1: https://registry.npmjs.org/@playwright/test/latest
- FastAPI / Starlette WebSockets: https://fastapi.tiangolo.com/advanced/websockets/ ; https://starlette.dev/websockets/ ; uvicorn settings: https://github.com/encode/uvicorn/blob/master/docs/settings.md ; python-websockets compression/memory: https://websockets.readthedocs.io/en/stable/topics/compression.html ; https://websockets.readthedocs.io/en/stable/topics/memory.html
- Newtonsoft for Unity 3.2: https://docs.unity3d.com/Packages/com.unity.nuget.newtonsoft-json@3.2/changelog/CHANGELOG.html ; NJsonSchema: https://github.com/RicoSuter/NJsonSchema
