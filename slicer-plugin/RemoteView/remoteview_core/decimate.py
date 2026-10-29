"""Decimation and budgets (SLC-14; protocol §7.5, FR-10, NFR-03, NFR-04, NFR-23, R-05).

The device profile the publisher chose (``session.create.profile``) sets the budgets of a snapshot (§7.5):

============  ===============  ==============  ==============================
Profile       Total triangles  Per node        Snapshot size (recommended)
============  ===============  ==============  ==============================
``mobile``    500,000          100,000         32 MiB (64 MiB hard)
``quest2``    500,000          100,000         32 MiB (64 MiB hard)
``quest3``    1,000,000        100,000         64 MiB (hard)
============  ===============  ==============  ==============================

:func:`fit_to_budget` gives every node a share of the total in proportion to its triangles (:func:`allocate`) — at
least :attr:`Budget.floor_triangles` (or all it has), at most the per-node cap — and decimates the nodes above their
share (:func:`fit_entity`, one node at a time: ``snapshot.ScenePreparation`` calls it once per step, SLC-51).
Nodes are **never dropped** (§7.5): a node the filters cannot reduce keeps its mesh and is reported. Decimation runs on
the collected entities (glTF metres, after SLC-07's clean-up), one node per :func:`decimate_entity` call:
``vtkQuadricDecimation``; ``vtkDecimatePro`` with ``PreserveTopologyOn`` when the quadric result is unusable (no
triangle, more than the share, a non-finite normal or a position beyond float32) — a zero normal is repaired to +Y
like a collected node's; and last ``vtkDecimatePro`` with its defaults —
topology changes, splitting and boundary deletion allowed — for which VTK documents a guaranteed reduction (not
reached for duplicated or non-manifold triangles: the node is then sent whole and reported;
``docs/research/slicer-decimate.md``). The normals are then recomputed like a collected mesh's
(:func:`~remoteview_core.collect.mesh_from_triangles`). :func:`glb_binary_size` (exact) lets ``build_snapshot`` refuse a
scene whose binary chunk alone is over the relay's limit before the file is built; :func:`estimate_glb_size` gives the
size that refusal reports.

Main thread only (VTK). No Slicer or Qt import.
"""

from __future__ import annotations

import dataclasses
import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import numpy as np
from vtkmodules.vtkFiltersCore import vtkDecimatePro, vtkQuadricDecimation

from remoteview_core.collect import (
    mesh_from_triangles,
    mesh_points_and_triangles,
    polydata_from_triangles,
)
from remoteview_core.coords import unit_normals
from remoteview_core.glb_writer import MAX_UINT16_VERTICES, Entity

MIB = 1 << 20


@dataclass(frozen=True)
class Budget:
    """The budgets of one profile (§7.5)."""

    total_triangles: int
    node_triangles: int
    target_bytes: int
    #: the smallest share a node is reduced to: below that a model is no longer recognisable (FR-10)
    floor_triangles: int = 2_000


#: §7.5. ``quest2`` is a 500k profile because of the Quest 2's draw calls and memory (quest.md §7).
PROFILES: Mapping[str, Budget] = MappingProxyType(
    {
        "mobile": Budget(500_000, 100_000, 32 * MIB),
        "quest2": Budget(500_000, 100_000, 32 * MIB),
        "quest3": Budget(1_000_000, 100_000, 64 * MIB),
    }
)


def allocate(counts: Sequence[int], budget: Budget) -> list[int]:
    """The triangles each node may keep: ``min(count, cap, max(floor, λ·count))`` with the largest ``λ`` whose total
    fits ``budget.total_triangles``. Every node keeps at least ``min(count, floor)`` even when those alone exceed the
    total (never dropped, §7.5)."""
    counts = [max(0, int(c)) for c in counts]
    caps = [min(c, budget.node_triangles) for c in counts]
    if sum(caps) <= budget.total_triangles:
        return caps
    floors = [min(c, budget.floor_triangles) for c in counts]
    if sum(floors) >= budget.total_triangles:
        return floors

    def shares(scale: float) -> list[int]:
        return [
            min(cap, max(floor, math.floor(scale * c)))
            for c, cap, floor in zip(counts, caps, floors, strict=True)
        ]

    low, high = 0.0, 1.0  # shares(0) = floors fit; shares(1) = caps do not
    for _ in range(60):
        middle = (low + high) / 2
        if sum(shares(middle)) <= budget.total_triangles:
            low = middle
        else:
            high = middle
    return shares(low)


