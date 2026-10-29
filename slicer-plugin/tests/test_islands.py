"""SLC-53: *Remove small islands* — the small connected parts of a node are left out before the shares are given
(``clustering.small_islands``, ``decimate.island_mask``, ``fit_to_budget(…, remove_islands=True)``)."""

from __future__ import annotations

import dataclasses
import logging
import time
import tracemalloc

import numpy as np
import pytest
from support import FakeScene, flying_edges, mesh_entity
from vtkmodules.vtkFiltersCore import vtkTriangleFilter
from vtkmodules.vtkFiltersSources import vtkCubeSource, vtkSphereSource

from remoteview_core import clustering, decimate
from remoteview_core.collect import collect_entities, mesh_points_and_triangles
from remoteview_core.decimate import Budget, fit_to_budget, island_mask

MINIMUM, SHARE = decimate.SMALL_ISLAND_TRIANGLES, decimate.SMALL_ISLAND_SHARE
#: Exact in binary: grids placed at multiples of it share exactly equal positions.
STEP = 2.0**-10


def uv_sphere(resolution: int, radius: float = 0.05, centre=(0.0, 0.0, 0.0)):
    """A ``vtkSphereSource`` of ``2 · resolution · (resolution − 2)`` triangles, one part."""
    source = vtkSphereSource()
    source.SetRadius(radius)
    source.SetCenter(*centre)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    return mesh_points_and_triangles(source.GetOutput())


def grid(nx: int, ny: int, origin=(0, 0, 0)):
    """An ``nx × ny`` grid of quads in a z plane at ``origin`` (in :data:`STEP` units): ``2 · nx · ny`` triangles."""
    i, j = np.meshgrid(np.arange(nx + 1), np.arange(ny + 1), indexing="ij")
    positions = (np.c_[i.ravel(), j.ravel(), np.zeros(i.size)] + np.asarray(origin)) * STEP
    corner = (np.arange(nx)[:, None] * (ny + 1) + np.arange(ny)[None]).ravel()
    triangles = np.concatenate(
        [
            np.c_[corner, corner + ny + 1, corner + 1],
            np.c_[corner + 1, corner + ny + 1, corner + ny + 2],
        ]
    )
    return positions, triangles


def joined(*meshes):
    """The meshes as one, vertex IDs offset."""
    offsets = np.cumsum([0] + [len(p) for p, _ in meshes])
    return (
        np.concatenate([p for p, _ in meshes]),
        np.concatenate([t + o for (_, t), o in zip(meshes, offsets, strict=False)]),
    )


def soup(positions, triangles):
    """Every triangle with its own three vertices (an STL read without merging)."""
    return positions[triangles.ravel()], np.arange(3 * len(triangles)).reshape(-1, 3)


def charts(positions, triangles, count: int):
    """The mesh cut into ``count`` charts by the angle of each triangle's centre around z, every chart with its own
    vertices (an OBJ with UV seams): the charts touch only through equal positions."""
    centre = positions[triangles].mean(axis=1)
    angle = np.arctan2(centre[:, 1], centre[:, 0]) + np.pi
    chart = np.floor(angle / (2 * np.pi) * count).astype(int) % count
    return joined(*(clustering.compact(positions, triangles[chart == c]) for c in range(count)))


def old_components(n, a, b):
    """``clustering.components`` as SLC-41 shipped it."""
    parent = np.arange(n, dtype=np.int64)
    a, b = np.asarray(a, dtype=np.int64), np.asarray(b, dtype=np.int64)
    while len(a):
        pa, pb = parent[a], parent[b]
        apart = pa != pb
        a, b, pa, pb = a[apart], b[apart], pa[apart], pb[apart]
        if not len(a):
            break
        np.minimum.at(parent, np.maximum(pa, pb), np.minimum(pa, pb))
        while True:
            compressed = parent[parent]
            if np.array_equal(compressed, parent):
                break
            parent = compressed
    return parent


def reference_islands(positions, triangles, minimum=MINIMUM, share=SHARE):
    """The plain definition: every pair of vertices at the same position, all three edges of every triangle, the
    SLC-41 union-find."""
    key = clustering.position_keys(positions)
    order = np.argsort(key, kind="stable")
    k = key[order]
    start = np.r_[True, k[1:] != k[:-1]]
    first = order[np.maximum.accumulate(np.where(start, np.arange(len(order)), 0))]
    a, b = order[~start], first[~start]
    same = np.all(positions[a] == positions[b], axis=1)
    e = clustering.edges(triangles)
    root = old_components(len(positions), np.r_[e[:, 0], a[same]], np.r_[e[:, 1], b[same]])
    label = root[triangles[:, 0]]
    size = np.bincount(label, minlength=len(positions))
    island = (size > 0) & (size < min(minimum, share * size.max()))
    return island[label], int(island.sum())


