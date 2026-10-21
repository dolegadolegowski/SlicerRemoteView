"""MRML collection (``docs/architecture.md`` §6.4, ADR 0005 + errata): Slicer model nodes → GLB entities.

:func:`collect_scene` reads the scene through a small injectable :class:`SceneApi` (the real implementation is the
Slicer adapter in ``RemoteView.py``, SLC-09/SLC-22; tests use a fake) and returns one
:class:`~remoteview_core.glb_writer.Entity` per exportable model node, in glTF space:

- geometry: a **deep copy** of the node's points (same precision), polygons and strips only (the user's data is
  never touched — ADR 0005 §3; no attribute arrays, vertices or lines) → ``vtkTriangleFilter`` → triangles with a
  repeated vertex dropped → the bake, if any (below) → triangles without area dropped → ``vtkPolyDataNormals``
  (``SplittingOff``, ``ConsistencyOn``) → owned numpy arrays without the points no triangle uses; positions/normals
  converted with :mod:`remoteview_core.coords` (RAS mm → glTF m, +Y up);
- transform: a linear world matrix becomes ``T.matrix = C·M·C⁻¹`` (protocol §7.2), identity becomes no matrix; a
  world transform that is not linear, or linear with shear (glTF ``node.matrix`` must be TRS), is **baked** into the
  vertices instead (SLC-13, protocol §7.3 ``baked: true``, identity ``T.matrix``) — the 3D view applies it the same way,
  as a ``vtkTransformFilter`` on the mesh; normals are computed after it, and a transform that mirrors (negative
  Jacobian at the first triangle) gets the triangles reversed so that their front faces still point outwards;
- appearance: display colour/opacity clamped to 0..1, visibility as a bool;
- name: :class:`~remoteview_core.names.NameAssigner` (sanitised, or ``Model <n>`` with *Hide node names*).

A node that cannot be exported never aborts the snapshot: it is left out and reported in
:attr:`CollectedScene.skipped` with a :class:`SkipReason` — no triangles (empty, points or lines only), a non-linear
world transform the scene cannot hand over for baking, invalid or duplicate IDs (with *Hide node names* also IDs not
of the generated shape), non-finite data (also after a bake), cells that reference missing points or are not
stored as integers (checked before any VTK filter runs: the filters do not bounds-check point IDs).

Main thread only (VTK). No Slicer or Qt import: the VTK classes come from ``vtkmodules``, which Slicer 5.12 and the
``vtk`` wheel provide identically (``docs/research/slicer-collect.md``).
"""

from __future__ import annotations

import enum
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray
from vtkmodules.util.numpy_support import get_numpy_array_type, numpy_to_vtk
from vtkmodules.vtkCommonCore import (
    VTK_BIT,
    VTK_DOUBLE,
    VTK_FLOAT,
    VTK_ID_TYPE,
    vtkDataArray,
    vtkPoints,
)
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
from vtkmodules.vtkCommonTransforms import vtkAbstractTransform, vtkTransform
from vtkmodules.vtkFiltersCore import vtkPolyDataNormals, vtkTriangleFilter

from remoteview_core.coords import ras_matrix_to_gltf, ras_to_gltf_normals, ras_to_gltf_points
from remoteview_core.glb_writer import NODE_ID_PATTERN, Entity, is_exportable_matrix
from remoteview_core.names import NameAssigner


