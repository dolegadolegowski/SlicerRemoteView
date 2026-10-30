# Decimation to the profile budgets (SLC-14, SLC-61)

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
`collect.mesh_from_triangles` (the normals filter of SLC-07; triangles without area and unused points dropped) — a zero
normal is repaired to +Y with `coords.unit_normals`, as for a collected node — and positions within float32. Indices out
of range or repeating a vertex are refused before any filter (VTK does not check them; a `vtkDecimatePro` crash on the
latter was reported in review but not reproduced with VTK 9.6.2 — `[TODO verify]` with the input that crashed). The
guaranteed reduction of the third filter was measured not to hold for duplicated or non-manifold triangles; such a node
is sent whole and reported. The input is the collected entity (glTF metres: RAS → glTF is a rotation and a uniform
scale, so the quadric error and the winding are unchanged) — since SLC-61 merged, centred and jittered: see *One node in
bounded time*.

## Measured (dev venv, this container)

| Input | Target | `vtkQuadricDecimation` | `vtkDecimatePro` (topology kept) |
|---|---|---|---|
| `vtkSphereSource` 632 × 318 (399,424 triangles; the criterion-1 test uses 448 × 448: 399,616) | 100,000 | 100,000 in 3.3 s | 100,000 in 2.6 s |
| same | 2,000 | 2,000 in 4.7 s | 2,000 in 3.4 s |

A 400k-triangle node therefore blocks Slicer's main thread for a few seconds — up to ≈ 8 s when all three filters run
(since SLC-61 a non-manifold node can take up to six filter runs: pro, the chain's other two on the mesh as it is, then
the three on the split copy). **Worst case (measured by the SLC-14 review, VTK 9.6.2 wheel):** the quadric is
super-linear on dense, exactly flat regions (tied zero-error collapses): a flat 0.1 m plane of 180k triangles takes 57 s
to reach 100k and 237 s / 2.3 GB to reach 2k; an unsmoothed segmentation-like surface of 427k triangles with flat caps
takes 437 s / 3 GB to reach 100k (`vtkDecimatePro(PreserveTopologyOn)`: ≈ 3 s; the same surface smoothed by Slicer's
default 0.5: ≈ 8 s). A progress observer's `AbortExecuteOn` stops the quadric only after ≈ 16 s (7 progress events).
SLC-61 (below) bounds one node's time on these shapes, and SLC-28 moves the preparation to one node per `QTimer` tick
with a progress dialog (FR-10). Whole-snapshot test (`test_decimate_quest2_scene_fits_500k_…`): about 5 s for 564k input
triangles.

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

The ADR erratum release is asked to write is in report `2026-10-21-slicer-4` (section *The rule*).

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
holds such books to that area (e.g. a budget of the decimation's own).

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

- **Node size (→ SLC-65).** The quadric is not linear in the input on this sandbox:

  | Sphere, input → 100k | Time |
  |---|---|
  | 400k | 3–4 s |
  | 800k | 8.8 s |
  | 1.6M | 22.5 s with the rule, 19.8 s today |

  `vtkDecimatePro(PreserveTopologyOn)` takes 14.8 s on the 1.6M sphere. A node of about 1M input triangles or more
  therefore exceeds 10 s whichever filter runs (0.8M: 6.6–8.8 s; review, the implementation: 1.6M 16.4 s, 2M 25.3 s).
  The rule bounds the pathological cases, not size; large CT surfaces of 1–3M triangles are ordinary input. SLC-65 owns
  it: a cheap pre-pass to a few times the share, an input cap, or decimation off the main thread. Whether Slicer's VTK
  wrapping releases the GIL during `Update()` is `[TODO verify]`.
- **Points used by very many triangles (→ SLC-64).** Every filter is super-linear around one: `AddBoundaryConstraints`
  asks `GetCellEdgeNeighbors` (n(p)·n(q) checks, SLC-63) for every edge, and each collapse at a point of *k* triangles
  scans them. Measured with the rule (collected, then decimated to a fifth): a manifold fan around one point of 10k /
  20k / 40k triangles 1.35 / 3.9 / 15.2 s (≈ d²), a cone with two such points of 12,500 3.2 s, triangles sharing only
  one point (a bow-tie) 1k / 2k / 4k 0.09 / 0.41 / 2.75 s (≈ d³; 20k > 120 s). `vtkDecimatePro` is no better here (cone
  hubs of 25,000: pro stops at 45,852, pro defaults 7.4 s; on a shared edge pro grows about as m², read from
  [DP#L580](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L580) and
  [DP#L667](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkDecimatePro.cxx#L667)). Bounding it trades
  quality (cutting such points before decimating leaves the fan's triangles unconnected, so decimation deletes them)
  against reduction (keeping the node whole and reporting it); that choice is SLC-64's. The same holds for
  `vtkDecimatePro(PreserveTopologyOn)` on a shared edge of many triangles (a book of 10k / 20k / 40k / 100k pages on
  one edge: 0.74 / 3.0 / 12.3 / 77 s, ≈ m²; review) and for points the merge creates: a soup whose triangles share one
  corner merges into a bow-tie (2k / 4k / 8k triangles: 0.36 / 2.2 / 17 s, against 0.01–0.04 s before SLC-61, which
  decimated each loose triangle alone and left holes). SLC-64's prediction must run on the merged mesh. SLC-62's
  polygon cap removes
  the most common source, a big polygon triangulated as a fan (whether `vtkTriangleFilter` fans a convex polygon is
  `[TODO verify]` there).
- **A far-off triangle stretches the box (→ SLC-65).** The jitter scales with the diagonal of the node's whole bounding
  box, so one triangle far from a dense part makes the jitter larger than that part's edges and crumples it, and the
  quadric is super-linear on the crumpled part (review round 3 and its delta check: a 400k sphere of 0.28 mm edges with
  one used triangle in the same node — 1 km 3.0–3.9 s; 10 km 6.2 s, or 22–31 s with another far triangle; 30 km 12 s;
  100 km 3.3–14.9 s; 1,000 km > 150 s; before SLC-61 2.2–2.7 s). The time depends on the far triangle and does not rise
  steadily with the distance; the worst seen below 1,000 km is ≈ 30 s at 10 km. It takes crafted or corrupt input
  (collect accepts it: finite float32 metres, non-zero area). Mitigations for SLC-65: cap the amplitude by a fraction of
  the median edge length (the GLB's position step, extent / 65,534, erases such a part anyway), or centre and jitter
  each connected component on its own box.
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
