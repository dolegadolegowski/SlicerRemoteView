"""Decimation and budgets (SLC-14; protocol §7.5, FR-10, NFR-03, NFR-04, NFR-23, R-05).

The device profile the publisher chose (``session.create.profile``) sets the budgets of a snapshot (§7.5):

============  ===============  ==============  ==============================
Profile       Total triangles  Per node        Snapshot size (recommended)
============  ===============  ==============  ==============================
``mobile``    500,000          100,000         32 MiB (64 MiB hard)
``quest2``    500,000          100,000         32 MiB (64 MiB hard)
``quest3``    1,000,000        100,000         64 MiB (hard)
============  ===============  ==============  ==============================

:func:`fit_to_budget` gives every node a share of the total in proportion to its triangles — at least
:attr:`Budget.floor_triangles` (or all it has), at most the per-node cap — and decimates the nodes above their share.
Nodes are **never dropped** (§7.5): a node nothing can reduce keeps its mesh and is reported. Decimation runs on the
collected entities (glTF metres, after SLC-07's clean-up), one node per :func:`decimate_entity` call, in bounded time
(SLC-41; the bound covers decimation, not collect):

- small islands (SLC-53, ``remove_islands``): before the shares every node loses its parts below
  :data:`SMALL_ISLAND_TRIANGLES` that are also below :data:`SMALL_ISLAND_SHARE` of its largest part
  (:func:`island_mask`); the largest part always stays;
- size bound: a node above ``2 · max(CLUSTER_GOAL, 3 · share)`` triangles (800k for a 100k share) is first reduced to
  at most twice that goal by connected vertex clustering (:mod:`remoteview_core.clustering`; both sides of a thin wall
  stay apart, seams stay closed);
- coincident points (SLC-66): the used points that lie at exactly one position are merged class by class, unless the
  merge would give an edge more triangles than two and than the input edges it comes from (two layers on each other
  stay apart; a soup's classes are merged anyway), so a soup or a seam is one surface for the quadric
  (:func:`~remoteview_core.clustering.merge_coincident_steps`); a node without such points is left as it is;
- fans: a mesh with non-manifold fans (pages sharing one spine: ``fan_weight`` above :data:`FAN_LIMIT`, or a
  quadric set-up above :data:`QUADRIC_WORK`) is clustered by grid cell and normal class instead, since the quadric's
  set-up and its work per collapse grow with the valences;
- island shares: connected parts below :data:`ISLAND_TRIANGLES` get their own run with twice their proportional share
  (at most half the share), so small pieces are not eaten first;
- ``vtkQuadricDecimation`` on centred coordinates scaled to a median edge of :data:`EDGE_UNITS`, with the ends of
  edges that are zero-length in float32 welded first (its working copy is float32, and such an edge stalled it),
  ``RegularizeOn`` with :data:`REGULARIZATION`; one :data:`QUADRIC_SECONDS` deadline per node, counted from the
  start of its quadric step (no run starts after it, and a progress observer aborts a running one);
- if any part gives no usable result (aborted, no triangle, more than the share, a non-finite normal or a position
  beyond float32): clustering of the whole node with a growing cell (:func:`_fallback_steps`), with a warning in the
  log naming the reason and the outcome;
- folds repaired (a triangle whose face opposes its vertex normals is turned over), then point normals from
  ``vtkPolyDataNormals`` with ``SplittingOff`` (§7.4) and ``ConsistencyOff``
  (:func:`~remoteview_core.collect.mesh_from_triangles` with ``orient=False``); a zero normal becomes +Y like a
  collected node's.

``vtkDecimatePro`` is not used (its splitting cracked the surface, SLC-41). Sources and measurements:
``docs/research/slicer-decimate.md``, ``docs/research/slicer-islands.md`` (SLC-53). :func:`glb_binary_size` (exact)
lets ``build_snapshot`` refuse a scene whose binary chunk alone is over the relay's limit before the file is built;
:func:`estimate_glb_size` gives the size that refusal reports.

:func:`decimate_steps`, :func:`fit_entity_steps` and :func:`fit_steps` are :func:`decimate_entity`, :func:`fit_entity`
and :func:`fit_to_budget` in steps (SLC-28, :mod:`remoteview_core.steps`): one per clustering pass and per node's
:func:`island_mask`, and the quadric's runs together in one, so its deadline counts only their own time, never the
event loop's between steps. Main thread only (VTK). No Slicer or Qt import.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import math
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import numpy as np
from numpy.typing import NDArray
from vtkmodules.vtkFiltersCore import vtkQuadricDecimation

from remoteview_core import clustering
from remoteview_core.collect import (
    mesh_from_triangles,
    mesh_points_and_triangles,
    polydata_from_triangles,
)
from remoteview_core.coords import unit_normals
from remoteview_core.glb_writer import MAX_UINT16_VERTICES, Entity
from remoteview_core.steps import Progress, Steps, run

_log = logging.getLogger(__name__)

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


#: A node above ``2 · max(CLUSTER_GOAL, 3 · share)`` triangles is first clustered to about ``max(CLUSTER_GOAL,
#: 3 · share)``, so the quadric's input is bounded (a 16M-triangle segmentation: 148.8 s → 4.4-4.5 s natively;
#: 300k measured 3.6 s but recon16m d_out_to_in p99 1.40e-3 instead of 1.29e-3; research note § SLC-41).
CLUSTER_GOAL = 400_000
#: The size bound's rescue of islands smaller than a cell is skipped above ``RESCUE_GOALS · goal`` lost triangles,
#: and its result is clustered again (no rescue) up to ``BOUND_TRIES`` times while it is above ``2 · goal``: a node
#: of dust (a 16.5M-triangle random labelmap: 14.9 s → 2.7 s) does not reach the goal in one pass.
RESCUE_GOALS = 3
BOUND_TRIES = 6
#: ``clustering.fan_weight`` above which the quadric's work per collapse explodes: ``FindAffectedEdges`` uses
#: ``vtkIdList::IsId`` over both fans (research note § SLC-41, fact h); about 6 on an ordinary mesh.
FAN_LIMIT = 50.0
#: ``clustering.edge_work`` above which the quadric is not run: its set-up (``AddBoundaryConstraints``, fact l) cannot
#: be aborted and costs about 1 s per 4e9 natively (672 pages on one spine, fan_weight 46.9: 6.4e10, 16.8 s). An
#: ordinary mesh measures 106-148 per triangle (about 1.2e8 at the 800k bound); such a mesh is clustered as a fan.
QUADRIC_WORK = 2e9
#: A fan mesh is clustered by normal class to about ``max(FAN_GOAL_FACTOR · share, FAN_GOAL_MIN)`` triangles; the
#: cell shrinks by ``FAN_REFINE`` (at most ``FAN_TRIES`` times) until at least twice the share is left — pages packed
#: in a volume merge more than their area predicts (the 3,000-page book: did not finish → 0.35 s).
FAN_GOAL_MIN = 20_000
FAN_GOAL_FACTOR = 10
FAN_REFINE = 1.6
FAN_TRIES = 10
#: Connected parts below ``ISLAND_TRIANGLES`` are decimated in their own run with ``ISLAND_BOOST`` times their
#: proportional share (at most half the share): one run eats small debris first (recon16m d_in_to_out p99 0.0093
#: without, 0.0051 with).
ISLAND_TRIANGLES = 2_000
ISLAND_BOOST = 2.0
#: The quadric runs on centred coordinates scaled to this median edge length: its cost thresholds are absolute
#: (``errorNumber`` 1e-10, fact g) and its float32 working copy keeps more bits near the origin (fact a).
EDGE_UNITS = 100.0
#: ``vtkQuadricDecimation::SetRegularization`` (with ``RegularizeOn``): breaks the exact cost ties of flat regions
#: (a flat 180k plane: 93.9 s → 0.22 s to 100k), in units of :data:`EDGE_UNITS` (fact f).
REGULARIZATION = 0.01
#: Wall-clock budget of one node's quadric step (:func:`_reduce_parts`), from its start: no run starts after it, and a
#: progress observer aborts a running one — VTK checks the abort only every 10,000 collapses, after the set-up (fact e;
#: the set-up is bounded by :data:`QUADRIC_WORK`). An aborted run fails the node, which then goes to
#: :func:`_fallback_steps`. The clustering before it is numpy and linear, so it is not counted: counted from the entry,
#: the reporter's node left the quadric 1.5 s of margin in Slicer under Rosetta (size bound 4.4-4.5 s, then a quadric
#: step of 2.0-2.2 s), and machine load could switch it to the coarser fallback; now the step has about 4 times what it
#: needs. In steps (SLC-28) the quadric's runs are one step, so the time between steps never counts either.
QUADRIC_SECONDS = 8.0
#: Rounds of :func:`_repair_folds` (each turns over the triangles whose face opposes their vertex normals).
FOLD_ROUNDS = 3
#: *Remove small islands* (SLC-53): a connected part with fewer triangles than this is left out of the snapshot.
#: Slicer's Islands effect removes islands of fewer than 1,000 voxels by default (``MinimumSize``,
#: SegmentEditorIslandsEffect.py v5.12.4 L95, L392; face connectivity L155). The smallest surface Slicer's default
#: conversion (vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx v5.12.4 L72-L101, L279-L486) makes of 1,000
#: face-connected voxels has 1,196 triangles (a 10 × 10 × 10 cube; a ball of 1,000 voxels has 1,448, random compact
#: clusters 2,920-3,012, thin shapes up to 8,000). So a part with fewer triangles has fewer than 1,000 voxels.
SMALL_ISLAND_TRIANGLES = 1_196
#: A part is left out only if it also has less than this share of the triangles of its node's largest part: a node
#: made of small parts of similar size keeps them (electrode contacts, glyphs, letters, screws next to a small body).
#: Below 1 the largest part is never left out (never dropped, §7.5).
SMALL_ISLAND_SHARE = 0.01
#: :func:`_fallback_steps` grows its cell by ``FALLBACK_GROWTH`` up to ``FALLBACK_TRIES`` times until the share is met;
#: when that empties the mesh after a cell that left too many, it bisects between the two up to ``FALLBACK_BISECT``
#: times.
FALLBACK_GROWTH = 1.25
FALLBACK_TRIES = 12
FALLBACK_BISECT = 8


def _quadric(reduction: float) -> Any:
    decimate = vtkQuadricDecimation()
    decimate.SetTargetReduction(reduction)
    decimate.RegularizeOn()
    decimate.SetRegularization(REGULARIZATION)
    return decimate


#: Makes the quadric filter for a target reduction (tests replace it; looked up at the call).
QUADRIC: Callable[[float], Any] = _quadric


def _weld_float32(
    positions: NDArray[np.float64], triangles: NDArray[np.int64]
) -> NDArray[np.int64]:
    """``triangles`` with the ends of every edge that is zero-length in float32 merged (into the component's
    smallest vertex ID) and the triangles that then repeat a vertex dropped.

    ``vtkQuadricDecimation`` works on a float32 copy of the points (fact a); a boundary edge of zero length there
    gives NaN quadrics (fact b), and a NaN cost ends its main loop early (facts c, d): the stall of SLC-41. Positions
    are not changed: a merged vertex takes its root's position, which is the same in float32. One pass suffices: a
    vertex and its root are equal in float32, so an edge between two roots is zero-length only if an edge between
    their members was, and those were merged."""
    p32 = positions.astype(np.float32)
    e = clustering.edges(triangles)
    zero = np.all(p32[e[:, 0]] == p32[e[:, 1]], axis=1)
    if not zero.any():
        return triangles
    label = clustering.components(len(positions), e[zero, 0], e[zero, 1])
    triangles = label[triangles]
    a, b, c = triangles.T
    return triangles[(a != b) & (b != c) & (a != c)]


def _prepared(
    positions: NDArray[np.float64], triangles: NDArray[np.int64]
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.float64], float]:
    """The quadric's input: positions centred and scaled to a median edge of :data:`EDGE_UNITS`, the triangles
    welded for float32; plus the centre and scale to undo it."""
    centre = (positions.max(axis=0) + positions.min(axis=0)) / 2
    scale = EDGE_UNITS / clustering.median_edge(positions, triangles)
    scaled = (positions - centre) * scale
    return scaled, _weld_float32(scaled, triangles), centre, scale


def _run_quadric(
    positions: NDArray[np.float64],
    triangles: NDArray[np.int64],
    target: int,
    deadline: float,
    make: Callable[[float], Any],
) -> tuple[NDArray[np.float64], NDArray[np.int64]] | None:
    """One quadric run towards ``target`` triangles, aborted at ``deadline`` (``time.monotonic``); ``None`` when it
    is not started (the deadline passed, or a set-up above :data:`QUADRIC_WORK`), was aborted (its output is then
    empty: measured with 9.6.2) or gives no triangle."""
    if time.monotonic() > deadline:
        return None
    scaled, welded, centre, scale = _prepared(positions, triangles)
    if 0 < len(welded) <= target:  # same vertex IDs: unused points go later
        return positions, welded
    if len(welded) == 0 or clustering.edge_work(welded) > QUADRIC_WORK:
        return None
    decimate = make(1.0 - target / len(welded))

    def abort_after_deadline(caller: Any, _event: str) -> None:
        if time.monotonic() > deadline:
            caller.AbortExecuteOn()

    decimate.AddObserver("ProgressEvent", abort_after_deadline)
    decimate.SetInputData(polydata_from_triangles(scaled, welded))
    decimate.Update()
    aborted = getattr(decimate, "GetAbortExecute", lambda: 0)()
    points, result = mesh_points_and_triangles(decimate.GetOutput())
    return None if aborted or len(result) == 0 else (points / scale + centre, result)


def _reduce_parts(
    positions: NDArray[np.float64],
    triangles: NDArray[np.int64],
    target: int,
    deadline: float,
    make: Callable[[float], Any],
) -> tuple[NDArray[np.float64], NDArray[np.int64]] | None:
    """The quadric on the large parts and, in a run of its own, on the parts below :data:`ISLAND_TRIANGLES`
    (:data:`ISLAND_BOOST` times their proportional share, at most half of ``target``; all of it when every part is
    small, and what the large parts left of ``target`` when that is more). ``None`` when any run fails
    (:func:`_run_quadric`): a part is never dropped silently, the whole node goes to the fallback."""
    small = clustering.part_sizes(positions, triangles) < ISLAND_TRIANGLES
    n, n_small = len(triangles), int(small.sum())
    proportional = min(n_small, int(ISLAND_BOOST * target * n_small / n), target // 2)
    t_small = target if n_small == n else proportional
    pieces: list[tuple[NDArray[np.float64], NDArray[np.int64]]] = []
    for mask, large in ((~small, True), (small, False)):
        share = target - t_small if large else t_small
        if (
            not mask.any() or share <= 0
        ):  # islands whose share rounds to 0 (fewer than n / (2 · target) triangles)
            continue
        part_positions, part_triangles = clustering.compact(positions, triangles[mask])
        if len(part_triangles) > share:
            run = _run_quadric(part_positions, part_triangles, share, deadline, make)
            if run is None:
                return None
            part_positions, part_triangles = run
        pieces.append((part_positions, part_triangles))
        if large:  # the islands may use what the large parts left
            t_small = min(n_small, max(t_small, target - len(part_triangles)))
    offsets = np.cumsum([0] + [len(p) for p, _ in pieces])
    return (
        np.concatenate([p for p, _ in pieces]),
        np.concatenate([t + o for (_, t), o in zip(pieces, offsets, strict=False)]),
    )


def _repair_folds(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], rounds: int = FOLD_ROUNDS
) -> NDArray[np.int64]:
    """A copy of ``triangles`` in which every triangle whose face normal opposes the sum of its vertices' normals is
    turned over, up to ``rounds`` times. A vertex normal is the sum of the unit normals of its triangles, VTK's
    point-normal rule (fact i), so the final normals agree. A fold the decimation left would otherwise show its back
    face: a hole under the viewer's back-face culling, or a dark triangle."""
    triangles = triangles.copy()
    for _ in range(rounds):
        first = positions[triangles[:, 0]]
        with np.errstate(all="ignore"):  # non-finite positions are refused by the caller
            face = np.cross(positions[triangles[:, 1]] - first, positions[triangles[:, 2]] - first)
            face /= np.maximum(np.linalg.norm(face, axis=1, keepdims=True), 1e-300)
        flat = triangles.ravel()
        vertex = np.stack(
            [
                np.bincount(flat, weights=np.repeat(face[:, j], 3), minlength=len(positions))
                for j in range(3)
            ],
            axis=1,
        )
        with np.errstate(all="ignore"):
            bad = np.einsum("ij,ij->i", vertex[triangles].sum(axis=1), face) < 0
        if not bad.any():
            break
        triangles[bad] = triangles[bad][:, ::-1]
    return triangles


