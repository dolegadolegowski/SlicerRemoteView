"""SLC-22: the Slicer scene adapter against fake MRML nodes (the calls of docs/research/slicer-scene.md)."""

from __future__ import annotations

import numpy as np
import pytest
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core.collect import collect_scene
from remoteview_core.mrml_scene import MrmlSceneApi

MODEL_DISPLAY = ("vtkMRMLModelDisplayNode", "vtkMRMLDisplayNode", "vtkMRMLNode")
SLICE_DISPLAY = ("vtkMRMLSliceDisplayNode", *MODEL_DISPLAY)
LEGEND_DISPLAY = ("vtkMRMLColorLegendDisplayNode", "vtkMRMLDisplayNode", "vtkMRMLNode")


class FakeDisplay:
    """A display node: ``IsA`` walks ``classes`` like VTK's class hierarchy."""

    def __init__(  # noqa: PLR0913 — one keyword per MRML property
        self,
        classes=MODEL_DISPLAY,
        *,
        visible=1,
        visible_3d=1,
        color=(1.0, 0.5, 0.25),
        opacity=0.8,
        views=(),
        folders_apply=True,
    ):
        self.classes, self.visible, self.visible_3d = classes, visible, visible_3d
        self.color, self.opacity, self.views, self.folders_apply = (
            color,
            opacity,
            views,
            folders_apply,
        )

    def IsA(self, name):  # noqa: N802 — MRML's names
        return int(name in self.classes)

    def GetVisibility(self):  # noqa: N802
        return self.visible

    def GetVisibility3D(self):  # noqa: N802
        return self.visible_3d

    def GetColor(self):  # noqa: N802
        return self.color

    def GetOpacity(self):  # noqa: N802
        return self.opacity

    def GetNumberOfViewNodeIDs(self):  # noqa: N802
        return len(self.views)

    def IsDisplayableInView(self, view_id):  # noqa: N802
        return not self.views or view_id in self.views

    def GetFolderDisplayOverrideAllowed(self):  # noqa: N802
        return self.folders_apply


class FakeTransform:
    def __init__(self, matrix=None):
        self.matrix = matrix  # None = non-linear chain
        self.asked = 0

    def IsTransformToWorldLinear(self):  # noqa: N802
        return int(self.matrix is not None)

    def GetMatrixTransformToWorld(self, out):  # noqa: N802
        self.asked += 1
        out.DeepCopy([v for row in self.matrix for v in row])
        return 1


class FakeModel:
    def __init__(  # noqa: PLR0913
        self,
        node_id,
        *,
        name="Liver",
        displays=(),
        cls="vtkMRMLModelNode",
        hidden_from_editors=0,
        transform=None,
        polydata=None,
    ):
        self.node_id, self.node_name, self.displays, self.cls = node_id, name, list(displays), cls
        self.hidden_from_editors, self.transform, self.mesh = (
            hidden_from_editors,
            transform,
            polydata,
        )

    def GetClassName(self):  # noqa: N802
        return self.cls

    def GetHideFromEditors(self):  # noqa: N802
        return self.hidden_from_editors

    def GetNumberOfDisplayNodes(self):  # noqa: N802
        return len(self.displays)

    def GetNthDisplayNode(self, index):  # noqa: N802
        return self.displays[index]

    def GetID(self):  # noqa: N802
        return self.node_id

    def GetName(self):  # noqa: N802
        return self.node_name

    def GetPolyData(self):  # noqa: N802
        return self.mesh

    def GetParentTransformNode(self):  # noqa: N802
        return self.transform


class FakeView:
    def __init__(self, view_id):
        self.view_id = view_id

    def GetID(self):  # noqa: N802
        return self.view_id


class FakeFolders:
    """``slicer.vtkMRMLFolderDisplayNode``'s static methods, per model node."""

    def __init__(self, hidden=(), opacity=None, overriding=None):
        self.hidden, self.opacity, self.overriding = set(hidden), opacity or {}, overriding or {}

    def GetHierarchyVisibility(self, node):  # noqa: N802
        return node.node_id not in self.hidden

    def GetHierarchyOpacity(self, node):  # noqa: N802
        return self.opacity.get(node.node_id, 1.0)

    def GetOverridingHierarchyDisplayNode(self, node):  # noqa: N802
        return self.overriding.get(node.node_id)


