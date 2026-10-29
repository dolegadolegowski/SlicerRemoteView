"""SLC-08: relay transport — one WebSocket in a worker thread (ADR 0009; protocol §3, §9.1, §9.3)."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import queue
import random
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time
from http import HTTPStatus
from pathlib import Path

import pytest
from websockets.datastructures import Headers
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidMessage,
    InvalidProxy,
    InvalidProxyStatus,
    InvalidStatus,
)
from websockets.frames import Close
from websockets.http11 import Response
from websockets.sync.server import serve

import remoteview_core
from remoteview_core import transport
from remoteview_core.transport import (
    Connected,
    Disconnected,
    ErrorKind,
    Received,
    RelayTransport,
    TlsError,
    TransportError,
    check_relay_url,
    classify,
)
from remoteview_core.vendored import chunk_header  # noqa: F401 — registers the vendored protocol package
from remoteview_protocol import schemas

# --------------------------------------------------------------------------- fake relay and helpers


_RELAY_LOGGER = logging.getLogger("test_transport.fake_relay")
# the relay side is scaffolding: only the transport's logs are checked
_RELAY_LOGGER.setLevel(logging.CRITICAL)


class FakeRelay:
    """A ``websockets`` sync server in a thread. ``received`` holds ``(connection number, message)`` for every
    frame the transport sent (text parsed as JSON); ``client_close_codes`` the close codes the transport sent."""

    def __init__(
        self,
        behaviour: str = "echo",
        *,
        tls=None,
        process_request=None,
        max_queue=16,
        read_bytes_per_s: float = 0,
    ) -> None:
        self.behaviour = behaviour
        #: ``slow-pong``/``slow-silent``: each frame takes its size in bytes / ``read_bytes_per_s`` s to read, in
        #: order — a ping sent behind a chunk is answered only after the chunk (the peer of a slow uplink)
        self.read_bytes_per_s = read_bytes_per_s
        self._log: list[
            tuple[int, object, float]
        ] = []  # (connection, message, time.monotonic()), one append each
        self.client_close_codes: list[int | None] = []
        self.connections = 0
        self.release = threading.Event()  # ends the "stuck" handlers
        self.last_ping: str | None = None  # chatter-late-pong
        self._server = serve(
            self._handle,
            "127.0.0.1",
            0,
            compression=None,
            max_size=transport.MAX_INBOUND_BYTES,
            max_queue=max_queue,
            ssl=tls,
            process_request=process_request,
            logger=_RELAY_LOGGER,
            close_timeout=1,
        )
        self.port = self._server.socket.getsockname()[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    @property
    def received(self) -> list[tuple[int, object]]:
        return [(number, message) for number, message, _ in list(self._log)]

    def ping_times(self, connection: int | None = None) -> list[float]:
        """When the relay read each ``ping`` (of one connection, or all)."""
        return [
            at
            for number, message, at in list(self._log)
            if isinstance(message, dict)
            and message.get("type") == "ping"
            and connection in (None, number)
        ]

    def chunk_times(self) -> list[float]:
        """When the relay read each binary frame."""
        return [at for _, message, at in list(self._log) if isinstance(message, bytes)]

    def url(self, scheme: str = "ws", host: str = "127.0.0.1") -> str:
        return f"{scheme}://{host}:{self.port}/ws"

    def shutdown(self) -> None:
        self.release.set()
        self._server.shutdown()

    def _handle(self, ws) -> None:
        self.connections += 1
        number = self.connections
        if self.behaviour == "stuck":  # never reads: the transport's sends back up
            self.release.wait(30)
            return
        try:
            for frame in ws:
                message = json.loads(frame) if isinstance(frame, str) else frame
                if self.read_bytes_per_s:
                    size = len(frame.encode()) if isinstance(frame, str) else len(frame)
                    time.sleep(size / self.read_bytes_per_s)
                self._log.append((number, message, time.monotonic()))
                self._answer(ws, number, frame, message)
        except ConnectionClosed:
            pass
        finally:
            self.client_close_codes.append(
                ws.protocol.close_rcvd.code if ws.protocol.close_rcvd else None
            )

    def _answer(self, ws, number, frame, message) -> None:
        if self.behaviour == "echo":
            ws.send(frame)
        elif (
            self.behaviour in ("pong", "slow-pong", "pong-once", "pong-then-close")
            and isinstance(message, dict)
            and message.get("type") == "ping"
        ):
            if self.behaviour == "pong-once":
                # the first ping is answered, the next ones are not
                self.behaviour = "silent"
            ws.send(
                json.dumps({"protocolVersion": "1.0", "type": "pong", "replyTo": message["id"]})
            )
            if self.behaviour == "pong-then-close" and number == 1:
                ws.close(1011, "test")
        elif (
            self.behaviour.startswith("chatter")
            and isinstance(message, dict)
            and message.get("type") == "ping"
        ):
            self._chatter(ws, message["id"])
        elif (
            self.behaviour == "foreign-pong"
            and isinstance(message, dict)
            and message.get("type") == "ping"
        ):
            # while the transport's ping is outstanding: a pong that answers something else
            ws.send(json.dumps({"protocolVersion": "1.0", "type": "pong", "replyTo": "c-7"}))
        elif self.behaviour == "junk" and number == 1 and len(self.received) == 1:
            for text in ("not json", "[1]", "null", '{"type": "ok"}'):
                ws.send(text)
        elif self.behaviour == "error-open":  # an error that leaves the socket open
            ws.send(json.dumps({"protocolVersion": "1.0", "type": "error", "code": "CAPACITY",
                                "message": "busy", "retryable": True}))  # fmt: skip
        elif self.behaviour.startswith("rate-limited"):  # rate-limited-<retryAfterS>
            retry_after = int(self.behaviour.removeprefix("rate-limited-"))
            error = {"protocolVersion": "1.0", "type": "error", "code": "RATE_LIMITED", "message": "slow down",
                     "retryable": True, "details": {"retryAfterS": retry_after}}  # fmt: skip
            ws.send(json.dumps(error))
            ws.close(4006, "rate limited")
        elif self.behaviour.startswith("close-") and (
            self.behaviour != "close-first" or number == 1
        ):
            code = (
                1011
                if self.behaviour == "close-first"
                else int(self.behaviour.removeprefix("close-"))
            )
            ws.close(code, "test")

    def _chatter(self, ws, ping: str) -> None:
        # anything but the pong: the downlink is alive, the relay does not say it read the bytes before the ping
        if self.behaviour == "chatter-binary":
            ws.send(bytes(12))
        else:
            ws.send(
                json.dumps({"protocolVersion": "1.0", "type": "viewer.count", "viewerCount": 0})
            )
        if self.behaviour == "chatter-pong":
            # the pong follows, late
            time.sleep(0.2)
            ws.send(json.dumps({"protocolVersion": "1.0", "type": "pong", "replyTo": ping}))
        elif self.behaviour == "chatter-late-pong":
            # each ping's pong comes after the next ping
            if self.last_ping is not None:
                ws.send(
                    json.dumps(
                        {"protocolVersion": "1.0", "type": "pong", "replyTo": self.last_ping}
                    )
                )
            self.last_ping = ping


class TopRandom:
    """Every draw at the top of its range (deterministic jitter)."""

    def uniform(self, low: float, high: float) -> float:
        return high


@pytest.fixture
def relay():
    started: list[FakeRelay] = []

    def start(*args, **kwargs) -> FakeRelay:
        started.append(FakeRelay(*args, **kwargs))
        return started[-1]

    yield start
    for server in started:
        server.shutdown()


@pytest.fixture
def make_transport():
    made: list[RelayTransport] = []

    def make(url: str, **kwargs) -> tuple[RelayTransport, queue.Queue]:
        events: queue.Queue = queue.Queue()
        made.append(RelayTransport(url, events, use_proxy=False, **kwargs))
        made[-1].start()
        return made[-1], events

    yield make
    for item in made:
        assert item.stop(timeout=10)


def next_event(events: queue.Queue, kind: type | None = None, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while True:
        try:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty:
            raise AssertionError(
                f"no {kind.__name__ if kind else 'event'} within {timeout} s"
            ) from None
        if kind is None or isinstance(event, kind):
            return event


def wait_until(condition, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.01)


def drain(events: queue.Queue) -> list:
    items = []
    while not events.empty():
        items.append(events.get_nowait())
    return items


def recording_sleep(delays: list[float], real_after: int = 4):
    """A backoff wait that returns at once (the patched sleep of criterion 1) and then blocks until stop()."""

    async def sleep(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0 if len(delays) < real_after else 3600)

    return sleep


@pytest.fixture(scope="module")
def certs(tmp_path_factory):
    """Self-signed certificates made with the openssl CLI (the dev venv has no `cryptography`)."""
    openssl = shutil.which("openssl")
    if openssl is None:  # CI sets REMOTEVIEW_REQUIRE_OPENSSL=1 so criterion 3 cannot skip silently
        if os.environ.get("REMOTEVIEW_REQUIRE_OPENSSL") == "1":
            pytest.fail("REMOTEVIEW_REQUIRE_OPENSSL=1 but the openssl CLI is missing")
        pytest.skip("openssl CLI not available")
    directory = tmp_path_factory.mktemp("certs")

    def make(name: str, san: str) -> tuple[Path, Path]:
        cert, key = directory / f"{name}.pem", directory / f"{name}.key"
        subprocess.run(
            [openssl, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "2",
             "-subj", "/CN=RemoteView test relay", "-addext", f"subjectAltName={san}"],
            check=True,
            capture_output=True,
            timeout=60,
        )  # fmt: skip
        return cert, key

    return {
        "local": make("local", "DNS:localhost,IP:127.0.0.1"),
        "other": make("other", "DNS:relay.invalid"),
    }


def server_tls(cert_and_key) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(*cert_and_key)
    return context  # TLS 1.3 with the default 2 session tickets: what stalled the sync client (ADR 0009)


# --------------------------------------------------------------------------- criterion 1: frames and backoff


def test_transport_round_trips_text_and_1mib_binary_in_order(relay, make_transport):
    server = relay("echo")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    chunk = bytes(range(256)) * 4096 + b"\x00" * 12  # 1 MiB payload + 12-byte header (§3.3)
    frames = [
        {"type": "session.create", "n": 1},
        chunk,
        '{"type":"scene.snapshot.end"}',
        chunk[::-1],
    ]
    for frame in frames:
        assert client.send(frame, connection=connection)
    got = [next_event(events, Received).message for _ in frames]
    assert got == [frames[0], chunk, {"type": "scene.snapshot.end"}, chunk[::-1]]
    # the transport's own pings aside (one goes out of cycle after 2 MiB written, §9.1)
    sent = [m for _, m in server.received if not (isinstance(m, dict) and m.get("type") == "ping")]
    assert sent == got


def test_transport_reconnects_with_exponential_backoff(relay, make_transport):
    delays: list[float] = []
    server = relay("echo")
    _, events = make_transport(server.url(), sleep=recording_sleep(delays), rng=random.Random(7))  # noqa: S311 — jitter, not crypto
    assert next_event(events, Connected).connection == 1
    server.shutdown()  # 1001 to the open connection, then nothing listens on the port
    drops = [next_event(events, Disconnected) for _ in range(4)]
    assert (drops[0].connection, drops[0].error.kind, drops[0].close_code) == (
        1,
        ErrorKind.CLOSED,
        1001,
    )
    assert [d.connection for d in drops[1:]] == [None] * 3
    assert {d.error.kind for d in drops[1:]} == {ErrorKind.REFUSED}
    retry = [d.retry_in for d in drops]
    # ≈ 0.5, 1, 2 s
    assert 0.4 <= retry[0] <= 0.6 and 0.8 <= retry[1] <= 1.2 and 1.6 <= retry[2] <= 2.4
    wait_until(lambda: len(delays) >= 4)  # the worker calls sleep() just after it emits the event
    assert delays[:4] == retry


def test_transport_backoff_schedule():
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), rng=random.Random(1))  # noqa: S311
    network = TransportError(ErrorKind.NETWORK, retryable=True)
    failures, jittered = 0, []
    for n in range(12):  # ≈ 0.5, 1, 2 … s, capped at 30 s, ±20 %
        delay, failures = client._backoff(network, failures, 0.0)
        base = min(30.0, 0.5 * 2**n)
        assert 0.8 * base <= delay <= min(30.0, 1.2 * base) and failures == n + 1
        jittered.append(delay != base)
    assert all(jittered[:6])  # §9.1 "with jitter" (only the capped tail may hit 30 s exactly)
    # a connection that stayed up 30 s resets the backoff
    delay, failures = client._backoff(network, 9, 30.0)
    assert 0.4 <= delay <= 0.6 and failures == 1
    assert client._backoff(network, 9, 29.0)[0] >= 24.0
    restarting = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4008)
    # §9.3: 0–3 s with jitter, then a fresh backoff
    delay, failures = client._backoff(restarting, 9, 0.0)
    assert 0.0 <= delay <= 3.0 and failures == 0
    other = RelayTransport("wss://relay.example.org/ws", queue.Queue(), rng=random.Random(3))  # noqa: S311
    assert other._backoff(restarting, 9, 0.0)[0] != delay
    assert 0.4 <= client._backoff(network, failures, 0.0)[0] <= 0.6
    assert (
        client._backoff(TransportError(ErrorKind.TLS_CERTIFICATE, retryable=False), 0, 0.0)[0]
        is None
    )


@pytest.mark.parametrize(
    ("details", "floor"),
    [({"retryAfterS": 600}, 600.0), ({"retryAfterS": 1e9}, 3600.0), ({"retryAfterS": 2.5}, 2.5),
     ({"retryAfterS": 10**400}, 3600.0), ({"retryAfterS": True}, None), ({"retryAfterS": "600"}, None),
     ({"retryAfterS": float("nan")}, None), ({"retryAfterS": -(10**400)}, 0.0),
     ({"retryAfterS": -5}, 0.0), (None, None), ([600], None)],
)  # fmt: skip
def test_transport_retry_after_is_a_bounded_floor_used_once(details, floor):
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), rng=random.Random(2))  # noqa: S311
    network = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4006)
    client._note_retry_after(details)
    delay, _ = client._backoff(network, 0, 0.0)
    if floor is not None and floor > 0.6:
        assert delay == floor
    else:  # ignored (or below the backoff anyway)
        assert delay <= 0.6
    assert client._backoff(network, 0, 0.0)[0] <= 0.6  # used once


def test_transport_retry_after_is_a_floor_and_the_last_error_replaces_it():
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), rng=random.Random(5))  # noqa: S311
    rate_limited = TransportError(ErrorKind.CLOSED, retryable=True, close_code=4006)
    client._note_retry_after({"retryAfterS": 2})
    # a floor under the backoff (≈ 16 s), not a value
    assert client._backoff(rate_limited, 5, 0.0)[0] >= 12.8
    client._note_retry_after({"retryAfterS": 900})
    client._note_retry_after({"viewerLimit": 20})  # the relay's last error carries no retryAfterS
    assert client._backoff(rate_limited, 0, 0.0)[0] <= 0.6


@pytest.mark.parametrize("close_code", [1011, 4009, None])
def test_transport_retry_after_applies_only_to_4005_and_4006(close_code):
    """An error that kept the socket open (e.g. CAPACITY on scene.snapshot.begin) must not slow down the reconnect
    after a later, unrelated drop: the 120 s publisher grace would run out (§9.1, §9.3)."""
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), rng=random.Random(4))  # noqa: S311
    client._note_retry_after({"retryAfterS": 900})
    kind = ErrorKind.NETWORK if close_code is None else ErrorKind.CLOSED
    assert (
        client._backoff(TransportError(kind, retryable=True, close_code=close_code), 0, 0.0)[0]
        <= 0.6
    )


def test_transport_rate_limit_close_backs_off_retry_after(relay, make_transport):
    """§9.3 4006: back off retryAfterS (from the error the relay sends first), not 0.5 s."""
    delays: list[float] = []
    server = relay("rate-limited-600")
    client, events = make_transport(server.url(), sleep=recording_sleep(delays, real_after=1))
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    # the main thread still gets it
    assert next_event(events, Received).message["code"] == "RATE_LIMITED"
    drop = next_event(events, Disconnected)
    assert drop.close_code == 4006 and drop.retry_in == 600.0
    wait_until(lambda: delays)
    assert delays == [600.0] and server.connections == 1


def test_transport_huge_retry_after_is_clamped_not_fatal(relay, make_transport):
    """A schema-valid error with a 400-digit retryAfterS must neither crash the reader nor leak the socket."""
    server = relay(f"rate-limited-{10**400}")
    client, events = make_transport(server.url(), sleep=recording_sleep([], real_after=1))
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    drop = next_event(events, Disconnected)
    assert (drop.close_code, drop.retry_in) == (4006, 3600.0)
    wait_until(lambda: server.client_close_codes)


def test_transport_unexpected_reader_error_stops_and_releases_the_socket(
    relay, make_transport, monkeypatch
):
    """A bug while handling an inbound message ends the transport (INTERNAL) and never leaks the open socket."""
    server = relay("error-open")
    client, events = make_transport(server.url())

    def broken(details):
        raise RuntimeError("bug")

    monkeypatch.setattr(client, "_note_retry_after", broken)
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    drop = next_event(events, Disconnected)
    assert (drop.error.kind, drop.retry_in) == (ErrorKind.INTERNAL, None)
    wait_until(lambda: server.client_close_codes)
    assert server.client_close_codes == [None]  # aborted by the transport, not left open


def test_transport_handshake_and_defaults_follow_the_protocol(relay, make_transport):
    """§3.1: no permessage-deflate, no Origin or subprotocol; §9.1 timings by default."""
    requests = []

    def record(connection, request):
        requests.append(request.headers)

    server = relay("echo", process_request=record)
    _, events = make_transport(server.url())
    next_event(events, Connected)
    [headers] = requests
    for name in (
        "Sec-WebSocket-Extensions",
        "Origin",
        "Sec-WebSocket-Protocol",
        "Authorization",
        "Cookie",
    ):
        assert name not in headers
    assert headers["User-Agent"] == f"SlicerRemoteView/{remoteview_core.__version__}"
    defaults = RelayTransport("wss://relay.example.org/ws", queue.Queue())
    assert (defaults._ping_interval, defaults._pong_timeout, defaults._send_timeout) == (
        15.0,
        10.0,
        60.0,
    )


# --------------------------------------------------------------------------- criterion 2: heartbeat


def test_transport_missing_pong_closes_the_socket_and_reconnects(relay, make_transport):
    delays: list[float] = []
    server = relay("silent")
    client, events = make_transport(
        server.url(), ping_interval=0.2, pong_timeout=0.3, sleep=recording_sleep(delays)
    )
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    started = time.monotonic()
    drop = next_event(events, Disconnected)
    assert (
        drop.error.kind is ErrorKind.HEARTBEAT
        and drop.connection == 1
        and drop.retry_in is not None
    )
    assert time.monotonic() - started >= 0.45  # one ping interval + the pong timeout
    assert server.received[:2] == [
        (1, {"type": "session.create"}),
        (1, {"protocolVersion": "1.0", "type": "ping", "id": "hb-1"}),
    ]
    wait_until(lambda: server.client_close_codes)
    # aborted: no close frame, the peer is presumed gone
    assert server.client_close_codes[0] is None
    assert next_event(events, Connected).connection == 2  # reconnect scheduled and made


def test_transport_answered_pings_keep_the_connection_and_pongs_are_consumed(relay, make_transport):
    server = relay("pong")
    client, events = make_transport(server.url(), ping_interval=0.1, pong_timeout=0.3)
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    wait_until(lambda: sum(m.get("type") == "ping" for _, m in server.received) >= 5)
    time.sleep(0.3)  # one pong timeout more: nothing may drop
    assert drain(events) == []  # no drop, and no pong reaches the protocol layer
    pings = [m for _, m in server.received if m.get("type") == "ping"]
    assert len(pings) >= 5 and [p["id"] for p in pings] == [
        f"hb-{n}" for n in range(1, len(pings) + 1)
    ]
    validators = schemas.compile_schemas()
    assert all(schemas.validate_message(p, None, validators) == [] for p in pings)  # §9.1
    # one per interval (0.1 s), never a storm
    assert min(b - a for a, b in itertools.pairwise(server.ping_times())) >= 0.08


# SLC-26: the relay answers a ping after it has read the bytes written before it. ``MIN_UPLINK`` is the heartbeat's
# assumed minimum speed in these tests, so a full chunk is worth 1.05 s of waiting.
CHUNK = bytes(transport.MAX_BINARY_BYTES)  # a full §6.3 frame: 1 MiB + the 12-byte header
MIN_UPLINK = 1_000_000.0


def connect_and_create(relay, make_transport, behaviour, *, read_bytes_per_s=0, **options):
    """A transport connected to a fake relay, ``session.create`` sent (pings follow the first text message, §3.1)."""
    server = relay(behaviour, read_bytes_per_s=read_bytes_per_s)
    options = {"ping_interval": 0.05, "pong_timeout": 0.2, "min_uplink": MIN_UPLINK} | options
    client, events = make_transport(server.url(), **options)
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    return server, client, events, connection


def test_transport_heartbeat_waits_for_the_bytes_written_ahead_of_a_ping(relay, make_transport):
    server, client, events, connection = connect_and_create(
        relay, make_transport, "slow-pong", read_bytes_per_s=2_000_000
    )
    started = time.monotonic()
    # 2 MiB: the relay needs 1.05 s to read them, five times the pong timeout
    assert client.send(CHUNK, connection=connection) and client.send(CHUNK, connection=connection)
    wait_until(lambda: len(server.ping_times()) >= 2)
    # the first ping was answered, and only after the chunks: otherwise this test would prove nothing
    assert server.ping_times()[0] - started > 0.8
    assert drain(events) == [] and server.connections == 1


def test_transport_heartbeat_still_ends_a_peer_that_reads_but_never_answers(relay, make_transport):
    _server, client, events, connection = connect_and_create(
        relay, make_transport, "slow-silent", read_bytes_per_s=2_000_000, sleep=recording_sleep([])
    )
    started = time.monotonic()
    assert client.send(CHUNK, connection=connection)
    drop = next_event(events, Disconnected, timeout=5)
    assert drop.error.kind is ErrorKind.HEARTBEAT
    # the ping goes out 0.05 s after the create; its deadline is 0.2 s + the 1 MiB ahead of it at MIN_UPLINK, less
    # the 0.05 s of credit: ≈ 1.2 s. Without the extension the connection would end after 0.25 s.
    assert 1.1 <= time.monotonic() - started <= 2.5


def test_transport_heartbeat_extension_is_bounded(relay, make_transport):
    # an extension of at most 0.5 s (the protocol's 60 s, scaled); no ping out of cycle, nothing held back
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "silent",
        ping_interval=0.3,
        max_extension=0.5,
        write_ahead=1 << 40,
        sleep=recording_sleep([]),
    )
    # 4 MiB written ahead of the first ping: ≈ 3.9 s at MIN_UPLINK by then, eight times the cap
    for _ in range(4):
        assert client.send(CHUNK, connection=connection)
    wait_until(server.ping_times)
    ping_read = server.ping_times()[0]
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # 0.2 s + the 0.5 s of the cap after the ping; twice the cap would be 1.2 s, uncapped ≈ 4.1 s
    assert 0.6 <= time.monotonic() - ping_read < 1.0


def test_transport_heartbeat_defaults_bound_the_wait_for_a_silent_peer():
    # §9.1 (v1.1): at most 10 s + 60 s for a ping; with 4 MiB written ahead of it at 1 Mbit/s, ≈ 44 s; the idle bound
    # stays the protocol's 10 s (docs/research/slicer-heartbeat.md)
    assert transport.MIN_UPLINK_BYTES_PER_S == 125_000
    assert (transport.MAX_PONG_EXTENSION_S, transport.WRITE_AHEAD_BYTES) == (60.0, 4 * 1_048_576)
    assert transport.PONG_TIMEOUT_S + transport.MAX_PONG_EXTENSION_S == 70
    ahead = (
        transport.PONG_TIMEOUT_S + transport.WRITE_AHEAD_BYTES / transport.MIN_UPLINK_BYTES_PER_S
    )
    assert 43 < ahead < 44


def test_transport_heartbeat_credits_the_time_a_minimum_link_needed_to_read_the_bytes(
    relay, make_transport
):
    server, client, events, connection = connect_and_create(
        relay, make_transport, "silent", ping_interval=0.8, sleep=recording_sleep([])
    )
    assert client.send(CHUNK, connection=connection)
    wait_until(server.ping_times, timeout=5)
    ping_read = server.ping_times()[0]
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # by the ping 0.8 s have passed: a MIN_UPLINK link has read 0.8 MB of the 1.05 MB, so 0.2 s + ≈ 0.25 s, not 1.25 s
    assert 0.3 <= time.monotonic() - ping_read < 0.9


def test_transport_heartbeat_credits_only_the_time_since_the_bytes_were_written(
    relay, make_transport
):
    """§9.1 (v1.1): B is the bytes written less what a MIN_UPLINK link has carried *since they were written* — the
    idle time before them earns no credit."""
    server, client, events, connection = connect_and_create(
        relay, make_transport, "pong-once", ping_interval=0.5, sleep=recording_sleep([])
    )
    # ping 1 goes out at 0.5 s and is answered at once; 0.3 s of idle, then the chunk
    wait_until(lambda: len(server.ping_times()) >= 1)
    time.sleep(0.3)
    assert client.send(CHUNK, connection=connection)
    # ping 2 at 1.0 s is never answered
    wait_until(lambda: len(server.ping_times()) >= 2)
    second = server.ping_times()[1]
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # 1.05 MB written ≈ 0.2 s before ping 2: 0.2 s + ≈ 0.85 s. Credit since ping 1 would give 0.2 s + 0.55 s, credit
    # since the connection's start 0.2 s + 0.05 s.
    assert 0.9 <= time.monotonic() - second < 1.5


def test_transport_heartbeat_forgets_the_bytes_an_answered_ping_confirmed(relay, make_transport):
    server, client, events, connection = connect_and_create(
        relay, make_transport, "pong-once", sleep=recording_sleep([])
    )
    assert client.send(CHUNK, connection=connection)
    # the first ping is answered (1 MiB confirmed); the second is not
    wait_until(lambda: len(server.ping_times()) >= 2)
    second = server.ping_times()[1]
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # the 1 MiB of the first round does not count again: 0.2 s, not 0.2 s + 1.05 s
    assert time.monotonic() - second < 0.7


def test_transport_heartbeat_counts_chunks_written_after_a_ping_until_it_is_answered(
    relay, make_transport
):
    server, client, events, connection = connect_and_create(
        relay, make_transport, "slow-pong", read_bytes_per_s=2_000_000
    )
    # chunk A is read until ≈ 0.52 s; the first ping is out behind it and not yet answered
    assert client.send(CHUNK, connection=connection)
    time.sleep(0.25)
    # chunk B: after ping 1 and ahead of ping 2
    assert client.send(CHUNK, connection=connection)
    wait_until(lambda: len(server.ping_times()) >= 3)
    assert drain(events) == [] and server.connections == 1


def test_transport_heartbeat_counts_bytes_per_connection(relay, make_transport):
    # connection 1 is closed after its first frame; connection 2 stays silent
    _server, client, events, first = connect_and_create(
        relay, make_transport, "close-first", sleep=recording_sleep([])
    )
    # 1 MiB written on a connection that is about to end
    assert client.send(CHUNK, connection=first)
    assert next_event(events, Disconnected).connection == first
    # the chunk was written, not dropped before it
    assert client.dropped_outbound == 0
    second = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=second)
    started = time.monotonic()
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # the old connection's chunk does not stretch this deadline
    assert time.monotonic() - started < 0.7


def test_transport_heartbeat_forgets_what_the_previous_connection_confirmed(relay, make_transport):
    # connection 1 answers a ping behind 2 MiB and is closed; connection 2 sends 3 MiB behind its ping and the relay
    # needs 1.26 s to read them. Had connection 1's 2 MiB stayed "confirmed", connection 2's deadline would be 0.7 s.
    server = relay("pong-then-close", read_bytes_per_s=2_500_000)
    client, events = make_transport(
        server.url(),
        ping_interval=0.15,
        pong_timeout=0.2,
        min_uplink=2_000_000,
        sleep=recording_sleep([]),
    )
    first = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=first)
    assert client.send(CHUNK, connection=first) and client.send(CHUNK, connection=first)
    assert next_event(events, Disconnected).connection == first
    second = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=second)
    for _ in range(3):
        assert client.send(CHUNK, connection=second)
    wait_until(lambda: len(server.ping_times(2)) >= 2)
    assert drain(events) == [] and server.connections == 2


def test_transport_heartbeat_of_an_idle_connection_is_the_protocols_pong_timeout(
    relay, make_transport
):
    _server, _client, events, _connection = connect_and_create(
        relay, make_transport, "silent", ping_interval=0.3, sleep=recording_sleep([])
    )
    started = time.monotonic()
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    # the ping at 0.3 s and 0.2 s more, plus a few hundred bytes at MIN_UPLINK: not shorter (the credit of 0.3 s at
    # MIN_UPLINK must not turn the deadline into the past) and not longer
    assert 0.45 <= time.monotonic() - started < 0.8


# --------------------------------------------------------------------------- SLC-40: the v1.1 heartbeat rule


@pytest.mark.parametrize("behaviour", ["chatter", "chatter-binary"])
def test_transport_heartbeat_any_frame_from_the_relay_answers_for_a_ping(
    relay, make_transport, behaviour
):
    """§9.1 (v1.1): the connection ends only when nothing at all arrives within a ping's deadline; another frame, text
    or binary, counts for the downlink (and is passed on), though it confirms nothing the relay read."""
    server, client, events, _connection = connect_and_create(relay, make_transport, behaviour)
    time.sleep(1.5)  # ≈ 30 pings, each 0.2 s from its deadline: none answered by a pong
    received = drain(events)
    assert [e for e in received if isinstance(e, Disconnected)] == []
    assert len([e for e in received if isinstance(e, Received)]) > 5
    assert client._confirmed == 0
    # the frame lets the writer schedule the next ping at once (not at the old deadline), and the pings no pong answers
    # are not kept for good
    assert len(server.ping_times()) >= 15
    assert len(client._pings) <= transport._MAX_OUTSTANDING_PINGS


def test_transport_heartbeat_keeps_a_long_upload_on_a_slow_link(relay, make_transport):
    """The protocol's 20 MiB at 1 Mbit/s, scaled: eight chunks through a relay that reads at 2 MB/s and answers a ping
    only after the bytes before it, two chunks of write-ahead and a 1 s extension cap — never cut, all delivered."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "slow-pong",
        read_bytes_per_s=2_000_000,
        pong_timeout=0.5,
        write_ahead=2 * len(CHUNK),
        max_extension=1.0,
    )
    for _ in range(8):
        assert client.send(CHUNK, connection=connection)
    wait_until(
        lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 8, timeout=15
    )
    assert drain(events) == [] and server.connections == 1


