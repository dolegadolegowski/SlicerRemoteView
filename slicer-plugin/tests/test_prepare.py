"""SLC-28: the scene's preparation in steps — the GLB of one call, nothing asked of the client before the last step,
and a large mesh in many short steps (protocol §6.2, FR-10; ``remoteview_core.steps``)."""

from __future__ import annotations

import itertools
import math
import time

import numpy as np
import pytest
from support import FakeScene, ack, live_client, reassemble, sphere
from vtkmodules.vtkCommonTransforms import vtkTransform

from remoteview_core import collect, decimate, snapshot
from remoteview_core.protocol_client import SessionState
from remoteview_core.snapshot import build_snapshot, prepare_snapshot
from remoteview_core.steps import Progress, Stepper, run

#: Every node above 500 triangles is decimated; with ``CLUSTER_GOAL`` 1,000 the size bound runs above 3,000.
SMALL = decimate.Budget(total_triangles=500_000, node_triangles=500, target_bytes=32 << 20)


@pytest.fixture
def small_budget(monkeypatch):
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": SMALL})
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 1_000)


def scene_of_four() -> FakeScene:
    """A model through the size bound (7,936 triangles), one below its share, one without a mesh, and a segment the
    quadric reduces."""
    return FakeScene(
        {"id": "vtkMRMLModelNode4", "mesh": sphere(64)},
        {"id": "vtkMRMLModelNode5", "mesh": sphere(16)},
        {"id": "vtkMRMLModelNode6"},
        {"id": "vtkMRMLSegmentationNode1", "segment": "Segment_1", "mesh": sphere(32)},
    )


def stepwise(scene, client, **options):
    """``prepare_snapshot`` one step per ``advance`` (a zero slice): the snapshot, the steps taken and the progress
    after each of them."""
    progress = Progress()
    steps = prepare_snapshot(scene, client, slicer_version="5.12.4", progress=progress, **options)
    stepper = Stepper(steps, time.monotonic)
    seen = []
    while not stepper.advance(0.0):
        seen.append((progress.done, progress.total))
    seen.append((progress.done, progress.total))
    return stepper.result, stepper.taken, seen


def test_prepare_in_steps_gives_the_glb_of_one_call(small_budget):
    one = build_snapshot(scene_of_four(), live_client(), slicer_version="5.12.4")
    stepped, taken, seen = stepwise(scene_of_four(), live_client())
    _, glb_one, _ = reassemble(list(one.frames()))
    begin, glb, _ = reassemble(list(stepped.frames()))
    assert glb == glb_one and begin["sceneVersion"] == 1
    reduced = ("vtkMRMLModelNode4", "vtkMRMLSegmentationNode1/Segment_1")
    assert (stepped.reduced, stepped.unreduced) == (one.reduced, one.unreduced) == (reduced, ())
    assert stepped.skipped == one.skipped and [
        (s.node_id, s.reason.value) for s in stepped.skipped
    ] == [("vtkMRMLModelNode6", "no-triangles")]
    assert taken > 40  # each mesh's filters, the size bound's passes, the quadric
    # two units of work per node — collected, then fitted (the node left out needs no fit) — counted from the first
    # step, never backwards
    assert seen[0] == (0, 8) and seen == sorted(seen) and seen[-2:] == [(7, 8), (8, 8)]


def second_export(client):
    """``prepare_snapshot`` of the four nodes after an acknowledged first snapshot, announcing a model: a full run
    builds the ``scene.nodeAdded`` hint, which takes a version of its own."""
    build_snapshot(FakeScene(), client, slicer_version="5.12.4")
    client.handle(ack(1))
    announce = [("vtkMRMLModelNode4", "model")]
    return prepare_snapshot(scene_of_four(), client, slicer_version="5.12.4", announce=announce)


@pytest.mark.parametrize("phase", ["first step", "collect", "fit", "last step"])
def test_prepare_abandoned_between_steps_asks_nothing_of_the_client(small_budget, phase):
    """Stop between steps (``close()``): no ``scene.nodeAdded`` hint, no version used, nothing owed to the relay."""
    full = Stepper(second_export(live_client()), time.monotonic)
    full.advance(math.inf)
    assert (
        full.result.announced is not None and full.result.scene_version == 3
    )  # the hint took version 2
    after = {"first step": 1, "collect": 12, "fit": full.taken - 5, "last step": full.taken}[phase]
    client = live_client()
    steps = second_export(client)
    stepper = Stepper(steps, time.monotonic)
    for _ in range(after):
        assert not stepper.advance(0.0)
    stepper.close()
    assert (client.next_scene_version, client.snapshot_in_flight, client.snapshot_needed) == (
        2,
        None,
        False,
    )
    assert client.state is SessionState.ACTIVE
    with pytest.raises(StopIteration):
        next(steps)  # nothing after the step it was at runs


