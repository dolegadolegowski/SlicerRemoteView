"""SLC-06: publisher protocol core (docs/protocol.md §4, §6, §8.4, §9)."""

from __future__ import annotations

import json
import logging
import pickle
import re
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from remoteview_core import protocol_client
from remoteview_core.protocol_client import (
    DEFAULT_CHUNK_SIZE,
    ErrorInfo,
    ProtocolClient,
    ProtocolStateError,
    SceneVersionCounter,
    Secret,
    SessionState,
    build_session_create,
    build_snapshot_messages,
    glb_extensions,
    make_client_info,
)
from remoteview_core.vendored import chunk_header

# The vendored package is registered by remoteview_core.vendored; the tests (which have jsonschema) use its schema
# layer explicitly — the client itself never imports it (FR-16).
from remoteview_protocol import envelope, schemas

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "shared" / "fixtures"
ASYMMETRIC_GLB = (FIXTURES / "glb" / "asymmetric-2nodes.glb").read_bytes()
QUANTIZED_GLB = (FIXTURES / "glb" / "quantized-1node.glb").read_bytes()
TOKEN = "pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA"  # noqa: S105 — the protocol.md §4.2 example token
CODE = "7KQ4X"
SESSION_ID = "sess_01K7Q4XMB2TJ9RD6"


@pytest.fixture(scope="module")
def validators():
    return schemas.compile_schemas()


@pytest.fixture(scope="module")
def lenient():
    """Client-side validation: unknown enum values are tolerated (§14)."""
    compiled = schemas.compile_schemas(tolerate_unknown_enums=True)
    return lambda message: schemas.validate_message(message, None, compiled)


def _issues(message, validators) -> list:
    return schemas.validate_message(message, None, validators)


