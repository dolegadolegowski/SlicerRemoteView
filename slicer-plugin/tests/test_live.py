"""SLC-29: the live update controller — marks → flushes → updates or re-exports, holds, reset, pacing, lifecycle, T7
(docs/protocol.md §6.2, §7.3, §8.1–8.2, §9.2; FR-11, FR-12, NFR-02; T2, T7). A fake timer and clock drive the
debouncer; the client validates every message against the protocol's schemas."""

from __future__ import annotations

import itertools
import logging
import math

import numpy as np
import pytest
from support import (
    FakeTimer,
    LiveScene,
    ack,
    live_client,
    manifest,
    reassemble,
    root_extras,
    sphere,
)
from vtkmodules.vtkCommonTransforms import vtkTransform

from remoteview_core.collect import polydata_from_triangles
from remoteview_core.debounce import Change
from remoteview_core.ids import SceneIds
from remoteview_core.live import (
    RESET_NOT_SENT,
    RESET_REFUSED,
    LiveEventKind,
    LiveUpdates,
)
from remoteview_core.protocol_client import ProtocolStateError, SessionState
from remoteview_core.snapshot import build_snapshot
from remoteview_protocol import envelope, schemas

A, B, C, D = (f"vtkMRMLModelNode{i}" for i in (4, 5, 6, 7))
SHEAR = np.array([[1.0, 0.5, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
#: three collinear points: one triangle without area, so no triangle to export (``no-triangles``)
DEGENERATE = polydata_from_triangles(
    np.array([[0.0, 0, 0], [1, 0, 0], [2, 0, 0]]), np.array([[0, 1, 2]])
)
#: a mesh too large for ``SMALL_LIMIT`` once its neighbours fit
BIG = sphere(64)
SMALL_LIMIT = 40_000


@pytest.fixture(scope="module")
def strict():
    compiled = schemas.compile_schemas()
    return lambda message: schemas.validate_message(message, None, compiled)


def moved(x: float) -> np.ndarray:
    world = np.eye(4)
    world[0, 3] = x
    return world


def error(code: str, reply_to: str | None = None, **details) -> dict:
    message = envelope.make(
        "error", reply_to=reply_to, code=code, message=f"{code} for test", retryable=True
    )
    if details:
        message["details"] = details
    return message


class Rig:
    """A live session: ``LiveUpdates`` on a validating client, a fake timer and clock, and a scene that changes like
    MRML. ``sent`` records what the controller and the client hand to the transport."""

    def __init__(
        self,
        strict,
        scene: LiveScene,
        *,
        export=build_snapshot,
        anonymize=False,
        ids=None,
        **limits,
    ):
        self.timer = FakeTimer()
        self.client = live_client(validate=strict, **limits)
        self.scene = scene
        self.sent: list = []
        self.discarded = 0
        self.ended: list[str] = []
        self.events: list = []
        self.exports = 0  # export attempts (a too-large one sends nothing)

        def counted(*args, **options):
            self.exports += 1
            return export(*args, **options)

        # the panel's side, replaceable by a test
        self.read_scene = lambda: self.scene
        self.send = self.sent.append
        self.on_event = self.events.append
        self.end_session = self.ended.append
        self.live = LiveUpdates(
            self.client,
            scene=self._read_scene,
            send=self._send,
            discard_queued=self._discard,
            timer=self.timer,
            clock=self.timer.clock,
            slicer_version="5.12.4",
            end_session=self._end_session,
            on_event=self._on_event,
            export=counted,
            anonymize_names=anonymize,
            ids=ids,
        )
        self.timer.callback = self.live.flush

    # late-bound, so a test can replace read_scene, send, end_session, on_event or discard_hook
    def _read_scene(self):
        return self.read_scene()

    def _send(self, frame):
        return self.send(frame)

    def _end_session(self, text):
        return self.end_session(text)

    def _on_event(self, event):
        return self.on_event(event)

    def _discard(self) -> None:
        self.discarded += 1
        self.discard_hook()

    def discard_hook(self) -> None:
        pass

    def relay(self, message: dict) -> None:
        """One relay message, as the panel handles it: the client's replies go out, then ``observe``."""
        self.sent.extend(self.client.handle(message))
        self.live.observe()

    def ack(self) -> None:
        self.relay(ack(self.client.snapshot_in_flight))

    def started(self) -> Rig:
        """The first snapshot sent and acknowledged; ``sent`` emptied."""
        self.live.start()
        self.ack()
        self.take()
        return self

    def advance(self, ms: float) -> None:
        """Time passes: the flush timer fires, then the pump ticks."""
        self.timer.advance(ms)
        self.live.tick()

    def wait(self, seconds: float, step_ms: float = 100.0) -> None:
        """The pump ticking every ``step_ms`` for ``seconds``."""
        for _ in range(round(seconds * 1000 / step_ms)):
            self.advance(step_ms)

    def at(self, seconds: float) -> None:
        """The pump ticks at absolute clock time ``seconds``."""
        self.advance(seconds * 1000 - self.timer.now)

    def take(self) -> list[dict]:
        messages = [m for m in self.sent if isinstance(m, dict)]
        self.sent.clear()
        return messages

    def begins(self) -> list[dict]:
        return [m for m in self.take() if m["type"] == "scene.snapshot.begin"]

    def begin_id(self) -> str:
        [begin] = [
            m for m in self.sent if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"
        ]
        return begin["id"]

    def kinds(self) -> list[LiveEventKind]:
        return [e.kind for e in self.events]


def two(strict, **kw) -> Rig:
    return Rig(strict, LiveScene({"id": A}, {"id": B}), **kw)


def update_id(rig: Rig) -> str:
    """Send a colour change of A as one ``scene.update``; its message ID."""
    grey = round(rig.timer.now % 1000 / 1000, 3)  # a new colour each time
    rig.scene.node(A)["color"] = (
        (grey, 0.5, 0.5) if (grey, 0.5, 0.5) != rig.live.sent.get(A).color else (0.1, 0.1, 0.1)
    )
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    [update] = rig.take()
    assert update["type"] == "scene.update"
    return update["id"]


# --------------------------------------------------------------------------- A. the flush pipeline (criterion 1)


def test_live_first_snapshot_installs_sent_and_holds_marks_until_its_ack(strict):
    rig = two(strict)
    rig.live.start()
    [begin] = rig.begins()
    assert begin["sceneVersion"] == 1 and begin["nodeCount"] == 2
    assert A in rig.live.sent and B in rig.live.sent  # installed at begin, not at the ack
    assert rig.kinds() == [LiveEventKind.SENT]
    rig.scene.node(A)["color"] = (0.1, 0.2, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(3)
    assert rig.take() == []  # held while the snapshot is in flight
    rig.relay(ack(1))
    assert rig.kinds()[-1] is LiveEventKind.ACKED
    rig.advance(0)  # the release hands the marks over at 0 ms
    [update] = rig.take()
    assert (update["type"], update["sceneVersion"], update["baseVersion"]) == ("scene.update", 2, 1)
    assert update["changes"] == [{"nodeId": A, "color": [0.1, 0.2, 0.3]}]
    assert rig.live.sent.get(A).color == (0.1, 0.2, 0.3)


def test_live_start_needs_a_created_session(strict):
    rig = two(strict)
    rig.client.close()
    with pytest.raises(ProtocolStateError):
        rig.live.start()
    assert not rig.live.running and rig.sent == []


def test_live_fifty_appearance_marks_and_a_transform_give_one_update(strict):
    rig = two(strict).started()
    for i in range(50):  # every 2 ms for 100 ms
        rig.timer.advance(2)
        rig.scene.node(A)["opacity"] = 0.5 + i / 100
        rig.live.mark(A, Change.APPEARANCE)
    rig.scene.node(B)["world"] = moved(10.0)
    rig.live.mark_transform(B)  # at 100 ms
    rig.advance(149)
    assert rig.take() == []
    rig.advance(1)  # 150 ms after the last mark (and 250 ms after the first)
    [update] = rig.take()
    assert update["type"] == "scene.update"
    assert [c["nodeId"] for c in update["changes"]] == [A, B]
    assert update["changes"][0] == {"nodeId": A, "opacity": 0.99}
    assert set(update["changes"][1]) == {"nodeId", "matrix"}
    rig.live.mark(A, Change.APPEARANCE)  # nothing changed since
    rig.wait(1)
    assert rig.take() == []


def test_live_removed_mark_sends_node_removed(strict):
    rig = two(strict).started()
    rig.scene.remove(B)
    rig.live.mark(B, Change.REMOVED)
    rig.advance(150)
    [removed] = rig.take()
    assert (removed["type"], removed["nodeIds"]) == ("scene.nodeRemoved", [B])
    assert B not in rig.live.sent


def test_live_added_mark_announces_then_begins(strict):
    rig = two(strict).started()
    rig.scene.add(C)
    rig.live.mark(C, Change.ADDED)
    rig.advance(749)
    assert rig.take() == []
    rig.advance(1)
    frames = list(rig.sent)
    messages = rig.take()
    assert [m["type"] for m in messages] == [
        "scene.nodeAdded",
        "scene.snapshot.begin",
        "scene.snapshot.end",
    ]
    added, begin, _ = messages
    assert added["nodes"] == [{"nodeId": C, "kind": "model"}] and added["snapshotFollows"] is True
    assert (added["sceneVersion"], added["baseVersion"], begin["sceneVersion"]) == (2, 1, 3)
    assert any(isinstance(f, bytes) for f in frames)  # the chunks between begin and end
    assert C in rig.live.sent  # before the ack


def test_live_geometry_mark_in_flight_waits_for_the_ack(strict):
    rig = two(strict)
    rig.live.start()
    rig.take()
    rig.live.mark(A, Change.GEOMETRY)
    rig.wait(5)
    assert rig.take() == []
    rig.relay(ack(1))
    rig.advance(0)
    assert [b["sceneVersion"] for b in rig.begins()] == [2]
    rig.ack()
    rig.wait(3)
    assert rig.begins() == []


def test_live_unmatched_release_keeps_the_in_flight_hold(strict):
    rig = two(strict)
    rig.live.start()
    rig.take()
    rig.live.release()  # an EndBatchProcessEvent without its start
    rig.live.hold()
    rig.live.release()
    rig.live.release()
    rig.live.mark(
        A, Change.GEOMETRY
    )  # an appearance mark would pass without the guard (the client holds it)
    rig.wait(5)
    assert rig.take() == []
    rig.relay(ack(1))
    rig.advance(0)
    assert [b["sceneVersion"] for b in rig.begins()] == [2]


def test_live_update_plan_applies_sent_only_after_sending(strict, monkeypatch):
    rig = two(strict).started()
    held = rig.live.sent.get(A).color

    def refuse(changes):
        raise RuntimeError("transport")

    monkeypatch.setattr(rig.client, "send_changes", refuse)
    rig.scene.node(A)["color"] = (0.1, 0.2, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    assert rig.live.sent.get(A).color == held
    assert rig.client.snapshot_needed  # a snapshot shows it instead
    assert rig.kinds()[-1] is LiveEventKind.FAILED


def test_live_an_empty_plan_is_applied_too(strict):
    """``forget``: a node the export left out, marked while hidden, is forgotten — shown again, it re-exports."""
    rig = Rig(strict, LiveScene({"id": A}, {"id": D, "mesh": DEGENERATE}))
    rig.started()
    assert D in rig.live.sent.skipped
    rig.scene.node(D)["visible"] = False
    rig.live.mark(D, Change.GEOMETRY)
    rig.advance(750)
    assert rig.take() == [] and D not in rig.live.sent.skipped


def test_live_batch_holds_are_counted(strict):
    rig = two(strict).started()
    rig.live.hold()
    rig.live.hold()
    rig.scene.node(A)["visible"] = False
    rig.live.mark(A, Change.APPEARANCE)
    rig.live.release()
    rig.wait(2)
    assert rig.take() == []
    rig.live.release()
    rig.advance(0)
    [update] = rig.take()
    assert update["changes"] == [{"nodeId": A, "visible": False}]


def test_live_mark_transform_lanes(strict):
    rig = Rig(
        strict,
        LiveScene({"id": A}, {"id": B, "world": SHEAR}, {"id": D, "mesh": DEGENERATE}),
    ).started()
    assert rig.live.sent.get(B).matrix is None  # baked
    rig.scene.node(A)["world"] = moved(5.0)
    rig.live.mark_transform(A)
    assert rig.timer.starts[-1] == 150
    rig.advance(150)
    [update] = rig.take()
    assert set(update["changes"][0]) == {"nodeId", "matrix"}
    rig.scene.node(B)["world"] = SHEAR @ moved(5.0)
    rig.live.mark_transform(B)
    assert rig.timer.starts[-1] == 750  # FR-12: the slow lane
    rig.advance(749)
    assert rig.take() == []
    rig.advance(1)
    assert len(rig.begins()) == 1
    rig.ack()
    rig.live.mark_transform(D)  # left out by the export: never geometry
    assert rig.timer.starts[-1] == 150


def test_live_degenerate_mesh_under_sheared_transform_drag_sends_no_begin(strict):
    """SLC-30 review parts 1-3: a node left out for its own mesh under a dragged sheared transform."""
    rig = Rig(strict, LiveScene({"id": A}, {"id": D, "mesh": DEGENERATE, "world": SHEAR}))
    rig.started()
    assert rig.live.sent.skipped[D].baked is False
    for step in range(4):
        rig.scene.node(D)["world"] = SHEAR @ moved(step + 1.0)
        rig.live.mark_transform(D)
        rig.wait(1)
    assert rig.take() == []


def test_live_tick_never_exports_while_a_flush_is_pending_held_or_in_flight(strict):
    rig = two(strict).started()
    rig.live.request_snapshot()
    rig.live.mark(A, Change.GEOMETRY)
    rig.live.tick()
    assert rig.take() == []  # the flush comes first: its plan announces what it adds
    rig.advance(750)
    assert len(rig.begins()) == 1
    rig.live.request_snapshot()
    rig.wait(2)
    assert rig.begins() == []  # in flight
    rig.live.hold()
    rig.ack()
    rig.wait(2)
    assert rig.begins() == []  # a batch runs
    rig.live.release()
    rig.live.tick()
    assert len(rig.begins()) == 1


# --------------------------------------------------------------------------- B. reset (criterion 2)


def test_live_reset_in_flight_discards_and_supersedes(strict):
    rig = two(strict)
    rig.live.start()
    rig.take()
    rig.live.hold()  # Close Scene runs inside a batch
    rig.scene = LiveScene({"id": A, "color": (0.0, 1.0, 0.0)})  # the next scene reuses A
    rig.live.reset()
    assert rig.discarded == 1
    assert A not in rig.live.sent  # no update can address the closed scene's A
    rig.wait(2)
    assert rig.take() == []
    rig.live.release()
    rig.advance(0)
    messages = rig.take()
    assert [m["type"] for m in messages] == ["scene.snapshot.begin", "scene.snapshot.end"]
    assert messages[0]["sceneVersion"] == 2  # without waiting for version 1's ack
    rig.relay(ack(2))
    assert rig.live.sent.get(A).color == (0.0, 1.0, 0.0) and B not in rig.live.sent
    rig.live.mark(B, Change.APPEARANCE)  # the closed scene's node
    rig.wait(1)
    assert rig.take() == []


def test_live_reset_too_large_sends_an_empty_snapshot(strict):
    rig = two(strict, maxSnapshotBytes=SMALL_LIMIT).started()
    rig.live.hold()
    rig.scene = LiveScene({"id": A}, {"id": C, "mesh": BIG})
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    messages = rig.take()
    assert [m["type"] for m in messages] == ["scene.snapshot.begin", "scene.snapshot.end"]
    assert messages[0]["nodeCount"] == 0  # §7.3: the closed scene is off the viewers
    assert len(rig.live.sent) == 0
    assert rig.kinds()[-2:] == [LiveEventKind.SENT, LiveEventKind.TOO_LARGE]
    exports = rig.exports
    rig.ack()  # the empty scene's ack keeps the too-large gate
    assert rig.client.snapshot_needed and rig.client.updates_held
    rig.scene.node(A)["color"] = (0.2, 0.2, 0.2)
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(65)
    assert (
        rig.take() == [] and rig.exports == exports
    )  # a colour change cannot shrink it: no attempt
    rig.scene.node(C)["visible"] = False
    rig.live.mark(C, Change.APPEARANCE)
    rig.advance(150)
    [begin] = rig.begins()
    assert begin["nodeCount"] == 1


def test_live_reset_with_nothing_buildable_ends_the_session(strict, caplog):
    calls = []

    def export(scene_api, client, **options):
        calls.append(scene_api)
        if len(calls) > 1:
            raise KeyError(f"{A} Liver Smith")
        return build_snapshot(scene_api, client, **options)

    rig = two(strict, export=export).started()
    rig.live.hold()
    rig.live.reset()
    with caplog.at_level(logging.DEBUG):
        rig.live.release()
        rig.advance(0)
    assert rig.ended == [RESET_NOT_SENT] and rig.take() == []
    assert not rig.live.running and len(calls) == 3  # the scene, then the empty one
    assert A not in caplog.text and "Smith" not in caplog.text and "KeyError" in caplog.text


def test_live_reset_snapshot_refused_ends_the_session(strict):
    rig = two(strict).started()
    rig.live.hold()
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id, retryAfterS=1))
    assert rig.ended == [RESET_REFUSED] and rig.discarded == 1
    assert not rig.live.running
    rig.wait(5)
    assert rig.take() == []


# --------------------------------------------------------------------------- C. pacing (criterion 3, T2)


def refuse_next_snapshot(rig: Rig, code: str, **details) -> float:
    """Ask for a snapshot, let it begin, have the relay refuse it; the clock time of the refusal."""
    rig.live.request_snapshot()
    rig.live.tick()
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error(code, begin_id, **details))
    return rig.timer.clock()


def first_begin_at(rig: Rig, expected: float) -> None:
    """The next ``begin`` goes out at clock time ``expected`` (s), not 1 ms before."""
    rig.at(expected - 0.001)
    assert rig.begins() == []
    rig.at(expected)
    assert len(rig.begins()) == 1


@pytest.mark.parametrize(
    "shrink",
    ["hide", "remove", "geometry", "request_snapshot"],
)
def test_live_payload_too_large_waits_for_a_shrinking_change(strict, shrink):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    assert rig.discarded == 1
    assert rig.kinds()[-1] is LiveEventKind.REFUSED and rig.events[-1].code == "PAYLOAD_TOO_LARGE"
    rig.wait(65)
    rig.scene.node(A)["color"] = (0.3, 0.3, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(2)
    assert rig.take() == []  # not on ticks, not on a colour change
    if shrink == "hide":
        rig.scene.node(B)["visible"] = False
        rig.live.mark(B, Change.APPEARANCE)
    elif shrink == "remove":
        rig.scene.remove(B)
        rig.live.mark(B, Change.REMOVED)
    elif shrink == "geometry":
        rig.live.mark(B, Change.GEOMETRY)
    else:
        rig.live.request_snapshot()
    rig.wait(1)
    assert len(rig.begins()) == 1


def test_live_local_too_large_behaves_like_the_relay_refusal(strict):
    rig = Rig(strict, LiveScene({"id": A}, {"id": C, "mesh": BIG}), maxSnapshotBytes=SMALL_LIMIT)
    rig.live.start()
    assert rig.take() == [] and rig.kinds() == [LiveEventKind.TOO_LARGE]
    assert rig.events[0].too_large.limit == SMALL_LIMIT
    assert rig.client.snapshot_needed and rig.client.versions.last == 0
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(65)
    assert rig.take() == [] and rig.exports == 1  # a re-export plan waits for its gate
    rig.scene.node(C)["visible"] = False
    rig.live.mark(C, Change.APPEARANCE)
    rig.wait(1)
    [begin] = rig.begins()
    assert (begin["sceneVersion"], begin["nodeCount"]) == (1, 1)


RETRY_AFTER = [
    ({}, 2.0),
    ({"retryAfterS": 30}, 30.0),
    ({"retryAfterS": 0}, 2.0),
    ({"retryAfterS": -1}, 2.0),
    ({"retryAfterS": math.nan}, 2.0),
    ({"retryAfterS": math.inf}, 2.0),
    ({"retryAfterS": True}, 2.0),
    ({"retryAfterS": "30"}, 2.0),
    ({"retryAfterS": 1e9}, 600.0),
    ({"retryAfterS": 10**400}, 600.0),  # a JSON integer beyond the double range
]


@pytest.mark.parametrize(
    "code", ["CAPACITY", "INTERNAL", "RATE_LIMITED", "CHECKSUM_MISMATCH", "SLOW_CONSUMER"]
)
@pytest.mark.parametrize(("details", "wait"), RETRY_AFTER)
@pytest.mark.parametrize("answering", ["snapshot", "update"])
def test_live_busy_codes_honour_retry_after_or_back_off(strict, code, details, wait, answering):
    rig = two(strict).started()
    if answering == "snapshot":
        failed = refuse_next_snapshot(rig, code, **details)
    else:
        reply_to = update_id(rig)
        rig.relay(error(code, reply_to, **details))
        failed = rig.timer.clock()
    assert rig.client.snapshot_needed
    first_begin_at(rig, failed + wait)


def test_live_an_unknown_error_code_backs_off():
    """A code a later protocol version adds (not in this schema's enum): like the busy codes."""
    rig = Rig(None, LiveScene({"id": A})).started()
    failed = refuse_next_snapshot(rig, "NEW_CODE", retryAfterS=7)
    first_begin_at(rig, failed + 7)


def test_live_back_off_doubles_and_caps_at_60_s(strict):
    rig = two(strict).started()
    rig.live.request_snapshot()
    waits = []
    for _ in range(7):
        rig.live.tick()  # the owed snapshot
        begin_id = rig.begin_id()
        rig.take()
        rig.relay(error("CAPACITY", begin_id))
        failed = rig.timer.clock()
        rig.live.mark(A, Change.APPEARANCE)  # a change after each failure (the flush gate)
        for _ in range(700):  # at most 70 s
            if any(isinstance(m, dict) for m in rig.sent):
                break
            rig.advance(100)
        waits.append(round(rig.timer.clock() - failed, 1))
    assert waits == [2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0]


@pytest.mark.parametrize(
    "resync",
    ["BAD_SEQUENCE", "INVALID_MESSAGE", "PAYLOAD_TOO_LARGE"],
)
def test_live_resync_codes_resend_at_once_then_back_off(strict, resync):
    rig = two(strict).started()

    def fail() -> float:
        reply_to = update_id(rig)
        # BAD_SEQUENCE may come without replyTo (§9.2)
        rig.relay(error(resync, None if resync == "BAD_SEQUENCE" else reply_to))
        return rig.timer.clock()

    failed = fail()
    rig.live.tick()
    assert len(rig.begins()) == 1  # at once
    rig.ack()
    rig.advance(1000)
    failed = fail()  # 1 s after the re-sync's ack
    first_begin_at(rig, failed + 2.0)
    rig.ack()
    rig.wait(10)
    fail()  # 10 s of quiet
    rig.live.tick()
    assert len(rig.begins()) == 1


@pytest.mark.parametrize("code", ["BAD_SEQUENCE", "INVALID_MESSAGE"])
def test_live_a_snapshot_refused_for_its_sequence_is_sent_again_at_once(strict, code):
    rig = two(strict).started()
    refuse_next_snapshot(rig, code)
    rig.live.tick()
    begin_id = rig.begin_id()  # at once: a re-sync
    rig.take()
    rig.relay(error(code, begin_id))
    first_begin_at(rig, rig.timer.clock() + 2.0)  # the second without an ack backs off


def test_live_max_text_bytes_resyncs_under_the_same_rule(strict):
    rig = two(strict, maxTextBytes=240).started()
    for _ in range(2):
        rig.scene.node(A)["world"] = moved(rig.timer.now + 1.0)
        rig.live.mark_transform(A)  # a matrix change does not fit 240 bytes, a colour would
        rig.advance(150)
        assert len(rig.begins()) == 1  # the re-sync, at once each time
        rig.ack()
        rig.wait(10)  # quiet: at once again


def test_live_max_text_bytes_within_10_s_of_a_resync_backs_off(strict):
    rig = two(strict, maxTextBytes=240).started()
    rig.scene.node(A)["world"] = moved(1.0)
    rig.live.mark_transform(A)
    rig.advance(150)
    assert len(rig.begins()) == 1
    rig.ack()
    rig.scene.node(A)["world"] = moved(2.0)
    rig.live.mark_transform(A)
    rig.advance(150)
    failed = rig.timer.clock()
    assert rig.begins() == []
    first_begin_at(rig, failed + 2.0)


def test_live_three_failures_without_an_ack_wait_for_a_flush(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "CAPACITY")  # back-off 2 s
    rig.wait(2)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id))  # 4 s
    rig.wait(4)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id))  # the third: 8 s, and a change is needed
    rig.wait(70)
    assert rig.take() == []
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    assert len(rig.begins()) == 1


