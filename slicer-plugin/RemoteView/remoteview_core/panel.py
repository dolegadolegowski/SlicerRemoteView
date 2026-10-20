"""Session panel logic (SLC-09): what *Start session* / *Stop session* do and what the panel shows — no Qt, no Slicer.

:class:`PanelController` owns one :class:`~remoteview_core.protocol_client.ProtocolClient` and one
:class:`~remoteview_core.transport.RelayTransport` per session. The Qt adapter (``RemoteView.py``) calls
:meth:`~PanelController.start` / :meth:`~PanelController.stop`, drains the transport's events every 50 ms with
:meth:`~PanelController.pump` and renders the returned :class:`PanelView`. Main thread only.

- Nothing leaves the computer before *Start session* (FR-02); the relay URL and the CA file are checked before any
  thread starts, and their error messages are fixed texts that never echo the input.
- Texts are fixed English strings (localised in SLC-21). Relay free text (``error.message``, §9.2) is never shown;
  close reasons and error codes are mapped to texts, and an unknown code is shown only as its validated enum value.
  The adapter's labels are plain text (no rich text from anywhere).
- The session code is shown only while the session runs and is never logged.
- No resume yet (SLC-17): a connection lost after ``session.created`` ends the session; one lost before it is
  retried by the transport, which then sends a new ``session.create``. A relay that keeps the socket open but does
  not answer ``session.create`` within :data:`CREATE_TIMEOUT_S` ends the attempt.
- No automatic ``session.renew``: until ``release`` decides how renewal follows user activity (SLC-17/SLC-18), a
  session nobody joins ends after the relay's idle TTL (NFR-11, T1) instead of living for its 12 h maximum.
"""

from __future__ import annotations

import enum
import math
import queue
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from remoteview_core.protocol_client import ProtocolClient, SessionState, envelope, make_client_info
from remoteview_core.transport import Connected, Disconnected, Event, Received, RelayTransport

DEFAULT_PROFILE = "mobile"
#: Events handled per pump tick (50 ms): the relay sends a publisher few messages; this bounds one tick's work.
MAX_EVENTS_PER_PUMP = 100
#: How long the module's cleanup waits for ``session.close`` to go out (the transport aborts after 2 s).
SHUTDOWN_TIMEOUT_S = 3.0
#: How long the panel waits for ``session.created`` after each ``session.create``. The relay answers at once (§4.1);
#: the heartbeat alone would keep a relay that answers pings but not the create — and the panel — waiting for ever.
CREATE_TIMEOUT_S = 15.0

NOT_CONNECTED = "Not connected."
SESSION_ENDED = "Session ended."
CANNOT_START = "Cannot start the session."
STOPPING = "Stopping…"
WAITING = "Waiting for the relay…"
WEBSOCKETS_MISSING = (
    "RemoteView needs the Python package websockets 17.2, which is not installed. Automatic installation arrives "
    "in a later version."
)
CA_FILE_UNREADABLE = "The additional CA certificate file cannot be read."
NO_ANSWER = "The relay did not answer. Check the relay address or try again later."
VERSION_UNUSABLE = "This Slicer version string cannot be sent to the relay. Please report this."
RESUME_LATER = (
    "The connection to the relay was lost: the relay keeps the session for up to 2 minutes, then ends it. Click "
    "Start session for a new code (automatic resume arrives in a later version)."
)
EXTRA_CA_IN_USE = "An additional CA certificate is trusted for this connection."
PROTOCOL_VIOLATION = (
    "The relay sent data RemoteView does not expect, so the session was stopped. "
    "Please report this."
)
FINAL_NOT_SENT = (
    "The stop message could not be sent in time: the relay keeps the session for up to 2 minutes, "
    "then ends it."
)
#: Why a session ended, by ``ProtocolClient.close_reason`` (§4.5 reasons, §9.2 error codes, §9.3 close codes).
END_REASONS = {
    "USER_STOPPED": "",
    "PUBLISHER_CLOSED": "The session was closed.",
    "SESSION_CLOSED": "The session was closed.",
    "PUBLISHER_GONE": "The relay ended the session after the connection was lost.",
    "IDLE": "The session expired because nobody joined for a while.",
    "SESSION_EXPIRED": "The session expired.",
    "MAX_LIFETIME": "The session reached its maximum length.",  # set by the relay (§14)
    "CAPACITY": "The relay is full. Try again later.",
    "RATE_LIMITED": "Too many sessions were started from this network. Wait a few minutes and try again.",
    "UNSUPPORTED_VERSION": "The relay uses a newer protocol. Update RemoteView.",
    "UNAUTHORIZED": "The relay did not authorise this session. Start a new session.",
    "REPLACED": "Another connection took over this session.",
    "POLICY_VIOLATION": "The relay refused a message from RemoteView. Please report this.",
    "INTERNAL": "The relay had an internal error. Try again later.",
}


class Phase(enum.Enum):
    IDLE = "idle"  # nothing runs; Start is enabled
    CONNECTING = "connecting"  # transport started, waiting for session.created
    LIVE = "live"  # session created: the code is shown
    STOPPING = "stopping"  # waiting for the transport to end


