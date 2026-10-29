"""SLC-16: scene update messages and their sequencing (docs/protocol.md §3.3, §6.2, §8.1, §8.2, §8.4)."""

from __future__ import annotations

import itertools
import json
import logging
import math
import queue
import sys
import time

import numpy as np
import pytest
from support import (
    FakeScene,
    ack,
    created,
    minimal_glb,
    needs_relay_stub,
    sphere,
    start_relay_stub,
)

from remoteview_core import transport as transport_module
from remoteview_core.protocol_client import (
    MessageTooLargeError,
    NodeChange,
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    encoded_size,
    make_client_info,
    split_items,
)
from remoteview_core.snapshot import build_snapshot
from remoteview_core.transport import Connected, Disconnected, Received, RelayTransport
from remoteview_protocol import envelope, schemas

LONG_ID = "vtkMRMLSegmentationNode1/" + "S" * 103  # 128 characters, the §3.3 maximum


@pytest.fixture(scope="module")
def strict():
    compiled = schemas.compile_schemas()
    return lambda message: schemas.validate_message(message, None, compiled)


def _error(code: str, reply_to: str | None = None) -> dict:
    return envelope.make(
        "error", reply_to=reply_to, code=code, message=f"{code} for test", retryable=True
    )


def _snapshot(client: ProtocolClient):
    glb = minimal_glb(client.next_scene_version)
    return client.begin_snapshot(glb, node_count=1, triangle_count=12)


def live(strict, *, acked: bool = True, **limits) -> ProtocolClient:
    """A client whose session is created and (by default) whose first snapshot (version 1) the relay acknowledged."""
    client = ProtocolClient(make_client_info("5.12.4", "linux"), validate=strict, auto_renew=False)
    client.start("mobile")
    assert client.handle(created(**limits)) == []
    if acked:
        _snapshot(client)
        assert client.handle(ack(1)) == []
    return client


def shape(messages: list[dict]) -> list[tuple]:
    """(type, sceneVersion, baseVersion, number of items) of each message."""
    return [
        (
            m["type"],
            m["sceneVersion"],
            m["baseVersion"],
            len(m.get("changes") or m.get("nodeIds") or m["nodes"]),
        )
        for m in messages
    ]


def assert_held(client: ProtocolClient) -> None:
    """Neither a change nor a removal goes out now, and no version is used."""
    last = client.versions.last
    assert client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)]) == []
    assert client.send_removed(["vtkMRMLModelNode7"]) == []
    assert client.versions.last == last


def in_state(strict, state: str) -> ProtocolClient:
    """A live client whose updates are sent (``acked``), held by a snapshot in flight, or held before the first."""
    client = live(strict, acked=state != "first")
    if state == "in-flight":
        _snapshot(client)  # version 2
    return client


def moved(x: float) -> list[float]:
    """A column-major glTF translation by ``x`` metres."""
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]


def colours(n: int, prefix: str = "vtkMRMLModelNode") -> list[NodeChange]:
    return [NodeChange(f"{prefix}{i}", color=(i % 10 / 10, 0.5, 0.25)) for i in range(n)]


# --------------------------------------------------------------------------- NodeChange


def test_scene_updates_node_change_serialises_only_what_changed():
    change = NodeChange(
        "vtkMRMLModelNode4", color=np.array([0.1, 0.2, np.float32(0.3)]), opacity=np.float64(0.5)
    )
    assert change.to_json() == {
        "nodeId": "vtkMRMLModelNode4",
        "color": [0.1, 0.2, pytest.approx(0.3)],
        "opacity": 0.5,
    }
    assert all(type(c) is float for c in change.color)
    moved = NodeChange("vtkMRMLModelNode5", matrix=range(16), visible=False)
    assert moved.to_json() == {
        "nodeId": "vtkMRMLModelNode5",
        "visible": False,
        "matrix": [float(i) for i in range(16)],
    }
    # numpy float32 (what VTK arrays give) is not JSON-serialisable: stored as Python floats
    single = NodeChange(
        "vtkMRMLModelNode6", matrix=np.eye(4, dtype=np.float32).ravel(), opacity=np.float32(0.25)
    )
    assert all(type(m) is float for m in single.matrix) and type(single.opacity) is float
    assert encoded_size(single.to_json()) > 0


