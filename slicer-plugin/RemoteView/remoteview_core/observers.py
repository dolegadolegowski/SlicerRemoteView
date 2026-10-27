"""Slicer scene observers of a live session (SLC-31; ``docs/research/slicer-live.md`` §1, §2, §7).

:class:`SceneWatcher` turns MRML events into marks of SLC-29's :class:`~remoteview_core.live.LiveUpdates` (the
*sink*) and does nothing else: no MRML writes, no exports, no mesh reads — a handler that changes MRML can make other
observers miss events (research note §5), and the flush runs later from the event loop.

- The scene: ``NodeAddedEvent`` (an exact-class model is watched and marked ``added``; a 3D view node marks every
  model ``appearance``), ``NodeRemovedEvent`` (``removed``, the node's observers go), ``StartBatchProcessEvent`` →
  ``hold()``, ``EndBatchProcessEvent`` → ``release()``, ``EndCloseEvent`` → ``reset()``. Close, import and restore
  always run inside a batch (research note §4), so the import events are not observed; attached in the middle of a
  batch, the watcher holds at once, so the batch's end finds its hold (``IsBatchProcessing`` from Python is
  [TODO verify], research note §4). The batch state is read with :meth:`SceneWatcher.batch_processing`, which fails
  open: a hold nothing releases would stop every update.
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
- Python receives every MRML event under the name ``'NoEvent'`` (research note §1), so each event has its own bound
  method; the two node events carry the node as call data (``calldata_type(VTK_OBJECT)``) and are called with two
  arguments when it is NULL. The watcher keeps its own observer tags (``detach`` removes every one), instead of
  ``slicer.util.VTKObservationMixin``, so it is tested here against real VTK dispatch.
- An exception would reach ``PyErr_Print``, which prints its text — often a node ID or name — to the console and the
  log file (T7): every handler catches ``Exception`` and logs its type only; :meth:`SceneWatcher.attach` raises a
  fixed text. An event on another thread marks nothing (MRML is main-thread only); :meth:`SceneWatcher.take_off_thread`
  tells the pump to ask for a fresh snapshot, and the pump brings the sink's batch hold in line with
  :meth:`SceneWatcher.batch_processing` (SLC-33: an ``EndBatchProcessEvent`` missed released nothing).

Pure: ``vtkmodules`` only; the event ids come from the adapter's ``slicer.vtkMRML*`` constants (:class:`MrmlEvents`).
Main thread only.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from vtkmodules.util.misc import calldata_type
from vtkmodules.vtkCommonCore import VTK_OBJECT, vtkCommand

from remoteview_core.debounce import Change
from remoteview_core.mrml_scene import MODEL_CLASS, VIEW_CLASS

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class MrmlEvents:
    """The MRML event ids the watcher observes, as Slicer defines them (``slicer.vtkMRMLScene.NodeAddedEvent`` …)."""

    node_added: int
    node_removed: int
    start_batch: int
    end_batch: int
    end_close: int
    display_modified: int  # vtkMRMLDisplayableNode
    mesh_modified: int  # vtkMRMLModelNode
    transform_modified: int  # vtkMRMLTransformableNode
    modified: int = int(vtkCommand.ModifiedEvent)


class Sink(Protocol):
    """What the watcher calls: SLC-29's ``LiveUpdates`` (none of these raise)."""

    def mark(self, node_id: str, flags: Change) -> None: ...

    def mark_transform(self, node_id: str) -> None: ...

    def hold(self) -> None: ...

    def release(self) -> None: ...

    def reset(self) -> None: ...


#: ``_Watched.matrix`` when the pose is unknown (not read yet, or unreadable): the next transform event marks.
_UNKNOWN = None