def scene(models, folders=None, views=("vtkMRMLViewNode1",)):
    """``nodes_by_class`` like ``slicer.util.getNodesByClass``: subclasses included, scene order."""
    by_class = {
        "vtkMRMLModelNode": list(models),
        "vtkMRMLViewNode": [FakeView(v) for v in views],
    }
    asked = []

    def nodes_by_class(class_name):
        asked.append(class_name)
        return by_class[class_name]

    api = MrmlSceneApi(nodes_by_class, folders or FakeFolders())
    return api, asked


def sphere():
    source = vtkSphereSource()
    source.SetRadius(10.0)
    source.SetCenter(1.0, 2.0, 3.0)
    source.Update()
    return source.GetOutput()


# --------------------------------------------------------------------------- which nodes leave the PC


def test_mrml_scene_exports_only_what_the_3d_view_shows():
    shown = FakeModel("vtkMRMLModelNode4", displays=[FakeDisplay()])
    models = [
        FakeModel(
            "vtkMRMLModelNode1", displays=[FakeDisplay()], hidden_from_editors=1
        ),  # slice plane
        FakeModel("vtkMRMLAnnotationNode2", displays=[FakeDisplay()], cls="vtkMRMLAnnotationNode"),
        FakeModel("vtkMRMLModelNode3", displays=[]),  # no display node
        shown,
        FakeModel("vtkMRMLModelNode5", displays=[FakeDisplay(visible=0)]),  # eye closed
        FakeModel("vtkMRMLModelNode6", displays=[FakeDisplay(visible_3d=0)]),  # 2D only
        FakeModel("vtkMRMLModelNode7", displays=[FakeDisplay()]),  # in a hidden folder
        FakeModel("vtkMRMLModelNode8", displays=[FakeDisplay(views=("vtkMRMLSliceNodeRed",))]),
        FakeModel("vtkMRMLModelNode9", displays=[FakeDisplay(SLICE_DISPLAY)]),
        FakeModel("vtkMRMLModelNode10", displays=[None, FakeDisplay(LEGEND_DISPLAY)]),
    ]
    api, asked = scene(models, FakeFolders(hidden={"vtkMRMLModelNode7"}))
    assert api.visible_model_nodes() == [shown]
    assert set(asked) == {"vtkMRMLModelNode", "vtkMRMLViewNode"}


def test_mrml_scene_follows_display_node_choices():
    # a node shown only in a 3D view that exists; one whose folder override is switched off ignores the hidden folder
    in_view = FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay(views=("vtkMRMLViewNode2",))])
    own_rules = FakeModel("vtkMRMLModelNode2", displays=[FakeDisplay(folders_apply=False)])
    # the first model display node is hidden, the second (another view's) is shown: the shown one counts
    second = FakeDisplay(color=(0.0, 1.0, 0.0))
    two = FakeModel(
        "vtkMRMLModelNode3",
        displays=[FakeDisplay(LEGEND_DISPLAY), FakeDisplay(visible=0), second],
    )
    folders = FakeFolders(hidden={"vtkMRMLModelNode2", "vtkMRMLModelNode3"})
    api, _ = scene(
        [in_view, own_rules, two], folders, views=("vtkMRMLViewNode1", "vtkMRMLViewNode2")
    )
    assert api.visible_model_nodes() == [in_view, own_rules]
    folders.hidden.discard("vtkMRMLModelNode3")
    assert api.visible_model_nodes() == [in_view, own_rules, two]
    assert api.display_props(two)[0] == (0.0, 1.0, 0.0)


def test_mrml_scene_shows_nothing_without_a_3d_view():
    api, _ = scene([FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay()])], views=())
    assert api.visible_model_nodes() == []


def test_mrml_scene_display_props_say_when_a_node_is_hidden():
    """The visible flag of a node a later snapshot or ``scene.update`` reads again (SLC-16)."""
    eye_closed = FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay(visible=0)])
    in_hidden_folder = FakeModel("vtkMRMLModelNode2", displays=[FakeDisplay()])
    no_display = FakeModel("vtkMRMLModelNode3", displays=[FakeDisplay(LEGEND_DISPLAY)])
    first = FakeDisplay(color=(0.0, 0.0, 1.0))
    two_shown = FakeModel("vtkMRMLModelNode4", displays=[first, FakeDisplay(color=(1.0, 0.0, 0.0))])
    api, _ = scene(
        [eye_closed, in_hidden_folder, no_display, two_shown],
        FakeFolders(hidden={"vtkMRMLModelNode2"}),
    )
    assert api.display_props(eye_closed)[2] is False
    assert api.display_props(in_hidden_folder)[2] is False
    assert api.display_props(no_display) == ((0.0, 0.0, 0.0), 0.0, False)
    assert api.display_props(two_shown) == (
        (0.0, 0.0, 1.0),
        0.8,
        True,
    )  # the first shown display node


