# Research A3: Web viewer stack (three.js, Safari iOS, WebXR, deep links, WebSocket, Vite, testing)

Status: research note, written by `architect` on 2026-10-17. All version numbers were checked on that date
(npm registry / official docs). Claims that could not be verified against an official source are marked
`[TODO verify]`. Numbered references `[n]` point to the "Sources" section.

## Key findings for the design

- **three.js r186 (npm `three@0.186.1`)** is current; releases are irregular (~2–3 months lately: r183 20 Feb, r184 16 Apr, r185 1 Jul, r186 24 Sep 2026). Pin the exact version; the addon import path is `three/addons/...` [1][2].
- **WebGL 2 only**: `WebGLRenderer` throws if WebGL 1 is requested ("WebGL 1 is not supported since r163") and calls `getContext('webgl2')` only. Safari ≥ 15 (desktop and iOS) ships WebGL 2 by default, so this is acceptable for the target devices; still gate startup with `WebGL.isWebGL2Available()` [3][4][5].
- **GLB from WebSocket**: `GLTFLoader.parse(arrayBuffer, path, onLoad, onError)` detects the GLB magic `glTF` and parses the binary container directly; no `fetch` or object URL is needed [6].
- **Compression decoders are optional add-ons**: Draco needs `draco_wasm_wrapper.js` (58 KB) + `draco_decoder.wasm` (192 KB) copied to a static path and `setDecoderPath()`; meshopt is a single 29 KB ES module (`meshopt_decoder.module.js`, WASM embedded) and `KHR_mesh_quantization` is handled natively through `normalized` buffer attributes. **Recommendation**: use `KHR_mesh_quantization` (+ optional `EXT_meshopt_compression`) first; add Draco only if measured sizes require it [6][7][8][9][10].
- **Explicit disposal is mandatory**: removing an object from the scene frees nothing; call `geometry.dispose()`, `material.dispose()` and `texture.dispose()` separately (materials do not dispose their textures). Check `renderer.info.memory` for leaks. r186 adds `Object3D.dispose()` [11][2].
- **OrbitControls** is the right default for touch: one finger rotates, two fingers pinch-zoom and pan (`touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }`), `enableDamping` (default off, factor 0.05) needs `update()` per frame while settling, and `connect()` sets `touch-action: none` on the canvas. TrackballControls has no rotation limits (free roll) and damping on by default (`dynamicDampingFactor = 0.2`), which is less predictable for clinical viewing [12][13].
- **Render on demand**: render only on `controls.change`, incoming updates, resize and visibility; with damping, keep requesting frames until `update()` stops emitting `change`. This is the single biggest battery saver on phones [14].
- **Transparency**: three.js sorts transparent objects per object (by `renderOrder`, then camera depth), never per triangle. Use one `Mesh` per anatomical node, `transparent = true` only when `opacity < 1`, and consider `depthWrite = false` for semi-transparent segmentations layered over opaque bone; set `renderOrder` for deterministic layering [15][16][17].
- **Safari iOS memory is a policy budget, not RAM**: there is no published WebGL memory limit; a WebKit engineer states the WebContent process limit is ~1.5 GB on most iPhones (higher on iPad), and texture-heavy pages get killed and reloaded in a loop without any `webglcontextlost` event. Design for a scene budget well under 1 GB of JS+GPU memory, free the GLB `ArrayBuffer` after parsing, and handle `webglcontextlost` anyway (three.js already calls `preventDefault()` and re-initialises on restore) [18][19][20][3].
- **Mobile page behaviour**: Safari iOS ignores `user-scalable=no`; use `touch-action: none` on the canvas plus `gesturestart` `preventDefault()` for Safari; use `100dvh`/`100svh` instead of `100vh` (Safari iOS ≥ 15.4, Chrome Android); use `viewport-fit=cover` and `env(safe-area-inset-*)` for notch devices [21][22][23][24].
- **Wake Lock** (`navigator.wakeLock.request('screen')`) works in Safari ≥ 16.4, Chrome 84+, Firefox 126+; it needs HTTPS, is released when the page is hidden and must be re-requested on `visibilitychange` [25][26].
- **PWA**: a manifest with `display: standalone`, 192/512 px icons and `start_url` is enough for "Add to Home Screen" on iOS ≥ 16.4 and for Chrome Android's install menu (service worker no longer required for menu install since Chrome 108). Keep `apple-touch-icon` because it takes precedence over manifest icons on iOS [27][28][29][30].
- **WebXR**: `navigator.xr` is `[SecureContext]` (HTTPS mandatory); Safari iOS has **no** WebXR at all (visionOS Safari 18 has `immersive-vr`). Meta Quest Browser (152.1, Chromium 146+) supports `immersive-vr`, `immersive-ar` passthrough (transparent canvas; passthrough pixels are not readable) and hand tracking with 25 joints. three.js provides `XRButton` (AR-first, then VR), `XRControllerModelFactory` (loads controller meshes from a jsDelivr CDN by default; override with `setPath`) and `XRHandModelFactory` (`spheres` / `boxes` / `mesh`) [31][32][33][34][35][36][37][38][39][40].
- **Fragment deep link `/j#ABCDE`**: RFC 3986 §3.5 says the fragment is "dereferenced solely by the user agent" and is separated before dereference, so it never appears in the HTTP request, server logs, or `Referer`. Read it with `location.hash`, then `history.replaceState(null, '', '/j')` to remove the code from the address bar and history. The relay must serve `index.html` for `/j` (SPA fallback with `@fastify/static`) [41][42][43][44].
- **WebSocket in browsers**: set `binaryType = 'arraybuffer'`; the API exposes no `ping()` (ping/pong frames are "not currently exposed"), so liveness must be an application-level heartbeat; no maximum message size is specified by the spec, while the `ws` server defaults to `maxPayload` = 100 MiB and closes with 1009 when exceeded. Chunk large GLBs at the protocol level and reassemble client-side; reconnect with exponential backoff and treat the socket as dead after `visibilitychange` on iOS [45][46][47][48][49].
- **Vite 8.3.4** (Rolldown bundler, Node ≥ 20.19 / ≥ 22.12, default target `baseline-widely-available` = Safari/iOS 16.4+): `build.rollupOptions` → `build.rolldownOptions`, object-form `manualChunks` removed, dev WS proxy via `server.proxy[...].ws = true`, only `VITE_`-prefixed env vars reach the client [50][51][52][53][55][56].
- **Testing**: Vitest 5.0.5 (peer Vite ^6.4 || ^7 || ^8) for pure logic; Playwright 1.64.1 bundles Chromium 156 / WebKit 27.2 and ships descriptors like `iPhone 15` (393×659 viewport, DPR 3, webkit) and `Pixel 7` (412×839, DPR 2.625, chromium). Headless Chromium needs `--enable-unsafe-swiftshader` (plus `--use-gl=angle --use-angle=swiftshader-webgl`) for software WebGL; Playwright itself does not add GPU flags [67][69][70][73][74].