def _created(reply_to: str | None = "p-1", **limits) -> dict:
    return envelope.make(
        "session.created",
        reply_to=reply_to,
        sessionId=SESSION_ID,
        code=CODE,
        publisherToken=TOKEN,
        viewerLimit=20,
        ttl={"graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120},
        limits={
            "maxSnapshotBytes": 67_108_864,
            "maxChunkBytes": 1_048_576,
            "maxTextBytes": 262_144,
            "maxChanges": 1000,
            **limits,
        },
    )


def _error(code: str, message: str | None = None, **fields) -> dict:
    return envelope.make("error", code=code, message=message or f"{code} for test", **fields)


def _ack(version: int) -> dict:
    return envelope.make(
        "scene.snapshot.ack", sceneVersion=version, viewersStreamed=0, viewersDeferred=0
    )


def _glb_json(document) -> bytes:
    """A GLB container holding only a JSON chunk (for the extension checks)."""
    text = json.dumps(document).encode()
    text += b" " * (-len(text) % 4)
    return struct.pack("<IIIII", 0x46546C67, 2, 20 + len(text), len(text), 0x4E4F534A) + text


def _snapshot(client: ProtocolClient):
    return client.begin_snapshot(ASYMMETRIC_GLB, node_count=2, triangle_count=36)


@pytest.fixture
def client(lenient) -> ProtocolClient:
    return ProtocolClient(make_client_info("5.12.4", "win32"), validate=lenient)


@pytest.fixture
def live(client) -> ProtocolClient:
    client.start("mobile")
    client.handle(_created())
    return client


@pytest.fixture
def bare() -> ProtocolClient:
    """The Slicer runtime path: no validator (no jsonschema), session created."""
    client = ProtocolClient(make_client_info("5.12.4", "win32"))
    client.start("mobile")
    client.handle(_created())
    return client


# --------------------------------------------------------------------------- builders vs schemas (criterion 1)


def test_protocol_client_outbound_messages_validate(client, validators):
    sent = [client.start("quest3")]
    client.handle(_created())
    begin, chunks, end = _snapshot(client)  # SnapshotMessages unpacks like the plan's tuple
    sent += [begin, end, client.build_session_renew(), client.build_ping(), client.close()]
    assert [m["type"] for m in sent] == [
        "session.create",
        "scene.snapshot.begin",
        "scene.snapshot.end",
        "session.renew",
        "ping",
        "session.close",
    ]
    for message in sent:
        assert _issues(message, validators) == [], message["type"]
        json.loads(envelope.dumps(message))  # serialisable as one text frame
    ids = [m["id"] for m in sent]
    assert len(ids) == len(set(ids)) and all(len(i) <= 32 for i in ids)
    assert sent[0]["clientInfo"] == {
        "app": "SlicerRemoteView",
        "version": "0.1.0",
        "platform": "Slicer 5.12.4 / win32",
    }
    assert sent[0]["profile"] == "quest3" and sent[0]["preferredCode"] is None
    assert sent[-1]["reason"] == "USER_STOPPED"
    assert len(list(chunks)) == 1 and list(chunks) == []  # one-shot iterator


def test_protocol_client_session_create_with_preferred_code(validators):
    message = build_session_create(
        make_client_info("5.12.4", "darwin"), "mobile", CODE, message_id="p-9"
    )
    assert _issues(message, validators) == []
    assert message["preferredCode"] == CODE and message["id"] == "p-9"
    with pytest.raises(ValueError, match="preferredCode"):
        # "O" is not in the code alphabet
        build_session_create(make_client_info("5.12.4", "darwin"), "mobile", "7KQ4O")
    with pytest.raises(ValueError, match="profile"):
        build_session_create(make_client_info("5.12.4", "darwin"), "desktop")
    # "Slicer 5.12.4 / " is 16 characters: 48 more reach the 64-character limit exactly
    assert len(make_client_info("5.12.4", "x" * 48)["platform"]) == 64
    with pytest.raises(ValueError, match="platform"):
        make_client_info("5.12.4", "x" * 49)


def test_protocol_client_outbound_validation_catches_builder_bugs(lenient, monkeypatch):
    client = ProtocolClient(make_client_info("5.12.4", "win32"), validate=lenient)
    broken = lambda type_, message_id=None, **fields: {"type": type_, **fields}  # noqa: E731 — no protocolVersion
    monkeypatch.setattr(protocol_client, "envelope", broken)
    with pytest.raises(ValueError, match=r"outbound session\.create invalid"):
        client.start("mobile")
    assert client.state is SessionState.IDLE  # builders validate before changing state


def test_protocol_client_failed_start_keeps_the_previous_state(bare):
    bare.handle(envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"))
    with pytest.raises(ValueError, match="profile"):
        bare.start("desktop")
    assert bare.state is SessionState.CLOSED and bare.close_reason == "IDLE"


def test_protocol_client_envelope_matches_the_shared_builder():
    for type_, fields in (("ping", {}), ("session.close", {"reason": "USER_STOPPED"})):
        assert protocol_client.envelope(type_, "p-1", **fields) == envelope.make(
            type_, id="p-1", **fields
        )
    assert protocol_client.PROTOCOL_VERSION == envelope.PROTOCOL_VERSION


# --------------------------------------------------------------------------- chunking (criterion 2)


def _fixture_begin(name: str) -> dict:
    return json.loads((FIXTURES / "messages" / "scene.snapshot.begin" / name).read_text())


BEGIN_KEYS = (
    "byteLength",
    "sha256",
    "format",
    "extensionsUsed",
    "extensionsRequired",
    "profile",
    "nodeCount",
    "triangleCount",
)


@pytest.mark.parametrize("chunk_size", [1_048_576, 65_536])
def test_protocol_client_chunks_shared_glb_fixture_like_ts(chunk_size, validators):
    reference = _fixture_begin("valid-asymmetric-2nodes.json")  # written by the TS generator
    messages = build_snapshot_messages(
        ASYMMETRIC_GLB, 1, chunk_size=chunk_size, profile="mobile", node_count=2, triangle_count=36
    )
    begin = messages.begin
    for key in (*BEGIN_KEYS, "sceneVersion", "chunkCount"):
        assert begin[key] == reference[key], key
    assert begin["chunkSize"] == chunk_size
    frames = list(messages.chunks)
    assert len(frames) == begin["chunkCount"] == 1
    header = chunk_header.decode_chunk_header(frames[0])
    assert (header.scene_version, header.chunk_index) == (1, 0)
    assert bytes(header.payload) == ASYMMETRIC_GLB
    assert frames[0][:12] == (FIXTURES / "blob" / "chunk-header-v1-i0.bin").read_bytes()
    assert messages.end == envelope.make(
        "scene.snapshot.end", sceneVersion=1, sha256=reference["sha256"]
    )
    assert _issues(begin, validators) == [] and _issues(messages.end, validators) == []


@pytest.mark.parametrize(("chunk_size", "chunk_count"), [(1_048_576, 5), (65_536, 76)])
def test_protocol_client_chunks_the_large_ts_fixture(chunk_size, chunk_count):
    """Multi-chunk cross-language vector: the TS generator's large-synthetic.glb begin (5 chunks at 1 MiB)."""
    reference = _fixture_begin("valid-large-synthetic.json")
    glb = (FIXTURES / "glb" / "large-synthetic.glb").read_bytes()
    messages = build_snapshot_messages(
        glb,
        reference["sceneVersion"],
        chunk_size=chunk_size,
        profile="mobile",
        node_count=reference["nodeCount"],
        triangle_count=reference["triangleCount"],
    )
    for key in BEGIN_KEYS:
        assert messages.begin[key] == reference[key], key
    if chunk_size == reference["chunkSize"]:
        assert messages.begin["chunkCount"] == reference["chunkCount"]
    frames = [chunk_header.decode_chunk_header(f) for f in messages.chunks]
    assert len(frames) == messages.begin["chunkCount"] == chunk_count
    assert [(f.scene_version, f.chunk_index) for f in frames] == [
        (reference["sceneVersion"], i) for i in range(chunk_count)
    ]
    assert frames[-1].payload.nbytes == len(glb) - (chunk_count - 1) * chunk_size
    assert b"".join(bytes(f.payload) for f in frames) == glb


def test_protocol_client_multi_chunk_frames_pass_the_receiver_rules():
    """A 4-chunk snapshot (the §6.3 vector 196,609 B at 64 KiB) passes the vendored receiver checks and
    reassembles to the same bytes and SHA-256."""
    vectors = json.loads((FIXTURES / "blob" / "chunk-headers.json").read_text())["chunkify"]
    case = next(c for c in vectors if c["chunkSize"] == 65_536 and c["chunkCount"] == 4)
    glb = bytearray(ASYMMETRIC_GLB) + bytes(case["byteLength"] - len(ASYMMETRIC_GLB))
    glb[8:12] = len(glb).to_bytes(4, "little")  # GLB header length matches the padding
    messages = build_snapshot_messages(
        bytes(glb), 43, chunk_size=65_536, profile="mobile", node_count=2, triangle_count=36
    )
    assert messages.begin["chunkCount"] == case["chunkCount"]
    out = bytearray(messages.begin["byteLength"])
    for index, frame in enumerate(messages.chunks):
        chunk = chunk_header.decode_chunk_header(frame)
        expected = chunk_header.ExpectedChunk(43, len(glb), 65_536, case["chunkCount"], index)
        # raises BadSequenceError on any §6.3 violation
        offset = chunk_header.check_chunk(chunk, expected)
        out[offset : offset + chunk.payload.nbytes] = chunk.payload
    assert chunk.payload.nbytes == case["lastPayloadLength"]
    assert bytes(out) == bytes(glb)
    assert chunk_header.sha256_hex(out) == messages.begin["sha256"] == messages.end["sha256"]


def test_protocol_client_quantized_glb_announces_its_extensions():
    used, required = glb_extensions(QUANTIZED_GLB)
    assert used == required == ["KHR_mesh_quantization"]
    begin = build_snapshot_messages(
        QUANTIZED_GLB, 3, profile="mobile", node_count=1, triangle_count=128
    ).begin
    assert begin["extensionsUsed"] == begin["extensionsRequired"] == ["KHR_mesh_quantization"]


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"chunk_size": 65_535}, "chunkSize"),
        ({"chunk_size": 2_097_152}, "chunkSize"),
        ({"scene_version": 0}, "sceneVersion"),
        ({"scene_version": True}, "sceneVersion"),
        ({"profile": "desktop"}, "profile"),
        ({"node_count": -1}, "nodeCount"),
        ({"triangle_count": 1.5}, "triangleCount"),
        ({"glb": b""}, "snapshot"),
        ({"glb": b"glTF" + bytes(30)}, "glTF 2.0"),
        ({"glb": (FIXTURES / "glb" / "truncated.glb").read_bytes()}, "glTF 2.0"),
        ({"glb": _glb_json([])}, "glTF document"),
        ({"glb": b"glTF\x02\x00\x00\x00"}, "shorter than the header"),
        ({"glb": b"glTX" + _glb_json({})[4:]}, "glTF 2.0"),  # magic
        ({"glb": _glb_json({})[:4] + b"\x01" + _glb_json({})[5:]}, "glTF 2.0"),  # version 1
        ({"glb": _glb_json({})[:16] + b"BIN\x00" + _glb_json({})[20:]}, "glTF 2.0"),  # chunk type
        (  # JSON chunk length beyond the container
            {"glb": _glb_json({})[:12] + struct.pack("<I", 404) + _glb_json({})[16:]},
            "truncated",
        ),
        ({"glb": _glb_json({"extensionsUsed": "KHR_mesh_quantization"})}, "lists of strings"),
        ({"glb": _glb_json({"extensionsUsed": [5]})}, "lists of strings"),
        ({"glb": _glb_json({"extensionsUsed": ["KHR_materials_unlit"]})}, "extensions"),
        ({"glb": _glb_json({"extensionsUsed": ["KHR_mesh_quantization"] * 2})}, "extensions"),
        ({"glb": _glb_json({"extensionsRequired": ["KHR_mesh_quantization"]})}, "extensions"),
        (
            {
                "glb": _glb_json(
                    {
                        "extensionsUsed": ["KHR_mesh_quantization"],
                        "extensionsRequired": ["KHR_mesh_quantization"] * 2,
                    }
                )
            },
            "extensions",
        ),
    ],
)
def test_protocol_client_rejects_bad_snapshots(kwargs, match):
    args = {
        "glb": ASYMMETRIC_GLB,
        "scene_version": 1,
        "profile": "mobile",
        "chunk_size": DEFAULT_CHUNK_SIZE,
        "node_count": 0,
        "triangle_count": 0,
    }
    args.update(kwargs)
    with pytest.raises(ValueError, match=match):
        build_snapshot_messages(
            args["glb"],
            args["scene_version"],
            chunk_size=args["chunk_size"],
            profile=args["profile"],
            node_count=args["node_count"],
            triangle_count=args["triangle_count"],
        )