def _quadric(reduction: float) -> Any:
    decimate = vtkQuadricDecimation()
    decimate.SetTargetReduction(reduction)
    return decimate


def _pro(reduction: float) -> Any:
    """Keeps the topology, so it may stop short of ``reduction`` (VTK's documentation)."""
    decimate = vtkDecimatePro()
    decimate.PreserveTopologyOn()
    decimate.SetTargetReduction(reduction)
    return decimate


def _pro_guaranteed(reduction: float) -> Any:
    """``vtkDecimatePro``'s defaults — ``PreserveTopology`` off, ``Splitting`` and ``BoundaryVertexDeletion`` on,
    ``MaximumError`` unbounded — under which VTK guarantees the reduction (holes may close, the mesh may split)."""
    decimate = vtkDecimatePro()
    decimate.SetTargetReduction(reduction)
    return decimate


#: The filters :func:`decimate_entity` tries in turn (tests replace them).
FILTERS: tuple[Callable[[float], Any], ...] = (_quadric, _pro, _pro_guaranteed)


def decimate_entity(
    entity: Entity,
    target: int,
    *,
    filters: Sequence[Callable[[float], Any]] | None = None,
) -> Entity | None:
    """``entity`` reduced to at most ``target`` triangles (unchanged when it already has no more), or ``None`` when no
    filter gives a usable result at or below ``target``. A result is usable when it has a triangle, finite normals
    (:func:`~remoteview_core.collect.mesh_from_triangles`; a zero normal becomes +Y, as for a collected node) and
    positions that fit float32 (what the GLB stores). Indices outside the positions, or a triangle that repeats a
    vertex, give ``None`` before any filter runs (VTK does not check them). ``filters``: :data:`FILTERS`, looked up
    at the call."""
    count = entity.triangle_count
    if count <= target:
        return entity
    indices = np.asarray(entity.indices)
    if indices.size and (indices.min() < 0 or indices.max() >= len(entity.positions)):
        return None
    a, b, c = indices.reshape(-1, 3).T
    if np.any(
        (a == b) | (b == c) | (a == c)
    ):  # collect never makes them; a crash of vtkDecimatePro on them was reported, not reproduced (9.6.2)
        return None
    source = polydata_from_triangles(entity.positions, indices)
    reduction = 1.0 - target / count
    for make in FILTERS if filters is None else filters:
        decimate = make(reduction)
        decimate.SetInputData(source)
        decimate.Update()
        points, triangles = mesh_points_and_triangles(decimate.GetOutput())
        if not 0 < len(triangles) <= target:
            continue
        mesh = mesh_from_triangles(points, triangles)
        if mesh is None:
            continue
        with np.errstate(over="ignore", invalid="ignore"):
            fits = bool(np.all(np.isfinite(mesh.positions.astype(np.float32))))
        try:  # the normals go to the writer as they are: glTF space already, so only the +Y repair of collect
            normals = unit_normals(mesh.normals)
        except ValueError:  # a non-finite point gives a non-finite normal
            continue
        if fits:
            return dataclasses.replace(
                entity, positions=mesh.positions, normals=normals, indices=mesh.triangles
            )
    return None


@dataclass(frozen=True)
class FitResult:
    """The entities within budget, in input order: ``reduced`` names the nodes that were decimated, ``unreduced`` those
    above their share that no filter could reduce (kept whole, never dropped)."""

    entities: tuple[Entity, ...]
    reduced: tuple[str, ...]
    unreduced: tuple[str, ...]

    @property
    def triangle_count(self) -> int:
        return sum(e.triangle_count for e in self.entities)


