"""SLC-14: decimation to the profile budgets (protocol §7.5, FR-10) and the GLB size estimate (NFR-03, NFR-23);
SLC-41: bounded time and a crack-free result on very large, flat and non-manifold meshes."""

from __future__ import annotations

import dataclasses
import logging
import struct
import time

import numpy as np
import pytest
from pygltflib import GLTF2
from support import (
    FakeScene,
    face_normals,
    flying_edges,
    live_client,
    mesh_entity,
    needs_validator,
    normal_opposes_face,
    reassemble,
    sphere,
    validate_glb,
)
from vtkmodules.vtkCommonCore import reference
from vtkmodules.vtkCommonDataModel import vtkPolyData, vtkStaticCellLocator
from vtkmodules.vtkFiltersCore import vtkQuadricDecimation
from vtkmodules.vtkFiltersSources import vtkCubeSource, vtkPlaneSource, vtkSphereSource

from remoteview_core import clustering, decimate, glb_writer, protocol_client
from remoteview_core import snapshot as snapshot_module
from remoteview_core.collect import (
    collect_entities,
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
from remoteview_core.steps import run

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


def outward(entity, centre=(0.1, 0.0, 0.0)) -> float:
    """The smallest cosine between a vertex normal and the direction from the sphere's centre (support.sphere: R+100
    mm, glTF +X 0.1 m) — near 1 when the normals point out, in glTF space."""
    radial = entity.positions - np.asarray(centre)
    radial /= np.linalg.norm(radial, axis=1)[:, None]
    return float(np.einsum("ij,ij->i", entity.normals, radial).min())


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
    """A quadric that "succeeds" with no triangle, a non-finite point, a point beyond float32, too many triangles — or
    with two triangles folded onto each other (finite, but their normals cancel: usable, the zero normals become
    +Y as in collect)."""

    def __init__(self, kind: str, calls: list, target: int = 0) -> None:
        self.kind, self.calls, self.input, self.target = kind, calls, None, target

    def AddObserver(self, *args):  # noqa: N802 — the deadline observer; never fires here
        pass

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


#: Fixed quadric outputs of :class:`Degenerate`: (points, triangles), in the quadric's scaled frame.
DEGENERATE_OUTPUTS = {
    "nan": ([[0, 0, 0], [1, 0, 0], [np.nan, 1, 0]], [[0, 1, 2]]),
    "huge": (
        [[0, 0, 0], [1e45, 0, 0], [0, 1e45, 0]],
        [[0, 1, 2]],
    ),  # finite in float64, beyond float32 (metres, after the quadric's scale is undone)
    "folded": ([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 1, 0]], [[0, 1, 2], [1, 0, 3]]),
    "flat": ([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 1, 2]]),  # every triangle without area
    # an unused point and a triangle without area next to a real one
    "loose": (
        [[0, 0, 0], [5, 5, 5], [0.01, 0, 0], [0, 0.01, 0], [0.02, 0, 0]],
        [[0, 2, 3], [0, 2, 4]],
    ),
}


def unscaled(entity, points) -> np.ndarray:
    """``points`` of the quadric's frame (centred, median edge 100) back in the entity's metres."""
    _, _, centre, scale = decimate._prepared(
        np.asarray(entity.positions, dtype=np.float64), np.asarray(entity.indices)
    )
    return np.asarray(points, dtype=np.float64) / scale + centre


def every_face_outward(entity, centre=(0.1, 0.0, 0.0)) -> bool:
    face = face_normals(entity.positions, entity.indices)
    out = entity.positions[entity.indices].mean(axis=1) - np.asarray(centre)
    return bool(np.all(np.einsum("ij,ij->i", face, out) > 0))


def fallback_warnings(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "remoteview_core.decimate" and r.levelno == logging.WARNING
    ]


