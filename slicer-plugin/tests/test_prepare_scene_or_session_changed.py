"""SLC-68: the scene or the session changed between two steps of a preparation (SLC-51), at every step position —
what ``LiveUpdates`` and the panel do with it: a scene closed (T7), a batch, *Hide node names*, a lost connection and
a session created again. ``prepare_snapshot``'s own checks are in ``test_prepare.py``."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator

import pytest
from support import (
    CODE,
    OTHER_TOKEN,
    TOKEN,
    FakeTransport,
    LiveScene,
    MrmlModel,
    ack,
    created,
    deliver,
    glb_json,
    leaks,
    manifest,
    reassemble,
    relay_error,
    resumed,
    root_extras,
    sphere,
)
from test_live import A, Rig, drop, resume, started_in_steps
from test_panel_live import NETWORK, B, C, begins_on, close_scene, reconnect, sent_on
from test_panel_live import Rig as PanelRig
from test_panel_prepare_resume import RESTART, stepwise

from remoteview_core.debounce import Change
from remoteview_core.panel import Phase
from remoteview_core.protocol_client import SessionState
from remoteview_core.transport import Connected, Disconnected, Received
from remoteview_protocol import schemas

#: the scene closed while it is prepared (patient Doe): a scripted ID (aliased ``m_<n>``), a generated one, and a
#: segment of a scripted node
DOE = (
    {"id": "Sphere", "name": "Doe^John liver"},
    {"id": A, "name": "Doe^John lung"},
    {"id": "SegDoe", "segment": "DoeTumor", "name": "Doe tumor"},
)
#: the scene opened after it (patient Roe)
ROE = ({"id": "Kidney", "name": "Roe^Jane kidney"},)
#: more steps than any preparation here takes: a loop over the positions ends even if one never does
MAX_STEPS = 500
READS = (
    "node_id",
    "segment_identity",
    "name",
    "polydata",
    "display_props",
    "world_matrix",
    "world_transform",
)


@pytest.fixture(scope="module")
def strict():
    compiled = schemas.compile_schemas()
    return lambda message: schemas.validate_message(message, None, compiled)


class ClosingScene(LiveScene):
    """``LiveScene`` that records every read of a handle of the scene it closed."""

    def __init__(self, *nodes: dict) -> None:
        super().__init__(*nodes)
        self.closed: list[dict] = []  # the closed scene's handles, kept alive
        self.reads_after_close: list[str] = []

    def close_and_open(self, *nodes: dict) -> None:
        self.closed += self.nodes
        self.nodes = [{**self._defaults(), **n} for n in nodes]


def _traced(method: str):
    def read(self, node):
        if any(node is handle for handle in self.closed):
            self.reads_after_close.append(method)
        return getattr(LiveScene, method)(self, node)

    return read


for _method in READS:
    setattr(ClosingScene, _method, _traced(_method))


def snapshots(frames: list) -> list[tuple[dict, bytes]]:
    """``(begin, GLB)`` of every snapshot completed in ``frames``."""
    out, current = [], None
    for frame in frames:
        if isinstance(frame, dict) and frame["type"] == "scene.snapshot.begin":
            current = [frame]
        elif current is not None:
            current.append(frame)
            if isinstance(frame, dict) and frame["type"] == "scene.snapshot.end":
                begin, glb, _ = reassemble(current)
                out.append((begin, glb))
                current = None
    return out


def node_counts(frames: list) -> list[int]:
    return [begin["nodeCount"] for begin, _ in snapshots(frames)]


def found(frames: list, *needles: str) -> list[str]:
    """The needles in any frame handed to the transport — a JSON message, a chunk or a reassembled GLB."""
    texts = [json.dumps(f) if isinstance(f, dict) else f.decode("latin-1") for f in frames]
    texts += [glb.decode("latin-1") for _, glb in snapshots(frames)]
    return sorted({needle for needle in needles for text in texts if needle in text})


def settle(rig: Rig, rounds: int = 3_000) -> None:
    """Pump until nothing is prepared, in flight or owed: preparations ticked, snapshots acknowledged."""
    for _ in range(rounds):
        if rig.live.preparing is not None:
            rig.live.tick()
        elif rig.client.snapshot_in_flight is not None:
            rig.ack()
        elif rig.live.owed or rig.live._debouncer.pending:
            rig.advance(100)
        else:
            return
    raise AssertionError("not settled")


def at_every_step(strict, *, re_export: bool) -> Iterator[tuple[int, Rig]]:
    """A stepwise rig (``slice_s=0``) whose preparation of :data:`DOE` has taken ``k`` steps, for every ``k`` before
    its ``begin``; ``sent`` is empty. With ``re_export`` the first snapshot is in and acknowledged, and a model added
    is being re-exported. The scene is a :class:`ClosingScene`."""
    for k in range(1, MAX_STEPS):
        rig = Rig(strict, ClosingScene(*DOE), slice_s=0.0)
        if re_export:
            started_in_steps(rig)
            rig.scene.add("Spleen", name="Doe^John spleen")
            rig.live.mark("Spleen", Change.ADDED)
            rig.timer.advance(750)  # the flush: the re-export's first step
        else:
            rig.live.start()  # the first slice: one step
        for _ in range(k - 1):
            rig.live.tick()
        if rig.live.preparing is None:
            assert k > 10  # the scene took that many steps: every position was tried
            return
        assert rig.sent == []
        yield k, rig
    raise AssertionError("still preparing")


@pytest.mark.parametrize("re_export", [False, True])
def test_live_a_scene_closed_at_any_step_of_a_preparation_never_reaches_the_viewers(
    strict, re_export, caplog
):
    """T7: ``reset()`` between any two steps abandons the preparation before the registry forgets the closed
    scene — no handle of it read again, nothing of it sent — and the viewers get an empty snapshot, then the next
    scene (§7.3)."""
    for k, rig in at_every_step(strict, re_export=re_export):
        aliases = sorted(rig.live.ids._models.values())  # the closed scene's aliases (m_<n>)
        with caplog.at_level(logging.DEBUG):
            caplog.clear()
            rig.scene.close_and_open(*ROE)
            rig.live.reset()
            assert rig.live.preparing is None, k
            settle(rig)
        assert rig.scene.reads_after_close == [], k
        assert node_counts(rig.sent) == [0, 1], k
        assert found(rig.sent, "Doe", "Sphere", "SegDoe", "Spleen", *aliases) == [], k
        assert caplog.text == "", k


@pytest.mark.parametrize("re_export", [False, True])
def test_live_a_batch_at_any_step_of_a_preparation_abandons_it_and_sends_the_scene_after_it(
    strict, re_export
):
    """A batch (a load, an import) abandons the preparation; after it, only the scene the batch left goes out, once."""
    for k, rig in at_every_step(strict, re_export=re_export):
        rig.live.hold()
        assert rig.live.preparing is None, k
        rig.scene.remove(A)
        rig.scene.add(C, name="Doe^John heart")
        rig.live.mark(A, Change.REMOVED)
        rig.live.mark(C, Change.ADDED)
        for _ in range(3):
            rig.advance(1_000)
        assert rig.sent == [], k
        rig.live.release()
        settle(rig)
        [(begin, glb)] = snapshots(rig.sent)
        ids = {e["nodeId"] for e in manifest(glb)}
        assert C in ids and A not in ids and begin["nodeCount"] == len(rig.scene.nodes), k
        assert begin["sceneVersion"] == (2 if re_export else 1), k


@pytest.mark.parametrize("re_export", [False, True])
def test_live_names_hidden_at_any_step_of_a_preparation_are_never_sent(strict, re_export):
    """*Hide node names* abandons a preparation made with the names; the next one hides them: no name, a segment's
    ``s_<n>`` alias and no ``segmentId`` (§7.3)."""
    for k, rig in at_every_step(strict, re_export=re_export):
        rig.live.set_anonymize_names(True)
        assert rig.live.preparing is None and rig.sent == [], k
        settle(rig)
        [(_, glb)] = snapshots(rig.sent)
        assert root_extras(glb)["anonymizedNames"] is True, k
        assert found(rig.sent, "Doe", "DoeTumor") == [], k
        [segment] = [e for e in manifest(glb) if "/" in e["nodeId"]]
        assert segment["nodeId"].split("/")[1].startswith("s_") and "segmentId" not in segment
        names = [n.get("name", "") for n in glb_json(glb)["nodes"]]
        assert not any("Doe" in name for name in names), k


@pytest.mark.parametrize("re_export", [False, True])
def test_live_a_connection_lost_at_any_step_of_a_preparation_sends_it_once_on_the_same_session(
    strict, re_export
):
    """A drop abandons the preparation (nothing sent, no version used); the resume of the same session prepares the
    scene again and sends it once, on that session's aliases."""
    for k, rig in at_every_step(strict, re_export=re_export):
        version = rig.client.next_scene_version
        aliases = dict(rig.live.ids._models)
        drop(rig)
        assert rig.live.preparing is None and rig.sent == [], k
        for _ in range(3):
            rig.advance(1_000)
        assert rig.sent == [] and rig.client.next_scene_version == version, k
        held = 1 if re_export else 0
        resume(rig, scene=held, snapshot=held or None)
        settle(rig)
        [(begin, glb)] = snapshots(rig.sent)
        assert begin["nodeCount"] == len(rig.scene.nodes), k
        assert {raw: rig.live.ids._models[raw] for raw in aliases} == aliases, k
        assert "m_1" in {e["nodeId"] for e in manifest(glb)}, k