def test_transport_heartbeat_keeps_an_upload_after_an_idle_spell_at_exactly_the_minimum_uplink(
    relay, make_transport
):
    """Acceptance 1 at the edge: the protocol's timings scaled 1:16 (ping 15 s, pong 10 s, cap 60 s, 4 MiB ahead at
    1 Mbit/s ≈ 2 MiB at MIN_UPLINK), a relay that reads at exactly MIN_UPLINK, and an upload that starts 0.8 s
    (12.8 s unscaled) after a pong. Crediting that idle time would cut it at the first ping behind the chunks."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "slow-pong",
        read_bytes_per_s=MIN_UPLINK,
        ping_interval=0.9375,
        pong_timeout=0.625,
        max_extension=3.75,
        write_ahead=2 * 1_048_576,
    )
    wait_until(server.ping_times)  # ping 1 at 0.94 s, answered at once
    time.sleep(0.8)
    for _ in range(4):
        assert client.send(CHUNK, connection=connection)
    wait_until(
        lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 4, timeout=10
    )
    assert drain(events) == [] and server.connections == 1


def test_transport_heartbeat_pings_out_of_cycle_so_a_fast_uplink_is_not_held(relay, make_transport):
    """§9.1: after every half of WRITE_AHEAD_BYTES (a chunk here) a ping goes out of cycle, and its pong lets the
    writer on: a link that reads fast is not held to WRITE_AHEAD_BYTES per ping interval (30 s here)."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "pong",
        ping_interval=30.0,
        min_uplink=1_000.0,
        write_ahead=2 * len(CHUNK),
    )
    started = time.monotonic()
    for _ in range(10):
        assert client.send(CHUNK, connection=connection)
    wait_until(
        lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 10, timeout=10
    )
    assert time.monotonic() - started < 5
    assert len(server.ping_times()) >= 4 and drain(events) == []


