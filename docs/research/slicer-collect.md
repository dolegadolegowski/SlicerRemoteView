# Research — MRML collection and the VTK mesh pipeline (SLC-07, SLC-22)

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
v9.6.2 and in Slicer's fork `slicer/VTK@c9cd17a` (compared).

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
