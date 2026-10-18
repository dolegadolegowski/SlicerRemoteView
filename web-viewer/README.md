# web-viewer — mobile browser 3D viewer (Vite / TypeScript / three.js, optional WebXR)

Part of **SlicerRemoteView**. Owned by the `web` workstream (branch `ws/web`, plan
`docs/plan/web.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

A page that a phone or tablet opens without installing anything: enter the 5-character session code (or follow
the deep link `/j#CODE`), then view, rotate, zoom and filter the 3D Slicer scene live. See
`docs/architecture.md` §7 and `docs/plan/web.md`.

## Layout (planned; directories appear with the tasks of docs/plan/web.md)

| Path                      | Content                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `src/protocol/`           | connection, snapshot reassembly, versions — no DOM, no three.js (unit-tested)     |
| `src/render/`             | three.js wrapper (scene model, viewer, controls)                                  |
| `src/ui/`                 | DOM screens and widgets                                                           |
| `src/i18n/`, `src/state/` | strings (PL/EN) and the error / state catalogue                                   |
| `test/`                   | vitest: `protocol`, `state`, `i18n` run in Node; `ui`, `render` run in jsdom      |
| `e2e/`                    | Playwright component E2E (`iphone15` = WebKit, `pixel7` = Chromium + SwiftShader) |

## How to run

From the repository root (npm workspaces; `npm install` once):

```bash
npm run dev -w web-viewer        # Vite dev server; proxies /ws and /api to the relay on localhost:8787
npm run build -w web-viewer      # typecheck + production build into web-viewer/dist (hashed assets/)
npm run preview -w web-viewer    # serve dist/ locally
```

The relay serves `dist/` on the same origin as `/ws` and `/api` (ADR 0006); the WebSocket URL is derived from
`location` at runtime, so there is no host configuration.

## Test and lint commands

```bash
npm test -w web-viewer           # vitest (unit)
npm run e2e -w web-viewer        # Playwright, builds and serves dist/ itself; both device projects, headless
npm run lint -w web-viewer       # eslint + prettier --check
npm run typecheck -w web-viewer  # tsc --noEmit
```

Root `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` also cover this workspace.

### Playwright version and browsers

`@playwright/test` is pinned to **1.60.0** (Chromium 1223 / WebKit 2287), the version whose browser builds are
already installed on the development Mac (`~/Library/Caches/ms-playwright`). `docs/plan/web.md` names 1.64.1; moving
there means `npx playwright install chromium webkit` (a download of a few hundred MB) and bumping the pin. Playwright
WebKit is **not** Safari — iOS behaviour is verified on a real iPhone (`docs/testing/web.md`).

### Pinned dependencies

`three` is pinned to an exact version (`0.186.1`, NFR-41); upgrade deliberately, three.js has no LTS. `index.html`
loads nothing from a CDN (NFR-09; asserted in `test/toolchain.test.ts`).

### Shared protocol package

`@slicerremoteview/shared` is resolved to its **sources** (`shared/ts/index.ts`) by a Vite/vitest alias and a
`tsconfig` path (same approach as `tools/fake-slicer`), so dev, build, tests and typecheck need no prior
`npm run build -w shared`. Only what the viewer imports ends up in the bundle. Ajv is deliberately **not** in it:
it compiles schemas with `new Function`, which the relay's CSP (no `unsafe-eval`) forbids — see "Connection
client" below.

### Code entry (WEB-03)

`src/ui/code-entry.ts` — five cells, paste of a whole code, hints for `0/O` and `1/I/L` from the shared
`normalizeCode`. The form has no `action`/`method` and the inputs no `name`, so the code cannot reach a URL; the
connection layer is wired through `onJoin` in `src/main.ts`. Unit tests:
`test/ui/code-entry.test.ts`; device E2E: `e2e/code-entry.spec.ts`.

### Connection client (WEB-04)

`src/protocol/connection.ts` is one WebSocket's lifetime (no DOM, no three.js); reconnect with backoff is WEB-14.

```ts
const connection = createConnection(); // wss://<location.host>/ws, or ws:// on localhost only (T5)
connection.on("state", (s) => …);      // idle | connecting | connected | disconnected | enterCode | sessionEnded | stopped
connection.onMessage("viewer.joined", (m) => …); // typed per message type
connection.on("binary", (chunk) => …); // snapshot chunks (WEB-05)
connection.connect({ code });          // or { sessionId, viewerToken } to rejoin; viewer.join is the first frame
```

- **Heartbeat** (§9.1): `ping` every 15 s; no answer within 10 s closes the socket and emits `dead`. Any inbound frame
  after a `ping` also proves the link is alive, so a `pong` queued behind a snapshot stream cannot kill a slow link.
- **Close codes** (§9.3) become states: `4004`/`4003`/`4011` → `enterCode`, `4001`/`4002` → `sessionEnded`,
  `4000`/`1008`/`1009` (and a refused insecure transport) → `stopped`, everything else → `disconnected` (retry;
  `immediate` for `4008`, `retryAfterS` from the relay's `error.details`). Every state carries the localised
  `Description` from `src/state/errors.ts`.
- **Validation without Ajv**: inbound text frames go through `src/protocol/envelope.ts`, a CSP-friendly guard
  that checks the envelope (`protocolVersion` major 1, §11 direction) and the required fields of each relay → viewer
  message. `createConnection({ parse })` accepts the full Ajv-based `parseEnvelope` from `@slicerremoteview/shared`
  (tests run all valid fixtures through both). Unknown message types are ignored and logged by `type` only; the
  log never contains codes, tokens or payload.
- Tests: `npm test -w web-viewer -- connection envelope` (mock socket in `test/protocol/mock-socket.ts`, fake timers).

### Snapshot reassembly (WEB-05)

`src/protocol/snapshot-stream.ts` assembles a GLB streamed over the WebSocket (§6.2–6.4); `bindSnapshotStream(connection,
stream)` feeds it from `scene.snapshot.begin|end|abort` and binary frames and drops the partial buffer when the socket
closes.

```ts
const stream = createSnapshotStream({ maxSnapshotBytes }); // same value as announced in viewer.join
stream.on("progress", ({ fraction }) => …);               // 0 < fraction ≤ 1
stream.on("ready", ({ sceneVersion, bytes }) => …);       // hash-verified; the stream keeps no reference
stream.on("badSequence", ({ sceneVersion, field }) => …); // caller sends scene.request{reason:"GAP"}
stream.on("checksumMismatch" | "tooLarge" | "aborted", …);
```

`begin` is bound-checked before anything is allocated (`chunkSize` 64 KiB–1 MiB, `chunkCount == ceil(byteLength /
chunkSize) ≤ 1024`, `byteLength ≤ maxSnapshotBytes ≤ 64 MiB`, uint32 `sceneVersion`); chunks of an aborted or failed
snapshot are dropped silently, a skipped, duplicated or mis-sized chunk discards the snapshot and reports
`badSequence`. A new `begin` reports `aborted{reason:"SUPERSEDED"}` for the snapshot it replaces. The binding also
drops the partial buffer when the relay switches this viewer to HTTP mid-stream (`scene.snapshot.ready` for the same
or a newer version) and whenever the connection is not `connected`. Tests:
`npm test -w web-viewer -- snapshot-stream` (fixtures from `shared/fixtures/glb`).

### HTTP scene download (WEB-06)

`src/protocol/scene-http.ts` — `fetchScene()`, one `GET /api/scene/:sceneVersion` (§6.5, §10): pre-sized buffer,
streaming progress, `Content-Length` (skipped for a content-encoded body) and `ETag` checks when present, a 20 s stall
watchdog, SHA-256 verification; never throws. `src/protocol/scene-loader.ts` decides when to fetch and what the answer
means:

```ts
const loader = createSceneLoader(connection, { maxSnapshotBytes }); // fetches on viewer.joined / scene.snapshot.ready
loader.on("progress", ({ fraction }) => …);
loader.on("ready", ({ sceneVersion, bytes }) => …);          // hash-verified; the loader keeps no reference
loader.on("enterCode" | "sessionEnded", ({ description }) => …); // 401 / 410 on a live connection
loader.requestResync("GAP");                                 // scene.request with what the viewer holds
bindStreamToLoader(connection, stream, loader);              // stream failures use the same resync path
```

The viewer token is sent **only** in `Authorization: Bearer …` (never in the URL, never logged) and lives in memory;
it is dropped on 401, 410 and when the connection reports the session ended, the credentials invalid, a stop or a
leave. 404 and a SHA-256 mismatch send one `scene.request` (`GAP` / `CHECKSUM_MISMATCH`) per version — a second
failure of the same version gives up (`failed`) instead of downloading it in a loop. 429 waits `Retry-After`;
network/stall/5xx/length/ETag failures retry twice (1 s, 2 s). A 401/410 that arrives after the socket dropped drops
the token and the download without ending the session, and `4008` (relay restart) cancels the download: the rejoin
decides (§13 step 9). A 401 for a request made with a token that a rejoin has since replaced is retried with the new
token. A broken stream asks for the snapshot
only after that version's `scene.snapshot.end`, when the relay has cached it. Tests:
`npm test -w web-viewer -- scene-http scene-loader` (mocked `fetch` with WHATWG `Response`s,
`test/protocol/http-fixtures.ts`).
