"""SLC-04: GLB writer (docs/protocol.md §7.1–7.4; ADR 0005 Decision 1 and errata)."""

from __future__ import annotations

import ast
import hashlib
import json
import struct
import subprocess
import sys
import typing
from pathlib import Path

import numpy as np
import pytest
from pygltflib import GLTF2
from support import needs_validator, validate_glb

from remoteview_core import (
    __version__,
    vendored,
)  # vendored registers the protocol package (no __init__)
from remoteview_core import glb_writer as writer
from remoteview_core.coords import ras_matrix_to_gltf, ras_to_gltf_normals, ras_to_gltf_points
from remoteview_core.glb_writer import (
    Entity,
    GlbWriteError,
    RootExtras,
    is_exportable_matrix,
    write_glb,
)
from remoteview_protocol import generated

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parent
CORE_DIR = PLUGIN_ROOT / "RemoteView" / "remoteview_core"
ROOT = RootExtras(scene_version=7, profile="mobile", slicer_version="5.12.4")

# --------------------------------------------------------------------------- fixtures


def _tetra_ras() -> tuple[np.ndarray, np.ndarray]:
    """Asymmetric tetrahedron in RAS mm (vertices on +R at 100 mm, +S at 50 mm, +A at 100 mm), faces outward."""
    points = np.array([[0, 0, 0], [100, 0, 0], [0, 0, 50], [0, 100, 0]], dtype=np.float64)
    tris = np.array([[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]])
    return points, tris


def _vertex_normals(points: np.ndarray, tris: np.ndarray) -> np.ndarray:
    normals = np.zeros_like(points)
    for t in tris:
        normals[t] += np.cross(points[t[1]] - points[t[0]], points[t[2]] - points[t[0]])
    return normals / np.linalg.norm(normals, axis=1)[:, None]


def _grid(nx: int, ny: int) -> tuple[np.ndarray, np.ndarray]:
    """Flat (nx × ny)-vertex grid in the glTF x/z plane (normals +Y)."""
    xs, zs = np.meshgrid(np.linspace(0, 0.1, nx), np.linspace(0, 0.1, ny), indexing="ij")
    points = np.c_[xs.ravel(), np.zeros(nx * ny), zs.ravel()]
    i = (np.arange(nx - 1)[:, None] * ny + np.arange(ny - 1)[None, :]).ravel()
    tris = np.r_[np.c_[i, i + 1, i + ny], np.c_[i + 1, i + ny + 1, i + ny]]
    return points, tris


def _grid_entity(nx: int, ny: int, node_id: str = "vtkMRMLModelNode9") -> Entity:
    points, tris = _grid(nx, ny)
    return Entity(
        node_id=node_id,
        kind="model",
        name="Grid",
        positions=points,
        normals=np.tile([0.0, 1.0, 0.0], (len(points), 1)),
        indices=tris,
        color=(0.2, 0.4, 0.6),
        opacity=1.0,
        visible=True,
        mrml_id=node_id,
    )


def _liver(**overrides) -> Entity:
    points, tris = _tetra_ras()
    fields = dict(
        node_id="vtkMRMLSegmentationNode1/Segment_2",
        kind="segment",
        name="Liver",
        positions=ras_to_gltf_points(points),
        normals=ras_to_gltf_normals(_vertex_normals(points, tris)),
        indices=tris,
        color=(0.8, 0.33, 0.27),
        opacity=1.0,
        visible=True,
        mrml_id="vtkMRMLSegmentationNode1",
        segment_id="Segment_2",
    )
    fields.update(overrides)
    return Entity(**fields)


def _tumor(**overrides) -> Entity:
    points, tris = _tetra_ras()
    translation = np.eye(4)
    translation[:3, 3] = (10, 20, 30)
    fields = dict(
        node_id="vtkMRMLModelNode3",
        kind="model",
        name="Tumor",
        positions=ras_to_gltf_points(points * 0.25),
        normals=ras_to_gltf_normals(_vertex_normals(points, tris)),
        indices=tris,
        color=(0.95, 0.85, 0.7),
        opacity=0.5,
        visible=False,
        mrml_id="vtkMRMLModelNode3",
        matrix=ras_matrix_to_gltf(translation),
    )
    fields.update(overrides)
    return Entity(**fields)


