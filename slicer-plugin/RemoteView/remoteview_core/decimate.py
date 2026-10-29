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
the collected entities (glTF metres, after SLC-07's clean-up), one node per :func:`decimate_entity` call, by a rule
that keeps exactly flat regions and edges shared by many triangles from taking minutes (SLC-52,
``docs/research/slicer-decimate.md``):

1. exactly coincident points are merged (``vtkCleanPolyData``, tolerance 0) when there are any, so a triangle soup is
   decimated as one surface and does not come out with holes — unless merging would join sheets lying on each other
   (a duplicated shell, two sides or two touching segments with points of their own) into more edges of more than two
   triangles than the input had (a pure soup is always merged);
2. the mesh is centred on the bounding box of its used points and every coordinate moved by up to 1e-7 of its diagonal
   (seeded from a digest of the mesh, so the same mesh gives the same result): on an exactly flat region every collapse
   of ``vtkQuadricDecimation`` would cost 0, and its queue would then keep collapsing into one point whose valence grows
   (minutes and gigabytes); the jitter gives every collapse a cost. Every filter gets this input; the centre is added
   back to its result;
3. a mesh with an edge shared by more than two triangles (non-manifold) costs the quadric's set-up n(p)·n(q) for every
   edge — the cube of the triangles on one edge — so it goes to ``vtkDecimatePro`` with ``PreserveTopologyOn`` first;
   if its result is not usable, the chain below runs on the mesh as it is when that set-up fits SLC-54's budget
   (:func:`~remoteview_core.collect.walk_within_budget`: a two-sided surface, four triangles on every edge), and last
   on a copy with a point of its own for every corner at an end of such an edge
   (:func:`~remoteview_core.collect.split_points`);
4. the chain: ``vtkQuadricDecimation``; ``vtkDecimatePro`` with ``PreserveTopologyOn``; last ``vtkDecimatePro`` with
   its defaults — topology changes, splitting and boundary deletion allowed — for which VTK documents a guaranteed
   reduction (not reached for duplicated or non-manifold triangles: the node is then sent whole and reported).

The first usable result wins: at least one triangle, at most the share, finite normals, positions within float32 — a
zero normal is repaired to +Y like a collected node's. The normals are recomputed like a collected mesh's
(:func:`~remoteview_core.collect.mesh_from_triangles`). The rule does not bound the size — a node of ≈ 1M triangles or
more takes over 10 s (0.8M: 6.6–8.8 s), whichever filter runs (SLC-56) — nor a point used by thousands of triangles,
around which every filter is super-linear (a fan of 20,000 triangles ≈ 4 s, 4,000 triangles sharing only one point
≈ 3 s, a book of 40,000 pages on one edge ≈ 12 s in ``vtkDecimatePro``; SLC-55), nor a node whose bounding box one
far-off triangle stretches: the jitter grows with the box and crumples the dense part (a 400k sphere with one triangle
10 km away up to ≈ 30 s, depending on that triangle, before SLC-52 2.2–2.7 s; SLC-56).
:func:`glb_binary_size` (exact) lets ``build_snapshot`` refuse a scene whose binary chunk alone is over the relay's
limit before the file is built; :func:`estimate_glb_size` gives the size that refusal reports.

Main thread only (VTK). No Slicer or Qt import.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import numpy as np
from numpy.typing import NDArray
from vtkmodules.vtkFiltersCore import vtkCleanPolyData, vtkDecimatePro, vtkQuadricDecimation

from remoteview_core.collect import (
    mesh_from_triangles,
    mesh_points_and_triangles,
    polydata_from_triangles,
    split_points,
    walk_within_budget,
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
#: The filter tried first on a mesh with an edge shared by more than two triangles; then :data:`FILTERS` on the mesh as
#: it is while its set-up fits ``collect.walk_within_budget``, then on its split copy (SLC-52; looked up at the call,
#: tests replace it).
NON_MANIFOLD_FIRST: Callable[[float], Any] = _pro
#: How far the jitter moves a coordinate at most, as a fraction of the bounding-box diagonal (SLC-52): ≈ 13× the
#: rounding noise of a centred coordinate (√ε·|x| ≤ 0.75e-8 of the diagonal, |x| being at most half of it; 1e-8 still
#: left hubs), ≈ 180× in the quadric's cost; 1e-6 slowed the quadric on a smooth sphere by 10–15 %. It is 0.011 of the
#: GLB's position step (``max extent / 65,534``).
JITTER = 1e-7


def _mixed(bits: NDArray[np.uint64]) -> NDArray[np.uint64]:
    """SplitMix64's finaliser: every input bit moves about half the output bits."""
    bits = (bits ^ (bits >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    bits = (bits ^ (bits >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return bits ^ (bits >> np.uint64(31))


def _point_keys(positions: NDArray[np.float64]) -> NDArray[np.uint64]:
    """One 64-bit key per point, hashed from the coordinates' bits (``+ 0.0`` makes -0.0 the same point as 0.0, as
    ``vtkMergePoints`` compares them), sorted — ≈ 0.006 s for 200k points. Equal keys are a collision or two coincident
    points; either way :func:`_merged` runs the merge, which is right in both cases."""
    bits = np.ascontiguousarray(positions + 0.0, dtype=np.float64).view(np.uint64).reshape(-1, 3)
    return np.sort(_mixed(_mixed(_mixed(bits[:, 0]) ^ bits[:, 1]) ^ bits[:, 2]))


def _coincident(keys: NDArray[np.uint64]) -> bool:
    """Whether two points may coincide exactly (:func:`_point_keys`)."""
    return bool(np.any(keys[1:] == keys[:-1]))


def _merged(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], keys: NDArray[np.uint64]
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """``triangles`` with exactly coincident points merged and the points no triangle uses dropped — or as they are when
    no two points coincide (:func:`_coincident`; most meshes: the merge took ≈ 0.07 s for 400k triangles and reordered
    the points), or when merging would join separate sheets lying on each other — a duplicated shell, two sides with
    points of their own, touching segments — into more edges of more than two triangles than the input had (decimating
    those cuts holes: SLC-52 review). A soup (:func:`_soup`) is always merged. Tolerance 0 makes ``vtkCleanPolyData``
    use ``vtkMergePoints`` (exact coincidence). A triangle left with a repeated point becomes a line and is dropped:
    only one whose corners already coincided, which has no area (collect drops those)."""
    if not _coincident(keys):
        return positions, triangles
    clean = vtkCleanPolyData()
    clean.PointMergingOn()
    clean.SetTolerance(0.0)
    clean.SetInputData(polydata_from_triangles(positions, triangles))
    clean.Update()
    points, merged = mesh_points_and_triangles(clean.GetOutput())
    joined = _over_shared(merged, len(points)) > _over_shared(triangles, len(positions))
    # a soup has no surface yet: it is merged whatever the merge makes of it
    return (positions, triangles) if joined and not _soup(triangles) else (points, merged)


def _soup(triangles: NDArray[np.int64]) -> bool:
    """Whether no point is used by two triangles, a triangle repeated on the same points counted once (an STL read
    without merging, a facet written twice included)."""
    corners = np.sort(triangles, axis=1)
    corners = corners[np.lexsort(corners.T[::-1])]
    distinct = corners[np.r_[True, np.any(corners[1:] != corners[:-1], axis=1)]]
    return bool(np.bincount(distinct.ravel()).max(initial=0) <= 1)


def _edge_keys(triangles: NDArray[np.int64], point_count: int) -> NDArray[np.int64]:
    """One key per triangle edge, the same in both directions (IDs in ``[0, point_count)``): edge ``k`` of triangle
    ``t`` runs from its corner ``k`` to corner ``k + 1`` (mod 3) and has its key at ``3·t + k``."""
    starts, ends = triangles.ravel(), triangles[:, [1, 2, 0]].ravel()
    return np.minimum(starts, ends) * np.int64(point_count) + np.maximum(starts, ends)


def _non_manifold(triangles: NDArray[np.int64], point_count: int) -> bool:
    """Whether an edge is shared by more than two triangles."""
    keys = np.sort(_edge_keys(triangles, point_count))
    return bool(np.any(keys[2:] == keys[:-2]))


def _over_shared(triangles: NDArray[np.int64], point_count: int) -> int:
    """How many edges are shared by more than two triangles."""
    _, counts = np.unique(_edge_keys(triangles, point_count), return_counts=True)
    return int(np.count_nonzero(counts > 2))


def _shared_edge_ends(triangles: NDArray[np.int64], point_count: int) -> NDArray[np.bool_]:
    """The points at an end of an edge shared by more than two triangles."""
    _, inverse, counts = np.unique(
        _edge_keys(triangles, point_count), return_inverse=True, return_counts=True
    )
    shared = (counts[inverse] > 2).reshape(-1, 3)
    ends = np.zeros(point_count, dtype=bool)
    ends[triangles[shared]] = True  # the first corner of each such edge
    ends[triangles[np.roll(shared, 1, axis=1)]] = True  # and its second: corner k ends edge k − 1
    return ends


def _attempts(
    points: NDArray[np.float64],
    triangles: NDArray[np.int64],
    chain: Sequence[Callable[[float], Any]],
) -> Iterator[tuple[Any, Callable[[float], Any]]]:
    """The (input, filter) pairs of the rule in turn: the chain on a manifold mesh; else :data:`NON_MANIFOLD_FIRST`, the
    chain less that filter on the mesh as it is when its set-up fits the budget, then the chain on a copy with the
    shared edges' ends cut (made only when it is reached)."""
    if not _non_manifold(triangles, len(points)):
        source = polydata_from_triangles(points, triangles)
        for make in chain:
            yield source, make
        return
    whole = polydata_from_triangles(points, triangles)
    yield whole, NON_MANIFOLD_FIRST
    # mildly non-manifold (a two-sided surface: four triangles on every edge): the chain copes, as it did before SLC-52,
    # when the quadric's set-up — the n(p)·n(q) loop of SLC-54's walk — fits its budget; the split copy would be a soup
    if walk_within_budget(triangles, len(points)):
        for make in chain:
            if make is not NON_MANIFOLD_FIRST:  # it has just run on this input
                yield whole, make
    split, origin = split_points(triangles, len(points), _shared_edge_ends(triangles, len(points)))
    copy = polydata_from_triangles(points[origin], split)
    for make in chain:
        yield copy, make


def _prepared(
    entity: Entity,
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64]] | None:
    """The filters' input — the points merged where they coincide, centred and jittered (the module docstring) — its
    triangles and the centre to add back; ``None`` for indices outside the positions, a triangle that repeats a vertex
    (collect never makes them; a crash of ``vtkDecimatePro`` on them was reported, not reproduced with 9.6.2) or
    positions that are not finite (collect's ``_finite_geometry`` keeps them out): VTK does not check them; ``None`` too
    for positions whose extent overflows float64 (a filter aborted the process on them)."""
    indices = np.asarray(entity.indices).reshape(-1, 3)
    if indices.size and (indices.min() < 0 or indices.max() >= len(entity.positions)):
        return None
    a, b, c = indices.T
    positions = np.asarray(entity.positions, dtype=np.float64)
    if np.any((a == b) | (b == c) | (a == c)) or not np.all(np.isfinite(positions)):
        return None
    keys = _point_keys(positions)
    points, triangles = _merged(positions, indices, keys)
    if len(triangles) == 0:
        return None
    # a point no triangle uses neither moves the centre nor scales the jitter
    used = np.zeros(len(points), dtype=bool)
    used[triangles.ravel()] = True
    low, high = points[used].min(axis=0), points[used].max(axis=0)
    with np.errstate(over="ignore", invalid="ignore"):
        centre, diagonal = (low + high) / 2, float(np.linalg.norm(high - low))
    # finite positions can still lie further apart than float64 holds
    if not (np.all(np.isfinite(centre)) and math.isfinite(diagonal)):
        return None
    # seeded from a digest of the mesh: the same mesh moves the same way, and a crafted one cannot steer the seed to
    # cancel its jitter in advance (an XOR of the keys could be: SLC-52 review)
    rng = np.random.default_rng(
        int.from_bytes(hashlib.blake2b(keys.tobytes(), digest_size=8).digest(), "little")
    )
    return (
        points - centre + rng.uniform(-1.0, 1.0, points.shape) * (JITTER * diagonal),
        triangles,
        centre,
    )


def decimate_entity(
    entity: Entity,
    target: int,
    *,
    filters: Sequence[Callable[[float], Any]] | None = None,
) -> Entity | None:
    """``entity`` reduced to at most ``target`` triangles (unchanged when it already has no more), or ``None`` when no
    filter gives a usable result at or below ``target`` (the rule: see the module docstring). A result is usable when it
    has a triangle, finite normals (:func:`~remoteview_core.collect.mesh_from_triangles`; a zero normal becomes +Y, as
    for a collected node) and positions that fit float32 (what the GLB stores). Indices outside the positions, a
    triangle that repeats a vertex, a position that is not finite or positions whose extent overflows float64 give
    ``None`` before any filter runs (VTK does not check them). ``filters``: :data:`FILTERS`, looked up at the call, as
    is :data:`NON_MANIFOLD_FIRST`."""
    count = entity.triangle_count
    if count <= target:
        return entity
    prepared = _prepared(entity)
    if prepared is None:
        return None
    jittered, triangles, centre = prepared
    reduction = 1.0 - target / count
    for source, make in _attempts(jittered, triangles, FILTERS if filters is None else filters):
        decimate = make(reduction)
        decimate.SetInputData(source)
        decimate.Update()
        kept_points, kept = mesh_points_and_triangles(decimate.GetOutput())
        if not 0 < len(kept) <= target:
            continue
        mesh = mesh_from_triangles(kept_points + centre, kept)
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
