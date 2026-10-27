"""SLC-24: the snapshot core — scene → GLB → scene.snapshot.* frames, and the frames through the relay stub."""

from __future__ import annotations

import json
import queue
import struct
import sys
import time

import pytest
from support import (
    FakeScene,
    ack,
    live_client,
    needs_node,
    needs_relay_stub,
    needs_validator,
    reassemble,
    root_extras,
    sphere,
    start_relay_stub,
    start_throttle_proxy,
    validate_glb,
)

from remoteview_core import snapshot as snapshot_module
from remoteview_core.protocol_client import (
    ProtocolClient,
    ProtocolStateError,
    SessionState,
    make_client_info,
)
from remoteview_core.snapshot import SnapshotTooLargeError, build_snapshot
from remoteview_core.transport import Connected, Disconnected, Received, RelayTransport
from remoteview_core.vendored import chunk_header
from remoteview_protocol import envelope, schemas

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


def test_snapshot_is_quantized_and_its_begin_says_so():
    """FR-09, SLC-12: the GLB uses KHR_mesh_quantization, and begin declares exactly what the file requires."""
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)})
    quantized = build_snapshot(scene, live_client(), slicer_version="5.12.4")
    begin, glb, _ = reassemble(list(quantized.frames()))
    assert begin["extensionsUsed"] == begin["extensionsRequired"] == ["KHR_mesh_quantization"]
    document = json.loads(glb[20 : 20 + struct.unpack_from("<I", glb, 12)[0]])
    assert document["extensionsRequired"] == ["KHR_mesh_quantization"]
    assert "matrix" in document["nodes"][2]  # M dequantises (§7.2)
    plain = build_snapshot(scene, live_client(), slicer_version="5.12.4", quantize=False)
    begin_plain, glb_plain, _ = reassemble(list(plain.frames()))
    assert begin_plain["extensionsUsed"] == begin_plain["extensionsRequired"] == []
    assert len(glb) < 0.8 * len(glb_plain)


def test_snapshot_versions_follow_the_client():
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    first = build_snapshot(scene, client, slicer_version="5.12.4")
    second = build_snapshot(scene, client, slicer_version="5.12.4")  # supersedes the first (§6.2)
    begin, glb, _ = reassemble(list(second.frames()))
    assert (first.scene_version, second.scene_version, begin["sceneVersion"]) == (1, 2, 2)
    assert root_extras(glb)["sceneVersion"] == 2 and client.next_scene_version == 3


def test_snapshot_announces_new_nodes_before_its_begin():
    """``announce`` (SLC-29): ``scene.nodeAdded`` takes the version before the snapshot's own (§8.2, §8.4)."""
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    build_snapshot(scene, client, slicer_version="5.12.4")
    client.handle(ack(1))
    scene.nodes.append({"id": "vtkMRMLModelNode5", "mesh": sphere(8)})
    new = [("vtkMRMLModelNode5", "model")]
    second = build_snapshot(scene, client, slicer_version="5.12.4", announce=new)
    added = second.announced
    begin, glb, _ = reassemble(list(second.frames()))
    assert (added["type"], added["sceneVersion"], added["baseVersion"]) == ("scene.nodeAdded", 2, 1)
    assert added["nodes"] == [{"nodeId": "vtkMRMLModelNode5", "kind": "model"}]
    assert begin["sceneVersion"] == root_extras(glb)["sceneVersion"] == second.scene_version == 3
    assert "vtkMRMLModelNode5" not in repr(second)
    # updates held (version 3 in flight): no hint, no version used for one
    third = build_snapshot(scene, client, slicer_version="5.12.4", announce=new)
    assert third.announced is None and third.scene_version == 4
    assert build_snapshot(scene, client, slicer_version="5.12.4").announced is None


