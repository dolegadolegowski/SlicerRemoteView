"""SLC-47: the panel renews an idle session only for someone at the computer (docs/protocol.md §4.4; NFR-11, T1).

60 s before the relay's idle TTL ends a session no viewer is connected to, it sends ``session.expiring``. The panel
answers ``session.renew`` by itself once per Start, and only when a panel button was used within
``ACTIVITY_WINDOW_S``; otherwise — and after that once — it says so and shows *Keep session*. Scene flushes and
reconnects are not activity. The clocks are moved by hand.
"""

from __future__ import annotations

import logging
import sys

import pytest
from support import (
    CODE,
    OTHER_SESSION_ID,
    OTHER_TOKEN,
    SESSION_ID,
    TOKEN,
    URL,
    FakeTransport,
    created,
    deliver,
    leaks,
    relay_error,
    resumed,
    ttl,
    viewer_count,
)

from remoteview_core import panel
from remoteview_core.panel import PanelController, PanelView, Phase
from remoteview_core.transport import Connected, Disconnected, ErrorKind, Received, TransportError
from remoteview_protocol import envelope, schemas

NETWORK = TransportError(ErrorKind.NETWORK, retryable=True)
RESTART = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4008)
#: A session nobody has joined for 29 minutes: the relay's idle TTL (1800 s) ends it 60 s later.
IDLE_S = 1740.0
#: ``closesAt`` of a warning, and of a later one (another idle period).
CLOSES_AT, LATER = 1_800_001_800_000, 1_800_003_600_000


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> Clock:
    return Clock()


def controller(clock: Clock) -> PanelController:
    return PanelController(
        slicer_version="5.12.4",
        platform=sys.platform,
        transport_factory=FakeTransport,
        clock=lambda: clock.now,
        wall=lambda: 1_800_000_000.0 + clock.now,
    )


def live(ctl: PanelController) -> PanelView:
    ctl.start(URL)
    return deliver(ctl, Connected(1), Received(1, created()))


def expiring(connection: int = 1, **fields) -> Received:
    return Received(
        connection,
        envelope.make("session.expiring", **{"reason": "IDLE", "closesAt": CLOSES_AT, **fields}),
    )


def sent(connection: int = 1) -> list[dict]:
    return [m for c, m in FakeTransport.made[-1].sent if c == connection]


def renews(connection: int = 1) -> list[dict]:
    return [m for m in sent(connection) if m["type"] == "session.renew"]


def renewed(connection: int = 1) -> Received:
    [renew] = renews(connection)
    return Received(connection, envelope.make("session.renewed", reply_to=renew["id"], ttl=ttl()))


def offered(view: PanelView) -> bool:
    """*Keep session* and its text are shown together."""
    assert view.keep_shown == (panel.KEEP_SESSION in view.detail)
    return view.keep_shown


def test_panel_renew_after_a_recent_click_answers_by_itself(fake, clock, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S - 100)
    ctl.note_activity()  # e.g. Copy link
    clock.advance(100)
    view = deliver(ctl, expiring())
    [renew] = renews()
    assert schemas.validate_message(renew, None, schemas.compile_schemas()) == []
    assert not offered(view) and view.status.startswith("Session running")
    assert not offered(deliver(ctl, renewed()))
    assert leaks(caplog, capfd, CODE, TOKEN, SESSION_ID) == []


@pytest.mark.parametrize(
    ("since", "renewed_by_itself"), [(panel.ACTIVITY_WINDOW_S, True), (300.5, False)]
)
def test_panel_renew_start_is_activity_for_five_minutes(fake, clock, since, renewed_by_itself):
    """A relay with a short idle TTL: the click on Start is the last activity."""
    ctl = controller(clock)
    live(ctl)
    clock.advance(since)
    view = deliver(ctl, expiring())
    assert bool(renews()) is renewed_by_itself
    assert offered(view) is not renewed_by_itself


def test_panel_renew_flushes_and_reconnects_are_not_activity(fake, clock):
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S)
    ctl.flush_live()  # the flush timer, not a person
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    [resume] = [m for m in sent(2) if m["type"] == "session.resume"]
    deliver(ctl, Received(2, resumed(resume["id"], scene_version=0, snapshot_version=None)))
    for _ in range(3):
        ctl.pump()
    view = deliver(ctl, expiring(2))
    assert renews(2) == []
    assert offered(view) and view.status.startswith("Session running") and view.code == CODE
    assert view.detail == panel.KEEP_SESSION


