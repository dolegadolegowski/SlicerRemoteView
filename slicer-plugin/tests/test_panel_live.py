"""SLC-32: the panel owns the live scene — ``LiveUpdates`` and the observers, from ``session.created`` to the session's
end — and its texts follow the scene (docs/protocol.md §6.2, §7.3, §8; FR-11, FR-12, NFR-02; T2, T7).

The panel runs with the real ``SceneWatcher`` on vtkObject fakes (``mrml_fakes``, ``support.MrmlModel``), read by the
real ``MrmlSceneApi`` too, so a mark and the export see the same scene. A ``FakeTimer`` is both the flush timer (its
callback is ``flush_live``, as the adapter connects ``timeout()``) and the panel's clock. T7 checks look at the log,
this process's stdout/stderr and ``sys.last_value``/``sys.last_exc`` (``support.leaks``).
"""

from __future__ import annotations

import gc
import json
import logging
import sys
import threading
import weakref

import pytest
from mrml_fakes import EVENT_IDS, Scene
from support import (
    SESSION_ID,
    TOKEN,
    URL,
    FakeFolders,
    FakeSegment,
    FakeTimer,
    FakeTransport,
    MrmlModel,
    MrmlSegmentation,
    MrmlView,
    ack,
    created,
    deliver,
    leaks,
    live_client,
    manifest,
    needs_relay_stub,
    parent_widget,
    pump_while,
    reassemble,
    specked,
    sphere,
    start_relay_stub,
)

from remoteview_core import live, panel
from remoteview_core.mrml_scene import MrmlSceneApi
from remoteview_core.observers import MrmlEvents, SceneWatcher
from remoteview_core.panel import PanelController, Phase
from remoteview_core.protocol_client import ProtocolStateError
from remoteview_core.snapshot import build_snapshot
from remoteview_core.transport import (
    Connected,
    Disconnected,
    ErrorKind,
    Received,
    RelayTransport,
    TransportError,
)
from remoteview_protocol import envelope

EVENTS = MrmlEvents(**EVENT_IDS)
A, B = "vtkMRMLModelNode4", "vtkMRMLModelNode5"
#: T7 needles: the models are named "Doe^John …", and a traceback must never be printed
NAMES = ("Doe", "vtkMRMLModelNode", "Traceback")
SECRET = KeyError(f"{A} Doe^John")
SCENE_EVENTS = (
    EVENTS.node_added,
    EVENTS.node_removed,
    EVENTS.start_batch,
    EVENTS.end_batch,
    EVENTS.end_close,
)
MODEL_EVENTS = (
    EVENTS.display_modified,
    EVENTS.mesh_modified,
    EVENTS.transform_modified,
    EVENTS.modified,
)
SEGMENTATION_EVENTS = (
    EVENTS.display_modified,
    EVENTS.transform_modified,
    EVENTS.modified,
    EVENTS.segment_added,
    EVENTS.segment_removed,
    EVENTS.segment_modified,
    EVENTS.representation_modified,
    EVENTS.representation_names_modified,
)
SEG = "vtkMRMLSegmentationNode1"


class Rig:
    """A panel whose ``watch`` factory builds (and records) the real ``SceneWatcher`` over ``scene``."""

    def __init__(
        self,
        *models,
        transport_factory=FakeTransport,
        batch=False,
        scene_class=Scene,
        watch=None,
        remove_islands=False,
    ):
        self.models = list(models)
        self.scene = scene_class(MrmlView("vtkMRMLViewNode1"), *models)
        self.scene.batch = batch
        self.timer = FakeTimer()
        self.watchers: list[SceneWatcher] = []
        self.ctl = PanelController(
            slicer_version="5.12.4",
            platform=sys.platform,
            transport_factory=transport_factory,
            clock=self.timer.clock,
            scene=lambda: MrmlSceneApi(self.scene.by_class, FakeFolders()),
            flush_timer=self.timer,
            watch=watch or self.watch,
            remove_islands=remove_islands,
        )
        self.timer.callback = self.ctl.flush_live  # what the adapter's timeout() connection does

    def watch(self, sink):
        watcher = SceneWatcher(
            sink,
            scene=self.scene,
            events=EVENTS,
            nodes_by_class=self.scene.by_class,
            world_matrix=MrmlSceneApi(self.scene.by_class, FakeFolders()).world_matrix,
        )
        self.watchers.append(watcher)
        return watcher

    def add(self, model):
        self.models.append(model)
        self.scene.add(model)

    def sent(self) -> list:
        return [m for _, m in FakeTransport.made[-1].sent]

    def kinds(self) -> list[str]:
        return [m["type"] if isinstance(m, dict) else "chunk" for m in self.sent()]

    def begins(self) -> list[dict]:
        return [
            m for m in self.sent() if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"
        ]

    def observers(self) -> int:
        """VTK observers on the scene (5 events) and on every model (4 events each) or segmentation (8) ever in
        it."""
        count = sum(bool(self.scene.HasObserver(event)) for event in SCENE_EVENTS)
        for node in self.models:
            events = SEGMENTATION_EVENTS if isinstance(node, MrmlSegmentation) else MODEL_EVENTS
            count += sum(bool(node.HasObserver(event)) for event in events)
        return count

    def glb(self, index: int = -1) -> bytes:
        """The GLB of the ``index``-th snapshot the panel sent (frames after its ``begin`` up to its ``end``)."""
        frames = self.sent()
        starts = [
            i
            for i, m in enumerate(frames)
            if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"
        ]
        start = starts[index]
        end = next(
            i
            for i in range(start, len(frames))
            if isinstance(frames[i], dict) and frames[i]["type"] == "scene.snapshot.end"
        )
        _, glb, _ = reassemble(frames[start : end + 1])
        return glb

    def pump(self, ms: float = 0):
        self.timer.advance(ms)
        return self.ctl.pump()


def live_rig(*models, limits=None, **kw) -> Rig:
    """Start, ``Connected``, ``session.created``: the panel is live."""
    rig = Rig(*models, **kw)
    rig.ctl.start(URL)
    deliver(rig.ctl, Connected(1), Received(1, created(**(limits or {}))))
    return rig


def acked(rig: Rig, version: int):
    return deliver(rig.ctl, Received(1, ack(version)))


def last_id(rig: Rig, type_: str) -> str:
    """The ``id`` of the last message of that type the panel sent."""
    return next(m for m in reversed(rig.sent()) if isinstance(m, dict) and m["type"] == type_)["id"]