def test_mrml_scene_display_props_match_the_3d_view():
    plain = FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay(opacity=0.8)])
    in_folder = FakeModel("vtkMRMLModelNode2", displays=[FakeDisplay(opacity=0.8)])
    overridden = FakeModel("vtkMRMLModelNode3", displays=[FakeDisplay(opacity=0.8)])
    opted_out = FakeModel(
        "vtkMRMLModelNode4", displays=[FakeDisplay(opacity=0.8, folders_apply=False)]
    )
    branch = FakeDisplay(color=(0.1, 0.2, 0.3), opacity=0.5)
    folders = FakeFolders(
        opacity={"vtkMRMLModelNode2": 0.5, "vtkMRMLModelNode3": 0.5, "vtkMRMLModelNode4": 0.25},
        overriding={"vtkMRMLModelNode3": branch, "vtkMRMLModelNode4": branch},
    )
    api, _ = scene([plain, in_folder, overridden, opted_out], folders)
    assert api.display_props(plain) == ((1.0, 0.5, 0.25), 0.8, True)
    assert api.display_props(in_folder) == ((1.0, 0.5, 0.25), 0.4, True)
    # an "apply to branch" folder replaces colour and opacity; like the 3D view, its opacity also counts as a folder's
    assert api.display_props(overridden) == ((0.1, 0.2, 0.3), 0.25, True)
    assert api.display_props(opted_out) == ((1.0, 0.5, 0.25), 0.8, True)


def test_mrml_scene_world_matrix():
    linear = FakeTransform([[0, -1, 0, 10], [1, 0, 0, -20], [0, 0, 1, 30], [0, 0, 0, 1]])
    warped = FakeTransform(None)
    api, _ = scene([])
    assert np.array_equal(api.world_matrix(FakeModel("a")), np.eye(4))
    assert np.array_equal(
        api.world_matrix(FakeModel("b", transform=linear)), linear.matrix
    )  # row-major
    assert api.world_matrix(FakeModel("c", transform=warped)) is None
    assert warped.asked == 0  # Slicer logs errors when asked for a non-linear chain's matrix


# --------------------------------------------------------------------------- collect_scene over the adapter


def test_mrml_scene_feeds_collect_scene():
    shift = FakeTransform([[1, 0, 0, 100], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    liver = FakeModel(
        "vtkMRMLModelNode4",
        name="Liver",
        displays=[FakeDisplay(color=(0.8, 0.3, 0.2), opacity=0.9)],
        transform=shift,
        polydata=sphere(),
    )
    hidden = FakeModel("vtkMRMLModelNode5", displays=[FakeDisplay(visible=0)], polydata=sphere())
    grid = FakeModel(
        "vtkMRMLModelNode6", displays=[FakeDisplay()], polydata=None
    )  # unstructured grid
    api, _ = scene([liver, hidden, grid])
    collected = collect_scene(api)
    [entity] = collected.entities
    assert (entity.node_id, entity.name, entity.color, entity.opacity, entity.visible) == (
        "vtkMRMLModelNode4",
        "Liver",
        (0.8, 0.3, 0.2),
        pytest.approx(0.9),
        True,
    )
    # 100 mm along R → 0.1 m along glTF +X (protocol §7.2)
    assert entity.matrix is not None and entity.matrix[0][3] == pytest.approx(0.1)
    assert len(entity.indices) > 0
    # the hidden node never reaches collect; the grid model is reported as having no triangles
    assert [(s.node_id, s.reason.value) for s in collected.skipped] == [
        ("vtkMRMLModelNode6", "no-triangles")
    ]


# --------------------------------------------------------------------------- the module logic builds it from Slicer


def test_mrml_scene_adapter_uses_slicers_functions(import_remote_view, slicer_stubs, monkeypatch):
    model = FakeModel("vtkMRMLModelNode4", displays=[FakeDisplay()])
    nodes = {"vtkMRMLModelNode": [model], "vtkMRMLViewNode": [FakeView("vtkMRMLViewNode1")]}
    slicer = slicer_stubs["slicer"]
    monkeypatch.setattr(slicer.util, "getNodesByClass", nodes.__getitem__, raising=False)
    monkeypatch.setattr(slicer, "vtkMRMLFolderDisplayNode", FakeFolders(), raising=False)
    api = import_remote_view().RemoteViewLogic().sceneApi()
    assert api.visible_model_nodes() == [model]