def test_scene_updates_node_change_repr_shows_no_node_id():
    assert "Doe" not in repr(NodeChange("Doe_John_liver", visible=True))


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"node_id": ""}, ValueError),
        ({"node_id": "a" * 129}, ValueError),
        ({"node_id": "vtkMRMLModelNode4\n"}, ValueError),
        ({"node_id": "Leber Müller"}, ValueError),
        ({"node_id": "Doe John liver"}, ValueError),
        ({"node_id": 4}, ValueError),
        ({"visible": None}, ValueError),  # nothing changed
        ({"visible": 1}, TypeError),
        ({"visible": np.bool_(True)}, TypeError),
        ({"color": (1.0, 0.5)}, ValueError),
        ({"color": (1.0, 0.5, 0.2, 1.0)}, ValueError),
        ({"color": (1.5, 0.5, 0.2)}, ValueError),
        ({"color": (-0.1, 0.5, 0.2)}, ValueError),
        ({"color": (math.nan, 0.5, 0.2)}, ValueError),
        ({"color": (True, 0.5, 0.2)}, TypeError),
        ({"color": "red"}, TypeError),
        ({"opacity": 1.01}, ValueError),
        ({"opacity": math.inf}, ValueError),
        ({"opacity": "1"}, TypeError),
        ({"opacity": 10**400}, ValueError),  # beyond the double range
        ({"matrix": [0] * 15 + [10**400]}, ValueError),
        ({"matrix": [0.0] * 15}, ValueError),
        ({"matrix": [0.0] * 17}, ValueError),
        ({"matrix": [0.0] * 15 + [math.nan]}, ValueError),
        ({"matrix": [0.0] * 15 + [math.inf]}, ValueError),
        ({"matrix": np.eye(4)}, TypeError),  # rows, not 16 numbers: flatten column-major first
    ],
)
def test_scene_updates_node_change_refuses_what_the_schema_refuses(kwargs, error):
    arguments = {"node_id": "vtkMRMLModelNode4", **kwargs}
    if set(kwargs) == {"node_id"}:
        arguments["visible"] = True
    with pytest.raises(error) as refused:
        NodeChange(**arguments)
    assert "Doe" not in str(refused.value) and "Müller" not in str(refused.value)  # T7


