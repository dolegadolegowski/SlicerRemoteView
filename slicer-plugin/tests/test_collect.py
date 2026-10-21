"""SLC-07: MRML model collection through an injectable scene API (architecture §6.4, ADR 0005 + errata)."""

from __future__ import annotations

import hashlib
import itertools
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pygltflib import GLTF2
from vtkmodules.util.numpy_support import (
    get_numpy_array_type,
    numpy_to_vtk,
    numpy_to_vtkIdTypeArray,
)
from vtkmodules.vtkCommonCore import (
    VTK_DOUBLE,
    vtkBitArray,
    vtkDoubleArray,
    vtkFloatArray,
    vtkIdTypeArray,
    vtkPoints,
)
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData, vtkUnstructuredGrid
from vtkmodules.vtkCommonTransforms import (
    vtkGeneralTransform,
    vtkThinPlateSplineTransform,
    vtkTransform,
)
from vtkmodules.vtkFiltersCore import vtkAppendPolyData, vtkStripper
from vtkmodules.vtkFiltersSources import vtkCubeSource, vtkLineSource, vtkSphereSource

from remoteview_core import collect
from remoteview_core.collect import (
    CollectedScene,
    SkippedNode,
    SkipReason,
    collect_entities,
    collect_scene,
    mesh_from_polydata,
)
from remoteview_core.glb_writer import Entity, RootExtras, is_exportable_matrix, write_glb

# --------------------------------------------------------------------------- fakes and fixtures


@dataclass
class FakeNode:
    node_id: Any
    polydata: Any
    name: Any = "Model"
    color: Any = (0.9, 0.5, 0.1)
    opacity: Any = 1.0
    visible: Any = True
    world: Any = field(default_factory=lambda: np.eye(4))
    transform: Any = None  # what world_transform hands over for baking a non-linear chain


class FakeScene:
    """The SceneApi protocol over plain objects (the Slicer adapter arrives in SLC-09/SLC-22)."""

    def __init__(self, *nodes: FakeNode) -> None:
        self.nodes = list(nodes)

    def visible_model_nodes(self):
        return list(self.nodes)

    def node_id(self, node):
        return node.node_id

    def name(self, node):
        return node.name

    def polydata(self, node):
        return node.polydata

    def display_props(self, node):
        return node.color, node.opacity, node.visible

    def world_matrix(self, node):
        return node.world

    def world_transform(self, node):
        return node.transform


def _sphere(center=(100.0, 30.0, -20.0), radius=10.0, resolution=16) -> vtkPolyData:
    """Sphere offset along R, A and S (a centred mesh would hide an axis flip — SLC-05 follow-up)."""
    source = vtkSphereSource()
    source.SetCenter(*center)
    source.SetRadius(radius)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    return source.GetOutput()


def _cube(center=(-40.0, 60.0, 25.0), lengths=(10.0, 20.0, 30.0)) -> vtkPolyData:
    source = vtkCubeSource()
    source.SetCenter(*center)
    source.SetXLength(lengths[0])
    source.SetYLength(lengths[1])
    source.SetZLength(lengths[2])
    source.Update()
    return source.GetOutput()


def _polydata(points, polys=(), lines=(), verts=()) -> vtkPolyData:
    data = vtkPolyData()
    vtk_points = vtkPoints()
    vtk_points.SetData(numpy_to_vtk(np.asarray(points, dtype=np.float64), deep=True))
    data.SetPoints(vtk_points)
    for cells, setter in ((polys, data.SetPolys), (lines, data.SetLines), (verts, data.SetVerts)):
        if cells:
            array = vtkCellArray()
            for cell in cells:
                array.InsertNextCell(len(cell), list(cell))
            setter(array)
    return data


def vtk_to_numpy(array) -> np.ndarray:
    """A view of a VTK array (numpy_support.vtk_to_numpy sets .shape in place, deprecated in numpy 2.5)."""
    flat = np.frombuffer(array, dtype=get_numpy_array_type(array.GetDataType()))
    components = array.GetNumberOfComponents()
    return flat.reshape(-1, components) if components > 1 else flat


def _ras_to_gltf(points) -> np.ndarray:
    p = np.asarray(points, dtype=np.float64)
    return np.c_[p[:, 0], p[:, 2], -p[:, 1]] * 0.001


def _root(anonymized: bool = False) -> RootExtras:
    return RootExtras(
        scene_version=1, profile="mobile", slicer_version="5.12.4", anonymized_names=anonymized
    )


def _snapshot(polydata: vtkPolyData) -> dict:
    """Everything observable about a vtkPolyData, to prove the input is left untouched."""
    state = {
        "mtime": polydata.GetMTime(),
        "points_mtime": polydata.GetPoints().GetMTime() if polydata.GetPoints() else None,
        "npoints": polydata.GetNumberOfPoints(),
        "ncells": [
            polydata.GetPolys().GetNumberOfCells(),
            polydata.GetLines().GetNumberOfCells(),
            polydata.GetVerts().GetNumberOfCells(),
        ],
        "arrays": [
            polydata.GetPointData().GetArrayName(i)
            for i in range(polydata.GetPointData().GetNumberOfArrays())
        ],
        "normals": polydata.GetPointData().GetNormals(),
    }
    digest = hashlib.sha256()
    if polydata.GetPoints():
        digest.update(vtk_to_numpy(polydata.GetPoints().GetData()).tobytes())
    for cells in (polydata.GetPolys(), polydata.GetLines(), polydata.GetVerts()):
        if cells.GetNumberOfCells():
            digest.update(vtk_to_numpy(cells.GetConnectivityArray()).tobytes())
            digest.update(vtk_to_numpy(cells.GetOffsetsArray()).tobytes())
    for i in range(polydata.GetPointData().GetNumberOfArrays()):
        digest.update(vtk_to_numpy(polydata.GetPointData().GetArray(i)).tobytes())
    state["digest"] = digest.hexdigest()
    return state


# --------------------------------------------------------------------------- conversion (criterion 1)


def test_collect_sphere_positions_are_converted_and_normals_point_outward():
    center = np.array([100.0, 30.0, -20.0])
    sphere = _sphere(center)
    [entity] = collect_entities(FakeScene(FakeNode("vtkMRMLModelNode4", sphere, name="Skull")))
    ras = vtk_to_numpy(sphere.GetPoints().GetData()).astype(np.float64)
    np.testing.assert_allclose(entity.positions, _ras_to_gltf(ras), atol=1e-9)
    gltf_center = _ras_to_gltf([center])[0]
    np.testing.assert_allclose(gltf_center, [0.100, -0.020, -0.030])  # x=R, y=S, z=-A (metres)
    np.testing.assert_allclose(entity.positions.mean(axis=0), gltf_center, atol=1e-6)
    lengths = np.linalg.norm(entity.normals, axis=1)
    np.testing.assert_allclose(lengths, 1.0, atol=1e-6)  # §7.4 NORMAL is unit length
    radial = entity.positions - gltf_center
    radial /= np.linalg.norm(radial, axis=1)[:, None]
    assert (
        np.einsum("ij,ij->i", entity.normals, radial).min() > 0.95
    )  # outward, same frame as positions
    assert entity.kind == "model" and entity.mrml_id == entity.node_id == "vtkMRMLModelNode4"
    assert entity.name == "Skull" and entity.matrix is None and entity.triangle_count == 16 * 14 * 2
    assert sphere.GetNumberOfPoints() == len(entity.positions)  # SplittingOff: no duplicated points


