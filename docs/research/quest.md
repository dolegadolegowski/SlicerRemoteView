# Research A4 — Meta Quest client: Unity, OpenXR, Meta XR SDK, glTFast, networking, performance, build

Status: research note (architect), 2026-10-17. Every claim carries a source and version; items that could
not be verified against official documentation are marked `[TODO verify]`. Target devices: Quest 2, Quest 3,
Quest 3S. Development host: macOS (Apple Silicon assumed).

## Key findings for the design

- **Engine/version:** Unity 6.3 LTS (6000.3, released 2025-12-04, supported until Dec 2027). Unity 6.0 LTS
  support ends Oct 2026, so do not start on it. Meta XR SDK v203+ requires Unity >= 6000.0.66f2.
- **XR stack:** Unity OpenXR Plugin 1.18 with the *Meta Quest Support* feature group is mandatory for
  Unity 6 + Meta XR SDK v74+; the Oculus XR Plugin is deprecated. Use the Unity *Meta Quest build profile*
  (Unity 6.1+): Vulkan, IL2CPP, ARM64, min API 29, stereo instancing/multiview.
- **Target API:** Meta requires `targetSdkVersion` 34 for apps created in the Developer Dashboard after
  2026-03-01 (min SDK may stay 29–32). Override the build profile default (32) to 34.
- **Passthrough:** two supported paths — (a) `com.unity.xr.meta-openxr` 2.6 (AR Foundation provider,
  *Meta Quest: Camera (Passthrough)* feature, camera clear colour alpha 0) or (b) Meta XR Core SDK
  `OVRManager` + `OVRPassthroughLayer`. Default: (a) to stay vendor-neutral; fall back to (b) if the
  course material already teaches Meta Building Blocks.
- **Interaction:** XR Interaction Toolkit 3.6.1 + XR Hands 1.9 cover grab/rotate/scale with two hands and
  world-space canvas UI (ray + poke) with controllers *and* hands via OpenXR. Meta Interaction SDK is the
  alternative with first-class Quest hand grab; it needs the Meta Core SDK rig. Pick one, not both.
- **GLB loading:** glTFast 6.20.0 (`com.unity.cloud.gltfast`, Unity registry, Unity 6000.0+).
  `GltfImport.Load(byte[])` works directly on a WebSocket payload; `LoadGltfBinary` is obsolete.
  Draco (`com.unity.cloud.draco` 5.5.0) is production-ready; meshopt decompress is `0.3.0-exp.1`
  (experimental) — prefer Draco or uncompressed + `KHR_mesh_quantization` on the Slicer side.
- **Stable node IDs:** glTF node `name` and `extras` are both reachable at instantiation time
  (`GameObjectInstantiator.NodeCreated(nodeIndex, GameObject)` + `GetSourceRoot().Nodes[i].extras`
  via the `GLTFast.Newtonsoft` variant). Put the Slicer MRML node ID into `extras.nodeId`; do not rely on
  Unity GameObject names.
- **Coordinate system:** glTF is right-handed, Y-up, metres; Unity is left-handed, Y-up. glTFast converts
  automatically, but *which axis it negates* is `[TODO verify]` (UnityGLTF negates X; glTFast is believed to
  negate Z). Protocol transforms must be defined in glTF space and converted in the client — never author
  protocol math in Unity space.
- **WebSocket:** `System.Net.WebSockets.ClientWebSocket` is the only dependency-free option on IL2CPP/Android;
  NativeWebSocket 2.x wraps it and dispatches to the main thread. Working `wss://` on Quest with a
  publicly-trusted certificate is **not documented anywhere official** — `[TODO verify]` with a device smoke
  test in the first sprint. Never ship self-signed certs. Do not enable *Force Remove Internet Permission*.
- **JSON:** `com.unity.nuget.newtonsoft-json` 3.2.1 (Newtonsoft 13.0.2, AOT DLL for IL2CPP). Avoid
  System.Text.Json (Unity pins a 6.0.0-preview build; IL2CPP behaviour unverified). Generate C# DTOs from the
  shared JSON Schema with NJsonSchema (Newtonsoft-based) and add a `link.xml` for the DTO assembly.
- **Performance budgets (Meta):** Quest 2 < 100 draw calls, < 750k tris; Quest 3/3S < 200 draw calls,
  < 1.5M tris at 72 Hz (13.8 ms). App memory limit (PSS): 4.4 GiB (Quest 2/Pro), 5.75 GiB (Quest 3/3S).
  Design implication for `slicer`: decimate to **<= 500k triangles total for Quest 2, <= 1M for Quest 3**,
  and keep **<= 60 renderable model nodes** (one draw call each, no per-model transparency by default).
- **Transparency** is the main GPU risk (back-to-front overdraw on a tile-based GPU). Opacity < 1 should be
  the exception; Application SpaceWarp does not help transparent content.
- **Build/install from macOS:** Unity Hub modules (OpenJDK 17, NDK r27c, SDK Build Tools 36), `adb install`
  via Unity's `platform-tools`, Meta Quest Developer Hub 6.5.2 for Mac. Quest Link is Windows-only; the
  Meta XR Simulator (standalone, v205, Apple Silicon only) is the desktop test path on macOS.
- **Distribution:** since 2024-07-31 everything goes through the Meta Horizon Store; App Lab is gone.
  For a course/clinical pilot use **release channels** (ALPHA/BETA, invite-only, 200 users default) or
  sideloading; a public listing needs VRC + IARC review.
- **CI:** game-ci `unity-builder@v4` (`targetPlatform: Android`) with a Personal `.ulf` licence works per
  community reports (Apr 2026) but Unity does not document Personal-licence CI use — `[TODO verify]`
  licensing before relying on it; Unity Build Automation offers 100 Mac / 200 Windows free minutes per month.
- **Alternatives:** Unreal (Meta XR plugin v207 for UE 5.8, macOS host supported, Simulator Windows-only)
  costs more for a glTF-streaming viewer and has no teaching value for this course. WebXR-only in Quest
  Browser is the cheapest path and shares code with `web-viewer`, but Meta's own mixed-reality WebXR page
  lists only Quest 2/Pro and performance headroom (no Burst, no AppSW) is smaller. Recommendation: Unity for
  `quest`, keep WebXR as an optional mode of `web-viewer` (already in `CLAUDE.md`).

## 1. Unity version and Android toolchain on macOS

