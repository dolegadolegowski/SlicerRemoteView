# Quantised meshes in the GLB writer (SLC-12)

What `remoteview_core.glb_writer.write_glb(..., quantize=True)` relies on. Source: the `KHR_mesh_quantization`
specification, [KhronosGroup/glTF@7cee0fc `extensions/2.0/Khronos/KHR_mesh_quantization/README.md`](https://github.com/KhronosGroup/glTF/blob/7cee0fcddd5730e90d488bfb5aa2e52171483dde/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
(read 2026-10-21), and the Khronos glTF validator the tests run (`tests/validate_glb.mjs`).

| Fact | Spec lines | Used as |
|---|---|---|
| A file that uses the extension must list it in `extensionsRequired` ("the extension is not optional") | L36 | `extensionsUsed` and `extensionsRequired` = `["KHR_mesh_quantization"]`, only when the GLB has a mesh |
| `POSITION` may be (unsigned) byte or short, normalised or not; `NORMAL` byte or short **normalised** | L44-L45 | `POSITION` non-normalised `SHORT`, `NORMAL` normalised `BYTE` |
| Each element is aligned to 4 bytes: a `BYTE` normal has a stride of 4, not 3 | L49 | strides 8 (positions) and 4 (normals); views and accessor offsets 4-byte aligned |
| Quantised normals are not exactly unit length; viewers normalise them | L53 | the writer's unit-length check applies to the float input only |
| `accessor.min`/`max` hold quantised values | L55 | `min`/`max` on the `SHORT` accessor are the stored integers |
| The dequantisation of a non-skinned mesh goes into the node transform (an extra leaf node when needed); keep the scale uniform across X/Y/Z so normals keep their direction | L76-L82 | the mesh node `M` (already a leaf under `T`, protocol §7.2) carries `matrix` = uniform scale ⊕ offset; `T.matrix` keeps the world transform |
| Normalised `BYTE` decodes as `max(c / 127, -1)` and encodes as `round(f × 127)` | L100 | `NORMAL` = `round(n × 127)` (protocol §7.4 allows `FLOAT` or normalised `BYTE`; FR-09's "16-bit normals" is reported in `docs/testing/reports/2026-10-21-slicer-3.md`) |
| Signed normalised positions may decode differently on WebGL 1 / GLES 2; unnormalised avoids it | L105 | positions are unnormalised `SHORT` |

## Step and error

One step per mesh: `s = max(extent) / 65,534` (at least 1e-9 m so a mesh that is a single point stays invertible), the
offset is the bounding-box centre, and a vertex is stored as `round((p − offset) / s)` ∈ [−32,767, 32,767]. The error
is at most `s / 2` per axis: 2.3 µm for a 0.3 m head, 14 µm for a 1.8 m whole-body model (the plan's 1e-5 m holds up
to a 1.3 m extent). Quantising from the float64 input keeps the bound; quantising float32 values first added their
rounding to it.

Viewers: three.js `GLTFLoader` handles the extension natively through normalised buffer attributes
(`docs/research/web.md` §1), glTFast imports it (`docs/research/quest.md`, Features table).
