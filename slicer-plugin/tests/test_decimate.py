"""SLC-14: decimation to the profile budgets (protocol §7.5, FR-10) and the GLB size estimate (NFR-03, NFR-23)."""

from __future__ import annotations

import dataclasses
import gc
import struct
import time

import numpy as np
import pytest
from pygltflib import GLTF2
from support import (
    FakeScene,
    book,
    live_client,
    needs_validator,
    reassemble,
    sphere,
    validate_glb,
)
from vtkmodules.util.numpy_support import numpy_to_vtk
from vtkmodules.vtkCommonDataModel import vtkImageData, vtkPolyData
from vtkmodules.vtkFiltersGeneral import vtkDiscreteFlyingEdges3D
from vtkmodules.vtkFiltersSources import vtkCubeSource, vtkPlaneSource

from remoteview_core import decimate, glb_writer, protocol_client
from remoteview_core import snapshot as snapshot_module
from remoteview_core.collect import (
    collect_entities,
    mesh_from_triangles,
    mesh_points_and_triangles,
    polydata_from_triangles,
)
from remoteview_core.decimate import (
    PROFILES,
    Budget,
    allocate,
    decimate_entity,
    estimate_glb_size,
    fit_to_budget,
    glb_binary_size,
)
from remoteview_core.glb_writer import Entity, RootExtras, size_report, write_glb
from remoteview_core.snapshot import SnapshotTooLargeError, build_snapshot

ROOT = RootExtras(scene_version=1, profile="quest2", slicer_version="5.12.4")
QUEST2 = PROFILES["quest2"]


def entities(*nodes: dict) -> list:
    return collect_entities(FakeScene(*nodes))


def cube(n: int = 0):
    source = vtkCubeSource()
    source.SetCenter(10.0 * n, 0.0, 0.0)
    source.Update()
    return source.GetOutput()


def fan(triangles: int):
    """A flat fan of ``triangles`` triangles around the origin (an odd count leaves uint16 indices unaligned)."""
    angles = np.linspace(0.0, np.pi, triangles + 1)
    rim = np.c_[np.cos(angles), np.sin(angles), np.zeros_like(angles)] * 10.0
    points = np.vstack([[0.0, 0.0, 0.0], rim])
    return polydata_from_triangles(points, np.array([[0, i + 1, i + 2] for i in range(triangles)]))


def grid_entity(nx: int, ny: int, *, matrix=None):
    """A flat ``nx × ny`` grid of points, two triangles per cell (65,535 vs 65,536 points switch the index width)."""
    xs, ys = np.meshgrid(np.arange(nx, dtype=np.float64), np.arange(ny, dtype=np.float64))
    points = np.c_[xs.ravel(), np.zeros(nx * ny), ys.ravel()] * 0.001
    cells = (np.arange(ny - 1)[:, None] * nx + np.arange(nx - 1)[None, :]).ravel()
    triangles = np.vstack(
        [np.c_[cells, cells + nx, cells + 1], np.c_[cells + 1, cells + nx, cells + nx + 1]]
    )
    return Entity(
        node_id="vtkMRMLModelNode9",
        kind="model",
        name="Grid",
        positions=points,
        normals=np.tile([0.0, 1.0, 0.0], (len(points), 1)),
        indices=triangles,
        color=(0.2, 0.4, 0.6),
        opacity=1.0,
        visible=True,
        mrml_id="vtkMRMLModelNode9",
        matrix=matrix,
    )


def outward_cosines(entity, centre=(0.1, 0.0, 0.0)) -> np.ndarray:
    """The cosine between each vertex normal and the direction from the sphere's centre (support.sphere: R+100 mm,
    glTF +X 0.1 m) — near 1 when the normals point out, in glTF space."""
    radial = entity.positions - np.asarray(centre)
    radial /= np.linalg.norm(radial, axis=1)[:, None]
    return np.einsum("ij,ij->i", entity.normals, radial)


def outward(entity, centre=(0.1, 0.0, 0.0)) -> float:
    """The smallest of :func:`outward_cosines`."""
    return float(outward_cosines(entity, centre).min())


def has_unit_normals(entity) -> bool:
    return bool(np.allclose(np.linalg.norm(entity.normals, axis=1), 1.0, atol=1e-6))


# --------------------------------------------------------------------------- the profile table (§7.5)


def test_decimate_profiles_are_those_of_the_protocol():
    assert set(PROFILES) == {"mobile", "quest2", "quest3"}
    assert [(b.total_triangles, b.node_triangles, b.target_bytes) for b in PROFILES.values()] == [
        (500_000, 100_000, 32 << 20),
        (500_000, 100_000, 32 << 20),
        (1_000_000, 100_000, 64 << 20),
    ]
    with pytest.raises(TypeError):
        PROFILES["mobile"] = Budget(1, 1, 1)  # read-only


# --------------------------------------------------------------------------- the shares


def test_decimate_allocate_keeps_what_fits_and_caps_every_node():
    assert allocate([400_000, 30_000, 1_000], QUEST2) == [100_000, 30_000, 1_000]
    assert allocate([], QUEST2) == []
    assert allocate([0, 5], QUEST2) == [0, 5]


def test_decimate_allocate_shares_in_proportion_with_a_floor():
    counts = [400_000, 300_000, 150_000, 120_000, 110_000, 100_000, 90_000, 3_000, 500]
    shares = allocate(counts, QUEST2)
    assert sum(shares) <= QUEST2.total_triangles
    assert sum(shares) >= QUEST2.total_triangles - len(counts)  # the budget is used, not wasted
    assert all(s <= min(c, QUEST2.node_triangles) for s, c in zip(shares, counts, strict=True))
    assert shares[-2:] == [2_000, 500]  # the floor, or all a small node has
    assert shares[0] == shares[1] == QUEST2.node_triangles  # the cap holds for the largest
    assert (
        shares[2] >= shares[3] >= shares[4] >= shares[5] >= shares[6]
    )  # in proportion to the input


def test_decimate_allocate_never_drops_a_node():
    """300 nodes of 5,000 triangles: their floors alone exceed 500k — each keeps its floor (§7.5: never dropped),
    and a node smaller than the floor keeps all it has."""
    shares = allocate([5_000] * 300 + [10], PROFILES["mobile"])
    assert shares == [2_000] * 300 + [10]


def test_decimate_allocate_seeded_fuzz():
    rng = np.random.default_rng(14)
    for _ in range(300):
        counts = [int(c) for c in rng.integers(0, 400_000, size=rng.integers(1, 40))]
        budget = PROFILES[rng.choice(list(PROFILES))]
        shares = allocate(counts, budget)
        floors = [min(c, budget.floor_triangles) for c in counts]
        assert all(
            f <= s <= min(c, budget.node_triangles)
            for f, s, c in zip(floors, shares, counts, strict=True)
        )
        assert sum(shares) <= max(budget.total_triangles, sum(floors))


# --------------------------------------------------------------------------- one node


