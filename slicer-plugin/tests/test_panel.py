"""SLC-09: session panel — the pure PanelController, the .ui file and the Qt adapter against the stubs."""

from __future__ import annotations

import ast
import logging
import re
import sys
import time
import types
import xml.etree.ElementTree as ET
from dataclasses import replace

import pytest
from conftest import MODULE_DIR, ui_widget_names
from support import (
    CODE,
    SESSION_ID,
    TOKEN,
    URL,
    FakeTransport,
    created,
    deliver,
    needs_relay_stub,
    parent_widget,
    pump_while,
    relay_error,
    start_relay_stub,
    viewer_count,
)

from remoteview_core import panel
from remoteview_core.panel import PanelController, PanelView, Phase
from remoteview_core.protocol_client import TERMINAL_CLOSE_CODES
from remoteview_core.transport import (
    Connected,
    Disconnected,
    ErrorKind,
    Received,
    RelayTransport,
    TlsError,
    TransportError,
)
from remoteview_core.vendored import chunk_header  # noqa: F401 — registers the vendored protocol package
from remoteview_protocol import envelope, schemas

UI_FILE = MODULE_DIR / "Resources" / "UI" / "RemoteView.ui"

# --------------------------------------------------------------------------- the controller


def controller(clock=time.monotonic) -> PanelController:
    return PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport, clock=clock
    )


def live(ctl: PanelController) -> PanelView:
    ctl.start(URL)
    return deliver(ctl, Connected(1), Received(1, created()))


def view_text(view: PanelView) -> str:
    return " ".join((view.status, view.detail, view.code))


# --------------------------------------------------------------------------- controller (criterion 3)


def test_panel_start_creates_the_session_and_shows_the_code(fake):
    ctl = controller()
    view = ctl.start(f" {URL} ")
    transport = fake.made[0]
    assert transport.started and transport.url == URL and ctl.active
    assert view == PanelView(
        "Connecting to relay.example.org…",
        start_enabled=False,
        stop_enabled=True,
        settings_enabled=False,
    )
    view = deliver(ctl, Connected(1))
    [(connection, create)] = transport.sent
    assert connection == 1 and create["type"] == "session.create" and create["profile"] == "mobile"
    assert schemas.validate_message(create, None, schemas.compile_schemas()) == []
    assert view.status == panel.WAITING and view.code == ""
    view = deliver(ctl, Received(1, created(create["id"])))
    assert ctl.phase is Phase.LIVE
    assert view == PanelView(
        "Session running · no viewers yet.",
        code=CODE,
        link=f"https://relay.example.org/j#{CODE}",
        start_enabled=False,
        stop_enabled=True,
        settings_enabled=False,
    )
    assert deliver(ctl, Received(1, viewer_count(2))).status == "Session running · 2 viewers."
    assert deliver(ctl, Received(1, viewer_count(1))).status == "Session running · 1 viewer."


def test_panel_stop_sends_session_close_and_returns_to_idle(fake):
    ctl = controller()
    live(ctl)
    view = ctl.stop()
    [(final, timeout)] = fake.made[0].stops
    assert final["type"] == "session.close" and final["reason"] == "USER_STOPPED" and timeout == 0
    assert view == PanelView(
        panel.STOPPING, start_enabled=False, stop_enabled=False, settings_enabled=False
    )
    assert ctl.stop() is view and len(fake.made[0].stops) == 1  # a second click does nothing
    view = deliver(ctl, Disconnected(1, None, None, final_sent=True))
    assert view == PanelView(panel.NOT_CONNECTED) and not ctl.active and ctl.phase is Phase.IDLE


def test_panel_stop_says_when_the_relay_keeps_the_session(fake):
    ctl = controller()
    live(ctl)
    ctl.stop()
    view = deliver(ctl, Disconnected(1, None, None, final_sent=False))
    assert (
        view.status == panel.SESSION_ENDED
        and view.detail == panel.FINAL_NOT_SENT
        and view.start_enabled
    )


def test_panel_stop_while_waiting_for_the_relay(fake):
    ctl = controller()
    ctl.start(URL)
    deliver(ctl, Connected(1))  # session.create is on its way: the relay may create the session
    ctl.stop()
    [(final, _)] = fake.made[0].stops
    assert final["type"] == "session.close"
    view = deliver(ctl, Disconnected(1, None, None, final_sent=False))
    # the user stopped it: not "Cannot start the session."
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.FINAL_NOT_SENT)


def test_panel_relay_end_during_stop_is_not_reported_as_kept(fake):
    ctl = controller()
    live(ctl)
    ctl.stop()
    expired = envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")
    view = deliver(ctl, Received(1, expired), Disconnected(1, None, None, final_sent=False))
    assert view == PanelView(panel.NOT_CONNECTED)  # the relay ended it: nothing waits for 2 minutes


def test_panel_malformed_frame_during_stop_does_not_stall_the_pump(fake):
    ctl = controller()
    live(ctl)
    ctl.stop()
    malformed = Received(1, {"protocolVersion": "1.0", "type": ["session.expired"]})
    view = deliver(ctl, malformed, Disconnected(1, None, None, final_sent=True))
    assert view == PanelView(panel.NOT_CONNECTED) and not ctl.active  # same tick, no exception


