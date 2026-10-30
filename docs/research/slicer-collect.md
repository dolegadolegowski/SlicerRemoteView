# Research — MRML collection and the VTK mesh pipeline (SLC-07, SLC-22, SLC-63)

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
**SLC-63:** `collect` predicts the walk's work, Σ n(p)·n(q) over the edges of every triangle (`np.bincount` of the
corners and three dot products: ≈ 0.03 s for 2M triangles). Within a budget of the larger of 1,000 checks a triangle
and 10⁹ (≈ 0.5 s), VTK's filter runs as before and gives the same arrays to the bit, manifold or not: spheres need ≈ 120
checks a triangle (2M: 118), a 100-sided cone 628, a 3,000-gon extruded with `vtkRegularPolygonSource` →
`vtkLinearExtrusionFilter` → `vtkTriangleFilter` 1,900–3,300 (the caps' triangulation varies with the radius); a
cylinder of 4,000 sides whose caps are
fanned from a rim point needs 3.5·10⁸, a sphere split by an equatorial disc (edges of three triangles) 5.8·10⁵ — VTK
turns its reversed half round across the disc, and so does collect. Over the budget — a fan of 20,000 triangles needs
1.6·10⁹, the 3,000-page book 5·10¹⁰ — the points of more than T triangles are cut for the largest T that brings the
walk on the copy within the budget (bisection over the valences at the corners; each copy of a cut point has one
triangle: ≤ 0.6 s for a crafted 2M mesh of 1,999 valences), the copy is walked by `vtkOrientPolyData` with
`vtkPolyDataNormals`' settings (its points are zeros: the walk reads only the cells and their links) and the normals
are computed with `ConsistencyOff` on the original points. The triangles joined to the rest of their part only through
cut points then form parts of their own — of any size, on closed meshes too — each wound like its own lowest-ID
triangle: a reversed one there is not repaired and turns its part round with it (round-3 review: an extruded
10,000-gon, 3.0–5.6·10⁸ checks, lost the repair of 31,620 of 39,996 triangles under a budget of 10⁸; ordinary meshes
short of very large primitives — an extruded 20,000-gon needs 0.9–1.4·10⁹ — are now under the 10⁹). Every point keeps the normalised sum of its triangles' normals. Measured with
`mesh_from_triangles`, before → after: the 3,000-page book 11 s → 0.03 s (four rows: minutes → 0.03 s), a fan of 100k
triangles → 0.07 s, 100k triangles on one point → 0.1 s; ordinary meshes the same within noise (best of 9 interleaved
collects of a sphere of 400k 0.235 → 0.242 s, of the labelmap cylinder 0.309 → 0.284 s; a sphere of 2M 2.6 → 2.9 s,
+548 → +551 MiB peak). What is left is linear but not small on crafted input, mostly cache misses of the normals filter
on randomly ordered points (≈ 3.5 s per 1M triangles with no cut, before and after): a random mesh of 2M triangles whose
every point is used by 32 9.3 → 4.3 s (+410 → +641 MiB, the cut copy), one whose points have 18 plus a fan that tips it
over the budget ≈ 5–5.5 s per 1M at 2–4M (≈ 25 % above the old walk on it), shuffled fans of 3 to 2,000 triangles at 2M
9.4 s. The budget is per node: VTK's walk costs ≈ 0.5 s for a node up to 1M triangles at the budget's edge, ≈ 0.5 s per
1M triangles above (8,032 fans of 249 triangles, 2M triangles: 1.1 s), more on randomly ordered points — a scene of many
such nodes costs that for each (SLC-28's ticks).

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
