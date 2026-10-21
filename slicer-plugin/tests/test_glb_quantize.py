"""SLC-12: KHR_mesh_quantization in the GLB writer (FR-09, docs/protocol.md §7.2; glTF 2.0 §3.6.2.4)."""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest
from pygltflib import GLTF2
from support import FakeScene, needs_validator, sphere, validate_glb

from remoteview_core import glb_writer as writer
from remoteview_core.collect import collect_scene
from remoteview_core.glb_writer import Entity, RootExtras, size_report, write_glb

ROOT = RootExtras(scene_version=3, profile="quest3", slicer_version="5.12.4")
COMPONENT = {5120: "i1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}


def ellipsoid(
    node_id: str = "vtkMRMLModelNode7",
    *,
    radii=(0.30, 0.05, 0.12),
    center=(0.4, -1.2, 0.05),
    steps: int = 48,
    **fields,
) -> Entity:
    """An ellipsoid off the origin with unequal radii (the largest along x): a uniform step and the offset both
    matter, and an axis mix-up shows."""
    theta, phi = np.meshgrid(
        np.linspace(0, np.pi, steps), np.linspace(0, 2 * np.pi, steps, endpoint=False)
    )
    unit = np.c_[
        (np.sin(theta) * np.cos(phi)).ravel(),
        (np.sin(theta) * np.sin(phi)).ravel(),
        np.cos(theta).ravel(),
    ]
    points = unit * radii + center
    normals = unit / np.asarray(radii) ** 2
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    i = (np.arange(steps - 1)[:, None] * steps + np.arange(steps)[None, :]).ravel()
    j = (i // steps) * steps + (i % steps + 1) % steps
    tris = np.r_[np.c_[i, j, i + steps], np.c_[j, j + steps, i + steps]]
    entity = dict(
        node_id=node_id,
        kind="model",
        name="Ellipsoid",
        positions=points,
        normals=normals,
        indices=tris,
        color=(0.7, 0.2, 0.1),
        opacity=1.0,
        visible=True,
        mrml_id=node_id,
    )
    entity.update(fields)
    return Entity(**entity)


def vtk_sphere_entity(resolution: int) -> Entity:
    """A ``vtkSphereSource`` model (radius 20 mm) through the real collection: normals and glTF space as exported."""
    [entity] = collect_scene(
        FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(resolution)})
    ).entities
    return entity


def parse(glb: bytes) -> tuple[dict, bytes]:
    json_length = struct.unpack_from("<I", glb, 12)[0]
    document = json.loads(glb[20 : 20 + json_length])
    return document, glb[20 + json_length + 8 :]


def attribute(document: dict, binary: bytes, accessor_index: int) -> np.ndarray:
    """An accessor's elements as stored (strided views included)."""
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    dtype = np.dtype(COMPONENT[accessor["componentType"]])
    width = {"VEC3": 3, "SCALAR": 1}[accessor["type"]]
    stride = view.get("byteStride", dtype.itemsize * width)
    start = view["byteOffset"] + accessor.get("byteOffset", 0)
    rows = [
        np.frombuffer(binary, dtype=dtype, count=width, offset=start + k * stride)
        for k in range(accessor["count"])
    ]
    return np.array(rows)


def mesh_parts(document: dict, binary: bytes, entity_index: int = 0):
    """``(T, M, positions as stored, normals as stored, primitive)`` of the n-th entity."""
    t_node = document["nodes"][1 + 2 * entity_index]
    m_node = document["nodes"][t_node["children"][0]]
    primitive = document["meshes"][m_node["mesh"]]["primitives"][0]
    positions = attribute(document, binary, primitive["attributes"]["POSITION"])
    normals = attribute(document, binary, primitive["attributes"]["NORMAL"])
    return t_node, m_node, positions, normals, primitive


def dequantized(m_node: dict, stored: np.ndarray) -> np.ndarray:
    matrix = np.array(m_node["matrix"], dtype=np.float64).reshape(4, 4).T  # column-major
    return (np.c_[stored.astype(np.float64), np.ones(len(stored))] @ matrix.T)[:, :3]


# --------------------------------------------------------------------------- criterion 1: accuracy


