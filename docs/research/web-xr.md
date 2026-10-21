# Research: WebXR mode of the web viewer (WEB-19)

Facts the WebXR mode (`web-viewer/src/xr/`) relies on, checked on 2026-10-21 in the pinned sources (CLAUDE.md rule 5):
three.js 0.186.1 as installed (`node_modules/three`), `@webxr-input-profiles/assets` 1.0.20 and `iwer` 2.6.0 from the
npm registry. Device behaviour on Quest Browser stays `[TODO verify]` until `docs/testing/web.md` §Quest Browser is run.

## 1. three.js 0.186.1

- `examples/jsm/webxr/XRButton.js` `createButton(renderer, sessionInit)`: tries `immersive-ar`, then `immersive-vr`
  (`navigator.xr.isSessionSupported`), always adds `local-floor`, `bounded-floor`, `layers` to the caller's
  `optionalFeatures`, labels itself "START XR" / "STOP XR" in English with inline styles, and calls
  `navigator.xr.offerSession` when present. The viewer therefore draws its own localised button (EN/PL, WEB-21) and
  requests the session itself in the click handler, with `optionalFeatures: ['local-floor', 'hand-tracking']`
  (`hand-tracking` is not in three's defaults; research `web.md` §3).
- `src/renderers/webxr/WebXRManager.js`: `setReferenceSpaceType('local-floor')` before `setSession`; frames come
  from `renderer.setAnimationLoop(fn)` (the session's `requestAnimationFrame`), so the viewer's render-on-demand
  must stop while presenting. Each frame copies the XR camera's pose into the user camera (`updateUserCamera`:
  `matrix.decompose(position, quaternion, scale)` and its `fov`) and takes `depthNear`/`depthFar` from the user
  camera's `near`/`far` (lines 740–758) — the viewer's millimetre clip planes must be swapped for metric ones while
  presenting. On `sessionend` three restores the pixel ratio, the size, `fov` and `zoom` (lines 255–278), not the
  camera's position, orientation or clip planes: the viewer saves and restores those. It does so on three's
  `sessionend` event (dispatched at line 278, after that restore), not on the session's `end`: an `end` listener added
  before `setSession` runs before three's own (line 424) — with the headset's field of view still on the camera, size
  changes refused ("Can't change size while VR device is presenting") — and before `WebGLRenderer`'s `sessionend`
  handler restarts its window animation loop (`WebGLRenderer.js` lines 1591–1619), which `setAnimationLoop(null)`
  must stop afterwards.
- `examples/jsm/webxr/XRControllerModelFactory.js`: `DEFAULT_PROFILES_PATH` is
  `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles`, `DEFAULT_PROFILE` is
  `generic-trigger`; `setPath(path)` replaces the CDN. It fetches `profilesList.json`, then the first profile of
  `xrInputSource.profiles` that the list names (else `generic-trigger`), then its GLB
  (`libs/motion-controllers.module.js` `fetchProfile`). It only builds models for `tracked-pointer` sources with a
  gamepad, so hands are left to the hand factory.
- `examples/jsm/webxr/XRHandModelFactory.js` / `XRHandMeshModel.js`: `createHandModel(hand, 'mesh')` loads
  `<path>/<handedness>.glb`, default path `…/profiles/generic-hand/` on the same CDN; `setPath` replaces it. Only a
  loader the model creates itself gets that path (`XRHandMeshModel.js` lines 120–127): a loader passed to the factory
  loads `<handedness>.glb` relative to the page unless its own `setPath` was called first.
- `examples/jsm/loaders/GLTFLoader.js`: embedded images become `blob:` object URLs (line 3368) and are loaded with
  `ImageBitmapLoader` wherever `createImageBitmap` exists outside old Safari and Firefox (lines 2633–2660), i.e. with
  `fetch(blob:…)` (`src/loaders/ImageBitmapLoader.js` line 173). A failed image is re-thrown (line 3421) and caught by
  `loadTextureImage`, which resolves `null` (lines 3329–3331): the model loads without that texture and three logs
  "Couldn't load texture". Under the relay's CSP `connect-src 'self' wss:` (ADR 0006, SRV-16) that `fetch` is refused,
  so every controller model would be untextured (grey) on Quest Browser (Chromium). A GLTFLoader plugin is called
  with the parser before anything loads (lines 492–498): the viewer's plugin sets the parser's `textureLoader` to a
  `TextureLoader` (an `<img>` on the `blob:` URL, allowed by `img-src 'self' data: blob:`). Reported to the server workstream as
  well (`docs/testing/reports/2026-10-21-web.md`).

- Grabbing (WEB-20). `src/renderers/webxr/WebXRController.js`: `getTargetRaySpace()` groups get `selectstart`,
  `selectend` (trigger or pinch) and `squeezestart` (grip button), and `connected` with the `XRInputSource` (its
  `hand` set for hand input); their `matrix` is the target-ray pose (`matrixAutoUpdate` off), and `visible` is false
  while that pose is null. For hand input `update()` takes the hand-joint branch: joints (`hand.joints[name]`) get
  their poses and the target ray its, the grip does not. WebXR sends input events before the frame in which three
  updates these matrices, so the viewer anchors a grab at the next frame (`src/xr/grab.ts`).
- A hand's target ray is the runtime's aim ray. OpenXR `XR_EXT_hand_interaction` §Aim pose: "the rotation of the
  'aim' pose may account for forearm or shoulder motion as well as hand rotation. Hence, the 'aim' pose may not
  always rigidly attach to the user's hand rotation. If the application desires to rotate the targeted remote object
  in place, it should use the rotation of the 'grip' pose instead" [5]. Hands therefore drag the scene with their
  wrist joint (rigid to the hand); whether Quest Browser's hand target ray is that aim pose is `[TODO verify]` on a
  device (`docs/testing/web.md` §WebXR step 10).

## 2. `@webxr-input-profiles/assets` 1.0.20

- MIT (`LICENSE.md`); the README notes that some assets depict device trademarks. 133 files, 101.7 MB unpacked; the
  viewer copies 7 profiles (≈ 9 MB) at build time (`scripts/copy-xr-profiles.mjs`) into
  `dist/assets/xr-profiles-<version>/`, never into git. Under `/assets/` the relay serves them as it is (SRV-16
  registers nothing else besides `/` and `/j`), with its 30-day `immutable` cache — correct because the version is
  in the path; the profiles are:
  `meta-quest-touch-plus` (444 KB) and `meta-quest-touch-plus-v2` (1.6 MB) for Quest 3/3S, `meta-quest-touch-pro`
  (604 KB), `oculus-touch-v3` (1.3 MB, Quest 2), `oculus-touch-v2` (1.1 MB, Quest 1), `generic-trigger` (3.9 MB, the
  factory's fallback) and `generic-hand` (196 KB, hand meshes, no textures).
- Each `profile.json` names its GLBs in `layouts.<handedness>.assetPath`. The Quest profiles' `fallbackProfileIds`
  point to `oculus-touch`, `generic-trigger-squeeze-thumbstick` and others, which are not copied — harmless, because
  `fetchProfile` only matches ids that `profilesList.json` lists, and the copied list names only the 7 copied ones.
- Which profile ids Quest Browser reports per controller generation is `[TODO verify]` on devices; IWER's Meta
  configurations (below) use `oculus-touch-v2` (Quest 1), `oculus-touch-v3` (Quest 2), `meta-quest-touch-pro` and
  `meta-quest-touch-plus` (Quest 3).

## 3. IWER 2.6.0 (end-to-end tests only)

- `iwer` (MIT, Meta's Immersive Web Emulation Runtime): `new XRDevice(metaQuest3).installRuntime({ forceInstall:
  true })` replaces `navigator.xr` with an emulated Quest 3 and sets `navigator.userAgent` to a Quest 3 Browser UA
  (`lib/device/configs/headset/meta.js`); `forceInstall` is needed where the browser already has `navigator.xr`
  (`lib/device/XRDevice.js` `installRuntime`). `build/iwer.min.js` is a UMD build (global `IWER`), injected by
  Playwright before the page runs (`e2e/xr.spec.ts`). Hand input (`primaryInputMode = 'hand'`) reports the
  profiles `oculus-hand`, `generic-hand`, `generic-hand-select`, `generic-trigger`.

## Sources

1. three.js 0.186.1 files named above, as installed from npm (`three@0.186.1`, pinned in `web-viewer/package.json`).
2. `@webxr-input-profiles/assets@1.0.20` — https://www.npmjs.com/package/@webxr-input-profiles/assets/v/1.0.20 (package
   contents read from the installed tarball).
3. `iwer@2.6.0` — https://www.npmjs.com/package/iwer/v/2.6.0 (package contents read from the installed tarball).
4. ADR 0003 (M3a), ADR 0006 (CSP), FR-47, US-14, research `web.md` §3.
5. OpenXR specification source, `XR_EXT_hand_interaction` §Aim pose, lines 100–108 —
   https://github.com/KhronosGroup/OpenXR-Docs/blob/18ebc0374da23c020ef4c949f9b144ffae6160ef/specification/sources/chapters/extensions/ext/ext_hand_interaction.adoc