def _connected_steps(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], cell: float
) -> Steps[tuple[NDArray[np.float64], NDArray[np.int64]]]:
    return clustering.cluster_connected_steps(positions, triangles, cell, rescue=0)


def _fallback_steps(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], target: int
) -> Steps[tuple[NDArray[np.float64], NDArray[np.int64]] | None]:
    """Clustering with the cell grown until at most ``target`` triangles are left — connected clusters, then normal
    classes (which reduce a non-manifold fan that connected clusters empty). When a cell empties the mesh after one
    that left too many, the cell is bisected between the two. ``None`` when neither gives ``0 <`` triangles ``≤
    target`` (a soup of triangles each smaller than the first cell). Bounded (at most
    ``2 · (FALLBACK_TRIES + FALLBACK_BISECT)`` numpy passes); no splitting, so no cracks."""
    start = clustering.median_edge(positions, triangles) * math.sqrt(len(triangles) / target)
    for cluster in (_connected_steps, clustering.cluster_by_normal_steps):
        cell, above = start, None
        for _ in range(FALLBACK_TRIES):
            centres, result = yield from cluster(positions, triangles, cell)
            if len(result) <= target:
                break
            above = cell
            cell *= FALLBACK_GROWTH
        else:
            continue
        if len(result):
            return centres, result
        empty = cell
        for _ in range(FALLBACK_BISECT if above is not None else 0):
            middle = math.sqrt(above * empty)
            centres, result = yield from cluster(positions, triangles, middle)
            if 0 < len(result) <= target:
                return centres, result
            if len(result):
                above = middle
            else:
                empty = middle
    return None


