"""Session panel logic (SLC-09): what *Start session* / *Stop session* do and what the panel shows — no Qt, no Slicer.

:class:`PanelController` owns one :class:`~remoteview_core.protocol_client.ProtocolClient` and one
:class:`~remoteview_core.transport.RelayTransport` per session. The Qt adapter (``RemoteView.py``) calls
:meth:`~PanelController.start` / :meth:`~PanelController.stop`, drains the transport's events every 50 ms with
:meth:`~PanelController.pump` and renders the returned :class:`PanelView`. Main thread only.

- Nothing leaves the computer before *Start session* (FR-02); the relay URL and the CA file are checked before any
  thread starts, and their error messages are fixed texts that never echo the input.
- The Python packages the session needs are installed only then (SLC-10): ``ensure_deps`` runs after the address is
  accepted and before the transport starts, asks the user first, and a "no" or a failure ends the attempt with its text.
- Texts are fixed English strings (localised in SLC-21). Relay free text (``error.message``, §9.2) is never shown;
  close reasons and error codes are mapped to texts, and an unknown code is shown only as its validated enum value.
  The adapter's labels are plain text (no rich text from anywhere).
- The session code is shown only while the session runs and is never logged.
- No resume yet (SLC-17): a connection lost after ``session.created`` ends the session; one lost before it is
  retried by the transport, which then sends a new ``session.create``. A relay that keeps the socket open but does
  not answer ``session.create`` within :data:`CREATE_TIMEOUT_S` ends the attempt.
- With a ``scene`` factory (SLC-25), the first ``session.created`` sends the scene as a snapshot
  (:func:`~remoteview_core.snapshot.build_snapshot`, main thread); the status says "Sending the scene" until the
  relay's ``scene.snapshot.ack`` and "Live" after it. A scene the relay refuses, or one too large to send, leaves the
  session running (the code still works) with a fixed text saying why.
- No automatic ``session.renew``: until ``release`` decides how renewal follows user activity (SLC-17/SLC-18), a
  session nobody joins ends after the relay's idle TTL (NFR-11, T1) instead of living for its 12 h maximum.
"""

from __future__ import annotations

import enum
import logging
import math
import queue
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any
from urllib.parse import urlsplit

from remoteview_core.collect import SceneApi
from remoteview_core.deps import DepsResult, Outcome
from remoteview_core.links import join_url
from remoteview_core.protocol_client import ProtocolClient, SessionState, envelope, make_client_info
from remoteview_core.snapshot import Snapshot, SnapshotTooLargeError, build_snapshot
from remoteview_core.transport import Connected, Disconnected, Event, Received, RelayTransport

_log = logging.getLogger(__name__)

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
    "The Python package websockets 17.2 could not be loaded. Restart Slicer; if this repeats, install it as "
    "described in slicer-plugin/README.md on the RemoteView project page (section Offline installation of the "
    "Python packages)."
)
CA_FILE_UNREADABLE = "The additional CA certificate file cannot be read."
NO_LINK = (
    "No QR code for this relay address: the join link would be longer than 64 characters, or the relay is not at "
    "/ws. Read the code to the viewers instead."
)
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
    # the session code and the join link (which holds it) stay out of repr (logs, tracebacks)
    code: str = field(default="", repr=False)
    link: str = field(default="", repr=False)
    start_enabled: bool = True
    stop_enabled: bool = False
    settings_enabled: bool = True  # relay address and CA file


#: The first part of the live status, by the state of the scene (no scene factory: "").
SCENE_STATES = {
    "": "Session running",
    "sending": "Sending the scene",
    "live": "Live",
    "failed": "Session running without the scene",
}
SCENE_FAILED = "The scene could not be prepared, so viewers see nothing. Please report this."
#: Why the relay refused the scene (§6.2, §6.4, §9.2); other codes are shown as their validated enum value.
SCENE_REFUSED = {
    "PAYLOAD_TOO_LARGE": (
        "The relay refused the scene as too large. Hide models in 3D, then stop and start the session."
    ),
    "CAPACITY": "The relay has no room for the scene right now. Stop the session and try again later.",
}