class SceneApi(Protocol):
    """What :func:`collect_scene` needs from a Slicer scene (one implementation per host; tests use fakes)."""

    def visible_model_nodes(self) -> Iterable[Any]:
        """The model nodes to export, in a stable order (the adapter decides which ones — FR-05, SLC-22)."""
        ...

    def node_id(self, node: Any) -> str:
        """The MRML node ID (``vtkMRMLModelNode4``), used as ``nodeId`` (protocol §7.3)."""
        ...

    def name(self, node: Any) -> str | bytes | None:
        """The display name as Slicer stores it (VTK returns ``bytes`` for a name that is not UTF-8)."""
        ...

    def polydata(self, node: Any) -> vtkPolyData | None:
        """The node's mesh in its own coordinates (before the parent transform), or ``None``."""
        ...

    def display_props(self, node: Any) -> tuple[Sequence[float], float, bool]:
        """``(color [r, g, b] 0..1, opacity 0..1, visible)`` of the node's 3D display."""
        ...

    def world_matrix(self, node: Any) -> Any:
        """The 4×4 RAS (mm) node-to-world matrix (identity without a parent transform), or ``None`` when the parent
        transform chain is not linear."""
        ...

    def world_transform(self, node: Any) -> vtkAbstractTransform | None:
        """The whole node-to-world transform (RAS mm) as the 3D view applies it, for baking a chain that is not linear
        into the vertices; ``None`` when it cannot be had. Asked only when :meth:`world_matrix` is ``None``."""
        ...


class SkipReason(enum.Enum):
    """Why a node is left out of the snapshot (shown in the panel's node list, SLC-18)."""

    INVALID_NODE_ID = "invalid-node-id"
    DUPLICATE_NODE_ID = "duplicate-node-id"
    NO_TRIANGLES = "no-triangles"
    INVALID_GEOMETRY = "invalid-geometry"
    INVALID_DISPLAY = "invalid-display"
    INVALID_TRANSFORM = "invalid-transform"
    #: a non-linear world transform that :meth:`SceneApi.world_transform` did not provide (a sheared or non-linear
    #: transform is baked otherwise)
    NON_LINEAR_TRANSFORM = "non-linear-transform"


@dataclass(frozen=True)
class SkippedNode:
    """A node left out of the snapshot; ``node_id`` is ``""`` when the ID itself was invalid. ``index`` is the
    node's position in ``visible_model_nodes()`` so the panel can still show which node it was (local only, never
    sent; not part of equality)."""

    node_id: str
    reason: SkipReason
    index: int = field(default=-1, compare=False)


@dataclass(frozen=True)
class CollectedScene:
    """The entities of one snapshot plus the nodes that were left out (pass ``anonymized_names`` to ``RootExtras``)."""

    entities: tuple[Entity, ...]
    skipped: tuple[SkippedNode, ...]
    anonymized_names: bool


@dataclass(frozen=True, eq=False)
class Mesh:
    """Triangle mesh in the node's RAS frame (mm) — world RAS when a transform was baked: owned float64
    ``positions``/``normals`` ``(n, 3)``, int64 ``triangles`` ``(m, 3)`` with every point used and no triangle
    repeating a vertex."""

    positions: NDArray[np.float64] = field(repr=False)
    normals: NDArray[np.float64] = field(repr=False)
    triangles: NDArray[np.int64] = field(repr=False)


def _owned(array: vtkDataArray, dtype: type[np.generic]) -> NDArray[Any]:
    """An owned copy of a VTK data array, shaped ``(tuples, components)`` (``(tuples,)`` for one component).

    Same buffer access as ``numpy_support.vtk_to_numpy`` — whose result is a view into VTK memory that the filter
    outputs share with the input — minus its in-place ``shape`` assignment, deprecated in numpy 2.5.
    """
    tuples, components = array.GetNumberOfTuples(), array.GetNumberOfComponents()
    shape = (tuples, components) if components > 1 else (tuples,)
    if tuples == 0:
        return np.empty(shape, dtype=dtype)
    flat = np.frombuffer(array, dtype=get_numpy_array_type(array.GetDataType()))
    return flat.reshape(shape).astype(dtype)  # astype copies


