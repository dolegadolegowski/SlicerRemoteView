"""Slicer scene observers of a live session (SLC-31, SLC-36; ``docs/research/slicer-live.md`` §1, §2, §7;
``docs/research/slicer.md`` §2 "Segmentation nodes", §3).

:class:`SceneWatcher` turns MRML events into marks of SLC-29's :class:`~remoteview_core.live.LiveUpdates` (the
*sink*) and does nothing else: no MRML writes, no exports, no mesh reads — a handler that changes MRML can make other
observers miss events (research note §5), and the flush runs later from the event loop. Every mark carries the **raw**
MRML ID (and segment ID) the event's node reports; the sink resolves it through the session's alias registry (§7.3).

- The scene: ``NodeAddedEvent`` (an exact-class model or segmentation node is watched and marked ``added`` — a
  segmentation per current segment, usually none yet; a 3D view node marks every model and segment ``appearance``),
  ``NodeRemovedEvent`` (``removed`` for a model, ``mark_held_segments(removed)`` for a segmentation; the node's
  observers go), ``StartBatchProcessEvent`` → ``hold()``, ``EndBatchProcessEvent`` → ``release()``, ``EndCloseEvent``
  → ``reset()``. Close, import and restore always run inside a batch (research note §4), so the import events are not
  observed; attached in the middle of a batch, the watcher holds at once, so the batch's end finds its hold
  (``IsBatchProcessing`` from Python is [TODO verify], research note §4). The batch state is read with
  :meth:`SceneWatcher.batch_processing`, which fails open: a hold nothing releases would stop every update.
- Every exact-class ``vtkMRMLModelNode``, hidden ones too (shown later, it is marked): ``DisplayModifiedEvent`` →
  ``appearance`` (folder changes reach each model this way), ``MeshModifiedEvent`` → ``geometry``,
  ``TransformModifiedEvent`` → ``mark_transform`` unless the linear world matrix is unchanged (a parent transform's
  rename fires it too; the pose is not read inside ``NodeAddedEvent``, so a new node's first one marks),
  ``ModifiedEvent`` → ``name`` when the cached name changed. Nodes hidden from editors (slice planes, whose meshes
  change on every slice move) are not marked: when *HideFromEditors* flips, ``appearance|geometry`` makes the viewers
  drop the node, or get it whole when it is shown again — this relies on ``SetHideFromEditors`` firing the node's
  ``ModifiedEvent`` [TODO verify] (research note §2 row 10). A removal is marked for every watched node. A 3D view node
  is recognised with ``IsA("vtkMRMLViewNode")``, as ``mrml_scene.py`` does; that the virtual reality view node derives
  from it is [TODO verify] (research note §2 row 17).
- Every exact-class ``vtkMRMLSegmentationNode`` (SLC-36), 3 node observers + 5 ``vtkSegmentation`` events the node
  forwards (:class:`MrmlEvents`; ``SourceRepresentationModified`` and ``SegmentsOrderModified`` are not observed: a
  pass-through and an order change mean nothing to the export). The segment events carry the segment ID as
  ``char*`` (``calldata_type(VTK_STRING)``) on the immediate path and **NULL** when deferred at ``EndModify``
  [TODO verify] — a call data that is not a ``str`` is the whole-node case: ``SegmentAdded(id)`` → ``added``, NULL →
  ``added`` for every ID ``GetSegmentIDs()`` lists that the cached list did not; ``SegmentRemoved(id)`` →
  ``removed``, NULL → ``removed`` for every cached ID that is gone; ``SegmentModified(id)`` → ``appearance``, plus
  ``name`` only when the segment's name (``GetSegment(id).GetName()``, a read, research note §2) differs from the
  cached one — as ``ModifiedEvent`` does for a model, so that ``name`` means *renamed*: the classifier removes a
  hidden held node marked ``name`` as surely renamed, and a hidden segment whose colour changed must stay a
  ``visible: false``; NULL → the same for every current segment and ``mark_held_segments(appearance)`` — **never**
  ``geometry``, and never ``name`` for a name that did not change: an export's own display getters run
  ``UpdateSegmentList()`` and may fire a deferred ``SegmentModified(NULL)``, which as ``geometry`` would re-export
  the scene after every export and as ``name`` would remove every hidden held segment after every export;
  ``RepresentationModified(id)`` → ``geometry`` (the end of every brush stroke), NULL → ``geometry`` for current and
  held; ``ContainedRepresentationNamesModified`` (no call data: *Show 3D* on/off) → ``geometry`` for current and
  held, so a segment no longer drawn leaves the viewers (the classifier's stale rule) and one drawn again comes back;
  ``DisplayModifiedEvent`` → ``appearance`` for current and held (the display node does not say which segment);
  ``TransformModifiedEvent`` → ``mark_segment_transform`` per cached segment unless the linear pose is unchanged;
  ``ModifiedEvent`` → a *HideFromEditors* flip marks ``appearance|geometry`` for current and held, a node rename
  nothing (segment names come from the segments). The segment cache (``GetSegmentIDs()`` and each segment's name,
  read at watch time — inside ``NodeAddedEvent`` too, where these reads write nothing [TODO verify] —, on every
  add/remove and in the re-scan; a ``SegmentModified`` refreshes the names it compared, never the ID list) is what
  the NULL cases diff against.
- Python receives every MRML event under the name ``'NoEvent'`` (research note §1), so each event has its own bound
  method; the two node events carry the node as call data (``calldata_type(VTK_OBJECT)``) and are called with two
  arguments when it is NULL. The watcher keeps its own observer tags (``detach`` removes every one), instead of
  ``slicer.util.VTKObservationMixin``, so it is tested here against real VTK dispatch.
- An exception would reach ``PyErr_Print``, which prints its text — often a node ID or name — to the console and the
  log file (T7): every handler catches ``Exception`` and logs its type only; :meth:`SceneWatcher.attach` raises a
  fixed text. An event on another thread marks nothing (MRML is main-thread only); :meth:`SceneWatcher.take_off_thread`
  tells the pump to ask for a fresh snapshot, and the pump brings the sink's batch hold in line with
  :meth:`SceneWatcher.batch_processing` (SLC-33: an ``EndBatchProcessEvent`` missed released nothing).

Pure: ``vtkmodules`` only; the event ids come from the adapter's ``slicer.vtkMRML*``/``slicer.vtkSegmentation``
constants (:class:`MrmlEvents`). Main thread only.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from vtkmodules.util.misc import calldata_type
from vtkmodules.vtkCommonCore import VTK_OBJECT, VTK_STRING, vtkCommand

from remoteview_core.debounce import Change
from remoteview_core.mrml_scene import MODEL_CLASS, SEGMENTATION_CLASS, VIEW_CLASS

_log = logging.getLogger(__name__)

#: ``_Watched.kind`` values.
MODEL = "model"
SEGMENTATION = "segmentation"


@dataclass(frozen=True)
class MrmlEvents:
    """The MRML event ids the watcher observes, as Slicer defines them (``slicer.vtkMRMLScene.NodeAddedEvent`` …,
    ``slicer.vtkSegmentation.SegmentAdded`` …). The five segment events are keyword-only without defaults: a misspelt
    constant fails in the adapter's test, not in a session."""

    node_added: int
    node_removed: int
    start_batch: int
    end_batch: int
    end_close: int
    display_modified: int  # vtkMRMLDisplayableNode
    mesh_modified: int  # vtkMRMLModelNode
    transform_modified: int  # vtkMRMLTransformableNode
    modified: int = int(vtkCommand.ModifiedEvent)
    # vtkSegmentation, forwarded by vtkMRMLSegmentationNode (SLC-36)
    segment_added: int = field(kw_only=True)
    segment_removed: int = field(kw_only=True)
    segment_modified: int = field(kw_only=True)
    representation_modified: int = field(kw_only=True)
    representation_names_modified: int = field(kw_only=True)


