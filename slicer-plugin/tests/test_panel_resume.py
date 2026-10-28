"""SLC-37: the panel resumes its session after a lost connection (docs/protocol.md §4.3, §8.4, §9.1, §9.3; FR-14,
US-05; T1, T4, T7).

The transport reconnects by itself (SLC-08). On each ``Connected`` while reconnecting the panel sends
``session.resume`` — never after the reconnect window, which runs on the monotonic and on the wall clock — and
``session.resumed`` brings the session back to Live. The clocks are moved by hand; the tests that handle the session's
secrets check that the code, the publisher token and the session ID reach no log line, stdout or stderr (T7). The
scene across a resume (the same live updates and observers) is in ``test_panel_live.py``.
"""

from __future__ import annotations

import logging
import sys

import pytest
from support import (
    CODE,
    SESSION_ID,
    TOKEN,
    URL,
    FakeTransport,
    created,
    deliver,
    leaks,
    relay_error,
    resumed,
)

from remoteview_core import panel
from remoteview_core.panel import PanelController, PanelView, Phase
from remoteview_core.transport import (
    Connected,
    Disconnected,
    ErrorKind,
    Received,
    TlsError,
    TransportError,
)
from remoteview_protocol import envelope, schemas

SECRETS = (CODE, TOKEN, SESSION_ID)
NETWORK = TransportError(ErrorKind.NETWORK, retryable=True)
HEARTBEAT = TransportError(ErrorKind.HEARTBEAT, retryable=True)
RESTART = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4008)
GAVE_UP_HELD = f"{panel.RECONNECT_GAVE_UP}\n{panel.RELAY_HOLDS_SESSION}"
GAVE_UP_LONGER = f"{panel.RECONNECT_GAVE_UP}\n{panel.RELAY_HOLDS_SESSION_LONGER}"


class Clocks:
    """The panel's monotonic clock and its wall clock, in seconds."""

    def __init__(self) -> None:
        self.mono = 1000.0
        self.wall = 1_800_000_000.0

    def advance(self, seconds: float) -> None:
        self.mono += seconds
        self.wall += seconds


@pytest.fixture
def clocks() -> Clocks:
    return Clocks()


def controller(clocks: Clocks) -> PanelController:
    return PanelController(
        slicer_version="5.12.4",
        platform=sys.platform,
        transport_factory=FakeTransport,
        clock=lambda: clocks.mono,
        wall=lambda: clocks.wall,
    )


def live(ctl: PanelController, *, grace_s: int = 120, **start) -> PanelView:
    ctl.start(URL, **start)
    return deliver(ctl, Connected(1), Received(1, created(grace_s=grace_s)))


def sent(connection: int) -> list[dict]:
    return [m for c, m in FakeTransport.made[-1].sent if c == connection]


def resume_id(connection: int) -> str:
    [message] = [m for m in sent(connection) if m["type"] == "session.resume"]
    return message["id"]


def up_to_date(connection: int, **kw) -> dict:
    """``session.resumed`` for a session that has published nothing yet."""
    return resumed(resume_id(connection), scene_version=0, snapshot_version=None, **kw)


# --------------------------------------------------------------------------- the drop and the resume