def test_collect_cube_faces_keep_their_anatomical_direction():
    """Flat cube faces: the anterior face (+A) must face glTF −Z, superior (+S) +Y, right (+R) +X."""
    [entity] = collect_entities(FakeScene(FakeNode("vtkMRMLModelNode5", _cube())))
    assert entity.triangle_count == 12  # quads triangulated
    expected = {
        (1.0, 0.0, 0.0): ("x", -40.0 + 5.0),  # right face at R = −35
        (0.0, 0.0, -1.0): ("z", -(60.0 + 10.0)),  # anterior face at A = 70 → z = −0.070
        (0.0, 1.0, 0.0): ("y", 25.0 + 15.0),  # superior face at S = 40
    }
    axis = {"x": 0, "y": 1, "z": 2}
    for normal, (name, mm) in expected.items():
        on_face = np.all(np.isclose(entity.normals, normal, atol=1e-6), axis=1)
        assert on_face.sum() == 4, normal
        np.testing.assert_allclose(entity.positions[on_face, axis[name]], mm * 0.001, atol=1e-9)


def test_collect_writes_a_valid_glb():
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode4", _sphere(), name="Skull", opacity=0.4),
        FakeNode("vtkMRMLModelNode5", _cube(), name="Box", visible=False),
    )
    collected = collect_scene(scene)
    gltf = GLTF2.load_from_bytes(write_glb(collected.entities, _root()))
    t_nodes = [gltf.nodes[i] for i in gltf.nodes[0].children]
    assert [t.extras["nodeId"] for t in t_nodes] == ["vtkMRMLModelNode4", "vtkMRMLModelNode5"]
    assert [t.extras["opacity"] for t in t_nodes] == [0.4, 1.0]
    assert [t.extras["visible"] for t in t_nodes] == [True, False]
    assert collected.skipped == () and collected.anonymized_names is False


def test_collect_large_mesh_uses_uint32_indices():
    big = _sphere(resolution=260)  # 260 × 258 + 2 > 65,535 points
    [entity] = collect_entities(FakeScene(FakeNode("vtkMRMLModelNode9", big)))
    assert len(entity.positions) > 65_535
    gltf = GLTF2.load_from_bytes(write_glb([entity], _root()))
    assert gltf.accessors[2].componentType == 5125


# --------------------------------------------------------------------------- transforms


def test_collect_linear_world_matrix_becomes_t_matrix():
    translation = np.eye(4)
    translation[:3, 3] = (10.0, 20.0, 30.0)
    rotation = np.eye(4)
    rotation[:3, :3] = [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]  # 90° about S
    mirror = np.diag([-1.0, 1.0, 1.0, 1.0])  # negative scale is TRS
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere(), world=translation),
        FakeNode("vtkMRMLModelNode2", _sphere(), world=rotation),
        FakeNode("vtkMRMLModelNode3", _sphere(), world=mirror),
        FakeNode("vtkMRMLModelNode4", _sphere(), world=np.eye(4)),
    )
    first, second, third, fourth = collect_entities(scene)
    np.testing.assert_allclose(first.matrix[:3, 3], [0.010, 0.030, -0.020], atol=1e-12)
    np.testing.assert_allclose(
        first.positions, fourth.positions
    )  # geometry stays in the node frame
    # +R rotated onto +A: glTF +X goes to −Z
    np.testing.assert_allclose(
        second.matrix[:3, :3] @ [1.0, 0.0, 0.0], [0.0, 0.0, -1.0], atol=1e-12
    )
    assert np.linalg.det(third.matrix[:3, :3]) < 0 and fourth.matrix is None
    write_glb([first, second, third, fourth], _root())


@pytest.mark.parametrize(
    ("world", "reason"),
    [
        (None, SkipReason.NON_LINEAR_TRANSFORM),  # and the scene hands over no transform to bake
        (np.full((4, 4), np.nan), SkipReason.INVALID_TRANSFORM),
        (
            np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0.5, 1.0]]),
            SkipReason.INVALID_TRANSFORM,
        ),
        (np.eye(3), SkipReason.INVALID_TRANSFORM),
        ("identity", SkipReason.INVALID_TRANSFORM),
    ],
)
def test_collect_unusable_transforms_are_skipped(world, reason):
    """A matrix that is not a finite affine 4×4, or a non-linear chain without a transform to bake: the node is left
    out, not the scene."""
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere(), world=world),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode2"]
    assert collected.skipped == (SkippedNode("vtkMRMLModelNode1", reason),)


def test_collect_uses_the_writers_matrix_predicate():
    """A matrix collect keeps is one the writer accepts (SLC-04 follow-up: same predicate)."""
    rng = np.random.default_rng(7)
    kept = 0
    for _ in range(200):
        m = np.eye(4)
        rotation, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        shear = np.eye(3) + np.triu(rng.normal(size=(3, 3)) * rng.choice([0.0, 1e-9, 1e-3]), 1)
        m[:3, :3] = rotation @ shear @ np.diag(rng.uniform(0.01, 100, size=3))
        m[:3, 3] = rng.normal(size=3) * 100
        result = collect._placement(m)
        if result is collect._BAKE:
            assert not is_exportable_matrix(collect.ras_matrix_to_gltf(m))
        else:
            kept += 1
            assert is_exportable_matrix(result)
            entity = Entity(
                node_id="vtkMRMLModelNode1",
                kind="model",
                name="M",
                positions=np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.0, -0.01]]),
                normals=np.tile([0.0, 1.0, 0.0], (3, 1)),
                indices=np.array([[0, 1, 2]]),
                color=(1.0, 1.0, 1.0),
                opacity=1.0,
                visible=True,
                mrml_id="vtkMRMLModelNode1",
                matrix=result,
            )
            write_glb([entity], _root())
    assert 0 < kept < 200  # both branches ran


# --------------------------------------------------------------------------- names (criterion 2)


def test_collect_names_are_sanitised_and_anonymised_without_gaps():
    nodes = [
        FakeNode("vtkMRMLModelNode1", _sphere(), name="Patient\x07 Name  "),
        FakeNode("vtkMRMLModelNode2", vtkPolyData(), name="Empty"),  # skipped: no number used
        FakeNode("vtkMRMLModelNode3", _cube(), name=b"P\xb3uco"),  # VTK bytes for a non-UTF-8 name
    ]
    shown = collect_scene(FakeScene(*nodes))
    assert [e.name for e in shown.entities] == ["Patient Name", "P�uco"]
    hidden = collect_scene(FakeScene(*nodes), anonymize_names=True)
    assert [e.name for e in hidden.entities] == ["Model 1", "Model 2"]
    assert hidden.anonymized_names is True
    glb = write_glb(hidden.entities, _root(hidden.anonymized_names))
    gltf = GLTF2.load_from_bytes(glb)
    assert gltf.nodes[0].extras["anonymizedNames"] is True
    assert b"Patient" not in glb and b"P\xef\xbf\xbduco" not in glb