def test_protocol_client_enforces_relay_limits(client):
    client.start("mobile")
    client.handle(_created(maxSnapshotBytes=len(ASYMMETRIC_GLB) - 1))
    with pytest.raises(ValueError, match="maxSnapshotBytes"):
        _snapshot(client)
    assert client.versions.last == 0 and client.snapshot_in_flight is None
    client.limits["maxSnapshotBytes"] = len(ASYMMETRIC_GLB)  # exactly the limit is allowed
    assert _snapshot(client).begin["byteLength"] == len(ASYMMETRIC_GLB)


def test_protocol_client_chunk_size_follows_the_relay_limit(client):
    """§14: a relay may announce a lower maxChunkBytes; the default chunk size follows it."""
    client.start("mobile")
    client.handle(_created(maxChunkBytes=65_536))
    with pytest.raises(ValueError, match="maxChunkBytes"):
        client.begin_snapshot(ASYMMETRIC_GLB, node_count=2, triangle_count=36, chunk_size=1_048_576)
    assert client.versions.last == 0
    assert _snapshot(client).begin["chunkSize"] == 65_536


# --------------------------------------------------------------------------- state machine (criterion 3)


def test_protocol_client_happy_path_states(client):
    assert client.state is SessionState.IDLE
    create = client.start("mobile")
    assert client.state is SessionState.CONNECTING
    assert client.handle(_created(reply_to=create["id"])) == []
    assert client.state is SessionState.CREATED
    assert client.code == CODE and client.session_id == SESSION_ID and client.has_publisher_token
    assert client.ttl == _created()["ttl"] and client.limits == _created()["limits"]
    assert client.viewer_limit == 20
    snapshot = _snapshot(client)
    assert client.state is SessionState.ACTIVE and client.snapshot_in_flight == 1
    client.handle(_ack(1))
    assert client.snapshot_in_flight is None
    assert client.snapshot_version == client.accepted_version == 1
    assert snapshot.begin["sceneVersion"] == 1
    count = envelope.make(
        "viewer.count", viewerCount=3, viewerLimit=15, platforms={"web": 2, "quest3": 1}
    )
    assert client.handle(count) == []
    assert client.viewer_count == 3 and client.platforms == {"web": 2, "quest3": 1}
    assert client.viewer_limit == 15
    close = client.close()
    assert close["reason"] == "USER_STOPPED" and client.state is SessionState.CLOSED
    assert not client.has_publisher_token and client.close() is None
    assert client.code is None  # an ended session's code is not shown or reused (T1)


def test_protocol_client_restart_starts_a_fresh_session(live):
    _snapshot(live)
    live.handle(envelope.make("viewer.count", viewerCount=2, viewerLimit=20, platforms={"web": 2}))
    live.handle(_error("INTERNAL", retryable=True))
    live.close()
    create = live.start("quest2")
    fresh = ProtocolClient(make_client_info("5.12.4", "win32"))
    for attribute in (
        "session_id",
        "code",
        "viewer_limit",
        "viewer_count",
        "platforms",
        "ttl",
        "limits",
        "close_reason",
        "last_error",
        "invalid_inbound",
        "last_invalid_type",
        "snapshot_in_flight",
        "snapshot_version",
        "accepted_version",
    ):
        assert getattr(live, attribute) == getattr(fresh, attribute), attribute
    assert live.versions.last == 0 and live.profile == "quest2" and not live.has_publisher_token
    assert fresh.profile is None and fresh.state is SessionState.IDLE
    live.handle(_created(reply_to=create["id"]))
    assert _snapshot(live).begin["sceneVersion"] == 1  # §8.4: a new session restarts at 1


@pytest.mark.parametrize(
    ("start", "message", "end", "error"),
    [
        (
            "active",
            _error("PAYLOAD_TOO_LARGE", retryable=False),
            SessionState.ACTIVE,
            "PAYLOAD_TOO_LARGE",
        ),
        ("active", _error("CAPACITY", retryable=True), SessionState.ACTIVE, "CAPACITY"),
        ("active", _error("BAD_SEQUENCE", retryable=True), SessionState.ACTIVE, "BAD_SEQUENCE"),
        (
            "active",
            _error("CHECKSUM_MISMATCH", retryable=True),
            SessionState.ACTIVE,
            "CHECKSUM_MISMATCH",
        ),
        ("active", _error("INTERNAL", retryable=True), SessionState.ACTIVE, "INTERNAL"),
        ("active", _error("UNAUTHORIZED", retryable=False), SessionState.CLOSED, "UNAUTHORIZED"),
        (
            "active",
            _error("SESSION_CLOSED", retryable=False),
            SessionState.CLOSED,
            "SESSION_CLOSED",
        ),
        (
            "created",
            _error("UNSUPPORTED_VERSION", retryable=False),
            SessionState.CLOSED,
            "UNSUPPORTED_VERSION",
        ),
        (
            "active",
            envelope.make("session.closed", sessionId=SESSION_ID, reason="PUBLISHER_CLOSED"),
            SessionState.CLOSED,
            None,
        ),
        (
            "active",
            envelope.make("session.expired", sessionId=SESSION_ID, reason="MAX_LIFETIME"),
            SessionState.CLOSED,
            None,
        ),
        (
            "created",
            envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"),
            SessionState.CLOSED,
            None,
        ),
        ("connecting", _error("CAPACITY", retryable=True), SessionState.CLOSED, "CAPACITY"),
        (
            "connecting",
            _error("RATE_LIMITED", retryable=True, details={"retryAfterS": 30}, replyTo="p-1"),
            SessionState.CLOSED,
            "RATE_LIMITED",
        ),
        ("created", envelope.make("pong", replyTo="hb-1", serverTs=1), SessionState.CREATED, None),
        ("active", _ack(99), SessionState.ACTIVE, None),
        ("idle", _created(), SessionState.IDLE, None),
    ],
)
def test_protocol_client_state_table(client, start, message, end, error):
    if start != "idle":
        client.start("mobile")
    if start in ("created", "active"):
        client.handle(_created())
    if start == "active":
        _snapshot(client)
    assert client.handle(message) == []
    assert client.state is end
    assert (client.last_error.code if client.last_error else None) == error
    if error is not None:
        assert client.last_error.retryable is message["retryable"]
        assert client.last_error.details == message.get("details", {})
    if end is SessionState.CLOSED:
        assert not client.has_publisher_token and client.snapshot_in_flight is None
        assert client.close_reason == (error or message["reason"])
    elif start == "active":
        # a snapshot rejection (no replyTo: chunk-level) drops the in-flight snapshot; anything else keeps it
        dropped = error in ("PAYLOAD_TOO_LARGE", "CAPACITY", "BAD_SEQUENCE", "CHECKSUM_MISMATCH")
        assert client.snapshot_in_flight == (None if dropped else 1)
        assert client.snapshot_version is None


