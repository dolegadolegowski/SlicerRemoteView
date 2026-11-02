"""MRML collection (``docs/architecture.md`` §6.4, ADR 0005 + errata): Slicer model nodes and segments → GLB entities.

:func:`collect_scene` reads the scene through a small injectable :class:`SceneApi` (the real implementation is
:class:`~remoteview_core.mrml_scene.MrmlSceneApi`, SLC-22/SLC-35; tests use a fake) and returns one
:class:`~remoteview_core.glb_writer.Entity` per exportable model node and per shown segment (one handle per entity,
one code path for both), in glTF space:

- geometry: a **deep copy** of the node's points (same precision), polygons and strips only (the user's data is
  never touched — ADR 0005 §3; no attribute arrays, vertices or lines) → ``vtkTriangleFilter`` → triangles with a
  repeated vertex dropped → the bake, if any (below) → triangles without area dropped → ``vtkPolyDataNormals``
  (``SplittingOff``; ``ConsistencyOn`` when the winding is not already consistent and the mesh is not a
  non-manifold fan) → owned numpy arrays without the points no triangle uses; positions/normals converted with
  :mod:`remoteview_core.coords` (RAS mm → glTF m, +Y up);
- transform: a linear world matrix becomes ``T.matrix = C·M·C⁻¹`` (protocol §7.2), identity becomes no matrix; a
  world transform that is not linear, or linear with shear (glTF ``node.matrix`` must be TRS), is **baked** into the
  vertices instead (SLC-13, protocol §7.3 ``baked: true``, identity ``T.matrix``) — the 3D view applies it the same way,
  as a ``vtkTransformFilter`` on the mesh; normals are computed after it, and a transform that mirrors (negative
  Jacobian at the first triangle) gets the triangles reversed so that their front faces still point outwards;
- appearance: display colour/opacity clamped to 0..1, visibility as a bool;
- name: :class:`~remoteview_core.names.NameAssigner` (sanitised, or ``Model <n>``/``Segment <n>`` with *Hide node
  names*);
- identity (protocol v1.1 §7.3, :class:`~remoteview_core.ids.SceneIds`): a model's ``nodeId``/``mrmlId`` is its MRML
  ID when that is what Slicer generates, else an ``m_<n>`` alias — in both modes, never a skip; a segment's ``nodeId``
  is ``<mrmlId>/<segmentId>`` verbatim or ``<mrmlId>/s_<n>``, and ``extras.segmentId`` is the raw ID or omitted under
  *Hide node names*. The caller passes the session's registry so that every export reuses the aliases it issued
  (``ids=None`` makes a fresh one: fine for a single export).

A node that cannot be exported never aborts the snapshot: it is left out and reported in
:attr:`CollectedScene.skipped` with a :class:`SkipReason` — no triangles (empty, points or lines only; a segment
without a 3D representation or with a planar-contour one), a non-linear world transform the scene cannot hand over for
baking, duplicate IDs, an ID that is not a string at all (``GetID()`` returning ``None``: an adapter bug, never a
Slicer state), non-finite data (also after a bake), cells that reference missing points, are not stored as integers or
are strips of fewer than 3 points (checked before any VTK filter runs: the filters do not bounds-check point IDs), and
a polygon too large for the triangle filter to cut in one step (:data:`MAX_POLYGON_POINTS`, SLC-52; the other polygons
are triangulated in parts).

:func:`collect_steps` is the same collection in steps (SLC-28, :mod:`remoteview_core.steps`): one per filter or numpy
pass over a mesh and one per node, keeping the seen IDs and the names across them; :func:`collect_scene` runs it in
one call.

Main thread only (VTK). No Slicer or Qt import: the VTK classes come from ``vtkmodules``, which Slicer 5.12 and the
``vtk`` wheel provide identically (``docs/research/slicer-collect.md``).
"""

from __future__ import annotations

import enum
import itertools
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
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

from remoteview_core.clustering import edge_work
from remoteview_core.coords import ras_matrix_to_gltf, ras_to_gltf_normals, ras_to_gltf_points
from remoteview_core.glb_writer import Entity, is_exportable_matrix
from remoteview_core.ids import SceneIds
from remoteview_core.meshcache import CachedMesh, CachedSkip, MeshCache, Stamp, mesh_stamp
from remoteview_core.names import NameAssigner
from remoteview_core.steps import Progress, Steps, run


