# ADR 0001: Scene transport — GLB geometry rendered locally plus incremental JSON state updates

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `protocol`, `slicer`, `web`, `quest`, `server`
- **Related:** `docs/requirements.md` (NFRs on time-to-first-model, scene size, viewers), `docs/architecture.md`
  (sequences: snapshot, incremental update, late join), `docs/protocol.md` (contract v1), ADR 0004 (MVP scope),
  ADR 0005 (GLB export), ADR 0003 (Quest engine)

## Context

Viewers (iPhone/iPad/Android browsers, Meta Quest) must show the 3D scene of one running 3D Slicer instance,
reached through a relay on Railway over outbound WSS only (`prompts/00-goal.md`, non-negotiable requirements).
Two transport families were on the table: stream *pixels* (video / pixel streaming rendered on the Slicer host
or on a server) or stream *geometry* (meshes once, then small state deltas) and render on each device.

Facts that constrain the choice (from `docs/research/`):

- Railway has no GPU offering in its plan table; usage is billed per vCPU/GB-RAM, and egress costs $0.05/GB
  (`relay.md` §1.7). A server-side renderer would need a GPU the platform does not provide.
- Railway WebSockets have no edge duration/inactivity limit; `ws` 8.22.0 sends one frame per `send()` and
  enforces `maxPayload` (default 100 MiB) with close code 1009 (`relay.md` §1.3, §2).
- three.js r186 `GLTFLoader.parse(arrayBuffer, …)` parses a GLB container directly from a WebSocket payload;
  `KHR_mesh_quantization` is handled natively through `normalized` buffer attributes (no decoder); Draco needs
  `draco_decoder.wasm` 192,420 B + `draco_wasm_wrapper.js` 58,456 B (+ `draco_decoder.js` 512,465 B JS
  fallback); meshopt is a 29,256 B module (`web.md` §1.2–1.3).
- glTFast 6.20.0 loads GLB via `GltfImport.Load(byte[])`, supports `KHR_mesh_quantization` and Draco
  (`com.unity.cloud.draco` 5.5.0, production-ready); meshopt decompress is `0.3.0-exp.1`, "experimental … not
  ready for production use" (`quest.md` §4).
- Safari iOS WebContent process budget is ~1.5 GB on most iPhones with no `webglcontextlost` before the tab
  is killed (`web.md` §2.1); Meta budgets are < 750k triangles (Quest 2) / < 1.5M (Quest 3) per frame and
  < 100 / < 200 draw calls (`quest.md` §7).
- CT segmentations yield 10^5–10^6 triangles per segment before decimation; `vtkQuadricDecimation` /
  `vtkDecimatePro` are available in Slicer's VTK 9.6 (`slicer.md` §5).

## Decision

1. **Geometry is transported as glTF 2.0 Binary (GLB)** produced by the Slicer plugin (ADR 0005) and rendered
   locally by each viewer (three.js on the web, glTFast on Quest). No video or pixel streaming.
2. **Scene state changes are sent as incremental JSON messages** addressed by stable `nodeId`
   (see ADR 0005): visibility, colour, opacity, transform (4x4 in glTF space). Camera synchronisation is a
   later message type (ADR 0004 defers it to M4). Message shapes live in `docs/protocol.md`.
3. **Snapshot granularity:** one GLB per snapshot containing one glTF node (one mesh, one primitive, one
   material) per Slicer model/segment. The relay keeps only the latest snapshot per session in memory and
   serves it to late joiners (`relay.md` §3).
4. **v1 compression: `KHR_mesh_quantization` only** (16-bit positions/normals; no decoder on any client; listed
   in `extensionsRequired`). **Draco is an optional later milestone** (both clients have a production decoder:
   three.js `DRACOLoader` ~250 KB download, Unity `com.unity.cloud.draco` 5.5.0). **meshopt is excluded**
   (experimental in glTFast). `permessage-deflate` on the relay stays off (`relay.md` §2); compression, if any,
   happens at the source.
5. **Decimation happens on the Slicer side** with *budget profiles* exposed as a session parameter (default
   "mobile": ≤ 100k triangles per node, ≤ 500k total; "quest3": ≤ 1M total; exact numbers are NFRs in
   `docs/requirements.md` and limits in `docs/protocol.md`). The relay enforces byte limits only
   (`MAX_SNAPSHOT_BYTES`, proposed 64 MiB) and never inspects geometry.

## Consequences

**Positive**

- Interaction latency is local (orbit/zoom at device frame rate; 72–90 Hz on Quest), independent of network RTT.
- Bandwidth is paid once per snapshot (tens of MB) instead of continuously (a 1080p stream is ~1 GB/h/viewer);
  with 20 viewers (ADR 0004) a 30 MB snapshot costs 0.6 GB egress ≈ $0.03.
