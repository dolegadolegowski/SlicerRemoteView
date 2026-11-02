"""The scene prepared in steps (SLC-51) across a lost connection (SLC-42, SLC-44, SLC-45): the panel, end to end with
the real collect and decimation (the merge of `main` into `ws/slicer`, 2026-10-30)."""

from __future__ import annotations

import logging

from support import (
    CODE,
    OTHER_TOKEN,
    TOKEN,
    URL,
    MrmlModel,
    ack,
    created,
    deliver,
    leaks,
    relay_error,
    resumed,
    sphere,
)
from test_panel_live import NETWORK, A, B, C, Rig, begins_on, close_scene, reconnect, sent_on

from remoteview_core.panel import Phase
from remoteview_core.transport import Connected, Disconnected, ErrorKind, Received, TransportError

RESTART = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4008)


def stepwise(*models) -> Rig:
    """A live panel that prepares one step per pump (the tests' ``prepare_slice_s=0``)."""
    rig = Rig(*models)
    rig.ctl._prepare_slice_s = 0.0
    rig.ctl.start(URL)
    deliver(rig.ctl, Connected(1), Received(1, created()))
    return rig


def until_begin(rig: Rig, connection: int, pumps: int = 200) -> list[dict]:
    for _ in range(pumps):
        begins = begins_on(connection)
        if begins:
            return begins
        rig.pump(0)
    raise AssertionError("no begin")


def preparing_a_re_export(rig: Rig) -> int:
    """The first snapshot sent and acknowledged, then a model added: its re-export is being prepared. The version
    the viewers hold."""
    [first] = until_begin(rig, 1)
    deliver(rig.ctl, Received(1, ack(first["sceneVersion"])))
    rig.add(MrmlModel(B, name="Doe^John kidney", polydata=sphere(16)))
    rig.pump(1000)  # the flush starts the re-export: its first step
    assert rig.ctl._live.preparing is not None
    return first["sceneVersion"]


def test_panel_a_drop_abandons_the_first_preparation_and_the_resume_sends_it_once(fake):
    """SLC-51's rule: a lost connection abandons a preparation — nothing sent, no hold left but the pause's — and
    the resume prepares the scene again (merge review: it stayed frozen through the outage)."""
    rig = stepwise(MrmlModel(A, polydata=sphere(16)), MrmlModel(C, polydata=sphere(16)))
    live = rig.ctl._live
    assert live.preparing is not None
    deliver(rig.ctl, Disconnected(1, NETWORK, 0.5))
    assert rig.ctl.phase is Phase.RECONNECTING
    assert live.preparing is None and live._debouncer._holds == 1  # the pause's hold only
    for _ in range(5):
        rig.pump(1000)
    resume_id = reconnect(rig)
    deliver(rig.ctl, Received(2, resumed(resume_id, scene_version=0, snapshot_version=None)))
    assert [b["sceneVersion"] for b in until_begin(rig, 2)] == [1]
    assert begins_on(1) == []
    deliver(rig.ctl, Received(2, ack(1)))
    for _ in range(5):
        rig.pump(1000)
    assert [b["sceneVersion"] for b in begins_on(2)] == [1] and live._debouncer._holds == 0


def test_panel_a_drop_during_a_re_export_sends_it_once_after_a_consistent_resume(fake):
    rig = stepwise(MrmlModel(A, polydata=sphere(16)))
    held = preparing_a_re_export(rig)
    resume_id = reconnect(rig)
    assert rig.ctl._live.preparing is None
    deliver(rig.ctl, Received(2, resumed(resume_id, scene_version=held, snapshot_version=held)))
    [begin] = until_begin(rig, 2)
    assert begin["sceneVersion"] == held + 1 and begin["nodeCount"] == 2
    deliver(rig.ctl, Received(2, ack(begin["sceneVersion"])))
    for _ in range(5):
        rig.pump(1000)
    assert len(begins_on(2)) == 1 and rig.ctl._live._debouncer._holds == 0


def test_panel_a_re_create_during_a_preparation_starts_afresh(fake):
    """SLC-45: a session created again after a relay restart has other aliases — a new live update, registry and
    cache, and its first snapshot is version 1."""
    rig = stepwise(MrmlModel(A, polydata=sphere(16)))
    preparing_a_re_export(rig)
    old = rig.ctl._live
    resume_id = reconnect(rig, RESTART)
    deliver(rig.ctl, Received(2, relay_error("SESSION_NOT_FOUND", resume_id)))
    assert rig.ctl._live is None and old.preparing is None
    create = sent_on(2)[-1]
    assert create["type"] == "session.create"
    deliver(rig.ctl, Received(2, created(create["id"], token=OTHER_TOKEN)))
    new = rig.ctl._live
    assert new is not old and new.ids is not old.ids and new._cache is not old._cache
    [begin] = until_begin(rig, 2)
    assert begin["sceneVersion"] == 1 and begin["nodeCount"] == 2


def test_panel_a_scene_closed_offline_during_a_preparation_sends_the_new_scene_first(
    fake, caplog, capfd
):
    """§7.3, T7: the closed scene's re-export was abandoned at the drop; after the resume the new (empty) scene's
    snapshot is the first scene frame, and nothing of the closed scene — no update, hint, name or ID — goes out."""
    caplog.set_level(logging.DEBUG)
    rig = stepwise(MrmlModel(A, name="Doe^John liver", polydata=sphere(16)))
    held = preparing_a_re_export(rig)
    resume_id = reconnect(rig)
    close_scene(rig, *list(rig.models))
    assert rig.ctl._live.reset_owed
    deliver(rig.ctl, Received(2, resumed(resume_id, scene_version=held, snapshot_version=held)))
    [begin] = until_begin(rig, 2)
    frames = [m for m in sent_on(2) if isinstance(m, dict)]
    assert [m["type"] for m in frames][:2] == ["session.resume", "scene.snapshot.begin"]
    assert not {"scene.update", "scene.nodeAdded"} & {m["type"] for m in frames}
    assert begin["nodeCount"] == 0
    chunks = [m for m in sent_on(2) if isinstance(m, bytes)]
    assert all(b"Doe" not in chunk and b"kidney" not in chunk for chunk in chunks)
    assert leaks(caplog, capfd, A, B, "Doe", "John", CODE, TOKEN) == []
