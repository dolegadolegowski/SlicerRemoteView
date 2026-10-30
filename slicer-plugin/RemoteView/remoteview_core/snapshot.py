"""The scene snapshot of a live session (SLC-24; protocol §6, §7): Slicer scene → GLB → the frames to send.

:func:`build_snapshot` collects the scene (:func:`~remoteview_core.collect.collect_scene`), writes one GLB whose root
``extras.sceneVersion``/``profile`` are those of the ``scene.snapshot.begin`` that announces it, and lets the
:class:`~remoteview_core.protocol_client.ProtocolClient` build ``begin`` + chunk frames + ``end`` (1 MiB chunks, the
relay's limits from ``session.created``). Nothing is sent here: the caller hands :meth:`Snapshot.frames` to the
transport in order.

- The GLB is quantised (``KHR_mesh_quantization``, FR-09, SLC-12): about half the vertex data; ``begin`` declares the
  extension because the client reads it from the file.
- The meshes are decimated to the budgets of the session's profile (SLC-14, §7.5, FR-10): :attr:`Snapshot.reduced`
  names the nodes that were, :attr:`Snapshot.unreduced` those nothing could reduce (sent whole), and
  :attr:`Snapshot.over_target` says the GLB is above the profile's recommended size (NFR-03: warn). With
  ``remove_islands`` (SLC-53) every node first loses its small islands (``decimate.island_mask``) and the shares
  follow the triangles left; :attr:`Snapshot.cleaned` names the nodes that lost some.
- An empty scene is a snapshot too (no nodes): viewers then show an empty scene instead of an old one.
- A GLB over the relay's ``maxSnapshotBytes`` raises :class:`SnapshotTooLargeError` before any version is used — before
  the GLB is written when its binary chunk alone is too large (the error then carries the estimated size, which can
  differ from the real one by a few percent).
- Nodes that cannot be exported are reported in :attr:`Snapshot.skipped`, never sent.
- :attr:`Snapshot.sent` is what the viewers hold once this snapshot is in: the live-change classifier's scene (SLC-30),
  installed by the caller in the same call that took the frames — the scene ``begin`` announces, not the ack's.
- ``announce`` (a re-export's new nodes, SLC-29) gives :attr:`Snapshot.announced`, the ``scene.nodeAdded`` hint (§8.2)
  the caller sends before the frames, for the nodes the export takes. It is built only once the binary chunk is known
  to fit, so a scene too large for the relay leaves no hint without its snapshot on the wire.

:func:`prepare_snapshot` is the same in steps (SLC-28, :mod:`remoteview_core.steps`): the collection and the
decimation yield between their passes over a mesh, and the client is asked for nothing — no version, no hint — before
the last step, so a preparation abandoned before it (``close()``) sends nothing and uses no version. It also stops
itself (SLC-68, T7): a scene closed between two steps (``SceneIds.reset``) raises
:class:`~remoteview_core.ids.SceneClosedError` at the next one, before any handle of it is read again, and a session
created again in between (SLC-45: other aliases) raises ``ProtocolStateError`` at the last. Main thread only (VTK, and
the client is not thread-safe). The SHA-256 is computed here too (decided in SLC-08).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
from numpy.typing import NDArray

from remoteview_core import decimate
from remoteview_core.changes import SentScene
from remoteview_core.collect import (
    CollectedScene,
    SceneApi,
    SkippedNode,
    Source,
    collect_steps,
    recollect_steps,
)
from remoteview_core.decimate import PROFILES, Budget, FitResult, estimate_glb_size, glb_binary_size
from remoteview_core.glb_writer import Entity, RootExtras, write_glb
from remoteview_core.ids import SceneClosedError, SceneIds
from remoteview_core.meshcache import CachedMesh, MeshCache
from remoteview_core.names import NameAssigner
from remoteview_core.protocol_client import (
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    SnapshotMessages,
)
from remoteview_core.steps import Progress, Steps, run


class SnapshotTooLargeError(ValueError):
    """The GLB exceeds the relay's ``maxSnapshotBytes`` (§3.3); numbers only, no scene data."""

    def __init__(self, byte_length: int, limit: int) -> None:
        super().__init__(
            f"snapshot of {byte_length} bytes exceeds the relay's limit of {limit} bytes"
        )
        self.byte_length = byte_length
        self.limit = limit


