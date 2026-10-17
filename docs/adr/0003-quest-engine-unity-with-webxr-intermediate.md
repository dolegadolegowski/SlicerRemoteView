# ADR 0003: Meta Quest client — Unity 6.3 LTS native app (M3b) with a WebXR intermediate milestone (M3a)

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `quest`, `web` (WebXR mode), `protocol`
- **Related:** `docs/requirements.md` (Quest 2/3/3S compatibility, personas: lecturer, student),
  `docs/architecture.md`, `docs/protocol.md` (coordinate system, `nodeId`), ADR 0001 (GLB transport),
  ADR 0005 (coordinates in glTF space), ADR 0007 (generated C# types)

## Context

The goal requires a **native Meta Quest application** as the target and asks whether "WebXR in Quest Browser via
the web-viewer" should be a separate milestone first (`prompts/00-goal.md`, decision 3). The team teaches Unity
in an XR-in-medicine course, so the Quest client doubles as teaching material. Development hosts are macOS.

Verified facts (`docs/research/quest.md`, `web.md`, 2026-10-17):

- **Unity 6.3 LTS** (6000.3, 2025-12-04) is supported until Dec 2027; Unity 6.0 LTS support ends Oct 2026.
  Meta XR Core SDK v203+ requires Unity ≥ 6000.0.66f2. The Oculus XR Plugin is "deprecated and scheduled for
  removal"; the supported route is the **Unity OpenXR Plugin 1.18.0** with the **Meta Quest Support** feature
  group. Unity's Meta Quest build profile defaults: Vulkan, IL2CPP, ARM64, min API 29; Meta requires
  `targetSdkVersion` 34 for apps created after 2026-03-01.
- **XR Interaction Toolkit 3.6.1** + **XR Hands 1.9.0** provide grab/rotate/two-hand scale and world-space UI
  (ray + poke) for controllers and hands via OpenXR; Built-in RP is deprecated from Unity 6.5 → URP.
- **Passthrough:** `com.unity.xr.meta-openxr` 2.6.1 (AR Foundation provider, *Camera (Passthrough)* feature,
  camera clear alpha 0) or Meta Core SDK `OVRPassthroughLayer`. Quest 2 passthrough is greyscale.
- **glTFast 6.20.0** (`com.unity.cloud.gltfast`, Unity 6000.0+): `GltfImport.Load(byte[])`, `KHR_mesh_quantization`,
  Draco via `com.unity.cloud.draco` 5.5.0, node `extras` readable with the `GLTFast.Newtonsoft` variant in
  `GameObjectInstantiator.NodeCreated`. Handedness conversion axis `[TODO verify]` (believed to negate Z).
- **JSON:** `com.unity.nuget.newtonsoft-json` 3.2.1 = Newtonsoft 13.0.2 with an AOT DLL for IL2CPP; needs
  `link.xml`. System.Text.Json support in Unity is a 6.0.0-preview build → avoid.
- **WebSocket:** `System.Net.WebSockets.ClientWebSocket` (BCL) or NativeWebSocket 2.x wrapping it. **`wss://`
  with a public CA chain on Android IL2CPP is not confirmed by any official Unity page** `[TODO verify]`.
- **Budgets (Meta):** Quest 2 < 100 draw calls / < 750k tris; Quest 3/3S < 200 / < 1.5M at 72 Hz; app memory
  4.4 GiB (Quest 2/Pro) / 5.75 GiB (Quest 3/3S). Transparency is the main GPU risk on the tile GPU.
- **macOS tooling:** Build & Run + `adb` from Unity's platform-tools; Meta XR Simulator v205 (Apple Silicon only);
  **Quest Link is Windows-only**; MQDH 6.5.2 for Mac. Distribution via Meta Horizon Store release channels
  (ALPHA/BETA, invite-only, 200 users default) or sideloading; App Lab no longer exists.
- **WebXR in Meta Quest Browser** 152.1: `immersive-vr` supported; `immersive-ar` passthrough supported with
  `isSessionSupported` check, but Meta's mixed-reality WebXR page lists Quest 2/Pro — Quest 3 `[TODO verify]`;
  hand tracking with 25 joints; three.js `XRButton` tries AR then VR and needs `hand-tracking` added explicitly;
  `XRControllerModelFactory` fetches profiles from a jsDelivr CDN by default (override with `setPath`).
  Safari iOS has no WebXR at all. WebXR requires a secure context (HTTPS).

## Decision

1. **M3a — WebXR mode of `web-viewer` in Meta Quest Browser** (component `web`): `renderer.xr.enabled`,
   `XRButton` with `optionalFeatures: ['hand-tracking']`, `immersive-vr` as the guaranteed mode, `immersive-ar`
   offered only when `isSessionSupported('immersive-ar')` is true; controller/hand models self-hosted (no CDN);
   scene placed at 1.2–1.6 m in metres (ADR 0005 units). Delivered before any Unity code; serves demos and as a
   no-install fallback.
2. **M3b — native Quest app in Unity 6.3 LTS** (component `quest`): OpenXR Plugin 1.18 + Meta Quest Support
   feature group (Oculus Touch + Hand Interaction profiles), Meta Quest build profile (Vulkan, IL2CPP, ARM64,
   min API 32, target API 34), URP, **XR Interaction Toolkit 3.6** + **XR Hands 1.9** (one `XRGrabInteractable`
   on the scene root, two-hand rotate/scale, world-space 31-key code keypad), **glTFast 6.20** with the
   `GLTFast.Newtonsoft` extras path, **`com.unity.xr.meta-openxr` 2.6** passthrough (vendor-neutral path;
   Meta Core SDK only as fallback), **Newtonsoft JSON** with generated DTOs (ADR 0007) and `link.xml`,
   WebSocket via `ClientWebSocket` (NativeWebSocket 2.x acceptable as a thin wrapper).
3. **First `QST-` task is a device smoke test**: connect `wss://` to the Railway relay (Let's Encrypt chain) from
   an IL2CPP/ARM64 build, receive a > 16 MiB binary message and reassemble fragments. If it fails, fall back to
   HTTPS GET of the snapshot with a one-time viewer token (reserved in `docs/protocol.md`).
4. **Teaching context is a design input:** the project uses the Unity-standard OpenXR/XRI stack rather than Meta
   proprietary rigs wherever both work, so course material transfers to other OpenXR headsets.

## Consequences

**Positive**

- M3a reuses 100 % of the viewer code; a Quest user can join from the browser with zero installation, which is
  also the fallback when sideloading is impossible in a classroom.
- Unity + glTFast + XRI is the lowest-effort native path and the one the course already teaches.
- OpenXR-only stack avoids the deprecated Oculus XR Plugin and keeps the door open for non-Meta headsets.
- Desktop iteration on macOS is possible through the Meta XR Simulator (Apple Silicon).

**Negative**

- Two Quest implementations (WebXR and Unity) share only the protocol, not rendering code.
- WebXR headroom is smaller (no Burst/Jobs, no Application SpaceWarp, browser overhead); `immersive-ar` on Quest 3
  in Browser is unverified.
- Unity: IL2CPP stripping requires `link.xml` discipline; `wss://` is unverified until the smoke test; Quest Link
  is unavailable on macOS (slower APK iteration); Unity Personal licence use in CI is `[TODO verify]`.
- Hand-grab quality with XRI may lag Meta's Interaction SDK; ISDK Essentials remains a documented fallback.
- Store distribution requires VRC/IARC review; pilots use release channels or sideloading.

**Follow-ups**

- `quest`: smoke test (`wss://`, large frames, reassembly) as `QST-01`; verify glTFast handedness axis with an
  asymmetric test model; measure glTFast load time at 0.5–1M triangles; decide `TimeBudgetPerFrameDeferAgent` budget.
- `web`: self-host WebXR input profiles; test `immersive-ar` on Quest 3 (`docs/testing/web.md`).
- `protocol`: express transforms in glTF space (never Unity space) so both clients convert identically.
- `qa`/`deploy`: resolve the Unity CI licence question before planning automated APK builds.

## Alternatives considered

- **Unreal Engine 5.8 + Meta XR plugin v207.** Rejected: higher effort for a glTF-streaming viewer (runtime glTF
  import path `[TODO verify]`, C++ networking), ~50 GB install and long Android packaging, Meta XR Simulator for
  Unreal is Windows-only, and no teaching value for a Unity-based course.
- **WebXR-only (no native app).** Rejected as the end state because the goal mandates a native app and because
  of lower performance headroom and URL-only distribution; **kept as milestone M3a** and as a permanent fallback.
- **Godot.** Not evaluated in the research notes `[TODO verify]` OpenXR/Meta feature coverage and runtime glTF
  loading; rejected because no verified facts support it and it has no place in the course curriculum.
- **Meta Interaction SDK + Core SDK rig instead of XRI/XR Hands.** Deferred: best Quest hand-grab polish, but
  ties the scene to `OVRCameraRig`/Building Blocks; chosen as fallback if user tests show XRI grab is insufficient.

## Sources

- Unity 6.3 LTS: https://unity.com/blog/unity-6-3-lts-is-now-available ; releases/support: https://unity.com/ja/releases/
- Meta Quest build profile (6.3): https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-build-profile.html ; Quest packages: https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-packages.html
- OpenXR Plugin 1.18 / Meta Quest Support: https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/index.html ; https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/metaquest.html
- Meta: Oculus XR Plugin deprecated: https://developers.meta.com/horizon/documentation/unity/unity-xr-plugin/ ; Core SDK 203 minimum Unity: https://developers.meta.com/horizon/downloads/package/meta-xr-core-sdk/203.0 ; Android 14 target: https://developers.meta.com/horizon/blog/meta-quest-apps-android-14-march-1
- Unity OpenXR: Meta 2.6 passthrough: https://docs.unity3d.com/Packages/com.unity.xr.meta-openxr@2.6/manual/features/camera.html ; Meta passthrough (Core SDK): https://developers.meta.com/horizon/documentation/unity/unity-passthrough-gs/
- XRI 3.6: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/index.html ; grab: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/xr-grab-interactable.html ; XR Hands 1.9: https://docs.unity3d.com/Packages/com.unity.xr.hands@1.9/manual/index.html
- glTFast 6.20 runtime import / extras / features: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/ImportRuntime.html ; https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/UseCaseCustomExtras.html ; https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html
- Newtonsoft for Unity 3.2: https://docs.unity3d.com/Packages/com.unity.nuget.newtonsoft-json@3.2/changelog/CHANGELOG.html ; IL2CPP stripping: https://docs.unity3d.com/Manual/IL2CPP-BytecodeStripping.html
- NativeWebSocket: https://github.com/endel/NativeWebSocket ; wss on Android issue: https://issuetracker.unity3d.com/issues/unable-to-establish-wss-connection-in-ios-and-android
- Meta perf / memory: https://developers.meta.com/horizon/documentation/unity/unity-perf/ ; https://developers.meta.com/horizon/documentation/unity/po-memory-ram/ ; https://developers.meta.com/horizon/resources/device-optimization-comparison/
- Meta XR Simulator (Mac ARM 205): https://developers.meta.com/horizon/downloads/package/meta-xr-simulator-mac-arm/205.0/ ; Unity requirements (Link Windows-only): https://developers.meta.com/horizon/documentation/unity/unity-req/ ; MQDH Mac: https://developers.meta.com/horizon/downloads/package/oculus-developer-hub-mac/
- Distribution: https://developers.meta.com/horizon/policy/distribution-options/ ; https://developers.meta.com/horizon/resources/publish-release-channels-add-users/
- Unreal: https://developers.meta.com/horizon/documentation/unreal/unreal-quick-start-install-prerequisites/ ; https://developers.meta.com/horizon/downloads/package/unreal-engine-5-integration/
- WebXR: Meta Quest Browser release notes: https://developers.meta.com/horizon/documentation/web/browser-release-notes/ ; MR in Browser: https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/ ; hands: https://developers.meta.com/horizon/documentation/web/webxr-hands/ ; WebXR secure context: https://immersive-web.github.io/webxr/#navigator-xr-attribute ; caniuse WebXR: https://caniuse.com/webxr
- three.js `XRButton.js` / `XRControllerModelFactory.js`: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/XRButton.js ; https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/webxr/XRControllerModelFactory.js
