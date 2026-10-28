"""SLC-17: the client's resume state machine (docs/protocol.md §4.3, §6.2, §6.3, §8.4, §9.2, §9.3, §13 steps 9-10).

Every client validates what it sends and receives against the strict schemas, except where a test pins the
stdlib-only checks Slicer runs (no ``jsonschema`` there). Snapshots are the shared asymmetric two-node GLB fixture.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from support import (
    CODE,
    OTHER_CODE,
    OTHER_SESSION_ID,
    OTHER_TOKEN,
    SESSION_ID,
    TOKEN,
    ack,
    created,
    leaks,
    live_client,
    relay_error,
    resumed,
    viewer_count,
)

from remoteview_core.protocol_client import (
    NodeChange,
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    make_client_info,
    resume_plan,
)
from remoteview_protocol import schemas

GLB = (
    Path(__file__).resolve().parents[2] / "shared/fixtures/glb/asymmetric-2nodes.glb"
).read_bytes()
A = "vtkMRMLModelNode4"


@pytest.fixture(scope="module")
def strict():
    compiled = schemas.compile_schemas()
    return lambda message: schemas.validate_message(message, None, compiled)


def snap(client: ProtocolClient) -> int:
    """Begin a snapshot; its ``sceneVersion``."""
    client.begin_snapshot(GLB, node_count=2, triangle_count=36)
    return client.snapshot_in_flight


def change(grey: float = 0.5) -> NodeChange:
    return NodeChange(A, color=(grey, 0.5, 0.25))


def acked(strict) -> ProtocolClient:
    """A live client whose snapshot v1 the relay acknowledged."""
    client = live_client(validate=strict)
    snap(client)
    assert client.handle(ack(1)) == []
    return client


def offline_resume(client: ProtocolClient, close_code: int | None = 1006) -> str:
    """The connection drops, a new one opens: the ID of the session.resume sent on it."""
    client.transport_lost(close_code)
    assert client.state is SessionState.GRACE
    return client.resume()["id"]


def versions(messages) -> list[tuple[str, int, int]]:
    return [(m["type"], m["sceneVersion"], m["baseVersion"]) for m in messages]


# --------------------------------------------------------------------------- session.resume


def test_resume_builds_the_schema_valid_message(strict):
    client = acked(strict)
    assert versions(client.send_changes([change(0.1)])) == [("scene.update", 2, 1)]
    assert versions(client.send_changes([change(0.2)])) == [("scene.update", 3, 2)]
    client.transport_lost(1006)
    message = client.resume()  # validated against session.resume.schema.json by the client itself
    assert strict(message) == []
    assert message["type"] == "session.resume"
    assert (message["sessionId"], message["publisherToken"]) == (SESSION_ID, TOKEN)
    assert message["clientInfo"] == client.client_info
    # the highest version sent, not the last acknowledged one (§4.3, §8.4)
    assert message["lastSceneVersion"] == 3 and client.accepted_version == 1
    assert client.state is SessionState.RESUMING


def test_resume_of_a_session_without_a_snapshot_sends_version_zero(strict):
    client = live_client(validate=strict)
    client.transport_lost()
    message = client.resume()
    assert message["lastSceneVersion"] == 0
    client.handle(resumed(message["id"], scene_version=0, snapshot_version=None))
    # nothing begun yet: the first snapshot is still owed
    assert client.state is SessionState.CREATED
    assert client.snapshot_needed and client.next_scene_version == 1


def _in_state(name: str, strict) -> ProtocolClient:
    if name == "IDLE":
        return ProtocolClient(make_client_info("5.12.4", "win32"), validate=strict)
    if name == "CONNECTING":
        client = ProtocolClient(make_client_info("5.12.4", "win32"), validate=strict)
        client.start("mobile")
        return client
    client = live_client(validate=strict)
    if name == "ACTIVE":
        snap(client)
    elif name == "RESUMING":
        offline_resume(client)
    elif name == "CLOSED":
        client.close()
    return client


@pytest.mark.parametrize("state", ["IDLE", "CONNECTING", "CREATED", "ACTIVE", "RESUMING", "CLOSED"])
def test_resume_only_from_grace(strict, state):
    client = _in_state(state, strict)
    before = client.state
    assert before is SessionState[state]
    with pytest.raises(ProtocolStateError) as error:
        client.resume()
    assert client.state is before
    assert TOKEN not in str(error.value) and CODE not in str(error.value)


# --------------------------------------------------------------------------- session.resumed: what is owed


def test_resume_resumed_null_snapshot_owes_a_snapshot(strict):
    """Criterion 1: the relay holds no snapshot → a snapshot is owed and updates are held until it begins."""
    client = live_client(validate=strict)
    snap(client)  # v1, its upload cut by the drop
    resume_id = offline_resume(client)
    assert client.handle(resumed(resume_id, scene_version=1, snapshot_version=None)) == []
    assert client.state is SessionState.ACTIVE
    assert client.snapshot_needed and client.updates_held
    assert client.send_changes([change()]) == []  # held
    assert client.next_scene_version == 2 and client.accepted_version == 0
    assert snap(client) == 2  # the owed snapshot drops the held change: its export has it
    assert not client.snapshot_needed
    assert client.handle(ack(2)) == [] and not client.updates_held


@pytest.mark.parametrize("reply", ["answering", "no-reply"])
def test_resume_up_to_date_needs_no_snapshot(strict, reply):
    """§13 step 10: the relay holds our snapshot and our last version → no re-upload (replyTo is optional, §3.2)."""
    client = acked(strict)
    assert versions(client.send_changes([change(0.1)])) == [("scene.update", 2, 1)]
    resume_id = offline_resume(client)
    assert client.snapshot_needed  # owed until the relay says otherwise
    reply_to = resume_id if reply == "answering" else None
    assert client.handle(resumed(reply_to, scene_version=2, snapshot_version=1)) == []
    assert not client.snapshot_needed and not client.updates_held
    assert versions(client.send_changes([change(0.2)])) == [("scene.update", 3, 2)]


@pytest.mark.parametrize("before", ["snapshot", "update-then-snapshot"])
def test_resume_snapshot_cut_mid_upload_is_owed_even_when_versions_match(strict, before):
    """The relay's sceneVersion may count a begin (the relay stub's does), so a snapshot cut by the drop can be
    answered with our last version all the same: it is owed, and the changes held behind it stay held."""
    client = acked(strict)
    if before == "update-then-snapshot":
        assert versions(client.send_changes([change(0.1)])) == [("scene.update", 2, 1)]
    cut = snap(client)
    assert client.send_changes([change(0.3)]) == []  # held behind the snapshot in flight
    resume_id = offline_resume(client)
    assert client.handle(resumed(resume_id, scene_version=cut, snapshot_version=1)) == []
    assert client.snapshot_needed and client.updates_held
    assert client.next_scene_version == cut + 1 and client.accepted_version == 1


def test_resume_lost_updates_owe_a_snapshot_and_never_reuse_versions(strict):
    client = acked(strict)
    client.send_changes([change(0.1)])  # v2
    client.send_changes([change(0.2)])  # v3, lost with the connection
    resume_id = offline_resume(client)
    assert client.handle(resumed(resume_id, scene_version=2, snapshot_version=1)) == []
    assert client.snapshot_needed
    assert client.send_changes([change(0.4)]) == []  # held: only a snapshot shows what was lost
    assert client.next_scene_version == 4  # above every version used (§6.2), not 3 (D4)


def test_resume_relay_claiming_a_higher_version_continues_from_it(strict):
    client = acked(strict)
    resume_id = offline_resume(client)
    client.handle(resumed(resume_id, scene_version=9, snapshot_version=1))
    assert client.next_scene_version == 10 and client.snapshot_needed  # §8.4


def test_resume_accepts_a_snapshot_whose_ack_was_lost(strict):
    """The relay holds the snapshot in flight at the drop: it is adopted, and the changes held behind it go out on
    top of it (§6.2)."""
    client = live_client(validate=strict)
    snap(client)  # v1
    assert client.send_changes([change(0.7)]) == []  # held behind v1
    resume_id = offline_resume(client)
    replies = client.handle(resumed(resume_id, scene_version=1, snapshot_version=1))
    assert client.snapshot_version == client.accepted_version == 1
    assert not client.snapshot_needed
    assert versions(replies) == [("scene.update", 2, 1)]
    assert replies[0]["changes"] == [{"nodeId": A, "color": [0.7, 0.5, 0.25]}]


def test_resume_first_snapshot_cut_before_the_relay_saw_it_is_owed(strict):
    client = live_client(validate=strict)
    snap(client)  # v1: the relay never saw its begin
    resume_id = offline_resume(client)
    client.handle(resumed(resume_id, scene_version=0, snapshot_version=None))
    assert client.snapshot_needed and client.next_scene_version == 2  # v1 is never used again


@pytest.mark.parametrize("when", ["before", "grace", "announce_added"])
def test_resume_keeps_a_need_from_before_or_during_the_drop(strict, when):
    """A need the drop did not cause survives an up-to-date resume (a reset, a re-sync, a scene.nodeAdded whose
    snapshot did not begin, §8.2)."""
    client = acked(strict)
    last = 1
    if when == "before":
        client.require_snapshot()
    elif when == "announce_added":
        assert client.announce_added([("vtkMRMLModelNode9", "model")])["sceneVersion"] == 2
        last = 2
    resume_id = offline_resume(client)
    if when == "grace":
        client.require_snapshot()  # e.g. Close Scene while offline (§7.3)
    assert client.handle(resumed(resume_id, scene_version=last, snapshot_version=1)) == []
    assert client.snapshot_needed and client.updates_held


def test_resume_two_drops_keep_the_lost_snapshot(strict):
    client = live_client(validate=strict)
    snap(client)  # v1
    offline_resume(client)
    resume_id = offline_resume(client)  # dropped again before the answer: nothing is in flight now
    client.handle(resumed(resume_id, scene_version=1, snapshot_version=1))
    assert client.accepted_version == 1 and not client.snapshot_needed


def test_resume_forgets_the_lost_snapshot_once_resumed(strict):
    """A snapshot adopted at one resume is not taken for one cut at the next: a later outage with nothing in flight
    and the relay up to date owes nothing."""
    client = live_client(validate=strict)
    snap(client)  # v1, its ack lost with the connection
    resume_id = offline_resume(client)
    client.handle(resumed(resume_id, scene_version=1, snapshot_version=1))  # adopted
    snap(client)  # v2
    client.handle(ack(2))
    resume_id = offline_resume(client)
    assert client.handle(resumed(resume_id, scene_version=2, snapshot_version=2)) == []
    assert not client.snapshot_needed and client.next_scene_version == 3


def test_resume_takes_viewer_count_and_ttl(strict):
    client = acked(strict)
    client.handle(viewer_count(2))
    platforms, limits = dict(client.platforms), dict(client.limits)
    resume_id = offline_resume(client)
    client.handle(
        resumed(resume_id, scene_version=1, snapshot_version=1, viewer_count=3, grace_s=60)
    )
    assert client.viewer_count == 3 and client.ttl["graceS"] == 60
    # session.resumed carries neither: the earlier ones are kept (report R1)
    assert client.platforms == platforms and client.limits == limits


# --------------------------------------------------------------------------- session.resumed: what is ignored


@pytest.mark.parametrize("field", ["sessionId", "code", "replyTo"])
def test_resume_resumed_for_another_session_code_or_reply_is_invalid(strict, field, caplog, capfd):
    """T11: an answer that is not ours changes nothing, and none of it is logged."""
    caplog.set_level(logging.DEBUG)
    client = acked(strict)
    resume_id = offline_resume(client)
    kwargs = {"scene_version": 1, "snapshot_version": 1}
    if field == "sessionId":
        kwargs["session_id"] = OTHER_SESSION_ID
    elif field == "code":
        kwargs["code"] = OTHER_CODE
    else:
        resume_id = "p-99"
    assert client.handle(resumed(resume_id, **kwargs)) == []
    assert client.invalid_inbound == 1 and client.last_invalid_type == "session.resumed"
    assert client.state is SessionState.RESUMING and client.snapshot_needed
    assert client.versions.last == 1
    assert leaks(caplog, capfd, CODE, TOKEN, SESSION_ID, OTHER_CODE, OTHER_SESSION_ID) == []


@pytest.mark.parametrize("state", ["CREATED", "ACTIVE", "GRACE"])
def test_resume_resumed_outside_resuming_is_ignored(strict, state):
    client = live_client(validate=strict)
    if state == "ACTIVE":
        snap(client)
    elif state == "GRACE":
        client.transport_lost()
    before = (client.state, client.versions.last, client.snapshot_needed)
    assert client.handle(resumed("p-1", scene_version=7, snapshot_version=None)) == []
    assert (client.state, client.versions.last, client.snapshot_needed) == before
    assert client.invalid_inbound == 0


MALFORMED = {
    "snapshot zero": {"snapshotVersion": 0},
    "snapshot bool": {"snapshotVersion": True},
    "snapshot text": {"snapshotVersion": "1"},
    "snapshot above scene": {"snapshotVersion": 3},
    "scene negative": {"sceneVersion": -1},
    "viewerCount bool": {"viewerCount": True},
    "no ttl": {"ttl": None},
    "bad code": {"code": "OOOOO"},
    "code int": {"code": 12345},
    "no code": {"code": ...},
    "no sessionId": {"sessionId": ...},
    "sessionId path": {"sessionId": "sess/../x"},
    "sessionId int": {"sessionId": 7},
    "scene bool": {"sceneVersion": True},
    "scene above uint32": {"sceneVersion": 2**32},
    "no sceneVersion": {"sceneVersion": ...},
    "no snapshotVersion": {"snapshotVersion": ...},
}


@pytest.mark.parametrize("state", ["RESUMING", "ACTIVE"])
@pytest.mark.parametrize("change_", list(MALFORMED.values()), ids=list(MALFORMED))
def test_resume_malformed_resumed_is_invalid(change_, state, caplog, capfd):
    """The stdlib checks Slicer runs (no jsonschema there) refuse every malformed answer, in any state, without raising
    (``handle`` never raises for relay input) and without logging it."""
    caplog.set_level(logging.DEBUG)
    client = ProtocolClient(make_client_info("5.12.4", "win32"), auto_renew=False)
    client.start("mobile")
    client.handle(created())
    snap(client)
    client.handle(ack(1))
    resume_id = offline_resume(client) if state == "RESUMING" else "p-1"
    message = resumed(resume_id, scene_version=2, snapshot_version=1)
    for key, value in change_.items():
        if value is None or value is ...:
            del message[key]
        else:
            message[key] = value
    assert client.handle(message) == []
    assert client.invalid_inbound == 1 and client.state is SessionState[state]
    assert leaks(caplog, capfd, CODE, TOKEN, SESSION_ID, "sess/../x") == []


# --------------------------------------------------------------------------- errors answering the resume


@pytest.mark.parametrize("reply", ["answering", "no-reply"])
def test_resume_session_not_found_closes_for_the_fallback(strict, reply):
    """Criterion 1 (§13 step 9): the relay no longer knows the session → closed; the caller falls back to
    session.create with the old code, and the new session's versions start at 1 (§8.4)."""
    client = acked(strict)
    client.send_changes([change(0.1)])  # v2
    resume_id = offline_resume(client, 4008)
    client.handle(relay_error("SESSION_NOT_FOUND", resume_id if reply == "answering" else None))
    assert client.state is SessionState.CLOSED and client.close_reason == "SESSION_NOT_FOUND"
    assert client.code is None and client.publisher_token() is None and not client.snapshot_needed
    create = client.start("mobile", CODE)
    assert strict(create) == [] and create["preferredCode"] == CODE
    assert client.versions.last == 0
    client.handle(
        created(create["id"], code=OTHER_CODE, session_id=OTHER_SESSION_ID, token=OTHER_TOKEN)
    )
    assert client.state is SessionState.CREATED and client.code == OTHER_CODE
    assert snap(client) == 1  # counter reset