def _triangle(node_id: str = "vtkMRMLModelNode4") -> Entity:
    """One triangle: a 6-byte uint16 index block, so the next block needs alignment padding."""
    return Entity(
        node_id=node_id,
        kind="model",
        name="Marker",
        positions=np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.0, -0.01]]),
        normals=np.tile([0.0, 1.0, 0.0], (3, 1)),
        indices=np.array([[0, 2, 1]]),
        color=(1.0, 1.0, 0.0),
        opacity=1.0,
        visible=True,
        mrml_id=node_id,
    )


def _parse(glb: bytes) -> tuple[dict, bytes, bytes]:
    """Container checks of glTF 2.0 §4 + JSON document, BIN payload, raw JSON chunk."""
    magic, version, length = struct.unpack_from("<III", glb, 0)
    assert (magic, version, length) == (0x46546C67, 2, len(glb))
    json_len, json_type = struct.unpack_from("<II", glb, 12)
    assert json_type == 0x4E4F534A and json_len % 4 == 0
    text = glb[20 : 20 + json_len]
    stripped = text.rstrip(b" ")
    assert stripped.endswith(b"}") and len(text) - len(stripped) < 4  # padded with spaces only
    doc = json.loads(stripped)
    bin_start = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<II", glb, bin_start)
    assert bin_type == 0x004E4942 and bin_len % 4 == 0
    assert bin_start + 8 + bin_len == len(glb)
    return doc, glb[bin_start + 8 :], text


def _repack(doc: dict, binary: bytes) -> bytes:
    """GLB container around an edited document (for the broken-file tests of the validator helper)."""
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    return b"".join(
        [
            struct.pack("<III", 0x46546C67, 2, 28 + len(text) + len(binary)),
            struct.pack("<II", len(text), 0x4E4F534A),
            text,
            struct.pack("<II", len(binary), 0x004E4942),
            binary,
        ]
    )


def _accessor_array(doc: dict, binary: bytes, index: int) -> np.ndarray:
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    dtype = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[acc["componentType"]]
    width = {"VEC3": 3, "SCALAR": 1}[acc["type"]]
    start = view["byteOffset"] + acc.get("byteOffset", 0)
    return np.frombuffer(binary, dtype=dtype, count=acc["count"] * width, offset=start).reshape(
        -1, width
    )


@pytest.fixture(scope="module")
def two_node_glb() -> bytes:
    return write_glb([_liver(), _tumor()], ROOT)


@pytest.fixture(scope="module")
def odd_glb() -> bytes:
    """Odd-sized index blocks before other blocks: exercises inter-view and trailing BIN padding."""
    return write_glb([_triangle(), _liver(), _triangle("vtkMRMLModelNode5")], ROOT)


# --------------------------------------------------------------------------- container (criterion 1)


def test_glb_writer_container_padding_and_alignment(two_node_glb, odd_glb):
    for glb in (two_node_glb, odd_glb):
        doc, binary, _ = _parse(glb)
        assert doc["asset"] == {"version": "2.0", "generator": f"SlicerRemoteView {__version__}"}
        assert doc["scene"] == 0 and len(doc["scenes"]) == 1
        assert "extensionsUsed" not in doc and "extensionsRequired" not in doc
        assert doc["buffers"] == [{"byteLength": len(binary)}]
        end = 0
        for view in sorted(doc["bufferViews"], key=lambda v: v["byteOffset"]):
            assert view["byteOffset"] % 4 == 0 and view["buffer"] == 0
            assert binary[end : view["byteOffset"]] == b"\x00" * (
                view["byteOffset"] - end
            )  # zero padding
            end = view["byteOffset"] + view["byteLength"]
        assert binary[end:] == b"\x00" * (len(binary) - end) and len(binary) - end < 4
        for acc in doc["accessors"]:
            assert acc.get("byteOffset", 0) % 4 == 0
        for prim in (m["primitives"][0] for m in doc["meshes"]):
            views = doc["bufferViews"]
            for attribute in prim["attributes"].values():
                assert views[doc["accessors"][attribute]["bufferView"]]["target"] == 34962
            assert views[doc["accessors"][prim["indices"]]["bufferView"]]["target"] == 34963
        for key in ("images", "textures", "samplers", "animations", "skins", "cameras"):
            assert key not in doc
    doc, binary, _ = _parse(odd_glb)
    index_view = doc["bufferViews"][doc["accessors"][2]["bufferView"]]
    assert (
        index_view["byteLength"] == 6
        and doc["bufferViews"][3]["byteOffset"] == index_view["byteOffset"] + 8
    )