class Sink(Protocol):
    """What the watcher calls: SLC-29's ``LiveUpdates`` (none of these raise). Every ID is raw: the sink resolves."""

    def mark(self, node_id: str, flags: Change) -> None: ...

    def mark_transform(self, node_id: str) -> None: ...

    def mark_segment(self, node_id: str, segment_id: Any, flags: Change) -> None: ...

    def mark_segment_transform(self, node_id: str, segment_id: Any) -> None: ...

    def mark_held_segments(self, node_id: str, flags: Change) -> None: ...

    def hold(self) -> None: ...

    def release(self) -> None: ...

    def reset(self) -> None: ...


#: ``_Watched.matrix`` when the pose is unknown (not read yet, or unreadable): the next transform event marks. Also a
#: segment name that could not be read: compared with a name that was, it counts as a rename (conservative, like the
#: unknown pose: the classifier re-checks the real name of a shown segment).
_UNKNOWN = None


class _Watched:
    """One watched node (a model or a segmentation): its observer tags and what its events are compared with."""

    __slots__ = ("hidden", "kind", "matrix", "name", "node", "segments", "tags")

    def __init__(  # noqa: PLR0913 — one argument per cached property
        self, node: Any, name: Any, hidden: bool, matrix: Any, *, kind: str, segments: dict
    ) -> None:
        self.node = node
        self.kind = kind
        self.tags: list[int] = []
        self.name = name
        self.hidden = hidden
        # the linear RAS world matrix last seen; None for a chain that is not linear, or unknown
        self.matrix = matrix
        # a segmentation's segments as GetSegmentIDs() last listed them, each with the name last seen ({} for a model)
        self.segments = segments