def _triangles(cells: vtkCellArray) -> NDArray[np.int64]:
    """The 3-point cells of ``cells`` as an owned ``(m, 3)`` array (other cell sizes can survive the triangle
    filter's fast path and are dropped)."""
    count = cells.GetNumberOfCells()
    if count == 0:
        return np.empty((0, 3), dtype=np.int64)
    connectivity = _owned(cells.GetConnectivityArray(), np.int64)  # int32/int64/uint32 storage
    if cells.IsHomogeneous() == 3:
        return connectivity.reshape(count, 3)
    offsets = _owned(cells.GetOffsetsArray(), np.int64)
    starts = offsets[:-1][np.diff(offsets) == 3]
    return connectivity[starts[:, None] + np.arange(3)]


def _cell_array(triangles: NDArray[np.int64]) -> vtkCellArray:
    """A triangle-only ``vtkCellArray`` holding a copy of ``triangles`` ``(m, 3)``."""
    cells = vtkCellArray()
    offsets = np.arange(0, triangles.size + 1, 3, dtype=np.int64)
    cells.SetData(
        numpy_to_vtk(offsets, deep=True, array_type=VTK_ID_TYPE),
        numpy_to_vtk(triangles.ravel(), deep=True, array_type=VTK_ID_TYPE),
    )
    return cells


class InvalidMeshError(ValueError):
    """The polydata's cells reference points it does not have or are not integer IDs (a corrupt or crafted file)."""


def _integer_storage(array: vtkDataArray | None) -> bool:
    """Cell IDs stored as integers. VTK 9.6 also accepts bit and floating-point cell arrays (a legacy file can
    declare ``OFFSETS bit``); bits are not IDs, and a float such as NaN or 1e30 has no defined vtkIdType value."""
    if array is None or array.GetDataType() == VTK_BIT:
        return False
    try:
        return np.dtype(get_numpy_array_type(array.GetDataType())).kind in "iu"
    except KeyError:
        return False


def _check_cells(cells: vtkCellArray, point_count: int) -> None:
    """Refuse cells that the VTK filters would read or write out of bounds (they do not check point IDs: an ID
    ≥ the point count or negative crashes Slicer with a heap corruption)."""
    if cells.GetNumberOfCells() == 0:
        return
    if not (
        _integer_storage(cells.GetOffsetsArray()) and _integer_storage(cells.GetConnectivityArray())
    ):
        raise InvalidMeshError("cell arrays are not integer IDs")
    connectivity = _owned(cells.GetConnectivityArray(), np.int64)
    offsets = _owned(cells.GetOffsetsArray(), np.int64)
    if not (
        offsets.size >= 1
        and offsets[0] == 0
        and offsets[-1] == connectivity.size
        and np.all(np.diff(offsets) >= 0)
        and (
            connectivity.size == 0 or (connectivity.min() >= 0 and connectivity.max() < point_count)
        )
    ):
        raise InvalidMeshError("cell point IDs out of range")


def _geometry_copy(polydata: vtkPolyData) -> vtkPolyData:
    """A new polydata with deep copies of the points, polygons and strips of ``polydata`` and nothing else.

    Leaving out every attribute array also leaves out stored normals (``vtkPolyDataNormals`` returns existing float
    normals unchanged — they would not follow re-oriented triangles), scalars and texture coordinates the GLB never
    carries (FR-15), and arrays whose length does not match the cells (the triangle filter copies cell data without a
    bounds check). Leaving out vertices and lines matters because the triangle filter's all-triangle fast path passes
    lines through even with ``PassLinesOff`` and the normals filter would mix their normals into the mesh. Double
    points stay double (``vtkPoints.DeepCopy`` converts to the copy's type, float by default).
    """
    copy = vtkPolyData()
    points = vtkPoints()
    source_points = polydata.GetPoints()
    if source_points.GetDataType() in (VTK_FLOAT, VTK_DOUBLE):
        points.SetDataType(source_points.GetDataType())
    points.DeepCopy(source_points)
    copy.SetPoints(points)
    for source_cells, setter in (
        (polydata.GetPolys(), copy.SetPolys),
        (polydata.GetStrips(), copy.SetStrips),
    ):
        cells = vtkCellArray()
        cells.DeepCopy(source_cells)
        setter(cells)
    return copy


