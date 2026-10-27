# Decimation to the profile budgets (SLC-14)

What `remoteview_core.decimate` relies on. Checked against VTK v9.6.0 headers; the dev venv runs VTK 9.6.2, and Slicer
5.12.4 builds VTK 9.6 by default — Slicer's fork tag `slicer-v9.6.2-2026-05-15-f49a1dbaf`
([CMakeLists.txt#L455](https://github.com/Slicer/Slicer/blob/v5.12.4/CMakeLists.txt#L455),
[SuperBuild/External_VTK.cmake#L173-L175](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_VTK.cmake#L173-L175)).

## Filters

| Fact | Source | Used as |
|---|---|---|
| `vtkQuadricDecimation` treats triangles only; `TargetReduction` is a fraction of the input triangles and "the actual reduction may be less depending on triangulation, topological constraints and optional maximum error limit" | [vtkQuadricDecimation.h#L7-L11, L66-L74](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.h#L66-L74) | first filter; its result is used only when it has at most the node's share of triangles |
| `vtkDecimatePro` treats triangles only; the requested reduction "may not be realized" unless topology changes, splitting and boundary deletion are allowed (turning splitting off: "you may not obtain the requested reduction") | [vtkDecimatePro.h#L7-L10, L96-L106, L132-L137](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.h#L96-L106) | second filter (the plan's fallback) |
| `vtkDecimatePro` "is guaranteed to generate a reduced mesh at this level" when `PreserveTopology` is off, `Splitting` and `BoundaryVertexDeletion` are on and `MaximumError` is `VTK_DOUBLE_MAX` — "these ivars are initialized this way when the object is instantiated" | [vtkDecimatePro.h#L34-L56, L100-L105](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.h#L34-L56) | third filter, so a node is never left above its share unless every filter fails (then it is sent whole and reported, never dropped — §7.5) |

Every result is checked the same way: at least one triangle, at most the share, finite normals after
`collect.mesh_from_triangles` (the normals filter of SLC-07; triangles without area and unused points dropped) — a
zero normal is repaired to +Y with `coords.unit_normals`, as for a collected node — and positions within float32.
Indices out of range or repeating a vertex are refused before any filter (VTK does not check them; a `vtkDecimatePro` crash on the latter was reported in review but not reproduced with VTK 9.6.2 — `[TODO verify]` with the input that crashed). The guaranteed reduction of the third filter was measured not to hold for duplicated or non-manifold triangles; such a node is sent whole and reported. The input is the
collected entity (glTF metres: RAS → glTF is a rotation and a uniform scale, so the quadric error and the winding are
unchanged).

## Measured (dev venv, this container)

| Input | Target | `vtkQuadricDecimation` | `vtkDecimatePro` (topology kept) |
|---|---|---|---|
| `vtkSphereSource` 632 × 318 (399,424 triangles; the criterion-1 test uses 448 × 448: 399,616) | 100,000 | 100,000 in 3.3 s | 100,000 in 2.6 s |
| same | 2,000 | 2,000 in 4.7 s | 2,000 in 3.4 s |

A 400k-triangle node therefore blocks Slicer's main thread for a few seconds — up to ≈ 8 s when all three filters
run. **Worst case (measured by the SLC-14 review, VTK 9.6.2 wheel):** the quadric is super-linear on dense, exactly flat
regions (tied zero-error collapses): a flat 0.1 m plane of 180k triangles takes 57 s to reach 100k and 237 s / 2.3 GB
to reach 2k; an unsmoothed segmentation-like surface of 427k triangles with flat caps takes 437 s / 3 GB to reach 100k
(`vtkDecimatePro(PreserveTopologyOn)`: ≈ 3 s; the same surface smoothed by Slicer's default 0.5: ≈ 8 s). A progress
observer's `AbortExecuteOn` stops the quadric only after ≈ 16 s (7 progress events). SLC-28 bounds one node's time and
moves the preparation to one node per `QTimer` tick with a progress dialog (FR-10). Whole-snapshot test (`test_decimate_quest2_scene_fits_500k_…`): about
5 s for 564k input triangles.

## Shares

`allocate(counts, budget)` gives node *i* `min(count_i, cap, max(floor_i, ⌊λ·count_i⌋))` with `floor_i = min(count_i,
2,000)` and the largest `λ` (bisection, 60 steps) whose sum fits the total; when the floors alone exceed the total every
node keeps its floor (never dropped). The 2,000-triangle floor is the plan's (FR-10); the per-node cap and totals are
protocol §7.5.

## Size estimate

`glb_binary_size` is exact (12 bytes a vertex quantised, 24 as floats; indices 2 or 4 bytes, each block padded to 4).
The JSON chunk is estimated from measured sizes: 420 bytes for an empty scene, 70 for the quantisation declarations,
≈ 1,100 bytes per quantised node (≈ 970 as floats) plus its name and IDs. Measured error: < 0.1 % for meshes of
thousands of triangles, up to +4 % for 40 cubes of 12 triangles (`tests/test_decimate.py`).
