"""SLC-15: coalescing scene changes — DirtySet and Debouncer with a fake timer and clock (FR-11, FR-12, NFR-02)."""

from __future__ import annotations

import itertools
import subprocess
import sys
from pathlib import Path

import pytest
from support import FakeTimer

from remoteview_core import debounce
from remoteview_core.debounce import (
    APPEARANCE_MAX_MS,
    APPEARANCE_MS,
    AT_ONCE,
    GEOMETRY_MAX_MS,
    GEOMETRY_MS,
    Change,
    Debouncer,
    DirtySet,
    Drained,
    SendPolicy,
)


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


@pytest.mark.parametrize("flags", [Change.NAME, Change.ADDED])
def test_debounce_re_exports_wait_like_geometry(setup, flags):
    """A rename (SLC-30) and an added node are shown by a re-export only: the 750 ms lane."""
    timer, debouncer, _ = setup
    debouncer.mark("vtkMRMLModelNode4", flags)
    assert timer.starts[-1] == GEOMETRY_MS


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
    """A slider dragged for 3 s: the viewers still get an update every ``longest`` ms (NFR-02). The geometry case
    marks a different node each time: a repeated ``geometry`` mark on one node re-bases the cap instead (SLC-36,
    below)."""
    timer, debouncer, flushed = setup
    for i in range(600):  # 6 s: at least two windows even for geometry
        node = f"vtkMRMLModelNode{i}" if flags & Change.GEOMETRY else "vtkMRMLModelNode4"
        debouncer.mark(node, flags)
        timer.advance(10)
    times = [at for at, _ in flushed]
    assert times[0] == longest and len(times) >= 2
    assert all(b - a <= longest + 10 for a, b in itertools.pairwise(times))
    assert len(times) >= 6_000 // (longest + 10)


# --------------------------------------------------------------------------- SLC-36: segment-editing bursts


def test_debounce_repeated_geometry_marks_on_one_node_flush_once_after_the_last(setup):
    """Painting one segment (every brush stroke ends in ``RepresentationModified``) or smoothing one model for 6 s:
    one flush, 750 ms after the last stroke — not a full-scene re-export every 2 s (plan correction, SLC-36)."""
    timer, debouncer, flushed = setup
    for _ in range(12):  # 0, 500, … 5500 ms
        debouncer.mark("vtkMRMLSegmentationNode1/Segment_1", Change.GEOMETRY)
        timer.advance(500)
    assert flushed == []  # 6 s of strokes: nothing yet (the old cap flushed at 2 s)
    timer.advance(GEOMETRY_MS - 500 - 1)
    assert flushed == []
    timer.advance(1)
    [(at, drained)] = flushed
    assert at == 5_500 + GEOMETRY_MS
    assert dict(drained.changes) == {"vtkMRMLSegmentationNode1/Segment_1": Change.GEOMETRY}
    timer.advance(5_000)
    assert len(flushed) == 1


def test_debounce_the_cap_holds_while_new_nodes_or_flags_keep_arriving(setup):
    """Geometry marks on different nodes every 500 ms: the 2 s cap of the oldest flushes what is pending; a repeated
    mark that adds a new flag to its node is not a repeat either."""
    timer, debouncer, flushed = setup
    for i in range(
        5
    ):  # A at 0, B at 500, C at 1000, D at 1500 → the cap at 2000; E at 2000 opens a new window
        debouncer.mark(f"vtkMRMLModelNode{i}", Change.GEOMETRY)
        timer.advance(500)
    [(at, drained)] = flushed
    assert at == GEOMETRY_MAX_MS and len(drained.changes) == 4
    flushed.clear()
    timer.advance(5_000)
    [(at, drained)] = flushed
    assert at == 2_000 + GEOMETRY_MS and list(drained.changes) == ["vtkMRMLModelNode4"]
    flushed.clear()
    # the same node, geometry then geometry|appearance then geometry: only the pure repeats re-base
    start = timer.now
    debouncer.mark("vtkMRMLModelNode9", Change.GEOMETRY)
    timer.advance(500)
    debouncer.mark(
        "vtkMRMLModelNode9", Change.GEOMETRY | Change.APPEARANCE
    )  # a new flag: no re-base
    timer.advance(500)
    debouncer.mark("vtkMRMLModelNode9", Change.GEOMETRY | Change.APPEARANCE)  # a repeat: re-based
    timer.advance(500)
    debouncer.mark("vtkMRMLModelNode9", Change.GEOMETRY)  # a repeat: re-based again
    timer.advance(5_000)
    [(at, _)] = flushed
    assert at == start + 1_500 + GEOMETRY_MS