def _baked(
    points: vtkPoints, transform: vtkAbstractTransform, seed: NDArray[np.int64]
) -> tuple[vtkPoints, bool]:
    """``points`` moved by ``transform`` into double-precision points (the 3D view's ``vtkTransformFilter`` applies
    the same transform), and whether the transform mirrors at the centre of the ``seed`` triangle (point IDs).

    ``vtkPolyDataNormals(ConsistencyOn)`` orients each connected part like its lowest-ID triangle, so a mirror is
    judged where that orientation comes from: the sign of the transform's Jacobian at the first triangle.
    """
    moved = vtkPoints()
    moved.SetDataTypeToDouble()
    transform.Update()
    transform.TransformPoints(points, moved)
    out = [0.0, 0.0, 0.0]
    jacobian = [[0.0, 0.0, 0.0] for _ in range(3)]
    # untrusted coordinates (inf, 1e300) give inf/NaN here: no warning; the node is skipped by _finite_geometry later
    with np.errstate(all="ignore"):
        centre = np.mean([points.GetPoint(int(i)) for i in seed], axis=0)
        transform.InternalTransformDerivative([float(v) for v in centre], out, jacobian)
        mirrored = bool(np.linalg.det(np.asarray(jacobian, dtype=np.float64)) < 0)
    return moved, mirrored


def mesh_from_polydata(
    polydata: vtkPolyData | None, transform: vtkAbstractTransform | None = None
) -> Mesh | None:
    """Triangulated mesh with point normals for ``polydata`` (unchanged), or ``None`` when it has no triangle.

    The pipeline runs on :func:`_geometry_copy` — points, polygons and strips only; anything that is not a
    ``vtkPolyData`` counts as no mesh. With a ``transform`` the points are moved by it before the normals are computed
    (baking, see the module docstring); the mesh is then in the transform's output frame. Raises
    :class:`InvalidMeshError` — before any filter runs — when polygons or strips reference missing points or are not
    stored as integers.
    """
    if (
        not isinstance(polydata, vtkPolyData)
        or polydata.GetNumberOfPoints() == 0
        or polydata.GetPoints() is None
    ):
        return None
    copy = _geometry_copy(polydata)
    for cells in (copy.GetPolys(), copy.GetStrips()):
        _check_cells(cells, copy.GetNumberOfPoints())
    triangulate = vtkTriangleFilter()
    triangulate.PassVertsOff()
    triangulate.PassLinesOff()
    triangulate.SetInputData(copy)
    triangulate.Update()
    triangulated = triangulate.GetOutput()
    triangles = _triangles(triangulated.GetPolys())
    a, b, c = triangles.T
    # A triangle that repeats a vertex has no area and no normal, and it must go before ConsistencyOn: its edges
    # run both ways, so it would turn every triangle reached through it inside out (stitched strips make them).
    triangles = triangles[(a != b) & (b != c) & (a != c)]
    points = triangulated.GetPoints()
    if len(triangles) == 0 or points is None:
        return None
    if transform is not None:
        points, mirrored = _baked(points, transform, triangles[0])
        if mirrored:  # a mirror turns the triangles inside out: reverse them, so the normals point outwards again
            triangles = triangles[:, ::-1]
    # A triangle without area (collinear points, or flattened by a baked transform) has no normal of its own: as the
    # lowest-ID triangle it would seed ConsistencyOn with an arbitrary winding and turn the real ones over, and a
    # point only it uses would get a zero normal. It is invisible, so it goes.
    xyz = _owned(points.GetData(), np.float64)
    first = xyz[triangles[:, 0]]
    # non-finite or huge coordinates warn here; such a node is skipped later (invalid-geometry or no-triangles)
    with np.errstate(all="ignore"):
        area = np.cross(xyz[triangles[:, 1]] - first, xyz[triangles[:, 2]] - first)
    triangles = triangles[np.any(area != 0, axis=1)]
    if len(triangles) == 0:
        return None
    clean = vtkPolyData()
    clean.SetPoints(points)
    clean.SetPolys(_cell_array(triangles))
    normals = vtkPolyDataNormals()
    normals.SplittingOff()  # no duplicated points along feature edges (§7.4)
    normals.ConsistencyOn()
    normals.AutoOrientNormalsOff()
    normals.ComputePointNormalsOn()
    normals.ComputeCellNormalsOff()
    normals.SetInputData(clean)
    normals.Update()
    output = normals.GetOutput()
    points = output.GetPoints()
    point_normals = output.GetPointData().GetNormals()
    if points is None or point_normals is None:
        return None
    triangles = _triangles(output.GetPolys())  # ConsistencyOn may have reversed some
    positions = _owned(points.GetData(), np.float64)
    vertex_normals = _owned(point_normals, np.float64)
    used = np.zeros(len(positions), dtype=bool)
    used[triangles.ravel()] = True
    remap = np.cumsum(used) - 1
    return Mesh(positions[used], vertex_normals[used], remap[triangles])