def test_transport_heartbeat_holds_the_writer_at_write_ahead_until_a_pong(relay, make_transport):
    """While the relay has not confirmed it read them, at most WRITE_AHEAD_BYTES are written ahead (here: two chunks
    and a little, so the third chunk waits); a peer that reads but never answers then ends the connection by the
    deadline."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "silent",
        ping_interval=30.0,
        min_uplink=1_000.0,
        write_ahead=2 * len(CHUNK) + 1024,
        max_extension=0.5,
        sleep=recording_sleep([]),
    )
    for _ in range(6):
        assert client.send(CHUNK, connection=connection)
    assert next_event(events, Disconnected, timeout=5).error.kind is ErrorKind.HEARTBEAT
    assert len([m for _, m in server.received if isinstance(m, bytes)]) == 2


def test_transport_heartbeat_a_late_pong_lets_a_held_writer_on(relay, make_transport):
    """Another frame clears the ping's deadline while the writer is held; the pong behind it still confirms the bytes
    and wakes the writer, long before a MIN_UPLINK link (1 kB/s here) would make room."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "chatter-pong",
        ping_interval=30.0,
        min_uplink=1_000.0,
        write_ahead=2 * len(CHUNK) + 1024,
    )
    for _ in range(4):
        assert client.send(CHUNK, connection=connection)
    wait_until(lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 4, timeout=5)
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == []


