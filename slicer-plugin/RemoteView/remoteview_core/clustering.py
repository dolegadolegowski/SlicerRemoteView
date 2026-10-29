"""Vertex clustering for meshes too large or too fan-shaped for ``vtkQuadricDecimation`` (SLC-41).

:mod:`remoteview_core.decimate` uses it to bound the quadric's input and as its fallback. A cluster is a
**connected** piece of the mesh inside one grid cell (:func:`cluster_connected`), so the two sides of a wall thinner
than a cell stay apart instead of collapsing into one sheet of mixed winding; vertices at exactly the same position
with agreeing normals (the two sides of a seam) count as connected, so seams do not open. A cluster is represented by
its member closest to the cluster's mean, which lies on the input surface. Winding is kept per triangle: a triangle
keeps the order of its clusters, a repeated one is kept once, and the two sides of a collapsed fold, whose windings
cancel, go both. For non-manifold fans (pages sharing one spine) :func:`cluster_by_normal` clusters by grid cell and the
tetrahedral class of the vertex normal instead. :func:`small_islands` finds the small connected parts that *Remove
small islands* leaves out before the shares (SLC-53), with parts joined through shared vertex IDs and through exactly
equal positions.

Pure numpy (no VTK, no Slicer), deterministic (fixed seed). Indices are int64, positions float64. Sources and
measurements: ``docs/research/slicer-decimate.md`` § SLC-41, ``docs/research/slicer-islands.md`` (SLC-53).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

#: Four tetrahedral directions: the classes ``argmax(n · d)`` of ``n`` and ``-n`` always differ.
TETRA = np.array([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], dtype=np.float64) / np.sqrt(3)
#: Triangles sampled for :func:`median_edge`.
MEDIAN_SAMPLE = 200_000
#: Pieces lost to a cell (islands smaller than it) are clustered again with ``cell / RESCUE_DIVISOR``.
RESCUE_DIVISOR = 3.0

Positions = NDArray[np.float64]
Triangles = NDArray[np.int64]


def edges(triangles: Triangles) -> NDArray[np.int64]:
    """The three directed edges of every triangle, ``(3m, 2)``: all first edges, then all second, then all third."""
    return np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])


def components(n: int, a: NDArray[np.int64], b: NDArray[np.int64]) -> NDArray[np.int64]:
    """The root (smallest vertex ID) of every vertex's connected component under the undirected edges ``(a, b)``.

    Hooking of roots by their minimum plus full path compression; edges already inside one component are dropped each
    round, so the work shrinks quickly (4-5 rounds on 16M triangles). The first round needs no gather (the parents are
    the identity), and the edges left are taken by index after one scan, so a round that drops none copies nothing
    (SLC-53: two edges per triangle of a 16.1M-triangle segmentation 0.52-0.56 s → 0.32 s natively, same roots)."""
    parent = np.arange(n, dtype=np.int64)
    a, b = np.asarray(a, dtype=np.int64), np.asarray(b, dtype=np.int64)
    pa, pb = a, b
    while len(a):
        apart = pa != pb
        if not apart.all():
            keep = np.flatnonzero(apart)
            a, b, pa, pb = a[keep], b[keep], pa[keep], pb[keep]
        if not len(a):
            break
        np.minimum.at(parent, np.maximum(pa, pb), np.minimum(pa, pb))
        while True:
            compressed = parent[parent]
            if np.array_equal(compressed, parent):
                break
            parent = compressed
        pa, pb = parent[a], parent[b]
    return parent


def median_edge(positions: Positions, triangles: Triangles) -> float:
    """The median length of the first edge of up to :data:`MEDIAN_SAMPLE` random triangles (seed 0); 1.0 when it is
    not positive."""
    m = len(triangles)
    if m == 0:
        return 1.0
    idx = np.random.default_rng(0).integers(0, m, min(MEDIAN_SAMPLE, m))
    sample = triangles[idx]
    median = float(
        np.median(np.linalg.norm(positions[sample[:, 1]] - positions[sample[:, 0]], axis=1))
    )
    return median if median > 0 else 1.0


def compact(positions: Positions, triangles: Triangles) -> tuple[Positions, Triangles]:
    """Only the vertices ``triangles`` use, in their order, with the triangles remapped. O(n): a used-mask and its
    running count give the same arrays as ``np.unique``, which sorted 43M indices in 4.5 s on a node of dust."""
    used = np.zeros(len(positions), dtype=bool)
    used[triangles.ravel()] = True
    remap = np.cumsum(used) - 1
    return positions[used], remap[triangles]


def edge_work(triangles: Triangles) -> float:
    """``Σ deg(a) · deg(b)`` over the three edges of every triangle, ``deg`` a vertex's triangle count: the work of
    ``vtkPolyData::GetCellEdgeNeighbors`` on every edge, which ``vtkQuadricDecimation``'s set-up and
    ``vtkOrientPolyData`` (``ConsistencyOn``) run before they can be aborted — 106-148 per triangle on an ordinary
    mesh, 6.4e10 on 672 pages sharing one spine (research note § SLC-41, fact l)."""
    if len(triangles) == 0:
        return 0.0
    degree = np.bincount(triangles.ravel()).astype(np.float64)
    e = edges(triangles)
    return float(np.dot(degree[e[:, 0]], degree[e[:, 1]]))


def fan_weight(triangles: Triangles) -> float:
    """``Σdeg² / Σdeg`` over the vertex valences: the valence weighted by valence, about 6 on an ordinary mesh and
    about 1,000 on 3,000 pages sharing one spine (the quadric's work per collapse grows with it)."""
    if len(triangles) == 0:
        return 0.0
    degree = np.bincount(triangles.ravel()).astype(np.float64)
    return float((degree**2).sum() / degree.sum())


def _grid_keys(positions: Positions, cell: float) -> NDArray[np.int64]:
    """The grid cell of every vertex as one integer."""
    ijk = np.floor((positions - positions.min(axis=0)) / cell).astype(np.int64)
    dims = ijk.max(axis=0) + 1
    if float(np.prod(dims.astype(np.float64))) < 2.0**62:
        return (ijk[:, 0] * dims[1] + ijk[:, 1]) * dims[2] + ijk[:, 2]
    return np.unique(ijk, axis=0, return_inverse=True)[1].ravel()


def _collapse(
    positions: Positions,
    triangles: Triangles,
    cid: NDArray[np.int64],
    k: int,
    kept: NDArray[np.bool_] | None = None,
) -> tuple[Positions, Triangles]:
    """Every vertex moved to its cluster ``cid`` (``k`` clusters), represented by the member closest to the mean (the
    largest vertex ID on a tie); triangles that repeat a cluster dropped, same-winding duplicates merged, and the
    sides of a fold whose windings cancel dropped. Returns the used clusters' positions and the triangles over them;
    ``kept`` (``k`` booleans), when given, is set for the clusters a kept triangle uses."""
    count = np.bincount(cid, minlength=k).astype(np.float64)
    mean = (
        np.stack([np.bincount(cid, weights=positions[:, j], minlength=k) for j in range(3)], axis=1)
        / np.maximum(count, 1.0)[:, None]
    )
    offset = positions - mean[cid]
    dist = np.einsum("ij,ij->i", offset, offset)
    best = np.full(k, np.inf)
    np.minimum.at(best, cid, dist)
    hit = np.flatnonzero(dist == best[cid])
    member = np.full(k, -1, dtype=np.int64)
    np.maximum.at(
        member, cid[hit], hit
    )  # the largest vertex ID among the closest: no reliance on write order
    centres = mean.copy()
    chosen = member >= 0
    centres[chosen] = positions[member[chosen]]
    mapped = cid[triangles]
    a, b, c = mapped.T
    mapped = mapped[(a != b) & (b != c) & (a != c)]
    if len(mapped) == 0:
        return np.empty((0, 3), dtype=np.float64), np.empty((0, 3), dtype=np.int64)
    start = np.argmin(mapped, axis=1)  # rotate to start at the smallest index: the winding is kept
    mapped = np.take_along_axis(mapped, (start[:, None] + np.arange(3)) % 3, axis=1)
    ordered = np.sort(mapped, axis=1)
    _, group, group_count = np.unique(ordered, axis=0, return_inverse=True, return_counts=True)
    group = group.ravel()
    orient = np.where(mapped[:, 1] == ordered[:, 1], 1, -1)
    net = np.bincount(group, weights=orient)
    first = np.full(len(group_count), -1, dtype=np.int64)
    first[group[::-1]] = np.arange(len(mapped))[::-1]
    keep = net != 0
    chosen = first[keep]
    result = mapped[chosen].copy()
    flip = net[keep] * orient[chosen] < 0
    result[flip] = result[flip][:, ::-1]
    if kept is not None:
        kept[result.ravel()] = True
    return compact(centres, result)


def _mix(z: NDArray[np.uint64]) -> NDArray[np.uint64]:
    """The splitmix64 finaliser (wrapping uint64 arithmetic)."""
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return z ^ (z >> np.uint64(31))


def position_keys(positions: Positions) -> NDArray[np.uint64]:
    """A 64-bit hash of the coordinate bits of every vertex (``-0.0`` counts as ``0.0``): equal positions have equal
    keys. One coordinate at a time, so no copy of all the positions is made."""

    def bits(j: int) -> NDArray[np.uint64]:
        return np.ascontiguousarray(positions[:, j] + 0.0).view(np.uint64)  # + 0.0: -0.0 → 0.0

    with np.errstate(over="ignore"):
        return _mix(_mix(_mix(bits(0)) ^ bits(1)) ^ bits(2))


#: Bits of the key-prefix table of :func:`small_islands` (2²⁴ booleans, 16 MiB): when the threshold is the minimum, it
#: selects the vertices whose position may be that of a small part's vertex, so only those are sorted (532,616 of
#: 8,089,163 vertices on a 16.1M-triangle segmentation).
PREFIX_BITS = 24


def _key_order(key: NDArray[np.uint64], candidates: NDArray[np.int64]) -> NDArray[np.int64]:
    """``candidates`` ordered by ``key``, ties in their given order: ``candidates[np.argsort(key[candidates],
    kind="stable")]``, as four stable passes over 16 bits each, which numpy radix-sorts (SLC-53: 0.29 s instead of
    1.64 s on 8M random keys, 1.29 s instead of 8.71 s on 25M)."""
    order = candidates
    for shift in range(0, 64, 16):
        digit = (key[order] >> np.uint64(shift)).astype(np.uint16)  # the 16 bits from ``shift`` up
        order = order[np.argsort(digit, kind="stable")]
    return order


def _same_position(
    positions: Positions, key: NDArray[np.uint64], candidates: NDArray[np.int64]
) -> tuple[NDArray[np.int64], NDArray[np.int64]]:
    """``(a, b)``: every vertex of ``candidates`` paired with the first candidate of its key, kept when their positions
    are exactly equal (compared one axis at a time, without ``(p, 3)`` copies)."""
    order = _key_order(key, candidates)
    k = key[order]
    start = np.r_[True, k[1:] != k[:-1]]
    first = order[np.maximum.accumulate(np.where(start, np.arange(len(order)), 0))]
    a, b = order[~start], first[~start]
    same = np.ones(len(a), dtype=bool)
    for j in range(3):
        axis = positions[:, j]
        same &= axis[a] == axis[b]
    return a[same], b[same]


def small_islands(
    positions: Positions, triangles: Triangles, minimum: int, share: float
) -> tuple[NDArray[np.bool_], int]:
    """For every triangle, whether it lies in a small island, and how many islands that makes (SLC-53).

    A part is connected through shared vertex IDs and through vertices at exactly the same position, whatever their
    normals: an unwelded seam, a double-sided sheet or a triangle soup is one part. A part is a small island when it
    has fewer than ``minimum`` triangles **and** fewer than ``share`` times the triangles of the largest part, so with
    ``share <= 1`` the largest part (and any part as large) never is one. The parts by vertex IDs come from
    :func:`components` on two edges per triangle; the parts that :func:`_same_position` joins are merged by
    :func:`components` on their roots. Which vertices it compares:

    - every vertex when ``share`` × the largest part by vertex IDs is below ``minimum``: the threshold then follows the
      largest part, which a join between two larger parts can make larger still (an unwelded seam);
    - otherwise only the vertices whose :data:`PREFIX_BITS` key prefix is that of a small part's vertex: the threshold
      is ``minimum``, and a join between two parts of at least ``minimum`` triangles makes no part small.

    Either way the result is the rule's with every coincident pair. The cost grows with the vertices compared, sorted
    by :func:`_key_order`: 0.6 s natively for 16.1M triangles (532,616 vertices compared), 0.9 s for 16.4M triangles of
    dust and 0.8 s for a 2.3M-triangle soup (every vertex compared)."""
    m, n = len(triangles), len(positions)
    root = components(
        n,
        np.concatenate([triangles[:, 0], triangles[:, 1]]),
        np.concatenate([triangles[:, 1], triangles[:, 2]]),
    )
    label = root[triangles[:, 0]]  # every triangle's part, named by its root (a vertex ID)
    size = np.bincount(label, minlength=n)
    small = (size > 0) & (size < minimum)
    if m == 0 or not small.any():
        return np.zeros(m, dtype=bool), 0
    key = position_keys(positions)
    if share * size.max() < minimum:
        candidates = np.arange(n)
    else:
        prefix = key >> np.uint64(64 - PREFIX_BITS)
        table = np.zeros(1 << PREFIX_BITS, dtype=bool)
        table[prefix[small[root]]] = True
        candidates = np.flatnonzero(table[prefix])
        del prefix, table
    a, b = _same_position(positions, key, candidates)
    del key, candidates
    ra, rb = root[a], root[b]
    joined = ra != rb
    if joined.any():
        # the parts that positions join, each named by its smallest root, and their sizes
        label = components(n, ra[joined], rb[joined])[label]
        size = np.bincount(label, minlength=n)
    island = (size > 0) & (size < min(minimum, share * size.max()))
    return island[label], int(island.sum())


def coincident_pairs(positions: Positions, triangles: Triangles) -> NDArray[np.int64]:
    """``(p, 2)`` pairs of distinct vertices at exactly the same position whose vertex normals (sums of their
    triangles' face normals) agree: the two sides of a seam (a reader's or a normal filter's duplicated points). Each
    vertex is paired with the first of its position. Opposite normals — two coincident layers of a double-sided sheet —
    stay apart, or they would cancel. A 64-bit hash of the coordinate bits finds candidates (one sort, 0.3 s on 8M
    vertices; only the vertices of repeated hashes are sorted again, by :func:`_same_position`); the positions are
    compared exactly."""
    empty = np.empty((0, 2), dtype=np.int64)
    if len(positions) < 2:
        return empty
    key = position_keys(positions)
    ordered = np.sort(key)
    repeated = ordered[1:] == ordered[:-1]
    if not repeated.any():
        return empty
    values = np.unique(ordered[1:][repeated])  # the repeated keys; only their vertices are sorted
    slot = np.minimum(np.searchsorted(values, key), len(values) - 1)
    a, b = _same_position(positions, key, np.flatnonzero(values[slot] == key))
    del key, ordered, slot  # not needed for the normals
    if not len(a):
        return empty
    mark = np.zeros(len(positions), dtype=bool)
    mark[a] = mark[b] = True
    near = triangles[mark[triangles].any(axis=1)]  # the vertex normals of the candidates only
    corner = positions[near[:, 0]]
    face = np.cross(positions[near[:, 1]] - corner, positions[near[:, 2]] - corner)
    normal = np.stack(
        [
            np.bincount(near.ravel(), weights=np.repeat(face[:, j], 3), minlength=len(positions))
            for j in range(3)
        ],
        axis=1,
    )
    agree = np.einsum("ij,ij->i", normal[a], normal[b]) > 0
    return np.stack([a[agree], b[agree]], axis=1)


def cluster_connected(
    positions: Positions,
    triangles: Triangles,
    cell: float,
    *,
    rescue: float = RESCUE_DIVISOR,
    rescue_limit: int | None = None,
) -> tuple[Positions, Triangles]:
    """Vertex clustering where a cluster is a connected piece of the mesh inside one grid cell of size ``cell``;
    vertices at the same position count as connected (:func:`coincident_pairs`), so a seam does not open. With
    ``rescue``, the input triangles none of whose clusters is used by a kept triangle (islands smaller than a cell,
    also those whose two sides cancel) are clustered again with ``cell / rescue`` and added — unless there are more
    than ``rescue_limit`` of them (a node of dust: the rescue would cost O(lost) and return several times the goal)."""
    key = _grid_keys(positions, cell)
    twins = coincident_pairs(positions, triangles)
    m = len(triangles)
    e = np.empty(
        (3 * m + len(twins), 2), dtype=np.int64
    )  # edges(triangles) and the twins, in one allocation
    for j in range(3):
        e[j * m : (j + 1) * m] = triangles[:, [j, (j + 1) % 3]]
    e[3 * m :] = twins
    same = key[e[:, 0]] == key[e[:, 1]]
    a, b = e[same, 0], e[same, 1]
    del e, same, key  # the largest arrays: not alive during _collapse
    label = components(len(positions), a, b)
    del a, b
    uniq, cid = np.unique(label, return_inverse=True)
    cid = cid.ravel()
    alive = np.zeros(len(uniq), dtype=bool)
    centres, result = _collapse(positions, triangles, cid, len(uniq), alive)
    if not rescue:
        return centres, result
    lost = ~alive[cid[triangles]].any(axis=1)
    n_lost = int(lost.sum())
    if not n_lost or (rescue_limit is not None and n_lost > rescue_limit):
        return centres, result
    more, more_triangles = cluster_connected(
        *compact(positions, triangles[lost]), cell / rescue, rescue=0
    )
    return np.concatenate([centres, more]), np.concatenate([result, more_triangles + len(centres)])


def cluster_by_normal(
    positions: Positions, triangles: Triangles, cell: float
) -> tuple[Positions, Triangles]:
    """Vertex clustering by grid cell and the tetrahedral class of the area-weighted vertex normal, for non-manifold
    fans where connected clusters do not reduce (every page reaches the spine)."""
    first = positions[triangles[:, 0]]
    face = np.cross(positions[triangles[:, 1]] - first, positions[triangles[:, 2]] - first)
    flat = triangles.ravel()
    normals = np.stack(
        [
            np.bincount(flat, weights=np.repeat(face[:, j], 3), minlength=len(positions))
            for j in range(3)
        ],
        axis=1,
    )
    key = _grid_keys(positions, cell) * 4 + np.argmax(normals @ TETRA.T, axis=1)
    uniq, cid = np.unique(key, return_inverse=True)
    return _collapse(positions, triangles, cid.ravel(), len(uniq))


def part_sizes(positions: Positions, triangles: Triangles) -> NDArray[np.int64]:
    """For every triangle, the triangle count of its connected component."""
    e = edges(triangles)
    label = components(len(positions), e[:, 0], e[:, 1])
    _, part, counts = np.unique(label[triangles[:, 0]], return_inverse=True, return_counts=True)
    return counts[part.ravel()]