def test_decimate_entity_reduces_to_the_target_with_unit_normals():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    smaller = decimate_entity(entity, 2_000)
    assert 0 < smaller.triangle_count <= 2_000 < entity.triangle_count
    assert (
        has_unit_normals(smaller)
        and smaller.node_id == entity.node_id
        and smaller.name == entity.name
    )
    # still the same sphere: radius 20 mm at R+100 mm (glTF +X 0.1 m)
    radius = np.linalg.norm(smaller.positions - [0.1, 0.0, 0.0], axis=1)
    np.testing.assert_allclose(radius, 0.020, atol=0.002)
    assert outward(smaller) > 0.9  # normals in glTF space and pointing out, not only of unit length
    # front faces outside, as before
    p, t = smaller.positions, smaller.indices
    face = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    assert np.all(np.einsum("ij,ij->i", face, p[t].mean(axis=1) - [0.1, 0.0, 0.0]) > 0)
    assert decimate_entity(entity, entity.triangle_count) is entity  # nothing to do


class Degenerate:
    """A filter that "succeeds" with no triangle, a non-finite point, a point beyond float32, too many triangles — or
    with two triangles folded onto each other (finite, but their normals cancel: usable, the zero normals become
    +Y as in collect)."""

    def __init__(self, kind: str, calls: list, target: int = 0) -> None:
        self.kind, self.calls, self.input, self.target = kind, calls, None, target

    def SetInputData(self, data):  # noqa: N802
        self.input = data

    def Update(self):  # noqa: N802
        self.calls.append(self.kind)

    def GetOutput(self):  # noqa: N802
        if self.kind == "unchanged":
            return self.input
        if self.kind == "empty":
            return vtkPolyData()
        if self.kind == "over":  # a valid fan of one triangle more than the share
            angles = np.linspace(0.0, np.pi, self.target + 2)
            rim = np.c_[np.cos(angles), np.sin(angles), np.zeros_like(angles)] * 0.01
            fan = [[0, i + 1, i + 2] for i in range(self.target + 1)]
            return polydata_from_triangles(np.vstack([[0.0, 0.0, 0.0], rim]), np.array(fan))
        points, triangles = DEGENERATE_OUTPUTS[self.kind]
        return polydata_from_triangles(np.array(points, dtype=np.float64), np.array(triangles))


#: Fixed filter outputs of :class:`Degenerate`: (points, triangles).
DEGENERATE_OUTPUTS = {
    "nan": ([[0, 0, 0], [1, 0, 0], [np.nan, 1, 0]], [[0, 1, 2]]),
    "huge": (
        [[0, 0, 0], [1e39, 0, 0], [0, 1e39, 0]],
        [[0, 1, 2]],
    ),  # finite in float64, beyond float32 (metres)
    "folded": ([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 1, 0]], [[0, 1, 2], [1, 0, 3]]),
    "flat": ([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 1, 2]]),  # every triangle without area
    # an unused point and a triangle without area next to a real one
    "loose": (
        [[0, 0, 0], [5, 5, 5], [0.01, 0, 0], [0, 0.01, 0], [0.02, 0, 0]],
        [[0, 2, 3], [0, 2, 4]],
    ),
}


@pytest.mark.parametrize("kind", ["empty", "nan", "huge", "flat", "unchanged"])
def test_decimate_falls_back_to_decimate_pro_when_the_quadric_result_is_unusable(kind):
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    calls: list = []
    filters = (lambda r: Degenerate(kind, calls), decimate._pro)
    smaller = decimate_entity(entity, 2_000, filters=filters)
    assert calls == [kind]  # the quadric ran once; DecimatePro made the result
    assert 0 < smaller.triangle_count <= 2_000 and has_unit_normals(smaller)
    radius = np.linalg.norm(
        smaller.positions - [0.1, 0.0, 0.0], axis=1
    )  # still the sphere, not the bad result
    np.testing.assert_allclose(radius, 0.020, atol=0.002)
    assert outward(smaller) > 0.9


def test_decimate_a_result_one_triangle_over_the_share_is_not_used():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    calls: list = []
    filters = (lambda r: Degenerate("over", calls, target=2_000), decimate._pro)
    smaller = decimate_entity(entity, 2_000, filters=filters)
    assert calls == ["over"] and 0 < smaller.triangle_count <= 2_000 and outward(smaller) > 0.9


def test_decimate_result_keeps_only_the_points_its_triangles_use():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    smaller = decimate_entity(entity, 10, filters=(lambda r: Degenerate("loose", []),))
    np.testing.assert_array_equal(
        smaller.indices, [[0, 1, 2]]
    )  # the flat triangle and the loose point are gone
    # the filters see the mesh centred on its bounding box (SLC-52); the centre is added back to their result
    centre = (entity.positions.min(axis=0) + entity.positions.max(axis=0)) / 2
    np.testing.assert_allclose(
        smaller.positions - centre, [[0, 0, 0], [0.01, 0, 0], [0, 0.01, 0]], atol=1e-15
    )
    np.testing.assert_allclose(smaller.normals, [[0.0, 0.0, 1.0]] * 3, atol=1e-6)


def test_decimate_keeps_everything_but_the_geometry():
    """T.matrix, baked, segment ID, colour, opacity, visibility, IDs and name survive decimation (§7.2, §7.3)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    moved = np.eye(4)
    moved[:3, 3] = (0.01, -0.02, 0.03)
    styled = dataclasses.replace(
        entity, matrix=moved, color=(0.1, 0.2, 0.3), opacity=0.4, visible=False, name="Liver"
    )
    for original in (styled, dataclasses.replace(styled, matrix=None, baked=True)):
        smaller = decimate_entity(original, 2_000)
        kept = {f.name for f in dataclasses.fields(Entity)} - {"positions", "normals", "indices"}
        for name in kept:
            assert np.array_equal(getattr(smaller, name), getattr(original, name)) or (
                getattr(smaller, name) == getattr(original, name)
            ), name
        document = GLTF2.load_from_bytes(write_glb([smaller], ROOT))
        t_node = document.nodes[document.nodes[0].children[0]]
        assert t_node.extras["baked"] is original.baked
        assert (t_node.matrix is None) is (original.matrix is None)


def test_decimate_repairs_normals_that_cancel_out_like_collect():
    """Decimated normals go to the writer as they are; a zero one becomes +Y (``coords.unit_normals``), so a result
    with a fold is used, not refused — refusing it would send the whole model above its share."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    smaller = decimate_entity(entity, 2_000, filters=(lambda r: Degenerate("folded", []),))
    assert smaller is not None and smaller.triangle_count == 2
    np.testing.assert_allclose(
        smaller.normals[:2], [[0.0, 1.0, 0.0]] * 2
    )  # the shared edge: cancelled → +Y
    assert has_unit_normals(smaller)