# --------------------------------------------------------------------------- baked transforms (SLC-13)

SHEAR = np.array(
    [[1.0, 0.3, 0.0, 5.0], [0.0, 1.0, 0.0, -7.0], [0.0, 0.0, 1.0, 2.0], [0.0, 0.0, 0.0, 1.0]]
)
MIRROR = np.diag([-1.0, 1.0, 1.0, 1.0])


def _points(polydata: vtkPolyData) -> np.ndarray:
    return vtk_to_numpy(polydata.GetPoints().GetData()).astype(np.float64)


def _signed_volume(entity: Entity) -> float:
    """Positive when the triangles of a closed mesh face outwards (their front faces, what a viewer culls by)."""
    a, b, c = (entity.positions[entity.indices[:, i]] for i in range(3))
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)


def _faces_agree_with_normals(entity: Entity) -> bool:
    p, t = entity.positions, entity.indices
    face = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    return bool(np.all(np.einsum("ij,ij->i", face, entity.normals[t].mean(axis=1)) > 0))


def _tps(center=(100.0, 30.0, -20.0), bend=4.0) -> vtkThinPlateSplineTransform:
    """A thin-plate spline that bends a 40 mm box around ``center``: S moves by ``bend`` × (R offset / 20 mm)²."""
    source, target = vtkPoints(), vtkPoints()
    for corner in itertools.product((-20.0, 20.0), repeat=3):
        p = np.add(center, corner)
        source.InsertNextPoint(*p)
        target.InsertNextPoint(*np.add(p, [0.0, 0.0, bend * (corner[0] / 20.0) ** 2]))
    source.InsertNextPoint(*center)
    target.InsertNextPoint(*center)
    tps = vtkThinPlateSplineTransform()
    tps.SetBasisToR()
    tps.SetSourceLandmarks(source)
    tps.SetTargetLandmarks(target)
    return tps


def _linear(matrix) -> vtkTransform:
    transform = vtkTransform()
    transform.SetMatrix([float(v) for v in np.asarray(matrix).ravel()])
    return transform


@pytest.mark.parametrize("world", [SHEAR, SHEAR @ MIRROR], ids=["shear", "shear+mirror"])
def test_collect_bakes_a_sheared_world_matrix(world):
    """glTF node.matrix must be TRS (§7.2): a sheared world matrix is applied to the vertices instead (§7.3)."""
    sphere = _sphere()
    before = _snapshot(sphere)
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", sphere, world=world),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    baked, plain = collect_entities(scene)
    assert baked.baked and baked.matrix is None and not plain.baked
    moved = _points(sphere) @ world[:3, :3].T + world[:3, 3]
    np.testing.assert_allclose(baked.positions, _ras_to_gltf(moved), rtol=0, atol=1e-12)
    np.testing.assert_allclose(np.linalg.norm(baked.normals, axis=1), 1.0, atol=1e-6)
    assert _signed_volume(baked) > 0 and _faces_agree_with_normals(
        baked
    )  # front faces outside, mirror or not
    assert _snapshot(sphere) == before  # the user's mesh is not moved
    gltf = GLTF2.load_from_bytes(write_glb([baked, plain], _root()))
    t_nodes = [gltf.nodes[i] for i in gltf.nodes[0].children]
    assert [t.extras["baked"] for t in t_nodes] == [True, False]
    assert t_nodes[0].matrix is None  # identity


@pytest.mark.parametrize("mirrored", [False, True])
def test_collect_bakes_a_non_linear_transform(mirrored):
    """§7.3: a thin-plate spline parent → baked: true, identity T.matrix, vertices moved by the spline."""
    sphere = _sphere()
    warp = vtkGeneralTransform()
    warp.PostMultiply()
    warp.Concatenate(_tps())
    if mirrored:
        warp.Concatenate(_linear(MIRROR))
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", sphere, world=None, transform=warp),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    collected = collect_scene(scene)
    baked, plain = collected.entities
    assert collected.skipped == () and baked.baked and baked.matrix is None and not plain.baked
    moved = np.array([warp.TransformPoint(p) for p in _points(sphere)])
    np.testing.assert_allclose(baked.positions, _ras_to_gltf(moved), rtol=0, atol=1e-12)
    straight = collect_entities(FakeScene(FakeNode("vtkMRMLModelNode1", _sphere())))[0]
    assert np.abs(baked.positions - straight.positions).max() > 1e-3  # really bent (> 1 mm)
    assert _signed_volume(baked) > 0 and _faces_agree_with_normals(baked)
    write_glb(collected.entities, _root())


def test_collect_bakes_a_flattening_transform_and_drops_triangles_left_without_area():
    """A zero scale is not TRS either: the cube's sides collapse to lines and are dropped; top and bottom stay."""
    world = np.diag([1.0, 1.0, 0.0, 1.0])
    assert not is_exportable_matrix(collect.ras_matrix_to_gltf(world))
    [entity] = collect_entities(FakeScene(FakeNode("vtkMRMLModelNode1", _cube(), world=world)))
    assert entity.baked and entity.triangle_count == 4
    np.testing.assert_allclose(entity.positions[:, 1], 0.0)  # S = 0 → glTF y = 0
    assert sorted(entity.normals[:, 1]) == [-1.0] * 4 + [1.0] * 4  # bottom faces −S, top +S
    write_glb([entity], _root())


@pytest.mark.parametrize(
    "transform",
    [None, "warp", vtkPolyData(), 7],
    ids=["none", "str", "not-a-transform", "int"],
)
def test_collect_skips_a_non_linear_node_without_a_transform_to_bake(transform):
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere(), world=None, transform=transform),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode2"]
    assert collected.skipped == (SkippedNode("vtkMRMLModelNode1", SkipReason.NON_LINEAR_TRANSFORM),)


def test_collect_world_transform_is_asked_only_for_a_non_linear_chain():
    asked = []

    class Spy(FakeScene):
        def world_transform(self, node):
            asked.append(node.node_id)
            return super().world_transform(node)

    scene = Spy(
        FakeNode("vtkMRMLModelNode1", _sphere()),
        FakeNode("vtkMRMLModelNode2", _sphere(), world=SHEAR),  # baked from the matrix itself
        FakeNode("vtkMRMLModelNode3", _sphere(), world=None, transform=_tps()),
    )
    assert [e.baked for e in collect_entities(scene)] == [False, True, True]
    assert asked == ["vtkMRMLModelNode3"]