def test_protocol_client_errors_affect_only_the_snapshot_they_answer(live):
    """§3.2 replyTo: an error answering another message leaves the in-flight snapshot (and its ack) alone."""
    _snapshot(live)
    # e.g. an error answering a scene.update (SLC-16)
    live.handle(_error("BAD_SEQUENCE", retryable=True, replyTo="p-99"))
    assert live.snapshot_in_flight == 1
    live.handle(_ack(1))
    assert live.snapshot_version == live.accepted_version == 1
    superseded = _snapshot(live)
    _snapshot(live)  # v3 supersedes v2 (§6.2)
    live.handle(_error("CAPACITY", retryable=True, replyTo=superseded.begin["id"]))
    assert live.snapshot_in_flight == 3
    live.handle(_ack(3))
    assert live.accepted_version == 3
    for answered in ("begin", "end"):
        snapshot = _snapshot(live)
        live.handle(
            _error("CHECKSUM_MISMATCH", retryable=True, replyTo=getattr(snapshot, answered)["id"])
        )
        assert live.snapshot_in_flight is None, answered
    # any error answering this begin drops it (INVALID_MESSAGE is the answer to a bad begin, §6.2) …
    snapshot = _snapshot(live)
    live.handle(_error("INVALID_MESSAGE", replyTo=snapshot.begin["id"]))
    assert live.snapshot_in_flight is None
    # … but an error of that kind answering another message does not
    _snapshot(live)
    live.handle(_error("INVALID_MESSAGE", replyTo="p-99"))
    assert live.snapshot_in_flight == live.versions.last


def test_protocol_client_messages_after_the_session_change_nothing(live):
    """An error or count crossing our session.close (or arriving before Start) leaves the outcome alone."""
    ping = live.build_ping()
    live.close()
    assert not live.ping_outstanding
    live.handle(_error("SESSION_CLOSED", retryable=False, replyTo=ping["id"]))
    live.handle(envelope.make("session.closed", sessionId=SESSION_ID, reason="PUBLISHER_CLOSED"))
    live.handle(envelope.make("viewer.count", viewerCount=4, viewerLimit=20, platforms={}))
    assert live.close_reason == "USER_STOPPED" and live.last_error is None
    assert live.viewer_count == 0
    connecting = ProtocolClient(make_client_info("5.12.4", "win32"))
    connecting.start("mobile")  # nothing to renew before session.created
    assert connecting.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1)) == []
    connecting.handle(envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"))
    assert connecting.state is SessionState.CONNECTING  # not this session's id (none yet)
    assert connecting.build_ping()["type"] == "ping"  # the heartbeat runs while connecting too
    idle = ProtocolClient(make_client_info("5.12.4", "win32"))
    idle.handle(_error("UNAUTHORIZED", retryable=False))
    assert idle.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1)) == []
    assert idle.state is SessionState.IDLE and idle.last_error is None


def test_protocol_client_second_session_created_is_ignored(live):
    _snapshot(live)
    other = {**_created(reply_to=None), "code": "9ABCD", "publisherToken": "q" * 43}
    assert live.handle(other) == []
    assert live.code == CODE and live.publisher_token().reveal() == TOKEN
    assert live.state is SessionState.ACTIVE and live.snapshot_in_flight == 1


def test_protocol_client_rejected_snapshot_uses_no_version(live, monkeypatch):
    """Builders validate before they change state: a refused snapshot does not consume a sceneVersion."""
    with pytest.raises(ValueError, match="nodeCount"):
        live.begin_snapshot(ASYMMETRIC_GLB, node_count=-1, triangle_count=0)
    with pytest.raises(ValueError, match="chunkSize"):
        live.begin_snapshot(ASYMMETRIC_GLB, node_count=0, triangle_count=0, chunk_size=1000)
    calls = []
    monkeypatch.setattr(live, "_validate", lambda m: calls.append(m["type"]) or ["rejected"])
    with pytest.raises(ValueError, match=r"outbound scene\.snapshot\.begin invalid"):
        _snapshot(live)
    monkeypatch.setattr(
        live, "_validate", lambda m: ["rejected"] if m["type"] == "scene.snapshot.end" else []
    )
    with pytest.raises(ValueError, match=r"outbound scene\.snapshot\.end invalid"):
        _snapshot(live)
    assert calls == ["scene.snapshot.begin"]
    assert live.versions.last == 0 and live.state is SessionState.CREATED
    assert live.snapshot_in_flight is None


def test_protocol_client_versions_never_reused_after_rejection(live):
    first = _snapshot(live)
    live.handle(_error("PAYLOAD_TOO_LARGE", retryable=False, replyTo=first.begin["id"]))
    second = _snapshot(live)
    assert (first.begin["sceneVersion"], second.begin["sceneVersion"]) == (1, 2)
    assert live.snapshot_in_flight == 2 and live.accepted_version == 0
    live.handle(_ack(1))  # stale
    assert live.snapshot_in_flight == 2


def test_protocol_client_expiring_auto_renews(live, validators):
    replies = live.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000))
    assert [m["type"] for m in replies] == ["session.renew"]
    assert _issues(replies[0], validators) == []
    renewed = envelope.make(
        "session.renewed",
        replyTo=replies[0]["id"],
        ttl={"graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792290000000},
    )
    assert live.handle(renewed) == []
    assert live.ttl["expiresAt"] == 1792290000000
    live.auto_renew = False
    expiring = envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000)
    assert live.handle(expiring) == []
    live.auto_renew = True
    live.transport_lost()
    assert live.handle(expiring) == []
    with pytest.raises(ProtocolStateError):
        live.build_session_renew()  # no socket in grace