def test_quantize_positions_are_within_half_a_step_and_1e5_m():
    entity = ellipsoid()
    document, binary = parse(write_glb([entity], ROOT, quantize=True))
    _, m_node, stored, _, _ = mesh_parts(document, binary)
    step = m_node["matrix"][0]
    original = np.asarray(entity.positions)
    lo, hi = original.min(axis=0), original.max(axis=0)
    # one step for all axes, set by the largest extent (≈ 0.6 m along x)
    assert np.argmax(hi - lo) == 0 and step == pytest.approx((hi - lo).max() / 65_534, rel=1e-6)
    assert m_node["matrix"][5] == m_node["matrix"][10] == step
    error = np.abs(dequantized(m_node, stored) - original)
    assert error.max() <= step / 2 + 1e-9 and error.max() <= 1e-5  # FR-09, §7.2
    # the offset is the bounding-box centre, so the largest axis uses the whole range
    assert stored[:, 0].min() == -32_767 and stored[:, 0].max() == 32_767
    assert m_node["matrix"][12:15] == pytest.approx((lo + hi) / 2, abs=1e-7)


def test_quantize_normals_are_within_one_degree():
    entity = ellipsoid()
    document, binary = parse(write_glb([entity], ROOT, quantize=True))
    _, _, _, stored, primitive = mesh_parts(document, binary)
    accessor = document["accessors"][primitive["attributes"]["NORMAL"]]
    assert accessor["componentType"] == writer.BYTE and accessor["normalized"] is True
    decoded = np.maximum(stored.astype(np.float64) / 127.0, -1.0)  # glTF's rule for normalised BYTE
    decoded /= np.linalg.norm(decoded, axis=1)[:, None]
    cosine = np.clip((decoded * np.asarray(entity.normals)).sum(axis=1), -1.0, 1.0)
    assert np.degrees(np.arccos(cosine)).max() <= 1.0
    assert stored.min() >= -127 and stored.max() <= 127  # -128 is never written
    # the encoding of the extension's table: round(n × 127), from the float32 normals the file would hold
    expected = np.rint(np.asarray(entity.normals, dtype=np.float32).astype(np.float64) * 127.0)
    np.testing.assert_array_equal(stored, expected)


def test_quantize_keeps_t_for_the_world_transform_and_puts_only_the_dequantisation_on_m():
    moved = np.eye(4)
    moved[:3, 3] = (0.01, 0.02, -0.03)
    document, _ = parse(write_glb([ellipsoid(matrix=moved)], ROOT, quantize=True))
    t_node = document["nodes"][1]
    m_node = document["nodes"][t_node["children"][0]]
    assert t_node["matrix"][12:15] == pytest.approx(
        [0.01, 0.02, -0.03]
    )  # updates (§8) replace this one
    assert set(m_node) == {"mesh", "matrix"}  # no name, no extras
    matrix = np.array(m_node["matrix"]).reshape(4, 4).T
    assert np.allclose(matrix[:3, :3], np.eye(3) * matrix[0, 0]) and matrix[0, 0] > 0
    assert writer.is_exportable_matrix(matrix)  # a TRS matrix, also in float32


