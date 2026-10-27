"""The Slicer scene for :func:`~remoteview_core.collect.collect_scene` (SLC-22): which model nodes the 3D view shows,
and how — without importing ``slicer``.

``RemoteView.py`` builds :class:`MrmlSceneApi` with Slicer's own functions (``slicer.util.getNodesByClass`` and the
``slicer.vtkMRMLFolderDisplayNode`` class, whose static methods give the folder visibility and opacity); tests pass
fakes. Every call below is the one Slicer's model displayable manager makes to draw a model in a 3D view
(``docs/research/slicer-scene.md``), so a node leaves the PC only if Slicer's display rules show it in a 3D view (FR-05,
NFR-16; those rules ignore opacity 0 and clipping, so such meshes are sent whole — the consent text says so):

- the exact class ``vtkMRMLModelNode`` (no annotations, fibre bundles or other subclasses), not hidden from editors
  (slice planes and helper models are);
- its first model display node that is not a slice display node is visible (``Visibility`` and ``Visibility3D``), in at
  least one 3D view, and inside visible folders (``GetHierarchyVisibility``, unless the display node opts out of
  folder overrides);
- colour and opacity come from the outermost folder that applies its display properties to the branch, else from the
  display node, and the opacity is multiplied by the folders' opacity — exactly like the 3D view;
- the world matrix is the identity without a parent transform and ``None`` for a non-linear chain (never ask Slicer for
  the matrix of a non-linear chain — it logs errors); the transform of such a chain, for baking (SLC-13), is the one the
  3D view applies with its ``vtkTransformFilter``: ``GetTransformToWorld`` into an identity ``vtkGeneralTransform``.

Main thread only (MRML).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np
from numpy.typing import NDArray
from vtkmodules.vtkCommonMath import vtkMatrix4x4
from vtkmodules.vtkCommonTransforms import vtkGeneralTransform

MODEL_CLASS = "vtkMRMLModelNode"
VIEW_CLASS = "vtkMRMLViewNode"  # the 3D views


class MrmlSceneApi:
    """:class:`~remoteview_core.collect.SceneApi` over a live MRML scene.

    ``nodes_by_class(class_name)`` returns the scene's nodes of that class (and its subclasses) in scene order, like
    ``slicer.util.getNodesByClass``; ``folder_display`` is ``slicer.vtkMRMLFolderDisplayNode``.
    """

    def __init__(self, nodes_by_class: Callable[[str], Sequence[Any]], folder_display: Any) -> None:
        self._nodes_by_class = nodes_by_class
        self._folders = folder_display

    # ------------------------------------------------------------------ SceneApi

    def visible_model_nodes(self) -> list[Any]:
        views = [view.GetID() for view in self._nodes_by_class(VIEW_CLASS)]
        return [
            node
            for node in self._nodes_by_class(MODEL_CLASS)
            if node.GetClassName() == MODEL_CLASS
            and not node.GetHideFromEditors()
            and self._shown(node, self._display_node(node, views), views)
        ]

    def node_id(self, node: Any) -> Any:
        return node.GetID()

    def name(self, node: Any) -> Any:
        return node.GetName()  # str, or bytes for a name that is not UTF-8 (collect handles both)

    def polydata(self, node: Any) -> Any:
        return node.GetPolyData()  # None for an unstructured-grid model: reported as "no triangles"

    def display_props(self, node: Any) -> tuple[Sequence[float], float, bool]:
        views = [view.GetID() for view in self._nodes_by_class(VIEW_CLASS)]
        display = self._display_node(node, views)
        if display is None:
            return (0.0, 0.0, 0.0), 0.0, False
        source, folder_opacity = display, 1.0
        if display.GetFolderDisplayOverrideAllowed():
            source = self._folders.GetOverridingHierarchyDisplayNode(node) or display
            folder_opacity = self._folders.GetHierarchyOpacity(node)
        opacity = folder_opacity * source.GetOpacity()
        return source.GetColor(), opacity, self._shown(node, display, views)

    def world_matrix(self, node: Any) -> NDArray[np.float64] | None:
        parent = node.GetParentTransformNode()
        if parent is None:
            return np.eye(4)
        if not parent.IsTransformToWorldLinear():
            return None
        matrix = vtkMatrix4x4()
        parent.GetMatrixTransformToWorld(matrix)
        return np.array([[matrix.GetElement(row, col) for col in range(4)] for row in range(4)])

    def world_transform(self, node: Any) -> vtkGeneralTransform | None:
        parent = node.GetParentTransformNode()
        if parent is None:
            return None
        transform = vtkGeneralTransform()
        transform.Identity()
        parent.GetTransformToWorld(transform)
        return transform

    # ------------------------------------------------------------------ helpers

    def _display_node(self, node: Any, views: Sequence[str]) -> Any:
        """The model display node the 3D view draws: the first shown one, else the first one (or ``None``)."""
        candidates = []
        for index in range(node.GetNumberOfDisplayNodes()):
            display = node.GetNthDisplayNode(index)  # None in temporary states
            if (
                display is not None
                and display.IsA("vtkMRMLModelDisplayNode")
                and not display.IsA("vtkMRMLSliceDisplayNode")
            ):
                candidates.append(display)
        shown = [d for d in candidates if self._shown(node, d, views)]
        return (shown or candidates or [None])[0]

    def _shown(self, node: Any, display: Any, views: Sequence[str]) -> bool:
        if display is None:
            return False
        in_folders = (
            self._folders.GetHierarchyVisibility(node)
            if display.GetFolderDisplayOverrideAllowed()
            else True
        )
        # an empty view list means every view; with no 3D view in the scene nothing is shown
        in_a_view = any(display.IsDisplayableInView(view) for view in views)
        return bool(
            in_folders and display.GetVisibility() and display.GetVisibility3D() and in_a_view
        )
