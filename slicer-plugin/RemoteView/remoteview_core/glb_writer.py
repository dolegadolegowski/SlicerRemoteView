"""GLB snapshot writer (``docs/protocol.md`` §7, ADR 0005 Decision 1 and errata).

Pure function from exported entities to the bytes of one glTF 2.0 binary container:

- 12-byte header, one JSON chunk (padded with spaces), one BIN chunk (padded with zeros); every chunk, buffer
  view and accessor starts on a 4-byte boundary (glTF 2.0 §4.4, §3.6.2.4); one buffer = the BIN chunk.
- One scene whose only root node ``SlicerRemoteView`` carries the §7.1 extras.
- Per entity a transform node ``T`` (name, §7.3 extras, ``matrix`` in glTF space — omitted when identity) with
  exactly one child mesh node ``M`` owning one mesh → one ``TRIANGLES`` primitive → one material (§7.2, §7.4).
- ``POSITION`` (float32, with ``min``/``max``), ``NORMAL`` (float32), indices ``UNSIGNED_SHORT`` when the mesh has
  ≤ 65,535 vertices, else ``UNSIGNED_INT``. Quantization (``KHR_mesh_quantization``) is SLC-12.
- An empty scene (no entities, e.g. after the user closed the scene — §7.3 still requires a new snapshot) is the
  root node alone with a 4-byte zero BIN chunk, so the "exactly one buffer" rule of §7.1 still holds.
- Display names (possibly PHI, threat T7) appear only where §7.2–7.3 require them: ``T.name`` and
  ``T.extras.name``; meshes, materials and ``M`` nodes carry no name.

Inputs are already in glTF space (metres, +Y up — convert with :mod:`remoteview_core.coords`). The output is a
deterministic function of the input (byte-identical across runs; ADR 0005 consequences). Pure Python + numpy:
no Slicer, Qt or VTK import (CLAUDE.md rule 10).
"""

from __future__ import annotations

import json
import re
import struct
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import NDArray

from remoteview_core import __version__
from remoteview_core.coords import gltf_matrix_column_major, is_trs_decomposable

GLB_MAGIC = 0x46546C67  # "glTF"
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A  # "JSON"
CHUNK_BIN = 0x004E4942  # "BIN\0"

# glTF enums (glTF 2.0 §5.1.3, §3.7.2.1, §3.11)
FLOAT = 5126
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
TRIANGLES = 4

#: Largest vertex count indexed with ``UNSIGNED_SHORT`` (65,535 itself is the reserved restart value).
MAX_UINT16_VERTICES = 65_535
#: §7.4: the publisher may tune 0.4–0.9.
ROUGHNESS = 0.6
ROOT_NAME = "SlicerRemoteView"
PROFILES = ("mobile", "quest2", "quest3")
#: §3.3 ``nodeId`` grammar (used with ``fullmatch``: ``$`` would also accept a trailing newline).
NODE_ID_PATTERN = re.compile(r"[A-Za-z0-9_./:-]{1,128}")
#: §7.3: names are sanitised (trimmed, ≤ 64 characters) and contain no control, format (bidi/zero-width),
#: surrogate, private-use, unassigned or line/paragraph-separator characters.
MAX_NAME_LENGTH = 64
#: Unicode categories a sanitised name never contains; ``names.sanitize_name`` (SLC-23) removes exactly these.
FORBIDDEN_NAME_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"})
#: §7.3 substitutes for hidden names.
_ANONYMOUS_NAME = re.compile(r"(Model|Segment) [1-9][0-9]*")

EntityKind = Literal["model", "segment"]


@dataclass(frozen=True, eq=False, kw_only=True)
class Entity:
    """One exported Slicer node or segment, already converted to glTF space (§7.2–7.3).

    ``positions``/``normals`` are ``(n, 3)`` real arrays and ``indices`` an ``(m, 3)`` integer array; ``matrix`` is
    the world transform in glTF space (``C · M_world · C⁻¹``, TRS-decomposable) or ``None`` for identity (omitted
    in the file); ``baked`` entities have their non-linear transform applied to the vertices and no matrix.
    ``triangle_count`` (§7.3 ``triangleCount``) is derived from ``indices``.
    """

    node_id: str
    kind: EntityKind
    # repr=False: a repr in a log line or traceback must not carry the (possibly PHI) name or the geometry (T7)
    name: str = field(repr=False)
    positions: NDArray[Any] = field(repr=False)
    normals: NDArray[Any] = field(repr=False)
    indices: NDArray[Any] = field(repr=False)
    color: tuple[float, float, float]
    opacity: float
    visible: bool
    mrml_id: str
    segment_id: str | None = None
    matrix: NDArray[Any] | None = field(default=None, repr=False)
    baked: bool = False

    @property
    def triangle_count(self) -> int:
        return int(np.shape(self.indices)[0])