## 1. three.js

### 1.1 Version and cadence

- Latest release: **r186**, 24 Sep 2026; npm `three@0.186.1` (patch 0.186.1 exists). Previous: r185 1 Jul, r184 16 Apr, r183 20 Feb 2026, i.e. roughly every 2–3 months, with no LTS branch and frequent breaking changes documented in the migration guide between consecutive releases [1][2]. Decision input: pin `three` to an exact version in `web-viewer/package.json` and upgrade deliberately.
- Addon modules (loaders, controls, WebXR helpers) live under `three/addons/*` (`examples/jsm/*` in the repository) [6].
- `WebGLRenderer` is WebGL 2 only: the constructor throws `'THREE.WebGLRenderer: WebGL 1 is not supported since r163.'` and requests `'webgl2'` only. Defaults: `antialias = false`, `alpha = false`, `powerPreference = 'default'`, `sortObjects = true` [3]. The manual recommends `WebGL.isWebGL2Available()` / `WebGL.getWebGL2ErrorMessage()` from `three/addons/capabilities/WebGL.js` before creating the renderer [4].

### 1.2 GLTFLoader, GLB from an ArrayBuffer

- `loader.parse(data, path, onLoad, onError)` accepts a JSON string, an `ArrayBuffer` or an object. For an `ArrayBuffer` it reads the first 4 bytes, compares them with the GLB magic `glTF`, and if they match parses the binary container (JSON chunk `0x4E4F534A`, BIN chunk `0x004E4942`, unknown chunk types skipped; version < 2 rejected) [6]. This is exactly what the viewer needs for a GLB received over WebSocket; `path` can be `''` because the snapshot must be self-contained (no external URIs).
- `setDRACOLoader()`, `setMeshoptDecoder()`, `setKTX2Loader()` are chainable setters; the loader throws if a file *requires* an extension whose decoder was not provided (`'No DRACOLoader instance provided.'`, `!decoder.supported` for meshopt) [6].
- Supported extension constants include `KHR_draco_mesh_compression`, `KHR_mesh_quantization`, `EXT_meshopt_compression`, `KHR_texture_basisu`, `EXT_mesh_gpu_instancing` [6].
- Limitation: the parse is asynchronous but runs on the main thread (except Draco/meshopt decoding in workers). Multi-MB GLBs with many primitives can block the UI for hundreds of ms on phones. `[TODO verify]` measured parse time for a realistic 20 MB anatomical GLB on an iPhone; consider parsing in a Web Worker (three.js has no built-in worker GLTFLoader).

### 1.3 Decoders: Draco, meshopt, KHR_mesh_quantization