def refuse(rig: Rig, code: str, answers: str = "scene.snapshot.begin"):
    refusal = envelope.make(
        "error", reply_to=last_id(rig, answers), code=code, message="x", retryable=True
    )
    return deliver(rig.ctl, Received(1, refusal))


def recolor(node, rgb):
    node.displays[0].color = rgb
    node.InvokeEvent(EVENTS.display_modified)


def hide(node):
    node.displays[0].visible = 0
    node.InvokeEvent(EVENTS.display_modified)


def close_scene(rig: Rig, *removed, added=()):
    """*File → Close Scene*: inside a batch, the models go, ``EndCloseEvent``; then a load may add models."""
    rig.scene.InvokeEvent(EVENTS.start_batch)
    for node in removed:
        rig.scene.remove(node)
    rig.scene.InvokeEvent(EVENTS.end_close)
    for node in added:
        rig.add(node)
    rig.scene.InvokeEvent(EVENTS.end_batch)


def limit_for_one(resolution: int) -> int:
    """``maxSnapshotBytes`` that one ``sphere(resolution)`` model fits under and two do not."""
    one = Scene(MrmlView("vtkMRMLViewNode1"), MrmlModel(A, polydata=sphere(resolution)))
    snapshot = build_snapshot(
        MrmlSceneApi(one.by_class, FakeFolders()), live_client(), slicer_version="5.12.4"
    )
    return int(1.5 * snapshot.byte_length)


# --------------------------------------------------------------------------- criterion 1: end to end


@needs_relay_stub
def test_panel_live_end_to_end_with_the_relay_stub(caplog, capfd):
    """First snapshot, an update, ``scene.nodeAdded`` + snapshot, ``scene.nodeRemoved``, a closed scene's snapshot:
    the stub checks every version (§6.2, §8.1, §8.4) and reports every update it received."""
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    rig = Rig(
        a,
        transport_factory=lambda url, events, extra_ca_file=None: RelayTransport(
            url, events, use_proxy=False
        ),
    )
    ctl, timer, scene = rig.ctl, rig.timer, rig.scene

    def wait_live():
        pump_while(ctl, lambda: not ctl.view.status.startswith("Live"), 10)
        assert ctl.view.status == "Live · no viewers yet."

    stub = start_relay_stub("--report-updates")
    try:
        ctl.start(stub.address)
        wait_live()
        code, token = ctl.view.code, ctl._client.publisher_token().reveal()
        assert code and token
        recolor(a, (0.0, 1.0, 0.0))
        assert timer.starts[-1] == 150
        timer.advance(150)
        b = MrmlModel(B, name="Doe^John spleen")
        rig.add(b)
        assert timer.starts[-1] == 750
        timer.advance(750)
        assert ctl.view.status.startswith("Updating the scene")
        wait_live()
        scene.remove(b)
        timer.advance(150)
        close_scene(rig, a)
        assert timer.deadline == timer.now
        timer.advance(0)
        wait_live()
        ctl.stop()
        pump_while(ctl, lambda: ctl.active, 5)
        assert ctl.observer_count == 0 and rig.observers() == 0
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    lines = out.splitlines()
    closes, _pings, *snapshots = lines[0].split()
    report = json.loads(lines[-1])
    assert report["violations"] == []
    assert report["updates"] == [
        ["scene.update", 2, 1],
        ["scene.nodeAdded", 3, 2],
        ["scene.nodeRemoved", 5, 4],
    ]
    assert [s.split(":")[0] for s in snapshots] == ["v1", "v4", "v6"] and closes == "1"
    assert leaks(caplog, capfd, *NAMES, code, token) == []


# --------------------------------------------------------------------------- criterion 2: observers only while live


ENDS = [
    "stop",
    "relay-end",
    "lost",
    "transport-ended",
    "shutdown",
    "refused-reset",
    "binary-frame",
    "fatal-error",
]


@pytest.mark.parametrize("end", ENDS)
def test_panel_live_observers_exist_only_while_live(fake, caplog, capfd, end):
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    rig = Rig(a)
    ctl = rig.ctl
    ctl.start(URL)
    deliver(ctl, Connected(1))
    assert rig.observers() == 0 and rig.watchers == []
    deliver(ctl, Received(1, created()))
    acked(rig, 1)
    assert rig.observers() == 5 + 4 and ctl.observer_count == 5 + 4
    recolor(a, (0.0, 1.0, 0.0))
    assert rig.timer.deadline is not None  # a flush pending when the session ends
    if end == "stop":
        ctl.stop()
    elif end == "relay-end":
        expired = envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")
        deliver(ctl, Received(1, expired))
    elif end == "lost":
        deliver(ctl, Disconnected(1, None, 1.0))
    elif end == "transport-ended":
        error = TransportError(ErrorKind.CLOSED, retryable=False, close_code=4003)
        deliver(ctl, Disconnected(1, error, None))
    elif end == "shutdown":
        ctl.shutdown(timeout=0)
    elif end == "refused-reset":
        close_scene(rig)
        rig.timer.advance(0)
        refuse(rig, "CAPACITY")
    elif end == "binary-frame":
        deliver(ctl, Received(1, b"\x00"))
    else:
        fatal = envelope.make("error", code="UNAUTHORIZED", message="x", retryable=False)
        deliver(ctl, Received(1, fatal))
    assert ctl.phase is not Phase.LIVE
    assert ctl.observer_count == 0 and rig.observers() == 0
    assert rig.timer.deadline is None
    gone = weakref.ref(rig.watchers.pop())  # the panel keeps no reference to the session's watcher
    gc.collect()
    assert gone() is None
    sent = len(FakeTransport.made[0].sent)
    recolor(a, (0.0, 0.0, 1.0))
    ctl.flush_live()
    rig.pump(1000)
    assert len(FakeTransport.made[0].sent) == sent
    assert leaks(caplog, capfd, *NAMES) == []


# --------------------------------------------------------------------------- criterion 3: Start during a batch


def test_panel_live_start_during_a_batch_sends_the_scene_once_it_ends(fake):
    rig = live_rig(MrmlModel(A), batch=True)
    view = rig.ctl.view
    assert rig.kinds() == ["session.create"]
    assert (view.status, view.detail) == (
        "Sending the scene · no viewers yet.",
        panel.WAITING_FOR_SLICER,
    )
    rig.add(MrmlModel(B))  # inside the batch
    for _ in range(10):  # 600 s: a batch that never ends says why
        view = rig.pump(60_000)
    assert rig.kinds() == ["session.create"]
    assert (view.status, view.detail) == (
        "Sending the scene · no viewers yet.",
        panel.WAITING_FOR_SLICER,
    )
    rig.scene.batch = False
    rig.scene.InvokeEvent(EVENTS.end_batch)
    view = rig.pump(0)
    assert len(rig.begins()) == 1 and rig.begins()[0]["nodeCount"] == 2
    assert "scene.nodeAdded" not in rig.kinds()
    assert (view.status, view.detail) == ("Sending the scene · no viewers yet.", "")
    acked(rig, 1)
    rig.pump(2000)
    assert len(rig.begins()) == 1


