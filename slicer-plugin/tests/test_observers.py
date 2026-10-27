"""SLC-31: the Slicer scene observers, driven by real VTK event dispatch (``docs/research/slicer-live.md`` §1, §2, §7).

The scene and the nodes are Python subclasses of ``vtkObject``: ``AddObserver``, ``InvokeEvent`` (with or without call
data) and ``RemoveObserver`` are VTK's own, so the handlers see what Slicer gives them — the event name ``'NoEvent'``,
the node as call data for the scene's node events, two arguments when the call data is NULL.
"""

from __future__ import annotations

import gc
import logging
import threading
import traceback
import weakref

import numpy as np
import pytest
from support import FakeTimer, LiveScene, ack, live_client
from vtkmodules.vtkCommonCore import VTK_OBJECT, vtkObject

from remoteview_core.debounce import Change, Debouncer
from remoteview_core.live import LiveUpdates
from remoteview_core.observers import MrmlEvents, SceneWatcher

#: The ids Slicer 5.12.4 defines: Libs/MRML/Core/vtkMRMLScene.h:692-726 (0x2000 + 1, + 3; state events
#: StateEvent | Start/EndEvent | state), vtkMRMLDisplayableNode.h:174, vtkMRMLModelNode.h:137,
#: vtkMRMLTransformableNode.h:73.
EVENTS = MrmlEvents(
    node_added=0x2001,
    node_removed=0x2003,
    start_batch=0x2101,
    end_batch=0x2201,
    end_close=0x2203,
    display_modified=17000,
    mesh_modified=17001,
    transform_modified=15000,
)
A, B, C, D = (f"vtkMRMLModelNode{i}" for i in (4, 5, 6, 7))


class Node(vtkObject):
    """An MRML node as the watcher reads it."""

    def __init__(self, node_id, *, cls="vtkMRMLModelNode", name="Liver", hidden=False, world=None):
        self.node_id, self.cls, self.name, self.hidden = node_id, cls, name, hidden
        self.world = np.eye(4) if world is None else world
        self.in_scene = True

    def GetID(self):  # noqa: N802 — the MRML API
        return self.node_id

    def GetClassName(self):  # noqa: N802
        return self.cls

    def IsA(self, name):  # noqa: N802
        return int(
            name == self.cls or (name == "vtkMRMLViewNode" and self.cls.endswith("ViewNode"))
        )

    def GetName(self):  # noqa: N802
        return self.name

    def GetHideFromEditors(self):  # noqa: N802
        return int(self.hidden)

    def GetScene(self):  # noqa: N802
        return object() if self.in_scene else None


class Scene(vtkObject):
    batch = False

    def __init__(self, *nodes):
        self.nodes = list(nodes)

    def IsBatchProcessing(self):  # noqa: N802
        return int(self.batch)

    def by_class(self, name):
        return [n for n in self.nodes if n.IsA(name)]

    def add(self, node):
        self.nodes.append(node)
        self.InvokeEvent(EVENTS.node_added, node)

    def remove(self, node):
        self.nodes.remove(node)
        node.in_scene = False
        self.InvokeEvent(EVENTS.node_removed, node)


class Recorder:
    """The sink: records every call."""

    def __init__(self):
        self.calls = []

    def mark(self, node_id, flags):
        self.calls.append(("mark", node_id, flags))

    def mark_transform(self, node_id):
        self.calls.append(("mark_transform", node_id))

    def hold(self):
        self.calls.append(("hold",))

    def release(self):
        self.calls.append(("release",))

    def reset(self):
        self.calls.append(("reset",))

    def take(self):
        calls, self.calls = self.calls, []
        return calls


def new_watcher(scene, sink, *, world_matrix=lambda node: node.world):
    return SceneWatcher(
        sink, scene=scene, events=EVENTS, nodes_by_class=scene.by_class, world_matrix=world_matrix
    )


def watched(*nodes, scene=None):
    scene = scene or Scene(*nodes)
    sink = Recorder()
    watcher = new_watcher(scene, sink)
    watcher.attach()
    return scene, sink, watcher


# --------------------------------------------------------------------------- criterion 1: what each event marks