@pytest.mark.parametrize("re_export", [False, True])
def test_live_a_session_closed_at_any_step_of_a_preparation_sends_nothing_more(strict, re_export):
    """The session stopped or expired (before it is created again, SLC-45): ``observe()`` stops the controller — the
    preparation abandoned, no read of the scene, no frame — and its ticks do nothing."""
    for k, rig in at_every_step(strict, re_export=re_export):
        rig.client.close()
        rig.live.observe()
        assert rig.live.preparing is None, k
        meshes = rig.scene.meshes
        for _ in range(3):
            rig.advance(1_000)
        assert rig.sent == [] and rig.scene.meshes == meshes, k
        assert rig.client.state is SessionState.CLOSED


# --------------------------------------------------------------------------- the panel


def panel_at_every_step(models: Callable[[], list[MrmlModel]]) -> Iterator[tuple[int, PanelRig]]:
    """A live panel (``prepare_slice_s=0``) whose first snapshot has taken ``k + 1`` steps, for every ``k`` before
    its ``begin``: every position the pump exposes — the pump that delivers ``session.created`` runs two steps."""
    for k in range(1, MAX_STEPS):
        FakeTransport.made = []  # sent_on() reads the first transport made
        rig = stepwise(*models())
        for _ in range(k - 1):
            rig.pump(0)
        if rig.ctl._live.preparing is None:
            assert k > 10
            return
        assert begins_on(1) == []
        yield k, rig
    raise AssertionError("still preparing")