@dataclass(frozen=True, kw_only=True)
class RootExtras:
    """Variable part of the root node extras (§7.1); the constant keys are added by the writer."""

    scene_version: int
    profile: str
    slicer_version: str
    anonymized_names: bool = False
    #: Free-form app name in ``source.app`` (§7.1 example: ``"3D Slicer"``).
    source_app: str = field(default="3D Slicer")

    def to_json(self) -> dict[str, Any]:
        return {
            "nodeId": "root",
            "kind": "root",
            "sceneVersion": self.scene_version,
            "profile": self.profile,
            "source": {"app": self.source_app, "version": self.slicer_version},
            "units": "m",
            "upAxis": "+Y",
            "rasToGltf": "x=R*0.001, y=S*0.001, z=-A*0.001",
            "anonymizedNames": bool(self.anonymized_names),
        }


class GlbWriteError(ValueError):
    """An entity or the root extras violate §7 (raised before any byte is produced)."""


def _is_bool(value: Any) -> bool:
    return isinstance(value, (bool, np.bool_))


def _check_unit_float(value: Any, what: str) -> float:
    if _is_bool(value) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise GlbWriteError(f"{what} must be a number within 0..1")
    v = float(value)
    if not (0.0 <= v <= 1.0):  # also rejects NaN
        raise GlbWriteError(f"{what} must be within 0..1")
    return v


def _validated_arrays(
    e: Entity,
) -> tuple[NDArray[np.float32], NDArray[np.float32], NDArray[np.uint32]]:
    try:
        positions = np.asarray(e.positions)
        normals = np.asarray(e.normals)
        indices = np.asarray(e.indices)
    except (TypeError, ValueError):  # ragged nested sequences
        raise GlbWriteError(f"{e.node_id}: positions, normals and indices must be arrays") from None
    for what, arr in (("positions", positions), ("normals", normals)):
        if not (np.issubdtype(arr.dtype, np.floating) or np.issubdtype(arr.dtype, np.integer)):
            raise GlbWriteError(f"{e.node_id}: {what} must be real numbers")
    if positions.ndim != 2 or positions.shape[1] != 3 or positions.shape[0] == 0:
        raise GlbWriteError(f"{e.node_id}: positions must have shape (n>0, 3)")
    if normals.shape != positions.shape:
        raise GlbWriteError(f"{e.node_id}: normals must have the same shape as positions")
    if indices.ndim != 2 or indices.shape[1] != 3 or indices.shape[0] == 0:
        raise GlbWriteError(f"{e.node_id}: indices must have shape (m>0, 3)")
    if not np.issubdtype(indices.dtype, np.integer):
        raise GlbWriteError(f"{e.node_id}: indices must be integers")
    vertex_count = positions.shape[0]
    if vertex_count >= 2**32 - 1:
        raise GlbWriteError(f"{e.node_id}: too many vertices for UNSIGNED_INT indices")
    if indices.min() < 0 or indices.max() >= vertex_count:
        raise GlbWriteError(f"{e.node_id}: index out of range")
    # Overflow to inf is reported below as GlbWriteError, not as a numpy warning.
    with np.errstate(over="ignore", invalid="ignore"):
        p32 = positions.astype("<f4")
        n32 = normals.astype("<f4")
    if not (np.all(np.isfinite(p32)) and np.all(np.isfinite(n32))):
        raise GlbWriteError(f"{e.node_id}: positions/normals must be finite float32 values")
    if not np.allclose(np.linalg.norm(n32.astype(np.float64), axis=1), 1.0, rtol=0, atol=1e-4):
        raise GlbWriteError(f"{e.node_id}: normals must have unit length (§7.4)")
    return p32, n32, indices.astype("<u4")


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and NODE_ID_PATTERN.fullmatch(value) is not None


def is_valid_name(name: Any) -> bool:
    """A sanitised display name (§7.3): a string, trimmed, ≤ 64 characters, no :data:`FORBIDDEN_NAME_CATEGORIES`."""
    return (
        isinstance(name, str)
        and len(name) <= MAX_NAME_LENGTH
        and name == name.strip()
        and not any(unicodedata.category(ch) in FORBIDDEN_NAME_CATEGORIES for ch in name)
    )