@dataclass(frozen=True)
class PanelView:
    """Everything the panel shows. ``detail`` is guidance after a failure or an end (empty when there is none)."""

    status: str
    detail: str = ""
    # the session code stays out of repr (logs, tracebacks)
    code: str = field(default="", repr=False)
    start_enabled: bool = True
    stop_enabled: bool = False
    settings_enabled: bool = True  # relay address and CA file


def viewers_text(count: int) -> str:
    if count <= 0:
        return "Session running · no viewers yet."
    return f"Session running · {count} viewer{'s' if count != 1 else ''}."


def end_text(reason: str | None) -> str:
    """Panel text for a ``close_reason``: mapped, or the validated enum value for a code this version does not know."""
    if reason is None:
        return ""
    if reason in END_REASONS:
        return END_REASONS[reason]
    return f"The relay ended the session ({reason})."


class PanelController:
    """Start/Stop and the relay events → :class:`PanelView` (see the module docstring).

    ``transport_factory`` is called as ``factory(url, events, extra_ca_file=...)`` and defaults to
    :class:`~remoteview_core.transport.RelayTransport` (looked up at Start, so tests can replace it). ``clock``
    (seconds, monotonic) times the wait for ``session.created``.
    """

    def __init__(
        self,
        *,
        slicer_version: str,
        platform: str,
        profile: str = DEFAULT_PROFILE,
        transport_factory: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._slicer_version = slicer_version
        self._platform = platform
        self.profile = profile
        self._factory = transport_factory
        self._clock = clock
        self.phase = Phase.IDLE
        self.view = PanelView(NOT_CONNECTED)
        self._events: queue.Queue[Event] = queue.Queue()
        self._transport: Any = None
        self._client: ProtocolClient | None = None
        self._connection: int | None = None
        self._end_detail = ""
        self._user_stopped = False
        self._sent_final = False
        self._was_live = False
        # session.expired/closed arrived while our session.close was on its way
        self._relay_ended = False
        self._ca_note = ""
        # clock() by which session.created must arrive (checked while CONNECTING only)
        self._create_deadline: float | None = None

    @property
    def active(self) -> bool:
        """A transport runs (or its last events wait): the adapter keeps pumping while this is true."""
        return self._transport is not None

    # ------------------------------------------------------------------ user actions

    def start(self, url: str, *, extra_ca_file: str | None = None) -> PanelView:
        """*Start session*: check the inputs, start the transport; ``session.create`` follows on ``Connected``."""
        if self.phase is not Phase.IDLE:
            return self.view
        try:
            # auto_renew=False: see the module docstring (branch-audit follow-up, NFR-11)
            client = ProtocolClient(
                make_client_info(self._slicer_version, self._platform), auto_renew=False
            )
        except ValueError:
            return self._idle(CANNOT_START, VERSION_UNUSABLE)
        factory = self._factory or RelayTransport
        events: queue.Queue[Event] = queue.Queue()
        try:
            transport = factory(url.strip(), events, extra_ca_file=extra_ca_file or None)
        except ValueError as exc:  # fixed texts: the URL and CA checks never echo what they refuse
            return self._idle(CANNOT_START, str(exc))
        except OSError:
            return self._idle(CANNOT_START, CA_FILE_UNREADABLE)
        try:
            transport.start()
        except ImportError:
            return self._idle(CANNOT_START, WEBSOCKETS_MISSING)
        self._transport, self._events, self._client = transport, events, client
        self._connection, self._end_detail, self._create_deadline = None, "", None
        self._user_stopped = self._sent_final = self._was_live = self._relay_ended = False
        self.phase = Phase.CONNECTING
        address = urlsplit(transport.url)
        # an extra trust anchor stays visible while it is in use (T5); ws:// to loopback uses no TLS
        self._ca_note = EXTRA_CA_IN_USE if extra_ca_file and address.scheme == "wss" else ""
        return self._show(f"Connecting to {address.hostname or ''}…")

    def stop(self) -> PanelView:
        """*Stop session*: ``session.close`` if a session exists, then the transport ends (never blocks)."""
        if self._transport is None or self.phase is Phase.STOPPING:
            return self.view
        self._user_stopped = True
        self._finish("")
        return self.view

    def shutdown(self, timeout: float = SHUTDOWN_TIMEOUT_S) -> bool:
        """Module cleanup: like :meth:`stop`, but waits up to ``timeout`` s for the transport to end."""
        if self._transport is None:
            return True
        if self.phase is not Phase.STOPPING:
            self._finish("")
        transport, self._transport = self._transport, None
        # a second stop() keeps the first final message
        ended = bool(transport.stop(timeout=timeout))
        self._idle(NOT_CONNECTED)
        return ended

    def pump(self, max_events: int = MAX_EVENTS_PER_PUMP) -> PanelView:
        """Handle the transport events that arrived since the last tick."""
        for _ in range(max_events):
            try:
                event = self._events.get_nowait()
            except queue.Empty:
                break
            if isinstance(event, Connected):
                self._on_connected(event)
            elif isinstance(event, Received):
                self._on_received(event)
            elif isinstance(event, Disconnected):
                self._on_disconnected(event)
        deadline = self._create_deadline
        if self.phase is Phase.CONNECTING and deadline is not None and self._clock() >= deadline:
            self._finish(NO_ANSWER)
        return self.view

    # ------------------------------------------------------------------ transport events

    def _on_connected(self, event: Connected) -> None:
        if self.phase is not Phase.CONNECTING or self._client is None:
            return
        self._connection = event.connection
        if self._client.state in (SessionState.IDLE, SessionState.CLOSED):
            self._send(self._client.start(self.profile))
            self._create_deadline = self._clock() + CREATE_TIMEOUT_S
            self._show(WAITING)

    def _on_received(self, event: Received) -> None:
        client = self._client
        if client is None or event.connection != self._connection:
            return
        message = event.message
        if self.phase is Phase.STOPPING:
            # the relay ended the session itself (§11): it does not keep it after a lost session.close
            if client.ends_session(message):
                self._relay_ended = True
            return
        if not isinstance(message, dict):  # §3.2: no binary frames to a publisher
            self._finish(PROTOCOL_VIOLATION)
            return
        for reply in client.handle(message):
            self._send(reply)
        if client.state in (SessionState.CREATED, SessionState.ACTIVE):
            self.phase = Phase.LIVE
            self._was_live = True
            self._show(viewers_text(client.viewer_count), code=client.code or "")
        elif client.state is SessionState.CLOSED:
            # session.expired/closed, a refused create, a fatal error (§9.2). After a fatal error the relay may keep
            # the socket and the session (§11): a live session is closed explicitly, so its code is freed at once.
            fatal = self.phase is Phase.LIVE and message.get("type") == "error"
            close = envelope("session.close", reason="USER_STOPPED") if fatal else None
            self._finish(end_text(client.close_reason), close)

    def _on_disconnected(self, event: Disconnected) -> None:
        client = self._client
        if event.retry_in is None:  # the transport has ended for good
            self._transport = None
            detail = self._end_detail
            if self.phase is Phase.STOPPING:
                if (
                    self._user_stopped
                    and self._sent_final
                    and not event.final_sent
                    and not self._relay_ended
                ):
                    detail = FINAL_NOT_SENT
            elif client is not None:
                # it stopped by itself: certificate, proxy, HTTP status, close code
                client.transport_lost(event.close_code)
                reason = client.close_reason if client.state is SessionState.CLOSED else None
                if client.state is not SessionState.CLOSED:
                    client.close()  # nothing can be sent any more; forget the token and the code
                mapped = end_text(reason) if reason not in (None, "CONNECT_FAILED") else ""
                detail = mapped or (event.error.guidance if event.error is not None else "")
            if self._user_stopped:
                status = SESSION_ENDED if detail else NOT_CONNECTED
            else:
                status = SESSION_ENDED if self._was_live else CANNOT_START
            self._idle(status, detail)
            return
        if client is None or self.phase is Phase.STOPPING:
            return
        live = client.state in (SessionState.CREATED, SessionState.ACTIVE)
        client.transport_lost(event.close_code)
        if live:  # no resume before SLC-17
            self._finish(RESUME_LATER)
            return
        self._connection = None
        self._create_deadline = None
        detail = event.error.guidance if event.error is not None else ""
        # rounded up, and never "0 s" (a 4008 restart retries after 0–3 s)
        seconds = max(1, math.ceil(event.retry_in))
        self._show(f"Relay unreachable — retrying in {seconds} s.", detail=detail)

    # ------------------------------------------------------------------ helpers

    def _send(self, message: dict[str, Any]) -> None:
        if self._transport is not None and self._connection is not None:
            self._transport.send(message, connection=self._connection)

    def _finish(self, detail: str, close: dict[str, Any] | None = None) -> None:
        """End the session: ``session.close`` while a socket can carry it, then stop the transport (non-blocking).
        ``close`` is that message when the client has none any more (it closed itself on a relay error)."""
        client = self._client
        final = (client.close() if client is not None else None) or close
        self._sent_final = final is not None and self._connection is not None
        self._end_detail = detail
        self.phase = Phase.STOPPING
        if self._transport is not None:
            self._transport.stop(final if self._sent_final else None, timeout=0)
        self._show(STOPPING)

    def _show(self, status: str, *, detail: str = "", code: str = "") -> PanelView:
        phase = self.phase
        note = self._ca_note if phase in (Phase.CONNECTING, Phase.LIVE) else ""
        self.view = PanelView(
            status=status,
            detail=detail or note,
            code=code if phase is Phase.LIVE else "",
            start_enabled=phase is Phase.IDLE,
            stop_enabled=phase in (Phase.CONNECTING, Phase.LIVE),
            settings_enabled=phase is Phase.IDLE,
        )
        return self.view

    def _idle(self, status: str, detail: str = "") -> PanelView:
        self.phase = Phase.IDLE
        self._client = None
        self._connection = None
        return self._show(status, detail=detail)