- The relay stays a byte pipe with no GPU, no decoding and no knowledge of medical content (CLAUDE.md rule 6).
- Late joiners and reconnects are served from the relay's in-memory snapshot without involving Slicer.
- Both clients can read `nodeId` from glTF `extras` (GLTFLoader `userData`, glTFast `NodeCreated` +
  `GLTFast.Newtonsoft` extras) so state updates need no second mapping.

**Negative**

- Fidelity depends on the device: no volume rendering, no slice planes, no scalar colour maps in v1; VTK shading
  differs from PBR shading in three.js/URP.
- Scene size is bounded by the weakest device (iPhone memory, Quest 2 triangle budget), so decimation is
  mandatory and changes the mesh the clinician sees.
- Mesh changes (segment editing) require re-sending whole node meshes; `MeshModifiedEvent` must be debounced
  (≈ 0.5–1 s, `slicer.md` §3) to avoid flooding.
- Order-dependent transparency artefacts on both renderers (three.js sorts per object; Quest tile GPU overdraw).

**Follow-ups**

- `protocol`: define snapshot framing (size announcement, optional chunking, hash), per-node update schema,
  budget profile enumeration, and `extensionsRequired` policy in `docs/protocol.md`.
- `slicer`: measure triangle counts, decimation time and GLB size on sample segmentations (`docs/testing/slicer.md`).
- `web`/`quest`: measure parse time and peak memory for a 20–50 MB GLB on an iPhone and on Quest 2
  `[TODO verify]` before fixing the default budget profile numbers.
- Draco milestone (post-M2): add `KHR_draco_mesh_compression` writer in the plugin, `DRACOLoader` served from
  `/draco/` (same origin, ADR 0006) and `com.unity.cloud.draco` in Unity; decide per measured sizes.

## Alternatives considered

- **Video / pixel streaming (WebRTC or MJPEG of the Slicer 3D view).** Rejected: every interaction has a full
  network round trip; one encoded stream per viewer (or one shared camera) on the Slicer host or a server GPU;
  Railway offers no GPU; continuous egress cost; no per-node interaction on the device.
- **OBJ / STL per node.** Rejected: no materials (colour/opacity would need a side channel), ASCII or
  uncompressed float32 only (larger than quantized GLB), no standard container for many nodes, no `extras`.
- **Separate GLB per node instead of one GLB per snapshot.** Deferred, not rejected: simpler incremental mesh
  updates and progress UI, but N parse calls and N buffers on the client and more protocol state. The v1
  snapshot is one GLB; a per-node `meshUpdate` message carrying a single-node GLB is reserved in
  `docs/protocol.md` for segment edits.
- **Draco or meshopt from day one.** Rejected for v1: meshopt is experimental in Unity; Draco adds decoder
  download/decode time and a second encoder dependency in Slicer's Python before sizes have been measured.

## Sources

- Railway plans/pricing (no GPU, egress $0.05/GB): https://docs.railway.com/reference/pricing/plans ; https://railway.com/pricing
- Railway specs & limits (WebSockets exempt from timeouts): https://docs.railway.com/networking/public-networking/specs-and-limits.md
- `ws` 8.22.0 API (`maxPayload`, one frame per `send`, `perMessageDeflate` off): https://github.com/websockets/ws/blob/master/doc/ws.md
- three.js `GLTFLoader.js` (GLB magic, `KHR_mesh_quantization`, decoder setters): https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/loaders/GLTFLoader.js
- Draco decoder file sizes: https://api.github.com/repos/mrdoob/three.js/contents/examples/jsm/libs/draco/gltf ; meshopt: https://github.com/zeux/meshoptimizer/blob/master/js/README.md
- `KHR_mesh_quantization` spec: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md
- glTFast 6.20 features / runtime import: https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/features.html ; https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.20/manual/ImportRuntime.html
- Draco for Unity 5.5: https://docs.unity3d.com/Packages/com.unity.cloud.draco@5.5/manual/index.html ; meshopt decompress 0.3 (experimental): https://docs.unity3d.com/Packages/com.unity.meshopt.decompress@0.3/manual/index.html
- WebKit bug 268816 (~1.5 GB WebContent limit) and 300782 (reload loop): https://bugs.webkit.org/show_bug.cgi?id=268816 ; https://bugs.webkit.org/show_bug.cgi?id=300782
- Meta device optimisation comparison / Unity perf guide: https://developers.meta.com/horizon/resources/device-optimization-comparison/ ; https://developers.meta.com/horizon/documentation/unity/unity-perf/
- VTK decimation: https://vtk.org/doc/nightly/html/classvtkQuadricDecimation.html ; https://vtk.org/doc/nightly/html/classvtkDecimatePro.html
- Slicer forum on mesh sizes: https://discourse.slicer.org/t/size-of-stl-obj-files-too-many-triangles/5137