def test_glb_writer_parses_with_pygltflib(two_node_glb):
    gltf = GLTF2.load_from_bytes(two_node_glb)
    assert gltf.asset.generator.startswith("SlicerRemoteView ")
    assert len(gltf.scenes) == 1 and gltf.scenes[0].nodes == [0]
    root = gltf.nodes[0]
    assert root.name == "SlicerRemoteView" and root.children == [1, 3]
    assert root.extras == {
        "nodeId": "root",
        "kind": "root",
        "sceneVersion": 7,
        "profile": "mobile",
        "source": {"app": "3D Slicer", "version": "5.12.4"},
        "units": "m",
        "upAxis": "+Y",
        "rasToGltf": "x=R*0.001, y=S*0.001, z=-A*0.001",
        "anonymizedNames": False,
    }
    assert len(gltf.binary_blob()) == gltf.buffers[0].byteLength


# --------------------------------------------------------------------------- nodes, extras, materials (criterion 2)


def test_glb_writer_t_extras_and_mesh_structure(two_node_glb):
    doc, _, _ = _parse(two_node_glb)
    liver_t, liver_m, tumor_t, tumor_m = doc["nodes"][1:5]
    assert liver_t["extras"] == {
        "nodeId": "vtkMRMLSegmentationNode1/Segment_2",
        "kind": "segment",
        "mrmlId": "vtkMRMLSegmentationNode1",
        "segmentId": "Segment_2",
        "name": "Liver",
        "color": [0.8, 0.33, 0.27],
        "opacity": 1.0,
        "visible": True,
        "triangleCount": 4,
        "baked": False,
    }
    assert tumor_t["extras"] == {
        "nodeId": "vtkMRMLModelNode3",
        "kind": "model",
        "mrmlId": "vtkMRMLModelNode3",
        "name": "Tumor",
        "color": [0.95, 0.85, 0.7],
        "opacity": 0.5,
        "visible": False,
        "triangleCount": 4,
        "baked": False,
    }
    for t, m in ((liver_t, liver_m), (tumor_t, tumor_m)):
        assert t["children"] == [doc["nodes"].index(m)] and "mesh" not in t
        assert set(m) == {"mesh"}  # no extras, no matrix (no quantization), no name
        mesh = doc["meshes"][m["mesh"]]
        assert len(mesh["primitives"]) == 1
        prim = mesh["primitives"][0]
        assert prim["mode"] == 4 and set(prim["attributes"]) == {"POSITION", "NORMAL"}
    liver_mat = doc["materials"][doc["meshes"][liver_m["mesh"]]["primitives"][0]["material"]]
    tumor_mat = doc["materials"][doc["meshes"][tumor_m["mesh"]]["primitives"][0]["material"]]
    assert liver_mat["alphaMode"] == "OPAQUE" and tumor_mat["alphaMode"] == "BLEND"
    assert liver_mat["pbrMetallicRoughness"] == {
        "baseColorFactor": [0.8, 0.33, 0.27, 1.0],
        "metallicFactor": 0.0,
        "roughnessFactor": 0.6,
    }
    assert tumor_mat["pbrMetallicRoughness"]["baseColorFactor"] == [0.95, 0.85, 0.7, 0.5]
    assert liver_mat["doubleSided"] is False and tumor_mat["doubleSided"] is False
    assert "matrix" not in liver_t  # identity is omitted
    np.testing.assert_allclose(tumor_t["matrix"][12:15], [0.010, 0.030, -0.020], atol=1e-12)


