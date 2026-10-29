"""SLC-25: the panel sends the first snapshot on session.created and goes "Live" on the relay's ack.

Since SLC-32 the panel hands the session to ``LiveUpdates``, which sends the scene again by itself after a refusal or a
failure. These controllers have no watch factory (``RemoteView.py`` passes none before SLC-34): nothing in Slicer is
followed, so the texts that wait for a change say to stop and start the session."""

from __future__ import annotations

import logging
import sys
import time

import pytest
from support import (
    CODE,
    URL,
    FakeDisplay,
    FakeFolders,
    FakeScene,
    FakeTransport,
    FakeView,
    MrmlModel,
    ack,
    created,
    deliver,
    manifest,
    needs_relay_stub,
    parent_widget,
    pump_while,
    reassemble,
    root_extras,
    sphere,
    start_relay_stub,
    viewer_count,
)

from remoteview_core import panel
from remoteview_core.ids import SceneIds
from remoteview_core.panel import PanelController, Phase
from remoteview_core.snapshot import SnapshotTooLargeError
from remoteview_core.transport import Connected, Disconnected, Received, RelayTransport
from remoteview_protocol import envelope


def controller(scene, now=None) -> PanelController:
    """``now`` is a one-item list of the clock's seconds (the back-off is timed on it)."""
    now = [0.0] if now is None else now
    return PanelController(
        slicer_version="5.12.4",
        platform="win32",
        transport_factory=FakeTransport,
        scene=scene,
        clock=lambda: now[0],
    )


def begins(transport) -> list[dict]:
    return [
        m for _, m in transport.sent if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"
    ]


def kinds(transport) -> list[str]:
    return [m["type"] if isinstance(m, dict) else "chunk" for _, m in transport.sent]


def liver_scene():
    return FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})


# --------------------------------------------------------------------------- the controller


def test_panel_snapshot_is_sent_after_created_and_goes_live_on_ack(fake):
    ctl = controller(liver_scene)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    transport = fake.made[0]
    assert kinds(transport) == [
        "session.create",
        "scene.snapshot.begin",
        "chunk",
        "scene.snapshot.end",
    ]
    assert all(connection == 1 for connection, _ in transport.sent)
    assert (view.status, view.code, view.detail) == (
        "Sending the scene · no viewers yet.",
        CODE,
        "",
    )
    begin = transport.sent[1][1]
    assert begin["nodeCount"] == 1 and begin["sceneVersion"] == 1
    assert deliver(ctl, Received(1, ack(7))).status.startswith("Sending")  # another version's ack
    assert deliver(ctl, Received(1, ack(1))).status == "Live · no viewers yet."
    assert deliver(ctl, Received(1, viewer_count(2))).status == "Live · 2 viewers."
    assert len(kinds(transport)) == 4  # the scene is sent once per session


def test_panel_snapshot_reports_models_left_out(fake):
    def scene():
        return FakeScene(
            {"id": "vtkMRMLModelNode4", "mesh": sphere(8)},
            {"id": "vtkMRMLModelNode5"},
            {"id": "vtkMRMLModelNode6"},
        )

    ctl = controller(scene)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert view.detail == "2 models or segments shown in 3D could not be shared."
    assert (
        deliver(ctl, Received(1, ack(1))).detail
        == "2 models or segments shown in 3D could not be shared."
    )
    assert (
        panel.skipped_text(1) == "1 model or segments shown in 3D could not be shared."
        and panel.skipped_text(0) == ""
    )


def test_panel_snapshot_warns_about_the_device_profiles_budgets(fake, monkeypatch):
    """SLC-14 (NFR-03): a scene above the profile's recommended size is sent with a warning; a model nothing could
    simplify is sent whole and counted."""
    from remoteview_core import decimate, snapshot  # noqa: PLC0415

    def nothing_reduces(entity, target, **kw):
        return None
        yield  # a steps generator (remoteview_core.steps)

    monkeypatch.setattr(decimate, "decimate_steps", nothing_reduces)
    small = decimate.Budget(
        total_triangles=500_000, node_triangles=50, target_bytes=1_000
    )  # sphere(8): 96
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": small})

    def scene():
        return FakeScene(
            {"id": "vtkMRMLModelNode4", "mesh": sphere(8)}, {"id": "vtkMRMLModelNode5"}
        )

    ctl = controller(scene)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert view.detail.startswith(
        "1 model or segments shown in 3D could not be shared. 1 model or segments could not be simplified for "
        "the device profile and is sent whole. The scene is "
    )
    assert view.detail.endswith(
        " MB, more than the 0.0 MB recommended for the device profile: viewers may load it slowly. Hide models or "
        "segments in 3D to make it smaller."
    )
    assert (
        view.status == "Sending the scene · no viewers yet."
    )  # sent all the same (a warning, not a refusal)


