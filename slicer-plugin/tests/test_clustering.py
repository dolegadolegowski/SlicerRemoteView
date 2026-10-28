"""SLC-41: numpy vertex clustering (``remoteview_core.clustering``) — connected clusters that keep both sides of a thin
wall, normal-class clusters for fans, components and part sizes."""

from __future__ import annotations

import numpy as np
from support import face_normals, flying_edges, mesh_entity, normal_opposes_face
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core import clustering, collect, decimate
from remoteview_core.collect import mesh_points_and_triangles
from remoteview_core.coords import ras_to_gltf_normals, ras_to_gltf_points


def sphere_mesh(resolution: int, centre=(0.0, 0.0, 0.0), radius: float = 0.01):
    source = vtkSphereSource()
    source.SetRadius(radius)
    source.SetCenter(*centre)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    return mesh_points_and_triangles(source.GetOutput())


def slab():
    """A 40 × 40 × 2-voxel slab labelmap (0.5 mm voxels: 20 × 20 × 1 mm) through flying edges, in RAS mm."""
    mask = np.zeros((6, 44, 44), dtype=bool)
    mask[2:4, 2:42, 2:42] = True
    return collect.mesh_from_polydata(flying_edges(mask, 0.5))


def test_clustering_keeps_both_sides_of_a_thin_wall():
    """A grid cell four times the wall's thickness: the top and the bottom of the slab are separate pieces of the
    mesh inside a cell, so they become separate clusters and keep their own winding."""
    mesh = slab()
    thickness = np.ptp(mesh.positions[:, 2])
    assert thickness == 1.0
    centres, triangles = clustering.cluster_connected(mesh.positions, mesh.triangles, 4 * thickness)
    assert 0 < len(triangles) < len(mesh.triangles) // 10
    _, sets = np.unique(np.sort(triangles, axis=1), axis=0, return_counts=True)
    assert sets.max() == 1  # no two triangles with the same vertex set
    _, uses = np.unique(np.sort(clustering.edges(triangles), axis=1), axis=0, return_counts=True)
    assert uses.max() <= 2  # no edge with more than two triangles
    # a triangle on the top faces +z, one on the bottom -z; triangles that join both sides only where the two
    # sides meet inside one cell: along the slab's rim
    z = centres[triangles][:, :, 2]
    top, bottom = np.all(z == z.max(), axis=1), np.all(z == z.min(), axis=1)
    up = face_normals(centres, triangles)[:, 2]
    assert np.all(up[top] > 0) and np.all(up[bottom] < 0) and top.sum() >= 16 and bottom.sum() >= 16
    xy = centres[triangles][~(top | bottom)][:, :, :2]
    lo, hi = mesh.positions[:, :2].min(axis=0), mesh.positions[:, :2].max(axis=0)
    rim = np.any((xy < lo + 4 * thickness) | (xy > hi - 4 * thickness), axis=(1, 2))
    assert np.all(rim)
    # the whole pipeline on the slab, in glTF metres
    entity = mesh_entity(
        ras_to_gltf_points(mesh.positions, dtype=np.float64),
        mesh.triangles,
        ras_to_gltf_normals(mesh.normals),
    )
    smaller = decimate.decimate_entity(entity, entity.triangle_count // 4)
    assert 0 < smaller.triangle_count <= entity.triangle_count // 4
    assert normal_opposes_face(smaller) == 0
    # the decimated slab is convex: every face points away from its centre
    centre = (entity.positions.min(axis=0) + entity.positions.max(axis=0)) / 2
    middle = smaller.positions[smaller.indices].mean(axis=1) - centre
    assert np.all(
        np.einsum("ij,ij->i", face_normals(smaller.positions, smaller.indices), middle) > 0
    )


def disc(thickness: int):
    """A flying-edges disc ``thickness`` voxels thick with a radius of 3 voxels (1 mm voxels), in RAS mm."""
    z, y, x = np.mgrid[0 : thickness + 4, 0:12, 0:12]
    mask = (z >= 2) & (z < 2 + thickness) & (((x - 6) ** 2 + (y - 6) ** 2) < 9)
    return collect.mesh_from_polydata(flying_edges(mask, 1.0))


def test_clustering_rescues_islands_whose_two_sides_cancel():
    """A disc thinner than a cell collapses onto the same clusters from both sides: its folds cancel and nothing is
    kept. Its clusters were counted alive because a triangle mapped onto them; now only kept triangles count, so the
    disc is clustered again at ``cell / 3`` instead of vanishing."""
    for thickness in (1, 2):
        mesh = disc(thickness)
        assert (
            len(clustering.cluster_connected(mesh.positions, mesh.triangles, 3.0, rescue=0)[1]) == 0
        )
        _, rescued = clustering.cluster_connected(mesh.positions, mesh.triangles, 3.0)
        assert len(rescued) > 0.5 * len(mesh.triangles)
    # a limit below the lost triangles skips the rescue (a node of dust)
    mesh = disc(1)
    limited = clustering.cluster_connected(mesh.positions, mesh.triangles, 3.0, rescue_limit=10)
    assert len(limited[1]) == 0


def test_clustering_coincident_pairs_join_seams_not_opposite_layers():
    """Vertices at exactly the same position are paired when their normals agree (a seam), not when they oppose
    (two layers of a double-sided sheet); -0.0 and 0.0 are the same position."""
    positions = np.array(
        [[0, 0, 0], [1, 0, 0], [0, 1, 0], [-0.0, 0, 0], [1, -1, 0], [0, 0, 0], [0, 1, 0]],
        dtype=np.float64,
    )
    # 0-1-2 faces +z; 3-4-1 (3 = 0) faces +z on the other side of the seam 0-1; 5-6-1 faces -z over 0-2-1
    triangles = np.array([[0, 1, 2], [3, 4, 1], [5, 6, 1]])
    np.testing.assert_array_equal(clustering.coincident_pairs(positions, triangles), [[3, 0]])
    assert clustering.coincident_pairs(positions[:3], triangles[:1]).shape == (0, 2)


def test_clustering_compact_and_edge_work():
    rng = np.random.default_rng(5)
    positions = rng.random((50, 3))
    triangles = rng.integers(0, 50, (40, 3))
    used = np.unique(triangles)
    compact_positions, compact_triangles = clustering.compact(positions, triangles)
    np.testing.assert_array_equal(compact_positions, positions[used])
    np.testing.assert_array_equal(compact_triangles, np.searchsorted(used, triangles))
    # edge_work: Σ deg(a) · deg(b) over the three edges of every triangle
    one = np.array([[0, 1, 2]])
    assert clustering.edge_work(one) == 3.0
    two = np.array([[0, 1, 2], [0, 2, 3]])  # degrees 2, 1, 2, 1
    assert clustering.edge_work(two) == (2 * 1 + 1 * 2 + 2 * 2) + (2 * 2 + 2 * 1 + 1 * 2)


def test_clustering_components_and_parts():
    # two chains (0-1-2, 5-4-3) and an isolated vertex 6
    a, b = np.array([1, 2, 4, 3]), np.array([0, 1, 5, 4])
    np.testing.assert_array_equal(clustering.components(7, a, b), [0, 0, 0, 3, 3, 3, 6])
    np.testing.assert_array_equal(clustering.components(3, a[:0], b[:0]), [0, 1, 2])
    first, second = sphere_mesh(16), sphere_mesh(8, centre=(0.1, 0.0, 0.0))
    positions = np.concatenate([first[0], second[0]])
    triangles = np.concatenate([first[1], second[1] + len(first[0])])
    sizes = clustering.part_sizes(positions, triangles)
    np.testing.assert_array_equal(
        sizes, [len(first[1])] * len(first[1]) + [len(second[1])] * len(second[1])
    )
    # the valence weighted by valence: an ordinary mesh against 3,000 pages sharing one spine
    assert clustering.fan_weight(first[1]) < 10
    spine = np.array([[0, 1, 2 + page] for page in range(3_000)])
    assert clustering.fan_weight(spine) > 50


def test_clustering_collapse_drops_cancelling_folds():
    positions = np.array(
        [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0]], dtype=np.float64
    )
    cid = np.arange(6)
    # the same vertex set with opposite windings: a collapsed fold, both go
    _, folded = clustering._collapse(positions, np.array([[0, 1, 2], [0, 2, 1]]), cid, 6)
    assert folded.shape == (0, 3)
    # the same winding twice: kept once
    centres, twice = clustering._collapse(positions, np.array([[0, 1, 2], [1, 2, 0]]), cid, 6)
    assert len(twice) == 1 and np.all(face_normals(centres, twice)[:, 2] > 0)
    # otherwise the winding is kept, whatever the rotation
    triangles = np.array([[3, 1, 4], [4, 3, 5]])  # one facing +z, one -z
    centres, kept = clustering._collapse(positions, triangles, cid, 6)
    np.testing.assert_array_equal(
        np.sign(face_normals(centres, kept)[:, 2]),
        np.sign(face_normals(positions, triangles)[:, 2]),
    )


def test_clustering_representative_is_a_member_of_its_cluster():
    positions, triangles = sphere_mesh(64)
    cell = 4 * clustering.median_edge(positions, triangles)
    centres, result = clustering.cluster_connected(positions, triangles, cell)
    assert 0 < len(result) < len(triangles) // 4
    # every cluster position is an input vertex: it lies on the input surface
    distance = np.linalg.norm(centres[:, None, :] - positions[None], axis=2).min(axis=1)
    assert distance.max() == 0.0
    assert np.all(np.einsum("ij,ij->i", face_normals(centres, result), centres[result].mean(1)) > 0)