def test_collect_mirror_is_judged_where_the_mesh_is():
    """A warp that mirrors around the mesh but not at the origin (its Jacobian: negative at the sphere, positive at
    (0, 0, 0)): the front faces must stay outside, which needs the mirror to be judged at the mesh."""
    center = np.array([100.0, 30.0, -20.0])
    source, target = vtkPoints(), vtkPoints()
    for corner in itertools.product((-20.0, 20.0), repeat=3):
        inner = center + corner
        source.InsertNextPoint(*inner)
        target.InsertNextPoint(
            2 * center[0] - inner[0], inner[1], inner[2]
        )  # mirrored about R = 100
    for corner in itertools.product((-300.0, 300.0), repeat=3):
        source.InsertNextPoint(*(center + corner))
        target.InsertNextPoint(*(center + corner))  # far away: unchanged
    warp = vtkThinPlateSplineTransform()
    warp.SetBasisToR()
    warp.SetSourceLandmarks(source)
    warp.SetTargetLandmarks(target)
    warp.Update()
    for at, sign in ((center, -1), (np.zeros(3), 1)):
        jacobian = [[0.0] * 3 for _ in range(3)]
        warp.InternalTransformDerivative([float(v) for v in at], [0.0] * 3, jacobian)
        assert np.sign(np.linalg.det(jacobian)) == sign
    # then far away along R: at the moved mesh the chain's Jacobian is positive, so the input point must be used
    moved = vtkGeneralTransform()
    moved.PostMultiply()
    moved.Concatenate(warp)
    moved.Concatenate(_linear([[1, 0, 0, -400.0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]))
    for transform in (warp, moved):
        sphere = _sphere(center, radius=10.0)
        [entity] = collect_entities(
            FakeScene(FakeNode("vtkMRMLModelNode1", sphere, world=None, transform=transform))
        )
        assert entity.baked and _signed_volume(entity) > 0 and _faces_agree_with_normals(entity)


def test_collect_skips_a_baked_mesh_that_overflows_float32():
    """A transform that moves the vertices beyond float32 (what the GLB stores): the node is left out."""
    blow_up = _linear(np.diag([1e300, 1.0, 1.0, 1.0]))
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere(), world=None, transform=blow_up),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode2"]
    assert collected.skipped == (SkippedNode("vtkMRMLModelNode1", SkipReason.INVALID_GEOMETRY),)


# --------------------------------------------------------------------------- skipped nodes (criterion 2)