def test_transport_heartbeat_a_pong_after_a_newer_ping_still_confirms(relay, make_transport):
    """Each ping's deadline is cleared by another frame, so the next ping goes before the last one's pong; that pong
    still confirms what the relay read, and is consumed here."""
    server, client, events, _connection = connect_and_create(
        relay, make_transport, "chatter-late-pong"
    )
    wait_until(lambda: len(server.ping_times()) >= 4)
    wait_until(lambda: client._confirmed > 0)
    received = drain(events)
    assert [e for e in received if isinstance(e, Disconnected)] == []
    assert [
        e for e in received if isinstance(e, Received) and e.message.get("type") == "pong"
    ] == []


def test_transport_heartbeat_paces_the_writer_at_the_minimum_uplink_without_pongs(
    relay, make_transport
):
    """A relay alive but slow to read (its pongs not back yet): the writer goes on as a minimum-speed link would carry
    the bytes, never more than WRITE_AHEAD_BYTES ahead by that estimate — it wakes for that, not for the next ping
    (30 s away here)."""
    server, client, events, connection = connect_and_create(
        relay, make_transport, "chatter", ping_interval=30.0, write_ahead=2 * len(CHUNK) + 1024
    )
    started = time.monotonic()
    for _ in range(4):
        assert client.send(CHUNK, connection=connection)
    wait_until(
        lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 4, timeout=10
    )
    # two chunks allowed ahead: they go at once; the third and the fourth each wait ≈ 1.05 s for a MIN_UPLINK link to
    # carry one more, counted from when the chunks were written (not until it carried both)
    assert 2.0 <= time.monotonic() - started < 3.5
    first, _, third, fourth = server.chunk_times()
    assert 0.95 <= third - first < 1.6 and 0.95 <= fourth - third < 1.6
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == []


def test_transport_write_ahead_does_not_hold_back_the_final_message(relay, make_transport):
    """stop()'s final message is never held: with the writer held at WRITE_AHEAD_BYTES (a chunk ahead here),
    session.close goes at once; the relay reads it and answers our close (1000), so final_sent is true."""
    server = relay("slow-silent", read_bytes_per_s=MIN_UPLINK)
    client, events = make_transport(
        server.url(), min_uplink=MIN_UPLINK, write_ahead=len(CHUNK) + 1024
    )
    connection = next_event(events, Connected).connection
    for _ in range(5):
        assert client.send(CHUNK, connection=connection)
    time.sleep(0.3)
    started = time.monotonic()
    assert client.stop({"type": "session.close"}, timeout=10)
    assert time.monotonic() - started < transport.STOP_GRACE_S + 1
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=True)
    wait_until(lambda: server.client_close_codes)
    # the chunk ahead of it, then the final message; the held chunks were dropped by stop()
    assert [m for _, m in server.received] == [CHUNK, {"type": "session.close"}]


def test_transport_final_message_too_far_behind_is_not_reported_sent(relay, make_transport):
    """T1: a final message handed to the socket behind more than a MIN_UPLINK link carries before the abort (a chunk
    at 125 kB/s ≈ 8.4 s here, the abort 2 s after stop()) is not reported sent: the panel then says the relay may
    keep the session (FINAL_NOT_SENT). The relay stops reading after the first frame."""
    server = relay("stuck", max_queue=0)
    client, events = make_transport(server.url(), write_ahead=len(CHUNK))
    connection = next_event(events, Connected).connection
    for _ in range(40):
        client.send(CHUNK, connection=connection)
    time.sleep(1.0)
    started = time.monotonic()
    assert client.stop({"type": "session.close"}, timeout=10)
    assert time.monotonic() - started < transport.STOP_GRACE_S + 1
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=False)


def test_transport_write_ahead_lets_a_larger_frame_go_alone(relay, make_transport):
    """A frame larger than WRITE_AHEAD_BYTES is not held for good: it goes once B is 0 (here: each chunk once the one
    before is carried at MIN_UPLINK), and B is never more than that one frame."""
    server, client, events, connection = connect_and_create(
        relay, make_transport, "chatter", ping_interval=30.0, write_ahead=1024
    )
    started = time.monotonic()
    for _ in range(3):
        assert client.send(CHUNK, connection=connection)
    wait_until(
        lambda: len([m for _, m in server.received if isinstance(m, bytes)]) == 3, timeout=10
    )
    # the second and the third chunk each wait ≈ 1.05 s
    assert 2.0 <= time.monotonic() - started < 2.8
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == []


def read_frames(client: RelayTransport, frames: list) -> list:
    """The transport's reader run over ``frames`` on a loop of its own (no socket): what it passed on."""

    class Socket:
        close_code = 1000

        async def __aiter__(self):
            for frame in frames:
                yield frame

    async def read() -> None:
        with contextlib.suppress(transport._ClosedError):
            await client._read(Socket(), 1)

    asyncio.run(read())
    return drain(client._events)


def pong(ping: str) -> str:
    return json.dumps({"protocolVersion": "1.0", "type": "pong", "replyTo": ping})


def test_transport_a_pong_confirms_its_ping_and_the_older_ones():
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), min_uplink=1.0)
    client._pings = {"hb-1": 1_000, "hb-2": 3_000, "hb-3": 6_000}
    client._written = 8_000
    client._backlog, client._backlog_at = 7_000.0, time.monotonic()
    # hb-1 got no pong of its own: pongs come in order, so hb-2's answers for both; a stray or repeated pong, or
    # one whose replyTo is not a string, is passed on
    stray = [pong("hb-1"), pong("hb-9"), json.dumps({"type": "pong", "replyTo": ["hb-3"]})]
    passed = read_frames(client, [pong("hb-2"), *stray])
    assert client._pings == {"hb-3": 6_000} and client._confirmed == 3_000
    assert [e.message.get("replyTo") for e in passed] == ["hb-1", "hb-9", ["hb-3"]]
    # B starts again from the 5,000 bytes written after hb-2 (it was 7,000; 1 B/s drains nothing here)
    assert 4_999 <= client._backlog <= 5_000
    assert read_frames(client, [pong("hb-3")]) == []
    assert client._pings == {} and client._confirmed == 6_000 and client._backlog <= 2_000


def test_transport_final_message_in_time_by_the_estimate_alone(relay, make_transport):
    # a relay that stops reading after the first frame (max_queue=0), so no close of its own decides: with nothing
    # ahead of it, a MIN_UPLINK link carries the final message long before the abort
    server = relay("stuck", max_queue=0)
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    time.sleep(0.2)
    assert client.stop({"type": "session.close"}, timeout=10)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=True)


def test_transport_final_message_in_time_with_a_chunk_ahead(relay, make_transport):
    # ≈ 0.95 MB ahead of session.close: a MIN_UPLINK link carries it in the 2 s before the abort, less the margin
    server = relay("stuck", max_queue=0)
    client, events = make_transport(server.url(), min_uplink=MIN_UPLINK)
    connection = next_event(events, Connected).connection
    assert client.send(CHUNK, connection=connection)
    time.sleep(0.1)
    assert client.stop({"type": "session.close"}, timeout=10)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=True)


def test_transport_final_message_not_in_time_with_the_margin(relay, make_transport):
    """The edge of the estimate: two chunks written 0.3 s before stop() leave ≈ 1.8 MB ahead of session.close, which a
    MIN_UPLINK link carries in the 2 s before the abort, but not within them less the margin (1.5 s) that framing and
    latency take on a real one. The relay stops reading after the first frame, so no close of its own decides."""
    server = relay("stuck", max_queue=0)
    client, events = make_transport(
        server.url(), min_uplink=MIN_UPLINK, write_ahead=2 * len(CHUNK) + 1024
    )
    connection = next_event(events, Connected).connection
    for _ in range(2):
        assert client.send(CHUNK, connection=connection)
    time.sleep(0.3)
    assert client.stop({"type": "session.close"}, timeout=10)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=False)


