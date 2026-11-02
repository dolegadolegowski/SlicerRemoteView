# Research — MRML collection and the VTK mesh pipeline (SLC-07, SLC-22, SLC-52, SLC-63)

Verified for `remoteview_core/collect.py` (SLC-07) and the Slicer `scene_api` adapter that SLC-22 writes in
`RemoteView.py`. Sources are pinned to **3D Slicer v5.12.4** (commit `4e21c19d`) and **VTK v9.6.2**; "run" means
checked with the `vtk==9.6.2` wheel in `slicer-plugin/.venv` (the same VTK version Slicer 5.12.4 builds). Nothing here
was run inside a Slicer binary (CLAUDE.md rule 10) — the manual check is `docs/testing/slicer.md` §1.

## 1. Python environment inside Slicer 5.12.4

| Fact | Source |
|---|---|
| Slicer 5.12.4 builds VTK **9.6.2** from its fork `slicer/VTK@c9cd17a` (`slicer-v9.6.2-2026-05-15`) with `VTK_WRAP_PYTHON=ON`, `VTK_ENABLE_KITS=ON`, `VTK_LEGACY_REMOVE=ON` | [External_VTK.cmake](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_VTK.cmake), [CMakeLists.txt#L447-L461](https://github.com/Slicer/Slicer/blob/v5.12.4/CMakeLists.txt#L447-L461) |
| The `vtkmodules` package (one extension module per VTK module, `vtkmodules/util/numpy_support.py`) is installed; the umbrella `vtk.py` is only `from vtkmodules.<Module> import *` lines, so `import vtk` working implies `vtkmodules` works | [vtk.py.in](https://github.com/Kitware/VTK/blob/v9.6.2/Wrapping/Python/vtk.py.in), [vtkModuleWrapPython.cmake](https://github.com/Kitware/VTK/blob/v9.6.2/CMake/vtkModuleWrapPython.cmake), [SlicerBlockInstallExternalPythonModules.cmake](https://github.com/Slicer/Slicer/blob/v5.12.4/CMake/SlicerBlockInstallExternalPythonModules.cmake) |
| Slicer imports `vtk` (and numpy) at startup, so `vtkmodules.*` imports from the core cost a `sys.modules` lookup | [slicerqt.py](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicerqt.py), [slicer/\_\_init\_\_.py](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/__init__.py) |
| Slicer ships Python 3.12.10 and **numpy 2.4.6**; the dev venv pins numpy 2.5.4 (one minor ahead) | [External_python-numpy.cmake](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_python-numpy.cmake) |
| `vtk.util.numpy_support` and `vtkmodules.util.numpy_support` load the same file as two module objects — use one spelling (`vtkmodules`) | run |
| `numpy_support.vtk_to_numpy` returns a **writable view** into VTK memory (`np.frombuffer`) and assigns `.shape` in place, which numpy 2.5 deprecates (`DeprecationWarning`); `collect._owned` uses the same buffer access with `reshape` and copies at once | [numpy_support.py#L204-L252](https://github.com/Kitware/VTK/blob/v9.6.2/Wrapping/Python/vtkmodules/util/numpy_support.py#L204-L252), run |
| A `char*` getter whose value is not valid UTF-8 returns `bytes` in Python (e.g. `vtkMRMLNode::GetName()` for a name read from a legacy cp1250 file); `None` when unset | run (`vtkFloatArray().SetName(b"P\xb3uco")`), [vtkMRMLNode.h#L474-L480](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLNode.h#L474-L480) |

## 2. VTK filters used by `collect.mesh_from_polydata` (VTK 9.6.2)

The links below point at the `v9.6.0` tag; `vtkTriangleFilter.cxx`, `vtkPolyDataNormals.cxx`, `vtkOrientPolyData.cxx`,
`vtkPolygon.cxx`, `vtkCellArray.h`, `vtkStaticCellLinksTemplate.txx` and `numpy_support.py` are byte-identical in
v9.6.2 and in Slicer's fork `slicer/VTK@c9cd17a` (compared); `vtkPolyData.cxx` differs only after its line 1611.

| Fact | Source |
|---|---|
| `vtkTriangleFilter` defaults `PassVerts=1`, `PassLines=1`; triangulates quads, polygons and strips (strips keep alternating winding) | [vtkTriangleFilter.h#L79-L85](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkTriangleFilter.h#L79-L85), run |
| All-triangle **fast path** (`GetMaxCellSize() == 3`): polys are shallow-copied untriangulated, so 1- and 2-point "polygons" pass through, and the input **lines are passed even with `PassLinesOff`** | [vtkTriangleFilter.cxx#L191-L212](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkTriangleFilter.cxx#L191-L212), run |
| Neither filter drops unused points; outputs share the input's `vtkPoints` and point-data arrays | [vtkTriangleFilter.cxx#L316-L317](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkTriangleFilter.cxx#L316-L317), run |
| `vtkPolyDataNormals` with `SplittingOff` keeps the point count; normals are float32, unit length (max error 1.3e-7), the unweighted mean of adjacent cell normals | [vtkPolyDataNormals.cxx#L152-L182](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L152-L182), run |
| Unused points and points of zero-area triangles get exactly `(0, 0, 0)`; vertex and line cells contribute the normal `(1, 0, 0)` | [vtkPolyDataNormals.cxx#L89-L101](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L89-L101), [vtkPolygon.cxx#L198-L218](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolygon.cxx#L198-L218), run |
| Existing float `Normals` are **returned unchanged** (not recomputed), even when `ConsistencyOn` reversed cells | [vtkPolyDataNormals.cxx#L137-L143](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L137-L143), run |
| `ConsistencyOn` reverses cells that disagree with the lowest-id cell of each component; a consistent closed sphere is unchanged; not necessarily outward (that is `AutoOrientNormals`) | [vtkOrientPolyData.cxx](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx), run |
| A triangle that repeats a vertex, `(a, b, b)`, runs its edge `a–b` both ways: on an edge of the mesh it makes `ConsistencyOn` reverse the triangles reached through it (420 of 448 sphere triangles and their normals in the run; `(a, a, b)` happened not to). Stitched triangle strips decompose into such triangles | [vtkOrientPolyData.cxx](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx), run |
| `ConsistencyOn` is a `vtkOrientPolyData` (consistency on, `NonManifoldTraversal` on — the normals filter's default — no auto-orientation) run on a `vtkTriangleFilter` output before the normals are computed | [vtkPolyDataNormals.cxx#L33-L44](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L33-L44), [#L236-L254](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L236-L254) |
| The walk reads the cells and their links only (not the coordinates), reverses cells in place and keeps their order; it seeds each connected part with its lowest-ID unvisited cell | [vtkOrientPolyData.cxx#L152-L176](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx#L152-L176), [#L382-L403](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx#L382-L403) |
| **Cost (SLC-63):** the walk calls `GetCellEdgeNeighbors` for every edge (p, q) of every cell it reaches, and that call loops over the cells of p and, for each, over the cells of q: n(p)·n(q) checks. An edge shared by *m* triangles costs ≈ m³ — a book of pages fanned around one spine edge: 1,000 / 2,000 / 3,000 pages 0.4 / 3.2 / 11 s; 1,000 / 1,500 pages × 4 rows on a 4-edge spine 8.8 / 29 s — and a point used by *d* triangles ≈ d², with no shared edge: a fan of 10k / 20k / 40k / 80k triangles around one point 0.21 / 0.80 / 3.8 / 12.8 s, 20k / 40k / 100k triangles sharing only one point 0.46 / 1.7 / 11.2 s (SLC-63 review). With `ConsistencyOff` each ≤ 5 ms | [vtkOrientPolyData.cxx#L67-L113](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx#L67-L113), [vtkPolyData.cxx#L1217-L1270](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolyData.cxx#L1217-L1270), run |
| With `NonManifoldTraversal` on (the normals filter's default; `vtkOrientPolyData`'s own default is off), every neighbour across a shared edge is turned to run that edge the other way from the triangle that reached it: of a book whose pages are all wound the same way, every page but the first comes out reversed; a sphere split by an equatorial disc, its southern half reversed, is made consistent across the disc. Off, the walk does not cross an edge with more than one neighbour | [vtkOrientPolyData.cxx#L84-L111](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkOrientPolyData.cxx#L84-L111), run (10 pages) |
| No polys → no `Normals` array; empty polydata → `GetPoints()` is `None` | [vtkPolyDataNormals.cxx#L198-L216](https://github.com/Kitware/VTK/blob/v9.6.0/Filters/Core/vtkPolyDataNormals.cxx#L198-L216), run |
| The filters never modify their input (MTimes, arrays, cells unchanged); `DeepCopy` shares no memory | run |
| Deterministic across runs and processes (Sequential and STDThread SMP backends; TBB — which Slicer may use — only from the source: point links are sorted) | run, [vtkStaticCellLinksTemplate.txx](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkStaticCellLinksTemplate.txx) |
| `vtkCellArray::GetConnectivityArray()`/`GetOffsetsArray()`; storage may be int32, int64, fixed-size (implicit affine offsets) or generic — the numpy dtype follows it; `IsHomogeneous()` is 3 for all-triangle arrays | [vtkCellArray.h](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkCellArray.h), run |
| Generic storage takes any `vtkDataArray` in `SetData` — `vtkBitArray`, `vtkFloatArray`, `vtkDoubleArray` — and the legacy 5.1 reader keeps a file's declared `OFFSETS`/`CONNECTIVITY` type (`bit`, `float`); `numpy_support` maps `VTK_BIT` to `uint8` (one byte per 8 bits) | [vtkCellArray.h](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkCellArray.h), [numpy_support.py](https://github.com/Kitware/VTK/blob/v9.6.0/Wrapping/Python/vtkmodules/util/numpy_support.py), run |
| `vtkPoints::DeepCopy` converts to the copy's data type (float unless `SetDataType` was called first): a double mesh loses precision | [vtkPoints.cxx](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPoints.cxx), run |

**Consequences in `collect.py`:** a working copy with points (same float/double type), polygons and strips only (no
attribute arrays, vertices or lines); check that cells are stored as integers and that point IDs and offsets are in
range before filtering (the filters do not bounds-check: an ID out of range crashes the process); keep only 3-point
cells and drop triangles that repeat a vertex **between** the triangle filter and the normals filter; compact unused
points; copy every array out of VTK memory with a normalised dtype; skip (never abort) a node without triangles.
**SLC-63 (superseded in the merge of `main` on 2026-10-30):** SLC-41 bounds the walk its own way — `ConsistencyOn` only
when the winding is not already consistent, and not at all on a non-manifold fan (`clustering.edge_work` over
`ORIENT_WORK`), where the given winding is kept for the whole node; SLC-67 brings back the cut below for such a node, so
that the rest of it is still made consistent. What SLC-63 did: `collect` predicts the walk's work, Σ n(p)·n(q) over the
edges of every triangle (`np.bincount` of the corners and three dot products: ≈ 0.03 s for 2M triangles). Within a
budget of the larger of 1,000 checks a triangle and 10⁹ (≈ 0.5 s), VTK's filter runs as before and gives the same arrays
to the bit, manifold or not: spheres need ≈ 120 checks a triangle (2M: 118), a 100-sided cone 628, a 3,000-gon extruded
with `vtkRegularPolygonSource` → `vtkLinearExtrusionFilter` → `vtkTriangleFilter` 1,900–3,300 (the caps' triangulation
varies with the radius); a cylinder of 4,000 sides whose caps are fanned from a rim point needs 3.5·10⁸, a sphere split
by an equatorial disc (edges of three triangles) 5.8·10⁵ — VTK turns its reversed half round across the disc, and so
does collect. Over the budget — a fan of 20,000 triangles needs 1.6·10⁹, the 3,000-page book 5·10¹⁰ — the points of more
than T triangles are cut for the largest T that brings the walk on the copy within the budget (bisection over the
valences at the corners; each copy of a cut point has one triangle: ≤ 0.6 s for a crafted 2M mesh of 1,999 valences),
the copy is walked by `vtkOrientPolyData` with `vtkPolyDataNormals`' settings (its points are zeros: the walk reads only
the cells and their links) and the normals are computed with `ConsistencyOff` on the original points. The triangles
joined to the rest of their part only through cut points then form parts of their own — of any size, on closed meshes
too — each wound like its own lowest-ID triangle: a reversed one there is not repaired and turns its part round with it
(round-3 review: an extruded 10,000-gon, 3.0–5.6·10⁸ checks, lost the repair of 31,620 of 39,996 triangles under a
budget of 10⁸; ordinary meshes short of very large primitives — an extruded 20,000-gon needs 0.9–1.4·10⁹ — are now under
the 10⁹). Every point keeps the normalised sum of its triangles' normals. Measured with `mesh_from_triangles`, before
→ after: the 3,000-page book 11 s → 0.03 s (four rows: minutes → 0.03 s), a fan of 100k triangles → 0.07 s, 100k
triangles on one point → 0.1 s; ordinary meshes the same within noise (best of 9 interleaved collects of a sphere of
400k 0.235 → 0.242 s, of the labelmap cylinder 0.309 → 0.284 s; a sphere of 2M 2.6 → 2.9 s, +548 → +551 MiB peak). What
is left is linear but not small on crafted input, mostly cache misses of the normals filter on randomly ordered points
(≈ 3.5 s per 1M triangles with no cut, before and after): a random mesh of 2M triangles whose every point is used by 32
9.3 → 4.3 s (+410 → +641 MiB, the cut copy), one whose points have 18 plus a fan that tips it over the budget ≈ 5–5.5 s
per 1M at 2–4M (≈ 25 % above the old walk on it), shuffled fans of 3 to 2,000 triangles at 2M 9.4 s. The budget is per
node: VTK's walk costs ≈ 0.5 s for a node up to 1M triangles at the budget's edge, ≈ 0.5 s per 1M triangles above (8,032
fans of 249 triangles, 2M triangles: 1.1 s), more on randomly ordered points — a scene of many such nodes costs that for
each (SLC-51's ticks).

### Merge comparison (2026-10-30)

`collect_entities` of one node on `main` (`d70c5be`, SLC-41's walk rule) and on `ws/slicer` (`e4573c3`, SLC-63's cut),
three runs each in one process (load 0.01–0.4); "edge work" is Σ n(p)·n(q). The indices and normals were compared by
hash.

| Mesh | Triangles | Edge work | `main` (s; consistency) | `ws/slicer` (s; consistency, points cut) | Same output |
|---|---|---|---|---|---|
| Book 3,000 × 1 | 6,000 | 5.4e10 | 0.005–0.007 (off) | 0.021–0.031 (off, 1 cut) | yes |
| Book 3,000 × 4 | 24,000 | 7.3e11 | 0.012–0.019 (off) | 0.126–0.141 (off, 3 cut) | yes |
| Fan of 100k around one point | 100,000 | 4.0e10 | 0.056–0.082 (off) | 0.074–0.130 (off, 1 cut) | yes |
| 100k triangles sharing one point | 100,000 | 2.0e10 | 0.094–0.151 (off) | 0.103–0.174 (off, 1 cut) | yes |
| Sphere 2M | 1,998,000 | 2.4e8 | best of five 1.32–1.51 (off: already consistent) | 2.05–2.06 (on) | yes |
| Labelmap cylinder | 434,800 | 4.7e7 | 0.23–0.53 (off) | 0.28–0.38 (on) | yes |
| Fan of 22k, every second triangle reversed | 22,000 | 1.9e9 | 1.10–1.15 (on: under `ORIENT_WORK` = 2e9) | 0.017–0.030 (off, 1 cut) | no |
| A reversed sphere next to an alternately wound book 3,000 × 2 | 13,056 | 2.4e11 | 0.007–0.011 (off) | 0.110–0.121 (off, 1 cut) | no: 151 of the sphere's 1,056 triangles face in on `main`, 0 on `ws/slicer` |

`main` bounds the walk by switching it off for the whole node over `ORIENT_WORK` (2e9, or 1,000 a triangle) and skips it
on a mesh already wound consistently; `ws/slicer` cut the busiest points and walked the rest. Every named case is fast
on both; what only the cut gives is the repair of the rest of such a node → SLC-67. A trial rule — `main`'s skip for a
consistent mesh first, then the cut instead of the switch-off — passed `main`'s SLC-41 tests and gave `ws/slicer`'s
output on every case above (the 2M sphere 1.33–1.68 s best of five).

### Polygons too large to cut (SLC-52)

`vtkTriangleFilter` (`vtkTriangleFilter.cxx`, VTK v9.6.2) copies a triangle, cuts every other polygon with an ear
cut (`vtkPolygon::TriangulateLocalIds` → `EarCutTriangulation`, about O(n²) for n points; most quads take its
`SimpleTriangulation` shortcut) and does all of a node's polygons in one call, which SLC-28's steps cannot split. A
node of triangles only takes a fast path that copies the cell array. Measured in the sandbox (the filter alone, best
of three):

| Points in one polygon | 2,000 | 4,000 | 6,000 | 8,000 |
|---|---|---|---|---|
| convex (a regular polygon) | 0.005 s | 0.021 s | 0.063 s | 0.12 s |
| star, inner radius 0.6 | 0.027 s | 0.090 s | 0.17 s | 0.31 s |
| star, inner radius 0.03 | 0.034 s | 0.14 s | 0.33 s | 0.69 s |
| random 3D points | 0.022 s | 0.093 s | 0.27 s | 0.36 s |
| thin zigzag ribbon (a zigzag out, the same back 0.01 above) | 0.040 s | 0.16 s | 0.42 s | 0.65 s |

The zigzag row was measured again in the SLC-52 review: a run under load had given 0.071 / 0.19 / 0.44 / 0.83 s. At
16,000 points an earlier run took 0.31 s (convex) and 1.15 s (star, 0.6). One polygon of a million points (a crafted or
broken file) would hold the main thread for over an hour. Many small polygons add up in the same call. Per polygon, the
slowest of the convex, zigzag and deep-star outlines is about 12 ns × (n² + 64): the 64 is the fixed cost of an ear cut,
which dominates for 5 to 8 points. The cost is 0.23 / 0.91 / 1.35 / 1.67 / 3.8 µs for 4 / 5 / 6 / 8 / 16 points and 45
µs / 0.68 ms / 10.5 ms for 64 / 256 / 1,000 (each polygon with its own consecutive points). When each small polygon has
its own points, scattered over a large point array, every point read misses the cache: up to 18 ns per unit (7-point
stars, SLC-52 review). A quad the ear cut rejects is the exception: a bow tie (its last two points swapped), four
collinear points or one point repeated. `TriangulateLocalIds` then hands the quad to `vtkQuad`, which costs 3.8–4.3 µs,
against 0.2 µs for a plain quad (SLC-52 review). Polygons of 5 or more points have no such fallback, and degenerate ones
fail fast (0.1–1.4 µs). A triangle costs 34 ns when the call also cuts polygons (10M triangles and one quad: 0.34 s),
against 1.4 ns on the fast path. So, before SLC-52, 300,000 zigzag polygons of 64 points sharing 64 points (19.2M IDs, a
small file) held the filter for 17.3 s in one step (SLC-52 review).

`collect.py` therefore checks the polygons first, in the same pass as the ID check:

- **One polygon too large.** A node with a polygon of more than `MAX_POLYGON_POINTS` (6,000) points is left out as
  `invalid-geometry` before the filter runs. A polygon of 100k points is refused in a few milliseconds.
- **Parts.** The other polygons are cut in parts, in order. Each part holds at most the work of one polygon of 6,000
  points (`_cut_parts`, greedy, at least one cell per part). The work counts n² + 64 per polygon of five or more
  points, 400 per quad (its `vtkQuad` fallback) and 3 per other cell. A part holds 8,653 polygons of 64 points,
  360,000 hexagons or 90,000 quads.
- **One step per part.** Each part is one `vtkTriangleFilter` call and one step. It runs on cell arrays sliced from
  the copy's, over the copy's points: the filter's output keeps its input's points, `SetPoints(input->GetPoints())`.
- **Strips and order.** The strips (linear) follow in one call. The triangles are concatenated in the order of one
  call, polygons then strips, so the winding and the normals are the same (`test_collect.py` compares them).
- **One call.** A node of cells of at most 3 points, or whose polygons fit in one part, is cut in one call, as before.

Measured on crafted nodes (`mesh_steps`, every step timed), a part took about 0.4 s (best of three), up to about
0.65 s for small polygons over scattered points; single runs under load reached about 0.8 s:

- one zigzag polygon of 6,000 points: 0.40 s;
- three of them: about 0.4 s each, best of three (0.36–0.70 s for the longest in single runs);
- a deep star of 6,000 points: 0.32–0.43 s (0.57 s in a single run under load);
- the 300,000 shared 64-gons: 35 parts of 0.41–0.79 s (0.40–0.64 s in a reviewer's run; the highest figures come from
  runs under load);
- 2M hexagons: 6 parts of 0.20–0.46 s;
- 450,000 and 2M bow-tie quads: 5 and 23 parts of at most 0.43 and 0.54 s; 450,000 one-point quads: 5 parts of at
  most 0.53 s; one part of 90,000 bow-tie quads alone: 0.36–0.42 s (SLC-52 review);
- 1.2M 7-point stars over scattered points: 4 parts, the three full ones 0.53–0.65 s (up to 0.83 s under load), the
  last 0.44–0.50 s (SLC-52 review);
- 2M plain quads: 23 parts of at most 0.06 s;
- 10M triangles and a quad: one call, 0.43 s.

The step after the last part joins the parts' triangles: it is linear in the mesh, 2.8 s for the 18.6M triangles of
the 300,000 64-gons. The steps after the cut are SLC-28's, linear in the mesh's triangles and points like those of
any mesh that size. For 2M hexagons (8M triangles over 12M points) the longest is 7.3 s, the normals, against 4.6 s
for a sphere of 8M triangles. For the 300,000 64-gons (18.6M triangles, each edge shared by 300,000 of them) it is
8.5 s, also in the normals' steps. No step is quadratic any more.

The total is not capped: a node's cutting time grows with the work of all its polygons. In a reviewer's run, 20 zigzag
polygons of 6,000 points that share their points (120,000 IDs) took 30 steps and 8.8 s in all, no step above 0.72 s. By
the same rate, 1,000 of them (6M IDs, a small file when the IDs repeat) would keep "Preparing the scene" for about 7
minutes. Slicer handles its events between the steps, about twice a second, and *Stop* ends it. A cap on the total would
have to be in seconds of cutting, so that real meshes of millions of quads are not refused; it is a follow-up in the
plan.

Strips need checks of their own. `vtkTriangleStrip::DecomposeStrip` reads a strip's first two IDs whatever its size
(`vtkTriangleStrip.cxx`, VTK v9.6.2). A strip of 0 points crashes Slicer (SIGSEGV in the sandbox, with or without
polygons, in pure VTK too), a strip of 1 point reads one ID past its own (past the array when it is the last), and a
strip of 2 points makes no triangle. No VTK filter makes such strips (`vtkStripper`, `vtkTubeFilter`,
`vtkCleanPolyData`), so a node with one is left out as `invalid-geometry` before the filter runs. Offsets whose
differences wrap around int64 (`0, 2⁶² + 10, −2⁶², 6`) passed a check that subtracted them: the strips' loop then ran
for ever with int64 storage and aborted with uint64. The offsets are now compared instead. Both were older than SLC-52
(SLC-52 review).

Slicer itself is not slowed by such a polygon in 3D: the OpenGL mapper fans every polygon linearly when it builds its
index buffer (`AppendTrianglesFunctor` in `vtkOpenGLIndexBufferObject.cxx`, the VTK fork Slicer v5.12.4 pins,
`c9cd17a`), so the triangle filter would have been RemoteView's own freeze. The slice views are another matter: a
model's slice intersection cuts its cells, and a polygon cut contours through `vtkPolygon` (`[TODO verify]` its cost
in Slicer); manual §15 step 13 turns the 2D display off.

## 3. MRML API for the Slicer adapter (SLC-22)

| Fact | Source |
|---|---|
| `slicer.util.getNodesByClass('vtkMRMLModelNode')` returns nodes in scene order including **subclasses** (`vtkMRMLAnnotationNode`); its `scene=` argument is ignored. Slicer's own "all models" code compares the exact class name | [util.py#L1799-L1813](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L1799-L1813), [vtkSlicerModelsLogic.cxx#L483-L492](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Models/Logic/vtkSlicerModelsLogic.cxx#L483-L492) |
| Slice-plane models (`Red Volume Slice`, …) are plain `vtkMRMLModelNode`s with `HideFromEditors=1`, a `vtkMRMLSliceDisplayNode` and a textured plane | [vtkMRMLSliceLogic.cxx#L1532-L1622](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Logic/vtkMRMLSliceLogic.cxx#L1532-L1622) |
| `GetPolyData()` updates and returns the **live** pipeline output; `None` without a mesh or for an unstructured-grid model (`.vtu`) | [vtkMRMLModelNode.cxx#L240-L282](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLModelNode.cxx#L240-L282) |
| The mesh is in the node's own RAS frame (mm), before the parent transform; the 3D view applies `GetMatrixTransformToWorld` as the actor's user matrix when `IsTransformToWorldLinear()`, else a `vtkTransformFilter` | [vtkMRMLModelDisplayableManager.cxx#L1254-L1294](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L1254-L1294), [vtkMRMLDisplayableNode.h#L200-L209](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayableNode.h#L200-L209) |
| `vtkMRMLTransformNode::IsTransformToWorldLinear()`; `GetMatrixTransformToWorld(vtkMatrix4x4*)` returns 0 (and logs errors) for a non-linear chain — call it only when linear; world = `M_root ··· M_parent · p_local`, `vtkMatrix4x4` element `(i, j)` = row `i` | [vtkMRMLTransformNode.h#L62-L176](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLTransformNode.h#L62-L176), [vtkMRMLTransformNode.cxx#L422-L433](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLTransformNode.cxx#L422-L433), run |
| 3D visibility = folder hierarchy visibility ∧ `GetVisibility()` ∧ `GetVisibility3D()` ∧ displayable in the view; opacity is multiplied by the folder hierarchy opacity; a folder with "apply to branch" overrides colour/opacity. `GetDisplayVisibility()` is only the Data-module eye (ignores `Visibility3D` and folders). Colour/opacity setters do not clamp | [vtkMRMLModelDisplayableManager.cxx#L1254-L1340](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L1254-L1340), [vtkMRMLDisplayNode.h#L141-L295](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayNode.h#L141-L295), [vtkMRMLDisplayableNode.cxx#L227-L250](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayableNode.cxx#L227-L250) |
| Generated IDs are `<ClassName><N>` (`[A-Za-z0-9]+`), but `SetID` and the `.mrml` `id` attribute accept any string; IDs restart after *Close scene* | [vtkMRMLScene.cxx#L2503-L2627](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLScene.cxx#L2503-L2627), [vtkMRMLScene.cxx#L349-L367](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLScene.cxx#L349-L367) |

**Adapter guidance (SLC-22):** `visible_model_nodes()` = exact class `vtkMRMLModelNode`, not `HideFromEditors`,
with a `vtkMRMLModelDisplayNode` that is not a `vtkMRMLSliceDisplayNode`; `display_props` from the first model display
node, combined with the folder hierarchy visibility/opacity like the displayable manager; `world_matrix` = identity
without a parent, `None` when `not IsTransformToWorldLinear()`, else `GetMatrixTransformToWorld` converted row by row;
`polydata` = `GetPolyData()` on the main thread (collect deep-copies it).

## 4. Not verified

- The fork's C++ was not diffed against upstream VTK 9.6.2 (only its Python files, which are identical).
- TBB determinism of `vtkPolyDataNormals` (the wheel has no TBB backend).
- Calling `vtkMRMLFolderDisplayNode.GetHierarchyVisibility`/`GetHierarchyOpacity` from Python in Slicer, and model-node
  subclasses created by extensions (SlicerDMRI, SlicerIGT, SlicerVirtualReality).