| Item | Finding | Source |
|---|---|---|
| Current LTS | Unity 6.3 LTS = 6000.3, announced 2025-12-04; "two years of dedicated support" (+1 year Enterprise/Industry). Unity 6.2 no longer supported. | [Unity blog 6.3 LTS](https://unity.com/blog/unity-6-3-lts-is-now-available) |
| Previous LTS | Unity 6.0 LTS (Oct 2024) supported until Oct 2026 — effectively end-of-life for a project starting now. | [unity.com/releases](https://unity.com/ja/releases/) |
| Meta minimum | Meta XR Core SDK v203 (2026-06-03): "minimum supported version of Unity is now 6000.0.66f2". Meta software-setup page (2026-10-01) repeats 6000.0.66f2+. | [Core SDK 203](https://developers.meta.com/horizon/downloads/package/meta-xr-core-sdk/203.0), [Software setup](https://developers.meta.com/horizon/documentation/unity/unity-software-setup/) |
| Android modules | Installed only via Unity Hub: *Android Build Support*, *Android SDK & NDK Tools*, *OpenJDK*; placed under `.../PlaybackEngines/AndroidPlayer/`. | [Unity Manual: Android dependencies](https://docs.unity3d.com/Manual/android-install-dependencies.html) |
| Dependency versions (6000.3) | OpenJDK 17; NDK r27c (27.2.12479018); SDK Build Tools 36.0.0; cmdline-tools 16; Platform Tools 36.0.0 (37.0.1 from 6000.3.26f1); CMake 3.22.1. | [Supported dependency versions](https://docs.unity3d.com/6000.3/Documentation/Manual/android-supported-dependency-versions.html) |
| Meta Quest build profile | Available since Unity 6.1. Defaults overriding Android: Graphics API Vulkan; Min API 29 (Android 10); Target API 32 (12L); IL2CPP; ARM64; Stereo Rendering Path Instancing; optional ThinLTO (needs IL2CPP, no engine stripping). OpenXR plugin auto-installed. Meta partner packages via Platform Browser. | [Meta Quest build profile (6.3)](https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-build-profile.html) |
| Supported headsets | "Unity supports development for Meta Quest 2, 3, and 3S, and Quest Pro." | [Meta Quest develop (6.3)](https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-develop.html) |
| Target API (Meta rule) | Apps created in the Developer Dashboard after **2026-03-01** must target API 34 (Android 14); `minSdkVersion` may remain 32; existing apps unaffected. Meta's Unity publishing guide: min API 29 or higher. | [Meta blog Android 14](https://developers.meta.com/horizon/blog/meta-quest-apps-android-14-march-1), [Prepare for publish](https://developers.meta.com/horizon/documentation/unity/unity-prepare-for-publish/) |
| macOS host | Meta: Build & Run works on Windows or macOS; **Meta Horizon Link is Windows only**; Simulator needs Apple Silicon. | [Unity requirements](https://developers.meta.com/horizon/documentation/unity/unity-req/) |

Decision input: pin `6000.3.x` LTS (latest patch), IL2CPP + ARM64 only (no ARMv7), Vulkan only (needed for
SpaceWarp and FDM foveation), target API 34, min API 32 (Quest 1 is not a target).

## 2. OpenXR plugin, Meta XR SDK packages, Simulator, passthrough, hand tracking

### 2.1 Unity OpenXR Plugin
- `com.unity.xr.openxr` **1.18.0**, Unity 6000.0 LTS+, OpenXR SDK 1.1.54. Meta Quest = Android arm64 +
  Vulkan preferred; "HMD + Controllers via Meta Quest Support Feature".
  ([OpenXR 1.18 manual](https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/index.html))
- **Meta Quest Support** feature group: produces Quest APKs; recommended interaction profile *Oculus Touch
  Controller* ("supported by all Meta Quest controllers"), optional *Touch Plus*, *Touch Pro*, *Hand
  Interaction*. Settings: Symmetric Projection (Vulkan), Optimize Buffer Discards (Vulkan, memoryless 4x
  MSAA), Multiview Render Regions (6.2+), Space Warp motion-vector format, **Force Remove Internet
  Permission** (keep OFF — we need network), System Splash Screen, Enable System Keyboard (duplicate
  `uses-feature` warning if Meta Core SDK also requires it).
  ([Meta Quest Support feature](https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/metaquest.html))
- **Hand Interaction Profile** = `XR_EXT_hand_interaction`: pinch/poke/grip/aim poses, `pinchValue`,
  `graspValue`, `pointerActivateValue`. ([Hand interaction profile](https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/handinteractionprofile.html))
- Oculus XR Plugin: "deprecated and scheduled for removal. Use the Unity OpenXR Plugin instead." OpenXR
  route requires Unity 6+ and Meta XR SDK v74+. ([Meta: Unity XR plugin](https://developers.meta.com/horizon/documentation/unity/unity-xr-plugin/))
- Meta-recommended OpenXR settings for Quest (2026-05-11): Render Mode Multi-View; Latency Optimization
  "Prioritize Input Polling"; Depth Submission None unless needed; Foveated Rendering API = SRP Foveation on
  Unity 6+; Offscreen Rendering Only (Vulkan) on. ([Meta OpenXR settings](https://developers.meta.com/horizon/documentation/unity/unity-openxr-settings/))

### 2.2 Unity OpenXR: Meta (AR Foundation provider)
- `com.unity.xr.meta-openxr` **2.6.1**; depends on OpenXR plugin and AR Foundation 6.x. Features: Session,
  **Camera (Passthrough)**, Planes, Bounding boxes, Anchors, Ray casts, Meshing, Occlusion, Colocation
  discovery; OpenXR features Display utilities (query/request refresh rate), Boundary visibility, Social eye
  gaze. ([OpenXR Meta 2.6 manual](https://docs.unity3d.com/Packages/com.unity.xr.meta-openxr@2.6/manual/index.html))
- Passthrough: enable *Meta Quest: Camera (Passthrough)* feature, add `ARCameraManager` to the camera,
  camera Background/Clear Flags Solid Color with **alpha 0**; passthrough video is composited behind the
  scene. Unity's Mixed Reality template (`com.unity.template.mixed-reality`) ships this preconfigured.
  ([Camera feature 2.6](https://docs.unity3d.com/Packages/com.unity.xr.meta-openxr@2.6/manual/features/camera.html), [Unity 6.3 Quest packages](https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-packages.html))

### 2.3 Meta XR SDK packages (maintained by Meta)
| Package | UPM id | Latest | Notes |
|---|---|---|---|
| Meta XR All-in-One SDK | `com.meta.xr.sdk.all` | 207.0.1 (Asset Store, 2026-10-12) | Meta recommends long-term projects install only the SDKs they need. |
| Meta XR Core SDK | `com.meta.xr.sdk.core` | 207.0 (2026-09-22) | OVRManager, OVRCameraRig, passthrough layers, Building Blocks, Project Setup Tool. |
| Interaction SDK Essentials | `com.meta.xr.sdk.interaction` | 207.0 | "platform-independent package with no dependency on the Meta XR Core SDK" (v207 listing). |
| Interaction SDK (full) | `com.meta.xr.sdk.interaction.ovr` | 207.0 | Adds OVR-specific integration. |
| MR Utility Kit | `com.meta.xr.mrutilitykit` | — | Scene/room helpers; not needed for v1. |
| Simulator (package) | `com.meta.xr.sdk.simulator` | deprecated | Replaced by the standalone Simulator app (v83+). |

Sources: [Unity 6.3 Quest packages](https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-packages.html),
[Asset Store Meta XR SDK](https://assetstore.unity.com/packages/package/265014),
[Core SDK download](https://developers.meta.com/horizon/downloads/package/meta-xr-core-sdk/),
[Meta UPM guide](https://developers.meta.com/horizon/documentation/unity/unity-package-manager/).
Install routes: Asset Store (dependencies resolved), Unity 6.3 Platform Browser, or tarballs from
`npm.developer.oculus.com` (manual dependency management). Meta packages are **not** on OpenUPM.

### 2.4 Meta XR Simulator (desktop testing on macOS)
- Standalone installer since v83 (Windows + macOS); "macOS 10.10+ (ARM only)"; requires Unity OpenXR Plugin
  **>= 1.13.0** on macOS; no Unity package needed for OpenXR projects. Activate via Window > Meta > Meta XR
  Simulator > Activate (or the toolbar icon when Core SDK is present). One device profile at a time;
  controller input via keyboard/mouse/Xbox controller unless controllers are data-forwarded.
  ([XR Sim getting started](https://developers.meta.com/horizon/documentation/unity/xrsim-getting-started/))
- Latest Mac ARM build **205.0** (2026-07-23): fixed MoltenVK swapchain crash and play-mode teardown crashes;
  known "occasional stuttering on macOS". ([Simulator Mac ARM 205](https://developers.meta.com/horizon/downloads/package/meta-xr-simulator-mac-arm/205.0/))
- Limitation: it exercises OpenXR features, not real hand-tracking quality or real passthrough latency;
  device testing remains mandatory (see `docs/testing/quest.md` when created).

### 2.5 Passthrough via Meta Core SDK (alternative path)
`OVRCameraRig` → OVRManager > Quest Features > Passthrough Support = Supported/Required; *Enable
Passthrough* or `OVRManager.isInsightPassthroughEnabled`; add `OVRPassthroughLayer`; Skybox None; centre-eye
camera `clearFlags = SolidColor`, `backgroundColor = Color.clear`; wait for `passthroughLayerResumed` to avoid
a black flicker. ([Meta passthrough GS](https://developers.meta.com/horizon/documentation/unity/unity-passthrough-gs/))
Passthrough colour: Quest 2 greyscale, Quest Pro colour (Meta WebXR MR page); Quest 3/3S colour
`[TODO verify]` against a Meta hardware page.

### 2.6 Hand tracking
- Unity path: XR Hands `com.unity.xr.hands` **1.9.0** (1.10.0-pre.2 is pre-release). "the OpenXR package is
  the only plug-in provider that supports hand tracking." Features: Hand Tracking Subsystem, Meta Hand
  Tracking Aim (`XR_FB_hand_tracking_aim`), in 1.10-pre also Hand joints motion range, Meta frequency hint,
  Meta wide motion mode. ([XR Hands 1.9](https://docs.unity3d.com/Packages/com.unity.xr.hands@1.9/manual/index.html), [XR Hands 1.10-pre](https://docs.unity3d.com/Packages/com.unity.xr.hands@1.10/manual/index.html))
- Meta path: Interaction SDK supports the OpenXR hand skeleton since v71; legacy OVR skeleton deprecated in
  v78. Meta warns that custom hand interactions "without the SDK are difficult to build and make store
  approval harder". ([ISDK overview](https://developers.meta.com/horizon/documentation/unity/unity-isdk-interaction-sdk-overview/), [Hand tracking overview](https://developers.meta.com/horizon/documentation/unity/unity-handtracking-overview/))
- Hand tracking on macOS can only be tested on device (Link is Windows-only).

## 3. Interaction: XRI vs Meta Interaction SDK

### 3.1 XR Interaction Toolkit (XRI)
- `com.unity.xr.interaction.toolkit` **3.6.1**, Unity 6000.0+, Input System installed as dependency.
  ([XRI 3.6 manual](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/index.html))
- `XRGrabInteractable`: Rigidbody "Required for all grab interactables", colliders required (child colliders
  are used when the list is empty) — so **one interactable on the scene root with child meshes works**.
  Movement Type Instantaneous/Kinematic/Velocity Tracking; *Select Mode = Multiple* enables two-handed
  grabs; default `XRGeneralGrabTransformer` moves/rotates with one or two interactors.
  ([XR Grab Interactable](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/xr-grab-interactable.html))
- Two-handed **scaling** is demonstrated in the Hands Interaction Demo ("floating objects can be scaled and
  rotated with two hands"); the exact `XRGeneralGrabTransformer` scale options page was not fetched —
  `[TODO verify]` the min/max scale clamps in the 3.6 grab-transformers page.
- Hands Interaction Demo requirements: XR Hands >= 1.5.1 (1.6.1+ recommended), OpenXR >= 1.11.0,
  XR Management >= 4.3.1, Starter Assets, Shader Graph; on Quest enable Meta Quest Support + Meta Hand
  Tracking Aim. Built-in RP needs Multi-pass and is "deprecated from Unity 6.5 onward" → **use URP**.
  ([Hands Interaction Demo](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/samples-hands-interaction-demo.html))
- UI: `GameObject > XR > UI Canvas` creates a World Space canvas + XR Event System with **XR UI Input
  Module**; add **Tracked Device Graphic Raycaster**; Near-Far/Ray/Poke interactors register with the input
  module; *Canvas Optimizer* optional; system keyboard on Quest needs OpenXR >= 1.17 + Enable System
  Keyboard. Poke Interactor "Click UI On Down" works only with uGUI. Known issue: Quest software keyboard
  cannot be closed for Multi Line Newline input fields. ([XRI UI setup](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/ui-setup.html))
- For the 5-character code keypad: a world-space canvas with our own 36-key grid avoids the system keyboard
  entirely (works identically with hands/poke and controllers/ray).

### 3.2 Meta Interaction SDK (ISDK)
- Grab/poke/ray/UI/locomotion/pose detection; hands and controllers. Two-handed scale: `Grabbable`
  (Max grab points -1 or 2, *Transfer on second selection* off) + `GrabFreeTransformer` in both One-/Two-grab
  slots; Scale constraints min/max (example 0.5–2.0); `TwoGrabRotateTransformer` for constrained rotation.
  (`OneGrabFreeTransformer`/`TwoGrabFreeTransformer` deprecated in v74.)
  ([Two-handed grab](https://developers.meta.com/horizon/documentation/unity/unity-isdk-two-handed-grab-interaction/))
- Canvas UI: `PointableCanvasModule` on a `CanvasModule` object + Flat/CurvedUnityCanvas prefabs; poke
  (press, scroll) with hands; ray via Quick Actions (v62+). ([Create UI](https://developers.meta.com/horizon/documentation/unity/unity-isdk-create-ui/))
- Trade-off: ISDK gives the most polished Quest hand grab and matches Meta store review expectations, but
  ties the scene to OVRCameraRig/Building Blocks; XRI is engine-standard, cross-vendor, and is what Unity's
  own MR template uses. Recommendation for ADR: **XRI 3.6 + XR Hands** (teaching value, OpenXR-only stack),
  with ISDK Essentials as a documented fallback if hand-grab quality is insufficient in user tests.

## 4. glTFast — runtime GLB loading

| Topic | Finding | Source |
|---|---|---|
| Package | `com.unity.cloud.gltfast` **6.20.0** (2026-08-25); Unity **6000.0+** since 6.19.0; install by name in Package Manager (Unity registry). No OpenUPM needed. | [Changelog](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/changelog/CHANGELOG.html), [Installation](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/installation.html) |
| Optional packages | Draco `com.unity.cloud.draco` 5.5.0 (min 5.4.0); KTX `com.unity.cloud.ktx` (min 3.6.0); meshopt `com.unity.meshopt.decompress` **0.3.0-exp.1** — "experimental … not ready for production use". | [Draco 5.5](https://docs.unity3d.com/Packages/com.unity.cloud.draco@5.5/manual/index.html), [meshopt 0.3](https://docs.unity3d.com/Packages/com.unity.meshopt.decompress@0.3/manual/index.html) |
| Extensions (import) | KHR_draco_mesh_compression, EXT_meshopt_compression, **KHR_mesh_quantization**, KHR_texture_transform, KHR_materials_unlit, KHR_materials_variants, KHR_texture_basisu, KHR_materials_clearcoat (URP 12+: mask/smoothness only), KHR_materials_pbrSpecularGlossiness (archived), EXT_mesh_gpu_instancing. Transmission = approximation; ior/sheen/specular/volume planned. KHR_materials_emissive_strength: no status listed. | [Features](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html) |
| Materials | Per-material base colour + alpha (OPAQUE/MASK/BLEND), double-sided, **vertex colours** imported in URP/HDRP/Built-in; since 6.16.1 vertex-colour alpha applied linearly. Max 2 UV sets in shaders. | same |
| Load API | `Task<bool> Load(byte[] data, Uri uri = null, ImportSettings importSettings = null, CancellationToken ct = default)`; also `Load(NativeArray<byte>.ReadOnly …)`; `LoadGltfBinary` is `[Obsolete]` (deprecated 6.11.0). `true` only means "no critical error" — partial loads still return true; check logger. | [GltfImportBase API](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/api/GLTFast.GltfImportBase.html), [Runtime import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/ImportRuntime.html) |
| Instantiate | `InstantiateMainSceneAsync(IInstantiator)` or `(Transform parent)`; `GameObjectInstantiator(IGltfReadable, Transform parent, ICodeLogger, InstantiationSettings)`; events `NodeCreated(uint nodeIndex, GameObject)`, `MeshAdded`, `EndSceneCompleted`; `SceneTransform` root. | [GameObjectInstantiator API](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/api/GLTFast.GameObjectInstantiator.html) |
| Main-thread cost | `TimeBudgetPerFrameDeferAgent` (tunable `FrameBudget`) vs `UninterruptedDeferAgent` (may block "for up to multiple seconds"). Even with the time-budget agent "does **not** guarantee a stutter free frame rate" (GPU uploads are main-thread). Set via `GltfImport.SetDefaultDeferAgent`. | [Runtime import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/ImportRuntime.html) |
| Memory | Shared vertex accessors are duplicated per mesh (Unity API limit); images with several samplers are duplicated; 16-bit indices preserved (6.16.1); `Dispose()` destroys all sub-assets regardless of live instances. | [Known issues](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/KnownIssues.html), Changelog |
| Node names | `ImportSettings.NodeNameMethod = NameImportMethod.OriginalUnique`; `CreateNode(..., string name)` falls back to the first valid mesh name. | Runtime import, GameObjectInstantiator API |
| Extras | Use `GLTFast.Newtonsoft.GltfImport`; in `NodeCreated` read `GetSourceRoot().Nodes[(int)nodeIndex] as GLTFast.Newtonsoft.Schema.Node` → `extras.TryGetValue("key", out string v)`. Requires `com.unity.nuget.newtonsoft-json`; asmdef references `glTFast` + `glTFast.Newtonsoft`. | [Custom extras use case](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/UseCaseCustomExtras.html) |
| Coordinates | glTF: right-handed, +Y up, metres (glTF 2.0 spec). glTFast converts to Unity's left-handed system on import; the negated axis is **`[TODO verify]`** in source (`Runtime/Scripts/...`; UnityGLTF negates X — glTFast is believed to negate Z and flip winding). | [UnityGLTF #257](https://github.com/KhronosGroup/UnityGLTF/issues/257) (for contrast) |
| Render pipeline | URP, HDRP, Built-in supported; glTFast ships URP shader graphs. Built-in RP is deprecated from Unity 6.5 (XRI docs) → **URP**. | [Features](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html) |

Design consequences for `protocol`/`slicer`:
- Stable ID: `node.extras.nodeId` (Slicer MRML node ID) **and** `node.name` = display name. Mapping table
  `nodeId → GameObject` built in `NodeCreated`; incremental updates (`visibility`, `color`, `opacity`,
  `transform`) address `nodeId` only. Material updates must clone the glTFast material per node before
  editing (glTFast shares one Unity `Material` per glTF material index).
- One glTF node per Slicer model, one primitive per node, one material per node (base colour + alpha from
  the Slicer display node). Vertex colours only when the Slicer model has scalar colouring.
- Compression: Draco is supported and production-ready; meshopt is experimental in Unity → the Slicer
  exporter should offer **Draco or none**; `KHR_mesh_quantization` is free and halves position memory.
- Y-up conversion: Slicer is RAS (right-handed, +Z up-ish patient axes); exporter must write glTF Y-up
  metres (Slicer units are mm → scale 0.001). Define this in `docs/protocol.md`.
- Protocol transforms: send glTF-space 4x4 column-major matrices (same convention as glTF `node.matrix`)
  and convert in the client with the same helper glTFast uses — avoids double-negation bugs.

## 5. WebSocket client on Quest (Android, IL2CPP)

- **`System.Net.WebSockets.ClientWebSocket`** (BCL, .NET Standard 2.1 profile): no extra dependency. Unity's
  issue tracker shows historical wss failures fixed in 2018.2 and TLS trust failures
  (`UNITYTLS_X509VERIFY_FLAG_NOT_TRUSTED`) on some platforms; **no official Unity page confirms wss on
  Android IL2CPP in Unity 6** → `[TODO verify]` with a first-sprint smoke test against the Railway relay
  (Let's Encrypt chain). RxWebSocket's README claims it was "tested on Android with IL2CPP".
  ([Unity discussions](https://discussions.unity.com/t/solved-clientwebsocket-wss-issues/699587), [Unity issue](https://issuetracker.unity3d.com/issues/unable-to-establish-wss-connection-in-ios-and-android), [RxWebSocket](https://github.com/nenoNaninu/RxWebSocket))
- **NativeWebSocket (endel)** 2.x: Unity wrapper over `System.Net.WebSockets` on native platforms, JS on
  WebGL; UPM git URL `https://github.com/endel/NativeWebSocket.git#upm-2`; events dispatched to the main
  thread via `SynchronizationContext` (no `DispatchMessageQueue()` in 2.x); `OnMessage(byte[])` for text
  and binary; `Send(byte[])`/`SendText(string)`; Apache-2.0; 52 open issues, release list not visible — low
  maintenance risk but thin. ([NativeWebSocket](https://github.com/endel/NativeWebSocket))
- **websocket-sharp**: Asset Store listing unavailable, no WebGL, old .NET profile notes; supports proxies.
  Not recommended. ([websocket-sharp fork README](https://github.com/TabbedOut/websocket-sharp))
- Large binary messages: `ClientWebSocket.ReceiveAsync` delivers fragments; accumulate until
  `EndOfMessage` into a pooled buffer sized from a preceding JSON `sceneSnapshot` header (`byteLength`).
  Whether NativeWebSocket reassembles multi-fragment messages internally is `[TODO verify]` (read
  `WebSocket.cs`). Protocol recommendation: announce size first, cap at a protocol limit (e.g. 64 MiB), and
  consider a separate HTTPS GET of the GLB with a one-time token as fallback for > 16 MiB payloads.
- Threading: parse JSON off the main thread (Task), but all Unity object mutation on the main thread.
- Manifest: do **not** enable *Force Remove Internet Permission*; Unity adds `INTERNET` automatically.
- Security (CLAUDE.md rule 6): session code and token in the first JSON message, never in the URL path/query.

## 6. JSON on IL2CPP and protocol code generation

- `com.unity.nuget.newtonsoft-json` **3.2.1** (2023-04-27) = Newtonsoft.Json **13.0.2**; "AOT-compatible DLL
  for IL2CPP platform targets" since 2.0.0. ([Package changelog](https://docs.unity3d.com/Packages/com.unity.nuget.newtonsoft-json@3.2/changelog/CHANGELOG.html))
- IL2CPP always strips managed code; reflection-based serialisers need `link.xml`
  (`<assembly fullname="Newtonsoft.Json" preserve="all"/>` plus the DTO assembly). ([Unity: managed stripping](https://docs.unity3d.com/Manual/IL2CPP-BytecodeStripping.html))
- System.Text.Json: Unity documents support only for the **6.0.0-preview** NuGet build (source-generator
  docs); IL2CPP behaviour of reflection vs source-generated paths is undocumented → avoid.
  ([Unity: source generators](https://docs.unity3d.com/Manual/create-source-generator.html))
- Code generation from the shared JSON Schema: **NJsonSchema** `CSharpGenerator` emits Newtonsoft-annotated
  classes (`[JsonProperty]`), fits the Unity package above; schema-draft coverage (2019-09/2020-12) is
  `[TODO verify]`. **quicktype** can also emit C# for JSON Schema with Newtonsoft or System.Text.Json
  `[TODO verify]` current options. Keep generated C# under `shared/` and vendor it into `quest-app/` as a
  local UPM package with its own asmdef + `link.xml`. ([NJsonSchema](https://github.com/RicoSuter/NJsonSchema))

## 7. Performance limits on Quest 2 / Quest 3 / Quest 3S

| Metric | Quest 2 (Quest Pro similar) | Quest 3 / 3S | Source |
|---|---|---|---|
| Draw calls per frame | < 100 (device table); 80–200 busy / 400–600 light (perf guide) | < 200; 200–300 busy / 700–1000 light | [Device comparison](https://developers.meta.com/horizon/resources/device-optimization-comparison/), [Unity perf](https://developers.meta.com/horizon/documentation/unity/unity-perf/) |
| Triangles per frame | < 750k; 750k–1M | < 1.5M; 1.3–1.8M | same |
| Frame rate | 72 Hz (13.8 ms); valid 72/80/90/120 | 72 Hz, 90 recommended; valid 72/80/90/120 | same, [Unreal advanced rendering table](https://developers.meta.com/horizon/documentation/unreal/unreal-advanced-rendering/) |
| App memory limit (PSS) | **4.4 GiB** (Quest 2, Quest Pro) | **5.75 GiB** (Quest 3, 3S) | [Memory/RAM](https://developers.meta.com/horizon/documentation/unity/po-memory-ram/) (2025-08-12) |
| RAM / GPU | 6 GB, XR2 Gen 1 | 8 GB, XR2 Gen 2 (~2.5x GPU) | Device comparison |
| Resolution per eye | 1832x1920 | Quest 3 2064x2208; Quest 3S 1832x1920 | Device comparison; [Road to VR](https://roadtovr.com/quest-3s-quest-3-quest-2-specs-compared/) |
| Texture compression | ASTC | ASTC | Device comparison |

- Tile-based GPU: vertex shader runs per vertex per covered tile; strip unused channels; half precision for
  non-position attributes. Transparent objects are drawn back-to-front and re-shade fragments; fully faded
  objects still cost full price (Meta WebXR perf guide). Mid-shader `discard`/alpha-test forcing tile
  re-render is a second-hand claim `[TODO verify]`. ([Unity perf](https://developers.meta.com/horizon/documentation/unity/unity-perf/), [WebXR perf BP](https://developers.meta.com/horizon/documentation/web/webxr-perf-bp/))
- Foveated rendering: OpenXR *Foveated Rendering* feature, SRP Foveation API (Unity 6+, OpenXR >= 1.11, URP,
  Vulkan FDM); level 0–1 via `XRDisplaySubsystem.foveatedRenderingLevel`; gaze-based needs eye tracking
  (Quest Pro only among our targets) and `com.oculus.permission.EYE_TRACKING`. ([OpenXR foveation 1.18](https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/foveatedrendering.html))
- Application SpaceWarp: Vulkan only; URP with motion-vector pass (Unity 6000.0.9+ built-in); OVRPlugin
  v34+, `OVRManager.SetSpaceWarp` → requires Meta Core SDK; "up to 70 percent additional compute"; transparent
  and semi-transparent content is a known artifact source → not a fit for semi-transparent anatomy; treat as
  optional later optimisation. ([Meta AppSW](https://developers.meta.com/horizon/documentation/unity/unity-asw/))

Implications for decimation targets (`slicer` exporter, to be written into `docs/protocol.md` limits):
- Total scene budget after decimation: **<= 500k triangles (Quest 2 profile), <= 1.0M (Quest 3/3S
  profile)**, leaving headroom for hands, UI, passthrough compositor. Server/plugin should expose the
  profile as a session parameter; default to the Quest 2 budget until the client reports its device.
- Node count: <= 60 visible nodes (draw calls) on Quest 2, <= 120 on Quest 3, assuming one material per
  node; nodes beyond that should be merged by the exporter or hidden by default.
- Transparency: at most ~5 translucent nodes concurrently; UI should warn when more are enabled.
- Memory: a 1M-triangle scene with positions+normals (float32 + 32-bit indices) is ~36 MB in GPU plus the
  managed GLB copy → well inside 4.4 GiB; the risk is CPU time in glTFast (seconds at 1M tris) not RAM.
- Per-message GLB cap suggestion: 64 MiB (Draco-compressed anatomy at 1M tris is typically < 15 MB
  `[TODO verify]` with real Slicer exports).

## 8. Build, install and release from macOS

- Developer Mode: verified Meta developer account (18+), Meta Horizon mobile app → headset → Headset Settings
  → Developer Mode; connect USB-C data cable; on headset allow USB debugging ("Always allow"); enable MTP
  Notification under Settings → Developer. ([Software setup](https://developers.meta.com/horizon/documentation/unity/unity-software-setup/), 2026-10-01)
- adb: shipped with Unity's Android SDK at
  `/Applications/Unity/Hub/Editor/{version}/PlaybackEngines/AndroidPlayer/SDK/platform-tools`; no USB driver
  on macOS; `adb devices` must show `device`; `adb install -r app.apk`. adb-installed apps are not tracked by
  Cloud Backup. ([Device setup](https://developers.meta.com/horizon/documentation/unity/unity-env-device-setup/))
- Meta Quest Developer Hub (MQDH) for Mac **6.5.2** (2026-09-16), signed and notarised; Device Manager,
  Logcat, Performance Analyzer (`mqdh-perf capture`), OVR Metrics, ADB-over-Wi-Fi.
  ([MQDH Mac](https://developers.meta.com/horizon/downloads/package/oculus-developer-hub-mac/))
- Quest Link (streaming the Editor to the headset) is **Windows-only** → on macOS iterate with Build & Run
  (~1–3 min per APK) or the Simulator.
- Store rules: "From July 31st, 2024 on, all Quest apps must be submitted to the Meta Horizon Store"; App Lab
  no longer a separate channel. Release channels ALPHA/BETA/RC (invite-only, 200 users default, up to
  2,500); Production only for review submission; sideloading requires *Unknown Sources*; Meta Platform
  Technologies Keys 2,000 per 6 months after approval; IARC rating and VRC compliance for public listing.
  ([Distribution options](https://developers.meta.com/horizon/policy/distribution-options/) 2026-03-23, [FAQ](https://developers.meta.com/horizon/faqs/), [Release channels](https://developers.meta.com/horizon/resources/publish-release-channels-add-users/))
- CI builds: game-ci `unity-builder@v4` (`targetPlatform: Android`, `androidExportType: androidPackage`,
  custom keystore via base64 secrets, `androidTargetSdkVersion`, Library cache); licence via
  `UNITY_LICENSE` (.ulf from Unity Hub) + `UNITY_EMAIL`/`UNITY_PASSWORD` for Personal, or `UNITY_SERIAL`
  for Pro. Unity's manual activation "doesn't support … Unity Personal"; game-ci issue #235 says the
  Hub-.ulf workaround "still works today" (2026-04-29). Whether Personal terms permit CI use is
  `[TODO verify]` (ask Unity or use a Pro/Plus seat for CI). ([game-ci activation](https://game.ci/docs/github/activation), [game-ci builder](https://game.ci/docs/github/builder), [Unity manual activation](https://docs.unity3d.com/6000.3/Documentation/Manual/ManualActivationGuide.html), [issue #235](https://github.com/game-ci/unity-test-runner/issues/235))
- Unity Build Automation (Cloud Build): since 2026-03-01 pay-as-you-go beyond free tiers of 200 Windows /
  100 Mac / 100 Linux minutes per month. ([Unity DevOps charges](https://support.unity.com/hc/en-us/articles/34748492914964-Understanding-Unity-DevOps-charges))

## 9. Testing

- Unity Test Framework **1.9** (latest). CLI: `Unity -batchmode -projectPath <p> -runTests -testPlatform
  EditMode|PlayMode|<BuildTarget e.g. Android> -testResults <xml> [-testFilter] [-testCategory]
  [-assemblyNames] [-testSettingsFile TestSettings.json] [-playerHeartbeatTimeout] [-forgetProjectPath]
  [-runSynchronously (EditMode only)]`. "no common definition for exit codes"; `-quit` not supported during
  test runs; `TestSettings.json` can set `scriptingBackend`, `architecture`, `playerGraphicsAPI`.
  ([UTF command-line reference](https://docs.unity3d.com/6000.3/Documentation/Manual/test-framework/reference-command-line.html))
- Strategy matching CLAUDE.md rule 10 (no Unity in the sandbox): keep protocol parsing, nodeId mapping,
  transform conversion and state reducers in plain C# assemblies with **EditMode** tests; PlayMode tests
  only for glTFast instantiation and material updates (run on a macOS runner or locally); device PlayMode
  (`-testPlatform Android`) manual/weekly. Meta XR Simulator for manual XR flows on macOS (Apple Silicon).
- CI test job: game-ci `unity-test-runner` (same licence caveat as builds).

## 10. Engine comparison for the ADR

| Criterion | Unity 6.3 LTS | Unreal Engine 5.8 + Meta XR plugin v207 | WebXR-only (Quest Browser) |
|---|---|---|---|
| Effort for this app | Low-medium: glTFast, XRI, templates, byte[] GLB load | High: runtime glTF import weaker (`[TODO verify]` Interchange runtime), C++ for networking, 50 GB install, long Android packaging | Lowest: reuse `web-viewer` three.js + GLTFLoader (Draco/meshopt/KTX2 supported), no store |
| Teaching value | Highest (course teaches Unity) | Low for this course | Medium (web stack) |
| Passthrough / MR | Yes via OpenXR Meta or Core SDK; Quest 2 greyscale | Yes, UE 5.4+ Meta XR plugin; some features need Meta fork | `immersive-ar` listed for Quest 2/Pro on Meta's MR page; Quest 3 `[TODO verify]`; no passthrough pixel access |
| Hands | XR Hands / ISDK | Meta XR plugin | WebXR `hand-tracking` feature |
| Performance headroom | Full: Burst/Jobs, Vulkan, FFR, AppSW | Full | Lower: JS/WebGL, no AppSW, browser overhead |
| macOS development | Build & Run + Simulator (ARM) | Host supported; Simulator Windows-only | Any browser + IWER emulator |
| Distribution | Horizon Store channels / sideload | same | URL only (no sideload, no review); PWA optional |
| Sources | §1–§9 | [Unreal prerequisites](https://developers.meta.com/horizon/documentation/unreal/unreal-quick-start-install-prerequisites/), [Unreal plugin 207](https://developers.meta.com/horizon/downloads/package/unreal-engine-5-integration/) | [WebXR overview](https://developers.meta.com/horizon/documentation/web/webxr-overview/), [WebXR MR](https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/), [Browser specs](https://developers.meta.com/horizon/documentation/web/browser-specs/) |

Recommendation: **Unity** for the `quest` component (ADR to be written as `docs/adr/000X-quest-engine.md`);
keep WebXR as an optional mode of `web-viewer` so that a Quest user can also join from the browser without
installing anything (useful for demos and as a fallback when sideloading is impossible).

## Open questions

1. glTFast handedness conversion axis (Z vs X) — read source or test with an asymmetric model.
2. `ClientWebSocket` + `wss://` on IL2CPP/Android with a Let's Encrypt chain — device smoke test.
3. Multi-fragment reassembly inside NativeWebSocket vs. own `ClientWebSocket` loop.
4. Unity Personal licence terms for CI; otherwise budget a Pro seat for the CI runner.
5. XRI 3.6 `XRGeneralGrabTransformer` scale clamping options (min/max scale).
6. Quest 3/3S colour passthrough statement from a Meta hardware page; WebXR `immersive-ar` on Quest 3.
7. Real Draco-compressed sizes of Slicer anatomy at 0.5–1M triangles (sets the GLB message cap).
8. Whether NJsonSchema handles our chosen JSON Schema draft (2020-12) or we constrain the schema to draft-07.

## Sources

- Unity 6.3 LTS blog: https://unity.com/blog/unity-6-3-lts-is-now-available
- Unity releases/support: https://unity.com/ja/releases/
- Unity Manual 6.3 — Meta Quest develop: https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-develop.html
- Unity Manual 6.3 — Meta Quest build profile: https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-build-profile.html
- Unity Manual 6.3 — Quest packages/templates: https://docs.unity3d.com/6000.3/Documentation/Manual/xr-meta-quest-packages.html
- Unity Manual — Android dependencies: https://docs.unity3d.com/Manual/android-install-dependencies.html
- Unity Manual 6.3 — Android supported dependency versions: https://docs.unity3d.com/6000.3/Documentation/Manual/android-supported-dependency-versions.html
- Unity Manual 6.3 — Manual activation: https://docs.unity3d.com/6000.3/Documentation/Manual/ManualActivationGuide.html
- Unity Manual 6.3 — Test Framework CLI: https://docs.unity3d.com/6000.3/Documentation/Manual/test-framework/reference-command-line.html
- Unity Manual — Managed code stripping (IL2CPP): https://docs.unity3d.com/Manual/IL2CPP-BytecodeStripping.html
- Unity Manual — Source generators (System.Text.Json note): https://docs.unity3d.com/Manual/create-source-generator.html
- OpenXR Plugin 1.18: https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/index.html
- OpenXR 1.18 — Meta Quest Support: https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/metaquest.html
- OpenXR 1.18 — Foveated rendering: https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/foveatedrendering.html
- OpenXR 1.18 — Hand interaction profile: https://docs.unity3d.com/Packages/com.unity.xr.openxr@1.18/manual/features/handinteractionprofile.html
- Unity OpenXR: Meta 2.6: https://docs.unity3d.com/Packages/com.unity.xr.meta-openxr@2.6/manual/index.html
- Unity OpenXR: Meta 2.6 — Camera (Passthrough): https://docs.unity3d.com/Packages/com.unity.xr.meta-openxr@2.6/manual/features/camera.html
- XR Interaction Toolkit 3.6: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/index.html
- XRI 3.6 — XR Grab Interactable: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/xr-grab-interactable.html
- XRI 3.6 — UI setup: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/ui-setup.html
- XRI 3.6 — Hands Interaction Demo: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.6/manual/samples-hands-interaction-demo.html
- XR Hands 1.9: https://docs.unity3d.com/Packages/com.unity.xr.hands@1.9/manual/index.html
- XR Hands 1.10-pre: https://docs.unity3d.com/Packages/com.unity.xr.hands@1.10/manual/index.html
- glTFast 6.20 — features: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html
- glTFast 6.20 — installation: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/installation.html
- glTFast 6.20 — runtime import: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/ImportRuntime.html
- glTFast 6.20 — custom extras: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/UseCaseCustomExtras.html
- glTFast 6.20 — known issues: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/KnownIssues.html
- glTFast 6.20 — changelog: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/changelog/CHANGELOG.html
- glTFast 6.20 — GltfImportBase API: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/api/GLTFast.GltfImportBase.html
- glTFast 6.20 — GameObjectInstantiator API: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/api/GLTFast.GameObjectInstantiator.html
- Draco for Unity 5.5: https://docs.unity3d.com/Packages/com.unity.cloud.draco@5.5/manual/index.html
- meshopt decompress 0.3: https://docs.unity3d.com/Packages/com.unity.meshopt.decompress@0.3/manual/index.html
- Newtonsoft Json package 3.2 changelog: https://docs.unity3d.com/Packages/com.unity.nuget.newtonsoft-json@3.2/changelog/CHANGELOG.html
- UnityGLTF handedness issue (contrast): https://github.com/KhronosGroup/UnityGLTF/issues/257
- NativeWebSocket: https://github.com/endel/NativeWebSocket
- RxWebSocket: https://github.com/nenoNaninu/RxWebSocket
- Unity discussions — ClientWebSocket wss: https://discussions.unity.com/t/solved-clientwebsocket-wss-issues/699587
- Unity issue tracker — wss on iOS/Android: https://issuetracker.unity3d.com/issues/unable-to-establish-wss-connection-in-ios-and-android
- NJsonSchema: https://github.com/RicoSuter/NJsonSchema
- Meta — Core SDK download: https://developers.meta.com/horizon/downloads/package/meta-xr-core-sdk/
- Meta — Core SDK 203 notes: https://developers.meta.com/horizon/downloads/package/meta-xr-core-sdk/203.0
- Meta — Unity Package Manager guide: https://developers.meta.com/horizon/documentation/unity/unity-package-manager/
- Unity Asset Store — Meta XR SDK: https://assetstore.unity.com/packages/package/265014
- Meta — Unity XR plugin (Oculus XR deprecated): https://developers.meta.com/horizon/documentation/unity/unity-xr-plugin/
- Meta — Unity OpenXR settings: https://developers.meta.com/horizon/documentation/unity/unity-openxr-settings/
- Meta — XR Simulator getting started: https://developers.meta.com/horizon/documentation/unity/xrsim-getting-started/
- Meta — XR Simulator Mac ARM 205: https://developers.meta.com/horizon/downloads/package/meta-xr-simulator-mac-arm/205.0/
- Meta — Passthrough getting started: https://developers.meta.com/horizon/documentation/unity/unity-passthrough-gs/
- Meta — Hand tracking overview: https://developers.meta.com/horizon/documentation/unity/unity-handtracking-overview/
- Meta — Interaction SDK overview: https://developers.meta.com/horizon/documentation/unity/unity-isdk-interaction-sdk-overview/
- Meta — ISDK two-handed grab: https://developers.meta.com/horizon/documentation/unity/unity-isdk-two-handed-grab-interaction/
- Meta — ISDK create UI: https://developers.meta.com/horizon/documentation/unity/unity-isdk-create-ui/
- Meta — Unity requirements: https://developers.meta.com/horizon/documentation/unity/unity-req/
- Meta — Unity software setup: https://developers.meta.com/horizon/documentation/unity/unity-software-setup/
- Meta — Unity device setup: https://developers.meta.com/horizon/documentation/unity/unity-env-device-setup/
- Meta — Prepare for publish: https://developers.meta.com/horizon/documentation/unity/unity-prepare-for-publish/
- Meta — Android 14 target requirement: https://developers.meta.com/horizon/blog/meta-quest-apps-android-14-march-1
- Meta — Device optimisation comparison: https://developers.meta.com/horizon/resources/device-optimization-comparison/
- Meta — Unity performance guide: https://developers.meta.com/horizon/documentation/unity/unity-perf/
- Meta — Memory/RAM limits: https://developers.meta.com/horizon/documentation/unity/po-memory-ram/
- Meta — Application SpaceWarp (Unity): https://developers.meta.com/horizon/documentation/unity/unity-asw/
- Meta — Unreal advanced rendering (refresh rates): https://developers.meta.com/horizon/documentation/unreal/unreal-advanced-rendering/
- Meta — WebXR performance best practices: https://developers.meta.com/horizon/documentation/web/webxr-perf-bp/
- Meta — MQDH for Mac: https://developers.meta.com/horizon/downloads/package/oculus-developer-hub-mac/
- Meta — Distribution options policy: https://developers.meta.com/horizon/policy/distribution-options/
- Meta — Developer FAQ (Store/App Lab): https://developers.meta.com/horizon/faqs/
- Meta — Release channels: https://developers.meta.com/horizon/resources/publish-release-channels-add-users/
- Meta — Unreal prerequisites: https://developers.meta.com/horizon/documentation/unreal/unreal-quick-start-install-prerequisites/
- Meta — Unreal Meta XR plugin 207: https://developers.meta.com/horizon/downloads/package/unreal-engine-5-integration/
- Meta — WebXR overview: https://developers.meta.com/horizon/documentation/web/webxr-overview/
- Meta — WebXR mixed reality: https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/
- Meta — Browser specs: https://developers.meta.com/horizon/documentation/web/browser-specs/
- game-ci — activation: https://game.ci/docs/github/activation
- game-ci — builder: https://game.ci/docs/github/builder
- game-ci — issue #235 (Personal licence): https://github.com/game-ci/unity-test-runner/issues/235
- Unity support — DevOps charges (2026-03-01): https://support.unity.com/hc/en-us/articles/34748492914964-Understanding-Unity-DevOps-charges
- Road to VR — Quest 3S/3/2 specs: https://roadtovr.com/quest-3s-quest-3-quest-2-specs-compared/