def test_protocol_client_renew_records_when_the_idle_session_closes(live):
    """SLC-47: ``closesAt`` is kept until ``session.renewed`` or a viewer (the idle timer stops, §4.4)."""
    live.auto_renew = False
    assert live.closes_at is None
    live.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000))
    assert live.closes_at == 1792240260000
    live.handle(envelope.make("viewer.count", viewerCount=0, viewerLimit=20, platforms={}))
    assert live.closes_at == 1792240260000
    live.handle(envelope.make("viewer.count", viewerCount=1, viewerLimit=20, platforms={"web": 1}))
    assert live.closes_at is None
    live.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1792240320000))
    renew = live.build_session_renew()
    ttl = {"graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792290000000}
    live.handle(envelope.make("session.renewed", replyTo=renew["id"], ttl=ttl))
    assert live.closes_at is None
    live.handle(envelope.make("session.expiring", reason="IDLE", closesAt=1792240380000))
    live.close()
    live.start("mobile")  # a new session: nothing of the old one's expiry
    assert live.closes_at is None


@pytest.mark.parametrize(
    "fields",
    [
        {"closesAt": "soon"},
        {"closesAt": -1},
        {"closesAt": 1.5},
        {"closesAt": None},
        {"reason": "idle"},
        {},
    ],
)
def test_protocol_client_renew_ignores_an_invalid_expiring(bare, fields):
    """Without a validator (Slicer) the stdlib checks refuse it: no renew, nothing recorded."""
    message = envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000)
    message.update(fields)
    if not fields:
        del message["closesAt"]
    assert bare.handle(message) == []
    assert bare.closes_at is None and bare.invalid_inbound == 1
    assert bare.last_invalid_type == "session.expiring"


def test_protocol_client_renew_asks_a_callable_at_each_live_expiring(live):
    answers = [True, False]
    asked = []
    live.auto_renew = lambda: asked.append(live.state) or answers.pop(0)
    expiring = envelope.make("session.expiring", reason="IDLE", closesAt=1792240260000)
    assert [m["type"] for m in live.handle(expiring)] == ["session.renew"]
    assert live.handle(expiring) == []
    live.transport_lost()
    assert live.handle(expiring) == []  # in grace nothing can be sent: not asked
    assert asked == [SessionState.CREATED, SessionState.CREATED]


def test_protocol_client_ping_pong(live):
    ping = live.build_ping()
    assert live.ping_outstanding
    live.handle(envelope.make("pong", replyTo="hb-unrelated", serverTs=1))
    assert live.ping_outstanding
    live.handle(envelope.make("pong", replyTo=ping["id"], serverTs=1))
    assert not live.ping_outstanding
    live.build_ping()
    live.transport_lost()
    assert not live.ping_outstanding
    with pytest.raises(ProtocolStateError):
        live.build_ping()
    idle = ProtocolClient(make_client_info("5.12.4", "win32"))
    with pytest.raises(ProtocolStateError):
        idle.build_ping()  # nothing leaves the PC before Start (FR-02)


def test_protocol_client_transport_lost_enters_grace(live):
    _snapshot(live)
    live.transport_lost()
    assert live.state is SessionState.GRACE
    assert live.snapshot_in_flight is None and live.has_publisher_token
    with pytest.raises(ProtocolStateError):
        _snapshot(live)
    assert live.close() is None  # no socket in grace: the relay expires the session (§9.1)
    assert live.state is SessionState.CLOSED and not live.has_publisher_token
    assert live.close_reason == "USER_STOPPED"
    connecting = ProtocolClient(make_client_info("5.12.4", "linux"))
    connecting.start("mobile")
    connecting.transport_lost()
    assert connecting.state is SessionState.CLOSED and connecting.close_reason == "CONNECT_FAILED"


@pytest.mark.parametrize(
    ("close_code", "state", "reason"),
    [
        (None, SessionState.GRACE, None),
        (1006, SessionState.GRACE, None),  # abnormal drop: resume within grace (SLC-17)
        (4008, SessionState.GRACE, None),  # relay restarting: resume (§9.3)
        (1008, SessionState.CLOSED, "POLICY_VIOLATION"),
        (4000, SessionState.CLOSED, "UNSUPPORTED_VERSION"),
        (4001, SessionState.CLOSED, "SESSION_CLOSED"),
        (4002, SessionState.CLOSED, "SESSION_EXPIRED"),
        (4003, SessionState.CLOSED, "UNAUTHORIZED"),  # forget the token (§9.3)
        (4011, SessionState.CLOSED, "REPLACED"),  # another connection took over: never resume
    ],
)
def test_protocol_client_terminal_close_codes(bare, close_code, state, reason):
    bare.transport_lost(close_code)
    assert bare.state is state and bare.close_reason == reason
    assert bare.has_publisher_token is (state is SessionState.GRACE)
    bare.transport_lost(4011)  # a later close code never rewrites how the session ended
    if state is SessionState.CLOSED:
        assert bare.close_reason == reason
    idle = ProtocolClient(make_client_info("5.12.4", "win32"))
    idle.transport_lost(close_code)
    assert idle.state is SessionState.IDLE and idle.close_reason is None


def test_protocol_client_illegal_transitions_raise(client):
    with pytest.raises(ProtocolStateError):
        _snapshot(client)
    with pytest.raises(ProtocolStateError):
        client.build_session_renew()
    client.start("mobile")
    with pytest.raises(ProtocolStateError):
        client.start("mobile")
    with pytest.raises(ProtocolStateError):
        _snapshot(client)  # no session.created yet
    close = client.close()  # Stop while connecting still tells the relay
    assert close["type"] == "session.close" and client.state is SessionState.CLOSED


def test_protocol_client_ignores_invalid_and_unknown_inbound(live):
    assert live.handle({"protocolVersion": "1.0", "type": "viewer.count", "viewerCount": -1}) == []
    assert live.viewer_count == 0 and live.invalid_inbound == 1
    assert live.last_invalid_type == "viewer.count" and live.last_error is None
    # v1.1-reserved / unknown types are ignored without counting them as invalid
    assert live.handle(envelope.make("scene.camera", pose=[0] * 16)) == []
    assert live.invalid_inbound == 1
    # a second session.created does not replace the session
    assert live.handle(_created(reply_to=None)) == []
    assert live.state is SessionState.CREATED and live.invalid_inbound == 1


def test_protocol_client_invalid_inbound_keeps_the_relay_error(live):
    """The panel shows the relay's last error (SLC-18), not the local bookkeeping of ignored messages."""
    live.handle(_error("CAPACITY", retryable=True))
    live.handle({"protocolVersion": "1.0", "type": "viewer.count"})
    assert live.last_error.code == "CAPACITY" and live.invalid_inbound == 1


def test_protocol_client_injected_validator_checks_inbound():
    rejected = []

    def validate(message):
        if message["type"] == "viewer.count":
            rejected.append(message)
            return ["rejected by the schema"]
        return []

    client = ProtocolClient(make_client_info("5.12.4", "win32"), validate=validate)
    client.start("mobile")
    client.handle(_created())
    client.handle(envelope.make("viewer.count", viewerCount=1, viewerLimit=20, platforms={}))
    assert rejected and client.viewer_count == 0 and client.invalid_inbound == 1