def test_observers_display_mesh_and_transform_changes_mark_their_lanes():
    a = Node(A)
    _, sink, _ = watched(a)
    a.InvokeEvent(EVENTS.display_modified)
    a.InvokeEvent(EVENTS.mesh_modified)
    a.world = np.diag([1.0, 1.0, 1.0, 1.0])
    a.world[0, 3] = 5.0
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [
        ("mark", A, Change.APPEARANCE),
        ("mark", A, Change.GEOMETRY),
        ("mark_transform", A),
    ]


def test_observers_a_transform_event_with_an_unchanged_matrix_marks_nothing():
    """A parent transform renamed fires TransformModifiedEvent on every child (research note §2 row 7)."""
    a = Node(A)
    _, sink, _ = watched(a)
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == []
    a.world = a.world.copy()
    a.world[1, 3] = 2.0
    a.InvokeEvent(EVENTS.transform_modified)
    a.InvokeEvent(EVENTS.transform_modified)  # the same new pose again
    assert sink.take() == [("mark_transform", A)]


def test_observers_a_chain_that_is_not_linear_always_marks():
    a = Node(A)
    _, sink, _ = watched(a)
    a.world = None  # no matrix to compare
    a.InvokeEvent(EVENTS.transform_modified)
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [("mark_transform", A)] * 2


def test_observers_a_rename_marks_name_once():
    a = Node(A)
    _, sink, _ = watched(a)
    a.InvokeEvent(EVENTS.modified)  # an attribute or a reference: not the name
    a.name = "Liver Smith"
    a.Modified()
    a.Modified()
    assert sink.take() == [("mark", A, Change.NAME)]


def test_observers_hide_from_editors_flipping_marks_appearance_and_geometry():
    """Nothing a node hidden from editors does is marked: the viewers drop it when it is hidden and get it whole when
    it is shown again."""
    a = Node(A)
    _, sink, _ = watched(a)
    a.hidden = True
    a.Modified()
    # hidden from editors: never marked
    a.InvokeEvent(EVENTS.display_modified)
    a.InvokeEvent(EVENTS.mesh_modified)
    a.world = a.world.copy()
    a.world[0, 3] = 3.0
    a.InvokeEvent(EVENTS.transform_modified)
    a.name = "Liver Smith"
    a.Modified()
    a.hidden = False
    a.Modified()
    assert sink.take() == [("mark", A, Change.APPEARANCE | Change.GEOMETRY)] * 2
    a.InvokeEvent(EVENTS.transform_modified)  # the pose it was shown with: nothing new
    assert sink.take() == []


def test_observers_a_slice_plane_is_never_marked():
    plane = Node(D, name="Red Volume Slice", hidden=True)
    scene, sink, watcher = watched(plane)
    for event in (EVENTS.display_modified, EVENTS.mesh_modified, EVENTS.transform_modified):
        plane.InvokeEvent(event)
    plane.world = None
    plane.InvokeEvent(EVENTS.transform_modified)
    plane.name = "Yellow Volume Slice"
    plane.Modified()
    assert sink.take() == [] and watcher.observer_count == 5 + 4  # watched: it may be shown later
    scene.remove(plane)
    # a removal is marked whatever the node (the classifier ignores an ID the viewers do not hold)
    assert sink.take() == [("mark", D, Change.REMOVED)] and watcher.observer_count == 5


def test_observers_only_exact_class_models_are_watched():
    fibre = Node(C, cls="vtkMRMLFiberBundleNode")
    markups = Node(D, cls="vtkMRMLMarkupsFiducialNode")
    scene = Scene(fibre, markups)
    # getNodesByClass lists a subclass too
    scene.by_class = lambda name: [fibre] if name == "vtkMRMLModelNode" else []
    _, sink, watcher = watched(scene=scene)
    fibre.InvokeEvent(EVENTS.display_modified)
    scene.add(Node(B, cls="vtkMRMLMarkupsFiducialNode"))
    assert sink.take() == [] and watcher.observer_count == 5


def test_observers_a_node_added_is_watched_and_marked():
    scene, sink, watcher = watched(Node(A))
    b = Node(B)
    scene.add(b)
    b.InvokeEvent(EVENTS.display_modified)
    hidden = Node(C, hidden=True)
    scene.add(hidden)  # watched, not marked
    assert sink.take() == [("mark", B, Change.ADDED), ("mark", B, Change.APPEARANCE)]
    assert watcher.observer_count == 5 + 3 * 4