@pytest.mark.parametrize(
    "bad",
    [[0, 1, "n"], [-1, 0, 1], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    ids=["too-high", "negative", "repeated-ab", "repeated-bc", "repeated-ac"],
)
def test_decimate_refuses_broken_indices_before_vtk(bad):
    """IDs out of range, or a triangle that repeats a vertex (collect never makes them; a vtkDecimatePro crash on
    them was reported, not reproduced): no filter sees them."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    row = [len(entity.positions) if v == "n" else v for v in bad]
    broken = dataclasses.replace(entity, indices=np.vstack([entity.indices, [row]]))
    calls: list = []
    assert decimate_entity(broken, 10, filters=(lambda r: Degenerate("unchanged", calls),)) is None
    assert calls == []
    assert decimate_entity(entity, 10, filters=()) is None  # no filter at all: nothing usable


def test_decimate_filters_and_their_settings():
    pro = decimate._pro(0.5)
    assert pro.GetPreserveTopology() == 1 and pro.GetTargetReduction() == 0.5
    quadric = decimate._quadric(0.25)
    assert quadric.GetTargetReduction() == 0.25
    # the settings under which VTK guarantees the reduction (vtkDecimatePro.h)
    forced = decimate._pro_guaranteed(0.75)
    assert (
        forced.GetPreserveTopology(),
        forced.GetSplitting(),
        forced.GetBoundaryVertexDeletion(),
    ) == (0, 1, 1)
    assert forced.GetMaximumError() >= 1e299 and forced.GetTargetReduction() == 0.75
    assert (decimate._quadric, decimate._pro, decimate._pro_guaranteed) == decimate.FILTERS


def test_decimate_reaches_the_target_when_topology_cannot_be_kept():
    """Both first filters unusable: the last one, allowed to change the topology, still reaches the target."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    calls: list = []
    filters = (
        lambda r: Degenerate("empty", calls),
        lambda r: Degenerate("unchanged", calls),
        decimate._pro_guaranteed,
    )
    smaller = decimate_entity(entity, 300, filters=filters)
    assert (
        calls == ["empty", "unchanged"]
        and 0 < smaller.triangle_count <= 300
        and has_unit_normals(smaller)
    )
    assert outward(smaller) > 0.9


def test_decimate_a_node_no_filter_can_reduce_is_kept_whole_and_reported():
    nodes = entities(
        {"id": "vtkMRMLModelNode4", "mesh": sphere(64)},
        {"id": "vtkMRMLModelNode5", "mesh": cube()},
    )
    calls: list = []
    filters = (lambda r: Degenerate("empty", calls), lambda r: Degenerate("nan", calls))
    tight = Budget(
        total_triangles=3_000, node_triangles=2_000, target_bytes=1 << 20, floor_triangles=100
    )
    assert decimate_entity(nodes[0], 2_000, filters=filters) is None
    result = fit_to_budget(nodes, tight, filters=filters)
    assert result.entities == tuple(nodes) and result.reduced == ()
    assert result.unreduced == ("vtkMRMLModelNode4",)  # never dropped (§7.5)
    write_glb(list(result.entities), ROOT)


# --------------------------------------------------------------------------- the whole scene (criterion 1)


def test_decimate_quest2_scene_fits_500k_with_no_node_above_100k():
    """A 400k-triangle sphere and three other nodes under ``quest2`` (FR-10, §7.5)."""
    nodes = entities(
        {"id": "vtkMRMLModelNode4", "mesh": sphere(448)},  # 399,616 triangles
        {"id": "vtkMRMLModelNode5", "mesh": sphere(240)},  # 114,240
        {"id": "vtkMRMLModelNode6", "mesh": sphere(160)},  # 50,560
        {"id": "vtkMRMLModelNode7", "mesh": cube()},  # 12
    )
    counts = [e.triangle_count for e in nodes]
    assert counts == [399_616, 114_240, 50_560, 12]
    result = fit_to_budget(nodes, QUEST2)
    fitted = [e.triangle_count for e in result.entities]
    assert result.triangle_count <= 500_000 and max(fitted) <= 100_000
    assert result.reduced == ("vtkMRMLModelNode4", "vtkMRMLModelNode5") and result.unreduced == ()
    assert (
        result.entities[2] is nodes[2] and result.entities[3] is nodes[3]
    )  # within their shares: untouched
    assert all(has_unit_normals(e) and outward(e) > 0.9 for e in result.entities[:3])  # the spheres
    write_glb(list(result.entities), ROOT, quantize=True)


def test_decimate_fit_to_budget_holds_the_total():
    """Three nodes whose caps add up to more than the total: each gets a third, with real filters (FR-10)."""
    nodes = entities(*({"id": f"vtkMRMLModelNode{i}", "mesh": sphere(64)} for i in (4, 5, 6)))
    assert [e.triangle_count for e in nodes] == [7_936] * 3
    tight = Budget(
        total_triangles=6_000, node_triangles=5_000, target_bytes=1 << 20, floor_triangles=500
    )
    result = fit_to_budget(nodes, tight)
    counts = [e.triangle_count for e in result.entities]
    assert (
        result.triangle_count <= 6_000 and max(counts) - min(counts) <= 10
    )  # in proportion: equal inputs
    assert min(counts) >= 1_900 and result.reduced == tuple(e.node_id for e in nodes)


def test_decimate_profile_names_match_the_protocol():
    assert set(PROFILES) == set(protocol_client.PROFILES) == set(glb_writer.PROFILES)


# --------------------------------------------------------------------------- one node in bounded time (SLC-52)


def plane(resolution: int):
    """A flat 100 mm square of ``resolution``² quads (``vtkPlaneSource``): 2·resolution² triangles once collected."""
    source = vtkPlaneSource()
    source.SetOrigin(0.0, 0.0, 0.0)
    source.SetPoint1(100.0, 0.0, 0.0)
    source.SetPoint2(0.0, 100.0, 0.0)
    source.SetResolution(resolution, resolution)
    source.Update()
    return source.GetOutput()


def grid(nx: int, ny: int, spacing: float):
    """:func:`grid_entity`'s triangles in its order (all first triangles of the cells, then all second ones) as a
    polydata in millimetres, to be collected."""
    entity = grid_entity(nx, ny)
    return polydata_from_triangles(entity.positions * 1000.0 * spacing, entity.indices)


def labelmap_cylinder(radius: int = 110, height: int = 160):
    """The unsmoothed closed surface of a labelmap cylinder of 1 mm voxels whose flat caps lie on the volume's border
    (``vtkDiscreteFlyingEdges3D``, no smoothing or decimation): 434,800 triangles, most of them in exactly flat
    regions — the SLC-14 review's 427k segmentation surface."""
    side = np.arange(-radius - 1, radius + 2)
    y, x = np.meshgrid(side, side, indexing="ij")
    volume = np.zeros((height + 2, len(side), len(side)), dtype=np.uint8)
    volume[1:-1] = x * x + y * y <= radius * radius
    image = vtkImageData()
    image.SetDimensions(len(side), len(side), height + 2)
    image.GetPointData().SetScalars(numpy_to_vtk(volume.ravel(), deep=True))
    surface = vtkDiscreteFlyingEdges3D()
    surface.SetInputData(image)
    surface.SetValue(0, 1)
    surface.ComputeNormalsOff()
    surface.ComputeGradientsOff()
    surface.ComputeScalarsOff()
    surface.Update()
    return surface.GetOutput()


def boundary_edges(entity) -> int:
    """Edges used by one triangle only, with coincident points merged (a hole, or a seam a soup leaves)."""
    _, merged = np.unique(entity.positions, axis=0, return_inverse=True)
    triangles = merged.reshape(-1)[entity.indices]
    edges = np.sort(triangles[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int(np.count_nonzero(counts == 1))


def area(entity) -> float:
    p, t = entity.positions, entity.indices
    return float(
        np.linalg.norm(np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]]), axis=1).sum() / 2
    )


