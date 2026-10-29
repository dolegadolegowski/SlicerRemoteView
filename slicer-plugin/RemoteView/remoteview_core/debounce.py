"""Coalescing scene changes before they are sent (SLC-15; FR-11, FR-12, NFR-02, architecture §6.2).

The Slicer adapter's MRML observers only *mark* what changed — :meth:`Debouncer.mark` with a node ID and
:class:`Change` flags — and one single-shot timer later hands everything marked since the last flush to the sender as
one :class:`Drained` set (SLC-16 turns it into ``scene.update`` / ``scene.nodeRemoved`` / a new snapshot):

- appearance, transform and removal wait :data:`APPEARANCE_MS` (150 ms) after the **last** mark (protocol §8.1: coalesce
  100–250 ms) and at most :data:`APPEARANCE_MAX_MS` after the first, so a slider dragged for seconds still updates the
  viewers four times a second (NFR-02: ≤ 500 ms from Slicer to the viewers);
- a mesh change, a new node or a rename (all need a re-export) waits :data:`GEOMETRY_MS` (750 ms; protocol §8.1:
  500–1000 ms; segment editing fires mesh events continuously), at most :data:`GEOMETRY_MAX_MS` after the first;
- the cap counts **per node** from that node's first pending mark (the flush is due when the oldest one's cap runs
  out), and a repeated ``geometry`` mark on a node already pending ``geometry`` in this flush re-bases that node's
  entry — only that one (SLC-36, a plan correction of SLC-15): painting one segment (every brush stroke ends in
  ``RepresentationModified``) or smoothing one model exports once, 750 ms after the last stroke, instead of a
  full-scene re-export every 2 s on the main thread (ADR 0005 Consequences; SLC-28 still todo), while a mark on any
  other node made during the burst — a segment hidden, a slider moved — still leaves within :data:`GEOMETRY_MAX_MS` of
  *its* mark (NFR-02), taking the burst's node with it. A new flag on the burst's node is not a repeat either. A script
  that edits one mesh every < 750 ms for ever never exports until it stops (SLC-18 may add a "send now");
- while Slicer runs a batch process (a scene close, import or restore always runs inside one) nothing is flushed: the
  marks are kept and flushed once when the last hold ends (``EndBatchProcessEvent``; SLC-29's controller also holds
  while a snapshot is in flight or the connection is lost);
- a closed scene (``EndCloseEvent``) drops every mark and flushes a reset: the next scene is a new snapshot.

One timer serves both: while a re-export is pending, appearance changes wait with it (at most
:data:`GEOMETRY_MAX_MS` after their own mark, a burst on another node notwithstanding) — the re-exported snapshot
carries them anyway.

A :class:`SendPolicy` (SLC-56, the owner's request) can replace the lanes above: with ``delay_s`` the marks go out that
long after the **last** mark, with no cap (a countdown the toolbar shows, :meth:`Debouncer.due_in`); with ``manual``
they wait for :meth:`Debouncer.send_now`. A reset (a closed scene) keeps the lanes above under every policy: a closed
scene must not stay on the viewers (§7.3). The end of a batch under a policy restarts the delay instead of the 0 ms
hand-off, unless ``send_now`` was asked meanwhile.

Pure logic: the timer and the clock are injected (``qt.QTimer`` and ``time.monotonic`` in Slicer, fakes in tests). Main
thread only, like the observers that call it.
"""

from __future__ import annotations

import enum
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Protocol

#: Delays in milliseconds (see the module docstring).
APPEARANCE_MS = 150
APPEARANCE_MAX_MS = 250
GEOMETRY_MS = 750
GEOMETRY_MAX_MS = 2_000


@dataclass(frozen=True)
class SendPolicy:
    """When marked changes go out (SLC-56): ``delay_s`` seconds after the last mark, only on ``send_now`` when
    ``manual``, or — both unset — by the lanes of the module docstring."""

    delay_s: float | None = None
    manual: bool = False

    def __post_init__(self) -> None:
        if self.delay_s is not None and (
            isinstance(self.delay_s, bool) or not (0 < float(self.delay_s) < 3_600)
        ):
            raise ValueError("delay_s must be None or seconds in (0, 3600)")
        if self.manual and self.delay_s is not None:
            raise ValueError("a manual policy has no delay")

    @property
    def lanes(self) -> bool:
        """The fast lanes apply (no delay, not manual)."""
        return self.delay_s is None and not self.manual


AT_ONCE = SendPolicy()


