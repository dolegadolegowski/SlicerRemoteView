"""SLC-46: the resume end to end — the panel with the real ``RelayTransport`` and ``SceneWatcher`` against the relay
stub of tools/fake-slicer (``relay_stub.mjs``, its commands and its ``--report-sessions`` line; protocol §4.3, §6.2,
§6.3, §8.4, §9.1, §9.3; FR-14, US-05; T1, T4, T7).

The panel's clock is the flush timer's fake clock (so the reconnect window and the answer deadline never run out in a
test lasting seconds); the transport's retry delays come from a ``random.Random`` pinned at their longest or shortest.
Every test checks that no session code, token, session ID or model name reaches the log, stdout or stderr, nor the
stub's printed report.
"""

from __future__ import annotations

import json
import logging
import time

import pytest
from support import (
    LeastJitter,
    MrmlModel,
    WorstJitter,
    leaks,
    needs_relay_stub,
    pump_while,
    start_relay_stub,
    stub_transport,
)
from test_panel_live import NAMES, Rig, recolor

from remoteview_core import panel
from remoteview_core.panel import Phase
from remoteview_core.transport import RESTART_JITTER_S, Received

pytestmark = needs_relay_stub
A = "vtkMRMLModelNode4"


def resume_stub(*extra: str):
    """The stub with a session grace of 60 s (later options win) and its per-handshake report."""
    return start_relay_stub("--report-sessions", "--grace-ms", "60000", *extra)


def until(ctl, condition, seconds: float, seen: set | None = None) -> float:
    """Pump like the adapter until ``condition()`` holds (at most ``seconds``); the time it took. ``seen`` collects
    every status and detail shown meanwhile."""
    began = time.monotonic()

    def waiting() -> bool:
        if seen is not None:
            seen.update((ctl.view.status, *ctl.view.detail.split("\n")))
        return not condition()

    pump_while(ctl, waiting, seconds)
    assert condition(), f"still {ctl.phase.value}: {ctl.view.status}"
    return time.monotonic() - began


def stub_has(ctl, stub, what: str, count: int, seconds: float = 5) -> None:
    """Pump until the stub has received ``count`` frames of ``what`` (``begins``, ``chunks``, ``ends`` or ``updates``):
    a frame the transport still queues is dropped by a Stop."""
    index = ("handshakes", "begins", "chunks", "ends", "updates").index(what) + 1
    until(ctl, lambda: int(stub.command("status").split()[index]) >= count, seconds)


def live_scene(ctl) -> bool:
    return ctl.phase is Phase.LIVE and ctl.view.status.startswith("Live")


def secrets(ctl) -> tuple[str, str, str]:
    client = ctl._client
    return client.code, client.publisher_token().reveal(), client.session_id


def report(out: str) -> dict:
    return json.loads(out.splitlines()[-1])


def printed(out: str, *secret: str) -> list[str]:
    """The secrets (codes, tokens, session IDs, names) that the stub printed: none."""
    return [s for s in secret if s and s in out]


def first_entries(sessions: list) -> list:
    return [(s["first"], s["preferredCode"]) for s in sessions]


def stopped(ctl) -> None:
    ctl.stop()
    pump_while(ctl, lambda: ctl.active, 5)


def test_resume_e2e_relay_restart_keeps_the_code_within_5_s(caplog, capfd):
    """Criterion 1: a relay restart (4008, the session forgotten) brings the session back with the same code within
    5 s, at the longest retry delay; the stub sees create, resume, then create with the previous code (§9.3)."""
    caplog.set_level(logging.DEBUG)
    rig = Rig(
        MrmlModel(A, name="Doe^John liver"), transport_factory=stub_transport(rng=WorstJitter())
    )
    ctl, seen = rig.ctl, set()
    stub = resume_stub()
    try:
        ctl.start(stub.address)
        until(ctl, lambda: live_scene(ctl), 10)
        first = secrets(ctl)
        began = time.monotonic()  # the transport's wait cannot start before the command is written
        stub.command("restart")
        until(ctl, lambda: ctl.phase is not Phase.LIVE, 3, seen)
        until(ctl, lambda: live_scene(ctl), 10, seen)
        took = time.monotonic() - began
        again = secrets(ctl)
        assert again[0] == first[0]
        assert RESTART_JITTER_S <= took < 5.0, f"took {took:.2f} s"  # the longest delay was used
        assert panel.RELAY_RESTARTED in seen
        stopped(ctl)
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    sessions = report(out)["sessions"]
    assert first_entries(sessions) == [
        ("session.create", "none"),
        ("session.resume", None),
        ("session.create", "previous"),
    ]
    assert sessions[1]["lastSceneVersion"] == 1 and sessions[1]["frames"] == []
    assert sessions[2]["frames"] == [
        ["scene.snapshot.begin", 1],
        ["chunk", 1, 0],
        ["scene.snapshot.end", 1],
        ["session.close"],
    ]
    assert report(out)["violations"] == []
    assert leaks(caplog, capfd, *NAMES, *first, *again) == []
    assert printed(out, *NAMES, *first, *again) == []