@pytest.mark.parametrize(("after_ack", "wait"), [(60.0, 2.0), (59.9, 8.0)])
def test_live_back_off_streak_resets_60_s_after_an_ack(strict, after_ack, wait):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "CAPACITY")  # back-off 2 s
    rig.wait(2)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id))  # 4 s
    rig.wait(4)
    rig.take()
    rig.ack()
    acked = rig.timer.clock()
    rig.at(acked + after_ack - 0.15)
    reply_to = update_id(rig)  # 150 ms
    rig.relay(error("CAPACITY", reply_to))
    assert rig.timer.clock() == pytest.approx(acked + after_ack)
    first_begin_at(rig, rig.timer.clock() + wait)


def test_live_an_unreadable_scene_does_not_lift_the_too_large_gate(strict):
    rig = Rig(strict, Unreadable({"id": A}, {"id": B})).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    rig.scene.broken = True
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    rig.scene.broken = False
    rig.wait(70)
    assert rig.take() == []


def test_live_a_lost_connection_counts_as_a_resync(strict):
    """The re-sync after a resume makes the next re-sync within 10 s of its ack back off."""
    rig = two(strict).started()
    refuse_next_snapshot(rig, "CAPACITY")  # back-off step 1: 2 s
    rig.wait(2)
    assert len(rig.begins()) == 1
    rig.client.transport_lost()
    rig.live.observe()
    rig.client.state = SessionState.ACTIVE  # resumed (SLC-17)
    rig.live.observe()
    rig.live.tick()
    assert len(rig.begins()) == 1  # the first re-sync: at once
    rig.ack()
    rig.advance(1000)
    reply_to = update_id(rig)
    rig.relay(error("BAD_SEQUENCE", reply_to))
    first_begin_at(rig, rig.timer.clock() + 4.0)  # step 2