- **DRACOLoader**: `setDecoderPath(path)` resolves `draco_wasm_wrapper.js`, `draco_decoder.wasm`, `draco_decoder.js` relative to `path` (or accepts an object with explicit `js`/`wasm` URLs). WASM is used when `typeof WebAssembly === 'object'`, otherwise the JS fallback. Default `workerLimit = 4`; `preload()` starts loading early; `dispose()` terminates workers. `setDecoderConfig()` is deprecated ("will be removed in r194") [7]. File sizes in `examples/jsm/libs/draco/gltf/`: `draco_decoder.wasm` 192,420 B, `draco_wasm_wrapper.js` 58,456 B, `draco_decoder.js` 512,465 B (JS fallback only) [8]. These files are **not** bundled by Vite automatically: copy them to `public/draco/` and call `setDecoderPath('/draco/')` (or import with `?url`) [52].
- **meshopt**: `examples/jsm/libs/meshopt_decoder.module.js` is 29,256 B with the WASM embedded; the upstream README documents `MeshoptDecoder.ready` (Promise), `supported` (boolean), `decodeGltfBuffer(target, count, size, source, mode, filter)`, `useWorkers(count)` and `decodeGltfBufferAsync`. GLTFLoader prefers `decodeGltfBufferAsync` and falls back to `ready.then(decodeGltfBuffer)` for decoders ≤ 0.18 [9][6].
- **KHR_mesh_quantization**: allows `BYTE`/`SHORT` (normalized or not) for `POSITION`, `BYTE`/`SHORT` normalized for `NORMAL`/`TANGENT`, 8/16-bit for `TEXCOORD`; accessors must be 4-byte aligned. It must be listed in `extensionsRequired` (no float fallback). The spec example reduces a PBR vertex from 48 to 20 bytes. GLTFLoader needs no decoder: it passes `accessorDef.normalized` into `BufferAttribute`, so quantized data is uploaded as-is to the GPU [10][6].
- Design input: anatomical meshes have no textures, so vertex data dominates. Quantization (free, no WASM) plus optional meshopt (29 KB, fast) is the pragmatic default; Draco gives the best ratio but costs ~250 KB of decoder download plus decode time. The Slicer exporter side must support the same extension set (coordinate with `slicer` research).
- Instancing (`EXT_mesh_gpu_instancing`, `InstancedMesh`) is not needed: each anatomical node is unique geometry.

### 1.4 Disposing GPU resources