def compact(entity) -> bool:
    """Every vertex is used by a triangle (no vertex of a removed island is written to the GLB)."""
    return len(entity.positions) == len(np.unique(entity.indices))


def peak_bytes(function, *args) -> int:
    """The peak of the memory ``function(*args)`` allocates (numpy reports its arrays to ``tracemalloc``)."""
    started = not tracemalloc.is_tracing()
    if started:
        tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        base = tracemalloc.get_traced_memory()[0]
        function(*args)
        return tracemalloc.get_traced_memory()[1] - base
    finally:
        if started:
            tracemalloc.stop()


# --------------------------------------------------------------------------- parts and islands (clustering)


def test_islands_components_same_roots_as_before():
    """The faster ``components`` gives the roots of SLC-41's on random graphs, self-loops and repeated edges included
    (the size bound and the fallback cluster with it too). Its first round needs no gather and, without self-loops (a
    mesh's edges), copies nothing: on two edges per triangle of a sphere it peaks at 22 bytes per edge (SLC-41: 53)."""
    for seed in range(6):
        rng = np.random.default_rng(seed)
        n = int(rng.integers(1, 3_000))
        m = int(rng.integers(0, 5_000))
        a, b = rng.integers(0, n, m), rng.integers(0, n, m)
        np.testing.assert_array_equal(clustering.components(n, a, b), old_components(n, a, b))
    positions, triangles = uv_sphere(400)
    a = np.concatenate([triangles[:, 0], triangles[:, 1]])
    b = np.concatenate([triangles[:, 1], triangles[:, 2]])
    roots = clustering.components(len(positions), a, b)
    np.testing.assert_array_equal(roots, old_components(len(positions), a, b))
    assert np.all(roots == 0)  # one part
    assert peak_bytes(clustering.components, len(positions), a, b) < 32 * len(a)


def test_islands_parts_join_through_exactly_shared_positions():
    """A ``vtkCubeSource`` has its own 4 points per face (24 points): six parts by vertex IDs, one by position. A
    sphere read as a soup is one part too."""
    source = vtkCubeSource()
    source.SetCenter(2.0, 0.0, 0.0)
    triangulate = vtkTriangleFilter()
    triangulate.SetInputConnection(source.GetOutputPort())
    triangulate.Update()
    cube = mesh_points_and_triangles(triangulate.GetOutput())
    assert len(cube[0]) == 24 and len(cube[1]) == 12
    body = uv_sphere(100)  # 19,600 triangles
    drop, count = clustering.small_islands(*joined(body, cube), MINIMUM, SHARE)
    assert count == 1 and drop.sum() == 12 and drop[-12:].all()  # one island of 12, not six of 2
    speck = uv_sphere(8, 0.003, (0.1, 0.0, 0.0))  # 96 triangles
    drop, count = clustering.small_islands(*soup(*joined(body, speck)), MINIMUM, SHARE)
    assert count == 1 and drop.sum() == 96  # not 19,696 islands of one triangle


def test_islands_the_minimum_is_exclusive_and_the_largest_part_stays():
    """Fewer triangles than the minimum is an island (Slicer: fewer voxels than the minimum size); a part with exactly
    the minimum stays."""
    body = uv_sphere(250)  # 124,000 triangles: 1 % of it is above the minimum
    kept = grid(23, 26, origin=(200, 0, 0))  # 1,196
    removed = grid(3, 199, origin=(300, 0, 0))  # 1,194
    specks = [uv_sphere(8, 0.003, (0.0, 0.1 + 0.01 * i, 0.0)) for i in range(20)]  # 96 each
    positions, triangles = joined(body, kept, removed, *specks)
    drop, count = clustering.small_islands(positions, triangles, MINIMUM, SHARE)
    assert count == 21 and drop.sum() == 1_194 + 20 * 96
    assert not drop[: len(body[1]) + len(kept[1])].any()
    expected, expected_count = reference_islands(positions, triangles)
    np.testing.assert_array_equal(drop, expected)
    assert count == expected_count


