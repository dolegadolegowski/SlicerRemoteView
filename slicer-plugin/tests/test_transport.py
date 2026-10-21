"""SLC-08: relay transport — one WebSocket in a worker thread (ADR 0009; protocol §3, §9.1, §9.3)."""

from __future__ import annotations

import asyncio
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
        self, behaviour: str = "echo", *, tls=None, process_request=None, max_queue=16
    ) -> None:
        self.behaviour = behaviour
        self.received: list[tuple[int, object]] = []
        self.received_at: list[float] = []  # time.monotonic() of each entry of received
        self.client_close_codes: list[int | None] = []
        self.connections = 0
        self.release = threading.Event()  # ends the "stuck" handlers
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
                self.received.append((number, message))
                self.received_at.append(time.monotonic())
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
            self.behaviour == "pong" and isinstance(message, dict) and message.get("type") == "ping"
        ):
            ws.send(
                json.dumps({"protocolVersion": "1.0", "type": "pong", "replyTo": message["id"]})
            )
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
    assert [m for _, m in server.received] == got


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
    sent = [
        t
        for t, (_, m) in zip(server.received_at, server.received, strict=True)
        if m.get("type") == "ping"
    ]
    # one per interval (0.1 s), never a storm
    assert min(b - a for a, b in itertools.pairwise(sent)) >= 0.08


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
    client._thread.join(5)
    assert not client.running and server.connections == 1


@pytest.mark.parametrize(
    ("code", "low", "high"), [(4008, 0.0, 3.0), (1011, 0.4, 0.6), (4009, 0.4, 0.6)]
)
def test_transport_retryable_close_codes_reconnect(relay, make_transport, code, low, high):
    delays: list[float] = []
    server = relay(f"close-{code}")
    client, events = make_transport(server.url(), sleep=recording_sleep(delays, real_after=1))
    assert client.send(
        {"type": "session.create"}, connection=next_event(events, Connected).connection
    )
    drop = next_event(events, Disconnected)
    assert drop.close_code == code and low <= drop.retry_in <= high


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
    client, events = make_transport(
        server.url(), send_timeout=0.5, sleep=recording_sleep([], real_after=1)
    )
    connection = next_event(events, Connected).connection
    chunk = b"\x00" * transport.MAX_BINARY_BYTES
    for _ in range(40):  # far more than the socket buffers hold
        client.send(chunk, connection=connection)
    drop = next_event(events, Disconnected, timeout=20)
    assert drop.error.kind is ErrorKind.TIMEOUT and drop.retry_in is not None


def test_transport_stop_returns_promptly_while_a_send_is_stuck(relay, make_transport):
    server = relay("stuck", max_queue=1)
    # send timeout 60 s: only stop()'s abort can end it
    client, events = make_transport(server.url())
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
        (ConnectionClosedError(Close(4011, "replaced"), None), ErrorKind.CLOSED, False),
        (ConnectionClosedError(Close(4008, "restart"), None), ErrorKind.CLOSED, True),
        (ConnectionClosedError(Close(1001, ""), None), ErrorKind.CLOSED, True),
        (RuntimeError("bug"), ErrorKind.INTERNAL, False),
    ],
)  # fmt: skip
def test_transport_classifies_errors_by_type_never_by_text(exc, kind, retryable):
    error = classify(exc)
    assert (error.kind, error.retryable) == (kind, retryable)
    shown = f"{error} {error!r} {error.guidance} {error.args}"
    assert "s3cret" not in shown and "alice" not in shown and "python-socks" not in shown
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