def test_transport_final_message_confirmed_by_the_relays_close(relay, make_transport):
    """On a fast link the estimate still counts a chunk the relay has read (no ping since it: B ≈ 1 MB at 125 kB/s,
    far more than the 2 s before the abort carry); the relay's close 1000, which follows everything ahead of it, says
    the final message arrived — no false FINAL_NOT_SENT."""
    server = relay("pong")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    assert client.send(CHUNK, connection=connection)
    wait_until(lambda: any(isinstance(m, bytes) for _, m in server.received))
    assert client.stop({"type": "session.close"}, timeout=10)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=True)
    # the relay's library answers our close before its handler has logged session.close
    wait_until(lambda: server.client_close_codes)
    assert server.received[-1] == (1, {"type": "session.close"})


class FakeSocket:
    """Just enough of a websockets connection for ``_serve``: a binary frame takes ``delay`` s to send, and close()
    receives the relay's close ``code`` (1006: none came)."""

    def __init__(self, code: int, delay: float = 0.0) -> None:
        self.close_code: int | None = None
        self.sent: list[str | bytes] = []
        self._code, self._delay = code, delay
        self._closed = asyncio.Event()

    def __aiter__(self):
        return self._frames()

    async def _frames(self):
        await self._closed.wait()
        for frame in ():
            yield frame

    async def send(self, data) -> None:
        await asyncio.sleep(self._delay if isinstance(data, bytes) else 0)
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.close_code = self._code
        self._closed.set()


def stopped_on(
    socket: FakeSocket, *, min_uplink: float, queued=(), stop_after: float = 0.0
) -> bool:
    """``final_sent`` of a transport served on ``socket`` and stopped with session.close after ``stop_after`` s."""
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), min_uplink=min_uplink)
    client._pending.extend((1, frame) for frame in queued)

    async def run() -> None:
        asyncio.get_running_loop().call_later(
            stop_after, client._request_stop, '{"type":"session.close"}'
        )
        await client._serve(socket, 1)

    asyncio.run(run())
    assert socket.sent[-1] == '{"type":"session.close"}'
    return client._final_sent


@pytest.mark.parametrize(
    ("code", "min_uplink", "sent"),
    [
        # the relay ended the session after reading it: true even where the estimate says no
        (1000, 1.0, True),
        (1000, MIN_UPLINK, True),
        # no close frame: the estimate decides
        (1006, MIN_UPLINK, True),
        (1006, 1.0, False),
        # the relay refused it (the first frame of a new socket; over the budget; replaced): never sent
        (1008, MIN_UPLINK, False),
        (4006, MIN_UPLINK, False),
        (4011, MIN_UPLINK, False),
    ],
)
def test_transport_final_sent_reads_the_relays_close(code, min_uplink, sent):
    assert stopped_on(FakeSocket(code), min_uplink=min_uplink) is sent


@pytest.mark.parametrize(("delay", "sent"), [(0.2, True), (1.2, False)])
def test_transport_final_message_counts_the_time_spent_in_a_send(delay, sent):
    # stop() 0.05 s into a chunk's send: the final message follows the chunk (1.05 MB at MIN_UPLINK) with the time left
    # until the abort, less the margin — 1.35 s after a 0.2 s send, 0.35 s after a 1.2 s one
    socket = FakeSocket(1006, delay=delay)
    assert stopped_on(socket, min_uplink=MIN_UPLINK, queued=[CHUNK], stop_after=0.05) is sent
    assert socket.sent[0] == CHUNK


def test_transport_stop_without_a_final_message_sends_none(relay, make_transport):
    # the relay's close 1000 answers ours, but no final message was sent: nothing to report
    server = relay("silent")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    assert client.stop(timeout=10)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=False)
    wait_until(lambda: server.client_close_codes)
    assert server.client_close_codes == [1000] and server.received == []


@pytest.mark.parametrize("value", [0, -1])
def test_transport_write_ahead_must_be_positive(value):
    with pytest.raises(ValueError, match="write_ahead"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue(), write_ahead=value)


def test_transport_write_ahead_counts_no_ping_towards_the_next(relay, make_transport):
    # a write-ahead smaller than a ping frame: an idle connection still pings once per interval, not after each pong
    # (the first goes at once: session.create crosses the one-byte threshold; then one at 0.3, 0.6 and 0.9 s)
    server, _client, events, _connection = connect_and_create(
        relay, make_transport, "pong", ping_interval=0.3, write_ahead=1
    )
    time.sleep(1.0)
    assert 2 <= len(server.ping_times()) <= 6
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == []


def test_transport_write_ahead_counts_a_waiting_text_frame_in_utf8_bytes(relay, make_transport):
    # one ≈ 250 kB frame of non-ASCII text may be ahead (≈ 1.5 frames of write-ahead): counted in characters, the next
    # one would fit too
    server, client, _events, connection = connect_and_create(
        relay, make_transport, "silent", ping_interval=30.0, min_uplink=1_000.0, write_ahead=376_000
    )
    text = {"type": "scene.update", "names": "Ł" * 124_950}
    for _ in range(3):
        assert client.send(text, connection=connection)
    wait_until(lambda: any(m == text for _, m in server.received))
    time.sleep(0.3)
    assert sum(m == text for _, m in server.received) == 1


def test_transport_heartbeat_counts_text_frames_in_utf8_bytes(relay, make_transport):
    """B counts what goes on the wire: a text frame of non-ASCII characters is twice as many UTF-8 bytes here. The
    timings of the idle-spell test (1:16), a relay that reads every frame at exactly MIN_UPLINK, and 3 MB of
    scene.update text: counted in characters, B would let 4 MiB out ahead of a ping whose deadline expects 2 MiB."""
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "slow-pong",
        read_bytes_per_s=MIN_UPLINK,
        ping_interval=0.9375,
        pong_timeout=0.625,
        max_extension=3.75,
        write_ahead=2 * 1_048_576,
    )
    text = {"type": "scene.update", "names": "Ł" * 124_950}  # ≈ 250 kB of UTF-8, 125k characters
    for _ in range(12):
        assert client.send(text, connection=connection)
    wait_until(lambda: sum(m == text for _, m in server.received) == 12, timeout=10)
    assert drain(events) == [] and server.connections == 1


@pytest.mark.parametrize("value", [-1.0, float("nan"), float("inf")])
def test_transport_max_extension_must_be_finite_and_non_negative(value):
    with pytest.raises(ValueError, match="max_extension"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue(), max_extension=value)
    # no extension at all is the protocol's v1.0 rule
    RelayTransport("wss://relay.example.org/ws", queue.Queue(), max_extension=0)


# --------------------------------------------------------------------------- SLC-41: when a connection was lost


class OffsetClocks:
    """The transport's ``(monotonic, wall)`` clocks, moved by ``offsets``: a sleep moves the wall clock alone where
    the monotonic clock stops during it (Linux, macOS), or both where it runs on (Windows; see
    ``docs/research/slicer-sleep-clocks.md``)."""

    def __init__(self) -> None:
        self.offsets = (0.0, 0.0)

    def clocks(self):
        return (lambda: time.monotonic() + self.offsets[0], lambda: time.time() + self.offsets[1])


@pytest.mark.parametrize(
    ("alive", "now", "lost"),
    [
        ((100.0, 1000.0), (125.0, 1025.0), 1025.0),  # no sleep: when the heartbeat noticed
        ((100.0, 1000.0), (125.0, 4625.0), 1025.0),  # an hour asleep, the monotonic clock stopped
        # it ran on: no later than the bound after the last frame
        ((100.0, 1000.0), (3700.0, 4600.0), 1300.0),
        # the wall clock went back: when the heartbeat noticed
        ((100.0, 1000.0), (125.0, 965.0), 965.0),
    ],
)
def test_transport_loss_time(alive, now, lost):
    assert transport.loss_time(alive, now, 300.0) == lost


def test_transport_max_silence_adds_up_the_heartbeats_waits():
    """A ping held back by a send, its pong's deadline with the largest extension, and that deadline's check held
    back by another send (205 s with the protocol's settings); each transport uses its own settings."""
    assert transport.max_silence(1.0, 2.0, 3.0, 4.0) == 1.0 + 3.0 + 2.0 + 4.0 + 3.0
    assert transport.MAX_SILENCE_S == 15.0 + 60.0 + 10.0 + 60.0 + 60.0
    tuned = RelayTransport(
        "wss://relay.example.org/ws",
        queue.Queue(),
        ping_interval=1.0,
        pong_timeout=2.0,
        send_timeout=3.0,
        max_extension=4.0,
    )
    assert tuned._max_silence == 13.0


def test_transport_dates_with_the_monotonic_and_the_wall_clock():
    assert RelayTransport("wss://relay.example.org/ws", queue.Queue())._clocks == (
        time.monotonic,
        time.time,
    )


@pytest.mark.parametrize("sleep", [None, "monotonic-stopped", "monotonic-ran-on"])
def test_transport_dates_a_lost_connection(relay, make_transport, sleep):
    """Without a sleep (the transport's own clocks) the loss is when the transport noticed it; after an hour asleep,
    the same where the monotonic clock stopped, and the longest silence after the opening where it ran on."""
    clocks = OffsetClocks()
    server = relay("echo")
    opened = time.time()
    options = {} if sleep is None else {"clocks": clocks.clocks()}
    _, events = make_transport(server.url(), sleep=recording_sleep([], real_after=2), **options)
    next_event(events, Connected)
    connected = time.time()
    clocks.offsets = (3600.0 if sleep == "monotonic-ran-on" else 0.0, 3600.0)
    before = time.time()
    server.shutdown()
    lost_at = next_event(events, Disconnected).lost_at
    if sleep == "monotonic-ran-on":
        assert opened + transport.MAX_SILENCE_S <= lost_at <= connected + transport.MAX_SILENCE_S
    else:
        assert before <= lost_at <= time.time()
    assert next_event(events, Disconnected).lost_at is None  # a failed attempt lost no connection