class SceneApi(Protocol):
    """What :func:`collect_scene` needs from a Slicer scene (one implementation per host; tests use fakes). The
    per-entity methods take a model node or a segment handle (what :meth:`visible_segments` yields); the adapter
    dispatches on the handle type, so the collection has one code path per entity."""

    def visible_model_nodes(self) -> Iterable[Any]:
        """The model nodes to export, in a stable order (the adapter decides which ones — FR-05, SLC-22)."""
        ...

    def visible_segments(self) -> Iterable[Any]:
        """One handle per segment the 3D view shows, in Slicer's segment order, grouped per segmentation node in
        scene order (the adapter decides which ones — SLC-35)."""
        ...

    def node_id(self, node: Any) -> str:
        """The MRML node ID (``vtkMRMLModelNode4``) of a model node, the raw of ``nodeId`` (protocol §7.3)."""
        ...

    def segment_identity(self, handle: Any) -> tuple[str, str | bytes]:
        """``(segmentation node MRML ID, raw segment ID)`` of a segment handle (``bytes`` for an ID that is not
        UTF-8)."""
        ...

    def name(self, node: Any) -> str | bytes | None:
        """The display name of a model node or a segment handle as Slicer stores it (VTK returns ``bytes`` for a name
        that is not UTF-8)."""
        ...

    def polydata(self, node: Any) -> vtkPolyData | None:
        """The mesh of a model node or a segment handle in its own coordinates (before the parent transform), or
        ``None``."""
        ...

    def display_props(self, node: Any) -> tuple[Sequence[float], float, bool]:
        """``(color [r, g, b] 0..1, opacity 0..1, visible)`` of the 3D display of a model node or a segment handle."""
        ...

    def world_matrix(self, node: Any) -> Any:
        """The 4×4 RAS (mm) node-to-world matrix of a model node or a segment handle (identity without a parent
        transform), or ``None`` when the parent transform chain is not linear."""
        ...

    def world_transform(self, node: Any) -> vtkAbstractTransform | None:
        """The whole node-to-world transform (RAS mm) of a model node or a segment handle as the 3D view applies it,
        for baking a chain that is not linear into the vertices; ``None`` when it cannot be had. Asked only when
        :meth:`world_matrix` is ``None``."""
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
    handle's position in ``visible_model_nodes()`` followed by ``visible_segments()`` so the panel can still show
    which one it was (local only, never sent; not part of equality). The repr shows the reason and the index only: a
    segment's ``nodeId`` may carry a verbatim, name-derived segment ID (T7), and a repr can reach a log."""

    node_id: str = field(repr=False)
    reason: SkipReason
    index: int = field(default=-1, compare=False)
    #: ``no-triangles`` and ``invalid-geometry`` only: the bake of the node's transform made a mesh that passes the
    #: check unbaked fail it — a new transform may lift the reason (SLC-30); false when the node's own mesh fails
    baked: bool = field(default=False, compare=False)


@dataclass(frozen=True, eq=False)
class Source:
    """Where an entity's mesh comes from (SLC-50): the polydata and the bake to collect it again, the handle's
    position (``SkippedNode.index``), its raw name (to name the entities again when one is left out late), the mesh's
    stamp (``None``: not cached), the triangle count collect gave, and the cache entry the entity was taken from
    (``None``: collected now). Its repr holds neither the name nor the mesh (T7)."""

    polydata: Any = field(repr=False)
    bake: vtkAbstractTransform | None = field(repr=False)
    index: int
    raw_name: str | bytes | None = field(repr=False)
    stamp: Stamp | None = field(repr=False)
    count: int
    cached: CachedMesh | None = field(default=None, repr=False)


@dataclass(frozen=True)
class CollectedScene:
    """The entities of one snapshot plus the nodes that were left out (pass ``anonymized_names`` to ``RootExtras``);
    ``sources`` has one :class:`Source` per entity."""

    entities: tuple[Entity, ...]
    skipped: tuple[SkippedNode, ...]
    anonymized_names: bool
    sources: tuple[Source, ...] = field(default=(), compare=False, repr=False)


@dataclass(frozen=True, eq=False)
class Mesh:
    """Triangle mesh in the frame of its input — a node's RAS frame (mm), world RAS when a transform was baked, glTF
    metres for :func:`mesh_from_triangles` on an entity: owned float64
    ``positions``/``normals`` ``(n, 3)``, int64 ``triangles`` ``(m, 3)`` with every point used and no triangle
    repeating a vertex."""

    positions: NDArray[np.float64] = field(repr=False)
    normals: NDArray[np.float64] = field(repr=False)
    triangles: NDArray[np.int64] = field(repr=False)


def _view(array: vtkDataArray) -> NDArray[Any]:
    """A read-only view of a VTK data array's memory in its own type, shaped ``(tuples, components)`` (``(tuples,)``
    for one component); valid while the array is neither changed nor freed.

    Same buffer access as ``numpy_support.vtk_to_numpy`` — whose result is a view into VTK memory that the filter
    outputs share with the input — minus its in-place ``shape`` assignment, deprecated in numpy 2.5.
    """
    tuples, components = array.GetNumberOfTuples(), array.GetNumberOfComponents()
    shape = (tuples, components) if components > 1 else (tuples,)
    dtype = get_numpy_array_type(array.GetDataType())
    flat = np.empty(0, dtype=dtype) if tuples == 0 else np.frombuffer(array, dtype=dtype)
    view = flat.reshape(shape)
    view.flags.writeable = False
    return view