@pytest.mark.parametrize("kind", ["empty", "nan", "huge", "flat", "unchanged"])
def test_decimate_falls_back_to_clustering_when_the_quadric_result_is_unusable(
    kind, monkeypatch, caplog
):
    """No usable quadric result: connected clustering with a growing cell still reaches the share, crack-free and
    outward (SLC-41; ``vtkDecimatePro`` is gone), with a warning in the log (counts only)."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    calls: list = []
    fallbacks: list = []
    original = decimate._fallback_steps
    monkeypatch.setattr(
        decimate, "_fallback_steps", lambda *a: fallbacks.append(len(a[1])) or original(*a)
    )
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        smaller = decimate_entity(entity, 2_000, quadric=lambda r: Degenerate(kind, calls))
    assert (
        calls == [kind] and len(fallbacks) == 1
    )  # the quadric ran once; the clustering made the result
    assert fallback_warnings(caplog) == [
        f"Decimation: the quadric gave no usable result on a node of {entity.triangle_count} triangles; "
        f"vertex clustering reduced it to {smaller.triangle_count} instead (coarser)"
    ]
    assert 0 < smaller.triangle_count <= 2_000 and has_unit_normals(smaller)
    radius = np.linalg.norm(
        smaller.positions - [0.1, 0.0, 0.0], axis=1
    )  # still the sphere, not the bad result
    np.testing.assert_allclose(radius, 0.020, atol=0.002)
    assert outward(smaller) > 0.9 and every_face_outward(smaller)


def test_decimate_a_result_one_triangle_over_the_share_is_not_used():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
    calls: list = []
    smaller = decimate_entity(
        entity, 2_000, quadric=lambda r: Degenerate("over", calls, target=2_000)
    )
    assert calls == ["over"] and 0 < smaller.triangle_count <= 2_000 and outward(smaller) > 0.9


def test_decimate_quadric_deadline_falls_back(monkeypatch, caplog):
    """An aborted quadric (the deadline already passed) gives no triangle: the clustering fallback makes the
    result, quickly, and the log says why (the §14 console check then shows which path ran)."""
    monkeypatch.setattr(decimate, "QUADRIC_SECONDS", 0.0)
    fallbacks: list = []
    original = decimate._fallback_steps
    monkeypatch.setattr(
        decimate, "_fallback_steps", lambda *a: fallbacks.append(len(a[1])) or original(*a)
    )
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(200)})
    start = time.perf_counter()
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        smaller = decimate_entity(entity, 2_000)
    assert time.perf_counter() - start < 2.0
    assert fallbacks == [entity.triangle_count] and 0 < smaller.triangle_count <= 2_000
    assert outward(smaller) > 0.9
    assert fallback_warnings(caplog) == [
        f"Decimation: the quadric did not finish within 0 s on a node of {entity.triangle_count} triangles; "
        f"vertex clustering reduced it to {smaller.triangle_count} instead (coarser)"
    ]


def test_decimate_deadline_starts_at_the_quadric_step(monkeypatch, caplog):
    """The clustering before the quadric (numpy, linear) does not use the quadric's time: a slow size bound (the
    clock jumps 1,000 s) still leaves the quadric its ``QUADRIC_SECONDS``, so the result does not depend on how fast
    the bound ran. Counted from the entry, the reporter's node had 1.5 s of margin in Slicer under Rosetta."""
    clock = Clock()
    monkeypatch.setattr(decimate, "time", clock)
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    bounded = decimate._bounded_steps

    def slow_bound(*args):
        clock.now += 1_000.0
        return bounded(*args)

    monkeypatch.setattr(decimate, "_bounded_steps", slow_bound)
    monkeypatch.setattr(decimate, "_fallback_steps", no_fallback)
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(200)})
    assert entity.triangle_count > 2 * decimate.CLUSTER_GOAL  # the size bound runs
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        smaller = decimate_entity(entity, 2_000)
    assert clock.now == 1_000.0 and fallback_warnings(caplog) == []
    assert 0 < smaller.triangle_count <= 2_000 and outward(smaller) > 0.9


def no_fallback(*args):
    raise AssertionError("the fallback ran")


def test_decimate_steps_the_event_loop_between_them_never_counts(monkeypatch, caplog):
    """SLC-28: driven a step at a time with the clock jumping 1,000 s between steps (the event loop's time), the
    quadric still has its run — its runs are one step, and its deadline counts only their own time."""
    clock = Clock()
    monkeypatch.setattr(decimate, "time", clock)
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    monkeypatch.setattr(decimate, "_fallback_steps", no_fallback)
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(200)})
    steps = decimate.decimate_steps(entity, 2_000)
    taken = 0
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        while True:
            try:
                next(steps)
            except StopIteration as stop:
                smaller = stop.value
                break
            taken += 1
            clock.now += 1_000.0
    assert taken > 5 and clock.now == 1_000.0 * taken and fallback_warnings(caplog) == []
    assert 0 < smaller.triangle_count <= 2_000 and outward(smaller) > 0.9


def test_decimate_deadline_does_not_count_the_fan_clustering(monkeypatch, caplog):
    """Like the size bound, the fan clustering before the quadric is not counted: a slow one (the clock jumps
    1,000 s) on a book of pages sharing one spine still leaves the quadric its run, and no fallback follows."""
    clock = Clock()
    monkeypatch.setattr(decimate, "time", clock)
    unfanned = decimate._unfanned_steps

    def slow_fans(*args):
        clock.now += 1_000.0
        return unfanned(*args)

    monkeypatch.setattr(decimate, "_unfanned_steps", slow_fans)
    runs = spy_runs(monkeypatch)
    positions, triangles = book()
    assert clustering.fan_weight(triangles) > decimate.FAN_LIMIT  # the fan path
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        smaller = decimate_entity(mesh_entity(positions, triangles), 2_000)
    assert clock.now == 1_000.0 and runs and fallback_warnings(caplog) == []
    assert 0 < smaller.triangle_count <= 2_000