@pytest.mark.parametrize("where", ["active", "foreign-reply"])
def test_resume_session_not_found_elsewhere_changes_nothing(strict, where):
    client = acked(strict)
    if where == "active":
        client.handle(relay_error("SESSION_NOT_FOUND"))
        assert client.state is SessionState.ACTIVE
    else:
        offline_resume(client)
        client.handle(relay_error("SESSION_NOT_FOUND", "p-99"))
        assert client.state is SessionState.RESUMING
    assert client.has_publisher_token


@pytest.mark.parametrize("how", ["error", "close-4003"])
def test_resume_unauthorized_closes_and_forgets_the_token(strict, how):
    client = acked(strict)
    resume_id = offline_resume(client)
    if how == "error":
        client.handle(relay_error("UNAUTHORIZED", resume_id))
    else:
        client.transport_lost(4003)
    assert client.state is SessionState.CLOSED and client.close_reason == "UNAUTHORIZED"
    assert client.publisher_token() is None and client.code is None


@pytest.mark.parametrize("code", ["RATE_LIMITED", "INTERNAL", "CAPACITY", "INVALID_MESSAGE"])
def test_resume_retryable_error_waits(strict, code):
    """Nothing to do but wait: the relay closes the socket (or the panel's answer deadline ends it), and the next
    connection resumes again."""
    client = acked(strict)
    resume_id = offline_resume(client)
    client.handle(relay_error(code, resume_id, retryable=True))
    assert client.state is SessionState.RESUMING and client.last_error.code == code
    client.transport_lost(1006)
    assert client.state is SessionState.GRACE and client.has_publisher_token
    assert client.resume()["type"] == "session.resume"