def test_islands_a_node_of_small_similar_parts_keeps_them():
    """Electrode contacts, glyphs, letters: no part is below 1 % of the largest, so none is an island. Next to a
    50,000-triangle body, parts of 600 triangles (1.2 %) stay and parts of 400 (0.8 %) go."""
    contacts = [uv_sphere(8, 0.002, (0.01 * i, 0.0, 0.0)) for i in range(8)]
    drop, count = clustering.small_islands(*joined(*contacts), MINIMUM, SHARE)
    assert count == 0 and not drop.any()
    body = grid(100, 250)  # 50,000
    larger = [grid(10, 30, origin=(200, 50 * i, 0)) for i in range(3)]  # 600 each
    smaller = [grid(10, 20, origin=(300, 50 * i, 0)) for i in range(3)]  # 400 each
    drop, count = clustering.small_islands(*joined(body, *larger, *smaller), MINIMUM, SHARE)
    assert count == 3 and drop.sum() == 1_200 and drop[-1_200:].all()
    # two equal largest parts below the minimum, with a share of 1: both stay
    pair = joined(grid(10, 10), grid(10, 10, origin=(20, 0, 0)))
    assert clustering.small_islands(*pair, MINIMUM, 1.0)[1] == 0


def test_islands_double_sided_sheet_and_merged_islands_count_once():
    """Coincident layers of opposite winding are one part (positions join whatever the normals, unlike
    ``coincident_pairs``); two grids that share a column of positions under other vertex IDs are one island."""
    body = uv_sphere(250)
    sheet_p, sheet_t = grid(10, 10, origin=(300, 0, 0))
    sheet = (np.vstack([sheet_p, sheet_p]), np.vstack([sheet_t, sheet_t[:, ::-1] + len(sheet_p)]))
    left = grid(2, 2, origin=(600, 0, 0))
    right = grid(2, 2, origin=(602, 0, 0))  # its first column is the last of ``left``
    positions, triangles = joined(body, sheet, left, right)
    drop, count = clustering.small_islands(positions, triangles, MINIMUM, SHARE)
    assert count == 2 and drop.sum() == 400 + 16
    expected, expected_count = reference_islands(positions, triangles)
    np.testing.assert_array_equal(drop, expected)
    assert count == expected_count


def test_islands_the_largest_part_counts_its_unwelded_seams():
    """The 1 % guard measures the largest part through positions too. Two 30,000-triangle grids that share a column of
    positions under other vertex IDs are one part of 60,000, so a 400-triangle speck (below 1 % of 60,000, not of
    30,000) is an island; so is a 720-triangle speck next to a 101,248-triangle sphere cut into 8 charts of at most
    12,768 triangles, and the sphere is sent whole without it."""
    left = grid(100, 150)
    right = grid(100, 150, origin=(100, 0, 0))  # its first column is the last of ``left``
    positions, triangles = joined(left, right, grid(10, 20, origin=(400, 0, 0)))
    drop, count = clustering.small_islands(positions, triangles, MINIMUM, SHARE)
    assert count == 1 and drop.sum() == 400 and drop[-400:].all()
    np.testing.assert_array_equal(drop, reference_islands(positions, triangles)[0])
    sphere = charts(*uv_sphere(226), 8)  # 101,248 triangles
    node = mesh_entity(*joined(sphere, uv_sphere(20, 0.002, (0.2, 0.0, 0.0))))  # and 720
    budget = Budget(total_triangles=500_000, node_triangles=200_000, target_bytes=1 << 20)
    result = fit_to_budget([node], budget, remove_islands=True)
    assert result.cleaned == ("vtkMRMLModelNode4",) and result.reduced == ()
    assert result.entities[0].triangle_count == 101_248


@pytest.mark.parametrize("bits", [1, 4, 24])
def test_islands_the_prefix_table_misses_no_shared_position(monkeypatch, bits):
    """Next to a body whose 1 % is at least the minimum, only the vertices whose key prefix is a small part's are
    compared by position (with 24 bits the specks' 5,760 and 3 of the body's 62,002); with a 1-bit table every vertex
    is, and the result is the same."""
    monkeypatch.setattr(clustering, "PREFIX_BITS", bits)
    compared = []
    original = clustering._same_position
    monkeypatch.setattr(
        clustering, "_same_position", lambda p, k, c: compared.append(len(c)) or original(p, k, c)
    )
    rng = np.random.default_rng(5)
    specks = [soup(*uv_sphere(6, 0.002, tuple(rng.random(3)))) for _ in range(40)]
    positions, triangles = joined(uv_sphere(250), *specks)  # 124,000 triangles and 40 soups of 48
    drop, count = clustering.small_islands(positions, triangles, MINIMUM, SHARE)
    expected, expected_count = reference_islands(positions, triangles)
    np.testing.assert_array_equal(drop, expected)
    assert count == expected_count == 40
    [compared_count] = compared
    if bits == 24:
        assert 5_760 <= compared_count < 6_000
    else:
        assert compared_count == len(positions)


