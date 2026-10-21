"""The scene snapshot of a live session (SLC-24; protocol §6, §7): Slicer scene → GLB → the frames to send.

:func:`build_snapshot` collects the scene (:func:`~remoteview_core.collect.collect_scene`), writes one GLB whose root
``extras.sceneVersion``/``profile`` are those of the ``scene.snapshot.begin`` that announces it, and lets the
:class:`~remoteview_core.protocol_client.ProtocolClient` build ``begin`` + chunk frames + ``end`` (1 MiB chunks, the
relay's limits from ``session.created``). Nothing is sent here: the caller hands :meth:`Snapshot.frames` to the
transport in order.

- The GLB is quantised (``KHR_mesh_quantization``, FR-09, SLC-12): about half the vertex data; ``begin`` declares the
  extension because the client reads it from the file.
- An empty scene is a snapshot too (no nodes): viewers then show an empty scene instead of an old one.
- A GLB over the relay's ``maxSnapshotBytes`` raises :class:`SnapshotTooLargeError` before any version is used.
- Nodes that cannot be exported are reported in :attr:`Snapshot.skipped`, never sent.

Main thread only (VTK, and the client is not thread-safe). The SHA-256 is computed here too (decided in SLC-08).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from remoteview_core.collect import SceneApi, SkippedNode, collect_scene
from remoteview_core.glb_writer import RootExtras, write_glb
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
    _taken: list[bool] = field(
        default_factory=lambda: [False], init=False, repr=False, compare=False
    )

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


def build_snapshot(
    scene_api: SceneApi,
    client: ProtocolClient,
    *,
    slicer_version: str,
    anonymize_names: bool = False,
    quantize: bool = True,
) -> Snapshot:
    """Collect ``scene_api`` and build the next snapshot of ``client``'s session (see the module docstring). The GLB
    is quantised (``KHR_mesh_quantization``, FR-09) unless ``quantize`` is false."""
    limits = client.limits
    if (
        client.state not in (SessionState.CREATED, SessionState.ACTIVE)
        or not limits
        or not client.profile
    ):
        raise ProtocolStateError(f"cannot send a snapshot in state {client.state.value}")
    collected = collect_scene(scene_api, anonymize_names=anonymize_names)
    version = client.next_scene_version
    root = RootExtras(
        scene_version=version,
        profile=client.profile,
        slicer_version=slicer_version,
        anonymized_names=collected.anonymized_names,
    )
    glb = write_glb(list(collected.entities), root, quantize=quantize)
    if len(glb) > limits["maxSnapshotBytes"]:
        raise SnapshotTooLargeError(len(glb), limits["maxSnapshotBytes"])
    triangles = sum(entity.triangle_count for entity in collected.entities)
    messages = client.begin_snapshot(
        glb, node_count=len(collected.entities), triangle_count=triangles
    )
    # invariant: the root extras name the version the begin announces
    if messages.begin["sceneVersion"] != version:
        raise RuntimeError("sceneVersion of the GLB and of scene.snapshot.begin differ")
    return Snapshot(
        messages=messages,
        scene_version=version,
        node_count=len(collected.entities),
        triangle_count=triangles,
        byte_length=len(glb),
        skipped=collected.skipped,
    )