def test_collect_skips_nodes_without_triangles_and_keeps_the_rest():
    points_only = _polydata([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
    line = vtkLineSource()
    line.Update()
    two_point_poly = _polydata([[0, 0, 0], [1, 0, 0]], polys=[(0, 1)])
    degenerate = _polydata([[0, 0, 0], [1, 0, 0], [0, 1, 0]], polys=[(0, 1, 1), (2, 2, 2)])
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", None),
        FakeNode("vtkMRMLModelNode2", vtkPolyData()),
        FakeNode("vtkMRMLModelNode3", points_only),
        FakeNode("vtkMRMLModelNode4", line.GetOutput()),
        FakeNode("vtkMRMLModelNode5", two_point_poly),
        FakeNode("vtkMRMLModelNode6", degenerate),
        FakeNode("vtkMRMLModelNode7", _sphere()),
        FakeNode("vtkMRMLModelNode8", _sphere(), world=None),  # non-linear, nothing to bake
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode7"]
    assert collected.skipped == (
        *(SkippedNode(f"vtkMRMLModelNode{i}", SkipReason.NO_TRIANGLES) for i in range(1, 7)),
        SkippedNode("vtkMRMLModelNode8", SkipReason.NON_LINEAR_TRANSFORM),
    )
    assert [s.index for s in collected.skipped] == [
        0,
        1,
        2,
        3,
        4,
        5,
        7,
    ]  # local position, for the panel
    write_glb(collected.entities, _root())  # the snapshot is still written


@pytest.mark.parametrize(
    ("node", "reason", "reported_id"),
    [
        (FakeNode("bad id", None), SkipReason.INVALID_NODE_ID, ""),
        (FakeNode("vtkMRMLModelNode1/x", None), SkipReason.INVALID_NODE_ID, ""),
        (FakeNode("root", None), SkipReason.INVALID_NODE_ID, ""),
        (FakeNode(42, None), SkipReason.INVALID_NODE_ID, ""),
        (FakeNode("x" * 129, None), SkipReason.INVALID_NODE_ID, ""),
        (
            FakeNode("vtkMRMLModelNode9", None, color=(np.nan, 0, 0)),
            SkipReason.INVALID_DISPLAY,
            "vtkMRMLModelNode9",
        ),
        (
            FakeNode("vtkMRMLModelNode9", None, color=(1.0, 0.0)),
            SkipReason.INVALID_DISPLAY,
            "vtkMRMLModelNode9",
        ),
        (
            FakeNode("vtkMRMLModelNode9", None, color="red"),
            SkipReason.INVALID_DISPLAY,
            "vtkMRMLModelNode9",
        ),
        (
            FakeNode("vtkMRMLModelNode9", None, opacity=float("inf")),
            SkipReason.INVALID_DISPLAY,
            "vtkMRMLModelNode9",
        ),
        (
            FakeNode("vtkMRMLModelNode9", None, opacity="opaque"),
            SkipReason.INVALID_DISPLAY,
            "vtkMRMLModelNode9",
        ),
    ],
)
@pytest.mark.parametrize("anonymize", [False, True])
def test_collect_invalid_nodes_are_skipped(node, reason, reported_id, anonymize):
    scene = FakeScene(node, FakeNode("vtkMRMLModelNode2", _sphere()))
    collected = collect_scene(scene, anonymize_names=anonymize)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode2"]
    assert collected.skipped == (SkippedNode(reported_id, reason),)
    write_glb(collected.entities, _root(anonymize))


_CRAFTED_CELLS = """
import sys
sys.path.append(sys.argv[1])
import numpy as np
from vtkmodules.util.numpy_support import numpy_to_vtkIdTypeArray
from vtkmodules.vtkCommonCore import vtkPoints
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkFiltersSources import vtkSphereSource
from remoteview_core.collect import collect_scene

def cells(offsets, connectivity):
    array = vtkCellArray()
    array.SetData(numpy_to_vtkIdTypeArray(np.array(offsets, dtype=np.int64), deep=True),
                  numpy_to_vtkIdTypeArray(np.array(connectivity, dtype=np.int64), deep=True))
    return array

def mesh(kind, offsets, connectivity):
    data = vtkPolyData()
    points = vtkPoints()
    for p in [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]:
        points.InsertNextPoint(*p)
    data.SetPoints(points)
    (data.SetStrips if kind == "strip" else data.SetPolys)(cells(offsets, connectivity))
    return data

def legacy_file(cells="POLYGONS 3 3\\nOFFSETS vtktypeint64\\n0 3 9000000\\nCONNECTIVITY vtktypeint64\\n0 1 2\\n"):
    # the path a crafted file takes: a legacy VTK 5.1 file (by default its OFFSETS run past its CONNECTIVITY)
    import os, tempfile
    from vtkmodules.vtkIOLegacy import vtkPolyDataReader
    text = (
        "# vtk DataFile Version 5.1\\ncrafted\\nASCII\\nDATASET POLYDATA\\nPOINTS 4 float\\n"
        "0 0 0 1 0 0 0 1 0 0 0 1\\n" + cells
    )
    handle, path = tempfile.mkstemp(suffix=".vtk")
    with os.fdopen(handle, "w") as stream:
        stream.write(text)
    reader = vtkPolyDataReader()
    reader.SetFileName(path)
    reader.Update()
    os.unlink(path)
    assert reader.GetOutput().GetNumberOfPoints() == 4
    return reader.GetOutput()

case = sys.argv[2]
data = {
    "id-equal-count": lambda: mesh("poly", [0, 3, 6], [0, 1, 2, 0, 1, 4]),
    "id-minus-one": lambda: mesh("poly", [0, 3, 6], [0, 1, 2, 3, 1, -1]),
    "id-huge-negative": lambda: mesh("poly", [0, 3], [0, -100000000, 2]),
    "strip-large-id": lambda: mesh("strip", [0, 5], [0, 1, 2, 3, 90000000]),
    "quad-large-id": lambda: mesh("poly", [0, 4], [0, 1, 2, 90000000]),
    "offset-start-nonzero": lambda: mesh("poly", [1, 4], [0, 1, 2, 3]),
    "offset-end-beyond": lambda: mesh("poly", [0, 3, 3000000], [0, 1, 2]),
    "offset-end-short": lambda: mesh("poly", [0, 3], [0, 1, 2, 3, 1, 2]),
    "offset-decreasing": lambda: mesh("poly", [0, -3000000, 3], [0, 1, 2]),
    "offset-not-monotonic": lambda: mesh("poly", [0, 4, 2, 6], [0, 1, 2, 3, 0, 1]),
    "strip-offset-beyond": lambda: mesh("strip", [0, 3000000], [0, 1, 2]),
    "legacy-file": lambda: legacy_file(),
    # VTK 9.6 keeps the declared type: a vtkBitArray (or float) cell array the filters would read as IDs
    "legacy-bit-cells": lambda: legacy_file("POLYGONS 2 3\\nOFFSETS bit\\n0 1\\nCONNECTIVITY bit\\n0 1 1\\n"),
    "legacy-float-cells": lambda: legacy_file(
        "POLYGONS 2 3\\nOFFSETS float\\n0 3\\nCONNECTIVITY float\\n0 1 1e30\\n"
    ),
}[case]()
sphere = vtkSphereSource()
sphere.Update()

class Scene:
    def visible_model_nodes(self):
        return ["vtkMRMLModelNode1", "vtkMRMLModelNode2"]
    def node_id(self, node):
        return node
    def name(self, node):
        return node
    def polydata(self, node):
        return data if node == "vtkMRMLModelNode1" else sphere.GetOutput()
    def display_props(self, node):
        return (1.0, 1.0, 1.0), 1.0, True
    def world_matrix(self, node):
        return np.eye(4)

result = collect_scene(Scene())
print([e.node_id for e in result.entities], [(s.node_id, s.reason.value) for s in result.skipped])
"""


@pytest.mark.parametrize(
    "case",
    [
        "id-equal-count",
        "id-minus-one",
        "id-huge-negative",
        "strip-large-id",
        "quad-large-id",
        "offset-start-nonzero",
        "offset-end-beyond",
        "offset-end-short",
        "offset-decreasing",
        "offset-not-monotonic",
        "strip-offset-beyond",
        "legacy-file",
        "legacy-bit-cells",
        "legacy-float-cells",
    ],
)
def test_collect_cells_with_missing_points_are_skipped_not_crashing(case):
    """VTK's filters do not bounds-check point IDs: a corrupt or crafted file would crash Slicer (heap write).
    Run in a subprocess, so a regression fails this test instead of killing pytest."""
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-W",
            "error",
            "-c",
            _CRAFTED_CELLS,
            str(Path(collect.__file__).parents[1]),
            case,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert result.stdout.strip() == (
        "['vtkMRMLModelNode2'] [('vtkMRMLModelNode1', 'invalid-geometry')]"
    )


@pytest.mark.parametrize(
    ("offsets_type", "connectivity_type"),
    [
        (vtkBitArray, vtkBitArray),
        (vtkFloatArray, vtkFloatArray),
        (vtkDoubleArray, vtkDoubleArray),
        (
            vtkIdTypeArray,
            vtkFloatArray,
        ),  # VTK 9.6 also accepts mixed storage: both arrays are checked
        (vtkFloatArray, vtkIdTypeArray),
    ],
)
def test_collect_cells_not_stored_as_integers_are_skipped(offsets_type, connectivity_type):
    """vtkCellArray.SetData takes any vtkDataArray (VTK 9.6 generic storage); only integer IDs are IDs."""
    offsets, connectivity = offsets_type(), connectivity_type()
    for value in (0, 1):
        offsets.InsertNextValue(value)
    connectivity.InsertNextValue(1)
    cells = vtkCellArray()
    cells.SetData(offsets, connectivity)
    data = _polydata([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
    data.SetPolys(cells)
    with pytest.raises(collect.InvalidMeshError, match="not integer"):
        mesh_from_polydata(data)
    collected = collect_scene(FakeScene(FakeNode("vtkMRMLModelNode1", data)))
    assert collected.skipped == (SkippedNode("vtkMRMLModelNode1", SkipReason.INVALID_GEOMETRY),)


def test_collect_malformed_adapter_values_never_abort():
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere(), visible=np.array([1, 0])),
        FakeNode("vtkMRMLModelNode2", _sphere(), name=5),  # not a name: the substitute instead
        FakeNode("vtkMRMLModelNode3", _cube()),
        FakeNode("vtkMRMLModelNode4", vtkUnstructuredGrid()),  # not a vtkPolyData: no mesh
        FakeNode("vtkMRMLModelNode5", "mesh"),
    )
    collected = collect_scene(scene)
    assert [(e.node_id, e.name) for e in collected.entities] == [
        ("vtkMRMLModelNode2", "Model 1"),
        ("vtkMRMLModelNode3", "Model"),
    ]
    assert collected.skipped == (
        SkippedNode("vtkMRMLModelNode1", SkipReason.INVALID_DISPLAY),
        SkippedNode("vtkMRMLModelNode4", SkipReason.NO_TRIANGLES),
        SkippedNode("vtkMRMLModelNode5", SkipReason.NO_TRIANGLES),
    )


def test_collect_hide_node_names_exports_only_generated_ids():
    """With Hide node names a hand-edited ID (which could carry a name) never leaves the PC (T7)."""
    hand_edited = [
        "Kowalski.Jan.1950-01-01",
        "KowalskiJan19500101",
        # the generated prefix alone is not enough: the whole ID must be the generated shape
        "vtkMRMLModelNode7Kowalski",
        "vtkMRMLModelNodeKowalski",
        "vtkMRMLModelNode7.Jan",
        "vtkMRMLModelNode12345678901",  # 11 digits: longer than Slicer's counter
    ]
    scene = FakeScene(
        *(FakeNode(node_id, _sphere(), name="Jan Kowalski") for node_id in hand_edited),
        FakeNode("vtkMRMLModelNode7", _cube(), name="Jan Kowalski"),
    )
    hidden = collect_scene(scene, anonymize_names=True)
    assert [(e.node_id, e.name) for e in hidden.entities] == [("vtkMRMLModelNode7", "Model 1")]
    assert hidden.skipped == (SkippedNode("", SkipReason.INVALID_NODE_ID),) * len(hand_edited)
    assert [s.index for s in hidden.skipped] == list(range(len(hand_edited)))
    glb = write_glb(hidden.entities, _root(True))
    assert b"Kowalski" not in glb and b"Jan" not in glb
    shown = collect_scene(scene)
    assert [e.node_id for e in shown.entities] == [*hand_edited, "vtkMRMLModelNode7"]


def test_collect_duplicate_ids_and_non_finite_points_are_skipped():
    nan_mesh = _polydata([[0, 0, 0], [np.nan, 0, 0], [0, 1, 0]], polys=[(0, 1, 2)])
    # finite in mm (float64), but 1e39 m overflows the float32 the GLB stores
    huge = _polydata([[0, 0, 0], [1e42, 0, 0], [0, 1, 0]], polys=[(0, 1, 2)])
    scene = FakeScene(
        FakeNode("vtkMRMLModelNode1", _sphere()),
        FakeNode("vtkMRMLModelNode1", _cube()),
        FakeNode("vtkMRMLModelNode2", nan_mesh),
        FakeNode("vtkMRMLModelNode3", huge),
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode1"]
    assert collected.skipped == (
        SkippedNode("vtkMRMLModelNode1", SkipReason.DUPLICATE_NODE_ID),
        SkippedNode("vtkMRMLModelNode2", SkipReason.INVALID_GEOMETRY),
        SkippedNode("vtkMRMLModelNode3", SkipReason.INVALID_GEOMETRY),
    )


def test_collect_display_values_are_clamped():
    [entity] = collect_entities(
        FakeScene(
            FakeNode("vtkMRMLModelNode1", _sphere(), color=(1.2, -0.1, 0.5), opacity=1.5, visible=0)
        )
    )
    assert entity.color == (1.0, 0.0, 0.5) and entity.opacity == 1.0 and entity.visible is False
    assert all(type(c) is float for c in entity.color) and type(entity.opacity) is float


# --------------------------------------------------------------------------- input untouched (criterion 3)


def test_collect_leaves_the_input_polydata_unchanged():
    inputs = [_sphere(), _cube()]
    line = vtkLineSource()
    line.SetPoint1(0, 0, 0)
    line.SetPoint2(5, 5, 5)
    line.Update()
    append = vtkAppendPolyData()  # triangles + a line + stored normals in one input
    append.AddInputData(_sphere(center=(0, 0, 0)))
    append.AddInputData(line.GetOutput())
    append.Update()
    inputs.append(append.GetOutput())
    before = [_snapshot(p) for p in inputs]
    scene = FakeScene(*(FakeNode(f"vtkMRMLModelNode{i}", p) for i, p in enumerate(inputs)))
    entities = collect_entities(scene)
    assert [_snapshot(p) for p in inputs] == before
    for polydata, entity in zip(inputs, entities, strict=True):
        source_points = vtk_to_numpy(polydata.GetPoints().GetData())
        assert not np.shares_memory(source_points, entity.positions)
        assert not np.shares_memory(source_points, entity.indices)


def _outward(mesh) -> float:
    radial = mesh.positions / np.linalg.norm(mesh.positions, axis=1)[:, None]
    return float(np.einsum("ij,ij->i", mesh.normals, radial).min())


def test_collect_recomputes_stored_normals():
    """vtkPolyDataNormals returns stored float normals unchanged; collect never uses them (research note §2)."""
    sphere = _sphere(center=(0.0, 0.0, 0.0))
    wrong = numpy_to_vtk(
        np.tile([1.0, 0.0, 0.0], (sphere.GetNumberOfPoints(), 1)).astype(np.float32), deep=True
    )
    wrong.SetName("Normals")
    sphere.GetPointData().SetNormals(wrong)
    assert _outward(mesh_from_polydata(sphere)) > 0.99


def test_collect_lines_and_vertices_never_bend_the_normals():
    """Lines and vertices that share mesh points would mix the normal (1, 0, 0) into those points."""
    sphere = _sphere(center=(0.0, 0.0, 0.0))
    points = vtk_to_numpy(sphere.GetPoints().GetData())
    polys = vtk_to_numpy(sphere.GetPolys().GetConnectivityArray()).reshape(-1, 3)
    plain = mesh_from_polydata(_polydata(points, polys=[tuple(t) for t in polys]))
    shared = _polydata(
        points,
        polys=[tuple(t) for t in polys],
        lines=[(0, 5), (5, 20), (1, 2, 3)],
        verts=[(7,), (8,)],
    )
    mesh = mesh_from_polydata(shared)
    np.testing.assert_array_equal(mesh.triangles, plain.triangles)
    np.testing.assert_allclose(mesh.normals, plain.normals, atol=1e-12)
    assert _outward(mesh) > 0.99


def test_collect_does_not_split_points_at_sharp_edges():
    """§7.4 SplittingOff: a cube of 8 shared corners keeps 8 points (splitting would make 24)."""
    corners = [[x, y, z] for x in (0.0, 10.0) for y in (0.0, 10.0) for z in (0.0, 10.0)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = mesh_from_polydata(_polydata(corners, polys=quads))
    assert len(mesh.positions) == 8 and mesh.triangles.shape == (12, 3)


def test_collect_working_copy_has_geometry_only():
    """Attribute arrays (scalars, texture coordinates, a cell array shorter than the cells) never reach the
    filters; the triangle filter would copy a short cell array out of bounds."""
    cube = _cube()
    short = numpy_to_vtk(np.zeros(1, dtype=np.float32), deep=True)
    short.SetName("Short")
    cube.GetCellData().AddArray(short)
    copy = collect._geometry_copy(cube)
    assert copy.GetPointData().GetNumberOfArrays() == 0
    assert copy.GetCellData().GetNumberOfArrays() == 0
    assert copy.GetFieldData().GetNumberOfArrays() == 0
    assert copy.GetVerts().GetNumberOfCells() == 0 and copy.GetLines().GetNumberOfCells() == 0
    assert copy.GetNumberOfPoints() == cube.GetNumberOfPoints()
    assert copy.GetPolys().GetNumberOfCells() == cube.GetPolys().GetNumberOfCells()
    assert mesh_from_polydata(cube).triangles.shape == (12, 3)


def test_collect_filters_run_on_the_working_copy(monkeypatch):
    """The triangle filter reads the geometry-only copy, never the caller's polydata (whose attribute arrays it
    would copy without a bounds check)."""
    inputs = []

    class SpyTriangleFilter(collect.vtkTriangleFilter):
        def SetInputData(self, data):  # noqa: N802 — VTK method name
            inputs.append(data)
            super().SetInputData(data)

    monkeypatch.setattr(collect, "vtkTriangleFilter", SpyTriangleFilter)
    cube = _cube()
    assert (
        cube.GetPointData().GetNumberOfArrays() > 0
    )  # vtkCubeSource adds normals and texture coordinates
    assert mesh_from_polydata(cube).triangles.shape == (12, 3)
    [data] = inputs
    assert data is not cube
    assert (
        data.GetPointData().GetNumberOfArrays() == 0 and data.GetCellData().GetNumberOfArrays() == 0
    )


def test_collect_drops_degenerate_triangles_and_unused_points():
    data = _polydata(
        [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 5], [9, 9, 9]],
        polys=[(0, 1, 2), (3, 3, 4), (3, 4, 3)],  # the others repeat a vertex: zero area
    )
    mesh = mesh_from_polydata(data)
    np.testing.assert_array_equal(mesh.triangles, [[0, 1, 2]])
    assert len(mesh.positions) == 3 and np.all(np.isfinite(mesh.normals))
    np.testing.assert_allclose(np.linalg.norm(mesh.normals, axis=1), 1.0, atol=1e-6)


def test_collect_drops_triangles_without_area():
    """Collinear points: no area, no normal. Left in as the lowest-ID triangle, it seeded ConsistencyOn and turned the
    real triangle over (its normal came out −S), and the point only it used got a zero normal."""
    data = _polydata([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0]], polys=[(0, 1, 2), (0, 1, 3)])
    mesh = mesh_from_polydata(data)
    np.testing.assert_array_equal(mesh.triangles, [[0, 1, 2]])  # (0, 1, 3) without point 2
    np.testing.assert_allclose(
        mesh.normals, np.tile([0.0, 0.0, 1.0], (3, 1)), atol=1e-6
    )  # its own winding


def test_collect_mesh_from_triangles_drops_triangles_that_are_not_there():
    """The public helper (SLC-14 decimation output): IDs out of range or repeated are dropped, never read."""
    positions = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0]])
    mesh = collect.mesh_from_triangles(
        positions, np.array([[0, 1, 2], [0, 1, 7], [-1, 0, 1], [1, 1, 2]])
    )
    np.testing.assert_array_equal(mesh.triangles, [[0, 1, 2]])
    assert collect.mesh_from_triangles(positions, np.array([[0, 1, 9]])) is None
    assert collect.mesh_from_triangles(positions, np.empty((0, 3))) is None