def test_panel_never_logs_or_prints_the_code_or_token(fake, widget, caplog, capsys):
    """T4/T6, CLAUDE.md rule 6: the code is shown in its label only; the token never leaves the client."""
    caplog.set_level(logging.DEBUG)
    ctl = controller()
    live(ctl)
    deliver(ctl, Received(1, viewer_count(2)))
    ctl.stop()
    deliver(ctl, Disconnected(1, None, None, final_sent=False))
    live(ctl)
    error = envelope.make("error", code="UNAUTHORIZED", message="relay text " + CODE)
    deliver(ctl, Received(1, error), Disconnected(1, None, None, final_sent=True))
    _, instance = widget  # the adapter path
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    fake.made[-1].events.put(Connected(1))
    fake.made[-1].events.put(Received(1, created()))
    instance.onPump()
    assert instance.ui.codeLabel.text == CODE
    instance.onStopClicked()
    instance.cleanup()
    printed = capsys.readouterr()
    for text in (caplog.text, printed.out, printed.err, repr(ctl.view), repr(ctl)):
        assert CODE not in text and TOKEN not in text


@pytest.mark.parametrize(
    "message",
    [envelope.make("session.expired", sessionId="sess_OTHER0000000000", reason="IDLE"),  # T11
     {"type": "session.closed", "sessionId": SESSION_ID, "reason": "PUBLISHER_CLOSED"}],  # no envelope
)  # fmt: skip
def test_panel_only_its_own_valid_session_end_counts_during_stop(fake, message):
    ctl = controller()
    live(ctl)
    ctl.stop()
    view = deliver(ctl, Received(1, message), Disconnected(1, None, None, final_sent=False))
    assert view.detail == panel.FINAL_NOT_SENT


def test_panel_stop_before_the_connection_sends_nothing(fake):
    ctl = controller()
    ctl.start(URL)
    ctl.stop()
    assert fake.made[0].stops == [(None, 0)]  # no socket yet: no session.close to send
    assert deliver(ctl, Disconnected(None, None, None)) == PanelView(panel.NOT_CONNECTED)


@pytest.mark.parametrize(
    ("message", "status", "detail"),
    [
        (envelope.make("error", reply_to="p-1", code="RATE_LIMITED", message="<b>relay free text 1</b>",
                       retryable=True, details={"retryAfterS": 600}),
         panel.CANNOT_START, panel.END_REASONS["RATE_LIMITED"]),
        (envelope.make("error", reply_to="p-1", code="CAPACITY", message="relay free text 2"),
         panel.CANNOT_START, panel.END_REASONS["CAPACITY"]),
        (envelope.make("error", reply_to="p-1", code="SOMETHING_NEW", message="relay free text 3"),
         panel.CANNOT_START, "The relay ended the session (SOMETHING_NEW)."),
    ],
)  # fmt: skip
def test_panel_refused_create_shows_a_mapped_reason(fake, message, status, detail):
    ctl = controller()
    ctl.start(URL)
    deliver(ctl, Connected(1), Received(1, message))
    assert fake.made[0].stops == [(None, 0)] and ctl.phase is Phase.STOPPING
    # what the real transport emits in the same tick: the relay's close (with a retry the stop cancels), then the end
    rate_limited = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4006)
    view = deliver(ctl, Disconnected(1, rate_limited, 600.0), Disconnected(None, None, None))
    assert (view.status, view.detail) == (status, detail)
    assert message["message"] not in view_text(view)  # relay free text is never shown (§9.2)
    assert len(fake.made[0].stops) == 1 and not ctl.active


