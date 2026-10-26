"""SLC-15: coalescing scene changes — DirtySet and Debouncer with a fake timer and clock (FR-11, FR-12, NFR-02)."""

from __future__ import annotations

import itertools
import subprocess
import sys
from pathlib import Path

import pytest

from remoteview_core import debounce
from remoteview_core.debounce import (
    APPEARANCE_MAX_MS,
    APPEARANCE_MS,
    GEOMETRY_MAX_MS,
    GEOMETRY_MS,
    Change,
    Debouncer,
    DirtySet,
    Drained,
)


class FakeTimer:
    """A single-shot timer on a fake clock: ``advance(ms)`` fires it when its deadline passes, like ``qt.QTimer``."""

    def __init__(self) -> None:
        self.now = 0.0  # milliseconds
        self.deadline: float | None = None
        self.callback = None
        self.starts: list[int] = []

    def clock(self) -> float:  # seconds, like time.monotonic
        return self.now / 1000.0

    def start(self, msec: int) -> None:
        assert isinstance(msec, int) and msec >= 0
        self.starts.append(msec)
        self.deadline = self.now + msec

    def stop(self) -> None:
        self.deadline = None

    def advance(self, ms: float) -> None:
        target = self.now + ms
        for _ in range(100_000):
            if self.deadline is None or self.deadline > target:
                break
            self.now = self.deadline
            self.deadline = None
            self.callback()
        else:
            raise AssertionError("the timer re-armed itself 100,000 times")
        self.now = target


@pytest.fixture
def setup():
    timer = FakeTimer()
    flushed: list[tuple[float, Drained]] = []
    debouncer = Debouncer(timer, lambda drained: flushed.append((timer.now, drained)), timer.clock)
    timer.callback = debouncer.flush
    return timer, debouncer, flushed


# --------------------------------------------------------------------------- DirtySet


def test_debounce_dirty_set_unions_flags_in_first_mark_order():
    dirty = DirtySet()
    assert not dirty and dirty.pending() == Change(0)
    dirty.mark("vtkMRMLModelNode5", Change.APPEARANCE)
    dirty.mark("vtkMRMLModelNode4", Change.TRANSFORM)
    dirty.mark("vtkMRMLModelNode5", Change.GEOMETRY)
    assert dirty and dirty.pending() == Change.APPEARANCE | Change.TRANSFORM | Change.GEOMETRY
    drained = dirty.drain()
    assert list(drained.changes.items()) == [
        ("vtkMRMLModelNode5", Change.APPEARANCE | Change.GEOMETRY),
        ("vtkMRMLModelNode4", Change.TRANSFORM),
    ]
    assert not drained.reset and drained
    assert not dirty and dirty.pending() == Change(0) and not dirty.drain()  # emptied
    with pytest.raises(TypeError):
        drained.changes["x"] = Change.ADDED  # read-only


def test_debounce_dirty_set_reset_forgets_earlier_marks():
    dirty = DirtySet()
    dirty.mark("vtkMRMLModelNode4", Change.GEOMETRY)
    dirty.reset()
    assert dirty and dirty.pending() == Change(0)
    dirty.mark("vtkMRMLModelNode9", Change.ADDED)  # the next scene's nodes
    drained = dirty.drain()
    assert drained.reset and dict(drained.changes) == {"vtkMRMLModelNode9": Change.ADDED}
    assert not dirty.drain().reset


@pytest.mark.parametrize(
    ("node_id", "flags", "error"),
    [
        ("", Change.ADDED, ValueError),
        ("n", Change(0), ValueError),
        (None, Change.ADDED, TypeError),
        (7, Change.ADDED, TypeError),
        ("n", 1, TypeError),
        ("n", None, TypeError),
    ],
)
def test_debounce_dirty_set_refuses_what_is_not_a_change(node_id, flags, error):
    with pytest.raises(error, match="node ID"):
        DirtySet().mark(node_id, flags)


def test_debounce_drained_is_true_for_a_reset_or_changes():
    assert not Drained() and Drained(reset=True)
    dirty = DirtySet()
    dirty.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    assert dirty.drain()


def test_debounce_delays_are_the_contracts():
    """Criterion 1's numbers and their ranges: protocol §8.1 (100–250 ms, mesh 500–1000 ms), FR-11, FR-12 (≥ 500 ms),
    NFR-02 (≤ 500 ms to the viewers) — the timing tests below use the constants, this one pins them."""
    assert (APPEARANCE_MS, APPEARANCE_MAX_MS, GEOMETRY_MS, GEOMETRY_MAX_MS) == (
        150,
        250,
        750,
        2_000,
    )
    assert 100 <= APPEARANCE_MS <= APPEARANCE_MAX_MS <= 250
    assert 500 <= GEOMETRY_MS <= 1_000 and GEOMETRY_MS < GEOMETRY_MAX_MS


# --------------------------------------------------------------------------- Debouncer timing (criterion 1)


