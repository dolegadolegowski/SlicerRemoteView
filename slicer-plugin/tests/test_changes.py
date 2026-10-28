"""SLC-30: classify drained scene changes against the scene and what the viewers hold (protocol §7.3, §8; FR-11,
FR-12; T7)."""

from __future__ import annotations

import logging
import traceback

import numpy as np
import pytest
from pygltflib import GLTF2
from support import FakeScene, LiveScene, ack, live_client, small_sphere, sphere
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkCommonTransforms import vtkTransform
from vtkmodules.vtkFiltersSources import vtkLineSource

from remoteview_core.changes import (
    IDENTITY,
    Plan,
    SceneReadError,
    SentNode,
    SentScene,
    SkipInfo,
    classify,
)
from remoteview_core.collect import SkipReason, collect_scene, polydata_from_triangles
from remoteview_core.coords import gltf_matrix_column_major, ras_matrix_to_gltf
from remoteview_core.debounce import Change, DirtySet, Drained
from remoteview_core.glb_writer import RootExtras, write_glb
from remoteview_core.protocol_client import NodeChange
from remoteview_core.snapshot import SnapshotTooLargeError, build_snapshot
from remoteview_protocol import schemas

ROOT = RootExtras(scene_version=1, profile="mobile", slicer_version="5.12.4")
MESH = small_sphere()  # LiveScene's default mesh
SHEAR = np.array([[1.0, 0.5, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
COLLAPSE = np.diag([0.0, 0.0, 0.0, 1.0])  # every triangle loses its area once baked


def _line():
    source = vtkLineSource()
    source.Update()
    return source.GetOutput()


LINE = _line()  # a centre line: no triangles
DEGENERATE = polydata_from_triangles(
    np.array([[0.0, 0, 0], [1, 0, 0], [2, 0, 0]]), np.array([[0, 1, 2]])
)


def moved(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> np.ndarray:
    world = np.eye(4)
    world[:3, 3] = (x, y, z)
    return world


def gltf(world: np.ndarray) -> tuple[float, ...]:
    return tuple(gltf_matrix_column_major(ras_matrix_to_gltf(world)))


def warp() -> vtkTransform:
    t = vtkTransform()
    t.Translate(1.0, 2.0, 3.0)
    return t


def exported(scene: LiveScene, *, anonymize: bool = False) -> SentScene:
    """The viewers' scene after an export of ``scene`` (what ``Snapshot.sent`` holds)."""
    collected = collect_scene(scene, anonymize_names=anonymize)
    return SentScene.from_export(
        collected.entities, collected.skipped, anonymized=collected.anonymized_names
    )


def drained(*marks: tuple[str, Change], reset: bool = False) -> Drained:
    dirty = DirtySet()
    if reset:
        dirty.reset()
    for node_id, flags in marks:
        dirty.mark(node_id, flags)
    return dirty.drain()


def plan_of(
    scene: LiveScene, sent: SentScene, *marks, anonymize: bool = False, reset: bool = False
) -> Plan:
    return classify(drained(*marks, reset=reset), scene, sent, anonymize_names=anonymize)


# --------------------------------------------------------------------------- criterion 1: updates


def test_changes_appearance_transform_and_removal():
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5"}, {"id": "vtkMRMLModelNode6"}
    )
    sent = exported(scene)
    reads = scene.meshes
    scene.node("vtkMRMLModelNode4")["color"] = (0.1, 0.9, 0.2)
    scene.node("vtkMRMLModelNode5")["world"] = moved(10.0, -4.0, 2.5)
    scene.remove("vtkMRMLModelNode6")
    plan = plan_of(
        scene,
        sent,
        ("vtkMRMLModelNode4", Change.APPEARANCE),
        ("vtkMRMLModelNode5", Change.TRANSFORM),
        ("vtkMRMLModelNode6", Change.REMOVED),
    )
    assert not plan.snapshot and plan.removed == ("vtkMRMLModelNode6",)
    a, b = plan.changes
    assert a == NodeChange("vtkMRMLModelNode4", color=(0.1, 0.9, 0.2))
    assert b.node_id == "vtkMRMLModelNode5" and (b.color, b.opacity, b.visible) == (
        None,
        None,
        None,
    )
    # the matrix the GLB writer writes for node 5 once it moved
    entity = next(e for e in collect_scene(scene).entities if e.node_id == "vtkMRMLModelNode5")
    document = GLTF2.load_from_bytes(write_glb([entity], ROOT))
    assert (
        list(b.matrix)
        == document.nodes[document.nodes[0].children[0]].matrix
        == list(gltf(moved(10.0, -4.0, 2.5)))
    )
    assert (
        scene.meshes == reads + 2
    )  # the collect above (two nodes) only: the classifier read no mesh


def test_changes_are_valid_scene_update_items():
    """Wired to SLC-16: the plan's items become a schema-valid scene.update and scene.nodeRemoved."""
    compiled = schemas.compile_schemas()
    client = live_client("mobile", validate=lambda m: schemas.validate_message(m, None, compiled))
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5"})
    snapshot = build_snapshot(scene, client, slicer_version="5.12.4")
    client.handle(ack(snapshot.scene_version))
    scene.node("vtkMRMLModelNode4").update(opacity=0.25, world=moved(3.0))
    scene.remove("vtkMRMLModelNode5")
    plan = plan_of(
        scene,
        snapshot.sent,
        ("vtkMRMLModelNode4", Change.APPEARANCE | Change.TRANSFORM),
        ("vtkMRMLModelNode5", Change.REMOVED),
    )
    update, removal = client.send_changes(plan.changes) + client.send_removed(plan.removed)
    assert update["changes"] == [
        {"nodeId": "vtkMRMLModelNode4", "opacity": 0.25, "matrix": list(gltf(moved(3.0)))}
    ]
    assert removal["nodeIds"] == ["vtkMRMLModelNode5"]


def test_changes_a_transform_back_to_identity_sends_the_identity():
    scene = LiveScene({"id": "vtkMRMLModelNode4", "world": moved(5.0)})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4")["world"] = np.eye(4)
    [change] = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.TRANSFORM)).changes
    assert change.matrix == IDENTITY == (1.0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)


def test_changes_a_baked_node_gets_display_updates():
    """Baked (sheared here): only its pose needs a re-export — colour, opacity and visibility are updates."""
    scene = LiveScene({"id": "vtkMRMLModelNode4", "world": SHEAR})
    sent = exported(scene)
    assert sent.get("vtkMRMLModelNode4").matrix is None
    scene.node("vtkMRMLModelNode4").update(opacity=0.5, color=(0.0, 0.0, 1.0))
    plan = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan == Plan(
        changes=(NodeChange("vtkMRMLModelNode4", opacity=0.5, color=(0.0, 0.0, 1.0)),)
    )


def test_changes_plans_with_something_to_send_are_true():
    assert Plan(removed=("vtkMRMLModelNode4",)) and Plan(snapshot=True)
    assert Plan(changes=(NodeChange("vtkMRMLModelNode4", opacity=0.5),))
    assert not Plan() and not Plan(forget=("vtkMRMLModelNode4",))


def test_changes_only_what_differs_is_sent():
    """Criterion 4: a display event that changed nothing, and a transform event without a new pose, send nothing."""
    scene = LiveScene({"id": "vtkMRMLModelNode4", "world": moved(5.0)})
    sent = exported(scene)
    both = ("vtkMRMLModelNode4", Change.APPEARANCE | Change.TRANSFORM)
    assert plan_of(scene, sent, both) == Plan() and not plan_of(scene, sent, both)
    scene.node("vtkMRMLModelNode4")["opacity"] = 0.5
    assert plan_of(scene, sent, both).changes == (NodeChange("vtkMRMLModelNode4", opacity=0.5),)


def test_changes_display_values_are_clipped_like_the_export():
    """§8.1 ranges: an out-of-range colour or opacity is sent as collect would export it (0..1)."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4").update(color=(1.5, -0.2, 0.5), opacity=1.3)
    plan = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan == Plan(
        changes=(NodeChange("vtkMRMLModelNode4", color=(1.0, 0.0, 0.5)),)
    )  # opacity stays 1


def test_changes_are_recorded_as_sent():
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5"})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4").update(opacity=0.5, world=moved(1.0), color=(0.0, 0.5, 1.0))
    scene.remove("vtkMRMLModelNode5")
    marks = (
        ("vtkMRMLModelNode4", Change.APPEARANCE | Change.TRANSFORM),
        ("vtkMRMLModelNode5", Change.REMOVED),
    )
    sent.apply(plan_of(scene, sent, *marks))
    four = sent.get("vtkMRMLModelNode4")
    assert (four.opacity, four.matrix) == (
        0.5,
        gltf(moved(1.0)),
    ) and "vtkMRMLModelNode5" not in sent
    assert plan_of(scene, sent, *marks) == Plan()
    # the exported name survives the update: an unchanged name after it needs nothing
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME)) == Plan()


# --------------------------------------------------------------------------- criterion 2: re-exports


@pytest.mark.parametrize(
    ("change", "flags"),
    [
        ("geometry", Change.GEOMETRY),
        ("readded", Change.REMOVED | Change.ADDED),
        ("removed-yet-shown", Change.REMOVED),  # a removal whose node is back: the export decides
        ("added-again", Change.ADDED),
        ("baked-moves", Change.TRANSFORM),
        ("non-linear", Change.TRANSFORM),
        ("sheared", Change.TRANSFORM),
        ("unbaked", Change.TRANSFORM),
        ("invalid-transform", Change.TRANSFORM),
        ("invalid-display", Change.APPEARANCE),
        ("renamed", Change.NAME),
    ],
)
def test_changes_that_need_a_new_snapshot(change, flags):
    """FR-12, §8.2: only a snapshot shows them; the plan carries no update items — the snapshot has every change."""
    world = {"baked-moves": SHEAR, "unbaked": SHEAR}.get(change, np.eye(4))
    scene = LiveScene({"id": "vtkMRMLModelNode4", "world": world}, {"id": "vtkMRMLModelNode5"})
    sent = exported(scene)
    node = scene.node("vtkMRMLModelNode4")
    node.update(
        {
            "non-linear": {"world": None, "warp": warp()},
            "sheared": {"world": SHEAR},
            "unbaked": {"world": moved(1.0)},
            "baked-moves": {"world": SHEAR @ moved(1.0)},
            "invalid-transform": {"world": np.full((4, 4), np.nan)},
            "invalid-display": {"color": (np.nan, 0.0, 0.0)},
            "renamed": {"name": "Liver segment 8"},
        }.get(change, {})
    )
    scene.node("vtkMRMLModelNode5")["opacity"] = 0.5
    plan = plan_of(
        scene, sent, ("vtkMRMLModelNode4", flags), ("vtkMRMLModelNode5", Change.APPEARANCE)
    )
    assert plan == Plan(snapshot=True)  # nothing new to announce
    # the result does not depend on the order of the marks
    assert (
        plan_of(scene, sent, ("vtkMRMLModelNode5", Change.APPEARANCE), ("vtkMRMLModelNode4", flags))
        == plan
    )


def test_changes_new_nodes_are_announced():
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene)
    scene.add("vtkMRMLModelNode7")
    plan = plan_of(scene, sent, ("vtkMRMLModelNode7", Change.ADDED | Change.GEOMETRY))
    assert plan == Plan(snapshot=True, added=(("vtkMRMLModelNode7", "model"),))


def test_changes_a_node_hidden_at_the_export_is_announced_when_shown():
    """Hidden models are not exported (SLC-22): showing one is an addition for the viewers."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "visible": False})
    sent = exported(scene)
    assert "vtkMRMLModelNode5" not in sent
    scene.node("vtkMRMLModelNode5")["visible"] = True
    plan = plan_of(scene, sent, ("vtkMRMLModelNode5", Change.APPEARANCE))
    assert plan == Plan(snapshot=True, added=(("vtkMRMLModelNode5", "model"),))


def test_changes_a_closed_scene_is_forgotten_with_its_ids():
    """§7.3: after a close an old ID may name another model; nothing addresses it before the new snapshot."""
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"},
        {"id": "vtkMRMLModelNode5"},
        {"id": "vtkMRMLModelNode6", "mesh": LINE},
    )
    sent = exported(scene)
    assert set(sent.skipped) == {"vtkMRMLModelNode6"}
    heart = LiveScene(
        {"id": "vtkMRMLModelNode4", "name": "Heart", "color": (0.9, 0.1, 0.1)}
    )  # IDs restart
    plan = plan_of(heart, sent, ("vtkMRMLModelNode4", Change.ADDED), reset=True)
    assert plan == Plan(snapshot=True, reset=True, added=(("vtkMRMLModelNode4", "model"),))
    sent.apply(plan)  # before the export, which may not begin (too large)
    assert len(sent) == 0 and not sent.skipped
    heart.node("vtkMRMLModelNode4")["opacity"] = 0.5
    for flags in (Change.APPEARANCE, Change.TRANSFORM):
        assert plan_of(heart, sent, ("vtkMRMLModelNode4", flags)) == Plan(
            snapshot=True, added=(("vtkMRMLModelNode4", "model"),)
        )
    assert plan_of(heart, sent, ("vtkMRMLModelNode5", Change.REMOVED)) == Plan()
    assert plan_of(LiveScene(), exported(scene), reset=True) == Plan(snapshot=True, reset=True)