def test_live_retry_after_below_the_back_off_waits_the_back_off(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "CAPACITY")  # 2 s
    rig.wait(2)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id, retryAfterS=1))
    first_begin_at(rig, rig.timer.clock() + 4.0)


def test_live_a_later_failure_never_shortens_the_relays_wait(strict):
    rig = Rig(strict, Unreadable({"id": A}, {"id": B})).started()
    failed = refuse_next_snapshot(rig, "RATE_LIMITED", retryAfterS=100)
    rig.scene.broken = True  # a local failure: 4 s of back-off
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    rig.scene.broken = False
    first_begin_at(rig, failed + 100)


def test_live_updates_stay_held_while_owed(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    last = rig.client.versions.last
    rig.scene.node(A)["color"] = (0.4, 0.4, 0.4)
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(1)
    assert (
        rig.take() == [] and rig.client.versions.last == last
    )  # nothing went out, no version used
    rig.scene.remove(B)
    rig.live.mark(B, Change.REMOVED)  # lifts the too-large gate
    rig.wait(1)
    assert [m["type"] for m in rig.take()] == ["scene.snapshot.begin", "scene.snapshot.end"]


# --------------------------------------------------------------------------- D. lifecycle (criterion 4)


@pytest.mark.parametrize("paused", [SessionState.GRACE, SessionState.RESUMING])
@pytest.mark.parametrize("in_flight", [False, True])
def test_live_grace_holds_marks_and_resume_resyncs_at_once(strict, in_flight, paused):
    rig = two(strict)
    if in_flight:
        rig.live.start()
        rig.take()
    else:
        rig.started()
    kinds = rig.kinds()
    rig.client.transport_lost()
    rig.live.observe()
    assert rig.client.state is SessionState.GRACE
    rig.client.state = paused  # SLC-17 resumes through RESUMING
    rig.live.observe()
    assert rig.live.running
    assert rig.kinds() == kinds  # a lost snapshot is not an ack
    rig.scene.node(A)["color"] = (0.5, 0.1, 0.1)
    rig.live.mark(A, Change.APPEARANCE)
    assert rig.timer.deadline is None  # kept, not flushed
    rig.wait(5)
    assert rig.take() == []
    rig.client.state = SessionState.ACTIVE  # resumed (SLC-17)
    rig.live.observe()
    assert rig.timer.deadline == rig.timer.now  # the kept marks, at 0 ms
    rig.advance(0)
    messages = rig.take()
    assert [m["type"] for m in messages] == ["scene.snapshot.begin", "scene.snapshot.end"]
    rig.ack()
    assert rig.live.sent.get(A).color == (0.5, 0.1, 0.1)


def test_live_closed_stops_timer_drops_marks_and_ignores_later_marks(strict):
    rig = two(strict).started()
    rig.live.mark(A, Change.GEOMETRY)
    rig.sent.extend(m for m in [rig.client.close()] if m)
    rig.live.observe()
    assert not rig.live.running and rig.timer.deadline is None
    rig.take()
    rig.live.mark(A, Change.GEOMETRY)
    rig.live.reset()
    rig.live.hold()
    rig.wait(3)
    assert rig.take() == [] and rig.timer.deadline is None
    assert len(rig.live.sent) == 0


def test_live_tick_alone_sees_a_closed_session(strict):
    rig = two(strict).started()
    rig.client.close()
    rig.live.tick()
    assert not rig.live.running


def test_live_stop_with_a_flush_pending_sends_nothing(strict):
    rig = two(strict).started()
    rig.live.mark(A, Change.GEOMETRY)
    rig.live.stop()
    rig.live.flush()
    rig.live.stop()
    rig.wait(2)
    assert rig.take() == [] and not rig.live.running


def test_live_stop_inside_the_scene_factory_sends_nothing(strict):
    rig = two(strict).started()
    scene = rig.scene

    def stopping():
        rig.live.stop()
        return scene

    rig.read_scene = stopping  # the panel stopped while the flush read the scene
    last = rig.client.versions.last
    rig.live.mark(A, Change.GEOMETRY)
    rig.advance(750)
    assert rig.take() == [] and rig.client.versions.last == last


def test_live_send_to_a_dead_transport_then_transport_lost_raises_nothing(strict):
    rig = two(strict).started()
    rig.send = lambda frame: False  # a stopped transport drops frames
    rig.live.mark(A, Change.GEOMETRY)
    rig.advance(750)
    rig.client.transport_lost(1006)
    rig.live.observe()
    rig.wait(2)
    assert rig.client.snapshot_needed and rig.live.running


def test_live_hide_names_switch_reexports_when_allowed(strict):
    rig = Rig(strict, LiveScene({"id": A, "name": "Liver Smith"}))
    rig.live.start()
    rig.take()
    rig.live.set_anonymize_names(True)
    rig.wait(2)
    assert rig.take() == []  # in flight
    rig.ack()
    rig.live.tick()
    _, glb, _ = reassemble(list(rig.sent))
    assert len(rig.begins()) == 1
    assert root_extras(glb)["anonymizedNames"] is True
    assert rig.live.sent.anonymized and b"Smith" not in glb
    rig.ack()
    # a wait the relay asked for is honoured
    failed = refuse_next_snapshot(rig, "CAPACITY", retryAfterS=30)
    rig.live.set_anonymize_names(False)
    first_begin_at(rig, failed + 30)
    rig.ack()
    # under the too-large gate: one attempt
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    rig.live.set_anonymize_names(True)
    rig.live.tick()
    assert len(rig.begins()) == 1
    rig.live.set_anonymize_names(True)  # unchanged: nothing
    rig.ack()
    rig.wait(2)
    assert rig.begins() == []


SEG = "vtkMRMLSegmentationNode1"


def test_live_exports_segments_and_keeps_their_aliases_when_names_are_hidden(strict):
    """SLC-35, §7.3: the registry the panel hands in is the one every export uses — an alias issued by the first
    snapshot is the same in the snapshot *Hide node names* asks for."""
    ids = SceneIds()
    scene = LiveScene(
        {"id": A, "name": "Liver Smith"},
        {"id": SEG, "segment": "left lung", "name": "Left lung Smith"},
        {"id": SEG, "segment": "Tumor(1)", "name": "Tumor Smith"},
        {"id": SEG, "segment": "Segment_2", "name": "Spleen Smith"},
    )
    rig = Rig(strict, scene, ids=ids)
    assert rig.live.ids is ids
    rig.live.start()
    _, glb, _ = reassemble(list(rig.sent))
    assert [(m["nodeId"], m.get("segmentId")) for m in manifest(glb)] == [
        (A, None),
        (f"{SEG}/s_1", "left lung"),
        (f"{SEG}/s_2", "Tumor(1)"),
        (f"{SEG}/Segment_2", "Segment_2"),
    ]
    assert all(node_id in rig.live.sent for node_id in (A, f"{SEG}/s_1", f"{SEG}/Segment_2"))
    rig.take()
    rig.ack()
    scene.nodes[1]["visible"] = False  # the lung hidden: a fresh registry would give the tumour s_1
    rig.live.set_anonymize_names(True)
    rig.live.tick()
    _, glb, _ = reassemble(list(rig.sent))
    assert [(m["nodeId"], m.get("segmentId"), m["name"]) for m in manifest(glb)] == [
        (A, None, "Model 1"),
        (
            f"{SEG}/s_2",
            None,
            "Segment 1",
        ),  # the first export's alias: a registry per export renumbers
        (f"{SEG}/s_3", None, "Segment 2"),
    ]
    assert root_extras(glb)["anonymizedNames"] is True and b"Smith" not in glb


def test_live_registry_survives_start_and_stop_and_is_cleared_by_reset(strict):
    """D-a: ``start()``, ``stop()`` and a new session on the same controller keep the raw → alias maps (a resume
    must not renumber); ``reset()`` (the scene closed) clears them while the counters keep counting."""
    rig = two(strict)
    ids = rig.live.ids

    def alias() -> str:
        return ids.segment_node_id(SEG, "left lung", anonymize=False)

    assert alias() == f"{SEG}/s_1" and ids.model_node_id("Sphere") == "m_1"
    rig.live.start()
    assert alias() == f"{SEG}/s_1" and ids.model_node_id("Sphere") == "m_1"
    rig.live.stop()
    assert alias() == f"{SEG}/s_1" and ids.model_node_id("Sphere") == "m_1"
    rig.live._forget_session()
    assert alias() == f"{SEG}/s_1" and ids.model_node_id("Sphere") == "m_1"
    rig.live.start()
    rig.live.reset()
    assert (
        alias() == f"{SEG}/s_2" and ids.model_node_id("Sphere") == "m_2"
    )  # fresh numbers, never reused
    assert alias() == f"{SEG}/s_2"
    rig.live.stop()
    rig.live.reset()  # stopped: ignored, like every other call
    assert alias() == f"{SEG}/s_2"
    assert isinstance(
        Rig(strict, LiveScene()).live.ids, SceneIds
    )  # a registry of its own without one


def test_live_request_snapshot_lifts_shrink_and_the_flush_gate_but_not_retry_after(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    rig.live.request_snapshot()  # a smaller device profile may fit
    rig.live.tick()
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id))  # back-off 2 s
    rig.wait(2.1)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("CAPACITY", begin_id))  # the third failure without an ack: 4 s, and a change
    rig.wait(10)
    assert rig.take() == []
    rig.live.request_snapshot()
    rig.live.tick()
    assert len(rig.begins()) == 1
    rig.ack()
    failed = refuse_next_snapshot(rig, "RATE_LIMITED", retryAfterS=20)
    rig.live.request_snapshot()
    first_begin_at(rig, failed + 20)