def _owned(array: vtkDataArray, dtype: type[np.generic]) -> NDArray[Any]:
    """An owned copy of a VTK data array (:func:`_view`) in ``dtype``."""
    return _view(array).astype(dtype)  # astype copies


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
    """The polydata's cells reference points it does not have, are not integer IDs or are strips of fewer than 3
    points, or it holds a polygon too large to triangulate in one step (:data:`MAX_POLYGON_POINTS`): a corrupt or
    crafted file."""


def _integer_storage(array: vtkDataArray | None) -> bool:
    """Cell IDs stored as integers. VTK 9.6 also accepts bit and floating-point cell arrays (a legacy file can
    declare ``OFFSETS bit``); bits are not IDs, and a float such as NaN or 1e30 has no defined vtkIdType value."""
    if array is None or array.GetDataType() == VTK_BIT:
        return False
    try:
        return np.dtype(get_numpy_array_type(array.GetDataType())).kind in "iu"
    except KeyError:
        return False


#: ``vtkTriangleFilter`` cuts a polygon of n ≥ 4 points with an ear cut (``vtkPolygon::EarCutTriangulation``) in about
#: O(n²) time, and a node's polygons in one call: one step that SLC-28's steps cannot split (SLC-52). Measured in the
#: sandbox (VTK 9.6.2, best of three; the research note has the figures): about 12 ns × (n² + 64) per polygon — the 64
#: is the fixed cost of an ear cut, most of the time for 5 to 8 points — except a quad the ear cut rejects (a bow tie,
#: repeated or collinear points), which ``vtkQuad`` cuts in about 4 µs, so a quad counts 400 units. Small polygons whose
#: points are scattered over a large array take up to 18 ns a unit (cache misses). A triangle in the same pass costs
#: 34 ns, as much as 3 units. One polygon of a million points freezes Slicer. So a node with a polygon of more than
#: ``MAX_POLYGON_POINTS`` points is left out as ``invalid-geometry`` before the filter runs, and the other polygons are
#: cut in parts of at most the work of one polygon of ``MAX_POLYGON_POINTS`` points, one step each: about 0.4 s a part
#: (a thin zigzag ribbon of 6,000 points, 360,000 hexagons or 90,000 bow-tie quads), up to about 0.65 s for small
#: polygons over scattered points. A node of cells of at most 3 points, or whose polygons fit in one part, is cut in one
#: call, as before; strips are cut in linear time, after the parts.
MAX_POLYGON_POINTS = 6_000


def _cut_work(sizes: NDArray[np.int64]) -> NDArray[np.int64]:
    """The triangle filter's work for cells of ``sizes`` points (≤ :data:`MAX_POLYGON_POINTS`), in the units above (one
    new array: a node can have tens of millions of cells)."""
    work = sizes * sizes
    work += 64
    work[sizes == 4] = 400
    work[sizes < 4] = 3
    return work


def _check_cells(cells: vtkCellArray, point_count: int) -> NDArray[np.int64]:
    """The number of points of each cell, once cells that the VTK filters would read or write out of bounds are refused
    (they do not check point IDs: an ID ≥ the point count or negative crashes Slicer with a heap corruption)."""
    if cells.GetNumberOfCells() == 0:
        return np.empty(0, dtype=np.int64)
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
        # compared, not subtracted: a difference of crafted offsets can wrap around int64 and look positive
        and np.all(offsets[1:] >= offsets[:-1])
        and (
            connectivity.size == 0 or (connectivity.min() >= 0 and connectivity.max() < point_count)
        )
    ):
        raise InvalidMeshError("cell point IDs out of range")
    return np.diff(offsets)


def _cut_parts(sizes: NDArray[np.int64]) -> list[int]:
    """Cell indices that split polygons of ``sizes`` points into parts of at most the triangle filter's work for one
    polygon of :data:`MAX_POLYGON_POINTS` points (and at least one cell), in order: ``[0, len(sizes)]`` when one part
    holds them all, or for cells of at most 3 points, however many. Raises :class:`InvalidMeshError` for a polygon of
    more points."""
    count = len(sizes)
    # cells of at most 3 points: one linear call (the filter or _triangles drops the smaller cells)
    if count == 0 or sizes.max() <= 3:
        return [0, count]
    if sizes.max() > MAX_POLYGON_POINTS:  # checked first: n² of a crafted size can overflow
        raise InvalidMeshError("a polygon too large to triangulate")
    budget = int(_cut_work(np.array([MAX_POLYGON_POINTS]))[0])
    work = _cut_work(sizes)
    np.cumsum(work, out=work)
    bounds = [0]
    while (start := bounds[-1]) < count:
        done = int(work[start - 1]) if start else 0
        bounds.append(max(start + 1, int(np.searchsorted(work, done + budget, side="right"))))
    return bounds