def test_quantize_off_writes_floats_and_no_m_matrix():
    document, _ = parse(write_glb([ellipsoid()], ROOT))
    m_node = document["nodes"][2]
    assert "matrix" not in m_node and "extensionsUsed" not in document
    accessor = document["accessors"][
        document["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
    ]
    assert accessor["componentType"] == writer.FLOAT


# --------------------------------------------------------------------------- criterion 2: a valid file


def test_quantize_declares_the_extension_and_aligns_every_vertex():
    glb = write_glb([ellipsoid(), vtk_sphere_entity(16)], ROOT, quantize=True)
    document, binary = parse(glb)
    assert document["extensionsUsed"] == document["extensionsRequired"] == ["KHR_mesh_quantization"]
    for view in document["bufferViews"]:
        assert view["byteOffset"] % 4 == 0 and view.get("byteStride", 4) % 4 == 0
    for k in range(2):
        _, _, positions, _, primitive = mesh_parts(document, binary, k)
        position = document["accessors"][primitive["attributes"]["POSITION"]]
        normal = document["accessors"][primitive["attributes"]["NORMAL"]]
        assert (position["componentType"], position.get("normalized", False)) == (
            writer.SHORT,
            False,
        )
        assert document["bufferViews"][position["bufferView"]]["byteStride"] == 8
        assert document["bufferViews"][normal["bufferView"]]["byteStride"] == 4
        # min/max are those of the stored integers (glTF: POSITION needs them)
        assert position["min"] == positions.min(axis=0).tolist()
        assert position["max"] == positions.max(axis=0).tolist()
        assert all(isinstance(v, int) for v in position["min"] + position["max"])
    gltf = GLTF2.load_from_bytes(glb)  # a second reader
    assert gltf.extensionsRequired == ["KHR_mesh_quantization"] and len(gltf.meshes) == 2


@needs_validator
def test_quantize_output_passes_the_khronos_validator(tmp_path):
    files = {
        "quantized.glb": write_glb([ellipsoid(), vtk_sphere_entity(32)], ROOT, quantize=True),
        # 260 × 258 + 2 = 67,082 vertices: UNSIGNED_INT indices
        "big.glb": write_glb([vtk_sphere_entity(260)], ROOT, quantize=True),
    }
    document, _ = parse(files["big.glb"])
    indices = document["accessors"][document["meshes"][0]["primitives"][0]["indices"]]
    assert indices["componentType"] == writer.UNSIGNED_INT
    for name, report in validate_glb(tmp_path, files).items():
        assert report["numErrors"] == 0 and report["numWarnings"] == 0, name
        assert report["violations"] == [], name


def test_quantize_an_empty_scene_declares_no_extension():
    document, _ = parse(write_glb([], ROOT, quantize=True))
    assert "extensionsUsed" not in document and "extensionsRequired" not in document


def test_quantize_a_mesh_that_is_a_single_point_stays_invertible():
    point = Entity(
        node_id="vtkMRMLModelNode5",
        kind="model",
        name="Point",
        positions=np.tile([0.1, 0.2, 0.3], (3, 1)),
        normals=np.tile([0.0, 0.0, 1.0], (3, 1)),
        indices=np.array([[0, 1, 2]]),
        color=(0.0, 1.0, 0.0),
        opacity=1.0,
        visible=True,
        mrml_id="vtkMRMLModelNode5",
    )
    document, binary = parse(write_glb([point], ROOT, quantize=True))
    _, m_node, stored, _, _ = mesh_parts(document, binary)
    assert m_node["matrix"][0] == writer.MIN_POSITION_STEP and not stored.any()
    assert np.allclose(dequantized(m_node, stored), point.positions)
    assert np.float32(m_node["matrix"][0]) > 0  # still a scale on a float32 GPU


def test_quantize_is_deterministic():
    entities = [ellipsoid(), vtk_sphere_entity(24)]
    assert write_glb(entities, ROOT, quantize=True) == write_glb(entities, ROOT, quantize=True)


# --------------------------------------------------------------------------- criterion 3: size


def test_quantize_a_100k_triangle_sphere_halves_its_vertex_data():
    entity = vtk_sphere_entity(224)
    assert 99_000 <= entity.triangle_count <= 100_000
    floats = size_report(write_glb([entity], ROOT))
    quantized = size_report(write_glb([entity], ROOT, quantize=True))
    vertex_count = len(entity.positions)
    # 24 bytes per vertex (two float32 VEC3) become 12 (SHORT VEC3 + 2 bytes padding, BYTE VEC3 + 1)
    assert (floats.positions, floats.normals) == (12 * vertex_count, 12 * vertex_count)
    assert (quantized.positions, quantized.normals) == (8 * vertex_count, 4 * vertex_count)
    assert quantized.vertex_data <= 0.6 * floats.vertex_data  # ≥ 40 % smaller (criterion 3)
    # the indices are unchanged, so the whole file shrinks by about a third
    assert quantized.indices == floats.indices
    assert quantized.total <= 0.7 * floats.total


def test_size_report_counts_each_part_once():
    glb = write_glb([ellipsoid(), ellipsoid("vtkMRMLModelNode8")], ROOT, quantize=True)
    report = size_report(glb)
    document, binary = parse(glb)
    views = document["bufferViews"]
    assert report.positions + report.normals + report.indices == sum(v["byteLength"] for v in views)
    assert report.total == len(glb) and report.json == struct.unpack_from("<I", glb, 12)[0]
    assert len(binary) >= report.positions + report.normals + report.indices
    empty = size_report(write_glb([], ROOT))
    assert (empty.positions, empty.normals, empty.indices, empty.vertex_data) == (0, 0, 0, 0)