def test_collect_exports_a_mesh_whose_normals_cancel_out():
    """Two triangles folded flat onto each other, wound consistently: their normals cancel where they meet. The node is
    exported — ``ras_to_gltf_normals`` makes a zero normal glTF +Y, so every normal written is a unit vector."""
    folded = _polydata([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 1, 0]], polys=[(0, 1, 2), (1, 0, 3)])
    mesh = mesh_from_polydata(folded)
    np.testing.assert_allclose(np.linalg.norm(mesh.normals[:2], axis=1), 0.0)  # cancelled
    collected = collect_scene(FakeScene(FakeNode("vtkMRMLModelNode1", folded)))
    [entity] = collected.entities
    assert collected.skipped == ()
    np.testing.assert_allclose(np.linalg.norm(entity.normals, axis=1), 1.0, atol=1e-6)
    np.testing.assert_allclose(entity.normals[:2], [[0.0, 1.0, 0.0]] * 2)
    write_glb([entity], _root())


@pytest.mark.parametrize(
    ("points", "world", "transform"),
    [
        ([[0, 0, 0], [np.inf, 0, 0], [0, 1, 0]], np.eye(4), None),
        ([[0, 0, 0], [-np.inf, 0, 0], [0, np.nan, 0]], SHEAR, None),
        ([[0, 0, 0], [1e200, 0, 0], [0, 1e200, 0]], np.eye(4), None),
        ([[0, 0, 0], [1, 0, 0], [0, 1, 0]], None, np.diag([1e300, 1e300, 1.0, 1.0])),
        ([[0, 0, 0], [1, 0, 0], [0, 1, 0]], None, np.full((4, 4), np.nan)),
    ],
    ids=["inf", "-inf-and-nan-sheared", "1e200-mm", "overflow-on-two-axes", "nan-transform"],
)
def test_collect_untrusted_coordinates_skip_the_node_without_a_warning(points, world, transform):
    """A crafted file or transform with inf, NaN or huge values: the node is skipped, nothing warns (the suite runs
    with ``-W error``, so a RuntimeWarning would fail the whole snapshot here)."""
    transform = None if transform is None else _linear(transform)
    scene = FakeScene(
        FakeNode(
            "vtkMRMLModelNode1",
            _polydata(points, polys=[(0, 1, 2)]),
            world=world,
            transform=transform,
        ),
        FakeNode("vtkMRMLModelNode2", _cube()),
    )
    collected = collect_scene(scene)
    assert [e.node_id for e in collected.entities] == ["vtkMRMLModelNode2"]
    assert [s.node_id for s in collected.skipped] == ["vtkMRMLModelNode1"]
    assert collected.skipped[0].reason is SkipReason.INVALID_GEOMETRY