@dataclass(frozen=True)
class Snapshot:
    """One snapshot ready to send; :meth:`frames` can be called once (chunks are encoded lazily, one at a time)."""

    messages: SnapshotMessages = field(repr=False)
    scene_version: int
    node_count: int
    triangle_count: int
    byte_length: int
    skipped: tuple[SkippedNode, ...]
    #: node IDs, out of the repr (T7), like those of ``skipped``
    reduced: tuple[str, ...] = field(default=(), repr=False)
    unreduced: tuple[str, ...] = field(default=(), repr=False)
    #: the nodes whose small islands were left out (SLC-53, ``remove_islands``)
    cleaned: tuple[str, ...] = field(default=(), repr=False)
    #: the profile's recommended size (0: none)
    target_bytes: int = 0
    #: the viewers' scene after this snapshot (SLC-30): its entities, the skipped nodes, the *Hide node names* setting
    sent: SentScene = field(
        default_factory=lambda: SentScene(anonymized=False), repr=False, compare=False
    )
    #: ``scene.nodeAdded`` for ``announce`` (§8.2), to send before :meth:`frames`; ``None`` when there is none
    announced: dict[str, Any] | None = field(default=None, repr=False, compare=False)
    _taken: list[bool] = field(
        default_factory=lambda: [False], init=False, repr=False, compare=False
    )

    @property
    def over_target(self) -> bool:
        """The GLB is above the profile's recommended size (NFR-03: sent, with a warning)."""
        return 0 < self.target_bytes < self.byte_length

    def frames(self) -> Iterator[dict[str, Any] | bytes]:
        """``scene.snapshot.begin``, the binary chunk frames, ``scene.snapshot.end`` — in the order §6 requires.
        A second call raises ``RuntimeError``: the chunks are gone, and begin + end alone would be a broken snapshot."""
        if self._taken[0]:
            raise RuntimeError("the frames of a snapshot can be taken once; build a new snapshot")
        self._taken[0] = True
        return self._frames()

    def _frames(self) -> Iterator[dict[str, Any] | bytes]:
        yield self.messages.begin
        yield from self.messages.chunks
        yield self.messages.end


def build_snapshot(  # noqa: PLR0913 — keyword-only options after the scene and the client
    scene_api: SceneApi,
    client: ProtocolClient,
    *,
    slicer_version: str,
    anonymize_names: bool = False,
    quantize: bool = True,
    announce: Iterable[tuple[str, str]] = (),
    ids: SceneIds | None = None,
    cache: MeshCache | None = None,
    remove_islands: bool = False,
) -> Snapshot:
    """Collect ``scene_api`` and build the next snapshot of ``client``'s session (see the module docstring). The GLB
    is quantised (``KHR_mesh_quantization``, FR-09) unless ``quantize`` is false. ``announce`` lists the ``(nodeId,
    kind)`` pairs for :attr:`Snapshot.announced` (``ProtocolClient.announce_added``: none while updates are held).
    ``ids`` is the session's alias registry (§7.3: every export of a session reuses the aliases it issued); ``None``
    makes a fresh one for a single export. ``cache`` is the session's :class:`~remoteview_core.meshcache.MeshCache`
    (SLC-50): the nodes whose mesh and share are those of their entry are neither collected nor decimated again.
    ``remove_islands`` leaves every node's small islands out (SLC-53)."""
    return run(
        prepare_snapshot(
            scene_api,
            client,
            slicer_version=slicer_version,
            anonymize_names=anonymize_names,
            quantize=quantize,
            announce=announce,
            ids=ids,
            cache=cache,
            remove_islands=remove_islands,
        )
    )