def test_live_stopped_controller_ignores_everything(strict):
    rig = two(strict)
    for call in (
        lambda: rig.live.mark(A, Change.GEOMETRY),
        lambda: rig.live.mark_transform(A),
        rig.live.hold,
        rig.live.release,
        rig.live.reset,
        rig.live.observe,
        rig.live.tick,
        rig.live.flush,
        rig.live.request_snapshot,
        lambda: rig.live.set_anonymize_names(True),
    ):
        call()
    rig.wait(2)
    assert rig.sent == [] and rig.timer.deadline is None and not rig.client.snapshot_needed


# --------------------------------------------------------------------------- E. T7 (criterion 4)


class Unreadable(LiveScene):
    """The node list fails with a text that names a node (an adapter error)."""

    broken = False

    def visible_model_nodes(self):
        if self.broken:
            raise KeyError(f"{A} Liver Smith")
        return super().visible_model_nodes()


def test_live_scene_read_error_logs_only_the_type(strict, caplog):
    rig = Rig(strict, Unreadable({"id": A, "name": "Liver Smith"}, {"id": B})).started()
    rig.scene.broken = True
    exports = rig.exports
    with caplog.at_level(logging.DEBUG):
        rig.live.mark(A, Change.APPEARANCE)
        rig.advance(150)
        assert rig.take() == [] and rig.client.updates_held
        assert rig.kinds()[-1] is LiveEventKind.FAILED
        assert rig.exports == exports  # no export attempt before the back-off
        rig.scene.broken = False
        rig.at(rig.timer.clock() + 1.9)
        assert rig.begins() == []
        rig.advance(100)  # the back-off: 2 s
        assert len(rig.begins()) == 1
    assert "SceneReadError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