@pytest.mark.slow
@pytest.mark.parametrize(
    ("make", "target", "kept_area"),
    [
        # before: review 57 s; > 90 s with VTK 9.6.2 here
        (lambda: plane(300), 100_000, 1.0),
        # the same plane in grid_entity's order: > 90 s
        (lambda: grid(301, 301, 1 / 3), 100_000, 1.0),
        # 28,800 triangles: 4.5 s
        (lambda: grid(121, 121, 1.0), 2_000, 1.0),
        # review: 437 s and 3 GB; > 90 s here
        (labelmap_cylinder, 100_000, 1.0),
        # 18 s (the review's book: 73 s); collect 11 s before SLC-54
        (lambda: book(3_000, 1), 2_000, 0.3),
        # > 90 s; collect minutes before SLC-54
        (lambda: book(3_000, 4), 2_000, 0.05),
    ],
    ids=["plane-180k", "grid-180k", "grid-28.8k", "labelmap-cylinder-435k", "book", "book-4-rows"],
)
def test_decimate_bounded_one_node_within_its_share(make, target, kept_area):
    """The meshes that took minutes (flat regions tie the quadric's costs; an edge of 3,000 triangles costs its
    set-up m³) are collected and decimated within their share in well under 10 s (plan criterion 1)."""
    data = make()
    started = time.perf_counter()
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": data})
    smaller = decimate_entity(entity, target)
    elapsed = time.perf_counter() - started
    assert smaller is not None and 0 < smaller.triangle_count <= target
    assert elapsed < 10.0, elapsed
    # the plane keeps its area; a book cannot
    assert area(smaller) >= kept_area * area(entity) * 0.999
    assert has_unit_normals(smaller)


@pytest.mark.slow
def test_decimate_bounded_smooth_sphere_keeps_the_quadric_and_its_time():
    """A smooth 400k-triangle sphere still goes through the quadric, in at most 1.2× the time of SLC-14's first
    filter alone (plan criterion 2): the best of seven interleaved runs each, the estimate least moved by other load
    (measured 1.02–1.18 under load, ≈ 1.06 idle; single pairs 1.0–1.25)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(448)})
    used: list[str] = []

    def recorded(make):
        def filter_(reduction):
            used.append(make.__name__)
            return make(reduction)

        return filter_

    filters = tuple(recorded(make) for make in decimate.FILTERS)

    # SLC-14: the quadric on the collected mesh as it is, then the same normals step
    def before() -> int:
        quadric = decimate._quadric(1.0 - 100_000 / entity.triangle_count)
        quadric.SetInputData(polydata_from_triangles(entity.positions, entity.indices))
        quadric.Update()
        return len(mesh_from_triangles(*mesh_points_and_triangles(quadric.GetOutput())).triangles)

    def after() -> int:
        return decimate_entity(entity, 100_000, filters=filters).triangle_count

    times: dict[str, list[float]] = {"before": [], "after": []}
    collecting = gc.isenabled()
    gc.disable()  # as timeit does: a collection of the suite's heap inside one run is not the rule's cost
    try:
        for _ in range(7):
            for name, run in (("before", before), ("after", after)):
                gc.collect()
                started = time.perf_counter()
                assert 0 < run() <= 100_000
                times[name].append(time.perf_counter() - started)
    finally:
        if collecting:
            gc.enable()
    assert used == ["_quadric"] * 7
    assert min(times["after"]) <= 1.2 * min(times["before"]), times


def _repeated(entity, *, own_points: bool):
    """``entity`` with its first triangle written twice: on the same points, or on copies of them (an STL facet)."""
    triangles = np.asarray(entity.indices)
    corners = triangles[0]
    if not own_points:
        return dataclasses.replace(entity, indices=np.vstack([triangles, corners]))
    added = len(entity.positions) + np.arange(3)
    return dataclasses.replace(
        entity,
        positions=np.vstack([entity.positions, entity.positions[corners]]),
        normals=np.vstack([entity.normals, entity.normals[corners]]),
        indices=np.vstack([triangles, added]),
    )


@pytest.mark.parametrize(
    "repeat",
    [None, True, False],
    ids=["soup", "facet-twice-on-its-own-points", "facet-twice-on-the-same-points"],
)
def test_decimate_bounded_triangle_soup_comes_out_without_holes(repeat):
    """Every triangle with points of its own (an STL read without merging): the quadric decimated each triangle
    alone and left 300,000 boundary edges on the 400k sphere; merged, the soup is one surface again (criterion 3) —
    also with a facet written twice, whose merged edges are shared by three triangles (SLC-52 review: 0.38 of the
    area with 6,000 open edges)."""
    source = sphere(64)
    points, triangles = mesh_points_and_triangles(source)
    soup = polydata_from_triangles(
        points[triangles.ravel()], np.arange(triangles.size).reshape(-1, 3)
    )
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": soup})
    assert boundary_edges(entity) == 0 and len(entity.positions) == 3 * entity.triangle_count
    if repeat is not None:
        entity = _repeated(entity, own_points=repeat)
    smaller = decimate_entity(entity, 2_000)
    assert 0 < smaller.triangle_count <= 2_000 and boundary_edges(smaller) == 0
    # coincident triangles close each other's edges: the area tells a holed result apart
    assert area(smaller) >= 0.99 * area(entity)
    radius = np.linalg.norm(smaller.positions - [0.1, 0.0, 0.0], axis=1)
    np.testing.assert_allclose(radius, 0.020, atol=0.002)
    cosines = outward_cosines(smaller)
    # the facet written twice can tilt a normal or two next to it, by how much depends on the jitter's draws (down to
    # ≈ 0.71 over 600 seeds, below 0.9 for ≈ 8 % of them, never inward); all the others point out
    assert cosines.min() > (0.9 if repeat is None else 0.0)
    assert np.quantile(cosines, 0.01) > 0.9


def test_decimate_bounded_soup_of_a_two_sided_surface_keeps_one_sides_area():
    """The soup of a two-sided sphere is merged into the two-sided sphere and decimated like it (0.19 of the area
    unmerged: SLC-52 review)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    soup = _soup(_two_sheets(entity, reversed_=True, own_points=False))
    smaller = decimate_entity(soup, 2_000)
    assert 0 < smaller.triangle_count <= 2_000
    assert area(smaller) >= 0.45 * area(soup)


def test_decimate_bounded_soup_check():
    assert decimate._soup(np.arange(9).reshape(-1, 3))
    # a facet written twice, either way round, is still a soup
    assert decimate._soup(np.array([[0, 1, 2], [3, 4, 5], [2, 0, 1], [2, 1, 0]]))
    assert not decimate._soup(np.array([[0, 1, 2], [2, 1, 3]]))  # points 1 and 2 in two triangles
    assert not decimate._soup(np.array([[0, 1, 2], [0, 1, 2], [2, 3, 4]]))
    # the last two triangles share point 5
    assert not decimate._soup(np.array([[0, 1, 2], [3, 4, 5], [5, 6, 7]]))


class Recording:
    """A filter factory that records the input each filter is given, and then runs the real one."""

    def __init__(self, make, log: list) -> None:
        self.make, self.log = make, log

    def __call__(self, reduction):
        recording, real = self, self.make(reduction)

        class Filter:
            def SetInputData(self, data):  # noqa: N802
                points, triangles = mesh_points_and_triangles(data)
                recording.log.append((recording.make.__name__, points, triangles))
                real.SetInputData(data)

            def Update(self):  # noqa: N802
                real.Update()

            def GetOutput(self):  # noqa: N802
                return real.GetOutput()

        return Filter()


