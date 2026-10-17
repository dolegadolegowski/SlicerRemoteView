# ADR 0005: Slicer export — custom pure-Python GLB writer, RAS→glTF conversion in Slicer, stable `nodeId`

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `slicer`, `protocol` (coordinate system, `nodeId` semantics), `web`, `quest`
- **Related:** `docs/protocol.md` (coordinate system, units, `nodeId`, limits), `docs/requirements.md`
  (PHI/no-identifying-data NFR), `docs/architecture.md` (snapshot sequence), ADR 0001 (GLB transport),
  ADR 0003 (glTFast consumes the same GLB)

## Context

The plugin must turn MRML model and segmentation nodes into GLB snapshots (ADR 0001) with per-node colour,
opacity, visibility and a stable identifier for incremental updates, and it must be testable without Slicer
(CLAUDE.md rule 10). Verified facts (`docs/research/slicer.md`, 2026-10-17, Slicer 5.12.4 / Python 3.12.10 /
VTK 9.6):

- **`vtkGLTFExporter`** writes **JSON `.gltf` only, never `.glb`**; it exports what the *render window* renders
  (actors of all renderers, skipping invisible ones), writes `baseColorFactor = [diffuse rgb, opacity]` but
  **never sets `alphaMode: BLEND`** (SlicerOpenAnatomy patches the JSON afterwards), writes VTK/RAS coordinates
  in mm as-is, inflates buffers by 33 % with base64 when `InlineDataOn()`, and has no stable node IDs.
- **`vtkGLTFWriter`** takes a `vtkMultiBlockDataSet` (CityGML-oriented), writes `.glb` by extension; whether it
  is Python-wrapped in Slicer's VTK build is `[TODO verify]`.
- Segment meshes: `segNode.CreateClosedSurfaceRepresentation()` then the static
  `vtkSlicerSegmentationsModuleLogic.GetSegmentClosedSurfaceRepresentation(segNode, segmentId, polyData,
  applyParentTransform)`; closed surfaces are already in the segmentation node's RAS frame, only the parent
  transform remains.
- Transforms: `GetMatrixTransformToWorld()` returns 0 when non-linear; `GetTransformToWorld(vtkGeneralTransform)`
  + `vtkTransformPolyDataFilter` handles all cases; `HardenTransform()` mutates the user's node.
- Appearance: `vtkMRMLDisplayNode.GetColor/GetOpacity/GetVisibility3D`; segments via
  `GetSegmentColor(id)`, `GetSegmentOpacity3D(id)`, `GetSegmentVisibility3D(id)`, whole-segmentation `Opacity3D`.
- Node IDs (`vtkMRMLModelNode1`) are unique and stable while a scene is open, remapped on scene load; segments
  have no MRML ID but segment IDs are unique within a segmentation.
- glTF 2.0: right-handed, +Y up, +Z forward, metres, column-major matrices; GLB container = 12-byte header +
  JSON chunk (padded with 0x20) + BIN chunk (padded with 0x00), 4-byte alignment; `POSITION` needs `min`/`max`.
- pip installs at import/constructor time are forbidden (Slicer FAQ, Extension Index); numpy is bundled. glTFast's
  handedness conversion axis is `[TODO verify]` (`quest.md` §4), so protocol math in Unity space is risky.

## Decision

1. **Custom GLB writer in pure Python + numpy + `struct`/`json`** (`slicer-plugin/.../glb_writer.py`, ~150 lines,
   no third-party dependency), a pure function from `(positions, normals, indices, material, nodeId, name)` lists
   to `bytes`; unit-tested outside Slicer; validated with `gltf-validator` in CI `[TODO]` (`tools/`).
2. **Geometry sources:** models via `GetPolyData()`; segments via `CreateClosedSurfaceRepresentation()` +
   `GetSegmentClosedSurfaceRepresentation(..., applyParentTransform=True)`; `vtkTriangleFilter` → optional
   decimation (ADR 0001 budget profiles: `vtkQuadricDecimation`, fallback `vtkDecimatePro(PreserveTopologyOn)`)
   → `vtkPolyDataNormals(SplittingOff)`; indices from `vtkCellArray` connectivity/offsets.