- `BufferGeometry.dispose()` frees the WebGL buffers; `Material.dispose()` frees the shader program only when no other material uses it and **does not dispose textures**; `Texture.dispose()` frees the `WebGLTexture` (and `ImageBitmap.close()` is the app's job); `WebGLRenderTarget.dispose()` frees texture + framebuffers; controls have `dispose()` for event listeners. Removing a mesh from the scene frees nothing. `renderer.info.memory` reports live geometries/textures/programs. Objects can be re-used after `dispose()` (resources are re-created, causing a frame hitch); renderers and controls cannot [11].
- r186 adds `Object3D.dispose()` (#34141) [2]; `[TODO verify]` whether it recursively disposes geometry/material of children or only the object's own resources, before relying on it instead of a `scene.traverse` cleanup.
- Design input: on a new snapshot, traverse the old root, dispose geometry + material per mesh, and drop the reference to the received `ArrayBuffer` so the JS heap can shrink (important on iOS, section 2.2).

### 1.5 Controls on touch

- **OrbitControls**: `touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }` by default; two-finger dolly uses the ratio of finger distances (`Math.pow(dollyEnd.y / dollyStart.y, zoomSpeed)`), pan uses the midpoint. `enableDamping = false`, `dampingFactor = 0.05`, `zoomToCursor = false` by default. Uses Pointer Events with `setPointerCapture`, handles `pointercancel`, and `connect()` sets `domElement.style.touchAction = 'none'`. `update()` returns `true` and dispatches `change` only when the camera actually moved; with damping, `update()` must run every frame until the motion settles [12].
- **TrackballControls**: one finger rotates, two fingers zoom + pan (`TOUCH_ZOOM_PAN`), `staticMoving = false` (damping on), `dynamicDampingFactor = 0.2`, optional `multiTouchRoll`. Input handlers only record positions; `update()` must be called every frame. No polar-angle limit, so the model can roll freely — disorienting for anatomy [13].
- Recommendation: OrbitControls with `enableDamping = true`, `screenSpacePanning = true`, target set to the scene bounding-box centre, `minDistance`/`maxDistance` from the bounding sphere. Use `ArcballControls` only if clinicians require free roll `[TODO verify]` (not evaluated).

### 1.6 Many objects, visibility, opacity, transparency

- Per-node toggles map to `Object3D.visible` (descendants of invisible objects are not traversed/rendered) and `Object3D.layers` (object rendered only if it shares a layer with the camera) [16].
- Opaque objects are sorted by `groupOrder`, `renderOrder`, `material.id`, `materialVariant`, then depth (`painterSortStable`); transparent/transmissive objects by `groupOrder`, `renderOrder`, then **reverse depth** (`reversePainterSortStable`) — per object, never per triangle [15]. The manual's transparency article confirms sorting is per `Mesh`, `DoubleSide` is unreliable for self-overlapping transparent geometry, and recommends separate objects per overlapping part [17].
- `Material` defaults: `transparent = false`, `opacity = 1`, `depthWrite = true`, `depthTest = true`, `side = FrontSide`, `forceSinglePass = false`, `alphaToCoverage = false` [16]. Opacity has no visual effect unless `transparent = true`; toggling `transparent` changes the render list bucket, so set it only when `opacity < 1`.
- Practical recipe for segmentations over bone: keep opaque nodes `depthWrite = true`; for semi-transparent nodes set `transparent = true`, `depthWrite = false` (avoids holes where one transparent mesh writes depth over another) and a stable `renderOrder` (e.g. by node order from Slicer). Accept that intersecting transparent segmentations will show order artefacts; Order-Independent Transparency is only available on the WebGPU path (`OITPassNode`) and is out of scope [15][17].
- Scenes with hundreds of segments: one draw call per mesh; `[TODO verify]` draw-call budget on a mid-range Android phone — if > ~300 meshes, merge opaque meshes sharing a material.

### 1.7 Render on demand

- Pattern from the three.js manual: a `renderRequested` flag plus `requestRenderIfNotRequested()` → `requestAnimationFrame(render)`; `render()` clears the flag, calls `controls.update()`, renders. Listen to `controls.addEventListener('change', requestRenderIfNotRequested)` (not `render` directly, or damping loops forever), `window.resize`, and any data change. With damping each `update()` emits `change` so frames continue until motion settles [14].
- In WebXR the renderer must drive the loop (`renderer.setAnimationLoop`) and renders every frame; render-on-demand applies only to the 2D mode [36][3].
- Also stop rendering when `document.visibilityState !== 'visible'`.

## 2. Safari iOS limits

### 2.1 WebGL memory and context loss

- No official WebGL memory limit is published. WebKit bug 300782 (filed 2025-10-15, status NEW as of 2026-03-11, Safari/iOS 18) describes texture-heavy WebGL pages being killed under memory pressure and immediately reloaded in a loop ("A problem repeatedly occurred"), with **no OOM error and no `webglcontextlost` event** before termination. A commenter notes the limit is a policy budget rather than physical RAM; a WebKit engineer asked for a reproduction, no fix committed [18].
- WebKit bug 268816 (2024): a WebKit engineer states the WebContent process limit is "about 1.5 GB on most iPhones" (may be exceeded without system pressure), higher on iPad (4 GB+ on an 8 GB model) [19]. Earlier (2018) the jetsam limit was a hard-coded 840 MB, later read from the system [20].
- Design input: budget total resident memory (decoded GLB `ArrayBuffer` + three.js geometry copies + GPU buffers) well below 1 GB on iPhone; free the raw buffer after parse; avoid textures; prefer quantized attributes (half the GPU memory of float32). Register `webglcontextlost`/`webglcontextrestored` on the canvas: three.js already calls `event.preventDefault()` on loss (so restore can happen), skips rendering while lost and re-initialises GL state on restore [3]; the app additionally needs to re-request a render and show a status message. `webglcontextcreationerror` should surface a user-visible error.

### 2.2 JS heap / ArrayBuffer

- The per-process limit above also bounds the JS heap: a 2021 WebKit bug reproduced a jetsam at > 1.5 GB; the ArrayBuffer maximum length is spec-sized but allocation fails when the process limit is hit [19][20]. No official per-`ArrayBuffer` cap documented `[TODO verify]`.
- Consequence for the protocol: a 50 MB GLB received as one `ArrayBuffer` plus three.js copies is fine; several hundred MB is not. Chunked transfer still ends in one contiguous buffer for `GLTFLoader.parse`, so chunking helps flow control and progress, not peak memory.

### 2.3 WebGL 2 support

- Safari desktop and iOS enable WebGL 2 by default from **version 15** (Safari 10.1–14.x had it behind a flag) [5]. Safari 18 adds further WebGL extensions and renders visionOS WebXR via WebGL [57]. iOS 15 is well below Vite's default `safari16.4` target, so WebGL 2 can be assumed; still show a friendly error when `getContext('webgl2')` returns `null`.

### 2.4 Viewport, 100vh, pinch zoom, safe areas

- `vh` equals `lvh` (largest viewport, browser UI retracted), so `100vh` overflows while the Safari toolbar is visible. `svh` is stable and never hidden behind UI; `dvh` tracks the UI but resizes during scroll [23]. Dynamic viewport units are supported in Safari iOS ≥ 15.4, Firefox ≥ 101, Chrome Android [24]. Use `height: 100svh` (or `100dvh` for a fixed, non-scrolling canvas page) with a `100vh` fallback, and prefer a `ResizeObserver` on the canvas container.
- Safari on iOS ≥ 10 ignores `user-scalable=no`; reported workarounds are `touch-action` CSS and a `gesturestart` listener calling `preventDefault()` [21]. `touch-action: none` disables all browser pan/zoom gestures on the element (OrbitControls sets this on the canvas); `touch-action: manipulation` keeps pinch-zoom but removes double-tap zoom and its click delay — use it on UI buttons. Accessibility note: blocking zoom on text content is a WCAG failure, so block it only on the canvas [22].
- `viewport-fit=cover` plus `env(safe-area-inset-*)` (iOS ≥ 11.2) lets the canvas fill notch devices while UI padding stays in the safe area; combine with `max(12px, env(safe-area-inset-left))` [58].

### 2.5 Wake lock

- Screen Wake Lock API: Safari/iOS ≥ 16.4, Chrome 84, Edge 84, Firefox 126 [25]. Secure context required; `Permissions-Policy: screen-wake-lock` default allowlist `self`; the sentinel is released when the page is hidden or on low battery, so re-request on `visibilitychange` when `visibilityState === 'visible'`; feature-detect with `'wakeLock' in navigator` [26][59]. Design input: request the lock while connected to a session, release on disconnect, and show a toggle.

### 2.6 PWA on iOS and Android

- iOS: `<meta name="apple-mobile-web-app-capable" content="yes">` enables standalone mode, `apple-mobile-web-app-status-bar-style`, `<link rel="apple-touch-icon">` and `navigator.standalone` are the legacy Apple mechanisms [27]. Since iOS/iPadOS 16.4 a site whose manifest `display` is `standalone` or `fullscreen` opens as a Home Screen web app, Web Push/Badging work, third-party browsers can offer Add to Home Screen, `apple-touch-icon` takes precedence over manifest icons, and Screen Wake Lock / Screen Orientation are supported in web apps [28].
- Android/Chrome install criteria: HTTPS, manifest with `name`/`short_name`, 192 px and 512 px icons, `start_url`, `display` ∈ {fullscreen, standalone, minimal-ui, window-controls-overlay}, `prefer_related_applications` not true; `beforeinstallprompt` lets the page show its own install button [29]. The service-worker `fetch()` handler is no longer required for menu installation since Chrome 108 (mobile) / 112 (desktop); the automatic prompt still requires one [30].
- `display` fallback chain `fullscreen → standalone → minimal-ui → browser`; detect with `@media (display-mode: standalone)` [60].
- Design input: a PWA is optional for v1 (users arrive via QR each time). If added, `start_url` must be `/` (not `/j#CODE`); deep links still work because iOS opens matching URLs in Safari, not necessarily in the installed app `[TODO verify]` scope handling on iOS.

## 3. WebXR (optional milestone, Meta Quest Browser)

- `navigator.xr`, `XRSystem` and `XRSession` are `[SecureContext]` in the spec: WebXR requires HTTPS (or `localhost`) [31]. three.js `XRButton`/`VRButton` render a "WEBXR NEEDS HTTPS" link when `navigator.xr` is missing and `isSecureContext === false` [33][34].
- Safari on iOS: **not supported** in any version (caniuse); desktop Safari lists it "disabled by default"; Safari 18 on visionOS 2 adds `immersive-vr`, `transient-pointer` input and hand tracking [32][57]. Conclusion: the iPhone/iPad path is 2D only; no AR Quick Look fallback is planned.
- Meta Quest Browser: latest 152.1 (2 Oct 2026); 2026 releases track Chromium milestones (144 in March, 146 in April) and add experimental WebGPU/XR features [35]. `immersive-ar` passthrough is supported (check `isSessionSupported('immersive-ar')`, render on a transparent background, passthrough pixels are not readable by the page; `plane-detection` optional) [37]. Hand tracking exposes 25 joints per hand via `XRHand` / `getJointPose` / `fillPoses`; hands appear as `XRInputSource`s alongside controllers; palm pinch is reserved for the system [38]. Simultaneous hands + controllers was added in Browser 31.4 (Feb 2024) and re-enabled in 33.0 per secondary sources `[TODO verify]` against Meta's own notes [61].
- three.js helpers: `XRButton.createButton(renderer, sessionInit)` tries `immersive-ar` first, then `immersive-vr`; default `optionalFeatures` are `local-floor`, `bounded-floor`, `layers` (+ caller's); **`hand-tracking` must be added explicitly**; on success it calls `renderer.xr.setSession(session)` [33]. `VRButton` is VR-only with the same defaults [34]. `renderer.xr.enabled = true` and `renderer.setAnimationLoop(fn)` are required; units are metres, so place the model at ~1.2–1.6 m height and scale mm → m (Slicer uses mm) [36].
- `XRControllerModelFactory(gltfLoader?, onLoad?)` fetches profiles from `DEFAULT_PROFILES_PATH = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles'`, fallback profile `generic-trigger`; override with `setPath()` to self-host the assets (avoid third-party CDN calls from a medical viewer) [39]. `XRHandModelFactory(gltfLoader?, onLoad?)`: `createHandModel(controller, 'spheres' | 'boxes' | 'mesh')`; `mesh` needs `setPath()` to hand GLBs; the model attaches on the `connected` event when `event.data.hand` is present [40].
- Limitation: `renderer.xr` + WebGL path only; the WebGPU renderer's XR support in Quest Browser is experimental [35]. Quest resolution and 72–90 Hz mean a 50 MB anatomical scene must be reduced (decimation on the Slicer side) `[TODO verify]` triangle budget for Quest 3 in Browser.

## 4. Deep link with the code in the URL fragment

- RFC 3986 §3.5: the fragment "is separated from the rest of the URI prior to a dereference" and is "dereferenced solely by the user agent, regardless of the URI scheme" — it is never part of the request sent to the server, so `/j#ABCDE` arrives at the relay as `GET /j`; the code cannot appear in access logs, proxy logs or `Referer` headers [41]. This satisfies CLAUDE.md rule 6 (codes never in URL paths or logs).
- Client side: `location.hash` returns `'#ABCDE'` (or `''`); normalise (uppercase, strip `#`, validate the 5-character alphabet) before use [42]. Then call `history.replaceState(null, '', '/j')` to remove the code from the address bar/history without reloading (same-origin only, no `popstate`) so screenshots, shared tabs and history do not leak it [43]. Listen to `hashchange` only if codes can be re-entered via URL.
- Server side: `@fastify/static` has no SPA option; serve `index.html` for `/j` either with an explicit route or `setNotFoundHandler` + `reply.sendFile('index.html')` (requires `wildcard: false` in encapsulated contexts), with `Cache-Control: no-cache` for `index.html` and `immutable, max-age=30d` for hashed assets [44]. Alternatively make `/j` a static `j.html` entry in Vite (multi-page) to avoid any fallback logic.
- QR generation on the Slicer side: Python `qrcode` 8.2 (Python ≥ 3.9) renders PNG via `pypng` without Pillow (`PyPNGImage` factory) or SVG (`SvgPathImage`), so no compiled dependency is needed [62]. Slicer 5.11+ recommends `slicer.packaging.pip_ensure()` (asks the user, shows progress, skips in testing mode) and warns against installing at module import time [63]. Alternative without any dependency: the server exposes `GET /qr?url=` — rejected, because the URL would carry the code to the server; generate locally instead.
- Scanning on the phone: iOS Camera recognises QR codes natively and shows a tappable link [64]; Android 9+ stock cameras and Google Lens do the same per third-party guides `[TODO verify]` against Google's support page [65]. The encoded URL must be `https://<host>/j#ABCDE` (uppercase, no query string). Universal Links are not required.

## 5. WebSocket in browsers

- API surface (WHATWG): `readyState`, `bufferedAmount`, `extensions`, `protocol`, `binaryType`, `close(code?, reason?)`, `send(BufferSource | Blob | string)`; **no `ping()`** — ping/pong frames "are not currently exposed in the API"; no maximum message size specified [45]. `binaryType` defaults to `'blob'`; set `'arraybuffer'` to read frames synchronously with `DataView`/typed arrays [46].
- Server side (`ws`): `maxPayload` defaults to 104,857,600 bytes (100 MiB) and oversize messages raise `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` (close code 1009 "Message Too Big" per the WebSocket close codes); `websocket.ping()` exists server-side only [47][48]. Browser-side limits are undocumented `[TODO verify]` (Chromium/WebKit have internal buffer limits); keep each application message ≤ 1–4 MiB and chunk the GLB: `{type:'snapshot-begin', bytes, chunks, sha256}` → N binary frames → `{type:'snapshot-end'}`; the client pre-allocates one `Uint8Array(bytes)` and copies chunks in (`set(chunk, offset)`), giving progress UI and bounded per-frame memory. Protocol choice belongs to `docs/protocol.md`.
- Heartbeat: the server pings (`ws.ping()`) and terminates on missing pong; the browser cannot see pings, so it needs an application-level `{type:'hb'}` every ~15 s and must treat silence > 2 intervals as stale. Close codes to classify: 1000 normal, 1001 going away, 1006 abnormal (no close frame: network drop), 1008 policy, 1009 too big, 1011 server error, 1012 restart, 1013 try again later [48].
- Reconnect: exponential backoff with jitter (e.g. 0.5 s → 30 s cap), reset on a successful hello; on 1008/4xxx application codes (invalid or expired code) stop and show the code entry. iOS Safari background behaviour: the server sees the client vanish when Safari is backgrounded, the page gets `onclose` only on return to the foreground, and `readyState` can be stale; the common pattern is to force a reconnect on `visibilitychange → visible` (anecdotal forum reports; behaviour changed across iOS versions) `[TODO verify]` on iOS 26 hardware [49].

## 6. Vite

- Current: **Vite 8.3.4**; Node `^20.19.0 || >=22.12.0` (Node 22 LTS fits the server stack); bundler is Rolldown (`rolldown ~1.2.12`), `esbuild` only an optional peer [50]. Vite 8 announced 12 Mar 2026, 8.1 on 23 Jun 2026 [51].
- Migration/config facts: `build.rollupOptions` → `build.rolldownOptions` (alias deprecated), object-form `manualChunks` unsupported and function form deprecated in favour of Rolldown's `codeSplitting` option (`[TODO verify]` exact schema), `esbuild` options auto-converted to `oxc`, Lightning CSS default minifier [52]. `build.target` default `'baseline-widely-available'` = `chrome111, edge111, firefox114, safari16.4, ios16.4`; `outDir = dist`; `assetsInlineLimit = 4096`; `chunkSizeWarningLimit = 500` kB [53].
- Code splitting of decoders: dynamic `import('three/addons/loaders/DRACOLoader.js')` creates a separate chunk automatically; Draco WASM/JS files are loaded by `DRACOLoader` at runtime via `fetch`, so place them in `public/draco/` (copied verbatim to `dist/`, referenced as `/draco/`) or import with `?url` / `new URL('./x.wasm', import.meta.url)` (rewritten to hashed assets at build) [54]. meshopt's module embeds its WASM and can simply be imported (29 KB) [9].
- Dev proxy for WS: `server.proxy['/ws'] = { target: 'ws://localhost:8787', ws: true }`; Vite does not check the WS origin before proxying and warns that `rewriteWsOrigin` opens CSRF risk — do not enable it; `server.https` with `@vitejs/plugin-basic-ssl` provides a self-signed cert for phone testing on the LAN (needed for Wake Lock and WebXR, which require secure contexts) [55].
- Env: only `VITE_*` variables reach the client (`import.meta.env.VITE_WS_URL`), bundled at build time (never secrets); built-ins `MODE`, `BASE_URL`, `PROD`, `DEV`, `SSR`; `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local` with shell variables taking priority; type them by augmenting `ImportMetaEnv` in `src/vite-env.d.ts` (no `import` statements in that file) [56]. Recommendation: derive the WS URL from `location` at runtime (`wss://${location.host}/ws`) so one build serves every deployment; use `VITE_*` only for dev overrides.
- Serving from Fastify: `@fastify/static` 10.1.6 (Fastify ^5, `@fastify/send` ^4): `root: dist`, `prefix: '/'`, `wildcard` default true, `preCompressed: true` serves `.br`/`.gz` variants with `Vary: Accept-Encoding` (generate them in CI); per-file `maxAge`/`immutable` overrides; the README recommends a reverse proxy/CDN for production caching [44][66].

## 7. Testing

- **Vitest 5.0.5** (peer `vite ^6.4.0 || ^7.0.0 || ^8.0.0`) for protocol parsing, chunk reassembly, backoff timers, scene-graph diffing (pure functions, Node environment) [67]. Vitest Browser Mode runs tests in a real browser via the `playwright` provider (`test.browser.enabled`, `instances: [{ browser: 'chromium' }]`); it is the way to test three.js code that needs a real `WebGL2RenderingContext` instead of jsdom [68].
- **Playwright 1.64.1** bundles Chromium 156.0.8078.4 (also as headless shell), Firefox 157, WebKit 27.2 [69]. Device descriptors (168 entries incl. landscape) are spread into a project's `use`: `iPhone 15` → viewport 393×659, screen 393×852, DPR 3, `isMobile`, `hasTouch`, `defaultBrowserType: 'webkit'`; `iPhone 17 Pro Max`, `iPad Pro 11` (834×1194, DPR 2, webkit); `Pixel 7` → 412×839, DPR 2.625, chromium; `Galaxy S24`, `Pixel 10` also present. `isMobile` makes the meta viewport honoured and enables touch events; override `viewport` after the spread [70][71]. Limitation: Playwright's WebKit is a patched WebKit build, "not the branded version of Safari"; iOS memory limits, jetsam and real-device GPU behaviour cannot be emulated — keep a manual device test checklist in `docs/testing/web.md` [72].
- **WebGL in headless Chromium**: Chromium deprecated the automatic SwiftShader fallback ("WebGL context creation will soon fail instead of falling back to SwiftShader"); the documented opt-in is `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`, flagged "not intended for running untrusted content" (acceptable in CI) [73]. Playwright adds no GPU switches of its own, so pass them via `launchOptions.args` in the Chromium projects [74]. New headless (`channel: 'chromium'`) is "the real Chrome browser"; the headless shell is the legacy binary — prefer `channel: 'chromium'` for WebGL fidelity [72][75]. WebGL in headless WebKit on Linux CI `[TODO verify]`; plan WebKit runs for layout/touch, Chromium runs for rendering assertions (e.g. read back pixel colours after toggling a node).

## Open questions

1. Measured parse time and peak memory for a realistic 20–50 MB anatomical GLB in Safari iOS (section 1.2, 2.1) — needs a prototype on hardware.
2. Exact semantics of `Object3D.dispose()` added in r186 (recursive or not).
3. Exact Rolldown `codeSplitting` schema for isolating the Draco chunk.
4. Browser-side WebSocket message size limits (Chromium/WebKit) — none documented.
5. iOS 26 behaviour of WebSockets in background tabs and after Home Screen web-app resume.
6. Quest 3 triangle/draw-call budget in Quest Browser for the optional WebXR milestone.
7. Whether WebGL works in Playwright's headless WebKit on Linux CI.

## Sources

1. three.js releases — https://github.com/mrdoob/three.js/releases (r186 24 Sep 2026, r185 1 Jul, r184 16 Apr, r183 20 Feb)
2. three.js r186 release notes — https://github.com/mrdoob/three.js/releases/tag/r186 ; npm — https://registry.npmjs.org/three/latest (0.186.1)
3. `WebGLRenderer.js` source (r186 dev) — https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/WebGLRenderer.js
4. three.js manual, WebGL compatibility check — https://github.com/mrdoob/three.js/blob/dev/manual/pages/webgl-compatibility-check.html
5. caniuse WebGL 2.0 — https://caniuse.com/webgl2
6. `GLTFLoader.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/loaders/GLTFLoader.js
7. `DRACOLoader.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/loaders/DRACOLoader.js
8. Draco decoder file sizes — https://api.github.com/repos/mrdoob/three.js/contents/examples/jsm/libs/draco/gltf
9. meshoptimizer JS README — https://github.com/zeux/meshoptimizer/blob/master/js/README.md ; size — https://api.github.com/repos/mrdoob/three.js/contents/examples/jsm/libs
10. KHR_mesh_quantization spec — https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md
11. three.js manual, How to dispose of objects — https://github.com/mrdoob/three.js/blob/dev/manual/pages/how-to-dispose-of-objects.html
12. `OrbitControls.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/controls/OrbitControls.js
13. `TrackballControls.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/controls/TrackballControls.js
14. three.js manual, Rendering on demand — https://github.com/mrdoob/three.js/blob/dev/manual/pages/rendering-on-demand.html
15. `WebGLRenderLists.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl/WebGLRenderLists.js
16. `Material.js` and `Object3D.js` sources — https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js , https://raw.githubusercontent.com/mrdoob/three.js/dev/src/core/Object3D.js
17. three.js manual, Transparency — https://github.com/mrdoob/three.js/blob/dev/manual/pages/transparency.html
18. WebKit bug 300782 (iOS reload loop under WebGL memory pressure) — https://bugs.webkit.org/show_bug.cgi?id=300782
19. WebKit bug 268816 (WebContent process ~1.5 GB limit on iPhone) — https://bugs.webkit.org/show_bug.cgi?id=268816 ; bug 227636 — https://bugs.webkit.org/show_bug.cgi?id=227636
20. WebKit jetsam limit patch (2018) — https://lists.webkit.org/pipermail/webkit-reviews/2018-July/552203.html
21. WebKit bug 186970 and discussion of `user-scalable=no` being ignored on iOS ≥ 10 — https://bugs.webkit.org/show_bug.cgi?id=186970 , https://github.com/w3c/html/issues/602
22. MDN `touch-action` — https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
23. MDN CSS length units (svh/lvh/dvh) — https://developer.mozilla.org/en-US/docs/Web/CSS/length
24. caniuse viewport unit variants — https://caniuse.com/viewport-unit-variants
25. caniuse Screen Wake Lock — https://caniuse.com/wake-lock ; Chrome article — https://developer.chrome.com/articles/wake-lock/
26. MDN Screen Wake Lock API — https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
27. Apple, Configuring Web Applications (legacy meta tags) — https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
28. WebKit blog, Web Push for Web Apps on iOS and iPadOS (16.4) — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
29. web.dev, Install criteria — https://web.dev/articles/install-criteria
30. Chrome blog, Revisiting Chrome's installability criteria — https://developer.chrome.com/blog/update-install-criteria
31. WebXR Device API spec, `navigator.xr` `[SecureContext]` — https://immersive-web.github.io/webxr/#navigator-xr-attribute
32. caniuse WebXR — https://caniuse.com/webxr
33. `XRButton.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/XRButton.js
34. `VRButton.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/VRButton.js
35. Meta Quest Browser release notes — https://developers.meta.com/horizon/documentation/web/browser-release-notes/
36. three.js manual, WebXR basics — https://github.com/mrdoob/three.js/blob/dev/manual/pages/webxr-basics.html
37. Meta, Mixed Reality support in Browser — https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/
38. Meta, WebXR hands — https://developers.meta.com/horizon/documentation/web/webxr-hands/
39. `XRControllerModelFactory.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/XRControllerModelFactory.js
40. `XRHandModelFactory.js` source — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/XRHandModelFactory.js
41. RFC 3986 §3.5 Fragment — https://www.rfc-editor.org/rfc/rfc3986#section-3.5
42. MDN `Location.hash` — https://developer.mozilla.org/en-US/docs/Web/API/Location/hash
43. MDN `History.replaceState()` — https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
44. `@fastify/static` README — https://github.com/fastify/fastify-static
45. WHATWG WebSockets Standard — https://websockets.spec.whatwg.org/
46. MDN `WebSocket.binaryType` — https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType
47. `ws` API docs (`maxPayload`, `ping`) — https://github.com/websockets/ws/blob/master/doc/ws.md
48. MDN `CloseEvent.code` — https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
49. Apple Developer Forums, WebSockets in iOS 26 / iOS 15 background behaviour (anecdotal) — https://developer.apple.com/forums/thread/792842 , https://developer.apple.com/forums/thread/696310
50. npm `vite@latest` — https://registry.npmjs.org/vite/latest (8.3.4)
51. Vite blog — https://vite.dev/blog.html ; Announcing Vite 8 — https://vite.dev/blog/announcing-vite8
52. Vite migration guide — https://vite.dev/guide/migration
53. Vite build options — https://vite.dev/config/build-options
54. Vite static asset handling — https://vite.dev/guide/assets
55. Vite server options (`server.proxy`, `ws`, `server.https`) — https://vite.dev/config/server-options
56. Vite env variables and modes — https://vite.dev/guide/env-and-mode
57. WebKit features in Safari 18.0 — https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
58. WebKit blog, Designing websites for iPhone X (`viewport-fit`, `env()`) — https://webkit.org/blog/7929/designing-websites-for-iphone-x/
59. MDN Permissions-Policy `screen-wake-lock` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/screen-wake-lock
60. MDN manifest `display` — https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display
61. Meta Quest Browser 31.4 notes via secondary sources — https://mixed-news.com/en/meta-quest-browser-update-31-4/ , https://en.wikipedia.org/wiki/Meta_Quest_Browser
62. PyPI `qrcode` 8.2 — https://pypi.org/project/qrcode/
63. 3D Slicer developer guide, Python FAQ (`slicer.packaging.pip_ensure`) — https://slicer.readthedocs.io/en/latest/developer_guide/python_faq.html
64. Apple Support, Scan a QR code with iPhone Camera — https://support.apple.com/en-us/HT208843
65. Third-party Android QR scanning guides (unofficial) — https://scanapp.org/supports/how-to-scan-qr-code-android
66. npm `@fastify/static@latest` — https://registry.npmjs.org/@fastify/static/latest (10.1.6)
67. npm `vitest@latest` — https://registry.npmjs.org/vitest/latest (5.0.5)
68. Vitest Browser Mode — https://vitest.dev/guide/browser/
69. Playwright `browsers.json` 1.64.1 — https://unpkg.com/playwright-core@1.64.1/browsers.json ; npm — https://registry.npmjs.org/@playwright/test/latest
70. Playwright device descriptors (bundled in `playwright-core@1.64.1` `lib/coreBundle.js`, source `deviceDescriptorsSource.json`)
71. Playwright emulation docs — https://playwright.dev/docs/emulation
72. Playwright browsers docs — https://playwright.dev/docs/browsers
73. Chromium, Using Chromium with SwiftShader — https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
74. Playwright `chromiumSwitches.ts` — https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts
75. Chrome for Developers, New Headless mode — https://developer.chrome.com/docs/chromium/new-headless