# --------------------------------------------------------------------------- criterion 4: texts


def test_panel_live_scene_states_follow_the_live_events(fake):
    a = MrmlModel(A)
    rig = live_rig(a)
    ctl = rig.ctl
    details = [ctl.view.detail]
    assert ctl.view.status == "Sending the scene · no viewers yet."
    assert acked(rig, 1).status == "Live · no viewers yet."
    a.mesh = sphere(16)
    a.InvokeEvent(EVENTS.mesh_modified)
    rig.timer.advance(750)
    assert ctl.view.status == "Updating the scene · no viewers yet."
    assert acked(rig, 2).status == "Live · no viewers yet."
    a.mesh = sphere(12)
    a.InvokeEvent(EVENTS.mesh_modified)
    rig.timer.advance(750)
    view = refuse(rig, "CAPACITY")
    details.append(view.detail)
    assert view.status == "Scene not up to date · no viewers yet."
    assert view.detail == f"{panel.SCENE_REFUSED['CAPACITY']} {panel.RETRY_LATER}"
    assert FakeTransport.made[0].discarded == [1]  # the queued frames of the refused snapshot
    view = rig.pump(1900)
    assert len(rig.begins()) == 3 and view.status.startswith("Scene not up to date")
    view = rig.pump(100)  # sent again by itself after 2 s
    details.append(view.detail)
    assert [m["sceneVersion"] for m in rig.begins()] == [1, 2, 3, 4]
    assert (view.status, view.detail) == ("Updating the scene · no viewers yet.", "")
    assert acked(rig, 4).status == "Live · no viewers yet."
    assert [d for d in details if "stop and start" in d.lower()] == []


def test_panel_live_a_scene_too_large_waits_for_a_change(fake):
    a = MrmlModel(A, polydata=sphere(64))
    b = MrmlModel(B, polydata=sphere(64))
    rig = live_rig(a, b, limits={"maxSnapshotBytes": limit_for_one(64)})
    view = rig.ctl.view
    assert view.status == "Session running without the scene · no viewers yet."
    assert view.detail.startswith("The scene is too large to send (")
    assert view.detail.endswith(" " + panel.HIDE_MODELS)
    rig.pump(600_000)
    assert rig.begins() == []
    hide(b)
    rig.timer.advance(150)
    assert len(rig.begins()) == 1 and rig.begins()[0]["nodeCount"] == 1


def test_panel_live_repeated_failures_wait_for_a_change(fake):
    a = MrmlModel(A)
    rig = live_rig(a)
    refuse(rig, "INTERNAL")
    rig.pump(2000)
    refuse(rig, "INTERNAL")
    rig.pump(4000)
    view = refuse(rig, "INTERNAL")
    assert len(rig.begins()) == 3
    assert view.status == "Session running without the scene · no viewers yet."
    assert view.detail == f"{panel.scene_refused_text('INTERNAL')} {panel.RETRY_ON_CHANGE}"
    rig.pump(600_000)
    assert len(rig.begins()) == 3
    recolor(a, (0.0, 0.0, 1.0))
    rig.timer.advance(150)
    assert len(rig.begins()) == 4


def test_panel_live_remove_small_islands_follows_the_switch(fake):
    """SLC-54: switched on and off during a live session, the scene goes again without and with the specks;
    switched while no session runs, the next Start uses it."""
    rig = live_rig(MrmlModel(A, polydata=specked(32)))
    assert [b["triangleCount"] for b in rig.begins()] == [2_016]
    acked(rig, 1)
    rig.ctl.set_remove_islands(True)
    rig.pump()
    assert acked(rig, 2).status == "Live · no viewers yet."
    rig.ctl.set_remove_islands(False)
    rig.pump()
    assert [b["triangleCount"] for b in rig.begins()] == [2_016, 1_920, 2_016]
    assert acked(rig, 3).status == "Live · no viewers yet."
    rig.ctl.stop()
    deliver(rig.ctl, Disconnected(1, None, None, final_sent=True))
    rig.ctl.set_remove_islands(True)
    rig.ctl.start(URL)
    deliver(rig.ctl, Connected(1), Received(1, created()))
    assert [b["triangleCount"] for b in rig.begins()] == [1_920]
    restarted = Rig(MrmlModel(A, polydata=specked(32)), remove_islands=True)
    restarted.ctl.start(URL)
    deliver(restarted.ctl, Connected(1), Received(1, created()))
    assert [b["triangleCount"] for b in restarted.begins()] == [1_920]


def test_panel_live_an_acknowledged_empty_scene_is_not_live(fake):
    a = MrmlModel(A)
    rig = live_rig(a, limits={"maxSnapshotBytes": limit_for_one(8)})
    acked(rig, 1)
    close_scene(rig, a, added=[MrmlModel(B, polydata=sphere(64))])  # the loaded scene is too large
    rig.timer.advance(0)
    begin = rig.begins()[-1]
    assert begin["nodeCount"] == 0  # the closed scene is cleared off the viewers (§7.3)
    view = acked(rig, begin["sceneVersion"])
    assert view.status == "Scene not up to date · no viewers yet."
    assert view.detail.startswith("The scene is too large to send (")
    assert view.detail.endswith(" " + panel.HIDE_MODELS)


@pytest.mark.parametrize("fails", ["plain", "event-text", "show"])
def test_panel_live_a_refused_reset_closes_the_session_even_if_the_texts_fail(
    fake, monkeypatch, caplog, capfd, fails
):
    """The closed scene may be another patient's: a refused reset ends the session, whatever the panel's texts do
    (§7.3, the SLC-29 review)."""
    caplog.set_level(logging.DEBUG)
    rig = live_rig(MrmlModel(A, name="Doe^John liver"))
    ctl = rig.ctl
    acked(rig, 1)
    close_scene(rig)
    rig.timer.advance(0)  # the reset's begin

    def boom(*args, **kwargs):
        raise SECRET

    if fails == "event-text":
        monkeypatch.setattr(panel, "scene_refused_text", boom)
    elif fails == "show":
        monkeypatch.setattr(ctl, "_show", boom)
    refuse(rig, "CAPACITY")
    transport = FakeTransport.made[0]
    final, timeout = transport.stops[0]
    assert (final["type"], timeout) == ("session.close", 0)
    assert ctl.phase is Phase.STOPPING and rig.observers() == 0
    assert "live: session not ended" not in caplog.text
    if fails == "show":
        assert "scene: panel not updated (KeyError)" in caplog.text
        monkeypatch.delattr(ctl, "_show")  # the class's method shows again
    else:
        assert ctl.view.status == panel.STOPPING
    view = deliver(ctl, Disconnected(1, None, None, final_sent=True))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, live.RESET_REFUSED)
    assert leaks(caplog, capfd, *NAMES) == []