def test_changes_a_reset_under_hide_node_names_announces_generated_ids_only():
    """T7: the new scene's hand-set, name-derived ID never reaches scene.nodeAdded."""
    sent = exported(LiveScene({"id": "vtkMRMLModelNode4"}), anonymize=True)
    new = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "Doe_John_liver"})
    plan = plan_of(new, sent, ("Doe_John_liver", Change.ADDED), anonymize=True, reset=True)
    assert plan == Plan(snapshot=True, reset=True, added=(("vtkMRMLModelNode4", "model"),))


def test_changes_a_reset_survives_a_scene_that_cannot_be_listed():
    """A reset needs no scene read: the closed scene is forgotten even when the new one cannot be listed yet."""
    scene = _Broken({"id": "vtkMRMLModelNode4"}, failing="list")
    sent = exported(LiveScene({"id": "vtkMRMLModelNode4"}))
    assert plan_of(scene, sent, reset=True) == Plan(snapshot=True, reset=True)


def test_changes_hide_node_names_switched_needs_a_snapshot():
    """The viewers' scene was made under the other setting: its names follow other rules (T7). Since SLC-27 a
    hand-set ID is skipped in both modes (protocol v1.1 §7.3; SLC-35 aliases it), so a switch changes no ID — the
    hand-set one is never updated, removed or announced either way."""
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"},
        {"id": "vtkMRMLModelNode5"},
        {"id": "vtkMRMLModelNode6", "visible": False},  # hidden at the named export: not held
        {"id": "Doe_John_liver"},  # hand-set: skipped in both modes
    )
    named = exported(scene)
    assert "vtkMRMLModelNode5" in named and "Doe_John_liver" not in named and not named.anonymized
    scene.node("vtkMRMLModelNode5")["opacity"] = 0.5
    scene.node("vtkMRMLModelNode6")["visible"] = True
    scene.node("Doe_John_liver")["opacity"] = 0.5
    # switched on: nothing is updated or removed, the scene is exported again; the node that became visible is
    # announced (a generated ID), the hand-set one is not
    marks = (
        ("vtkMRMLModelNode5", Change.APPEARANCE),
        ("vtkMRMLModelNode6", Change.APPEARANCE),
        ("Doe_John_liver", Change.APPEARANCE),
    )
    assert plan_of(scene, named, *marks, anonymize=True) == Plan(
        snapshot=True, added=(("vtkMRMLModelNode6", "model"),)
    )
    # a reset in the same flush is not lost to the switch; the hand-set ID is not announced
    reset = plan_of(scene, named, *marks, anonymize=True, reset=True)
    assert reset == Plan(
        snapshot=True,
        reset=True,
        added=(
            ("vtkMRMLModelNode4", "model"),
            ("vtkMRMLModelNode5", "model"),
            ("vtkMRMLModelNode6", "model"),
        ),
    )
    anonymous = exported(scene, anonymize=True)
    assert "Doe_John_liver" not in anonymous and anonymous.anonymized
    # switched off: exported again; every shown node is held already, so nothing is announced
    plan = plan_of(scene, anonymous, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan == Plan(snapshot=True)
    # a node the export left out is not announced on a switch either (the hint lists nodes that will come)
    scene.add("vtkMRMLModelNode7", mesh=LINE)
    anonymous = exported(scene, anonymize=True)
    assert "vtkMRMLModelNode7" in anonymous.skipped
    plan = plan_of(scene, anonymous, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan == Plan(snapshot=True)


# --------------------------------------------------------------------------- hidden in Slicer


def test_changes_hiding_a_node_keeps_it_on_the_viewers():
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4")["visible"] = False
    plan = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan == Plan(changes=(NodeChange("vtkMRMLModelNode4", visible=False),))
    sent.apply(plan)
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE)) == Plan()  # still hidden
    scene.node("vtkMRMLModelNode4").update(visible=True, opacity=0.25)
    plan = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert plan.changes == (NodeChange("vtkMRMLModelNode4", visible=True, opacity=0.25),)


