"""SLC-22, SLC-35: the Slicer scene adapter against fake MRML nodes (the calls of docs/research/slicer-scene.md for
models; v5.12.4 ``vtkMRMLSegmentationsDisplayableManager3D::vtkInternal`` for segments)."""

from __future__ import annotations

import logging
import sys

import numpy as np
import pytest
from support import (
    LEGEND_DISPLAY,
    SLICE_DISPLAY,
    FakeDisplay,
    FakeFolders,
    FakeModel,
    FakeSegDisplay,
    FakeSegment,
    FakeSegmentation,
    FakeView,
    leaks,
)
from support import (
    FakeMrmlTransform as FakeTransform,
)
from vtkmodules.vtkCommonDataModel import vtkPolyData
from vtkmodules.vtkCommonTransforms import vtkGeneralTransform, vtkTransform
from vtkmodules.vtkFiltersSources import vtkLineSource, vtkSphereSource

from remoteview_core.collect import SkipReason, collect_scene
from remoteview_core.mrml_scene import INVALID_DISPLAY_PROPS, MrmlSceneApi, SegmentRef


def scene(models, folders=None, views=("vtkMRMLViewNode1",), segmentations=()):
    """``nodes_by_class`` like ``slicer.util.getNodesByClass``: subclasses included, scene order."""
    by_class = {
        "vtkMRMLModelNode": list(models),
        "vtkMRMLSegmentationNode": list(segmentations),
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


# --------------------------------------------------------------------------- segments (SLC-35)

SEG = "vtkMRMLSegmentationNode1"


def segmentation(node_id=SEG, *, display=None, segments=None, **kw) -> FakeSegmentation:
    """A segmentation with ``Segment_1`` (3D opacity 0.8, colour red) and ``Segment_2`` (0.6, green), both with a
    sphere as their closed-surface representation, under a display node at 3D opacity 0.5."""
    if display is None:
        display = FakeSegDisplay(
            opacity_3d=0.5,
            per_segment={
                "Segment_1": {"opacity_3d": 0.8, "override_color": (1.0, 0.0, 0.0)},
                "Segment_2": {"opacity_3d": 0.6, "override_color": (0.0, 1.0, 0.0)},
            },
        )
    if segments is None:
        segments = [
            FakeSegment("Segment_1", name="Liver", polydata=sphere()),
            FakeSegment("Segment_2", name="Spleen", polydata=sphere()),
        ]
    return FakeSegmentation(node_id, displays=[display], segments=segments, **kw)


def handles(api, node) -> list[SegmentRef]:
    return [h for h in api.visible_segments() if h.node is node]


def test_mrml_scene_lists_shown_segments_in_slicers_order_after_the_models():
    node = segmentation()
    api, asked = scene([], segmentations=[node])
    assert api.visible_segments() == [SegmentRef(node, "Segment_1"), SegmentRef(node, "Segment_2")]
    assert api.segment_identity(SegmentRef(node, "Segment_2")) == (SEG, "Segment_2")
    assert api.name(SegmentRef(node, "Segment_2")) == "Spleen"
    assert "vtkMRMLSegmentationNode" in asked
    # the display getters were asked only with IDs GetSegmentIDs() returned (an unknown one logs a vtkError)
    assert set(node.displays[0].asked) <= {"Segment_1", "Segment_2"}


def test_mrml_scene_segment_opacity_is_the_four_factor_product_without_a_folder():
    """(a) ``hier_op (1.0) × GetSegmentOpacity3D × GetOpacity3D × display.GetOpacity``."""
    node = segmentation()
    api, _ = scene([], segmentations=[node])
    first, second = handles(api, node)
    assert api.display_props(first) == ((1.0, 0.0, 0.0), pytest.approx(0.8 * 0.5 * 1.0), True)
    assert api.display_props(second) == ((0.0, 1.0, 0.0), pytest.approx(0.6 * 0.5 * 1.0), True)
    node.displays[0].opacity = 0.5  # the generic display node's own opacity is the fourth factor
    assert api.display_props(first)[1] == pytest.approx(0.8 * 0.5 * 0.5)


def test_mrml_scene_segment_opacity_and_colour_under_an_overriding_folder():
    """(b) override allowed: the folder's opacity enters as the hierarchy opacity and again as the generic display
    node's — what ``UpdateDisplayNodePipeline`` reads (``[TODO verify]`` on screen, manual §13 step 6b); the folder's
    colour replaces the segment's."""
    node = segmentation()
    branch = FakeDisplay(color=(0.0, 0.0, 1.0), opacity=0.5)
    folders = FakeFolders(opacity={SEG: 0.5}, overriding={SEG: branch})
    api, _ = scene([], folders, segmentations=[node])
    first, _ = handles(api, node)
    assert api.display_props(first) == ((0.0, 0.0, 1.0), pytest.approx(0.5 * 0.8 * 0.5 * 0.5), True)


def test_mrml_scene_folder_colour_applies_even_when_the_display_node_opts_out():
    """(c) ``GetFolderDisplayOverrideAllowed`` false: the folders are ignored for opacity and visibility, but the DM's
    colour branch is not gated — the folder colour still applies (unlike the model path of the same adapter)."""
    display = FakeSegDisplay(
        opacity_3d=0.5,
        folders_apply=False,
        per_segment={"Segment_1": {"opacity_3d": 0.8, "override_color": (1.0, 0.0, 0.0)}},
    )
    node = segmentation(display=display, segments=[FakeSegment("Segment_1", polydata=sphere())])
    branch = FakeDisplay(color=(0.0, 0.0, 1.0), opacity=0.5)
    folders = FakeFolders(opacity={SEG: 0.5}, hidden={SEG}, overriding={SEG: branch})
    api, _ = scene([], folders, segmentations=[node])
    [first] = handles(api, node)  # the hidden folder is ignored too
    assert api.display_props(first) == ((0.0, 0.0, 1.0), pytest.approx(0.8 * 0.5 * 1.0), True)
    # the model path keeps its gated reading: an opted-out model ignores the folder's colour
    model = FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay(folders_apply=False)])
    folders.overriding["vtkMRMLModelNode1"] = branch
    api, _ = scene([model], folders)
    assert api.display_props(model)[0] == (1.0, 0.5, 0.25)


