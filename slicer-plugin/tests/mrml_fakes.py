"""MRML fakes with VTK's own event dispatch, shared by ``test_observers`` and ``test_panel_live`` (SLC-31, SLC-32).

The scene and the nodes are Python subclasses of ``vtkObject``: ``AddObserver``, ``InvokeEvent`` (with or without call
data) and ``RemoveObserver`` are VTK's own, so the handlers see what Slicer gives them. numpy, vtkmodules and the
standard library only.
"""

from __future__ import annotations

import numpy as np
from vtkmodules.vtkCommonCore import vtkObject

#: The ids Slicer 5.12.4 defines: Libs/MRML/Core/vtkMRMLScene.h:692-726 (0x2000 + 1, + 3; state events
#: StateEvent | Start/EndEvent | state), vtkMRMLDisplayableNode.h:174, vtkMRMLModelNode.h:137,
#: vtkMRMLTransformableNode.h:73.
EVENT_IDS = {
    "node_added": 0x2001,
    "node_removed": 0x2003,
    "start_batch": 0x2101,
    "end_batch": 0x2201,
    "end_close": 0x2203,
    "display_modified": 17000,
    "mesh_modified": 17001,
    "transform_modified": 15000,
}


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
