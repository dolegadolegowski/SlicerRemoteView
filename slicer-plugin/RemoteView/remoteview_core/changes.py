"""What a set of live scene changes needs on the wire (SLC-30; protocol §8): SLC-15's drained marks, classified against
the current scene and what the viewers hold.

:func:`classify` reads only what changed — display properties, world transforms, names, and for a node the last export
left out without triangles its cell counts — never a mesh, and returns a :class:`Plan`: the ``scene.update`` items
(:class:`~remoteview_core.protocol_client.NodeChange`) and removed IDs SLC-16 sends, or a re-export when only a new
snapshot can show the change (§8.2: v1 has no per-node geometry):

- ``appearance`` of a node the viewers hold → the properties that differ from what they hold (colour, opacity,
  visibility read and normalised exactly as :func:`~remoteview_core.collect.collect_scene` does);
- ``transform`` of a node sent with ``T.matrix`` → its new glTF matrix, written like the GLB writer writes it; of a
  baked node, or one whose world transform becomes non-linear or not TRS → re-export (SLC-13, FR-12);
- ``name`` of a node the viewers hold → re-export when its exported name changes (names travel in the GLB only, §8.3);
  never under *Hide node names*;
- ``geometry``, ``added``, ``removed`` and added again of a shown node, a ``reset``, and a shown node the viewers do
  not hold (new, or hidden at the last export — hidden models are not exported, SLC-22) → re-export;
- a node the export left out (``skipped``) → re-export only when the mark can lift the reason it was left out for, so a
  centre line under a dragged transform does not re-export on every flush; marked while hidden, it is forgotten
  (``Plan.forget``), so showing it again re-exports;
- ``removed`` of a node the viewers hold → ``scene.nodeRemoved``; a node they hold that is no longer shown →
  ``visible: false`` (it keeps its mesh on the viewers), or ``scene.nodeRemoved`` when its mesh, pose or exported name
  changed meanwhile (a hidden node's pose cannot be read, and a re-export would leave it out too);
- a node the adapter cannot read (deleted meanwhile, a bad MRML state) → re-export: the export reads it again and
  reports it. ``classify`` raises only :class:`SceneReadError` (fixed text) when the node list itself fails —
  except on a reset, which needs no scene read: the closed scene is forgotten anyway.

A re-export plan carries no update items: the snapshot carries every change. Its ``added`` lists the IDs it brings
that the viewers do not hold, for ``scene.nodeAdded`` (a hint: the export may still leave one out, §8.2).

Privacy (T7): an ID reaches a ``scene.update``/``scene.nodeRemoved`` only if the viewers hold it — it passed collect's
ID rules in an export — and ``added`` lists only IDs that pass them now. The *Hide node names* setting is part of the
viewers' scene: when it differs from the one ``classify`` is called with, the plan is a re-export. Reprs show counts
only.

The contract with SLC-29, which wires this to the debouncer, SLC-16's client and the exports:

- call ``classify`` with the current *Hide node names* setting, in ``CREATED``/``ACTIVE`` only (hold the debouncer
  otherwise);
- every plan is applied, an empty one too (``forget``);
- an update plan: ``send_changes(plan.changes)``, ``send_removed(plan.removed)``, then ``sent.apply(plan)`` — only if
  neither raised; a held result counts as sent;
- a re-export plan: ``sent.apply(plan)`` (it forgets the closed scene on a ``reset``), ``announce_added(plan.added)``,
  ``build_snapshot``, and ``sent = snapshot.sent`` in that same main-thread call — the scene of the export that
  ``begin`` announces, never swapped at the ack, kept even if the relay refuses that snapshot; when no snapshot begins
  (too large, back-off), ``client.require_snapshot()`` (SLC-29) keeps updates held until one does, so the re-export
  stays owed;
- no flush between the start of an export's collection and its ``begin`` (SLC-28 holds the debouncer).

Main thread only (MRML).
"""

from __future__ import annotations

import enum
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from vtkmodules.vtkCommonDataModel import vtkPolyData

from remoteview_core.collect import (
    BAKE,
    SceneApi,
    SkippedNode,
    SkipReason,
    display_of,
    placement_of,
    raw_name,
    transform_to_bake,
    valid_model_id,
)
from remoteview_core.coords import gltf_matrix_column_major
from remoteview_core.debounce import Change, Drained
from remoteview_core.glb_writer import Entity
from remoteview_core.names import sanitize_name
from remoteview_core.protocol_client import NodeChange

