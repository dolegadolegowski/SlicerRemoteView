"""RAS millimetres → glTF metres, +Y up (``docs/protocol.md`` §7.1; ADR 0005 §4).

Slicer works in RAS (+X right, +Y anterior, +Z superior) millimetres; glTF is right-handed, +Y up, metres. The
contract is ``[x, y, z]_gltf = [R, S, -A] × 0.001`` (§7.1), i.e. ``p_gltf = C · p_ras`` with the change of basis

    C = 0.001 · [[1, 0,  0],      x =  R
                 [0, 0,  1],      y =  S
                 [0, -1, 0]]      z = −A

(rows act on the column vector ``(R, A, S)``). Its rotation part has determinant +1, so triangle winding (and
therefore front faces) is preserved. Points use ``C``, normals the rotation part only, and 4×4 transforms
``C · M · C⁻¹`` (the matrix that does in glTF space what ``M`` does in RAS space). The patient faces −Z; viewers
may rotate the root but never the data (§7.1).

Note: ADR 0005 §4 and the research note print ``C`` as ``[[1,0,0],[0,0,-1],[0,1,0]]``; read row by row that is
the transpose (``[R, -S, A]``) — it is the column-major listing used by SlicerOpenAnatomy's root matrix. The
normative formula of protocol §7.1 wins; the asymmetric tests in ``tests/test_coords.py`` pin it (report:
``docs/testing/reports/2026-10-18-slicer-1.md``).

Pure numpy, no Slicer/VTK import (CLAUDE.md rule 10).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike, DTypeLike, NDArray

#: Millimetres → metres (§7.1).
MM_TO_M = 0.001

#: Rotation part of ``C``: ``(R, A, S) → (R, S, −A)``. Orthonormal, determinant +1.
RAS_TO_GLTF_ROTATION: NDArray[np.float64] = np.array(
    [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float64
)
RAS_TO_GLTF_ROTATION.setflags(write=False)


def _homogeneous(linear: NDArray[np.float64]) -> NDArray[np.float64]:
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = linear
    out.setflags(write=False)
    return out


#: ``C`` as a 4×4 homogeneous matrix (RAS mm → glTF m).
RAS_TO_GLTF: NDArray[np.float64] = _homogeneous(MM_TO_M * RAS_TO_GLTF_ROTATION)
#: ``C⁻¹`` (glTF m → RAS mm); the rotation is orthonormal, so the inverse is the transpose over the scale.
GLTF_TO_RAS: NDArray[np.float64] = _homogeneous(RAS_TO_GLTF_ROTATION.T / MM_TO_M)


def _as_vec3_array(values: ArrayLike, what: str) -> NDArray[np.float64]:
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 3:
        raise ValueError(f"{what} must have shape (n, 3), got {arr.shape}")
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{what} contain non-finite values")
    return arr


def _float_dtype(dtype: DTypeLike) -> np.dtype:
    result = np.dtype(dtype)
    if result.kind != "f":  # an integer dtype would silently truncate metres to 0
        raise ValueError(f"dtype must be a floating-point type, got {result}")
    return result


def _finite(result: NDArray, what: str, dtype: DTypeLike = np.float64) -> NDArray:
    """Cast to ``dtype`` and require finite values: outputs feed GLB ``min``/``max`` and JSON matrices, so a finite
    input that overflows (e.g. > 3.4e38 m in float32) must fail here, never become ``Infinity`` downstream."""
    with np.errstate(over="ignore", invalid="ignore"):
        result = result.astype(dtype)
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{what} overflow the output type")
    return result


def ras_to_gltf_points(points: ArrayLike, dtype: DTypeLike = np.float32) -> NDArray:
    """Convert ``(n, 3)`` RAS millimetre points to glTF metres (computed in float64, returned as ``dtype``)."""
    out_dtype = _float_dtype(dtype)
    arr = _as_vec3_array(points, "points")
    return _finite(arr @ (MM_TO_M * RAS_TO_GLTF_ROTATION).T, "points", out_dtype)


def ras_to_gltf_normals(normals: ArrayLike, dtype: DTypeLike = np.float32) -> NDArray:
    """Rotate ``(n, 3)`` RAS normals into glTF space (no scale) and renormalise to unit length.

    An all-zero input normal (degenerate geometry) becomes glTF ``+Y`` so the ``NORMAL`` accessor stays unit
    length as glTF requires (§7.4); non-finite input raises ``ValueError``.
    """
    out_dtype = _float_dtype(dtype)
    arr = _as_vec3_array(normals, "normals") @ RAS_TO_GLTF_ROTATION.T
    # Scale each row by its largest component first, so huge or tiny inputs cannot overflow/underflow the norm.
    peak = np.max(np.abs(arr), axis=1)
    degenerate = peak == 0
    peak[degenerate] = 1.0
    arr = arr / peak[:, None]
    arr[degenerate] = (0.0, 1.0, 0.0)
    return _finite(arr / np.linalg.norm(arr, axis=1)[:, None], "normals", out_dtype)


_AFFINE_ROW = np.array([0.0, 0.0, 0.0, 1.0])


def ras_matrix_to_gltf(matrix: ArrayLike) -> NDArray[np.float64]:
    """Return ``C · M · C⁻¹`` for a 4×4 affine RAS (mm) transform ``M`` — its glTF-space (m) equivalent (§8.1).

    ``M`` must be affine (bottom row ``[0, 0, 0, 1]``, like ``vtkMRMLTransformNode.GetMatrixTransformToWorld``).
    """
    m = np.asarray(matrix, dtype=np.float64)
    if m.shape != (4, 4):
        raise ValueError(f"matrix must have shape (4, 4), got {m.shape}")
    if not np.all(np.isfinite(m)):
        raise ValueError("matrix contains non-finite values")
    if not np.array_equal(m[3], _AFFINE_ROW):
        raise ValueError("matrix must be affine (bottom row [0, 0, 0, 1])")
    result = RAS_TO_GLTF @ m @ GLTF_TO_RAS
    _finite(result, "matrix", np.float32)  # viewers hold matrices in float32 (GPU uniforms, Unity)
    return result


def is_trs_decomposable(matrix: ArrayLike, rtol: float = 1e-6) -> bool:
    """True when a 4×4 matrix can be a glTF ``node.matrix``: affine, non-singular, free of shear (column axes
    orthogonal within ``rtol`` as a cosine) (glTF 2.0 §3.5.3: a node
    matrix MUST decompose into translation, rotation and scale). Viewers decompose ``T.matrix`` into TRS, so a
    sheared transform (common after affine registration) would display wrongly; the exporter bakes such
    transforms into the vertices instead (``baked: true``, SLC-13). Negative scale (mirroring) is decomposable.
    """
    m = np.asarray(matrix, dtype=np.float64)
    if m.shape != (4, 4) or not np.all(np.isfinite(m)) or not np.array_equal(m[3], _AFFINE_ROW):
        return False
    linear = m[:3, :3]
    gram = linear.T @ linear  # diagonal ⇔ orthogonal columns ⇔ rotation · scale
    norms = np.sqrt(np.diag(gram))  # axis scales
    if norms.min() <= 1e-12 * norms.max():
        return False  # (numerically) zero scale: viewers' TRS decomposition would divide by zero
    cosines = gram / np.outer(norms, norms)  # cosine of the angle between column axes
    return bool(np.max(np.abs(cosines - np.eye(3))) <= rtol)


def gltf_matrix_column_major(matrix: ArrayLike) -> list[float]:
    """Flatten a 4×4 (row-major numpy) matrix into the 16 column-major floats of glTF ``node.matrix``."""
    m = np.asarray(matrix, dtype=np.float64)
    if m.shape != (4, 4):
        raise ValueError(f"matrix must have shape (4, 4), got {m.shape}")
    if not np.all(np.isfinite(m)):
        raise ValueError("matrix contains non-finite values")
    return [float(v) for v in m.T.reshape(16)]


def face_normals(points: ArrayLike, triangles: ArrayLike) -> NDArray[np.float64]:
    """Unnormalised face normals ``(p1 − p0) × (p2 − p0)`` of ``(m, 3)`` index triangles (right-hand rule)."""
    p = _as_vec3_array(points, "points")
    t = np.asarray(triangles)
    if t.ndim != 2 or t.shape[1] != 3:
        raise ValueError(f"triangles must have shape (m, 3), got {t.shape}")
    if t.size and (not np.issubdtype(t.dtype, np.integer) or t.min() < 0 or t.max() >= len(p)):
        raise ValueError("triangles must be integer indices into points")
    p0, p1, p2 = p[t[:, 0]], p[t[:, 1]], p[t[:, 2]]
    return np.cross(p1 - p0, p2 - p0)


def winding_preserved(
    points_ras: ArrayLike, triangles: ArrayLike, rotation: ArrayLike = RAS_TO_GLTF_ROTATION
) -> bool:
    """True when mapping ``points_ras`` with ``0.001 · rotation`` keeps every non-degenerate triangle's orientation.

    The face normal computed from the mapped vertices must point the same way as the RAS face normal carried
    along by ``rotation`` (an orthonormal 3×3 matrix, by default the contract's). A mirroring map (determinant −1)
    flips every one of them, so this is the executable form of "winding preserved" (§7.1).
    """
    r = np.asarray(rotation, dtype=np.float64)
    p = _as_vec3_array(points_ras, "points")
    before = face_normals(p, triangles) @ r.T
    after = face_normals(p @ (MM_TO_M * r).T, triangles)
    valid = np.linalg.norm(before, axis=1) > 0
    if not np.any(valid):
        return False  # nothing to check is no evidence of preserved winding
    return bool(np.all(np.einsum("ij,ij->i", before[valid], after[valid]) > 0))