def test_panel_renew_only_once_by_itself(fake, clock):
    ctl = controller(clock)
    live(ctl)
    clock.advance(60)
    deliver(ctl, expiring())
    assert len(renews()) == 1
    deliver(ctl, renewed())
    clock.advance(60)
    ctl.note_activity()  # recent again, but the one automatic renewal is spent
    view = deliver(ctl, expiring(closesAt=LATER))
    assert len(renews()) == 1 and offered(view)
    # a warning the panel did not renew does not give the automatic renewal back
    deliver(ctl, Received(1, viewer_count(1)), Received(1, viewer_count(0)))
    clock.advance(60)
    ctl.note_activity()
    view = deliver(ctl, expiring(closesAt=LATER + 120_000))
    assert len(renews()) == 1 and offered(view)


def test_panel_renew_keep_session_renews_and_renewed_clears_it(fake, clock, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S)
    assert offered(deliver(ctl, expiring()))
    view = ctl.keep()
    [renew] = renews()
    assert schemas.validate_message(renew, None, schemas.compile_schemas()) == []
    assert not offered(view)  # on its way: no second click
    assert not offered(ctl.keep()) and len(renews()) == 1
    assert not offered(deliver(ctl, renewed()))
    # the click was activity: a later expiring within five minutes is renewed by the panel
    clock.advance(60)
    deliver(ctl, expiring(closesAt=LATER))
    assert len(renews()) == 2
    assert leaks(caplog, capfd, CODE, TOKEN, SESSION_ID) == []


def test_panel_renew_keep_sends_nothing_unless_offered(fake, clock):
    ctl = controller(clock)
    assert ctl.keep().keep_shown is False  # idle
    ctl.start(URL)
    ctl.keep()  # connecting
    deliver(ctl, Connected(1), Received(1, created()))
    ctl.keep()  # live, nothing said
    clock.advance(IDLE_S)
    deliver(ctl, expiring())
    view = deliver(ctl, Disconnected(1, NETWORK, 0.6))
    assert ctl.phase is Phase.RECONNECTING and not view.keep_shown
    ctl.keep()  # no socket while reconnecting
    assert [m["type"] for _, m in FakeTransport.made[-1].sent] == ["session.create"]


def test_panel_renew_a_viewer_ends_the_offer(fake, clock):
    """The idle timer runs only while no viewer is connected (§4.4); the relay warns again before a later expiry."""
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S)
    deliver(ctl, expiring())
    assert not offered(deliver(ctl, Received(1, viewer_count(1))))
    assert not offered(deliver(ctl, Received(1, viewer_count(0))))
    assert renews() == []


def test_panel_renew_lost_with_the_connection_is_offered_again(fake, clock):
    ctl = controller(clock)
    live(ctl)
    clock.advance(60)
    deliver(ctl, expiring())  # renewed by the panel (Start was a minute ago)
    assert len(renews()) == 1
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    [resume] = [m for m in sent(2) if m["type"] == "session.resume"]
    view = deliver(ctl, Received(2, resumed(resume["id"], scene_version=0, snapshot_version=None)))
    # its answer never came: the relay may still end the session
    assert offered(view) and renews(2) == []
    ctl.keep()
    assert len(renews(2)) == 1


@pytest.mark.parametrize("by", ["keep", "itself"])
@pytest.mark.parametrize("answer", ["none", "refused"])
def test_panel_renew_unanswered_is_offered_again(fake, clock, by, answer):
    """A renew the relay never answers — its frame discarded with a snapshot's, or refused — leaves the session to end:
    after RENEW_TIMEOUT_S *Keep session* is back, and a click sends another renew."""
    ctl = controller(clock)
    live(ctl)
    clock.advance(60 if by == "itself" else IDLE_S)
    view = deliver(ctl, expiring())
    if by == "keep":
        assert offered(view)
        view = ctl.keep()
    [renew] = renews()
    assert not offered(view)
    if answer == "refused":
        view = deliver(ctl, Received(1, relay_error("INVALID_MESSAGE", renew["id"])))
        assert ctl.phase is Phase.LIVE and not offered(view)
    clock.advance(panel.RENEW_TIMEOUT_S - 0.5)
    assert not offered(ctl.pump())
    clock.advance(0.5)
    assert offered(ctl.pump())
    ctl.keep()
    assert len(renews()) == 2 and not offered(ctl.pump())
    assert not offered(
        deliver(
            ctl,
            Received(1, envelope.make("session.renewed", reply_to=renews()[-1]["id"], ttl=ttl())),
        )
    )