3. **Transforms are baked into the exported vertices** on a *copy* of the polydata (`vtkTransformPolyDataFilter`
   with `GetTransformToWorld`), covering linear and non-linear parents uniformly; **the user's nodes are never
   hardened**. glTF node `matrix` is identity in the snapshot. When a *linear* parent transform changes later,
   the plugin may send a `transform` delta `D = M_new · M_old⁻¹` converted to glTF space (ADR 0001 update
   message) instead of re-exporting the mesh; non-linear changes re-export the node.
4. **Coordinates are converted in Slicer:** `[x, y, z]_gltf = [R, S, −A] × 0.001` (RAS mm → glTF metres, +Y up);
   the basis change `C = 0.001·[[1,0,0],[0,0,−1],[0,1,0]]` has det +1 (winding preserved); normals use the
   rotation part only; any matrix sent in the protocol is `C · M_ras · C⁻¹`. The patient faces −Z; viewers may
   rotate the root 180° about Y. `docs/protocol.md` states "coordinates: glTF, metres, Y-up" as the contract.
5. **Stable `nodeId`:** glTF node `extras.nodeId` = MRML node ID for models (`vtkMRMLModelNode1`) and
   `"<segmentationNodeID>/<segmentID>"` for segments; glTF node `name` = display name. The `nodeId` is valid for
   one session; `EndCloseEvent`/`EndImportEvent` trigger a `scene.reset` and a fresh snapshot.
6. **Materials:** one `pbrMetallicRoughness` material per node, `baseColorFactor = [r, g, b, opacity]`,
   `metallicFactor 0`, `roughnessFactor` ≈ 0.8 (tunable), `alphaMode: "BLEND"` when effective opacity < 1
   (segment opacity × segmentation `Opacity3D`), else `OPAQUE`; `doubleSided` `[TODO verify]` against Slicer's
   default backface rendering before deciding. Invisible nodes are exported with `visible: false` in the state
   message rather than omitted, so toggling needs no re-export.
7. **PHI option:** a "Hide node names" setting replaces `name` with `node-<n>` and omits any description/
   metadata; `nodeId` is opaque anyway. Default **off** (opt-in): students need anatomical labels, and the
   pre-send node list lets the presenter check names before anything leaves Slicer (`docs/requirements.md`
   FR-15, NFR-16). The user guide must recommend turning it on for cases imported from identified DICOM.

## Consequences

**Positive**