def test_panel_live_a_reset_that_cannot_be_sent_ends_the_session(fake, monkeypatch, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    rig = live_rig(MrmlModel(A, name="Doe^John liver"))
    acked(rig, 1)
    transport = FakeTransport.made[0]
    real = transport.send

    def send(frame, *, connection):
        if isinstance(frame, dict) and frame["type"] == "scene.snapshot.begin":
            raise OSError(f"socket {A} Doe^John")
        return real(frame, connection=connection)

    monkeypatch.setattr(transport, "send", send)
    close_scene(rig)
    rig.timer.advance(0)
    final, timeout = transport.stops[0]
    assert (final["type"], timeout) == ("session.close", 0) and rig.observers() == 0
    assert rig.ctl.view.status == panel.STOPPING  # no scene text after the end
    view = deliver(rig.ctl, Disconnected(1, None, None, final_sent=True))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, live.RESET_NOT_SENT)
    assert leaks(caplog, capfd, *NAMES) == []


class _Unobservable(Scene):
    def AddObserver(self, *args):  # noqa: N802 — VTK's name
        raise SECRET


@pytest.mark.parametrize("fails", ["factory", "attach"])
def test_panel_live_a_scene_that_cannot_be_observed_is_not_sent(fake, caplog, capfd, fails):
    """A scene that silently stops following Slicer would mislead the viewers: nothing is sent (C4)."""
    caplog.set_level(logging.DEBUG)

    def broken(sink):
        raise SECRET

    if fails == "factory":
        rig = Rig(MrmlModel(A, name="Doe^John liver"), watch=broken)
    else:
        rig = Rig(MrmlModel(A, name="Doe^John liver"), scene_class=_Unobservable)
    rig.ctl.start(URL)
    view = deliver(rig.ctl, Connected(1), Received(1, created()))
    assert rig.kinds() == ["session.create"]
    assert (view.status, view.detail) == (
        "Session running without the scene · no viewers yet.",
        panel.OBSERVE_FAILED,
    )
    assert rig.observers() == 0 and rig.ctl.observer_count == 0
    error = "KeyError" if fails == "factory" else "RuntimeError"
    assert f"scene: changes not followed ({error})" in caplog.text
    assert rig.pump(600_000).detail == panel.OBSERVE_FAILED and rig.kinds() == ["session.create"]
    rig.ctl.stop()
    assert FakeTransport.made[0].stops[0][0]["type"] == "session.close"
    assert leaks(caplog, capfd, *NAMES) == []


def test_panel_live_a_live_start_that_fails_says_restart(fake, monkeypatch, caplog):
    def boom(self, *, deferred=False):
        raise ProtocolStateError("x")

    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(live.LiveUpdates, "start", boom)
    rig = live_rig(MrmlModel(A))
    view = rig.ctl.view
    assert rig.kinds() == ["session.create"]
    assert (view.status, view.detail) == (
        "Session running without the scene · no viewers yet.",
        f"{panel.SCENE_FAILED} {panel.RESTART}",
    )
    assert "scene: live updates not started (ProtocolStateError)" in caplog.text
    assert rig.observers() == 0 and rig.ctl.observer_count == 0


@pytest.mark.parametrize("fails", ["close", "transport-stop"])
def test_panel_live_a_close_that_fails_still_removes_the_observers(
    fake, monkeypatch, caplog, capfd, fails
):
    """No observer outlives the session, even when the close or the transport's stop raises (C5)."""
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    rig = live_rig(a)
    acked(rig, 1)
    recolor(a, (0.0, 1.0, 0.0))  # a flush pending

    def boom(*args, **kwargs):
        raise SECRET

    if fails == "close":
        monkeypatch.setattr(rig.ctl._client, "close", boom)
    else:
        monkeypatch.setattr(FakeTransport.made[0], "stop", boom)
    with pytest.raises(KeyError):
        rig.ctl.stop()
    assert rig.observers() == 0 and rig.ctl.observer_count == 0
    assert rig.timer.deadline is None
    sent = len(FakeTransport.made[0].sent)
    recolor(a, (0.0, 0.0, 1.0))
    rig.ctl.flush_live()
    rig.pump(1000)
    assert len(FakeTransport.made[0].sent) == sent
    assert leaks(caplog, capfd, *NAMES) == []


@pytest.mark.parametrize("fails", ["detach", "stop"])
def test_panel_live_teardown_that_fails_still_ends_the_session(
    fake, monkeypatch, caplog, capfd, fails
):
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    rig = live_rig(a)
    acked(rig, 1)
    recolor(a, (0.0, 1.0, 0.0))  # a flush pending

    stops = FakeTransport.made[0].stops
    closed_first = []

    def boom(*args, **kwargs):
        closed_first.append(len(stops) == 1)  # the close is queued before any teardown
        raise SECRET

    if fails == "detach":
        monkeypatch.setattr(rig.watchers[0], "detach", boom)
    else:
        monkeypatch.setattr(live.LiveUpdates, "stop", boom)
    rig.ctl.stop()
    final, timeout = FakeTransport.made[0].stops[0]
    assert (final["type"], timeout) == ("session.close", 0) and rig.ctl.phase is Phase.STOPPING
    assert closed_first == [True]
    if fails == "detach":
        assert "scene: observers not removed (KeyError)" in caplog.text
        assert rig.timer.deadline is None  # the live updates were still stopped
    else:
        assert "scene: live updates not stopped (KeyError)" in caplog.text
        assert rig.observers() == 0  # the observers were still removed
    sent = len(FakeTransport.made[0].sent)
    recolor(a, (0.0, 0.0, 1.0))
    rig.ctl.flush_live()
    rig.pump(1000)
    assert len(FakeTransport.made[0].sent) == sent
    assert leaks(caplog, capfd, *NAMES) == []