@pytest.mark.parametrize(
    "case",
    [
        "show-3d-off",
        "opacity-3d-zero",
        "eye-closed",
        "not-3d",
        "hidden-folder",
        "hidden-from-editors",
        "no-3d-view",
        "subclass",
        "no-display",
    ],
)
def test_mrml_scene_a_segmentation_that_is_not_drawn_yields_nothing(case):
    kw: dict = {}
    display_kw: dict = {}
    views = ("vtkMRMLViewNode1",)
    folders = FakeFolders()
    if case == "show-3d-off":
        display_kw = {"representation_3d": ""}
    elif case == "opacity-3d-zero":
        display_kw = {"opacity_3d": 0.0}  # IsVisible: unlike a model at opacity 0
    elif case == "eye-closed":
        display_kw = {"visible": 0}
    elif case == "not-3d":
        display_kw = {"visible_3d": 0}
    elif case == "hidden-folder":
        folders = FakeFolders(hidden={SEG})
    elif case == "hidden-from-editors":
        kw = {"hidden_from_editors": 1}
    elif case == "no-3d-view":
        views = ()
    elif case == "subclass":
        kw = {"cls": "vtkMRMLSomeSegmentationNode"}
    display = FakeSegDisplay(**({"opacity_3d": 0.5} | display_kw))
    node = segmentation(display=display, **kw)
    if case == "no-display":
        node.displays = []
    api, _ = scene([], folders, views=views, segmentations=[node])
    assert api.visible_segments() == []
    assert node.segmentation.created == []  # never converted
    if case in ("opacity-3d-zero", "eye-closed", "not-3d", "hidden-folder", "no-3d-view"):
        # the display rules also say so for a held segment (SLC-36 reads them); the node-level filters (class,
        # hidden from editors) and Show 3D are the list's business, not the display node's
        assert api.display_props(SegmentRef(node, "Segment_1"))[2] is False
    if case == "no-display":
        assert api.display_props(SegmentRef(node, "Segment_1")) == ((0.0, 0.0, 0.0), 0.0, False)


def test_mrml_scene_a_hidden_segment_is_left_out_and_its_sibling_listed():
    display = FakeSegDisplay(
        opacity_3d=0.5,
        per_segment={"Segment_1": {"visible_3d": 0}, "Segment_2": {"opacity_3d": 0.6}},
    )
    node = segmentation(display=display)
    api, _ = scene([], segmentations=[node])
    assert api.visible_segments() == [SegmentRef(node, "Segment_2")]
    assert api.display_props(SegmentRef(node, "Segment_1"))[2] is False
    display.per_segment["Segment_1"] = {"visible": 0}
    assert api.visible_segments() == [SegmentRef(node, "Segment_2")]
    # a hidden folder with override allowed hides every segment; not allowed, they are listed
    folders = FakeFolders(hidden={SEG})
    api, _ = scene([], folders, segmentations=[node])
    assert api.visible_segments() == []
    display.folders_apply = False
    assert api.visible_segments() == [SegmentRef(node, "Segment_2")]