def _soup(entity):
    """``entity`` with every triangle on points of its own."""
    corners = np.asarray(entity.indices).ravel()
    return dataclasses.replace(
        entity,
        positions=entity.positions[corners],
        normals=entity.normals[corners],
        indices=np.arange(corners.size).reshape(-1, 3),
    )


def test_decimate_bounded_filters_get_the_merged_centred_jittered_mesh():
    """Every filter gets the same input: coincident points merged, centred on the bounding box and moved by up to 1e-7
    of its diagonal; the centre is added back to the result."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    soup = _soup(entity)
    log: list = []
    unusable = lambda r: Degenerate("empty", [])  # noqa: E731
    decimate_entity(soup, 2_000, filters=(Recording(unusable, log), Recording(decimate._pro, log)))
    assert [name for name, _, _ in log] == ["<lambda>", "_pro"]
    (_, first, triangles), (_, second, _) = log
    np.testing.assert_array_equal(first, second)  # one input for every filter
    assert len(first) == len(entity.positions)  # merged: the sphere's points again
    low, high = entity.positions.min(axis=0), entity.positions.max(axis=0)
    diagonal = np.linalg.norm(high - low)
    np.testing.assert_allclose(
        (first.min(axis=0) + first.max(axis=0)) / 2, 0.0, atol=2e-7 * diagonal
    )
    # merged points come in the order they are first used
    _, first_seen = np.unique(soup.positions, axis=0, return_index=True)
    moved = np.abs(first - (soup.positions[np.sort(first_seen)] - (low + high) / 2))
    # 24k uniform draws in [−1, 1]: the largest is within 1e-3 of the amplitude
    assert 0.99e-7 * diagonal <= moved.max() <= 1e-7 * diagonal * (1 + 1e-9)
    assert triangles.shape == (entity.triangle_count, 3)


def _keys(points) -> np.ndarray:
    return decimate._point_keys(np.asarray(points, dtype=np.float64))


def test_decimate_bounded_merges_only_when_points_coincide():
    """No two points coincide (the collected sphere): the filters get its points in their order, merely centred and
    jittered; one point repeated: the merge runs and the copy goes; a point 1e-12 of the diagonal away stays."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    assert not decimate._coincident(_keys(entity.positions))
    log: list = []
    decimate_entity(entity, 2_000, filters=(Recording(decimate._quadric, log),))
    [(_, points, triangles)] = log
    low, high = entity.positions.min(axis=0), entity.positions.max(axis=0)
    diagonal = np.linalg.norm(high - low)
    shift = np.abs(points - (entity.positions - (low + high) / 2))
    assert shift.max() <= 1e-7 * diagonal * (1 + 1e-9)
    np.testing.assert_array_equal(triangles, entity.indices)
    first = int(np.flatnonzero(np.any(entity.indices == 0, axis=1))[0])
    indices = np.array(entity.indices)
    # point 0 replaced in one triangle by its copy, or by a point next to it
    indices[first][indices[first] == 0] = len(entity.positions)
    for offset, merged in ((0.0, True), (1e-12 * diagonal, False)):
        log.clear()
        twin = entity.positions[:1] + np.array([offset, 0.0, 0.0])
        decimate_entity(
            dataclasses.replace(
                entity,
                positions=np.vstack([entity.positions, twin]),
                normals=np.vstack([entity.normals, entity.normals[:1]]),
                indices=indices,
            ),
            2_000,
            filters=(Recording(decimate._quadric, log),),
        )
        assert len(log[0][1]) == len(entity.positions) + (0 if merged else 1), offset


def test_decimate_bounded_coincidence_check():
    points = np.array([[0.0, 1.0, 2.0], [0.0, -1.0, -2.0], [-0.0, 1.0, -2.0], [1.0, 1.0, 2.0]])
    assert not decimate._coincident(_keys(points))  # mirror images do not collide
    assert decimate._coincident(_keys(np.vstack([points, [[0.0, -1.0, -2.0]]])))
    # -0.0 is 0.0, as in vtkMergePoints
    assert decimate._coincident(_keys([[0.0, 1.0, 2.0], [-0.0, 1.0, 2.0]]))
    rng = np.random.default_rng(52)
    assert not decimate._coincident(_keys(rng.normal(size=(200_000, 3))))


def _two_sheets(entity, *, reversed_: bool, own_points: bool):
    """``entity`` and a second copy of its surface lying on it: wound the other way (a two-sided surface) or the same
    way (a duplicated shell), on the same points or on points of its own."""
    triangles = np.asarray(entity.indices)
    second = triangles[:, ::-1] if reversed_ else triangles
    if own_points:
        second = second + len(entity.positions)
        positions = np.vstack([entity.positions, entity.positions])
        normals = np.vstack([entity.normals, entity.normals])
    else:
        positions, normals = entity.positions, entity.normals
    return dataclasses.replace(
        entity, positions=positions, normals=normals, indices=np.vstack([triangles, second])
    )


@pytest.mark.parametrize(
    ("make", "kept"),
    [
        (
            lambda e: _two_sheets(e, reversed_=True, own_points=False),
            0.45,
        ),  # one sheet's area: as before SLC-52
        (lambda e: _two_sheets(e, reversed_=True, own_points=True), 0.99),
        (lambda e: _two_sheets(e, reversed_=False, own_points=True), 0.99),
        # one edge of three triangles already: the merge would add thousands (0.50 before the per-edge guard)
        (
            lambda e: _repeated(_two_sheets(e, reversed_=True, own_points=True), own_points=False),
            0.99,
        ),
        (
            lambda e: _repeated(_two_sheets(e, reversed_=False, own_points=True), own_points=False),
            0.99,
        ),
    ],
    ids=[
        "two-sided",
        "two-sided-own-points",
        "duplicated-shell",
        "two-sided-own-points-and-a-facet-twice",
        "duplicated-shell-and-a-facet-twice",
    ],
)
def test_decimate_bounded_sheets_on_each_other_keep_their_area(make, kept):
    """A surface with a second sheet on it (SLC-52 review): every edge shared by four triangles, so the topology-kept
    filter stops short, and the split copy would be a soup the quadric empties (area 0.19 and 0.38 before the fix) —
    the chain runs on the mesh as it is when its set-up fits the budget, and sheets with points of their own are not
    merged into one."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    doubled = make(entity)
    smaller = decimate_entity(doubled, 2_000)
    assert 0 < smaller.triangle_count <= 2_000
    assert area(smaller) >= kept * area(doubled)


def test_decimate_bounded_soup_next_to_a_non_manifold_part_is_still_merged():
    """The guard keeps sheets apart only when merging would make shared edges the input did not have: a soup next to a
    three-page book (shared edges already) is merged and comes out without holes."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    mixed = _with_book(_soup(entity), 3)
    assert decimate._non_manifold(np.asarray(mixed.indices), len(mixed.positions))
    smaller = decimate_entity(mixed, 2_000)
    on_sphere = np.linalg.norm(smaller.positions - [0.1, 0.0, 0.0], axis=1) < 0.05
    sphere_part = dataclasses.replace(
        smaller, indices=smaller.indices[np.all(on_sphere[smaller.indices], axis=1)]
    )
    assert boundary_edges(sphere_part) == 0