def test_glb_writer_extras_duplicate_material_and_mesh_state(two_node_glb, odd_glb):
    """§7.3: colour/opacity in T.extras equal the material; triangleCount equals the index count / 3 (the per-node
    rules of shared/test/glb.test.ts). The grid has 6 × 5 vertices but 40 triangles."""
    grid = write_glb([_grid_entity(6, 5), _tumor(opacity=0.25, color=(0.1, 0.2, 0.3))], ROOT)
    for glb in (two_node_glb, odd_glb, grid):
        doc, _, _ = _parse(glb)
        for t in doc["nodes"][1::2]:
            prim = doc["meshes"][doc["nodes"][t["children"][0]]["mesh"]]["primitives"][0]
            factor = doc["materials"][prim["material"]]["pbrMetallicRoughness"]["baseColorFactor"]
            assert factor == [*t["extras"]["color"], t["extras"]["opacity"]]
            assert t["extras"]["triangleCount"] * 3 == doc["accessors"][prim["indices"]]["count"]
    doc, _, _ = _parse(grid)
    assert doc["nodes"][1]["extras"]["triangleCount"] == 40 and doc["accessors"][0]["count"] == 30
    assert doc["nodes"][3]["extras"]["opacity"] == 0.25


def test_glb_writer_names_appear_only_where_the_protocol_needs_them(two_node_glb):
    """Display names may be PHI (T7): only T.name and T.extras.name carry them (§7.2–7.3)."""
    _, _, text = _parse(two_node_glb)
    assert text.count(b'"Liver"') == 2 and text.count(b'"Tumor"') == 2
    assert b"Liver mesh" not in text


def test_glb_writer_geometry_round_trip_in_gltf_space(two_node_glb):
    doc, binary, _ = _parse(two_node_glb)
    prim = doc["meshes"][0]["primitives"][0]
    positions = _accessor_array(doc, binary, prim["attributes"]["POSITION"])
    # RAS (100,0,0) mm → glTF (+0.1, 0, 0); RAS (0,100,0) (anterior) → glTF (0, 0, −0.1)
    np.testing.assert_allclose(positions[1], [0.1, 0, 0], atol=1e-7)
    np.testing.assert_allclose(positions[3], [0, 0, -0.1], atol=1e-7)
    acc = doc["accessors"][prim["attributes"]["POSITION"]]
    assert acc["min"] == [float(v) for v in positions.min(axis=0)]
    assert acc["max"] == [float(v) for v in positions.max(axis=0)]
    indices = _accessor_array(doc, binary, prim["indices"]).reshape(-1, 3)
    np.testing.assert_array_equal(indices, _tetra_ras()[1])
    assert doc["accessors"][prim["indices"]]["componentType"] == 5123
    normals = _accessor_array(doc, binary, prim["attributes"]["NORMAL"])
    np.testing.assert_array_equal(normals, np.asarray(_liver().normals, dtype="<f4"))
    assert "min" not in doc["accessors"][prim["attributes"]["NORMAL"]]


@pytest.mark.parametrize(("nx", "ny", "expected"), [(255, 257, 5123), (256, 256, 5125)])
def test_glb_writer_index_width_switches_above_65535_vertices(nx, ny, expected):
    """65,535 vertices fit UNSIGNED_SHORT; 65,536 would need index 65,535, the primitive-restart value."""
    entity = _grid_entity(nx, ny)
    doc, binary, _ = _parse(write_glb([entity], ROOT))
    acc = doc["accessors"][2]
    assert acc["componentType"] == expected, (nx * ny, acc)
    np.testing.assert_array_equal(_accessor_array(doc, binary, 2).reshape(-1, 3), entity.indices)


