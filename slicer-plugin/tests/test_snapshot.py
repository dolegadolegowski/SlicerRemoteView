"""SLC-24: the snapshot core — scene → GLB → scene.snapshot.* frames, and the frames through the relay stub."""

from __future__ import annotations

import json
import queue
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from test_glb_writer import _validate, needs_validator
from test_panel import RELAY_STUB, _first_line, needs_relay_stub
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core.protocol_client import (
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    make_client_info,
)
from remoteview_core.snapshot import SnapshotTooLargeError, build_snapshot
from remoteview_core.transport import Connected, Received, RelayTransport
from remoteview_core.vendored import chunk_header
from remoteview_protocol import envelope, schemas

LIMITS = {
    "maxSnapshotBytes": 67_108_864,
    "maxChunkBytes": 1_048_576,
    "maxTextBytes": 262_144,
    "maxChanges": 1000,
}


def sphere(resolution: int = 16):
    source = vtkSphereSource()
    source.SetRadius(20.0)
    source.SetCenter(100.0, 0.0, 0.0)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    return source.GetOutput()


class FakeScene:
    """A :class:`~remoteview_core.collect.SceneApi` over plain dicts (the MRML adapter is SLC-22's)."""

    def __init__(self, *nodes: dict) -> None:
        self.nodes = list(nodes)
        self.asked = 0

    def visible_model_nodes(self):
        self.asked += 1
        return self.nodes

    def node_id(self, node):
        return node["id"]

    def name(self, node):
        return node.get("name", "Liver")

    def polydata(self, node):
        return node.get("mesh")

    def display_props(self, node):
        return (0.8, 0.3, 0.2), 1.0, True

    def world_matrix(self, node):
        return np.eye(4)


def live_client(profile: str = "mobile", **limits) -> ProtocolClient:
    client = ProtocolClient(make_client_info("5.12.4", "win32"), auto_renew=False)
    client.start(profile)
    client.handle(
        envelope.make(
            "session.created",
            reply_to="p-1",
            sessionId="sess_01K7Q4XMB2TJ9RD6",
            code="7KQ4X",
            publisherToken="pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA",  # the protocol.md §4.2 example
            viewerLimit=20,
            ttl={"graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120},
            limits={**LIMITS, **limits},
        )
    )
    assert client.state is SessionState.CREATED
    return client


def reassemble(frames: list) -> tuple[dict, bytes, dict]:
    """``(begin, glb, end)`` from the frames in order, checking each chunk like a receiver does (§6.3)."""
    begin, *chunks, end = frames
    assert len(chunks) == begin["chunkCount"]
    glb = bytearray()
    for index, frame in enumerate(chunks):
        decoded = chunk_header.decode_chunk_header(frame)
        expected = chunk_header.ExpectedChunk(
            begin["sceneVersion"],
            begin["byteLength"],
            begin["chunkSize"],
            begin["chunkCount"],
            index,
        )
        chunk_header.check_chunk(decoded, expected)
        glb += decoded.payload
    return begin, bytes(glb), end


def root_extras(glb: bytes) -> dict:
    json_length, json_type = struct.unpack_from("<II", glb, 12)
    assert json_type == 0x4E4F534A
    document = json.loads(glb[20 : 20 + json_length])
    [root] = [n for n in document["nodes"] if n.get("name") == "SlicerRemoteView"]
    return root["extras"]


# --------------------------------------------------------------------------- the snapshot core


def test_snapshot_of_a_sphere_scene_matches_its_begin():
    client = live_client("quest3")
    scene = FakeScene(
        {"id": "vtkMRMLModelNode4", "mesh": sphere()},
        {"id": "vtkMRMLModelNode5"},
        {"id": "vtkMRMLModelNode6", "name": "Tumor", "mesh": sphere(8)},
    )
    snapshot = build_snapshot(scene, client, slicer_version="5.10.2")
    begin, glb, end = reassemble(list(snapshot.frames()))
    compiled = schemas.compile_schemas()
    assert schemas.validate_message(begin, None, compiled) == []
    assert schemas.validate_message(end, None, compiled) == []
    assert begin["sha256"] == end["sha256"] == chunk_header.sha256_hex(glb)
    assert (begin["byteLength"], begin["sceneVersion"], begin["chunkSize"]) == (
        len(glb),
        1,
        1_048_576,
    )
    # the counts are the sums over the exported nodes
    assert (begin["nodeCount"], begin["triangleCount"]) == (2, 16 * 14 * 2 + 8 * 6 * 2)
    assert (snapshot.node_count, snapshot.triangle_count, snapshot.byte_length) == (
        begin["nodeCount"],
        begin["triangleCount"],
        begin["byteLength"],
    )
    extras = root_extras(glb)
    assert (extras["sceneVersion"], extras["profile"]) == (begin["sceneVersion"], "quest3")
    assert begin["profile"] == "quest3"
    assert extras["source"] == {"app": "3D Slicer", "version": "5.10.2"}
    # the node without a mesh is reported, not sent
    assert [(s.node_id, s.reason.value) for s in snapshot.skipped] == [
        ("vtkMRMLModelNode5", "no-triangles")
    ]
    assert client.state is SessionState.ACTIVE and client.snapshot_in_flight == 1
    assert repr(snapshot).count("7KQ4X") == 0
    with pytest.raises(
        RuntimeError
    ):  # the chunks were taken: begin + end alone would be a broken snapshot
        snapshot.frames()


def test_snapshot_versions_follow_the_client():
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    first = build_snapshot(scene, client, slicer_version="5.12.4")
    second = build_snapshot(scene, client, slicer_version="5.12.4")  # supersedes the first (§6.2)
    begin, glb, _ = reassemble(list(second.frames()))
    assert (first.scene_version, second.scene_version, begin["sceneVersion"]) == (1, 2, 2)
    assert root_extras(glb)["sceneVersion"] == 2 and client.next_scene_version == 3


def test_snapshot_of_an_empty_scene_has_no_nodes():
    client = live_client()
    snapshot = build_snapshot(FakeScene(), client, slicer_version="5.12.4")
    begin, glb, _ = reassemble(list(snapshot.frames()))
    assert (begin["nodeCount"], begin["triangleCount"], begin["chunkCount"]) == (0, 0, 1)
    assert root_extras(glb)["sceneVersion"] == 1


def test_snapshot_with_hidden_names():
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "name": "Doe^John liver", "mesh": sphere(8)})
    _, glb, _ = reassemble(
        list(build_snapshot(scene, client, slicer_version="5.12.4", anonymize_names=True).frames())
    )
    assert root_extras(glb)["anonymizedNames"] is True
    assert b"Doe" not in glb and b"Model 1" in glb


