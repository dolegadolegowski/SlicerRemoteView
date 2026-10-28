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
- A connection lost after ``session.created`` is resumed (SLC-37, §4.3): the panel keeps the code and Stop while the
  transport reconnects by itself, each new connection starts with ``session.resume``, and ``session.resumed`` brings
  the session back to Live with the same live updates and observers. The reconnect window — the relay's grace (at most
  :data:`MAX_GRACE_S`) plus :data:`RECONNECT_SLACK_S` — runs from when the transport says the connection was lost
  (``Disconnected.lost_at``, SLC-41: before the wake for a computer that slept while Live — on Windows only after a
  sleep longer than about ``MAX_SILENCE_S``), on the monotonic and on the wall clock (a computer that sleeps during
  the outage); after it nothing is sent (T1). So a sleep that begins while Live and outlasts the window ends the
  session once the drop is reported after the wake — on Windows, whose monotonic clock runs on through a sleep, only
  one longer than about ``MAX_SILENCE_S`` plus the window; a shorter sleep resumes, and a relay that has ended the
  session answers ``SESSION_NOT_FOUND``. A resume left unanswered for :data:`CREATE_TIMEOUT_S`, a relay that refuses
  it, or Stop while offline ends the session. A connection lost before ``session.created`` is retried by the
  transport, which then sends a new ``session.create``; a relay that keeps the socket open but does not answer it
  within :data:`CREATE_TIMEOUT_S` ends the attempt.
