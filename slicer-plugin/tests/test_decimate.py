"""SLC-14: decimation to the profile budgets (protocol §7.5, FR-10) and the GLB size estimate (NFR-03, NFR-23)."""

from __future__ import annotations

import dataclasses
import struct

import numpy as np
import pytest
from pygltflib import GLTF2
from support import FakeScene, created, needs_validator, reassemble, sphere, validate_glb
from vtkmodules.vtkCommonDataModel import vtkPolyData
from vtkmodules.vtkFiltersSources import vtkCubeSource

from remoteview_core import decimate, glb_writer, protocol_client
from remoteview_core import snapshot as snapshot_module
from remoteview_core.collect import collect_entities, polydata_from_triangles
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
from remoteview_core.protocol_client import ProtocolClient, make_client_info
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
    np.testing.assert_allclose(smaller.positions, [[0, 0, 0], [0.01, 0, 0], [0, 0.01, 0]])
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


def live_client(profile: str, **limits) -> ProtocolClient:
    client = ProtocolClient(make_client_info("5.12.4", "win32"), auto_renew=False)
    client.start(profile)
    client.handle(created(**limits))
    return client


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
