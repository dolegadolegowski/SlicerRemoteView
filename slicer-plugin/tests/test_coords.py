"""SLC-05: RAS mm → glTF m, +Y up (docs/protocol.md §7.1, §8.1; ADR 0005 §4)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pygltflib
import pytest

from remoteview_core.coords import (
    GLTF_TO_RAS,
    RAS_TO_GLTF,
    RAS_TO_GLTF_ROTATION,
    face_normals,
    gltf_matrix_column_major,
    is_trs_decomposable,
    ras_matrix_to_gltf,
    ras_to_gltf_normals,
    ras_to_gltf_points,
    winding_preserved,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

# Asymmetric fixtures: every axis has a different magnitude so a swapped or mirrored axis cannot pass.
AXES_RAS = np.array([[100.0, 0.0, 0.0], [0.0, 100.0, 0.0], [0.0, 0.0, 100.0], [10.0, 20.0, 30.0]])
AXES_GLTF = np.array([[0.1, 0.0, 0.0], [0.0, 0.0, -0.1], [0.0, 0.1, 0.0], [0.010, 0.030, -0.020]])


def _translation(x: float, y: float, z: float) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


def test_coords_axes_map_right_superior_anterior():
    """R → +x, S (superior) → +y, A (anterior) → −z, millimetres → metres (FR-07, FR-65)."""
    out = ras_to_gltf_points(AXES_RAS)
    assert out.dtype == np.float32
    np.testing.assert_allclose(out, AXES_GLTF, atol=1e-7)
    # Exact per-axis expectations of the plan (criterion 1).
    np.testing.assert_allclose(ras_to_gltf_points([[100, 0, 0]])[0], [0.1, 0, 0], atol=1e-7)
    np.testing.assert_allclose(ras_to_gltf_points([[0, 100, 0]])[0], [0, 0, -0.1], atol=1e-7)
    np.testing.assert_allclose(ras_to_gltf_points([[0, 0, 100]])[0], [0, 0.1, 0], atol=1e-7)


def test_coords_float64_output_on_request():
    out = ras_to_gltf_points([[123.456789, -98.7654321, 0.5]], dtype=np.float64)
    assert out.dtype == np.float64
    np.testing.assert_allclose(out[0], [0.123456789, 0.0005, 0.0987654321], rtol=0, atol=1e-15)


def test_coords_basis_has_determinant_plus_one_and_inverse():
    assert np.linalg.det(RAS_TO_GLTF_ROTATION) == pytest.approx(1.0)
    assert np.linalg.det(RAS_TO_GLTF[:3, :3]) > 0
    np.testing.assert_allclose(RAS_TO_GLTF @ GLTF_TO_RAS, np.eye(4), atol=1e-15)
    with pytest.raises(ValueError):
        RAS_TO_GLTF[0, 0] = 2.0  # module constants are read-only


def test_coords_ccw_triangle_stays_ccw():
    """Winding preserved (§7.1): the converted face normal is the rotated RAS face normal."""
    tri_ras = np.array([[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 0.0, 20.0]])  # in the R-S plane
    tris = np.array([[0, 1, 2]])
    n_ras = face_normals(tri_ras, tris)[0]
    np.testing.assert_allclose(n_ras, [0, -200, 0])  # faces posterior (−A)
    n_gltf = face_normals(ras_to_gltf_points(tri_ras, dtype=np.float64), tris)[0]
    # posterior (−A) is glTF +z; the triangle must still face it after conversion
    assert n_gltf[2] > 0 and abs(n_gltf[0]) < 1e-12 and abs(n_gltf[1]) < 1e-12
    assert winding_preserved(tri_ras, tris)


def test_coords_winding_check_detects_a_mirroring_conversion():
    rng = np.random.default_rng(7)
    points = rng.normal(size=(30, 3)) * 50
    tris = rng.integers(0, 30, size=(40, 3))
    assert winding_preserved(points, tris)
    mirrored = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])  # [R, S, +A]: det −1
    transposed = np.array(
        [[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]]
    )  # [R, −S, A]: det +1
    assert winding_preserved(points, tris, rotation=transposed)  # a rotation, just the wrong one
    assert not winding_preserved(points, tris, rotation=mirrored)


def test_coords_normals_rotate_without_scale_and_renormalise():
    normals = np.array([[0.0, 2.0, 0.0], [0.0, 0.0, 0.5], [3.0, 4.0, 0.0], [0.0, 0.0, 0.0]])
    out = ras_to_gltf_normals(normals)
    assert out.dtype == np.float32
    np.testing.assert_allclose(
        out, [[0, 0, -1], [0, 1, 0], [0.6, 0, -0.8], [0, 1, 0]], atol=1e-7
    )  # anterior → −z, superior → +y, zero-length → +Y fallback
    np.testing.assert_allclose(np.linalg.norm(out, axis=1), 1.0, atol=1e-6)


def test_coords_translation_lands_in_last_column():
    """RAS (10, 20, 30) mm → glTF translation (0.010, 0.030, −0.020) in node.matrix[12:15] (§8.1)."""
    gltf = ras_matrix_to_gltf(_translation(10, 20, 30))
    flat = gltf_matrix_column_major(gltf)
    assert len(flat) == 16 and all(type(v) is float for v in flat)
    np.testing.assert_allclose(flat[12:16], [0.010, 0.030, -0.020, 1.0], atol=1e-15)
    np.testing.assert_allclose(flat[:12], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], atol=1e-15)


def test_coords_matrix_conjugation_commutes_with_point_conversion():
    """Transform-then-convert equals convert-then-transform for a rotation + scale + shear + translation."""
    angle = np.deg2rad(30)
    m = np.array(
        [
            [np.cos(angle), -np.sin(angle), 0.0, 12.5],
            [np.sin(angle), np.cos(angle), 0.3, -7.0],
            [0.1, 0.0, 1.7, 41.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    points = np.array([[1.0, 2.0, 3.0], [-40.0, 15.0, 7.5], [100.0, -3.0, -60.0]])
    moved_ras = (np.c_[points, np.ones(3)] @ m.T)[:, :3]
    expected = ras_to_gltf_points(moved_ras, dtype=np.float64)
    gltf_m = ras_matrix_to_gltf(m)
    converted = ras_to_gltf_points(points, dtype=np.float64)
    actual = (np.c_[converted, np.ones(3)] @ gltf_m.T)[:, :3]
    np.testing.assert_allclose(actual, expected, atol=1e-12)


def test_coords_rotation_about_superior_becomes_rotation_about_y():
    angle = np.deg2rad(90)
    about_s = np.eye(4)
    about_s[:2, :2] = [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    gltf = ras_matrix_to_gltf(about_s)
    # C has determinant +1, so +90° about S becomes +90° about glTF +Y: R → A becomes +x → −z
    np.testing.assert_allclose(gltf[:3, :3] @ [1, 0, 0], [0, 0, -1], atol=1e-12)
    np.testing.assert_allclose(gltf[:3, :3] @ [0, 1, 0], [0, 1, 0], atol=1e-12)


def test_coords_column_major_order():
    m = np.arange(16, dtype=np.float64).reshape(4, 4)
    assert gltf_matrix_column_major(m) == [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]


@pytest.mark.parametrize(
    ("func", "value"),
    [
        (ras_to_gltf_points, np.zeros((3,))),
        (ras_to_gltf_points, np.zeros((2, 4))),
        (ras_to_gltf_points, [[np.nan, 0, 0]]),
        (ras_to_gltf_normals, [[np.inf, 0, 0]]),
        (ras_matrix_to_gltf, np.eye(3)),
        (ras_matrix_to_gltf, np.full((4, 4), np.nan)),
        (gltf_matrix_column_major, np.eye(3)),
        (gltf_matrix_column_major, np.full((4, 4), np.inf)),
        (lambda v: ras_to_gltf_points(v, dtype=np.int32), [[100.0, 200.0, 300.0]]),
        (lambda v: ras_to_gltf_normals(v, dtype=np.int16), [[0.0, 1.0, 0.0]]),
        (lambda v: face_normals(np.zeros((3, 3)), v), [[0, 1, -1]]),
        (lambda v: face_normals(np.zeros((3, 3)), v), [[0, 1, 3]]),
        (lambda v: face_normals(np.zeros((3, 3)), v), [[0.0, 1.0, 2.0]]),
        (ras_to_gltf_points, [[1e42, 0.0, 0.0]]),  # finite in float64, overflows float32 metres
        (
            ras_matrix_to_gltf,
            np.vstack([np.eye(4)[:3], [0.0, 0.0, 1e-3, 1.0]]),
        ),  # projective, not affine
        (
            ras_matrix_to_gltf,
            np.array([[1, 0, 0, 1e44], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1.0]]),
        ),
    ],
)
def test_coords_rejects_bad_input(func, value):
    with pytest.raises(ValueError):
        func(value)


def test_coords_adr_matrix_literal_read_row_major_is_the_transpose():
    """Guards the documented discrepancy: ADR 0005 §4 prints C as [[1,0,0],[0,0,-1],[0,1,0]] (column listing)."""
    adr_literal = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
    np.testing.assert_array_equal(adr_literal.T, RAS_TO_GLTF_ROTATION)
    assert not np.allclose(adr_literal @ [10, 20, 30], RAS_TO_GLTF_ROTATION @ [10, 20, 30])


def test_coords_match_shared_asymmetric_fixture():
    """Consistency with the PRO-08 fixture (written in glTF space by shared/scripts/make-glb-fixtures.ts): its
    asymmetric tetrahedron is what the contract makes of the RAS points (0,0,0), (100,0,0) R, (0,0,50) S and
    (0,100,0) A — a mirrored or transposed conversion would move (0,0,−0.1)."""
    glb = REPO_ROOT / "shared" / "fixtures" / "glb" / "asymmetric-2nodes.glb"
    gltf = pygltflib.GLTF2.load(str(glb))
    accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION]
    view = gltf.bufferViews[accessor.bufferView]
    assert (
        view.byteStride in (None, 12) and accessor.componentType == 5126
    )  # tightly packed float32
    data = gltf.binary_blob()[view.byteOffset + (accessor.byteOffset or 0) :][: accessor.count * 12]
    fixture = np.frombuffer(data, dtype="<f4").reshape(-1, 3)
    ras = np.array([[0, 0, 0], [100, 0, 0], [0, 0, 50], [0, 100, 0]], dtype=np.float64)
    np.testing.assert_array_equal(ras_to_gltf_points(ras), fixture)


def test_coords_normals_survive_extreme_magnitudes():
    out = ras_to_gltf_normals([[1e300, 1e300, 0.0], [1e-320, 0.0, 0.0], [0.0, 3e38, 4e38]])
    np.testing.assert_allclose(np.linalg.norm(out, axis=1), 1.0, atol=1e-6)
    np.testing.assert_allclose(out[1], [1.0, 0.0, 0.0])
    np.testing.assert_allclose(out[2], [0.0, 0.8, -0.6], atol=1e-7)


def test_coords_winding_check_needs_evidence():
    assert not winding_preserved(np.zeros((3, 3)), [[0, 1, 2]])  # all triangles degenerate


def test_coords_trs_decomposability():
    angle = np.deg2rad(25)
    rotation = np.eye(4)
    rotation[:2, :2] = [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    trs = rotation @ np.diag([2.0, 0.5, 3.0, 1.0])
    trs[:3, 3] = (10, -20, 30)
    shear = np.eye(4)
    shear[0, 1] = 0.3
    assert is_trs_decomposable(np.eye(4)) and is_trs_decomposable(trs)
    assert is_trs_decomposable(
        np.diag([-1.0, 1.0, 1.0, 1.0])
    )  # mirroring decomposes with a negative scale
    assert is_trs_decomposable(ras_matrix_to_gltf(trs))  # conjugation by C keeps TRS
    assert not is_trs_decomposable(shear) and not is_trs_decomposable(ras_matrix_to_gltf(shear))
    assert not is_trs_decomposable(np.diag([2.0, 0.5, 3.0, 1.0]) @ rotation @ shear)
    assert not is_trs_decomposable(np.zeros((4, 4)))
    assert not is_trs_decomposable(
        np.diag([1.0, 1.0, 0.0, 1.0])
    )  # singular: zero scale on one axis
    sheared = np.diag([1000.0, 0.001, 1.0, 1.0])
    sheared[:2, 1] = (0.001, 0.001)  # columns 0 and 1 at 45° despite the 10⁶ scale ratio
    assert not is_trs_decomposable(sheared)
    assert is_trs_decomposable(
        np.diag([1000.0, 0.001, 1.0, 1.0])
    )  # anisotropic scale alone is fine
    assert not is_trs_decomposable(np.vstack([np.eye(4)[:3], [0.0, 0.0, 1e-3, 1.0]]))
    assert not is_trs_decomposable(np.eye(3))