def test_snapshot_over_the_relay_limit_is_refused_before_anything_is_sent():
    client = live_client(maxSnapshotBytes=5_000)
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)})
    with pytest.raises(SnapshotTooLargeError) as raised:
        build_snapshot(scene, client, slicer_version="5.12.4")
    assert raised.value.limit == 5_000 and raised.value.byte_length > 5_000
    assert "Liver" not in str(raised.value)  # numbers only
    # no version used, the session untouched
    assert client.next_scene_version == 1 and client.state is SessionState.CREATED
    assert client.snapshot_in_flight is None
    client.limits["maxSnapshotBytes"] = raised.value.byte_length  # exactly the limit is allowed
    assert (
        build_snapshot(scene, client, slicer_version="5.12.4").byte_length
        == raised.value.byte_length
    )


def _not_live(state: str) -> ProtocolClient:
    if state == "idle":
        return ProtocolClient(make_client_info("5.12.4", "win32"))
    client = live_client()
    if state == "connecting":
        client = ProtocolClient(make_client_info("5.12.4", "win32"))
        client.start("mobile")
    elif state == "grace":
        client.transport_lost(1006)  # limits and profile are kept for the resume (SLC-17)
    elif state == "closed":
        client.close()
    elif state == "expired":
        client.handle(
            envelope.make("session.expired", sessionId="sess_01K7Q4XMB2TJ9RD6", reason="IDLE")
        )
    return client


@pytest.mark.parametrize("state", ["idle", "connecting", "grace", "closed", "expired"])
def test_snapshot_needs_a_live_session(state):
    client = _not_live(state)
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    with pytest.raises(ProtocolStateError):
        build_snapshot(scene, client, slicer_version="5.12.4")
    assert scene.asked == 0  # nothing collected


@needs_validator
def test_snapshot_glb_passes_khronos_gltf_validator(tmp_path):
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere()})
    _, glb, _ = reassemble(list(build_snapshot(scene, client, slicer_version="5.12.4").frames()))
    report = _validate(tmp_path, {"snapshot.glb": glb})["snapshot.glb"]
    assert report["numErrors"] == 0 and report["numWarnings"] == 0 and report["violations"] == []


# --------------------------------------------------------------------------- end to end through the relay stub


def _next(events: queue.Queue, kind: type, deadline: float, client: ProtocolClient):
    """The next event of ``kind``; ``Received`` messages on the way are fed to ``client``."""
    while True:
        event = events.get(timeout=max(0.01, deadline - time.monotonic()))
        if isinstance(event, Received) and isinstance(event.message, dict):
            client.handle(event.message)
        if isinstance(event, kind):
            return event


@needs_relay_stub
def test_snapshot_end_to_end_with_the_relay_stub():
    """Real client and transport (§4.1, §6): the stub receives intact chunks and acknowledges the snapshot."""
    stub = subprocess.Popen(  # fixed argv: node and two repository files
        ["node", str(Path(__file__).with_name("relay_stub.mjs")), RELAY_STUB.as_uri()],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    events: queue.Queue = queue.Queue()
    transport = None
    try:
        url = _first_line(stub, timeout=15)
        assert url.startswith("ws://127.0.0.1:"), "the relay stub did not start"
        transport = RelayTransport(url, events, use_proxy=False)
        transport.start()
        client = ProtocolClient(make_client_info("5.12.4", sys.platform), auto_renew=False)
        deadline = time.monotonic() + 10
        connection = _next(events, Connected, deadline, client).connection
        transport.send(client.start("mobile"), connection=connection)
        while client.state is not SessionState.CREATED:
            _next(events, Received, deadline, client)
        # 3 chunks of 64 KiB: the reassembly checks order and sizes, not just one frame
        client.limits["maxChunkBytes"] = 65_536
        scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(64)})
        snapshot = build_snapshot(scene, client, slicer_version="5.12.4")
        assert snapshot.byte_length > 2 * 65_536
        begin = snapshot.messages.begin
        for frame in snapshot.frames():
            assert transport.send(frame, connection=connection)
        while client.accepted_version != snapshot.scene_version:
            _next(events, Received, deadline, client)
        assert client.snapshot_in_flight is None and client.state is SessionState.ACTIVE
        assert transport.stop(client.close(), timeout=3)
    finally:
        if transport is not None:
            transport.stop(timeout=3)  # no transport thread outlives a failed test
        try:
            out, _ = stub.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            stub.kill()
            out, _ = stub.communicate()
    closes, _pings, *snapshots = out.split()
    assert closes == "1" and snapshots == [f"v1:{begin['sha256']}"]