@pytest.mark.parametrize("before", ["renewed by itself", "lost offline"])
def test_panel_renew_the_warning_repeated_after_a_resume_is_the_same_warning(fake, clock, before):
    """The relay repeats an outstanding warning right after ``session.resumed``, with the same ``closesAt`` (SRV-15;
    reports ``2026-10-27-server-4`` item 5, ``2026-10-29-slicer-1`` item 2). It is the same warning: after a recent
    click the panel renews it — again, when its automatic renewal was lost with the connection; a later warning (a new
    ``closesAt``) gets the offer."""
    ctl = controller(clock)
    live(ctl)
    if before == "renewed by itself":
        clock.advance(60)
        deliver(ctl, expiring())  # its renew is lost with the connection
        assert len(renews()) == 1
    else:
        clock.advance(IDLE_S)  # the warning falls due while offline
    deliver(ctl, Disconnected(1, NETWORK, 0.6), Connected(2))
    [resume] = [m for m in sent(2) if m["type"] == "session.resume"]
    deliver(ctl, Received(2, resumed(resume["id"], scene_version=0, snapshot_version=None)))
    ctl.note_activity()
    view = deliver(ctl, expiring(2))
    assert not offered(view) and len(renews(2)) == 1
    deliver(ctl, renewed(2))
    clock.advance(60)
    ctl.note_activity()
    view = deliver(ctl, expiring(2, closesAt=LATER))
    assert offered(view) and len(renews(2)) == 1
    # the repeat of a warning that was offered is offered again: no second automatic renewal in one Start
    deliver(ctl, Disconnected(2, NETWORK, 0.6), Connected(3))
    [resume] = [m for m in sent(3) if m["type"] == "session.resume"]
    deliver(ctl, Received(3, resumed(resume["id"], scene_version=0, snapshot_version=None)))
    ctl.note_activity()
    view = deliver(ctl, expiring(3, closesAt=LATER))
    assert offered(view) and renews(3) == []


def test_panel_renew_a_resume_with_viewers_ends_the_offer(fake, clock):
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S)
    deliver(ctl, expiring(), Disconnected(1, NETWORK, 0.6), Connected(2))
    [resume] = [m for m in sent(2) if m["type"] == "session.resume"]
    reply = resumed(resume["id"], scene_version=0, snapshot_version=None, viewer_count=1)
    assert not offered(deliver(ctl, Received(2, reply)))


@pytest.mark.parametrize(
    "fields",
    [
        {"closesAt": "soon"},
        {"closesAt": -1},
        {"closesAt": True},
        {"reason": "idle"},
        {"reason": None},
    ],
)
def test_panel_renew_an_invalid_expiring_is_ignored(fake, clock, fields, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    ctl = controller(clock)
    live(ctl)
    clock.advance(10)  # recent: a valid one would be renewed
    view = deliver(ctl, expiring(**fields))
    assert renews() == [] and not offered(view)
    assert leaks(caplog, capfd, CODE, TOKEN, SESSION_ID) == []


def test_panel_renew_the_offer_ends_with_the_session(fake, clock):
    """NFR-11, T1: nobody keeps it, so the relay's idle TTL ends it."""
    ctl = controller(clock)
    live(ctl)
    clock.advance(IDLE_S)
    deliver(ctl, expiring())
    deliver(ctl, Received(1, envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")))
    view = deliver(ctl, Disconnected(1, None, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.END_REASONS["IDLE"])
    assert not view.keep_shown and renews() == []


def test_panel_renew_a_new_start_begins_afresh(fake, clock):
    ctl = controller(clock)
    live(ctl)
    clock.advance(60)
    deliver(ctl, expiring())  # the first Start's automatic renewal
    ctl.stop()
    deliver(ctl, Disconnected(1, None, None, final_sent=True))
    clock.advance(IDLE_S)
    live(ctl)
    clock.advance(60)
    view = deliver(ctl, expiring(closesAt=LATER))
    # the new Start's own one
    assert len(renews()) == 1 and not offered(view)


def test_panel_renew_a_session_created_again_after_a_restart_starts_without_the_offer(fake, clock):
    """SLC-45: the new session has its own idle timer; the automatic renewal stays spent (once per Start)."""
    ctl = controller(clock)
    live(ctl)
    clock.advance(60)
    deliver(ctl, expiring())  # renewed by the panel; its answer is lost with the connection
    assert len(renews()) == 1
    deliver(ctl, Disconnected(1, RESTART, 0.6), Connected(2))
    [resume] = [m for m in sent(2) if m["type"] == "session.resume"]
    deliver(ctl, Received(2, relay_error("SESSION_NOT_FOUND", resume["id"])))
    [create] = [m for m in sent(2) if m["type"] == "session.create"]
    reply = created(create["id"], session_id=OTHER_SESSION_ID, token=OTHER_TOKEN)
    view = deliver(ctl, Received(2, reply))
    # the old session's expiry is not the new one's
    assert ctl.phase is Phase.LIVE and not offered(view)
    ctl.note_activity()
    assert offered(deliver(ctl, expiring(2, closesAt=LATER))) and renews(2) == []