def test_panel_budget_text_counts_and_rounds():
    def snap(**fields):
        values = {
            "messages": None,
            "scene_version": 1,
            "node_count": 1,
            "triangle_count": 1,
            "skipped": (),
        }
        return panel.Snapshot(
            **(values | {"byte_length": 1_000_000, "target_bytes": 32 << 20} | fields)
        )

    assert panel.budget_text(snap()) == ""
    assert panel.budget_text(snap(unreduced=("a", "b"))) == (
        "2 models or segments could not be simplified for the device profile and are sent whole."
    )
    text = panel.budget_text(snap(byte_length=33_554_433, target_bytes=33_554_432))  # one byte over
    assert (
        "33.6 MB, more than the 33.5 MB recommended" in text
    )  # never the same number on both sides


@pytest.mark.parametrize("withdrawn", ["stop", "timeout", "stale"])
def test_panel_snapshot_never_collects_after_the_session_was_given_up(fake, withdrawn):
    """Opt-in (FR-02): the scene is collected only for a session that is live — not at Start or on Connected, and not
    when session.created arrives after Stop, after the answer timeout or on a connection the transport left."""
    calls = []

    def scene():
        calls.append(1)
        return liver_scene()

    now = [0.0]
    ctl = PanelController(
        slicer_version="5.12.4",
        platform="win32",
        transport_factory=FakeTransport,
        scene=scene,
        clock=lambda: now[0],
    )
    ctl.start(URL)
    deliver(ctl, Connected(1))
    assert calls == []
    if withdrawn == "stop":
        ctl.stop()
    elif withdrawn == "timeout":
        now[0] = 15.0
        ctl.pump()
    else:  # the connection dropped before the answer; the relay's late answer arrives on the old connection
        deliver(ctl, Disconnected(1, None, 1.0), Connected(2))
    deliver(ctl, Received(1, created()))
    assert calls == [] and "scene.snapshot.begin" not in kinds(fake.made[0])


def test_panel_snapshot_too_large_keeps_the_session(fake):
    now = [0.0]
    ctl = controller(liver_scene, now)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created(maxSnapshotBytes=2_000)))
    assert kinds(fake.made[0]) == ["session.create"]  # nothing of the scene left the PC
    assert view.status == "Session running without the scene · no viewers yet."
    assert (
        view.detail.startswith("The scene is too large to send (")
        and "this relay accepts" in view.detail
        and view.detail.endswith(
            "Hide models or segments in 3D, then stop and start the session."
        )  # one action, NFR-23/31
    )
    assert view.detail.endswith(" " + panel.HIDE_MODELS_AND_RESTART)
    assert ctl.phase is Phase.LIVE and view.code == CODE and view.stop_enabled
    now[0] = 3600.0  # nothing in Slicer is followed: only a new session sends it
    assert ctl.pump().detail == view.detail and kinds(fake.made[0]) == ["session.create"]


@pytest.mark.parametrize(
    ("code", "answers", "detail", "again_after"),
    [("PAYLOAD_TOO_LARGE", "begin",
      "The relay refused the scene as too large. Hide models or segments in 3D, then stop and start the session.",
      None),
     ("CAPACITY", "begin",
      "The relay has no room for the scene right now. RemoteView tries again automatically.", 2.0),
     ("CHECKSUM_MISMATCH", "end",
      "The relay refused the scene (CHECKSUM_MISMATCH); if this repeats, please report it. RemoteView tries again "
      "automatically.", 2.0)],
)  # fmt: skip
def test_panel_snapshot_refused_by_the_relay(fake, code, answers, detail, again_after):
    now = [0.0]
    ctl = controller(liver_scene, now)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    sent = {m["type"]: m for _, m in fake.made[0].sent if isinstance(m, dict)}
    message_id = sent[f"scene.snapshot.{answers}"]["id"]
    refusal = envelope.make(
        "error", reply_to=message_id, code=code, message="relay free text 9", retryable=True
    )
    view = deliver(ctl, Received(1, refusal))
    assert (view.status, view.detail) == (
        "Session running without the scene · no viewers yet.",
        detail,
    )
    assert "relay free text" not in view.detail and ctl.phase is Phase.LIVE
    assert fake.made[0].discarded == [1]  # the rest of the refused snapshot stays on this PC
    assert deliver(ctl, Received(1, ack(1))).status.startswith(
        "Session running without"
    )  # too late
    now[0] = 1.9
    ctl.pump()
    assert len(begins(fake.made[0])) == 1
    if again_after is None:  # a scene too large waits for a change nothing follows here
        now[0] = 600.0
        assert ctl.pump().detail == detail and len(begins(fake.made[0])) == 1
        return
    now[0] = again_after  # the back-off: sent again by itself
    view = ctl.pump()
    assert [m["sceneVersion"] for m in begins(fake.made[0])] == [1, 2]
    assert (view.status, view.detail) == ("Sending the scene · no viewers yet.", "")