def _finite_geometry(mesh: Mesh) -> bool:
    """Finite positions (also in metres as float32, what the GLB stores) and normals. A zero normal (normals that
    cancel out where two sheets lie back to back) is fine: ``coords.ras_to_gltf_normals`` makes it glTF +Y."""
    with np.errstate(over="ignore", invalid="ignore"):
        metres32 = (mesh.positions * 0.001).astype(np.float32)
    return bool(np.all(np.isfinite(metres32)) and np.all(np.isfinite(mesh.normals)))


def _display(props: Any) -> tuple[tuple[float, float, float], float, bool] | None:
    try:
        color, opacity, visible = props
        rgb = np.asarray(color, dtype=np.float64)
        alpha = float(opacity)
        shown = bool(visible)  # Slicer's getters return int; an array would raise here
    except (TypeError, ValueError):
        return None
    if rgb.shape != (3,) or not (np.all(np.isfinite(rgb)) and np.isfinite(alpha)):
        return None
    r, g, b = (float(v) for v in np.clip(rgb, 0.0, 1.0))
    return (r, g, b), float(np.clip(alpha, 0.0, 1.0)), shown


class _Bake:
    """What :func:`_placement` returns for a transform to bake into the vertices (the one instance :data:`_BAKE`)."""


_BAKE = _Bake()


def _placement(world: Any) -> NDArray[np.float64] | SkipReason | _Bake | None:
    """How a node with RAS world matrix ``world`` is placed: ``None`` (identity) or ``C·M·C⁻¹`` as ``T.matrix``,
    :data:`_BAKE` for a chain that is not linear (``None``) or is sheared (glTF ``node.matrix`` must be TRS, and the
    writer's own predicate decides — ``is_exportable_matrix``), or a skip reason for a matrix that is not a finite
    affine 4×4."""
    if world is None:
        return _BAKE
    try:
        matrix = ras_matrix_to_gltf(world)
    except (TypeError, ValueError):  # not a finite affine 4×4
        return SkipReason.INVALID_TRANSFORM
    if not is_exportable_matrix(matrix):
        return _BAKE
    return None if np.array_equal(matrix, np.eye(4)) else matrix


def _world_transform(world: Any, scene_api: SceneApi, node: Any) -> vtkAbstractTransform | None:
    """The transform to bake: a sheared linear world matrix as a ``vtkTransform`` (exact, no round trip through
    Slicer), otherwise the scene's own non-linear transform."""
    if world is not None:
        linear = vtkTransform()
        # row-major, like vtkMatrix4x4
        linear.SetMatrix([float(v) for v in np.asarray(world, dtype=np.float64).ravel()])
        return linear
    transform = scene_api.world_transform(node)
    return transform if isinstance(transform, vtkAbstractTransform) else None