def test_observers_a_node_removed_is_marked_and_unwatched():
    a, b = Node(A), Node(B)
    scene, sink, watcher = watched(a, b)
    scene.remove(b)
    b.InvokeEvent(EVENTS.display_modified)
    assert sink.take() == [("mark", B, Change.REMOVED)]
    assert watcher.observer_count == 5 + 4 and not b.HasObserver(EVENTS.display_modified)


def test_observers_a_view_node_added_or_removed_marks_every_shown_model():
    a, b, plane = Node(A), Node(B), Node(D, hidden=True)
    view = Node("vtkMRMLViewNode2", cls="vtkMRMLViewNode")
    scene, sink, _ = watched(a, b, plane)
    scene.add(view)
    scene.remove(view)
    # IsA, not the exact class
    vr = Node("vtkMRMLVirtualRealityViewNode1", cls="vtkMRMLVirtualRealityViewNode")
    scene.add(vr)
    scene.remove(vr)
    expected = [("mark", A, Change.APPEARANCE), ("mark", B, Change.APPEARANCE)]
    assert sink.take() == expected * 4


def test_observers_node_events_without_call_data_raise_nothing(caplog, capsys):
    """VTK calls a handler with two arguments when the call data is NULL (the public ``NodeAdded()``); a handler that
    needed a third would raise ``TypeError`` inside VTK, which prints it (``PyErr_Print``) instead of raising."""
    assert SceneWatcher._on_node_added.CallDataType == VTK_OBJECT
    assert SceneWatcher._on_node_removed.CallDataType == VTK_OBJECT
    scene, sink, _ = watched(Node(A))
    capsys.readouterr()
    with caplog.at_level(logging.DEBUG, logger="remoteview_core.observers"):
        scene.InvokeEvent(EVENTS.node_added)
        scene.InvokeEvent(EVENTS.node_removed)
    assert sink.take() == [] and caplog.records == []
    assert capsys.readouterr().err == ""


def test_observers_batches_hold_and_release_and_a_close_resets():
    a = Node(A)
    scene, sink, watcher = watched(a)
    scene.InvokeEvent(EVENTS.start_batch)
    scene.remove(a)
    scene.InvokeEvent(EVENTS.end_close)
    scene.InvokeEvent(EVENTS.end_batch)
    assert sink.take() == [("hold",), ("mark", A, Change.REMOVED), ("reset",), ("release",)]
    assert watcher.observer_count == 5


def test_observers_a_close_drops_models_left_out_of_the_scene():
    a = Node(A)
    scene, sink, watcher = watched(a)
    a.in_scene = False  # removed without its event (defensive)
    scene.InvokeEvent(EVENTS.end_close)
    assert sink.take() == [("reset",)] and watcher.observer_count == 5


def test_observers_attached_during_a_batch_hold_at_once():
    scene = Scene(Node(A))
    scene.batch = True
    _, sink, _ = watched(scene=scene)
    assert sink.take() == [("hold",)]
    scene.InvokeEvent(EVENTS.end_batch)
    assert sink.take() == [("release",)]


def test_observers_an_event_on_another_thread_marks_nothing():
    a = Node(A)
    _, sink, watcher = watched(a)
    thread = threading.Thread(target=a.InvokeEvent, args=(EVENTS.display_modified,))
    thread.start()
    thread.join()
    assert sink.take() == []
    assert watcher.take_off_thread() is True and watcher.take_off_thread() is False


def test_observers_attach_is_idempotent_and_works_again_after_detach():
    a = Node(A)
    _, sink, watcher = watched(a)
    watcher.attach()
    assert watcher.observer_count == 5 + 4
    watcher.detach()
    watcher.attach()  # the next session
    assert watcher.observer_count == 5 + 4
    a.InvokeEvent(EVENTS.display_modified)
    assert sink.take() == [("mark", A, Change.APPEARANCE)]


def test_observers_a_node_added_twice_is_watched_once():
    a = Node(A)
    scene, sink, watcher = watched(a)
    scene.InvokeEvent(EVENTS.node_added, a)
    a.InvokeEvent(EVENTS.display_modified)
    assert watcher.observer_count == 5 + 4
    assert sink.take() == [("mark", A, Change.ADDED), ("mark", A, Change.APPEARANCE)]