- With a ``scene`` factory, the first ``session.created`` hands the session to SLC-29's
  :class:`~remoteview_core.live.LiveUpdates` (SLC-32), which sends the first snapshot and every later change. With a
  ``watch`` factory, the observers that mark the changes (SLC-31's ``SceneWatcher``) are attached in the same
  main-thread call and removed when the session ends, on Stop, when the transport ends and when the module is
  unloaded. After events the observers saw off the main thread, the pump brings the batch hold in line with Slicer's
  and asks for a re-sync (SLC-33). The status follows the scene — sending, updating, live, not up to date, without the
  scene — with the reason and what happens next; a scene that cannot go out now (too large, refused, not prepared)
  leaves the session running (the code still works). A closed scene that cannot be cleared off the viewers ends the
  session (§7.3).
- No automatic ``session.renew``: until ``release`` decides how renewal follows user activity (SLC-40), a
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
from typing import Any, Protocol
from urllib.parse import urlsplit

from remoteview_core.collect import SceneApi
from remoteview_core.debounce import Timer
from remoteview_core.deps import DepsResult, Outcome
from remoteview_core.links import join_url
from remoteview_core.live import LiveEvent, LiveEventKind, LiveUpdates
from remoteview_core.protocol_client import ProtocolClient, SessionState, envelope, make_client_info
from remoteview_core.snapshot import Snapshot, SnapshotTooLargeError
from remoteview_core.transport import Connected, Disconnected, Event, Received, RelayTransport

_log = logging.getLogger(__name__)

DEFAULT_PROFILE = "mobile"
#: Events handled per pump tick (50 ms): the relay sends a publisher few messages; this bounds one tick's work.
MAX_EVENTS_PER_PUMP = 100
#: How long the module's cleanup waits for ``session.close`` to go out (the transport aborts after 2 s).
SHUTDOWN_TIMEOUT_S = 3.0
#: How long the panel waits for ``session.created`` after each ``session.create``, and for ``session.resumed`` after
#: each ``session.resume``. The relay answers at once (§4.1, §4.3); the heartbeat alone would keep a relay that answers
#: pings but not the request — and the panel — waiting for ever.
CREATE_TIMEOUT_S = 15.0
#: The reconnect window after a lost connection (SLC-37): the relay's grace (``ttl.graceS``, at most MAX_GRACE_S) plus
#: up to 60 s before the relay notices the drop (§9.1). Then the relay has ended the session, and resuming it later
#: would publish to nobody (T1). A backward wall-clock step beyond WALL_JUMP_TOLERANCE_S (not an NTP correction) ends
#: the window too.
RECONNECT_SLACK_S = 60.0
MAX_GRACE_S = 600.0
WALL_JUMP_TOLERANCE_S = 60.0
#: §9.3: the relay is restarting (its sessions do not survive it, §13 step 9).
RESTART_CLOSE_CODE = 4008
#: §8.4: ``sceneVersion`` is a uint32.
LAST_SCENE_VERSION = 2**32 - 1

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
EXTRA_CA_IN_USE = "An additional CA certificate is trusted for this connection."
PROTOCOL_VIOLATION = (
    "The relay sent data RemoteView does not expect, so the session was stopped. "
    "Please report this."
)
#: Reconnecting after a lost connection (SLC-37/SLC-38; protocol §4.3, §9.1). "A few minutes", never a number: the
#: relay's grace plus up to 60 s before the relay notices the drop (§9.1 heartbeat). While the relay may keep the
#: session, the texts say who can still see the scene, as the consent text does ("anyone who has the session code").
RECONNECTING_IN = "Connection lost — reconnecting in {seconds} s."
RESTARTING_IN = "The relay is restarting — reconnecting in {seconds} s."
RECONNECTING = "Reconnecting to the session…"
RELAY_HOLDS_SESSION = (
    "Anyone with the code can still see the last scene until the relay ends the session, "
    "after a few minutes."
)
RECONNECT_DETAIL = (
    "The code stays the same: viewers continue when RemoteView is back. Until then anyone with the code "
    "can still see the last scene; the relay ends the session if RemoteView is not back within a few "
    "minutes."
)
RECONNECT_GAVE_UP = (
    "The connection to the relay was lost for too long, so RemoteView stopped the session. "
    "Click Start session for a new code."
)
#: After RECONNECT_GAVE_UP when the relay keeps sessions longer than RemoteView waits (graceS > MAX_GRACE_S).
RELAY_HOLDS_SESSION_LONGER = (
    "The relay keeps sessions longer than RemoteView waits: anyone with the code can still see the "
    "last scene until the relay ends the session."
)
SESSION_LOST = (
    "Session lost: the relay no longer accepts RemoteView for this session. "
    + RELAY_HOLDS_SESSION
    + " Click Start session for a new code."
)
SESSION_GONE_OFFLINE = (
    "The relay ended the session while RemoteView was offline. Click Start session for a new code."
)
RESUME_NO_ANSWER = (
    "The relay did not answer after the connection came back, so the session was stopped. "
    "Click Start session for a new code."
)
STOPPED_OFFLINE = (
    "RemoteView was not connected to the relay when you stopped. " + RELAY_HOLDS_SESSION
)
RELAY_RESTARTED = (
    "The relay restarted: RemoteView starts the session again, "
    "with the same code if it is still free."
)
NEW_CODE = (
    "The relay restarted and could not keep the old code: give the viewers the new code. "
    "The old code may now belong to another session."
)
SCENE_INTERRUPTED = "Sending the scene was interrupted: RemoteView sends it again once reconnected."
FINAL_NOT_SENT = "The stop message could not be sent in time. " + RELAY_HOLDS_SESSION
RESET_PENDING = (
    "The scene was closed in Slicer, but anyone with the code still sees it until RemoteView "
    "reconnects, or until the relay ends the session after a few minutes."
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
#: Why a session ended while reconnecting, where :data:`END_REASONS` would mislead: the relay refused the resume
#: (§4.3, §9.2). ``SESSION_NOT_FOUND`` ends a session only then (a create refused with it is not "offline").
RECONNECT_END_REASONS = {
    "UNAUTHORIZED": SESSION_LOST,
    "SESSION_NOT_FOUND": SESSION_GONE_OFFLINE,
}


class Phase(enum.Enum):
    IDLE = "idle"  # nothing runs; Start is enabled
    CONNECTING = "connecting"  # transport started, waiting for session.created
    LIVE = "live"  # session created: the code is shown
    # the connection was lost: the code and Stop stay while the session waits for a resume (SLC-37)
    RECONNECTING = "reconnecting"
    STOPPING = "stopping"  # waiting for the transport to end


#: The phases that show the session code and its link: a session keeps its code while reconnecting (after a 4008
#: restart the relay may have freed it until the session is created again: SLC-38 says so, T4).
_SHOWS_CODE = (Phase.LIVE, Phase.RECONNECTING)
#: The phases in which a transport runs for a session that is not stopping: Stop is enabled, the extra-CA note shows.
_RUNNING = (Phase.CONNECTING, Phase.LIVE, Phase.RECONNECTING)


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

    def __post_init__(self) -> None:
        # the link holds the code: no link without its code (a code may show alone: NO_LINK)
        if self.link and not self.code:
            raise ValueError("a join link needs its code")  # fixed text: never the link itself


#: The first part of the live status, by the state of the scene (no scene factory: "").
SCENE_STATES = {
    "": "Session running",
    "sending": "Sending the scene",  # no snapshot of this session accepted yet: one in flight or owed
    "updating": "Updating the scene",  # one accepted; a newer one in flight or owed
    "live": "Live",
    "failed": "Session running without the scene",  # none accepted, and the scene cannot go out now
    "stale": "Scene not up to date",  # one accepted; the newer one cannot go out now
}
SCENE_FAILED = "The scene could not be prepared; if this repeats, please report it."
#: Why the relay refused the scene (§6.2, §6.4, §9.2); other codes are shown as their validated enum value.
SCENE_REFUSED = {
    "PAYLOAD_TOO_LARGE": "The relay refused the scene as too large.",
    "CAPACITY": "The relay has no room for the scene right now.",
}
#: What happens next, after the reason, while changes in Slicer are followed (a watcher is attached)…
HIDE_MODELS = "Hide models in 3D to make it smaller: RemoteView then sends it again."
RETRY_ON_CHANGE = "RemoteView tries again after the next change to a model shown in 3D."
RETRY_LATER = "RemoteView tries again automatically."
#: … and when they are not (no watch factory): nothing in Slicer can then open the too-large or the flush gate.
HIDE_MODELS_AND_RESTART = "Hide models in 3D, then stop and start the session."
RESTART = "Stop and start the session to try again."
OBSERVE_FAILED = (
    "Changes in Slicer cannot be followed, so the scene was not sent. Please report this."
)
#: A batch process (loading, closing, a script) holds the owed snapshot.
WAITING_FOR_SLICER = (
    "Slicer is still loading or changing the scene: RemoteView sends it when Slicer is done."
)


def viewers_text(count: int, scene: str = "") -> str:
    viewers = "no viewers yet" if count <= 0 else f"{count} viewer{'s' if count != 1 else ''}"
    return f"{SCENE_STATES[scene]} · {viewers}."


def scene_too_large_text(error: SnapshotTooLargeError) -> str:
    # MB = 10^6 bytes, one decimal; the size rounded up and the limit down, so they never read the same
    size = math.ceil(error.byte_length / 100_000) / 10
    limit = math.floor(error.limit / 100_000) / 10
    return f"The scene is too large to send ({size:.1f} MB; this relay accepts {limit:.1f} MB)."


def scene_refused_text(code: str | None) -> str:
    if code in SCENE_REFUSED:
        return SCENE_REFUSED[code]
    return (
        f"The relay refused the scene ({code or 'no reason'}); if this repeats, please report it."
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


def retry_seconds(retry_in: float) -> int:
    """Whole seconds until the transport tries again, for the texts: rounded up and never 0 (a 4008 restart retries
    after 0–3 s, §9.3)."""
    return max(1, math.ceil(retry_in))


class Watcher(Protocol):
    """The observers of the scene (SLC-31's ``SceneWatcher``, injected by the adapter): they mark changes on the
    :class:`~remoteview_core.live.LiveUpdates` they were made for."""

    @property
    def observer_count(self) -> int: ...

    def attach(self) -> None: ...

    def detach(self) -> None: ...

    def take_off_thread(self) -> bool: ...

    def batch_processing(self) -> bool: ...


class _NoTimer:
    """The flush timer without a watcher: nothing marks a change, so nothing is flushed."""

    def start(self, msec: int) -> None:
        pass

    def stop(self) -> None:
        pass


class PanelController:
    """Start/Stop and the relay events → :class:`PanelView` (see the module docstring).

    ``transport_factory`` is called as ``factory(url, events, extra_ca_file=...)`` and defaults to
    :class:`~remoteview_core.transport.RelayTransport` (looked up at Start, so tests can replace it). ``clock``
    (seconds, monotonic) times the wait for ``session.created``/``session.resumed`` and, with ``wall`` (seconds, the
    wall clock, which also runs while the computer sleeps; the clock of ``Disconnected.lost_at``), the reconnect
    window. ``ensure_deps`` (SLC-10) is called once the address is accepted and before the transport starts; it
    returns a :class:`~remoteview_core.deps.DepsResult` (it may show dialogs and block while pip runs). Without it
    nothing is installed or checked. ``scene`` returns the scene the snapshots are made of. ``watch(live)`` returns the
    :class:`Watcher` that marks the scene's changes on ``live``; ``flush_timer`` is the single-shot timer whose
    timeout calls :meth:`flush_live`. ``watch`` needs both (marks that are never flushed would freeze the viewers
    silently).
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
        flush_timer: Timer | None = None,
        watch: Callable[[LiveUpdates], Watcher] | None = None,
        wall: Callable[[], float] = time.time,
    ) -> None:
        if watch is not None and (scene is None or flush_timer is None):
            raise ValueError("watch needs a scene factory and a flush_timer")
        self._slicer_version = slicer_version
        self._platform = platform
        self.profile = profile
        self._factory = transport_factory
        self._clock = clock
        self._wall = wall
        self._scene_factory = scene
        self._ensure_deps = ensure_deps
        self._flush_timer: Timer = flush_timer if flush_timer is not None else _NoTimer()
        self._watch = watch
        self._live: LiveUpdates | None = None
        self._watcher: Watcher | None = None
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
        self._ended_reconnecting = False  # the panel ended the session while reconnecting
        self._was_live = False
        # session.expired/closed arrived while our session.close was on its way
        self._relay_ended = False
        self._ca_note = ""
        # clock() by which session.created or session.resumed must arrive (while connecting or reconnecting)
        self._answer_deadline: float | None = None
        self._forget_outage()
        self._scene = ""  # the SCENE_STATES key while no live updates run: "", or "failed" if going live failed
        # why the scene cannot go out now (a fixed text), "" when nothing is wrong
        self._problem = ""
        self._too_large = False  # the problem is the scene's size
        self._notes = ""  # what the last snapshot sent left out (skipped models, budgets)
        self._accepted = False  # the relay acknowledged a snapshot of this session

    @property
    def observer_count(self) -> int:
        """The observers the current watcher has added (its own bookkeeping; 0 without one)."""
        return self._watcher.observer_count if self._watcher is not None else 0

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
        self._connection, self._end_detail, self._answer_deadline = None, "", None
        self._forget_outage()
        self._user_stopped = self._sent_final = self._was_live = self._relay_ended = False
        self._ended_reconnecting = False
        self._scene, self._problem, self._too_large, self._notes = "", "", False, ""
        self._accepted = False
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
        client = self._client
        # offline nothing can carry session.close: the relay keeps the session until its grace ends
        offline = (
            self.phase is Phase.RECONNECTING
            and client is not None
            and client.state is SessionState.GRACE
        )
        self._finish(STOPPED_OFFLINE if offline else "")
        return self.view

    def shutdown(self, timeout: float = SHUTDOWN_TIMEOUT_S) -> bool:
        """Module cleanup: like :meth:`stop`, but waits up to ``timeout`` s for the transport to end. The transport is
        stopped and the panel left idle even when the close or the stop raises (the error still propagates); when this
        call's close or its first ``stop()`` raised, a plain ``session.close`` goes with the last ``stop()``, so the
        relay frees the code at once rather than after its grace (T1)."""
        if self._transport is None:
            return True
        transport, ended, handed_over = self._transport, False, False
        try:
            if self.phase is not Phase.STOPPING:
                self._finish("")
            handed_over = True  # this call ended the session without raising, or a Stop did before
        finally:
            self._transport = None
            fallback = None
            if not handed_over and self._connection is not None:
                fallback = envelope("session.close", reason="USER_STOPPED")
            try:
                # only the first stop()'s final message counts: a second one waits
                ended = bool(transport.stop(fallback, timeout=timeout))
            finally:
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
        deadline = self._answer_deadline
        waiting = self.phase in (Phase.CONNECTING, Phase.RECONNECTING)
        if waiting and deadline is not None and self._clock() >= deadline:
            self._finish(NO_ANSWER if self.phase is Phase.CONNECTING else RESUME_NO_ANSWER)
        elif self.phase is Phase.RECONNECTING and self._connection is None and self._window_over():
            self._give_up()
        if self.phase is Phase.LIVE:
            self._tick_live()
        # the tick may have ended the session (a closed scene not cleared, §7.3)
        if self.phase is Phase.LIVE:
            self._show_live()  # timer-driven changes show within one pump
        return self.view

    def flush_live(self) -> None:
        """The flush timer fired (the adapter's slot): the changes marked since the last flush go out."""
        live = self._live
        if live is None:  # a timeout posted after Stop
            return
        live.flush()  # catches everything, logs the type only (T7)
        if self.phase is Phase.LIVE:
            self._show_live()

    # ------------------------------------------------------------------ transport events

    def _on_connected(self, event: Connected) -> None:
        client = self._client
        if client is None or self.phase not in (Phase.CONNECTING, Phase.RECONNECTING):
            return
        self._connection = event.connection
        if self.phase is Phase.RECONNECTING:
            self._resume(client)
        elif client.state in (SessionState.IDLE, SessionState.CLOSED):
            self._send(client.start(self.profile))
            self._answer_deadline = self._clock() + CREATE_TIMEOUT_S
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
        # an ack's (or a resume's) held updates go out first (§6.2)
        for reply in client.handle(message):
            self._send(reply)
        if client.state in (SessionState.CREATED, SessionState.ACTIVE):
            if self.phase is Phase.RECONNECTING:
                self._back_live(client)
            elif self.phase is not Phase.LIVE:
                self.phase = Phase.LIVE
                self._was_live = True
                self._go_live(client)
            else:
                self._observe_live()  # an ack, a refusal, an error answering an update; may end the session
            # otherwise a status would overwrite "Stopping…" after a refused reset
            if self.phase is Phase.LIVE:
                self._show_live()
        elif client.state is SessionState.CLOSED:
            # session.expired/closed, a refused create, a fatal error (§9.2). After a fatal error the relay may keep
            # the socket and the session (§11): a live session is closed explicitly, so its code is freed at once.
            fatal = self.phase is Phase.LIVE and message.get("type") == "error"
            close = envelope("session.close", reason="USER_STOPPED") if fatal else None
            self._finish(self._reason_text(client.close_reason), close)

    def _on_disconnected(self, event: Disconnected) -> None:
        client, retry_in = self._client, event.retry_in
        if retry_in is None:  # the transport has ended for good
            self._transport = None
            if self.phase is Phase.STOPPING:
                detail = self._stopped_detail(event)
            elif client is not None:
                detail = self._ended_detail(client, event)
            else:
                detail = self._end_detail
            if self._user_stopped:
                status = SESSION_ENDED if detail else NOT_CONNECTED
            else:
                status = SESSION_ENDED if self._was_live else CANNOT_START
            self._idle(status, detail)
        elif client is not None and self.phase is not Phase.STOPPING:
            self._on_connection_lost(client, event, retry_in)

    def _stopped_detail(self, event: Disconnected) -> str:
        """Why a session the panel stopped ended, and whether the relay may still hold it (its close was lost)."""
        detail = self._end_detail
        if self._sent_final and not event.final_sent and not self._relay_ended:
            if self._user_stopped:
                return FINAL_NOT_SENT
            # ended while reconnecting (e.g. a resume left unanswered): the relay may still hold it (§9.1)
            if self._ended_reconnecting:
                return "\n".join(part for part in (detail, RELAY_HOLDS_SESSION) if part)
        return detail

    def _ended_detail(self, client: ProtocolClient, event: Disconnected) -> str:
        """The transport stopped by itself (certificate, proxy, HTTP status, close code): why, for the panel."""
        reconnecting = self.phase is Phase.RECONNECTING
        client.transport_lost(event.close_code)
        self._observe_live()
        reason = client.close_reason if client.state is SessionState.CLOSED else None
        if client.state is not SessionState.CLOSED:
            client.close()  # nothing can be sent any more; forget the token and the code
        mapped = self._reason_text(reason) if reason not in (None, "CONNECT_FAILED") else ""
        detail = mapped or (event.error.guidance if event.error is not None else "")
        if reconnecting and reason is None:  # the relay still holds the session (§9.1)
            detail = "\n".join(part for part in (detail, RELAY_HOLDS_SESSION) if part)
        return detail

    def _on_connection_lost(
        self, client: ProtocolClient, event: Disconnected, retry_in: float
    ) -> None:
        """The transport retries: before the session exists a new ``session.create`` follows; after, a resume."""
        # CREATED/ACTIVE/RESUMING → GRACE (§9.1); a create left unanswered → CLOSED, sent again on the next connection
        client.transport_lost(event.close_code)
        self._observe_live()  # the marks are held; a snapshot in flight is lost (§6.3, SLC-35)
        self._connection, self._answer_deadline = None, None
        guidance = event.error.guidance if event.error is not None else ""
        if self.phase is Phase.CONNECTING:
            retrying = f"Relay unreachable — retrying in {retry_seconds(retry_in)} s."
            self._show(retrying, detail=guidance)
            return
        if self.phase is Phase.LIVE:  # the first drop of this outage
            self.phase = Phase.RECONNECTING
            # from when the transport lost the connection: before the wake if the computer slept (SLC-41)
            now, wall = self._clock(), self._wall()
            age = 0.0 if event.lost_at is None else max(0.0, wall - event.lost_at)
            self._lost_at, self._lost_wall = now - age, wall - age
            # a backward step counts from here: a dated loss must not widen its tolerance
            self._handled_wall = wall
            ttl: Any = client.ttl  # set by session.created, checked there
            self._grace_s = float(ttl["graceS"])
            self._window_s = min(self._grace_s, MAX_GRACE_S) + RECONNECT_SLACK_S
        # sticky for the outage: a refused retry after it does not make it a plain loss
        self._restart_seen = self._restart_seen or event.close_code == RESTART_CLOSE_CODE
        status = RESTARTING_IN if self._restart_seen else RECONNECTING_IN
        self._reconnect_status = status.format(seconds=retry_seconds(retry_in))
        self._guidance = guidance
        self._show_reconnecting()

    # ------------------------------------------------------------------ reconnecting (SLC-37)

    def _forget_outage(self) -> None:
        """No connection lost, or the session is back: no window, restart or resume flag, status or guidance."""
        self._lost_at = self._lost_wall = self._handled_wall = self._window_s = self._grace_s = 0.0
        self._restart_seen = self._resume_sent = False
        self._reconnect_status = self._guidance = ""

    def _window_over(self) -> bool:
        """The reconnect window has passed on either clock, or the wall clock went back by more than a correction."""
        wall = self._wall()
        return (
            max(self._clock() - self._lost_at, wall - self._lost_wall) >= self._window_s
            or wall - self._handled_wall < -WALL_JUMP_TOLERANCE_S
        )

    def _resume(self, client: ProtocolClient) -> None:
        """A new connection while reconnecting: ``session.resume`` first (§4.3), unless the window is over (T1)."""
        if self._window_over():
            self._give_up()
            return
        self._send(client.resume())
        # the relay may hold the session again from here: its grace starts over when this socket is lost
        self._resume_sent = True
        self._answer_deadline = self._clock() + CREATE_TIMEOUT_S
        # connected: the failure's guidance is past
        self._reconnect_status, self._guidance = RECONNECTING, ""
        self._show_reconnecting()

    def _give_up(self) -> None:
        """The reconnect window is over: the session ends and nothing is sent (T1). Not even ``session.close``: on a
        new socket it would be bound to no session (the first message is ``session.create`` or ``session.resume``,
        §3.1, §11), and a resume first would send the token after the window. The relay has ended the session by now;
        the text warns when it may not have: it keeps sessions longer than RemoteView waits, a resume went out in this
        outage (if it reached the relay, its grace starts over when that socket is lost), or the window ended only
        because the wall clock went back. A forward step reads as a sleep; a restarted relay (4008) keeps no session
        (§13 step 9)."""
        _log.info("panel: reconnect window over")
        # the window has not passed on either clock: it ended because the wall clock went back
        early = max(self._clock() - self._lost_at, self._wall() - self._lost_wall) < self._window_s
        if self._restart_seen:
            warning = ""
        elif self._grace_s > MAX_GRACE_S:
            warning = RELAY_HOLDS_SESSION_LONGER
        elif self._resume_sent or early:
            warning = RELAY_HOLDS_SESSION
        else:
            warning = ""
        self._finish("\n".join(part for part in (RECONNECT_GAVE_UP, warning) if part))

    def _back_live(self, client: ProtocolClient) -> None:
        """``session.resumed``: the same session goes on, with the same live updates and observers (§4.3)."""
        if client.versions.last >= LAST_SCENE_VERSION:
            # no version left for the owed snapshot (§8.4): the relay's sceneVersion cannot be ours
            self._finish(PROTOCOL_VIOLATION)
            return
        self.phase = Phase.LIVE
        self._forget_outage()
        self._observe_live()  # leaves the pause: an owed snapshot goes from the next tick or flush (SLC-35)

    def _show_reconnecting(self) -> None:
        client: Any = self._client  # never None while reconnecting
        # after a 4008 the relay keeps no session: the code may be free until the session is created again (T4)
        detail = "" if self._restart_seen else RECONNECT_DETAIL
        parts = (self._ca_note, self._guidance, detail)
        self._show(
            self._reconnect_status, detail="\n".join(p for p in parts if p), code=client.code or ""
        )

    # ------------------------------------------------------------------ helpers

    def _send(self, message: dict[str, Any] | bytes) -> None:
        if self._transport is not None and self._connection is not None:
            self._transport.send(message, connection=self._connection)

    def _discard_queued(self) -> None:
        """The relay ignores the rest of a refused or superseded snapshot (§6.2): do not spend the uplink on it."""
        if self._transport is not None and self._connection is not None:
            self._transport.discard_queued(connection=self._connection)

    # ------------------------------------------------------------------ the live scene (SLC-32)

    def _go_live(self, client: ProtocolClient) -> None:
        """The session was created: :class:`~remoteview_core.live.LiveUpdates` sends the first snapshot and, with a
        ``watch`` factory, the observers follow the scene from this same main-thread call (no MRML event can fall in
        between). A batch process running now holds the first snapshot until it ends (the watcher's hold at
        ``attach()``). When the scene cannot be followed, nothing is sent: the user agreed to a scene that follows
        Slicer, and viewers cannot see a publisher's note that it stopped."""
        self._stop_live()  # never two sets of observers
        if self._scene_factory is None:
            return
        watching = False  # true while the watch factory or attach() runs
        try:
            live = self._live = LiveUpdates(
                client,
                scene=self._scene_factory,
                send=self._send,
                discard_queued=self._discard_queued,
                timer=self._flush_timer,
                clock=self._clock,
                slicer_version=self._slicer_version,
                end_session=self._end_live,
                on_event=self._on_live_event,
            )
            if self._watch is not None:
                watching = True
                # before start: a factory that fails has asked for nothing
                self._watcher = self._watch(live)
                watching = False
            live.start(deferred=True)  # running: the watcher's batch hold counts from here
            if self._watcher is not None:
                watching = True
                self._watcher.attach()
        except Exception as exc:  # noqa: BLE001 — the adapter's or MRML's text may carry a node ID (T7: type only)
            what = "changes not followed" if watching else "live updates not started"
            _log.error("scene: %s (%s)", what, type(exc).__name__)
            self._stop_live()  # detach() is idempotent; stop() drops a hold attach() gave
            self._scene = "failed"
            self._problem = OBSERVE_FAILED if watching else f"{SCENE_FAILED} {RESTART}"
            return
        live.tick()  # the first snapshot, unless a batch holds it

    def _tick_live(self) -> None:
        live, watcher = self._live, self._watcher
        if live is None:
            return
        # an event off the main thread marked nothing (SLC-33): the watcher re-lists the models first (never raises),
        # then the batch hold follows Slicer's again and a snapshot re-syncs the viewers
        if watcher is not None and watcher.take_off_thread():
            live.request_resync(batch=watcher.batch_processing())
        live.tick()

    def _observe_live(self) -> None:
        if self._live is not None:
            self._live.observe()  # never raises

    def _stop_live(self) -> None:
        """Remove the observers and stop the live updates; never raises, and a second call does nothing."""
        watcher, self._watcher = self._watcher, None
        live, self._live = self._live, None
        if watcher is not None:
            try:
                watcher.detach()
            except Exception as exc:  # noqa: BLE001 — MRML's text may carry a node ID (T7)
                _log.error("scene: observers not removed (%s)", type(exc).__name__)
        if live is not None:
            try:
                live.stop()  # the debouncer stops the flush timer and drops the holds and marks
            except Exception as exc:  # noqa: BLE001
                _log.error("scene: live updates not stopped (%s)", type(exc).__name__)

    def _end_live(self, text: str) -> None:
        """``end_session`` of the live updates: a closed scene could not be cleared off the viewers (§7.3).
        :meth:`_finish` queues the close before any text is built, so a text that fails cannot keep the session."""
        if self.phase is Phase.LIVE:
            self._finish(text)

    def _on_live_event(self, event: LiveEvent) -> None:
        """Called inside ``LiveUpdates`` (which logs the type of anything raised here): fields and texts only."""
        kind = event.kind
        if kind is LiveEventKind.SENT:
            snapshot = event.snapshot
            self._problem, self._too_large = "", False
            if snapshot is None:
                self._notes = ""
            else:
                notes = (skipped_text(len(snapshot.skipped)), budget_text(snapshot))
                self._notes = " ".join(text for text in notes if text)
        elif kind is LiveEventKind.ACKED:
            self._accepted = True
            # an acknowledged empty reset snapshot keeps its problem
            if self._live is None or not self._live.owed:
                self._problem, self._too_large = "", False
        elif kind is LiveEventKind.REFUSED:
            self._problem = scene_refused_text(event.code)
            self._too_large = event.code == "PAYLOAD_TOO_LARGE"
        elif kind is LiveEventKind.TOO_LARGE and event.too_large is not None:
            self._problem, self._too_large = scene_too_large_text(event.too_large), True
        elif kind is LiveEventKind.FAILED:
            self._problem, self._too_large = SCENE_FAILED, False

    def _scene_state(self) -> tuple[str, str]:
        """``(SCENE_STATES key, detail)`` now; the controller's flags are read here only (a ``REFUSED`` event comes
        before the refusal sets its gate)."""
        live = self._live
        if live is None:
            return self._scene, self._problem
        if self._problem:
            state = "stale" if self._accepted else "failed"
            return state, f"{self._problem} {self._next_step(live)}"
        if live.in_flight or live.owed:
            state = "updating" if self._accepted else "sending"
        else:
            state = "live" if self._accepted else "sending"
        waiting = live.batch_held and live.owed and not live.in_flight
        return state, WAITING_FOR_SLICER if waiting else self._notes

    def _next_step(self, live: LiveUpdates) -> str:
        """What happens next: only a followed change can open the too-large and the flush gates."""
        follows = self._watcher is not None
        if self._too_large:
            return HIDE_MODELS if follows else HIDE_MODELS_AND_RESTART
        if live.waits_for_change:
            return RETRY_ON_CHANGE if follows else RESTART
        return RETRY_LATER

    def _show_live(self) -> None:
        client: Any = self._client  # never None while LIVE (the only callers)
        scene, detail = self._scene_state()
        # the extra-CA note stays next to a scene message (T5)
        self._show(
            viewers_text(client.viewer_count, scene),
            detail="\n".join(part for part in (self._ca_note, detail) if part),
            code=client.code or "",
        )

    # ------------------------------------------------------------------ the session's end and the view

    def _finish(self, detail: str, close: dict[str, Any] | None = None) -> None:
        """End the session: ``session.close`` while a socket can carry it, then stop the transport (non-blocking).
        ``close`` is that message when the client has none any more (it closed itself on a relay error)."""
        client = self._client
        try:
            final = (client.close() if client is not None else None) or close
            self._sent_final = final is not None and self._connection is not None
            self._end_detail = detail
            self._ended_reconnecting = self.phase is Phase.RECONNECTING
            self.phase = Phase.STOPPING
            if self._transport is not None:
                self._transport.stop(final if self._sent_final else None, timeout=0)
        finally:
            self._stop_live()  # after the close is queued, and even if the close or the stop raised
        try:
            self._show(STOPPING)
        except Exception as exc:  # noqa: BLE001 — the session is closing; a text must not undo that (T7)
            _log.error("scene: panel not updated (%s)", type(exc).__name__)

    def _reason_text(self, reason: str | None) -> str:
        """:func:`end_text`, except for the reasons :data:`RECONNECT_END_REASONS` explains while reconnecting."""
        if self.phase is Phase.RECONNECTING and reason in RECONNECT_END_REASONS:
            return RECONNECT_END_REASONS[reason]
        return end_text(reason)

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
        note = self._ca_note if phase in _RUNNING else ""
        shown = phase in _SHOWS_CODE
        link, link_note = self._join_link(code) if shown else ("", "")
        self.view = PanelView(
            status=status,
            detail="\n".join(part for part in (detail or note, link_note) if part),
            code=code if shown else "",
            link=link,
            start_enabled=phase is Phase.IDLE,
            stop_enabled=phase in _RUNNING,
            settings_enabled=phase is Phase.IDLE,
        )
        return self.view

    def _idle(self, status: str, detail: str = "") -> PanelView:
        self._stop_live()  # a transport that ended by itself
        self.phase = Phase.IDLE
        self._client = None
        self._connection = None
        return self._show(status, detail=detail)