def test_panel_resume_drop_keeps_the_code(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live_view = live(ctl)
    view = deliver(ctl, Disconnected(1, NETWORK, 0.6))
    assert ctl.phase is Phase.RECONNECTING
    assert view.status == "Connection lost — reconnecting in 1 s."
    assert (view.code, view.link) == (CODE, live_view.link)
    assert view.detail == f"{NETWORK.guidance}\n{panel.RECONNECT_DETAIL}"
    assert view.stop_enabled and not (view.start_enabled or view.settings_enabled)
    assert fake.made[0].stops == [] and ctl.active
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_keeps_the_extra_ca_note(fake, clocks):
    """T5: the extra trust anchor stays named while the transport reconnects with it."""
    ctl = controller(clocks)
    live(ctl, extra_ca_file="/etc/hospital-root.pem")
    view = deliver(ctl, Disconnected(1, None, 0.6))
    assert view.detail == f"{panel.EXTRA_CA_IN_USE}\n{panel.RECONNECT_DETAIL}"


def test_panel_resume_sends_session_resume_on_connected(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    view = deliver(ctl, Connected(2))
    [message] = sent(2)  # the first frame on the new connection, and no session.create
    assert message["type"] == "session.resume"
    assert (message["sessionId"], message["publisherToken"]) == (SESSION_ID, TOKEN)
    assert message["lastSceneVersion"] == 0
    assert schemas.validate_message(message, None, schemas.compile_schemas()) == []
    assert (view.status, view.code) == (panel.RECONNECTING, CODE)
    assert view.detail == panel.RECONNECT_DETAIL  # connected: the failure's guidance is past
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_resumed_returns_to_live(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    view = deliver(ctl, Received(2, up_to_date(2, viewer_count=2)))
    assert ctl.phase is Phase.LIVE
    assert (view.status, view.detail, view.code) == (panel.viewers_text(2), "", CODE)
    clocks.advance(10_000)  # back live: no window and no answer deadline any more
    assert ctl.pump().code == CODE and fake.made[0].stops == []
    view = deliver(ctl, Disconnected(2, NETWORK, 1.5))  # a new outage starts afresh
    assert ctl.phase is Phase.RECONNECTING and view.status.startswith("Connection lost")
    clocks.advance(180)
    ctl.pump()
    view = deliver(ctl, Disconnected(None, None, None))
    assert view.detail == panel.RECONNECT_GAVE_UP  # the last outage's resume is forgotten
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_ignores_frames_of_the_old_connection(fake, clocks):
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    answer = up_to_date(2)
    deliver(ctl, Received(1, answer))  # a frame of connection 1 that arrives late
    assert ctl.phase is Phase.RECONNECTING
    deliver(ctl, Received(2, answer))
    assert ctl.phase is Phase.LIVE


def test_panel_resume_restart_says_the_relay_restarts(fake, clocks):
    """§9.3: after a 4008 the relay keeps no session, so the code is not promised to stay (T4, SLC-38)."""
    ctl = controller(clocks)
    live(ctl)
    view = deliver(ctl, Disconnected(1, RESTART, 0.0))
    assert view.status == "The relay is restarting — reconnecting in 1 s."
    assert panel.RECONNECT_DETAIL not in view.detail and view.code == CODE


def test_panel_resume_restart_is_sticky_for_the_outage(fake, clocks):
    """A refused retry after the 4008 does not turn the status back into a plain lost connection; back live, a new
    outage starts plain."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, RESTART, 0.0))
    refused = TransportError(ErrorKind.REFUSED, retryable=True)
    view = deliver(ctl, Disconnected(None, refused, 0.6))
    assert view.status == "The relay is restarting — reconnecting in 1 s."
    assert view.detail == refused.guidance
    deliver(ctl, Connected(2))
    deliver(ctl, Received(2, up_to_date(2)))
    view = deliver(ctl, Disconnected(2, NETWORK, 1.5))
    assert view.status == "Connection lost — reconnecting in 2 s."


def test_panel_resume_detail_names_only_the_latest_failure(fake, clocks):
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    refused = TransportError(ErrorKind.REFUSED, retryable=True)
    view = deliver(ctl, Disconnected(None, refused, 1.2))
    assert view.detail == f"{refused.guidance}\n{panel.RECONNECT_DETAIL}"
    view = deliver(ctl, Disconnected(None, None, 2.4))
    assert view.detail == panel.RECONNECT_DETAIL


@pytest.mark.parametrize("grace_s", [120, 5000])
def test_panel_resume_restart_ends_with_its_session(fake, clocks, grace_s):
    """A session that ended during a 4008 outage says nothing about the relay still holding it (a restarted relay
    keeps none, §13 step 9, however long its grace), and leaves no restart status for the next session's drop."""
    ctl = controller(clocks)
    live(ctl, grace_s=grace_s)
    deliver(ctl, Disconnected(1, RESTART, 0.0))
    clocks.advance(min(grace_s, 600) + 60)
    ctl.pump()
    view = deliver(ctl, Disconnected(None, None, None))
    assert view.detail == panel.RECONNECT_GAVE_UP
    live(ctl)
    view = deliver(ctl, Disconnected(1, NETWORK, 0.6))
    assert view.status == "Connection lost — reconnecting in 1 s."
    assert view.detail == f"{NETWORK.guidance}\n{panel.RECONNECT_DETAIL}"


def test_panel_resume_scene_version_left_by_the_relay_ends_the_session(fake, clocks, caplog, capfd):
    """§8.4: a relay whose ``sceneVersion`` leaves no version for the next snapshot is not believed."""
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    last = resumed(resume_id(2), scene_version=2**32 - 1, snapshot_version=None)
    deliver(ctl, Received(2, last))
    [(final, timeout)] = fake.made[0].stops
    assert (final["type"], timeout) == ("session.close", 0)  # frees the code at once (§4.5)
    view = deliver(ctl, Disconnected(2, None, None, final_sent=True))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.PROTOCOL_VIOLATION)
    assert leaks(caplog, capfd, *SECRETS) == []


# --------------------------------------------------------------------------- the relay refuses or does not answer


@pytest.mark.parametrize("how", ["error", "close-4003"])
def test_panel_resume_unauthorized_ends_with_session_lost(fake, clocks, caplog, capfd, how):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    if how == "error":
        deliver(ctl, Received(2, relay_error("UNAUTHORIZED", resume_id(2))))
        view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
    else:
        closed = TransportError(ErrorKind.CLOSED, retryable=False, close_code=4003)
        view = deliver(ctl, Disconnected(2, closed, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.SESSION_LOST)
    assert [m["type"] for m in sent(2)] == ["session.resume"]  # no session.close
    assert not ctl.active and ctl.phase is Phase.IDLE
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_session_not_found_ends_the_session(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    deliver(ctl, Received(2, relay_error("SESSION_NOT_FOUND", resume_id(2))))
    assert [m["type"] for m in sent(2)] == ["session.resume"]  # no session.create either (SLC-38)
    view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.SESSION_GONE_OFFLINE)
    assert leaks(caplog, capfd, *SECRETS) == []


@pytest.mark.parametrize("final_sent", [True, False])
def test_panel_resume_unanswered_ends_the_session(fake, clocks, caplog, capfd, final_sent):
    """15 s without ``session.resumed``: the session is closed; when that close is lost, the relay may still hold
    the session, and the panel says so."""
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    clocks.advance(14.9)
    assert ctl.pump().status == panel.RECONNECTING
    clocks.advance(0.1)
    ctl.pump()
    [(final, timeout)] = fake.made[0].stops
    assert (final["type"], timeout) == ("session.close", 0)  # resuming: the socket can carry it
    view = deliver(ctl, Disconnected(2, None, None, final_sent=final_sent))
    expected = panel.RESUME_NO_ANSWER
    if not final_sent:
        expected = f"{expected}\n{panel.RELAY_HOLDS_SESSION}"
    assert (view.status, view.detail) == (panel.SESSION_ENDED, expected)
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_expired_racing_the_resume(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    expired = envelope.make("session.expired", sessionId=SESSION_ID, reason="PUBLISHER_GONE")
    deliver(ctl, Received(2, expired))
    view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.END_REASONS["PUBLISHER_GONE"])
    assert leaks(caplog, capfd, *SECRETS) == []


# --------------------------------------------------------------------------- the reconnect window (T1)


@pytest.mark.usefixtures("fake")
@pytest.mark.parametrize(
    ("grace_s", "window"), [(120, 180.0), (30, 90.0), (600, 660.0), (601, 660.0), (5000, 660.0)]
)
def test_panel_resume_gives_up_after_the_window(clocks, caplog, capfd, grace_s, window):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl, grace_s=grace_s)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    clocks.advance(window / 2)
    deliver(ctl, Disconnected(None, NETWORK, 4.0))  # a failed attempt does not move the window
    clocks.advance(window / 2 - 0.1)
    assert ctl.pump().status.startswith("Connection lost") and ctl.phase is Phase.RECONNECTING
    clocks.advance(0.1)
    ctl.pump()
    assert ctl.phase is Phase.STOPPING
    assert FakeTransport.made[0].stops == [(None, 0)]  # nothing sent (T1)
    assert "panel: reconnect window over" in caplog.text
    view = deliver(ctl, Disconnected(None, None, None))
    expected = panel.RECONNECT_GAVE_UP
    if grace_s > panel.MAX_GRACE_S:  # the relay keeps the session past the window
        expected = f"{expected}\n{panel.RELAY_HOLDS_SESSION_LONGER}"
    assert (view.status, view.detail) == (panel.SESSION_ENDED, expected)
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_window_is_checked_before_a_resume_is_sent(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    clocks.advance(180)  # no pump in between: the Connected comes first
    deliver(ctl, Connected(2))
    assert sent(2) == [] and ctl.phase is Phase.STOPPING
    view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.RECONNECT_GAVE_UP)
    assert leaks(caplog, capfd, *SECRETS) == []


@pytest.mark.usefixtures("fake")
@pytest.mark.parametrize(
    ("outage", "detail"),
    [
        ((NETWORK, 120), GAVE_UP_HELD),  # a relay that took the resume holds the session again
        ((NETWORK, 5000), GAVE_UP_LONGER),  # one that keeps sessions longer says that instead
        # a restarted relay keeps no session (§13 step 9)
        ((RESTART, 120), panel.RECONNECT_GAVE_UP),
        ((RESTART, 5000), panel.RECONNECT_GAVE_UP),
    ],
)
def test_panel_resume_gives_up_after_a_resume_went_out(clocks, caplog, capfd, outage, detail):
    """A resume that went out just inside the window, and its socket lost before the answer: if the relay took it,
    its grace starts again, so past the panel's window anyone with the code may still see the scene."""
    caplog.set_level(logging.DEBUG)
    drop, grace_s = outage
    window = min(grace_s, 600) + 60
    ctl = controller(clocks)
    live(ctl, grace_s=grace_s)
    deliver(ctl, Disconnected(1, drop, 0.6))
    clocks.advance(window - 10)
    deliver(ctl, Connected(2))
    assert [m["type"] for m in sent(2)] == ["session.resume"]
    clocks.advance(1)
    deliver(ctl, Disconnected(2, NETWORK, 0.6))  # the answer is lost with the socket
    clocks.advance(9)
    ctl.pump()
    assert ctl.phase is Phase.STOPPING
    assert FakeTransport.made[0].stops == [(None, 0)]  # nothing sent (T1)
    view = deliver(ctl, Disconnected(None, None, None))
    assert view.detail == detail
    assert leaks(caplog, capfd, *SECRETS) == []


@pytest.mark.usefixtures("fake")
@pytest.mark.parametrize(
    ("moved", "detail"),
    [
        # (monotonic, wall) seconds after the drop. A sleep: the relay ended the session long ago
        ((0, 3600), panel.RECONNECT_GAVE_UP),
        ((0, -61), GAVE_UP_HELD),  # a clock reset: less time passed than the window
        ((150, -61), GAVE_UP_HELD),
        ((179.5, -61), GAVE_UP_HELD),
        ((180, -61), panel.RECONNECT_GAVE_UP),  # ... unless the monotonic clock shows it passed
        ((180, 125), panel.RECONNECT_GAVE_UP),  # a correction of -55 s does not stretch the window
        ((0, -60), None),
        ((0, -30), None),
    ],
)
def test_panel_resume_sleep_is_seen_on_the_wall_clock(clocks, caplog, capfd, moved, detail):
    """A computer that slept did not advance the monotonic clock; the wall clock shows the time that passed. A
    backward step of more than 60 s (a clock reset) counts as over too; an NTP correction neither ends the window nor
    stretches it."""
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    clocks.mono += moved[0]
    clocks.wall += moved[1]
    deliver(ctl, Connected(2))
    if detail is None:
        assert [m["type"] for m in sent(2)] == ["session.resume"]
    else:
        assert sent(2) == [] and ctl.phase is Phase.STOPPING
        view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
        assert (view.status, view.detail) == (panel.SESSION_ENDED, detail)
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_after_a_restart_a_clock_reset_warns_nothing(fake, clocks):
    """A window ended by a clock reset in a 4008 outage says nothing about the relay holding the session either."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, RESTART, 0.0))
    clocks.wall -= 61
    deliver(ctl, Connected(2))
    assert sent(2) == [] and ctl.phase is Phase.STOPPING
    view = deliver(ctl, Disconnected(2, None, None, final_sent=False))
    assert view.detail == panel.RECONNECT_GAVE_UP


@pytest.mark.usefixtures("fake")
@pytest.mark.parametrize(
    ("grace_s", "connected"), [(120, False), (120, True), (600, False), (600, True)]
)
def test_panel_resume_sleep_while_live_ends_the_session_at_the_wake(
    clocks, caplog, capfd, grace_s, connected
):
    """SLC-41: a computer that slept while Live. The transport reports the drop after the wake, dated before it:
    the window is over at once, and nothing is sent, not even on a connection made in the same tick (T1)."""
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl, grace_s=grace_s)
    # the heartbeat would have noticed 20 s in, had the computer not slept for 3 h
    lost_at = clocks.wall + 20
    clocks.mono += 25  # the monotonic clock stopped during the sleep
    clocks.wall += 3 * 3600 + 25
    deliver(ctl, Disconnected(1, HEARTBEAT, 0.6, lost_at=lost_at), *[Connected(2)] * connected)
    assert ctl.phase is Phase.STOPPING and sent(2) == []
    assert FakeTransport.made[0].stops == [(None, 0)]  # nothing sent (T1)
    view = deliver(ctl, Disconnected(None, None, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.RECONNECT_GAVE_UP)
    assert leaks(caplog, capfd, *SECRETS) == []


@pytest.mark.parametrize(
    ("dated", "moved", "over"),
    [
        # dated: the loss, from now (a busy main thread handles the drop late); moved: (monotonic, wall) seconds after
        (-20.0, (159.9, 159.9), False),
        (-20.0, (160.0, 160.0), True),
        # the wall clock corrected back: the monotonic clock runs from the loss too
        (-20.0, (160.0, 100.0), True),
        # a sleep in the outage: the wall clock runs from the loss too
        (-20.0, (100.0, 160.0), True),
        (0.0, (179.9, 179.9), False),
        # dated after now (the wall clock went back meanwhile): from now
        (30.0, (179.9, 179.9), False),
        (30.0, (180.0, 180.0), True),
    ],
)
def test_panel_resume_window_runs_from_the_transports_loss(fake, clocks, dated, moved, over):
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6, lost_at=clocks.wall + dated))
    clocks.mono += moved[0]
    clocks.wall += moved[1]
    ctl.pump()
    assert ctl.phase is (Phase.STOPPING if over else Phase.RECONNECTING)


@pytest.mark.parametrize(("step", "over"), [(-61.0, True), (-60.0, False)])
def test_panel_resume_a_dated_loss_keeps_the_backward_step_tolerance(fake, clocks, step, over):
    """A wall clock that goes back is measured from when the panel handled the drop, not from the dated loss: more
    than 60 s back ends the window, as without the dating."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6, lost_at=clocks.wall - 100))
    clocks.wall += step
    ctl.pump()
    assert ctl.phase is (Phase.STOPPING if over else Phase.RECONNECTING)
    if over:  # 100 s of a 180 s window: the relay may still hold the session, and the text says so
        assert deliver(ctl, Disconnected(None, None, None)).detail == GAVE_UP_HELD


def test_panel_resume_a_later_drop_keeps_the_backward_step_anchor(fake, clocks):
    """A failed attempt after the wall clock went back does not move the point the step is measured from."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    clocks.wall -= 61
    deliver(ctl, Disconnected(None, NETWORK, 4.0))
    assert ctl.phase is Phase.STOPPING


def test_panel_resume_only_the_first_drop_dates_the_outage(fake, clocks):
    """A resume's connection lost later does not move the window, however its loss is dated."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    deliver(ctl, Disconnected(2, NETWORK, 0.6, lost_at=clocks.wall - 3600))
    clocks.advance(179.9)
    ctl.pump()
    assert ctl.phase is Phase.RECONNECTING
    clocks.advance(0.1)
    ctl.pump()
    assert ctl.phase is Phase.STOPPING


def test_panel_resume_window_waits_while_a_socket_is_open(fake, clocks):
    """Once a resume is on its way, the answer deadline governs: one sent just inside the window gets its 15 s."""
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    clocks.advance(170)
    deliver(ctl, Connected(2))
    clocks.advance(11)  # past the window, inside the answer deadline
    assert ctl.pump().status == panel.RECONNECTING
    deliver(ctl, Received(2, up_to_date(2)))
    assert ctl.phase is Phase.LIVE


# --------------------------------------------------------------------------- Stop, a second drop, the transport's end


@pytest.mark.usefixtures("fake")
@pytest.mark.parametrize(
    ("when", "final_sent"), [("offline", False), ("resuming", True), ("resuming", False)]
)
def test_panel_resume_stop(clocks, caplog, capfd, when, final_sent):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    if when == "resuming":
        deliver(ctl, Connected(2))
    ctl.stop()
    [(final, timeout)] = FakeTransport.made[0].stops
    assert timeout == 0
    if when == "offline":
        assert final is None  # no socket: the relay ends the session after its grace
        view = deliver(ctl, Disconnected(None, None, None))
        assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.STOPPED_OFFLINE)
    else:
        assert final["type"] == "session.close"  # frees the code at once (§4.5)
        view = deliver(ctl, Disconnected(2, None, None, final_sent=final_sent))
        if final_sent:
            assert view == PanelView(panel.NOT_CONNECTED)
        else:  # the relay may still hold the session
            assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.FINAL_NOT_SENT)
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_drop_queued_behind_stop_keeps_stopping(fake, clocks):
    """A drop the transport reported just before it took the Stop brings no reconnect status back."""
    ctl = controller(clocks)
    live(ctl)
    ctl.stop()
    view = deliver(ctl, Disconnected(1, NETWORK, 0.6))
    assert ctl.phase is Phase.STOPPING and view.status == panel.STOPPING