def _finished(
    entity: Entity, positions: NDArray[np.float64], triangles: NDArray[np.int64], target: int
) -> Entity | None:
    """``entity`` with the reduced geometry, folds repaired and point normals from ``vtkPolyDataNormals``
    (``SplittingOff`` per §7.4, ``ConsistencyOff`` so the repaired winding stays:
    :func:`~remoteview_core.collect.mesh_from_triangles` with ``orient=False``); ``None`` when the result is not usable:
    no triangle with an area, more than ``target``, a non-finite normal or a position beyond float32. A zero normal
    becomes +Y, as for a collected node."""
    mesh = mesh_from_triangles(positions, _repair_folds(positions, triangles), orient=False)
    if mesh is None or not 0 < len(mesh.triangles) <= target:
        return None
    with np.errstate(over="ignore", invalid="ignore"):
        if not np.all(np.isfinite(mesh.positions.astype(np.float32))):
            return None
    try:  # the normals go to the writer as they are: glTF space already, so only the +Y repair of collect
        normals = unit_normals(mesh.normals)
    except ValueError:  # a non-finite point gives a non-finite normal
        return None
    return dataclasses.replace(
        entity, positions=mesh.positions, normals=normals, indices=mesh.triangles
    )


def decimate_entity(
    entity: Entity,
    target: int,
    *,
    quadric: Callable[[float], Any] | None = None,
) -> Entity | None:
    """``entity`` reduced to at most ``target`` triangles (unchanged when it already has no more).

    1. A mesh above ``2 · max(CLUSTER_GOAL, 3 · target)`` triangles is clustered to at most twice that goal
       (:func:`_bounded_steps`).
    2. Its used points at exactly one position are merged class by class
       (:func:`~remoteview_core.clustering.merge_coincident_steps`, SLC-66; unchanged when none coincide).
    3. A mesh with non-manifold fans (``fan_weight`` above :data:`FAN_LIMIT`, or ``edge_work`` above
       :data:`QUADRIC_WORK`) is clustered by normal class (:func:`_unfanned_steps`).
    4. The quadric (``quadric``, default :data:`QUADRIC`, looked up at the call) on the large parts and on the small
       ones (:func:`_reduce_parts`), on welded and scaled coordinates, within :data:`QUADRIC_SECONDS` of the start of
       this step.
    5. If any part gives no usable result: :func:`_fallback_steps` (clustering) on the whole mesh of step 3, with a
       warning in the log (counts only, no node data).
    6. Folds repaired, normals recomputed (:func:`_finished`).

    Returns ``None`` — before any VTK filter runs — for indices outside the positions or a triangle that repeats a
    vertex (VTK does not check them), and when nothing can reduce the mesh; :func:`fit_to_budget` then keeps the
    node whole and reports it (never dropped, §7.5)."""
    return run(decimate_steps(entity, target, quadric=quadric))


