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

### Activity line (WEB-24)

`src/ui/activity.ts` is the last line of the code entry (its `footer` slot): "Active sessions: 3 · Viewers: 12", the
relay-wide counts of `GET /healthz` (§10, SRV-31), like the in-session viewer count of the status bar. `main.ts` runs it
only while no session is live, joining or retrying — the states in which `screens.ts` shows the idle code entry — so a
relay-wide "Viewers" never sits under a session's Leave button. It is not started while the page is being left
(`pagehide`, where Reconnect leaves the session): a read then would keep Chromium from putting the page into the
back/forward cache, and WEB-14's rejoin by the in-memory code would be lost; `pageshow` starts it again on the idle
entry. A page opened from a `/j#CODE` link joins first, so it reads nothing. Started, it reads `/healthz` of the page's
own origin (`no-store`, no credentials, no redirect, 10 s timeout) at once, then every 30 s while the page is visible,
and at once when the page becomes visible again; stopped, it hides the line and drops an answer still on its way, so the
counts from before a session are never shown after it. A read sends no code, token, cookie or body — only what the
browser adds to any request (IP address, User-Agent), which the Railway edge logs (§10): one line per open home page
every 30 s. The line is hidden unless the relay gives both counts as whole numbers (a draining `503`, offline, an older
relay without `viewers`). Not a live region. `npm run dev` proxies `/healthz` to the local relay; under `vite preview`
(the E2E server) it falls through to `index.html` and the line stays hidden unless a spec routes it. Unit tests:
`test/ui/activity.test.ts`; device E2E: `e2e/activity.spec.ts`.

### Connection client (WEB-04)

`src/protocol/connection.ts` is one WebSocket's lifetime (no DOM, no three.js); reconnecting is `reconnect.ts` (WEB-14).

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

### GLB parse and node map (WEB-07)

`src/render/scene-model.ts` turns a verified GLB into three.js objects (§7):

```ts
const models = createSceneModelStore();       // disposes the previous model on every successful load
bindModelLifecycle(connection, [stream, loader], models, showInvalid); // what main.ts does
const result = await models.load(bytes);      // { ok: true, model } | { ok: false, reason }
scene.add(result.model.root);                 // glTF scene rotated 180° about Y for presentation
result.model.nodes.get(nodeId);               // { T, M, material, manifest } — manifest order (§7.2, §7.3)
```