def test_changes_a_folder_hidden_hides_each_marked_child():
    scene = LiveScene(*({"id": f"vtkMRMLModelNode{i}"} for i in range(4, 15)))
    sent = exported(scene)
    for node in scene.nodes:
        node["visible"] = False
    plan = plan_of(scene, sent, *((n["id"], Change.APPEARANCE) for n in scene.nodes))
    assert plan == Plan(changes=tuple(NodeChange(n["id"], visible=False) for n in scene.nodes))


def test_changes_a_rename_of_a_hidden_node_under_hide_node_names_only_hides_it():
    """The viewers show "Model 1" anyway: nothing to remove — but a node hidden in Slicer is hidden on them, whatever
    its mark."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene, anonymize=True)
    scene.node("vtkMRMLModelNode4").update(visible=False, name="Doe^John")
    hidden = Plan(changes=(NodeChange("vtkMRMLModelNode4", visible=False),))
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME), anonymize=True) == hidden
    sent.apply(hidden)
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME), anonymize=True) == Plan()


def test_changes_an_added_node_is_updated_against_its_export():
    """After the re-export that brought X, ``sent = snapshot.sent``: X's colour is an update, not another snapshot."""
    client = live_client("mobile")
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = build_snapshot(scene, client, slicer_version="5.12.4").sent
    scene.add("vtkMRMLModelNode9")
    assert plan_of(scene, sent, ("vtkMRMLModelNode9", Change.ADDED)).snapshot
    sent = build_snapshot(scene, client, slicer_version="5.12.4").sent
    scene.node("vtkMRMLModelNode9")["color"] = (0.0, 0.0, 1.0)
    plan = plan_of(scene, sent, ("vtkMRMLModelNode9", Change.APPEARANCE))
    assert plan == Plan(changes=(NodeChange("vtkMRMLModelNode9", color=(0.0, 0.0, 1.0)),))