#: ``T.matrix`` of a node without one in the GLB (glTF 2.0: an absent matrix is the identity).
IDENTITY = tuple(gltf_matrix_column_major(np.eye(4)))
#: Marks of a shown node the viewers hold that only a snapshot can show (§8.2).
_REEXPORT = Change.GEOMETRY | Change.ADDED | Change.REMOVED
#: Marks on a hidden node after which what the viewers or the last export know of it is stale: a held node is removed
#: from the viewers (a rename too, unless names are hidden), a node the export left out loses its skip reason.
_STALE_WHEN_HIDDEN = _REEXPORT | Change.TRANSFORM
#: Skip reasons :func:`_lifts` re-checks with the export's own rule: lifted, the node is announced (a later check of
#: the export may still leave it out — the hint is best effort, §8.2).
_CERTAIN_LIFTS = frozenset(
    {SkipReason.INVALID_DISPLAY, SkipReason.INVALID_TRANSFORM, SkipReason.NON_LINEAR_TRANSFORM}
)
#: The §7.3 substitute names (``names.anonymous_name``): what a node without a usable name is exported with.
_SUBSTITUTE = re.compile(r"(?:Model|Segment) [1-9][0-9]*")


@dataclass(frozen=True)
class SentNode:
    """What the viewers hold of one node: its kind, visual properties and name (§7.3, §8.3 merged state)."""

    kind: str
    color: tuple[float, float, float]
    opacity: float
    visible: bool
    #: ``T.matrix``, column-major glTF (:data:`IDENTITY` when the GLB has none); ``None`` for a baked node (its
    #: transform is in the vertices)
    matrix: tuple[float, ...] | None = field(repr=False)
    name: str = field(default="", repr=False)  # the exported name (T7: not in a repr)


@dataclass(frozen=True)
class SkipInfo:
    """Why an export left a node out, and whether it had baked the node's transform first."""

    reason: SkipReason
    baked: bool = False


class _SkipMap(Mapping[str, SkipInfo]):
    """A read-only view of the skipped nodes whose ``repr`` shows a count, never the IDs (T7)."""

    def __init__(self, items: Mapping[str, SkipInfo]) -> None:
        self._items = items

    def __getitem__(self, node_id: str) -> SkipInfo:
        return self._items[node_id]

    def __iter__(self) -> Iterator[str]:
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __repr__(self) -> str:
        return f"<{len(self._items)} skipped>"


class SentScene:
    """The viewers' scene: the nodes of the last export with every change sent since, the nodes that export left out
    (and why), and whether it was made under *Hide node names*. Replaced by each export's own scene
    (``Snapshot.sent``), changed by :meth:`apply`."""

    def __init__(
        self,
        nodes: Mapping[str, SentNode] | None = None,
        skipped: Mapping[str, SkipInfo] | None = None,
        *,
        anonymized: bool,
    ) -> None:
        self._nodes = dict(nodes or {})
        self._skipped = {k: v for k, v in (skipped or {}).items() if k and k not in self._nodes}
        self.anonymized = bool(anonymized)

    def __repr__(self) -> str:  # counts only (T7)
        return (
            f"SentScene(nodes={len(self._nodes)}, skipped={len(self._skipped)}, "
            f"anonymized={self.anonymized})"
        )

    @classmethod
    def from_export(
        cls, entities: Iterable[Entity], skipped: Iterable[SkippedNode] = (), *, anonymized: bool
    ) -> SentScene:
        """The scene of one export: its (decimated) entities, the nodes it skipped — the first skip of an ID, the node
        :func:`classify` reads for it — and its *Hide node names* setting."""
        nodes = {}
        for e in entities:
            matrix = None
            if not e.baked:
                matrix = IDENTITY if e.matrix is None else tuple(gltf_matrix_column_major(e.matrix))
            nodes[e.node_id] = SentNode(
                kind=e.kind,
                color=(float(e.color[0]), float(e.color[1]), float(e.color[2])),
                opacity=float(e.opacity),
                visible=bool(e.visible),
                matrix=matrix,
                name=e.name,
            )
        first: dict[str, SkipInfo] = {}
        for s in skipped:
            first.setdefault(s.node_id, SkipInfo(s.reason, s.baked))
        return cls(nodes, first, anonymized=anonymized)

    def __contains__(self, node_id: object) -> bool:
        return node_id in self._nodes

    def __len__(self) -> int:
        return len(self._nodes)

    def get(self, node_id: str) -> SentNode | None:
        return self._nodes.get(node_id)

    @property
    def skipped(self) -> Mapping[str, SkipInfo]:
        """Read-only; its ``repr`` shows a count only (T7)."""
        return _SkipMap(self._skipped)

    def apply(self, plan: Plan) -> None:
        """Record ``plan`` as what the viewers hold — after SLC-16 accepted its messages (a held result counts as
        sent: a snapshot that drops it installs its own scene at its ``begin``). A ``reset`` plan forgets the closed
        scene before its export, so no update can address a reused ID until that export's scene replaces this one
        (§7.3)."""
        if plan.reset:
            self._nodes.clear()
            self._skipped.clear()
        for node_id in plan.forget:
            self._skipped.pop(node_id, None)
        for change in plan.changes:
            held = self._nodes.get(change.node_id)
            if held is None:
                continue
            self._nodes[change.node_id] = SentNode(
                kind=held.kind,
                color=held.color if change.color is None else change.color,
                opacity=held.opacity if change.opacity is None else change.opacity,
                visible=held.visible if change.visible is None else change.visible,
                matrix=held.matrix if change.matrix is None else change.matrix,
                name=held.name,
            )
        for node_id in plan.removed:
            self._nodes.pop(node_id, None)


