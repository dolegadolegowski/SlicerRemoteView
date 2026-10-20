# Research — the Slicer scene adapter, application exit and module layout (SLC-22)

Verified on 2026-10-20 by reading the sources of Slicer `v5.12.4`, the CTK revision it builds
(`5056664a20a3d0a393bb6d91f040525581e0dcdf`), VTK `v9.6.2` (whose wrapping headers Slicer's VTK fork shares) and qtbase
`v5.15.2`/`v6.8.0`. Nothing was run inside Slicer (CLAUDE.md rule 10): the manual steps are `docs/testing/slicer.md`
§12. This extends `docs/research/slicer-collect.md` §3. DM = `vtkMRMLModelDisplayableManager` (draws models in a 3D
view), SH = subject hierarchy.

## 1. What the 3D view shows

| Fact | Source |
|---|---|
| `vtkMRMLFolderDisplayNode` has static `GetHierarchyVisibility(displayableNode)` (bool), `GetHierarchyOpacity(displayableNode)` (double) and `GetOverridingHierarchyDisplayNode(displayableNode)` | [vtkMRMLFolderDisplayNode.h#L86-L111](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLFolderDisplayNode.h#L86-L111) |
| Hierarchy visibility is `False` iff an ancestor folder's display node has `Visibility` 0 (its `Visibility3D` is not read); `True` outside folders; hierarchy opacity is the product of the ancestors' `Opacity` (1.0 outside folders) | [vtkMRMLFolderDisplayNode.cxx#L290-L364](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLFolderDisplayNode.cxx#L290-L364) |
| The overriding node is the display node of the **outermost** ancestor folder with "apply display properties to branch" on (`None` while the scene imports) | [vtkMRMLFolderDisplayNode.cxx#L247-L287](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLFolderDisplayNode.cxx#L247-L287) |
| The DM uses folders only when `GetFolderDisplayOverrideAllowed()` (default on); then `source = overriding node or display node`. Shown = hierarchy visibility ∧ `GetVisibility()` ∧ `GetVisibility3D()` ∧ `IsDisplayableInView(<3D view>)`; opacity = hierarchy opacity × `source.GetOpacity()`; colour = `source.GetColor()` (selection colour, textures and scalar colouring aside) | [vtkMRMLModelDisplayableManager.cxx#L1254-L1412](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L1254-L1412), [vtkMRMLDisplayNode.cxx#L86](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayNode.cxx#L86) |
| Slicer's own registered test calls `slicer.vtkMRMLFolderDisplayNode.GetHierarchyVisibility(modelNode)` and `GetHierarchyOpacity(modelNode)` from Python (0.25 for two nested folders at 0.5) | [SubjectHierarchyFoldersTest1.py#L134-L238](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/SubjectHierarchy/Testing/Python/SubjectHierarchyFoldersTest1.py#L134-L238), [VTK PythonWrappers.md#L392-L401](https://github.com/Kitware/VTK/blob/v9.6.2/Documentation/docs/advanced/PythonWrappers.md?plain=1#L392-L401) |
| `GetDisplayNode()`/`GetModelDisplayNode()` look only at the first display-node reference; `GetNthDisplayNode(i)` may return `None`. Slice display nodes (`vtkMRMLSliceDisplayNode`) are model display nodes; a colour legend is a plain display node the DM skips | [vtkMRMLDisplayableNode.h#L119-L151](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayableNode.h#L119-L151), [vtkMRMLModelNode.cxx#L135-L138](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLModelNode.cxx#L135-L138), [vtkMRMLSliceDisplayNode.h#L28](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLSliceDisplayNode.h#L28), [DM.cxx#L753-L757](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L753-L757) |
| `GetVisibility()`/`GetVisibility3D()` return int, `GetOpacity()` float, `GetColor()` a 3-tuple; an empty view list means "all views"; 3D views are `vtkMRMLViewNode`s | [vtkMRMLDisplayNode.h#L141-L295](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayNode.h#L141-L295), [#L584-L613](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLDisplayNode.h#L584-L613) |
| `GetPolyData()` is `None` for an unstructured-grid model, which the DM still draws; `GetName()`/`GetID()` return `str`, `bytes` (not UTF-8) or `None` | [vtkMRMLModelNode.cxx#L240-L306](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLModelNode.cxx#L240-L306), [vtkPythonArgs.h#L866-L885](https://github.com/Kitware/VTK/blob/v9.6.2/Wrapping/PythonCore/vtkPythonArgs.h#L866-L885) |
| `slicer.util.getNodesByClass` returns a `list` in scene order, subclasses included (`vtkMRMLAnnotationNode`, SlicerDMRI's fibre bundles) | [util.py#L1799-L1813](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L1799-L1813), [vtkMRMLFiberBundleNode.h#L43](https://github.com/SlicerDMRI/SlicerDMRI/blob/a40200bfb9df21a6092b308188175d1e339b5771/Modules/Loadable/TractographyDisplay/MRML/vtkMRMLFiberBundleNode.h#L43) |

**Consequences in `remoteview_core/mrml_scene.py`:** the adapter repeats the DM's calls, so a model leaves the PC only
if a 3D view shows it, with the colour and opacity the presenter sees (the double-counted opacity of an "apply to
branch" folder included); the display node is the first shown model display node that is not a slice display node.
Hidden models are **left out** (FR-05, T7: a hidden skin surface can identify a patient), not exported with
`visible: false` as ADR 0005 Decision 6 proposed — asked of `release` in `docs/testing/reports/2026-10-20-slicer-5.md`;
following the ADR later means dropping one condition in `visible_model_nodes()`.

## 2. Application exit and module layout

| Fact | Source |
|---|---|
| The application connects `aboutToQuit()` to `onAboutToQuit()`, which unloads every module; unloading emits `moduleAboutToBeUnloaded`, which calls a scripted widget's `cleanup()`. Slots run in connection order, so `cleanup()` runs before any `aboutToQuit` slot a module connects, and no `QTimer` fires afterwards | [qSlicerCoreApplication.cxx#L611](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerCoreApplication.cxx#L611), [#L2173-L2190](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerCoreApplication.cxx#L2173-L2190), [qSlicerModuleFactoryManager.cxx#L222-L265](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerModuleFactoryManager.cxx#L222-L265), [ScriptedLoadableModule.py#L109-L140](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/ScriptedLoadableModule.py#L109-L140), [qcoreapplication.cpp 5.15.2#L1352-L1394](https://github.com/qt/qtbase/blob/v5.15.2/src/corelib/kernel/qcoreapplication.cpp#L1352-L1394), [6.8.0#L2199-L2215](https://github.com/qt/qtbase/blob/v6.8.0/src/corelib/kernel/qcoreapplication.cpp#L2199-L2215) |
| The widget, and so `cleanup()`, exists once the panel was shown — always the case while a session runs, since only the panel starts one | [qSlicerAbstractCoreModule.cxx#L233-L243](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerAbstractCoreModule.cxx#L233-L243) |
| *Reload* re-executes only `<Module>.py`; packages next to it stay imported | [util.py#L1578-L1643](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L1578-L1643) |
| Every top-level `*.py` in a module path is a module candidate and must define a class of its name; helper code goes into a sub-package listed in `MODULE_PYTHON_SCRIPTS` (as `remoteview_core/` is) | [qSlicerScriptedLoadableModuleFactory.cxx#L126-L224](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTGUI/qSlicerScriptedLoadableModuleFactory.cxx#L126-L224), [python_faq.md#L311-L347](https://github.com/Slicer/Slicer/blob/v5.12.4/Docs/developer_guide/python_faq.md?plain=1#L311-L347) |

**Consequences:** the SLC-09 `cleanup()` already closes a running session on application exit, before anything else
the module could hook to `aboutToQuit`; SLC-24 verifies it with a viewer instead of adding a second hook. The scene
adapter lives in `remoteview_core/` with Slicer's functions passed in, so it imports no `slicer` and is tested with
fakes.

## Not verified

- Anything inside a Slicer binary (manual §12).
- The Python binding of `GetOverridingHierarchyDisplayNode` (no Python caller in Slicer 5.12.4; wrappable by VTK's
  rules) `[TODO verify]`, and which Qt the official 5.12.4 packages use `[TODO verify]`.
- View nodes added by extensions (e.g. SlicerVirtualReality) and `aboutToQuit` on an OS log-off.
- Accepted differences from what the presenter sees: every `vtkMRMLViewNode` counts, also one whose layout is not
  shown (`IsViewVisibleInLayout()`), and Slicer's rules ignore opacity 0 and clipping, so such models and clipped-away
  parts are exported whole (the consent text says so; the opacity rule is asked of `release` with the hidden models).