def test_debounce_fifty_marks_within_100_ms_flush_once_150_ms_after_the_last(setup):
    timer, debouncer, flushed = setup
    for i in range(50):
        debouncer.mark(f"vtkMRMLModelNode{i % 5}", Change.APPEARANCE)
        timer.advance(2)  # 50 marks in 100 ms
    timer.advance(APPEARANCE_MS - 3)
    assert flushed == []  # 149 ms after the last mark (at 98 ms)
    timer.advance(10)
    [(at, drained)] = flushed
    assert at == pytest.approx(98 + 150)  # 150 ms after the last mark
    assert list(drained.changes) == [f"vtkMRMLModelNode{i}" for i in range(5)]
    timer.advance(1_000)
    assert len(flushed) == 1  # nothing more


def test_debounce_geometry_extends_the_wait_to_750_ms(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    timer.advance(50)
    debouncer.mark("vtkMRMLModelNode5", Change.GEOMETRY)
    timer.advance(GEOMETRY_MS - 1)
    assert flushed == []
    timer.advance(1)
    [(at, drained)] = flushed
    assert at == 50 + 750
    assert dict(drained.changes) == {
        "vtkMRMLModelNode4": Change.APPEARANCE,
        "vtkMRMLModelNode5": Change.GEOMETRY,
    }


@pytest.mark.parametrize(
    ("flags", "longest"),
    [
        (Change.APPEARANCE, APPEARANCE_MAX_MS),
        (Change.TRANSFORM, APPEARANCE_MAX_MS),
        (Change.GEOMETRY, GEOMETRY_MAX_MS),
    ],
)
def test_debounce_continuous_marks_still_flush_after_the_longest_wait(setup, flags, longest):
    """A slider dragged for 3 s: the viewers still get an update every ``longest`` ms (NFR-02)."""
    timer, debouncer, flushed = setup
    for _ in range(600):  # 6 s: at least two windows even for geometry
        debouncer.mark("vtkMRMLModelNode4", flags)
        timer.advance(10)
    times = [at for at, _ in flushed]
    assert times[0] == longest and len(times) >= 2
    assert all(b - a <= longest + 10 for a, b in itertools.pairwise(times))
    assert len(times) >= 6_000 // (longest + 10)


def test_debounce_removal_and_transform_are_fast_adding_is_slow(setup):
    timer, debouncer, _ = setup
    debouncer.mark("vtkMRMLModelNode4", Change.REMOVED)
    assert timer.starts[-1] == 150
    debouncer.mark("vtkMRMLModelNode5", Change.ADDED)
    assert timer.starts[-1] == 750


def test_debounce_a_busy_main_thread_flushes_at_once(setup):
    """Slicer was busy for longer than the longest wait between two marks: the timer starts at 0, not negative."""
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    timer.deadline = None  # the timer could not fire while Slicer worked
    timer.now += 400
    debouncer.mark("vtkMRMLModelNode5", Change.APPEARANCE)
    assert timer.starts[-1] == 0
    timer.advance(0)
    [(_, drained)] = flushed
    assert list(drained.changes) == ["vtkMRMLModelNode4", "vtkMRMLModelNode5"]


# --------------------------------------------------------------------------- import / batch / close (criterion 2)


def test_debounce_marks_during_an_import_are_flushed_once_at_its_end(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode1", Change.APPEARANCE)
    debouncer.hold()  # StartImportEvent
    assert debouncer.held and timer.deadline is None  # the pending flush waits for the import
    debouncer.flush()  # a timer that fires anyway flushes nothing
    assert flushed == []
    for i in range(2, 40):
        debouncer.mark(f"vtkMRMLModelNode{i}", Change.ADDED)
        assert timer.deadline is None
        timer.advance(100)
    assert flushed == [] and timer.deadline is None  # nothing scheduled while importing
    debouncer.release()  # EndImportEvent
    assert flushed == [] and timer.starts[-1] == 0  # from the event loop, not inside the MRML event
    timer.advance(0)
    [(at, drained)] = flushed
    assert at == timer.now and len(drained.changes) == 39  # at once, everything kept
    timer.advance(5_000)
    assert len(flushed) == 1


def test_debounce_a_scene_load_closes_and_imports_inside_one_hold(setup):
    """Slicer's Load Scene: marks of the old scene, close (reset) and the new nodes between start and end of the import:
    one flush, with the reset and only the new scene's nodes."""
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode1", Change.APPEARANCE)
    debouncer.hold()
    debouncer.reset()
    debouncer.mark("vtkMRMLModelNode7", Change.ADDED)
    debouncer.release()
    timer.advance(0)
    [(_, drained)] = flushed
    assert drained.reset and dict(drained.changes) == {"vtkMRMLModelNode7": Change.ADDED}
    timer.advance(5_000)
    assert len(flushed) == 1


def test_debounce_a_mark_after_the_release_keeps_the_0_ms_hand_off(setup):
    """Slicer fires display events right after EndImportEvent: they join the hand-off instead of delaying it."""
    timer, debouncer, flushed = setup
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode7", Change.ADDED)
    timer.advance(500)
    debouncer.release()
    debouncer.mark("vtkMRMLModelNode7", Change.APPEARANCE)
    assert timer.starts[-1] == 0
    timer.advance(0)
    [(at, drained)] = flushed
    assert at == 500 and drained.changes["vtkMRMLModelNode7"] == Change.ADDED | Change.APPEARANCE
    debouncer.mark("vtkMRMLModelNode7", Change.APPEARANCE)  # after the flush: a normal window again
    assert timer.starts[-1] == 150


def test_debounce_a_mark_made_by_on_flush_waits_a_quiet_period():
    """A re-export that touches MRML marks again: neither lost nor flushed at once."""
    timer = FakeTimer()
    seen = []

    def on_flush(drained):
        seen.append((timer.now, set(drained.changes)))
        if len(seen) == 1:
            debouncer.mark("vtkMRMLModelNode9", Change.APPEARANCE)

    debouncer = Debouncer(timer, on_flush, timer.clock)
    timer.callback = debouncer.flush
    for _ in range(30):  # continuous marks: the first flush comes from the longest wait
        debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
        timer.advance(10)
    timer.advance(1_000)
    # the mark made at 250 ms opens a new window; the marks go on until 290 ms, so it closes at 290 + 150
    assert seen == [(250, {"vtkMRMLModelNode4"}), (440, {"vtkMRMLModelNode4", "vtkMRMLModelNode9"})]


def test_debounce_drained_repr_shows_no_node_id():
    dirty = DirtySet()
    dirty.mark("Doe^John liver", Change.APPEARANCE)
    assert repr(dirty.drain()) == "Drained(nodes=1, reset=False)"


def test_debounce_nested_holds_flush_after_the_last_release(setup):
    timer, debouncer, flushed = setup
    debouncer.hold()  # batch process
    debouncer.hold()  # import inside it
    debouncer.mark("vtkMRMLModelNode1", Change.GEOMETRY)
    debouncer.release()
    assert timer.deadline is None and debouncer.held
    debouncer.release()
    timer.advance(0)
    assert len(flushed) == 1 and not debouncer.held
    debouncer.release()  # an unmatched end event changes nothing
    assert not debouncer.held and len(flushed) == 1
    debouncer.hold()  # and does not cancel the next hold
    assert debouncer.held


def test_debounce_release_without_marks_flushes_nothing(setup):
    timer, debouncer, flushed = setup
    debouncer.hold()
    debouncer.release()
    assert flushed == [] and timer.deadline is None


def test_debounce_a_close_alone_is_flushed(setup):
    timer, debouncer, flushed = setup
    debouncer.reset()
    assert timer.starts[-1] == 150
    timer.advance(150)
    [(at, drained)] = flushed
    assert at == 150 and drained.reset and dict(drained.changes) == {}


def test_debounce_close_flushes_a_reset_and_drops_earlier_marks(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.GEOMETRY)
    debouncer.reset()  # EndCloseEvent
    timer.advance(GEOMETRY_MAX_MS)
    [(_, drained)] = flushed
    assert drained.reset and dict(drained.changes) == {}


def test_debounce_stop_forgets_everything(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    debouncer.hold()
    debouncer.stop()
    assert timer.deadline is None and not debouncer.held
    debouncer.flush()
    timer.advance(5_000)
    assert flushed == []
    debouncer.mark("vtkMRMLModelNode5", Change.APPEARANCE)  # usable again, with a fresh window
    timer.advance(150)
    assert [(at, dict(d.changes)) for at, d in flushed] == [
        (5_150, {"vtkMRMLModelNode5": Change.APPEARANCE})
    ]


def test_debounce_stop_stops_the_timer(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    debouncer.stop()
    assert timer.deadline is None and flushed == []


def test_debounce_stop_during_the_release_hand_off_keeps_the_next_session_live(setup):
    """Stop between EndImportEvent and the 0 ms timer: the next session's marks still get their windows."""
    timer, debouncer, flushed = setup
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode4", Change.ADDED)
    debouncer.release()
    debouncer.stop()
    timer.advance(1_000)
    debouncer.mark("vtkMRMLModelNode5", Change.APPEARANCE)
    assert timer.starts[-1] == 150
    timer.advance(150)
    assert [(at, dict(d.changes)) for at, d in flushed] == [
        (1_150, {"vtkMRMLModelNode5": Change.APPEARANCE})
    ]


def test_debounce_flush_after_a_flush_is_empty(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    debouncer.flush()
    debouncer.flush()
    assert len(flushed) == 1
    timer.advance(1_000)
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)  # a new window starts at this mark
    timer.advance(APPEARANCE_MS - 1)
    assert (
        len(flushed) == 1
    )  # not at once: the longest wait counts from this mark, not the first one
    timer.advance(1)
    assert len(flushed) == 2


def test_debounce_imports_nothing_from_slicer_or_qt():
    code = (
        "import sys; sys.path.append(sys.argv[1]); import remoteview_core.debounce\n"
        "print(sorted(m for m in sys.modules if m.split('.')[0] in {'slicer', 'qt', 'ctk', 'vtk', 'vtkmodules'}))\n"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", code, str(Path(debounce.__file__).parents[1])],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"