def test_panel_live_a_close_in_a_batch_says_slicer_is_busy(fake):
    """A batch alone owes nothing ("Live"); a scene closed inside it is owed and waits for the batch's end."""
    a = MrmlModel(A)
    rig = live_rig(a)
    acked(rig, 1)
    rig.scene.InvokeEvent(EVENTS.start_batch)
    view = rig.pump(0)
    assert (view.status, view.detail) == ("Live · no viewers yet.", "")
    rig.scene.remove(a)
    rig.scene.InvokeEvent(EVENTS.end_close)
    view = rig.pump(1000)
    assert (view.status, view.detail) == (
        "Updating the scene · no viewers yet.",
        panel.WAITING_FOR_SLICER,
    )
    rig.scene.InvokeEvent(EVENTS.end_batch)
    view = rig.pump(0)
    assert rig.begins()[-1]["nodeCount"] == 0
    assert (view.status, view.detail) == ("Updating the scene · no viewers yet.", "")


def test_panel_live_a_snapshot_owed_during_a_batch_while_sending_is_not_waiting(fake):
    """The viewers are getting a snapshot: a batch, and a snapshot owed behind it (``request_snapshot``, SLC-18's
    profile or *Hide node names*), do not make the panel say Slicer is busy."""
    a = MrmlModel(A)
    rig = live_rig(a)
    acked(rig, 1)
    a.InvokeEvent(EVENTS.mesh_modified)
    rig.timer.advance(750)
    assert len(rig.begins()) == 2  # in flight
    rig.scene.InvokeEvent(EVENTS.start_batch)
    rig.ctl._live.request_snapshot()
    view = rig.pump(0)
    assert rig.ctl._live.owed and rig.ctl._live.in_flight and rig.ctl._live.batch_held
    assert (view.status, view.detail) == ("Updating the scene · no viewers yet.", "")


def test_panel_live_a_failure_after_a_scene_too_large_says_it_tries_again(fake, monkeypatch):
    a = MrmlModel(A, polydata=sphere(64))
    b = MrmlModel(B, polydata=sphere(64))
    rig = live_rig(a, b, limits={"maxSnapshotBytes": limit_for_one(64)})
    assert rig.ctl.view.detail.endswith(" " + panel.HIDE_MODELS)

    def boom(name):
        raise SECRET

    # the export's reads fail; the observers keep theirs
    monkeypatch.setattr(rig.scene, "by_class", boom)
    a.InvokeEvent(EVENTS.mesh_modified)
    rig.timer.advance(750)
    view = rig.ctl.view
    assert view.detail == f"{panel.SCENE_FAILED} {panel.RETRY_LATER}"


def test_panel_live_a_new_session_forgets_the_last_ones_problem(fake):
    a = MrmlModel(A, polydata=sphere(64))
    rig = live_rig(
        a, MrmlModel(B, polydata=sphere(64)), limits={"maxSnapshotBytes": limit_for_one(64)}
    )
    assert rig.ctl.view.detail.endswith(" " + panel.HIDE_MODELS)
    rig.ctl.stop()
    deliver(rig.ctl, Disconnected(1, None, None, final_sent=True))
    # the next session starts during a batch: nothing is sent, nothing is wrong
    rig.scene.batch = True
    rig.ctl.start(URL)
    view = deliver(rig.ctl, Connected(1), Received(1, created()))
    assert (view.status, view.detail) == (
        "Sending the scene · no viewers yet.",
        panel.WAITING_FOR_SLICER,
    )


def test_panel_live_without_a_watcher_the_texts_say_stop_and_start(fake):
    """Without a watch factory (``RemoteView.py`` before SLC-34) nothing in Slicer can open the too-large gate."""
    scene = Scene(MrmlView("vtkMRMLViewNode1"), MrmlModel(A, polydata=sphere(64)))
    ctl = PanelController(
        slicer_version="5.12.4",
        platform="win32",
        transport_factory=FakeTransport,
        scene=lambda: MrmlSceneApi(scene.by_class, FakeFolders()),
    )
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created(maxSnapshotBytes=2_000)))
    assert view.detail.endswith(" " + panel.HIDE_MODELS_AND_RESTART)
    assert ctl.observer_count == 0


# --------------------------------------------------------------------------- SLC-33: events off the main thread


def _in_thread(fn, *args):
    worker = threading.Thread(target=fn, args=args)
    worker.start()
    worker.join()


@pytest.mark.parametrize("case", ["event", "missed-end", "missed-start"])
def test_panel_live_events_off_the_main_thread_resync(fake, caplog, capfd, case):
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    rig = live_rig(a)
    acked(rig, 1)
    code, token = rig.ctl.view.code, rig.ctl._client.publisher_token().reveal()
    if case == "event":
        _in_thread(recolor, a, (0.0, 0.0, 1.0))
        assert rig.timer.deadline is None  # marked nothing
        rig.pump(0)
        assert len(rig.begins()) == 2  # the re-sync
    elif case == "missed-end":
        rig.scene.InvokeEvent(EVENTS.start_batch)
        rig.scene.batch = False
        _in_thread(rig.scene.InvokeEvent, EVENTS.end_batch)
        rig.pump(0)
        assert "batch=0" in repr(rig.ctl._live)  # caught up: the hold is released
        assert len(rig.begins()) == 2
    else:
        rig.scene.batch = True
        _in_thread(rig.scene.InvokeEvent, EVENTS.start_batch)
        view = rig.pump(0)
        assert len(rig.begins()) == 1  # the re-sync waits for the batch
        assert (view.status, view.detail) == (
            "Updating the scene · no viewers yet.",
            panel.WAITING_FOR_SLICER,
        )
        rig.scene.batch = False
        rig.scene.InvokeEvent(EVENTS.end_batch)
        rig.pump(0)
        assert len(rig.begins()) == 2
    assert acked(rig, 2).status == "Live · no viewers yet."
    assert leaks(caplog, capfd, *NAMES, code, token) == []


# --------------------------------------------------------------------------- SLC-34: the Slicer adapter


def _adapter(import_remote_view, slicer_stubs, monkeypatch, *nodes):
    """``RemoteView.py`` against the stubs, with ``slicer.mrmlScene`` holding ``nodes`` and a fake transport."""
    slicer = slicer_stubs["slicer"]
    slicer.mrmlScene.nodes = [MrmlView("vtkMRMLViewNode1"), *nodes]
    monkeypatch.setattr(slicer.util, "getNodesByClass", slicer.mrmlScene.by_class)
    monkeypatch.setattr(slicer, "vtkMRMLFolderDisplayNode", FakeFolders())
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    module = import_remote_view()

    def start():
        widget = module.RemoteViewWidget(parent=parent_widget())
        widget.setup()
        widget.ui.relayUrlLineEdit.text = URL
        widget.ui.extraCaPathLineEdit.currentPath = ""
        widget.onStartClicked()
        transport = FakeTransport.made[-1]
        transport.events.put(Connected(1))
        transport.events.put(Received(1, created()))
        widget.onPump()
        return widget, transport

    return slicer.mrmlScene, start