def _faces_and_normals_outward(mesh) -> tuple[float, float]:
    """The smallest outward component of the face normals (from the winding) and of the point normals of a mesh
    centred at the origin."""
    p, t = mesh.positions, mesh.triangles
    a, b, c = p[t[:, 0]], p[t[:, 1]], p[t[:, 2]]
    faces = np.einsum("ij,ij->i", np.cross(b - a, c - a), (a + b + c) / 3)
    return float(faces.min()), _outward(mesh)


@pytest.mark.parametrize("at", [0, 20, -1])
def test_collect_degenerate_triangles_never_turn_the_mesh_inside_out(at):
    """A triangle (a, b, b) on an edge a→b of the mesh runs that edge both ways: left in front of ConsistencyOn it
    reversed hundreds of the sphere's triangles and their normals (SLC-07 review)."""
    sphere = _sphere(center=(0.0, 0.0, 0.0))
    points = vtk_to_numpy(sphere.GetPoints().GetData())
    polys = [
        tuple(t) for t in vtk_to_numpy(sphere.GetPolys().GetConnectivityArray()).reshape(-1, 3)
    ]
    a, b, _ = polys[5]
    polys.insert(len(polys) if at == -1 else at, (a, b, b))
    mesh = mesh_from_polydata(_polydata(points, polys=polys))
    assert len(mesh.triangles) == len(polys) - 1
    faces, normals = _faces_and_normals_outward(mesh)
    assert faces > 0 and normals > 0.99


