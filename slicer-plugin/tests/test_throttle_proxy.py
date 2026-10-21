"""The throttling proxy of the slow-uplink tests (SLC-26): it must really limit the rate, or they prove nothing."""

from __future__ import annotations

import socket
import subprocess
import threading
import time

from support import TESTS_DIR, needs_node, start_throttle_proxy

RATE = 400_000  # bytes per second


class Sink:
    """A loopback TCP server that counts the bytes it receives and when the last one came."""

    def __init__(self) -> None:
        self._server = socket.create_server(("127.0.0.1", 0))
        self.address = f"127.0.0.1:{self._server.getsockname()[1]}"
        self.received = 0
        self.last_at = 0.0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        try:
            connection, _ = self._server.accept()
        except OSError:
            return
        with connection:
            while data := connection.recv(65_536):
                self.received += len(data)
                self.last_at = time.monotonic()

    def close(self) -> None:
        self._server.close()


def push(proxy_address: str, sink: Sink, *writes: bytes, gap: float = 0.0) -> float:
    """Send ``writes`` (``gap`` s apart) through the proxy and return the seconds until the sink has them all. The
    connection stays open until then: the proxy drops what is still queued when its client closes."""
    host, port = proxy_address.rsplit(":", 1)
    total = sum(len(w) for w in writes)
    started = time.monotonic()
    with socket.create_connection((host, int(port)), timeout=10) as client:
        for index, data in enumerate(writes):
            if index:
                time.sleep(gap)
            client.sendall(data)
        deadline = time.monotonic() + 10
        while sink.received < total:
            assert time.monotonic() < deadline, f"{sink.received} of {total} bytes arrived"
            time.sleep(0.01)
    return sink.last_at - started


@needs_node
def test_throttle_proxy_limits_the_rate_towards_the_target():
    sink = Sink()
    proxy = start_throttle_proxy(sink.address, RATE)
    try:
        elapsed = push(proxy.address, sink, bytes(600_000))
        # 600 000 bytes at 400 000 bytes/s = 1.5 s; two timer chains would give 0.75 s, so the lower bound is the check
        assert 1.2 <= elapsed <= 2.4, elapsed
    finally:
        forwarded = int(proxy.finish().split()[0])
        sink.close()
    assert forwarded == 600_000


@needs_node
def test_throttle_proxy_keeps_limiting_after_it_has_been_idle():
    sink = Sink()
    proxy = start_throttle_proxy(sink.address, RATE)
    try:
        # a small write, a pause longer than a few ticks (the queue runs dry), then a large write
        elapsed = push(proxy.address, sink, bytes(1_000), bytes(400_000), gap=0.3)
        # 0.3 s pause + 400 000 bytes at 400 000 bytes/s
        assert 1.1 <= elapsed <= 1.8, elapsed
    finally:
        proxy.finish()
        sink.close()


@needs_node
def test_throttle_proxy_refuses_a_target_that_is_not_on_the_loopback_interface():
    result = subprocess.run(  # fixed argv: node and a file of this repository
        ["node", str(TESTS_DIR / "throttle_proxy.mjs"), "--target", "example.org:80"],
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert result.returncode != 0 and "loopback" in result.stderr and result.stdout == ""
