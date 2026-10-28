"""MRML fakes with VTK's own event dispatch, shared by ``test_observers`` and ``test_panel_live`` (SLC-31, SLC-32,
SLC-36).

The scene and the nodes are Python subclasses of ``vtkObject``: ``AddObserver``, ``InvokeEvent`` (with or without call
data) and ``RemoveObserver`` are VTK's own, so the handlers see what Slicer gives them. numpy, vtkmodules and the
standard library only.
"""

from __future__ import annotations

import numpy as np
from vtkmodules.vtkCommonCore import vtkObject

#: ``vtkSegmentation``'s event ids by Slicer's attribute names (Libs/Segmentations/vtkSegmentation.h: an enum starting
#: at 62100 in declaration order; ``[TODO verify]`` against ``slicer.vtkSegmentation.*``, manual §13 step 1).
#: ``conftest.slicer_stubs`` builds ``slicer.vtkSegmentation`` from it (SLC-36), and ``test_skeleton`` asserts that
#: ``RemoteView.makeWatcher`` passes five of them into their own ``MrmlEvents`` fields (SLC-37).
VTK_SEGMENTATION_EVENTS = {
    "SourceRepresentationModified": 62100,  # not observed: a pass-through of the source representation
    "RepresentationModified": 62101,
    "SegmentAdded": 62102,
    "SegmentRemoved": 62103,
    "SegmentModified": 62104,
    "ContainedRepresentationNamesModified": 62105,
    "SegmentsOrderModified": 62106,  # not observed: the order means nothing to the export
}

#: The ids Slicer 5.12.4 defines: Libs/MRML/Core/vtkMRMLScene.h:692-726 (0x2000 + 1, + 3; state events
#: StateEvent | Start/EndEvent | state), vtkMRMLDisplayableNode.h:174, vtkMRMLModelNode.h:137,
#: vtkMRMLTransformableNode.h:73, and the five ``vtkSegmentation`` events the watcher observes, under
#: ``observers.MrmlEvents``'s field names.
EVENT_IDS = {
    "node_added": 0x2001,
    "node_removed": 0x2003,
    "start_batch": 0x2101,
    "end_batch": 0x2201,
    "end_close": 0x2203,
    "display_modified": 17000,
    "mesh_modified": 17001,
    "transform_modified": 15000,
    "segment_added": VTK_SEGMENTATION_EVENTS["SegmentAdded"],
    "segment_removed": VTK_SEGMENTATION_EVENTS["SegmentRemoved"],
    "segment_modified": VTK_SEGMENTATION_EVENTS["SegmentModified"],
    "representation_modified": VTK_SEGMENTATION_EVENTS["RepresentationModified"],
    "representation_names_modified": VTK_SEGMENTATION_EVENTS[
        "ContainedRepresentationNamesModified"
    ],
}


def event_id(name: str) -> int:
    """An event id by the watcher's field name (``EVENT_IDS``) or by Slicer's ``vtkSegmentation`` attribute name."""
    return EVENT_IDS[name] if name in EVENT_IDS else VTK_SEGMENTATION_EVENTS[name]


class Node(vtkObject):
    """An MRML node as the watcher reads it."""

    def __init__(self, node_id, *, cls="vtkMRMLModelNode", name="Liver", hidden=False, world=None):
        self.node_id, self.cls, self.name, self.hidden = node_id, cls, name, hidden
        self.world = np.eye(4) if world is None else world
        self.in_scene = True

    def GetID(self):  # noqa: N802 — the MRML API
        return self.node_id

    def GetClassName(self):  # noqa: N802
        return self.cls

    def IsA(self, name):  # noqa: N802
        return int(
            name == self.cls or (name == "vtkMRMLViewNode" and self.cls.endswith("ViewNode"))
        )

    def GetName(self):  # noqa: N802
        return self.name

    def GetHideFromEditors(self):  # noqa: N802
        return int(self.hidden)

    def GetScene(self):  # noqa: N802
        return object() if self.in_scene else None


class _VtkSegment:
    """A ``vtkSegment`` as the watcher reads it: its name."""

    def __init__(self, name):
        self.name = name

    def GetName(self):  # noqa: N802
        return self.name


class _VtkSegmentation:
    """The ``vtkSegmentation`` of a :class:`Segmentation`: the segment IDs as the watcher lists them, and each
    segment's name (``GetSegment(id).GetName()``)."""

    def __init__(self, owner):
        self._owner = owner

    def GetSegmentIDs(self):  # noqa: N802
        return tuple(self._owner.segments)

    def GetSegment(self, segment_id):  # noqa: N802
        if segment_id not in self._owner.segments:
            return None
        return _VtkSegment(self._owner.names.get(segment_id, segment_id))


class Segmentation(Node):
    """A ``vtkMRMLSegmentationNode`` as the watcher reads it: ``segments`` is the live list of segment IDs (a test
    edits it before firing a NULL event), ``names`` maps a segment ID to its name (a segment not in it is named after
    its ID; a test edits it to rename one before firing ``segment_modified``); :meth:`fire` invokes a
    ``vtkSegmentation`` event with the segment ID as call data (a ``str`` arrives as ``char*``) or without one (the
    NULL case, deferred at ``EndModify``)."""

    def __init__(self, node_id, *, segments=(), names=None, name="Segmentation", **kw):
        super().__init__(node_id, cls="vtkMRMLSegmentationNode", name=name, **kw)
        self.segments = list(segments)
        self.names = dict(names or {})
        self._segmentation = _VtkSegmentation(self)

    def GetSegmentation(self):  # noqa: N802
        return self._segmentation

    def fire(self, name: str, segment_id: str | None = None) -> None:
        if segment_id is None:
            self.InvokeEvent(event_id(name))
        else:
            self.InvokeEvent(event_id(name), segment_id)


class Scene(vtkObject):
    batch = False

    def __init__(self, *nodes):
        self.nodes = list(nodes)

    def IsBatchProcessing(self):  # noqa: N802
        return int(self.batch)

    def by_class(self, name):
        return [n for n in self.nodes if n.IsA(name)]

    def add(self, node):
        self.nodes.append(node)
        self.InvokeEvent(EVENT_IDS["node_added"], node)

    def remove(self, node):
        self.nodes.remove(node)
        node.in_scene = False
        self.InvokeEvent(EVENT_IDS["node_removed"], node)
