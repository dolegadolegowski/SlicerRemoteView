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
  :attr:`Snapshot.over_target` says the GLB is above the profile's recommended size (NFR-03: warn).
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
the last step, so a preparation abandoned before it (``close()``) sends nothing and uses no version. Main thread only
(VTK, and the client is not thread-safe). The SHA-256 is computed here too (decided in SLC-08).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field, replace
from typing import Any

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
from remoteview_core.ids import SceneIds
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
    reduced: tuple[str, ...] = ()
    unreduced: tuple[str, ...] = ()
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
) -> Snapshot:
    """Collect ``scene_api`` and build the next snapshot of ``client``'s session (see the module docstring). The GLB
    is quantised (``KHR_mesh_quantization``, FR-09) unless ``quantize`` is false. ``announce`` lists the ``(nodeId,
    kind)`` pairs for :attr:`Snapshot.announced` (``ProtocolClient.announce_added``: none while updates are held).
    ``ids`` is the session's alias registry (§7.3: every export of a session reuses the aliases it issued); ``None``
    makes a fresh one for a single export. ``cache`` is the session's :class:`~remoteview_core.meshcache.MeshCache`
    (SLC-50): the nodes whose mesh and share are those of their entry are neither collected nor decimated again."""
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
) -> Steps[Snapshot]:
    """:func:`build_snapshot` in steps (the module docstring); ``progress`` counts the nodes collected and fitted."""
    limits = client.limits
    if (
        client.state not in (SessionState.CREATED, SessionState.ACTIVE)
        or not limits
        or not client.profile
    ):
        raise ProtocolStateError(f"cannot send a snapshot in state {client.state.value}")
    progress = progress if progress is not None else Progress()
    cache = cache if cache is not None else MeshCache()  # a single export: every node is a miss
    collected = yield from collect_steps(
        scene_api, anonymize_names=anonymize_names, ids=ids, progress=progress, cache=cache
    )
    budget = PROFILES[client.profile]
    fitted, skipped = yield from _fit_steps(collected, budget, cache, progress)
    progress.done = progress.total  # the nodes left out need no fit
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
        target_bytes=budget.target_bytes,
        sent=sent,
        announced=announced,
    )


def _fit_steps(
    collected: CollectedScene, budget: Budget, cache: MeshCache, progress: Progress
) -> Steps[tuple[FitResult, tuple[SkippedNode, ...]]]:
    """``decimate.fit_steps`` with the cache (SLC-50): the shares come from the triangle counts collect gave (a
    cached node's too); a cached node keeps its entry's result when that fits its share; every other node goes through
    ``decimate.fit_node_steps`` — a cached one that was decimated is collected again first (its entry is the mesh fitted
    to another share; any other entry holds the collected mesh) — and what it gives is stored. Also returns the skipped
    nodes: a mesh collected again may have become one to leave out since the node was listed, and the entities are
    then named again, as a fresh collection would name them."""
    targets = decimate.allocate([source.count for source in collected.sources], budget)
    fitted: list[Entity] = []
    kept: list[Source] = []
    reduced: list[str] = []
    unreduced: list[str] = []
    skipped = list(collected.skipped)
    for listed, source, target in zip(collected.entities, collected.sources, targets, strict=True):
        cached = source.cached
        if cached is not None and cached.fits(target):
            result, smaller, whole = listed, cached.reduced, cached.unreduced
        else:
            entity, count = listed, source.count
            if cached is not None and cached.reduced:
                again = yield from recollect_steps(listed, source)
                if isinstance(again, tuple):
                    reason, baked = again
                    skipped.append(SkippedNode(listed.node_id, reason, source.index, baked=baked))
                    progress.done += 1
                    continue
                entity, count = again, again.triangle_count
            result, smaller, whole = yield from decimate.fit_node_steps(entity, target)
            if source.stamp is not None:
                geometry = (result.positions, result.normals, result.indices)
                entry = CachedMesh(source.stamp, count, target, *geometry, smaller, whole)
                cache.put(listed.node_id, entry)
        fitted.append(result)
        kept.append(source)
        if smaller:
            reduced.append(listed.node_id)
        if whole:
            unreduced.append(listed.node_id)
        progress.done += 1
        yield
    if len(skipped) > len(collected.skipped):
        fitted = _named_again(fitted, kept, anonymize=collected.anonymized_names)
        skipped.sort(key=lambda node: node.index)
    return FitResult(tuple(fitted), tuple(reduced), tuple(unreduced)), tuple(skipped)


def _named_again(entities: list[Entity], sources: list[Source], *, anonymize: bool) -> list[Entity]:
    """``entities`` named as a collection without the nodes left out late would name them (``Model <n>`` counts the
    exported nodes, no gaps)."""
    names = NameAssigner(anonymize=anonymize)
    return [
        replace(entity, name=names.assign(entity.kind, source.raw_name))
        for entity, source in zip(entities, sources, strict=True)
    ]