def _observed(scene, *nodes) -> bool:
    return any(scene.HasObserver(e) for e in SCENE_EVENTS) or any(
        node.HasObserver(e) for node in nodes for e in MODEL_EVENTS
    )


@pytest.mark.usefixtures("fake", "packages_installed")
def test_panel_live_adapter_follows_the_mrml_scene_only_while_live(
    import_remote_view, slicer_stubs, monkeypatch, caplog, capfd
):
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    scene, start = _adapter(import_remote_view, slicer_stubs, monkeypatch, a)
    widget, transport = start()
    code = widget.controller.view.code
    assert [m["type"] for _, m in transport.sent if isinstance(m, dict)][:2] == [
        "session.create",
        "scene.snapshot.begin",
    ]
    assert widget.controller.observer_count == 5 + 4
    transport.events.put(Received(1, ack(1)))
    widget.onPump()
    assert widget.ui.statusLabel.text == "Live · no viewers yet."
    recolor(a, (0.0, 0.0, 1.0))
    # 150 ms after the mark (the panel's clock is the real one here: a stall can only shorten it)
    assert widget.flushTimer.active and 0 < widget.flushTimer.starts[-1] <= 150
    widget.flushTimer.fire()
    assert [m["type"] for _, m in transport.sent if isinstance(m, dict)].count("scene.update") == 1
    widget.onStopClicked()
    assert widget.controller.observer_count == 0 and not _observed(scene, a)
    assert not widget.flushTimer.active
    widget.cleanup()
    assert leaks(caplog, capfd, *NAMES, code, TOKEN) == []


@pytest.mark.usefixtures("fake", "packages_installed")
def test_panel_live_adapter_reload_during_a_session(import_remote_view, slicer_stubs, monkeypatch):
    a = MrmlModel(A)
    scene, start = _adapter(import_remote_view, slicer_stubs, monkeypatch, a)
    widget, transport = start()
    assert _observed(scene, a)
    widget.cleanup()  # Reload: the old widget closes the session and lets go of the scene
    assert [(f["type"] if f else None, t) for f, t in transport.stops] == [
        ("session.close", 0),
        (None, 3.0),
    ]
    assert not _observed(scene, a)
    again, _ = start()  # the reloaded panel's Start works
    assert _observed(scene, a) and again.controller.observer_count == 5 + 4
    again.cleanup()


@pytest.mark.usefixtures("fake", "packages_installed")
def test_panel_live_adapter_follows_a_segmentation(
    import_remote_view, slicer_stubs, monkeypatch, caplog, capfd
):
    """SLC-37: ``RemoteView.py``'s watcher observes a segmentation node through the five ``slicer.vtkSegmentation.*``
    ids it passes — a per-segment colour change (``SegmentModified`` with the segment ID) is one ``scene.update``
    addressing that segment, and Stop leaves no observer on the scene or the node (T7 checked on the log)."""
    caplog.set_level(logging.DEBUG)
    seg = MrmlSegmentation(
        SEG,
        segments=[
            FakeSegment("Segment_1", name="Doe^John liver", polydata=sphere(8)),
            FakeSegment("Segment_2", name="Doe^John spleen", polydata=sphere(8)),
        ],
    )
    scene, start = _adapter(import_remote_view, slicer_stubs, monkeypatch, seg)
    widget, transport = start()
    code = widget.controller.view.code
    assert widget.controller.observer_count == 5 + 8
    assert all(seg.HasObserver(e) for e in SEGMENTATION_EVENTS)
    [begin] = [
        m for _, m in transport.sent if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"
    ]
    assert begin["nodeCount"] == 2
    transport.events.put(Received(1, ack(1)))
    widget.onPump()
    assert widget.ui.statusLabel.text == "Live · no viewers yet."
    seg.displays[0].per_segment["Segment_1"] = {"override_color": (0.0, 0.0, 1.0)}
    seg.fire("SegmentModified", "Segment_1")
    # an appearance change: the fast lane, 150 ms after the mark
    assert widget.flushTimer.active and 0 < widget.flushTimer.starts[-1] <= 150
    widget.flushTimer.fire()
    updates = [m for _, m in transport.sent if isinstance(m, dict) and m["type"] == "scene.update"]
    assert len(updates) == 1
    assert updates[0]["changes"] == [{"nodeId": f"{SEG}/Segment_1", "color": [0.0, 0.0, 1.0]}]
    widget.onStopClicked()
    assert widget.controller.observer_count == 0
    assert not any(seg.HasObserver(e) for e in SEGMENTATION_EVENTS)
    assert not any(scene.HasObserver(e) for e in SCENE_EVENTS)
    assert not widget.flushTimer.active
    widget.cleanup()
    assert leaks(caplog, capfd, *NAMES, "Segment_1", "Segment_2", SEG, code, TOKEN) == []


# --------------------------------------------------------------------------- SLC-36: segments and aliases end to end


def _updates(rig: Rig) -> list[dict]:
    return [m for m in rig.sent() if isinstance(m, dict) and m["type"] == "scene.update"]


