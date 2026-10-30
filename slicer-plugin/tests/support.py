"""Test helpers shared by several test modules: the fakes of the panel, the scene and MRML, the Khronos glTF validator,
and the Node processes (relay stub, throttle proxy) of the end-to-end tests.

Pure test code: importing it starts nothing. Fixtures that use these fakes live in ``conftest.py``.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import queue
import random
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, ClassVar

import numpy as np
import pytest
from vtkmodules.util.numpy_support import numpy_to_vtk
from vtkmodules.vtkCommonCore import vtkObject
from vtkmodules.vtkCommonDataModel import vtkImageData
from vtkmodules.vtkFiltersCore import vtkAppendPolyData
from vtkmodules.vtkFiltersGeneral import vtkDiscreteFlyingEdges3D
from vtkmodules.vtkFiltersSources import vtkSphereSource

from remoteview_core.glb_writer import Entity
from remoteview_core.protocol_client import ProtocolClient, SessionState, make_client_info
from remoteview_core.transport import RelayTransport, check_relay_url
from remoteview_core.vendored import chunk_header
from remoteview_protocol import envelope

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
REPO_ROOT = PLUGIN_ROOT.parent
RELAY_STUB = REPO_ROOT / "tools" / "fake-slicer" / "dist" / "relay-stub.js"

URL = "wss://relay.example.org/ws"
CODE = "7KQ4X"
TOKEN = "pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA"  # noqa: S105 — the protocol.md §4.2 example token
SESSION_ID = "sess_01K7Q4XMB2TJ9RD6"
#: A second session (a re-create after a relay restart may get another code, SLC-45).
OTHER_CODE = "9HJ4M"
OTHER_SESSION_ID = "sess_01K7Q9ZRB4MP2WX8"
OTHER_TOKEN = "pt_Zq2Wx7Rb4Mp9Kt3Hv6Nc8Yd1Lf5Gs0Je2Ua7Qo4Xi"  # noqa: S105 — a made-up token of the defs pattern
LIMITS = {
    "maxSnapshotBytes": 67_108_864,
    "maxChunkBytes": 1_048_576,
    "maxTextBytes": 262_144,
    "maxChanges": 1000,
}

# --------------------------------------------------------------------------- Node processes and the glTF validator

needs_relay_stub = pytest.mark.skipif(
    (shutil.which("node") is None or not RELAY_STUB.is_file())
    and os.environ.get("REMOTEVIEW_REQUIRE_RELAY_STUB") != "1",
    reason="needs Node 22 and `npm run build -w shared -w tools/fake-slicer` (the relay stub's dist/)",
)

needs_node = pytest.mark.skipif(
    shutil.which("node") is None and os.environ.get("REMOTEVIEW_REQUIRE_RELAY_STUB") != "1",
    reason="needs Node 22",
)

VALIDATOR_SCRIPT = TESTS_DIR / "validate_glb.mjs"
HAS_VALIDATOR = (
    shutil.which("node") is not None and (REPO_ROOT / "node_modules" / "gltf-validator").is_dir()
)
# CI must set REMOTEVIEW_REQUIRE_GLTF_VALIDATOR=1 (exactly "1"; report 2026-10-19-slicer-1) so a missing `npm ci`
# fails instead of skipping the spec gate.
needs_validator = pytest.mark.skipif(
    not HAS_VALIDATOR and os.environ.get("REMOTEVIEW_REQUIRE_GLTF_VALIDATOR") != "1",
    reason="Node 22 + `npm ci` at the repository root are needed for the Khronos glTF validator",
)


def validate_glb(tmp_path: Path, files: dict[str, bytes]) -> dict:
    """The validator's report for each file (``numErrors``, ``numWarnings``, ``violations`` of the §7.1 pre-check)."""
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)
    result = subprocess.run(
        ["node", str(VALIDATOR_SCRIPT), *[str(tmp_path / n) for n in files]],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    reports = json.loads(result.stdout)
    return {name: reports[str(tmp_path / name)] for name in files}


class NodeProcess:
    """A helper script run by Node (fixed argv: ``node`` and repository files); its first stdout line is its address.

    One reader thread owns the script's stdout and queues its lines. :meth:`command` writes one line to the script and
    returns its one-line answer (the relay stub's commands, SLC-46); :meth:`finish` closes its stdin, which makes the
    script print its summary and exit; a script that hangs is killed.
    """

    def __init__(self, script: str, *args: str) -> None:
        self._process = subprocess.Popen(  # fixed argv: node and files of this repository
            ["node", str(TESTS_DIR / script), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._ended = False  # the reader reached the end of the output
        threading.Thread(target=self._read, daemon=True).start()
        self.output: str | None = None
        self.address = (self._line(timeout=15) or "").strip()

    def _read(self) -> None:
        stdout = self._process.stdout
        if stdout is not None:
            with stdout:
                for line in stdout:
                    self._lines.put(line)
        self._lines.put(None)  # end of output

    def _line(self, timeout: float) -> str | None:
        """The next line the script prints, or ``None`` at its end or after ``timeout`` s (never hangs)."""
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            return None
        self._ended = self._ended or line is None
        return line

    def command(self, line: str, timeout: float = 10) -> str:
        """Send one command line; its answer, which must start with ``ok``."""
        stdin = self._process.stdin
        assert stdin is not None and self.output is None, "the script has finished"
        stdin.write(f"{line}\n")
        stdin.flush()
        answer = (self._line(timeout) or "").strip()
        assert answer.startswith("ok"), f"{line!r} answered {answer!r}"
        return answer

    def finish(self) -> str:
        """Close stdin and return what the script printed after its first line and its answers (idempotent)."""
        if self.output is None:
            if self._process.stdin is not None:
                with contextlib.suppress(BrokenPipeError):  # a script that died
                    self._process.stdin.close()
            lines: list[str] = []
            deadline = time.monotonic() + 10
            while not self._ended and (line := self._line(max(0.0, deadline - time.monotonic()))):
                lines.append(line)
            if not self._ended:
                self._process.kill()  # a script that hangs
                while (line := self._line(5)) is not None:
                    lines.append(line)
            self._process.wait(timeout=10)
            self.output = "".join(lines)
        return self.output


def _started(process: NodeProcess, prefix: str, what: str) -> NodeProcess:
    if not process.address.startswith(prefix):
        process.finish()  # a script that did not start must not outlive the test
        raise AssertionError(f"{what} did not start")
    return process


def start_relay_stub(*options: str) -> NodeProcess:
    """The relay stub of tools/fake-slicer (``tests/relay_stub.mjs``, with its ``options``); ``.address`` is its
    ``ws://`` URL."""
    return _started(
        NodeProcess("relay_stub.mjs", *options, RELAY_STUB.as_uri()),
        "ws://127.0.0.1:",
        "the relay stub",
    )


class WorstJitter(random.Random):
    """The transport's retry delays at their longest (``uniform`` → its upper bound): timing tests stay honest."""

    def uniform(self, a: float, b: float) -> float:
        return b


class LeastJitter(random.Random):
    """The transport's retry delays at their shortest (``uniform`` → its lower bound): quick, still realistic."""

    def uniform(self, a: float, b: float) -> float:
        return a


def stub_transport(*, rng: random.Random, drop_out=None, drop_in=None, **knobs: Any):
    """A transport factory for the panel against the relay stub (no proxy, the given ``rng`` and ``knobs`` such as
    ``ping_interval``). ``drop_out(frame)`` swallows the first outbound frame it matches, as if lost on the way
    (``transport.dropped_out``); ``drop_in(event)`` swallows the first inbound ``Received`` it matches
    (``transport.dropped_in``). ``transport.sent_types`` lists ``(connection, type)`` for every frame the panel handed
    to ``send`` (``"chunk"`` for binary ones) and ``(None, "stop:<type of the final message or none>")`` for each
    ``stop``. ``factory.made`` lists the transports built."""
    made: list[RelayTransport] = []

    def factory(
        url: str, events: queue.Queue, *, extra_ca_file: str | None = None
    ) -> RelayTransport:
        transport = RelayTransport(url, events, use_proxy=False, rng=rng, min_uplink=1e12, **knobs)
        transport.dropped_out = transport.dropped_in = False  # type: ignore[attr-defined]
        sent_types: list[tuple[int | None, str]] = []
        transport.sent_types = sent_types  # type: ignore[attr-defined]
        if drop_in is not None:
            put = events.put

            def put_unless_dropped(event: Any, *args: Any, **kwargs: Any) -> None:
                if not transport.dropped_in and drop_in(event):  # type: ignore[attr-defined]
                    transport.dropped_in = True  # type: ignore[attr-defined]
                    return
                put(event, *args, **kwargs)

            events.put = put_unless_dropped  # type: ignore[method-assign]  # the worker thread puts here
        send, stop = transport.send, transport.stop

        def send_unless_dropped(frame: Any, *, connection: int) -> bool:
            kind = frame.get("type", "?") if isinstance(frame, dict) else "chunk"
            sent_types.append((connection, kind))
            if drop_out is not None and not transport.dropped_out and drop_out(frame):  # type: ignore[attr-defined]
                transport.dropped_out = True  # type: ignore[attr-defined]
                return True
            return send(frame, connection=connection)

        def recorded_stop(final: Any = None, **kwargs: Any) -> Any:
            kind = final.get("type", "?") if isinstance(final, dict) else "none"
            sent_types.append((None, f"stop:{kind}"))
            return stop(final, **kwargs)

        transport.send = send_unless_dropped  # type: ignore[method-assign]
        transport.stop = recorded_stop  # type: ignore[method-assign]
        made.append(transport)
        return transport

    factory.made = made  # type: ignore[attr-defined]
    return factory


def start_throttle_proxy(target: NodeProcess | str, rate: int) -> NodeProcess:
    """A proxy in front of ``target`` (the relay stub, or a loopback ``host:port``) that passes ``rate`` bytes per
    second towards it; ``.address`` is its own ``host:port``."""
    address = target if isinstance(target, str) else target.address.split("/")[2]
    proxy = NodeProcess("throttle_proxy.mjs", "--target", address, "--rate", str(rate))
    return _started(proxy, "127.0.0.1:", "the throttle proxy")


def pump_while(ctl: Any, condition, seconds: float) -> None:
    """The adapter's loop: pump, then sleep, while ``condition()`` holds (at most ``seconds``)."""
    deadline = time.monotonic() + seconds
    while condition() and time.monotonic() < deadline:
        ctl.pump()
        time.sleep(0.02)


# --------------------------------------------------------------------------- the panel


def leaks(caplog: Any, capfd: Any, *needles: str) -> list[str]:
    """Where a needle (a node ID, a name, a session code, a token, ``Traceback``) shows (T7): the captured log, this
    process's stdout and stderr (VTK and PythonQt print an exception that escapes a callback there, never to the log),
    and ``sys.last_value``/``sys.last_exc`` (set by ``PyErr_Print``; pytest clears them before each test call)."""
    out, err = capfd.readouterr()
    found = [
        f"{where}: {needle}"
        for where, text in (("log", caplog.text), ("stdout", out), ("stderr", err))
        for needle in needles
        if needle and needle in text
    ]
    found += [
        f"sys.{name}" for name in ("last_value", "last_exc") if getattr(sys, name, None) is not None
    ]
    return found


class FakeTimer:
    """A single-shot timer on a fake clock: ``advance(ms)`` fires it when its deadline passes, like ``qt.QTimer``."""

    def __init__(self) -> None:
        self.now = 0.0  # milliseconds
        self.deadline: float | None = None
        self.callback = None
        self.starts: list[int] = []

    def clock(self) -> float:  # seconds, like time.monotonic
        return self.now / 1000.0

    def start(self, msec: int) -> None:
        assert isinstance(msec, int) and msec >= 0
        self.starts.append(msec)
        self.deadline = self.now + msec

    def stop(self) -> None:
        self.deadline = None

    def advance(self, ms: float) -> None:
        target = self.now + ms
        for _ in range(100_000):
            if self.deadline is None or self.deadline > target:
                break
            self.now = self.deadline
            self.deadline = None
            self.callback()
        else:
            raise AssertionError("the timer re-armed itself 100,000 times")
        self.now = target


class FakeTransport:
    """``RelayTransport``'s interface: validates the URL like the real one, records sends and stops."""

    made: ClassVar[list[FakeTransport]] = []

    def __init__(self, url, events, *, extra_ca_file=None):
        self.url = check_relay_url(url)
        self.events = events
        self.extra_ca_file = extra_ca_file
        self.started = False
        self.sent: list[tuple[int, dict]] = []
        self.stops: list[tuple[object, float]] = []
        self.discarded: list[int] = []
        FakeTransport.made.append(self)

    def start(self) -> None:
        self.started = True

    def send(self, frame, *, connection):
        self.sent.append((connection, frame))
        return True

    def discard_queued(self, *, connection):
        self.discarded.append(connection)
        return True

    def stop(self, final=None, *, timeout=3.0):
        self.stops.append((final, timeout))
        return True


def ttl(grace_s: int = 120) -> dict:
    """``ttl`` of ``session.created``/``session.resumed``/``session.renewed`` (defs.schema.json)."""
    return {"graceS": grace_s, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120}


def created(
    reply_to: str = "p-1",
    *,
    code: str = CODE,
    session_id: str = SESSION_ID,
    token: str = TOKEN,
    grace_s: int = 120,
    **limits: int,
) -> dict:
    """``session.created`` (protocol §4.2); ``limits`` override the announced ``limits``."""
    return envelope.make(
        "session.created",
        reply_to=reply_to,
        sessionId=session_id,
        code=code,
        publisherToken=token,
        viewerLimit=20,
        ttl=ttl(grace_s),
        limits={**LIMITS, **limits},
    )


def resumed(  # noqa: PLR0913
    reply_to: str | None,
    *,
    scene_version: int,
    snapshot_version: int | None,
    viewer_count: int = 0,
    code: str = CODE,
    session_id: str = SESSION_ID,
    grace_s: int = 120,
) -> dict:
    """``session.resumed`` (protocol §4.3)."""
    return envelope.make(
        "session.resumed",
        reply_to=reply_to,
        sessionId=session_id,
        code=code,
        sceneVersion=scene_version,
        snapshotVersion=snapshot_version,
        viewerCount=viewer_count,
        ttl=ttl(grace_s),
    )


def relay_error(
    code: str, reply_to: str | None = None, *, retryable: bool = False, **details
) -> dict:
    """A relay ``error`` (protocol §9.2) with a fixed free text."""
    message = envelope.make(
        "error", reply_to=reply_to, code=code, message=f"{code} for test", retryable=retryable
    )
    if details:
        message["details"] = details
    return message


def live_client(profile: str = "mobile", *, validate=None, **limits: int) -> ProtocolClient:
    """A client whose session the relay created (``limits`` override the announced ones); no snapshot yet."""
    client = ProtocolClient(
        make_client_info("5.12.4", "win32"), validate=validate, auto_renew=False
    )
    client.start(profile)
    client.handle(created(**limits))
    assert client.state is SessionState.CREATED
    return client


def ack(version: int) -> dict:
    return envelope.make(
        "scene.snapshot.ack", sceneVersion=version, viewersStreamed=0, viewersDeferred=0
    )


def viewer_count(count: int) -> dict:
    platforms = {"ios": count} if count else {}
    return envelope.make("viewer.count", viewerCount=count, viewerLimit=20, platforms=platforms)


def deliver(ctl: Any, *events) -> Any:
    """Queue ``events`` on the newest fake transport and pump the controller once."""
    transport = FakeTransport.made[-1]
    for event in events:
        transport.events.put(event)
    return ctl.pump()


def parent_widget():
    from unittest import mock  # noqa: PLC0415

    return mock.MagicMock(name="parentWidget")


# --------------------------------------------------------------------------- scenes and MRML nodes


def sphere(resolution: int = 16):
    """A sphere of radius 20 mm at R+100 mm (an off-centre mesh shows axis mix-ups)."""
    source = vtkSphereSource()
    source.SetRadius(20.0)
    source.SetCenter(100.0, 0.0, 0.0)
    source.SetThetaResolution(resolution)
    source.SetPhiResolution(resolution)
    source.Update()
    return source.GetOutput()


def specked(resolution: int, specks: int = 6):
    """``sphere(resolution)`` and ``specks`` spheres of 16 triangles beside it, as one mesh: small islands of a body
    from ``sphere(32)`` (1,920 triangles, of which 1 % is 19.2) up (SLC-53)."""
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


class FakeScene:
    """A :class:`~remoteview_core.collect.SceneApi` over plain dicts (the MRML adapter is SLC-22's). A dict with a
    ``"segment"`` key (the raw segment ID) is a segment of the segmentation node ``id``; the others are models."""

    def __init__(self, *nodes: dict) -> None:
        self.nodes = list(nodes)
        self.asked = 0

    def visible_model_nodes(self):
        self.asked += 1
        return [n for n in self.nodes if "segment" not in n]

    def visible_segments(self):
        return [n for n in self.nodes if "segment" in n]

    def node_id(self, node):
        return node["id"]

    def segment_identity(self, node):
        return node["id"], node["segment"]

    def name(self, node):
        return node.get("name", "Liver")

    def polydata(self, node):
        return node.get("mesh")

    def display_props(self, node):
        return (0.8, 0.3, 0.2), 1.0, True

    def world_matrix(self, node):
        return np.eye(4)

    def world_transform(self, node):
        return None


def flying_edges(mask, spacing: float):
    """The ``vtkDiscreteFlyingEdges3D`` surface of a boolean ``(z, y, x)`` labelmap with isotropic ``spacing`` (mm),
    unsmoothed, like a segmentation's closed surface before Slicer's smoothing."""
    image = vtkImageData()
    image.SetDimensions(*mask.shape[::-1])
    image.SetSpacing(spacing, spacing, spacing)
    image.GetPointData().SetScalars(
        numpy_to_vtk(np.ascontiguousarray(mask, dtype=np.uint8).ravel(), deep=True)
    )
    surface = vtkDiscreteFlyingEdges3D()
    surface.SetInputData(image)
    surface.SetValue(0, 1)
    surface.Update()
    return surface.GetOutput()


def mesh_entity(positions, triangles, normals=None) -> Entity:
    """A model entity over ``positions``/``triangles`` (glTF metres; +Y normals unless given), for decimation tests
    that build their mesh directly."""
    positions = np.asarray(positions, dtype=np.float64)
    if normals is None:
        normals = np.tile([0.0, 1.0, 0.0], (len(positions), 1))
    return Entity(
        node_id="vtkMRMLModelNode4",
        kind="model",
        name="Mesh",
        positions=positions,
        normals=np.asarray(normals, dtype=np.float64),
        indices=np.asarray(triangles, dtype=np.int64).reshape(-1, 3),
        color=(0.5, 0.5, 0.5),
        opacity=1.0,
        visible=True,
        mrml_id="vtkMRMLModelNode4",
    )


def face_normals(positions, triangles):
    """The unnormalised face normal (winding) of every triangle."""
    p, t = np.asarray(positions), np.asarray(triangles)
    return np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])


def normal_opposes_face(entity) -> float:
    """The share of triangles whose mean vertex normal opposes their face normal: they shade dark, or vanish under
    the viewer's back-face culling (the GLB material is ``doubleSided`` false)."""
    mean = np.asarray(entity.normals)[entity.indices].mean(axis=1)
    face = face_normals(entity.positions, entity.indices)
    return float(np.mean(np.einsum("ij,ij->i", mean, face) < 0))


@functools.cache
def small_sphere():
    """One shared coarse sphere (``sphere(8)``): :class:`LiveScene`'s default mesh."""
    return sphere(8)


class LiveScene:
    """A :class:`~remoteview_core.collect.SceneApi` whose nodes change between calls, like a live MRML scene: each
    node is a dict with ``id``, ``name``, ``color``, ``opacity``, ``visible`` (shown in 3D), ``world`` (RAS matrix,
    ``None`` for a non-linear chain), ``warp`` (that chain's transform, or ``None``) and ``mesh``; a dict with a
    ``"segment"`` key (the raw segment ID) is a segment of the segmentation node ``id``. ``meshes`` counts the mesh
    reads (the classifier makes none; it may count cells of a node left out without triangles)."""

    def __init__(self, *nodes: dict) -> None:
        self.nodes = [{**self._defaults(), **n} for n in nodes]
        self.meshes = 0

    @staticmethod
    def _defaults() -> dict:
        return {
            "name": "Liver",
            "color": (0.8, 0.3, 0.2),
            "opacity": 1.0,
            "visible": True,
            "world": np.eye(4),  # one array per node
            "warp": None,
            "mesh": small_sphere(),
        }

    def node(self, node_id: str) -> dict:
        return next(n for n in self.nodes if n["id"] == node_id)

    def segment(self, node_id: str, segment_id) -> dict:
        return next(n for n in self.nodes if n["id"] == node_id and n.get("segment") == segment_id)

    def place(self, node_id: str, **props) -> None:
        """Set ``props`` on every dict of the node ``node_id`` — a segmentation node's ``world``/``warp`` are shared by
        all its segments (their transform is the node's, SLC-13)."""
        for node in self.nodes:
            if node["id"] == node_id:
                node.update(props)

    def add(self, node_id: str, **props) -> None:
        self.nodes.append({**self._defaults(), "id": node_id, **props})

    def remove(self, node_id: str, segment_id=None) -> None:
        """Remove the node, or one segment of it when ``segment_id`` is given."""
        self.nodes = [
            n
            for n in self.nodes
            if n["id"] != node_id or (segment_id is not None and n.get("segment") != segment_id)
        ]

    def visible_model_nodes(self):
        return [n for n in self.nodes if n["visible"] and "segment" not in n]

    def visible_segments(self):
        return [n for n in self.nodes if n["visible"] and "segment" in n]

    def node_id(self, node):
        return node["id"]

    def segment_identity(self, node):
        return node["id"], node["segment"]

    def name(self, node):
        return node["name"]

    def polydata(self, node):
        self.meshes += 1
        return node["mesh"]

    def display_props(self, node):
        return node["color"], node["opacity"], node["visible"]

    def world_matrix(self, node):
        return node["world"]

    def world_transform(self, node):
        return node["warp"]


MODEL_DISPLAY = ("vtkMRMLModelDisplayNode", "vtkMRMLDisplayNode", "vtkMRMLNode")
SLICE_DISPLAY = ("vtkMRMLSliceDisplayNode", *MODEL_DISPLAY)
LEGEND_DISPLAY = ("vtkMRMLColorLegendDisplayNode", "vtkMRMLDisplayNode", "vtkMRMLNode")


class FakeDisplay:
    """A display node: ``IsA`` walks ``classes`` like VTK's class hierarchy."""

    def __init__(  # noqa: PLR0913 — one keyword per MRML property
        self,
        classes=MODEL_DISPLAY,
        *,
        visible=1,
        visible_3d=1,
        color=(1.0, 0.5, 0.25),
        opacity=0.8,
        views=(),
        folders_apply=True,
    ):
        self.classes, self.visible, self.visible_3d = classes, visible, visible_3d
        self.color, self.opacity, self.views, self.folders_apply = (
            color,
            opacity,
            views,
            folders_apply,
        )

    def IsA(self, name):  # noqa: N802 — MRML's names
        return int(name in self.classes)

    def GetVisibility(self):  # noqa: N802
        return self.visible

    def GetVisibility3D(self):  # noqa: N802
        return self.visible_3d

    def GetColor(self):  # noqa: N802
        return self.color

    def GetOpacity(self):  # noqa: N802
        return self.opacity

    def GetNumberOfViewNodeIDs(self):  # noqa: N802
        return len(self.views)

    def IsDisplayableInView(self, view_id):  # noqa: N802
        return not self.views or view_id in self.views

    def GetFolderDisplayOverrideAllowed(self):  # noqa: N802
        return self.folders_apply


class FakeMrmlTransform:
    def __init__(self, matrix=None, warp=None):
        self.matrix = matrix  # None = non-linear chain
        self.warp = warp  # the VTK transform of a non-linear chain
        self.asked = 0

    def IsTransformToWorldLinear(self):  # noqa: N802
        return int(self.matrix is not None)

    def GetMatrixTransformToWorld(self, out):  # noqa: N802
        self.asked += 1
        out.DeepCopy([v for row in self.matrix for v in row])
        return 1

    def GetTransformToWorld(self, out):  # noqa: N802
        if self.warp is not None:
            out.Concatenate(self.warp)


class FakeModel:
    def __init__(  # noqa: PLR0913
        self,
        node_id,
        *,
        name="Liver",
        displays=(),
        cls="vtkMRMLModelNode",
        hidden_from_editors=0,
        transform=None,
        polydata=None,
    ):
        self.node_id, self.node_name, self.displays, self.cls = node_id, name, list(displays), cls
        self.hidden_from_editors, self.transform, self.mesh = (
            hidden_from_editors,
            transform,
            polydata,
        )

    def GetClassName(self):  # noqa: N802
        return self.cls

    def GetHideFromEditors(self):  # noqa: N802
        return self.hidden_from_editors

    def GetNumberOfDisplayNodes(self):  # noqa: N802
        return len(self.displays)

    def GetNthDisplayNode(self, index):  # noqa: N802
        return self.displays[index]

    def GetID(self):  # noqa: N802
        return self.node_id

    def GetName(self):  # noqa: N802
        return self.node_name

    def GetPolyData(self):  # noqa: N802
        return self.mesh

    def GetParentTransformNode(self):  # noqa: N802
        return self.transform


class FakeView:
    def __init__(self, view_id):
        self.view_id = view_id

    def GetID(self):  # noqa: N802
        return self.view_id


class MrmlModel(FakeModel, vtkObject):
    """A model node read by both the scene adapter (the export) and the observers (VTK's own event dispatch), so a mark
    and the export always see the same scene. ``FakeModel`` first: its ``GetClassName`` wins over VTK's."""

    def __init__(self, node_id, **kw):
        kw.setdefault("displays", [FakeDisplay()])
        kw.setdefault("polydata", sphere(8))
        FakeModel.__init__(self, node_id, **kw)
        self.in_scene = True

    def IsA(self, name):  # noqa: N802 — MRML's names
        return int(name == self.cls)

    def GetScene(self):  # noqa: N802
        return object() if self.in_scene else None


class MrmlView(FakeView):
    def IsA(self, name):  # noqa: N802
        return int(name == "vtkMRMLViewNode")


SEGMENTATION_DISPLAY = ("vtkMRMLSegmentationDisplayNode", "vtkMRMLDisplayNode", "vtkMRMLNode")


class FakeSegment:
    """One ``vtkSegment``: its name, stored colour and the polydata of its 3D representation."""

    def __init__(self, segment_id, *, name="Liver", color=(0.5, 0.2, 0.1), polydata=None):
        self.segment_id, self.segment_name, self.color, self.mesh = (
            segment_id,
            name,
            color,
            polydata,
        )

    def GetName(self):  # noqa: N802
        return self.segment_name

    def GetColor(self):  # noqa: N802
        return self.color


class FakeVtkSegmentation:
    """``vtkSegmentation``: the segments in order, their 3D representation read-only; ``created`` records every
    ``CreateRepresentation`` call (the exporter must make none)."""

    def __init__(self, segments=()):
        self.segments = list(segments)
        self.created: list[str] = []
        self.representation_reads: list[tuple] = []

    def GetSegmentIDs(self):  # noqa: N802
        return tuple(s.segment_id for s in self.segments)

    def GetNumberOfSegments(self):  # noqa: N802
        return len(self.segments)

    def GetNthSegmentID(self, index):  # noqa: N802
        return self.segments[index].segment_id

    def GetSegment(self, segment_id):  # noqa: N802
        return next((s for s in self.segments if s.segment_id == segment_id), None)

    def GetSegmentRepresentation(self, segment_id, name):  # noqa: N802
        self.representation_reads.append((segment_id, name))
        segment = self.GetSegment(segment_id)
        return None if segment is None else segment.mesh

    def CreateRepresentation(self, name):  # noqa: N802
        self.created.append(name)
        return True


class FakeSegDisplay:
    """A ``vtkMRMLSegmentationDisplayNode``: the node-level properties plus ``per_segment[sid]`` dicts with
    ``visible``, ``visible_3d``, ``opacity_3d`` and ``override_color`` (what ``GetSegmentColor`` returns; the
    one-argument ``vtkVector3d`` overload, as a 3-sequence). ``IsA`` walks ``classes`` like VTK's hierarchy."""

    def __init__(  # noqa: PLR0913 — one keyword per MRML property
        self,
        classes=SEGMENTATION_DISPLAY,
        *,
        visible=1,
        visible_3d=1,
        opacity=1.0,
        opacity_3d=1.0,
        views=(),
        folders_apply=True,
        representation_3d="Closed surface",
        per_segment=None,
    ):
        self.classes, self.visible, self.visible_3d = classes, visible, visible_3d
        self.opacity, self.opacity_3d, self.views = opacity, opacity_3d, views
        self.folders_apply, self.representation_3d = folders_apply, representation_3d
        self.per_segment = dict(per_segment or {})
        self.asked: list[Any] = []  # the IDs the per-segment getters were asked with

    def _props(self, segment_id):
        self.asked.append(segment_id)
        return self.per_segment.get(segment_id, {})

    def IsA(self, name):  # noqa: N802 — MRML's names
        return int(name in self.classes)

    def GetVisibility(self):  # noqa: N802
        return self.visible

    def GetVisibility3D(self):  # noqa: N802
        return self.visible_3d

    def GetOpacity(self):  # noqa: N802
        return self.opacity

    def GetOpacity3D(self):  # noqa: N802
        return self.opacity_3d

    def GetNumberOfViewNodeIDs(self):  # noqa: N802
        return len(self.views)

    def IsDisplayableInView(self, view_id):  # noqa: N802
        return not self.views or view_id in self.views

    def GetFolderDisplayOverrideAllowed(self):  # noqa: N802
        return self.folders_apply

    def GetDisplayRepresentationName3D(self):  # noqa: N802
        return self.representation_3d

    def GetSegmentVisibility(self, segment_id):  # noqa: N802
        return int(self._props(segment_id).get("visible", 1))

    def GetSegmentVisibility3D(self, segment_id):  # noqa: N802
        return int(self._props(segment_id).get("visible_3d", 1))

    def GetSegmentOpacity3D(self, segment_id):  # noqa: N802
        return self._props(segment_id).get("opacity_3d", 1.0)

    def GetSegmentColor(self, segment_id):  # noqa: N802 — the one-argument overload only
        return self._props(segment_id).get("override_color", (0.5, 0.2, 0.1))


class FakeSegmentation:
    """A ``vtkMRMLSegmentationNode`` as the adapter reads it."""

    def __init__(  # noqa: PLR0913
        self,
        node_id,
        *,
        name="Segmentation",
        cls="vtkMRMLSegmentationNode",
        hidden_from_editors=0,
        displays=(),
        transform=None,
        segments=(),
    ):
        self.node_id, self.node_name, self.cls = node_id, name, cls
        self.hidden_from_editors, self.displays, self.transform = (
            hidden_from_editors,
            list(displays),
            transform,
        )
        self.segmentation = FakeVtkSegmentation(segments)

    def GetID(self):  # noqa: N802
        return self.node_id

    def GetName(self):  # noqa: N802
        return self.node_name

    def GetClassName(self):  # noqa: N802
        return self.cls

    def GetHideFromEditors(self):  # noqa: N802
        return self.hidden_from_editors

    def GetNumberOfDisplayNodes(self):  # noqa: N802
        return len(self.displays)

    def GetNthDisplayNode(self, index):  # noqa: N802
        return self.displays[index]

    def GetParentTransformNode(self):  # noqa: N802
        return self.transform

    def GetSegmentation(self):  # noqa: N802
        return self.segmentation


class MrmlSegmentation(FakeSegmentation, vtkObject):
    """A segmentation node read by both the scene adapter (the export) and the observers (VTK's own event dispatch),
    like :class:`MrmlModel`: ``segments`` holds :class:`FakeSegment` objects with a sphere each by default, under one
    :class:`FakeSegDisplay`. :meth:`fire` invokes a ``vtkSegmentation`` event by Slicer's attribute name or the
    watcher's field name, with the segment ID as call data or without (NULL)."""

    def __init__(self, node_id, **kw):
        kw.setdefault("displays", [FakeSegDisplay()])
        if "segments" not in kw:
            kw["segments"] = [
                FakeSegment("Segment_1", name="Liver", polydata=sphere(8)),
                FakeSegment("Segment_2", name="Spleen", polydata=sphere(8)),
            ]
        FakeSegmentation.__init__(self, node_id, **kw)
        self.in_scene = True

    def IsA(self, name):  # noqa: N802 — MRML's names
        return int(name == self.cls)

    def GetScene(self):  # noqa: N802
        return object() if self.in_scene else None

    def add_segment(self, segment, *, fire=True):
        """Append ``segment`` and (unless ``fire`` is false) invoke ``SegmentAdded`` with its ID."""
        self.segmentation.segments.append(segment)
        if fire:
            self.fire("SegmentAdded", segment.segment_id)

    def remove_segment(self, segment_id, *, fire=True):
        self.segmentation.segments = [
            s for s in self.segmentation.segments if s.segment_id != segment_id
        ]
        if fire:
            self.fire("SegmentRemoved", segment_id)

    def fire(self, name: str, segment_id=None) -> None:
        from mrml_fakes import event_id  # noqa: PLC0415 — test modules on the same path

        if segment_id is None:
            self.InvokeEvent(event_id(name))
        else:
            self.InvokeEvent(event_id(name), segment_id)


class FakeFolders:
    """``slicer.vtkMRMLFolderDisplayNode``'s static methods, per model or segmentation node."""

    def __init__(self, hidden=(), opacity=None, overriding=None):
        self.hidden, self.opacity, self.overriding = set(hidden), opacity or {}, overriding or {}

    def GetHierarchyVisibility(self, node):  # noqa: N802
        return node.node_id not in self.hidden

    def GetHierarchyOpacity(self, node):  # noqa: N802
        return self.opacity.get(node.node_id, 1.0)

    def GetOverridingHierarchyDisplayNode(self, node):  # noqa: N802
        return self.overriding.get(node.node_id)


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


def glb_json(glb: bytes) -> dict:
    """The parsed JSON chunk of a GLB."""
    json_length, json_type = struct.unpack_from("<II", glb, 12)
    assert json_type == 0x4E4F534A
    return json.loads(glb[20 : 20 + json_length])


def glb_strings(glb: bytes) -> list[str]:
    """Every string value (and key) anywhere in the JSON chunk — what §7.3's anonymised-names promise is about."""
    found: list[str] = []

    def walk(value) -> None:
        if isinstance(value, str):
            found.append(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                found.append(key)
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(glb_json(glb))
    return found


def glb_container(document: dict, binary: bytes = b"") -> bytes:
    """A GLB of ``document`` (its JSON chunk padded with spaces) and an optional BIN chunk (§7.1)."""
    text = json.dumps(document).encode()
    text += b" " * (-len(text) % 4)
    chunks = struct.pack("<II", len(text), 0x4E4F534A) + text
    if binary:
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks


def minimal_glb(scene_version: int) -> bytes:
    """The smallest GLB whose root says what a ``scene.snapshot.begin`` for it must say (§6.2, SLC-38): one scene, the
    root's extras with ``sceneVersion`` and profile ``mobile``, and one ``T`` node of 12 triangles."""
    root = {
        "name": "SlicerRemoteView",
        "extras": {
            "nodeId": "root",
            "kind": "root",
            "sceneVersion": scene_version,
            "profile": "mobile",
        },
        "children": [1],
    }
    t_node = {"extras": {"nodeId": "vtkMRMLModelNode1", "triangleCount": 12}}
    document = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [root, t_node],
    }
    return glb_container(document)


def rewrite_json(glb: bytes, edit) -> bytes:
    """``glb`` with its JSON document changed in place by ``edit(document)`` (the BIN chunk kept)."""
    document = glb_json(glb)
    edit(document)
    json_length = struct.unpack_from("<I", glb, 12)[0]
    rest = glb[20 + json_length :]
    binary = rest[8 : 8 + struct.unpack_from("<I", rest, 0)[0]] if rest else b""
    return glb_container(document, binary)


def _root_node(document: dict) -> dict:
    [root] = [n for n in document["nodes"] if n.get("name") == "SlicerRemoteView"]
    return root


def restamped(glb: bytes, scene_version: int, profile: str = "mobile") -> bytes:
    """``glb`` with its root's ``extras.sceneVersion``/``profile`` set: a fixture sent as a later snapshot or for
    another profile (§6.2: the ``begin`` names the root's figures)."""
    stamp = {"sceneVersion": scene_version, "profile": profile}
    if _root_node(glb_json(glb))["extras"].items() >= stamp.items():
        return glb
    return rewrite_json(glb, lambda document: _root_node(document)["extras"].update(stamp))


def root_extras(glb: bytes) -> dict:
    return _root_node(glb_json(glb))["extras"]


def manifest(glb: bytes) -> list[dict]:
    """The ``T.extras`` of every exported node (§7.3), in file order."""
    return [
        n["extras"]
        for n in glb_json(glb)["nodes"]
        if n.get("name") != "SlicerRemoteView" and "nodeId" in n.get("extras", {})
    ]