def test_snapshot_announces_only_the_nodes_it_exports():
    """A node the export leaves out is not announced (T7: only IDs that passed collect's rules)."""
    client = live_client()
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    build_snapshot(scene, client, slicer_version="5.12.4")
    client.handle(ack(1))
    scene.nodes += [
        {"id": "vtkMRMLModelNode5", "mesh": sphere(8)},
        {"id": "vtkMRMLModelNode6"},
    ]  # no mesh
    new = [("vtkMRMLModelNode5", "model"), ("vtkMRMLModelNode6", "model")]
    snapshot = build_snapshot(scene, client, slicer_version="5.12.4", announce=new)
    assert snapshot.announced["nodes"] == [{"nodeId": "vtkMRMLModelNode5", "kind": "model"}]
    other = live_client()
    build_snapshot(scene, other, slicer_version="5.12.4")
    other.handle(ack(1))
    only_left_out = build_snapshot(scene, other, slicer_version="5.12.4", announce=new[1:])
    assert (
        only_left_out.announced is None and only_left_out.scene_version == 2
    )  # no version for a hint


def test_snapshot_too_large_for_the_relay_announces_nothing():
    """The binary chunk is checked before the hint is built: no ``scene.nodeAdded`` without its snapshot (§8.2)."""
    client = live_client()
    small = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(8)})
    build_snapshot(small, client, slicer_version="5.12.4")
    client.handle(ack(1))
    client.limits["maxSnapshotBytes"] = 5_000
    big = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)}, {"id": "vtkMRMLModelNode5"})
    with pytest.raises(SnapshotTooLargeError):
        build_snapshot(
            big, client, slicer_version="5.12.4", announce=[("vtkMRMLModelNode5", "model")]
        )
    assert client.versions.last == 1 and not client.snapshot_needed


def test_snapshot_refused_after_its_hint_keeps_a_snapshot_owed():
    """The binary chunk fits but the whole file is one byte over: the hint was built (a version used) but is never
    returned — and a snapshot stays owed, as §8.2 asks after a hint."""
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)})
    size = build_snapshot(scene, live_client(), slicer_version="5.12.4").byte_length
    client = live_client()
    build_snapshot(FakeScene(), client, slicer_version="5.12.4")
    client.handle(ack(1))
    client.limits["maxSnapshotBytes"] = size - 1
    with pytest.raises(SnapshotTooLargeError):
        build_snapshot(
            scene, client, slicer_version="5.12.4", announce=[("vtkMRMLModelNode4", "model")]
        )
    assert client.snapshot_needed and client.updates_held and client.versions.last == 2


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
    # its binary chunk alone is over the limit: refused before the GLB is written, with the estimated size (SLC-14)
    size = build_snapshot(scene, live_client(), slicer_version="5.12.4").byte_length
    assert abs(raised.value.byte_length - size) <= 0.1 * size
    client.limits["maxSnapshotBytes"] = size  # exactly the limit is allowed
    assert build_snapshot(scene, client, slicer_version="5.12.4").byte_length == size


def test_snapshot_just_over_the_relay_limit_is_refused_with_its_real_size():
    """Binary chunk within the limit, the whole file one byte over: written, measured, refused (no estimate)."""
    scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)})
    size = build_snapshot(scene, live_client(), slicer_version="5.12.4").byte_length
    client = live_client(maxSnapshotBytes=size - 1)
    with pytest.raises(SnapshotTooLargeError) as raised:
        build_snapshot(scene, client, slicer_version="5.12.4")
    assert (raised.value.byte_length, raised.value.limit) == (size, size - 1)
    assert client.next_scene_version == 1 and client.snapshot_in_flight is None


def test_snapshot_far_over_the_limit_is_never_written(monkeypatch):
    def no_write(*args, **kwargs):
        raise AssertionError("written")

    monkeypatch.setattr(snapshot_module, "write_glb", no_write)
    client = live_client(maxSnapshotBytes=5_000)
    with pytest.raises(SnapshotTooLargeError):
        build_snapshot(
            FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(32)}),
            client,
            slicer_version="5.12.4",
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
    report = validate_glb(tmp_path, {"snapshot.glb": glb})["snapshot.glb"]
    assert report["numErrors"] == 0 and report["numWarnings"] == 0 and report["violations"] == []


# --------------------------------------------------------------------------- end to end through the relay stub