def test_live_export_keyerror_logs_only_the_type_and_backs_off(strict, caplog):
    attempts = []

    def export(scene_api, client, **options):
        if attempts:
            attempts.append(round(rig.timer.clock(), 3))
            raise KeyError(f"{A} Liver Smith")
        attempts.append(0.0)
        return build_snapshot(scene_api, client, **options)

    rig = two(strict, export=export).started()
    with caplog.at_level(logging.DEBUG):
        rig.live.mark(A, Change.GEOMETRY)
        rig.wait(60, step_ms=50)
    assert rig.take() == [] and rig.client.snapshot_needed and rig.client.updates_held
    # the flush at 0.75 s, then 2 s and 4 s of back-off; the third failure waits for a change
    assert attempts == [0.0, 0.75, 2.75, 6.75]
    assert rig.kinds()[2:] == [LiveEventKind.FAILED] * 3
    assert "KeyError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


def test_live_on_event_and_send_errors_never_escape(strict, caplog):
    rig = two(strict)

    def broken_panel(event):
        raise ValueError(f"{A} Liver Smith")

    rig.on_event = broken_panel
    with caplog.at_level(logging.DEBUG):
        rig.live.start()
        rig.ack()
        rig.take()

        def dead(frame):
            raise ConnectionError(f"{A}")

        rig.send = dead
        rig.live.mark(A, Change.GEOMETRY)
        rig.advance(750)
        rig.wait(3)
    assert rig.live.running and rig.client.snapshot_needed
    assert "ValueError" in caplog.text and "ConnectionError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


@pytest.mark.parametrize(
    ("node_id", "flags"),
    [
        (None, Change.APPEARANCE),
        ("", Change.APPEARANCE),
        (A, Change(0)),
        (A, 3),
        (["x"], Change.GEOMETRY),
    ],
)
def test_live_bad_mark_arguments_are_ignored(strict, caplog, node_id, flags):
    rig = two(strict).started()
    with caplog.at_level(logging.DEBUG, logger="remoteview_core.live"):
        rig.live.mark(node_id, flags)
        if node_id != A:
            rig.live.mark_transform(node_id)
    assert rig.timer.deadline is None and caplog.records == []  # ignored, not failed
    rig.wait(1)
    assert rig.take() == []


def test_live_repr_events_and_logs_of_a_full_run_hold_no_id_or_name(strict, caplog):
    rig = Rig(
        strict,
        LiveScene(
            {"id": A, "name": "Liver Smith"},
            {"id": B, "name": "Kidney Jones"},
            {
                "id": D,
                "name": "Line Doe",
                "mesh": DEGENERATE,
            },  # left out: listed in Snapshot.skipped
        ),
    )
    with caplog.at_level(logging.DEBUG):
        rig.started()
        rig.scene.node(A)["color"] = (0.9, 0.9, 0.9)
        rig.live.mark(A, Change.APPEARANCE)
        rig.advance(150)
        rig.scene.add(C, name="Spleen Brown")
        rig.live.mark(C, Change.ADDED)
        rig.advance(750)
        refuse_mid = rig.begin_id()
        rig.take()
        rig.relay(error("PAYLOAD_TOO_LARGE", refuse_mid))
        rig.live.hold()
        rig.live.reset()
        rig.live.release()
        rig.advance(0)
        rig.ack()
    text = " ".join(
        [repr(rig.live), repr(rig.live.sent), *(repr(e) for e in rig.events), caplog.text]
    )
    assert any(e.snapshot is not None and e.snapshot.skipped for e in rig.events)
    for secret in (A, B, C, D, "Smith", "Jones", "Brown", "Doe"):
        assert secret not in text