# --------------------------------------------------------------------------- criterion 2: lifetime and T7


def test_observers_detach_removes_every_observer_and_frees_the_watcher():
    a, b = Node(A), Node(B)
    scene, sink, watcher = watched(a, b)
    watcher.detach()
    watcher.detach()
    assert watcher.observer_count == 0
    for event in (
        EVENTS.node_added,
        EVENTS.node_removed,
        EVENTS.start_batch,
        EVENTS.end_batch,
        EVENTS.end_close,
    ):
        assert not scene.HasObserver(event)
    for node in (a, b):
        for event in (
            EVENTS.display_modified,
            EVENTS.mesh_modified,
            EVENTS.transform_modified,
            EVENTS.modified,
        ):
            assert not node.HasObserver(event)
    a.InvokeEvent(EVENTS.display_modified)
    scene.add(Node(C))
    assert sink.take() == []
    gone = weakref.ref(watcher)
    del watcher
    gc.collect()
    assert gone() is None  # VTK keeps no reference to it


def test_observers_a_handler_error_logs_only_its_type(caplog):
    class Failing(Recorder):
        def mark(self, node_id, flags):
            raise KeyError(f"{node_id} Liver Smith")

    a = Node(A, name="Liver Smith")
    scene = Scene(a)
    watcher = new_watcher(scene, Failing())
    watcher.attach()
    with caplog.at_level(logging.DEBUG):
        # VTK would print the traceback of an escaping exception
        a.InvokeEvent(EVENTS.display_modified)
    assert "KeyError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


def test_observers_a_world_matrix_error_logs_only_its_type(caplog):
    a = Node(A)
    scene = Scene(a)
    reads = []

    def world(node):
        reads.append(node)
        if len(reads) > 1:
            raise RuntimeError(f"{A} Liver Smith")
        return node.world

    sink = Recorder()
    watcher = new_watcher(scene, sink, world_matrix=world)
    watcher.attach()
    with caplog.at_level(logging.DEBUG):
        a.InvokeEvent(EVENTS.transform_modified)
    # an unknown pose may have changed: marked, and the next one compares afresh
    assert sink.take() == [("mark_transform", A)] and "RuntimeError" in caplog.text
    assert A not in caplog.text and "Smith" not in caplog.text


def test_observers_repr_holds_no_node_id():
    _, _, watcher = watched(Node(A, name="Liver Smith"))
    assert repr(watcher) == "SceneWatcher(attached=True, models=1)"


# --------------------------------------------------------------------------- criterion 3: with the live controller


@pytest.fixture
def live_rig():
    timer = FakeTimer()
    client = live_client()
    scene_api = LiveScene(*({"id": i} for i in (A, B, C, D, "vtkMRMLModelNode8")))
    sent = []
    live = LiveUpdates(
        client,
        scene=lambda: scene_api,
        send=sent.append,
        discard_queued=lambda: None,
        timer=timer,
        clock=timer.clock,
        slicer_version="5.12.4",
        end_session=lambda text: None,
    )
    timer.callback = live.flush
    live.start()
    client.handle(ack(1))
    live.observe()
    sent.clear()
    return timer, scene_api, live, sent, client


def test_observers_a_closed_scene_flushes_one_reset_without_removals(live_rig):
    """Close Scene: hold, a removal per model, EndCloseEvent, release — one flush at 0 ms with the reset only, so the
    viewers get the new scene and no scene.nodeRemoved (§7.3)."""
    timer, scene_api, live, sent, _ = live_rig
    models = [Node(i) for i in (A, B, C, D, "vtkMRMLModelNode8")]
    scene = Scene(*models)
    watcher = new_watcher(scene, live)
    watcher.attach()
    scene.InvokeEvent(EVENTS.start_batch)
    for node in models:
        scene.remove(node)
    scene_api.nodes = []  # the closed scene
    scene.InvokeEvent(EVENTS.end_close)
    scene.InvokeEvent(EVENTS.end_batch)
    assert timer.deadline == timer.now  # the release: one flush at 0 ms
    timer.advance(0)
    live.tick()
    types = [m["type"] for m in sent if isinstance(m, dict)]
    assert types == ["scene.snapshot.begin", "scene.snapshot.end"]
    assert sent[0]["nodeCount"] == 0 and len(live.sent) == 0
    assert watcher.observer_count == 5