def test_mrml_scene_segment_geometry_is_the_live_representation_never_created():
    mesh = sphere()
    node = segmentation(
        segments=[FakeSegment("Segment_1", polydata=mesh), FakeSegment("Segment_2")]
    )
    api, _ = scene([], segmentations=[node])
    first, second = handles(api, node)
    assert api.polydata(first) is mesh  # identity: the DM's polydata, not a copy
    assert api.polydata(second) is None  # no representation yet
    assert node.segmentation.representation_reads == [
        ("Segment_1", "Closed surface"),
        ("Segment_2", "Closed surface"),
    ]
    assert node.segmentation.created == []
    assert not hasattr(node, "CreateClosedSurfaceRepresentation") or node.created == []
    collected = collect_scene(api)
    assert [(e.node_id, e.kind, e.mrml_id, e.segment_id) for e in collected.entities] == [
        (f"{SEG}/Segment_1", "segment", SEG, "Segment_1")
    ]
    assert [(s.node_id, s.reason, s.index) for s in collected.skipped] == [
        (f"{SEG}/Segment_2", SkipReason.NO_TRIANGLES, 1)
    ]
    # an empty polydata and a planar contour (lines) are no-triangles too; Show 3D switched off since the list was
    # read gives no mesh
    line = vtkLineSource()
    line.Update()
    node.segmentation.segments[1].mesh = line.GetOutput()
    node.segmentation.segments[0].mesh = vtkPolyData()
    assert [s.reason for s in collect_scene(api).skipped] == [SkipReason.NO_TRIANGLES] * 2
    node.displays[0].representation_3d = ""
    assert api.polydata(first) is None
    assert node.segmentation.created == []