def test_live_a_flush_in_a_paused_session_keeps_the_reset(strict):
    """A reset whose flush is dropped (the session was not live then) still clears the closed scene: the next flush
    exports it as a reset, and no update addresses a reused ID."""
    rig = two(strict).started()
    rig.live.reset()
    rig.client.state = SessionState.GRACE  # lost, but observe() has not run yet
    rig.advance(150)  # the flush is dropped
    rig.client.state = SessionState.ACTIVE
    rig.live.observe()
    rig.scene = LiveScene({"id": A, "color": (0.0, 0.0, 1.0)})
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    messages = rig.take()
    assert [m["type"] for m in messages] == [  # no scene.update for the reused A
        "scene.nodeAdded",
        "scene.snapshot.begin",
        "scene.snapshot.end",
    ]
    assert messages[0]["nodes"] == [{"nodeId": A, "kind": "model"}]  # §7.3: a new node
    assert rig.live.sent.get(A).color == (0.0, 0.0, 1.0)


def test_live_a_reset_whose_flush_was_dropped_goes_out_at_the_next_tick(strict):
    """Without a later change in Slicer: the closed scene must not stay on the viewers (§7.3)."""
    rig = two(strict).started()
    rig.live.reset()
    rig.client.state = SessionState.GRACE
    rig.timer.advance(150)  # the flush is dropped
    rig.client.state = SessionState.ACTIVE
    rig.scene = LiveScene(
        {"id": A}, {"id": B, "color": (0.0, 1.0, 0.0)}
    )  # the same IDs: nothing shrinks
    rig.live.tick()
    assert [m["type"] for m in rig.take()] == ["scene.snapshot.begin", "scene.snapshot.end"]
    assert rig.live.sent.get(B).color == (0.0, 1.0, 0.0)