def test_glb_writer_empty_scene(tmp_path):
    """After the user closes the scene the publisher still sends a snapshot (§7.3, §8.4): root only."""
    doc, binary, _ = _parse(write_glb([], ROOT))
    assert doc["nodes"] == [{"name": "SlicerRemoteView", "extras": ROOT.to_json()}]
    assert doc["buffers"] == [{"byteLength": 4}] and binary == b"\x00" * 4
    for key in ("meshes", "materials", "accessors", "bufferViews"):
        assert key not in doc  # glTF forbids empty top-level arrays


# --------------------------------------------------------------------------- determinism (criterion 3)


def test_glb_writer_is_deterministic_across_processes(two_node_glb):
    code = (
        "import sys, hashlib; sys.path[:0] = [sys.argv[1], sys.argv[2]]\n"
        "import test_glb_writer as t\n"
        "print(hashlib.sha256(t.write_glb([t._liver(), t._tumor()], t.ROOT)).hexdigest())\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code, str(Path(__file__).parent), str(CORE_DIR.parent)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == hashlib.sha256(two_node_glb).hexdigest()
    assert write_glb([_tumor(), _liver()], ROOT) != two_node_glb  # order is part of the input


def test_glb_writer_json_is_raw_utf8():
    glb = write_glb([_tumor(name="Wątroba – lewy płat")], ROOT)
    doc, _, text = _parse(glb)
    assert doc["nodes"][1]["name"] == "Wątroba – lewy płat"
    assert "Wątroba – lewy płat".encode() in text  # not \\u-escaped


def test_glb_writer_imports_no_vtk_slicer_or_qt():
    tree = ast.parse((CORE_DIR / "glb_writer.py").read_text())
    imported = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    allowed = {
        "__future__",
        "json",
        "re",
        "struct",
        "unicodedata",
        "collections",
        "dataclasses",
        "typing",
    }
    assert imported <= allowed | {"numpy", "remoteview_core"}
    assert "vtk" not in imported and "vtkmodules" not in imported


def test_glb_writer_constants_match_the_protocol_schema():
    assert generated.__file__.startswith(str(vendored.PACKAGE_DIR))
    profiles = typing.get_args(generated.Profile.__value__)
    assert profiles == writer.PROFILES
    defs = json.loads(
        (PLUGIN_ROOT / "RemoteView/_vendor/remoteview_protocol/schema/defs.schema.json").read_text()
    )["definitions"]["nodeId"]
    assert defs["pattern"] == "^[A-Za-z0-9_./:-]+$" and defs["maxLength"] == 128
    assert writer.NODE_ID_PATTERN.pattern == r"[A-Za-z0-9_./:-]{1,128}"


# --------------------------------------------------------------------------- negative cases


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"node_id": "bad id with spaces"}, "nodeId"),
        ({"node_id": "x" * 129}, "nodeId"),
        ({"node_id": "vtkMRMLModelNode3\n", "mrml_id": "vtkMRMLModelNode3\n"}, "nodeId"),
        ({"node_id": "root", "mrml_id": "root"}, "reserved"),
        ({"node_id": "vtkMRMLModelNode4"}, "MRML ID"),
        ({"mrml_id": ""}, "mrmlId"),
        ({"segment_id": "Segment_1"}, "segmentId"),
        ({"kind": "volume"}, "kind"),
        ({"name": "Patient\x07Name"}, "sanitised"),
        ({"name": "Liver\u202egnp.exe"}, "sanitised"),  # bidi override (Cf)
        ({"name": "Li\u200bver"}, "sanitised"),  # zero-width space (Cf)
        (
            {"name": "Liver\ud800"},
            "sanitised",
        ),  # lone surrogate: would fail as UnicodeEncodeError later
        ({"name": "Line\u2028break"}, "sanitised"),
        ({"name": " padded "}, "sanitised"),
        ({"name": " leading"}, "sanitised"),
        ({"name": "Para\u2029graph"}, "sanitised"),  # paragraph separator (Zp)
        ({"name": "Private\ue000use"}, "sanitised"),  # private use (Co)
        ({"name": "Un\u0378assigned"}, "sanitised"),  # unassigned (Cn)
        ({"name": "n" * 65}, "sanitised"),
        ({"name": 42}, "sanitised"),
        ({"color": (1.2, 0.0, 0.0)}, "color"),
        ({"color": (0.5, 0.5)}, "color"),
        ({"color": ("a", "b", "c")}, "color"),
        ({"color": ("0.5", 0.5, 0.5)}, "color"),
        ({"color": (True, False, True)}, "color"),
        ({"color": np.array(0.5)}, "color"),  # 0-d array has no len()
        ({"opacity": float("nan")}, "opacity"),
        ({"opacity": "0.5"}, "opacity"),
        ({"opacity": True}, "opacity"),
        ({"node_id": "a/b", "mrml_id": "a/b"}, "mrmlId"),
        ({"visible": "false"}, "booleans"),
        ({"baked": "no"}, "booleans"),
        ({"positions": np.full((4, 3), np.nan)}, "finite"),
        ({"positions": np.full((4, 3), 1e39)}, "finite"),  # finite float64, overflows float32
        ({"positions": np.zeros((4, 3), dtype=complex)}, "real"),
        ({"positions": np.zeros((0, 3))}, "positions"),
        ({"positions": [[0, 0, 0], [1, 1]]}, "arrays"),  # ragged
        ({"normals": np.zeros((4, 3))}, "unit length"),
        ({"normals": np.tile([0.0, 1.0 + 2e-4, 0.0], (4, 1))}, "unit length"),
        ({"normals": np.zeros((3, 3))}, "same shape"),
        ({"indices": np.array([[0, 1, 4]])}, "out of range"),
        ({"indices": np.array([[0, -1, 2]])}, "out of range"),
        ({"indices": np.array([[0.0, 1.0, 2.0]])}, "integers"),
        ({"indices": np.zeros((0, 3), dtype=int)}, "indices"),
        ({"matrix": np.eye(3)}, "4x4"),
        (
            {"matrix": np.array([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1.0]])},
            "shear",
        ),
        ({"matrix": np.full((4, 4), np.nan)}, "4x4"),
        ({"matrix": [[1, 0, 0, 0], [0, 1]]}, "4x4"),  # ragged
        ({"matrix": np.diag([1.0, 1.0, 1.0, 1.0]) + np.eye(4, k=3) * 1e39}, "float32"),
        ({"matrix": np.diag([1e-50, 1e-50, 1e-50, 1.0])}, "shear"),  # scale 0 in float32
        ({"baked": True}, "baked"),
    ],
)
def test_glb_writer_rejects_invalid_entities(overrides, message):
    with pytest.raises(GlbWriteError, match=message):
        write_glb([_tumor(**overrides)], ROOT)