def decimate_steps(
    entity: Entity,
    target: int,
    *,
    quadric: Callable[[float], Any] | None = None,
) -> Steps[Entity | None]:
    """:func:`decimate_entity` in steps (the module docstring)."""
    count = entity.triangle_count
    if count <= target:
        return entity
    indices = np.asarray(entity.indices)
    if indices.size and (indices.min() < 0 or indices.max() >= len(entity.positions)):
        return None
    triangles = indices.reshape(-1, 3).astype(np.int64, copy=False)  # never written to (SLC-53)
    a, b, c = triangles.T
    # a triangle repeating a vertex: collect never makes them; a share of 0: allocate never gives one
    if target <= 0 or np.any((a == b) | (b == c) | (a == c)):
        return None
    positions = np.asarray(entity.positions, dtype=np.float64).reshape(-1, 3)
    goal = max(CLUSTER_GOAL, 3 * target)
    yield
    if len(triangles) > 2 * goal:
        bounded, bounded_triangles = yield from _bounded_steps(positions, triangles, goal)
        # nothing left to give the quadric: the fallback on the input
        if len(bounded_triangles) == 0:
            return (
                yield from _fallback_entity_steps(
                    entity, positions, triangles, target, "the size bound left no triangle"
                )
            )
        positions, triangles = bounded, bounded_triangles
    # before the fans: a soup merged into a bow tie is a fan
    positions, triangles = yield from clustering.merge_coincident_steps(positions, triangles)
    if (
        clustering.fan_weight(triangles) > FAN_LIMIT
        or clustering.edge_work(triangles) > QUADRIC_WORK
    ):
        yield
        positions, triangles = yield from _unfanned_steps(positions, triangles, target)
    yield
    deadline = time.monotonic() + QUADRIC_SECONDS
    reduced = _reduce_parts(positions, triangles, target, deadline, quadric or QUADRIC)
    if reduced is not None and 0 < len(reduced[1]) <= target:
        result = _finished(entity, *reduced, target)
        if result is not None:
            return result
    late = time.monotonic() > deadline
    yield
    return (
        yield from _fallback_entity_steps(
            entity,
            positions,
            triangles,
            target,
            f"the quadric did not finish within {QUADRIC_SECONDS:g} s"
            if late
            else "the quadric gave no usable result",
        )
    )