def _cut(data: vtkPolyData) -> NDArray[np.int64]:
    """The triangles ``vtkTriangleFilter`` cuts the polygons and strips of ``data`` into, as an owned ``(m, 3)`` array
    of IDs of the points of ``data`` (its output keeps the input's points: ``SetPoints(input->GetPoints())``,
    vtkTriangleFilter.cxx, VTK 9.6.2). The polygons come first, then the strips, each in their order."""
    triangulate = vtkTriangleFilter()
    triangulate.PassVertsOff()
    triangulate.PassLinesOff()
    triangulate.SetInputData(data)
    triangulate.Update()
    return _triangles(triangulate.GetOutput().GetPolys())


def _part(
    copy: vtkPolyData, offsets: NDArray[Any], connectivity: NDArray[Any], start: int, stop: int
) -> vtkPolyData:
    """A polydata over the points of ``copy`` with a copy of its polygons ``start`` to ``stop`` (``offsets`` and
    ``connectivity`` are views of its polygon arrays)."""
    part_offsets = offsets[start : stop + 1].astype(np.int64)
    cells = vtkCellArray()
    cells.SetData(
        numpy_to_vtk(part_offsets - part_offsets[0], deep=True, array_type=VTK_ID_TYPE),
        numpy_to_vtk(
            connectivity[part_offsets[0] : part_offsets[-1]].astype(np.int64),
            deep=True,
            array_type=VTK_ID_TYPE,
        ),
    )
    part = vtkPolyData()
    part.SetPoints(copy.GetPoints())
    part.SetPolys(cells)
    return part


def _cut_steps(copy: vtkPolyData, bounds: list[int]) -> Steps[NDArray[np.int64]]:
    """:func:`_cut` of ``copy`` in steps: the polygons in the parts ``bounds`` gives (:func:`_cut_parts`), one step
    each, then the strips — the same triangles in the same order as one call."""
    if len(bounds) <= 2:
        return _cut(copy)
    polys = copy.GetPolys()
    offsets, connectivity = _view(polys.GetOffsetsArray()), _view(polys.GetConnectivityArray())
    pieces = []
    for start, stop in itertools.pairwise(bounds):
        pieces.append(_cut(_part(copy, offsets, connectivity, start, stop)))
        yield
    if copy.GetNumberOfStrips():
        strips = vtkPolyData()
        strips.SetPoints(copy.GetPoints())
        strips.SetStrips(copy.GetStrips())
        pieces.append(_cut(strips))
    return np.concatenate(pieces)


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
    stored as integers, a strip has fewer than 3 points or a polygon more than :data:`MAX_POLYGON_POINTS`.
    """
    return run(mesh_steps(polydata, transform))


def mesh_steps(
    polydata: vtkPolyData | None, transform: vtkAbstractTransform | None = None
) -> Steps[Mesh | None]:
    """:func:`mesh_from_polydata` in steps: one per filter or numpy pass over the mesh (SLC-28)."""
    if (
        not isinstance(polydata, vtkPolyData)
        or polydata.GetNumberOfPoints() == 0
        or polydata.GetPoints() is None
    ):
        return None
    copy = _geometry_copy(polydata)
    yield
    bounds = _cut_parts(_check_cells(copy.GetPolys(), copy.GetNumberOfPoints()))
    # vtkTriangleStrip::DecomposeStrip reads a strip's first two IDs whatever its size (vtkTriangleStrip.cxx, VTK
    # 9.6.2): past its own for a strip of 0 or 1 point (0 crashes Slicer); one of 2 points makes no triangle, and no
    # VTK filter makes such strips.
    if np.any(_check_cells(copy.GetStrips(), copy.GetNumberOfPoints()) < 3):
        raise InvalidMeshError("a strip of fewer than 3 points")
    yield
    triangles = yield from _cut_steps(copy, bounds)
    yield
    a, b, c = triangles.T
    # A triangle that repeats a vertex has no area and no normal, and it must go before ConsistencyOn: its edges
    # run both ways, so it would turn every triangle reached through it inside out (stitched strips make them).
    triangles = triangles[(a != b) & (b != c) & (a != c)]
    points = copy.GetPoints()
    if len(triangles) == 0:
        return None
    if transform is not None:
        yield
        points, mirrored = _baked(points, transform, triangles[0])
        if mirrored:  # a mirror turns the triangles inside out: reverse them, so the normals point outwards again
            triangles = triangles[:, ::-1]
    yield
    return (yield from _normals_steps(points, triangles))


def mesh_points_and_triangles(
    polydata: vtkPolyData,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """Owned float64 points ``(n, 3)`` and the 3-point polygons ``(m, 3)`` of a filter's output (e.g. a decimation)."""
    points = polydata.GetPoints()
    if points is None:
        return np.empty((0, 3), dtype=np.float64), np.empty((0, 3), dtype=np.int64)
    return _owned(points.GetData(), np.float64).reshape(-1, 3), _triangles(polydata.GetPolys())