def test_resume_close_while_resuming_sends_session_close(strict):
    client = acked(strict)
    offline_resume(client)
    message = client.close()  # a socket is open: Stop closes the session at once (§4.5)
    assert message["type"] == "session.close" and message["reason"] == "USER_STOPPED"
    assert client.state is SessionState.CLOSED and client.publisher_token() is None


# --------------------------------------------------------------------------- the pure plan


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ((2, 1, None, 2, 1), (None, True, 2)),  # up to date (§13 step 10)
        ((1, None, 1, 1, 1), (1, True, 1)),  # the lost ack recovered
        ((1, None, 1, 1, None), (None, False, 1)),  # the lost snapshot not held
        ((2, 1, 2, 2, 1), (None, False, 2)),  # cut mid-upload although the versions match
        ((3, 1, 3, 3, 1), (None, False, 3)),  # the same after an update
        ((3, 1, None, 2, 1), (None, False, 3)),  # an update lost
        ((1, 1, None, 9, 1), (None, False, 9)),  # the relay is ahead: continue from it
        ((1, 1, None, 1, None), (None, False, 1)),  # the relay holds nothing
        ((0, None, None, 0, None), (None, False, 0)),  # no snapshot yet: one is owed anyway
        ((2, 1, 2, 2, 2), (2, True, 2)),  # the second snapshot's ack recovered
        ((2, 2, None, 2, 1), (None, False, 2)),  # the relay holds an older snapshot
        ((2, 1, None, 2, 2), (None, False, 2)),  # the relay claims one we never had acked: re-send
        (
            (2, 1, 2, 3, 3),
            (None, False, 3),
        ),  # the relay names a snapshot we never began: not adopted
    ],
)
def test_resume_plan_table(case, expected):
    """``(last, snapshot_version, lost, relay sceneVersion, relay snapshotVersion) → (adopted, consistent, at)``."""
    assert resume_plan(*case) == expected


