"""The Slicer scene for :func:`~remoteview_core.collect.collect_scene` (SLC-22, SLC-35): which model nodes and
segments the 3D view shows, and how — without importing ``slicer``.

``RemoteView.py`` builds :class:`MrmlSceneApi` with Slicer's own functions (``slicer.util.getNodesByClass`` and the
``slicer.vtkMRMLFolderDisplayNode`` class, whose static methods give the folder visibility and opacity); tests pass
fakes. Every call below is the one Slicer's displayable managers make to draw a node in a 3D view
(``docs/research/slicer-scene.md``, ``docs/research/slicer.md`` §2), so a node leaves the PC only if Slicer's display
rules show it in a 3D view (FR-05, NFR-16; those rules ignore clipping, so such meshes are sent whole — the consent text
says so).

**Models** (``vtkMRMLModelDisplayableManager``, SLC-22):

- the exact class ``vtkMRMLModelNode`` (no annotations, fibre bundles or other subclasses), not hidden from editors
  (slice planes and helper models are);
- its first model display node that is not a slice display node is visible (``Visibility`` and ``Visibility3D``), in at
  least one 3D view, and inside visible folders (``GetHierarchyVisibility``, unless the display node opts out of
  folder overrides);
- colour and opacity come from the outermost folder that applies its display properties to the branch, else from the
  display node, and the opacity is multiplied by the folders' opacity — exactly like the 3D view; a model at opacity 0
  is drawn (invisibly) and therefore exported.

**Segments** (``vtkMRMLSegmentationsDisplayableManager3D``, Slicer v5.12.4,
``Modules/Loadable/Segmentations/MRMLDM/vtkMRMLSegmentationsDisplayableManager3D.cxx``: ``vtkInternal::IsVisible``
and ``vtkInternal::UpdateDisplayNodePipeline``; SLC-35). One :class:`SegmentRef` handle per shown segment:

- the exact class ``vtkMRMLSegmentationNode``, not hidden from editors, with a segmentation display node
  (:data:`SEGMENTATION_DISPLAY_CLASS`) displayable in a 3D view — the first shown one, else the first one;
- the **whole node is not shown** when ``display.GetVisibility()``, ``GetVisibility3D()`` or the view check fails,
  when the folders hide it (``GetHierarchyVisibility``, gated by ``GetFolderDisplayOverrideAllowed`` like the opacity
  below), or when ``display.GetOpacity3D() <= 0`` (``IsVisible``: unlike models, a segmentation at 3D opacity 0 is
  not drawn at all), or when ``GetDisplayRepresentationName3D()`` is ``""`` (*Show 3D* off: there is nothing to draw
  and nothing is converted here, see below);
- a segment is shown when ``GetSegmentVisibility(id)`` and ``GetSegmentVisibility3D(id)`` both hold; a hidden one is
  **left out** (SLC-22's privacy default extended to segments while ``2026-10-20-slicer-5`` is open; report
  ``2026-10-28-slicer-1``). The cost: a segment hidden at export time and shown later is a new node for the viewers →
  a full snapshot of the scene; a segment hidden after the export is a cheap ``scene.update{visible:false}``;
- opacity, as ``UpdateDisplayNodePipeline`` computes the actor's: ``hierarchy opacity × GetSegmentOpacity3D(id) ×
  GetOpacity3D() × generic.GetOpacity()``, where the *generic* display node is the overriding folder display node
  when the display node allows folder overrides and one exists, else the segmentation display node (four factors; the
  folder's opacity may then count twice — what the source reads, ``[TODO verify]`` on screen, manual §13 step 6);
- colour: the overriding folder display node's ``GetColor()`` **whenever such a node exists** — the DM's colour
  branch tests ``if (overrideHierarchyDisplayNode)`` without the ``GetFolderDisplayOverrideAllowed`` gate that its
  opacity and visibility branches have — else ``tuple(display.GetSegmentColor(id))``, the one-argument ``vtkVector3d``
  overload ("Convenience function for python compatibility"), checked for three finite floats. The model path above
  keeps its own gated reading (the model DM differs); the two are deliberately not unified. A ``TypeError``,
  ``ValueError`` or ``AttributeError`` from a per-segment getter (a binding that differs from the one probed) makes
  that one segment :data:`INVALID_DISPLAY_PROPS` (type-only log) → ``invalid-display`` in the collection; the rest of
  the scene ships. A segment ``GetSegment`` no longer has (removed since the list was read, a preparation in steps,
  SLC-71) reads as hidden without asking any per-segment getter: Slicer's would print its ID (``vtkErrorMacro``,
  T7);
- geometry, **read-only and never converted**: ``GetSegmentation().GetSegmentRepresentation(id,
  GetDisplayRepresentationName3D())`` — the live polydata the DM draws (collect makes its own geometry-only copy).
  ``CreateClosedSurfaceRepresentation()``/``CreateRepresentation()`` are never called: they write MRML, fire
  ``RepresentationModified``/``ContainedRepresentationNamesModified`` and take seconds to minutes on whole-body data
  (ADR 0005 Consequences); the DM has already created the representation for everything it draws. A missing or empty
  representation, or a planar-contour one (polylines, SlicerRT), is reported as ``no-triangles``, never aborts;
- the world transform is the segmentation node's parent transform, exactly as for a model (SLC-13): all segments of
  a node share it.

The world matrix is the identity without a parent transform and ``None`` for a non-linear chain (never ask Slicer for
the matrix of a non-linear chain — it logs errors); the transform of such a chain, for baking (SLC-13), is the one the
3D view applies with its ``vtkTransformFilter``: ``GetTransformToWorld`` into an identity ``vtkGeneralTransform``.

Main thread only (MRML). No node name or segment ID reaches a log (T7).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from typing import Any, NamedTuple

import numpy as np
from numpy.typing import NDArray
from vtkmodules.vtkCommonMath import vtkMatrix4x4
from vtkmodules.vtkCommonTransforms import vtkGeneralTransform

_log = logging.getLogger(__name__)

MODEL_CLASS = "vtkMRMLModelNode"
VIEW_CLASS = "vtkMRMLViewNode"  # the 3D views
SEGMENTATION_CLASS = "vtkMRMLSegmentationNode"
SEGMENTATION_DISPLAY_CLASS = "vtkMRMLSegmentationDisplayNode"
#: What :meth:`MrmlSceneApi.display_props` returns for a segment whose display getters fail: ``collect.display_of``
#: rejects the NaN opacity, so that one segment is skipped as ``invalid-display``.
INVALID_DISPLAY_PROPS: tuple[tuple[float, float, float], float, bool] = (
    (0.0, 0.0, 0.0),
    float("nan"),
    False,
)
_BINDING_ERRORS = (TypeError, ValueError, AttributeError)


class SegmentRef(NamedTuple):
    """One shown segment: its segmentation node and its raw segment ID (``str``, or ``bytes`` for an ID that is not
    UTF-8), exactly as ``GetSegmentIDs()`` returned it — the only form the display getters are asked with. The repr
    shows neither (a raw segment ID may be PHI, T7; SLC-36 passes handles into the classifier)."""

    node: Any
    segment_id: Any

    def __repr__(self) -> str:
        return f"SegmentRef(node=<{type(self.node).__name__}>, segment_id=<hidden>)"


class MrmlSceneApi:
    """:class:`~remoteview_core.collect.SceneApi` over a live MRML scene.

    ``nodes_by_class(class_name)`` returns the scene's nodes of that class (and its subclasses) in scene order, like
    ``slicer.util.getNodesByClass``; ``folder_display`` is ``slicer.vtkMRMLFolderDisplayNode``.
    """

    def __init__(self, nodes_by_class: Callable[[str], Sequence[Any]], folder_display: Any) -> None:
        self._nodes_by_class = nodes_by_class
        self._folders = folder_display

    # ------------------------------------------------------------------ SceneApi: the lists

    def visible_model_nodes(self) -> list[Any]:
        views = self._views()
        return [
            node
            for node in self._nodes_by_class(MODEL_CLASS)
            if node.GetClassName() == MODEL_CLASS
            and not node.GetHideFromEditors()
            and self._shown(node, self._display_node(node, views), views)
        ]

    def visible_segments(self) -> list[SegmentRef]:
        """The segments the 3D view draws, in Slicer's segment order, segmentation nodes in scene order."""
        views = self._views()
        handles: list[SegmentRef] = []
        for node in self._nodes_by_class(SEGMENTATION_CLASS):
            if node.GetClassName() != SEGMENTATION_CLASS or node.GetHideFromEditors():
                continue
            display = self._segmentation_display(node, views)
            if display is None or not self._node_shown(node, display, views):
                continue
            if not display.GetDisplayRepresentationName3D():
                continue  # Show 3D off: nothing is drawn, nothing is converted
            for segment_id in self._segment_ids(node):
                try:
                    shown = display.GetSegmentVisibility(
                        segment_id
                    ) and display.GetSegmentVisibility3D(segment_id)
                except _BINDING_ERRORS as exc:
                    # one segment's binding fails (SLC-35 review): list it anyway, so display_props reports it as
                    # invalid-display and the rest of the scene ships; type only (T7)
                    _log.error("mrml_scene: segment visibility not read (%s)", type(exc).__name__)
                    shown = True
                if shown:
                    handles.append(SegmentRef(node, segment_id))
        return handles

    # ------------------------------------------------------------------ SceneApi: per entity

    def node_id(self, node: Any) -> Any:
        return node.GetID()

    def segment_identity(self, handle: SegmentRef) -> tuple[Any, Any]:
        """``(segmentation node MRML ID, raw segment ID)``."""
        return handle.node.GetID(), handle.segment_id

    def name(self, node: Any) -> Any:
        if isinstance(node, SegmentRef):
            segment = node.node.GetSegmentation().GetSegment(node.segment_id)
            return None if segment is None else segment.GetName()  # None: vanished meanwhile
        return node.GetName()  # str, or bytes for a name that is not UTF-8 (collect handles both)

    def polydata(self, node: Any) -> Any:
        if isinstance(node, SegmentRef):
            display = self._segmentation_display(node.node, self._views())
            name3d = display.GetDisplayRepresentationName3D() if display is not None else ""
            if not name3d:
                return None  # Show 3D switched off since the list was read: nothing to draw
            # the live representation the DM draws — read only, never created here (module docstring)
            return node.node.GetSegmentation().GetSegmentRepresentation(node.segment_id, name3d)
        return node.GetPolyData()  # None for an unstructured-grid model: reported as "no triangles"

    def display_props(self, node: Any) -> tuple[Sequence[float], float, bool]:
        views = self._views()
        if isinstance(node, SegmentRef):
            return self._segment_props(node, views)
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
        parent = self._mrml_node(node).GetParentTransformNode()
        if parent is None:
            return np.eye(4)
        if not parent.IsTransformToWorldLinear():
            return None
        matrix = vtkMatrix4x4()
        parent.GetMatrixTransformToWorld(matrix)
        return np.array([[matrix.GetElement(row, col) for col in range(4)] for row in range(4)])

    def world_transform(self, node: Any) -> vtkGeneralTransform | None:
        parent = self._mrml_node(node).GetParentTransformNode()
        if parent is None:
            return None
        transform = vtkGeneralTransform()
        transform.Identity()
        parent.GetTransformToWorld(transform)
        return transform

    # ------------------------------------------------------------------ helpers: models

    def _views(self) -> list[Any]:
        return [view.GetID() for view in self._nodes_by_class(VIEW_CLASS)]

    @staticmethod
    def _mrml_node(node: Any) -> Any:
        """The transformable MRML node of a handle: a segment's segmentation node, else the node itself."""
        return node.node if isinstance(node, SegmentRef) else node

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

    # ------------------------------------------------------------------ helpers: segments

    def _segmentation_display(self, node: Any, views: Sequence[str]) -> Any:
        """The segmentation display node the 3D view draws: the first shown one, else the first one (or ``None``)."""
        candidates = []
        for index in range(node.GetNumberOfDisplayNodes()):
            display = node.GetNthDisplayNode(index)  # None in temporary states
            if display is not None and display.IsA(SEGMENTATION_DISPLAY_CLASS):
                candidates.append(display)
        shown = [d for d in candidates if self._node_shown(node, d, views)]
        return (shown or candidates or [None])[0]

    def _node_shown(self, node: Any, display: Any, views: Sequence[str]) -> bool:
        """``vtkInternal::IsVisible`` for the whole segmentation: the model rules plus ``Opacity3D > 0``."""
        return self._shown(node, display, views) and display.GetOpacity3D() > 0

    @staticmethod
    def _segment_ids(node: Any) -> tuple[Any, ...]:
        """The IDs as ``GetSegmentIDs()`` returns them (a tuple of ``str``/``bytes``; a sequence of another type is
        read the same way)."""
        return tuple(node.GetSegmentation().GetSegmentIDs())

    def _segment_props(
        self, handle: SegmentRef, views: Sequence[str]
    ) -> tuple[tuple[float, float, float], float, bool]:
        """``UpdateDisplayNodePipeline`` for one segment (module docstring); :data:`INVALID_DISPLAY_PROPS` when a
        per-segment getter's binding fails; hidden, asking no getter, for a segment removed since it was listed."""
        node, sid = handle.node, handle.segment_id
        display = self._segmentation_display(node, views)
        if display is None:
            return (0.0, 0.0, 0.0), 0.0, False
        if node.GetSegmentation().GetSegment(sid) is None:
            # removed since the list was read (a preparation in steps, SLC-71): Slicer's per-segment getters would
            # print its ID (vtkErrorMacro, T7); ``GetSegment`` returns nullptr without a word
            return (0.0, 0.0, 0.0), 0.0, False
        allowed = bool(display.GetFolderDisplayOverrideAllowed())
        folder = self._folders.GetOverridingHierarchyDisplayNode(
            node
        )  # ungated: the colour branch is not
        if allowed:
            hier_vis = bool(self._folders.GetHierarchyVisibility(node))
            hier_op = float(self._folders.GetHierarchyOpacity(node))
        else:
            hier_vis, hier_op = True, 1.0
        generic = folder if (allowed and folder is not None) else display
        node_vis = self._node_shown(node, display, views)
        try:
            visible = bool(
                hier_vis
                and node_vis
                and display.GetSegmentVisibility(sid)
                and display.GetSegmentVisibility3D(sid)
            )
            opacity = (
                hier_op
                * float(display.GetSegmentOpacity3D(sid))
                * float(display.GetOpacity3D())
                * float(generic.GetOpacity())
            )
            color = (
                tuple(folder.GetColor())
                if folder is not None
                else tuple(display.GetSegmentColor(sid))
            )
            if len(color) != 3:
                raise ValueError("colour is not three components")
            rgb = (float(color[0]), float(color[1]), float(color[2]))
        except _BINDING_ERRORS as exc:
            # the binding differs from the one probed (vtkVector3d overload, GetSegment* signatures): this one segment
            # is reported as invalid-display, the scene still ships. Type only: the ID may be PHI (T7)
            _log.error("mrml_scene: segment display properties not read (%s)", type(exc).__name__)
            return INVALID_DISPLAY_PROPS
        if not all(math.isfinite(v) for v in rgb):
            return INVALID_DISPLAY_PROPS
        return rgb, opacity, visible