`validateGlb()` (`src/render/glb-validate.ts`, no three.js, never throws) checks the container and the JSON chunk
against §7.1 **before** `GLTFLoader` sees the bytes, so a small file cannot make the loader fetch anything, run a
plugin or spend memory, GPU uploads or triangles out of proportion to its size: aligned JSON chunk of at most 8 MiB
(refused before decoding) then at most one BIN chunk ending the file; material factors in range; one scene, one root with extras, the node graph a tree; one buffer without `uri`; no
images/textures/animations/cameras/texture references in any form; only `KHR_mesh_quantization` and no `extensions`
objects at all (three.js runs its plugins — instancing, lights, `KHR_materials_*` — for any of them); disjoint views
inside the BIN chunk, every accessor inside a view, accessor bytes ≤ BIN and GPU uploads ≤ 2 × BIN (counted like the
loader's InterleavedBuffer cache); one TRIANGLES primitive with POSITION + NORMAL per mesh; every mesh, accessor and
material used once (§7.2). A refused or unparsable snapshot yields `snapshotInvalid` and keeps the previous model. No
Draco/meshopt decoder is registered (ADR 0001). Translucent materials (`opacity < 1`) get `transparent`,
`depthWrite = false` and `renderOrder = 1 + manifest position` (`applyOpacity(node, opacity)`); the loader's shared
default material is cloned per node. `bindModelLifecycle()` (`src/render/model-lifecycle.ts`) parses every snapshot
from the stream and the HTTP loader and drops the model when the session ends or another session is joined (kept
while reconnecting); the HTTP loader forgets its loaded version at the same moments. Tests run in jsdom with the real
`GLTFLoader` (no WebGL needed): `npm test -w web-viewer -- scene-model glb-validate model-lifecycle` (the
memory-release checks enable `gc` at runtime via `v8.setFlagsFromString`).

### Viewer and controls (WEB-08)

`src/render/viewer.ts` renders the scene model with three.js and touch controls; `src/ui/screens.ts` decides which
screen is visible (the viewer while a model is loaded on a live session, the code entry otherwise) and `main.ts`
only wires the pieces together.

```ts
const result = createViewer(); // { ok: false, reason: "webgl2Unavailable" } without WebGL 2 or a GL context
document.body.append(result.viewer.element); // .viewer: full-screen canvas (100dvh), notice, "Fit view" button
result.viewer.setModel(model);    // adds model.root to a ×1000 (mm) stage and fits it from the front; a new
                                  // snapshot of the scene on screen keeps the camera instead (WEB-25)
result.viewer.invalidate();       // request one frame after changing the scene (live updates, WEB-12)
result.viewer.setNotice(describeState({ kind: "snapshotInvalid" })); // message over the scene; null hides it
```

- **Render on demand** (FR-39, NFR-08): frames only on control changes, model changes, resize and visibility; while
  OrbitControls' damping settles it keeps rendering, then stops. Nothing renders while the page is hidden. Near/far
  follow the camera distance.
- **Touch** (FR-38, US-08): one finger rotates, two fingers zoom and pan, a double tap (or the Fit button, or a
  double click) re-frames the visible nodes keeping the direction; another scene is framed from the front, while a
  new snapshot of the scene on screen keeps the user's view (WEB-25, below). Only the canvas blocks browser gestures
  (`touch-action: none`, Safari `gesturestart`/`gesturechange`), so the code entry stays zoomable; if the page was
  pinch-zoomed before joining, the viewer covers the visual viewport.
- **Size**: `.viewer` is `position: fixed` with `100dvh`; the drawing buffer is `min(devicePixelRatio, 2) × page
  zoom × CSS size` (NFR-32; a zoomed viewer keeps the unzoomed resolution), resized from a `ResizeObserver` and
  `visualViewport` events and redrawn at once.
- **Screens and messages**: Join is refused at once without WebGL 2; `screens.report()` shows a message over the
  scene while it is visible (e.g. a refused update) and on the code entry otherwise; a closed session goes back to
  a focused code entry with its message, and a rejoin of the same session shows the kept model with the user's
  camera.
- Tests: `npm test -w web-viewer -- viewer screens` (mocked renderer, frame scheduler and visual viewport in jsdom)
  and `npm run e2e -w web-viewer -- controls` (Chromium: `e2e/fake-relay.ts` streams a fixture GLB from
  `page.routeWebSocket`; touch gestures and a page pinch-zoom over CDP). The gesture spec is skipped on WebKit —
  check iOS Safari on a device: `docs/testing/web.md` §iPhone Safari.

### Node panel (WEB-09)

`src/ui/node-panel.ts` lists the scene's structures in manifest order; `screens.ts` puts it into the viewer and
feeds it the shown model.

```ts
const panel = createNodePanel({ onChange: () => viewer.invalidate() });
viewer.element.append(panel.element); // bottom left; "Structures (n)" opens the list above it
panel.setModel(model);                // one 44 px switch per node: colour, name (as text), eye
panel.refresh();                      // after something else changed T.visible (presenter updates, WEB-12)
```

- A tap hides or shows the node on this device only (`T.visible`, FR-40, US-09) and redraws on the next frame;
  "Show all" brings everything back. Names may contain PHI: they are set as text only and never logged.
- Layout: at most half of a phone screen when open, upright and on its side; the panel box lets touches through
  to the canvas; the list scrolls inside. `e2e/glb.ts` builds a 40-structure scene from the fixture for this.
- Tests: `npm test -w web-viewer -- node-panel screens` and `npm run e2e -w web-viewer -- node-panel` (skipped
  where the browser has no WebGL 2); manual: `docs/testing/web.md` §Node panel.

### Component smoke (WEB-10)

`e2e/join-and-view.spec.ts` joins a real publisher end to end: `e2e/fake-slicer.ts` starts the relay stub of
`tools/fake-slicer` (until `relay-server` is on `main`) and the fake-slicer CLI, reads the session code from the
CLI's fd 3 (never stdout) and bridges the page's `/ws` to the stub with `page.routeWebSocket`. The spec types the code,
checks the drawn model and the node panel, and that the code is in no URL, no frame but `viewer.join` and no CLI
output.

```bash
npm run e2e -w web-viewer -- join-and-view   # builds shared/ and tools/fake-slicer, then the viewer
```

A snapshot download that gives up (`loader` `failed`) shows a notice over the scene if one is shown (the previous
scene stays), otherwise it leaves "Joining…" with the code still typed so **Join** tries again
(`screens.failSnapshot`; ignored unless connected, so a late failure cannot cancel a new join).

### Deep link (WEB-11)

`src/ui/deep-link.ts`: the QR opens `/j#<CODE>`; `main.ts` first calls `takeDeepLink()`, which replaces the URL with
`/j` (`history.replaceState`, no reload, no history entry) before anything reaches the network, then joins with the
code as if it had been typed (it is in the cells, so Join retries). An invalid fragment shows the code entry with its
hint and joins nothing; a link opened again in the same tab (`hashchange`) is taken the same way, but an invalid one
during a session leaves the joined code in the cells. Only `/j` takes a code (protocol §10). `replaceState` cleans the
address bar and the tab's Back/Forward entries; the browser's own History list keeps the opened link (no web API can
remove it), so the code's expiry is the limit there.

```bash
npm test -w web-viewer -- deep-link && npm run e2e -w web-viewer -- deep-link
```

### Live updates (WEB-12)

`src/protocol/scene-versions.ts` orders `scene.update`, `scene.nodeRemoved`, `scene.nodeAdded` and `scene.state` by
version (§8.3): applied only when `baseVersion` matches what is shown, queued while their snapshot is still loading,
one `scene.request{GAP}` after a gap. `src/render/apply-update.ts` applies them to the model (`visible`, `color`,
`opacity`, `matrix` on `T`, removals); a property changes only when the presenter's value changes, so a replayed
state keeps what the user hid locally, while a new presenter change of `visible` replaces it (FR-40).

```bash
npm test -w web-viewer -- scene-versions apply-update
npm run e2e -w web-viewer -- live-updates   # fake-slicer scripts through the relay stub
```

### Opacity and presenter overrides (WEB-13)

Every node-panel row has an opacity slider (0..1 in 1 % steps, local to this device, 44 px thumb; a vertical swipe
that starts on it scrolls the list and leaves the value as it was). A presenter change of
`visible` or `opacity` replaces the local choice; the viewer then says `The presenter changed <name>` for 3 s in its
status line (`screens.presenterChanged`). A presenter `color` change keeps a local hide.

```bash
npm test -w web-viewer -- node-panel apply-update screens && npm run e2e -w web-viewer -- opacity
```

### Reconnect and rejoin (WEB-14)

`src/protocol/reconnect.ts` (`createReconnect(connection)`) owns the session's code and viewer token, in memory only,
and decides after every closed socket whether to connect again (FR-43, NFR-19, NFR-20):

- Only a joined session retries without the user; a first join that fails is reported on the code entry.
- Rejoin with `sessionId` + `viewerToken` (§5.1); backoff 0.5 s → 30 s with jitter (`[d/2, d]`), reset only after a
  rejoin held 10 s; `4008` after 0–3 s; the relay's `retryAfterS` honoured; `enterCode` / `sessionEnded` / `stopped`
  / `idle` stop it.
- `SESSION_NOT_FOUND` (relay restarted): join by the code, first after a 4–6 s head start for the presenter on the
  same socket (the relay keeps it open 10 s for that, §9.2 — no second upgrade per viewer, so a room of 20 behind one
  address stays under the 30 upgrades a minute, §12), then `INVALID_CODE` retried on new sockets at ≈ 15, 35 and 60 s
  only (each failure counts against the room's IP, §12);
  then "Presentation ended" on the code entry. A closed state it retries keeps the scene, the token and the versions
  (`ends` passed to the model lifecycle, the loader and `bindSceneVersions`).
- `visibilitychange → visible`: a `ping` at once while connected (`connection.checkAlive()`), or the backoff wait is
  skipped; `pagehide` sends `viewer.leave` + `1000`; a page restored from the bfcache joins by the code again.
- `connection.ts`: a pong timer that fires more than 2 s late (frozen page) pings again instead of declaring the link
  dead; a socket that has not opened within 15 s counts as a drop; after `session.closed` / `session.expired` any
  close ends the session.

The screens keep the scene while reconnecting ("Reconnecting…", then "Connected" — in the status bar since WEB-15),
say "Presenter is offline" (`session.publisherState`, `viewer.joined.publisherOnline`) and, joined without a scene,
"Waiting for the presenter" or — while a stream or download really runs (`downloading()`) — "Loading the scene…"
under Join. Both status lines stay in the accessibility tree, empty when silent; the notice and the status line stack
at the top of the viewer.

```bash
npm test -w web-viewer -- reconnect connection screens code-entry viewer && npm run e2e -w web-viewer -- reconnect
```

### Status bar and device profile (WEB-15)

`src/platform.ts` turns `navigator.userAgent` into `clientInfo.platform` (`web` or `quest-browser`) and the
informational `profile` (`mobile`, `quest2`, `quest3`) — rule and sources in `docs/research/web-quest-user-agent.md`;
only those two values are sent. `snapshotLimit(profile)` sets `capabilities.maxSnapshotBytes` (64 MiB for `quest3`,
32 MiB otherwise) for the stream and the download too. `src/ui/status-bar.ts` is the first line over the scene: the connection
(`Connected`, `Reconnecting…`, `Presenter is offline` — its only live region), `Viewers: n` (`viewer.count`) and
`Scene v<n>`.

```bash
npm test -w web-viewer -- platform status-bar screens && npm run e2e -w web-viewer -- status
```

### Memory, lost context and wake lock (WEB-16)

The viewer stops drawing on `webglcontextlost` and says "3D view paused"; three.js re-uploads the scene on
`webglcontextrestored` and the viewer draws again. `src/ui/wake-lock.ts` keeps the screen on during a session
(`navigator.wakeLock`, re-requested when the page is visible again, and on the next tap after a refusal — Safari
wants a user gesture; let go after 2 min offline). `window.__rv.rendererInfo()` returns
`renderer.info.memory` counts for tests; development builds also show them in a small overlay.

```bash
npm test -w web-viewer -- viewer wake-lock dev-overlay && npm run e2e -w web-viewer -- memory
```

### Add to Home Screen (WEB-17)

`public/manifest.webmanifest` and `public/icons/` (copied to `dist/`) make the viewer installable: `start_url` and
`scope` `/`, `display: standalone`, 192/512 px icons (the 512 px one also maskable) and a 180 px
`apple-touch-icon`; `index.html` has the Apple web-app tags. There is no service worker. `e2e/pwa.spec.ts` also runs
axe-core's `color-contrast` rule (dev dependency `axe-core`, injected into the page) on the code entry, the status
bar and the node panel.

```bash
npm test -w web-viewer -- pwa && npm run e2e -w web-viewer -- pwa
```

### Bundle size (WEB-18)

`npm run build` ends with `scripts/check-bundle.mjs`: the gzipped size of the JS and CSS that `index.html` loads at
start, failing above 1 MiB (NFR-09) or when `index.html` names no module script (nothing measured). `e2e/network.spec.ts` asserts that the page talks only to its own origin.

| Initial asset (2026-10-21, three 0.186.1, Vite 8.3.4) | Size | gzip (level 9) |
|---|---|---|
| `assets/index-*.js` (app + three.js + GLTFLoader + OrbitControls) | 752,511 B | 192,804 B |
| `assets/index-*.css` | 9,774 B | 2,289 B |
| **Total initial JS + CSS** | 762,285 B | **195,093 B** (19 % of 1,048,576 B) |
| `assets/session-*.js` (WebXR, preloaded on Quest Browser only; not initial) | 17,361 B | 5,902 B |

```bash
npm run build -w web-viewer && npm test -w web-viewer -- bundle && npm run e2e -w web-viewer -- network
```

### Language (WEB-21)

The UI speaks English or Polish: the browser's language picks at first (`navigator.languages`, English otherwise),
and a switch — in the code entry's title row and in the status bar, named in the language it switches to
("Polski" / "English") — changes every visible text at once, without a reload, so the session stays. The choice is kept in
`localStorage` under `rv.lang` (the language only — never a code or token) and `<html lang>` follows it
(`src/i18n/lang.ts`). Messages are rendered again from what they describe (`localize` in `src/state/errors.ts`), so
one already on screen follows a switch.

```bash
npm test -w web-viewer -- i18n lang-toggle && npm run e2e -w web-viewer -- i18n
```

### WebXR on Meta Quest Browser (WEB-19)

On Quest Browser (user agent, `src/platform.ts`) with `navigator.xr`, the viewer shows **View in AR** (passthrough,
when `immersive-ar` is supported) or **View in VR**. The button requests the session in the tap itself
(`src/xr/enter.ts`), then runs the XR module (`src/xr/session.ts`, a separate ≈ 6 kB gzip chunk, preloaded when
the button is offered): `local-floor`
space, the scene 1:1 in metres 1.3 m in front at eye height (`src/xr/placement.ts`), controller and hand models, and
the 2D view restored when the session ends (it ends by itself when the presentation is over). In XR the scene is
grabbed with a controller's trigger or a pinch — one hand moves and turns it, two hands turn it about the vertical and
scale it between 0.1× and 5× (`src/xr/grab.ts`) — and the grip button or a double press of one hand puts it back
where it was first placed (WEB-20); on a Quest 2 a scene above its budget, or not prepared with the `quest2` profile,
gets a warning panel in the headset (`src/xr/budget.ts`, `src/xr/panel.ts`). Below the scene a status line repeats
what the page would say (WEB-23, `screens.xrStatus`): "Reconnecting…", "Presenter is offline", the title of a message
over the scene (a refused snapshot) and the notice line (a presenter change, "updating"), one line each, in the UI
language; it stands under the warning while that is up. Test hooks: `window.__rv.xrStage()` (the stage matrix) and
`window.__rv.xrPanels()` (how many panels are up) — numbers only. The input profiles are copied at build time from
`@webxr-input-profiles/assets` (dev dependency, pinned) into `dist/assets/xr-profiles-<version>/`
(`scripts/copy-xr-profiles.mjs`, also run by `npm run dev`; not committed) — never the jsDelivr default. Facts and
sources: `docs/research/web-xr.md`. `e2e/xr.spec.ts` emulates a Quest 3 with Meta's IWER (dev dependency `iwer`) and
serves the page with the relay's CSP.

```bash
npm test -w web-viewer -- xr && npm run e2e -w web-viewer -- xr
```

### Leave (WEB-22)

**Leave** ends the session for this viewer — `viewer.leave` and close `1000` when a socket is open, else the pending
retry is cancelled — drops the scene and brings back an empty code entry. It is in the status bar over the scene
(drawn small, with a 44 × 44 px target) and on the code entry while it is busy (joining, waiting for the presenter or
the first download, reconnecting). The installed app needs it: it has no address bar, reload or (iOS) back button.
`connection.leave()` now ends in `idle` from every state, so a scheduled code join after a relay restart is
cancelled too.

```bash
npm test -w web-viewer -- status-bar code-entry screens reconnect connection && npm run e2e -w web-viewer -- leave
```

### New snapshot of the same scene (WEB-25)

Slicer exports the whole scene again when a structure is edited (§8.2). A snapshot that continues the scene on screen
keeps the user's camera, and in XR the scene where the user put it: `Viewer.setModel` then only re-measures the model
for the clip planes and the zoom limits, widened so they never move the camera, and draws one frame (`follow()`, also
run by `contentChanged` for live updates). It continues the scene when it has at least one `nodeId` of it (§7.3) and
the two whole-model bounding spheres overlap (`continuesScene` in `src/render/viewer.ts`; the scene on screen is
measured again after live updates, whose transforms can move it): Slicer restarts its ids when a scene is closed, so
another scene loaded in one step can come under the old ids, elsewhere. Anything else — another scene, a scene after
an empty one — is framed from the front, in XR placed in front, with the presenter's values, as before. Only for a
snapshot that continues the scene (`Viewer.continues`, the same decision, asked before the screens show it) do the
node panel's local hides and opacities move to it by `nodeId` and name (`LiveScene.carryTo`, in `main.ts`), unless
the snapshot changed that property; then the presenter's value wins and the viewer says `The presenter changed
<name>` (FR-40, WEB-13).

```bash
npm test -w web-viewer -- viewer apply-update && npm run e2e -w web-viewer -- new-snapshot xr
```