class Change(enum.Flag):
    """What changed on a node since the last flush (a node can collect several)."""

    APPEARANCE = enum.auto()  # colour, opacity, visibility (display node)
    #: the parent transform or its matrix — of a node sent with ``T.matrix``; a node whose world transform is baked
    #: (non-linear or not TRS, SLC-13) needs a re-export, so its transform change is marked GEOMETRY (FR-12)
    TRANSFORM = enum.auto()
    GEOMETRY = enum.auto()  # the mesh (or a segment's surface)
    ADDED = enum.auto()
    REMOVED = enum.auto()
    #: the node's name: the JSON protocol never carries names (§8.3), so only a re-export shows a new one (SLC-30)
    NAME = enum.auto()


#: The changes that need a re-export (a new mesh, an added node, a rename), hence the longer wait.
SLOW = Change.GEOMETRY | Change.ADDED | Change.NAME
#: The key of a pending reset in ``Debouncer``'s first-mark table (node IDs are non-empty strings).
_RESET = None


@dataclass(frozen=True)
class Drained:
    """One flush: ``changes`` maps node IDs to what changed on them, in the order they were first marked; ``reset``
    says the scene was closed meanwhile (then ``changes`` holds only what came after the close)."""

    changes: Mapping[str, Change] = field(default_factory=lambda: MappingProxyType({}), repr=False)
    reset: bool = False

    def __bool__(self) -> bool:
        return self.reset or bool(self.changes)

    def __repr__(self) -> str:
        """Counts only: the IDs are not filtered yet (T7) and must not reach a log."""
        return f"Drained(nodes={len(self.changes)}, reset={self.reset})"


class DirtySet:
    """Node ID → accumulated :class:`Change` flags, drained all at once."""

    def __init__(self) -> None:
        self._changes: dict[str, Change] = {}
        self._union = Change(0)
        self._reset = False

    def mark(self, node_id: str, flags: Change) -> bool:
        """Add ``flags`` to the node's pending ones; ``True`` when every one of them was already pending (a repeated
        mark), which :class:`Debouncer` uses for its re-base rule."""
        if not isinstance(node_id, str) or not isinstance(flags, Change):
            raise TypeError("mark needs a str node ID and Change flags")
        if not node_id or not flags:
            raise ValueError("mark needs a node ID and at least one change")
        before = self._changes.get(node_id, Change(0))
        self._changes[node_id] = before | flags
        self._union |= flags
        return before & flags == flags

    def reset(self) -> None:
        """The scene was closed: forget every mark and remember the reset."""
        self._changes.clear()
        self._union = Change(0)
        self._reset = True

    def pending(self) -> Change:
        """The union of every pending flag (``Change(0)`` when only a reset or nothing is pending)."""
        return self._union

    @property
    def reset_pending(self) -> bool:
        return self._reset

    def drain(self) -> Drained:
        drained = Drained(MappingProxyType(dict(self._changes)), self._reset)
        self._changes.clear()
        self._union = Change(0)
        self._reset = False
        return drained

    def __bool__(self) -> bool:
        return self._reset or bool(self._changes)


class Timer(Protocol):
    """A restartable single-shot timer (``qt.QTimer`` with ``singleShot`` set); its timeout calls
    :meth:`Debouncer.flush`."""

    def start(self, msec: int) -> None: ...

    def stop(self) -> None: ...