def test_glb_writer_rejects_bad_segment_ids():
    with pytest.raises(GlbWriteError, match="nodeId"):
        write_glb(
            [_liver(node_id="vtkMRMLSegmentationNode1/Segment_2\n", segment_id="Segment_2\n")], ROOT
        )
    for segment_id in (2, "", None, "Segment_1"):  # Segment_1 does not match the nodeId's segment
        with pytest.raises(GlbWriteError, match="segment"):
            write_glb([_liver(segment_id=segment_id)], ROOT)
    with pytest.raises(GlbWriteError, match="segment"):
        write_glb([_liver(mrml_id="vtkMRMLSegmentationNode2")], ROOT)


def test_glb_writer_accepts_near_unit_normals_and_empty_names():
    doc, _, _ = _parse(
        write_glb([_tumor(normals=np.tile([0.0, 1.0 + 5e-5, 0.0], (4, 1)), name="")], ROOT)
    )
    assert doc["nodes"][1]["name"] == "" and doc["nodes"][1]["extras"]["name"] == ""


@pytest.mark.parametrize(
    ("root", "message"),
    [
        (RootExtras(scene_version=0, profile="mobile", slicer_version="5.12.4"), "sceneVersion"),
        (RootExtras(scene_version=2**32, profile="mobile", slicer_version="5"), "sceneVersion"),
        (RootExtras(scene_version=True, profile="mobile", slicer_version="5"), "sceneVersion"),
        (RootExtras(scene_version=1, profile="desktop", slicer_version="5.12.4"), "profile"),
        (RootExtras(scene_version=1, profile="mobile", slicer_version=None), "source.version"),
        (
            RootExtras(scene_version=1, profile="mobile", slicer_version="5", source_app=""),
            "source.app",
        ),
        (
            RootExtras(
                scene_version=1, profile="mobile", slicer_version="5", source_app="3D\x07Slicer"
            ),
            "source.app",
        ),
        (RootExtras(scene_version=1, profile="mobile", slicer_version="5.12\n4"), "source.version"),
        (
            RootExtras(
                scene_version=1, profile="mobile", slicer_version="5", anonymized_names="yes"
            ),
            "boolean",
        ),
    ],
)
def test_glb_writer_rejects_bad_root_extras(root, message):
    with pytest.raises(GlbWriteError, match=message):
        write_glb([_tumor()], root)