def _bounded_steps(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], goal: int
) -> Steps[tuple[NDArray[np.float64], NDArray[np.int64]]]:
    """Connected clustering to about ``goal`` triangles, at most ``2 · goal`` where a pass can reach it (the rescue
    skipped above ``RESCUE_GOALS · goal`` lost triangles, then up to :data:`BOUND_TRIES` passes without it)."""
    cell = clustering.median_edge(positions, triangles) * math.sqrt(len(triangles) / goal)
    bounded, bounded_triangles = yield from clustering.cluster_connected_steps(
        positions, triangles, cell, rescue_limit=RESCUE_GOALS * goal
    )
    for _ in range(BOUND_TRIES):
        if len(bounded_triangles) <= 2 * goal:
            break
        cell = clustering.median_edge(bounded, bounded_triangles) * math.sqrt(
            len(bounded_triangles) / goal
        )
        again, again_triangles = yield from clustering.cluster_connected_steps(
            bounded, bounded_triangles, cell, rescue=0
        )
        if len(again_triangles) == 0:
            break
        bounded, bounded_triangles = again, again_triangles
    return bounded, bounded_triangles


def _unfanned_steps(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], target: int
) -> Steps[tuple[NDArray[np.float64], NDArray[np.int64]]]:
    """A mesh with non-manifold fans clustered by grid cell and normal class to at least twice ``target`` triangles
    where possible, then coarser while its ``edge_work`` is above :data:`QUADRIC_WORK` (unchanged when every try
    leaves none)."""
    fan_goal = max(FAN_GOAL_FACTOR * target, FAN_GOAL_MIN)
    cell = clustering.median_edge(positions, triangles) * math.sqrt(len(triangles) / fan_goal)
    for _ in range(FAN_TRIES):
        centres, fans = yield from clustering.cluster_by_normal_steps(positions, triangles, cell)
        if len(fans) >= 2 * target:
            break
        cell /= FAN_REFINE
    for _ in range(FAN_TRIES):
        if len(fans) == 0 or clustering.edge_work(fans) <= QUADRIC_WORK:
            break
        cell *= FAN_REFINE
        coarser, coarser_fans = yield from clustering.cluster_by_normal_steps(
            positions, triangles, cell
        )
        if len(coarser_fans) == 0:
            break
        centres, fans = coarser, coarser_fans
    return (centres, fans) if len(fans) else (positions, triangles)