@dataclass(frozen=True)
class Plan:
    """What to send for one drained set: ``changes`` and ``removed`` (SLC-16's ``send_changes``/``send_removed``), or
    a re-export (``snapshot``; ``added`` lists the new ``(nodeId, kind)`` for ``scene.nodeAdded``, §8.2; ``reset``:
    the scene was closed, nothing the viewers hold is meaningful any more)."""

    snapshot: bool = False
    reset: bool = False
    added: tuple[tuple[str, str], ...] = field(default=(), repr=False)
    changes: tuple[NodeChange, ...] = field(default=(), repr=False)
    removed: tuple[str, ...] = field(default=(), repr=False)
    #: IDs the last export left out whose reason may be gone (marked while hidden): ``SentScene.apply`` forgets them,
    #: so showing one again re-exports; nothing is sent for them
    forget: tuple[str, ...] = field(default=(), repr=False)

    def __bool__(self) -> bool:
        """Something to send (``forget`` alone is not)."""
        return self.snapshot or bool(self.changes) or bool(self.removed)

    def __repr__(self) -> str:
        """Counts only: no node ID reaches a log (T7)."""
        return (
            f"Plan(snapshot={self.snapshot}, reset={self.reset}, added={len(self.added)}, "
            f"changes={len(self.changes)}, removed={len(self.removed)}, forget={len(self.forget)})"
        )


class SceneReadError(RuntimeError):
    """The scene's node list could not be read; fixed text, never the adapter's (T7)."""


class _Unreadable(Exception):  # noqa: N818 — internal signal, never leaves this module
    """A per-node read of the adapter failed: the node is left to the export."""


class _SafeScene:
    """The adapter's per-node reads, with any failure turned into :class:`_Unreadable` (its text may carry a node ID,
    T7) — so only the adapter is guarded, not this module's own code."""

    def __init__(self, scene_api: SceneApi) -> None:
        self._scene = scene_api

    def _read(self, method: str, node: Any) -> Any:
        try:
            return getattr(self._scene, method)(node)
        except Exception:  # noqa: BLE001 — any adapter failure (a deleted node, a bad MRML state)
            raise _Unreadable from None

    def display_props(self, node: Any) -> Any:
        return self._read("display_props", node)

    def world_matrix(self, node: Any) -> Any:
        return self._read("world_matrix", node)

    def world_transform(self, node: Any) -> Any:
        return self._read("world_transform", node)

    def polydata(self, node: Any) -> Any:
        return self._read("polydata", node)

    def name(self, node: Any) -> Any:
        return self._read("name", node)


class _Outcome(enum.Enum):
    """What one marked node asks for, besides an update item."""

    REEXPORT = enum.auto()
    REEXPORT_ANNOUNCED = enum.auto()  # and the node will come: list it for scene.nodeAdded
    REMOVED = enum.auto()
    FORGET = enum.auto()