def _next(
    events: queue.Queue, kind: type | tuple[type, ...], deadline: float, client: ProtocolClient
):
    """The next event of ``kind``; ``Received`` messages on the way are fed to ``client``."""
    while True:
        event = events.get(timeout=max(0.01, deadline - time.monotonic()))
        if isinstance(event, Received) and isinstance(event.message, dict):
            client.handle(event.message)
        if isinstance(event, kind):
            return event


def upload(
    url: str, scene: FakeScene, *, max_chunk: int | None = None, timeout: float = 10.0, **options
):
    """The real client and transport create a session at ``url`` and send ``scene`` as its first snapshot; returns
    the ``begin`` message and the connections that ended on the way (the upload stops at the first). Waits up to
    ``timeout`` s for the relay's ack, then ends the session with ``session.close``."""
    events: queue.Queue = queue.Queue()
    transport = RelayTransport(url, events, use_proxy=False, **options)
    transport.start()
    try:
        client = ProtocolClient(make_client_info("5.12.4", sys.platform), auto_renew=False)
        deadline = time.monotonic() + 10
        connection = _next(events, Connected, deadline, client).connection
        transport.send(client.start("mobile"), connection=connection)
        while client.state is not SessionState.CREATED:
            _next(events, Received, deadline, client)
        if max_chunk is not None:
            client.limits["maxChunkBytes"] = max_chunk
        snapshot = build_snapshot(scene, client, slicer_version="5.12.4")
        for frame in snapshot.frames():
            assert transport.send(frame, connection=connection)
        drops: list[Disconnected] = []
        deadline = time.monotonic() + timeout
        while client.accepted_version != snapshot.scene_version and not drops:
            event = _next(events, (Received, Disconnected), deadline, client)
            if isinstance(event, Disconnected):
                drops.append(event)
        if not drops:
            assert client.snapshot_in_flight is None and client.state is SessionState.ACTIVE
        assert transport.stop(client.close(), timeout=3)
        return snapshot, drops
    finally:
        transport.stop(timeout=3)  # no transport thread outlives a failed test


@needs_relay_stub
def test_snapshot_end_to_end_with_the_relay_stub():
    """Real client and transport (§4.1, §6): the stub receives intact chunks and acknowledges the snapshot."""
    stub = start_relay_stub()
    try:
        # 64 KiB chunks: the reassembly checks order and sizes, not just one frame
        scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(96)})  # ≈ 220 kB quantised
        snapshot, drops = upload(stub.address, scene, max_chunk=65_536)
        assert drops == [] and snapshot.byte_length > 2 * 65_536
    finally:
        out = stub.finish()
    closes, _pings, *snapshots = out.split()
    assert closes == "1" and snapshots == [f"v1:{snapshot.messages.begin['sha256']}"]


@needs_relay_stub
@needs_node
def test_snapshot_heartbeat_survives_a_throttled_uplink():
    """Real sockets (SLC-26): the proxy carries 400 KB/s to the relay, so the ping queued behind the chunks reaches it
    seconds after it was sent — long after the (scaled) 0.5 s pong timeout — yet the upload is not a dead connection."""
    stub = start_relay_stub()
    try:
        proxy = start_throttle_proxy(stub, rate=400_000)
        try:
            # ≈ 1.07 MB quantised (SLC-12)
            scene = FakeScene({"id": "vtkMRMLModelNode4", "mesh": sphere(212)})
            snapshot, drops = upload(
                f"ws://{proxy.address}/ws", scene, timeout=20, ping_interval=0.3, pong_timeout=0.5
            )
            # about 2.7 s at 400 KB/s: several pings (every 0.3 s) are due while the chunks are on their way
            assert snapshot.byte_length > 1_000_000
            assert drops == [], f"the upload was cut: {drops[0].error}"
        finally:
            forwarded = int(proxy.finish().split()[0])
    finally:
        out = stub.finish()
    closes, _pings, *snapshots = out.split()
    assert snapshots == [f"v1:{snapshot.messages.begin['sha256']}"] and closes == "1"
    # everything went through the throttle
    assert forwarded >= snapshot.byte_length