def test_live_a_dropped_reset_bypasses_the_too_large_gate(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    rig.live.reset()
    rig.client.state = SessionState.GRACE
    rig.timer.advance(150)  # the flush is dropped
    rig.client.state = SessionState.ACTIVE
    rig.live.observe()
    rig.scene = LiveScene({"id": A}, {"id": B})  # the same IDs: nothing shrinks
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    assert len(rig.begins()) == 1


def test_live_transform_without_a_chain_reexports_a_skipped_node(strict):
    """SLC-30 review part 2: a node left out for its own mesh comes back only on a chain that is not linear."""
    warp = vtkTransform()
    warp.Translate(1.0, 0.0, 0.0)
    rig = Rig(strict, LiveScene({"id": A}, {"id": D, "mesh": DEGENERATE})).started()
    rig.scene.node(D).update(world=None, warp=warp)
    rig.live.mark_transform(D)
    rig.advance(150)
    assert len(rig.begins()) == 1


# --------------------------------------------------------------------------- review round 1: pacing rules pinned


def resync(rig: Rig) -> None:
    """An update the relay answers with BAD_SEQUENCE (no replyTo, §9.2): a re-sync is owed."""
    update_id(rig)
    rig.relay(error("BAD_SEQUENCE"))


def test_live_a_quiet_resync_does_not_make_later_ones_immediate(strict):
    rig = two(strict).started()
    resync(rig)
    rig.live.tick()
    assert len(rig.begins()) == 1  # the first: at once
    rig.ack()
    rig.wait(11)
    resync(rig)
    rig.live.tick()
    assert len(rig.begins()) == 1  # after 10 s of quiet: at once
    rig.ack()
    rig.advance(1000)
    resync(rig)  # 1 s after that one's ack
    first_begin_at(rig, rig.timer.clock() + 2.0)


@pytest.mark.parametrize("quiet", [9.9, 10.0])
def test_live_the_resync_window_is_10_s_from_the_previous_ack(strict, quiet):
    rig = two(strict).started()
    resync(rig)
    rig.live.tick()
    rig.take()
    rig.ack()
    acked = rig.timer.clock()
    rig.at(acked + quiet - 0.15)
    resync(rig)  # its error arrives `quiet` s after the ack
    assert rig.timer.clock() == pytest.approx(acked + quiet)
    if quiet < 10.0:
        first_begin_at(rig, rig.timer.clock() + 2.0)
    else:
        rig.live.tick()
        assert len(rig.begins()) == 1


def test_live_an_ordinary_ack_is_not_the_resyncs_ack(strict):
    """Only the snapshot after a re-sync starts its 10 s window: a re-export acked just before does not."""
    rig = two(strict).started()
    resync(rig)
    rig.live.tick()
    rig.take()
    rig.ack()
    rig.wait(11)
    rig.live.mark(A, Change.GEOMETRY)
    rig.advance(750)
    assert len(rig.begins()) == 1
    rig.ack()
    rig.advance(1000)
    resync(rig)
    rig.live.tick()
    assert len(rig.begins()) == 1


def test_live_a_lost_connection_after_an_update_error_resyncs_at_once(strict):
    rig = two(strict).started()
    reply_to = update_id(rig)
    rig.relay(error("RATE_LIMITED", reply_to, retryAfterS=100))
    first_begin_at(rig, rig.timer.clock() + 100)
    rig.ack()
    rig.wait(70)
    rig.client.transport_lost()
    rig.live.observe()
    rig.client.state = SessionState.ACTIVE  # resumed (SLC-17)
    rig.live.observe()
    rig.live.tick()
    assert len(rig.begins()) == 1  # not the old error's 100 s


def test_live_an_error_before_start_is_not_blamed_for_a_lost_connection(strict):
    rig = two(strict)
    rig.client.handle(error("RATE_LIMITED", retryAfterS=100))  # e.g. a refused renew
    rig.live.start()
    rig.take()
    rig.client.transport_lost()
    rig.live.observe()
    rig.client.state = SessionState.ACTIVE
    rig.live.observe()
    rig.live.tick()
    assert len(rig.begins()) == 1


def test_live_lost_connections_never_wait_for_a_change(strict):
    """A loss is not a refusal: after three, the scene still goes out without a change in Slicer."""
    rig = two(strict).started()
    rig.live.mark(A, Change.GEOMETRY)
    rig.advance(750)
    rig.take()
    for wait in (0.0, 2.0, 4.0):  # the second and third re-sync within 10 s of none acknowledged
        rig.client.transport_lost()
        rig.live.observe()
        rig.client.state = SessionState.ACTIVE
        rig.live.observe()
        lost = rig.timer.clock()
        if wait:
            first_begin_at(rig, lost + wait)
        else:
            rig.live.tick()
            assert len(rig.begins()) == 1


# --------------------------------------------------------------------------- review round 1: failures of the panel side


def test_live_a_reset_whose_export_fails_sends_an_empty_snapshot_then_the_scene(strict):
    broken = []

    def export(scene_api, client, **options):
        if broken and scene_api is rig.scene:  # the scene's export fails, not the empty one
            raise KeyError(f"{A} Liver Smith")
        return build_snapshot(scene_api, client, **options)

    rig = two(strict, export=export).started()
    broken.append(True)
    rig.live.hold()
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    failed = rig.timer.clock()
    [begin] = rig.begins()
    assert begin["nodeCount"] == 0  # §7.3: the closed scene is off the viewers
    assert rig.kinds()[-2:] == [LiveEventKind.SENT, LiveEventKind.FAILED]
    assert rig.client.updates_held
    rig.ack()
    broken.clear()
    first_begin_at(rig, failed + 2.0)  # the back-off, no change in Slicer needed


def test_live_a_frame_the_transport_refuses_is_sent_again_after_the_back_off(strict):
    rig = two(strict).started()
    refused = []

    def refusing(frame):
        if not refused:
            refused.append(frame)
            raise ValueError("frame refused")
        rig.sent.append(frame)

    rig.send = refusing
    rig.live.mark(A, Change.GEOMETRY)
    rig.advance(750)
    failed = rig.timer.clock()
    assert rig.discarded == 1 and rig.kinds()[-1] is LiveEventKind.FAILED
    first_begin_at(rig, failed + 2.0)  # supersedes the one the relay got part of (§6.2)


def test_live_a_first_snapshot_the_transport_refuses_is_retried(strict):
    rig = two(strict)
    refused = []

    def refusing(frame):
        if not refused:
            refused.append(frame)
            raise ValueError("frame refused")
        rig.sent.append(frame)

    rig.send = refusing
    rig.live.start()
    assert rig.kinds() == [LiveEventKind.FAILED]
    first_begin_at(rig, 2.0)


def test_live_an_owed_snapshot_the_transport_refuses_is_reported(strict):
    rig = two(strict).started()
    rig.live.request_snapshot()
    rig.send = _raising
    rig.live.tick()  # the export from the pump
    assert rig.kinds()[-1] is LiveEventKind.FAILED and rig.discarded == 1
    rig.send = rig.sent.append
    first_begin_at(rig, 2.0 + rig.timer.clock())


def _raising(*_):
    raise KeyError(f"{A} Liver Smith")


@pytest.mark.parametrize(
    "where", ["send at start", "send at tick", "discard", "end_session", "on_event"]
)
def test_live_panel_side_errors_log_only_their_type(strict, caplog, where):
    rig = two(strict)
    with caplog.at_level(logging.DEBUG, logger="remoteview_core.live"):
        if where == "send at start":
            rig.send = _raising
            rig.live.start()
        elif where == "send at tick":
            rig.started()
            rig.live.request_snapshot()
            rig.send = _raising
            rig.live.tick()
        elif where == "discard":
            rig.started()
            rig.discard_hook = _raising
            refuse_next_snapshot(rig, "CAPACITY")
        elif where == "end_session":
            rig.started()
            rig.end_session = _raising
            rig.live.hold()
            rig.live.reset()
            rig.live.release()
            rig.advance(0)
            rig.relay(error("CAPACITY", rig.begin_id()))
        else:
            rig.on_event = _raising
            rig.live.start()
    assert "KeyError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


def test_live_the_flush_itself_resyncs_when_max_text_bytes_is_too_small(strict):
    """The pump's tick is not needed: the flush attributes the cause (no relay error to blame) and sends at once."""
    rig = two(strict, maxTextBytes=240).started()
    rig.scene.node(A)["world"] = moved(3.0)
    rig.live.mark_transform(A)
    rig.timer.advance(150)  # the flush timer only
    assert len(rig.begins()) == 1


def test_live_a_non_finite_mesh_under_a_dragged_warp_sends_no_begin(strict):
    """No transform gives non-finite points a value: only a new mesh lifts ``invalid-geometry``."""
    broken = polydata_from_triangles(
        np.array([[0.0, 0, 0], [np.nan, 0, 0], [0, 1, 0]]), np.array([[0, 1, 2]])
    )
    warp = vtkTransform()
    rig = Rig(strict, LiveScene({"id": A}, {"id": D, "mesh": broken, "world": None, "warp": warp}))
    rig.started()
    assert rig.live.sent.skipped[D].reason.value == "invalid-geometry"
    for step in range(4):
        warp.Translate(1.0, 0.0, 0.0)
        rig.scene.node(D)["warp"] = warp
        rig.live.mark_transform(D)
        rig.wait(1)
        assert rig.take() == [], step
    rig.live.mark(D, Change.GEOMETRY)
    rig.advance(750)
    assert len(rig.begins()) == 1


# --------------------------------------------------------------------------- review round 2


def test_live_a_reset_whose_frames_cannot_be_sent_ends_the_session(strict):
    """§7.3: the closed scene must not stay on the viewers, nor be rebuilt on every tick."""
    rig = two(strict).started()
    rig.send = _raising
    rig.live.hold()
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    assert rig.ended == [RESET_NOT_SENT] and not rig.live.running
    exports = rig.exports
    rig.wait(2)
    assert rig.exports == exports


def test_live_an_ack_ends_the_relays_wait(strict):
    """A reset goes out whatever the pacing; once the viewers acknowledge a scene, a change goes out at its own pace."""
    rig = two(strict).started()
    failed = refuse_next_snapshot(rig, "RATE_LIMITED", retryAfterS=100)
    rig.live.hold()
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    assert len(rig.begins()) == 1  # not 100 s later
    rig.ack()
    rig.scene.add(C)
    rig.live.mark(C, Change.ADDED)
    rig.advance(750)
    assert len(rig.begins()) == 1 and rig.timer.clock() < failed + 100


def test_live_an_ack_after_a_dropped_reset_under_the_too_large_gate_clears_it(strict):
    rig = two(strict).started()
    refuse_next_snapshot(rig, "PAYLOAD_TOO_LARGE")
    rig.live.reset()
    rig.client.state = SessionState.GRACE
    rig.timer.advance(150)  # the flush is dropped
    rig.client.state = SessionState.ACTIVE
    rig.live.tick()  # the reset, whatever the gate
    assert len(rig.begins()) == 1
    rig.ack()
    rig.scene.add(C)
    rig.live.mark(C, Change.ADDED)  # nothing shrinks: a re-export goes out only without the gate
    rig.advance(750)
    assert len(rig.begins()) == 1


def test_live_an_ack_handled_just_before_the_connection_dropped_counts(strict):
    rig = two(strict)
    rig.live.start()
    version = rig.client.snapshot_in_flight
    rig.client.handle(ack(version))  # the panel lost the socket before observe()
    rig.client.transport_lost()
    rig.live.observe()
    assert LiveEventKind.ACKED in rig.kinds()


def test_live_a_second_start_sends_nothing(strict):
    rig = two(strict)
    rig.live.start()
    rig.take()
    rig.live.start()
    assert rig.take() == [] and rig.exports == 1


def test_live_an_unexpected_failure_during_a_reset_keeps_the_session(strict):
    """Only a reset that cannot be sent ends the session: a failed read is retried like any export."""
    rig = two(strict).started()
    failures = [KeyError(f"{A} Liver Smith")]

    def once():
        if failures:
            raise failures.pop()
        return rig.scene

    rig.read_scene = once
    rig.live.hold()
    rig.live.reset()
    rig.live.release()
    rig.advance(0)
    assert rig.ended == [] and rig.live.running
    assert LiveEventKind.FAILED in rig.kinds()
    assert len(rig.begins()) == 1  # the reset, from the flush's tick


def test_live_a_lost_connection_does_not_close_the_flush_gate_again(strict):
    """After three refusals a change lifts the gate; a loss of the attempt it allowed does not close it again."""
    rig = two(strict).started()
    refuse_next_snapshot(rig, "CAPACITY")  # 2 s
    rig.wait(2)
    for _ in range(2):  # 4 s, then 8 s and the gate
        begin_id = rig.begin_id()
        rig.take()
        rig.relay(error("CAPACITY", begin_id))
        rig.wait(4)
    rig.wait(10)
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    assert len(rig.begins()) == 1  # the fourth attempt
    rig.client.transport_lost()
    rig.live.observe()
    rig.client.state = SessionState.ACTIVE
    rig.live.observe()
    rig.wait(70)
    assert len(rig.begins()) == 1  # the re-sync, without another change


# --------------------------------------------------------------------------- SLC-32: what the panel uses


def test_live_deferred_start_leaves_the_first_snapshot_to_the_tick(strict):
    rig = two(strict)
    rig.live.start(deferred=True)
    assert rig.take() == [] and rig.events == [] and rig.exports == 0
    assert rig.client.snapshot_needed and rig.live.owed and not rig.live.in_flight
    rig.live.start(deferred=True)  # a second call does nothing
    rig.live.tick()
    [begin] = rig.begins()
    assert (begin["sceneVersion"], begin["nodeCount"]) == (1, 2)
    assert rig.kinds() == [LiveEventKind.SENT]
    assert rig.live.in_flight and not rig.live.owed


def test_live_deferred_start_waits_for_a_hold_given_before_the_tick(strict):
    """The panel attaches the observers between ``start(deferred=True)`` and the tick: a batch running at Start holds
    the first snapshot until it ends, and the marks made in the batch announce nothing (SLC-31 review)."""
    rig = two(strict)
    rig.live.start(deferred=True)
    rig.live.hold()  # the watcher's attach() during a batch process
    assert rig.live.batch_held
    rig.scene.add(C)
    rig.live.mark(C, Change.ADDED)
    rig.wait(3)
    assert rig.take() == [] and rig.exports == 0
    rig.live.release()
    rig.advance(0)
    sent = rig.take()
    assert [m["type"] for m in sent] == ["scene.snapshot.begin", "scene.snapshot.end"]
    assert sent[0]["nodeCount"] == 3 and not rig.live.batch_held
    rig.live.release()  # unmatched: the in-flight hold stays
    rig.scene.node(A)["color"] = (0.1, 0.2, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.wait(1)
    assert rig.take() == []
    rig.ack()
    rig.advance(0)
    assert [m["type"] for m in rig.take()] == ["scene.update"]


def test_live_properties_follow_the_controller(strict):
    large = Rig(strict, LiveScene({"id": A}, {"id": C, "mesh": BIG}), maxSnapshotBytes=SMALL_LIMIT)
    assert not (large.live.owed or large.live.waits_for_change or large.live.batch_held)
    large.live.start()
    assert large.live.waits_for_change and large.live.owed and not large.live.in_flight
    large.live.stop()
    assert not (large.live.waits_for_change or large.live.owed)

    rig = two(strict).started()
    assert not (rig.live.in_flight or rig.live.owed or rig.live.waits_for_change)
    refuse_next_snapshot(rig, "CAPACITY")  # 2 s
    rig.wait(2)
    for _ in range(2):  # 4 s, then the third failure closes the flush gate
        begin_id = rig.begin_id()
        rig.take()
        assert rig.live.in_flight
        rig.relay(error("CAPACITY", begin_id))
        rig.wait(4)
    assert rig.live.waits_for_change and rig.live.owed and not rig.live.in_flight
    rig.wait(10)  # past the 8 s back-off: only a change opens the gate
    assert rig.take() == [] and rig.live.waits_for_change
    rig.live.mark(A, Change.APPEARANCE)
    rig.advance(150)
    assert len(rig.begins()) == 1 and rig.live.in_flight and not rig.live.waits_for_change
    rig.ack()  # an ack that owes nothing clears them all
    assert not (rig.live.in_flight or rig.live.owed or rig.live.waits_for_change)

    rig.live.hold()
    assert rig.live.batch_held
    rig.live.reset()  # a reset alone: no snapshot_needed, still owed
    assert rig.live.owed and not rig.client.snapshot_needed
    rig.live.request_snapshot()
    rig.live.stop()
    # the client's flag outlives the controller: owed reads it only while running
    assert rig.client.snapshot_needed
    assert not (rig.live.in_flight or rig.live.owed or rig.live.waits_for_change)
    assert not rig.live.batch_held


# ------------------------------------------------------------------------- SLC-33: events missed off the main thread


@pytest.mark.parametrize(
    ("depth", "batch", "expected"), [(0, True, 1), (2, True, 1), (2, False, 0), (1, False, 0)]
)
def test_live_request_resync_aligns_the_batch_hold(strict, depth, batch, expected):
    """MRML reports only the outermost batch (research note §4): the hold count follows it, one at most."""
    rig = two(strict).started()
    for _ in range(depth):
        rig.live.hold()
    rig.live.request_resync(batch=batch)
    assert f"batch={expected}" in repr(rig.live) and rig.live.batch_held is bool(expected)
    rig.advance(0)
    assert len(rig.begins()) == 1 - expected  # a batch still running holds the re-sync


def test_live_request_resync_follows_the_resync_rule(strict):
    rig = two(strict).started()
    rig.live.request_resync(batch=False)
    rig.live.tick()
    assert len(rig.begins()) == 1  # the first re-sync goes at once
    rig.ack()
    rig.wait(5)
    rig.live.request_resync(batch=False)  # within 10 s of the previous re-sync's ack
    first_begin_at(rig, rig.timer.clock() + 2.0)


def test_live_request_resync_lifts_the_flush_and_too_large_gates(strict):
    """A missed change is a change: the gates that wait for one open (at most one extra attempt per episode)."""
    rig = two(strict).started()
    refuse_next_snapshot(rig, "INTERNAL")  # 2 s
    rig.wait(2)
    for _ in range(2):  # 4 s, then the third failure closes the flush gate
        begin_id = rig.begin_id()
        rig.take()
        rig.relay(error("INTERNAL", begin_id))
        rig.wait(4)
    rig.wait(10)
    assert rig.live.waits_for_change and rig.take() == []
    rig.live.request_resync(batch=False)
    assert not rig.live.waits_for_change
    rig.live.tick()
    assert len(rig.begins()) == 1  # without a flush

    large = Rig(strict, LiveScene({"id": A}, {"id": C, "mesh": BIG}), maxSnapshotBytes=SMALL_LIMIT)
    large.live.start()
    assert large.live.waits_for_change and large.exports == 1
    large.live.request_resync(batch=False)
    large.live.tick()  # tried again: still too large
    assert large.exports == 2 and large.take() == []
    assert large.kinds() == [LiveEventKind.TOO_LARGE, LiveEventKind.TOO_LARGE]
    large.scene.node(C)["visible"] = False  # no mark: the observers missed it
    large.live.request_resync(batch=False)
    first_begin_at(large, large.timer.clock() + 2.0)  # the second re-sync in a row is paced


def test_live_request_resync_in_flight_sends_again_after_the_ack(strict):
    rig = two(strict).started()
    rig.live.request_snapshot()
    rig.live.tick()
    assert len(rig.begins()) == 1  # in flight
    rig.live.request_resync(batch=False)
    rig.live.tick()
    assert rig.begins() == []  # no supersede
    rig.ack()
    rig.advance(0)
    assert len(rig.begins()) == 1


def test_live_request_resync_before_start_or_after_stop_does_nothing(strict, caplog):
    caplog.set_level(logging.DEBUG, logger="remoteview_core.live")
    rig = two(strict)
    rig.live.request_resync(batch=True)
    assert not rig.client.snapshot_needed and "batch=0" in repr(rig.live)
    rig.live.start()
    rig.ack()
    rig.take()
    rig.live.stop()
    rig.live.request_resync(batch=True)
    assert not rig.client.snapshot_needed and "batch=0" in repr(rig.live)
    rig.wait(3)
    assert rig.take() == []
    assert [r for r in caplog.records if r.name == "remoteview_core.live"] == []


def test_live_request_resync_never_counts_toward_the_flush_gate(strict):
    """Missed events are not refusals: two re-syncs and one refusal leave the gate open (a lost connection's rule)."""
    rig = two(strict).started()
    rig.live.request_resync(batch=False)
    rig.live.request_resync(batch=False)  # the second in a row: after the 2 s back-off
    rig.wait(2)
    begin_id = rig.begin_id()
    rig.take()
    rig.relay(error("INTERNAL", begin_id))
    assert rig.live.owed and not rig.live.waits_for_change


def test_live_request_resync_that_fails_logs_only_the_type(strict, caplog, monkeypatch):
    rig = two(strict).started()

    def boom():
        raise KeyError(f"{A} Liver Smith")

    monkeypatch.setattr(rig.client, "require_snapshot", boom)
    with caplog.at_level(logging.DEBUG):
        rig.live.request_resync(batch=False)
    assert "live: re-sync not asked for (KeyError)" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


@pytest.mark.parametrize("every", [1, 2, 20, 60])
def test_live_request_resync_is_not_held_off_by_events_that_keep_coming(strict, every):
    """The SLC-33 review: in the panel's order — a 50 ms pump that calls ``request_resync`` and then ``tick`` — a
    steady stream of missed events (one every ``every`` pumps) never pushes back a re-sync that is due, so the viewers
    are re-synced with the back-off settling at 60 s."""
    rig = two(strict).started()
    times = []
    for step in range(1, 3601):  # 180 s
        rig.timer.advance(50)
        if step % every == 0:
            rig.live.request_resync(batch=False)
        rig.live.tick()
        if rig.begins():
            times.append(rig.timer.clock())
            rig.ack()
    assert (
        times and times[0] <= every * 0.05 + 2.1
    )  # the first event, then at most the first back-off
    assert len(times) >= 4 and max(b - a for a, b in itertools.pairwise(times)) <= 60 + every * 0.05