def test_panel_resume_second_drop_while_resuming_keeps_reconnecting(fake, clocks):
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    view = deliver(ctl, Disconnected(2, NETWORK, 2.4))
    assert (
        ctl.phase is Phase.RECONNECTING and view.status == "Connection lost — reconnecting in 3 s."
    )
    clocks.advance(15)  # the first resume's answer deadline left with its socket
    ctl.pump()
    assert ctl.phase is Phase.RECONNECTING
    deliver(ctl, Connected(3))
    assert [m["type"] for m in sent(3)] == ["session.resume"]


def test_panel_resume_transport_gives_up_while_reconnecting(fake, clocks, caplog, capfd):
    """The transport stops for good (here a certificate the system no longer trusts) while the relay still holds the
    session: the panel says why, and that the session is not over on the relay yet."""
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    error = TlsError(ErrorKind.TLS_CERTIFICATE, retryable=False, verify_code=20)
    view = deliver(ctl, Disconnected(None, error, None))
    assert view.status == panel.SESSION_ENDED
    assert view.detail == f"{error.guidance}\n{panel.RELAY_HOLDS_SESSION}"
    assert leaks(caplog, capfd, *SECRETS) == []


def test_panel_resume_shutdown_while_reconnecting(fake, clocks, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clocks)
    live(ctl)
    deliver(ctl, Disconnected(1, NETWORK, 0.6))
    assert ctl.shutdown(timeout=0) is True
    assert fake.made[0].stops == [(None, 0), (None, 0)]  # no socket: nothing to send
    assert ctl.phase is Phase.IDLE and ctl.view == PanelView(panel.NOT_CONNECTED)
    assert leaks(caplog, capfd, *SECRETS) == []