# --------------------------------------------------------------------------- T4, T7


def test_resume_token_and_code_never_logged(strict, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    client = live_client(validate=strict)
    snap(client)
    client.send_changes([change(0.6)])  # held behind v1, released at the resume that adopts it
    resume_id = offline_resume(client)
    assert client.handle(resumed(resume_id, scene_version=1, snapshot_version=1))
    resume_id = offline_resume(client, 4008)
    client.handle(relay_error("SESSION_NOT_FOUND", resume_id))
    create = client.start("mobile", CODE)
    client.handle(
        created(create["id"], code=OTHER_CODE, session_id=OTHER_SESSION_ID, token=OTHER_TOKEN)
    )
    client.transport_lost()
    client.resume()
    # the code is an attribute (the panel shows it), never in repr
    for text in (repr(client), str(client)):
        assert CODE not in text and OTHER_CODE not in text
    for text in (repr(client), str(client), repr(vars(client)), str(vars(client))):
        assert TOKEN not in text and OTHER_TOKEN not in text
    needles = (CODE, TOKEN, SESSION_ID, OTHER_CODE, OTHER_SESSION_ID, OTHER_TOKEN, A)
    assert leaks(caplog, capfd, *needles) == []
    assert "session: resuming" in caplog.text and "session: resumed" in caplog.text