def test_transport_each_frame_is_a_sign_of_life(relay, make_transport):
    clocks = OffsetClocks()
    server = relay("echo")
    client, events = make_transport(
        server.url(), clocks=clocks.clocks(), sleep=recording_sleep([], real_after=1)
    )
    connection = next_event(events, Connected).connection
    clocks.offsets = (3600.0, 3600.0)  # an hour on, on both clocks
    sent = time.time() + 3600
    assert client.send({"type": "session.create"}, connection=connection)
    next_event(events, Received)  # the echo: alive an hour after the opening
    server.shutdown()
    lost_at = next_event(events, Disconnected).lost_at
    assert sent <= lost_at <= time.time() + 3600  # not MAX_SILENCE_S after the opening


def test_transport_a_pong_is_a_sign_of_life(relay, make_transport):
    """An idle session receives pongs only: each one counts."""
    clocks = OffsetClocks()
    server = relay("pong")
    client, events = make_transport(
        server.url(),
        clocks=clocks.clocks(),
        ping_interval=0.1,
        sleep=recording_sleep([], real_after=1),
    )
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)  # pings follow it (§3.1)
    wait_until(lambda: len(server.ping_times()) >= 1)
    clocks.offsets = (3600.0, 3600.0)  # an hour on, on both clocks
    changed = time.time() + 3600
    seen = len(server.ping_times())
    # ping seen + 2 goes out only after the pong of ping seen + 1, which the relay sent after the change
    wait_until(lambda: len(server.ping_times()) >= seen + 2)
    server.shutdown()
    assert changed <= next_event(events, Disconnected).lost_at <= time.time() + 3600


def test_transport_a_send_is_no_sign_of_life(relay, make_transport):
    """Only frames received count: the pings sent after a sleep do not hide it."""
    clocks = OffsetClocks()
    server = relay("silent")
    client, events = make_transport(
        server.url(),
        clocks=clocks.clocks(),
        ping_interval=0.1,
        pong_timeout=0.3,
        sleep=recording_sleep([], real_after=1),
    )
    connection = next_event(events, Connected).connection
    asleep = time.time()
    clocks.offsets = (0.0, 3600.0)  # an hour asleep, the monotonic clock stopped
    assert client.send({"type": "session.create"}, connection=connection)  # unanswered pings follow
    assert asleep <= next_event(events, Disconnected).lost_at <= time.time()


def test_transport_dates_a_slow_uplink_loss_when_it_is_noticed(relay, make_transport):
    """A ping waiting behind a snapshot keeps a healthy connection silent for longer than a ping and its pong
    (SLC-26): a loss noticed then is dated when it was noticed, not a ping and a pong after the last frame."""
    _server, client, events, connection = connect_and_create(
        relay, make_transport, "slow-silent", read_bytes_per_s=2_000_000, sleep=recording_sleep([])
    )
    sent = time.time()
    assert client.send(CHUNK, connection=connection)
    drop = next_event(events, Disconnected, timeout=5)
    assert drop.error.kind is ErrorKind.HEARTBEAT
    # noticed ≈ 1.2 s after the chunk (test_transport_heartbeat_still_ends_a_peer_that_reads_but_never_answers)
    assert sent + 1.0 <= drop.lost_at <= time.time()


def test_transport_a_failing_clock_still_ends_the_socket(relay, make_transport):
    """An injected clock that raises between the opening and the first frame: the socket is aborted, not left
    open, and the transport stops."""

    def broken() -> float:
        raise RuntimeError

    server = relay("echo")
    _, events = make_transport(server.url(), clocks=(broken, time.time))
    assert next_event(events, Disconnected).retry_in is None
    wait_until(lambda: server.client_close_codes)  # aborted: the relay saw the socket end


def test_transport_discard_queued_drops_the_waiting_frames_of_one_connection():
    events: queue.Queue = queue.Queue()
    client = RelayTransport("wss://relay.example.org/ws", events)
    client._pending.extend([(1, b"a"), (2, b"b"), (1, "c"), (2, "d")])
    client._discard(1)
    assert list(client._pending) == [(2, b"b"), (2, "d")] and client.discarded_outbound == 2
    # a transport that is not running discards nothing
    assert client.dropped_outbound == 0 and client.discard_queued(connection=2) is False


def test_transport_discard_queued_runs_in_the_worker_thread(relay, make_transport, monkeypatch):
    server = relay("silent")
    client, events = make_transport(server.url(), ping_interval=60)
    next_event(events, Connected)
    threads: list[str] = []
    original = client._discard

    def spy(connection: int) -> None:
        threads.append(threading.current_thread().name)
        original(connection)

    monkeypatch.setattr(client, "_discard", spy)
    assert client.discard_queued(connection=1)
    wait_until(lambda: threads)
    assert threads == ["RemoteView-transport"] and threading.current_thread().name not in threads


def test_transport_discard_queued_stops_the_rest_of_a_slow_upload(relay, make_transport):
    # 64 MiB take 3 s to read
    server = relay("slow-silent", read_bytes_per_s=20_000_000)
    # nothing held back, so the writer fills every buffer
    client, events = make_transport(server.url(), ping_interval=60, write_ahead=1 << 40)
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    # far more than the buffers of both ends hold; the writer is blocked on one of them
    for _ in range(64):
        assert client.send(CHUNK, connection=connection)
    time.sleep(0.3)
    assert client.discard_queued(connection=connection)
    wait_until(lambda: client.discarded_outbound > 0)
    # the connection itself is untouched, and still usable
    assert drain(events) == []
    assert client.send({"type": "after"}, connection=connection)
    wait_until(lambda: any(m == {"type": "after"} for _, m in server.received), timeout=60)
    delivered = sum(isinstance(m, bytes) for _, m in server.received)
    # every chunk was either delivered or discarded, and the discarded ones are a good part of the 64 (the buffers of
    # both ends hold about 20 MiB; the slow reader got through 6 in the 0.3 s)
    assert delivered + client.discarded_outbound == 64
    assert client.discarded_outbound >= 8 and client.dropped_outbound == 0


def test_transport_discard_queued_drops_what_the_write_ahead_holds(relay, make_transport):
    # the writer is held after one chunk (a relay that reads but never answers, 1 kB/s assumed)
    server, client, events, connection = connect_and_create(
        relay,
        make_transport,
        "silent",
        ping_interval=30.0,
        min_uplink=1_000.0,
        write_ahead=len(CHUNK) + 1024,
    )
    for _ in range(4):
        assert client.send(CHUNK, connection=connection)
    wait_until(lambda: any(isinstance(m, bytes) for _, m in server.received))
    time.sleep(0.2)
    assert client.discard_queued(connection=connection)
    wait_until(lambda: client.discarded_outbound == 3)
    # a small frame fits within the write-ahead: it goes at once, the discarded chunks never
    assert client.send({"type": "after"}, connection=connection)
    wait_until(lambda: any(m == {"type": "after"} for _, m in server.received))
    assert sum(isinstance(m, bytes) for _, m in server.received) == 1
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == []


@pytest.mark.parametrize("value", [0, -1.0, float("nan")])
def test_transport_min_uplink_must_be_positive(value):
    with pytest.raises(ValueError, match="min_uplink"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue(), min_uplink=value)


def test_transport_passes_on_pongs_it_did_not_ask_for(relay, make_transport):
    server = relay("foreign-pong")
    client, events = make_transport(server.url(), ping_interval=0.05, pong_timeout=5)
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    assert next_event(events, Received).message == {
        "protocolVersion": "1.0",
        "type": "pong",
        "replyTo": "c-7",
    }


def test_transport_drops_inbound_text_that_is_not_a_json_object(relay, make_transport):
    server = relay("junk")
    client, events = make_transport(server.url())
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    assert next_event(events, Received).message == {"type": "ok"}
    time.sleep(0.2)
    # counted, never logged; no disconnect
    assert drain(events) == [] and client.dropped_inbound == 3


def test_transport_connect_options_follow_adr_0009(relay, make_transport, monkeypatch):
    from websockets.asyncio import client as ws_client  # noqa: PLC0415

    seen: list[dict] = []
    original = ws_client.connect.__init__

    def recording_init(self, uri, **kwargs):
        seen.append(kwargs)
        original(self, uri, **kwargs)

    monkeypatch.setattr(ws_client.connect, "__init__", recording_init)
    server = relay("echo")
    _, events = make_transport(server.url())
    next_event(events, Connected)
    options = seen[0]
    # §9.1 app heartbeat, §3.1
    assert options["ping_interval"] is None and options["compression"] is None
    assert (options["max_size"], options["open_timeout"], options["close_timeout"]) == (
        1_114_112,
        10.0,
        2.0,
    )
    # ws:// → never a proxy
    assert options["logger"] is transport._WS_LOGGER and options["proxy"] is None


def test_transport_sends_no_ping_before_the_first_text_message(relay, make_transport):
    """The relay wants session.create/session.resume as the first message (§3.1)."""
    server = relay("silent")
    client, events = make_transport(server.url(), ping_interval=0.05, pong_timeout=5)
    connection = next_event(events, Connected).connection
    assert client.send(b"\x00" * 12, connection=connection)  # binary does not start the heartbeat
    time.sleep(0.4)
    assert server.received == [(1, b"\x00" * 12)]
    assert client.send({"type": "session.create"}, connection=connection)
    wait_until(lambda: len(server.received) >= 3)
    assert server.received[1] == (1, {"type": "session.create"})
    assert server.received[2][1]["type"] == "ping"


# --------------------------------------------------------------------------- criterion 3: TLS


def test_transport_self_signed_certificate_fails_with_guidance(relay, make_transport, certs):
    server = relay("echo", tls=server_tls(certs["local"]))
    client, events = make_transport(server.url("wss"))
    drop = next_event(events, Disconnected)
    assert isinstance(drop.error, TlsError)
    assert (drop.error.kind, drop.error.verify_code, drop.retry_in) == (
        ErrorKind.TLS_CERTIFICATE,
        18,
        None,
    )
    assert "never turned off" in drop.error.guidance and "IT department" in drop.error.guidance
    client._thread.join(5)
    assert not client.running and server.connections == 0  # no retry, nothing sent


@pytest.mark.parametrize(("host", "code"), [("localhost", 62), ("127.0.0.1", 64)])
def test_transport_certificate_for_another_host_fails(relay, make_transport, certs, host, code):
    server = relay("echo", tls=server_tls(certs["other"]))
    _, events = make_transport(server.url("wss", host), extra_ca_file=str(certs["other"][0]))
    drop = next_event(events, Disconnected)
    assert (drop.error.kind, drop.error.verify_code, drop.retry_in) == (
        ErrorKind.TLS_CERTIFICATE,
        code,
        None,
    )
    assert "another host" in drop.error.guidance