def _with_book(entity, pages: int):
    """``entity`` and a book of ``pages`` pages on one edge (:func:`support.book`, in metres, 0.3 m along +X) in one
    node."""
    points, triangles = mesh_points_and_triangles(book(pages, 1))
    return dataclasses.replace(
        entity,
        positions=np.vstack([entity.positions, points * 0.001 + [0.3, 0.0, 0.0]]),
        normals=np.vstack([entity.normals, np.tile([0.0, 1.0, 0.0], (len(points), 1))]),
        indices=np.vstack([entity.indices, triangles + len(entity.positions)]),
    )


@pytest.mark.parametrize("reversed_", [False, True], ids=["duplicated-shell", "two-sided"])
def test_decimate_bounded_sheets_next_to_a_book_keep_their_area(reversed_):
    """A book's spine is an edge of 3,000 triangles already; merging sheets on their own points next to it would add
    thousands more (the guard counts them: the sphere kept 0.19 of its area with holes before)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    mixed = _with_book(_two_sheets(entity, reversed_=reversed_, own_points=True), 3_000)
    smaller = decimate_entity(mixed, 8_000)
    assert 0 < smaller.triangle_count <= 8_000
    on_sphere = np.linalg.norm(smaller.positions - [0.1, 0.0, 0.0], axis=1) < 0.05
    sphere_part = dataclasses.replace(
        smaller, indices=smaller.indices[np.all(on_sphere[smaller.indices], axis=1)]
    )
    assert area(sphere_part) >= 0.99 * area(entity)


@pytest.mark.parametrize("repeat", [False, True], ids=["labels", "labels-and-a-facet-twice"])
def test_decimate_bounded_touching_segments_keep_their_area(repeat):
    """The two halves of a ball as two labels in one flying-edges run (40³ voxels, radius 16): each label's surface
    has the disc between them on points of its own; merged, the two discs would be sheets on each other and lose area
    (0.85 with the guard off, and with a facet written twice under the whole-mesh guard of round 2; boxes lose none, so
    they cannot tell: SLC-52 review). The node keeps its area."""
    z, y, x = np.mgrid[0:40, 0:40, 0:40]
    ball = (x - 20) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 16**2
    volume = np.where(ball, np.where(x < 20, 1, 2), 0).astype(np.uint8)
    image = vtkImageData()
    image.SetDimensions(40, 40, 40)
    image.GetPointData().SetScalars(numpy_to_vtk(volume.ravel(), deep=True))
    surface = vtkDiscreteFlyingEdges3D()
    surface.SetInputData(image)
    surface.SetValue(0, 1)
    surface.SetValue(1, 2)
    surface.ComputeNormalsOff()
    surface.ComputeGradientsOff()
    surface.ComputeScalarsOff()
    surface.Update()
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": surface.GetOutput()})
    if repeat:
        entity = _repeated(entity, own_points=False)
    smaller = decimate_entity(entity, entity.triangle_count // 5)
    assert 0 < smaller.triangle_count <= entity.triangle_count // 5
    assert area(smaller) >= 0.99 * area(entity)


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_decimate_bounded_refuses_positions_that_are_not_finite(bad):
    """Collect keeps them out (``_finite_geometry``); here they give ``None`` rather than an exception."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    for positions in (
        np.vstack([entity.positions, [[bad, 0.0, 0.0]]]),  # unused
        np.where(np.arange(len(entity.positions))[:, None] == 3, bad, entity.positions),  # used
    ):
        broken = dataclasses.replace(
            entity,
            positions=positions,
            normals=np.vstack([entity.normals, entity.normals])[: len(positions)],
        )
        assert decimate_entity(broken, 10) is None


def test_decimate_bounded_refuses_positions_whose_extent_overflows():
    """Finite positions whose bounding box does not fit float64 (±1e308): ``None``, not an exception."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    positions = np.array(entity.positions)
    positions[0], positions[1] = [1e308, 0.0, 0.0], [-1e308, 0.0, 0.0]
    assert decimate_entity(dataclasses.replace(entity, positions=positions), 10) is None


def _first_use_order(entity):
    """``entity`` with its points renumbered in the order its triangles first use them, the order the merge leaves."""
    corners = np.asarray(entity.indices).ravel()
    _, first = np.unique(corners, return_index=True)
    order = corners[np.sort(first)]
    renumbered = np.empty(len(entity.positions), dtype=np.int64)
    renumbered[order] = np.arange(len(order))
    return dataclasses.replace(
        entity,
        positions=entity.positions[order],
        normals=entity.normals[order],
        indices=renumbered[entity.indices],
    )


def test_decimate_bounded_jitter_is_seeded_from_the_mesh():
    """The same mesh moves the same way (deterministic). The same mesh moved elsewhere, or with two coincident unused
    points added, moves differently: the seed is a digest of every point, so a crafted mesh cannot steer it to cancel
    its jitter in advance (an XOR of the keys could be: SLC-52 review)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    entity = _first_use_order(entity)  # so that the merge of the added pair keeps the points' order
    count = len(entity.positions)
    moved = dataclasses.replace(entity, positions=entity.positions + np.array([0.5, 0.0, 0.0]))
    pair = dataclasses.replace(
        entity,
        positions=np.vstack([entity.positions, [[0.3, 0.2, 0.1], [0.3, 0.2, 0.1]]]),
        normals=np.vstack([entity.normals, entity.normals[:2]]),
    )
    offsets = []
    for mesh in (entity, entity, moved, pair):
        log: list = []
        decimate_entity(mesh, 2_000, filters=(Recording(decimate._quadric, log),))
        used = mesh.positions[:count]
        low, high = used.min(axis=0), used.max(axis=0)
        assert len(log[0][1]) == count  # the pair merged and dropped
        offsets.append(log[0][1] - (used - (low + high) / 2))
    diagonal = np.linalg.norm(entity.positions.max(axis=0) - entity.positions.min(axis=0))
    np.testing.assert_array_equal(offsets[0], offsets[1])
    for other in offsets[2:]:
        assert np.abs(other).max() <= 1e-7 * diagonal * (1 + 1e-9)
        assert not np.allclose(offsets[0], other, rtol=0, atol=1e-12)


def test_decimate_bounded_unused_points_neither_centre_nor_scale_the_jitter():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    far = dataclasses.replace(
        entity,
        positions=np.vstack([entity.positions, [[1_000.0, 0.0, 0.0]]]),  # a kilometre away, unused
        normals=np.vstack([entity.normals, entity.normals[:1]]),
    )
    log: list = []
    decimate_entity(far, 2_000, filters=(Recording(decimate._quadric, log),))
    [(_, points, _)] = log
    low, high = entity.positions.min(axis=0), entity.positions.max(axis=0)
    moved = np.abs(points[:-1] - (entity.positions - (low + high) / 2))
    assert moved.max() <= 1e-7 * np.linalg.norm(high - low) * (1 + 1e-9)


def test_decimate_bounded_is_deterministic():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": plane(60)})
    first, second = decimate_entity(entity, 500), decimate_entity(entity, 500)
    for field in ("positions", "normals", "indices"):
        np.testing.assert_array_equal(getattr(first, field), getattr(second, field))
    # flat stays flat: the jitter moved no point off the plane by more than 1e-7 of the diagonal
    span = np.linalg.norm(entity.positions.max(axis=0) - entity.positions.min(axis=0))
    assert np.ptp(first.positions[:, 1]) <= 2e-7 * span