def _fallback_entity_steps(
    entity: Entity,
    positions: NDArray[np.float64],
    triangles: NDArray[np.int64],
    target: int,
    reason: str,
) -> Steps[Entity | None]:
    """:func:`_fallback_steps` on the mesh, finished, with one warning in the log that names ``reason`` and the
    outcome — counts only, never node data (T7) — so the Python console or the Error Log shows that the coarser path
    ran."""
    coarse = yield from _fallback_steps(positions, triangles, target)
    result = None if coarse is None else _finished(entity, *coarse, target)
    if result is None:
        _log.warning(
            "Decimation: %s on a node of %d triangles; nothing could reduce it, it is sent whole",
            reason,
            entity.triangle_count,
        )
    else:
        _log.warning(
            "Decimation: %s on a node of %d triangles; vertex clustering reduced it to %d instead (coarser)",
            reason,
            entity.triangle_count,
            result.triangle_count,
        )
    return result


@dataclass(frozen=True)
class FitResult:
    """The entities within budget, in input order: ``reduced`` names the nodes that were decimated, ``unreduced`` those
    above their share that nothing could reduce (kept whole, never dropped), ``cleaned`` those whose small islands were
    left out (SLC-53)."""

    entities: tuple[Entity, ...]
    reduced: tuple[str, ...]
    unreduced: tuple[str, ...]
    cleaned: tuple[str, ...] = ()

    @property
    def triangle_count(self) -> int:
        return sum(e.triangle_count for e in self.entities)


