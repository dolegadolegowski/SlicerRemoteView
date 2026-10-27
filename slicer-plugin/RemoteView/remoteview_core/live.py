"""Live scene changes during a session (SLC-29; protocol §6.2, §7.3, §8; FR-11, FR-12, NFR-02; T2, T7).

:class:`LiveUpdates` turns the marks of the Slicer observers (SLC-31) into what the viewers need, and owns every export
of the session, the first snapshot included:

- **marks** (:meth:`~LiveUpdates.mark`, :meth:`~LiveUpdates.mark_transform`) go to SLC-15's
  :class:`~remoteview_core.debounce.Debouncer`; its flush is classified by SLC-30's
  :func:`~remoteview_core.changes.classify` against :attr:`~LiveUpdates.sent` (what the viewers hold) and sent with
  SLC-16's client — an update plan as ``scene.update``/``scene.nodeRemoved``, a re-export as ``scene.nodeAdded`` and a
  new snapshot whose scene becomes :attr:`~LiveUpdates.sent` in the same call (``changes.py``'s contract);
- **holds**: the debouncer is held during a batch process (its own count, so a stray ``release`` cannot end another
  hold), from each snapshot's ``begin`` until its ack, refusal or loss — marks made meanwhile flush once after it,
  never as a second ``begin`` (no supersede: a slow uplink must finish its upload, T2) — and while the connection is
  lost (``GRACE``/``RESUMING``);
- **reset** (a closed scene, §7.3): the only supersede. The queued chunks of a snapshot in flight are dropped and the
  new scene's snapshot begins at the flush, whatever the pacing. When it cannot be built, an empty snapshot clears the
  closed scene off the viewers and the scene stays owed; when that fails too, when a frame of it cannot be sent, or
  when the relay refuses the reset's snapshot, the session ends (``end_session``) — the closed scene may be another
  patient's;
- **pacing** (T2, the SLC-16 review): a snapshot owed after a failure goes out from :meth:`~LiveUpdates.tick` when its
  gate opens. ``PAYLOAD_TOO_LARGE`` of a snapshot and a local :class:`~remoteview_core.snapshot.SnapshotTooLargeError`
  wait for a change that can shrink the export (a model hidden or removed, a mesh changed, a reset) or
  :meth:`~LiveUpdates.request_snapshot`; ``BAD_SEQUENCE``, ``INVALID_MESSAGE``, ``PAYLOAD_TOO_LARGE`` of an update, the
  relay's ``maxTextBytes`` and a lost connection re-sync — at once the first time and when the previous re-sync was
  acknowledged at least :data:`RESYNC_QUIET_S` before, after the back-off otherwise; every other code waits
  ``min(max(retryAfterS, back-off), 600 s)`` and local failures the back-off (2, 4, 8 … 60 s; the streak restarts when
  the first failure after an ack comes :data:`STREAK_RESET_S` later). After :data:`FAILURES_BEFORE_FLUSH_GATE` refusals
  or local failures without an ack an attempt also waits for a flush, so a refusal that repeats costs at most one
  upload per change (a lost connection neither counts nor closes it). Updates stay held while a snapshot is owed
  (``ProtocolClient.require_snapshot``);
- *Hide node names* and the device profile have no MRML event: :meth:`~LiveUpdates.set_anonymize_names` and
  :meth:`~LiveUpdates.request_snapshot` (SLC-18) ask for a snapshot.

The panel (SLC-32) calls :meth:`~LiveUpdates.observe` after every relay message and connection loss and
:meth:`~LiveUpdates.tick` from its pump; the flush timer calls :meth:`~LiveUpdates.flush`. ``IDLE``/``CLOSED`` stop the
controller: the marks are dropped and later ones ignored.

Privacy (T7): every method the observers, the flush timer or the pump call (the marks, ``hold``/``release``,
``reset``, :meth:`~LiveUpdates.observe`, :meth:`~LiveUpdates.tick`, :meth:`~LiveUpdates.flush`) catches ``Exception``
and logs its type only — exception texts often quote a node ID or name; so do the panel's ``start``, and the calls into
the panel (``send``, ``discard_queued``, ``end_session``, ``on_event``). Reprs and :class:`LiveEvent` show counts and
error codes only. ``end_session`` must close the session even if the panel's texts fail: after a refused reset it is
what keeps the closed scene off the viewers (§7.3). Main thread only (MRML, the client).
"""