def test_observers_marks_reach_the_live_controller(live_rig):
    timer, scene_api, live, sent, _ = live_rig
    a = Node(A)
    scene = Scene(a)
    watcher = new_watcher(scene, live)
    watcher.attach()
    scene_api.node(A)["color"] = (0.1, 0.2, 0.3)
    a.InvokeEvent(EVENTS.display_modified)
    timer.advance(150)
    [update] = [m for m in sent if isinstance(m, dict)]
    assert update["type"] == "scene.update" and update["changes"] == [
        {"nodeId": A, "color": [0.1, 0.2, 0.3]}
    ]


# --------------------------------------------------------------------------- review round 1


def test_observers_a_node_added_is_not_read_for_its_pose():
    """In NodeAddedEvent the parent transform reference may not be resolved yet (and resolving it writes MRML)."""
    scene = Scene(Node(A))
    in_event = []
    reads = []
    sink = Recorder()

    def world(node):
        reads.append(node.GetID())
        assert not in_event, "pose read inside NodeAddedEvent"
        return node.world

    watcher = new_watcher(scene, sink, world_matrix=world)
    watcher.attach()
    b = Node(B)
    in_event.append(True)
    scene.add(b)
    in_event.clear()
    b.InvokeEvent(EVENTS.transform_modified)  # its first pose: marked
    b.InvokeEvent(EVENTS.transform_modified)
    assert reads == [A, B, B]
    assert sink.take() == [("mark", B, Change.ADDED), ("mark_transform", B)]


def test_observers_attach_failing_leaves_no_observer_and_logs_only_the_type(caplog):
    a, b = Node(A), Node(B)

    class Unnamed(Node):
        def GetName(self):  # noqa: N802
            raise KeyError(f"{B} Liver Smith")

    c = Unnamed(C)
    scene = Scene(a, c, b)
    sink = Recorder()
    watcher = new_watcher(scene, sink)
    with caplog.at_level(logging.DEBUG), pytest.raises(RuntimeError) as raised:
        watcher.attach()
    # neither the message nor a printed traceback carries the adapter's text (T7: `from None`)
    printed = "".join(traceback.format_exception(raised.value))
    assert (
        str(raised.value) == "the scene could not be observed" and raised.value.__suppress_context__
    )
    assert B not in printed and "Smith" not in printed
    assert watcher.observer_count == 0 and repr(watcher) == "SceneWatcher(attached=False, models=0)"
    assert not scene.HasObserver(EVENTS.node_added) and not a.HasObserver(EVENTS.display_modified)
    assert not c.HasObserver(EVENTS.display_modified)
    assert "KeyError" in caplog.text and B not in caplog.text and "Smith" not in caplog.text
    scene.nodes.remove(c)
    watcher.attach()  # works once the scene can be read
    assert watcher.observer_count == 5 + 2 * 4


def test_observers_an_event_on_another_thread_forgets_the_poses():
    a = Node(A)
    _, sink, watcher = watched(a)
    thread = threading.Thread(target=a.InvokeEvent, args=(EVENTS.transform_modified,))
    thread.start()
    thread.join()
    assert watcher.take_off_thread() is True
    # the pose the cache held: marked anyway, it is unknown now
    a.InvokeEvent(EVENTS.transform_modified)
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [("mark_transform", A)]


def test_observers_a_scene_event_on_another_thread_holds_nothing():
    scene, sink, watcher = watched(Node(A))
    thread = threading.Thread(target=scene.InvokeEvent, args=(EVENTS.start_batch,))
    thread.start()
    thread.join()
    assert sink.take() == [] and watcher.take_off_thread() is True


@pytest.mark.parametrize("node_id", [None, "", 7])
def test_observers_a_model_without_a_usable_id_is_not_watched(node_id):
    scene, sink, watcher = watched(Node(node_id))
    scene.add(Node(node_id))
    assert watcher.observer_count == 5 and sink.take() == []


