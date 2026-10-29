"""SLC-50: the per-node cache of the scene's preparation — a warm cache gives the GLB of a fresh export, and only the
nodes whose mesh or share changed are collected and decimated again (``remoteview_core.meshcache``); with *Remove small
islands* (SLC-53) too."""

from __future__ import annotations

import math
import time

import numpy as np
import pytest
from support import FakeScene, live_client, manifest, reassemble, sphere
from vtkmodules.vtkCommonTransforms import vtkTransform
from vtkmodules.vtkFiltersCore import vtkAppendPolyData
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core import collect, decimate, snapshot
from remoteview_core.meshcache import MeshCache, mesh_stamp
from remoteview_core.snapshot import build_snapshot, prepare_snapshot
from remoteview_core.steps import Progress, Stepper

#: every node above 500 triangles is decimated (the 2k floor needs no total: 500,000 is never reached here)
SMALL = decimate.Budget(total_triangles=500_000, node_triangles=500, target_bytes=32 << 20)
A, B, C = "vtkMRMLModelNode4", "vtkMRMLModelNode5", "vtkMRMLModelNode6"
SHEAR = np.array([[1.0, 0.5, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])


@pytest.fixture
def work(monkeypatch):
    """The small budget, and a record of the meshes collected and the nodes decimated."""
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": SMALL})
    done: dict[str, list] = {"collected": [], "decimated": []}
    mesh_steps, decimate_steps = collect.mesh_steps, decimate.decimate_steps

    def collected(polydata, transform=None):
        done["collected"].append(polydata)
        return (yield from mesh_steps(polydata, transform))

    def decimated(entity, target, **options):
        done["decimated"].append(entity.node_id)
        return (yield from decimate_steps(entity, target, **options))

    monkeypatch.setattr(collect, "mesh_steps", collected)
    monkeypatch.setattr(decimate, "decimate_steps", decimated)
    return done


class Scene(FakeScene):
    """A ``FakeScene`` whose world matrices can be set per node."""

    def world_matrix(self, node):
        return node.get("world", np.eye(4))


def three() -> Scene:
    return Scene(
        {"id": A, "mesh": sphere(32)}, {"id": B, "mesh": sphere(24)}, {"id": C, "mesh": sphere(16)}
    )


def glb_of(scene, cache=None) -> bytes:
    """The GLB of a fresh client's first snapshot (sceneVersion 1), from ``cache`` or none."""
    snap = build_snapshot(scene, live_client(), slicer_version="5.12.4", cache=cache)
    return reassemble(list(snap.frames()))[1]


def clear(done) -> None:
    done["collected"].clear()
    done["decimated"].clear()


def test_prepare_cache_warm_gives_the_glb_of_a_fresh_export(work):
    scene, cache = three(), MeshCache()
    first = glb_of(scene, cache)
    assert work["decimated"] == [A, B] and len(cache) == 3  # C (448 triangles) fits its share
    clear(work)
    assert glb_of(scene, cache) == first == glb_of(scene)
    # the warm export collected nothing (the fresh one, last, collected all three) and decimated A and B once only
    assert len(work["collected"]) == 3 and work["decimated"] == [A, B]
    assert repr(cache) == "MeshCache(nodes=3)"  # counts only (T7)


@pytest.mark.parametrize("change", ["new-polydata", "points", "cells"])
def test_prepare_cache_a_changed_mesh_is_the_only_one_prepared_again(work, change):
    scene, cache = three(), MeshCache()
    glb_of(scene, cache)
    clear(work)
    node = scene.nodes[1]
    if change == "new-polydata":
        node["mesh"] = sphere(20)
    elif change == "points":
        points = node["mesh"].GetPoints()
        points.SetPoint(0, 100.0, 0.0, 25.0)
        points.Modified()
    else:  # Modified() on the connectivity array only: vtkPolyData::GetMTime() does not see it
        connectivity = node["mesh"].GetPolys().GetConnectivityArray()
        first, second = connectivity.GetTuple1(0), connectivity.GetTuple1(1)
        connectivity.SetTuple1(0, second)
        connectivity.SetTuple1(1, first)
        connectivity.Modified()
    warm = glb_of(scene, cache)
    assert [p is node["mesh"] for p in work["collected"]] == [True]
    assert work["decimated"] == [B]
    assert warm == glb_of(scene)  # the same as a fresh export of the changed scene


def test_prepare_cache_follows_the_shares(work, monkeypatch):
    """Over the profile's total the shares are proportional: when one node grows, the decimated nodes get new shares
    and are collected and decimated again; a node that fitted its share and still does is taken from the cache."""
    tight = decimate.Budget(2_000, 100_000, 32 << 20, floor_triangles=100)
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": tight})
    # 1,920 + 1,056 + 96 triangles: A and B are decimated to their shares, C keeps its 96
    scene = Scene(
        {"id": A, "mesh": sphere(32)}, {"id": B, "mesh": sphere(24)}, {"id": C, "mesh": sphere(8)}
    )
    cache = MeshCache()
    glb_of(scene, cache)
    assert work["decimated"] == [A, B]
    clear(work)
    scene.nodes[0]["mesh"] = sphere(40)  # 3,040 triangles: B's share shrinks, C's is still above 96
    warm = glb_of(scene, cache)
    assert sorted(id(p) for p in work["collected"]) == sorted(
        id(n["mesh"]) for n in scene.nodes[:2]
    )
    assert work["decimated"] == [A, B] and warm == glb_of(scene)


TIGHT = decimate.Budget(2_000, 100_000, 32 << 20, floor_triangles=100)


def snapshot_of(scene, cache=None, **options):
    return build_snapshot(scene, live_client(), slicer_version="5.12.4", cache=cache, **options)


def same_export(warm, fresh) -> bool:
    """The same GLB (both a client's first snapshot) and the same reports."""
    glbs = [reassemble(list(s.frames()))[1] for s in (warm, fresh)]
    reports = [(s.reduced, s.unreduced, s.skipped) for s in (warm, fresh)]
    return glbs[0] == glbs[1] and reports[0] == reports[1]


@pytest.mark.parametrize("gone", [(B, C), (C,)])
def test_prepare_cache_a_decimated_node_whose_share_grows_is_fitted_again(work, monkeypatch, gone):
    """Over the total, A is decimated to its share; when other nodes go its share grows — to its whole count (A is
    then sent whole) or to more than before (decimated again to it). The entry is the mesh decimated for the old share,
    so A is collected again either way."""
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": TIGHT})
    scene = Scene(
        {"id": A, "mesh": sphere(32)}, {"id": B, "mesh": sphere(24)}, {"id": C, "mesh": sphere(8)}
    )
    cache = MeshCache()
    assert snapshot_of(scene, cache).reduced == (A, B)
    scene.nodes = [n for n in scene.nodes if n["id"] not in gone]
    clear(work)
    warm = snapshot_of(scene, cache)
    # every node left was decimated and has a new share: collected again, A and (when it stays) B
    assert [id(p) for p in work["collected"]] == [id(n["mesh"]) for n in scene.nodes]
    assert same_export(warm, snapshot_of(scene))
    assert warm.reduced == ((A, B) if gone == (C,) else ())  # A alone fits its whole count


def nothing_reduces(entity, target, **options):
    return None
    yield  # a steps generator


def test_prepare_cache_a_node_nothing_reduces_is_kept_whole_and_not_collected_again(
    work, monkeypatch
):
    """A node nothing could reduce is sent whole and its entry holds that whole mesh: a new share above it tries the
    decimation again on that mesh, without collecting it."""
    tighter = decimate.Budget(
        1_000, 100_000, 32 << 20, floor_triangles=100
    )  # A alone stays above its share
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": tighter})
    monkeypatch.setattr(decimate, "decimate_steps", nothing_reduces)
    scene = Scene({"id": A, "mesh": sphere(32)}, {"id": B, "mesh": sphere(24)})
    cache = MeshCache()
    assert snapshot_of(scene, cache).unreduced == (A, B)
    clear(work)
    assert same_export(snapshot_of(scene, cache), snapshot_of(scene))
    scene.nodes = scene.nodes[
        :1
    ]  # A's share changes: the entry holds its whole mesh, nothing is collected again
    clear(work)
    warm = snapshot_of(scene, cache)
    assert work["collected"] == [] and warm.unreduced == (A,)
    assert same_export(warm, snapshot_of(scene))


def test_prepare_cache_a_mesh_that_loses_its_triangles_while_collected_again_is_left_out(
    work, monkeypatch
):
    """A decimated node whose share changed is collected again in the fit. Prepared in steps, its mesh may have
    changed since the node was listed: when nothing with an area is left, it is reported as left out, not sent, and the
    others are named as a fresh export names them (``Model <n>`` without a gap)."""
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": TIGHT})
    scene = Scene(
        {"id": A, "mesh": sphere(32)}, {"id": B, "mesh": sphere(24)}, {"id": C, "mesh": sphere(8)}
    )
    cache = MeshCache()
    snapshot_of(scene, cache, anonymize_names=True)
    scene.nodes[0]["mesh"] = sphere(
        40
    )  # A grows, so B's share changes and B is collected again in the fit
    progress = Progress()
    steps = prepare_snapshot(
        scene,
        live_client(),
        slicer_version="5.12.4",
        anonymize_names=True,
        cache=cache,
        progress=progress,
    )
    stepper = Stepper(steps, time.monotonic)
    while progress.done < 3:  # all three listed: A collected, B and C taken from the cache
        stepper.advance(0.0)
    points = scene.nodes[1]["mesh"].GetPoints()
    for i in range(points.GetNumberOfPoints()):
        points.SetPoint(i, 100.0, 0.0, 0.0)
    points.Modified()
    assert stepper.advance(math.inf)
    warm = stepper.result
    assert [(s.node_id, s.reason.value, s.index) for s in warm.skipped] == [(B, "no-triangles", 1)]
    _, glb, _ = reassemble(list(warm.frames()))
    assert [(e["nodeId"], e["name"]) for e in manifest(glb)] == [(A, "Model 1"), (C, "Model 2")]
    # the shares were those of the three listed nodes: A's is smaller than a fresh export's (the mesh change that
    # left B out is marked in Slicer and re-exports the scene after this snapshot)
    fresh = snapshot_of(scene, anonymize_names=True)
    assert warm.skipped == fresh.skipped and warm.triangle_count < fresh.triangle_count


def test_prepare_cache_a_sheared_bake_is_part_of_the_stamp_and_a_warp_is_never_cached(work):
    scene, cache = Scene({"id": A, "mesh": sphere(32), "world": SHEAR}), MeshCache()
    first = glb_of(scene, cache)
    clear(work)
    assert glb_of(scene, cache) == first and work["collected"] == []
    sheared_more = SHEAR.copy()
    sheared_more[0, 1] = 0.25
    scene.nodes[0]["world"] = sheared_more
    glb_of(scene, cache)
    assert len(work["collected"]) == 1 and work["decimated"] == [A]
    # a non-linear chain: its transform is a new object at every read, so the node is collected every time
    warp = vtkTransform()
    warp.Scale(1.0, 2.0, 1.0)
    scene.nodes[0]["world"] = None
    scene.world_transform = lambda node: warp
    clear(work)
    glb_of(scene, cache)
    glb_of(scene, cache)
    assert len(work["collected"]) == 2


def test_prepare_cache_skips_are_cached_entries_of_gone_nodes_dropped_and_clear_empties(work):
    flat = collect.polydata_from_triangles(
        np.array([[0.0, 0, 0], [1, 0, 0], [2, 0, 0]]), np.array([[0, 1, 2]])
    )
    scene, cache = Scene({"id": A, "mesh": sphere(32)}, {"id": B, "mesh": flat}), MeshCache()
    glb_of(scene, cache)
    clear(work)
    snap = build_snapshot(scene, live_client(), slicer_version="5.12.4", cache=cache)
    assert work["collected"] == [] and [s.reason.value for s in snap.skipped] == ["no-triangles"]
    del scene.nodes[1]
    glb_of(scene, cache)
    assert len(cache) == 1
    cache.clear()
    assert len(cache) == 0


def test_prepare_cache_stamp_follows_the_mesh():
    mesh = sphere(8)
    stamp = mesh_stamp(mesh)
    assert stamp == mesh_stamp(mesh) and stamp[0].startswith("Addr=")
    assert mesh_stamp(mesh, (1.0,)) != stamp  # the bake
    mesh.GetPoints().GetData().Modified()
    assert mesh_stamp(mesh) != stamp
    assert mesh_stamp(None) is None and mesh_stamp("not a mesh") is None


# --------------------------------------------------------------------------- small islands (SLC-53 follow-up (e))


def specked(resolution: int, specks: int = 6):
    """``sphere(resolution)`` and ``specks`` spheres of 16 triangles beside it, as one mesh: small islands of a body
    from ``sphere(32)`` (1,920 triangles, of which 1 % is 19.2) up."""
    append = vtkAppendPolyData()
    append.AddInputData(sphere(resolution))
    for i in range(specks):
        speck = vtkSphereSource()
        speck.SetRadius(0.5)
        speck.SetCenter(150.0 + 5.0 * i, 0.0, 0.0)
        speck.SetThetaResolution(4)
        speck.SetPhiResolution(4)
        speck.Update()
        append.AddInputData(speck.GetOutput())
    append.Update()
    return append.GetOutput()


def specked_three() -> Scene:
    """A: 1,920 + 96 triangles, B: 3,040 + 96, C: 448 and no island."""
    return Scene(
        {"id": A, "mesh": specked(32)},
        {"id": B, "mesh": specked(40)},
        {"id": C, "mesh": sphere(16)},
    )


@pytest.fixture
def masked(monkeypatch):
    """The nodes whose islands were looked for, in order."""
    seen: list[str] = []
    island_mask = decimate.island_mask
    monkeypatch.setattr(
        decimate, "island_mask", lambda entity: seen.append(entity.node_id) or island_mask(entity)
    )
    return seen


def glb_and_report(snap) -> tuple:
    return reassemble(list(snap.frames()))[1], snap.reduced, snap.unreduced, snap.cleaned


def test_prepare_cache_islands_in_steps_and_warm_give_the_glb_of_one_call(work, masked):
    """A and B are decimated without their islands, C fits whole: prepared a step at a time into a cache, then warm,
    the export is that of one call. Each node's islands are looked for once per collection, one step each, never for a
    node taken from the cache (its entry counts them)."""
    scene, cache = specked_three(), MeshCache()
    one = glb_and_report(snapshot_of(scene, remove_islands=True))
    assert one[1:] == ((A, B), (), (A, B)) and masked == [A, B, C]
    masked.clear()
    progress = Progress()
    steps = prepare_snapshot(
        scene,
        live_client(),
        slicer_version="5.12.4",
        cache=cache,
        progress=progress,
        remove_islands=True,
    )
    stepper = Stepper(steps, time.monotonic)
    while progress.done < 3:  # collected
        stepper.advance(0.0)
    taken = stepper.taken
    while masked != [A, B, C]:
        stepper.advance(0.0)
    assert stepper.taken == taken + 3  # one step per node's islands, before any share is given
    assert stepper.advance(math.inf) and A not in repr(stepper.result)  # T7
    assert glb_and_report(stepper.result) == one
    clear(work)
    masked.clear()
    assert glb_and_report(snapshot_of(scene, cache, remove_islands=True)) == one
    assert work == {"collected": [], "decimated": []} and masked == []


def test_prepare_cache_islands_the_shares_follow_the_triangles_left(work, masked, monkeypatch):
    """Over the total the shares are proportional to the triangles left without the specks: the export is SLC-53's
    ``fit_to_budget(…, remove_islands=True)`` of the collected nodes, fresh and with A taken from its entry."""
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": TIGHT})
    scene, cache = Scene({"id": A, "mesh": specked(32)}, {"id": B, "mesh": sphere(24)}), MeshCache()

    def reference() -> tuple:
        entities = collect.collect_scene(scene).entities
        fit = decimate.fit_to_budget(entities, TIGHT, remove_islands=True)
        return [e.triangle_count for e in fit.entities], (fit.reduced, fit.unreduced, fit.cleaned)

    def exported(snap) -> tuple:
        _, glb, _ = reassemble(list(snap.frames()))
        counts = [node["triangleCount"] for node in manifest(glb)]
        return counts, (snap.reduced, snap.unreduced, snap.cleaned)

    expected = reference()
    assert expected == ([1_290, 710], ((A, B), (), (A,)))  # counted with the specks: 1,313 and 687
    assert exported(snapshot_of(scene, cache, remove_islands=True)) == expected
    scene.nodes[1]["mesh"] = sphere(24)  # B collected again, A from its entry
    masked.clear()
    assert exported(snapshot_of(scene, cache, remove_islands=True)) == expected
    assert masked == [B]


def test_prepare_cache_islands_only_a_changed_node_is_looked_at_again(work, masked):
    scene, cache = specked_three(), MeshCache()
    snapshot_of(scene, cache, remove_islands=True)
    scene.nodes[2]["mesh"] = sphere(20)  # C: 720 triangles, now decimated too
    clear(work)
    masked.clear()
    warm = glb_and_report(snapshot_of(scene, cache, remove_islands=True))
    assert masked == [C] and work["decimated"] == [C] and len(work["collected"]) == 1
    assert warm == glb_and_report(snapshot_of(scene, remove_islands=True))


def test_prepare_cache_islands_another_rule_starts_the_cache_again(work, masked, monkeypatch):
    """The default profile fits every node whole, so the specks go and nothing else changes. The cache's entries are
    made for one island rule: an export with another collects every node again and gives what a fresh export gives; a
    changed threshold is another rule."""
    monkeypatch.setattr(snapshot, "PROFILES", decimate.PROFILES)  # nothing decimated
    scene, cache = specked_three(), MeshCache()
    plain = snapshot_of(scene, cache)
    assert plain.triangle_count == 2_016 + 3_136 + 448 and plain.cleaned == () and masked == []
    for rule in ("on", "on again", "a smaller share", "a lower minimum", "off"):
        if rule == "a smaller share":
            monkeypatch.setattr(
                decimate, "SMALL_ISLAND_SHARE", 0.001
            )  # no speck is below 0.1 % of its body
        if rule == "a lower minimum":
            monkeypatch.setattr(decimate, "SMALL_ISLAND_TRIANGLES", 16)  # no speck is below it
        clear(work)
        masked.clear()
        on = rule != "off"
        snap = snapshot_of(scene, cache, remove_islands=on)
        assert len(work["collected"]) == (0 if rule == "on again" else 3)
        assert masked == ([] if rule in ("on again", "off") else [A, B, C])
        cleaned = rule in ("on", "on again")
        begin, glb, _ = reassemble(list(snap.frames()))
        kept = [1_920, 3_040, 448] if cleaned else [2_016, 3_136, 448]
        assert [node["triangleCount"] for node in manifest(glb)] == kept
        assert begin["triangleCount"] == snap.triangle_count == sum(kept)
        assert snap.cleaned == ((A, B) if cleaned else ())
        assert glb == reassemble(list(snapshot_of(scene, remove_islands=on).frames()))[1]


@pytest.mark.parametrize("reduces", [True, False])
def test_prepare_cache_a_node_without_its_islands_is_collected_again_for_a_new_share(
    work, masked, monkeypatch, reduces
):
    """A's entry holds its mesh without its islands — sent whole within its share, or because nothing reduces it —,
    not the collected mesh a fresh export decimates (with the islands' vertices still in it): for a new share A is
    collected again and its islands looked for again, so the export is that of a fresh one."""
    total = 2_000 if reduces else 1_000
    budget = decimate.Budget(total, 100_000, 32 << 20, floor_triangles=100)
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": budget})
    if not reduces:
        monkeypatch.setattr(decimate, "decimate_steps", nothing_reduces)
    scene, cache = Scene({"id": A, "mesh": specked(32)}), MeshCache()
    first = snapshot_of(scene, cache, remove_islands=True)
    assert (first.reduced, first.unreduced, first.cleaned) == ((), () if reduces else (A,), (A,))
    scene.nodes.append({"id": B, "mesh": sphere(24)})  # A's share shrinks
    clear(work)
    masked.clear()
    fit_entity_steps = decimate.fit_entity_steps

    def fitted(entity, *args, **options):
        masked.append(f"fit {entity.node_id}")
        return (yield from fit_entity_steps(entity, *args, **options))

    monkeypatch.setattr(decimate, "fit_entity_steps", fitted)
    steps = prepare_snapshot(
        scene, live_client(), slicer_version="5.12.4", cache=cache, remove_islands=True
    )
    while True:  # a "|" after each step
        try:
            next(steps)
        except StopIteration as stop:
            warm = stop.value
            break
        masked.append("|")
    assert [id(p) for p in work["collected"]] == [id(n["mesh"]) for n in reversed(scene.nodes)]
    # B before the shares, A once collected again — each mask a step of its own
    assert [m for m in masked if m != "|"] == [B, A, f"fit {A}", f"fit {B}"]
    assert masked[masked.index(B) + 1] == masked[masked.index(A) + 1] == "|"
    assert (warm.reduced if reduces else warm.unreduced) == (A, B)
    assert glb_and_report(warm) == glb_and_report(snapshot_of(scene, remove_islands=True))


def test_prepare_cache_islands_off_a_node_collected_again_keeps_its_specks(
    work, masked, monkeypatch
):
    """With the rule off, A (2,016 triangles over a total of 2,000) is decimated with its specks; collected again for
    a new share, no island is looked for either."""
    budget = decimate.Budget(2_000, 100_000, 32 << 20, floor_triangles=100)
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": budget})
    scene, cache = Scene({"id": A, "mesh": specked(32)}), MeshCache()
    assert snapshot_of(scene, cache).reduced == (A,)
    scene.nodes.append({"id": B, "mesh": sphere(24)})  # A's share shrinks
    clear(work)
    warm = snapshot_of(scene, cache)
    assert [id(p) for p in work["collected"]] == [id(n["mesh"]) for n in reversed(scene.nodes)]
    assert masked == [] and warm.cleaned == ()
    assert glb_and_report(warm) == glb_and_report(snapshot_of(scene))