def viewers_text(count: int, scene: str = "") -> str:
    viewers = "no viewers yet" if count <= 0 else f"{count} viewer{'s' if count != 1 else ''}"
    return f"{SCENE_STATES[scene]} · {viewers}."


def scene_too_large_text(error: SnapshotTooLargeError) -> str:
    # MB = 10^6 bytes, one decimal; the size rounded up and the limit down, so they never read the same
    size = math.ceil(error.byte_length / 100_000) / 10
    limit = math.floor(error.limit / 100_000) / 10
    return (
        f"The scene is too large to send ({size:.1f} MB; this relay accepts {limit:.1f} MB), so viewers see "
        "nothing. Hide models in 3D, then stop and start the session."
    )


def scene_refused_text(code: str | None) -> str:
    if code in SCENE_REFUSED:
        return SCENE_REFUSED[code]
    return (
        f"The relay refused the scene ({code or 'no reason'}). Stop and start the session; if it happens again, "
        "please report this."
    )


def budget_text(snapshot: Snapshot) -> str:
    """What the device profile's budgets left over (SLC-14, §7.5, NFR-03): nodes no filter could simplify, and a scene
    above the profile's recommended size (sent anyway — the warning, not a refusal). Empty when the scene fits."""
    parts = []
    if snapshot.unreduced:
        count = len(snapshot.unreduced)
        parts.append(
            f"{count} model{'s' if count != 1 else ''} could not be simplified for the device profile and "
            f"{'are' if count != 1 else 'is'} sent whole."
        )
    if snapshot.over_target:
        # MB = 10^6 bytes, one decimal; the size rounded up and the target down, so they never read the same
        size = math.ceil(snapshot.byte_length / 100_000) / 10
        target = math.floor(snapshot.target_bytes / 100_000) / 10
        parts.append(
            f"The scene is {size:.1f} MB, more than the {target:.1f} MB recommended for the device profile: viewers "
            "may load it slowly. Hide models in 3D to make it smaller."
        )
    return " ".join(parts)