def test_debounce_a_mark_on_another_node_during_a_burst_flushes_within_its_own_cap(setup):
    """NFR-02 under the re-base rule: a segment hidden in Slicer (one appearance mark) while another segment is being
    painted for 6 s leaves within 2 s of its own mark, with the burst's node — the re-base counts per node, so the
    burst postpones nothing but its own cap."""
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLSegmentationNode1/Segment_1", Change.GEOMETRY)  # at 0
    timer.advance(100)
    debouncer.mark("vtkMRMLSegmentationNode1/Segment_2", Change.APPEARANCE)  # at 100: hidden
    timer.advance(400)
    for _ in range(11):  # strokes at 500, 1000, … 5500 ms
        debouncer.mark("vtkMRMLSegmentationNode1/Segment_1", Change.GEOMETRY)
        timer.advance(500)
    timer.advance(5_000)
    assert [(at, dict(d.changes)) for at, d in flushed] == [
        (
            100 + GEOMETRY_MAX_MS,  # 2 s after the hidden segment's mark, not after the burst
            {
                "vtkMRMLSegmentationNode1/Segment_1": Change.GEOMETRY,
                "vtkMRMLSegmentationNode1/Segment_2": Change.APPEARANCE,
            },
        ),
        (5_500 + GEOMETRY_MS, {"vtkMRMLSegmentationNode1/Segment_1": Change.GEOMETRY}),
    ]


def test_debounce_a_reset_counts_from_itself(setup):
    """The marks before a close are dropped with it, so the cap of the reset counts from the close."""
    timer, debouncer, flushed = setup
    # the slow lane: nothing flushed before the close
    debouncer.mark("vtkMRMLModelNode4", Change.GEOMETRY)
    timer.advance(200)
    debouncer.reset()
    # not the 50 ms left of the dropped mark's fast-lane cap
    assert timer.starts[-1] == APPEARANCE_MS
    timer.advance(APPEARANCE_MS)
    [(at, drained)] = flushed
    assert at == 200 + APPEARANCE_MS and drained.reset and dict(drained.changes) == {}


def test_debounce_dirty_set_mark_says_whether_the_flags_were_pending():
    dirty = DirtySet()
    assert dirty.mark("vtkMRMLModelNode4", Change.GEOMETRY) is False
    assert dirty.mark("vtkMRMLModelNode4", Change.GEOMETRY) is True
    assert dirty.mark("vtkMRMLModelNode4", Change.GEOMETRY | Change.APPEARANCE) is False
    assert dirty.mark("vtkMRMLModelNode4", Change.APPEARANCE) is True
    assert dirty.mark("vtkMRMLModelNode5", Change.GEOMETRY) is False
    dirty.drain()
    assert dirty.mark("vtkMRMLModelNode4", Change.GEOMETRY) is False  # a new window


def test_debounce_repeated_appearance_marks_do_not_re_base(setup):
    """Only ``geometry`` re-bases: a slider dragged on one node still updates the viewers every 250 ms."""
    timer, debouncer, flushed = setup
    for _ in range(30):
        debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE | Change.TRANSFORM)
        timer.advance(50)
    assert [at for at, _ in flushed] == [250, 500, 750, 1_000, 1_250, 1_500]


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


def test_debounce_pending_says_whether_a_flush_waits(setup):
    """``pending`` (SLC-29): marks or a reset wait — held or not; a flush or ``stop`` empties it."""
    timer, debouncer, flushed = setup
    assert not debouncer.pending
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode4", Change.APPEARANCE)
    assert debouncer.pending
    debouncer.release()
    timer.advance(0)
    assert not debouncer.pending and len(flushed) == 1
    debouncer.reset()
    assert debouncer.pending
    debouncer.stop()
    assert not debouncer.pending


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


# --------------------------------------------------------------------------- SLC-56: the send policy


def test_debounce_send_policy_is_checked():
    assert AT_ONCE.lanes and not SendPolicy(delay_s=15).lanes and not SendPolicy(manual=True).lanes
    for bad in ({"delay_s": 0}, {"delay_s": -1}, {"delay_s": 3_600}, {"delay_s": True}):
        with pytest.raises(ValueError):
            SendPolicy(**bad)
    with pytest.raises(ValueError):
        SendPolicy(delay_s=15, manual=True)
    with pytest.raises(TypeError):
        Debouncer(FakeTimer(), lambda d: None, lambda: 0.0).set_policy("15")


def test_debounce_a_delay_counts_from_the_last_mark_without_a_cap(setup):
    """SLC-56: ``delay_s`` after the last change, whatever the lane, however long the burst — the countdown the toolbar
    shows runs from the last mark."""
    timer, debouncer, flushed = setup
    debouncer.set_policy(SendPolicy(delay_s=15))
    assert debouncer.due_in(timer.clock()) is None
    debouncer.mark("vtkMRMLModelNode1", Change.APPEARANCE)
    assert timer.starts[-1] == 15_000 and debouncer.due_in(timer.clock()) == 15.0
    for _ in range(10):  # a burst of 100 s: each mark restarts the wait
        timer.advance(10_000)
        debouncer.mark("vtkMRMLModelNode1", Change.GEOMETRY)
        assert flushed == [] and timer.starts[-1] == 15_000
    timer.advance(14_999)
    assert flushed == [] and debouncer.due_in(timer.clock()) == pytest.approx(0.001)
    timer.advance(1)
    [(at, drained)] = flushed
    assert (
        at == timer.now
        and drained.changes["vtkMRMLModelNode1"] == Change.APPEARANCE | Change.GEOMETRY
    )
    assert debouncer.due_in(timer.clock()) is None and not debouncer.pending