def test_panel_snapshot_build_failure_is_contained(fake, caplog):
    class Broken(FakeScene):
        def visible_model_nodes(self):
            raise RuntimeError("Doe^John")  # e.g. an MRML call failing on a strange node

    caplog.set_level(logging.DEBUG)
    ctl = controller(Broken)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert (view.status, view.detail) == (
        "Session running without the scene · no viewers yet.",
        f"{panel.SCENE_FAILED} {panel.RETRY_LATER}",
    )
    assert kinds(fake.made[0]) == ["session.create"] and view.code == CODE
    assert "Doe" not in caplog.text and "live: scene not exported (RuntimeError)" in caplog.text


def test_panel_snapshot_state_starts_over_with_each_session(fake):
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()), Received(1, ack(1)))
    ctl.stop()
    deliver(ctl, Disconnected(1, None, None, final_sent=True))
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert view.status == "Sending the scene · no viewers yet." and view.detail == ""
    assert kinds(fake.made[1])[:2] == ["session.create", "scene.snapshot.begin"]


def test_panel_snapshot_owns_one_alias_registry_per_session(fake):
    """SLC-35 (§7.3, D-a): the panel hands ``LiveUpdates`` a ``SceneIds`` of its own — one per ``session.create``, so a
    Stop → Start may renumber while every export within a session reuses the aliases it issued."""
    seg = "vtkMRMLSegmentationNode1"

    def scene():
        return FakeScene(
            {"id": seg, "segment": "left lung", "mesh": sphere(8)},
            {"id": seg, "segment": "Tumor(1)", "mesh": sphere(8)},
        )

    ctl = controller(scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    first = ctl._live.ids
    assert isinstance(first, SceneIds)
    _, glb, _ = reassemble([m for _, m in fake.made[0].sent[1:]])
    assert [m["nodeId"] for m in manifest(glb)] == [f"{seg}/s_1", f"{seg}/s_2"]
    # the export used this very registry: the tumour's alias is already s_2 here (an untouched one would say s_1)
    assert first.segment_node_id(seg, "Tumor(1)", anonymize=False) == f"{seg}/s_2"
    ctl.stop()
    deliver(ctl, Disconnected(1, None, None, final_sent=True))
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    assert ctl._live.ids is not first and isinstance(ctl._live.ids, SceneIds)


def test_panel_snapshot_carries_the_slicer_version(fake):
    ctl = PanelController(
        slicer_version="5.10.2",
        platform="linux",
        transport_factory=FakeTransport,
        scene=liver_scene,
    )
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    _, glb, _ = reassemble([m for _, m in fake.made[0].sent[1:]])
    assert root_extras(glb)["source"]["version"] == "5.10.2"


def test_panel_snapshot_too_large_text_never_shows_equal_numbers():
    text = panel.scene_too_large_text(SnapshotTooLargeError(3 * 1_048_576 + 1, 2 * 1_048_576))
    assert text.startswith("The scene is too large to send (3.2 MB; this relay accepts 2.0 MB)")
    assert "(2.1 MB; this relay accepts 2.0 MB)" in panel.scene_too_large_text(
        SnapshotTooLargeError(2_000_001, 2_000_000)
    )


def test_panel_snapshot_keeps_the_extra_ca_note(fake):
    """T5 (SLC-09): the trust note stays next to every scene message while the wss:// connection runs."""

    def scenes():
        return FakeScene(
            {"id": "vtkMRMLModelNode4", "mesh": sphere(8)}, {"id": "vtkMRMLModelNode5"}
        )

    for limits, step in (({}, "skipped"), ({"maxSnapshotBytes": 2_000}, "too large")):
        ctl = controller(scenes)
        ctl.start(URL, extra_ca_file="/etc/hospital-root.pem")
        view = deliver(ctl, Connected(1), Received(1, created(**limits)))
        assert view.detail.split("\n")[0] == panel.EXTRA_CA_IN_USE, step  # the trust note first
        assert len(view.detail.split("\n")) == 2, step
        if not limits:
            assert panel.EXTRA_CA_IN_USE in deliver(ctl, Received(1, ack(1))).detail


def test_panel_snapshot_queued_frames_are_kept_unless_the_snapshot_is_refused(fake):
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    unrelated = envelope.make(
        "error", reply_to="hb-9", code="INVALID_MESSAGE", message="relay text"
    )
    deliver(ctl, Received(1, unrelated), Received(1, viewer_count(1)), Received(1, ack(1)))
    assert fake.made[0].discarded == []


def test_panel_snapshot_ignores_errors_about_other_messages(fake):
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    unrelated = envelope.make(
        "error", reply_to="hb-9", code="INVALID_MESSAGE", message="relay text"
    )
    assert deliver(ctl, Received(1, unrelated)).status == "Sending the scene · no viewers yet."
    assert deliver(ctl, Received(1, ack(1))).status == "Live · no viewers yet."


def test_panel_snapshot_chunk_error_without_reply_to_is_sent_again_at_once(fake):
    """The relay's chunk timeout or a bad chunk answers no message id (§6.3, §9.2): the snapshot is refused and the
    first re-sync goes out in the same pump (SLC-29's re-sync rule)."""
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    bad = envelope.make("error", code="BAD_SEQUENCE", message="relay text", retryable=True)
    view = deliver(ctl, Received(1, bad))
    assert [m["sceneVersion"] for m in begins(fake.made[0])] == [1, 2]
    assert fake.made[0].discarded == [1]
    assert (view.status, view.detail) == ("Sending the scene · no viewers yet.", "")


@pytest.mark.parametrize("failure", ["factory", "collect"])
def test_panel_snapshot_any_failure_while_preparing_is_contained(fake, failure):
    def factory():
        if failure == "factory":
            raise AttributeError("vtkMRMLModelNode has no GetPolyData")

        class Odd(FakeScene):
            def polydata(self, node):
                raise TypeError("unexpected mesh")

        return Odd({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})

    ctl = controller(factory)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert (view.detail, view.code, ctl.phase) == (
        f"{panel.SCENE_FAILED} {panel.RETRY_LATER}",
        CODE,
        Phase.LIVE,
    )
    assert kinds(fake.made[0]) == ["session.create"]


# --------------------------------------------------------------------------- the adapter passes the Slicer scene


def test_panel_snapshot_adapter_sends_the_mrml_scene(
    import_remote_view, slicer_stubs, monkeypatch, fake, packages_installed
):
    # MrmlModel: since SLC-34 the adapter's watcher observes the model (a FakeModel cannot be observed)
    model = MrmlModel("vtkMRMLModelNode4", displays=[FakeDisplay()], polydata=sphere(8))
    nodes = {
        "vtkMRMLModelNode": [model],
        "vtkMRMLSegmentationNode": [],
        "vtkMRMLViewNode": [FakeView("vtkMRMLViewNode1")],
    }
    monkeypatch.setattr(slicer_stubs["slicer"], "vtkMRMLFolderDisplayNode", FakeFolders())
    monkeypatch.setattr(slicer_stubs["slicer"].util, "getNodesByClass", nodes.__getitem__)
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    instance = import_remote_view().RemoteViewWidget(parent=parent_widget())
    instance.setup()
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    fake.made[0].events.put(Connected(1))
    fake.made[0].events.put(Received(1, created()))
    instance.onPump()
    begin = fake.made[0].sent[1][1]
    assert begin["type"] == "scene.snapshot.begin" and begin["nodeCount"] == 1
    assert instance.ui.statusLabel.text == "Sending the scene · no viewers yet."
    instance.cleanup()


# --------------------------------------------------------------------------- end to end through the relay stub


@needs_relay_stub
def test_panel_snapshot_end_to_end_with_the_relay_stub():
    """The real controller and transport: a sphere scene goes "Live" on the stub's ack (§6.4)."""
    ctl = PanelController(
        slicer_version="5.12.4",
        platform=sys.platform,
        transport_factory=lambda u, events, extra_ca_file=None: RelayTransport(
            u, events, use_proxy=False
        ),
        scene=lambda: FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)}),
    )
    stub = start_relay_stub()
    try:
        ctl.start(stub.address)
        pump_while(ctl, lambda: not ctl.view.status.startswith("Live"), 10)
        assert ctl.view.status == "Live · no viewers yet." and ctl.view.code
        started = time.monotonic()
        ctl.stop()
        pump_while(ctl, lambda: ctl.active, 5)
        assert ctl.view == panel.PanelView(panel.NOT_CONNECTED) and time.monotonic() - started < 5
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    closes, _pings, *snapshots = out.split()
    assert closes == "1" and len(snapshots) == 1 and snapshots[0].startswith("v1:")