def test_glb_writer_reads_the_input_once():
    """Validation and serialisation see the same entities, even for a one-shot iterable."""

    class Flipping(list):
        def __iter__(self):
            yield (
                _tumor(name="Model 1") if not hasattr(self, "seen") else _tumor(name="Jan Kowalski")
            )
            self.seen = True

    anonymous = RootExtras(
        scene_version=1, profile="mobile", slicer_version="5", anonymized_names=True
    )
    doc, _, _ = _parse(write_glb(Flipping([None]), anonymous))
    assert doc["nodes"][1]["name"] == "Model 1"
    doc, _, _ = _parse(write_glb((e for e in [_liver(), _tumor()]), ROOT))
    assert len(doc["nodes"]) == 5


def test_glb_writer_rejects_duplicates():
    with pytest.raises(GlbWriteError, match="duplicate"):
        write_glb([_tumor(), _tumor()], ROOT)


ANONYMOUS = RootExtras(
    scene_version=1, profile="mobile", slicer_version="5.12.4", anonymized_names=True
)


@pytest.mark.parametrize(
    "name",
    [
        "Liver",
        "Model 1 Jan Kowalski",  # a prefix match would let the real name through
        "Jan Kowalski Model 1",
        "Model 0",
        "Model 01",
        "model 1",
        "Model",
        "",
    ],
)
def test_glb_writer_anonymised_names_must_be_substitutes(name):
    """anonymizedNames: true promises that no display name left Slicer (§7.3, T7)."""
    with pytest.raises(GlbWriteError, match="anonymised"):
        write_glb([_tumor(name=name)], ANONYMOUS)


def test_glb_writer_accepts_anonymised_substitutes():
    doc, _, _ = _parse(write_glb([_liver(name="Segment 1"), _tumor(name="Model 12")], ANONYMOUS))
    assert doc["nodes"][0]["extras"]["anonymizedNames"] is True
    numpy_flag = RootExtras(
        scene_version=1, profile="mobile", slicer_version="5.12.4", anonymized_names=np.True_
    )
    doc, _, _ = _parse(write_glb([_tumor(name="Model 2")], numpy_flag))
    assert doc["nodes"][0]["extras"]["anonymizedNames"] is True


