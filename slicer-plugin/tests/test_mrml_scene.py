"""SLC-22: the Slicer scene adapter against fake MRML nodes (the calls of docs/research/slicer-scene.md)."""

from __future__ import annotations

import numpy as np
import pytest
from support import (
    LEGEND_DISPLAY,
    SLICE_DISPLAY,
    FakeDisplay,
    FakeFolders,
    FakeModel,
    FakeView,
)
from support import (
    FakeMrmlTransform as FakeTransform,
)
from vtkmodules.vtkCommonTransforms import vtkGeneralTransform, vtkTransform
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core.collect import collect_scene
from remoteview_core.mrml_scene import MrmlSceneApi


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


def _shift(x: float, y: float, z: float) -> vtkTransform:
    transform = vtkTransform()
    transform.Translate(x, y, z)
    return transform


def test_mrml_scene_world_transform_is_the_3d_views():
    """GetTransformToWorld into an identity vtkGeneralTransform, as the model displayable manager does (SLC-13)."""
    api, _ = scene([])
    assert api.world_transform(FakeModel("a")) is None
    general = api.world_transform(
        FakeModel("b", transform=FakeTransform(None, warp=_shift(1, 2, 3)))
    )
    assert isinstance(general, vtkGeneralTransform)
    assert general.TransformPoint(10.0, 20.0, 30.0) == pytest.approx((11.0, 22.0, 33.0))
    assert api.world_transform(FakeModel("c", transform=FakeTransform(None))).TransformPoint(
        1.0, 2.0, 3.0
    ) == pytest.approx((1.0, 2.0, 3.0))  # starts from the identity


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
    warped = FakeModel(
        "vtkMRMLModelNode7",
        displays=[FakeDisplay()],
        transform=FakeTransform(None, warp=_shift(0, 0, 50)),
        polydata=sphere(),
    )
    grid = FakeModel(
        "vtkMRMLModelNode6", displays=[FakeDisplay()], polydata=None
    )  # unstructured grid
    api, _ = scene([liver, hidden, grid, warped])
    collected = collect_scene(api)
    entity, baked = collected.entities
    assert (entity.node_id, entity.name, entity.color, entity.opacity, entity.visible) == (
        "vtkMRMLModelNode4",
        "Liver",
        (0.8, 0.3, 0.2),
        pytest.approx(0.9),
        True,
    )
    # 100 mm along R → 0.1 m along glTF +X (protocol §7.2)
    assert entity.matrix is not None and entity.matrix[0][3] == pytest.approx(0.1)
    assert len(entity.indices) > 0 and not entity.baked
    # the non-linear chain is baked: 50 mm along S → 0.05 m along glTF +Y, no matrix (§7.3)
    assert baked.baked and baked.matrix is None
    assert baked.positions[:, 1].mean() == pytest.approx(0.003 + 0.05, abs=1e-6)
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