class DebouncerSink:
    """SLC-15's debouncer behind the sink's interface, to see the drained sets themselves."""

    def __init__(self, timer, flushed):
        self.debouncer = Debouncer(timer, flushed.append, timer.clock)
        timer.callback = self.debouncer.flush

    def mark(self, node_id, flags):
        self.debouncer.mark(node_id, flags)

    def mark_transform(self, node_id):
        self.debouncer.mark(node_id, Change.TRANSFORM)

    def hold(self):
        self.debouncer.hold()

    def release(self):
        self.debouncer.release()

    def reset(self):
        self.debouncer.reset()


def test_observers_a_closed_scene_drains_one_reset_without_removals():
    """Criterion 3: Close Scene with five models the viewers hold — one flush at 0 ms, ``Drained(reset=True)`` and no
    removal (§7.3)."""
    timer, flushed = FakeTimer(), []
    models = [Node(i) for i in (A, B, C, D, "vtkMRMLModelNode8")]
    scene = Scene(*models)
    watcher = new_watcher(scene, DebouncerSink(timer, flushed))
    watcher.attach()
    scene.InvokeEvent(EVENTS.start_batch)
    for node in models:
        scene.remove(node)
    scene.InvokeEvent(EVENTS.end_close)
    scene.InvokeEvent(EVENTS.end_batch)
    assert timer.deadline == timer.now
    timer.advance(0)
    [drained] = flushed
    assert drained.reset and dict(drained.changes) == {}


def _hidden_from_editors(rig_scene, node, hidden):
    """Slicer: a model hidden from editors leaves what the 3D view shows (``MrmlSceneApi``)."""
    node.hidden = hidden
    rig_scene.node(node.GetID())["visible"] = not hidden
    node.Modified()


def test_observers_a_model_moved_while_hidden_from_editors_is_right_on_the_viewers(live_rig):
    """Hidden from editors, moved, shown again, moved back to its earlier pose: the viewers follow every step."""
    timer, scene_api, live, sent, client = live_rig
    a = Node(A)
    scene = Scene(a)
    watcher = new_watcher(scene, live)
    watcher.attach()

    def pose(x):
        world = np.eye(4)
        world[0, 3] = x
        a.world = world
        scene_api.node(A)["world"] = world
        a.InvokeEvent(EVENTS.transform_modified)

    def settle():
        """The flush, then the relay acknowledging any snapshot it sent."""
        timer.advance(750)
        live.tick()
        begins = [m for m in sent if isinstance(m, dict) and m["type"] == "scene.snapshot.begin"]
        sent.clear()
        for begin in begins:
            client.handle(ack(begin["sceneVersion"]))
            live.observe()
        timer.advance(0)

    _hidden_from_editors(scene_api, a, True)
    settle()
    assert A not in live.sent  # removed from the viewers: nothing it does is followed
    pose(7.0)
    _hidden_from_editors(scene_api, a, False)
    settle()
    # shown again: re-exported where it is
    assert live.sent.get(A).matrix[12] == pytest.approx(0.007)
    pose(0.0)  # back to the pose it had before it was hidden
    settle()
    assert live.sent.get(A).matrix[12] == 0.0


# --------------------------------------------------------------------------- review round 2


def test_observers_a_sub_millimetre_move_marks():
    """The world matrix is compared exactly: a fine registration nudge is a change."""
    a = Node(A)
    _, sink, _ = watched(a)
    a.world = a.world.copy()
    a.world[0, 3] = 1e-6
    a.InvokeEvent(EVENTS.transform_modified)
    a.world = a.world.copy()
    a.world[0, 1] = 1e-9  # one rotation element
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [("mark_transform", A)] * 2


def test_observers_take_off_thread_keeps_the_poses_when_nothing_happened():
    a = Node(A)
    _, sink, watcher = watched(a)
    assert watcher.take_off_thread() is False
    a.InvokeEvent(EVENTS.transform_modified)  # unchanged: a parent's rename
    assert sink.take() == []


def test_observers_models_added_and_removed_off_thread_are_followed_after_the_resync():
    a, b = Node(A), Node(B)
    scene, sink, watcher = watched(a)
    worker = threading.Thread(target=scene.add, args=(b,))
    worker.start()
    worker.join()
    worker = threading.Thread(target=scene.remove, args=(a,))
    worker.start()
    worker.join()
    assert sink.take() == [] and watcher.take_off_thread() is True
    assert watcher.observer_count == 5 + 4 and not a.HasObserver(EVENTS.display_modified)
    b.InvokeEvent(EVENTS.display_modified)
    scene.remove(b)
    assert sink.take() == [("mark", B, Change.APPEARANCE), ("mark", B, Change.REMOVED)]