def island_mask(entity: Entity) -> NDArray[np.bool_] | None:
    """The triangles of ``entity`` that lie in its small islands (:func:`clustering.small_islands` with
    :data:`SMALL_ISLAND_TRIANGLES` and :data:`SMALL_ISLAND_SHARE`), or ``None`` when it has none — or no triangle, or
    indices outside its positions, which :func:`decimate_entity` refuses. Logs one line with the counts when there are
    islands (T7: no name, ID or coordinate)."""
    indices = np.asarray(entity.indices)
    count = entity.triangle_count
    if count == 0 or indices.min() < 0 or indices.max() >= len(entity.positions):
        return None
    drop, islands = clustering.small_islands(
        np.asarray(entity.positions, dtype=np.float64).reshape(-1, 3),
        indices.reshape(-1, 3).astype(np.int64, copy=False),
        SMALL_ISLAND_TRIANGLES,
        SMALL_ISLAND_SHARE,
    )
    if not islands:
        return None
    _log.info(
        "Islands: %d small islands (%d of %d triangles) are left out of a node",
        islands,
        int(drop.sum()),
        count,
    )
    return drop


def without_islands(entity: Entity, drop: NDArray[np.bool_], *, compact: bool = True) -> Entity:
    """``entity`` without the triangles ``drop`` marks. ``compact`` also drops the vertices no kept triangle uses; a
    kept vertex keeps every triangle around it (they are in the same part), so its normal stays right.
    ``compact=False`` shares the positions and normals (no copy, unused vertices kept): only for
    :func:`decimate_steps`, whose results are compact — such an entity must never leave :func:`fit_entity_steps`, or
    the vertices of the islands would be written to the GLB."""
    triangles = np.asarray(entity.indices).reshape(-1, 3)[~drop]
    if not compact:
        return dataclasses.replace(entity, indices=triangles)
    used = np.zeros(len(entity.positions), dtype=bool)
    used[triangles.ravel()] = True
    remap = np.cumsum(used) - 1
    return dataclasses.replace(
        entity,
        positions=np.asarray(entity.positions)[used],
        normals=np.asarray(entity.normals)[used],
        indices=remap[triangles],
    )