def test_debounce_manual_waits_for_send_now(setup):
    """SLC-56: under ``manual`` the marks wait, with nothing scheduled, until ``send_now``; with nothing pending
    ``send_now`` says so."""
    timer, debouncer, flushed = setup
    debouncer.set_policy(SendPolicy(manual=True))
    assert debouncer.send_now() is False
    debouncer.mark("vtkMRMLModelNode1", Change.ADDED)
    timer.advance(600_000)
    assert flushed == [] and timer.deadline is None and debouncer.pending
    assert debouncer.due_in(timer.clock()) is None
    assert debouncer.send_now() is True
    [(at, drained)] = flushed
    assert at == timer.now and dict(drained.changes) == {"vtkMRMLModelNode1": Change.ADDED}
    assert debouncer.send_now() is False


@pytest.mark.parametrize("policy", ["delay", "manual"])
def test_debounce_a_reset_keeps_the_lanes_under_every_policy(setup, policy):
    """§7.3: a closed scene must leave the viewers whatever the policy: the reset, with the marks after it, flushes by
    the lanes."""
    timer, debouncer, flushed = setup
    debouncer.set_policy(SendPolicy(delay_s=60) if policy == "delay" else SendPolicy(manual=True))
    debouncer.mark("vtkMRMLModelNode1", Change.APPEARANCE)
    debouncer.reset()
    assert timer.starts[-1] == APPEARANCE_MS
    debouncer.mark("vtkMRMLModelNode7", Change.ADDED)
    assert timer.starts[-1] == GEOMETRY_MS
    timer.advance(GEOMETRY_MS)
    [(_, drained)] = flushed
    assert drained.reset and dict(drained.changes) == {"vtkMRMLModelNode7": Change.ADDED}
    debouncer.mark("vtkMRMLModelNode7", Change.APPEARANCE)  # after the flush: the policy again
    assert timer.starts[-1] == (60_000 if policy == "delay" else GEOMETRY_MS)
    assert (timer.deadline is None) == (policy == "manual")


def test_debounce_a_hold_ends_by_the_policy_unless_send_now_was_asked(setup):
    """SLC-56: at the end of a batch the delay counts from there and manual keeps waiting — the 0 ms hand-off is the
    lanes' and ``send_now``'s."""
    timer, debouncer, flushed = setup
    debouncer.set_policy(SendPolicy(delay_s=30))
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode1", Change.ADDED)
    assert debouncer.due_in(timer.clock()) is None  # held: no countdown
    debouncer.release()
    assert timer.starts[-1] == 30_000 and flushed == [] and debouncer.due_in(timer.clock()) == 30.0
    timer.advance(30_000)
    assert len(flushed) == 1
    debouncer.set_policy(SendPolicy(manual=True))
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode2", Change.ADDED)
    debouncer.release()
    timer.advance(60_000)
    assert len(flushed) == 1 and timer.deadline is None and debouncer.pending
    debouncer.hold()
    assert (
        debouncer.send_now() is True
    )  # asked during a hold: flushed at its end, from the event loop
    assert flushed[-1:] == flushed[-1:] and len(flushed) == 1
    debouncer.release()
    assert timer.starts[-1] == 0
    timer.advance(0)
    assert len(flushed) == 2
    debouncer.set_policy(AT_ONCE)
    debouncer.hold()
    debouncer.mark("vtkMRMLModelNode3", Change.APPEARANCE)
    debouncer.release()
    assert timer.starts[-1] == 0


def test_debounce_a_new_policy_reschedules_the_pending_marks(setup):
    timer, debouncer, flushed = setup
    debouncer.mark("vtkMRMLModelNode1", Change.APPEARANCE)
    assert timer.starts[-1] == APPEARANCE_MS
    debouncer.set_policy(SendPolicy(delay_s=15))
    assert timer.starts[-1] == 15_000 and debouncer.due_in(timer.clock()) == 15.0
    timer.advance(5_000)
    debouncer.set_policy(SendPolicy(manual=True))
    assert timer.deadline is None and debouncer.due_in(timer.clock()) is None
    timer.advance(60_000)
    assert flushed == []
    debouncer.set_policy(AT_ONCE)  # the lanes: this mark is long past its cap
    assert timer.starts[-1] == 0
    timer.advance(0)
    assert len(flushed) == 1
    debouncer.set_policy(SendPolicy(delay_s=15))  # nothing pending: nothing scheduled
    assert timer.deadline is None and debouncer.due_in(timer.clock()) is None