def test_observers_a_model_still_in_the_scene_at_the_close_stays_watched():
    """Another EndCloseEvent observer may add a model before this one runs (Subject Hierarchy, research note §2
    row 13)."""
    a, b = Node(A), Node(B)
    scene, sink, watcher = watched(a)
    scene.InvokeEvent(EVENTS.start_batch)
    scene.remove(a)
    scene.add(b)
    scene.InvokeEvent(EVENTS.end_close)
    scene.InvokeEvent(EVENTS.end_batch)
    b.InvokeEvent(EVENTS.display_modified)
    assert sink.take()[-2:] == [("release",), ("mark", B, Change.APPEARANCE)]
    assert watcher.observer_count == 5 + 4


def test_observers_a_pose_change_whose_event_was_dropped_is_caught_at_the_flip():
    """MRML drops an event that reaches a node inside its own ProcessMRMLEvents (research note §5): the pose is read
    again when the node is shown."""
    a = Node(A)
    _, sink, _ = watched(a)
    a.hidden = True
    a.Modified()
    a.world = a.world.copy()
    a.world[0, 3] = 4.0  # no transform event
    a.hidden = False
    a.Modified()
    a.world = np.eye(4)  # back to the pose cached before it was hidden
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [("mark", A, Change.APPEARANCE | Change.GEOMETRY)] * 2 + [
        ("mark_transform", A)
    ]


def test_observers_a_pose_that_cannot_be_converted_marks():
    a = Node(A)
    scene = Scene(a)
    sink = Recorder()
    watcher = new_watcher(scene, sink, world_matrix=lambda node: node.world)
    watcher.attach()
    a.world = "not a matrix"
    a.InvokeEvent(EVENTS.transform_modified)
    assert sink.take() == [("mark_transform", A)]


# --------------------------------------------------------------------------- review round 3 (delta)


def off_thread(fn, *args):
    worker = threading.Thread(target=fn, args=args)
    worker.start()
    worker.join()


def test_observers_a_model_hidden_off_thread_then_shown_is_marked():
    a = Node(A)
    _, sink, watcher = watched(a)
    a.hidden = True
    off_thread(a.Modified)  # missed: the fresh snapshot leaves A out
    assert watcher.take_off_thread() is True
    a.hidden = False
    a.Modified()
    assert sink.take() == [("mark", A, Change.APPEARANCE | Change.GEOMETRY)]


def test_observers_a_model_renamed_off_thread_then_back_is_marked():
    a = Node(A, name="Liver")
    _, sink, watcher = watched(a)
    a.name = "Spleen"
    off_thread(a.Modified)  # missed: the fresh snapshot sends "Spleen"
    assert watcher.take_off_thread() is True
    a.name = "Liver"
    a.Modified()
    assert sink.take() == [("mark", A, Change.NAME)]


def test_observers_a_model_replaced_off_thread_under_the_same_id_is_watched():
    a, replacement = Node(A), Node(A)
    scene, sink, watcher = watched(a)

    def replace():
        scene.remove(a)
        scene.add(replacement)

    off_thread(replace)
    assert watcher.take_off_thread() is True
    replacement.InvokeEvent(EVENTS.display_modified)
    assert sink.take() == [("mark", A, Change.APPEARANCE)]
    assert watcher.observer_count == 5 + 4 and not a.HasObserver(EVENTS.display_modified)


def test_observers_a_rescan_that_fails_still_asks_for_the_snapshot(caplog):
    a = Node(A)
    scene = Scene(a)
    failing = []

    def nodes_by_class(name):
        if failing:
            raise KeyError(f"{A} Liver Smith")
        return scene.by_class(name)

    watcher = SceneWatcher(
        Recorder(),
        scene=scene,
        events=EVENTS,
        nodes_by_class=nodes_by_class,
        world_matrix=lambda node: node.world,
    )
    watcher.attach()
    off_thread(a.Modified)
    failing.append(True)
    with caplog.at_level(logging.DEBUG):
        assert watcher.take_off_thread() is True
    assert "KeyError" in caplog.text and A not in caplog.text and "Smith" not in caplog.text