def test_islands_key_order_is_a_stable_argsort():
    """The position join orders the keys by four 16-bit radix passes: the order of a stable argsort, equal keys in the
    candidates' order, so every vertex is still paired with the smallest vertex ID of its key."""
    rng = np.random.default_rng(3)
    key = rng.integers(0, 2**64, 60_000, dtype=np.uint64)
    key[::3] = key[rng.integers(0, 60_000, 20_000)]  # equal keys
    candidates = np.flatnonzero(rng.random(60_000) < 0.7)
    expected = candidates[np.argsort(key[candidates], kind="stable")]
    np.testing.assert_array_equal(clustering._key_order(key, candidates), expected)
    assert clustering._key_order(key, candidates[:0]).shape == (0,)


def test_islands_labelmap_specks_match_face_connectivity():
    """Slicer's Islands effect counts face-connected voxels (``FullyConnected`` off); flying edges separates voxels
    that touch only along an edge or at a corner, so the parts of the mesh are the same islands."""
    mask = np.zeros((34, 34, 60), dtype=bool)  # (z, y, x)
    mask[2:32, 2:32, 2:32] = True  # 27,000 voxels: the largest part
    mask[3, 3, 40] = mask[4, 4, 41] = True  # touching at a corner: two islands of 8 triangles
    mask[3, 3, 46] = mask[3, 4, 47] = True  # along an edge: two islands
    mask[3, 3, 52] = mask[3, 3, 53] = True  # through a face: one island of 16 triangles
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": flying_edges(mask, 0.075)})
    [entity] = collect_entities(scene)
    drop, count = clustering.small_islands(
        entity.positions, np.asarray(entity.indices, dtype=np.int64), MINIMUM, SHARE
    )
    assert count == 5 and drop.sum() == 4 * 8 + 16


# --------------------------------------------------------------------------- before the shares (decimate)


