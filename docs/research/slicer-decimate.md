# Decimation to the profile budgets (SLC-14, SLC-41)

What `remoteview_core.decimate` relies on. Checked against VTK v9.6.0 headers; the dev venv runs VTK 9.6.2, and Slicer
5.12.4 builds VTK 9.6 by default — Slicer's fork tag `slicer-v9.6.2-2026-05-15-f49a1dbaf`
([CMakeLists.txt#L455](https://github.com/Slicer/Slicer/blob/v5.12.4/CMakeLists.txt#L455),
[SuperBuild/External_VTK.cmake#L173-L175](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_VTK.cmake#L173-L175)).

## Filters

| Fact | Source | Used as |
|---|---|---|
| `vtkQuadricDecimation` treats triangles only; `TargetReduction` is a fraction of the input triangles and "the actual reduction may be less depending on triangulation, topological constraints and optional maximum error limit" | [vtkQuadricDecimation.h#L7-L11, L66-L74](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.h#L66-L74) | first filter; its result is used only when it has at most the node's share of triangles |
| `vtkDecimatePro` treats triangles only; the requested reduction "may not be realized" unless topology changes, splitting and boundary deletion are allowed (turning splitting off: "you may not obtain the requested reduction") | [vtkDecimatePro.h#L7-L10, L96-L106, L132-L137](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.h#L96-L106) | second filter (the plan's fallback) until SLC-41 |
| `vtkDecimatePro` "is guaranteed to generate a reduced mesh at this level" when `PreserveTopology` is off, `Splitting` and `BoundaryVertexDeletion` are on and `MaximumError` is `VTK_DOUBLE_MAX` — "these ivars are initialized this way when the object is instantiated" | [vtkDecimatePro.h#L34-L56, L100-L105](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.h#L34-L56) | third filter until SLC-41, so a node was never left above its share unless every filter failed; its splitting cracked the surface (the phone image of SLC-41), so it is no longer used |

The pipeline since SLC-41 (no `vtkDecimatePro`) is in [§ Very large meshes and the stall](#very-large-meshes-and-the-stall-slc-41).
Every result is checked the same way: at least one triangle, at most the share, finite normals after
`collect.mesh_from_triangles` (the normals filter of SLC-07; triangles without area and unused points dropped) — a
zero normal is repaired to +Y with `coords.unit_normals`, as for a collected node — and positions within float32.
Indices out of range or repeating a vertex are refused before any filter (VTK does not check them; a `vtkDecimatePro` crash on the latter was reported in review but not reproduced with VTK 9.6.2). Until SLC-41 the guaranteed reduction of the third filter was measured not to hold for duplicated or non-manifold triangles; such a node was sent whole and reported, and a node nothing can reduce still is. The input is the
collected entity (glTF metres: RAS → glTF is a rotation and a uniform scale, so the quadric error and the winding are
unchanged).

## Measured (dev venv, this container)

| Input | Target | `vtkQuadricDecimation` | `vtkDecimatePro` (topology kept) |
|---|---|---|---|
| `vtkSphereSource` 632 × 318 (399,424 triangles; the criterion-1 test uses 448 × 448: 399,616) | 100,000 | 100,000 in 3.3 s | 100,000 in 2.6 s |
| same | 2,000 | 2,000 in 4.7 s | 2,000 in 3.4 s |

A 400k-triangle node therefore blocked Slicer's main thread for a few seconds — up to ≈ 8 s when all three filters
ran. **Worst case (measured by the SLC-14 review, VTK 9.6.2 wheel; fixed by SLC-41, see the next section — natively
≤ 1 s on these cases now):** the quadric is super-linear on dense, exactly flat
regions (tied zero-error collapses): a flat 0.1 m plane of 180k triangles takes 57 s to reach 100k and 237 s / 2.3 GB
to reach 2k; an unsmoothed segmentation-like surface of 427k triangles with flat caps takes 437 s / 3 GB to reach 100k
(`vtkDecimatePro(PreserveTopologyOn)`: ≈ 3 s; the same surface smoothed by Slicer's default 0.5: ≈ 8 s). A progress
observer's `AbortExecuteOn` stops the quadric only after ≈ 16 s (7 progress events) on those inputs. SLC-41 bounds one
node's decimation time (collect is not inside that bound); SLC-28 moves the preparation to one node per `QTimer` tick
with a progress dialog (FR-10). Whole-snapshot test (`test_decimate_quest2_scene_fits_500k_…`): about 1 s for 564k
input triangles.

## Very large meshes and the stall (SLC-41)

A user's micro-CT segmentation (one segment; labelmap 813 × 813 × 830 at 0.075 mm; closed surface with Slicer's
decimation factor 0) has 16,173,180 triangles, and collect keeps 16,116,404 of them (it drops 56,776 triangles without
area). *Start session* froze Slicer 5.12.4 (x86_64 under Rosetta) for about 3 minutes. Everything ran on the main
thread: collect took 6.3 s and `fit_to_budget` 169.6 s, with a peak of 16 GB. The quadric stopped at 15,998,256
triangles, `vtkDecimatePro(PreserveTopologyOn)` stopped at 3,275,820, and `vtkDecimatePro` with its defaults then made
the 100,000 triangles that were sent. Its splitting cracked the surface along lines, and its unbounded error left large
flat facets and shards, where Slicer's 3D view shows smooth bone.

| Fact | Source ([VTK v9.6.0](https://github.com/Kitware/VTK/tree/v9.6.0)) | Used as |
|---|---|---|
| (a) The quadric works on a copy of the input points in a `vtkPoints::New()`, whose type is `VTK_FLOAT` (`GetDataType()` of a new `vtkPoints` is 10 in the 9.6.2 wheel); `DeepCopy` keeps the destination's type, so the copy converts double input to float32 (measured: a 1e-12 offset is lost) | [vtkQuadricDecimation.cxx#L292-L303](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L292-L303), [vtkPoints.cxx#L35](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPoints.cxx#L35), [vtkPoints.cxx#L220-L236](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPoints.cxx#L220-L236) | `_weld_float32` checks edges in float32; the input is centred first (more float32 bits) |
| (b) `AddBoundaryConstraints` computes `c = Dot(e0, e1) / \|e0\|²`, which is NaN for a boundary edge of zero length; the NaN constraint quadric is added to both ends. `TrianglePlaneCheck` has the same division | [#L721-L828](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L721-L828) (L763, L815-L820), [#L1386](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L1386) | the cause of the stall; the weld removes such edges |
| (c) The main loop runs while `cost < MaximumError` (default `VTK_DOUBLE_MAX`): a NaN cost fails the test and ends it | [#L396-L443](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L396-L443), [vtkQuadricDecimation.h#L373](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.h#L373) | idem |
| (d) `vtkPriorityQueue` compares priorities only with `<` and `>`, so a NaN breaks the heap order and can surface early | [vtkPriorityQueue.cxx#L67-L78](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPriorityQueue.cxx#L67-L78), [#L114-L160](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPriorityQueue.cxx#L114-L160) | idem |
| (e) `CheckAbort` runs only every 10,000 collapses, the first time at collapse 0, after the set-up (`InitializeQuadrics`, `AddBoundaryConstraints`), which cannot be aborted. An observer's `AbortExecuteOn` gives an empty output and leaves `GetAbortExecute()` at 1 (measured, 9.6.2: 318k triangles, 0 triangles out after 0.08 s with a 0 s limit; VTK prints nothing) | [#L346-L374](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L346-L374), [#L402-L407](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L402-L407) | `QUADRIC_SECONDS` deadline from the start of the quadric step; an aborted or empty run fails the whole node, which goes to the fallback |
| (f) `Regularize` adds σ² to the quadric's diagonal, −σ²·p to its linear terms and σ²(\|p\|² + 1 + 3σ²) to its constant term (σ = `Regularization`, default 0.05, off by default): the constant term mixes units, so σ is not scale-free | [#L520-L524](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L520-L524), [#L570-L589](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L570-L589), [vtkQuadricDecimation.h#L110-L131](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.h#L110-L131), defaults [.h#L348-L349](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.h#L348-L349) | `RegularizeOn`, σ = 0.01 on coordinates scaled to a median edge of 100; it breaks the exact cost ties of flat regions |
| (g) `ComputeCost` uses absolute thresholds (`errorNumber` 1e-10) | [#L972-L1066](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L972-L1066) | the scale to a median edge of 100 (`EDGE_UNITS`) |
| (h) `FindAffectedEdges` uses `vtkIdList::IsId` over the fans of both ends, so a collapse costs about the square of the valence | [#L849-L886](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L849-L886) | `FAN_LIMIT`: non-manifold fans are clustered instead |
| (i) `vtkPolyDataNormals`: a point normal is the sum of the unit normals of its polygons; `vtkOrientPolyData` runs only when `Consistency` or `AutoOrientNormals` is on, and it reverses a neighbour only when that neighbour does not traverse the shared edge in the opposite direction — so a mesh with no repeated directed edge is left as it is | [vtkPolyDataNormals.cxx#L103-L180](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L103-L180), [#L245-L255](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L245-L255), [vtkOrientPolyData.cxx#L80-L110](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx#L80-L110) | `_repair_folds` uses the same rule; collect skips `ConsistencyOn` on a consistently wound mesh; decimate's last step runs with `ConsistencyOff` |
| (j) `vtkDecimatePro`'s guaranteed reduction needs `Splitting`, which splits the mesh along feature edges (the cracks) | [vtkDecimatePro.h#L36-L60](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.h#L36-L60) | not used any more |
| (k) `vtkQuadricDecimation` does not check the link condition: `IsGoodPlacement` runs only `TrianglePlaneCheck`, and it can make non-manifold edges (the full 85 s quadric leaves 2.9k on the reporter's mesh) | [#L1410-L1465](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L1410-L1465), measured | `nonmanifold_edges` is reported, not forced to 0 |
| (l) `AddBoundaryConstraints` calls `GetCellEdgeNeighbors` on every edge of every triangle (#L736-L742), which loops over the cell links of both ends, nested: its work is `Σ deg(a) · deg(b)` over the triangles' edges (`clustering.edge_work`). `vtkOrientPolyData` calls it on every edge it crosses. 106-148 per triangle on ordinary meshes; 6.4e10 on 672 pages of 24 × 24 quads on one spine (`fan_weight` 46.9, below 50): 16.8 s of set-up before the first abort check; collect's `ConsistencyOn` on 3,000 pages: 172 s | [#L736-L742](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L736-L742), [vtkPolyData.cxx#L1220-L1245](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolyData.cxx#L1220-L1245) | `QUADRIC_WORK` (2e9, about 0.5 s natively): above it the mesh goes the fan path and the quadric is not started; collect's `ORIENT_WORK` (2e9) together with `ORIENT_WORK_PER_TRIANGLE` (1,000): only a non-manifold fan, above both, keeps its given winding (an ordinary mesh measures 106-148 per triangle and is re-oriented at any size) |

All of the source facts above were read in the v9.6.0 sources, which are the base of Slicer's VTK fork. Slicer 5.12.4
bundles numpy 2.4.6, so `np.minimum.at` (used by the clustering) is fast there.

**The cause on the user's mesh.** collect drops Slicer's triangles without area, which leaves 42,732 boundary edges.
Some of them are very short: two distinct float64 vertices at almost the same place. In the quadric's float32 copy
10-25 of these edges have zero length. Each one gives a NaN boundary quadric (b), and the NaN cost ends the loop (c, d)
after about 56,000 collapses (16.1M → 16.0M triangles). On this mesh the size bound (step 1) already merges these
coincident ends, so the quadric gets no zero-length edge; the weld matters for meshes below the bound. A copy of the surface rebuilt outside Slicer has no triangles without area and no
boundary edges, and the quadric does not stall on it (85.4 s to 100,000). The generated reproduction is
`test_decimate_quadric_stall_float32_generated`: a sphere of 3,040 triangles with one triangle removed and a hole edge
split by a vertex 1e-12 m from its end. Plain `vtkQuadricDecimation(0.9)` keeps 3,038 triangles for a target of 304;
after the weld it reaches 303.

**The pipeline** (`decimate_entity`; constants in `decimate.py`, clustering in `clustering.py`, numpy only):

0. Small islands (SLC-53, in `fit_to_budget(…, remove_islands=True)`, before the shares): every node loses its parts
   below 1,196 triangles that also have less than 1 % of its largest part's triangles — [slicer-islands.md](slicer-islands.md).
1. Size bound. A node above `2 · max(CLUSTER_GOAL, 3 · share)` triangles (800k for a 100k share; `CLUSTER_GOAL`
   400,000) is clustered to about that goal. The cell is the median edge × √(triangles / goal). A cluster is a
   connected piece of the mesh inside one grid cell, so the two sides of a wall thinner than a cell stay apart.
   Vertices at exactly the same position whose normals agree (the two sides of a seam left by a reader's or a normal
   filter's duplicated points) count as connected, so a seam does not open; opposite normals (the two layers of a
   double-sided sheet) stay apart. A cluster's position is the member closest to the cluster's mean, which lies on the
   input surface. A triangle keeps the order of its clusters (its winding). Duplicates with the same winding are
   merged, and folds whose windings cancel are dropped. Input triangles none of whose clusters is used by a kept
   triangle — islands smaller than a cell, also thin ones whose two sides cancel — are clustered again with cell / 3,
   unless they are more than `RESCUE_GOALS · goal` (3 × 400k); the result is clustered again without the rescue (up
   to 6 times) while it is above `2 · goal`. On the reporter's mesh this takes 16.1M → about 0.5M triangles in about
   2.8 s; a 16.5M-triangle random labelmap (2 % of the voxels: dust) takes 2.7 s instead of 14.9 s, and the same
   smoothed like Slicer's 0.5 4.4 s instead of 23-32 s (and a node left whole).
2. Fans. When `Σdeg² / Σdeg` > 50 (non-manifold fans; about 6 on an ordinary mesh, about 1,000 on the 3,000-page
   book) or the quadric's set-up `edge_work` (fact l) is above 2e9, the mesh is clustered by grid cell and the
   tetrahedral class of the vertex normal, to about `max(10 · share, 20,000)` triangles. The cell is divided by 1.6
   (up to 10 times) until at least twice the share is left, then grown by 1.6 while `edge_work` is still above 2e9.
   672 pages of 24 × 24 quads (`fan_weight` 46.9): 17 s → 1.5 s to 100k, 0.4 s to 2k.
3. Island shares. Connected parts below 2,000 triangles get their own quadric run with twice their proportional
   share, at most half the share (all of it when every part is small, and what the large parts left when that is
   more). Without this, one run eats the debris first: recon16m d_in_to_out p99 goes from 0.0051 to 0.0093 and its
   max from 0.058 to 0.118.
4. The quadric (`RegularizeOn`, σ 0.01). It runs on coordinates centred on the bounding box and scaled to a median
   edge of 100. The ends of edges that are zero-length in float32 are welded first (one pass: a vertex and its root
   are equal in float32). One deadline per node, `QUADRIC_SECONDS` = 8 s from the start of the quadric step: no run
   starts after it, a progress observer aborts a running one, and a mesh whose set-up is above `QUADRIC_WORK` is not
   given to the quadric at all. The clustering of steps 1-2 is numpy and linear, so it is not counted: counted from
   `decimate_entity`'s entry (the first version), the reporter's node left the quadric 1.5 s of margin in Slicer
   under Rosetta (size bound 4.4-4.5 s, then a quadric step of 2.0-2.2 s), and machine load could switch it to the
   coarser fallback (seen once natively under load by the SLC-41 critic); now the step has about 4 times what it
   needs there. A run that is aborted, not started or gives no
   triangle fails the whole node: no part (the body, or its islands) is dropped silently.
5. Fallback, when any part gives no usable result (aborted, no triangle, more than the share, a non-finite normal
   or a position beyond float32): clustering of the whole mesh of step 2 with the cell grown × 1.25 up to 12 times,
   until the share is met — connected clusters, then normal classes, which reduce what connected clusters empty
   (closed parts smaller than a cell, non-manifold fans). When a cell empties the mesh right after one that left too
   many, the cell is bisected between the two (up to 8 times). When neither gives a result at or under the share,
   the node is kept whole and reported, never dropped (§7.5). There is no splitting, and seams are joined, so it
   opens no cracks. Every fallback — after the quadric, or when the size bound leaves no triangle — logs one
   warning (`remoteview_core.decimate`) with the reason, the node's triangle count and the outcome (reduced to N
   triangles, or sent whole), no node data (T7). Slicer routes Python `logging` records to its Error Log and shows
   warnings in the Python console at its console log level (`[TODO verify]` for 5.12.4), so the tester can see
   which path ran.
6. Folds. A triangle whose face normal opposes the sum of its vertices' normals (rule (i)) is turned over, for up to
   3 rounds. The point normals then come from `vtkPolyDataNormals` with `SplittingOff` (§7.4) and `ConsistencyOff`.
   With `ConsistencyOn` a decimated non-manifold mesh had whole regions turned inside out (9.7 % of the triangles
   opposed their normals).

The bound is on decimation: `QUADRIC_SECONDS`, plus the size bound and fan clustering before it, plus the fallback
and the last step after it; collect comes before. On the reporter's mesh natively collect takes 3.4 s and
`fit_to_budget` 4.5 s (7.9 s in all; peak 7.3 GiB).

collect: `_with_normals` runs `ConsistencyOn` only when a directed edge repeats (`_consistently_wound`). If none
repeats, every edge has at most two triangles, traversed in opposite directions, and `vtkOrientPolyData` turns
nothing over (fact i). On Slicer's raw surface of the reporter's mesh, `mesh_from_polydata` takes 2.77-3.00 s instead of
4.62-4.87 s, with identical positions, triangles and normals. When a directed edge repeats on a non-manifold fan —
`edge_work` above `ORIENT_WORK` (2e9; fact l) and above `ORIENT_WORK_PER_TRIANGLE` (1,000) per triangle —,
`ConsistencyOn` is skipped too and the given winding is kept: collect of the 3,000-page book takes 0.02 s instead of
172 s (a 1,000-page one 0.01 s instead of 6.6 s). The per-triangle rule was added after the SLC-41 critic: an
ordinary mesh measures 106-148 per triangle whatever its size, so the absolute bound alone skipped every mesh above
about 15M triangles, and such a mesh kept a reversed patch (the critic's 20M-triangle UV sphere: 4.9 % of the
decimated output faced inward). With the rule, a 20.2M-triangle UV sphere with 321k triangles reversed on the equator
(`edge_work` 2.38e9, 118 per triangle) is re-oriented: `mesh_from_triangles` 7.15 s natively, no face inward, peak
10.1 GiB.

**Measured** natively (arm64, dev venv, VTK 9.6.2 wheel), one case per process, wall time ± 20 % (other benchmarks
ran at the same time). The cases are those of the local benchmark harness (never committed). slicer16m is the
reporter's mesh as collect makes it, and recon16m the same labelmap rebuilt outside Slicer. The distances are
fractions of the input's bounding-box diagonal (area-weighted samples). `normal_opposes_face` is the share of
triangles whose mean vertex normal opposes their face: they shade dark, or vanish under the viewer's back-face culling.

| Case → target | Before (s) | After (s) | Triangles | d_out_to_in p99 | d_in_to_out p99 / max | Non-manifold edges | normal_opposes_face | Peak RSS |
|---|---|---|---|---|---|---|---|---|
| slicer16m → 100k | 148.8 (99,897; p99 3.8e-3 / 3.9e-3, max 0.017) | 4.4-4.5 | 99,999 | 1.27e-3 | 2.80e-3 / 0.033 | 2,022 | 0.43 % | 6.3 GB (before 10.1) |
| recon16m → 100k | 85.4 (p99 1.19e-3 / 5.76e-3, max 0.117) | 4.2 | 100,000 | 1.37e-3 | 3.62e-3 / 0.056 | 2,437 | 0.53 % | 6.2 GB (before 11.4) |
| slicer16m → 2k | — | 4.8 | 2,000 | 8.3e-3 | 4.1e-2 / 0.164 | 310 | 2.3 % | 6.2 GB |
| recon16m → 2k | — | 4.5 | 1,998 | 8.2e-3 | 4.1e-2 / 0.171 | 295 | 2.0 % | 6.2 GB |
| sphere400k → 100k | 0.85 | 0.82 | 100,000 | 1.2e-5 | 1.2e-5 / 1.9e-5 | 0 | 0 | 0.4 GB |
| sphere400k → 2k | 1.06 (p99 6.5e-4) | 1.06 | 2,000 | 6.9e-4 | 6.9e-4 / 8.4e-4 | 0 | 0 | 0.5 GB |
| plane180k → 100k | 93.9 | 0.22 | 100,000 | 0 | 0 / 0 | 0 | 0 | 0.2 GB |
| plane180k → 2k | 234.4 (3.0 GB) | 0.37 | 1,999 | 0 | 0 / 0 | 0 | 0 | 0.3 GB |
| plane28k → 2k | 5.6 | 0.06 | 2,000 | 0 | 0 / 0 | 0 | 0 | 0.1 GB |
| flatcap427k (456,176 triangles) → 100k | 28.4 | 0.90 | 100,000 | 1e-6 | 1e-6 / 7e-6 | 0 | 0 | 0.9 GB |
| book3000 (96,000, non-manifold) → 2k | did not finish (killed after 600 s) | 0.35 | 1,998 | 1.9e-4 | 4.2e-3 / 8.7e-3 | 423 | 0 | 0.2 GB |
| In Slicer 5.12.4 (Rosetta, 2026-10-28, two runs in one process): slicer16m collect + `fit_to_budget` | 6.3 + 169.6 (16 GB) | 3.8-4.4 + 6.6-6.7 = 10.5-11.0 (size bound 4.4-4.5, quadric 1.75 + 0.10, not aborted; GLB 1.22 MB, before 3.07 MB) | 99,999 | 1.27e-3 | 2.80e-3 / 0.033 | 2,022 | 0.43 % | 12.2 GiB, `ru_maxrss` / 2³⁰ (7.2 GiB with the scene loaded) |

The rescue counts a cluster alive only when a kept triangle uses it (SLC-41 review): at 100k this improves
d_in_to_out p99 by about 29 % (slicer16m 3.96e-3 → 2.80e-3, max 0.077 → 0.033) for +1.5 % / +6 % d_out_to_in p99
(slicer16m 1.25e-3 → 1.27e-3, recon16m 1.29e-3 → 1.37e-3) and about 3 × the boundary edges (thin debris kept as
open pieces). At 2k it is worse (slicer16m d_in_to_out p99 3.3e-2 → 4.1e-2), because the rescued pieces, clustered
finer, take more of the island share from the body. The peak memory of the native flow (read the surface, collect,
`fit_to_budget`) is 7.3 GiB; Slicer added about 4.5 GB to the same flow before SLC-41, so about 12 GB is expected
there (not under 8 GB: collect's normals step and the clustering each hold about 5 GiB above the surface).

Offscreen renders of the slicer16m result, with back faces culled like the viewer and the same cameras as Slicer's
full-resolution surface, are smooth: no cracks along lines, no shards and no large flat facets. What is still
visibly different from Slicer's view at 100k triangles:

- the micro-CT grain is smoothed away (any 100k budget does this);
- the holes in the thin perforated wall at the top left are a little larger, with a few more see-through specks. The
  full-resolution quadric shows the same, and double-sided renders are identical, so these are eroded thin walls,
  not winding;
- the loose debris beside the jaw is thinner (d_in_to_out max 0.033 against 0.017).

On recon16m, d_out_to_in p99 is 15 % worse than the 85 s full quadric (1.37e-3 against 1.19e-3), while d_in_to_out
p99 and max are better (3.62e-3 against 5.76e-3, 0.056 against 0.117). If the in-Slicer total is above 10 s, there are two measured knobs:

- `CLUSTER_GOAL` 300k: about 0.5 s faster natively, but recon16m d_out_to_in p99 1.40e-3;
- skipping collect's normals for nodes above the per-node cap: collect 0.98 s natively.

Rejected alternatives (measured on the same harness):

- `vtkQuadricClustering` at 128³ or 256³, then the old chain (2.0 s or 7.7 s): 13,112 or 3,962 non-manifold edges,
  and 7.9 % or 3.9 % of the triangles opposed their vertex normals. That showed as dark speckles and holes where thin
  walls collapse into one bin.
- Grid clustering keyed by a normal class instead of connectivity: 11-17k non-manifold edges, and recon16m distances
  about 1.4-1.5 × those of the chosen pipeline.
- Detaching the triangles that oppose their neighbours (about 27 % of the output): they render as light flat shards.
- `ConsistencyOn` after the quadric: 9.7 % opposed (whole regions inside out).
- The quadric straight on a 1.19M-triangle noisy sphere (below an earlier 1.2M bound): 4.8-5.0 s, longer than the
  whole 16M path. Hence the 800k bound.
- Connected clustering alone as the fallback for the book: 0 triangles. Hence the normal-class routing for fans.
- Joining coincident vertices with `np.unique(positions, axis=0)`: 2.2 s on 8M vertices, and it joined the two
  layers of a double-sided sheet, which then cancelled. Hence the hash and the normal test.
- Routing fans on the highest vertex degree: the poles of ordinary UV spheres (degree 632 and 1,800) would go the
  fan path, while their `edge_work` is low.

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