def test_resume_e2e_restart_without_the_old_code_shows_the_new_one(caplog, capfd):
    """T4: a relay that cannot keep the code gives a new one; the panel shows it and says so."""
    caplog.set_level(logging.DEBUG)
    rig = Rig(
        MrmlModel(A, name="Doe^John liver"), transport_factory=stub_transport(rng=LeastJitter())
    )
    ctl = rig.ctl
    stub = resume_stub("--ignore-preferred-code")
    try:
        ctl.start(stub.address)
        until(ctl, lambda: live_scene(ctl), 10)
        first = secrets(ctl)
        stub.command("restart")
        until(ctl, lambda: ctl.phase is not Phase.LIVE, 3)
        until(ctl, lambda: live_scene(ctl), 10)
        again = secrets(ctl)
        assert again[0] != first[0] and ctl.view.code == again[0]
        assert panel.NEW_CODE in ctl.view.detail
        stopped(ctl)
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    assert first_entries(report(out)["sessions"])[2] == ("session.create", "previous")
    assert leaks(caplog, capfd, *NAMES, *first, *again) == []
    assert printed(out, *NAMES, *first, *again) == []


def test_resume_e2e_heartbeat_loss_resumes_and_versions_continue(caplog, capfd):
    """§9.1: unanswered pings drop the connection; the resume restores the session (no second snapshot) and the next
    update continues the versions (§8.4)."""
    caplog.set_level(logging.DEBUG)
    a = MrmlModel(A, name="Doe^John liver")
    factory = stub_transport(rng=LeastJitter(), ping_interval=0.2, pong_timeout=0.3)
    rig = Rig(a, transport_factory=factory)
    ctl = rig.ctl
    stub = resume_stub("--report-updates")
    try:
        ctl.start(stub.address)
        until(ctl, lambda: live_scene(ctl), 10)
        first = secrets(ctl)
        stub.command("pongs off-until-handshake")
        until(ctl, lambda: ctl.phase is Phase.RECONNECTING, 3)
        assert ctl.view.code == first[0]
        until(ctl, lambda: live_scene(ctl), 5)
        pump_while(ctl, lambda: True, 1.0)  # five heartbeats: the resumed link answers them
        assert ctl.phase is Phase.LIVE
        recolor(a, (0.0, 1.0, 0.0))
        rig.timer.advance(150)
        stub_has(ctl, stub, "updates", 1)
        stopped(ctl)
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    sessions = report(out)["sessions"]
    assert first_entries(sessions) == [("session.create", "none"), ("session.resume", None)]
    assert sessions[1]["frames"] == [["scene.update", 2, 1], ["session.close"]]
    assert factory.made[0].sent_types[-1] == (None, "stop:session.close")  # the record works
    assert report(out)["violations"] == []
    assert leaks(caplog, capfd, *NAMES, *first) == []
    assert printed(out, *NAMES, *first) == []