def test_glb_writer_accepts_exactly_the_exportable_matrices():
    """`is_exportable_matrix` is the writer's own rule, so SLC-07/SLC-13 can decide "keep or bake" with it."""
    rng = np.random.default_rng(11)
    candidates = [
        np.eye(4),
        np.diag([-1.0, 1.0, 1.0, 1.0]),
        np.diag([1e-50, 1e-50, 1e-50, 1.0]),
        np.eye(4) + np.eye(4, k=3) * 1e39,
        np.array([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1.0]]),
        np.full((4, 4), np.nan),
        np.eye(3),
        "eye",
    ]
    for _ in range(100):
        m = np.eye(4)
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        shear = np.eye(3) + np.triu(rng.normal(size=(3, 3)) * rng.choice([0.0, 1e-7, 1e-3]), 1)
        m[:3, :3] = q @ shear @ np.diag(rng.uniform(0.1, 10, size=3))
        m[:3, 3] = rng.normal(size=3)
        candidates.append(m)
    accepted = 0
    for matrix in candidates:
        try:
            write_glb([_tumor(matrix=matrix)], ROOT)
        except GlbWriteError:
            assert not is_exportable_matrix(matrix)
        else:
            assert is_exportable_matrix(matrix)
            accepted += 1
    assert 0 < accepted < len(candidates)


def test_glb_writer_baked_entity_with_identity_matrix_is_accepted():
    doc, _, _ = _parse(write_glb([_tumor(baked=True, matrix=np.eye(4))], ROOT))
    assert doc["nodes"][1]["extras"]["baked"] is True and "matrix" not in doc["nodes"][1]


def test_glb_writer_entity_is_keyword_only():
    with pytest.raises(TypeError):
        Entity("vtkMRMLModelNode1", "model")  # type: ignore[misc]


def test_glb_writer_entity_repr_hides_names_and_geometry():
    """A repr in a log line or traceback must not carry a (possibly PHI) name or the mesh (T7)."""
    text = repr(_tumor(name="Jan Kowalski"))
    assert "vtkMRMLModelNode3" in text
    assert "Kowalski" not in text and "array" not in text and "positions" not in text


# --------------------------------------------------------------------------- Khronos validator (criterion 1)


@needs_validator
def test_glb_writer_passes_khronos_gltf_validator(two_node_glb, odd_glb, tmp_path):
    files = {
        "two-node.glb": two_node_glb,
        "odd.glb": odd_glb,
        "uint16-max.glb": write_glb([_grid_entity(255, 257), _liver()], ROOT),
        "uint32-min.glb": write_glb([_grid_entity(256, 256), _triangle()], ROOT),
        "empty.glb": write_glb([], ROOT),
    }
    for name, report in validate_glb(tmp_path, files).items():
        assert report["numErrors"] == 0 and report["numWarnings"] == 0, (name, report)
        assert report["violations"] == [], (name, report)


@needs_validator
def test_glb_writer_validator_helper_flags_broken_files(tmp_path):
    """Neither half of the helper is a rubber stamp: the Khronos validator reports errors for broken containers
    and the §7.1 pre-check reports rule violations (PRO-08 broken fixtures)."""
    names = ("truncated.glb", "bad-magic.glb", "two-scenes.glb", "external-uri.glb")
    glb_dir = REPO_ROOT / "shared" / "fixtures" / "glb"
    reports = validate_glb(tmp_path, {n: (glb_dir / n).read_bytes() for n in names})
    assert reports["truncated.glb"]["numErrors"] > 0 and reports["bad-magic.glb"]["numErrors"] > 0
    assert reports["two-scenes.glb"]["violations"] == ["exactly one scene"]
    assert "no uri" in reports["external-uri.glb"]["violations"]
    doc, binary, _ = _parse(write_glb([_triangle(), _liver()], ROOT))
    doc["bufferViews"][3]["byteOffset"] -= (
        2  # a view at an offset that breaks the float32 alignment
    )
    report = validate_glb(tmp_path, {"misaligned.glb": _repack(doc, binary)})["misaligned.glb"]
    assert report["numErrors"] > 0, report


@needs_validator
def test_glb_writer_validator_helper_reports_warnings(tmp_path):
    """The zero-warning gate is live: alphaCutoff on an OPAQUE material is a validator warning."""
    doc, binary, _ = _parse(write_glb([_triangle()], ROOT))
    doc["materials"][0]["alphaCutoff"] = 0.5
    report = validate_glb(tmp_path, {"warning.glb": _repack(doc, binary)})["warning.glb"]
    assert report["numErrors"] == 0 and report["numWarnings"] > 0, report
