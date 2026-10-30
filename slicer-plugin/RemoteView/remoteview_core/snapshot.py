"""The scene snapshot of a live session (SLC-24; protocol §6, §7): Slicer scene → GLB → the frames to send.

:func:`build_snapshot` collects the scene (:class:`~remoteview_core.collect.Collector`), writes one GLB whose root
``extras.sceneVersion``/``profile`` are those of the ``scene.snapshot.begin`` that announces it, and lets the
:class:`~remoteview_core.protocol_client.ProtocolClient` build ``begin`` + chunk frames + ``end`` (1 MiB chunks, the
relay's limits from ``session.created``). Nothing is sent here: the caller hands :meth:`Snapshot.frames` to the
transport in order.

- The GLB is quantised (``KHR_mesh_quantization``, FR-09, SLC-12): about half the vertex data; ``begin`` declares the
  extension because the client reads it from the file.
- The meshes are decimated to the budgets of the session's profile (SLC-14, §7.5, FR-10): :attr:`Snapshot.reduced`
  names the nodes that were, :attr:`Snapshot.unreduced` those no filter could reduce (sent whole), and
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
- :class:`ScenePreparation` does the same in steps (SLC-60), so the panel can run one per ``QTimer`` tick (SLC-28): one
  node collected per step, then one entity fitted to its share per step, then one last step that writes the GLB and
  builds the frames — the only one that touches the client (the hint, the version, ``begin``). Before it,
  :meth:`~ScenePreparation.cancel` leaves the client as it was. :func:`build_snapshot` runs all the steps in one call.

Main thread only (VTK, and the client is not thread-safe). The SHA-256 is computed here too, in the last step
(decided in SLC-08, kept in SLC-60): that step takes ≈ 0.15 s for a full ``quest3`` budget, ≈ 1.1–1.3 s for a
46 MiB GLB and ≈ 1.5 s at the relay's 64 MiB limit, mostly writing the GLB (``docs/research/slicer-prepare.md``).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, cast

from remoteview_core.changes import SentScene
from remoteview_core.collect import Collector, SceneApi, SkippedNode
from remoteview_core.decimate import (
    PROFILES,
    allocate,
    estimate_glb_size,
    fit_entity,
    glb_binary_size,
)
from remoteview_core.glb_writer import Entity, RootExtras, write_glb
from remoteview_core.ids import SceneIds
from remoteview_core.protocol_client import (
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    SnapshotMessages,
)


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


def _live_limits(client: ProtocolClient) -> dict[str, Any]:
    """The relay's limits of ``client``'s session, or ``ProtocolStateError`` when no snapshot can go now."""
    limits = client.limits
    if (
        client.state not in (SessionState.CREATED, SessionState.ACTIVE)
        or not limits
        or not client.profile
    ):
        raise ProtocolStateError(f"cannot send a snapshot in state {client.state.value}")
    return limits


class SceneChangedError(RuntimeError):
    """The Slicer scene was closed between two steps of a :class:`ScenePreparation` (its ``SceneIds`` were reset): the
    handles left are the closed scene's — maybe another patient's (T7). Nothing was sent; prepare the new scene."""


class ScenePreparation:
    """:func:`build_snapshot` in steps (SLC-60; see the module docstring): call :meth:`step` until it returns the
    :class:`Snapshot`. The scene's node lists are read here (no geometry), and *Hide node names* is fixed here
    (:attr:`anonymize_names`): the owner calls :meth:`cancel` and starts a new preparation when the setting changes or
    the scene is closed. ``ids`` is the session's registry, the one a scene close resets: a closed scene is then refused
    at the next step anyway (:class:`SceneChangedError`). A node removed from the scene is collected as it is at its
    step ([TODO verify] how the Slicer adapter reads a removed node — SLC-28, manual §15); its removal mark, held
    while the preparation runs (SLC-28), is sent after the snapshot as ``scene.nodeRemoved``. Exceptions other than
    the ones :meth:`step` names — here and in :meth:`step` — come from the scene adapter, VTK or the writer and may
    quote a node's ID or name: log their type only (T7). Main thread only."""

    def __init__(  # noqa: PLR0913 — the keyword-only options of build_snapshot
        self,
        scene_api: SceneApi,
        client: ProtocolClient,
        *,
        slicer_version: str,
        anonymize_names: bool = False,
        quantize: bool = True,
        announce: Iterable[tuple[str, str]] = (),
        ids: SceneIds,
    ) -> None:
        _live_limits(client)
        self._client = client
        self._session = client.session_id
        self._profile = client.profile
        self._slicer_version = slicer_version
        self._quantize = quantize
        self._announce = tuple(announce)
        self._ids = ids
        self._generation = ids.generation
        self._anonymize = bool(anonymize_names)
        collector = Collector(scene_api, ids, anonymize=self._anonymize)
        self._collector: Collector | None = collector
        # models first, then segments: collect_scene's order
        self._todo: list[tuple[Any, Any]] = [
            *((collector.model, node) for node in scene_api.visible_model_nodes()),
            *((collector.segment, handle) for handle in scene_api.visible_segments()),
        ]
        self._nodes = len(self._todo)
        #: known once every node is collected; until then each node counts for one
        self._entities: int | None = None
        self._collected = self._done = 0
        self._targets: list[int] | None = None
        self._fitted: list[Entity] = []
        self._reduced: list[str] = []
        self._unreduced: list[str] = []
        self._ended = False

    @property
    def anonymize_names(self) -> bool:
        """The *Hide node names* setting this preparation exports with (also after it ended)."""
        return self._anonymize

    @property
    def progress(self) -> tuple[int, int]:
        """``(steps done, steps in all)``: one per node, one per collected entity, one last. Until the nodes are
        collected, every node counts for an entity; a node left out then takes its step away."""
        entities = self._nodes if self._entities is None else self._entities
        return self._done, self._nodes + entities + 1

    def step(self) -> Snapshot | None:
        """Do the next step: ``None`` until the last one, which returns the snapshot. ``RuntimeError`` after the last
        step, :meth:`cancel` or a step that raised; :class:`SceneChangedError` when the scene was closed meanwhile. The
        last step raises what :func:`build_snapshot` raises (``ProtocolStateError`` when the session is no longer
        live, or is another one; :class:`SnapshotTooLargeError`); any other one: see the class docstring (T7)."""
        if self._ended:
            raise RuntimeError("this preparation has ended; start a new one")
        try:
            if self._ids.generation != self._generation:
                raise SceneChangedError("the scene was closed while it was prepared")
            snapshot = self._step()
        except BaseException:
            # a step that failed half-way is not repeated
            self._release()
            raise
        if snapshot is not None:
            self._release()
        return snapshot

    def cancel(self) -> None:
        """Stop here; the client has not been touched unless the last step ran. Further :meth:`step` calls raise."""
        self._release()

    def _release(self) -> None:
        """End the preparation and let go of the scene's handles and meshes (``progress`` keeps its counts)."""
        self._ended = True
        self._todo = []
        self._fitted = []
        self._collector = None

    def _step(self) -> Snapshot | None:
        collector = cast(Collector, self._collector)  # set until _release, which ends the steps
        self._done += 1
        if self._collected < self._nodes:
            collect, handle = self._todo[self._collected]
            collect(handle)
            self._collected += 1
            if self._collected == self._nodes:
                self._entities = len(collector.entities)
            return None
        entities = collector.entities
        if self._targets is None:
            self._targets = allocate([e.triangle_count for e in entities], PROFILES[self._profile])
        index = len(self._fitted)
        if index < len(entities):
            entity, decimated = fit_entity(entities[index], self._targets[index])
            self._fitted.append(entity)
            if decimated is not None:
                (self._reduced if decimated else self._unreduced).append(entity.node_id)
            return None
        return self._finish(collector)

    def _finish(self, collector: Collector) -> Snapshot:
        client = self._client
        # refused before any client call (announce_added and begin_snapshot would refuse too, after more work)
        limits = _live_limits(client)
        # between ticks the session may have been created again (SLC-45): the aliases belong to the old one
        if client.session_id != self._session:
            raise ProtocolStateError("the session changed while the scene was prepared")
        fitted = tuple(self._fitted)
        if glb_binary_size(fitted, quantize=self._quantize) > limits["maxSnapshotBytes"]:
            # too large whatever the JSON: refused before the file is written (NFR-23)
            raise SnapshotTooLargeError(
                estimate_glb_size(fitted, quantize=self._quantize), limits["maxSnapshotBytes"]
            )
        # the hint takes a version before the snapshot's own; once built, a snapshot must follow (§8.2): the client
        # keeps snapshot_needed set if the full GLB below is refused after all, and that message is then never sent.
        # Only IDs this export takes are announced: they passed collect's ID rules (T7)
        exported = {e.node_id for e in fitted}
        announced = client.announce_added(
            [(i, kind) for i, kind in self._announce if i in exported]
        )
        version = client.next_scene_version
        root = RootExtras(
            scene_version=version,
            profile=self._profile,
            slicer_version=self._slicer_version,
            anonymized_names=collector.anonymize,
        )
        glb = write_glb(list(fitted), root, quantize=self._quantize)
        if len(glb) > limits["maxSnapshotBytes"]:
            raise SnapshotTooLargeError(len(glb), limits["maxSnapshotBytes"])
        triangles = sum(e.triangle_count for e in fitted)
        skipped = tuple(collector.skipped)
        # before begin uses a version: nothing after it can fail but the invariant below
        sent = SentScene.from_export(fitted, skipped, anonymized=collector.anonymize)
        messages = client.begin_snapshot(glb, node_count=len(fitted), triangle_count=triangles)
        # invariant: the root extras name the version the begin announces
        if messages.begin["sceneVersion"] != version:
            raise RuntimeError("sceneVersion of the GLB and of scene.snapshot.begin differ")
        return Snapshot(
            messages=messages,
            scene_version=version,
            node_count=len(fitted),
            triangle_count=triangles,
            byte_length=len(glb),
            skipped=skipped,
            reduced=tuple(self._reduced),
            unreduced=tuple(self._unreduced),
            target_bytes=PROFILES[self._profile].target_bytes,
            sent=sent,
            announced=announced,
        )


def build_snapshot(  # noqa: PLR0913 — keyword-only options after the scene and the client
    scene_api: SceneApi,
    client: ProtocolClient,
    *,
    slicer_version: str,
    anonymize_names: bool = False,
    quantize: bool = True,
    announce: Iterable[tuple[str, str]] = (),
    ids: SceneIds | None = None,
) -> Snapshot:
    """Collect ``scene_api`` and build the next snapshot of ``client``'s session (see the module docstring): all of
    :class:`ScenePreparation`'s steps in one call. The GLB is quantised (``KHR_mesh_quantization``, FR-09) unless
    ``quantize`` is false. ``announce`` lists the ``(nodeId, kind)`` pairs for :attr:`Snapshot.announced`
    (``ProtocolClient.announce_added``: none while updates are held). ``ids`` is the session's alias registry (§7.3:
    every export of a session reuses the aliases it issued); ``None`` makes a fresh one for a single export."""
    preparation = ScenePreparation(
        scene_api,
        client,
        slicer_version=slicer_version,
        anonymize_names=anonymize_names,
        quantize=quantize,
        announce=announce,
        ids=ids if ids is not None else SceneIds(),
    )
    while (snapshot := preparation.step()) is None:
        pass
    return snapshot
