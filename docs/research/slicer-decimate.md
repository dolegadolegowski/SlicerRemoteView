# Decimation to the profile budgets (SLC-14, SLC-41, SLC-61)

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

## One node in bounded time (SLC-61)

> **Superseded.** This was `ws/slicer`'s rule (SLC-61, `e4573c3`). When `main` was merged into `ws/slicer` (2026-10-30)
> SLC-41's pipeline (*Very large meshes and the stall*, above) replaced it: it bounds every case measured here and the
> node's size, and keeps flat regions exactly flat without a jitter. The section stays for its measurements and source
> notes. The one part SLC-41 lacks — merging a soup's coincident points (with the guard that keeps sheets lying on each
> other apart) so that it is not decimated into holes — goes on as SLC-66; the figures that decided it are in *Merge
> comparison (2026-10-30)* at the end of this note.

Measured with the VTK 9.6.2 wheel of the dev venv (numpy 2.5.4) on the 4-core / 15 GB sandbox. Each run was its own
process, killed at 90 s and limited to 6 GB. Other jobs ran at the same time (load average 1–2), so times vary by about
±20 %. Source lines are from tag **v9.6.0**. The files cited (`vtkQuadricDecimation.{h,cxx}`, `vtkDecimatePro.{h,cxx}`,
`vtkPriorityQueue.cxx`, `vtkEdgeTable.cxx`, `vtkCellLinks.h`) are byte-identical at v9.6.2. `vtkPolyData.cxx` differs
only after L1611. Abbreviations used below:
Q = [`vtkQuadricDecimation.cxx`](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx),
DP = [`vtkDecimatePro.cxx`](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx),
PQ = [`vtkPriorityQueue.cxx`](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPriorityQueue.cxx),
PD = [`vtkPolyData.cxx`](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolyData.cxx).

### The rule