def classify(
    drained: Drained, scene_api: SceneApi, sent: SentScene, *, anonymize_names: bool
) -> Plan:
    """The :class:`Plan` for ``drained`` (see the module docstring). Reads the nodes the 3D view shows once, then the
    display properties, world matrices and names of the marked ones."""
    try:
        shown = _shown(scene_api, anonymize=anonymize_names)
    except SceneReadError:
        if drained.reset:
            # the closed scene is forgotten whatever the new one holds
            return Plan(snapshot=True, reset=True)
        raise
    if drained.reset:
        # §7.3: after a close every shown ID is a new node, also one that reuses an old ID
        return Plan(snapshot=True, reset=True, added=tuple((i, "model") for i in shown))
    if bool(anonymize_names) != sent.anonymized:
        # the viewers' names and IDs follow the other setting: only an export under this one is right
        return Plan(snapshot=True, added=_added(shown, sent, ()))
    needed = False
    lifted: list[str] = []
    changes: list[NodeChange] = []
    removed: list[str] = []
    forget: list[str] = []
    classifier = _Classifier(_SafeScene(scene_api), sent)
    for node_id, flags in drained.changes.items():
        outcome = classifier.node(node_id, flags, shown.get(node_id))
        if outcome is _Outcome.REEXPORT_ANNOUNCED:
            lifted.append(node_id)
        if outcome in (_Outcome.REEXPORT, _Outcome.REEXPORT_ANNOUNCED):
            needed = True
        elif outcome is _Outcome.REMOVED:
            removed.append(node_id)
        elif outcome is _Outcome.FORGET:
            forget.append(node_id)
        elif isinstance(outcome, NodeChange):
            changes.append(outcome)
    if needed:
        return Plan(snapshot=True, added=_added(shown, sent, lifted), forget=tuple(forget))
    return Plan(changes=tuple(changes), removed=tuple(removed), forget=tuple(forget))


def _shown(scene_api: SceneApi, *, anonymize: bool) -> dict[str, Any]:
    """The nodes the 3D view shows whose IDs pass collect's rules for the current setting (of duplicates the first,
    the one exported)."""
    shown: dict[str, Any] = {}
    try:
        for node in scene_api.visible_model_nodes():
            node_id = scene_api.node_id(node)
            if valid_model_id(node_id, anonymize=anonymize):
                shown.setdefault(node_id, node)
    except Exception:  # noqa: BLE001 — the adapter's text may carry a node ID (T7): a fixed one replaces it
        raise SceneReadError("the scene's nodes could not be read") from None
    return shown


class _Classifier:
    """The rules for one marked node (see the module docstring)."""

    def __init__(self, scene: _SafeScene, sent: SentScene) -> None:
        self._scene = scene
        self._sent = sent

    def node(self, node_id: str, flags: Change, node: Any) -> NodeChange | _Outcome | None:
        held = self._sent.get(node_id)
        try:
            if held is None:
                return self._not_held(node_id, flags, node)
            if node is None:
                return self._hidden(node_id, flags, held)
            if flags & _REEXPORT:
                return _Outcome.REEXPORT  # new mesh, or removed and added again under the same ID
            return self._changed(node_id, node, flags, held)
        except _Unreadable:
            return _Outcome.REEXPORT  # the export reads it again and reports it

    def _not_held(self, node_id: str, flags: Change, node: Any) -> _Outcome | None:
        skip = self._sent.skipped.get(node_id)
        if node is None:
            # in neither the scene nor the viewers' scene: nothing to say (T7); a node the export left out loses its
            # reason when its mesh or pose changes while hidden
            return _Outcome.FORGET if skip is not None and flags & _STALE_WHEN_HIDDEN else None
        if skip is None:
            return _Outcome.REEXPORT  # new, or hidden at the last export
        if not _lifts(skip, flags, node, self._scene):
            return None  # the export would leave it out again
        return _Outcome.REEXPORT_ANNOUNCED if skip.reason in _CERTAIN_LIFTS else _Outcome.REEXPORT

    def _hidden(self, node_id: str, flags: Change, held: SentNode) -> NodeChange | _Outcome | None:
        if held.kind != "model":
            # a kind classify cannot read yet (segments, SLC-27): the export decides
            return _Outcome.REEXPORT
        renamed = flags & Change.NAME and not self._sent.anonymized
        if flags & _STALE_WHEN_HIDDEN or renamed:
            # its mesh, pose or name on the viewers is stale; shown again later, it is a node they do not hold
            return _Outcome.REMOVED
        if held.visible:
            # hidden in Slicer, whatever the mark: shown again later, any mark restores it (_changed)
            return NodeChange(node_id, visible=False)
        return None

    def _changed(
        self, node_id: str, node: Any, flags: Change, held: SentNode
    ) -> NodeChange | _Outcome | None:
        """The properties of a shown node the viewers hold that differ from what they hold."""
        color = opacity = visible = matrix = None
        # shown in Slicer but hidden on the viewers: shown again, whatever the mark
        if flags & Change.APPEARANCE or not held.visible:
            display = display_of(self._scene.display_props(node))
            if display is None:
                return _Outcome.REEXPORT  # the export will leave it out and say why
            new_color, new_opacity, new_visible = display
            color = None if new_color == held.color else new_color
            opacity = None if new_opacity == held.opacity else new_opacity
            visible = None if new_visible == held.visible else new_visible
        if flags & Change.TRANSFORM:
            if held.matrix is None:
                return _Outcome.REEXPORT  # baked: the old transform is in the vertices
            placement = placement_of(self._scene.world_matrix(node))
            if placement is BAKE or isinstance(placement, SkipReason):
                # now non-linear or not TRS (bake), or invalid (the export says why)
                return _Outcome.REEXPORT
            new_matrix = (
                IDENTITY if placement is None else tuple(gltf_matrix_column_major(placement))
            )
            matrix = None if new_matrix == held.matrix else new_matrix
        renamed = flags & Change.NAME and not self._sent.anonymized
        if renamed and _name_changed(self._scene.name(node), held):
            return _Outcome.REEXPORT  # names travel in the GLB only (§8.3)
        if color is None and opacity is None and visible is None and matrix is None:
            return None
        return NodeChange(node_id, visible=visible, color=color, opacity=opacity, matrix=matrix)