def test_changes_a_reset_whose_export_is_too_large_holds_every_update():
    """Wired to SLC-16: the reset's scene.nodeAdded makes a snapshot owed, so nothing addresses the closed scene."""
    client = live_client("mobile", maxSnapshotBytes=5_000)
    scene = LiveScene({"id": "vtkMRMLModelNode4", "mesh": sphere(4)})
    first = build_snapshot(scene, client, slicer_version="5.12.4")
    client.handle(ack(first.scene_version))
    sent = first.sent
    big = LiveScene({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})  # the next case reuses the ID
    plan = plan_of(big, sent, ("vtkMRMLModelNode4", Change.ADDED), reset=True)
    sent.apply(plan)
    assert client.announce_added(plan.added) is not None
    with pytest.raises(SnapshotTooLargeError):
        build_snapshot(big, client, slicer_version="5.12.4")
    assert client.snapshot_needed
    big.node("vtkMRMLModelNode4")["opacity"] = 0.5
    later = plan_of(big, sent, ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert later.snapshot and later.changes == ()
    assert client.send_changes([NodeChange("vtkMRMLModelNode4", opacity=0.5)]) == []  # held


def test_changes_a_node_shown_again_is_visible_whatever_its_mark():
    """Hidden on the viewers, shown in Slicer again: any mark of the node restores it, with its other display
    properties (whether a folder's eye marks its models is SLC-29's to check)."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4")["visible"] = False
    sent.apply(plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE)))
    scene.node("vtkMRMLModelNode4").update(visible=True, color=(0.0, 1.0, 0.0))
    plan = plan_of(scene, sent, ("vtkMRMLModelNode4", Change.TRANSFORM))
    assert plan == Plan(
        changes=(NodeChange("vtkMRMLModelNode4", visible=True, color=(0.0, 1.0, 0.0)),)
    )


@pytest.mark.parametrize(
    "flags", [Change.TRANSFORM, Change.GEOMETRY, Change.NAME, Change.ADDED | Change.REMOVED]
)
def test_changes_a_hidden_node_whose_mesh_or_pose_changed_is_removed(flags):
    """The viewers would keep a stale mesh: it goes, as a re-export (which leaves hidden models out) would make it."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5"})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode4")["visible"] = False
    sent.apply(plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE)))
    for node in scene.nodes:
        node["world"] = moved(7.0)  # one parent transform dragged
    plan = plan_of(
        scene, sent, ("vtkMRMLModelNode4", flags), ("vtkMRMLModelNode5", Change.TRANSFORM)
    )
    assert plan == Plan(
        changes=(NodeChange("vtkMRMLModelNode5", matrix=gltf(moved(7.0))),),
        removed=("vtkMRMLModelNode4",),
    )
    sent.apply(plan)
    assert "vtkMRMLModelNode4" not in sent
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.TRANSFORM)) == Plan()
    scene.node("vtkMRMLModelNode4")["visible"] = True
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE)) == Plan(
        snapshot=True, added=(("vtkMRMLModelNode4", "model"),)
    )