- Full control of GLB layout, `extras`, materials and units; no renderer or offscreen window needed; output is
  byte-identical across runs for the same input (testable, hashable for the relay's snapshot id).
- Both clients receive glTF-native coordinates; no viewer-side RAS conversion and no duplicated math in TS and C#.
- No pip dependency for export → no install prompt, no Extension Index concern.
- Baking transforms keeps every snapshot self-consistent (viewers never see geometry with a stale matrix).

**Negative**

- We own glTF spec compliance (alignment, padding, `min`/`max`, `KHR_mesh_quantization` rules) — hence the
  validator in CI.
- Baked transforms mean a moved node needs either a delta matrix (linear) or a re-export (non-linear); a 100k-triangle
  node re-export is ~2–3 MB per change.
- The RAS→glTF mapping makes the patient face −Z; viewers must apply a known root rotation for "face the camera".
- Closed-surface creation and decimation run on Slicer's main thread (VTK) and can block the GUI for seconds on
  whole-body segmentations → progress dialog, one node per timer tick.

**Follow-ups**

- `slicer`: write `glb_writer.py` + tests with synthetic numpy meshes; measure sizes/times on `MRHead`/`CTChest`
  sample segmentations (`docs/testing/slicer.md`); confirm `Opacity3D × SegmentOpacity3D` is what the displayable
  manager renders `[TODO verify]`.
- `protocol`: record the coordinate contract, `nodeId` grammar, `extras` keys, `scene.reset` semantics.
- `quest`: verify glTFast's handedness axis with an asymmetric test GLB before trusting `transform` deltas.
- `tools/`: add `gltf-validator` to CI for exporter fixtures.

## Alternatives considered

- **`vtkGLTFExporter`.** Rejected: `.gltf` only (would need our own GLB packer anyway), render-window traversal
  (slice planes, markups, or a private offscreen renderer), no `alphaMode`, no node IDs, base64 overhead, RAS mm.
- **`vtkGLTFWriter`.** Rejected: multiblock/CityGML-oriented input and materials, Python wrapping in Slicer
  unverified, no `extras`/material control.
- **`pygltflib` / `trimesh`.** Rejected: pip installs at import are forbidden; `pip_ensure` adds a prompt and
  failure modes for ~150 lines of code we can own.
- **Send RAS mm and convert on each viewer.** Rejected: duplicates the conversion in TypeScript and C#, interacts
  with glTFast's (unverified) handedness flip and three.js's Y-up assumption, and makes the GLB non-standard
  (glTF mandates metres and Y-up).
- **Sending linear transforms as node `matrix` (unbaked geometry).** Deferred: more efficient for moving nodes
  but needs per-node local-frame export and a second code path for non-linear transforms; v1 bakes, the
  delta-matrix message gives most of the benefit.

## Sources

- VTK `vtkGLTFExporter` reference and source: https://vtk.org/doc/nightly/html/classvtkGLTFExporter.html ; https://gitlab.kitware.com/vtk/vtk/-/raw/master/IO/Export/vtkGLTFExporter.cxx
- VTK `vtkGLTFWriter`: https://vtk.org/doc/nightly/html/classvtkGLTFWriter.html
- SlicerOpenAnatomy `OpenAnatomyExport.py` (alphaMode patch, root matrix, scaleToMeters): https://raw.githubusercontent.com/PerkLab/SlicerOpenAnatomy/master/OpenAnatomyExport/OpenAnatomyExport.py
- glTF 2.0 specification (coordinates, units, GLB container, alignment, alpha): https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html ; `KHR_mesh_quantization`: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md
- Slicer MRML headers (`Libs/MRML/Core/`, branch `main`): `vtkMRMLSegmentationNode.h`/`.cxx`, `vtkMRMLTransformNode.h`, `vtkMRMLTransformableNode.h`, `vtkMRMLDisplayNode.h`, `vtkMRMLSegmentationDisplayNode.h`, `vtkMRMLScene.h` — https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLSegmentationNode.h ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLSegmentationNode.cxx ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLTransformNode.h ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLTransformableNode.h ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLDisplayNode.h ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLSegmentationDisplayNode.h ; https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/MRML/Core/vtkMRMLScene.h
- `vtkSlicerSegmentationsModuleLogic.cxx` (GetSegmentClosedSurfaceRepresentation, ExportSegmentsToModels): https://raw.githubusercontent.com/Slicer/Slicer/main/Modules/Loadable/Segmentations/Logic/vtkSlicerSegmentationsModuleLogic.cxx ; segment IDs: https://slicer.readthedocs.io/en/latest/developer_guide/modules/segmentations.html
- `slicer/util.py` (arrayFromModelPoints, VTKObservationMixin): https://raw.githubusercontent.com/Slicer/Slicer/main/Base/Python/slicer/util.py ; `vtkCellArray`: https://vtk.org/doc/nightly/html/classvtkCellArray.html ; Python FAQ (no pip at import, `pip_ensure`): https://slicer.readthedocs.io/en/latest/developer_guide/python_faq.html ; `slicer/packaging.py`: https://raw.githubusercontent.com/Slicer/Slicer/v5.12.4/Base/Python/slicer/packaging.py
- Decimation: https://vtk.org/doc/nightly/html/classvtkQuadricDecimation.html ; https://vtk.org/doc/nightly/html/classvtkDecimatePro.html ; conversion rule: https://raw.githubusercontent.com/Slicer/Slicer/main/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx ; glTFast handedness contrast (UnityGLTF #257): https://github.com/KhronosGroup/UnityGLTF/issues/257