def prepare_snapshot(  # noqa: PLR0913 — build_snapshot's options, and the progress
    scene_api: SceneApi,
    client: ProtocolClient,
    *,
    slicer_version: str,
    anonymize_names: bool = False,
    quantize: bool = True,
    announce: Iterable[tuple[str, str]] = (),
    ids: SceneIds | None = None,
    progress: Progress | None = None,
    cache: MeshCache | None = None,
    remove_islands: bool = False,
) -> Steps[Snapshot]:
    """:func:`build_snapshot` in steps (the module docstring); ``progress`` counts the nodes collected and fitted.
    The session's state and the relay's limits are checked at the first step and read again at the last, where the
    session must still be the same one; ``ids`` reset between two steps (a scene closed) stops it at the next one
    (``SceneClosedError``, the module docstring): a preparation in steps spans the event loop. With ``ids=None`` it
    makes a registry of its own, which nothing can reset: an owner that steps it across the event loop passes the
    session's."""
    _live_limits(client)
    session = client.session_id  # the aliases in ids are this session's (§7.3)
    ids = ids if ids is not None else SceneIds()
    # a scene closed between two steps stops the preparation at the next one (T7)
    generation = ids.generation
    progress = progress if progress is not None else Progress()
    cache = cache if cache is not None else MeshCache()  # a single export: every node is a miss
    # what the fit makes of a mesh depends on the island rule: a cache made with another one starts again
    cache.use_settings(
        (remove_islands, decimate.SMALL_ISLAND_TRIANGLES, decimate.SMALL_ISLAND_SHARE)
    )
    collected = yield from _same_scene(
        collect_steps(
            scene_api, anonymize_names=anonymize_names, ids=ids, progress=progress, cache=cache
        ),
        ids,
        generation,
    )
    budget = PROFILES[client.profile]
    fitted, skipped = yield from _same_scene(
        _fit_steps(collected, budget, cache, progress, remove_islands=remove_islands),
        ids,
        generation,
    )
    progress.done = progress.total  # the nodes left out need no fit
    limits = _live_limits(client)
    # created again between steps (SLC-45): another session, other aliases
    if client.session_id != session:
        raise ProtocolStateError("the session changed while the scene was prepared")
    if glb_binary_size(fitted.entities, quantize=quantize) > limits["maxSnapshotBytes"]:
        # too large whatever the JSON: refused before the file is written (NFR-23)
        raise SnapshotTooLargeError(
            estimate_glb_size(fitted.entities, quantize=quantize), limits["maxSnapshotBytes"]
        )
    # the hint takes a version before the snapshot's own; once built, a snapshot must follow (§8.2): the client keeps
    # snapshot_needed set if the full GLB below is refused after all, and that message is then never sent. Only IDs
    # this export takes are announced: they passed collect's ID rules (T7)
    exported = {e.node_id for e in fitted.entities}
    announced = client.announce_added([(i, kind) for i, kind in announce if i in exported])
    version = client.next_scene_version
    root = RootExtras(
        scene_version=version,
        profile=client.profile,
        slicer_version=slicer_version,
        anonymized_names=collected.anonymized_names,
    )
    glb = write_glb(list(fitted.entities), root, quantize=quantize)
    if len(glb) > limits["maxSnapshotBytes"]:
        raise SnapshotTooLargeError(len(glb), limits["maxSnapshotBytes"])
    triangles = fitted.triangle_count
    # before begin uses a version: nothing after it can fail but the invariant below
    sent = SentScene.from_export(fitted.entities, skipped, anonymized=collected.anonymized_names)
    messages = client.begin_snapshot(glb, node_count=len(fitted.entities), triangle_count=triangles)
    # invariant: the root extras name the version the begin announces
    if messages.begin["sceneVersion"] != version:
        raise RuntimeError("sceneVersion of the GLB and of scene.snapshot.begin differ")
    return Snapshot(
        messages=messages,
        scene_version=version,
        node_count=len(fitted.entities),
        triangle_count=triangles,
        byte_length=len(glb),
        skipped=skipped,
        reduced=fitted.reduced,
        unreduced=fitted.unreduced,
        cleaned=fitted.cleaned,
        target_bytes=budget.target_bytes,
        sent=sent,
        announced=announced,
    )


def _same_scene[T](steps: Steps[T], ids: SceneIds, generation: int) -> Steps[T]:
    """``steps``, checked before every step after the first that the scene was not closed (``ids`` reset) since the
    preparation started: its handles may be the next patient's (T7). Checked between steps, not per node — a close
    in the middle of a node, or once the last one has started, would still go out. A stop here, or the caller's
    ``close()``, ends ``steps`` at once."""
    try:
        while True:
            try:
                next(steps)
            except StopIteration as stop:
                return stop.value
            yield
            if ids.generation != generation:
                raise SceneClosedError("the scene was closed while it was prepared")
    finally:
        steps.close()


def _live_limits(client: ProtocolClient) -> dict[str, Any]:
    """The relay's limits of a session that can take a snapshot now (``ProtocolStateError`` otherwise)."""
    limits = client.limits
    if (
        client.state not in (SessionState.CREATED, SessionState.ACTIVE)
        or not limits
        or not client.profile
    ):
        raise ProtocolStateError(f"cannot send a snapshot in state {client.state.value}")
    return limits