def body_and_specks(count: int = 50):
    """A 19,600-triangle sphere and ``count`` specks of 96 triangles, as one mesh (the body's vertices first)."""
    specks = [
        uv_sphere(8, 0.003, (0.1 + 0.02 * (i % 10), 0.02 * (i // 10), 0.0)) for i in range(count)
    ]
    return joined(uv_sphere(100), *specks)


def test_islands_off_by_default_and_on_before_the_shares(caplog):
    """Off, the specks count in the shares and both nodes are reduced; on, the shares follow the triangles left, so
    both fit whole: the node without its specks (compact, its body's vertices and normals as they were), the other
    node untouched. One log line, counts only (T7)."""
    positions, triangles = body_and_specks()
    node = mesh_entity(positions, triangles)
    other = dataclasses.replace(
        mesh_entity(*uv_sphere(60)), node_id="vtkMRMLModelNode5", mrml_id="vtkMRMLModelNode5"
    )
    assert (node.triangle_count, other.triangle_count) == (24_400, 6_960)
    budget = Budget(total_triangles=19_600 + 6_960, node_triangles=100_000, target_bytes=1 << 20)
    off = fit_to_budget([node, other], budget)
    assert off.cleaned == () and off.reduced == ("vtkMRMLModelNode4", "vtkMRMLModelNode5")
    with caplog.at_level(logging.INFO, logger="remoteview_core.decimate"):
        on = fit_to_budget([node, other], budget, remove_islands=True)
    assert on.cleaned == ("vtkMRMLModelNode4",) and on.reduced == () and on.unreduced == ()
    cleaned, kept = on.entities
    assert kept is other and cleaned.triangle_count == 19_600 and compact(cleaned)
    body = len(uv_sphere(100)[0])
    np.testing.assert_array_equal(cleaned.positions, positions[:body])
    np.testing.assert_array_equal(cleaned.normals, node.normals[:body])
    lines = [r.getMessage() for r in caplog.records if r.name == "remoteview_core.decimate"]
    assert lines == ["Islands: 50 small islands (4800 of 24400 triangles) are left out of a node"]


def test_islands_a_decimated_node_keeps_none_and_gets_no_copy(monkeypatch):
    """A node above its share is decimated without its islands, from an entity that shares its positions (no copy)."""
    positions, triangles = body_and_specks()
    node = mesh_entity(positions, triangles)
    seen = []
    original = decimate.decimate_steps  # what fit_entity runs (SLC-28)
    monkeypatch.setattr(
        decimate, "decimate_steps", lambda e, t, **k: seen.append(e) or original(e, t, **k)
    )
    tight = Budget(total_triangles=5_000, node_triangles=5_000, target_bytes=1 << 20)
    result = fit_to_budget([node], tight, remove_islands=True)
    [working] = seen
    assert working.positions is node.positions and working.triangle_count == 19_600
    [smaller] = result.entities
    assert result.reduced == ("vtkMRMLModelNode4",) and 0 < smaller.triangle_count <= 5_000
    middle = smaller.positions[smaller.indices].mean(axis=1)
    assert np.all(np.abs(np.linalg.norm(middle, axis=1) - 0.05) < 0.005)  # all on the body
    assert compact(smaller)


def test_islands_an_unreduced_node_is_sent_without_its_islands(monkeypatch):
    """A node nothing can reduce is sent whole (never dropped, §7.5), but without its islands."""
    positions, triangles = body_and_specks()
    node = mesh_entity(positions, triangles)

    def nothing_reduces(*args, **kwargs):
        return None
        yield  # a steps generator (remoteview_core.steps), what fit_entity runs

    monkeypatch.setattr(decimate, "decimate_steps", nothing_reduces)
    tight = Budget(total_triangles=5_000, node_triangles=5_000, target_bytes=1 << 20)
    result = fit_to_budget([node], tight, remove_islands=True)
    [whole] = result.entities
    assert result.unreduced == ("vtkMRMLModelNode4",) and result.reduced == ()
    assert whole.triangle_count == 19_600 and compact(whole)


def test_islands_never_drop_a_node():
    """A 2-triangle node and a node of 30 equal small spheres: the largest part (and any as large) is never an
    island, so both come back as they were."""
    tiny = mesh_entity(*grid(1, 1))
    parts = mesh_entity(*joined(*[uv_sphere(6, 0.001, (0.01 * i, 0, 0)) for i in range(30)]))
    budget = Budget(total_triangles=500_000, node_triangles=100_000, target_bytes=1 << 20)
    result = fit_to_budget([tiny, parts], budget, remove_islands=True)
    assert result.entities[0] is tiny and result.entities[1] is parts and result.cleaned == ()


def test_decimate_entity_leaves_the_callers_indices_alone(monkeypatch):
    """``decimate_entity`` reads the caller's indices without copying them (SLC-53: the working entity's are the only
    copy) and never writes to them."""
    node = mesh_entity(*body_and_specks(10))
    before = node.indices.copy()
    seen = []
    original = decimate._reduce_parts
    monkeypatch.setattr(
        decimate, "_reduce_parts", lambda p, t, *a: seen.append(t) or original(p, t, *a)
    )
    smaller = decimate.decimate_entity(node, 2_000)
    assert 0 < smaller.triangle_count <= 2_000
    [triangles] = seen
    assert np.shares_memory(triangles, node.indices)
    np.testing.assert_array_equal(node.indices, before)


def test_islands_bounded_time_on_a_node_of_dust():
    """A random labelmap (12 % of 160³ voxels) through flying edges: 3,768,532 triangles in 306,440 parts of 8-160
    triangles, so every vertex is compared by position. 0.16 s natively (with a stable argsort 0.40 s, and 3.1 s at
    16.4M triangles), bounded at 2 s for CI; no part is below 1 % of the largest, so none goes."""
    mask = np.random.default_rng(3).random((160, 160, 160)) < 0.12
    mask[0] = mask[-1] = mask[:, 0] = mask[:, -1] = mask[:, :, 0] = mask[:, :, -1] = False
    entity = mesh_entity(*mesh_points_and_triangles(flying_edges(mask, 0.075)))
    assert entity.triangle_count == 3_768_532
    start = time.perf_counter()
    drop = island_mask(entity)
    elapsed = time.perf_counter() - start
    assert drop is None and elapsed < 2.0


def test_islands_bounded_time_on_two_million_triangles():
    """About 2M triangles and 20,000 unwelded specks: 0.14 s natively, bounded at 2 s for CI."""
    body = uv_sphere(1_000)  # 1,996,000 triangles
    # specks of 16 triangles, each triangle with its own vertices
    speck_p, speck_t = soup(*uv_sphere(4, 0.0005))
    centres = np.random.default_rng(1).random((20_000, 3)) * 0.4 + 0.1
    positions = np.concatenate([body[0], (speck_p[None] + centres[:, None]).reshape(-1, 3)])
    offsets = len(body[0]) + len(speck_p) * np.arange(20_000)
    triangles = np.concatenate([body[1], (speck_t[None] + offsets[:, None, None]).reshape(-1, 3)])
    entity = mesh_entity(positions, triangles)
    start = time.perf_counter()
    drop = island_mask(entity)
    elapsed = time.perf_counter() - start
    assert drop is not None and drop.sum() == 20_000 * 16 and not drop[: len(body[1])].any()
    assert elapsed < 2.0