def _validate_identity(e: Entity, seen: set[str], anonymized: bool) -> None:
    if not _valid_id(e.node_id):
        raise GlbWriteError("nodeId must match [A-Za-z0-9_./:-]{1,128} (§3.3)")
    if e.node_id in seen:
        raise GlbWriteError(f"duplicate nodeId {e.node_id}")
    if e.node_id == "root":
        raise GlbWriteError("nodeId 'root' is reserved for the root node (§7.1)")
    seen.add(e.node_id)
    if not _valid_id(e.mrml_id) or "/" in e.mrml_id:
        raise GlbWriteError(f"{e.node_id}: mrmlId must be an MRML node ID")
    if e.kind == "model":
        if e.segment_id is not None or e.node_id != e.mrml_id:
            raise GlbWriteError(
                f"{e.node_id}: a model's nodeId is its MRML ID and it has no segmentId"
            )
    elif e.kind == "segment":
        if (
            not isinstance(e.segment_id, str)
            or not e.segment_id
            or e.node_id != f"{e.mrml_id}/{e.segment_id}"
        ):
            raise GlbWriteError(f"{e.node_id}: a segment's nodeId is '<mrmlId>/<segmentId>' (§7.3)")
    else:
        raise GlbWriteError(f"{e.node_id}: kind must be 'model' or 'segment'")
    if not is_valid_name(e.name):
        raise GlbWriteError(
            f"{e.node_id}: name must be sanitised (no control/format characters, trimmed, ≤ 64)"
        )
    if anonymized and not _ANONYMOUS_NAME.fullmatch(e.name):
        # anonymizedNames: true promises viewers that no display name left Slicer (§7.3, T7)
        raise GlbWriteError(
            f"{e.node_id}: with anonymised names every name is 'Model <n>'/'Segment <n>'"
        )


def _validate_appearance(e: Entity) -> None:
    if (
        not isinstance(e.color, (tuple, list, np.ndarray))
        or np.ndim(e.color) != 1
        or len(e.color) != 3
    ):
        raise GlbWriteError(f"{e.node_id}: color must be [r, g, b]")
    for i, c in enumerate(e.color):
        _check_unit_float(c, f"{e.node_id}: color[{i}]")
    _check_unit_float(e.opacity, f"{e.node_id}: opacity")
    if not _is_bool(e.visible) or not _is_bool(e.baked):
        raise GlbWriteError(f"{e.node_id}: visible and baked must be booleans")
    if e.matrix is not None:
        try:
            m = np.asarray(e.matrix, dtype=np.float64)
        except (TypeError, ValueError):
            raise GlbWriteError(f"{e.node_id}: matrix must be a finite 4x4 array") from None
        if m.shape != (4, 4) or not np.all(np.isfinite(m)):
            raise GlbWriteError(f"{e.node_id}: matrix must be a finite 4x4 array")
        with np.errstate(over="ignore", under="ignore"):
            m32 = m.astype(np.float32)  # what float32 consumers (GPU, glTFast) will see
        if not np.all(np.isfinite(m32)):
            raise GlbWriteError(f"{e.node_id}: matrix must be a finite 4x4 array in float32")
        if not (is_trs_decomposable(m) and is_trs_decomposable(m32)):
            # glTF node.matrix must decompose into TRS; sheared transforms are baked instead (SLC-13, report slicer-4)
            raise GlbWriteError(f"{e.node_id}: matrix must be affine without shear (TRS)")
        if e.baked and not np.array_equal(m, np.eye(4)):
            raise GlbWriteError(f"{e.node_id}: a baked entity has an identity matrix (§7.3)")


def _validate_root(root: RootExtras) -> None:
    if isinstance(root.scene_version, bool) or not isinstance(root.scene_version, int):
        raise GlbWriteError("sceneVersion must be an integer")
    if not 1 <= root.scene_version <= 0xFFFF_FFFF:
        raise GlbWriteError("sceneVersion must be a uint32 ≥ 1 (§8.4)")
    if root.profile not in PROFILES:
        raise GlbWriteError(f"profile must be one of {PROFILES}")
    if not _is_bool(root.anonymized_names):
        raise GlbWriteError("anonymizedNames must be a boolean")
    for what, value in (("source.app", root.source_app), ("source.version", root.slicer_version)):
        if not isinstance(value, str) or not value or not is_valid_name(value):
            raise GlbWriteError(f"{what} must be a short plain string")