def test_panel_live_segments_and_a_scripted_model_follow_slicer(fake, caplog, capfd):
    """The real watcher, adapter and controller over vtkObject fakes: v1 holds both segments and the ``Sphere`` model
    as ``m_1``; a colour change on ``Sphere`` addresses ``m_1``, a per-segment opacity change its segment, a brush
    stroke re-exports once, a new segment is announced with kind ``segment``, the removed segmentation takes its
    segments off the viewers — and no raw ID or name reaches the log (T7)."""
    caplog.set_level(logging.DEBUG)
    seg = MrmlSegmentation(
        SEG,
        segments=[
            FakeSegment("Segment_1", name="Doe^John liver", polydata=sphere(8)),
            FakeSegment("left lung", name="Doe^John lung", polydata=sphere(8)),
        ],
    )
    sphere_model = MrmlModel("Sphere", name="Doe^John sphere")
    rig = live_rig(seg, sphere_model)
    ctl = rig.ctl
    assert ctl.observer_count == 5 + 8 + 4 == rig.observers()
    [begin] = rig.begins()
    assert begin["nodeCount"] == 3
    assert [(m["nodeId"], m["kind"], m.get("segmentId")) for m in manifest(rig.glb())] == [
        ("m_1", "model", None),
        (f"{SEG}/Segment_1", "segment", "Segment_1"),
        (f"{SEG}/s_1", "segment", "left lung"),
    ]
    acked(rig, 1)
    # a colour change on the scripted model: one update addressing its alias
    recolor(sphere_model, (0.0, 1.0, 0.0))
    rig.timer.advance(150)
    [update] = _updates(rig)
    assert (update["sceneVersion"], update["baseVersion"]) == (2, 1)
    assert update["changes"] == [{"nodeId": "m_1", "color": [0.0, 1.0, 0.0]}]
    # a per-segment opacity change (the display node's event): its segment only
    seg.displays[0].per_segment["left lung"] = {"opacity_3d": 0.5}
    seg.InvokeEvent(EVENTS.display_modified)
    rig.timer.advance(150)
    assert _updates(rig)[-1]["changes"] == [{"nodeId": f"{SEG}/s_1", "opacity": 0.5}]
    # SegmentModified with the ID: a colour change
    seg.displays[0].per_segment["Segment_1"] = {"override_color": (0.0, 0.0, 1.0)}
    seg.fire("SegmentModified", "Segment_1")
    rig.timer.advance(750)
    assert _updates(rig)[-1]["changes"] == [
        {"nodeId": f"{SEG}/Segment_1", "color": [0.0, 0.0, 1.0]}
    ]
    # brush strokes: one begin, 750 ms after the last
    for _ in range(4):
        seg.segmentation.segments[0].mesh = sphere(10)
        seg.fire("RepresentationModified", "Segment_1")
        rig.timer.advance(500)
    assert len(rig.begins()) == 1
    rig.timer.advance(250)
    assert len(rig.begins()) == 2 and rig.begins()[-1]["nodeCount"] == 3
    acked(rig, rig.begins()[-1]["sceneVersion"])
    # a new segment: announced with its kind, then the snapshot
    seg.add_segment(FakeSegment("Segment_3", name="Doe^John spleen", polydata=sphere(8)))
    rig.timer.advance(750)
    added = [m for m in rig.sent() if isinstance(m, dict) and m["type"] == "scene.nodeAdded"]
    assert added[-1]["nodes"] == [{"nodeId": f"{SEG}/Segment_3", "kind": "segment"}]
    assert len(rig.begins()) == 3 and rig.begins()[-1]["nodeCount"] == 4
    acked(rig, rig.begins()[-1]["sceneVersion"])
    # the segmentation removed: its segments leave the viewers, its observers go
    rig.scene.remove(seg)
    rig.timer.advance(150)
    [removed] = [m for m in rig.sent() if isinstance(m, dict) and m["type"] == "scene.nodeRemoved"]
    assert sorted(removed["nodeIds"]) == sorted(
        [f"{SEG}/Segment_1", f"{SEG}/s_1", f"{SEG}/Segment_3"]
    )
    assert ctl.observer_count == 5 + 4 and rig.observers() == 5 + 4
    ctl.stop()
    assert rig.observers() == 0
    assert leaks(caplog, capfd, *NAMES, "Sphere", "left lung", "Segment_1", SEG) == []


def _of_type(rig: Rig, type_: str) -> list[dict]:
    return [m for m in rig.sent() if isinstance(m, dict) and m["type"] == type_]


def test_panel_live_segmentation_opacity_3d_zero_is_visible_false_not_a_removal(fake):
    """Manual §13 step 5 sub-step 3: a segmentation at ``Opacity3D`` 0 is not drawn (the DM's ``IsVisible``), so its
    segments leave ``shown`` with an appearance-only mark — the viewers hold them, so each gets ``visible: false`` and
    ``visible: true`` when the opacity comes back (the fast lane), never ``scene.nodeRemoved`` or a snapshot. Models
    and segmentations differ at opacity 0 at export time only (a segmentation at ``Opacity3D`` 0 is left out of a
    snapshot, a model at opacity 0 is exported)."""
    seg = MrmlSegmentation(SEG)
    rig = live_rig(seg)
    acked(rig, 1)
    seg.displays[0].opacity_3d = 0.0
    seg.InvokeEvent(EVENTS.display_modified)
    assert 0 < rig.timer.starts[-1] <= 150
    rig.timer.advance(150)
    [hidden] = _updates(rig)
    assert (hidden["sceneVersion"], hidden["baseVersion"]) == (2, 1)
    assert sorted(hidden["changes"], key=lambda c: c["nodeId"]) == [
        {"nodeId": f"{SEG}/Segment_1", "visible": False},
        {"nodeId": f"{SEG}/Segment_2", "visible": False},
    ]
    seg.displays[0].opacity_3d = 1.0
    seg.InvokeEvent(EVENTS.display_modified)
    rig.timer.advance(150)
    shown = _updates(rig)[-1]
    assert (shown["sceneVersion"], shown["baseVersion"]) == (3, 2)
    assert sorted(shown["changes"], key=lambda c: c["nodeId"]) == [
        {"nodeId": f"{SEG}/Segment_1", "visible": True},
        {"nodeId": f"{SEG}/Segment_2", "visible": True},
    ]
    assert len(_updates(rig)) == 2 and len(rig.begins()) == 1
    assert _of_type(rig, "scene.nodeRemoved") == [] and _of_type(rig, "scene.nodeAdded") == []


def test_panel_live_an_empty_segment_added_while_live_costs_a_snapshot_each_step(fake):
    """Manual §13 step 9 sub-step 2: ``SegmentAdded`` of an empty segment is a snapshot (``v2``) in which the segment
    is left out as ``no-triangles`` — not held and not in ``sent.skipped`` yet, it can only be re-exported; nothing is
    announced since only exported entities are. Its first stroke (``RepresentationModified``) lifts a skip reason the
    classifier is not sure about, so it is another plain snapshot (``v3``) with no ``scene.nodeAdded`` either. The
    export's own deferred ``SegmentModified(NULL)`` afterwards marks appearance only and sends nothing."""
    seg = MrmlSegmentation(SEG)
    rig = live_rig(seg)
    acked(rig, 1)
    seg.add_segment(FakeSegment("Segment_3", name="Doe^John added", polydata=None))
    assert rig.timer.starts[-1] == 750
    rig.timer.advance(750)
    assert len(rig.begins()) == 2 and rig.begins()[-1]["nodeCount"] == 2
    assert [m["nodeId"] for m in manifest(rig.glb())] == [f"{SEG}/Segment_1", f"{SEG}/Segment_2"]
    view = acked(rig, 2)
    assert view.detail == panel.skipped_text(1)  # the panel: one segment could not be shared
    seg.segmentation.segments[-1].mesh = sphere(8)
    seg.fire("RepresentationModified", "Segment_3")
    rig.timer.advance(750)
    assert len(rig.begins()) == 3 and rig.begins()[-1]["nodeCount"] == 3
    assert f"{SEG}/Segment_3" in [m["nodeId"] for m in manifest(rig.glb())]
    acked(rig, 3)
    seg.fire("SegmentModified")  # the deferred NULL event the export's own getters may fire
    rig.timer.advance(750)
    assert len(rig.begins()) == 3
    assert _of_type(rig, "scene.nodeAdded") == [] and _updates(rig) == []