def test_protocol_client_tolerates_unknown_enum_values(live):
    live.handle(
        envelope.make("viewer.count", viewerCount=1, viewerLimit=20, platforms={"holo-lens": 1})
    )
    assert live.platforms == {"other": 1}  # unknown platform → other (§14)
    # viewer-chosen platform strings never reach the panel: only the §5.1 names are kept
    many = {
        "web": 3,
        "quest-browser": 2,
        "quest2": 1,
        "quest3": 4,
        "other": 1,
        "holo-lens": 1,
        "join-at.evil.example": 1,
        "jan.kowalski-pesel-8001": 1,
        "<a href='x'>web</a>": 1,
        "Web": 1,
        "x" * 64: 1,
        "web\u202e": 1,
    } | {f"p{i}": 1 for i in range(10)}
    live.handle(envelope.make("viewer.count", viewerCount=20, viewerLimit=20, platforms=many))
    assert live.viewer_count == 20
    assert live.platforms == {"web": 3, "quest-browser": 2, "quest2": 1, "quest3": 4, "other": 18}
    live.handle(envelope.make("session.expired", sessionId=SESSION_ID, reason="SOMETHING_NEW"))
    assert live.state is SessionState.CLOSED and live.close_reason == "SOMETHING_NEW"


def test_protocol_client_correlates_session_ids_and_replies(live, bare):
    """T11: an end-of-session for another session never closes this one; replies are matched by replyTo."""
    for client in (live, bare):
        other = envelope.make("session.expired", sessionId="sess_OTHER", reason="IDLE")
        client.handle(other)
        assert client.state is SessionState.CREATED and client.has_publisher_token
        assert client.last_invalid_type == "session.expired"
    connecting = ProtocolClient(make_client_info("5.12.4", "win32"))
    connecting.start("mobile")
    connecting.handle(_created(reply_to="p-77"))  # answers another create
    assert connecting.state is SessionState.CONNECTING and connecting.invalid_inbound == 1
    connecting.handle(_error("INVALID_MESSAGE", replyTo="hb-5"))  # answers a ping, not the create
    assert connecting.state is SessionState.CONNECTING
    connecting.handle(_created(reply_to=None))  # replyTo is optional
    assert connecting.state is SessionState.CREATED


def test_protocol_client_recognises_the_end_of_its_own_session_only(live):
    """``ends_session`` applies the inbound checks and T11, also after the client closed (the panel's Stop)."""
    mine = envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE")
    closed = envelope.make("session.closed", sessionId=SESSION_ID, reason="PUBLISHER_CLOSED")
    live.close()
    assert live.ends_session(mine) and live.ends_session(closed)
    for message in (
        envelope.make("session.expired", sessionId="sess_OTHER", reason="IDLE"),  # T11
        {"type": "session.expired", "sessionId": SESSION_ID, "reason": "IDLE"},  # no envelope
        {**mine, "protocolVersion": "2.0"},
        {**mine, "reason": "not an enum value"},
        {**mine, "type": "session.publisherState"},
        {**mine, "type": []},  # relay input: never raises
        {**mine, "type": {}},
        envelope.make("error", code="SESSION_CLOSED", message="relay text"),
        b"session.expired",
    ):
        assert not live.ends_session(message)
    fresh = ProtocolClient(make_client_info("5.12.4", "win32"))
    assert not fresh.ends_session(mine)  # no session yet
    # nothing changed
    assert live.state is SessionState.CLOSED and live.close_reason == "USER_STOPPED"


# --------------------------------------------------------------------------- secrets (T4, NFR-17)