class Debouncer:
    """Marks in, one :class:`Drained` set out per quiet period (see the module docstring).

    ``timer`` is started with the delay of the next flush and must call :meth:`flush` when it fires; ``clock`` returns
    seconds (monotonic); ``on_flush`` receives each non-empty :class:`Drained` set exactly once and must handle its own
    errors (a set it loses is gone: SLC-16 answers that with a fresh snapshot). Main thread only, no locks.
    """

    def __init__(
        self,
        timer: Timer,
        on_flush: Callable[[Drained], object],
        clock: Callable[[], float],
    ) -> None:
        self._timer = timer
        self._on_flush = on_flush
        self._clock = clock
        self._dirty = DirtySet()
        # when each pending node (or the reset, under _RESET) was first marked in this window: the cap of the whole
        # set counts from the oldest entry; a repeated geometry mark re-bases its own node's entry only
        self._since: dict[str | None, float] = {}
        self._holds = 0
        self._handoff = False  # the last release started the timer at 0 ms
        self._policy = AT_ONCE
        self._due: float | None = None  # clock seconds of the scheduled flush
        self._send_asked = False  # send_now came while held: flush at the hold's end

    @property
    def policy(self) -> SendPolicy:
        return self._policy

    def set_policy(self, policy: SendPolicy) -> None:
        """Change when marks go out; pending marks follow the new policy from now (a shorter delay counts from here,
        ``manual`` stops the timer, the lanes schedule by their caps)."""
        if not isinstance(policy, SendPolicy):
            raise TypeError("set_policy needs a SendPolicy")
        self._policy = policy
        if self._dirty and not self.held and not self._handoff:
            self._timer.stop()
            self._due = None
            self._schedule(self._clock())

    def due_in(self, now: float) -> float | None:
        """Seconds until the scheduled flush (0 when overdue), ``None`` when none is scheduled: nothing pending, held,
        or ``manual`` without a reset."""
        if self._due is None or self.held:
            return None
        return max(0.0, self._due - now)

    def send_now(self) -> bool:
        """*Send now*: flush the pending marks at once, or at the end of the current hold (then from the timer at 0 ms,
        whatever the policy). ``False`` when nothing is pending — the caller may send the scene again instead."""
        if not self._dirty:
            return False
        if self.held:
            self._send_asked = True
            return True
        self.flush()
        return True

    @property
    def held(self) -> bool:
        """A batch process (or another hold) is on: marks are kept, nothing is flushed."""
        return self._holds > 0

    @property
    def pending(self) -> bool:
        """Marks or a reset wait for a flush (held or not)."""
        return bool(self._dirty)

    def mark(self, node_id: str, flags: Change) -> None:
        repeated = self._dirty.mark(node_id, flags)
        now = self._clock()
        if repeated and flags & Change.GEOMETRY:
            # the same mesh edited again (a brush stroke, a smoothing drag): this node's cap counts from here; the
            # other pending nodes keep theirs
            self._since[node_id] = now
        else:
            self._since.setdefault(node_id, now)
        self._schedule(now)

    def reset(self) -> None:
        """The scene was closed (``EndCloseEvent``): the marks made before it are dropped, so the reset itself is now
        the oldest pending change."""
        self._dirty.reset()
        now = self._clock()
        self._since.clear()
        self._since[_RESET] = now
        self._schedule(now)

    def hold(self) -> None:
        """``StartBatchProcessEvent`` (or another hold): keep the marks until the matching :meth:`release`."""
        self._holds += 1
        self._timer.stop()
        self._due = None

    def release(self) -> None:
        """``EndBatchProcessEvent`` (or the end of another hold): once the last hold ends, flush what was kept — from
        the timer at 0 ms, so the flush runs from the event loop, not inside the MRML event that ended the batch."""
        if self._holds == 0:
            return
        self._holds -= 1
        if self._holds == 0 and self._dirty:
            now = self._clock()
            if self._policy.lanes or self._dirty.reset_pending or self._send_asked:
                self._handoff = True  # a mark before the event loop runs keeps this 0 ms deadline
                self._due = now
                self._timer.start(0)
            else:
                self._schedule(now)  # the delay counts from the batch's end; manual keeps waiting

    def flush(self) -> None:
        """The timer fired: hand the pending set to ``on_flush``. Does nothing while held. A mark made by ``on_flush``
        itself (or after it raised) starts a fresh window."""
        self._timer.stop()
        self._handoff = False
        self._due = None
        self._send_asked = False
        if self.held or not self._dirty:
            return
        drained = self._dirty.drain()
        self._since.clear()  # before on_flush: a mark it makes opens the next window
        self._on_flush(drained)

    def stop(self) -> None:
        """The session ended or the module is unloaded: forget everything; nothing is flushed."""
        self._timer.stop()
        self._dirty = DirtySet()
        self._since.clear()
        self._holds = 0
        self._handoff = False
        self._due = None
        self._send_asked = False

    def _schedule(self, now: float) -> None:
        if self.held or self._handoff:
            return
        policy = self._policy
        if not policy.lanes and not self._dirty.reset_pending:
            if policy.manual:
                self._timer.stop()  # a shorter delay that was running, or nothing
                self._due = None
                return
            delay = float(policy.delay_s or 0.0)
            self._due = now + delay
            self._timer.start(max(0, round(delay * 1000.0)))
            return
        slow = bool(self._dirty.pending() & SLOW)
        quiet, longest = (
            (GEOMETRY_MS, GEOMETRY_MAX_MS) if slow else (APPEARANCE_MS, APPEARANCE_MAX_MS)
        )
        oldest = min(self._since.values(), default=now)
        left = longest - (now - oldest) * 1000.0
        # a main thread that was busy longer than the longest wait: flush as soon as control returns to the event loop
        msec = max(0, round(min(quiet, left)))
        self._due = now + msec / 1000.0
        self._timer.start(msec)