def test_collect_stitched_triangle_strip_stays_outward():
    """One strip stitched from many with repeated vertices (a common export format) decomposes into degenerate
    triangles between the real ones; the mesh must still face outward."""
    stripper = vtkStripper()
    stripper.SetInputData(_sphere(center=(0.0, 0.0, 0.0)))
    stripper.Update()
    strips = stripper.GetOutput().GetStrips()
    offsets = vtk_to_numpy(strips.GetOffsetsArray())
    connectivity = vtk_to_numpy(strips.GetConnectivityArray())
    stitched: list[int] = []
    for start, end in itertools.pairwise(offsets):
        if stitched:
            if (
                len(stitched) % 2
            ):  # keep the next strip's parity, so its triangles keep their winding
                stitched.append(stitched[-1])
            stitched += [stitched[-1], connectivity[start]]
        stitched += list(connectivity[start:end])
    cells = vtkCellArray()
    cells.SetData(
        numpy_to_vtkIdTypeArray(np.array([0, len(stitched)], dtype=np.int64), deep=True),
        numpy_to_vtkIdTypeArray(np.array(stitched, dtype=np.int64), deep=True),
    )
    data = _polydata(vtk_to_numpy(stripper.GetOutput().GetPoints().GetData()))
    data.SetStrips(cells)
    mesh = mesh_from_polydata(data)
    assert len(offsets) > 10 and stripper.GetOutput().GetPolys().GetNumberOfCells() == 0
    assert len(mesh.triangles) == _sphere().GetNumberOfPolys()
    faces, normals = _faces_and_normals_outward(mesh)
    assert faces > 0 and normals > 0.99


def test_collect_keeps_double_precision_points():
    """vtkPoints.DeepCopy converts to the copy's type: without SetDataType a double mesh lost its precision."""
    data = _polydata([[1.0 + 1e-9, 0, 0], [0, 1.0 + 2e-9, 0], [0, 0, 1.0]], polys=[(0, 1, 2)])
    assert data.GetPoints().GetDataType() == VTK_DOUBLE
    assert collect._geometry_copy(data).GetPoints().GetDataType() == VTK_DOUBLE
    np.testing.assert_array_equal(
        mesh_from_polydata(data).positions, vtk_to_numpy(data.GetPoints().GetData())
    )
    assert (
        collect._geometry_copy(_sphere()).GetPoints().GetDataType()
        == _sphere().GetPoints().GetDataType()
    )


def test_collect_mixed_cell_sizes_keep_only_triangles():
    """The triangle filter's fast path lets 2-point 'polygons' through; they are dropped, triangles kept."""
    data = _polydata([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], polys=[(0, 1, 2), (2, 3)])
    mesh = mesh_from_polydata(data)
    np.testing.assert_array_equal(mesh.triangles, [[0, 1, 2]])


def test_collect_makes_inconsistent_winding_consistent():
    sphere = _sphere(center=(0.0, 0.0, 0.0), resolution=24)
    polys = vtk_to_numpy(sphere.GetPolys().GetConnectivityArray()).reshape(-1, 3).copy()
    polys[1::7] = polys[
        1::7, ::-1
    ]  # flip every 7th triangle (not the first: it seeds the orientation)
    cells = vtkCellArray()
    offsets = numpy_to_vtkIdTypeArray(np.arange(0, polys.size + 1, 3, dtype=np.int64), deep=True)
    cells.SetData(offsets, numpy_to_vtkIdTypeArray(polys.ravel().astype(np.int64), deep=True))
    sphere.SetPolys(cells)
    mesh = mesh_from_polydata(sphere)
    p = mesh.positions
    a, b, c = p[mesh.triangles[:, 0]], p[mesh.triangles[:, 1]], p[mesh.triangles[:, 2]]
    face_normals = np.cross(b - a, c - a)
    outward = np.einsum("ij,ij->i", face_normals, (a + b + c) / 3)
    assert np.all(outward > 0)  # every triangle wound outward again


# --------------------------------------------------------------------------- determinism and purity


def test_collect_is_deterministic():
    def glb() -> bytes:
        scene = FakeScene(
            FakeNode("vtkMRMLModelNode4", _sphere(), name="Skull"),
            FakeNode("vtkMRMLModelNode5", _cube(), name="Box"),
        )
        return write_glb(collect_entities(scene), _root())

    assert glb() == glb()


def test_collect_result_types():
    collected = collect_scene(FakeScene())
    assert collected == CollectedScene((), (), False)
    assert isinstance(collect_entities(FakeScene()), list)
    assert {r.value for r in SkipReason} == {
        "invalid-node-id",
        "duplicate-node-id",
        "no-triangles",
        "invalid-geometry",
        "invalid-display",
        "invalid-transform",
        "non-linear-transform",
    }


def test_collect_imports_no_slicer_qt_or_rendering():
    """What `import remoteview_core.collect` really loads: VTK data/filter modules only (no Qt, no rendering)."""
    code = (
        "import sys; sys.path.append(sys.argv[1]); import remoteview_core.collect\n"
        "print(sorted(m for m in sys.modules if m.split('.')[0] in {'slicer', 'qt', 'ctk', 'websockets', 'segno'}"
        " or 'Rendering' in m or 'Qt' in m))\n"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", code, str(Path(collect.__file__).parents[1])],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


def test_collect_output_always_writes():
    """Seeded fuzz: whatever an adapter hands over, the collected entities write (skips never abort, §7)."""
    rng = np.random.default_rng(2026)
    ids = ["vtkMRMLModelNode1", "vtkMRMLModelNode2", "root", "a/b", "Kowalski1", "x y", "", 7]
    names = ["Liver", "", None, b"P\xb3", 5, "Model 1", "x" * 90, "\x07"]
    meshes = [
        _sphere,
        _cube,
        lambda: None,
        vtkPolyData,
        lambda: _polydata([[0, 0, 0], [np.inf, 0, 0], [0, 1e200, 0]], polys=[(0, 1, 2)]),
    ]
    worlds = [
        np.eye(4),
        None,
        np.diag([1.0, 2.0, 3.0, 1.0]),
        np.full((4, 4), np.nan),
        "x",
        SHEAR @ MIRROR,
        np.diag([1.0, 0.0, 1.0, 1.0]),
    ]
    transforms = [
        None,
        _tps(),
        _linear(MIRROR),
        _linear(np.diag([1e300, 1.0, 1.0, 1.0])),
        _linear(np.full((4, 4), np.nan)),
        "x",
    ]
    for _ in range(60):
        nodes = [
            FakeNode(
                ids[rng.integers(len(ids))],
                meshes[rng.integers(len(meshes))](),
                name=names[rng.integers(len(names))],
                color=tuple(rng.uniform(-0.5, 1.5, size=3)),
                opacity=float(rng.uniform(-1, 2)),
                world=worlds[rng.integers(len(worlds))],
                transform=transforms[rng.integers(len(transforms))],
            )
            for _ in range(int(rng.integers(0, 5)))
        ]
        for anonymize in (False, True):
            collected = collect_scene(FakeScene(*nodes), anonymize_names=anonymize)
            write_glb(collected.entities, _root(collected.anonymized_names))