def fit_entity(
    entity: Entity,
    drop: NDArray[np.bool_] | None,
    target: int,
    *,
    quadric: Callable[[float], Any] | None = None,
) -> tuple[Entity, bool | None]:
    """One node of :func:`fit_to_budget`: ``entity`` without the triangles ``drop`` marks (its small islands, from
    :func:`island_mask`), reduced to ``target`` triangles if it has more. The flag is ``True`` when it was decimated,
    ``False`` when nothing could reduce it (sent whole, without its islands) and ``None`` within its share."""
    return run(fit_entity_steps(entity, drop, target, quadric=quadric))


def fit_entity_steps(
    entity: Entity,
    drop: NDArray[np.bool_] | None,
    target: int,
    *,
    quadric: Callable[[float], Any] | None = None,
) -> Steps[tuple[Entity, bool | None]]:
    """:func:`fit_entity` in steps (those of :func:`decimate_steps`)."""
    count = entity.triangle_count - (0 if drop is None else int(drop.sum()))
    if count <= target:
        return (entity if drop is None else without_islands(entity, drop)), None
    working = entity if drop is None else without_islands(entity, drop, compact=False)
    smaller = yield from decimate_steps(working, target, quadric=quadric)
    if smaller is not None:
        return smaller, True
    return (entity if drop is None else without_islands(entity, drop)), False


def fit_to_budget(
    entities: Sequence[Entity],
    budget: Budget,
    *,
    quadric: Callable[[float], Any] | None = None,
    remove_islands: bool = False,
) -> FitResult:
    """Decimate ``entities`` to ``budget`` (see the module docstring); ``quadric`` goes to :func:`decimate_entity`.
    With ``remove_islands`` every node first loses its small islands (:func:`island_mask`), also a node within its
    share, and the shares follow the triangles left."""
    return run(fit_steps(entities, budget, quadric=quadric, remove_islands=remove_islands))


def fit_steps(
    entities: Sequence[Entity],
    budget: Budget,
    *,
    quadric: Callable[[float], Any] | None = None,
    remove_islands: bool = False,
    progress: Progress | None = None,
) -> Steps[FitResult]:
    """:func:`fit_to_budget` in steps: one per node's islands, then those of :func:`fit_entity_steps` and one more per
    node; one unit of ``progress.done`` per node fitted."""
    drops: list[NDArray[np.bool_] | None] = [None] * len(entities)
    if remove_islands:
        for i, entity in enumerate(entities):
            drops[i] = island_mask(entity)
            yield
    targets = allocate(
        [
            e.triangle_count - (0 if d is None else int(d.sum()))
            for e, d in zip(entities, drops, strict=True)
        ],
        budget,
    )
    fitted: list[Entity] = []
    reduced: list[str] = []
    unreduced: list[str] = []
    for entity, drop, target in zip(entities, drops, targets, strict=True):
        result, decimated = yield from fit_entity_steps(entity, drop, target, quadric=quadric)
        fitted.append(result)
        if decimated is not None:
            (reduced if decimated else unreduced).append(entity.node_id)
        if progress is not None:
            progress.done += 1
        yield
    cleaned = tuple(e.node_id for e, d in zip(entities, drops, strict=True) if d is not None)
    return FitResult(tuple(fitted), tuple(reduced), tuple(unreduced), cleaned)


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