@pytest.mark.parametrize(
    ("pages", "rows", "used"),
    [(3_000, 1, ["first"]), (3_000, 4, ["first", "_quadric"])],
    ids=["book", "book-4-rows"],
)
def test_decimate_bounded_non_manifold_mesh_tries_topology_kept_first(
    monkeypatch, pages, rows, used
):
    """An edge of more than two triangles: ``vtkDecimatePro(PreserveTopologyOn)`` first — enough for one row of pages;
    with four rows it stops at 12,000 triangles, over the share of 2,000, and the chain runs on a copy with the shared
    edges' ends cut, where no such edge is left."""
    log: list = []
    monkeypatch.setattr(decimate, "NON_MANIFOLD_FIRST", Recording(decimate._pro, log))
    chain = tuple(Recording(make, log) for make in decimate.FILTERS)
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": book(pages, rows)})
    smaller = decimate_entity(entity, 2_000, filters=chain)
    assert 0 < smaller.triangle_count <= 2_000
    assert ["first" if i == 0 else name for i, (name, _, _) in enumerate(log)] == used
    if len(log) > 1:
        _, points, triangles = log[1]
        assert len(triangles) == entity.triangle_count and len(points) > len(log[0][1])
        assert not decimate._non_manifold(triangles, len(points))


def test_decimate_bounded_whole_mesh_chain_skips_the_filter_that_just_ran(monkeypatch):
    """A two-sided sphere: topology-kept pro stops short, the quadric (here unusable) runs on the mesh as it is, the
    same pro is not run again on the same input (deterministic: a wasted run, SLC-52 review), the guaranteed one
    is."""
    log: list = []
    first = Recording(decimate._pro, log)
    monkeypatch.setattr(decimate, "NON_MANIFOLD_FIRST", first)
    unusable = lambda r: Degenerate("empty", [])  # noqa: E731
    chain = (Recording(unusable, log), first, Recording(decimate._pro_guaranteed, log))
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    two_sided = _two_sheets(entity, reversed_=True, own_points=False)
    smaller = decimate_entity(two_sided, 2_000, filters=chain)
    assert 0 < smaller.triangle_count <= 2_000
    names = [name for name, _, _ in log]
    assert names[:3] == ["_pro", "<lambda>", "_pro_guaranteed"]
    assert all(len(points) == len(entity.positions) for _, points, _ in log[:3])


def test_decimate_bounded_shared_edge_ends_and_the_check():
    # edge 0–1 in three triangles, run both ways; triangle 3 touches its end 0 elsewhere
    triangles = np.array([[0, 1, 2], [1, 0, 3], [0, 1, 4], [0, 5, 6], [2, 5, 7]])
    assert decimate._non_manifold(triangles, 8)
    np.testing.assert_array_equal(np.flatnonzero(decimate._shared_edge_ends(triangles, 8)), [0, 1])
    # the edge run the same way by all three, as each triangle's second edge, then as its third
    for same_way in ([[2, 0, 1], [3, 0, 1], [4, 0, 1]], [[1, 2, 0], [1, 3, 0], [1, 4, 0]]):
        np.testing.assert_array_equal(
            np.flatnonzero(decimate._shared_edge_ends(np.array(same_way), 5)), [0, 1]
        )
    closed = mesh_points_and_triangles(sphere(16))[1]
    assert not decimate._non_manifold(closed, closed.max() + 1)
    assert not decimate._shared_edge_ends(closed, closed.max() + 1).any()
    assert not decimate._non_manifold(np.array([[0, 1, 2], [2, 1, 0]]), 3)  # two, either way round
    repeated = np.array([[0, 1, 2], [2, 1, 0], [0, 1, 2]])
    assert decimate._non_manifold(repeated, 3)
    assert decimate._non_manifold(np.array([[3, 0, 1], [3, 1, 2], [2, 1, 4], [5, 1, 2]]), 6)
    keys = decimate._edge_keys(np.array([[2, 0, 1]]), 3)
    # edges (2, 0), (0, 1), (1, 2), each keyed by its smaller end first
    np.testing.assert_array_equal(keys, [0 * 3 + 2, 0 * 3 + 1, 1 * 3 + 2])


def test_decimate_bounded_rule_constants():
    assert decimate.JITTER == 1e-7 and decimate.NON_MANIFOLD_FIRST is decimate._pro


# --------------------------------------------------------------------------- size estimate (criterion 3)


def _fixtures() -> dict[str, list]:
    return {
        "one sphere": entities({"id": "vtkMRMLModelNode4", "mesh": sphere(160)}),
        "mixed names": entities(
            {"id": "vtkMRMLModelNode4", "name": 'Wątroba — guz "A"', "mesh": sphere(64)},
            {"id": "vtkMRMLModelNode3", "mesh": fan(3)},  # an odd triangle count: padded indices
            {
                "id": "vtkMRMLModelNode5",
                "name": "x" * 64,
                "mesh": sphere(300),
            },  # > 65,535 vertices: uint32
            {"id": "vtkMRMLModelNode6", "mesh": cube()},
        ),
        "many small": entities(
            *({"id": f"vtkMRMLModelNode{i}", "mesh": cube(i)} for i in range(1, 41))
        ),
    }


@pytest.mark.parametrize("quantize", [True, False])
@pytest.mark.parametrize("fixture", ["one sphere", "mixed names", "many small"])
def test_decimate_estimate_is_within_ten_percent(fixture, quantize):
    nodes = _fixtures()[fixture]
    real = write_glb(nodes, ROOT, quantize=quantize)
    estimate = estimate_glb_size(nodes, quantize=quantize)
    assert abs(estimate - len(real)) <= 0.1 * len(real), (estimate, len(real))
    report = size_report(real)
    assert (
        glb_binary_size(nodes, quantize=quantize)
        == struct.unpack_from("<I", real, 20 + report.json)[
            0
        ]  # the BIN chunk's length, padding included
    )


@pytest.mark.parametrize("moved", [False, True], ids=["identity", "with-matrix"])
@pytest.mark.parametrize("quantize", [True, False])
def test_decimate_estimate_of_one_small_node_is_close(quantize, moved):
    """With one cube the JSON is most of the file: the estimate stays within 2.5 %, with a T.matrix too."""
    nodes = entities({"id": "vtkMRMLModelNode4", "mesh": cube()})
    if moved:
        matrix = np.eye(4)
        matrix[:3, 3] = (0.0123456789, -0.2, 0.3)
        nodes = [dataclasses.replace(nodes[0], matrix=matrix)]
    real = len(write_glb(nodes, ROOT, quantize=quantize))
    assert abs(estimate_glb_size(nodes, quantize=quantize) - real) <= 0.025 * real