def polydata_from_triangles(
    positions: NDArray[np.float64], triangles: NDArray[np.int64]
) -> vtkPolyData:
    """A new polydata with copies of ``positions`` (double) and ``triangles`` (point IDs, not checked)."""
    points = vtkPoints()
    points.SetData(numpy_to_vtk(np.asarray(positions, dtype=np.float64), deep=True))
    data = vtkPolyData()
    data.SetPoints(points)
    data.SetPolys(_cell_array(np.asarray(triangles, dtype=np.int64)))
    return data


def mesh_from_triangles(
    positions: NDArray[np.float64], triangles: NDArray[np.int64], *, orient: bool = True
) -> Mesh | None:
    """The :class:`Mesh` of ``triangles`` over ``positions`` with point normals computed as for a collected node (same
    frame as the input), or ``None`` when no triangle with an area is left. Triangles that repeat a vertex or reference
    a missing point are dropped. A point normal can be zero (normals that cancel out): callers that write it directly
    must check. ``orient=False`` keeps the given winding (no ``ConsistencyOn``; decimate's last step, SLC-41)."""
    triangles = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    positions = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    a, b, c = triangles.T
    in_range = np.all((triangles >= 0) & (triangles < len(positions)), axis=1)
    triangles = triangles[in_range & (a != b) & (b != c) & (a != c)]
    if len(triangles) == 0:
        return None
    return _with_normals(
        polydata_from_triangles(positions, triangles).GetPoints(), triangles, orient=orient
    )


#: The steps of the collection handle a large mesh in parts of this many triangles (SLC-28): the area test's parts take
#: a fixed time each; a part of the winding sort sorts only its share of the edges but picks it out of all of them, so
#: it grows with the mesh — 0.16 / 0.26 / 0.34 s natively on spheres of 4.2M / 16M / 32M triangles (0.63-0.67 s on the
#: 31.4M-triangle surface of the research note), against 2.7 s for that sort in one step. The total masking work is
#: O(m² / CHUNK_TRIANGLES): fine at these sizes.
CHUNK_TRIANGLES = 4_000_000


def _consistently_wound(triangles: NDArray[np.int64]) -> bool:
    """No directed edge appears twice: every edge then has at most two triangles, traversed in opposite directions,
    and ``vtkOrientPolyData`` (what ``ConsistencyOn`` runs) would turn nothing over. True for no triangle."""
    return run(_consistently_wound_steps(triangles))