@pytest.mark.parametrize(
    "flags", [Change.APPEARANCE, Change.ADDED | Change.REMOVED, Change.REMOVED]
)
def test_changes_a_hidden_segment_is_left_to_the_export(flags):
    """SLC-27 IDs are not read by the classifier yet: a held node of another kind is never hidden or removed by a
    guess."""
    sent = SentScene(
        {
            "vtkMRMLSegmentationNode1/Segment_1": SentNode(
                "segment", (0.0, 1.0, 0.0), 1.0, True, IDENTITY
            )
        },
        anonymized=False,
    )
    plan = plan_of(LiveScene(), sent, ("vtkMRMLSegmentationNode1/Segment_1", flags))
    assert plan == Plan(snapshot=True)


# --------------------------------------------------------------------------- nodes the export left out


def test_changes_a_centre_line_under_a_dragged_transform_is_not_re_exported():
    """A node without triangles is left out again whatever its pose: a drag sends matrices only, never snapshots."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": LINE})
    sent = exported(scene)
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.NO_TRIANGLES)}
    for x in (1.0, 2.0, 3.0):
        for node in scene.nodes:
            node["world"] = moved(x)
        marks = (("vtkMRMLModelNode4", Change.TRANSFORM), ("vtkMRMLModelNode5", Change.TRANSFORM))
        plan = plan_of(scene, sent, *marks)
        assert plan == Plan(changes=(NodeChange("vtkMRMLModelNode4", matrix=gltf(moved(x))),))
        sent.apply(plan)
    # a baked transform's change is marked geometry (SLC-29): still nothing while it has no triangle cell
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == Plan()
    scene.node("vtkMRMLModelNode5")["mesh"] = MESH
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == Plan(
        snapshot=True
    )  # not announced
    # removed and added again with a mesh within one quiet period
    both = Change.ADDED | Change.REMOVED
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", both)) == Plan(snapshot=True)


def test_changes_a_node_with_invalid_geometry_comes_back_with_a_new_mesh():
    """``invalid-geometry`` without a bake (a NaN point): a TRS move cannot fix it, a new mesh can."""
    broken = polydata_from_triangles(
        np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0], [np.nan, 0, 0]]),
        np.array([[0, 1, 2], [1, 2, 3]]),
    )
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": broken})
    sent = exported(scene)
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.INVALID_GEOMETRY)}
    scene.node("vtkMRMLModelNode5")["world"] = moved(3.0)
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan()
    scene.node("vtkMRMLModelNode5")["mesh"] = MESH
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == Plan(
        snapshot=True
    )  # not announced
    assert "vtkMRMLModelNode5" in {e.node_id for e in collect_scene(scene).entities}


def test_changes_a_non_finite_mesh_never_comes_back_with_a_transform():
    """Its own mesh fails (``baked`` false): non-finite points stay so under any chain, a new mesh may pass."""
    broken = polydata_from_triangles(
        np.array([[0.0, 0, 0], [np.nan, 0, 0], [0, 1, 0]]), np.array([[0, 1, 2]])
    )
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": broken})
    sent = exported(scene)
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.INVALID_GEOMETRY)}
    for world, chain in ((moved(1.0), None), (SHEAR, None), (None, warp())):
        scene.node("vtkMRMLModelNode5").update(world=world, warp=chain)
        assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan()
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == Plan(snapshot=True)


def test_changes_a_node_whose_bake_overflowed_comes_back_without_it():
    """``invalid-geometry`` after a bake (beyond float32): taking the transform away lifts it."""
    blow_up = vtkTransform()
    blow_up.Scale(1e300, 1.0, 1.0)
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "world": None, "warp": blow_up}
    )
    sent = exported(scene)
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.INVALID_GEOMETRY, baked=True)}
    scene.node("vtkMRMLModelNode5").update(world=np.eye(4), warp=None)
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan(snapshot=True)


def test_changes_a_node_collapsed_by_a_bake_comes_back_with_its_transform():
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "world": COLLAPSE})
    sent = exported(scene)
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.NO_TRIANGLES, baked=True)}
    scene.node("vtkMRMLModelNode5")["world"] = np.eye(4)
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan(snapshot=True)
    # the same reason without a bake: a TRS pose cannot give the mesh's triangles an area, a new mesh can
    flat = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": DEGENERATE})
    flat_sent = exported(flat)
    assert flat_sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.NO_TRIANGLES)}
    flat.node("vtkMRMLModelNode5")["world"] = moved(4.0)
    assert plan_of(flat, flat_sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan()
    # an affine bake keeps collinear points collinear (SLC-30 review part 2): a sheared drag sends nothing
    flat.node("vtkMRMLModelNode5")["world"] = SHEAR
    assert plan_of(flat, flat_sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan()
    flat.node("vtkMRMLModelNode5").update(world=None, warp=warp())  # a chain that is not linear may
    assert plan_of(flat, flat_sent, ("vtkMRMLModelNode5", Change.TRANSFORM)) == Plan(snapshot=True)
    assert plan_of(flat, flat_sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == Plan(snapshot=True)


@pytest.mark.parametrize(
    ("skip", "broken", "fixed", "flags"),
    [
        (
            "invalid-display",
            {"color": (np.nan, 0.0, 0.0)},
            {"color": (0.2, 0.4, 0.6)},
            Change.APPEARANCE,
        ),
        ("invalid-display", {"opacity": np.nan}, {"opacity": 0.5}, Change.APPEARANCE),
        (
            "invalid-transform",
            {"world": np.full((4, 4), np.inf)},
            {"world": moved(2.0)},
            Change.TRANSFORM,
        ),
        (
            "non-linear-transform",
            {"world": None},
            {"world": None, "warp": warp()},
            Change.TRANSFORM,
        ),
        (
            "invalid-transform",
            {"world": np.full((4, 4), np.nan)},
            {"world": SHEAR},
            Change.TRANSFORM,
        ),
        (
            "invalid-transform",
            {"world": np.full((4, 4), np.nan)},
            {"world": np.eye(4)},
            Change.ADDED | Change.REMOVED,  # removed and added again within one quiet period
        ),
    ],
)
def test_changes_a_node_left_out_comes_back_when_its_reason_is_gone(skip, broken, fixed, flags):
    """Re-checked with the export's own rule on every mark: still broken → nothing; fixed → announced re-export."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", **broken})
    sent = exported(scene)
    assert sent.skipped["vtkMRMLModelNode5"].reason.value == skip
    assert (
        plan_of(scene, sent, ("vtkMRMLModelNode5", Change.APPEARANCE | Change.TRANSFORM)) == Plan()
    )
    scene.node("vtkMRMLModelNode5").update(fixed)
    plan = plan_of(scene, sent, ("vtkMRMLModelNode5", flags))
    assert plan == Plan(snapshot=True, added=(("vtkMRMLModelNode5", "model"),))
    collected = collect_scene(scene)
    assert "vtkMRMLModelNode5" in {
        e.node_id for e in collected.entities
    }  # the export takes it indeed