def _added(
    shown: Mapping[str, Any], sent: SentScene, lifted: Iterable[str]
) -> tuple[tuple[str, str], ...]:
    """The shown IDs the viewers do not hold, except those the last export left out (unless surely lifted)."""
    lifted = set(lifted)
    return tuple(
        (node_id, "model")
        for node_id in shown
        if node_id not in sent and (node_id not in sent.skipped or node_id in lifted)
    )


def _has_triangle_cells(polydata: Any) -> bool:
    """Cell counts only — no mesh read: a line-only or empty model is left out again whatever its marks say (collect
    takes ``vtkPolyData`` only: an unstructured-grid model has none)."""
    return (
        isinstance(polydata, vtkPolyData)
        and polydata.GetNumberOfPolys() + polydata.GetNumberOfStrips() > 0
    )


def _usable_placement(node: Any, scene: _SafeScene) -> bool:
    """The node's world transform as collect would use it: a matrix, the identity, or a bake it can get."""
    world = scene.world_matrix(node)
    placement = placement_of(world)
    if placement is BAKE:
        return transform_to_bake(world, scene, node) is not None
    return not isinstance(placement, SkipReason)


def _name_changed(raw: Any, held: SentNode) -> bool:
    """The name an export would give the node differs from the one the viewers hold (a node without a usable name
    keeps the substitute it had)."""
    name = sanitize_name(raw_name(raw))
    return name != held.name if name else _SUBSTITUTE.fullmatch(held.name) is None


def _lifts(skip: SkipInfo, flags: Change, node: Any, scene_api: _SafeScene) -> bool:
    """A mark on a shown node the last export left out can make the next export take it."""
    reason = skip.reason
    if reason is SkipReason.INVALID_DISPLAY:
        return display_of(scene_api.display_props(node)) is not None
    if reason in (SkipReason.INVALID_TRANSFORM, SkipReason.NON_LINEAR_TRANSFORM):
        return bool(flags & (Change.TRANSFORM | _REEXPORT)) and _usable_placement(node, scene_api)
    if reason in (SkipReason.NO_TRIANGLES, SkipReason.INVALID_GEOMETRY):
        if reason is SkipReason.NO_TRIANGLES and not _has_triangle_cells(scene_api.polydata(node)):
            return False
        if flags & _REEXPORT:
            return True
        # a TRS matrix never touches the vertices; a bake (before, or now) can change area and finiteness
        return bool(flags & Change.TRANSFORM) and (
            skip.baked or placement_of(scene_api.world_matrix(node)) is BAKE
        )
    return False  # duplicate-node-id: never the first skip of an ID (the first node of an ID is decided first)