class _Bin:
    """BIN chunk builder: every appended block starts on a 4-byte boundary (zero padding). Blocks are kept as a
    list and joined once when the container is packed (snapshots reach tens of MiB)."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []
        self.length = 0

    def _pad(self) -> None:
        if pad := -self.length % 4:
            self.parts.append(b"\x00" * pad)
            self.length += pad

    def append(self, block: bytes) -> int:
        self._pad()
        offset = self.length
        self.parts.append(block)
        self.length += len(block)
        return offset

    def finish(self) -> list[bytes]:
        if self.length == 0:
            self.append(b"\x00" * 4)  # empty scene: glTF buffers need byteLength ≥ 1
        self._pad()
        return self.parts


def write_glb(entities: Sequence[Entity], root_extras: RootExtras) -> bytes:
    """Serialise ``entities`` into one GLB (§7). Raises :class:`GlbWriteError` on invalid input."""
    entities = tuple(entities)  # validated and written from the same snapshot of the input
    _validate_root(root_extras)
    seen: set[str] = set()
    for e in entities:
        _validate_identity(e, seen, bool(root_extras.anonymized_names))
        _validate_appearance(e)

    bin_chunk = _Bin()
    buffer_views: list[dict[str, Any]] = []
    accessors: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    meshes: list[dict[str, Any]] = []
    root: dict[str, Any] = {"name": ROOT_NAME}
    if entities:
        root["children"] = [1 + 2 * i for i in range(len(entities))]
    root["extras"] = root_extras.to_json()
    nodes: list[dict[str, Any]] = [root]

    def add_view(block: bytes, target: int) -> int:
        offset = bin_chunk.append(block)
        buffer_views.append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(block), "target": target}
        )
        return len(buffer_views) - 1

    def add_accessor(accessor: dict[str, Any]) -> int:
        accessors.append(accessor)
        return len(accessors) - 1

    for e in entities:
        positions, normals, indices = _validated_arrays(e)
        vertex_count = positions.shape[0]
        position_accessor = add_accessor(
            {
                "bufferView": add_view(positions.tobytes(), ARRAY_BUFFER),
                "componentType": FLOAT,
                "count": vertex_count,
                "type": "VEC3",
                "min": [float(v) for v in positions.min(axis=0)],
                "max": [float(v) for v in positions.max(axis=0)],
            }
        )
        normal_accessor = add_accessor(
            {
                "bufferView": add_view(normals.tobytes(), ARRAY_BUFFER),
                "componentType": FLOAT,
                "count": vertex_count,
                "type": "VEC3",
            }
        )
        wide = vertex_count > MAX_UINT16_VERTICES
        index_block = indices.reshape(-1).astype("<u4" if wide else "<u2").tobytes()
        index_accessor = add_accessor(
            {
                "bufferView": add_view(index_block, ELEMENT_ARRAY_BUFFER),
                "componentType": UNSIGNED_INT if wide else UNSIGNED_SHORT,
                "count": int(indices.size),
                "type": "SCALAR",
            }
        )
        color = [float(c) for c in e.color]
        opacity = float(e.opacity)
        materials.append(
            {
                "pbrMetallicRoughness": {
                    "baseColorFactor": [*color, opacity],
                    "metallicFactor": 0.0,
                    "roughnessFactor": ROUGHNESS,
                },
                "alphaMode": "BLEND" if opacity < 1.0 else "OPAQUE",
                "doubleSided": False,
            }
        )
        meshes.append(
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor},
                        "indices": index_accessor,
                        "material": len(materials) - 1,
                        "mode": TRIANGLES,
                    }
                ],
            }
        )
        extras: dict[str, Any] = {"nodeId": e.node_id, "kind": e.kind, "mrmlId": e.mrml_id}
        if e.segment_id is not None:
            extras["segmentId"] = e.segment_id
        extras.update(
            name=e.name,
            color=color,
            opacity=opacity,
            visible=bool(e.visible),
            triangleCount=e.triangle_count,
            baked=bool(e.baked),
        )
        t_node: dict[str, Any] = {"name": e.name, "children": [len(nodes) + 1]}
        if e.matrix is not None and not np.array_equal(
            np.asarray(e.matrix, dtype=np.float64), np.eye(4)
        ):
            # An absent matrix is identity (glTF 2.0 §5.25); an explicit one only earns NODE_MATRIX_DEFAULT info.
            t_node["matrix"] = gltf_matrix_column_major(e.matrix)
        t_node["extras"] = extras
        nodes.append(t_node)
        nodes.append({"mesh": len(meshes) - 1})

    bin_parts = bin_chunk.finish()
    document: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": f"SlicerRemoteView {__version__}"},
        "scene": 0,
        "scenes": [{"name": ROOT_NAME, "nodes": [0]}],
        "nodes": nodes,
    }
    if entities:  # glTF top-level arrays must not be empty
        document.update(
            meshes=meshes, materials=materials, accessors=accessors, bufferViews=buffer_views
        )
    document["buffers"] = [{"byteLength": bin_chunk.length}]
    return _pack(document, bin_parts, bin_chunk.length)


def _pack(document: dict[str, Any], bin_parts: list[bytes], bin_length: int) -> bytes:
    text = json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + bin_length
    if total > 0xFFFF_FFFF:
        raise GlbWriteError("GLB larger than 4 GiB")
    header = struct.pack("<III", GLB_MAGIC, GLB_VERSION, total)
    json_header = struct.pack("<II", len(text), CHUNK_JSON)
    bin_header = struct.pack("<II", bin_length, CHUNK_BIN)
    return b"".join([header, json_header, text, bin_header, *bin_parts])