@pytest.mark.parametrize(
    ("hidden_as", "fix", "flags"),
    [
        ({"mesh": LINE}, {"mesh": MESH}, Change.GEOMETRY),
        ({"world": np.full((4, 4), np.nan)}, {"world": moved(2.0)}, Change.TRANSFORM),
    ],
    ids=["mesh", "transform"],
)
def test_changes_a_node_left_out_and_fixed_while_hidden_comes_back_when_shown(
    hidden_as, fix, flags
):
    """Its reason may be gone (``Plan.forget``): showing it again — an appearance mark only — re-exports."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", **hidden_as})
    sent = exported(scene)
    assert "vtkMRMLModelNode5" in sent.skipped
    scene.node("vtkMRMLModelNode5").update(visible=False, **fix)
    plan = plan_of(scene, sent, ("vtkMRMLModelNode5", flags))
    assert plan == Plan(forget=("vtkMRMLModelNode5",)) and not plan  # nothing to send
    sent.apply(plan)
    assert "vtkMRMLModelNode5" not in sent.skipped
    scene.node("vtkMRMLModelNode5")["visible"] = True
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.APPEARANCE)) == Plan(
        snapshot=True, added=(("vtkMRMLModelNode5", "model"),)
    )
    # forgotten in a re-export plan too: applied before the export, which may not begin
    scene.node("vtkMRMLModelNode4")["mesh"] = sphere(6)
    other = exported(
        LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", **hidden_as})
    )
    scene.node("vtkMRMLModelNode5")["visible"] = False
    plan = plan_of(
        scene, other, ("vtkMRMLModelNode4", Change.GEOMETRY), ("vtkMRMLModelNode5", flags)
    )
    assert plan == Plan(snapshot=True, forget=("vtkMRMLModelNode5",))
    # an appearance mark while hidden keeps the reason: the display is re-checked when it is shown anyway
    hidden = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", **hidden_as})
    kept = exported(hidden)
    hidden.node("vtkMRMLModelNode5")["visible"] = False
    assert plan_of(hidden, kept, ("vtkMRMLModelNode5", Change.APPEARANCE)) == Plan()


def _strips():
    """A mesh of one triangle strip only (no polys): it has triangles for collect."""
    points = vtkPoints()
    for point in ([0.0, 0, 0], [1.0, 0, 0], [0.0, 1, 0], [1.0, 1, 0]):
        points.InsertNextPoint(point)
    strips = vtkCellArray()
    strips.InsertNextCell(4, [0, 1, 2, 3])
    data = vtkPolyData()
    data.SetPoints(points)
    data.SetStrips(strips)
    return data


@pytest.mark.parametrize(("mesh", "expected"), [(None, Plan()), ("strips", Plan(snapshot=True))])
def test_changes_a_new_mesh_of_a_node_without_triangles_is_checked_by_its_cells(mesh, expected):
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": LINE})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode5")["mesh"] = _strips() if mesh == "strips" else mesh
    assert plan_of(scene, sent, ("vtkMRMLModelNode5", Change.GEOMETRY)) == expected


def test_changes_display_changes_of_a_node_without_triangles_need_nothing():
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5", "mesh": None})
    sent = exported(scene)
    scene.node("vtkMRMLModelNode5")["color"] = (0.0, 0.0, 1.0)
    for flags in (Change.APPEARANCE, Change.NAME, Change.TRANSFORM):
        assert plan_of(scene, sent, ("vtkMRMLModelNode5", flags)) == Plan()


def test_changes_of_duplicate_ids_read_the_node_the_export_took():
    """Collect exports the first node of an ID: the classifier reads that one, not a later duplicate."""
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode4", "color": (0.0, 0.0, 1.0)}
    )
    sent = exported(scene)
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.APPEARANCE)) == Plan()


def test_changes_the_viewers_scene_keeps_the_first_skip_of_an_id():
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"},
        {"id": "vtkMRMLModelNode4", "mesh": LINE},
        {"id": "vtkMRMLModelNode5", "mesh": LINE},
        {"id": "vtkMRMLModelNode5"},
    )
    sent = exported(scene)
    # node 4: exported, its duplicate is not "left out"; node 5: the first one (no triangles) decides
    assert "vtkMRMLModelNode4" in sent and "vtkMRMLModelNode4" not in sent.skipped
    assert sent.skipped == {"vtkMRMLModelNode5": SkipInfo(SkipReason.NO_TRIANGLES)}


# --------------------------------------------------------------------------- names


def test_changes_a_node_without_a_usable_name_keeps_its_substitute():
    """Exported as "Model 1" (nothing left of its name after sanitising): another empty name changes nothing."""
    scene = LiveScene({"id": "vtkMRMLModelNode4", "name": "  "})
    sent = exported(scene)
    assert sent.get("vtkMRMLModelNode4").name == "Model 1"
    scene.node("vtkMRMLModelNode4")["name"] = "\t"
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME)) == Plan()
    scene.node("vtkMRMLModelNode4")["name"] = (
        42  # not a string (an adapter bug): the substitute too, never "42"
    )
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME)) == Plan()
    scene.node("vtkMRMLModelNode4")["name"] = "Liver"
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME)) == Plan(snapshot=True)


@pytest.mark.parametrize(
    ("names", "anonymize", "expected"),
    [
        (["Liver segment 8"], False, Plan(snapshot=True)),
        (["Liver segment 8"], True, Plan()),  # Hide node names: the viewers show "Model 1" anyway
        (["Liver segment 8", "Liver"], False, Plan()),  # renamed and back within one quiet period
        (["  Liver\t"], False, Plan()),  # the same exported name
        (["liver"], False, Plan(snapshot=True)),  # a change of case is a new name
        (
            [42],
            False,
            Plan(snapshot=True),
        ),  # not a string (an adapter bug): the substitute, a new name
        (
            ["\t", " "],
            False,
            Plan(snapshot=True),
        ),  # no usable name any more: the export gives a substitute
    ],
)
def test_changes_a_rename_needs_a_snapshot_only_when_the_exported_name_changes(
    names, anonymize, expected
):
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene, anonymize=anonymize)
    for name in names:
        scene.node("vtkMRMLModelNode4")["name"] = name
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", Change.NAME), anonymize=anonymize) == expected


# --------------------------------------------------------------------------- criterion 3: dropped IDs (T7)


@pytest.mark.parametrize("flags", [*Change, Change.ADDED | Change.REMOVED])
def test_changes_an_id_in_neither_scene_is_dropped(flags):
    scene = LiveScene({"id": "vtkMRMLModelNode4"})
    sent = exported(scene)
    assert plan_of(scene, sent, ("Doe_John_liver", flags)) == Plan()


def test_changes_added_and_removed_follows_the_scene():
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "vtkMRMLModelNode5"})
    sent = exported(scene)
    scene.remove("vtkMRMLModelNode5")  # added and removed again: only the viewers have it
    plan = plan_of(scene, sent, ("vtkMRMLModelNode5", Change.ADDED | Change.REMOVED))
    assert plan == Plan(removed=("vtkMRMLModelNode5",))
    scene.add("vtkMRMLModelNode9")  # only the scene has it: a new node
    for flags in (Change.ADDED | Change.REMOVED, Change.REMOVED):
        assert plan_of(scene, sent, ("vtkMRMLModelNode9", flags)) == Plan(
            snapshot=True, added=(("vtkMRMLModelNode9", "model"),)
        )


def test_changes_hide_node_names_keeps_hand_set_ids_off_the_wire():
    """With *Hide node names* only generated IDs are exported (collect): a hand-set ID is not the viewers' to know."""
    scene = LiveScene({"id": "vtkMRMLModelNode4"}, {"id": "Doe_John_liver"})
    sent = exported(scene, anonymize=True)
    assert "Doe_John_liver" not in sent
    scene.node("Doe_John_liver")["color"] = (0.0, 0.0, 1.0)
    for flags in (Change.APPEARANCE | Change.GEOMETRY, Change.ADDED, Change.REMOVED, Change.NAME):
        assert plan_of(scene, sent, ("Doe_John_liver", flags), anonymize=True) == Plan()
    scene.add("vtkMRMLModelNode9")
    plan = plan_of(scene, sent, ("vtkMRMLModelNode9", Change.ADDED), anonymize=True)
    assert plan.added == (("vtkMRMLModelNode9", "model"),)  # never the hand-set ID