def test_transport_extra_ca_is_added_to_the_default_trust(relay, make_transport, certs):
    cert = str(certs["local"][0])
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue(), extra_ca_file=cert)
    defaults = ssl.create_default_context().cert_store_stats()["x509_ca"]
    context = client._tls_context()
    # added, not replacing (ADR 0009 §2)
    assert context.cert_store_stats()["x509_ca"] == defaults + 1
    assert context.verify_mode is ssl.CERT_REQUIRED and context.check_hostname
    server = relay("echo", tls=server_tls(certs["local"]))
    sender, events = make_transport(server.url("wss"), extra_ca_file=cert)
    assert sender.send({"type": "hello"}, connection=next_event(events, Connected).connection)
    assert next_event(events, Received).message == {"type": "hello"}


def test_transport_extra_ca_file_formats(tmp_path, certs):
    """Windows exports DER (.cer); openssl exports add text headers; editors add a BOM — all are read."""
    pem = certs["local"][0].read_text()
    defaults = ssl.create_default_context().cert_store_stats()["x509_ca"]
    variants = {
        "der.cer": ssl.PEM_cert_to_DER_cert(pem),
        "header.pem": ("subject=CN = Hôpital Root\nissuer=CN = Hôpital Root\n" + pem).encode(
            "utf-8"
        ),
        "bom.pem": b"\xef\xbb\xbf" + pem.encode("ascii"),
    }
    for name, data in variants.items():
        (tmp_path / name).write_bytes(data)
        client = RelayTransport(
            "wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(tmp_path / name)
        )
        assert client._tls_context().cert_store_stats()["x509_ca"] == defaults + 1, name


def test_transport_unusable_extra_ca_file_fails_in_the_callers_thread(tmp_path):
    with pytest.raises(OSError):
        RelayTransport(
            "wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(tmp_path / "none.pem")
        )
    for name, data in {
        "empty.pem": b"",
        "garbage.pem": b"-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n",
        "text.pem": "Hôpital\n".encode(),
        "huge.pem": b"x" * (transport.MAX_CA_FILE_BYTES + 1),
    }.items():
        (tmp_path / name).write_bytes(data)
        with pytest.raises(ValueError, match="no usable certificate"):
            RelayTransport(
                "wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(tmp_path / name)
            )