def test_mrml_scene_segment_transform_is_the_nodes_like_a_model():
    linear = FakeTransform([[1, 0, 0, 10], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    node = segmentation(transform=linear)
    api, _ = scene([], segmentations=[node])
    first, second = handles(api, node)
    assert np.array_equal(api.world_matrix(first), linear.matrix)
    assert np.array_equal(api.world_matrix(second), linear.matrix)
    warped = segmentation(
        "vtkMRMLSegmentationNode2", transform=FakeTransform(None, warp=_shift(1, 2, 3))
    )
    api, _ = scene([], segmentations=[warped])
    [first, _] = handles(api, warped)
    assert api.world_matrix(first) is None
    assert api.world_transform(first).TransformPoint(0.0, 0.0, 0.0) == pytest.approx(
        (1.0, 2.0, 3.0)
    )
    assert api.world_transform(SegmentRef(segmentation("vtkMRMLSegmentationNode3"), "x")) is None


class _BrokenColorDisplay(FakeSegDisplay):
    def GetSegmentColor(self, segment_id):  # noqa: N802
        if segment_id == "Segment_1":
            raise TypeError(
                "GetSegmentColor() takes 2 arguments"
            )  # a binding other than the one probed
        return super().GetSegmentColor(segment_id)


def test_mrml_scene_a_segment_whose_colour_binding_fails_is_invalid_display_only(caplog):
    display = _BrokenColorDisplay(
        opacity_3d=0.5,
        per_segment={"Segment_1": {"opacity_3d": 0.8}, "Segment_2": {"opacity_3d": 0.6}},
    )
    node = segmentation(display=display)
    model = FakeModel("vtkMRMLModelNode1", displays=[FakeDisplay()], polydata=sphere())
    api, _ = scene([model], segmentations=[node])
    first, second = handles(api, node)
    with caplog.at_level(logging.DEBUG):
        props = api.display_props(first)
    assert props == INVALID_DISPLAY_PROPS and props[1] != props[1]  # NaN opacity
    assert api.display_props(second)[1] == pytest.approx(0.3)
    assert (
        "TypeError" in caplog.text and "Segment_1" not in caplog.text and "Liver" not in caplog.text
    )
    collected = collect_scene(api)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode1", f"{SEG}/Segment_2"]
    assert [(s.node_id, s.reason) for s in collected.skipped] == [
        (f"{SEG}/Segment_1", SkipReason.INVALID_DISPLAY)
    ]


@pytest.mark.parametrize("bad", [(1.0, 0.0), (1.0, 0.0, float("nan")), "red"])
def test_mrml_scene_a_colour_that_is_not_three_finite_floats_is_invalid_display(bad):
    display = FakeSegDisplay(per_segment={"Segment_1": {"override_color": bad}})
    node = segmentation(display=display, segments=[FakeSegment("Segment_1", polydata=sphere())])
    api, _ = scene([], segmentations=[node])
    assert api.display_props(SegmentRef(node, "Segment_1")) == INVALID_DISPLAY_PROPS


# --------------------------------------------------------------------------- the module logic builds it from Slicer


def test_mrml_scene_adapter_uses_slicers_functions(import_remote_view, slicer_stubs, monkeypatch):
    model = FakeModel("vtkMRMLModelNode4", displays=[FakeDisplay()])
    nodes = {
        "vtkMRMLModelNode": [model],
        "vtkMRMLSegmentationNode": [],
        "vtkMRMLViewNode": [FakeView("vtkMRMLViewNode1")],
    }
    slicer = slicer_stubs["slicer"]
    monkeypatch.setattr(slicer.util, "getNodesByClass", nodes.__getitem__, raising=False)
    monkeypatch.setattr(slicer, "vtkMRMLFolderDisplayNode", FakeFolders(), raising=False)
    api = import_remote_view().RemoteViewLogic().sceneApi()
    assert api.visible_model_nodes() == [model]


# --------------------------------------------------------------------------- SLC-36 (the SLC-35 review)


def test_mrml_scene_segment_ref_repr_hides_the_segment_id():
    """SLC-36 passes handles into the classifier: a raw segment ID may be PHI (T7)."""
    handle = SegmentRef(segmentation(), "Liver_DoeJohn")
    assert repr(handle) == "SegmentRef(node=<FakeSegmentation>, segment_id=<hidden>)"
    assert "Liver_DoeJohn" not in repr([handle]) and handle.segment_id == "Liver_DoeJohn"


class _BrokenVisibilityDisplay(FakeSegDisplay):
    def GetSegmentVisibility3D(self, segment_id):  # noqa: N802
        if segment_id == "Segment_1":
            raise TypeError("GetSegmentVisibility3D() takes 2 arguments")
        return super().GetSegmentVisibility3D(segment_id)


def test_mrml_scene_a_segment_whose_visibility_binding_fails_is_listed_as_invalid_display(caplog):
    """The listing's per-segment getters are guarded like the display properties: one segment is reported, the
    rest of the scene ships."""
    node = segmentation(display=_BrokenVisibilityDisplay(opacity_3d=0.5))
    api, _ = scene([], segmentations=[node])
    with caplog.at_level(logging.DEBUG):
        collected = collect_scene(api)
    assert [e.node_id for e in collected.entities] == [f"{SEG}/Segment_2"]
    assert [(s.node_id, s.reason) for s in collected.skipped] == [
        (f"{SEG}/Segment_1", SkipReason.INVALID_DISPLAY)
    ]
    assert "TypeError" in caplog.text and "Segment_1" not in caplog.text


class LoggingSegDisplay(FakeSegDisplay):
    """A display node whose per-segment getters, asked about a segment the segmentation no longer has, print its ID
    the way Slicer v5.12.4's do (``vtkErrorMacro`` in ``vtkMRMLSegmentationDisplayNode``: "No display properties
    found" from ``GetSegmentVisibility``/``GetSegmentOpacity3D``, "segment not found by id" from
    ``GetSegmentColor``)."""

    def __init__(self, segmentation: FakeSegmentation, **kw) -> None:
        super().__init__(**kw)
        self._segmentation = segmentation

    def _props(self, segment_id):
        if self._segmentation.GetSegmentation().GetSegment(segment_id) is None:
            print(
                f"ERROR: GetSegmentVisibility: no display properties for segment {segment_id}",
                file=sys.stderr,
            )
        return super()._props(segment_id)


def test_mrml_scene_a_segment_removed_while_preparing_asks_no_display_getter(caplog, capfd):
    """SLC-71: a segment removed after the list was read — between two preparation steps — reads as not shown and
    without a mesh, and no per-segment display getter is asked with its ID: Slicer's would print it, and a segment ID
    may be name-derived (T7). The collection then leaves it out."""
    node = segmentation(
        segments=[
            FakeSegment("Segment_1", name="Liver", polydata=sphere()),
            FakeSegment("Doe tumour", name="Doe tumour", polydata=sphere()),
        ]
    )
    display = LoggingSegDisplay(node, opacity_3d=0.5)
    node.displays = [display]
    api, _ = scene([], segmentations=[node])
    [kept, removed] = handles(api, node)
    node.segmentation.segments = node.segmentation.segments[:1]  # "Doe tumour" removed
    display.asked.clear()
    assert api.display_props(removed) == ((0.0, 0.0, 0.0), 0.0, False)
    assert api.polydata(removed) is None and api.name(removed) is None
    assert api.display_props(kept)[2] is True
    assert display.asked and "Doe tumour" not in display.asked
    assert leaks(caplog, capfd, "Doe", "tumour") == []