def test_changes_reprs_show_no_node_id_or_name(caplog):
    caplog.set_level(logging.DEBUG)
    scene = LiveScene(
        {"id": "vtkMRMLModelNode1", "name": "Doe^John liver"},
        {"id": "vtkMRMLModelNode2", "name": "Doe^Jane kidney"},
        {"id": "vtkMRMLModelNode3", "mesh": LINE},  # left out: in sent.skipped
    )
    sent = exported(scene)
    scene.node("vtkMRMLModelNode1")["opacity"] = 0.5
    scene.remove("vtkMRMLModelNode2")
    plan = plan_of(
        scene, sent, ("vtkMRMLModelNode1", Change.APPEARANCE), ("vtkMRMLModelNode2", Change.REMOVED)
    )
    assert plan.changes and plan.removed and len(sent.skipped) == 1
    texts = [repr(plan), repr(sent), repr(sent.get("vtkMRMLModelNode1")), repr(sent.skipped)]
    logging.getLogger("test").info(
        "%s %s %s %s", plan, sent, sent.get("vtkMRMLModelNode1"), sent.skipped
    )
    assert not any("Doe" in t or "vtkMRMLModelNode" in t for t in [*texts, caplog.text])


class _Broken(LiveScene):
    """An adapter whose ``failing`` read raises ``error`` with the node ID in its text (a node deleted meanwhile, a
    display node gone for a moment, a bad MRML state)."""

    def __init__(self, *nodes: dict, failing: str = "", error: type[Exception] = KeyError) -> None:
        super().__init__(*nodes)
        self.failing = failing
        self.error = error

    def _check(self, read: str, node_id: str) -> None:
        if self.failing == read:
            raise self.error(node_id)

    def display_props(self, node):
        self._check("display", node["id"])
        return super().display_props(node)

    def world_matrix(self, node):
        self._check("world", node["id"])
        return super().world_matrix(node)

    def name(self, node):
        self._check("name", node["id"])
        return super().name(node)

    def polydata(self, node):
        self._check("polydata", node["id"])
        return super().polydata(node)

    def world_transform(self, node):
        self._check("warp", node["id"])
        return super().world_transform(node)

    def visible_model_nodes(self):
        self._check("list", "Doe_John_liver")
        return super().visible_model_nodes()