def doe_models() -> list[MrmlModel]:
    return [
        MrmlModel("Sphere", name="Doe^John liver", polydata=sphere(12)),
        MrmlModel(B, name="Doe^John lung", polydata=sphere(12)),
    ]


def panel_settle(rig: PanelRig, connection: int, pumps: int = 3_000) -> None:
    """Pump the panel, acknowledging each snapshot it begins on ``connection``, until nothing is prepared or owed."""
    acked = 0
    for _ in range(pumps):
        live = rig.ctl._live
        begins = begins_on(connection)
        if len(begins) > acked:
            acked = len(begins)
            deliver(rig.ctl, Received(connection, ack(begins[-1]["sceneVersion"])))
        elif live.preparing is not None or live.owed or live._debouncer.pending:
            rig.pump(1_000)
        else:
            return
    raise AssertionError("not settled")


def test_panel_a_scene_closed_at_any_step_of_a_preparation_never_reaches_the_viewers(
    fake, caplog, capfd
):
    """§7.3, T7 through the panel: *File → Close Scene* (a batch around ``EndCloseEvent``) and a load, at any step of
    the first snapshot's preparation — nothing of the closed scene goes out, the next scene does."""
    for k, rig in panel_at_every_step(doe_models):
        with caplog.at_level(logging.DEBUG):
            close_scene(rig, *list(rig.models), added=[MrmlModel(C, name="Roe^Jane kidney")])
            panel_settle(rig, 1)
        frames = sent_on(1)
        # the closed scene leaves the viewers empty first (§7.3)
        assert node_counts(frames) == [0, 1], k
        assert found(frames, "Doe", "Sphere", "m_1", B) == [], k
        assert leaks(caplog, capfd, "Doe", "Sphere", B, CODE, TOKEN) == [], k


def test_panel_a_connection_lost_at_any_step_of_a_preparation_sends_it_once_after_the_resume(fake):
    """The drop abandons the preparation: nothing begins on the lost connection, no alias is issued while
    reconnecting, and the resumed session gets the scene once, with the same aliases."""
    for k, rig in panel_at_every_step(doe_models):
        live = rig.ctl._live
        deliver(rig.ctl, Disconnected(1, NETWORK, 0.5))
        assert rig.ctl.phase is Phase.RECONNECTING and live.preparing is None, k
        before = repr(live.ids)
        for _ in range(5):
            rig.pump(1_000)
        assert repr(live.ids) == before, k
        deliver(rig.ctl, Connected(2))
        [resume_message] = sent_on(2)
        assert resume_message["type"] == "session.resume"
        deliver(
            rig.ctl,
            Received(2, resumed(resume_message["id"], scene_version=0, snapshot_version=None)),
        )
        panel_settle(rig, 2)
        assert begins_on(1) == [] and [b["sceneVersion"] for b in begins_on(2)] == [1], k
        _, glb, _ = reassemble(sent_on(2)[1:])
        assert sorted(e["nodeId"] for e in manifest(glb)) == ["m_1", B], k
        assert rig.ctl._live is live, k


def test_panel_a_session_created_again_at_any_step_of_a_preparation_starts_afresh(fake):
    """SLC-45: a relay restart while the scene is prepared — the old controller's preparation is abandoned and its
    registry issues nothing more; the new session's first snapshot is version 1 with aliases of its own (§7.3)."""
    for k, rig in panel_at_every_step(doe_models):
        old = rig.ctl._live
        resume_id = reconnect(rig, RESTART)
        deliver(rig.ctl, Received(2, relay_error("SESSION_NOT_FOUND", resume_id)))
        assert rig.ctl._live is None and old.preparing is None, k
        before = repr(old.ids)
        create = sent_on(2)[-1]
        assert create["type"] == "session.create"
        deliver(rig.ctl, Received(2, created(create["id"], token=OTHER_TOKEN)))
        new = rig.ctl._live
        assert new is not old and new.ids is not old.ids, k
        panel_settle(rig, 2)
        assert repr(old.ids) == before and begins_on(1) == [], k
        [begin] = begins_on(2)
        assert begin["sceneVersion"] == 1 and begin["nodeCount"] == 2, k
        _, glb, _ = reassemble(sent_on(2)[sent_on(2).index(begin) :])
        assert sorted(e["nodeId"] for e in manifest(glb)) == ["m_1", B], k