def test_decimate_a_size_bound_that_leaves_nothing_warns_and_falls_back(monkeypatch, caplog):
    """When the size bound's clustering leaves no triangle (a node of dust), the fallback runs on the input, with the
    same kind of warning as after the quadric: every fallback shows in the log."""
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    empty = (np.empty((0, 3)), np.empty((0, 3), dtype=np.int64))

    def leaves_nothing(*args):
        return empty
        yield  # a steps generator (remoteview_core.steps)

    monkeypatch.setattr(decimate, "_bounded_steps", leaves_nothing)
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(200)})
    assert entity.triangle_count > 2 * decimate.CLUSTER_GOAL  # the size bound runs
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        smaller = decimate_entity(entity, 2_000)
    assert 0 < smaller.triangle_count <= 2_000 and outward(smaller) > 0.9
    assert fallback_warnings(caplog) == [
        f"Decimation: the size bound left no triangle on a node of {entity.triangle_count} triangles; "
        f"vertex clustering reduced it to {smaller.triangle_count} instead (coarser)"
    ]


class Clock:
    """A ``time`` stand-in for :mod:`remoteview_core.decimate` (it reads only ``time.monotonic``)."""

    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now


def body_and_debris() -> tuple[np.ndarray, np.ndarray]:
    """A 50 mm sphere (100 × 100: 19,600 triangles) at the origin and 50 islands of 96 triangles beside it."""
    source = vtkSphereSource()
    source.SetRadius(0.05)
    source.SetThetaResolution(100)
    source.SetPhiResolution(100)
    source.Update()
    centres = np.c_[0.1 + 0.02 * (np.arange(50) % 10), 0.02 * (np.arange(50) // 10), np.zeros(50)]
    return with_islands(mesh_points_and_triangles(source.GetOutput()), centres, radius=0.003)


def on_body(entity) -> int:
    """The triangles of ``entity`` on :func:`body_and_debris`'s large sphere."""
    middle = entity.positions[entity.indices].mean(axis=1)
    return int(np.sum(np.abs(np.linalg.norm(middle, axis=1) - 0.05) < 0.005))


@pytest.mark.parametrize("when", ["during-the-body", "between-the-runs"])
def test_decimate_an_aborted_part_sends_the_whole_node_to_the_fallback(when, monkeypatch):
    """A part whose run is aborted (or not started) at the deadline is not dropped: the whole node goes to the
    fallback. Before, the body's empty result was kept next to the islands (the node came back as its debris), or
    the islands' run was aborted and they vanished, and the node was reported as reduced."""
    positions, triangles = body_and_debris()
    assert len(triangles) == 19_600 + 50 * 96
    clock = Clock()
    monkeypatch.setattr(decimate, "time", clock)
    made: list = []

    def make(reduction):
        quadric = decimate._quadric(reduction)
        made.append(reduction)
        event = "StartEvent" if when == "during-the-body" else "EndEvent"
        quadric.AddObserver(event, lambda *_: setattr(clock, "now", 1e9))
        return quadric

    fallbacks: list = []
    original = decimate._fallback_steps
    monkeypatch.setattr(
        decimate, "_fallback_steps", lambda *a: fallbacks.append(len(a[1])) or original(*a)
    )
    # 15,000: the islands fit their share and need no run; 4,000: they need one, after the body's
    target = 15_000 if when == "during-the-body" else 4_000
    smaller = decimate_entity(mesh_entity(positions, triangles), target, quadric=make)
    assert len(made) == 1 and fallbacks == [len(triangles)]
    assert 0 < smaller.triangle_count <= target and on_body(smaller) > 0.5 * target


def seamed_sphere(resolution: int, radius: float = 0.02) -> tuple[np.ndarray, np.ndarray]:
    """A sphere cut into 6 charts (3 longitude sectors × 2 hemispheres) whose shared vertices are duplicated per
    chart, exact copies — the seams a reader (texture coordinates) or a normal filter (feature edges) leaves."""
    source = vtkSphereSource()
    source.SetRadius(radius)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    positions, triangles = mesh_points_and_triangles(source.GetOutput())
    middle = positions[triangles].mean(axis=1)
    sector = np.floor((np.arctan2(middle[:, 1], middle[:, 0]) + np.pi + 0.3) / (2 * np.pi / 3))
    chart = (sector.astype(np.int64) % 3) * 2 + (middle[:, 2] > 0)
    used, seamed = np.unique(chart[:, None] * len(positions) + triangles, return_inverse=True)
    return positions[used % len(positions)], seamed.reshape(-1, 3)


def boundary_edges(triangles) -> int:
    _, uses = np.unique(
        np.sort(clustering.edges(np.asarray(triangles)), axis=1), axis=0, return_counts=True
    )
    return int(np.sum(uses == 1))


def test_decimate_seams_stay_closed(monkeypatch):
    """Clustering joins the two sides of a seam (coincident vertices with agreeing normals): through the size bound
    and through the fallback the reduced sphere has no boundary edge, where the seams opened as cracks before."""
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    positions, triangles = seamed_sphere(200)
    assert len(triangles) > 2 * 10_000 and boundary_edges(triangles) > 1_000
    smaller = decimate_entity(mesh_entity(positions, triangles), 2_000)
    assert 0 < smaller.triangle_count <= 2_000 and boundary_edges(smaller.indices) == 0
    monkeypatch.setattr(decimate, "QUADRIC_SECONDS", 0.0)  # the fallback
    positions, triangles = seamed_sphere(64)
    smaller = decimate_entity(mesh_entity(positions, triangles), 2_000)
    assert 0 < smaller.triangle_count <= 2_000 and boundary_edges(smaller.indices) == 0


def test_decimate_double_sided_sheet_still_reduces(monkeypatch):
    """Two coincident layers with opposite winding: their vertices are not joined (their normals oppose), so the
    layers do not cancel and the sheet is still reduced, both sides kept."""
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    positions, triangles = grid_patch(120)
    sheet = np.vstack([positions, positions])
    both = np.vstack([triangles, triangles[:, ::-1] + len(positions)])
    assert len(both) > 2 * 10_000
    smaller = decimate_entity(mesh_entity(sheet, both), 2_000)
    assert 0 < smaller.triangle_count <= 2_000
    up = face_normals(smaller.positions, smaller.indices)[:, 2]
    assert np.sum(up > 0) > 500 and np.sum(up < 0) > 500


def test_decimate_dust_is_bounded(monkeypatch):
    """A labelmap of random voxels (2 %): almost every triangle is in an island smaller than the size bound's cell.
    The rescue is skipped above ``RESCUE_GOALS · goal`` lost triangles and the bound is applied again, so the quadric
    gets at most ``2 · goal`` (before: 59,947 for a goal of 10,000; a 16.5M-triangle version took 14.9 s)."""
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    mask = np.random.default_rng(3).random((120, 120, 120)) < 0.02
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": flying_edges(mask, 0.075)})
    assert entity.triangle_count > 200_000
    runs = spy_runs(monkeypatch)
    start = time.perf_counter()
    smaller = decimate_entity(entity, 2_000)
    assert time.perf_counter() - start < 5.0
    assert runs and sum(n for n, _ in runs) <= 2 * 10_000
    assert 0 < smaller.triangle_count <= 2_000


def test_decimate_result_keeps_only_the_points_its_triangles_use():
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    smaller = decimate_entity(entity, 10, quadric=lambda r: Degenerate("loose", []))
    np.testing.assert_array_equal(
        smaller.indices, [[0, 1, 2]]
    )  # the flat triangle and the loose point are gone
    np.testing.assert_allclose(
        smaller.positions, unscaled(entity, [[0, 0, 0], [0.01, 0, 0], [0, 0.01, 0]])
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
    smaller = decimate_entity(entity, 2_000, quadric=lambda r: Degenerate("folded", []))
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
    """IDs out of range, or a triangle that repeats a vertex (collect never makes them; VTK does not check them):
    no filter sees them."""
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": sphere(16)})
    row = [len(entity.positions) if v == "n" else v for v in bad]
    broken = dataclasses.replace(entity, indices=np.vstack([entity.indices, [row]]))
    calls: list = []
    assert decimate_entity(broken, 10, quadric=lambda r: Degenerate("unchanged", calls)) is None
    assert calls == []


def test_decimate_quadric_settings():
    quadric = decimate._quadric(0.5)
    assert (
        quadric.GetRegularize(),
        quadric.GetRegularization(),
        quadric.GetTargetReduction(),
    ) == (1, 0.01, 0.5)
    assert decimate.QUADRIC is decimate._quadric
    assert not hasattr(decimate, "vtkDecimatePro")  # its splitting cracked the surface (SLC-41)


def soup(rows: int = 80, columns: int = 100) -> tuple[np.ndarray, np.ndarray]:
    """``rows · columns`` separate right triangles with legs of 2⁻¹⁰ m, 2⁻⁴ m apart on a grid: each lies inside one
    cell of the fallback's first grid (cell = median edge · √(8,000 / 2,000) = 2⁻⁹ m, exact in binary)."""
    leg = 2.0**-10
    i, j = np.meshgrid(np.arange(rows), np.arange(columns), indexing="ij")
    corner = np.c_[i.ravel(), j.ravel(), np.zeros(i.size)] * 64 * leg
    n = len(corner)
    positions = np.concatenate(
        [corner, corner + np.array([leg, 0, 0]), corner + np.array([0, leg, 0])]
    )
    return positions, np.c_[np.arange(n), np.arange(n) + n, np.arange(n) + 2 * n]


def test_decimate_a_node_nothing_can_reduce_is_kept_whole_and_reported(caplog):
    """A soup of separate tiny triangles the quadric leaves unchanged: the fallback clustering collapses every
    triangle, so its first result at or under the share is empty — the node is sent whole and reported, and the
    warning says so (one per call)."""
    positions, triangles = soup()
    node = dataclasses.replace(
        mesh_entity(positions, triangles), node_id="vtkMRMLModelNode5", mrml_id="vtkMRMLModelNode5"
    )
    [other] = entities({"id": "vtkMRMLModelNode4", "mesh": cube()})
    calls: list = []
    quadric = lambda r: Degenerate("unchanged", calls)  # noqa: E731
    with caplog.at_level(logging.WARNING, logger="remoteview_core.decimate"):
        assert decimate_entity(node, 2_000, quadric=quadric) is None
        tight = Budget(
            total_triangles=3_000, node_triangles=2_000, target_bytes=1 << 20, floor_triangles=100
        )
        result = fit_to_budget([node, other], tight, quadric=quadric)
    assert result.entities == (node, other) and result.reduced == ()
    assert result.unreduced == ("vtkMRMLModelNode5",)  # never dropped (§7.5)
    write_glb(list(result.entities), ROOT)
    kept = (
        f"Decimation: the quadric gave no usable result on a node of {node.triangle_count} triangles; "
        "nothing could reduce it, it is sent whole"
    )
    assert fallback_warnings(caplog) == [kept, kept]


# --------------------------------------------------------------------------- bounded time and quality (SLC-41)


def stalling_sphere() -> tuple[np.ndarray, np.ndarray]:
    """A sphere (radius 0.03 m about (0.1, 0.1, 0.1) m, 3,040 triangles) with one triangle removed and a hole edge
    split by a vertex 1e-12 m from its end: distinct in float64, the same point in float32 — like the short boundary
    edges collect leaves where it drops a segmentation's triangles without area."""
    source = vtkSphereSource()
    source.SetRadius(0.03)
    source.SetCenter(0.1, 0.1, 0.1)
    source.SetThetaResolution(40)
    source.SetPhiResolution(40)
    source.Update()
    positions, triangles = mesh_points_and_triangles(source.GetOutput())
    hole = len(triangles) // 2
    a, b, _ = triangles[hole]
    triangles = np.delete(triangles, hole, axis=0)
    across = next(i for i, t in enumerate(triangles) if a in t and b in t)
    t = list(triangles[across])
    m = len(positions)
    step = positions[b] - positions[a]
    positions = np.vstack([positions, positions[a] + 1e-12 * step / np.linalg.norm(step)])
    first, second = list(t), list(t)  # (a, m, d) and (m, b, d) in the winding of t
    first[t.index(b)] = m
    second[t.index(a)] = m
    return positions, np.vstack([np.delete(triangles, across, axis=0), [first, second]])


def test_decimate_quadric_stall_float32_generated(monkeypatch):
    positions, triangles = stalling_sphere()
    assert len(triangles) == 3_040
    # Characterisation of VTK 9.6.x: vtkQuadricDecimation copies the points into float32, the split edge becomes
    # zero-length there, its NaN boundary quadric ends the main loop (measured 3,038 kept for a target of 304). A
    # release that copies double points would make this fail; the weld must then stay anyway (older VTK in Slicer).
    plain = vtkQuadricDecimation()
    plain.SetTargetReduction(0.9)
    plain.SetInputData(polydata_from_triangles(positions, triangles))
    plain.Update()
    assert plain.GetOutput().GetNumberOfPolys() > 2_700

    def no_fallback(*args):
        raise AssertionError("the fallback ran")

    monkeypatch.setattr(decimate, "_fallback_steps", no_fallback)
    smaller = decimate_entity(mesh_entity(positions, triangles), 304)
    assert 0 < smaller.triangle_count <= 304 and has_unit_normals(smaller)


def test_decimate_weld_float32_merges_only_float32_coincident_ends():
    one = np.float64(1.0)
    ulp = float(np.spacing(np.float32(1.0)))  # 2⁻²³
    positions = np.array(
        [
            [one, 0, 0],
            [one + 0.2 * ulp, 0, 0],  # equal to vertex 0 in float32
            [one + 2 * ulp, 0, 0],  # 2 ulp away: distinct
            [0, 1, 0],
            [0, 0, 1],
        ]
    )
    triangles = np.array([[0, 1, 3], [0, 2, 3], [1, 3, 4], [2, 4, 3]])
    welded = decimate._weld_float32(positions, triangles)
    # [0, 1, 3] repeats vertex 0 now and goes; vertex 1 becomes 0 elsewhere; vertex 2 stays
    np.testing.assert_array_equal(welded, [[0, 2, 3], [0, 3, 4], [2, 4, 3]])


def test_decimate_flat_plane_is_fast_and_exact():
    """A flat 0.1 m plane: exact cost ties made the plain quadric take 94 s (to 100k) and 234 s (to 2k); with
    Regularize it takes well under a second (measured 0.2-0.4 s)."""
    plane = vtkPlaneSource()
    plane.SetOrigin(0, 0, 0)
    plane.SetPoint1(100, 0, 0)
    plane.SetPoint2(0, 100, 0)
    for resolution, targets, limit in ((300, (100_000, 2_000), 5.0), (120, (2_000,), 2.0)):
        plane.SetResolution(resolution, resolution)
        plane.Update()
        [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": plane.GetOutput()})
        assert entity.triangle_count == 2 * resolution**2
        for target in targets:
            start = time.perf_counter()
            smaller = decimate_entity(entity, target)
            assert time.perf_counter() - start < limit
            assert 0 < smaller.triangle_count <= target
            # RAS z = 0 → glTF y = 0: every position stays on the plane
            assert np.ptp(smaller.positions[:, 1]) < 1e-9
            assert normal_opposes_face(smaller) == 0


def test_decimate_flatcap_cylinder_stays_exact():
    """An unsmoothed flying-edges cylinder with flat caps (the plain quadric took 28 s on a 427k version) to 25 %:
    fast, and the output's vertices stay on the input surface."""
    z, y, x = np.mgrid[0:100, 0:160, 0:160]
    mask = (((x - 80) ** 2 + (y - 80) ** 2) < 70**2) & (z > 2) & (z < 97)
    [entity] = entities({"id": "vtkMRMLModelNode4", "mesh": flying_edges(mask, 0.5)})
    start = time.perf_counter()
    smaller = decimate_entity(entity, entity.triangle_count // 4)
    assert time.perf_counter() - start < 5.0
    assert 0 < smaller.triangle_count <= entity.triangle_count // 4
    locator = vtkStaticCellLocator()
    locator.SetDataSet(polydata_from_triangles(entity.positions, entity.indices))
    locator.BuildLocator()
    closest, cell, sub, distance2 = [0.0, 0.0, 0.0], reference(0), reference(0), reference(0.0)
    distances = []
    for point in smaller.positions:
        locator.FindClosestPoint(list(point), closest, cell, sub, distance2)
        distances.append(float(distance2) ** 0.5)
    diagonal = np.linalg.norm(np.ptp(entity.positions, axis=0))
    assert np.percentile(distances, 99) < 1e-4 * diagonal


def book(pages: int = 300, grid: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """``pages`` pages of ``grid × grid`` quads, 10 mm square, sharing one spine (non-manifold: every spine edge has
    one triangle per page), in metres."""
    g = grid + 1
    i, j = np.meshgrid(np.arange(g), np.arange(g), indexing="ij")
    radius, height = 0.01 * i.ravel() / grid, 0.01 * j.ravel() / grid
    angle = np.pi * np.arange(pages) / pages
    positions = np.stack(
        [
            radius[None] * np.cos(angle)[:, None],
            radius[None] * np.sin(angle)[:, None],
            np.broadcast_to(height, (pages, g * g)),
        ],
        axis=-1,
    ).reshape(-1, 3)
    corner = (np.arange(grid)[:, None] * g + np.arange(grid)[None]).ravel()
    page = np.concatenate(
        [np.c_[corner, corner + g, corner + 1], np.c_[corner + 1, corner + g, corner + g + 1]]
    )
    triangles = (page[None] + g * g * np.arange(pages)[:, None, None]).reshape(-1, 3)
    local = np.arange(len(positions)) % (g * g)
    spine = np.where(
        local < g, local, np.arange(len(positions))
    )  # the first column of every page is page 0's
    return positions, spine[triangles]


def test_decimate_book_routes_around_the_quadric(monkeypatch):
    positions, triangles = book()
    assert clustering.fan_weight(triangles) > 50
    calls: list = []
    original = clustering.cluster_by_normal_steps
    monkeypatch.setattr(
        clustering, "cluster_by_normal_steps", lambda *a: calls.append(len(a[1])) or original(*a)
    )
    start = time.perf_counter()
    smaller = decimate_entity(mesh_entity(positions, triangles), 2_000)
    assert (
        time.perf_counter() - start < 2.0
    )  # the 3,000-page version: did not finish before, 0.3 s now
    assert calls and 0 < smaller.triangle_count <= 2_000


@pytest.mark.parametrize(("target", "limit"), [(2_000, 2.0), (100_000, 5.0)])
def test_decimate_a_fan_below_the_fan_limit_is_routed_by_its_quadric_work(
    target, limit, monkeypatch
):
    """400 pages of 16 × 16 quads: ``fan_weight`` 42 is below ``FAN_LIMIT``, but the quadric's set-up (which cannot be
    aborted) would cost ``edge_work`` 8.8e9 — 2.8-4.0 s here, 16.8 s on 672 pages. It goes the fan path instead
    (measured 0.12 s and 1.9 s)."""
    positions, triangles = book(400, 16)
    assert clustering.fan_weight(triangles) < decimate.FAN_LIMIT
    assert clustering.edge_work(triangles) > decimate.QUADRIC_WORK
    calls: list = []
    original = clustering.cluster_by_normal_steps
    monkeypatch.setattr(
        clustering, "cluster_by_normal_steps", lambda *a: calls.append(len(a[1])) or original(*a)
    )
    runs = spy_runs(monkeypatch)
    start = time.perf_counter()
    smaller = decimate_entity(mesh_entity(positions, triangles), target)
    assert time.perf_counter() - start < limit
    assert calls and runs and 0 < smaller.triangle_count <= target


def test_decimate_fallback_tries_normal_classes_when_connected_clusters_empty_the_mesh():
    """100 closed spheres, each inside one cell of the fallback's first grid: connected clusters collapse every
    sphere; normal classes keep a coarse shape of each."""
    centres = np.c_[0.02 * (np.arange(100) % 10), 0.02 * (np.arange(100) // 10), np.zeros(100)]
    nothing = (np.empty((0, 3)), np.empty((0, 3), dtype=np.int64))
    positions, triangles = with_islands(nothing, centres, radius=0.003)
    target = 300
    first = clustering.median_edge(positions, triangles) * np.sqrt(len(triangles) / target)
    assert len(clustering.cluster_connected(positions, triangles, first, rescue=0)[1]) == 0
    coarse = run(decimate._fallback_steps(positions, triangles, target))
    assert coarse is not None and 0 < len(coarse[1]) <= target


def noisy_sphere(resolution: int = 200, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    source = vtkSphereSource()
    source.SetRadius(0.02)
    source.SetCenter(0.1, 0.0, 0.0)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    positions, triangles = mesh_points_and_triangles(source.GetOutput())
    noise = 1 + 0.002 * np.random.default_rng(seed).standard_normal(len(positions))
    return (positions - [0.1, 0, 0]) * noise[:, None] + [0.1, 0, 0], triangles


def test_decimate_size_bound_feeds_the_quadric_a_bounded_mesh(monkeypatch):
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    runs = spy_runs(monkeypatch)
    positions, triangles = noisy_sphere()
    assert len(triangles) > 2 * 10_000
    smaller = decimate_entity(mesh_entity(positions, triangles), 2_000)
    assert runs and sum(n for n, _ in runs) <= 1.6 * 10_000
    assert 0 < smaller.triangle_count <= 2_000
    assert every_face_outward(smaller) and normal_opposes_face(smaller) == 0


def with_islands(
    body: tuple[np.ndarray, np.ndarray], centres: np.ndarray, radius: float = 0.005
) -> tuple[np.ndarray, np.ndarray]:
    """``body`` plus a small sphere (8 × 8: 96 triangles) at each of ``centres``, as one mesh."""
    meshes = [body]
    for centre in centres:
        source = vtkSphereSource()
        source.SetRadius(radius)
        source.SetCenter(*centre)
        source.SetThetaResolution(8)
        source.SetPhiResolution(8)
        source.Update()
        meshes.append(mesh_points_and_triangles(source.GetOutput()))
    offsets = np.cumsum([0] + [len(p) for p, _ in meshes])
    positions = np.concatenate([p for p, _ in meshes])
    triangles = np.concatenate([t + o for (_, t), o in zip(meshes, offsets, strict=False)])
    return positions, triangles


def spy_runs(monkeypatch) -> list:
    """Records ``(input triangles, share)`` of every :func:`decimate._run_quadric` call."""
    runs: list = []
    original = decimate._run_quadric
    monkeypatch.setattr(
        decimate,
        "_run_quadric",
        lambda p, t, share, *a: runs.append((len(t), share)) or original(p, t, share, *a),
    )
    return runs


def test_decimate_islands_keep_their_share(monkeypatch):
    """A large sphere with 200 small ones: the parts below ``ISLAND_TRIANGLES`` get a run of their own with their
    share (twice the proportional 1,920 is 3,840, capped at half the target), the large sphere the rest."""
    centres = np.c_[
        0.2 + 0.02 * (np.arange(200) % 20), 0.02 * (np.arange(200) // 20), np.zeros(200)
    ]
    positions, triangles = with_islands(noisy_sphere(160, seed=1), centres)
    assert len(triangles) == 50_560 + 200 * 96
    target = len(triangles) // 10
    t_small = target // 2
    runs = spy_runs(monkeypatch)
    smaller = decimate_entity(mesh_entity(positions, triangles), target)
    assert runs == [(50_560, target - t_small), (19_200, t_small)]
    assert 0 < smaller.triangle_count <= target
    middle = smaller.positions[smaller.indices].mean(axis=1)
    distance = np.linalg.norm(middle[:, None, :] - centres[None], axis=2)
    near = distance.min(axis=1) < 0.006
    assert 0.9 * t_small <= near.sum() <= t_small  # one run over everything: 6,670 and 306
    assert 0.9 * (target - t_small) <= (~near).sum() <= target - t_small
    assert len(np.unique(distance.argmin(axis=1)[near])) == 200
    # only small parts: they get all of the share, not half of it
    tetrahedron = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64) * 0.001
    faces = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
    positions = np.concatenate([tetrahedron + np.array([0.01 * i, 0, 0]) for i in range(300)])
    triangles = np.concatenate([faces + 4 * i for i in range(300)])
    smaller = decimate_entity(mesh_entity(positions, triangles), 200)
    assert 100 < smaller.triangle_count <= 200


def test_decimate_islands_use_what_the_body_leaves(monkeypatch):
    """A body within its share needs no run; the islands then get the rest of the target instead of half of it."""
    centres = np.c_[
        0.2 + 0.02 * (np.arange(100) % 10), 0.02 * (np.arange(100) // 10), np.zeros(100)
    ]
    positions, triangles = with_islands(noisy_sphere(40, seed=2), centres)
    body = 40 * 38 * 2
    target = 2 * body + 2_000  # the body (3,040) fits in its half; the islands (9,600) need a run
    runs = spy_runs(monkeypatch)
    smaller = decimate_entity(mesh_entity(positions, triangles), target)
    assert runs == [(9_600, target - body)]
    assert target - 50 <= smaller.triangle_count <= target


def grid_patch(n: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """An ``n × n`` grid of quads in the z = 0 plane, every triangle facing +z."""
    i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
    positions = np.c_[i.ravel(), j.ravel(), np.zeros(i.size)] * 0.001
    corner = (np.arange(n)[:, None] * (n + 1) + np.arange(n)[None]).ravel()
    triangles = np.concatenate(
        [
            np.c_[corner, corner + n + 1, corner + 1],
            np.c_[corner + 1, corner + n + 1, corner + n + 2],
        ]
    )
    return positions, triangles


def test_decimate_fold_repair():
    positions, triangles = grid_patch()
    assert np.all(face_normals(positions, triangles)[:, 2] > 0)
    np.testing.assert_array_equal(decimate._repair_folds(positions, triangles), triangles)
    flipped = triangles.copy()
    flipped[5] = flipped[5][::-1]
    np.testing.assert_array_equal(decimate._repair_folds(positions, flipped), triangles)
    # the final normals come from vtkPolyDataNormals without reordering: the repaired triangles, minus the one
    # without area (a collinear triangle on unused points), are what the entity gets
    extra = np.vstack([positions, [[0.0, 0.01, 0.0], [0.0, 0.02, 0.0], [0.0, 0.03, 0.0]]])
    with_flat = np.vstack([flipped, [[25, 26, 27]]])
    finished = decimate._finished(mesh_entity(extra, with_flat), extra, with_flat, 100)
    np.testing.assert_array_equal(finished.indices, triangles)
    np.testing.assert_allclose(finished.normals, [[0.0, 0.0, 1.0]] * len(positions), atol=1e-12)


# --------------------------------------------------------------------------- the whole scene (criterion 1)


def quest2_scene() -> list:
    """A 400k-triangle sphere and three other nodes, the last a ``vtkCubeSource`` (4 points of its own per face)."""
    return entities(
        {"id": "vtkMRMLModelNode4", "mesh": sphere(448)},  # 399,616 triangles
        {"id": "vtkMRMLModelNode5", "mesh": sphere(240)},  # 114,240
        {"id": "vtkMRMLModelNode6", "mesh": sphere(160)},  # 50,560
        {"id": "vtkMRMLModelNode7", "mesh": cube()},  # 12
    )


def test_decimate_quest2_scene_fits_500k_with_no_node_above_100k():
    """A 400k-triangle sphere and three other nodes under ``quest2`` (FR-10, §7.5)."""
    nodes = quest2_scene()
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


def test_decimate_quest2_scene_has_no_small_islands():
    """SLC-53: with *Remove small islands* the same scene fits with the same counts — every sphere is one part, and
    the cube's six faces (two triangles each by vertex IDs) are one part by position, the only one of its node."""
    nodes = quest2_scene()
    plain = fit_to_budget(nodes, QUEST2)
    result = fit_to_budget(nodes, QUEST2, remove_islands=True)
    assert result.cleaned == () and plain.cleaned == ()
    assert [e.triangle_count for e in result.entities] == [e.triangle_count for e in plain.entities]
    assert result.reduced == plain.reduced == ("vtkMRMLModelNode4", "vtkMRMLModelNode5")
    assert result.entities[2] is nodes[2] and result.entities[3] is nodes[3]


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