def test_protocol_client_token_and_code_never_leak(live, caplog):
    caplog.set_level(logging.DEBUG)
    live.handle(_error("PAYLOAD_TOO_LARGE", retryable=False))
    live.handle(envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"))
    other = ProtocolClient(make_client_info("5.12.4", "win32"))
    other.start("mobile")
    other.handle(_created())
    other.handle({"protocolVersion": "1.0", "type": "viewer.count"})  # logged as ignored
    other.handle(_error("INTERNAL", message="relay text\nFAKE-LOG-MARKER " + CODE))  # never logged
    secret = other.publisher_token()
    # The code is shown in the panel (an attribute) but never in repr/str or logs (CLAUDE.md rule 6, T6).
    for text in (repr(other), str(other), caplog.text):
        assert TOKEN not in text and CODE not in text and SESSION_ID not in text
    assert "FAKE-LOG-MARKER" not in caplog.text
    assert [r.getMessage() for r in caplog.records] == [
        "relay error PAYLOAD_TOO_LARGE",
        "session: closed (IDLE)",
        "session: connecting",
        "session: created",
        "ignored an invalid inbound viewer.count",
        "relay error INTERNAL",
    ]
    for text in (repr(secret), str(secret), f"{secret}", repr(vars(other)), str(vars(other))):
        assert TOKEN not in text
    assert other.publisher_token().reveal() == TOKEN
    with pytest.raises(TypeError):
        pickle.dumps(other.publisher_token())


def test_protocol_client_error_repr_hides_relay_text():
    info = ErrorInfo("INTERNAL", "free text\nwith 7KQ4X", True, "p-1", {"field": "x" * 50})
    assert repr(info) == "ErrorInfo(code='INTERNAL', retryable=True, reply_to='p-1')"


def test_protocol_client_secret_redaction():
    secret = Secret("pt_" + "x" * 40)
    assert "x" * 40 not in repr(secret) + str(secret) + f"{secret!s}{secret!r}{secret}"


def test_scene_version_counter():
    counter = SceneVersionCounter()
    assert counter.last == 0
    assert [counter.allocate() for _ in range(3)] == [1, 2, 3]
    counter.continue_from(42)
    assert counter.allocate() == 43
    counter.reset()
    assert counter.allocate() == 1
    counter.continue_from(0xFFFF_FFFF)
    with pytest.raises(OverflowError):
        counter.allocate()
    for bad in (-1, 2**32, True, 1.5):
        with pytest.raises(ValueError):
            counter.continue_from(bad)


# --------------------------------------------------------------------------- runtime path without jsonschema


@pytest.mark.parametrize(
    "bad",
    [
        {"code": "0OOOO"},  # outside the alphabet
        {"code": "7KQ4X\n"},
        {"code": 12345},
        {"publisherToken": "p" * 43 + "\n"},
        {"sessionId": "sess_1\n"},
        {"code": "7KQ4"},
        {"publisherToken": "short"},
        {"publisherToken": "x" * 42 + "!"},
        {"sessionId": "sess/../x"},
        {"viewerLimit": 21},
        {"viewerLimit": True},
        {"ttl": {"graceS": 120}},
        {"ttl": {"graceS": -1, "idleS": 1, "maxLifetimeS": 1, "expiresAt": 1}},
        *(
            {"ttl": {**_created()["ttl"], **change}}
            for key in ("graceS", "idleS", "maxLifetimeS", "expiresAt")
            for change in ({key: -1}, {key: True}, {key: "1"})
        ),
        *(
            {"ttl": {k: v for k, v in _created()["ttl"].items() if k != key}}
            for key in ("graceS", "idleS", "maxLifetimeS", "expiresAt")
        ),
        {
            "limits": {
                "maxSnapshotBytes": 2**40,
                "maxChunkBytes": 1_048_576,
                "maxTextBytes": 1,
                "maxChanges": 1,
            }
        },
        {  # a chunk limit below 64 KiB would make every snapshot impossible
            "limits": {
                "maxSnapshotBytes": 1,
                "maxChunkBytes": 1000,
                "maxTextBytes": 1,
                "maxChanges": 1,
            }
        },
        {"limits": None},
        {"publisherToken": "p" * 257},
        {"publisherToken": "p" * 42},
        {"sessionId": "s" * 65},
        *(
            {"limits": {**_created()["limits"], key: value}}
            for key, value in (
                ("maxTextBytes", 262_145),
                ("maxTextBytes", 0),
                ("maxChanges", 1001),
                ("maxChanges", 0),
                ("maxSnapshotBytes", 0),
                ("maxChunkBytes", 1_048_577),
            )
        ),
    ],
)
def test_protocol_client_manual_checks_reject_bad_session_created(bad):
    """In Slicer there is no jsonschema (FR-16): the handler's own checks still refuse malformed credentials."""
    client = ProtocolClient(make_client_info("5.12.4", "win32"))  # no validator, like Slicer
    client.start("mobile")
    client.handle({**_created(), **bad})
    assert client.state is SessionState.CONNECTING and not client.has_publisher_token
    assert client.invalid_inbound == 1 and client.last_invalid_type == "session.created"


def _msg(type_: str, **fields) -> dict:
    return {"protocolVersion": "1.0", "type": type_, **fields}


@pytest.mark.parametrize(
    "message",
    [
        _msg("viewer.count", viewerCount=-1, viewerLimit=20, platforms={}),
        _msg("viewer.count", viewerCount=True, viewerLimit=20, platforms={}),
        _msg("viewer.count", viewerCount=1, viewerLimit=20, platforms={"web": True}),
        _msg("viewer.count", viewerCount=1, viewerLimit=20, platforms={"web": -1}),
        _msg("scene.snapshot.ack", sceneVersion="1"),
        _msg("error", code="", message="x"),
        _msg("error", code="INTERNAL\nFAKE LOG LINE", message="x"),
        _msg("error", code="INTERNAL", message="x", details=[]),
        _msg("error", code="INTERNAL", message="x", retryable=1),
        _msg("error", code="INTERNAL", message="x", details={"publisherToken": TOKEN}),
        _msg("error", code="INTERNAL", message="x", details={"code": CODE}),
        _msg("session.renewed", ttl=None),
        *(
            _msg("session.renewed", ttl={**_created()["ttl"], key: -1})
            for key in ("graceS", "idleS", "maxLifetimeS", "expiresAt")
        ),
        *(
            _msg("session.renewed", ttl={k: v for k, v in _created()["ttl"].items() if k != key})
            for key in ("graceS", "idleS", "maxLifetimeS", "expiresAt")
        ),
        _msg(
            "session.renewed", ttl={"graceS": True, "idleS": 1, "maxLifetimeS": 1, "expiresAt": 1}
        ),
        _msg("session.renewed", ttl={"graceS": -5, "idleS": 1, "maxLifetimeS": 1, "expiresAt": 1}),
        _msg("session.expired", sessionId=SESSION_ID, reason="IDLE\nFAKE LOG LINE"),
        _msg("session.expired", sessionId=SESSION_ID, reason="idle"),
        _msg("session.expired", sessionId=SESSION_ID, reason=5),
        _msg("session.expired", sessionId=SESSION_ID, reason=None),
        _msg("session.expired", sessionId=SESSION_ID),
        _msg("session.expired", reason="IDLE"),
        _msg("session.closed", sessionId=SESSION_ID, reason="PUBLISHER_CLOSED\r\nX"),
        _msg("pong", replyTo=5),
        _msg("pong", replyTo="x" * 33),
        _msg("error", code="INTERNAL"),
        _msg("error", code="INTERNAL", message="x" * 1025),
        _msg("error", code="INTERNAL", message=""),
        _msg("error", code="A" * 65, message="x"),
        _msg("error", code="INTERNAL", message="x", details={"token": TOKEN}),
        _msg("error", code="INTERNAL", message="x", details={"viewerToken": "vt_" + "a" * 43}),
        _msg("session.expired", sessionId=SESSION_ID, reason="A" * 65),
        _msg("session.expired", sessionId=SESSION_ID, reason="iDLE"),
        _msg("session.expired", sessionId="s" * 65, reason="IDLE"),
        _msg("viewer.count", viewerCount=1, viewerLimit=0, platforms={}),
        _msg("viewer.count", viewerCount=1, viewerLimit=21, platforms={}),
        _msg("viewer.count", viewerCount=1, viewerLimit=20, platforms={"web": 1.5}),
        _msg("viewer.count", viewerCount=1, viewerLimit=20, platforms=[]),
        _msg(
            "session.renewed", ttl={"graceS": 2**63, "idleS": 1, "maxLifetimeS": 1, "expiresAt": 1}
        ),
        _msg("scene.snapshot.ack", sceneVersion=0),
        _msg("scene.snapshot.ack", sceneVersion=2**32),
        {"protocolVersion": "01.0", "type": "pong"},
        {"protocolVersion": chr(0x661) + ".0", "type": "pong"},  # Arabic-Indic digit one
        {"protocolVersion": "9" * 5000 + ".0", "type": "pong"},
        {"protocolVersion": "1.0\n", "type": "pong"},
        {"protocolVersion": 1.0, "type": "pong"},
    ],
)
def test_protocol_client_manual_checks_reject_bad_fields(bare, message):
    assert bare.handle(message) == []
    assert bare.invalid_inbound == 1 and bare.state is SessionState.CREATED
    assert bare.last_error is None and bare.viewer_count == 0 and bare.has_publisher_token


@pytest.mark.parametrize(
    "message",
    [
        None,
        [],
        "session.created",
        {},
        {"protocolVersion": "1.0"},
        {"protocolVersion": "1.0", "type": 5},
        {"protocolVersion": "1.0", "type": "error"},
        {"protocolVersion": "1.0", "type": "session.created", "code": 5, "limits": []},
        {"protocolVersion": "1.0", "type": "viewer.count", "platforms": {"a": "b"}},
        {"protocolVersion": "1.0", "type": "session.renewed", "ttl": []},
        {"protocolVersion": "1.0", "type": "scene.snapshot.ack", "sceneVersion": None},
        {
            "protocolVersion": "1.0",
            "type": "viewer.count",
            "viewerCount": 1,
            "viewerLimit": 20,
            "platforms": {1: 1},
        },  # non-string key (only possible from Python, not JSON)
    ],
)
def test_protocol_client_handle_never_raises(bare, message):
    assert bare.handle(message) == []
    assert bare.state is SessionState.CREATED


def _defs() -> dict:
    """``defs.schema.json#/definitions`` of the vendored protocol package (what the relay validates against)."""
    path = Path(schemas.__file__).parent / "schema" / "defs.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))["definitions"]


def test_protocol_client_known_platforms_match_the_schema():
    assert set(_defs()["platform"]["enum"]) == protocol_client.KNOWN_PLATFORMS


# --------------------------------------------------------------------------- contract bounds (branch audit, SLC-43)
# The Slicer runtime has no jsonschema: the client's own checks must accept exactly what the vendored schema allows,
# so a bound widened in a protocol minor fails here instead of making the client drop valid relay messages.


def test_protocol_client_enum_bounds_match_the_vendored_schema():
    defs = _defs()
    assert tuple(defs["profile"]["enum"]) == protocol_client.PROFILES
    assert frozenset(defs["gltfExtension"]["enum"]) == protocol_client.ALLOWED_EXTENSIONS


def _schema_accepts(definition: dict, value: str) -> bool:
    """An anchored ``^…$`` schema pattern with ECMA-262 semantics (``$`` never matches before a trailing newline)
    and the schema's length bounds."""
    pattern = definition["pattern"]
    assert pattern.startswith("^") and pattern.endswith("$")
    return (
        definition["minLength"] <= len(value) <= definition["maxLength"]
        and re.fullmatch(pattern[1:-1], value) is not None
    )


@pytest.mark.parametrize(
    ("definition", "name"),
    [("token", "_TOKEN"), ("sessionId", "_SESSION_ID"), ("nodeId", "_NODE_ID")],
)
def test_protocol_client_string_bounds_match_the_vendored_schema(definition, name):
    pattern = getattr(protocol_client, name)
    schema = _defs()[definition]
    low, high = schema["minLength"], schema["maxLength"]
    # every ASCII character and a few look-alikes (\uff21 is a full-width A), alone at both length bounds
    chars = [chr(i) for i in range(0x80)] + ["é", "٣", "\u00a0", "\uff21", "\u2028"]
    values = [char * length for char in chars for length in {max(low, 1), high}]
    values += ["A" * length for length in (low - 1, low, high, high + 1) if length >= 0]
    values.append("A" * low + "\n")
    for value in values:
        accepted = pattern.fullmatch(value) is not None
        assert accepted == _schema_accepts(schema, value), (definition, len(value), value[:1])


def _accepts_created(message: dict) -> bool:
    client = ProtocolClient(make_client_info("5.12.4", "win32"))  # no validator: the runtime path
    client.start("mobile")
    client.handle(message)
    return client.state is SessionState.CREATED and client.invalid_inbound == 0


def test_protocol_client_number_bounds_match_the_vendored_schema(bare):
    defs = _defs()
    limits = defs["limits"]["properties"]
    assert set(limits) == set(protocol_client._LIMITS)
    cases = [(None, "viewerLimit", defs["viewerLimit"])]
    cases += [("limits", key, spec) for key, spec in limits.items()]
    for parent, key, spec in cases:
        low, high = spec["minimum"], spec["maximum"]
        for value, accepted in ((low - 1, False), (low, True), (high, True), (high + 1, False)):
            message = _created()
            (message[parent] if parent else message)[key] = value
            assert _accepts_created(message) is accepted, (key, value)
    low, high = defs["viewerLimit"]["minimum"], defs["viewerLimit"]["maximum"]
    for value, accepted in ((low - 1, False), (low, True), (high, True), (high + 1, False)):
        before = bare.invalid_inbound
        bare.handle(
            envelope.make("viewer.count", viewerCount=1, viewerLimit=value, platforms={"web": 1})
        )
        assert (bare.invalid_inbound == before) is accepted, ("viewer.count", value)


def test_protocol_client_inbound_checks_cover_every_handler():
    assert set(protocol_client._INBOUND_CHECKS) == set(ProtocolClient._HANDLERS)


def test_protocol_client_runs_without_jsonschema():
    """The Slicer runtime path: no jsonschema → stdlib-only vendored modules; the client still works end to end."""
    module_dir = Path(__file__).resolve().parents[1] / "RemoteView"
    code = (
        "import sys; sys.modules['jsonschema'] = None; sys.path.append(sys.argv[1])\n"
        "from remoteview_core import vendored\n"
        "from remoteview_core.protocol_client import ProtocolClient, make_client_info\n"
        "assert 'jsonschema' not in [m for m in sys.modules if sys.modules[m] is not None]\n"
        "c = ProtocolClient(make_client_info('5.12.4', 'darwin'))\n"
        "c.start('mobile')\n"
        "c.handle({'protocolVersion': '1.0', 'type': 'session.created', 'sessionId': 's1', 'code': '7KQ4X',\n"
        "          'publisherToken': 'p' * 43, 'viewerLimit': 20,\n"
        "          'ttl': {'graceS': 1, 'idleS': 1, 'maxLifetimeS': 1, 'expiresAt': 1},\n"
        "          'limits': {'maxSnapshotBytes': 1 << 26, 'maxChunkBytes': 1 << 20, 'maxTextBytes': 1 << 18,\n"
        "                     'maxChanges': 1000}})\n"
        "m = c.begin_snapshot(open(sys.argv[2], 'rb').read(), node_count=2, triangle_count=36)\n"
        "print(c.state.value, m.begin['chunkCount'], len(list(m.chunks)))\n"
    )
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            code,
            str(module_dir),
            str(FIXTURES / "glb" / "asymmetric-2nodes.glb"),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["active", "1", "1"]


def test_protocol_client_checks_the_protocol_version():
    client = ProtocolClient(make_client_info("5.12.4", "win32"))  # runtime path, no schemas
    client.start("mobile")
    assert client.handle({**_created(), "protocolVersion": "one"}) == []
    assert client.handle({**_created(), "protocolVersion": "1.0\n"}) == []
    assert client.handle({k: v for k, v in _created().items() if k != "protocolVersion"}) == []
    assert client.invalid_inbound == 3 and client.last_invalid_type == "envelope"
    assert client.state is SessionState.CONNECTING and client.last_error is None
    client.handle({**_created(), "protocolVersion": "1.7"})  # a newer minor is fine (§2)
    assert client.state is SessionState.CREATED
    client.handle(
        {
            **envelope.make("viewer.count", viewerCount=1, viewerLimit=20, platforms={}),
            "protocolVersion": "2.0",
        }
    )
    assert client.state is SessionState.CLOSED and client.last_error.code == "UNSUPPORTED_VERSION"
    assert client.viewer_count == 0 and not client.has_publisher_token
    major_zero = ProtocolClient(make_client_info("5.12.4", "win32"))
    major_zero.start("mobile")
    major_zero.handle(_created())
    major_zero.handle(
        {
            **envelope.make("viewer.count", viewerCount=1, viewerLimit=20, platforms={}),
            "protocolVersion": "0.9",
        }
    )
    assert major_zero.close_reason == "UNSUPPORTED_VERSION" and major_zero.viewer_count == 0
    expired = ProtocolClient(make_client_info("5.12.4", "win32"))
    expired.start("mobile")
    expired.handle(_created())
    expired.handle(envelope.make("session.expired", sessionId=SESSION_ID, reason="IDLE"))
    expired.handle({**_created(), "protocolVersion": "2.0"})  # already closed: nothing changes
    assert expired.close_reason == "IDLE" and expired.last_error is None
