"""SLC-25: the panel sends the first snapshot on session.created and goes "Live" on the relay's ack."""

from __future__ import annotations

import logging
import subprocess
import sys
import time
from pathlib import Path

import pytest
from test_mrml_scene import FakeDisplay, FakeFolders, FakeModel, FakeView
from test_panel import (
    CODE,
    RELAY_STUB,
    URL,
    FakeTransport,
    _first_line,
    _parent,
    _pump_while,
    deliver,
    needs_relay_stub,
    viewer_count,
)
from test_snapshot import FakeScene, reassemble, root_extras, sphere

from remoteview_core import panel
from remoteview_core.panel import PanelController, Phase
from remoteview_core.snapshot import SnapshotTooLargeError
from remoteview_core.transport import Connected, Disconnected, Received, RelayTransport
from remoteview_protocol import envelope

LIMITS = {
    "maxSnapshotBytes": 67_108_864,
    "maxChunkBytes": 1_048_576,
    "maxTextBytes": 262_144,
    "maxChanges": 1000,
}


def created(**limits) -> dict:
    return envelope.make(
        "session.created",
        reply_to="p-1",
        sessionId="sess_01K7Q4XMB2TJ9RD6",
        code=CODE,
        publisherToken="pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA",  # the protocol.md §4.2 example
        viewerLimit=20,
        ttl={"graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120},
        limits={**LIMITS, **limits},
    )


def ack(version: int) -> dict:
    return envelope.make(
        "scene.snapshot.ack", sceneVersion=version, viewersStreamed=0, viewersDeferred=0
    )


def controller(scene) -> PanelController:
    return PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport, scene=scene
    )


def kinds(transport) -> list[str]:
    return [m["type"] if isinstance(m, dict) else "chunk" for _, m in transport.sent]


@pytest.fixture
def fake():
    FakeTransport.made = []
    return FakeTransport


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
    assert view.detail == "2 models shown in 3D could not be shared."
    assert deliver(ctl, Received(1, ack(1))).detail == "2 models shown in 3D could not be shared."
    assert (
        panel.skipped_text(1) == "1 model shown in 3D could not be shared."
        and panel.skipped_text(0) == ""
    )


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
    ctl = controller(liver_scene)
    ctl.start(URL)
    view = deliver(ctl, Connected(1), Received(1, created(maxSnapshotBytes=2_000)))
    assert kinds(fake.made[0]) == ["session.create"]  # nothing of the scene left the PC
    assert view.status == "Session running without the scene · no viewers yet."
    assert (
        view.detail.startswith("The scene is too large to send (")
        and "this relay accepts" in view.detail
    )
    assert ctl.phase is Phase.LIVE and view.code == CODE and view.stop_enabled


@pytest.mark.parametrize(
    ("code", "answers", "detail"),
    [("PAYLOAD_TOO_LARGE", "begin", panel.SCENE_REFUSED["PAYLOAD_TOO_LARGE"]),
     ("CAPACITY", "begin", panel.SCENE_REFUSED["CAPACITY"]),
     ("CHECKSUM_MISMATCH", "end", "The relay refused the scene (CHECKSUM_MISMATCH). Stop and start the session; if it "
                                  "happens again, please report this.")],
)  # fmt: skip
def test_panel_snapshot_refused_by_the_relay(fake, code, answers, detail):
    ctl = controller(liver_scene)
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
    assert deliver(ctl, Received(1, ack(1))).status.startswith(
        "Session running without"
    )  # too late


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
        panel.SCENE_FAILED,
    )
    assert kinds(fake.made[0]) == ["session.create"] and view.code == CODE
    assert "Doe" not in caplog.text and "scene: snapshot not built (RuntimeError)" in caplog.text


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


def test_panel_snapshot_ignores_errors_about_other_messages(fake):
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    unrelated = envelope.make(
        "error", reply_to="hb-9", code="INVALID_MESSAGE", message="relay text"
    )
    assert deliver(ctl, Received(1, unrelated)).status == "Sending the scene · no viewers yet."
    assert deliver(ctl, Received(1, ack(1))).status == "Live · no viewers yet."


def test_panel_snapshot_chunk_error_without_reply_to_refuses_it(fake):
    """The relay's chunk timeout or a bad chunk answers no message id (§6.3, §9.2)."""
    ctl = controller(liver_scene)
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, created()))
    bad = envelope.make("error", code="BAD_SEQUENCE", message="relay text", retryable=True)
    view = deliver(ctl, Received(1, bad))
    assert view.status == "Session running without the scene · no viewers yet."
    assert view.detail == panel.scene_refused_text("BAD_SEQUENCE")


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
    assert (view.detail, view.code, ctl.phase) == (panel.SCENE_FAILED, CODE, Phase.LIVE)
    assert kinds(fake.made[0]) == ["session.create"]


# --------------------------------------------------------------------------- the adapter passes the Slicer scene


def test_panel_snapshot_adapter_sends_the_mrml_scene(
    import_remote_view, slicer_stubs, monkeypatch, fake
):
    model = FakeModel("vtkMRMLModelNode4", displays=[FakeDisplay()], polydata=sphere(8))
    nodes = {"vtkMRMLModelNode": [model], "vtkMRMLViewNode": [FakeView("vtkMRMLViewNode1")]}
    monkeypatch.setattr(slicer_stubs["slicer"], "vtkMRMLFolderDisplayNode", FakeFolders())
    monkeypatch.setattr(slicer_stubs["slicer"].util, "getNodesByClass", nodes.__getitem__)
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    instance = import_remote_view().RemoteViewWidget(parent=_parent())
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
    stub = subprocess.Popen(  # fixed argv: node and two repository files
        ["node", str(Path(__file__).with_name("relay_stub.mjs")), RELAY_STUB.as_uri()],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    ctl = PanelController(
        slicer_version="5.12.4",
        platform=sys.platform,
        transport_factory=lambda u, events, extra_ca_file=None: RelayTransport(
            u, events, use_proxy=False
        ),
        scene=lambda: FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)}),
    )
    try:
        url = _first_line(stub, timeout=15)
        assert url.startswith("ws://127.0.0.1:"), "the relay stub did not start"
        ctl.start(url)
        _pump_while(ctl, lambda: not ctl.view.status.startswith("Live"), 10)
        assert ctl.view.status == "Live · no viewers yet." and ctl.view.code
        started = time.monotonic()
        ctl.stop()
        _pump_while(ctl, lambda: ctl.active, 5)
        assert ctl.view == panel.PanelView(panel.NOT_CONNECTED) and time.monotonic() - started < 5
    finally:
        ctl.shutdown(timeout=3)
        try:
            out, _ = stub.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            stub.kill()
            out, _ = stub.communicate()
    closes, _pings, *snapshots = out.split()
    assert closes == "1" and len(snapshots) == 1 and snapshots[0].startswith("v1:")