1. **Merge coincident points.** Run `vtkCleanPolyData` with its defaults: `PointMerging` 1, `Tolerance` 0.0
   ([vtkCleanPolyData.cxx#L48-L58](https://github.com/Kitware/VTK/blob/v9.6.2/Filters/Core/vtkCleanPolyData.cxx#L48-L58)).
   A zero tolerance makes it use `vtkMergePoints`, which merges exactly coincident points only
   ([#L715-L748](https://github.com/Kitware/VTK/blob/v9.6.2/Filters/Core/vtkCleanPolyData.cxx#L715-L748)). Keep only
   the triangles of its output. A triangle could only degenerate here if two of its corners already had the same
   position. Such a triangle has no area, and collect has already dropped those. The triangle count, and so the share,
   does not change. The implementation merges only when two points may coincide — a sort of one hashed 64-bit key per
   point (SplitMix64 over the coordinates' bits, -0.0 made 0.0), ≈ 0.006 s for 200k points; a collision merely runs
   the merge — since the merge cost ≈ 0.07 s and reordered the points of every 400k node (criterion 2, below). It
   also keeps the input as it is when merging would join sheets lying on each other — a duplicated shell, two sides
   or two touching segments with points of their own — that is, when the merged mesh has **more** edges of more than
   two triangles than the input (a count, not a yes/no: one repeated triangle anywhere, or a book next to the sheets,
   must not switch the guard off). The split copy of step 4 would turn such sheets into a soup (review: a duplicated
   sphere kept 0.38 of its area, a double-sided plane 0.25, two touching labels 0.78; with one repeated triangle or a
   3,000-page book in the same node 0.19–0.85; now 0.994–1.000). A **soup** is always merged: no point is used by two
   triangles once a triangle repeated on the same points is counted once (an STL read without merging, a facet
   written twice included — review: 0.38 of the area with 6,000 open edges for one such facet; now 0.998, 0 open).
2. **Centre and jitter.** Subtract the bounding-box centre. Then add `U(−1, 1) · 1e-7 · bounding-box diagonal` to every
   coordinate, using `numpy.random.default_rng(0)`. Every filter below gets this one input. Add the centre back to the
   result. (The research below chose 1e-6; the implementation uses 1e-7 — see *Amplitude* and *Criterion 2*. It also
   takes the box over the points the triangles use, refuses positions that are not finite, and seeds the generator with
   a BLAKE2b digest (8 bytes) of the points' sorted keys rather than 0, ≈ 1 ms for 200k points: the same mesh moves the
   same way, but a crafted one can neither subtract a fixed jitter in advance — review: a grid pre-shifted by
   `default_rng(0)`'s draws was back to the 5 s it took before SLC-61 — nor steer the seed: an XOR of the keys could be
   steered by one added point whose key was solved by inverting SplitMix64, and two coincident points cancelled in it.)
3. **Check for non-manifold edges.** Sort the undirected edge keys `min·n + max` of all triangle edges (built from the
   corner pairs with `np.minimum`/`np.maximum`, no per-row sort: SLC-63 review). The input is non-manifold if a key
   occurs three times or more (`key[i] == key[i + 2]`). This costs ≈ 0.03 s for 400k triangles.
4. **Try the attempts in order.** The first usable result wins. "Usable" is today's check: at least one triangle, at
   most the share, finite normals, positions within float32.
   - *Manifold input* (the order of ADR 0005 Decision 2 plus SLC-14's third filter, unchanged): `vtkQuadricDecimation`,
     then `vtkDecimatePro(PreserveTopologyOn)`, then `vtkDecimatePro` with its defaults.
   - *Non-manifold input*: first `vtkDecimatePro(PreserveTopologyOn)`. If its result is not usable, the manifold chain
     on the mesh as it is — when the quadric's set-up fits SLC-63's budget (`collect.walk_within_budget`: the same
     n(p)·n(q) loop; review: on a two-sided surface, four triangles on every edge, pro stops short and the split copy
     is a soup — a two-sided sphere kept 0.19 of its area; now 0.50, as before SLC-61). Last a **split copy**: every
     triangle corner at an end point of a non-manifold edge gets its own copy of that point (`collect.split_points`,
     SLC-63), made only when it is reached, through the manifold chain.
   - If no attempt is usable, the node is sent whole and reported, as today (§7.5, never dropped).

Until the merge, the ADR erratum release was asked to write was in report `2026-10-21-slicer-4` (section *The rule*,
removed in the merge: SLC-41's update there withdraws the erratum).

No filter options change. The code is about 200 lines in `decimate.py`, half of them docstrings: keys and merge with its
guard, jitter, check, split, and an attempts generator in place of the single `source`. The rule uses no timer, no tuned
threshold and no predictor of flatness.
The normals step after a filter (`collect.mesh_from_triangles`) was cubic on the result of a non-manifold input (the
one-row book's: 1,999 triangles on one edge, 3.3 s); SLC-63 bounds it.
The output is identical across runs: the same SHA-256 for the grid and the book in two runs each. Across numpy versions
it is not guaranteed to be identical (see the residual risks).

### Why the quadric is super-linear, and why the rule fixes it

**Exactly flat regions: tied zero costs.**

- On a plane, the 3×3 part of every quadric is rank-deficient. `ComputeCost` fails its determinant test and places the
  point on the edge or at its midpoint
  ([Q#L1010-L1045](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L1010-L1045)).
  That point lies in the plane, so the cost `xᵀQx` is exactly 0
  ([Q#L1052-L1064](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L1052-L1064)).
  It stays 0 after quadrics are merged.
- `vtkPriorityQueue` moves items only on strict `<` or `>`
  ([PQ#L39-L77](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPriorityQueue.cxx#L39-L77),
  [PQ#L89-L144](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPriorityQueue.cxx#L89-L144)). Equal keys
  therefore pop last-in, first-out.
- `UpdateEdgeData` re-inserts every edge around the kept point
  ([Q#L888-L967](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L888-L967)). The next
  collapses therefore hit the same point again, and its valence grows into a hub (6 → 445 within 6 % of the 180k
  plane).
- One collapse at valence *k* costs O(k²): `FindAffectedEdges`, `CollapseEdge` → `vtkPolyData::IsTriangle`, and linear
  `vtkEdgeTable::IsEdge` scans of edges that are never removed
  ([Q#L849-L885](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L849-L885),
  [Q#L1311-L1364](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L1311-L1364),
  [vtkEdgeTable.cxx#L195-L233](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkEdgeTable.cxx#L195-L233)).
  This explains both the minutes and the gigabytes.
- Whether and when a hub forms depends on the triangle order. The same 28.8k plane takes 0.16 s in `vtkPlaneSource`
  order and 4.5 s in the tests' `grid_entity` order. Shuffled, it takes 7.5–19.6 s.

The jitter makes every quadric full-rank. A merged star then costs more as its area grows, so the queue spreads the
collapses: the maximum valence stays at 10–14 and the run is linear again.

- **Amplitude.** The jitter must exceed the cost's rounding noise (about √ε · |coordinate| ≤ 0.75e-8 of the diagonal
  after centring: √ε ≈ 1.49e-8, |coordinate| at most half the diagonal). 1e-8 of the diagonal is not enough (segcyl
  7.5 s, valence 96). 1e-7 to 1e-5 all work. 1e-6 leaves a margin of about 100× in distance, 1e-7 about 13× (≈ 180× in
  the cost the quadric compares, which goes as its square). **The implementation uses 1e-7:** 1e-6 slowed the quadric on
  the smooth 400k sphere by 10–15 % (2.10 → 2.46 s, best of 3; the merge alone is neutral), which with the rule's other
  ≈ 0.15 s broke criterion 2 (1.26×). With 1e-7 every mesh of the table below stays linear (max valence 10–13 after
  decimation, times within ±10 % of 1e-6: plane 180k 0.79 s, grid 180k 0.89 s, segcyl 3.97 s, segbox 1.75 s, segcap
  4.25 s, 4-row book 1.02 s, sphere 2.93 s, its soup 3.08 s, the 100-duplicates sphere 2.52 s, cone 0.74 s).
- **Accuracy.** 1e-7 · diagonal is at most 0.011 of the GLB position step (`max extent / 65,534`, `glb_writer.py`
  `POSITION_STEPS`). At 1e-6 the measured added distance equalled the amplitude (mean 1–3e-7 and max ≤ 1.5e-6 of the
  diagonal) and the sphere's error was unchanged (mean 4.6e-6 vs 4.7e-6 of the diagonal).
- **Centring** keeps the margin independent of the model's distance from the origin. Without it, 1e-7 failed on a
  0.06 m model 0.5 m off the origin.
- **Order.** The merge must come before the jitter, or the coincident points would no longer coincide.

**Edges shared by many triangles: cubic set-up.**

- `AddBoundaryConstraints` calls `GetCellEdgeNeighbors` for every edge of every triangle
  ([Q#L721-L745](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L721-L745)). That
  call is a nested loop over the cells of both end points
  ([PD#L1220-L1245](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolyData.cxx#L1220-L1245)).
- An edge with *m* triangles therefore costs ≥ m³ before the first collapse. Jitter cannot change that.
- `vtkDecimatePro(PreserveTopologyOn)` stays fast here because `EvaluateVertex` returns `VTK_HIGH_DEGREE_VERTEX` without
  walking a point with ≥ `Degree` triangles (default 25,
  [DP#L72](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L72),
  [DP#L506-L508](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L506-L508)). Only
  `SplitVertex` walks such points, and it runs only when `Split = Splitting && !PreserveTopology`
  ([DP#L170](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L170),
  [DP#L1530](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L1530),
  [DP#L1641](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L1641)).
- `vtkDecimatePro` with its defaults does walk them, calling `GetCellEdgeNeighbors` per triangle
  ([DP#L1012-L1042](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L1012-L1042)). On the
  4-row book this took 52 s.
- So non-manifold input goes to `PreserveTopologyOn` first. That filter keeps the topology, so it can stop short: 12,000
  of 2,000 triangles on the 4-row book, where every page must keep the spine's points. The split copy removes the
  shared edges, and with them the hubs at their end points. After that, the quadric is fast (0.10–0.15 s).

**Why a time budget cannot bound one filter call in-process.**

- `CheckAbort` runs only every 10,000 collapses
  ([Q#L399-L407](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkQuadricDecimation.cxx#L399-L407)). On the
  180k plane the first check came at 20–48 s. The set-up (above) has no check at all.
- An aborted filter's output is discarded: `data->Initialize()`
  ([vtkDemandDrivenPipeline.cxx#L529-L541](https://github.com/Kitware/VTK/blob/v9.6.0/Common/ExecutionModel/vtkDemandDrivenPipeline.cxx#L529-L541)).

### Alternatives weighed

| Option | Verdict | Evidence |
|---|---|---|
| **Jitter** (chosen) | Removes every tie case. No predictor needed. Quality and the sphere's time are kept | 180k planes > 90 s → 0.9–1.0 s; segcyl > 90 → 3.8 s; segbox 81 → 2.0 s; sphere median ratio 1.05 |
| Predictor → `vtkDecimatePro` first for "flat" input | Rejected: the coplanar share does not separate slow from fast, and pro's error is 2.6–3.7× the quadric's on smooth parts | Share 0.30 → 7.7 s, 0.54 → > 90 s, 0.97 → 81 s, 1.0 → 0.16 s to > 90 s (order-dependent) |
| `vtkFeatureEdges` (non-manifold) | Rejected: slow on the very input it must catch | 10.3 s on the book. The numpy key sort gives the same answer in 0.2 ms |
| Quadric on a 5 % sample under a time limit | Rejected: predicts nothing. Hubs form late on a large tied region, and the probe pays the full set-up | Every probe ≤ 0.32 s; segbox blows up between 45 % and 50 % reduction |
| Time budget / `AbortExecute` | Rejected: no check during set-up, a check only every 10,000 collapses, and an aborted output is discarded | See above |
| `RegularizeOn` | Rejected: moves the geometry; the regularisation term is not unit-free | segcap max distance 8.7e-4 to 1.5e-3 of the diagonal, 6 boundary edges (holes); sphere max error ×4–4.6 |
| Shuffled input order | Rejected | segcap 7.7 → 27 s; segcyl still > 90 s |
| Split every non-manifold input, no pro first | Rejected: cuts mostly-good meshes | Sphere with 100 duplicated triangles: 3,166 crack edges after decimation; pro first gives 0 |

### Measured

The *today* column is the current first filter (`vtkQuadricDecimation` on the unmerged input). The *rule* column is one
run of the whole rule (merge, check, jitter, attempts). **> 90** means the run was killed.

| Mesh (glTF metres) | Triangles → share | Today (s) | Rule (s) | Result from | Out triangles | Boundary edges in → out | Area out/in |
|---|---|---|---|---|---|---|---|
| Flat 0.1 m plane, `vtkPlaneSource` 300 × 300 | 180,000 → 100,000 | **> 90** (review: 57) | 0.95 | quadric | 100,000 | 1,200 → 946 | 1.000 |
| Same, `grid_entity` order (301 × 301) | 180,000 → 100,000 | **> 90** | 0.96 | quadric | 100,000 | 1,200 → 918 | 1.000 |
| Flat plane, `vtkPlaneSource` 120 × 120 | 28,800 → 2,000 | 0.16 | 0.25 | quadric | 2,000 | 480 → 104 | 1.000 |
| Same, `grid_entity(121, 121)` | 28,800 → 2,000 | 4.50 | 0.29 | quadric | 2,000 | 480 → 104 | 1.000 |
| Unsmoothed labelmap surface, cylinder r 110 / h 160 voxels, 1 mm, two flat caps (`vtkDiscreteFlyingEdges3D`): the review's 427k case | 434,800 → 100,000 | **> 90** (review: 437) | 3.79 | quadric | 100,000 | 0 → 0 | 1.000 |
| Same, `vtkDiscreteMarchingCubes` | 434,800 → 100,000 | **> 90** | 4.00 | quadric | 100,000 | 0 → 0 | 1.000 |
| Labelmap box 150³ | 269,996 → 100,000 | 80.9 | 1.96 | quadric | 100,000 | 0 → 0 | 1.000 |
| Truncated labelmap ball, flat caps | 464,904 → 100,000 | 7.70 | 4.62 | quadric | 100,000 | 0 → 0 | 1.000 |
| Same, windowed-sinc smoothed (≈ Slicer's 0.5, `[TODO verify]`) | 464,904 → 100,000 | 4.42 | 4.90 | quadric | 100,000 | 0 → 0 | 1.000 |
| Book: 3,000 pages × 1 quad on one spine edge | 6,000 → 2,000 | 18.2 (review's book: 73) | 0.15 | pro | 1,999 | 9,000 → 3,998 | 0.333 |
| Book: 3,000 pages × 4 quads on a 4-edge spine | 24,000 → 2,000 | **> 90** | 0.94 | pro short (12,000), then split → quadric | 2,000 | 18,000 → 6,000 | 0.090 |
| `vtkSphereSource` 632 × 318, r 0.05 m | 399,424 → 100,000 | 3.27 | 3.19 | quadric | 100,000 | 0 → 0 | 1.000 |
| Same as a triangle soup (no shared point) | 399,424 → 100,000 | 2.69 (**300,000 boundary edges, area 0.38**) | 3.05 | quadric | 100,000 | 1,198,272 → 0 | 1.000 |
| Same sphere, 100 triangles duplicated (300 non-manifold edges) | 399,524 → 100,000 | 2.74 | 2.86 | pro | 100,000 | 0 → 0 | 1.000 |
| Cone, 2 hubs of 6,000 triangles (manifold) | 12,000 → 2,000 | 0.89 | 0.70 | quadric | 2,000 | 0 → 0 | 1.000 |

The overhead on a 400k node was 0.1–0.24 s for the merge, 0.06–0.19 s for the check and 0.03–0.05 s for the jitter
(the research scripts; in the implementation the check is ≈ 0.03 s, the key sort ≈ 0.006 s and the merge runs only for
coincident points).

**The implementation** (`decimate_entity`, jitter 1e-7, on the node as `collect` gives it; the meshes built in
`tests/test_decimate.py` and `tests/support.py`; one run each, collect / decimate):

| Mesh | Triangles → share | Collect (s) | Decimate (s) | Filters run | Boundary edges in → out | Area out/in |
|---|---|---|---|---|---|---|
| Flat plane, `vtkPlaneSource` 300 × 300 | 180,000 → 100,000 | 0.23 | 0.85 | quadric | 1,200 → 932 | 1.000 |
| Same, `grid_entity` order | 180,000 → 100,000 | 0.10 | 1.01 | quadric | 1,200 → 948 | 1.000 |
| Flat plane, `vtkPlaneSource` 120 × 120 | 28,800 → 2,000 | 0.02 | 0.19 | quadric | 480 → 82 | 1.000 |
| Same, `grid_entity(121, 121)` | 28,800 → 2,000 | 0.02 | 0.16 | quadric | 480 → 85 | 1.000 |
| Labelmap cylinder r 110 / h 160 (flying edges) | 434,800 → 100,000 | 0.50 | 3.58 | quadric | 0 → 0 | 1.000 |
| Book, 3,000 pages × 1 row | 6,000 → 2,000 | 0.04 (11 s before SLC-63) | 0.08 | pro | 9,000 → 3,998 | 0.333 |
| Book, 3,000 pages × 4 rows | 24,000 → 2,000 | 0.15 (minutes before SLC-63) | 1.07 | pro (12,000), quadric on the split copy | 18,000 → 6,000 | 0.084 |
| Sphere, `support.sphere(448)` | 399,616 → 100,000 | 0.22 | 2.58 | quadric | 0 → 0 | 1.000 |
| Same as a triangle soup | 399,616 → 100,000 | 1.10 | 2.64 | quadric | 0 → 0 (merged) | 1.000 |
| Same sphere, 100 triangles duplicated | 399,716 → 100,000 | 0.22 | 1.87 | pro | 0 → 0 | 1.000 |
| `support.sphere(200)` two-sided (each triangle twice, reversed) | 158,400 → 10,000 | — | 0.48 | pro, quadric on the mesh as it is | — | 0.500 |
| Same, the second side on points of its own | 158,400 → 10,000 | — | 1.10 | quadric (not merged) | — | 1.000 |
| Same, a duplicated shell on points of its own | 158,400 → 10,000 | — | 0.97 | quadric (not merged) | — | 1.000 |

**Notes on the books.** No filter can fit 3,000 pages into 2,000 triangles: the best is a third of the area, which pro
reaches on the 1-row book. The split copy of the 4-row book keeps 9 % of the area, as separate triangles. This is the
price of a bounded time on broken input. The gate to the whole-mesh chain is SLC-63's walk budget (≈ 0.5 s of set-up),
which is conservative for the quadric: over it a book keeps about 20 % of its area where the quadric alone kept 80–100 %
before SLC-61, in under 10 s (review round 3; area now vs before, and the time before to the share: 400 pages × 4 rows,
1.75× the budget, 0.20 vs 0.80 in 0.87 s; 300 × 8, 1.72×, 0.21 vs 1.0 in 0.78 s; 180 × 40, 2.09×, 0.22 vs 1.0 in 3.5 s;
1,000 × 4, 27×, 0.20 vs 0.80 in 9.6 s); under it the whole-mesh chain keeps the area it had before. SLC-64's criterion 4
held such books to that area (dropped in the merge; → SLC-69).

**Criterion 2 (sphere).** Eight interleaved pairs were run with a jitter of 1e-6: today's quadric against the whole
rule.

| | Mean (s) | Median (s) |
|---|---|---|
| Today's quadric | 3.05 | 3.18 |
| Whole rule | 3.40 | 3.33 |
| Ratio | 1.11 | 1.05 |

Per-pair ratios were 1.01–1.28. In the implementation (collected sphere, `mesh_from_triangles` after both) the rule
with 1e-6 came out at 1.26× (medians of 3), so the jitter went to 1e-7: six interleaved pairs 2.08–2.45 s before,
2.31–2.65 s after, median ratio 1.15, single pairs 1.06–1.25. Inside the full suite the best of five was still ≈ 1.22
in three runs, so the merge now runs only when points coincide (rule step 1). The test compares the **best of seven**
interleaved runs each (the estimate least moved by other load; ≈ 35 s, marked `slow`; the garbage collector off as in
`timeit`) and asserts that the quadric made the result: ≈ 1.06 idle, 1.02–1.18 in the reviews' runs under load
(1.04–1.08 in six runs in round 2), single pairs 1.0–1.25; every full run since has passed.

### Residual risks and `[TODO verify]`

- **Node size (→ SLC-65, dropped in the merge: SLC-41 bounds it).** The quadric is not linear in the input on this
  sandbox:

  | Sphere, input → 100k | Time |
  |---|---|
  | 400k | 3–4 s |
  | 800k | 8.8 s |
  | 1.6M | 22.5 s with the rule, 19.8 s today |

  `vtkDecimatePro(PreserveTopologyOn)` takes 14.8 s on the 1.6M sphere. A node of about 1M input triangles or more
  therefore exceeds 10 s whichever filter runs (0.8M: 6.6–8.8 s; review, the implementation: 1.6M 16.4 s, 2M 25.3 s).
  The rule bounds the pathological cases, not size; large CT surfaces of 1–3M triangles are ordinary input. SLC-65 owned
  it (a cheap pre-pass to a few times the share, an input cap, or decimation off the main thread); SLC-41's size bound
  does it now. Whether Slicer's VTK wrapping releases the GIL during `Update()` is `[TODO verify]`.
- **Points used by very many triangles (→ SLC-64, dropped in the merge: SLC-41's fan routing).** Every filter is
  super-linear around one: `AddBoundaryConstraints` asks `GetCellEdgeNeighbors` (n(p)·n(q) checks, SLC-63) for every
  edge, and each collapse at a point of *k* triangles scans them. Measured with the rule (collected, then decimated to a
  fifth): a manifold fan around one point of 10k / 20k / 40k triangles 1.35 / 3.9 / 15.2 s (≈ d²), a cone with two such
  points of 12,500 3.2 s, triangles sharing only one point (a bow-tie) 1k / 2k / 4k 0.09 / 0.41 / 2.75 s (≈ d³;
  20k > 120 s). `vtkDecimatePro` is no better here (cone hubs of 25,000: pro stops at 45,852, pro defaults 7.4 s; on a
  shared edge pro grows about as m², read from
  [DP#L580](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L580) and
  [DP#L667](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L667)). Bounding it trades
  quality (cutting such points before decimating leaves the fan's triangles unconnected, so decimation deletes them)
  against reduction (keeping the node whole and reporting it); that choice was SLC-64's (dropped: SLC-41 routes such
  fans to clustering; SLC-69 weighs what that costs). The same holds for `vtkDecimatePro(PreserveTopologyOn)` on a
  shared edge of many triangles (a book of 10k / 20k / 40k / 100k pages on one edge: 0.74 / 3.0 / 12.3 / 77 s, ≈ m²;
  review) and for points the merge creates: a soup whose triangles share one corner merges into a bow-tie (2k / 4k / 8k
  triangles: 0.36 / 2.2 / 17 s, against 0.01–0.04 s before SLC-61, which decimated each loose triangle alone and left
  holes). SLC-64's prediction had to run on the merged mesh. SLC-62's polygon cap removes the most common source, a big
  polygon triangulated as a fan (whether `vtkTriangleFilter` fans a convex polygon is `[TODO verify]` there).
- **A far-off triangle stretches the box (→ SLC-65, dropped in the merge: SLC-41 has no jitter).** The jitter scales
  with the diagonal of the node's whole bounding box, so one triangle far from a dense part makes the jitter larger than
  that part's edges and crumples it, and the quadric is super-linear on the crumpled part (review round 3 and its delta
  check: a 400k sphere of 0.28 mm edges with one used triangle in the same node — 1 km 3.0–3.9 s; 10 km 6.2 s, or
  22–31 s with another far triangle; 30 km 12 s; 100 km 3.3–14.9 s; 1,000 km > 150 s; before SLC-61 2.2–2.7 s). The time
  depends on the far triangle and does not rise steadily with the distance; the worst seen below 1,000 km is ≈ 30 s at
  10 km. It takes crafted or corrupt input (collect accepts it: finite float32 metres, non-zero area). Mitigations for
  SLC-65: cap the amplitude by a fraction of the median edge length (the GLB's position step, extent / 65,534, erases
  such a part anyway), or centre and jitter each connected component on its own box.
- **A soup mixed with other parts.** The soup exception is decided for the whole node: in a node that is not all soup, a
  merge that adds edges of more than two triangles is refused for the soup part as well, which then keeps its holes, as
  before SLC-61 (review round 3: a soup sphere with a facet written twice next to a connected sphere, area 0.645, the
  same as before). Merging per point class — always for points used only by soup triangles — would close it; criterion
  3's input, a pure soup, is merged.
- **Quality on non-manifold input.** Pro's error is 2.6× the quadric's (mean) on smooth surfaces, still below the GLB
  step. The split copy opens cracks along the cut corners.
- **Positions move slightly.** The jitter moves surviving points by ≤ 1e-7 · diagonal per coordinate, so flat faces are
  no longer exactly flat. The normal tilt is about jitter / edge length — small, except on sliver triangles, which can
  take an arbitrary normal (review: 26 of 50k points more than 1° off, at most 61°, on the 180k plane → 100k; 3 on the
  labelmap cylinder's caps; the code before SLC-61 makes such slivers too on a tilted plane, up to 5.8°). Tests compare
  positions with a tolerance, not exactly.
- **Determinism.** The output is deterministic per numpy build (the seed comes from the mesh). numpy guarantees a
  `Generator` stream only on the same build and environment, and may change it in feature releases
  ([compatibility.rst#L15-L22, #L46-L50, numpy v2.5.4](https://github.com/numpy/numpy/blob/v2.5.4/doc/source/reference/random/compatibility.rst#L15-L22)).
  Tests must check properties (count ≤ share, bounds, holes), not coordinates — and not single draws: the soup test's
  strict normals check failed for another seed (SLC-61 review round 3). Slicer 5.12.4 ships numpy 2.4.6 and the dev
  venv 2.5.4 (`slicer-collect.md`), so Slicer's draws may differ from the tests' (`[TODO verify]` in Slicer: the rule's
  properties, not its coordinates, are what §14.2 checks).
- **Slicer's VTK versus the wheel.**
  - The sources are the same. Slicer 5.12.4 pins `Slicer/VTK@c9cd17a` (`slicer-v9.6.2-2026-05-15-f49a1dbaf`,
    [External_VTK.cmake#L174](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_VTK.cmake#L174)).
  - `git diff --name-only v9.6.2 c9cd17a` lists 13 files: 3 in `CMake/`, 9 in `Rendering/OpenXR/`, and
    `Wrapping/PythonCore/vtkPythonUtil.cxx`. None is in `Filters/Core`, `Common/Core` or `Common/DataModel`
    ([compare](https://github.com/Slicer/VTK/compare/v9.6.2...c9cd17a377cbc7e488329e882a35b70c7f37fe76)).
  - Times in Slicer's own build (compiler and flags) are `[TODO verify]`. This is a manual step in
    `docs/testing/slicer.md`: decimate the cylinder labelmap surface and the 400k sphere in Slicer's Python console.
- **Not the review's meshes.** The review's 427k surface and 3,000-page book were not available. The table uses
  equivalents, both slow today, so the tests should build these meshes themselves. The smoothed surface only
  approximates Slicer's closed-surface smoothing 0.5 (`[TODO verify]`).

## Merge comparison (2026-10-30)

When `main` (`d70c5be`, SLC-41) was merged into `ws/slicer` (`e4573c3`, SLC-61), both branches decimated the same
meshes in the sandbox (VTK 9.6.2 wheel, 4 CPUs, load 0.4–2.8 from other agents: single times ±20 %). Each mesh was
collected on its own branch and decimated by that branch's per-node entry point — `decimate.fit_entity_steps(entity,
None, target)` stepped by hand on `main` (its longest step timed), `decimate.fit_entity(entity, target)` on `ws/slicer`
(one step). Times are the decimation only; "worst distance" is the largest input-to-output distance as a fraction of the
diagonal.

| Mesh → share | `main` (SLC-41) | `ws/slicer` (SLC-61) |
|---|---|---|
| Flat plane 180k → 100k | 0.69–0.81 s, area 1.0, exactly flat | 0.78–0.86 s, area 1.0, flat within 3.6e-8 m |
| `grid_entity` order 180k → 100k | 0.66 s | 0.98 s |
| Grid 28.8k → 2k | 0.15–0.16 s | 0.15–0.19 s |
| Labelmap cylinder 435k → 100k | 2.5–2.9 s, worst distance 1.7e-5 | 3.4–3.6 s, 2e-7; 2 open edges |
| Book 3,000 × 1 → 2k | 0.11 s, 544 triangles, area 0.091, worst distance 0.0035 | 0.07 s, 1,999, area 0.333, worst distance 0.31 (two thirds of the pages dropped) |
| Book 3,000 × 4 → 2k | 0.25–0.33 s, 1,856, area 0.077, worst distance 0.0039 | 1.0–1.1 s, 2,000, area 0.088, worst distance 0.26 |
| `main`'s book 300 × 4 → 2k | 0.13 s, area 0.51, worst distance 0.017 | 0.22 s, area 1.0 (2.6 % of normals opposed) |
| `main`'s book 400 × 16 → 2k | 0.47–0.58 s, area 0.10, worst distance 0.042 | 4.9–5.0 s, area 0.92, worst distance 0.020 |
| `main`'s book 400 × 16 → 100k | 4.7–5.0 s, area 0.97 | 1.4–1.5 s, area 1.0 (2.0 % opposed) |
| Smooth sphere 400k → 100k | 2.5 s (best ratio to SLC-14's quadric alone 1.03, median 1.17) | 2.4–2.7 s (1.20, 1.13) |
| Sphere 1.6M → 100k | 6.3–6.6 s: clustering to 571k 1.3 s, then the quadric 4.6 s (longest step 5.1–5.2 s) | 15.7–17.6 s in one quadric run |
| Soup of `sphere(64)` → 2k | 0.06 s, area 0.38, 207 open edges | 0.04 s, area 0.9995, 0 open edges |
| Seamed sphere 79k → 2k / 7.9k → 2k | 750 / 176 open edges (below the size bound) | 0 / 0 |
| Two-sided sphere, shared points / own points, duplicated shell | area 0.50 / 0.9987 / 0.9987 | the same |
| Two touching ball-half labels → 1/5 | area 1.0, 0.15 s | area 1.0, 0.09 s |
| Fan of 20k triangles around one point → 4,000 | 0.07–0.08 s, 387 triangles, area 0.9994 | 3.4–3.9 s, 4,000, exact |
| Coplanar fan of 4k / 20k sharing only the centre | 0.06 / 0.11 s, area 1.0 | 0.08 / 1.6 s, area 0.20 |
| `sphere(448)` with one triangle 10 km away in the node | the far triangle's part dropped (its share rounds to 0) | the sphere crumpled: area × 8.1, 603 open edges |

`main` undershoots the share on its fan path (544 of 2,000, 387 of 4,000, 598 of 800, 1,856 of 2,000 triangles).
ws/slicer's SLC-61 tests run against `main`'s `decimate.py`: 14 pass (the planes, the grids, the labelmap, the 4-row
book, the sheets, touching segments), 5 fail on behaviour (the 3,000 × 1 book's area 0.09 against 0.3; the three soup
cases with 207–208 open edges; the two-sided soup 0.19 against 0.45).

What decided it: SLC-41 keeps every measured case under 10 s per node and bounds the size; SLC-61 did not (1.6M: one
step of 16–18 s), and its jitter crumples a dense part when one triangle far away shares the node. Flat regions need no
jitter on SLC-41 (its `RegularizeOn` on scaled coordinates bounds them and keeps them exactly flat). What SLC-41 lacks:
the merge of a soup's or a seam's coincident points below the size bound → SLC-66. What SLC-61 kept and SLC-41 trades
away: the area of moderate non-manifold books (`vtkDecimatePro(PreserveTopologyOn)` first: 300 × 4 exact against 0.51,
400 × 16 0.92 against 0.10, at up to 10× the time) and the full share on fans → SLC-69. The harness and raw numbers were
in the session's scratchpad (`cmp_decimate/bench.py`), not kept.