def fit_entity(
    entity: Entity,
    target: int,
    *,
    filters: Sequence[Callable[[float], Any]] | None = None,
) -> tuple[Entity, bool | None]:
    """``entity`` within its share of ``target`` triangles: ``(entity, None)`` when it already is, ``(smaller,
    True)`` when decimated, ``(entity, False)`` when no filter could reduce it (kept whole, never dropped)."""
    if entity.triangle_count <= target:
        return entity, None
    smaller = decimate_entity(entity, target, filters=filters)
    return (entity, False) if smaller is None else (smaller, True)


def fit_to_budget(
    entities: Sequence[Entity],
    budget: Budget,
    *,
    filters: Sequence[Callable[[float], Any]] | None = None,
) -> FitResult:
    """Decimate ``entities`` to ``budget`` (see the module docstring)."""
    targets = allocate([e.triangle_count for e in entities], budget)
    fitted: list[Entity] = []
    reduced: list[str] = []
    unreduced: list[str] = []
    for entity, target in zip(entities, targets, strict=True):
        result, decimated = fit_entity(entity, target, filters=filters)
        fitted.append(result)
        if decimated is not None:
            (reduced if decimated else unreduced).append(entity.node_id)
    return FitResult(tuple(fitted), tuple(reduced), tuple(unreduced))


#: The GLB container: a 12-byte header and two 8-byte chunk headers.
_CONTAINER_BYTES = 28
#: The JSON of an empty scene (root node, scene, asset; measured with ``write_glb``: 420 bytes) and the extension
#: declarations a quantised scene with a mesh adds (70 bytes).
_BASE_JSON_BYTES = 420
_EXTENSION_JSON_BYTES = 70
#: The JSON of one entity — ``T`` with its extras, ``M``, the mesh, its material, three accessors and their views —
#: without its name, IDs and ``T.matrix``: measured 1,040–1,120 bytes quantised (the dequantisation matrix of ``M``
#: included) and 950–980 bytes as floats, depending on how many digits the numbers take.
_ENTITY_JSON_BYTES = {True: 1_100, False: 970}
_MATRIX_JSON_BYTES = 120


def _padded4(size: int) -> int:
    return (size + 3) // 4 * 4


def glb_binary_size(entities: Sequence[Entity], *, quantize: bool = True) -> int:
    """The exact size of the BIN chunk ``write_glb(entities, …, quantize=quantize)`` writes: per node the vertex
    attributes (12 bytes a vertex quantised — ``SHORT`` + 2 padding and ``BYTE`` + 1 — else two float32 ``VEC3``) and
    the indices (uint16 up to 65,535 vertices, else uint32), each padded to 4 bytes; 4 bytes for an empty scene."""
    total = 0
    for e in entities:
        vertices = len(e.positions)
        index_bytes = 2 if vertices <= MAX_UINT16_VERTICES else 4
        total += vertices * (12 if quantize else 24) + _padded4(e.triangle_count * 3 * index_bytes)
    return max(total, 4)


def estimate_glb_size(entities: Sequence[Entity], *, quantize: bool = True) -> int:
    """The size of ``write_glb(entities, …, quantize=quantize)`` in bytes: :func:`glb_binary_size` (exact) plus an
    estimate of the JSON chunk from measured sizes (within a few percent of the real file; most for many tiny nodes)."""
    total = _CONTAINER_BYTES + _BASE_JSON_BYTES + glb_binary_size(entities, quantize=quantize)
    if quantize and entities:
        total += _EXTENSION_JSON_BYTES
    for e in entities:
        name = json.dumps(e.name, ensure_ascii=False).encode(
            "utf-8", "replace"
        )  # as the writer encodes it
        # T.name and extras.name; extras.nodeId and mrmlId
        total += _ENTITY_JSON_BYTES[quantize] + 2 * len(name) + 2 * len(e.node_id)
        total += 0 if e.matrix is None else _MATRIX_JSON_BYTES
    return total