def _fit_steps(
    collected: CollectedScene,
    budget: Budget,
    cache: MeshCache,
    progress: Progress,
    *,
    remove_islands: bool,
) -> Steps[tuple[FitResult, tuple[SkippedNode, ...]]]:
    """``decimate.fit_steps`` with the cache (SLC-50): the shares come from the triangle counts collect gave (a
    cached node's too); a cached node keeps its entry's result when that fits its share; every other node goes through
    ``decimate.fit_entity_steps`` — a cached one whose entry is not its collected mesh (decimated for another share,
    or without its small islands) is collected again first — and what it gives is stored. With ``remove_islands``
    (SLC-53) every node collected now gets its ``decimate.island_mask`` before the shares, one step each, and the
    shares count the triangles left (an entry knows its islands). Also returns the skipped nodes: a mesh collected
    again may have become one to leave out since the node was listed, and the entities are then named again, as a
    fresh collection would name them."""
    drops: list[NDArray[np.bool_] | None] = [None] * len(collected.entities)
    if remove_islands:
        for i, (listed, source) in enumerate(
            zip(collected.entities, collected.sources, strict=True)
        ):
            if source.cached is None:
                drops[i] = decimate.island_mask(listed)
                yield
    counts = [
        source.count - (source.cached.islands if source.cached is not None else _marked(drop))
        for source, drop in zip(collected.sources, drops, strict=True)
    ]
    targets = decimate.allocate(counts, budget)
    fitted: list[Entity] = []
    kept: list[Source] = []
    reduced: list[str] = []
    unreduced: list[str] = []
    cleaned: list[str] = []
    skipped = list(collected.skipped)
    nodes = zip(collected.entities, collected.sources, drops, targets, strict=True)
    for listed, source, drop, target in nodes:
        outcome = yield from _fit_node_steps(
            listed, source, drop, target, cache=cache, remove_islands=remove_islands
        )
        progress.done += 1
        if isinstance(outcome, SkippedNode):
            skipped.append(outcome)
            continue
        result, smaller, whole, islands = outcome
        fitted.append(result)
        kept.append(source)
        for flag, names in ((smaller, reduced), (whole, unreduced), (islands, cleaned)):
            if flag:
                names.append(listed.node_id)
        yield
    if len(skipped) > len(collected.skipped):
        fitted = _named_again(fitted, kept, anonymize=collected.anonymized_names)
        skipped.sort(key=lambda node: node.index)
    fit = FitResult(tuple(fitted), tuple(reduced), tuple(unreduced), tuple(cleaned))
    return fit, tuple(skipped)


def _fit_node_steps(  # noqa: PLR0913 — one node of _fit_steps, with its cache and rule
    listed: Entity,
    source: Source,
    drop: NDArray[np.bool_] | None,
    target: int,
    *,
    cache: MeshCache,
    remove_islands: bool,
) -> Steps[tuple[Entity, bool, bool, int] | SkippedNode]:
    """One node of :func:`_fit_steps`: ``(entity, reduced, unreduced, islands)`` — ``islands`` the triangles of the
    small islands left out —, or the node left out because its mesh, collected again, now is one to leave out."""
    cached = source.cached
    if cached is not None and cached.fits(target):
        return listed, cached.reduced, cached.unreduced, cached.islands
    entity, count = listed, source.count
    if cached is not None and (cached.reduced or cached.islands):
        again = yield from recollect_steps(listed, source)
        if isinstance(again, tuple):
            reason, baked = again
            return SkippedNode(listed.node_id, reason, source.index, baked=baked)
        entity, count = again, again.triangle_count
        if remove_islands:
            drop = decimate.island_mask(entity)
            yield
    result, decimated = yield from decimate.fit_entity_steps(entity, drop, target)
    smaller, whole, islands = decimated is True, decimated is False, _marked(drop)
    if source.stamp is not None:
        geometry = (result.positions, result.normals, result.indices)
        entry = CachedMesh(source.stamp, count, target, *geometry, smaller, whole, islands)
        cache.put(listed.node_id, entry)
    return result, smaller, whole, islands


def _marked(drop: NDArray[np.bool_] | None) -> int:
    """The triangles ``drop`` marks (an island mask; ``None``: none)."""
    return 0 if drop is None else int(drop.sum())


def _named_again(entities: list[Entity], sources: list[Source], *, anonymize: bool) -> list[Entity]:
    """``entities`` named as a collection without the nodes left out late would name them (``Model <n>`` counts the
    exported nodes, no gaps)."""
    names = NameAssigner(anonymize=anonymize)
    return [
        replace(entity, name=names.assign(entity.kind, source.raw_name))
        for entity, source in zip(entities, sources, strict=True)
    ]