from __future__ import annotations

import enum
import logging
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from remoteview_core.changes import Plan, SceneReadError, SentScene, classify
from remoteview_core.collect import SceneApi
from remoteview_core.debounce import Change, Debouncer, Drained, Timer
from remoteview_core.protocol_client import ProtocolClient, ProtocolStateError, SessionState
from remoteview_core.snapshot import Snapshot, SnapshotTooLargeError, build_snapshot

_log = logging.getLogger(__name__)

#: Back-off of successive failures: 2, 4, 8 … s, at most 60 s.
BACKOFF_FIRST_S = 2.0
BACKOFF_MAX_S = 60.0
#: The longest wait a relay's ``details.retryAfterS`` can impose.
RETRY_AFTER_MAX_S = 600.0
#: A re-sync goes out at once only if the previous one was acknowledged at least this long ago.
RESYNC_QUIET_S = 10.0
#: A failure this long after the last ack starts a new back-off streak.
STREAK_RESET_S = 60.0
#: After this many failures without an ack, an attempt also waits for a flush (a change in Slicer).
FAILURES_BEFORE_FLUSH_GATE = 3

#: Why the session ends (fixed texts for the panel; §7.3: a closed scene must not stay on the viewers).
RESET_NOT_SENT = "The scene was closed, but RemoteView could not clear it on the viewers, so the session was stopped."
RESET_REFUSED = (
    "The scene was closed, but the relay refused the new scene, so the session was stopped to keep the closed "
    "scene off the viewers."
)

_LIVE = (SessionState.CREATED, SessionState.ACTIVE)
_PAUSED = (SessionState.GRACE, SessionState.RESUMING)
#: Codes that ask for a re-sync (§8.1, §9.2); ``PAYLOAD_TOO_LARGE`` re-syncs when it answers an update.
_RESYNC_CODES = frozenset({"BAD_SEQUENCE", "INVALID_MESSAGE"})
#: Marks after which an export refused as too large may be smaller.
_SHRINKING = Change.GEOMETRY | Change.REMOVED


class LiveEventKind(enum.Enum):
    SENT = "sent"  # a snapshot began (its frames are on their way)
    ACKED = "acked"  # the relay acknowledged it
    REFUSED = "refused"  # the relay refused it (``code``)
    TOO_LARGE = "too-large"  # an export over the relay's limit (``too_large``); nothing was sent
    FAILED = "failed"  # a scene read or an export failed; nothing was sent


@dataclass(frozen=True)
class LiveEvent:
    """What happened to the scene, for the panel's texts (SLC-32). ``code`` has the shape of a §9.2 code, possibly one
    this version does not know: map it to a fixed text, never show it raw."""

    kind: LiveEventKind
    snapshot: Snapshot | None = field(default=None, repr=False)
    code: str | None = None
    too_large: SnapshotTooLargeError | None = field(default=None, repr=False)

    def __repr__(self) -> str:  # a Snapshot's repr lists skipped node IDs (T7)
        return f"LiveEvent(kind={self.kind.value}, code={self.code})"


class _Cause(enum.Enum):
    TOO_LARGE = enum.auto()
    BUSY = enum.auto()
    RESYNC = enum.auto()
    LOCAL = enum.auto()
    LOST = enum.auto()  # the connection: a re-sync, but not a refusal (it never waits for a change)


class _EmptyScene:
    """A scene without nodes (all :func:`~remoteview_core.collect.collect_scene` asks of it): the empty snapshot after
    a reset."""

    def visible_model_nodes(self) -> list[Any]:
        return []


def _retry_after(details: Any) -> float | None:
    """``details.retryAfterS`` when it is a finite positive number (relay input: anything else is ignored)."""
    value = details.get("retryAfterS") if isinstance(details, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):  # a JSON integer beyond the double range would not convert
        value = min(value, int(RETRY_AFTER_MAX_S))
    return float(value) if math.isfinite(value) and value > 0 else None


