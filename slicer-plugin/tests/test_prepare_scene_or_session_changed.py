"""SLC-68: the scene or the session changed between two steps of a preparation (SLC-51), at every step position —
what ``LiveUpdates`` and the panel do with it: a scene closed (T7), a batch, *Hide node names*, a lost connection and
a session created again. ``prepare_snapshot``'s own checks are in ``test_prepare.py``. SLC-70: a scene closed off the
main thread, between two steps or during one. SLC-71: nodes removed or hidden while the scene is prepared."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator

import pytest
from support import (
    CODE,
    OTHER_TOKEN,
    TOKEN,
    URL,
    FakeSegment,
    FakeTransport,
    LiveScene,
    MrmlModel,
    MrmlSegmentation,
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
from test_live import A, Rig, drop, resume, started_in_steps, to_the_end
from test_panel_live import (
    EVENTS,
    NETWORK,
    B,
    C,
    _in_thread,
    begins_on,
    close_scene,
    recolor,
    reconnect,
    sent_on,
)
from test_panel_live import Rig as PanelRig
from test_panel_prepare_resume import RESTART, stepwise, until_begin

from remoteview_core import decimate
from remoteview_core import live as live_module
from remoteview_core import snapshot as snapshot_module
from remoteview_core.debounce import Change
from remoteview_core.live import LiveEventKind
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


# --------------------------------------------------------------------------- closed off the main thread (SLC-70)


class ClosedInAStep(ClosingScene):
    """A :class:`ClosingScene` that ``on_read`` (once) when the preparation reads the mesh of node ``at``."""

    def __init__(self, *nodes: dict, at: str, on_read: Callable[[], None]) -> None:
        super().__init__(*nodes)
        self._at, self._on_read = at, on_read

    def polydata(self, node):
        if node["id"] == self._at and self._on_read is not None:
            hook, self._on_read = self._on_read, None
            hook()
        return super().polydata(node)


#: where the preparation is when a close finishes off the main thread: a mesh read of the collection, a fit step,
#: the GLB written in the last step, and ``begin_snapshot`` at its end (after the last check)
DURING = ("collect", "fit", "glb", "begin")


def once(fn: Callable[[], None]) -> Callable[[], None]:
    pending = [fn]

    def fire() -> None:
        if pending:
            pending.pop()()

    return fire


def close_during(where: str, fire: Callable[[], None], monkeypatch, client) -> None:
    """Run ``fire`` inside the step ``where`` (``collect`` is the scene's or a model's own read)."""
    if where == "fit":
        real_fit = decimate.fit_entity_steps

        def fit(*args, **kw):
            fire()
            return (yield from real_fit(*args, **kw))

        monkeypatch.setattr(decimate, "fit_entity_steps", fit)
    elif where == "glb":
        real_write = snapshot_module.write_glb
        monkeypatch.setattr(
            snapshot_module, "write_glb", lambda *a, **kw: (fire(), real_write(*a, **kw))[1]
        )
    elif where == "begin":
        real_begin = client.begin_snapshot
        monkeypatch.setattr(
            client, "begin_snapshot", lambda *a, **kw: (fire(), real_begin(*a, **kw))[1]
        )


@pytest.mark.parametrize("where", DURING)
def test_live_a_scene_closed_off_thread_during_a_step_is_an_abandon_not_a_failure(
    strict, caplog, monkeypatch, where
):
    """The scene closed on another thread while a step runs (the whole preparation in one call): that step ends, and
    nothing of the closed scene goes out — stopped at the next step, before the version, or before the frames of a
    snapshot already begun —; no error, no failure event; the reset follows at once and the next scene goes out."""
    rig = Rig(strict, LiveScene(), slice_s=None)

    def close():
        rig.scene.close_and_open(*ROE)
        _in_thread(rig.live.scene_closed_off_thread)

    fire = once(close)
    if where == "collect":
        rig.scene = ClosedInAStep(*DOE, at=A, on_read=fire)
    else:
        rig.scene = ClosingScene(*DOE)
        close_during(where, fire, monkeypatch, rig.client)
    with caplog.at_level(logging.DEBUG):
        rig.live.start()
        assert rig.live.preparing is None and rig.sent == [] and rig.kinds() == []
        assert rig.live.reset_owed and rig.client.snapshot_needed
        reads = len(rig.scene.reads_after_close)
        settle(rig)
    assert (
        reads <= 2 and rig.scene.reads_after_close[reads:] == []
    )  # the rest of that one step only
    assert node_counts(rig.sent) == [1] and found(rig.sent, "Doe", "Sphere", "SegDoe") == []
    assert caplog.text == ""


def test_live_a_scene_closed_off_thread_between_steps_stops_the_preparation_at_the_next(strict):
    """Between two steps (``slice_s=0``): the next tick stops the preparation before any step reads the closed scene,
    and resets as for a close on the main thread — an empty snapshot first, then the next scene."""
    for k, rig in at_every_step(strict, re_export=False):
        rig.scene.close_and_open(*ROE)
        _in_thread(rig.live.scene_closed_off_thread)
        rig.live.tick()
        assert rig.live.preparing is None and rig.sent == [] and rig.kinds() == [], k
        assert rig.live.reset_owed, k
        settle(rig)
        assert rig.scene.reads_after_close == [] and node_counts(rig.sent) == [0, 1], k
        assert found(rig.sent, "Doe", "Sphere", "SegDoe") == [], k


def test_live_a_scene_closed_off_thread_with_its_snapshot_in_flight_is_reset_at_the_next_tick(
    strict,
):
    """No preparation, no flush: the next tick resets as a close on the main thread does — the closed scene's queued
    chunks dropped, an empty snapshot first, then the next scene (§6.2, §7.3)."""
    rig = Rig(strict, ClosingScene(*DOE), slice_s=0.0)
    rig.live.start()
    to_the_end(rig)
    assert rig.client.snapshot_in_flight == 1
    before = len(rig.sent)
    rig.scene.close_and_open(*ROE)
    _in_thread(rig.live.scene_closed_off_thread)
    assert rig.discarded == 0 and not rig.live.reset_owed
    rig.live.tick()
    assert rig.discarded == 1 and rig.live.reset_owed and rig.sent[before:] == []
    settle(rig)
    after = rig.sent[before:]
    assert node_counts(after) == [0, 1] and found(after, "Doe", "Sphere", "SegDoe") == []


#: the next patient's scene, with the raw IDs of two closed nodes: a red model where the closed scene had a model with
#: a scripted ID, and a generated ID Slicer restarts counting after a close
ROE_LIKE_DOE = (
    {"id": "Sphere", "name": "Roe^Jane sphere", "color": (0.9, 0.1, 0.1)},
    {"id": A, "name": "Roe^Jane lung", "color": (0.9, 0.1, 0.1)},
)


@pytest.mark.parametrize("trigger", ["timer", "send_now"])
def test_live_a_flush_after_a_scene_closed_off_thread_resets_first(strict, monkeypatch, trigger):
    """The flush timer, or *Send now*, between the close off the main thread and the next tick, with changes of the
    closed scene waiting: the reset comes first, so no update names a closed scene's ID with the next scene's values
    and no alias of it goes to the next scene's node with the same raw ID (§7.3, T7)."""
    rig = started_in_steps(Rig(strict, ClosingScene(*DOE), slice_s=0.0))
    issued = set(rig.live.ids._models.values())
    followed: list[bool] = []  # at each classification: the close followed first
    real_classify = live_module.classify

    def classify(*args, **kw):
        followed.append(rig.live.ids.generation == rig.live._seen_generation)
        return real_classify(*args, **kw)

    monkeypatch.setattr(live_module, "classify", classify)
    rig.scene.node(A)["color"] = (0.1, 0.2, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.live.mark("Sphere", Change.GEOMETRY)
    rig.scene.close_and_open(*ROE_LIKE_DOE)
    _in_thread(rig.live.scene_closed_off_thread)
    if trigger == "timer":
        rig.timer.advance(1_000)
    else:
        rig.live.send_now()
    assert rig.live.reset_owed
    assert not any(isinstance(m, dict) and m["type"] == "scene.update" for m in rig.sent)
    assert set(node_counts(rig.sent)) <= {0}  # at most the reset's empty snapshot so far
    settle(rig)
    frames = [m for m in rig.sent if isinstance(m, dict)]
    assert not any(m["type"] in ("scene.update", "scene.nodeRemoved") for m in frames)
    ids = {e["nodeId"] for _, glb in snapshots(rig.sent) for e in manifest(glb)}
    assert node_counts(rig.sent)[-1] == 2 and not issued & ids and found(rig.sent, "Doe") == []
    assert followed and all(followed)  # the closed scene's marks were never classified


class ClosedWhileListed(ClosingScene):
    """A :class:`ClosingScene` that ``on_list`` (once) when its shown models are listed — by the classifier of a
    flush, once armed."""

    on_list: Callable[[], None] | None = None

    def visible_model_nodes(self):
        hook, self.on_list = self.on_list, None
        if hook is not None:
            hook()
        return super().visible_model_nodes()


@pytest.mark.parametrize("broken", [False, True])
def test_live_a_scene_closed_off_thread_while_a_flush_is_classified_sends_nothing_of_it(
    strict, caplog, broken
):
    """The close finishes while the classifier reads the scene, after the flush's own check: the plan is dropped —
    no update under a closed scene's ID with the next scene's values — and the reset follows (§7.3, T7). A listing the
    finished close broke is no failure either."""
    rig = started_in_steps(Rig(strict, ClosedWhileListed(*DOE), slice_s=0.0))
    issued = set(rig.live.ids._models.values())
    rig.scene.node(A)["color"] = (0.1, 0.2, 0.3)
    rig.live.mark(A, Change.APPEARANCE)
    rig.live.mark("Sphere", Change.APPEARANCE)

    def close():
        rig.scene.close_and_open(*ROE_LIKE_DOE)
        _in_thread(rig.live.scene_closed_off_thread)
        if broken:
            raise RuntimeError("vtkMRMLModelNode4 Doe^John lung: no such node")

    rig.scene.on_list = close
    with caplog.at_level(logging.DEBUG):
        rig.timer.advance(1_000)
        assert rig.live.reset_owed
        assert not any(isinstance(m, dict) and m["type"] == "scene.update" for m in rig.sent)
        settle(rig)
    ids = {e["nodeId"] for _, glb in snapshots(rig.sent) for e in manifest(glb)}
    assert node_counts(rig.sent)[-1] == 2 and not issued & ids and found(rig.sent, "Doe") == []
    assert caplog.text == ""


class BrokenByTheClose(ClosedInAStep):
    """A :class:`ClosedInAStep` whose read, once the scene is closed, raises as a node removed under the step would
    (its text names the node, as VTK's and MRML's do)."""

    def polydata(self, node):
        mesh = super().polydata(node)
        if any(node is handle for handle in self.closed):
            raise AttributeError(f"{node['id']} {node['name']} has no mesh")
        return mesh


def test_live_a_read_the_close_off_thread_broke_is_an_abandon_too(strict, caplog):
    """A close that has finished leaves a handle whose read raises in the running step: an abandon like the others —
    no error line, no failure event — and the reset follows."""
    rig = Rig(strict, LiveScene(), slice_s=None)

    def close():
        rig.scene.close_and_open(*ROE)
        _in_thread(rig.live.scene_closed_off_thread)

    rig.scene = BrokenByTheClose(*DOE, at=A, on_read=close)
    with caplog.at_level(logging.DEBUG):
        rig.live.start()
        assert rig.live.preparing is None and rig.sent == [] and rig.kinds() == []
        assert rig.live.reset_owed
        settle(rig)
    assert node_counts(rig.sent) == [1] and found(rig.sent, "Doe", "Sphere", "SegDoe") == []
    assert caplog.text == ""


def test_live_a_read_broken_before_an_off_thread_end_close_is_a_failure_that_sends_nothing_of_it(
    strict, caplog
):
    """``Clear`` removes every node before its ``EndCloseEvent``: a read that breaks meanwhile comes before the close
    is known — a failure by type (one line, a FAILED event) —, and the close that follows resets as usual: nothing of
    the closed scene goes out, no ID or name is logged (T7)."""
    rig = Rig(strict, LiveScene(), slice_s=None)
    rig.scene = BrokenByTheClose(*DOE, at=A, on_read=lambda: rig.scene.close_and_open(*ROE))
    with caplog.at_level(logging.DEBUG):
        rig.live.start()  # the read breaks; EndCloseEvent has not fired yet
        assert rig.kinds() == [LiveEventKind.FAILED] and rig.sent == []
        _in_thread(rig.live.scene_closed_off_thread)  # now it does
        settle(rig)
    assert node_counts(rig.sent) == [1] and found(rig.sent, "Doe", "Sphere", "SegDoe") == []
    assert "live: scene not exported (AttributeError)" in caplog.text
    assert "Doe" not in caplog.text and A not in caplog.text


def test_live_a_scene_closed_off_thread_while_the_empty_snapshot_is_built_keeps_the_session(
    strict, caplog, monkeypatch
):
    """A second close, off the main thread, while a reset builds its empty snapshot: the empty scene names nothing,
    so nothing stops it — the session goes on, and the second close is reset in its turn (§7.3)."""
    rig = started_in_steps(Rig(strict, ClosingScene(*DOE), slice_s=0.0))
    real_write = snapshot_module.write_glb

    def second_close():
        rig.scene.close_and_open({"id": "vtkMRMLModelNode9", "name": "Poe^Ann spleen"})
        _in_thread(rig.live.scene_closed_off_thread)

    fire = once(second_close)

    def write(entities, *args, **kw):
        if not entities:
            fire()
        return real_write(entities, *args, **kw)

    monkeypatch.setattr(snapshot_module, "write_glb", write)
    rig.scene.close_and_open(*ROE)
    with caplog.at_level(logging.DEBUG):
        rig.live.reset()
        settle(rig)
    assert rig.ended == [] and caplog.text == ""
    assert node_counts(rig.sent)[0] == 0 and node_counts(rig.sent)[-1] == 1
    assert found(rig.sent, "Doe", "Roe") == []


def closed_off_thread(rig: PanelRig, *closed, added=()) -> None:
    """*File → Close Scene* and a load, run on another thread: the observers see every event off the main thread."""
    _in_thread(close_scene, rig, *closed)
    for model in added:
        _in_thread(rig.add, model)


def roe_models() -> list[MrmlModel]:
    return [
        MrmlModel("Sphere", name="Roe^Jane sphere", polydata=sphere(11)),
        MrmlModel("vtkMRMLModelNode7", name="Roe^Jane liver", polydata=sphere(8)),
    ]


def test_panel_a_scene_closed_off_thread_at_any_step_of_a_preparation_never_reaches_the_viewers(
    fake, caplog, capfd
):
    """T7 through the panel and the real observers: a close on another thread, at every position the pump exposes,
    goes as a close on the main thread does — the viewers get an empty snapshot, then the next scene only, without
    an alias of the closed one (§7.3: none reissued)."""
    for k, rig in panel_at_every_step(doe_models):
        issued = set(rig.ctl._live.ids._models.values())
        new = roe_models()
        with caplog.at_level(logging.DEBUG):
            closed_off_thread(rig, *list(rig.models), added=new)
            panel_settle(rig, 1)
        frames = sent_on(1)
        assert node_counts(frames) == [0, 2], k
        assert found(frames, "Doe", B) == [], k
        ids = {e["nodeId"] for e in manifest(snapshots(frames)[-1][1])}
        assert "vtkMRMLModelNode7" in ids and not issued & ids, k
        assert leaks(caplog, capfd, "Doe", "Roe", "Sphere", "Traceback", CODE, TOKEN) == [], k
        assert "live:" not in caplog.text and "scene:" not in caplog.text, k


class ReadHook(MrmlModel):
    """A model that runs ``on_read`` (once) when its mesh is read."""

    def __init__(self, node_id, *, on_read=None, **kw):
        super().__init__(node_id, **kw)
        self.on_read = on_read

    def GetPolyData(self):  # noqa: N802 — MRML's name
        hook, self.on_read = self.on_read, None
        if hook is not None:
            hook()
        return super().GetPolyData()


@pytest.mark.parametrize("where", DURING)
def test_panel_a_scene_closed_off_thread_during_a_step_of_the_default_slice_never_reaches_the_viewers(
    fake, caplog, capfd, monkeypatch, where
):
    """The close finishes on another thread while a step of the panel's own slice runs (the fake clock keeps the
    whole preparation in one slice) — in the collection, the fit, the GLB's write or the begin: nothing of the closed
    scene goes out, no error line, and the next scene follows as after a close on the main thread."""
    hooked = ReadHook("Spleen", name="Doe^John spleen", polydata=sphere(9))
    rig = PanelRig(*doe_models(), hooked)  # the panel's default slice
    seen: list[bool] = []

    def close():
        seen.append(rig.ctl._live.preparing is not None)
        closed_off_thread(rig, *list(rig.models), added=roe_models())

    fire = once(close)
    rig.ctl.start(URL)
    if where == "collect":
        hooked.on_read = fire
    else:
        close_during(where, fire, monkeypatch, rig.ctl._client)
    with caplog.at_level(logging.DEBUG):
        deliver(
            rig.ctl, Connected(1), Received(1, created())
        )  # the whole preparation runs in this pump
        assert seen == [True] and begins_on(1) == [] and rig.ctl._live.preparing is None
        panel_settle(rig, 1)
    frames = sent_on(1)
    assert node_counts(frames) == [2] and found(frames, "Doe", B, "Spleen") == []
    assert leaks(caplog, capfd, "Doe", "Roe", "Spleen", "Traceback", CODE, TOKEN) == []
    assert "live:" not in caplog.text and "scene:" not in caplog.text


def test_panel_a_flush_between_a_scene_closed_off_thread_and_the_pump_resets_first(
    fake, caplog, capfd
):
    """The flush timer fires between the close off the main thread and the next pump, with a colour change of the
    closed scene waiting: no update addresses the closed scene's IDs, no alias of it is reissued, and the viewers
    get the empty snapshot first (§7.3, T7)."""
    rig = stepwise(*doe_models())
    [first] = until_begin(rig, 1)
    deliver(rig.ctl, Received(1, ack(first["sceneVersion"])))
    panel_settle(rig, 1)
    issued = set(rig.ctl._live.ids._models.values())
    before = len(sent_on(1))
    recolor(rig.models[0], (0.1, 0.9, 0.1))
    recolor(rig.models[1], (0.1, 0.9, 0.1))
    assert rig.ctl._live.changes_wait
    with caplog.at_level(logging.DEBUG):
        closed_off_thread(rig, *list(rig.models), added=roe_models())
        rig.timer.advance(1_000)  # the flush timer, before the pump
        assert rig.ctl._live.reset_owed
        panel_settle(rig, 1)
    after = sent_on(1)[before:]
    assert not any(isinstance(m, dict) and m["type"] == "scene.update" for m in after)
    assert node_counts(after)[0] == 0 and node_counts(after)[-1] == 2
    ids = {e["nodeId"] for _, glb in snapshots(after) for e in manifest(glb)}
    assert not issued & ids and found(after, "Doe", B) == []
    assert leaks(caplog, capfd, "Doe", "Roe", "Traceback", CODE, TOKEN) == []
    assert "live:" not in caplog.text and "scene:" not in caplog.text


def outcome(*, off_thread: bool, in_flight: bool) -> tuple:
    """A live panel whose first snapshot is in (or still in flight), then *File → Close Scene* and a load, on the main
    thread or on another one: what the panel sends after the close, and what it drops of the queue."""
    FakeTransport.made = []
    rig = stepwise(*doe_models())
    [begin] = until_begin(rig, 1)
    if not in_flight:
        deliver(rig.ctl, Received(1, ack(begin["sceneVersion"])))
        panel_settle(rig, 1)
    before = len(sent_on(1))
    new = roe_models()
    if off_thread:
        closed_off_thread(rig, *list(rig.models), added=new)
        assert not rig.ctl._live.reset_owed and FakeTransport.made[0].discarded == []
        rig.pump(0)  # the next pump resets
    else:
        close_scene(rig, *list(rig.models), added=new)
    owed = rig.ctl._live.reset_owed
    panel_settle(rig, 1)
    after = sent_on(1)[before:]
    return owed, FakeTransport.made[0].discarded, node_counts(after), found(after, "Doe", B)


@pytest.mark.parametrize("in_flight", [False, True])
def test_panel_a_scene_closed_off_thread_with_no_preparation_goes_as_on_the_main_thread(
    fake, in_flight
):
    """With nothing being prepared, or with the closed scene's snapshot in flight, a close off the main thread is a
    reset at the next pump: the same frames as on the main thread, the queued chunks dropped (§6.2, §7.3)."""
    on_main = outcome(off_thread=False, in_flight=in_flight)
    assert on_main == (True, [1] if in_flight else [], [0, 2], [])
    assert outcome(off_thread=True, in_flight=in_flight) == on_main


def test_panel_a_scene_closed_off_thread_while_reconnecting_is_reset_at_once(fake, caplog, capfd):
    """Offline, a close off the main thread is a reset at the next pump, as on the main thread (``reset_owed``): the
    resume sends the new scene's snapshot first and nothing of the closed one; the other missed events are re-synced
    once the session is live (§7.3, T7)."""
    rig = stepwise(*doe_models())
    [first] = until_begin(rig, 1)
    deliver(rig.ctl, Received(1, ack(first["sceneVersion"])))
    panel_settle(rig, 1)
    resume_id = reconnect(rig)
    with caplog.at_level(logging.DEBUG):
        closed_off_thread(rig, *list(rig.models), added=roe_models())
        assert not rig.ctl._live.reset_owed
        rig.pump(0)
        assert rig.ctl.phase is Phase.RECONNECTING and rig.ctl._live.reset_owed
        deliver(rig.ctl, Received(2, resumed(resume_id, scene_version=1, snapshot_version=1)))
        panel_settle(rig, 2)
    frames = sent_on(2)
    assert [m["type"] for m in frames if isinstance(m, dict)][:2] == [
        "session.resume",
        "scene.snapshot.begin",
    ]
    assert node_counts(frames)[0] == 0 and node_counts(frames)[-1] == 2
    assert found(frames, "Doe", B) == []
    assert leaks(caplog, capfd, "Doe", "Roe", "Traceback", CODE, TOKEN) == []
    assert "live:" not in caplog.text and "scene:" not in caplog.text


# --------------------------------------------------------------------------- nodes removed meanwhile (SLC-71)

SEG = "vtkMRMLSegmentationNode1"


def viewers_hold(frames: list) -> dict[str, bool]:
    """``nodeId → visible`` on the viewers: the last snapshot in ``frames``, then the updates and removals after it."""
    messages = [m for m in frames if isinstance(m, dict)]
    last = max(i for i, m in enumerate(messages) if m["type"] == "scene.snapshot.begin")
    shown = {e["nodeId"]: e["visible"] for e in manifest(snapshots(frames)[-1][1])}
    for m in messages[last:]:
        if m["type"] == "scene.update":
            for change in m["changes"]:
                if "visible" in change and change["nodeId"] in shown:
                    shown[change["nodeId"]] = change["visible"]
        elif m["type"] == "scene.nodeRemoved":
            for node_id in m["nodeIds"]:
                shown.pop(node_id, None)
    return shown


def preparing_with_a_segmentation(strict, k: int, *, re_export: bool) -> Rig:
    """A stepwise rig whose preparation of a model and a segmentation of two segments has taken ``k`` steps: the
    first snapshot's, or (``re_export``) a re-export after the segmentation was added to a live session."""
    segments = ({"id": SEG, "segment": "Segment_1"}, {"id": SEG, "segment": "Segment_2"})
    if not re_export:
        rig = Rig(strict, LiveScene({"id": A}, *segments), slice_s=0.0)
        rig.live.start()
    else:
        rig = started_in_steps(Rig(strict, LiveScene({"id": A}), slice_s=0.0))
        for segment in segments:
            rig.scene.add(SEG, segment=segment["segment"])
            rig.live.mark_segment(SEG, segment["segment"], Change.ADDED)
        rig.timer.advance(750)  # the flush: the re-export's first step
    for _ in range(k - 1):
        rig.live.tick()
    return rig


@pytest.mark.parametrize("re_export", [False, True])
def test_live_a_segmentation_removed_at_any_step_of_a_preparation_is_removed_after_its_ack(
    strict, re_export
):
    """The segmentation node removed while the scene is prepared (the observers' whole-node mark): its segments may
    be in the snapshot — collected before the removal, or read from the handles listed before it —, and the viewers'
    scene from before that snapshot does not hold them yet; the mark finds them in the snapshot's scene, so they leave
    the viewers after its ack."""
    for k in range(1, MAX_STEPS):
        rig = preparing_with_a_segmentation(strict, k, re_export=re_export)
        if rig.live.preparing is None:
            assert k > 10
            break
        rig.scene.remove(SEG)
        rig.live.mark_held_segments(SEG, Change.REMOVED)
        settle(rig)
        viewers = viewers_hold(rig.sent)
        assert A in viewers and not any(i.startswith(f"{SEG}/") for i in viewers), (k, viewers)
    else:
        raise AssertionError("still preparing")


@pytest.mark.parametrize("removed_first", [False, True])
def test_live_whole_segmentation_marks_while_preparing_keep_every_change_removed_included(
    strict, removed_first
):
    """Two whole-node marks of a segmentation while the snapshot that carries it is prepared both reach that
    snapshot's segments after the ack, whatever their order — merged per node, never one for the other: its meshes
    changed and its colour (the geometry goes again), or its colour changed and the node removed (no segment of it is
    left on the viewers)."""
    segments = ({"id": SEG, "segment": "Segment_1"}, {"id": SEG, "segment": "Segment_2"})
    rig = Rig(strict, LiveScene({"id": A}, *segments), slice_s=0.0)
    rig.live.start()
    for _ in range(MAX_STEPS):
        if rig.live.preparing.done >= 3:  # the three nodes collected, none fitted yet
            break
        rig.live.tick()
    for segment in segments:
        rig.scene.segment(SEG, segment["segment"])["color"] = (0.1, 0.2, 0.3)
    if removed_first:
        rig.live.mark_held_segments(SEG, Change.APPEARANCE)
        rig.scene.remove(SEG)
        rig.live.mark_held_segments(SEG, Change.REMOVED)
    else:
        for segment in segments:
            rig.scene.segment(SEG, segment["segment"])["mesh"] = sphere(9)
        rig.live.mark_held_segments(SEG, Change.GEOMETRY)
        rig.live.mark_held_segments(SEG, Change.APPEARANCE)
    settle(rig)
    if removed_first:
        viewers = viewers_hold(rig.sent)
        assert A in viewers and not any(i.startswith(f"{SEG}/") for i in viewers), viewers
    else:
        # the first snapshot, then the re-export its geometry change needs
        assert node_counts(rig.sent) == [3, 3]


#: a scripted segment ID, aliased ``s_<n>``
SEG_X = "left lung"


def scene_with_a_segmentation():
    a = MrmlModel(A, name="Doe^John heart", polydata=sphere(12))
    b = MrmlModel(B, name="Doe^John liver", polydata=sphere(10))
    seg = MrmlSegmentation(
        SEG,
        segments=[
            FakeSegment("Segment_1", name="kidney", polydata=sphere(8)),
            FakeSegment(SEG_X, name="lung", polydata=sphere(9)),
        ],
    )
    return a, b, seg


def remove_or_hide(rig: PanelRig, what: str, b, seg) -> None:
    if what == "model removed":
        rig.scene.remove(b)
    elif what == "model hidden":
        b.displays[0].visible = 0
        b.InvokeEvent(EVENTS.display_modified)
    elif what == "segment removed":
        seg.remove_segment(SEG_X)
    elif what == "segment hidden":
        seg.displays[0].per_segment[SEG_X] = {"visible": 0}
        seg.InvokeEvent(EVENTS.display_modified)
    else:
        rig.scene.remove(seg)


@pytest.mark.parametrize("collected", [False, True], ids=["listed", "collected"])
@pytest.mark.parametrize(
    "what",
    ["model removed", "model hidden", "segment removed", "segment hidden", "segmentation removed"],
)
def test_panel_a_node_removed_or_hidden_while_preparing_is_not_shown_after_the_ack(
    fake, caplog, capfd, what, collected
):
    """Through the panel and the real observers: a node removed or hidden between two steps — before its own step,
    or after it — is not shown on the viewers once the snapshot is acknowledged and the marks made meanwhile have
    flushed; nothing is logged."""
    a, b, seg = scene_with_a_segmentation()
    rig = stepwise(a, b, seg)
    live = rig.ctl._live
    for _ in range(MAX_STEPS):
        if not collected or live.preparing.done >= live.preparing.total // 2:
            break
        rig.pump(0)
    else:
        raise AssertionError("still collecting")
    display = seg.displays[0]
    with caplog.at_level(logging.DEBUG):
        remove_or_hide(rig, what, b, seg)
        display.asked.clear()
        [begin] = until_begin(rig, 1)
        deliver(rig.ctl, Received(1, ack(begin["sceneVersion"])))
        for _ in range(3):
            rig.pump(1_000)
    target = {
        "model removed": [B],
        "model hidden": [B],
        "segment removed": [f"{SEG}/s_1"],
        "segment hidden": [f"{SEG}/s_1"],
        "segmentation removed": [f"{SEG}/Segment_1", f"{SEG}/s_1"],
    }[what]
    viewers = viewers_hold(sent_on(1))
    assert all(not viewers.get(node_id, False) for node_id in target), viewers
    assert viewers[A] is True
    if (
        what == "segment removed"
    ):  # no per-segment getter is asked about it: Slicer's would log its ID (T7)
        assert SEG_X not in display.asked
    assert leaks(caplog, capfd, "Doe", "lung", "kidney", "Traceback", CODE, TOKEN) == []
    assert "live:" not in caplog.text and "scene:" not in caplog.text