@pytest.mark.parametrize("run", ["exported", "skipped", "failing-writer"])
def test_panel_live_a_verbatim_name_like_segment_id_reaches_no_log(
    fake, caplog, capfd, monkeypatch, run
):
    """T7 with the verbatim, name-like raw ID ``Liver_DoeJohn``: exported, left out as ``no-triangles``
    (``Liver_DoeJohn2`` has no representation), and with a writer that fails — the log shows ``GlbWriteError`` only."""
    from remoteview_core import snapshot as snapshot_module  # noqa: PLC0415
    from remoteview_core.glb_writer import GlbWriteError  # noqa: PLC0415

    caplog.set_level(logging.DEBUG)
    seg = MrmlSegmentation(
        SEG,
        segments=[
            FakeSegment("Liver_DoeJohn", name="Doe^John liver", polydata=sphere(8)),
            FakeSegment("Liver_DoeJohn2", name="Doe^John liver 2", polydata=None),  # no-triangles
            FakeSegment("left lung", name="Doe^John lung", polydata=sphere(8)),
        ],
    )
    rig = live_rig(seg, MrmlModel("Sphere", name="Doe^John sphere"))
    ids = [m["nodeId"] for m in manifest(rig.glb())]
    assert ids == ["m_1", f"{SEG}/Liver_DoeJohn", f"{SEG}/s_1"]
    assert rig.begins()[0]["nodeCount"] == 3
    acked(rig, 1)
    if run == "failing-writer":

        def boom(*args, **kwargs):
            raise GlbWriteError("entities[0]: the position, never the ID")

        monkeypatch.setattr(snapshot_module, "write_glb", boom)
    if run == "skipped":
        seg.fire("RepresentationModified", "Liver_DoeJohn2")  # still no representation: nothing
    else:
        seg.segmentation.segments[0].mesh = sphere(10)
        seg.fire("RepresentationModified", "Liver_DoeJohn")
    seg.displays[0].per_segment["Liver_DoeJohn"] = {"opacity_3d": 0.5}
    seg.fire("SegmentModified", "Liver_DoeJohn")
    rig.pump(750)
    rig.pump(3_000)
    if run == "skipped":
        assert len(rig.begins()) == 1 and _updates(rig)[-1]["changes"] == [
            {"nodeId": f"{SEG}/Liver_DoeJohn", "opacity": 0.5}
        ]
    elif run == "exported":
        assert len(rig.begins()) == 2
    else:
        assert len(rig.begins()) == 1
        assert "live: scene not exported (GlbWriteError)" in caplog.text
        assert rig.ctl.view.status.startswith("Scene not up to date")
    rig.ctl.stop()
    assert leaks(caplog, capfd, *NAMES, "Liver_DoeJohn", "left lung", "Sphere", SEG) == []


@needs_relay_stub
def test_panel_live_segments_end_to_end_with_the_relay_stub(caplog, capfd):
    """Against the relay stub: v1 holds both segments and ``m_1``, a colour change on ``Sphere`` is
    ``['scene.update', 2, 1]`` addressing ``m_1``, a per-segment opacity change another update, a brush stroke a
    snapshot; ``violations == []`` and no raw ID or name leaks (T7)."""
    caplog.set_level(logging.DEBUG)
    seg = MrmlSegmentation(
        SEG,
        segments=[
            FakeSegment("Segment_1", name="Doe^John liver", polydata=sphere(8)),
            FakeSegment("Liver_DoeJohn", name="Doe^John liver 2", polydata=sphere(8)),
        ],
    )
    sphere_model = MrmlModel("Sphere", name="Doe^John sphere")
    rig = Rig(
        seg,
        sphere_model,
        transport_factory=lambda url, events, extra_ca_file=None: RelayTransport(
            url, events, use_proxy=False
        ),
    )
    ctl, timer = rig.ctl, rig.timer

    def wait_live():
        pump_while(ctl, lambda: not ctl.view.status.startswith("Live"), 10)
        assert ctl.view.status == "Live · no viewers yet."

    stub = start_relay_stub("--report-updates")
    try:
        ctl.start(stub.address)
        wait_live()
        code, token = ctl.view.code, ctl._client.publisher_token().reveal()
        assert code and token
        assert sorted(ctl._live.sent.under(f"{SEG}/")) == [
            f"{SEG}/Liver_DoeJohn",
            f"{SEG}/Segment_1",
        ]
        assert "m_1" in ctl._live.sent and "Sphere" not in ctl._live.sent
        recolor(sphere_model, (0.0, 1.0, 0.0))
        assert timer.starts[-1] == 150
        timer.advance(150)
        assert ctl._live.sent.get("m_1").color == (
            0.0,
            1.0,
            0.0,
        )  # the update went out and was recorded
        seg.displays[0].per_segment["Segment_1"] = {"opacity_3d": 0.5}
        seg.InvokeEvent(EVENTS.display_modified)
        timer.advance(150)
        assert ctl._live.sent.get(f"{SEG}/Segment_1").opacity == pytest.approx(0.5)
        seg.segmentation.segments[1].mesh = sphere(10)
        seg.fire("RepresentationModified", "Liver_DoeJohn")
        assert timer.starts[-1] == 750
        timer.advance(750)
        assert ctl.view.status.startswith("Updating the scene")
        wait_live()
        ctl.stop()
        pump_while(ctl, lambda: ctl.active, 5)
        assert ctl.observer_count == 0 and rig.observers() == 0
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    lines = out.splitlines()
    report = json.loads(lines[-1])
    assert report["violations"] == []
    assert report["updates"] == [["scene.update", 2, 1], ["scene.update", 3, 2]]
    assert [s.split(":")[0] for s in lines[0].split()[2:]] == ["v1", "v4"]
    assert (
        leaks(caplog, capfd, *NAMES, "Sphere", "Liver_DoeJohn", "Segment_1", SEG, code, token) == []
    )