class LiveUpdates:
    """One session's live scene (see the module docstring). Nothing runs before :meth:`start`."""

    def __init__(  # noqa: PLR0913 — keyword-only collaborators, injected for tests
        self,
        client: ProtocolClient,
        *,
        scene: Callable[[], SceneApi],
        send: Callable[[dict[str, Any] | bytes], object],
        discard_queued: Callable[[], object],
        timer: Timer,
        clock: Callable[[], float],
        slicer_version: str,
        end_session: Callable[[str], object],
        anonymize_names: bool = False,
        on_event: Callable[[LiveEvent], object] = lambda event: None,
        export: Callable[..., Snapshot] = build_snapshot,
    ) -> None:
        self._client = client
        self._scene = scene
        self._send = send
        self._discard_queued = discard_queued
        self._clock = clock
        self._slicer_version = slicer_version
        self._end_session = end_session
        self._anonymize = bool(anonymize_names)
        self._on_event = on_event
        self._export_fn = export
        self._debouncer = Debouncer(timer, self._on_flush, clock)
        self._running = False
        self._forget_session()

    def _forget_session(self) -> None:
        self._sent = SentScene(anonymized=self._anonymize)
        self._inflight: int | None = None  # sceneVersion of our snapshot in flight
        self._inflight_hold = False
        self._paused = False  # the pause hold (GRACE/RESUMING) is on
        self._depth = 0  # batch holds
        self._reset_owed = False  # a closed scene may still be on the viewers
        self._seen_error: Any = None  # the client's last_error already attributed
        self._needed_seen = False  # the current snapshot_needed has its gate
        # the gate of an owed snapshot
        self._shrink: frozenset[Any] | None = None  # too large: the IDs shown at the failure
        self._until = 0.0
        self._needs_flush = False
        self._streak = 0
        self._unacked = 0
        self._last_ack: float | None = None
        self._failed_since_ack = False
        self._resynced = False
        self._resync_acked_at: float | None = None

    def __repr__(self) -> str:  # counts only (T7)
        return (
            f"LiveUpdates(running={self._running}, nodes={len(self._sent)}, "
            f"in_flight={self._inflight is not None}, batch={self._depth}, paused={self._paused})"
        )

    @property
    def running(self) -> bool:
        return self._running

    @property
    def sent(self) -> SentScene:
        """What the viewers hold (the scene of the last export, with every change sent since)."""
        return self._sent

    # ------------------------------------------------------------------ the observers (SLC-31); never raise

    def mark(self, node_id: str, flags: Change) -> None:
        """A node changed (an ID or flags of another type, empty ones, or marks while stopped are ignored)."""
        if not self._running or not isinstance(node_id, str) or not node_id:
            return
        if not isinstance(flags, Change) or not flags:
            return
        try:
            self._debouncer.mark(node_id, flags)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark failed (%s)", type(exc).__name__)

    def mark_transform(self, node_id: str) -> None:
        """A node's world transform may have changed: ``geometry`` for a node the viewers hold baked (only a re-export
        shows it, FR-12's slow lane), ``transform`` for every other one — a node the export left out too, which a
        ``geometry`` mark would always re-export (SLC-30 review)."""
        if not self._running or not isinstance(node_id, str) or not node_id:
            return
        held = self._sent.get(node_id)
        self.mark(
            node_id,
            Change.GEOMETRY if held is not None and held.matrix is None else Change.TRANSFORM,
        )

    def hold(self) -> None:
        """``StartBatchProcessEvent``."""
        if not self._running:
            return
        self._depth += 1
        try:
            self._debouncer.hold()
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: hold failed (%s)", type(exc).__name__)

    def release(self) -> None:
        """``EndBatchProcessEvent``; one without its ``hold`` is ignored."""
        if not self._running or self._depth == 0:
            return
        self._depth -= 1
        try:
            self._debouncer.release()
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: release failed (%s)", type(exc).__name__)

    def reset(self) -> None:
        """``EndCloseEvent``: the scene was closed. A snapshot in flight shows the closed scene: its queued chunks are
        dropped, and the new scene's ``begin`` supersedes it at the flush (§6.2)."""
        if not self._running:
            return
        try:
            self._reset_owed = True
            # no update may address a closed scene's ID, which the next scene may reuse (§7.3)
            self._sent.apply(Plan(snapshot=True, reset=True))
            if self._inflight is not None:
                self._discard()
                self._end_inflight()
            self._debouncer.reset()
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: reset failed (%s)", type(exc).__name__)

    # ------------------------------------------------------------------ the panel

    def start(self) -> None:
        """The session was created: send the first snapshot. Raises ``ProtocolStateError`` unless the client is
        ``CREATED``/``ACTIVE`` (a caller's bug); a second call does nothing."""
        if self._running:
            return
        if self._client.state not in _LIVE:
            raise ProtocolStateError(f"cannot send the scene in state {self._client.state.value}")
        self._forget_session()
        self._running = True
        self._seen_error = self._client.last_error
        try:
            self._export(None)
        except Exception as exc:  # noqa: BLE001 — the transport refused a frame (T7: type only)
            _log.error("live: scene not sent (%s)", type(exc).__name__)
            self._not_sent()

    def stop(self) -> None:
        """The session ended (or Stop): drop the marks; later calls do nothing until :meth:`start`."""
        self._running = False
        self._debouncer.stop()
        self._forget_session()

    def observe(self) -> None:
        """After every relay message and connection loss: follow the snapshot in flight and new causes."""
        if not self._running:
            return
        try:
            self._observe()
        except Exception as exc:  # noqa: BLE001 — called from the pump (T7)
            _log.error("live: relay event not followed (%s)", type(exc).__name__)

    def tick(self) -> None:
        """From the pump: send an owed snapshot once its gate opens."""
        if not self._running:
            return
        try:
            self._observe()
            if self._running and self._may_export():
                self._export(None)
        except Exception as exc:  # noqa: BLE001 — called from the pump (T7)
            _log.error("live: scene not sent (%s)", type(exc).__name__)
            if self._running:
                self._not_sent()

    def flush(self) -> None:
        """The flush timer fired."""
        try:
            self._debouncer.flush()
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("live: flush failed (%s)", type(exc).__name__)

    def set_anonymize_names(self, on: bool) -> None:
        """*Hide node names* changed: the viewers' names and IDs need a new snapshot."""
        if bool(on) == self._anonymize:
            return
        self._anonymize = bool(on)
        self.request_snapshot()

    def request_snapshot(self) -> None:
        """Send the scene again (a new device profile, *Hide node names*): lifts the too-large and flush gates, not a
        wait the relay asked for."""
        if not self._running:
            return
        self._client.require_snapshot()
        self._needed_seen = True
        self._shrink = None
        self._needs_flush = False

    # ------------------------------------------------------------------ flush

    def _on_flush(self, drained: Drained) -> None:
        if not self._running or self._client.state not in _LIVE:
            return  # a snapshot is owed anyway: its export installs a new viewers' scene
        try:
            self._apply_flush(drained)
        except Exception as exc:  # noqa: BLE001 — T7: the type only
            _log.error("live: changes not sent (%s)", type(exc).__name__)
            if self._running:
                self._not_sent()
        self.tick()

    def _apply_flush(self, drained: Drained) -> None:
        self._needs_flush = False  # a change after the failures
        if self._reset_owed and not drained.reset:
            # a reset whose flush was dropped while the session was not live
            drained = Drained(drained.changes, reset=True)
        self._reset_owed = drained.reset
        if self._shrink is not None and self._shrinks(drained):
            self._shrink = None
        try:
            plan = classify(drained, self._scene(), self._sent, anonymize_names=self._anonymize)
        except SceneReadError:
            _log.error("live: scene not read (SceneReadError)")
            self._failed(_Cause.LOCAL)
            self._emit(LiveEventKind.FAILED)
            return
        if not self._running:
            return
        if plan.snapshot:
            self._sent.apply(plan)  # a reset forgets the closed scene before its export
            if self._reset_owed or self._gate_open():
                self._export(plan)
            else:
                self._client.require_snapshot()
                self._needed_seen = True
            return
        # a change the relay's maxTextBytes cannot carry sets snapshot_needed: the tick that follows makes it a re-sync
        for message in self._client.send_changes(plan.changes):
            self._send(message)
        for message in self._client.send_removed(plan.removed):
            self._send(message)
        self._sent.apply(plan)  # a held result counts as sent: the next snapshot drops it

    def _shrinks(self, drained: Drained) -> bool:
        """The flush may make an export refused as too large smaller."""
        if drained.reset or any(flags & _SHRINKING for flags in drained.changes.values()):
            return True
        shown = self._shown_ids()
        return shown is not None and bool(self._shrink - shown)

    def _shown_ids(self) -> frozenset[Any] | None:
        """The IDs of the nodes the 3D view shows (a light read: no mesh), or ``None`` when they cannot be read."""
        try:
            scene = self._scene()
            return frozenset(scene.node_id(node) for node in scene.visible_model_nodes())
        except Exception:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
            return None

    # ------------------------------------------------------------------ exports

    def _may_export(self) -> bool:
        client = self._client
        if client.state not in _LIVE or not (client.snapshot_needed or self._reset_owed):
            return False
        if self._inflight is not None or self._depth or self._paused or self._debouncer.pending:
            return False  # a pending flush classifies first (a reset's plan announces its nodes)
        return self._reset_owed or self._gate_open()

    def _gate_open(self) -> bool:
        return self._shrink is None and not self._needs_flush and self._clock() >= self._until

    def _export(self, plan: Plan | None) -> None:
        """Build the snapshot and send it, or record why not."""
        reset = self._reset_owed
        try:
            snapshot = self._build(self._scene(), plan.added if plan is not None else ())
        except SnapshotTooLargeError as exc:
            if reset:
                self._empty(_Cause.TOO_LARGE, exc)
            else:
                self._failed(_Cause.TOO_LARGE)
                self._emit(LiveEventKind.TOO_LARGE, too_large=exc)
            return
        except Exception as exc:  # noqa: BLE001 — a scene that cannot be exported (T7: type only)
            _log.error("live: scene not exported (%s)", type(exc).__name__)
            if reset:
                self._empty(_Cause.LOCAL)
            else:
                self._failed(_Cause.LOCAL)
                self._emit(LiveEventKind.FAILED)
            return
        self._install(snapshot)

    def _build(self, scene_api: SceneApi, announce: Iterable[tuple[str, str]]) -> Snapshot:
        return self._export_fn(
            scene_api,
            self._client,
            slicer_version=self._slicer_version,
            anonymize_names=self._anonymize,
            announce=announce,
        )

    def _empty(self, cause: _Cause, too_large: SnapshotTooLargeError | None = None) -> None:
        """A reset's scene cannot be sent: clear the closed one off the viewers, and keep the scene owed."""
        try:
            snapshot = self._build(_EmptyScene(), ())
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("live: empty scene not built (%s)", type(exc).__name__)
            self._end(RESET_NOT_SENT)
            return
        self._install(snapshot)
        self._failed(cause)  # after its begin: updates stay held until the real scene goes out
        if too_large is not None:
            self._emit(LiveEventKind.TOO_LARGE, too_large=too_large)
        else:
            self._emit(LiveEventKind.FAILED)

    def _install(self, snapshot: Snapshot) -> None:
        """The snapshot began: its scene is what the viewers hold from now on (``changes.py``'s contract)."""
        self._sent = snapshot.sent
        self._inflight = snapshot.scene_version
        if not self._inflight_hold:
            self._inflight_hold = True
            self._debouncer.hold()
        self._shrink = None
        self._needs_flush = False
        self._needed_seen = False  # begin cleared snapshot_needed
        try:
            if snapshot.announced is not None:
                self._send(snapshot.announced)
            for frame in snapshot.frames():
                self._send(frame)
        except Exception:
            # no ack will come for a snapshot the relay got part of, or none: the next begin supersedes it (§6.2)
            self._discard()
            self._end_inflight()
            if self._reset_owed:
                # a closed scene's replacement that cannot be sent would be rebuilt on every tick (§7.3)
                self._end(RESET_NOT_SENT)
            raise
        self._emit(LiveEventKind.SENT, snapshot=snapshot)

    # ------------------------------------------------------------------ relay events

    def _observe(self) -> None:
        state = self._client.state
        if state not in _LIVE and state not in _PAUSED:
            self.stop()
            return
        if state in _PAUSED:
            if not self._paused:
                self._paused = True
                self._debouncer.hold()
            version = self._inflight
            if version is not None and self._client.snapshot_in_flight != version:
                self._end_inflight()  # lost with the connection (§6.3) unless acked first
                if self._client.accepted_version >= version:
                    self._acked()
            self._check_cause(lost=True)
            return
        if self._paused:
            self._paused = False
            self._debouncer.release()
        self._check_inflight()
        if self._running:
            self._check_cause()

    def _check_inflight(self) -> None:
        version = self._inflight
        if version is None or self._client.snapshot_in_flight == version:
            return
        self._end_inflight()
        if self._client.accepted_version >= version:
            self._acked()
            return
        # refused (§6.2): the relay ignores the rest of it — do not spend the uplink on it
        self._discard()
        error = self._client.last_error
        self._seen_error = error
        code = error.code if error is not None else None
        self._emit(LiveEventKind.REFUSED, code=code)
        if self._reset_owed:
            self._end(RESET_REFUSED)
            return
        if code == "PAYLOAD_TOO_LARGE":
            self._failed(_Cause.TOO_LARGE)
        elif code in _RESYNC_CODES:
            self._failed(_Cause.RESYNC)
        else:
            self._failed(_Cause.BUSY, _retry_after(error.details) if error is not None else None)

    def _acked(self) -> None:
        now = self._clock()
        self._last_ack = now
        self._failed_since_ack = False
        self._unacked = 0
        self._reset_owed = False
        if self._resynced and self._resync_acked_at is None:
            self._resync_acked_at = now
        if not self._client.snapshot_needed:
            self._shrink, self._until, self._needs_flush = None, 0.0, False
        self._emit(LiveEventKind.ACKED)

    def _check_cause(self, *, lost: bool = False) -> None:
        """A ``snapshot_needed`` this controller did not set: an error answering an update, the relay's
        ``maxTextBytes`` (a change or held updates too large for one message), or a lost connection (``lost``)."""
        error = self._client.last_error
        new_error = error is not None and error is not self._seen_error
        self._seen_error = error
        if not self._client.snapshot_needed:
            self._needed_seen = False
            return
        if self._needed_seen:
            return
        if not new_error:
            self._failed(_Cause.LOST if lost else _Cause.RESYNC)
        elif error.code in _RESYNC_CODES or error.code == "PAYLOAD_TOO_LARGE":
            self._failed(_Cause.RESYNC)
        else:
            self._failed(_Cause.BUSY, _retry_after(error.details))

    def _failed(self, cause: _Cause, retry_after: float | None = None) -> None:
        """No snapshot shows the scene now: keep updates held and set when the next attempt may go."""
        now = self._clock()
        streak_over = self._last_ack is not None and now - self._last_ack >= STREAK_RESET_S
        if streak_over and not self._failed_since_ack:
            self._streak = 0  # the first failure after a quiet minute
        self._failed_since_ack = True
        # the flush gate is for refusals that would repeat: a lost connection leaves it as it is
        if cause is not _Cause.LOST:
            self._unacked += 1
            self._needs_flush = self._unacked >= FAILURES_BEFORE_FLUSH_GATE
        self._client.require_snapshot()
        self._needed_seen = True
        if cause is _Cause.TOO_LARGE:
            self._shrink = self._shown_ids() or frozenset()
            return
        if cause in (_Cause.RESYNC, _Cause.LOST):
            resync_quiet = (
                self._resync_acked_at is not None and now - self._resync_acked_at >= RESYNC_QUIET_S
            )
            first = not self._resynced
            self._resynced, self._resync_acked_at = True, None
            if first or resync_quiet:
                self._until = max(self._until, now)
                return
        delay = self._backoff()
        if retry_after is not None:
            delay = min(max(retry_after, delay), RETRY_AFTER_MAX_S)
        self._until = max(self._until, now + delay)

    def _backoff(self) -> float:
        self._streak = min(self._streak + 1, 16)
        return min(BACKOFF_FIRST_S * 2 ** (self._streak - 1), BACKOFF_MAX_S)

    # ------------------------------------------------------------------ helpers

    def _not_sent(self) -> None:
        """A flush or an export failed unexpectedly (the transport refused a frame, a bug): back off."""
        self._failed(_Cause.LOCAL)
        self._emit(LiveEventKind.FAILED)

    def _end_inflight(self) -> None:
        self._inflight = None
        if self._inflight_hold:
            self._inflight_hold = False
            self._debouncer.release()

    def _discard(self) -> None:
        try:
            self._discard_queued()
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("live: queued frames not dropped (%s)", type(exc).__name__)

    def _end(self, text: str) -> None:
        self.stop()
        try:
            self._end_session(text)
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("live: session not ended (%s)", type(exc).__name__)

    def _emit(self, kind: LiveEventKind, **details: Any) -> None:
        try:
            self._on_event(LiveEvent(kind, **details))
        except Exception as exc:  # noqa: BLE001 — the panel's texts must not stop the scene (T7)
            _log.error("live: event not shown (%s)", type(exc).__name__)