@pytest.mark.parametrize("chunk", [1, 7])
def test_prepare_in_parts_gives_what_one_pass_gives(monkeypatch, chunk):
    """``CHUNK_TRIANGLES`` (4M) splits the area test and the winding sort of large meshes; with tiny parts every mesh
    goes through them: the same answer as a sort of all the directed edges, and the same collected arrays."""

    def one_sort(triangles):
        n = int(triangles.max()) + 1
        key = np.sort(triangles.ravel() * n + triangles[:, [1, 2, 0]].ravel())
        return not np.any(key[1:] == key[:-1])

    mesh = collect.mesh_from_polydata(sphere(12))
    reversed_late = mesh.triangles.copy()
    reversed_late[-1] = reversed_late[-1][
        ::-1
    ]  # a repeated directed edge among the highest vertices
    mirror, sheared = vtkTransform(), vtkTransform()
    mirror.Scale(-1.0, 1.0, 1.0)
    sheared.SetMatrix([1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    whole = [collect.mesh_from_polydata(sphere(12), bake) for bake in (None, mirror, sheared)]
    whole.append(collect.mesh_from_triangles(mesh.positions, reversed_late))
    monkeypatch.setattr(collect, "CHUNK_TRIANGLES", chunk)
    for triangles in (
        mesh.triangles,
        reversed_late,
        mesh.triangles[::-1],
        np.array([[0, 1, 2], [1, 0, 3], [0, 1, 4]]),
    ):
        assert collect._consistently_wound(triangles) == one_sort(triangles)
    parts = [collect.mesh_from_polydata(sphere(12), bake) for bake in (None, mirror, sheared)]
    parts.append(collect.mesh_from_triangles(mesh.positions, reversed_late))
    for one, many in zip(whole, parts, strict=True):
        for a, b in (
            (one.positions, many.positions),
            (one.normals, many.normals),
            (one.triangles, many.triangles),
        ):
            np.testing.assert_array_equal(a, b)


def test_prepare_a_large_mesh_takes_many_short_steps(monkeypatch):
    """About a million triangles: collected, bounded (``CLUSTER_GOAL`` 10,000) and decimated in steps none of which
    holds a large part of the work — here the quadric's input is small, so its step (which cannot be split) is short
    too."""
    monkeypatch.setattr(snapshot, "PROFILES", {**decimate.PROFILES, "mobile": SMALL})
    monkeypatch.setattr(decimate, "CLUSTER_GOAL", 10_000)
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(700)})
    runs = []
    for _ in range(3):  # the steps are the same every run; other work on the machine only adds time
        stepper = Stepper(
            prepare_snapshot(scene, live_client(), slicer_version="5.12.4"), time.perf_counter
        )
        durations = []
        while True:
            start = time.perf_counter()
            done = stepper.advance(0.0)
            durations.append(time.perf_counter() - start)
            if done:
                break
        assert stepper.result.triangle_count <= 500
        runs.append(durations)
    fastest = np.min(runs, axis=0)
    assert len(fastest) > 15 and fastest.max() < 0.35 * fastest.sum()


def test_stepper_slices_by_its_clock_and_ends_with_the_result():
    def work(log):
        for i in range(5):
            log.append(i)
            yield
        return "done"

    log: list[int] = []
    # every reading of the clock is one second later: a 2.5 s slice holds three steps
    stepper = Stepper(work(log), itertools.count().__next__)
    assert not stepper.advance(2.5) and (log, stepper.taken) == ([0, 1, 2], 3)
    assert not stepper.advance(0.0) and stepper.taken == 4  # at least one step
    assert stepper.advance(math.inf) and (stepper.result, log) == ("done", [0, 1, 2, 3, 4])
    assert run(work([])) == "done"


def test_stepper_lets_a_step_raise_and_close_abandons_the_rest():
    closed: list[bool] = []

    def failing():
        yield
        raise KeyError("vtkMRMLModelNode4")

    stepper = Stepper(failing(), time.monotonic)
    assert not stepper.advance(0.0)
    with pytest.raises(KeyError):
        stepper.advance(0.0)
    with pytest.raises(RuntimeError):  # no result: the work failed, it did not end
        stepper.advance(0.0)

    def long():
        try:
            while True:
                yield
        finally:
            closed.append(True)

    stepper = Stepper(long(), time.monotonic)
    stepper.advance(0.0)
    stepper.close()
    assert closed == [True] and not stepper.done