@pytest.mark.parametrize("quantize", [True, False])
@pytest.mark.parametrize(
    ("nx", "ny"), [(255, 257), (256, 256)], ids=["65535-points", "65536-points"]
)
def test_decimate_binary_size_is_exact_at_the_index_width_switch(nx, ny, quantize):
    moved = np.eye(4)
    moved[:3, 3] = (0.01, 0.02, 0.03)
    nodes = [grid_entity(nx, ny, matrix=moved)]
    real = write_glb(nodes, ROOT, quantize=quantize)
    json_length = struct.unpack_from("<I", real, 12)[0]
    assert (
        glb_binary_size(nodes, quantize=quantize)
        == struct.unpack_from("<I", real, 20 + json_length)[0]
    )
    assert abs(estimate_glb_size(nodes, quantize=quantize) - len(real)) <= 0.1 * len(real)


def test_decimate_a_scene_that_fits_only_after_decimation_is_sent():
    """The size check before writing measures the decimated, quantised scene: 114,240 triangles are over a 1.3 MB
    relay limit, their 100,000-triangle share is not (FR-10, criterion 3)."""
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(240)})
    [whole] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(240)})
    assert glb_binary_size([whole]) > 1_300_000
    snapshot = build_snapshot(
        scene, live_client("quest3", maxSnapshotBytes=1_300_000), slicer_version="5.12.4"
    )
    assert snapshot.byte_length <= 1_300_000 and snapshot.reduced == ("vtkMRMLModelNode4",)


def test_decimate_float_size_decides_the_refusal_when_not_quantised(monkeypatch):
    """With ``quantize=False`` the check before writing uses float sizes: between the quantised and the float size
    of the fitted scene, the snapshot is refused and never written."""
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    limit = (glb_binary_size([entity]) + glb_binary_size([entity], quantize=False)) // 2

    def no_write(*args, **kwargs):
        raise AssertionError("written")

    monkeypatch.setattr(snapshot_module, "write_glb", no_write)
    with pytest.raises(SnapshotTooLargeError):
        build_snapshot(
            scene,
            live_client("quest3", maxSnapshotBytes=limit),
            slicer_version="5.12.4",
            quantize=False,
        )


def test_decimate_a_scene_the_estimate_overstates_is_still_sent():
    """Plan correction (criterion 3): the refusal before writing uses the exact binary size, not the estimate — 40
    tiny nodes are estimated ≈ 4 % high, and a relay limit between the two lets the real file through."""
    nodes = _fixtures()["many small"]
    real = len(write_glb(nodes, ROOT, quantize=True))
    estimate = estimate_glb_size(nodes, quantize=True)
    assert estimate > real
    scene = FakeScene(*({"id": f"vtkMRMLModelNode{i}", "mesh": cube(i)} for i in range(1, 41)))
    limit = (real + estimate) // 2
    client = live_client("mobile", maxSnapshotBytes=limit)
    assert build_snapshot(scene, client, slicer_version="5.12.4").byte_length <= limit


def test_decimate_estimate_of_an_empty_scene():
    real = write_glb([], ROOT, quantize=True)
    assert glb_binary_size([], quantize=True) == 4  # one zero word (§7.1: exactly one buffer)
    assert abs(estimate_glb_size([]) - len(real)) <= 0.1 * len(real)


@needs_validator
def test_decimate_output_passes_the_khronos_validator(tmp_path):
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(96)})
    glb = write_glb([decimate_entity(entity, 2_000)], ROOT, quantize=True)
    report = validate_glb(tmp_path, {"decimated.glb": glb})["decimated.glb"]
    assert report["numErrors"] == 0 and report["numWarnings"] == 0 and report["violations"] == []


# --------------------------------------------------------------------------- the snapshot


def _sent(snapshot) -> tuple[dict, list[int]]:
    """The begin message and the per-node triangle counts inside the GLB that went out (T extras and index accessors
    agree)."""
    begin, glb, _ = reassemble(list(snapshot.frames()))
    document = GLTF2.load_from_bytes(glb)
    t_nodes = [document.nodes[i] for i in document.nodes[0].children]
    counts = [t.extras["triangleCount"] for t in t_nodes]
    in_accessors = [document.accessors[m.primitives[0].indices].count // 3 for m in document.meshes]
    assert counts == in_accessors
    return begin, counts


def test_decimate_the_glb_sent_holds_the_decimated_meshes():
    scene = FakeScene(
        {
            "id": "vtkMRMLModelNode4",
            "mesh": sphere(240),
        },  # 114,240 triangles: above every per-node cap
        {"id": "vtkMRMLModelNode5", "mesh": sphere(16)},
    )
    snapshot = build_snapshot(scene, live_client("quest3"), slicer_version="5.12.4")
    begin, counts = _sent(snapshot)
    assert sum(counts) == begin["triangleCount"] == snapshot.triangle_count
    assert max(counts) <= 100_000 and counts[1] == 16 * 14 * 2


def test_decimate_snapshot_uses_the_sessions_profile(monkeypatch):
    budgets = {  # different totals, and a recommended size that only the mobile snapshot exceeds
        "mobile": Budget(
            total_triangles=1_000, node_triangles=5_000, target_bytes=100, floor_triangles=100
        ),
        "quest3": Budget(
            total_triangles=2_000, node_triangles=5_000, target_bytes=1 << 30, floor_triangles=100
        ),
    }
    monkeypatch.setattr(snapshot_module, "PROFILES", {**PROFILES, **budgets})
    totals = {}
    for profile, budget in budgets.items():
        scene = FakeScene(
            {"id": "vtkMRMLModelNode4", "mesh": sphere(32)},
            {"id": "vtkMRMLModelNode5", "mesh": sphere(32)},
        )
        snapshot = build_snapshot(scene, live_client(profile), slicer_version="5.12.4")
        begin, counts = _sent(snapshot)
        assert sum(counts) == begin["triangleCount"] <= budget.total_triangles
        assert snapshot.target_bytes == budget.target_bytes
        assert snapshot.over_target is (profile == "mobile")  # the session's own target
        totals[profile] = sum(counts)
    assert totals["mobile"] < totals["quest3"]


def test_decimate_snapshot_follows_the_session_profile(monkeypatch):
    scene = FakeScene(
        {
            "id": "vtkMRMLModelNode4",
            "mesh": sphere(240),
        },  # 114,240 triangles: above every per-node cap
        {"id": "vtkMRMLModelNode5", "mesh": sphere(16)},
    )
    snapshot = build_snapshot(scene, live_client("quest3"), slicer_version="5.12.4")
    assert snapshot.reduced == ("vtkMRMLModelNode4",) and snapshot.unreduced == ()
    assert snapshot.triangle_count <= 100_000 + 16 * 14 * 2 and not snapshot.over_target
    # a profile whose recommended size the scene exceeds: sent, with the warning flag (NFR-03)
    small = Budget(
        total_triangles=500_000, node_triangles=100_000, target_bytes=snapshot.byte_length - 1
    )
    monkeypatch.setattr(snapshot_module, "PROFILES", {**PROFILES, "mobile": small})
    warned = build_snapshot(scene, live_client("mobile"), slicer_version="5.12.4")
    assert warned.over_target and warned.byte_length == snapshot.byte_length
    assert warned.target_bytes == small.target_bytes
    # exactly at the recommended size: no warning
    at_target = dataclasses.replace(small, target_bytes=snapshot.byte_length)
    monkeypatch.setattr(snapshot_module, "PROFILES", {**PROFILES, "mobile": at_target})
    assert not build_snapshot(scene, live_client("mobile"), slicer_version="5.12.4").over_target