def test_transport_extra_ca_file_size_and_type_are_bounded(tmp_path, certs, monkeypatch):
    """A valid certificate past 1 MiB is refused by the cap alone; a FIFO, a device or a directory is never read
    (reading a FIFO would block the Qt main thread)."""
    pem = certs["local"][0].read_bytes()
    padded = tmp_path / "padded.pem"
    padded.write_bytes(pem + b"\n" * transport.MAX_CA_FILE_BYTES)
    read: list[int] = []
    real_read = os.read

    def counting_read(fd: int, size: int) -> bytes:
        chunk = real_read(fd, size)
        read.append(len(chunk))
        return chunk

    monkeypatch.setattr(transport.os, "read", counting_read)
    with pytest.raises(ValueError, match="no usable certificate"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(padded))
    monkeypatch.undo()
    assert sum(read) == transport.MAX_CA_FILE_BYTES + 1  # read up to the cap, whatever st_size says
    # exactly at the cap: accepted
    padded.write_bytes(pem + b"\n" * (transport.MAX_CA_FILE_BYTES - len(pem)))
    RelayTransport("wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(padded))
    with pytest.raises(ValueError if os.name == "posix" else OSError):
        RelayTransport("wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(tmp_path))
    if not hasattr(os, "mkfifo"):
        return
    fifo = tmp_path / "ca.fifo"
    os.mkfifo(fifo)
    outcome: list = []

    def construct() -> None:
        try:
            RelayTransport("wss://relay.example.org/ws", queue.Queue(), extra_ca_file=str(fifo))
        except ValueError as exc:
            outcome.append(exc)

    # a regression would block here, not the suite
    worker = threading.Thread(target=construct, daemon=True)
    worker.start()
    worker.join(5)
    assert not worker.is_alive() and len(outcome) == 1


def test_transport_tls13_connects_without_stalls(relay, certs):
    """ADR 0009: the sync client stalled on ~10 % of TLS 1.3 connects (session tickets); 30 in a row must not."""
    server = relay("echo", tls=server_tls(certs["local"]))
    for _ in range(30):
        events: queue.Queue = queue.Queue()
        client = RelayTransport(
            server.url("wss"), events, use_proxy=False, extra_ca_file=str(certs["local"][0])
        )
        client.start()
        try:
            assert isinstance(next_event(events, timeout=3.0), Connected)
        finally:
            assert client.stop(timeout=5)


def test_transport_writes_no_tls_key_log(relay, make_transport, certs, tmp_path, monkeypatch):
    log = tmp_path / "keys.log"
    monkeypatch.setenv("SSLKEYLOGFILE", str(log))
    server = relay("echo", tls=server_tls(certs["local"]))
    _, events = make_transport(server.url("wss"), extra_ca_file=str(certs["local"][0]))
    next_event(events, Connected)
    assert "SECRET" not in (log.read_text() if log.exists() else "")


def test_transport_has_no_code_path_that_disables_verification():
    """T5/NFR-14: grep the module's sources (the vendored package is generated and has no TLS code)."""
    forbidden = re.compile(
        r"CERT_NONE|CERT_OPTIONAL|check_hostname\s*=|verify_mode\s*=|_create_unverified_context|"
        r"VERIFY_DEFAULT\b|ssl\s*=\s*False"
    )
    sources = sorted((Path(transport.__file__).parents[1]).rglob("*.py"))
    assert Path(transport.__file__) in sources
    offenders = [
        f"{path.name}:{n}"
        for path in sources
        if "_vendor" not in path.parts
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if forbidden.search(line)
    ]
    assert offenders == []


# --------------------------------------------------------------------------- reconnect policy (§9.3)


@pytest.mark.parametrize("code", [4011, 4003, 4000, 1000, 1008, 1009])
def test_transport_terminal_close_codes_stop_reconnecting(relay, make_transport, code):
    server = relay(f"close-{code}")
    client, events = make_transport(server.url())
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    drop = next_event(events, Disconnected)
    assert (drop.error.kind, drop.close_code, drop.retry_in) == (ErrorKind.CLOSED, code, None)
    # a lost connection is dated even when the transport stops (SLC-41)
    assert drop.lost_at is not None
    client._thread.join(5)
    assert not client.running and server.connections == 1


@pytest.mark.parametrize(
    ("code", "delay"),
    [
        pytest.param(4008, 3.0, id="restart-4008"),
        pytest.param(1011, 0.6, id="1011"),
        pytest.param(4009, 0.6, id="4009"),
        # SLC-48: a drop like any other, not the restart jitter
        pytest.param(4010, 0.6, id="slow_consumer-4010"),
    ],
)
def test_transport_retryable_close_codes_reconnect(relay, make_transport, code, delay):
    """With every random draw at its top, the restart jitter (0–3 s) and the first backoff (0.5 s ± 20 %) differ."""
    delays: list[float] = []
    server = relay(f"close-{code}")
    client, events = make_transport(
        server.url(), sleep=recording_sleep(delays, real_after=1), rng=TopRandom()
    )
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    drop = next_event(events, Disconnected)
    assert drop.close_code == code and drop.retry_in == pytest.approx(delay)


def test_transport_http_errors_and_redirects_are_not_retried_or_followed(relay, make_transport):
    elsewhere = relay("echo")

    def redirect(connection, request):
        response = connection.respond(HTTPStatus.FOUND, "moved\n")
        response.headers["Location"] = elsewhere.url()
        return response

    server = relay("echo", process_request=redirect)
    _, events = make_transport(server.url())
    drop = next_event(events, Disconnected)
    assert (drop.error.kind, drop.error.status, drop.retry_in) == (ErrorKind.HTTP_STATUS, 302, None)
    assert elsewhere.connections == 0  # data goes only to the configured relay host


def test_transport_http_503_is_retried(relay, make_transport):
    server = relay(
        "echo", process_request=lambda c, r: c.respond(HTTPStatus.SERVICE_UNAVAILABLE, "busy\n")
    )
    _, events = make_transport(server.url(), sleep=recording_sleep([], real_after=1))
    drop = next_event(events, Disconnected)
    assert (drop.error.kind, drop.error.status) == (
        ErrorKind.HTTP_STATUS,
        503,
    ) and drop.retry_in is not None


def test_transport_frames_for_an_ended_connection_are_never_sent(relay, make_transport):
    """A chunk queued for connection 1 must not precede session.resume on connection 2 (SLC-17)."""
    server = relay("close-first")
    client, events = make_transport(server.url(), sleep=recording_sleep([], real_after=9))
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    assert next_event(events, Disconnected).close_code == 1011
    assert next_event(events, Connected).connection == 2
    assert client.send(b"stale chunk", connection=1)  # queued, then dropped
    assert client.send({"type": "session.resume"}, connection=2)
    wait_until(lambda: any(n == 2 for n, _ in server.received))
    assert [m for n, m in server.received if n == 2] == [{"type": "session.resume"}]
    assert client.dropped_outbound >= 1


# --------------------------------------------------------------------------- stop and stuck sends


def test_transport_stop_sends_the_final_message_and_closes_1000(relay, make_transport):
    server = relay("silent")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    time.sleep(0.2)
    assert client.stop({"type": "session.close", "reason": "USER_STOPPED"})
    assert [e for e in drain(events) if isinstance(e, Disconnected)] == [
        Disconnected(connection, None, None, final_sent=True)
    ]
    wait_until(lambda: server.client_close_codes)
    assert server.received[-1] == (1, {"type": "session.close", "reason": "USER_STOPPED"})
    assert server.client_close_codes == [1000]
    assert not client.send({"type": "late"}, connection=connection)


def test_transport_second_stop_keeps_the_first_final_message(relay, make_transport):
    """The Stop button calls stop(final, timeout=0); a later waiting stop() (module unload, exit) must not drop it."""
    server = relay("silent")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    assert client.send({"type": "session.create"}, connection=connection)
    wait_until(lambda: server.received)
    client.stop({"type": "session.close", "reason": "USER_STOPPED"}, timeout=0)
    assert client.stop(timeout=5)
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=True)
    wait_until(lambda: server.client_close_codes)
    assert server.received[-1] == (1, {"type": "session.close", "reason": "USER_STOPPED"})


def test_transport_stuck_send_times_out_and_reconnects(relay, make_transport):
    server = relay("stuck", max_queue=1)
    # nothing held back, so the sends fill every buffer
    client, events = make_transport(
        server.url(), send_timeout=0.5, write_ahead=1 << 40, sleep=recording_sleep([], real_after=1)
    )
    connection = next_event(events, Connected).connection
    chunk = b"\x00" * transport.MAX_BINARY_BYTES
    for _ in range(40):  # far more than the socket buffers hold
        client.send(chunk, connection=connection)
    drop = next_event(events, Disconnected, timeout=20)
    assert drop.error.kind is ErrorKind.TIMEOUT and drop.retry_in is not None


def test_transport_stop_returns_promptly_while_a_send_is_stuck(relay, make_transport):
    server = relay("stuck", max_queue=1)
    # send timeout 60 s: only stop()'s abort can end it; nothing held back, so the sends fill every buffer
    client, events = make_transport(server.url(), write_ahead=1 << 40)
    connection = next_event(events, Connected).connection
    for _ in range(40):
        client.send(b"\x00" * transport.MAX_BINARY_BYTES, connection=connection)
    time.sleep(1.0)
    started = time.monotonic()
    assert client.stop({"type": "session.close"}, timeout=10)
    assert time.monotonic() - started < transport.STOP_GRACE_S + 1.5
    # the relay saw a drop, not session.close: the panel can say the session lingers for the grace period
    assert drain(events)[-1] == Disconnected(connection, None, None, final_sent=False)


def test_transport_stop_before_or_without_a_connection(make_transport):
    with socket.socket() as probe:  # a port nobody listens on
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    client, events = make_transport(
        f"ws://127.0.0.1:{port}/ws", sleep=recording_sleep([], real_after=1)
    )
    assert next_event(events, Disconnected).error.kind is ErrorKind.REFUSED
    assert client.stop(timeout=5)
    assert drain(events)[-1] == Disconnected(None, None, None)
    assert RelayTransport("wss://relay.example.org/ws", queue.Queue()).stop()  # never started


# --------------------------------------------------------------------------- input checks, privacy, purity


@pytest.mark.parametrize(
    "url",
    [
        "http://relay.example.org/ws",
        "ws://relay.example.org/ws",  # plain ws only to localhost (§3.1)
        "wss://user:secret@relay.example.org/ws",
        "wss://relay.example.org/ws?code=7KQ4X",
        "wss://relay.example.org/ws?",
        "wss://relay.example.org/ws#7KQ4X",
        "wss:///ws",
        "wss://relay.example.org/ws\n",
        "wss://relay.example.org:99999/ws",
        "wss://relay.example.org:7KQ4X/ws",  # urllib's own message would quote it
        "WSS://relay.example.org/ws",  # the TLS options are chosen from the lower-case scheme
        "Wss://relay.example.org/ws",
        "WS://localhost/ws",
        "wss://[7KQ4X]/ws",  # urllib's messages would quote the host
        "wss://[v1.7KQ4X]/ws",
        "wss://relay.example.org;x=7KQ4X/ws",
        "wss://relay.example.org\\7KQ4X/ws",
        "wss://-relay.example.org/ws",
        "wss://" + "a" * 64 + ".example.org/ws",  # a DNS label is at most 63 characters
        "wss://"
        + ".".join(["a" * 63] * 3 + ["b" * 62])
        + "/ws",  # a host name is at most 253 characters
        "wss://relay.exämple.org/ws",
        b"wss://relay.example.org/ws",
    ],
)
def test_transport_refuses_urls_outside_protocol_3_1(url):
    with pytest.raises(ValueError) as raised:
        RelayTransport(url, queue.Queue())
    assert "user:secret" not in str(raised.value) and "7KQ4X" not in str(raised.value)


@pytest.mark.parametrize(
    "url",
    ["wss://relay.example.org/ws", "wss://relay.example.org:8443/ws", "ws://localhost:8080/ws",
     "ws://127.0.0.1:1/ws", "ws://[::1]:8080/ws", "wss://10.0.0.5:8443/ws", "wss://[2001:db8::1]/ws",
     "wss://relay-1.up.railway.app/ws"],
)  # fmt: skip
def test_transport_accepts_relay_urls(url):
    assert check_relay_url(url) == url


def test_transport_accepts_host_names_up_to_the_dns_limits():
    longest = ".".join(["a" * 63] * 3 + ["b" * 61])  # 253 characters, every label 63 or shorter
    assert len(longest) == 253
    for url in ("wss://" + "a" * 63 + ".example.org/ws", f"wss://{longest}/ws"):
        assert check_relay_url(url) == url


def test_transport_send_checks_frames_in_the_callers_thread():
    client = RelayTransport("wss://relay.example.org/ws", queue.Queue())
    with pytest.raises(ValueError, match="262144"):
        client.send("x" * (transport.MAX_TEXT_BYTES + 1), connection=1)
    with pytest.raises(ValueError, match="1048588"):
        client.send(b"\x00" * (transport.MAX_BINARY_BYTES + 1), connection=1)
    with pytest.raises(ValueError):
        client.send({"value": float("nan")}, connection=1)
    with pytest.raises(TypeError):
        client.send(42, connection=1)
    assert client.send({"type": "ping"}, connection=1) is False  # not started
    assert client.send(bytearray(b"ok"), connection=1) is False


def _response(status: int) -> Response:
    return Response(status, HTTPStatus(status).phrase, Headers())


@pytest.mark.parametrize(
    ("exc", "kind", "retryable"),
    [
        (ssl.SSLError(1, "handshake failure"), ErrorKind.TLS, True),
        (InvalidProxyStatus(_response(407)), ErrorKind.PROXY_AUTH, False),
        (InvalidProxyStatus(_response(403)), ErrorKind.PROXY, False),
        (InvalidProxyStatus(_response(502)), ErrorKind.PROXY, True),
        (InvalidProxy("http://alice:s3cret@proxy.local:8080/pac", "path is meaningless"),
         ErrorKind.PROXY_UNSUPPORTED, False),
        (ImportError("connecting through a SOCKS proxy requires python-socks"),
         ErrorKind.PROXY_UNSUPPORTED, False),
        (InvalidStatus(_response(404)), ErrorKind.HTTP_STATUS, False),
        (InvalidStatus(_response(429)), ErrorKind.HTTP_STATUS, True),
        (InvalidStatus(_response(502)), ErrorKind.HTTP_STATUS, True),
        (TimeoutError("timed out"), ErrorKind.TIMEOUT, True),
        (socket.gaierror(-2, "Name or service not known"), ErrorKind.DNS, True),
        (ConnectionRefusedError(111, "refused"), ErrorKind.REFUSED, True),
        (OSError(101, "Network is unreachable"), ErrorKind.NETWORK, True),
        (InvalidMessage("did not receive a valid HTTP response"), ErrorKind.HANDSHAKE, True),
        (ConnectionClosedError(None, None), ErrorKind.NETWORK, True),
        (ConnectionClosedError(Close(4011, "reason-4011"), None), ErrorKind.CLOSED, False),
        (ConnectionClosedError(Close(4008, "reason-4008"), None), ErrorKind.CLOSED, True),
        pytest.param(ConnectionClosedError(Close(4010, "reason-4010"), None), ErrorKind.CLOSED, True,
                     id="slow_consumer-4010"),
        (ConnectionClosedError(Close(1001, "reason-1001"), None), ErrorKind.CLOSED, True),
        (RuntimeError("bug"), ErrorKind.INTERNAL, False),
    ],
)  # fmt: skip
def test_transport_classifies_errors_by_type_never_by_text(exc, kind, retryable):
    error = classify(exc)
    assert (error.kind, error.retryable) == (kind, retryable)
    shown = f"{error} {error!r} {error.guidance} {error.args}"
    assert "s3cret" not in shown and "alice" not in shown and "python-socks" not in shown
    # a close reason is the relay's free text: never shown
    assert "reason-" not in shown
    assert error.guidance and error.__cause__ is None


def test_transport_classifies_certificate_errors_by_verify_code():
    def cert_error(code: int) -> ssl.SSLCertVerificationError:
        exc = ssl.SSLCertVerificationError(
            1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"
        )
        exc.verify_code = code
        return exc

    for code, words in [
        (20, "inspect HTTPS"),
        (19, "inspect HTTPS"),
        (10, "date"),
        (9, "date"),
        (62, "host"),
    ]:
        error = classify(cert_error(code))
        assert isinstance(error, TlsError) and error.verify_code == code and not error.retryable
        assert words in error.guidance and str(code) in error.guidance


def test_transport_logs_and_events_carry_no_payload(relay, make_transport, caplog):
    """websockets logs frame payloads at DEBUG (codes, tokens): its logger is pinned at WARNING (CLAUDE.md rule 6)."""
    caplog.set_level(logging.DEBUG)
    server = relay("echo")
    client, events = make_transport(server.url())
    connection = next_event(events, Connected).connection
    client.send(
        {"type": "session.created", "code": "7KQ4X", "publisherToken": "tok-SECRET"},
        connection=connection,
    )
    received = next_event(events, Received)
    assert received.message["code"] == "7KQ4X"
    assert client.stop()
    shown = caplog.text + repr(received) + "".join(repr(e) for e in drain(events))
    assert "7KQ4X" not in shown and "tok-SECRET" not in shown


def test_transport_plain_ws_to_loopback_never_uses_a_proxy(relay, monkeypatch):
    """Cleartext stays on the machine: the system proxy settings are ignored for ws:// (loopback only)."""
    for name in ("http_proxy", "https_proxy", "ws_proxy", "wss_proxy", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")  # nothing listens there
        monkeypatch.setenv(name.upper(), "http://127.0.0.1:9")
    for name in ("no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    server = relay("echo")
    events: queue.Queue = queue.Queue()
    client = RelayTransport(server.url(), events)  # use_proxy defaults to True
    client.start()
    try:
        connection = next_event(events, Connected).connection
        assert client.send({"type": "hello"}, connection=connection)
        assert next_event(events, Received).message == {"type": "hello"}
    finally:
        assert client.stop()


def test_transport_start_refuses_an_unsupported_websockets(monkeypatch):
    import websockets.version  # noqa: PLC0415
    from websockets.asyncio import client as ws_client  # noqa: PLC0415

    # no proxy support: every attempt would fail late
    monkeypatch.setattr(websockets.version, "version", "14.2")
    with pytest.raises(ImportError, match=r"websockets 17\.2"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue()).start()
    monkeypatch.setattr(websockets.version, "version", "17.2")
    # the redirect refusal would silently do nothing
    monkeypatch.delattr(ws_client.connect, "process_redirect")
    with pytest.raises(ImportError, match=r"websockets 17\.2"):
        RelayTransport("wss://relay.example.org/ws", queue.Queue()).start()