@pytest.mark.parametrize(
    ("message", "close_code", "detail", "sends_close"),
    [(envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"), 4002, panel.END_REASONS["IDLE"],
      False),
     (envelope.make("session.expired", sessionId=SESSION_ID, reason="PUBLISHER_GONE"), 4002,
      panel.END_REASONS["PUBLISHER_GONE"], False),
     (envelope.make("session.expired", sessionId=SESSION_ID, reason="MAX_LIFETIME"), 4002,
      panel.END_REASONS["MAX_LIFETIME"], False),
     (envelope.make("session.closed", sessionId=SESSION_ID, reason="PUBLISHER_CLOSED"), 4001,
      panel.END_REASONS["PUBLISHER_CLOSED"], False),
     # fatal errors (§9.2): the client closes; the relay may keep the socket and the session (§11), so the panel
     # sends session.close to free the code at once
     (envelope.make("error", code="UNAUTHORIZED", message="relay free text 4"), 4003,
      panel.END_REASONS["UNAUTHORIZED"], True),
     (envelope.make("error", code="SESSION_CLOSED", message="relay free text 5"), 4001,
      panel.END_REASONS["SESSION_CLOSED"], True)],
)  # fmt: skip
def test_panel_relay_ends_a_live_session(fake, message, close_code, detail, sends_close):
    ctl = controller()
    live(ctl)
    deliver(ctl, Received(1, message))
    assert ctl.phase is Phase.STOPPING and ctl.view.code == ""
    [(final, timeout)] = fake.made[0].stops
    assert timeout == 0
    if sends_close:
        assert final == {
            "protocolVersion": "1.0",
            "type": "session.close",
            "reason": "USER_STOPPED",
        }
        assert schemas.validate_message(final, None, schemas.compile_schemas()) == []
    else:
        assert final is None  # the relay ended it: nothing to close
    closed = TransportError(ErrorKind.CLOSED, retryable=False, close_code=close_code)
    view = deliver(ctl, Disconnected(1, closed, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, detail)
    assert message.get("message", "<none>") not in view_text(view)  # relay free text (§9.2)


def test_panel_does_not_renew_a_session_by_itself(fake):
    """NFR-11, T1: until release decides on renewal, a session nobody joins ends after the relay's idle TTL."""
    ctl = controller()
    live(ctl)
    deliver(
        ctl, Received(1, envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000))
    )
    assert [m["type"] for _, m in fake.made[0].sent] == ["session.create"]  # no session.renew
    deliver(ctl, Received(1, envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")))
    view = deliver(ctl, Disconnected(1, None, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.END_REASONS["IDLE"])


def test_panel_ignores_relay_messages_while_stopping(fake):
    ctl = controller()
    live(ctl)
    ctl.stop()
    view = deliver(ctl, Received(1, viewer_count(3)), Disconnected(1, None, None, final_sent=False))
    assert view.detail == panel.FINAL_NOT_SENT and len(fake.made[0].stops) == 1


def test_panel_close_before_the_session_exists_shows_guidance(fake):
    ctl = controller()
    ctl.start(URL)
    normal = TransportError(ErrorKind.CLOSED, retryable=False, close_code=1000)
    view = deliver(ctl, Connected(1), Disconnected(1, normal, None))
    assert (view.status, view.detail) == (panel.CANNOT_START, normal.guidance)


def test_panel_view_repr_hides_the_code(fake):
    ctl = controller()
    view = live(ctl)
    assert view.code == CODE and CODE not in repr(view)


def test_panel_transport_stop_shows_guidance(fake):
    ctl = controller()
    ctl.start(URL)
    error = TlsError(ErrorKind.TLS_CERTIFICATE, retryable=False, verify_code=20)
    view = deliver(ctl, Disconnected(None, error, None))
    assert (
        view.status == panel.CANNOT_START and view.detail == error.guidance and view.start_enabled
    )
    assert not ctl.active


def test_panel_terminal_close_of_a_live_session_shows_its_reason(fake):
    ctl = controller()
    live(ctl)
    replaced = TransportError(ErrorKind.CLOSED, retryable=False, close_code=4011)
    view = deliver(ctl, Disconnected(1, replaced, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.END_REASONS["REPLACED"])


def test_panel_retries_before_the_session_exists(fake):
    ctl = controller()
    ctl.start(URL)
    deliver(ctl, Connected(1))  # session.create sent, then the connection drops
    refused = TransportError(ErrorKind.REFUSED, retryable=True)
    view = deliver(ctl, Disconnected(1, refused, 1.2))
    assert view.status == "Relay unreachable — retrying in 2 s." and view.detail == refused.guidance
    assert view.stop_enabled and not view.start_enabled
    # a frame that arrives late on connection 1 is ignored, even one the new create would accept
    deliver(ctl, Connected(2), Received(1, created("p-2")))
    assert [(c, m["type"]) for c, m in fake.made[0].sent] == [
        (1, "session.create"),
        (2, "session.create"),
    ]
    assert ctl.phase is Phase.CONNECTING
    assert deliver(ctl, Received(2, created("p-2"))).code == CODE


def test_panel_gives_up_when_the_relay_does_not_answer(fake):
    now = [0.0]
    ctl = controller(clock=lambda: now[0])
    ctl.start(URL)
    deliver(ctl, Connected(1))
    now[0] = 14.9
    assert ctl.pump().status == panel.WAITING and fake.made[0].stops == []
    now[0] = 15.0
    ctl.pump()
    [(final, timeout)] = fake.made[0].stops
    assert final["type"] == "session.close" and timeout == 0 and ctl.phase is Phase.STOPPING
    # the panel stopped it, so a lost session.close does not replace why
    view = deliver(ctl, Disconnected(1, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.CANNOT_START, panel.NO_ANSWER)


def test_panel_answer_timeout_restarts_with_each_connection(fake):
    now = [0.0]
    ctl = controller(clock=lambda: now[0])
    ctl.start(URL)
    now[0] = 100.0  # before any connection nothing is awaited
    deliver(ctl, Connected(1))
    now[0] = 110.0
    deliver(ctl, Disconnected(1, TransportError(ErrorKind.NETWORK, retryable=True), 1.0))
    now[0] = 200.0  # no connection while the transport waits to retry
    assert ctl.pump().status.startswith("Relay unreachable")
    deliver(ctl, Connected(2))
    now[0] = 214.9
    assert deliver(ctl, Received(2, created("p-2"))).code == CODE
    now[0] = 10_000.0  # a live session has nothing to wait for
    assert ctl.pump().code == CODE and fake.made[0].stops == []


def test_panel_extra_ca_note_stays_while_it_is_in_use(fake):
    ctl = controller()
    view = ctl.start(URL, extra_ca_file="/etc/hospital-root.pem")
    assert (view.status, view.detail) == ("Connecting to relay.example.org…", panel.EXTRA_CA_IN_USE)
    assert deliver(ctl, Connected(1)).detail == panel.EXTRA_CA_IN_USE
    assert deliver(ctl, Received(1, created())).detail == panel.EXTRA_CA_IN_USE
    assert deliver(ctl, Received(1, viewer_count(2))).detail == panel.EXTRA_CA_IN_USE
    ctl.stop()
    assert deliver(ctl, Disconnected(1, None, None, final_sent=True)).detail == ""
    # a retry shows its guidance instead; plain ws:// (loopback, development) uses no TLS at all
    ctl.start(URL, extra_ca_file="/etc/hospital-root.pem")
    refused = TransportError(ErrorKind.REFUSED, retryable=True)
    assert deliver(ctl, Disconnected(None, refused, 1.0)).detail == refused.guidance
    ctl.stop()
    deliver(ctl, Disconnected(None, None, None))
    view = ctl.start("ws://127.0.0.1:8787/ws", extra_ca_file="/etc/hospital-root.pem")
    assert view.detail == ""


def test_panel_one_controller_runs_many_sessions(fake):
    """The adapter keeps one controller: every Start begins from a clean slate."""
    now = [0.0]
    ctl = controller(clock=lambda: now[0])
    live(ctl)  # 1: the relay ends it while our session.close is lost
    ctl.stop()
    expired = envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")
    assert deliver(ctl, Received(1, expired), Disconnected(1, None, None)) == PanelView(
        panel.NOT_CONNECTED
    )
    now[0] = 100.0  # long after session 1's answer deadline
    ctl.start(URL)  # 2: refused certificate, before any session existed
    assert ctl.pump().status.startswith("Connecting")
    error = TlsError(ErrorKind.TLS_CERTIFICATE, retryable=False, verify_code=20)
    view = deliver(ctl, Disconnected(None, error, None))
    assert (view.status, view.detail) == (panel.CANNOT_START, error.guidance)
    live(ctl)  # 3: the user stops and the stop message is lost
    ctl.stop()
    view = deliver(ctl, Disconnected(1, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.FINAL_NOT_SENT)
    view = live(ctl)  # 4: a drop ends it — the panel's own end, not a lost stop message
    assert view.code == CODE and view.detail == "" and len(fake.made) == 4
    deliver(ctl, Disconnected(1, TransportError(ErrorKind.NETWORK, retryable=True), 0.5))
    view = deliver(ctl, Disconnected(None, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.RESUME_LATER)


def test_panel_shutdown_reports_a_transport_that_did_not_end(fake):
    class Stuck(FakeTransport):
        def stop(self, final=None, *, timeout=3.0):
            super().stop(final, timeout=timeout)
            return False

    ctl = PanelController(slicer_version="5.12.4", platform="linux", transport_factory=Stuck)
    live(ctl)
    assert ctl.shutdown(timeout=3.0) is False and ctl.view == PanelView(panel.NOT_CONNECTED)


def test_panel_retry_text_never_says_zero_seconds(fake):
    ctl = controller()
    ctl.start(URL)
    restart = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4008)
    view = deliver(ctl, Connected(1), Disconnected(1, restart, 0.0))
    assert view.status == "Relay unreachable — retrying in 1 s."


def test_panel_drop_after_the_session_started_ends_it(fake):
    """No resume before SLC-37: the session ends instead of silently getting a new code."""
    ctl = controller()
    live(ctl)
    deliver(ctl, Disconnected(1, TransportError(ErrorKind.NETWORK, retryable=True), 0.5))
    assert fake.made[0].stops == [(None, 0)]  # in grace there is no socket for session.close
    view = deliver(ctl, Disconnected(None, None, None))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.RESUME_LATER)


def test_panel_binary_frame_from_the_relay_stops_the_session(fake):
    ctl = controller()
    live(ctl)
    deliver(ctl, Received(1, b"\x00" * 12))
    [(final, _)] = fake.made[0].stops
    assert final["type"] == "session.close"  # the session existed: tell the relay
    view = deliver(ctl, Disconnected(1, None, None, final_sent=True))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, panel.PROTOCOL_VIOLATION)


@pytest.mark.parametrize(
    ("url", "detail"),
    [("http://relay.example.org/ws", "relay URL must look like wss://<host>/ws"),
     ("wss://user:secret@relay.example.org/ws",
      "relay URL must not carry user info, a query or a fragment (no secrets in URLs, §3.1)"),
     ("", "relay URL must look like wss://<host>/ws")],
)  # fmt: skip
def test_panel_refused_address_starts_nothing(fake, url, detail):
    ctl = controller()
    view = ctl.start(url)
    assert fake.made == [] and not ctl.active and ctl.phase is Phase.IDLE
    assert (view.status, view.detail) == (panel.CANNOT_START, detail) and view.start_enabled
    assert "secret" not in view.detail.replace("secrets", "")


def test_panel_start_failures_have_fixed_texts(fake):
    def missing_ca(url, events, *, extra_ca_file=None):
        raise FileNotFoundError(2, "No such file", extra_ca_file)

    class NoWebsockets(FakeTransport):
        def start(self):
            raise ImportError("No module named 'websockets'")

    cases = [
        (PanelController(slicer_version="5.12.4", platform="linux", transport_factory=missing_ca),
         panel.CA_FILE_UNREADABLE),
        (PanelController(slicer_version="5.12.4", platform="linux", transport_factory=NoWebsockets),
         panel.WEBSOCKETS_MISSING),
        (PanelController(slicer_version="x" * 200, platform="linux", transport_factory=FakeTransport),
         panel.VERSION_UNUSABLE),
    ]  # fmt: skip
    for ctl, detail in cases:
        view = ctl.start(URL, extra_ca_file="/nowhere/ca.pem")
        assert (view.status, view.detail, ctl.active) == (panel.CANNOT_START, detail, False)


def test_panel_start_passes_the_ca_file_and_ignores_a_second_start(fake):
    ctl = controller()
    ctl.start(URL, extra_ca_file="/etc/hospital-root.pem")
    assert fake.made[0].extra_ca_file == "/etc/hospital-root.pem"
    ctl.start("wss://other.example.org/ws")
    assert len(fake.made) == 1  # already running: Start is disabled, a stray call changes nothing


def test_panel_shutdown_closes_and_waits(fake):
    ctl = controller()
    live(ctl)
    assert ctl.shutdown(timeout=3.0)
    [(final, first_timeout), (second_final, wait)] = fake.made[0].stops
    assert (
        final["type"] == "session.close"
        and first_timeout == 0
        and second_final is None
        and wait == 3.0
    )
    assert ctl.view == PanelView(panel.NOT_CONNECTED) and not ctl.active
    assert PanelController(slicer_version="5.12.4", platform="linux").shutdown()  # never started


def test_panel_shutdown_after_stop_only_waits(fake):
    """Stop's own stop() carried the session.close: cleanup only waits for the transport (no second close)."""
    ctl = controller()
    live(ctl)
    ctl.stop()
    assert ctl.shutdown(timeout=3.0)
    [(close, first), (second, wait)] = fake.made[0].stops
    assert (close["type"], first) == ("session.close", 0) and (second, wait) == (None, 3.0)


def test_panel_shutdown_sends_no_fallback_close_without_a_connection(fake, monkeypatch):
    """SLC-36: a plain ``session.close`` replaces a close that raised only on a socket the panel knows."""
    ctl = controller()
    ctl.start(URL)  # the transport has not connected yet

    def boom():
        raise RuntimeError("close failed")

    monkeypatch.setattr(ctl._client, "close", boom)
    with pytest.raises(RuntimeError):
        ctl.shutdown(timeout=3.0)
    assert fake.made[0].stops == [(None, 3.0)]
    assert ctl.phase is Phase.IDLE and not ctl.active


def test_panel_pump_handles_a_bounded_number_of_events(fake):
    ctl = controller()
    live(ctl)
    transport = fake.made[0]
    for n in range(150):
        transport.events.put(Received(1, viewer_count(n % 5)))
    ctl.pump()
    assert transport.events.qsize() == 50


def test_panel_texts_are_plain_and_complete():
    assert panel.end_text(None) == "" and panel.end_text("USER_STOPPED") == ""
    # every terminal close code (§9.3) and every §4.5 reason has its own text
    assert set(TERMINAL_CLOSE_CODES.values()) <= set(panel.END_REASONS)
    assert {"PUBLISHER_CLOSED", "PUBLISHER_GONE", "IDLE", "MAX_LIFETIME", "CAPACITY"} <= set(
        panel.END_REASONS
    )
    too_large = panel.scene_too_large_text(panel.SnapshotTooLargeError(3_000_000, 2_000_000))
    # SLC-32: shown while changes in Slicer are followed, these never ask to stop and start the session
    followed = [
        *panel.SCENE_STATES.values(),
        *panel.SCENE_REFUSED.values(),
        panel.SCENE_FAILED,
        panel.HIDE_MODELS,
        panel.RETRY_ON_CHANGE,
        panel.RETRY_LATER,
        panel.OBSERVE_FAILED,
        panel.WAITING_FOR_SLICER,
        panel.scene_refused_text("INTERNAL"),
        panel.scene_refused_text(None),
        too_large,
    ]
    unfollowed = [panel.HIDE_MODELS_AND_RESTART, panel.RESTART]
    texts = [*followed, *unfollowed]
    assert all(text and "<" not in text and ">" not in text for text in texts)
    assert [text for text in followed if "stop and start" in text.lower()] == []
    assert all("stop and start" in text.lower() for text in unfollowed)
    for reason, text in panel.END_REASONS.items():
        assert re.fullmatch(r"[A-Z][A-Z0-9_]*", reason)
        assert "<" not in text and ">" not in text
        assert (text == "") == (reason == "USER_STOPPED")  # every other end is explained
    assert panel.viewers_text(0) == "Session running · no viewers yet."
    # SLC-36: the reconnect texts (shown from SLC-37 on)
    reconnect = [
        panel.RECONNECTING_IN,
        panel.RESTARTING_IN,
        panel.RECONNECTING,
        panel.RELAY_HOLDS_SESSION,
        panel.RECONNECT_DETAIL,
        panel.RECONNECT_GAVE_UP,
        panel.SESSION_LOST,
        panel.SESSION_GONE_OFFLINE,
        panel.RESUME_NO_ANSWER,
        panel.STOPPED_OFFLINE,
        panel.RELAY_RESTARTED,
        panel.NEW_CODE,
        panel.SCENE_INTERRUPTED,
        panel.RESET_PENDING,
    ]
    assert len(set(reconnect)) == len(reconnect) and all(reconnect)
    assert [text for text in reconnect if "stop and start" in text.lower()] == []
    assert set(panel.RECONNECT_END_REASONS.values()) <= set(reconnect)
    # while the relay may keep the session they say who can still see the scene (the consent text's warning), for
    # "a few minutes", never a number
    assert panel.RELAY_HOLDS_SESSION.startswith("Anyone with the code can still see the last scene")
    for text in (
        panel.RELAY_HOLDS_SESSION,
        panel.RECONNECT_DETAIL,
        panel.STOPPED_OFFLINE,
        panel.RESET_PENDING,
        panel.SESSION_LOST,
    ):
        assert re.search(r"anyone with the code (can )?still sees?\b", text, re.IGNORECASE)
        assert "a few minutes" in text
    assert [text for text in reconnect if re.search(r"[0-9]", text)] == []
    # fixed texts: the only placeholder is the seconds of the two retry statuses
    assert [text for text in reconnect if "{" in text or "}" in text] == [
        panel.RECONNECTING_IN,
        panel.RESTARTING_IN,
    ]
    assert panel.SESSION_LOST.startswith("Session lost")
    assert "The old code may now belong to another session." in panel.NEW_CODE  # T4
    assert (
        "if it is still free" in panel.RELAY_RESTARTED
    )  # §4.1: preferredCode is granted only then
    for text in (
        panel.RECONNECT_GAVE_UP,
        panel.SESSION_LOST,
        panel.SESSION_GONE_OFFLINE,
        panel.RESUME_NO_ANSWER,
    ):
        assert text.endswith("Click Start session for a new code.")  # the session is over
    for text in (panel.RECONNECTING_IN, panel.RESTARTING_IN):
        assert text.count("{seconds}") == 1
        for retry_in in (0.0, 0.2, 2.5):
            assert " 0 s" not in text.format(seconds=panel.retry_seconds(retry_in))
    seconds = [panel.retry_seconds(r) for r in (0.0, 0.2, 1.0, 1.01, 29.5)]
    assert seconds == [1, 1, 1, 2, 30]
    # every text of the module is plain (the adapter's labels are plain text too)
    constants = [
        value for name, value in vars(panel).items() if name.isupper() and isinstance(value, str)
    ]
    assert all("<" not in text and ">" not in text for text in constants)


def test_panel_view_link_needs_a_code():
    """SLC-11 review: the link holds the code, so a view never carries one without the other (SLC-36)."""
    link = f"https://relay.example.org/j#{CODE}"
    assert PanelView("Live", code=CODE, link=link).link == link
    with pytest.raises(ValueError, match=r"^a join link needs its code$") as raised:
        PanelView("Live", link=link)
    assert CODE not in str(raised.value)
    with pytest.raises(ValueError, match=r"^a join link needs its code$"):
        replace(PanelView("Live", code=CODE, link=link), code="")
    # a code alone is fine (no QR code for this relay)
    assert PanelView("Live", code=CODE).link == ""


def test_panel_reconnecting_keeps_the_code_link_and_stop(fake):
    """SLC-36 for SLC-37: while reconnecting the panel keeps the code, its link, Stop and the extra-CA note; Start and
    the settings stay disabled. The phase is set by hand: nothing reaches it before SLC-37."""
    ctl = controller()
    ctl.start(URL, extra_ca_file="/etc/hospital-root.pem")
    live_view = deliver(ctl, Connected(1), Received(1, created()))
    assert live_view.link.endswith(f"#{CODE}")
    ctl.phase = Phase.RECONNECTING
    assert ctl._show(panel.RECONNECTING, code=CODE) == PanelView(
        panel.RECONNECTING,
        detail=panel.EXTRA_CA_IN_USE,
        code=CODE,
        link=live_view.link,
        start_enabled=False,
        stop_enabled=True,
        settings_enabled=False,
    )
    ctl.phase = Phase.STOPPING  # for contrast: stopping shows none of them
    assert ctl._show(panel.STOPPING, code=CODE) == PanelView(
        panel.STOPPING, start_enabled=False, stop_enabled=False, settings_enabled=False
    )


@pytest.mark.parametrize(
    ("ending", "expected"),
    [
        ("error-UNAUTHORIZED", "SESSION_LOST"),
        ("error-SESSION_NOT_FOUND", "SESSION_GONE_OFFLINE"),
        ("close-4003", "SESSION_LOST"),
    ],
)
def test_panel_reconnecting_explains_a_refused_resume(fake, ending, expected):
    """SLC-36 for SLC-37: a relay that refuses the resume ends the session with its reconnect text and no
    ``session.close`` (the session is gone or no longer ours). The resume is set up by hand until SLC-37 sends it."""
    ctl = controller()
    live(ctl)
    client = ctl._client
    client.transport_lost(1006)
    resume_id = client.resume()["id"]
    ctl.phase = Phase.RECONNECTING
    if ending == "close-4003":
        error = TransportError(ErrorKind.CLOSED, retryable=False, close_code=4003)
        view = deliver(ctl, Disconnected(1, error, None))
    else:
        deliver(ctl, Received(1, relay_error(ending.removeprefix("error-"), resume_id)))
        assert fake.made[0].stops == [(None, 0)]  # nothing to close: no session.close
        view = deliver(ctl, Disconnected(1, None, None, final_sent=False))
    assert (view.status, view.detail) == (panel.SESSION_ENDED, getattr(panel, expected))
    assert not ctl.active and ctl.phase is Phase.IDLE


@pytest.mark.parametrize("phase", ["connecting", "live"])
def test_panel_reconnect_texts_only_while_reconnecting(fake, phase):
    """Outside a reconnect the same reasons keep their usual texts: a refused create was not "offline", and a live
    session the relay stops authorising says so."""
    ctl = controller()
    ctl.start(URL)
    if phase == "connecting":
        deliver(ctl, Connected(1), Received(1, relay_error("SESSION_NOT_FOUND", "p-1")))
        expected = (panel.CANNOT_START, panel.end_text("SESSION_NOT_FOUND"))
    else:
        live_view = deliver(ctl, Connected(1), Received(1, created()))
        assert live_view.code == CODE
        deliver(ctl, Received(1, relay_error("UNAUTHORIZED")))
        expected = (panel.SESSION_ENDED, panel.END_REASONS["UNAUTHORIZED"])
    view = deliver(ctl, Disconnected(1, None, None, final_sent=True))
    assert (view.status, view.detail) == expected


@pytest.mark.parametrize("missing", ["scene", "flush_timer"])
def test_panel_watch_needs_a_scene_and_a_flush_timer(missing):
    """SLC-32: marks that are never flushed would freeze the viewers silently; a watcher without a scene has nothing
    to follow."""
    given = {"scene": lambda: None, "flush_timer": object()}
    del given[missing]
    with pytest.raises(ValueError, match="watch needs a scene factory and a flush_timer"):
        PanelController(slicer_version="5.12.4", platform="win32", watch=lambda live: None, **given)


# --------------------------------------------------------------------------- the .ui file (criterion 2)


def _adapter_widget_names() -> set[str]:
    """Every ``self.ui.<name>`` the adapter reads or writes."""
    tree = ast.parse((MODULE_DIR / "RemoteView.py").read_text())
    return {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Attribute)
        and node.value.attr == "ui"
        and isinstance(node.value.value, ast.Name)
        and node.value.value.id == "self"
    }


def test_panel_ui_defines_every_widget_the_adapter_uses():
    names = ui_widget_names(UI_FILE)
    assert len(names) == len(set(names))  # childWidgetVariables needs unique names
    used = _adapter_widget_names()
    assert used and used <= set(names), sorted(used - set(names))


def test_panel_ui_properties():
    root = ET.parse(UI_FILE).getroot()  # noqa: S314 — the module's own file
    widgets = {w.get("name"): w for w in root.iter("widget")}

    def prop(widget: str, name: str):
        return widgets[widget].find(f"property[@name='{name}']")

    font = prop("codeLabel", "font").find("font")
    # readable from 2 m; a monospace family (setStyleHint applies only when it is missing)
    assert int(font.findtext("pointsize")) >= 28 and font.findtext("bold") == "true"
    assert font.findtext("family") == "Courier New"
    # the node list preview (SLC-18)
    assert prop("nodeListPlaceholderLabel", "text").findtext("string")
    labels = [name for name, w in widgets.items() if w.get("class") == "QLabel"]
    assert labels and all(prop(n, "textFormat").findtext("enum") == "Qt::PlainText" for n in labels)
    assert "openExternalLinks" not in ET.tostring(root, encoding="unicode")
    assert prop("stopButton", "enabled").findtext("bool") == "false"
    assert widgets["extraCaPathLineEdit"].get("class") == "ctkPathLineEdit"
    assert (
        prop("extraCaPathLineEdit", "filters").findtext("set")
        == "ctkPathLineEdit::Files|ctkPathLineEdit::Readable"
    )
    declared = {c.findtext("class") for c in root.iter("customwidget")}
    used = {w.get("class") for w in widgets.values()}
    assert {c for c in used if not c.startswith("Q")} <= declared


# --------------------------------------------------------------------------- the Qt adapter against the stubs


@pytest.fixture
def widget(import_remote_view, monkeypatch, fake, packages_installed):
    module = import_remote_view()
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    instance = module.RemoteViewWidget(parent=parent_widget())
    instance.setup()
    return module, instance


def test_panel_adapter_setup_loads_the_ui_and_settings(
    import_remote_view, slicer_stubs, monkeypatch
):
    def no_transport(*_args, **_kwargs):
        raise AssertionError("opening the panel must not start a transport (FR-02)")

    monkeypatch.setattr(panel, "RelayTransport", no_transport)
    empty = import_remote_view().RemoteViewWidget(parent=parent_widget())
    empty.setup()
    assert empty.ui.relayUrlLineEdit.text == ""  # no built-in relay address
    qt = slicer_stubs["qt"]
    qt.QSettings().setValue("RemoteView/RelayURL", URL)
    module = import_remote_view()
    instance = module.RemoteViewWidget(parent=parent_widget())
    instance.setup()
    assert instance.ui.relayUrlLineEdit.text == URL
    assert instance.ui.extraCaPathLineEdit.currentPath == ""
    assert instance.ui.advancedCollapsibleButton.collapsed is True  # nothing extra to show
    assert instance.pumpTimer.interval == 50 and not instance.pumpTimer.isActive()
    assert instance.pumpTimer.slots["timeout()"] == instance.onPump
    instance.ui.startButton.connect.assert_called_once_with(
        "clicked(bool)", instance.onStartClicked
    )
    instance.ui.stopButton.connect.assert_called_once_with("clicked(bool)", instance.onStopClicked)


def test_panel_adapter_start_pump_and_stop(widget, slicer_stubs, fake):
    _, instance = widget
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    assert slicer_stubs["qt"].QSettings().value("RemoteView/RelayURL") == URL
    assert instance.pumpTimer.isActive()
    assert instance.ui.statusLabel.text == "Connecting to relay.example.org…"
    assert instance.ui.detailLabel.text == ""
    assert (
        instance.ui.startButton.enabled is False and instance.ui.relayUrlLineEdit.enabled is False
    )
    assert instance.ui.extraCaPathLineEdit.enabled is False
    transport = fake.made[0]
    transport.events.put(Connected(1))
    transport.events.put(Received(1, created()))
    instance.onPump()
    assert instance.ui.codeLabel.text == CODE and instance.ui.stopButton.enabled is True
    # §4.1 clientInfo: Slicer's version and the OS, nothing else
    (_, create), *scene = transport.sent
    assert create["clientInfo"]["platform"] == f"Slicer 5.12.4 / {sys.platform}"
    # SLC-25: the (empty) stub scene follows as a snapshot: begin, one chunk, end
    assert [m["type"] if isinstance(m, dict) else "chunk" for _, m in scene] == [
        "scene.snapshot.begin",
        "chunk",
        "scene.snapshot.end",
    ]
    instance.onStopClicked()
    assert instance.ui.statusLabel.text == panel.STOPPING and instance.ui.codeLabel.text == ""
    transport.events.put(Disconnected(1, None, None, final_sent=True))
    instance.onPump()
    assert not instance.pumpTimer.isActive() and instance.ui.startButton.enabled is True
    instance.cleanup()


def test_panel_adapter_refused_address_is_not_remembered(widget, slicer_stubs, fake):
    _, instance = widget
    instance.ui.relayUrlLineEdit.text = "wss://user:secret@relay.example.org/ws"
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    # a refused address might hold credentials: it is never stored
    assert not slicer_stubs["qt"].QSettings().contains("RemoteView/RelayURL")
    assert not instance.pumpTimer.isActive() and fake.made == []
    assert instance.ui.statusLabel.text == panel.CANNOT_START
    assert instance.ui.detailLabel.text.startswith("relay URL must not carry user info")


def test_panel_adapter_extra_ca_file_reaches_the_transport_and_is_remembered(
    widget, slicer_stubs, fake
):
    module, instance = widget
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = " /etc/hospital-root.pem "
    instance.onStartClicked()
    assert fake.made[0].extra_ca_file == "/etc/hospital-root.pem"
    stored = slicer_stubs["qt"].QSettings().value("RemoteView/ExtraCACertificate")
    assert stored == "/etc/hospital-root.pem"
    assert instance.ui.statusLabel.text == "Connecting to relay.example.org…"
    assert instance.ui.detailLabel.text == panel.EXTRA_CA_IN_USE
    instance.cleanup()
    again = module.RemoteViewWidget(parent=parent_widget())
    again.setup()
    assert again.ui.extraCaPathLineEdit.currentPath == "/etc/hospital-root.pem"
    # the extra trust anchor stays visible (T5)
    assert again.ui.advancedCollapsibleButton.collapsed is False


def test_panel_adapter_refused_ca_file_is_not_remembered(widget, slicer_stubs, monkeypatch):
    def refuse(url, events, *, extra_ca_file=None):
        raise ValueError("the extra CA file holds no usable certificate (PEM or DER)")

    monkeypatch.setattr(panel, "RelayTransport", refuse)
    _, instance = widget
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = "/home/user/notes.txt"
    instance.onStartClicked()
    settings = slicer_stubs["qt"].QSettings()
    assert not settings.contains("RemoteView/ExtraCACertificate")
    assert not settings.contains("RemoteView/RelayURL")
    assert (
        instance.ui.detailLabel.text == "the extra CA file holds no usable certificate (PEM or DER)"
    )


def test_panel_adapter_pump_yields_the_gil_on_every_tick(widget, fake, monkeypatch):
    """Without the short sleep the transport thread may run only when the mouse moves (docs/research/slicer.md §3)."""
    module, instance = widget
    sleeps: list[float] = []
    monkeypatch.setattr(module, "time", types.SimpleNamespace(sleep=sleeps.append))
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    instance.onPump()  # nothing arrived yet
    fake.made[0].events.put(Connected(1))
    instance.onPump()
    instance.onStopClicked()
    fake.made[0].events.put(Disconnected(1, None, None, final_sent=True))
    instance.onPump()  # the tick that stops the timer
    assert not instance.pumpTimer.isActive() and sleeps == [0.001] * 3


def test_panel_adapter_assigns_the_code_font_back(import_remote_view, slicer_stubs, monkeypatch):
    """PythonQt returns ``QLabel.font`` by value: changing it does nothing unless it is assigned back."""

    class Font:
        def __init__(self, calls=()):
            self.calls = list(calls)

        def setStyleHint(self, hint):  # noqa: N802 — Qt's name
            self.calls.append(("styleHint", hint))

        def setLetterSpacing(self, kind, value):  # noqa: N802 — Qt's name
            self.calls.append(("letterSpacing", kind, value))

    class Label:
        def __init__(self):
            self.shown = Font()

        @property
        def font(self):
            return Font(self.shown.calls)  # a copy

        @font.setter
        def font(self, value):
            self.shown = Font(value.calls)

    util = slicer_stubs["slicer"].util
    variables = util.childWidgetVariables

    def with_value_label(ui_widget):
        ui = variables(ui_widget)
        ui.codeLabel = Label()
        return ui

    monkeypatch.setattr(util, "childWidgetVariables", with_value_label)
    instance = import_remote_view().RemoteViewWidget(parent=parent_widget())
    instance.setup()
    qfont = slicer_stubs["qt"].QFont
    assert instance.ui.codeLabel.shown.calls == [
        ("styleHint", qfont.Monospace),
        ("letterSpacing", qfont.PercentageSpacing, 130),
    ]


def test_panel_adapter_starts_again_after_a_session(widget, fake):
    _, instance = widget
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    for session in (1, 2):
        instance.onStartClicked()
        transport = fake.made[-1]
        assert len(fake.made) == session and instance.pumpTimer.isActive()
        transport.events.put(Connected(1))
        transport.events.put(Received(1, created()))
        instance.onPump()
        assert instance.ui.codeLabel.text == CODE
        instance.onStopClicked()
        transport.events.put(Disconnected(1, None, None, final_sent=True))
        instance.onPump()
        assert instance.ui.statusLabel.text == panel.NOT_CONNECTED
        assert not instance.pumpTimer.isActive() and instance.ui.startButton.enabled is True
    instance.cleanup()


def test_panel_adapter_cleanup_closes_a_running_session(widget, fake):
    _, instance = widget
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    instance.onStartClicked()
    fake.made[0].events.put(Connected(1))
    fake.made[0].events.put(Received(1, created()))
    instance.onPump()
    instance.cleanup()
    assert [timeout for _, timeout in fake.made[0].stops] == [0, 3.0]  # unload waits at most 3 s
    assert instance.controller is None and not instance.pumpTimer.isActive()


# --------------------------------------------------------------------------- end to end with the fake-slicer relay stub


@needs_relay_stub
def test_panel_end_to_end_with_the_relay_stub():
    """The real controller, transport and protocol client against tools/fake-slicer's relay stub (§4.1, §4.5,
    §9.1 heartbeat with a short interval)."""
    ctl = PanelController(
        slicer_version="5.12.4",
        platform=sys.platform,
        transport_factory=lambda u, events, extra_ca_file=None: RelayTransport(
            u, events, use_proxy=False, ping_interval=0.1
        ),
    )
    stub = start_relay_stub()
    try:
        ctl.start(stub.address)
        pump_while(ctl, lambda: ctl.phase is not Phase.LIVE, 5)
        assert ctl.phase is Phase.LIVE and re.fullmatch(
            r"[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}", ctl.view.code
        )
        pump_while(ctl, lambda: True, 1.0)  # live for 1 s: about ten heartbeats
        assert ctl.phase is Phase.LIVE
        ctl.stop()
        pump_while(ctl, lambda: ctl.active, 5)
        assert ctl.view == PanelView(panel.NOT_CONNECTED)
    finally:
        ctl.shutdown(timeout=3)  # no transport thread outlives a failed test
        out = stub.finish()
    closes, pings = out.split()[:2]
    assert closes == "1"  # the stub received exactly one session.close
    assert int(pings) >= 3  # and the heartbeat kept going while the panel pumped
