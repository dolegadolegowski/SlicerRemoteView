"""Live scene changes during a session (SLC-29; protocol §6.2, §7.3, §8; FR-11, FR-12, NFR-02; T2, T7).

:class:`LiveUpdates` turns the marks of the Slicer observers (SLC-31) into what the viewers need, and owns every export
of the session, the first snapshot included:

- **marks** (:meth:`~LiveUpdates.mark`, :meth:`~LiveUpdates.mark_transform`, and for segments
  :meth:`~LiveUpdates.mark_segment`, :meth:`~LiveUpdates.mark_segment_transform`,
  :meth:`~LiveUpdates.mark_held_segments`) arrive with the **raw** MRML and segment IDs the observers read and are
  resolved here, never in the watcher, through the session's registry (SLC-36, §7.3): a model ``Sphere`` is marked
  as ``m_1`` — allocated on first sight, so a model added mid-session under a scripted ID is announced and exported
  under its alias —, a segment as ``<mrmlId>/<segmentId>`` or ``<mrmlId>/s_<n>`` under the current *Hide node names*
  setting, and a segmentation node's transform or removal reaches every segment of it the viewers hold
  (``SentScene.under``). The debouncer's keys are therefore the viewers' ``nodeId`` (T7: a raw ID never reaches a
  plan). The resolved marks go to SLC-15's :class:`~remoteview_core.debounce.Debouncer`; its flush is classified by
  SLC-30's :func:`~remoteview_core.changes.classify` against :attr:`~LiveUpdates.sent` (what the viewers hold) and
  sent with SLC-16's client — an update plan as ``scene.update``/``scene.nodeRemoved``, a re-export as
  ``scene.nodeAdded`` and a new snapshot whose scene becomes :attr:`~LiveUpdates.sent` in the same call
  (``changes.py``'s contract); a mark that resolves to an ID neither shown nor held is dropped there (T7);
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
- *Hide node names*, *Remove small islands* and the device profile have no MRML event:
  :meth:`~LiveUpdates.set_anonymize_names`, :meth:`~LiveUpdates.set_remove_islands` (SLC-54) and
  :meth:`~LiveUpdates.request_snapshot` (SLC-18) ask for a snapshot;
- **when changes go out** (SLC-56): :meth:`~LiveUpdates.set_send_policy` hands the toolbar's choice to the debouncer
  (at once by its lanes, a delay after the last change, or only on *Send now*); :meth:`~LiveUpdates.send_now` flushes
  what waits — or, with nothing waiting and nothing on its way, sends the scene again; :attr:`~LiveUpdates.due_in` and
  :attr:`~LiveUpdates.changes_wait` feed the countdown. A reset ignores the policy (§7.3, the debouncer's rule);
- **preparation in steps** (SLC-51, ``docs/research/slicer-prepare.md``): an export is prepared by SLC-28's
  ``prepare_snapshot`` with the session's :class:`~remoteview_core.meshcache.MeshCache` (SLC-50), a slice of
  ``slice_s`` seconds at a time — the first in the call that starts it, the others from :meth:`~LiveUpdates.tick` —
  or in that one call (``slice_s=None``). The debouncer is held from its first step until its ``begin`` (the SLC-30
  design review: marks made meanwhile are classified against its scene, after its ack). It runs only while its
  snapshot may go out: Stop, a reset, a batch, a lost connection, a new setting or a gate that closes abandon it —
  nothing of it was sent and it used no version — and a later tick starts again, from the cache. A re-sync
  (:meth:`~LiveUpdates.request_resync`) lets it finish and asks for another snapshot after it, so events that keep
  coming off the main thread cannot hold a large scene off for ever;
- **IDs** (protocol v1.1 §7.3, SLC-35): every export of the session runs through one
  :class:`~remoteview_core.ids.SceneIds` (:attr:`~LiveUpdates.ids`), owned by the panel — one per ``session.create`` —
  and handed in at construction, so a resumed session (SLC-17) cannot lose the aliases the viewers hold, while a new
  ``session.create`` (Stop → Start) may renumber. ``start()``/``stop()`` never touch it; :meth:`~LiveUpdates.reset`
  (the scene closed) clears its raw → alias maps and keeps its counters, so no alias is ever reissued.

The panel (SLC-32) calls ``start(deferred=True)``, attaches the observers, then :meth:`~LiveUpdates.tick` — all in
one main-thread call, so a batch process running at Start holds the first snapshot until it ends; it calls
:meth:`~LiveUpdates.observe` after every relay message and connection loss and :meth:`~LiveUpdates.tick` from its
pump — after :meth:`~LiveUpdates.request_resync` when the observers missed events off the main thread (SLC-33); the
flush timer calls :meth:`~LiveUpdates.flush`. Its texts read :attr:`~LiveUpdates.in_flight`,
:attr:`~LiveUpdates.owed`, :attr:`~LiveUpdates.waits_for_change` and :attr:`~LiveUpdates.batch_held` when they are
shown. ``IDLE``/``CLOSED`` stop the controller: the marks are dropped and later ones ignored.

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
from remoteview_core.debounce import AT_ONCE, Change, Debouncer, Drained, SendPolicy, Timer
from remoteview_core.ids import SceneIds
from remoteview_core.meshcache import MeshCache
from remoteview_core.protocol_client import ProtocolClient, ProtocolStateError, SessionState
from remoteview_core.snapshot import Snapshot, SnapshotTooLargeError, prepare_snapshot
from remoteview_core.steps import Progress, Stepper, Steps, run

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


@dataclass
class _Preparation:
    """A snapshot being prepared (SLC-51): its steps, whether it replaces a closed scene, its progress."""

    stepper: Stepper[Snapshot]
    reset: bool
    progress: Progress
    #: events were missed off the main thread while it ran (SLC-33): a re-sync follows its snapshot
    stale: bool = False


class _EmptyScene:
    """A scene without nodes (all :func:`~remoteview_core.collect.collect_scene` asks of it): the empty snapshot after
    a reset."""

    def visible_model_nodes(self) -> list[Any]:
        return []

    def visible_segments(self) -> list[Any]:
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
        remove_islands: bool = False,
        on_event: Callable[[LiveEvent], object] = lambda event: None,
        prepare: Callable[..., Steps[Snapshot]] = prepare_snapshot,
        ids: SceneIds | None = None,
        slice_s: float | None = None,
        send_policy: SendPolicy = AT_ONCE,
    ) -> None:
        self._client = client
        self._scene = scene
        self._ids = ids if ids is not None else SceneIds()
        self._send = send
        self._discard_queued = discard_queued
        self._clock = clock
        self._slicer_version = slicer_version
        self._end_session = end_session
        self._anonymize = bool(anonymize_names)
        self._remove_islands = bool(remove_islands)  # every export's island rule (SLC-53, SLC-54)
        self._on_event = on_event
        self._prepare_fn = prepare
        self._slice_s = slice_s
        self._debouncer = Debouncer(timer, self._on_flush, clock)
        self._debouncer.set_policy(send_policy)
        self._running = False
        self._prep: _Preparation | None = None
        self._forget_session()

    def _forget_session(self) -> None:
        self._prep = None  # abandoned first (stop)
        self._cache = MeshCache()  # the session's meshes (SLC-50)
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
            f"preparing={self._prep is not None}, in_flight={self._inflight is not None}, "
            f"batch={self._depth}, paused={self._paused})"
        )

    @property
    def running(self) -> bool:
        return self._running

    @property
    def sent(self) -> SentScene:
        """What the viewers hold (the scene of the last export, with every change sent since)."""
        return self._sent

    @property
    def ids(self) -> SceneIds:
        """The session's raw ID → alias registry (§7.3), the one every export of this controller uses."""
        return self._ids

    @property
    def preparing(self) -> Progress | None:
        """The progress of the snapshot being prepared; ``None`` when none is."""
        return self._prep.progress if self._prep is not None else None

    @property
    def in_flight(self) -> bool:
        """A snapshot began and has no ack, refusal or loss yet."""
        return self._inflight is not None

    @property
    def owed(self) -> bool:
        """The viewers need a new snapshot to catch up: the relay or a change asked for one, or a closed scene may
        still be on them (updates are held until it begins)."""
        return self._running and (self._client.snapshot_needed or self._reset_owed)

    @property
    def waits_for_change(self) -> bool:
        """The owed snapshot goes out only after a change in Slicer or :meth:`request_snapshot`: the scene was too
        large, or :data:`FAILURES_BEFORE_FLUSH_GATE` attempts failed without an ack (the SLC-29 review). Read it when a
        text is shown: :attr:`LiveEventKind.REFUSED` is emitted before the refusal sets the gate."""
        return self._shrink is not None or self._needs_flush  # stop() forgets both

    @property
    def batch_held(self) -> bool:
        """A batch process (loading, closing, a script) holds the marks and any owed snapshot until it ends."""
        return self._depth > 0  # stop() forgets it

    @property
    def changes_wait(self) -> bool:
        """Marked changes wait for the policy's delay, for *Send now* or for a hold to end."""
        return self._running and self._debouncer.pending

    @property
    def due_in(self) -> float | None:
        """Seconds until the waiting changes go out by themselves; ``None`` when none wait, they wait for a hold to
        end, or they wait for *Send now*."""
        return self._debouncer.due_in(self._clock()) if self._running else None

    # ------------------------------------------------------------------ the observers (SLC-31); never raise

    def mark(self, node_id: str, flags: Change) -> None:
        """A model node changed, under its raw MRML ID ``node_id`` (an ID or flags of another type, empty ones, or
        marks while stopped are ignored). Resolved through the registry: ``m_<n>`` for an ID Slicer did not generate
        (allocated now if needed, so a node added mid-session is announced under the alias it is exported with)."""
        if not self._accepts(node_id, flags):
            return
        try:
            alias = self._ids.model_node_id(node_id)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark not resolved (%s)", type(exc).__name__)
            return
        if alias is not None:
            self._mark_resolved(alias, flags)

    def mark_transform(self, node_id: str) -> None:
        """A node's world transform may have changed: ``geometry`` for a node the viewers hold baked (only a re-export
        shows it, FR-12's slow lane), ``transform`` for every other one — a node the export left out too, which a
        ``geometry`` mark would always re-export (SLC-30 review). For a segmentation node the same goes to every
        segment of it the viewers hold (``<alias>/…``): their transform is the node's (SLC-13)."""
        if not self._accepts(node_id, Change.TRANSFORM):
            return
        try:
            alias = self._ids.model_node_id(node_id)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark not resolved (%s)", type(exc).__name__)
            return
        if alias is None:
            return
        for resolved in (alias, *self._sent.under(alias + "/")):
            self._mark_resolved(resolved, self._transform_lane(resolved))

    def mark_segment(self, node_id: str, segment_id: Any, flags: Change) -> None:
        """A segment changed: ``segment_id`` is the raw ID (``str`` or ``bytes``, as ``GetSegmentIDs()`` returns it)
        of a segment of the segmentation node with MRML ID ``node_id``. Resolved to the ``nodeId`` an export under
        the current *Hide node names* setting gives it (§7.3) — the same registry, so it is the ID the viewers hold
        or will hold."""
        if not self._accepts(node_id, flags) or not isinstance(segment_id, (str, bytes)):
            return
        resolved = self._resolve_segment(node_id, segment_id)
        if resolved is not None:
            self._mark_resolved(resolved, flags)

    def mark_segment_transform(self, node_id: str, segment_id: Any) -> None:
        """The segmentation node moved: :meth:`mark_transform`'s lane rule for one of its segments."""
        if not self._accepts(node_id, Change.TRANSFORM) or not isinstance(segment_id, (str, bytes)):
            return
        resolved = self._resolve_segment(node_id, segment_id)
        if resolved is not None:
            self._mark_resolved(resolved, self._transform_lane(resolved))

    def mark_held_segments(self, node_id: str, flags: Change) -> None:
        """Every segment of the segmentation node ``node_id`` the viewers hold changed (``flags``): a whole-node event
        without a segment ID, or the node removed."""
        if not self._accepts(node_id, flags):
            return
        try:
            prefix = self._ids.held_prefix(node_id)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark not resolved (%s)", type(exc).__name__)
            return
        if prefix is None:
            return
        for resolved in self._sent.under(prefix):
            self._mark_resolved(resolved, flags)

    def _accepts(self, node_id: Any, flags: Any) -> bool:
        """The entry check of every mark: running, a non-empty ``str`` ID and non-empty ``Change`` flags."""
        if not self._running or not isinstance(node_id, str) or not node_id:
            return False
        return isinstance(flags, Change) and bool(flags)

    def _resolve_segment(self, node_id: str, segment_id: Any) -> str | None:
        try:
            return self._ids.segment_node_id(node_id, segment_id, anonymize=self._anonymize)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark not resolved (%s)", type(exc).__name__)
            return None

    def _transform_lane(self, resolved: str) -> Change:
        """``geometry`` for an entity the viewers hold baked, ``transform`` for every other one."""
        held = self._sent.get(resolved)
        return Change.GEOMETRY if held is not None and held.matrix is None else Change.TRANSFORM

    def _mark_resolved(self, node_id: str, flags: Change) -> None:
        """A mark under the viewers' ``nodeId``: to the debouncer."""
        try:
            self._debouncer.mark(node_id, flags)
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: mark failed (%s)", type(exc).__name__)

    def hold(self) -> None:
        """``StartBatchProcessEvent``."""
        if not self._running:
            return
        self._depth += 1
        try:
            # a batch changes the scene under a preparation: the next one, after the batch, reuses what it finished
            self._abandon()
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
            self._abandon()  # it was preparing the closed scene
            self._cache.clear()
            self._reset_owed = True
            # the aliases were the closed scene's: forgotten, never reissued (§7.3 — the counters keep counting)
            self._ids.reset()
            # no update may address a closed scene's ID, which the next scene may reuse (§7.3)
            self._sent.apply(Plan(snapshot=True, reset=True))
            if self._inflight is not None:
                self._discard()
                self._end_inflight()
            self._debouncer.reset()
        except Exception as exc:  # noqa: BLE001 — called from a VTK observer (T7)
            _log.error("live: reset failed (%s)", type(exc).__name__)

    # ------------------------------------------------------------------ the panel

    def start(self, *, deferred: bool = False) -> None:
        """The session was created: send the first snapshot — at once, or with ``deferred`` from the next
        :meth:`tick`. The panel attaches the observers between ``start(deferred=True)`` and that tick: a batch process
        running at Start gives the watcher's ``hold()`` (counted once running, and the only batch hold, the SLC-31
        review), so the first snapshot waits for the batch's end; marks made in the batch then flush once against an
        empty :attr:`sent`, and that export sends no ``scene.nodeAdded`` (none is sent while updates are held). Raises
        ``ProtocolStateError`` unless the client is ``CREATED``/``ACTIVE`` (a caller's bug); a second call does
        nothing."""
        if self._running:
            return
        if self._client.state not in _LIVE:
            raise ProtocolStateError(f"cannot send the scene in state {self._client.state.value}")
        self._forget_session()
        self._running = True
        self._seen_error = self._client.last_error
        if deferred:
            self._client.require_snapshot()
            self._needed_seen = True  # the gate is open: the next tick exports
            return
        try:
            self._export(None)
        except Exception as exc:  # noqa: BLE001 — the transport refused a frame (T7: type only)
            _log.error("live: scene not sent (%s)", type(exc).__name__)
            self._not_sent()

    def stop(self) -> None:
        """The session ended (or Stop): drop the marks and a preparation (nothing of it is sent); later calls do
        nothing until :meth:`start`."""
        self._running = False
        self._abandon()
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
        """From the pump: run a slice of the snapshot being prepared, or start an owed one once its gate opens."""
        if not self._running:
            return
        try:
            self._observe()
            if not self._running:
                return
            if self._prep is not None:
                if self._may_continue():
                    self._advance()
                else:
                    self._abandon()
            elif self._may_export():
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

    def set_remove_islands(self, on: bool) -> None:
        """*Remove small islands* changed (SLC-54): the viewers need the scene with (or without) the small islands."""
        if bool(on) == self._remove_islands:
            return
        self._remove_islands = bool(on)
        self.request_snapshot()

    def set_send_policy(self, policy: SendPolicy) -> None:
        """When changes go out (SLC-56); pending ones follow the new policy from now. Also before :meth:`start`."""
        self._debouncer.set_policy(policy)

    def send_now(self) -> None:
        """*Send now* (SLC-56): the waiting changes go out at once (or at the end of the hold that keeps them); with
        none waiting, the scene goes again unless a snapshot is already being prepared or in flight — a click then
        would only restart it. Lifts the too-large and flush gates like :meth:`request_snapshot`."""
        if not self._running:
            return
        try:
            if self._debouncer.send_now():
                return
            if self._prep is not None or self._inflight is not None:
                return
            self.request_snapshot()
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("live: send now failed (%s)", type(exc).__name__)

    def request_snapshot(self) -> None:
        """Send the scene again (a new device profile, *Hide node names*, *Remove small islands*): lifts the too-large
        and flush gates, not a wait the relay asked for."""
        if not self._running:
            return
        self._abandon()  # prepared with the old setting
        self._client.require_snapshot()
        self._needed_seen = True
        self._shrink = None
        self._needs_flush = False

    def request_resync(self, *, batch: bool) -> None:
        """The observers missed events (one arrived off the main thread, SLC-33): bring the batch hold in line with
        the scene's batch state ``batch`` (MRML reports only the outermost batch, research note §4: a missed
        ``EndBatchProcessEvent`` released nothing, a missed ``StartBatchProcessEvent`` held nothing), ask for a fresh
        snapshot under the re-sync rule (a lost connection's: it neither counts toward nor closes the flush gate), and
        lift the flush and too-large gates — a missed change is a change (at most one extra attempt per episode). A
        re-sync already waiting for its time is not pushed back: events off the main thread that keep coming must not
        hold it off for ever (SLC-33 review)."""
        if not self._running:
            return
        try:
            target = int(bool(batch))
            for _ in range(self._depth - target):
                self.release()
            if target and not self._depth:
                self.hold()
            # owed already, waiting for its time or free to go at this pump's tick (the panel calls this first)
            waiting = (
                self._client.snapshot_needed
                and self._needed_seen
                and (self._clock() < self._until or self._gate_open())
            )
            self._shrink = None
            self._needs_flush = False
            if self._prep is not None:
                # it may have read what the missed events changed: it finishes (abandoning it each time could hold a
                # large scene off for ever) and the re-sync follows its snapshot
                self._prep.stale = True
            elif not waiting:
                self._failed(_Cause.LOST)
        except Exception as exc:  # noqa: BLE001 — called from the pump (T7)
            _log.error("live: re-sync not asked for (%s)", type(exc).__name__)

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
        if (
            self._prep is None
        ):  # a preparation the flush started has had its slice: the pump runs the others
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
            plan = classify(
                drained, self._scene(), self._sent, anonymize_names=self._anonymize, ids=self._ids
            )
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
        """The ``nodeId`` of every model and segment the 3D view shows (a light read: no mesh), or ``None`` when they
        cannot be read."""
        try:
            scene = self._scene()
            shown = {self._ids.model_node_id(scene.node_id(n)) for n in scene.visible_model_nodes()}
            for handle in scene.visible_segments():
                node_raw, seg_raw = scene.segment_identity(handle)
                shown.add(self._ids.segment_node_id(node_raw, seg_raw, anonymize=self._anonymize))
            return frozenset(shown)
        except Exception:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
            return None

    # ------------------------------------------------------------------ exports

    def _may_export(self) -> bool:
        owed = self._client.snapshot_needed or self._reset_owed
        # a pending flush classifies first (a reset's plan announces its nodes)
        return owed and self._may_continue() and not self._debouncer.pending

    def _may_continue(self) -> bool:
        """A snapshot may go out now: the condition of every slice of a preparation — one a flush started owes no
        snapshot to the client, and marks made while it runs only wait for its ack."""
        if self._client.state not in _LIVE:
            return False
        if self._inflight is not None or self._depth or self._paused:
            return False
        return self._reset_owed or self._gate_open()

    def _gate_open(self) -> bool:
        return self._shrink is None and not self._needs_flush and self._clock() >= self._until

    def _export(self, plan: Plan | None) -> None:
        """Start preparing the snapshot and run its first slice (:meth:`tick` runs the others). The debouncer is held
        from here until its ``begin``: marks made meanwhile flush after its ack, against its scene (SLC-30 review)."""
        reset, progress = self._reset_owed, Progress()
        try:
            steps = self._prepare_fn(
                self._scene(),
                self._client,
                slicer_version=self._slicer_version,
                anonymize_names=self._anonymize,
                announce=plan.added if plan is not None else (),
                ids=self._ids,
                cache=self._cache,
                progress=progress,
                remove_islands=self._remove_islands,
            )
        except Exception as exc:  # noqa: BLE001 — the scene cannot be read (T7: type only)
            self._not_prepared(exc, reset)
            return
        self._prep = _Preparation(Stepper(steps, self._clock), reset, progress)
        self._debouncer.hold()
        self._advance()

    def _advance(self) -> None:
        """One slice of the preparation; at its end the snapshot begins, or why it cannot is recorded."""
        prep = self._prep
        if prep is None:
            return
        try:
            done = prep.stepper.advance(math.inf if self._slice_s is None else self._slice_s)
        except Exception as exc:  # noqa: BLE001 — a scene that cannot be exported (T7: type only)
            if (
                self._prep is not prep
            ):  # abandoned by a step that called back: its hold went with it
                _log.error("live: abandoned preparation failed (%s)", type(exc).__name__)
                return
            self._prep = None
            try:
                self._not_prepared(exc, prep.reset)
            finally:
                self._debouncer.release()  # the preparation's hold (an empty reset snapshot holds its own)
            return
        if self._prep is not prep:
            # abandoned by a step that called back (a scene event): nothing of it is sent; a snapshot it began is
            # superseded by the one still owed
            return
        if not done:
            if prep.reset:
                # a closed scene's replacement that takes more than one slice: the closed scene leaves the viewers
                # first (§7.3), and the new one follows as an owed snapshot
                self._abandon()
                self._empty()
            return
        self._prep = None
        try:
            self._install(
                prep.stepper.result
            )  # the in-flight hold is taken before the preparation's ends
        finally:
            self._debouncer.release()
        if prep.stale and self._running:
            self._failed(_Cause.LOST)  # the re-sync asked for while it ran

    def _not_prepared(self, exc: Exception, reset: bool) -> None:
        """The snapshot could not be prepared: record why. When it was a closed scene's replacement, an empty
        snapshot clears the closed scene off the viewers."""
        if isinstance(exc, SnapshotTooLargeError):
            if reset:
                self._empty(_Cause.TOO_LARGE, exc)
            else:
                self._failed(_Cause.TOO_LARGE)
                self._emit(LiveEventKind.TOO_LARGE, too_large=exc)
            return
        _log.error("live: scene not exported (%s)", type(exc).__name__)
        if reset:
            self._empty(_Cause.LOCAL)
        else:
            self._failed(_Cause.LOCAL)
            self._emit(LiveEventKind.FAILED)

    def _abandon(self) -> None:
        """Drop the snapshot being prepared: nothing of it is sent, and it used no version (unless a scene event
        abandoned it from inside its last step: the snapshot still owed then supersedes the one it began). While the
        session runs it stays owed — a flush's re-export or the first snapshot owe the client nothing yet —, so a
        later tick starts it again, without a flush's ``scene.nodeAdded`` hint (optional, §8.2: updates, and the hint,
        are held while a snapshot is owed)."""
        prep, self._prep = self._prep, None
        if prep is None:
            return
        try:
            prep.stepper.close()
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("live: preparation not closed (%s)", type(exc).__name__)
        self._debouncer.release()
        if self._running:
            self._client.require_snapshot()
            self._needed_seen = True

    def _build(self, scene_api: SceneApi, announce: Iterable[tuple[str, str]]) -> Snapshot:
        """A snapshot prepared in one call, without the session's cache (the empty one after a reset)."""
        return run(
            self._prepare_fn(
                scene_api,
                self._client,
                slicer_version=self._slicer_version,
                anonymize_names=self._anonymize,
                announce=announce,
                ids=self._ids,
                remove_islands=self._remove_islands,
            )
        )

    def _empty(
        self, cause: _Cause | None = None, too_large: SnapshotTooLargeError | None = None
    ) -> None:
        """A reset's scene cannot be sent now: clear the closed one off the viewers, and keep the scene owed —
        after a failure (``cause``), or while it is still being prepared (``None``, SLC-51)."""
        try:
            snapshot = self._build(_EmptyScene(), ())
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("live: empty scene not built (%s)", type(exc).__name__)
            self._end(RESET_NOT_SENT)
            return
        self._install(snapshot)
        if cause is None:
            self._client.require_snapshot()  # begin cleared it: the new scene follows the empty one's ack
            self._needed_seen = True
            return
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