ADAPTER_ERRORS = [KeyError, AttributeError, RuntimeError]


@pytest.mark.parametrize("error", ADAPTER_ERRORS)
@pytest.mark.parametrize(
    ("failing", "props", "held", "flags"),
    [
        ("display", {}, True, Change.APPEARANCE),
        ("world", {}, True, Change.TRANSFORM),
        ("name", {}, True, Change.NAME),
        ("polydata", {"mesh": LINE}, False, Change.GEOMETRY),  # left out as no-triangles
        ("warp", {"world": None}, False, Change.TRANSFORM),  # left out as non-linear-transform
    ],
)
def test_changes_a_node_the_adapter_cannot_read_is_left_to_the_export(
    failing, props, held, flags, error
):
    """The export reads it again and reports it if it still fails; the flush goes on (no exception with an ID)."""
    scene = _Broken({"id": "vtkMRMLModelNode4", **props}, {"id": "vtkMRMLModelNode5"}, error=error)
    sent = exported(scene)
    assert ("vtkMRMLModelNode4" in sent) is held
    scene.failing = failing
    assert plan_of(scene, sent, ("vtkMRMLModelNode4", flags)) == Plan(snapshot=True)


@pytest.mark.parametrize("error", ADAPTER_ERRORS)
def test_changes_a_scene_that_cannot_be_listed_raises_without_an_id(error):
    """T7: neither the message nor a logged traceback carries the adapter's text (``from None``)."""
    scene = _Broken({"id": "vtkMRMLModelNode4"}, failing="list", error=error)
    with pytest.raises(SceneReadError) as refused:
        plan_of(scene, SentScene(anonymized=False), ("vtkMRMLModelNode4", Change.APPEARANCE))
    assert refused.value.__cause__ is None and refused.value.__suppress_context__
    assert "Doe" not in "".join(traceback.format_exception(refused.value))


def test_changes_hide_node_names_is_required():
    with pytest.raises(TypeError):
        classify(drained(), LiveScene(), SentScene(anonymized=False))  # type: ignore[call-arg]


# --------------------------------------------------------------------------- the viewers' scene


def test_changes_sent_scene_of_an_export():
    scene = LiveScene(
        {"id": "vtkMRMLModelNode4"},
        {
            "id": "vtkMRMLModelNode5",
            "world": moved(1.0, 2.0, 3.0),
            "color": (0.1, 0.2, 0.3),
            "opacity": 0.4,
            "name": "Kidney",
        },
        {"id": "vtkMRMLModelNode6", "world": SHEAR},
        {"id": "vtkMRMLModelNode7", "mesh": LINE},
    )
    sent = exported(scene)
    assert sent.get("vtkMRMLModelNode4") == SentNode(
        "model", (0.8, 0.3, 0.2), 1.0, True, IDENTITY, "Liver"
    )
    five = sent.get("vtkMRMLModelNode5")
    assert (five.matrix, five.color, five.opacity, five.name) == (
        gltf(moved(1.0, 2.0, 3.0)),
        (0.1, 0.2, 0.3),
        0.4,
        "Kidney",
    )
    assert sent.get("vtkMRMLModelNode6").matrix is None  # baked
    assert len(sent) == 3 and set(sent.skipped) == {"vtkMRMLModelNode7"} and not sent.anonymized
    assert all(type(c) is float for c in five.color) and type(five.opacity) is float


def test_changes_snapshot_carries_the_viewers_scene():
    """``Snapshot.sent``: the decimated export, its skipped nodes and its *Hide node names* setting (SLC-14, SLC-22)."""
    scene = FakeScene(
        {"id": "vtkMRMLModelNode4", "mesh": sphere(240)}, {"id": "vtkMRMLModelNode5", "mesh": None}
    )
    client = live_client("quest2")
    snapshot = build_snapshot(scene, client, slicer_version="5.12.4", anonymize_names=True)
    assert snapshot.reduced == ("vtkMRMLModelNode4",)
    assert snapshot.sent.anonymized and set(snapshot.sent.skipped) == {"vtkMRMLModelNode5"}
    assert snapshot.sent.get("vtkMRMLModelNode4") == SentNode(
        "model", (0.8, 0.3, 0.2), 1.0, True, IDENTITY, "Model 1"
    )
    assert "sent" not in repr(snapshot)