#: The IDs Slicer generates for model nodes (``vtkMRMLModelNode4``: class name + counter, research note §3). With
#: *Hide node names* only IDs of this shape are exported: ``SetID`` and a hand-edited ``.mrml`` accept any string,
#: and an ID is repeated in every ``scene.update`` (T7).
_GENERATED_ID = re.compile(r"vtkMRMLModelNode[0-9]{1,10}")


def _valid_model_id(node_id: Any, *, anonymize: bool) -> bool:
    valid = (
        isinstance(node_id, str)
        and NODE_ID_PATTERN.fullmatch(node_id) is not None
        and "/" not in node_id
        and node_id != "root"
    )
    return valid and (not anonymize or _GENERATED_ID.fullmatch(node_id) is not None)


def _raw_name(name: Any) -> str | bytes | None:
    """A name of another type (an adapter bug) counts as no name: the node gets its substitute, not dropped."""
    return name if name is None or isinstance(name, (str, bytes)) else None


def collect_scene(scene_api: SceneApi, *, anonymize_names: bool = False) -> CollectedScene:
    """Collect every exportable model node of ``scene_api`` (see the module docstring)."""
    names = NameAssigner(anonymize=anonymize_names)
    entities: list[Entity] = []
    skipped: list[SkippedNode] = []
    seen: set[str] = set()
    for index, node in enumerate(scene_api.visible_model_nodes()):
        node_id = scene_api.node_id(node)
        if not _valid_model_id(node_id, anonymize=anonymize_names):
            skipped.append(SkippedNode("", SkipReason.INVALID_NODE_ID, index))
            continue
        if node_id in seen:
            skipped.append(SkippedNode(node_id, SkipReason.DUPLICATE_NODE_ID, index))
            continue
        seen.add(node_id)
        world = scene_api.world_matrix(node)
        matrix = _placement(world)
        if isinstance(matrix, SkipReason):
            skipped.append(SkippedNode(node_id, matrix, index))
            continue
        bake = None
        if matrix is _BAKE:
            bake, matrix = _world_transform(world, scene_api, node), None
            if bake is None:
                skipped.append(SkippedNode(node_id, SkipReason.NON_LINEAR_TRANSFORM, index))
                continue
        display = _display(scene_api.display_props(node))
        if display is None:
            skipped.append(SkippedNode(node_id, SkipReason.INVALID_DISPLAY, index))
            continue
        try:
            mesh = mesh_from_polydata(scene_api.polydata(node), bake)
        except InvalidMeshError:
            mesh = SkipReason.INVALID_GEOMETRY
        if mesh is None:
            mesh = SkipReason.NO_TRIANGLES
        elif not isinstance(mesh, SkipReason) and not _finite_geometry(mesh):
            mesh = SkipReason.INVALID_GEOMETRY
        if isinstance(mesh, SkipReason):
            skipped.append(SkippedNode(node_id, mesh, index))
            continue
        color, opacity, visible = display
        entities.append(
            Entity(
                node_id=node_id,
                kind="model",
                name=names.assign("model", _raw_name(scene_api.name(node))),
                positions=ras_to_gltf_points(mesh.positions, dtype=np.float64),
                normals=ras_to_gltf_normals(mesh.normals),
                indices=mesh.triangles,
                color=color,
                opacity=opacity,
                visible=visible,
                mrml_id=node_id,
                matrix=matrix,
                baked=bake is not None,
            )
        )
    return CollectedScene(tuple(entities), tuple(skipped), names.anonymize)


def collect_entities(scene_api: SceneApi, *, anonymize_names: bool = False) -> list[Entity]:
    """The entities of :func:`collect_scene` (plan SLC-07 signature)."""
    return list(collect_scene(scene_api, anonymize_names=anonymize_names).entities)