@pytest.mark.parametrize(
    ("prop", "older", "newer"),
    [
        ("visible", True, False),
        ("color", (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
        ("opacity", 0.5, 0.2),
        ("matrix", tuple(moved(0.01)), tuple(moved(0.02))),
    ],
)
def test_scene_updates_node_change_merge_is_last_writer_wins_per_property(prop, older, newer):
    """§8.1: per property the newer value wins; a property only one side sets is kept."""
    first = NodeChange("vtkMRMLModelNode4", **{prop: older})
    second = NodeChange("vtkMRMLModelNode4", **{prop: newer})
    assert getattr(first.merged(second), prop) == newer
    assert getattr(second.merged(first), prop) == older
    other = "opacity" if prop != "opacity" else "visible"
    kept = NodeChange("vtkMRMLModelNode4", **{other: 0.75 if other == "opacity" else False})
    assert getattr(kept.merged(second), other) == getattr(kept, other)
    assert getattr(second.merged(kept), other) == getattr(kept, other)


def test_scene_updates_node_change_merge_refuses_another_node():
    with pytest.raises(ValueError, match="different nodes"):
        NodeChange("vtkMRMLModelNode4", visible=True).merged(
            NodeChange("vtkMRMLModelNode5", visible=True)
        )


# --------------------------------------------------------------------------- versions (§8.1, §8.2, §8.4)


def test_scene_updates_versions_chain_after_the_snapshot(strict):
    """Criterion 1: an appearance change and a matrix in one scene.update, a removal in scene.nodeRemoved."""
    client = live(strict)
    update = client.send_changes(
        [
            NodeChange("vtkMRMLModelNode4", color=(0.95, 0.85, 0.7), opacity=0.35),
            NodeChange(
                "vtkMRMLModelNode5",
                matrix=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.012, -0.004, 0, 1],
            ),
        ]
    )
    removed = client.send_removed(["vtkMRMLModelNode6"])
    assert shape(update + removed) == [("scene.update", 2, 1, 2), ("scene.nodeRemoved", 3, 2, 1)]
    assert update[0]["changes"][1]["matrix"][12:15] == [0.012, -0.004, 0.0]
    assert removed[0]["nodeIds"] == ["vtkMRMLModelNode6"]
    assert client.versions.last == 3 and client.next_scene_version == 4
    assert len({m["id"] for m in update + removed}) == 2


def test_scene_updates_changes_of_one_node_are_merged(strict):
    client = live(strict)
    [update] = client.send_changes(
        [
            NodeChange("vtkMRMLModelNode4", color=(1, 0, 0)),
            NodeChange("vtkMRMLModelNode5", visible=False),
            NodeChange("vtkMRMLModelNode4", opacity=0.2),
            NodeChange("vtkMRMLModelNode4", color=(0, 0, 1)),
        ]
    )
    assert update["changes"] == [
        {"nodeId": "vtkMRMLModelNode4", "color": [0.0, 0.0, 1.0], "opacity": 0.2},
        {"nodeId": "vtkMRMLModelNode5", "visible": False},
    ]


def test_scene_updates_nothing_to_send_is_no_message(strict):
    client = live(strict)
    assert client.send_changes([]) == [] and client.send_removed([]) == []
    assert client.versions.last == 1


def test_scene_updates_duplicate_removals_are_one(strict):
    client = live(strict)
    [removed] = client.send_removed(["vtkMRMLModelNode6", "vtkMRMLModelNode6", "vtkMRMLModelNode7"])
    assert removed["nodeIds"] == ["vtkMRMLModelNode6", "vtkMRMLModelNode7"]


@pytest.mark.parametrize(
    "bad", [[NodeChange("vtkMRMLModelNode4", visible=True), {"nodeId": "x"}], ["x"]]
)
@pytest.mark.parametrize("state", ["acked", "in-flight", "first"])
def test_scene_updates_refuses_what_is_not_a_node_change(strict, bad, state):
    """Checked before the held branch: a bad item is never kept for the ack to send."""
    client = in_state(strict, state)
    last = client.versions.last
    with pytest.raises(TypeError):
        client.send_changes(bad)
    assert client.versions.last == last
    if state == "in-flight":
        # the good change of the refused call was not kept either
        assert client.handle(ack(2)) == []


@pytest.mark.parametrize("state", ["acked", "in-flight", "first"])
@pytest.mark.parametrize("one", ["Doe_John_liver", b"vtkMRMLModelNode4"])
def test_scene_updates_refuses_one_removed_id_given_as_a_string(strict, one, state):
    """``send_removed("ID")`` instead of ``send_removed(["ID"])``: its letters are valid IDs, and part of a name
    (T7)."""
    client = in_state(strict, state)
    last = client.versions.last
    with pytest.raises(TypeError, match="not one ID") as refused:
        client.send_removed(one)
    assert client.versions.last == last and "Doe" not in str(refused.value)


@pytest.mark.parametrize("state", ["acked", "in-flight", "first"])
@pytest.mark.parametrize("bad", ["", "a b", None, "a" * 129, "Doe John liver"])
def test_scene_updates_refuses_a_bad_removed_id_and_uses_no_version(bad, state):
    # without the schemas, as in Slicer; also while held, so the ack never sends it
    client = in_state(None, state)
    last = client.versions.last
    with pytest.raises(ValueError, match="node ID") as refused:
        client.send_removed(["vtkMRMLModelNode6", bad])
    assert client.versions.last == last and "Doe" not in str(refused.value)  # T7
    if state == "in-flight":
        assert client.handle(ack(2)) == []  # the good ID of the refused call was not kept either


@pytest.mark.parametrize("state", ["idle", "connecting", "grace", "closed"])
def test_scene_updates_only_in_a_live_session(strict, state):
    client = ProtocolClient(make_client_info("5.12.4", "linux"), validate=strict, auto_renew=False)
    if state != "idle":
        client.start("mobile")
    if state in ("grace", "closed"):
        client.handle(created())
        client.transport_lost() if state == "grace" else client.close()
    for build in (
        lambda: client.send_changes([NodeChange("vtkMRMLModelNode4", visible=True)]),
        lambda: client.send_removed(["vtkMRMLModelNode4"]),
        lambda: client.announce_added([("vtkMRMLModelNode4", "model")]),
    ):
        with pytest.raises(ProtocolStateError):
            build()


# --------------------------------------------------------------------------- splitting (§3.3)


def test_scene_updates_1500_changes_are_split_at_1000(strict):
    """Criterion 3."""
    client = live(strict)
    messages = client.send_changes(colours(1500))
    assert shape(messages) == [("scene.update", 2, 1, 1000), ("scene.update", 3, 2, 500)]
    assert [c["nodeId"] for m in messages for c in m["changes"]] == [
        f"vtkMRMLModelNode{i}" for i in range(1500)
    ]


def test_scene_updates_split_at_the_relays_max_changes(strict):
    client = live(strict, maxChanges=300)
    messages = client.send_changes(colours(1000)) + client.send_removed(
        [f"vtkMRMLModelNode{i}" for i in range(301)]
    )
    assert [n for *_, n in shape(messages)] == [300, 300, 300, 100, 300, 1]
    assert [m["sceneVersion"] for m in messages] == [2, 3, 4, 5, 6, 7]


def _fills(messages: list[dict], limit: int) -> bool:
    """No message was cut before it was full: the next one's first item would not have fitted, allowing for the
    envelope the split plans with (a 32-character ID and uint32 versions, a few bytes more than the real one)."""
    for message, nxt in itertools.pairwise(messages):
        worst = encoded_size(
            {**message, "id": "u-" + "9" * 30, "sceneVersion": 2**32 - 1, "baseVersion": 2**32 - 1}
        )
        slack = worst - encoded_size(message)
        if encoded_size(message) + 1 + encoded_size(nxt["changes"][0]) <= limit - slack:
            return False
    return True


def test_scene_updates_1000_long_changes_are_split_under_256_kib(strict):
    """Criterion 3: 1,000 nodes with 128-character IDs, matrices, colour, opacity and visibility exceed 256 KiB."""
    client = live(strict)
    matrix = [-0.123456789012345678] * 16
    changes = [
        NodeChange(
            f"{LONG_ID[:-4]}{i:04d}",
            matrix=matrix,
            color=(1 / 3, 2 / 3, 1 / 7),
            opacity=1 / 9,
            visible=True,
        )
        for i in range(1000)
    ]
    assert sum(encoded_size(c.to_json()) for c in changes) > 2 * 262_144
    messages = client.send_changes(changes)
    assert len(messages) == 3 and all(encoded_size(m) <= 262_144 for m in messages)
    assert _fills(messages, 262_144)
    assert [c["nodeId"] for m in messages for c in m["changes"]] == [c.node_id for c in changes]


@pytest.mark.parametrize("limit", [2_000, 20_000, 65_536])
def test_scene_updates_messages_fill_the_relays_max_text_bytes(strict, limit):
    """Each message stays within ``maxTextBytes`` and is cut only when the next item does not fit."""
    client = live(strict, maxTextBytes=limit)
    changes = [NodeChange(f"vtkMRMLModelNode{i}", matrix=[i / 7] * 16) for i in range(400)]
    messages = client.send_changes(changes)
    assert len(messages) > 1 and max(encoded_size(m) for m in messages) <= limit
    assert _fills(messages, limit)
    assert [c["nodeId"] for m in messages for c in m["changes"]] == [c.node_id for c in changes]


def test_scene_updates_a_change_too_large_for_the_relay_needs_a_snapshot(strict):
    """A relay whose maxTextBytes cannot carry one change: no message, no version, a snapshot shows it instead."""
    client = live(strict, maxTextBytes=300)
    assert client.send_changes([NodeChange("vtkMRMLModelNode4", matrix=[1 / 3] * 16)]) == []
    assert client.versions.last == 1 and client.snapshot_needed


def test_scene_updates_plans_with_the_longest_envelope(strict):
    """Late in a long session IDs and versions have more digits: the split still keeps every message within the
    limit (it plans with a 32-character ID and uint32 versions)."""
    client = live(strict, maxTextBytes=2_000)
    client.versions.continue_from(2**32 - 10)
    client._next_id = 10**17  # message IDs u-<18 digits>: as long as the counter gets in practice
    changes = [NodeChange(f"vtkMRMLModelNode{i}", matrix=[i / 7] * 16) for i in range(20)]
    messages = client.send_changes(changes)
    assert len(messages) > 1 and all(encoded_size(m) <= 2_000 for m in messages)
    assert messages[-1]["sceneVersion"] <= 2**32 - 1


def test_scene_updates_uint32_exhaustion_uses_no_version(strict):
    client = live(strict, maxChanges=1)
    client.versions.continue_from(2**32 - 2)  # one version left
    changes = [
        NodeChange("vtkMRMLModelNode4", visible=False),
        NodeChange("vtkMRMLModelNode5", visible=False),
    ]
    with pytest.raises(OverflowError):
        client.send_changes(changes)
    assert client.versions.last == 2**32 - 2
    [last] = client.send_changes(changes[:1])  # exactly the last version still goes out
    assert (last["sceneVersion"], last["baseVersion"]) == (2**32 - 1, 2**32 - 2)
    held = live(strict, maxChanges=1)
    _snapshot(held)  # 2
    held.send_changes(changes)
    held.versions.continue_from(2**32 - 2)
    assert held.handle(ack(2)) == []  # inside handle(): never raises
    assert held.snapshot_needed and held.versions.last == 2**32 - 2


def test_scene_updates_size_is_what_the_transport_sends(strict):
    """``encoded_size`` measures the frame ``transport._encode`` builds, so a split message is never over its check."""
    client = live(strict)
    [message] = client.send_changes(
        [
            NodeChange(f"vtkMRMLModelNode{i}", matrix=moved(i / 3), color=(1 / 3, 0.5, 1.0))
            for i in range(300)
        ]
    )
    assert encoded_size(message) == len(transport_module._encode(message).encode("utf-8"))


def test_scene_updates_split_items_counts_commas_and_brackets():
    items = ["ab", "cd", "ef"]  # 4 bytes each as JSON
    base = encoded_size({"nodeIds": []})  # 13
    assert split_items(items, base_size=base, max_items=10, max_bytes=base + 4 + 1 + 4) == [
        ["ab", "cd"],
        ["ef"],
    ]
    assert encoded_size({"nodeIds": ["ab", "cd"]}) == base + 9
    assert split_items(items, base_size=base, max_items=10, max_bytes=base + 8) == [
        ["ab"],
        ["cd"],
        ["ef"],
    ]
    assert split_items(items, base_size=base, max_items=1, max_bytes=10_000) == [
        ["ab"],
        ["cd"],
        ["ef"],
    ]
    assert split_items([], base_size=base, max_items=1, max_bytes=10_000) == []
    with pytest.raises(MessageTooLargeError):
        split_items(["ab", "a" * 50], base_size=base, max_items=10, max_bytes=base + 20)


# --------------------------------------------------------------------------- held during a snapshot (§6.2)


def test_scene_updates_are_held_until_the_snapshot_ack(strict):
    """Criterion 4: nothing between begin and ack; the ack's replies carry the held messages on its version."""
    client = live(strict)
    _snapshot(client)  # version 2 in flight
    assert client.updates_held
    assert client.send_changes([NodeChange("vtkMRMLModelNode4", color=(1, 0, 0))]) == []
    assert client.send_changes([NodeChange("vtkMRMLModelNode4", opacity=0.5)]) == []
    assert client.send_removed(["vtkMRMLModelNode6"]) == []
    assert client.versions.last == 2  # no version used while held
    replies = client.handle(ack(2))
    assert shape(replies) == [("scene.update", 3, 2, 1), ("scene.nodeRemoved", 4, 3, 1)]
    assert replies[0]["changes"] == [
        {"nodeId": "vtkMRMLModelNode4", "color": [1.0, 0.0, 0.0], "opacity": 0.5}
    ]
    assert client.handle(ack(2)) == []  # released once
    assert not client.updates_held


def test_scene_updates_held_changes_keep_the_last_value_of_each_property(strict):
    """A drag and a toggle while a snapshot is on its way: the viewers get the final pose and visibility (§8.1)."""
    client = live(strict)
    _snapshot(client)
    for x in (0.01, 0.02, 0.03):  # three flushes of one transform drag
        client.send_changes([NodeChange("vtkMRMLModelNode4", matrix=moved(x))])
    client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    client.send_changes([NodeChange("vtkMRMLModelNode4", visible=True, opacity=0.4)])
    [update] = client.handle(ack(2))
    assert update["changes"] == [
        {"nodeId": "vtkMRMLModelNode4", "visible": True, "opacity": 0.4, "matrix": moved(0.03)}
    ]


def test_scene_updates_a_held_removal_wins_over_held_changes(strict):
    client = live(strict)
    _snapshot(client)
    client.send_changes(
        [
            NodeChange("vtkMRMLModelNode4", color=(1, 0, 0)),
            NodeChange("vtkMRMLModelNode5", visible=False),
        ]
    )
    client.send_removed(["vtkMRMLModelNode4"])
    client.send_changes([NodeChange("vtkMRMLModelNode4", opacity=0.1)])  # the node is gone
    replies = client.handle(ack(2))
    assert [m.get("changes") or m.get("nodeIds") for m in replies] == [
        [{"nodeId": "vtkMRMLModelNode5", "visible": False}],
        ["vtkMRMLModelNode4"],
    ]


def test_scene_updates_held_before_the_first_snapshot_are_dropped_by_it(strict):
    client = live(strict, acked=False)
    assert client.updates_held and client.state is SessionState.CREATED
    assert_held(client)
    _snapshot(client)
    assert client.handle(ack(1)) == []  # the export already had it


def test_scene_updates_a_new_snapshot_drops_what_was_held_before_its_begin(strict):
    client = live(strict)
    _snapshot(client)  # 2
    client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    client.send_removed(["vtkMRMLModelNode8"])
    _snapshot(client)  # 3 supersedes 2 (§6.2)
    client.send_removed(["vtkMRMLModelNode9"])  # after the second begin: kept
    assert client.handle(ack(2)) == []  # the superseded snapshot's ack releases nothing
    [removed] = client.handle(ack(3))
    assert shape([removed]) == [("scene.nodeRemoved", 4, 3, 1)]
    assert removed["nodeIds"] == ["vtkMRMLModelNode9"]


def test_scene_updates_a_refused_snapshot_needs_a_new_one(strict):
    client = live(strict)
    messages = _snapshot(client)
    client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    client.handle(_error("CAPACITY", messages.begin["id"]))
    assert client.snapshot_in_flight is None and client.snapshot_needed and client.updates_held
    assert_held(client)
    _snapshot(client)
    assert not client.snapshot_needed
    assert client.handle(ack(3)) == []


def test_scene_updates_release_after_an_ack_never_raises(strict):
    """handle() never raises for relay input: a relay whose maxTextBytes is too small for one change gets none."""
    client = live(strict, maxTextBytes=300)
    _snapshot(client)
    client.send_changes([NodeChange("vtkMRMLModelNode4", matrix=[1 / 3] * 16)])
    assert client.handle(ack(2)) == []
    assert client.snapshot_needed and client.versions.last == 2


# --------------------------------------------------------------------------- re-sync (§8.1)


@pytest.mark.parametrize("code", ["BAD_SEQUENCE", "RATE_LIMITED", "INVALID_MESSAGE"])
def test_scene_updates_an_error_answering_an_update_needs_a_snapshot(strict, code):
    client = live(strict)
    [update] = client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    client.handle(_error(code, update["id"]))
    assert client.snapshot_needed and client.updates_held
    assert_held(client)
    assert client.announce_added([("vtkMRMLModelNode9", "model")]) is None


def test_scene_updates_bad_sequence_without_reply_to_needs_a_snapshot(strict):
    client = live(strict)
    client.handle(_error("BAD_SEQUENCE"))
    assert client.snapshot_needed
    assert_held(client)


def test_scene_updates_capacity_without_reply_to_needs_no_snapshot(strict):
    """Without a snapshot in flight a CAPACITY error is about something else (e.g. a refused session.create)."""
    client = live(strict)
    client.handle(_error("CAPACITY"))
    assert not client.snapshot_needed


def test_scene_updates_an_error_for_an_update_before_the_snapshot_is_superseded(strict):
    """The relay refused an update sent before the current snapshot's begin: that snapshot already re-synced."""
    client = live(strict)
    [update] = client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    _snapshot(client)
    client.handle(_error("RATE_LIMITED", update["id"]))
    assert client.snapshot_in_flight == 3 and not client.snapshot_needed


@pytest.mark.parametrize("answered", ["ping", "renew", "u-x", "u-", "u-999999999999999999", None])
def test_scene_updates_other_errors_need_no_snapshot(strict, answered):
    """Errors answering other messages sent after the snapshot's begin (their IDs are above it) re-sync nothing."""
    client = live(strict)
    sent = {"ping": client.build_ping, "renew": client.build_session_renew}.get(answered)
    reply_to = sent()["id"] if sent else answered
    client.handle(_error("RATE_LIMITED", reply_to))
    assert not client.snapshot_needed and not client.updates_held


def test_scene_updates_a_lost_connection_needs_a_snapshot(strict):
    client = live(strict)
    client.transport_lost(1006)
    assert client.state is SessionState.GRACE and client.snapshot_needed


def test_scene_updates_require_snapshot_holds_updates_until_the_next_begin(strict):
    """SLC-29: a snapshot that cannot begin now (too large, a back-off) keeps updates held; no message, no version."""
    client = live(strict)
    client.require_snapshot()
    assert client.snapshot_needed and client.updates_held and client.versions.last == 1
    assert_held(client)
    client.handle(ack(1))  # a late ack changes nothing
    assert client.snapshot_needed
    _snapshot(client)  # version 2 drops what was held
    assert not client.snapshot_needed
    assert client.handle(ack(2)) == [] and not client.updates_held


@pytest.mark.parametrize("state", ["idle", "connecting", "closed"])
def test_scene_updates_require_snapshot_without_a_session_does_nothing(strict, state):
    client = ProtocolClient(make_client_info("5.12.4", "linux"), validate=strict, auto_renew=False)
    if state != "idle":
        client.start("mobile")
    if state == "closed":
        client.close()
    client.require_snapshot()
    assert not client.snapshot_needed


@pytest.mark.parametrize("state", [SessionState.GRACE, SessionState.RESUMING])
def test_scene_updates_require_snapshot_while_the_connection_is_lost(strict, state):
    """After a resume SLC-17 may find the relay up to date (no snapshot needed): a later request still holds."""
    client = live(strict)
    client.state = state  # as SLC-17 leaves it after comparing versions
    client.require_snapshot()
    assert client.snapshot_needed


def test_scene_updates_close_forgets_what_was_held(strict):
    client = live(strict)
    _snapshot(client)
    client.send_changes([NodeChange("vtkMRMLModelNode4", visible=False)])
    client.send_removed(["vtkMRMLModelNode5"])
    client.handle(_error("BAD_SEQUENCE"))
    client.close()
    # nothing can send them any more: no node ID outlives the session in memory
    assert not client.snapshot_needed and not client._held_changes and not client._held_removed
    create = client.start("mobile")
    client.handle(created(create["id"]))
    _snapshot(client)
    assert client.handle(ack(1)) == []


# --------------------------------------------------------------------------- scene.nodeAdded (§8.2)


def test_scene_updates_node_added_comes_before_its_snapshot(strict):
    """Criterion 2: the hint, then a snapshot with a higher version; nothing in between."""
    client = live(strict)
    added = client.announce_added(
        [("vtkMRMLModelNode9", "model"), ("vtkMRMLSegmentationNode1/Segment_2", "segment")]
    )
    assert added is not None and shape([added]) == [("scene.nodeAdded", 2, 1, 2)]
    assert added["snapshotFollows"] is True and "name" not in json.dumps(added)
    assert client.snapshot_needed and client.updates_held
    assert_held(client)  # §8.2: nothing between the hint and the snapshot's begin
    assert client.announce_added([("vtkMRMLModelNode10", "model")]) is None  # one hint per snapshot
    assert _snapshot(client).begin["sceneVersion"] == 3
    assert not client.snapshot_needed


def test_scene_updates_node_added_is_skipped_when_it_cannot_be_right(strict):
    client = live(strict, maxChanges=2)
    assert client.announce_added([]) is None
    assert client.announce_added([(f"vtkMRMLModelNode{i}", "model") for i in range(3)]) is None
    _snapshot(client)
    assert (
        client.announce_added([("vtkMRMLModelNode9", "model")]) is None
    )  # in flight: the snapshot follows anyway
    assert client.versions.last == 2 and not client.snapshot_needed
    assert live(strict, acked=False).announce_added([("vtkMRMLModelNode9", "model")]) is None


@pytest.mark.parametrize("limit", [150, 4_096])
def test_scene_updates_node_added_that_does_not_fit_one_message_is_skipped(strict, limit):
    """The relay's maxTextBytes: one hint per snapshot, so a hint that needs two messages (or cannot carry one node)
    is not sent and uses no version."""
    client = live(strict, maxTextBytes=limit)
    nodes = [(f"vtkMRMLSegmentationNode1/{'S' * 90}{i:03d}", "segment") for i in range(40)]
    assert client.announce_added(nodes) is None
    assert client.versions.last == 1 and not client.snapshot_needed and not client.updates_held


@pytest.mark.parametrize(
    "node",
    [("vtkMRMLModelNode9", "volume"), ("", "model"), ("a b", "segment"), ("Doe John", "model")],
)
def test_scene_updates_node_added_refuses_bad_ids_and_kinds(node):
    """Without the schemas, as in Slicer: the client's own checks refuse them, never repeating the ID (T7)."""
    client = live(None)
    with pytest.raises(ValueError, match=r"node ID|kind") as refused:
        client.announce_added([node])
    assert client.versions.last == 1 and not client.snapshot_needed
    assert "Doe" not in str(refused.value)


def test_scene_updates_node_added_lists_each_node_once(strict):
    client = live(strict)
    added = client.announce_added(
        [
            ("vtkMRMLModelNode9", "model"),
            ("vtkMRMLModelNode9", "segment"),
        ]
    )
    assert added["nodes"] == [{"nodeId": "vtkMRMLModelNode9", "kind": "model"}]  # the first kind


def test_scene_updates_node_added_of_one_node_too_large_is_skipped(strict):
    client = live(strict, maxTextBytes=150)
    assert client.announce_added([(LONG_ID, "segment")]) is None
    assert client.versions.last == 1 and not client.snapshot_needed


# --------------------------------------------------------------------------- privacy (T7)


def test_scene_updates_log_no_node_id(strict, caplog):
    caplog.set_level(logging.DEBUG)
    client = live(strict)
    [update] = client.send_changes([NodeChange("Doe_John_liver", visible=False)])
    client.handle(_error("BAD_SEQUENCE", update["id"]))
    _snapshot(client)
    client.send_removed(["Doe_John_liver"])
    client.handle(ack(3))
    assert "Doe" not in caplog.text


# --------------------------------------------------------------------------- end to end


def _connected(events: queue.Queue) -> int:
    """The connection of the transport's first ``Connected`` event."""
    while True:
        event = events.get(timeout=10)
        if isinstance(event, Connected):
            return event.connection


@needs_relay_stub
def test_scene_updates_end_to_end_with_the_relay_stub():
    """Real client, transport and relay stub (which checks every version rule, §6.2, §8.1, §8.4): a snapshot, updates
    held during it, removals, the nodeAdded hint and the snapshot after it, and an update on top."""
    stub = start_relay_stub("--report-updates")
    events: queue.Queue = queue.Queue()
    transport = RelayTransport(stub.address, events, use_proxy=False)
    transport.start()
    try:
        client = ProtocolClient(make_client_info("5.12.4", sys.platform), auto_renew=False)
        deadline = time.monotonic() + 10
        connection = _connected(events)

        def pump(until) -> None:
            """Feed inbound messages to the client and send its replies (the panel's pump) until ``until()``."""
            while not until():
                event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                assert not isinstance(event, Disconnected), "the connection dropped"
                if isinstance(event, Received) and isinstance(event.message, dict):
                    for reply in client.handle(event.message):
                        assert transport.send(reply, connection=connection)

        assert transport.send(client.start("mobile"), connection=connection)
        pump(lambda: client.state is SessionState.CREATED)
        scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})

        def send_snapshot(during) -> int:
            """The frames, with ``during()`` run once ``begin`` and the first chunk are out: anything it sent would
            arrive inside the snapshot, which the stub reports (§6.2)."""
            snapshot = build_snapshot(scene, client, slicer_version="5.12.4")
            for index, frame in enumerate(snapshot.frames()):
                assert transport.send(frame, connection=connection)
                if index == 1:
                    during()
            return snapshot.scene_version

        def send(messages) -> None:
            for message in messages:
                assert transport.send(message, connection=connection)

        red = [NodeChange("vtkMRMLModelNode4", color=(1, 0, 0))]
        first = send_snapshot(lambda: send(client.send_changes(red)))  # 1, the change held
        send(client.send_changes(red))  # still held: no ack yet
        pump(lambda: client.accepted_version == first)  # update 2
        send(client.send_changes(colours(1200)))  # 3, 4
        send(client.send_removed(["vtkMRMLModelNode4"]))  # 5
        send([client.announce_added([("vtkMRMLModelNode4", "model")])])  # 6
        # held: the announced snapshot comes next (§8.2), and drops them
        send(client.send_changes(red))
        send(client.send_removed(["vtkMRMLModelNode4"]))
        second = send_snapshot(lambda: send(client.send_removed(["vtkMRMLModelNode4"])))  # 7, held
        pump(lambda: client.accepted_version == second)  # 8
        send(client.send_changes([NodeChange("vtkMRMLModelNode4", opacity=0.5)]))  # 9
        # the stub answers in order: its pong means it has everything sent before
        send([client.build_ping()])
        pump(lambda: not client.ping_outstanding)
        assert transport.stop(client.close(), timeout=3)
    finally:
        transport.stop(timeout=3)
        out = stub.finish()
    report = json.loads(out.splitlines()[-1])
    assert report["violations"] == []
    assert report["updates"] == [
        ["scene.update", 2, 1],
        ["scene.update", 3, 2],
        ["scene.update", 4, 3],
        ["scene.nodeRemoved", 5, 4],
        ["scene.nodeAdded", 6, 5],
        ["scene.nodeRemoved", 8, 7],
        ["scene.update", 9, 8],
    ]