class _Watched:
    """One watched model node: its observer tags and what its events are compared with."""

    __slots__ = ("hidden", "matrix", "name", "node", "tags")

    def __init__(self, node: Any, name: Any, hidden: bool, matrix: Any) -> None:
        self.node = node
        self.tags: list[int] = []
        self.name = name
        self.hidden = hidden
        # the linear RAS world matrix last seen; None for a chain that is not linear, or unknown
        self.matrix = matrix


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
        return f"SceneWatcher(attached={self._attached}, models={len(self._nodes)})"

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
                entry.matrix = _UNKNOWN  # even if the listing fails: the next transform event of each model marks
            try:
                self._rescan()
            except Exception as exc:  # noqa: BLE001 — the adapter's text may carry an ID (T7)
                _log.error("live: scene not listed again (%s)", type(exc).__name__)
        return seen

    def _rescan(self) -> None:
        """The models are listed again — one added meanwhile is watched, one gone or replaced under the same ID is
        not — and the name and *HideFromEditors* caches are read again (the poses were forgotten before, and a model
        watched here has none), so that what the fresh snapshot sends is what later events compare with."""
        listed: dict[str, Any] = {}
        for node in self._nodes_by_class(MODEL_CLASS):
            node_id = node.GetID()
            if isinstance(node_id, str) and node_id:  # _watch takes the exact class only
                listed.setdefault(node_id, node)
        for node_id in [i for i, e in self._nodes.items() if listed.get(i) is not e.node]:
            self._unwatch(node_id)
        for node in listed.values():
            self._watch(node, read_pose=False)
        for entry in self._nodes.values():
            entry.name = entry.node.GetName()
            entry.hidden = bool(entry.node.GetHideFromEditors())

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
        """Observe the scene and every model node in it; idempotent. Call it after the sink's ``start()`` (a hold
        before that is ignored). Raises ``RuntimeError`` (fixed text, T7) when the scene cannot be read, with every
        observer removed again; a hold given to the sink meanwhile is cleared by the sink's ``stop()``."""
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
            for node in self._nodes_by_class(MODEL_CLASS):
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
        """Watch an exact-class model node. Its pose is not read inside ``NodeAddedEvent`` (``read_pose=False``): the
        parent transform reference may not be resolved yet there (research note §2 row 11)."""
        node_id = node.GetID()
        if node.GetClassName() != MODEL_CLASS or not isinstance(node_id, str) or not node_id:
            return None
        if node_id in self._nodes:
            return self._nodes[node_id]
        # everything that can fail is read before an observer is added
        entry = _Watched(
            node,
            node.GetName(),
            bool(node.GetHideFromEditors()),
            self._pose(node) if read_pose else _UNKNOWN,
        )
        events = self._events
        self._nodes[node_id] = entry
        for event, handler in (
            (events.display_modified, self._on_display),
            (events.mesh_modified, self._on_mesh),
            (events.transform_modified, self._on_transform),
            (events.modified, self._on_modified),
        ):
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

    # ------------------------------------------------------------------ what each event marks

    def _mark(self, node: Any, flags: Change) -> None:
        """A display or mesh change of a watched node not hidden from editors (a hidden one is re-exported whole
        when it is shown again)."""
        if node.GetID() in self._nodes and not node.GetHideFromEditors():
            self._sink.mark(node.GetID(), flags)

    def _transformed(self, node: Any) -> None:
        entry = self._nodes.get(node.GetID())
        if entry is None:
            return
        matrix = self._pose(node)
        same = (
            matrix is not None and entry.matrix is not None and np.array_equal(matrix, entry.matrix)
        )
        entry.matrix = matrix  # kept up to date while hidden too, so a later pose compares right
        if not same and not node.GetHideFromEditors():
            # unchanged: e.g. a parent transform renamed (its children's poses did not change)
            self._sink.mark_transform(node.GetID())

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
        elif name != entry.name and not hidden:
            flags |= Change.NAME
        entry.name, entry.hidden = name, hidden
        if flags:
            self._sink.mark(node_id, flags)

    def _added(self, node: Any) -> None:
        if node is None:
            return
        if node.GetClassName() == MODEL_CLASS:
            # neither its display node nor its pose is read here: a lazy reference resolution would fire events
            # (and write MRML) inside this one; its first transform event marks
            entry = self._watch(node, read_pose=False)
            if entry is not None and not entry.hidden:
                self._sink.mark(node.GetID(), Change.ADDED)
        elif node.IsA(VIEW_CLASS):
            self._mark_all(Change.APPEARANCE)  # what the 3D views show depends on them

    def _removed(self, node: Any) -> None:
        if node is None:
            return
        if self._unwatch(node.GetID()) is not None:  # the ID is kept while the event runs
            # hidden from editors too: the viewers may still hold it (the classifier ignores an ID they do not)
            self._sink.mark(node.GetID(), Change.REMOVED)
        elif node.IsA(VIEW_CLASS):
            self._mark_all(Change.APPEARANCE)

    def _mark_all(self, flags: Change) -> None:
        for node_id, entry in self._nodes.items():
            if not entry.hidden:
                self._sink.mark(node_id, flags)

    def _closed(self) -> None:
        # every model went through NodeRemovedEvent before EndCloseEvent; drop any left over defensively
        for node_id in [i for i, e in self._nodes.items() if e.node.GetScene() is None]:
            self._unwatch(node_id)
        self._sink.reset()