def _consistently_wound_steps(triangles: NDArray[np.int64]) -> Steps[bool]:
    """:func:`_consistently_wound` in steps: the directed edges are sorted in parts of about
    :data:`CHUNK_TRIANGLES` triangles' edges, split by their first vertex — both copies of a repeated edge have it."""
    if len(triangles) == 0:
        return True
    n = int(triangles.max()) + 1
    first = triangles.ravel()
    key = first * n + triangles[:, [1, 2, 0]].ravel()
    parts = -(-len(triangles) // CHUNK_TRIANGLES)
    bounds = [n * i // parts for i in range(parts + 1)]
    for low, high in itertools.pairwise(bounds):
        yield
        part = key if parts == 1 else key[(first >= low) & (first < high)]
        part.sort()
        if np.any(part[1:] == part[:-1]):
            return False
    return True


#: ``ConsistencyOn`` is skipped on a non-manifold fan, a mesh whose
#: :func:`~remoteview_core.clustering.edge_work` is above both ``ORIENT_WORK`` and ``ORIENT_WORK_PER_TRIANGLE`` per
#: triangle: ``vtkOrientPolyData`` calls ``GetCellEdgeNeighbors`` on every edge it crosses, so on a fan its time grows
#: with the cube of the page count (3,000 pages on one spine: 172 s natively, about 1 s per 4e9). An ordinary mesh
#: measures 106-148 per triangle whatever its size, so a large one is still re-oriented when it needs it (a sphere of
#: 20.2M triangles with a reversed patch, 118 per triangle: 7.15 s natively; with the absolute bound alone, every mesh
#: above about 15M triangles kept a reversed patch, SLC-41 review). A mesh consistently wound skips it anyway (SLC-41).
ORIENT_WORK = 2e9
ORIENT_WORK_PER_TRIANGLE = 1_000.0


def _orientable_steps(triangles: NDArray[np.int64]) -> Steps[bool]:
    """Whether ``ConsistencyOn`` should run: the winding is not consistent and the mesh is not a non-manifold fan
    (:data:`ORIENT_WORK`)."""
    if (yield from _consistently_wound_steps(triangles)):
        return False
    yield
    work = edge_work(triangles)
    return work <= ORIENT_WORK or work <= ORIENT_WORK_PER_TRIANGLE * len(triangles)


def _with_normals(
    points: vtkPoints, triangles: NDArray[np.int64], *, orient: bool = True
) -> Mesh | None:
    """The pipeline's last steps: drop triangles without area, compute the point normals (re-orienting the
    triangles consistently if ``orient``), drop unused points."""
    return run(_normals_steps(points, triangles, orient=orient))


def _normals_steps(
    points: vtkPoints, triangles: NDArray[np.int64], *, orient: bool = True
) -> Steps[Mesh | None]:
    """:func:`_with_normals` in steps."""
    # A triangle without area (collinear points, or flattened by a baked transform) has no normal of its own: as the
    # lowest-ID triangle it would seed ConsistencyOn with an arbitrary winding and turn the real ones over, and a
    # point only it uses would get a zero normal. It is invisible, so it goes.
    xyz = _owned(points.GetData(), np.float64)
    with_area = np.empty(len(triangles), dtype=bool)
    for start in range(0, len(triangles), CHUNK_TRIANGLES):
        part = triangles[start : start + CHUNK_TRIANGLES]
        first = xyz[part[:, 0]]
        # non-finite or huge coordinates warn here; such a node is skipped later (invalid-geometry or no-triangles)
        with np.errstate(all="ignore"):
            area = np.cross(xyz[part[:, 1]] - first, xyz[part[:, 2]] - first)
        with_area[start : start + CHUNK_TRIANGLES] = np.any(area != 0, axis=1)
        yield
    triangles = triangles[with_area]
    if len(triangles) == 0:
        return None
    consistency = orient and (yield from _orientable_steps(triangles))
    yield
    clean = vtkPolyData()
    clean.SetPoints(points)
    clean.SetPolys(_cell_array(triangles))
    normals = vtkPolyDataNormals()
    normals.SplittingOff()  # no duplicated points along feature edges (§7.4)
    # ConsistencyOn runs vtkOrientPolyData (vtkPolyDataNormals.cxx#L245-L255, v9.6.0). On a mesh whose winding is
    # already consistent it turns nothing over, so it is skipped: same output, 4.87 s -> 2.8 s on 16M triangles; on a
    # non-manifold fan, where it is unbounded (ORIENT_WORK), the given winding is kept (docs/research/slicer-decimate.md
    # § SLC-41).
    normals.SetConsistency(consistency)
    normals.AutoOrientNormalsOff()
    normals.ComputePointNormalsOn()
    normals.ComputeCellNormalsOff()
    normals.SetInputData(clean)
    normals.Update()
    yield
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


def display_of(props: Any) -> tuple[tuple[float, float, float], float, bool] | None:
    """``SceneApi.display_props`` as exported — colour and opacity clipped to 0..1, visibility a bool — or ``None``
    when they are not a finite colour and opacity (the node is then skipped as ``invalid-display``)."""
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
    """What :func:`placement_of` returns for a transform to bake into the vertices (the one instance :data:`BAKE`)."""


BAKE = _Bake()


def placement_of(world: Any) -> NDArray[np.float64] | SkipReason | _Bake | None:
    """How a node with RAS world matrix ``world`` is placed: ``None`` (identity) or ``C·M·C⁻¹`` as ``T.matrix``,
    :data:`BAKE` for a chain that is not linear (``None``) or is sheared (glTF ``node.matrix`` must be TRS, and the
    writer's own predicate decides — ``is_exportable_matrix``), or a skip reason for a matrix that is not a finite
    affine 4×4."""
    if world is None:
        return BAKE
    try:
        matrix = ras_matrix_to_gltf(world)
    except (TypeError, ValueError):  # not a finite affine 4×4
        return SkipReason.INVALID_TRANSFORM
    if not is_exportable_matrix(matrix):
        return BAKE
    return None if np.array_equal(matrix, np.eye(4)) else matrix


def transform_to_bake(world: Any, scene_api: SceneApi, node: Any) -> vtkAbstractTransform | None:
    """The transform to bake: a sheared linear world matrix as a ``vtkTransform`` (exact, no round trip through
    Slicer), otherwise the scene's own non-linear transform."""
    if world is not None:
        linear = vtkTransform()
        # row-major, like vtkMatrix4x4
        linear.SetMatrix([float(v) for v in np.asarray(world, dtype=np.float64).ravel()])
        return linear
    transform = scene_api.world_transform(node)
    return transform if isinstance(transform, vtkAbstractTransform) else None


def raw_name(name: Any) -> str | bytes | None:
    """A name of another type (an adapter bug) counts as no name: the node gets its substitute, not dropped."""
    return name if name is None or isinstance(name, (str, bytes)) else None


def _checked_mesh_steps(
    polydata: Any, bake: vtkAbstractTransform | None
) -> Steps[Mesh | SkipReason]:
    """The node's mesh (baked by ``bake``), or why the export leaves it out."""
    try:
        mesh = yield from mesh_steps(polydata, bake)
    except InvalidMeshError:
        return SkipReason.INVALID_GEOMETRY
    if mesh is None:
        return SkipReason.NO_TRIANGLES
    yield
    return mesh if _finite_geometry(mesh) else SkipReason.INVALID_GEOMETRY


class _Collector:
    """One collection (:func:`collect_steps`): the entities and skips so far, the names and the ID registry it
    uses — kept across its steps."""

    def __init__(
        self, scene_api: SceneApi, ids: SceneIds, *, anonymize: bool, cache: MeshCache | None
    ) -> None:
        self._scene = scene_api
        self._ids = ids
        self._anonymize = anonymize
        self._cache = cache
        self._names = NameAssigner(anonymize=anonymize)
        self.entities: list[Entity] = []
        self.sources: list[Source] = []
        self.skipped: list[SkippedNode] = []
        self.meshes_read: list[
            str
        ] = []  # the nodes whose mesh was looked at: their cache entries stay
        self._seen: set[str] = set()
        self._index = -1  # the handle's position across both lists

    @property
    def anonymize(self) -> bool:
        return self._names.anonymize

    def model(self, node: Any) -> Steps[None]:
        self._index += 1
        node_id = self._ids.model_node_id(self._scene.node_id(node))
        if node_id is None:  # GetID() is not a string: an adapter bug, never a Slicer state
            self.skipped.append(SkippedNode("", SkipReason.INVALID_NODE_ID, self._index))
            return
        yield from self._collect_one(node, node_id, "model", node_id, None)

    def segment(self, handle: Any) -> Steps[None]:
        self._index += 1
        node_raw, seg_raw = self._scene.segment_identity(handle)
        node_id = self._ids.segment_node_id(node_raw, seg_raw, anonymize=self._anonymize)
        if node_id is None:  # neither raw ID is a string
            self.skipped.append(SkippedNode("", SkipReason.INVALID_NODE_ID, self._index))
            return
        mrml_id = (
            self._ids.model_node_id(node_raw) or ""
        )  # never empty: a segment nodeId implies its prefix
        yield from self._collect_one(
            handle,
            node_id,
            "segment",
            mrml_id,
            self._ids.segment_extra(seg_raw, anonymize=self._anonymize),
        )

    def _collect_one(
        self, handle: Any, node_id: str, kind: str, mrml_id: str, segment_id: str | None
    ) -> Steps[None]:
        """Export one entity (a model node or a segment handle) under ``node_id``, or report why not."""
        index, scene = self._index, self._scene
        if node_id in self._seen:
            self.skipped.append(SkippedNode(node_id, SkipReason.DUPLICATE_NODE_ID, index))
            return
        self._seen.add(node_id)
        world = scene.world_matrix(handle)
        matrix = placement_of(world)
        if isinstance(matrix, SkipReason):
            self.skipped.append(SkippedNode(node_id, matrix, index))
            return
        bake = None
        if matrix is BAKE:
            bake, matrix = transform_to_bake(world, scene, handle), None
            if bake is None:
                self.skipped.append(SkippedNode(node_id, SkipReason.NON_LINEAR_TRANSFORM, index))
                return
        display = display_of(scene.display_props(handle))
        if display is None:
            self.skipped.append(SkippedNode(node_id, SkipReason.INVALID_DISPLAY, index))
            return
        polydata = scene.polydata(handle)
        stamp = self._stamp(node_id, polydata, world, bake)
        cached = self._cache.get(node_id, stamp) if self._cache is not None else None
        if isinstance(cached, CachedSkip):
            self.skipped.append(SkippedNode(node_id, cached.reason, index, baked=cached.baked))
            return
        if cached is None:
            outcome = yield from _mesh_or_skip_steps(polydata, bake)
            if isinstance(outcome, tuple):
                reason, baked = outcome
                self.skipped.append(SkippedNode(node_id, reason, index, baked=baked))
                if stamp is not None and self._cache is not None:
                    self._cache.put(node_id, CachedSkip(stamp, reason, baked))
                return
            yield
            geometry = _gltf_geometry(outcome)
        else:
            # the mesh as the last export sent it; collected again if this export gives the node another share
            geometry = (cached.positions, cached.normals, cached.indices)
        positions, normals, indices = geometry
        color, opacity, visible = display
        name = raw_name(scene.name(handle))
        self.entities.append(
            Entity(
                node_id=node_id,
                kind=kind,
                name=self._names.assign(kind, name),
                positions=positions,
                normals=normals,
                indices=indices,
                color=color,
                opacity=opacity,
                visible=visible,
                mrml_id=mrml_id,
                segment_id=segment_id,
                matrix=matrix,
                baked=bake is not None,
            )
        )
        count = len(indices) if cached is None else cached.count
        self.sources.append(Source(polydata, bake, index, name, stamp, count, cached))

    def _stamp(self, node_id: str, polydata: Any, world: Any, bake: Any) -> Stamp | None:
        """The stamp the cache keys ``node_id``'s mesh by (``None``: no cache, no ``vtkPolyData``, or a non-linear
        chain, whose transform is a new object at every read — the node's entry, if any, goes)."""
        if self._cache is None:
            return None
        self.meshes_read.append(node_id)
        stamp = None
        if bake is None or world is not None:
            sheared = (
                None
                if bake is None
                else tuple(np.asarray(world, dtype=np.float64).ravel().tolist())
            )
            stamp = mesh_stamp(polydata, sheared)
        if stamp is None:
            self._cache.discard(node_id)
        return stamp


def _mesh_or_skip_steps(
    polydata: Any, bake: vtkAbstractTransform | None
) -> Steps[Mesh | tuple[SkipReason, bool]]:
    """The node's mesh (baked by ``bake``), or why the export leaves it out and whether the bake is to blame — only
    if the mesh passes unbaked (``SkippedNode.baked``; the extra check runs for skipped nodes only)."""
    mesh = yield from _checked_mesh_steps(polydata, bake)
    if not isinstance(mesh, SkipReason):
        return mesh
    unbaked = (yield from _checked_mesh_steps(polydata, None)) if bake is not None else None
    return mesh, bake is not None and not isinstance(unbaked, SkipReason)


def _gltf_geometry(
    mesh: Mesh,
) -> tuple[NDArray[np.float64], NDArray[np.float32], NDArray[np.int64]]:
    """A collected mesh's positions, normals and triangles in glTF space."""
    return (
        ras_to_gltf_points(mesh.positions, dtype=np.float64),
        ras_to_gltf_normals(mesh.normals),
        mesh.triangles,
    )


def recollect_steps(entity: Entity, source: Source) -> Steps[Entity | tuple[SkipReason, bool]]:
    """``entity`` with its mesh collected again from ``source`` (SLC-50: a decimated node taken from the cache whose
    share changed), or why that mesh is now left out — it changed since the node was listed — and whether its bake
    is to blame."""
    outcome = yield from _mesh_or_skip_steps(source.polydata, source.bake)
    if isinstance(outcome, tuple):
        return outcome
    yield
    positions, normals, indices = _gltf_geometry(outcome)
    return replace(entity, positions=positions, normals=normals, indices=indices)


def collect_scene(
    scene_api: SceneApi, *, anonymize_names: bool = False, ids: SceneIds | None = None
) -> CollectedScene:
    """Collect every exportable model node, then every shown segment, of ``scene_api`` (see the module docstring).
    ``ids`` is the session's alias registry (a fresh one when ``None``)."""
    return run(collect_steps(scene_api, anonymize_names=anonymize_names, ids=ids))


def collect_steps(
    scene_api: SceneApi,
    *,
    anonymize_names: bool = False,
    ids: SceneIds | None = None,
    progress: Progress | None = None,
    cache: MeshCache | None = None,
) -> Steps[CollectedScene]:
    """:func:`collect_scene` in steps (SLC-28): both lists are read first, then each node is collected in the steps
    of its mesh and one more. ``progress`` gets two units of work per node (this collection and its fit) in
    ``total`` and one in ``done`` per node collected. With a ``cache`` (SLC-50) a node whose mesh has the stamp of
    its entry is not collected: it gets the entry's fitted geometry (``Source.cached``), or its skip; entries of the
    nodes whose mesh was not looked at are dropped."""
    collector = _Collector(
        scene_api, ids if ids is not None else SceneIds(), anonymize=anonymize_names, cache=cache
    )
    models, segments = list(scene_api.visible_model_nodes()), list(scene_api.visible_segments())
    progress = progress if progress is not None else Progress()
    progress.total += 2 * (len(models) + len(segments))
    for collect, handles in ((collector.model, models), (collector.segment, segments)):
        for handle in handles:
            yield from collect(handle)
            progress.done += 1
            yield
    if cache is not None:
        cache.keep_only(collector.meshes_read)
    return CollectedScene(
        tuple(collector.entities),
        tuple(collector.skipped),
        collector.anonymize,
        tuple(collector.sources),
    )


def collect_entities(scene_api: SceneApi, *, anonymize_names: bool = False) -> list[Entity]:
    """The entities of :func:`collect_scene` (plan SLC-07 signature)."""
    return list(collect_scene(scene_api, anonymize_names=anonymize_names).entities)