def skipped_text(count: int) -> str:
    """Models the 3D view shows that the snapshot leaves out (the node list of SLC-18 says which and why)."""
    if count <= 0:
        return ""
    return f"{count} model{'s' if count != 1 else ''} shown in 3D could not be shared."


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
    (seconds, monotonic) times the wait for ``session.created``. ``ensure_deps`` (SLC-10) is called once the address is
    accepted and before the transport starts; it returns a :class:`~remoteview_core.deps.DepsResult` (it may show
    dialogs and block while pip runs). Without it nothing is installed or checked.
    """

    def __init__(  # noqa: PLR0913 — keyword-only collaborators, defaults for the application
        self,
        *,
        slicer_version: str,
        platform: str,
        profile: str = DEFAULT_PROFILE,
        transport_factory: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        scene: Callable[[], SceneApi] | None = None,
        ensure_deps: Callable[[], DepsResult] | None = None,
    ) -> None:
        self._slicer_version = slicer_version
        self._platform = platform
        self.profile = profile
        self._factory = transport_factory
        self._clock = clock
        self._scene_factory = scene
        self._ensure_deps = ensure_deps
        # ensure_deps blocks inside Qt's event loop (dialogs, pip's progress window): a second click must not start over
        self._preparing = False
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
        self._scene = ""  # a key of SCENE_STATES
        self._scene_detail = ""
        self._scene_version = 0  # the sceneVersion of the snapshot sent

    @property
    def active(self) -> bool:
        """A transport runs (or its last events wait): the adapter keeps pumping while this is true."""
        return self._transport is not None

    # ------------------------------------------------------------------ user actions

    def start(self, url: str, *, extra_ca_file: str | None = None) -> PanelView:
        """*Start session*: check the inputs, start the transport; ``session.create`` follows on ``Connected``."""
        if self.phase is not Phase.IDLE or self._preparing:
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
        problem = self._prepare(transport)
        if problem:
            return self._idle(CANNOT_START, problem)
        self._transport, self._events, self._client = transport, events, client
        self._connection, self._end_detail, self._create_deadline = None, "", None
        self._user_stopped = self._sent_final = self._was_live = self._relay_ended = False
        self._scene, self._scene_detail, self._scene_version = "", "", 0
        self.phase = Phase.CONNECTING
        address = urlsplit(transport.url)
        # an extra trust anchor stays visible while it is in use (T5); ws:// to loopback uses no TLS
        self._ca_note = EXTRA_CA_IN_USE if extra_ca_file and address.scheme == "wss" else ""
        return self._show(f"Connecting to {address.hostname or ''}…")

    def _prepare(self, transport: Any) -> str:
        """Install the missing packages (asking first), then start ``transport``; the text of what went wrong, or ""."""
        if self._ensure_deps is not None:
            before = self.view
            self._preparing = True
            # Qt's event loop runs inside the installation: a second click renders this view, so it says "not now"
            self.view = replace(before, start_enabled=False, settings_enabled=False)
            try:
                deps = self._ensure_deps()
            finally:
                self._preparing = False
                self.view = before  # an error leaves the panel as it was; every other way out shows a new view
            if deps.outcome is not Outcome.READY:
                return deps.detail
        try:
            transport.start()
        except ImportError:
            return WEBSOCKETS_MISSING
        return ""

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
            first = self.phase is not Phase.LIVE
            self.phase = Phase.LIVE
            self._was_live = True
            if first and self._scene_factory is not None:
                self._send_scene(client, self._scene_factory)
            self._follow_scene(client)
            status = viewers_text(client.viewer_count, self._scene)
            # the extra-CA note stays next to a scene message (T5)
            detail = "\n".join(part for part in (self._ca_note, self._scene_detail) if part)
            self._show(status, detail=detail, code=client.code or "")
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

    def _send(self, message: dict[str, Any] | bytes) -> None:
        if self._transport is not None and self._connection is not None:
            self._transport.send(message, connection=self._connection)

    def _send_scene(self, client: ProtocolClient, scene: Callable[[], SceneApi]) -> None:
        """The first snapshot of the session; nothing is sent when it cannot be built."""
        try:
            snapshot = build_snapshot(scene(), client, slicer_version=self._slicer_version)
        except SnapshotTooLargeError as exc:
            self._scene, self._scene_detail = "failed", scene_too_large_text(exc)
            return
        except Exception as exc:  # noqa: BLE001 — a scene that cannot be collected must not break the panel
            # the exception type only: its text may carry node names (T7)
            _log.error("scene: snapshot not built (%s)", type(exc).__name__)
            self._scene, self._scene_detail = "failed", SCENE_FAILED
            return
        for frame in snapshot.frames():
            self._send(frame)
        self._scene, self._scene_version = "sending", snapshot.scene_version
        budget = budget_text(snapshot)
        self._scene_detail = " ".join(t for t in (skipped_text(len(snapshot.skipped)), budget) if t)

    def _follow_scene(self, client: ProtocolClient) -> None:
        """After a relay message: the snapshot sent was acknowledged (``live``) or refused (``failed``)."""
        if self._scene != "sending":
            return
        if client.accepted_version >= self._scene_version:
            self._scene = "live"
        elif client.snapshot_in_flight != self._scene_version:  # the relay refused it (§6.2, §6.4)
            code = client.last_error.code if client.last_error is not None else None
            self._scene, self._scene_detail = "failed", scene_refused_text(code)
            # the relay ignores the rest of a refused snapshot (§6.2): do not spend the uplink on it
            if self._transport is not None and self._connection is not None:
                self._transport.discard_queued(connection=self._connection)

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

    def _join_link(self, code: str) -> tuple[str, str]:
        """``(link, note)`` for the live session: the viewer link on the relay's own host (SLC-11), or no link and a
        note when there is none (too long for a QR code, or a relay that is not at ``/ws``)."""
        if self._transport is None or not code:
            return "", ""
        try:
            return join_url(self._transport.url, code), ""
        except ValueError:
            return "", NO_LINK

    def _show(self, status: str, *, detail: str = "", code: str = "") -> PanelView:
        phase = self.phase
        note = self._ca_note if phase in (Phase.CONNECTING, Phase.LIVE) else ""
        link, link_note = self._join_link(code) if phase is Phase.LIVE else ("", "")
        self.view = PanelView(
            status=status,
            detail="\n".join(part for part in (detail or note, link_note) if part),
            code=code if phase is Phase.LIVE else "",
            link=link,
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