def test_resume_e2e_snapshot_cut_before_its_end_is_sent_again(caplog, capfd):
    """§6.3: a snapshot whose end never reached the relay is lost with the connection and sent again after the
    resume, on a new version."""
    caplog.set_level(logging.DEBUG)

    def snapshot_end(frame) -> bool:
        return isinstance(frame, dict) and frame.get("type") == "scene.snapshot.end"

    factory = stub_transport(rng=LeastJitter(), drop_out=snapshot_end)
    rig = Rig(MrmlModel(A, name="Doe^John liver"), transport_factory=factory)
    ctl, seen = rig.ctl, set()
    stub = resume_stub()
    try:
        ctl.start(stub.address)
        until(ctl, lambda: factory.made and factory.made[0].dropped_out, 10)
        # begin and chunk have reached the stub; the end never will
        stub_has(ctl, stub, "chunks", 1)
        first = secrets(ctl)
        stub.command("close-publisher 1001")
        until(ctl, lambda: ctl.phase is Phase.RECONNECTING, 3, seen)
        until(ctl, lambda: live_scene(ctl), 10, seen)
        assert panel.SCENE_INTERRUPTED in seen
        stopped(ctl)
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    sessions = report(out)["sessions"]
    assert first_entries(sessions) == [("session.create", "none"), ("session.resume", None)]
    assert sessions[0]["frames"] == [["scene.snapshot.begin", 1], ["chunk", 1, 0]]  # no end
    assert sessions[1]["frames"] == [
        ["scene.snapshot.begin", 2],
        ["chunk", 2, 0],
        ["scene.snapshot.end", 2],
        ["session.close"],
    ]
    assert report(out)["violations"] == []
    assert leaks(caplog, capfd, *NAMES, *first) == []
    assert printed(out, *NAMES, *first) == []


def test_resume_e2e_ack_lost_with_the_connection_is_not_resent(caplog, capfd):
    """§4.3: a snapshot the relay holds is adopted at the resume — only its ack was lost — and not uploaded again."""
    caplog.set_level(logging.DEBUG)

    def snapshot_ack(event) -> bool:
        return (
            isinstance(event, Received)
            and isinstance(event.message, dict)
            and (event.message.get("type") == "scene.snapshot.ack")
        )

    factory = stub_transport(rng=LeastJitter(), drop_in=snapshot_ack)
    rig = Rig(MrmlModel(A, name="Doe^John liver"), transport_factory=factory)
    ctl = rig.ctl
    stub = resume_stub()
    try:
        ctl.start(stub.address)
        until(ctl, lambda: factory.made and factory.made[0].dropped_in, 10)
        pump_while(ctl, lambda: True, 0.3)  # an ack that was not dropped would be handled by now
        assert ctl._client.snapshot_in_flight == 1
        first = secrets(ctl)
        stub.command("close-publisher 1001")
        until(ctl, lambda: ctl.phase is Phase.RECONNECTING, 3)
        until(ctl, lambda: live_scene(ctl), 10)
        stopped(ctl)
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    sessions = report(out)["sessions"]
    assert first_entries(sessions) == [("session.create", "none"), ("session.resume", None)]
    assert sessions[1]["frames"] == [["session.close"]]  # no second upload
    assert leaks(caplog, capfd, *NAMES, *first) == []
    assert printed(out, *NAMES, *first) == []


def test_resume_e2e_grace_ended_ends_the_session(caplog, capfd):
    """Without a 4008 a session the relay no longer knows ended while offline; nothing is created again (its code
    may already belong to another session)."""
    caplog.set_level(logging.DEBUG)
    factory = stub_transport(rng=LeastJitter())
    rig = Rig(MrmlModel(A, name="Doe^John liver"), transport_factory=factory)
    ctl = rig.ctl
    stub = resume_stub("--grace-ms", "50")
    try:
        ctl.start(stub.address)
        until(ctl, lambda: live_scene(ctl), 10)
        first = secrets(ctl)
        stub.command("close-publisher 1001")
        until(ctl, lambda: ctl.phase is Phase.IDLE, 10)
        assert (ctl.view.status, ctl.view.detail) == (
            panel.SESSION_ENDED,
            panel.SESSION_GONE_OFFLINE,
        )
    finally:
        ctl.shutdown(timeout=3)
        out = stub.finish()
    assert first_entries(report(out)["sessions"]) == [
        ("session.create", "none"),
        ("session.resume", None),
    ]
    # T1: after the refused resume nothing went out, not even session.close (no session on that socket)
    sent = factory.made[0].sent_types
    last = max(c for c, _ in sent if c is not None)
    assert [t for c, t in sent if c == last] == ["session.resume"]
    assert [t for c, t in sent if c is None] == ["stop:none"]  # every stop
    assert report(out)["violations"] == []
    assert leaks(caplog, capfd, *NAMES, *first) == []
    assert printed(out, *NAMES, *first) == []


def test_resume_e2e_a_stub_that_cannot_start_is_said_at_once():
    """The harness (no session, so nothing to leak): a stub that exits before printing its address fails the test at
    once, not after waiting 10 s for output that already ended."""
    began = time.monotonic()
    with pytest.raises(AssertionError, match="did not start"):
        start_relay_stub("--port", "-1")  # Node refuses the port and exits
    assert time.monotonic() - began < 5