def _segmentation_of(node: Any) -> Any:
    """``GetSegmentation()`` of a segmentation node; ``None`` when it cannot be read (type-only log, T7)."""
    try:
        return node.GetSegmentation()
    except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
        _log.error("live: segment list not read (%s)", type(exc).__name__)
        return None


def _segment_name(segmentation: Any, segment_id: Any) -> Any:
    """``GetSegment(id).GetName()`` (reads, research note §2 [S19]); :data:`_UNKNOWN` for a segment the segmentation
    does not have or a read that fails (type-only log, T7)."""
    if segmentation is None:
        return _UNKNOWN
    try:
        segment = segmentation.GetSegment(segment_id)
        return _UNKNOWN if segment is None else segment.GetName()
    except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID or a name (T7)
        _log.error("live: segment name not read (%s)", type(exc).__name__)
        return _UNKNOWN


def _segments(node: Any) -> dict:
    """The segments of a segmentation node, ``GetSegmentation().GetSegmentIDs()`` in order, each with its name
    (:func:`_segment_name`); ``{}`` when the list cannot be read (type-only log, T7)."""
    segmentation = _segmentation_of(node)
    if segmentation is None:
        return {}
    try:
        ids = tuple(segmentation.GetSegmentIDs())
    except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
        _log.error("live: segment list not read (%s)", type(exc).__name__)
        return {}
    return {segment_id: _segment_name(segmentation, segment_id) for segment_id in ids}


class SceneWatcher:
    """The observers of one live session (see the module docstring).

    ``scene`` is the MRML scene, ``nodes_by_class(name)`` returns its nodes of a class like
    ``slicer.util.getNodesByClass``, ``world_matrix(node)`` is ``MrmlSceneApi.world_matrix`` (the matrix collect uses;
    ``None`` for a chain that is not linear).
    """

    def __init__(
        self,
        sink: Sink,
        *,
        scene: Any,
        events: MrmlEvents,
        nodes_by_class: Callable[[str], Iterable[Any]],
        world_matrix: Callable[[Any], Any],
    ) -> None:
        self._sink = sink
        self._scene = scene
        self._events = events
        self._nodes_by_class = nodes_by_class
        self._world_matrix = world_matrix
        self._attached = False
        self._scene_tags: list[int] = []
        self._nodes: dict[str, _Watched] = {}
        self._main = threading.get_ident()
        self._off_thread = False
        self._off_thread_lock = threading.Lock()

    def __repr__(self) -> str:  # counts only (T7)
        models = sum(e.kind == MODEL for e in self._nodes.values())
        return (
            f"SceneWatcher(attached={self._attached}, models={models}, "
            f"segmentations={len(self._nodes) - models})"
        )

    @property
    def observer_count(self) -> int:
        """The observers this watcher has added and not removed yet."""
        return len(self._scene_tags) + sum(len(entry.tags) for entry in self._nodes.values())

    def take_off_thread(self) -> bool:
        """An event arrived on another thread since the last call: it marked nothing, so ask for a fresh snapshot.
        Called from the pump (main thread, outside MRML events): what the missed events may have changed is read
        again (see :meth:`_rescan`)."""
        with self._off_thread_lock:
            seen, self._off_thread = self._off_thread, False
        if seen and self._attached:
            for entry in self._nodes.values():
                entry.matrix = _UNKNOWN  # even if the listing fails: the next transform event of each node marks
            try:
                self._rescan()
            except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
                _log.error("live: scene not listed again (%s)", type(exc).__name__)
        return seen

    def _rescan(self) -> None:
        """The models and segmentations are listed again — one added meanwhile is watched, one gone or replaced under
        the same ID is not — and the name, *HideFromEditors* and segment ID caches are read again (the poses were
        forgotten before, and a node watched here has none), so that what the fresh snapshot sends is what later
        events compare with."""
        listed: dict[str, Any] = {}
        for class_name in (MODEL_CLASS, SEGMENTATION_CLASS):
            for node in self._nodes_by_class(class_name):
                node_id = node.GetID()
                if isinstance(node_id, str) and node_id:  # _watch takes the exact classes only
                    listed.setdefault(node_id, node)
        for node_id in [i for i, e in self._nodes.items() if listed.get(i) is not e.node]:
            self._unwatch(node_id)
        for node in listed.values():
            self._watch(node, read_pose=False)
        for entry in self._nodes.values():
            entry.name = entry.node.GetName()
            entry.hidden = bool(entry.node.GetHideFromEditors())
            if entry.kind == SEGMENTATION:
                entry.segments = _segments(entry.node)

    def batch_processing(self) -> bool:
        """``IsBatchProcessing()`` of the scene; ``False`` when it cannot be read (fail open: a hold that nothing
        releases would stop every update; the type of the error is logged only, T7)."""
        try:
            return bool(self._scene.IsBatchProcessing())
        except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
            _log.error("live: batch state not read (%s)", type(exc).__name__)
            return False

    # ------------------------------------------------------------------ lifecycle (main thread)

    def attach(self) -> None:
        """Observe the scene and every model and segmentation node in it; idempotent. Call it after the sink's
        ``start()`` (a hold before that is ignored). Raises ``RuntimeError`` (fixed text, T7) when the scene cannot be
        read, with every observer removed again; a hold given to the sink meanwhile is cleared by the sink's
        ``stop()``."""
        if self._attached:
            return
        self._attached = True
        self._main = threading.get_ident()
        try:
            events = self._events
            for event, handler in (
                (events.node_added, self._on_node_added),
                (events.node_removed, self._on_node_removed),
                (events.start_batch, self._on_start_batch),
                (events.end_batch, self._on_end_batch),
                (events.end_close, self._on_end_close),
            ):
                self._scene_tags.append(self._scene.AddObserver(event, handler))
            if self.batch_processing():
                self._sink.hold()  # the batch's EndBatchProcessEvent releases it
            for class_name in (MODEL_CLASS, SEGMENTATION_CLASS):
                for node in self._nodes_by_class(class_name):
                    self._watch(node, read_pose=True)
        except Exception as exc:  # noqa: BLE001 — the text may carry a node ID (T7); a fixed one replaces it
            _log.error("live: scene not observed (%s)", type(exc).__name__)
            self.detach()
            raise RuntimeError("the scene could not be observed") from None

    def detach(self) -> None:
        """Remove every observer (Stop, the session's end, the module's cleanup); idempotent. An event seen off the main
        thread before is forgotten: it belongs to the session that ends."""
        self._attached = False
        tags, self._scene_tags = self._scene_tags, []
        for tag in tags:
            self._scene.RemoveObserver(tag)
        for node_id in list(self._nodes):
            self._unwatch(node_id)
        with self._off_thread_lock:  # after the observers are gone: no event can set it again
            self._off_thread = False

    # ------------------------------------------------------------------ watched nodes

    def _watch(self, node: Any, *, read_pose: bool) -> _Watched | None:
        """Watch an exact-class model or segmentation node. Its pose is not read inside ``NodeAddedEvent``
        (``read_pose=False``): the parent transform reference may not be resolved yet there (research note §2
        row 11); a segmentation's segment IDs and names are (``GetSegmentIDs()``, ``GetSegment(id).GetName()`` write
        nothing [TODO verify])."""
        node_id = node.GetID()
        class_name = node.GetClassName()
        if class_name == MODEL_CLASS:
            kind = MODEL
        elif class_name == SEGMENTATION_CLASS:
            kind = SEGMENTATION
        else:
            return None
        if not isinstance(node_id, str) or not node_id:
            return None
        if node_id in self._nodes:
            return self._nodes[node_id]
        # everything that can fail is read before an observer is added
        entry = _Watched(
            node,
            node.GetName(),
            bool(node.GetHideFromEditors()),
            self._pose(node) if read_pose else _UNKNOWN,
            kind=kind,
            segments=_segments(node) if kind == SEGMENTATION else {},
        )
        events = self._events
        self._nodes[node_id] = entry
        handlers: list[tuple[int, Callable[..., None]]] = [
            (events.display_modified, self._on_display),
            (events.transform_modified, self._on_transform),
            (events.modified, self._on_modified),
        ]
        if kind == MODEL:
            handlers.append((events.mesh_modified, self._on_mesh))
        else:
            handlers += [
                (events.segment_added, self._on_segment_added),
                (events.segment_removed, self._on_segment_removed),
                (events.segment_modified, self._on_segment_modified),
                (events.representation_modified, self._on_representation_modified),
                (events.representation_names_modified, self._on_representation_names),
            ]
        for event, handler in handlers:
            entry.tags.append(node.AddObserver(event, handler))
        return entry

    def _unwatch(self, node_id: str) -> _Watched | None:
        entry = self._nodes.pop(node_id, None)
        if entry is not None:
            for tag in entry.tags:
                entry.node.RemoveObserver(tag)
        return entry

    def _pose(self, node: Any) -> Any:
        """The node's linear world matrix, or ``None`` (a chain that is not linear, or a read that failed)."""
        try:
            matrix = self._world_matrix(node)
            return None if matrix is None else np.array(matrix, dtype=np.float64)
        except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
            _log.error("live: pose not read (%s)", type(exc).__name__)
            return _UNKNOWN

    # ------------------------------------------------------------------ handlers (never raise; T7)

    def _guard(self, handle: Callable[..., None], *args: Any) -> None:
        if threading.get_ident() != self._main:
            with self._off_thread_lock:  # MRML and the sink are main-thread only
                self._off_thread = True
            return
        try:
            handle(*args)
        except Exception as exc:  # noqa: BLE001 — PyErr_Print would show the text (node IDs, names)
            _log.error("live: scene observer failed (%s)", type(exc).__name__)

    def _on_display(self, caller: Any, event: str) -> None:
        self._guard(self._mark, caller, Change.APPEARANCE)

    def _on_mesh(self, caller: Any, event: str) -> None:
        self._guard(self._mark, caller, Change.GEOMETRY)

    def _on_transform(self, caller: Any, event: str) -> None:
        self._guard(self._transformed, caller)

    def _on_modified(self, caller: Any, event: str) -> None:
        self._guard(self._modified, caller)

    @calldata_type(VTK_OBJECT)
    def _on_node_added(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._added, calldata)

    @calldata_type(VTK_OBJECT)
    def _on_node_removed(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._removed, calldata)

    def _on_start_batch(self, caller: Any, event: str) -> None:
        self._guard(self._sink.hold)

    def _on_end_batch(self, caller: Any, event: str) -> None:
        self._guard(self._sink.release)

    def _on_end_close(self, caller: Any, event: str) -> None:
        self._guard(self._closed)

    # the segment ID as char* on the immediate path; two arguments (None) when the call data is NULL
    @calldata_type(VTK_STRING)
    def _on_segment_added(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._segment_added, caller, calldata)

    @calldata_type(VTK_STRING)
    def _on_segment_removed(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._segment_removed, caller, calldata)

    @calldata_type(VTK_STRING)
    def _on_segment_modified(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._segment_modified, caller, calldata)

    @calldata_type(VTK_STRING)
    def _on_representation_modified(self, caller: Any, event: str, calldata: Any = None) -> None:
        self._guard(self._segment_changed, caller, calldata, Change.GEOMETRY)

    def _on_representation_names(self, caller: Any, event: str) -> None:
        self._guard(self._segment_changed, caller, None, Change.GEOMETRY)

    # ------------------------------------------------------------------ what each event marks

    def _mark(self, node: Any, flags: Change) -> None:
        """A display or mesh change of a watched node not hidden from editors (a hidden one is re-exported whole
        when it is shown again); of a segmentation, every current and held segment (``flags`` never carry ``name``
        here)."""
        entry = self._nodes.get(node.GetID())
        if entry is not None and not node.GetHideFromEditors():
            self._mark_entry(node.GetID(), entry, flags)

    def _mark_entry(self, node_id: str, entry: _Watched, flags: Change) -> None:
        if entry.kind == MODEL:
            self._sink.mark(node_id, flags)
        else:
            self._each_segment(node_id, entry, flags)
            self._sink.mark_held_segments(node_id, flags)

    def _each_segment(self, node_id: str, entry: _Watched, flags: Change) -> None:
        for segment_id in entry.segments:
            self._sink.mark_segment(node_id, segment_id, flags)

    def _transformed(self, node: Any) -> None:
        entry = self._nodes.get(node.GetID())
        if entry is None:
            return
        matrix = self._pose(node)
        same = (
            matrix is not None and entry.matrix is not None and np.array_equal(matrix, entry.matrix)
        )
        entry.matrix = matrix  # kept up to date while hidden too, so a later pose compares right
        if same or node.GetHideFromEditors():
            # unchanged: e.g. a parent transform renamed (its children's poses did not change)
            return
        if entry.kind == MODEL:
            self._sink.mark_transform(node.GetID())
        else:
            for segment_id in entry.segments:
                self._sink.mark_segment_transform(node.GetID(), segment_id)

    def _modified(self, node: Any) -> None:
        node_id = node.GetID()
        entry = self._nodes.get(node_id)
        if entry is None:
            return
        name, hidden = node.GetName(), bool(node.GetHideFromEditors())
        flags = Change(0)
        if hidden != entry.hidden:
            # it enters or leaves what the 3D view shows, and nothing it did while hidden was marked: the viewers
            # drop it when it is hidden (a stale mesh, pose or name), and get it whole when it is shown again
            flags |= Change.APPEARANCE | Change.GEOMETRY
            entry.matrix = self._pose(node)
            if entry.kind == SEGMENTATION:
                entry.segments = _segments(node)  # its segments may have changed meanwhile
        elif name != entry.name and not hidden and entry.kind == MODEL:
            flags |= Change.NAME  # a segmentation's name is not exported: its segments' are
        entry.name, entry.hidden = name, hidden
        if flags:
            self._mark_entry(node_id, entry, flags)

    def _segment_added(self, node: Any, segment_id: Any) -> None:
        entry = self._nodes.get(node.GetID())
        if entry is None:
            return
        before, entry.segments = entry.segments, _segments(node)
        if node.GetHideFromEditors():
            return
        if isinstance(segment_id, str):
            self._sink.mark_segment(node.GetID(), segment_id, Change.ADDED)
        else:  # NULL (deferred at EndModify): whatever the list has that the cache had not
            for new in entry.segments:
                if new not in before:
                    self._sink.mark_segment(node.GetID(), new, Change.ADDED)

    def _segment_removed(self, node: Any, segment_id: Any) -> None:
        entry = self._nodes.get(node.GetID())
        if entry is None:
            return
        before, entry.segments = entry.segments, _segments(node)
        # hidden from editors too: the viewers may still hold it (the classifier ignores an ID they do not)
        if isinstance(segment_id, str):
            self._sink.mark_segment(node.GetID(), segment_id, Change.REMOVED)
        else:
            for gone in before:
                if gone not in entry.segments:
                    self._sink.mark_segment(node.GetID(), gone, Change.REMOVED)

    def _segment_changed(self, node: Any, segment_id: Any, flags: Change) -> None:
        """``RepresentationModified`` and ``ContainedRepresentationNamesModified`` (``geometry``; the latter has no call
        data): one segment, or — NULL — every current segment and every held one."""
        entry = self._nodes.get(node.GetID())
        if entry is None or node.GetHideFromEditors():
            return
        if isinstance(segment_id, str):
            self._sink.mark_segment(node.GetID(), segment_id, flags)
            return
        self._each_segment(node.GetID(), entry, flags)
        self._sink.mark_held_segments(node.GetID(), flags)

    def _segment_modified(self, node: Any, segment_id: Any) -> None:
        """``SegmentModified``: ``appearance`` of one segment, or — NULL — of every current segment and every held one,
        plus ``name`` only for a segment whose name is not the cached one (:meth:`_segment_flags`). The ID list is not
        read again here: a deferred ``SegmentAdded``/``SegmentRemoved`` (NULL) still has to diff against the cache."""
        entry = self._nodes.get(node.GetID())
        if entry is None or node.GetHideFromEditors():
            return
        node_id = node.GetID()
        if isinstance(segment_id, str):
            flags = self._segment_flags(node, entry, segment_id)
            self._sink.mark_segment(node_id, segment_id, flags)
            return
        if entry.segments:
            segmentation = _segmentation_of(node)
            for current in list(entry.segments):
                flags = self._segment_flags(node, entry, current, segmentation)
                self._sink.mark_segment(node_id, current, flags)
        self._sink.mark_held_segments(node_id, Change.APPEARANCE)

    @staticmethod
    def _segment_flags(
        node: Any, entry: _Watched, segment_id: Any, segmentation: Any = None
    ) -> Change:
        """``appearance``, and ``name`` when the segment's name differs from the cached one (the cache is refreshed);
        a segment the cache does not know has no cached name, so it counts as renamed unless it has none either."""
        if segmentation is None:
            segmentation = _segmentation_of(node)
        name = _segment_name(segmentation, segment_id)
        renamed = name != entry.segments.get(segment_id, _UNKNOWN)
        if segment_id in entry.segments:
            entry.segments[segment_id] = name
        return Change.APPEARANCE | Change.NAME if renamed else Change.APPEARANCE

    def _added(self, node: Any) -> None:
        if node is None:
            return
        class_name = node.GetClassName()
        if class_name in (MODEL_CLASS, SEGMENTATION_CLASS):
            # neither its display node nor its pose is read here: a lazy reference resolution would fire events
            # (and write MRML) inside this one; its first transform event marks
            entry = self._watch(node, read_pose=False)
            if entry is None or entry.hidden:
                return
            if entry.kind == MODEL:
                self._sink.mark(node.GetID(), Change.ADDED)
            else:
                self._each_segment(node.GetID(), entry, Change.ADDED)
        elif node.IsA(VIEW_CLASS):
            self._mark_all(Change.APPEARANCE)  # what the 3D views show depends on them

    def _removed(self, node: Any) -> None:
        if node is None:
            return
        entry = self._unwatch(node.GetID())  # the ID is kept while the event runs
        if entry is not None:
            # hidden from editors too: the viewers may still hold it (the classifier ignores an ID they do not)
            if entry.kind == MODEL:
                self._sink.mark(node.GetID(), Change.REMOVED)
            else:
                self._sink.mark_held_segments(node.GetID(), Change.REMOVED)
        elif node.IsA(VIEW_CLASS):
            self._mark_all(Change.APPEARANCE)

    def _mark_all(self, flags: Change) -> None:
        for node_id, entry in self._nodes.items():
            if not entry.hidden:
                self._mark_entry(node_id, entry, flags)

    def _closed(self) -> None:
        # every node went through NodeRemovedEvent before EndCloseEvent; drop any left over defensively
        for node_id in [i for i, e in self._nodes.items() if e.node.GetScene() is None]:
            self._unwatch(node_id)
        self._sink.reset()
