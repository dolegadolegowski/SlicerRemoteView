"""Relay transport (SLC-08, ADR 0009): the publisher's WebSocket to the relay, in one worker thread.

:class:`RelayTransport` runs the ``websockets`` asyncio client on a private event loop in a daemon thread. The Qt main
thread talks to it only through a ``queue.Queue`` of events (:class:`Connected`, :class:`Received`,
:class:`Disconnected`) and the thread-safe :meth:`~RelayTransport.send` / :meth:`~RelayTransport.stop`; SLC-09's
50 ms ``QTimer`` drains the queue into :class:`~remoteview_core.protocol_client.ProtocolClient`.

- TLS is always verified (T5, NFR-14): a fresh ``ssl.create_default_context()`` per attempt (inside Slicer:
  ``Slicer.crt``, plus the system store on Windows), an optional user-supplied CA file *added* to it, no TLS key log
  for the relay connection.
  Plain ``ws://`` only to a loopback host and never through a proxy (protocol §3.1); no user info, query or fragment
  in the URL (no secrets in URLs); redirects are not followed (data goes only to the relay host named in the consent
  text).
- Heartbeat (§9.1): ``ping`` every 15 s once the connection's first text message is out (the relay wants
  ``session.create``/``session.resume`` first, §3.1); a ``pong`` 10 s late aborts the connection. Matching pongs are
  consumed here. The relay answers a ``ping`` only after it has read the bytes written before it (one TCP stream), so
  the deadline grows by the time the bytes it can still have to read need at :data:`MIN_UPLINK_BYTES_PER_S`: those
  written since the last answered ``ping``, less what a link of that speed has carried since then, and at most
  :data:`MAX_UNREAD_BYTES` (what the buffers hold). A snapshot going out on a slow uplink does not look like a dead
  connection; a peer that reads and never answers is ended after at most ``pong_timeout`` + :data:`MAX_UNREAD_BYTES` /
  :data:`MIN_UPLINK_BYTES_PER_S` (≈ 77 s), one that stops reading by ``send_timeout``. The deadline is checked between
  sends only, so one blocked ``send()`` can hold it back by up to ``send_timeout``.
- Reconnect: exponential backoff 0.5 s → 30 s with ±20 % jitter (0–3 s after ``4008``; after ``4005``/``4006`` at
  least the ``retryAfterS`` of the relay's last ``error`` on that connection, §9.3). Errors the user has to fix
  (certificate, proxy, HTTP 3xx/4xx) and the close codes of :data:`NO_RECONNECT_CLOSE_CODES` stop the transport.
- Frames name the connection they were queued for: a frame for a connection that is gone is dropped, never sent on
  the next one (a stale snapshot chunk must not precede ``session.resume``).
- Nothing about frames is logged: ``websockets`` gets a logger pinned at WARNING (its DEBUG output prints payloads),
  and errors carry a kind and numbers, never exception text (a proxy URL may hold a password).

``websockets`` (exactly 17.2, ADR 0009/T12; installed after consent — SLC-10) is imported when used
(:meth:`RelayTransport.start`, :func:`classify`), not at import.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import enum
import ipaddress
import json
import logging
import math
import os
import queue
import random
import re
import socket
import ssl
import stat
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from remoteview_core import __version__
from remoteview_core.protocol_client import TERMINAL_CLOSE_CODES, envelope

_log = logging.getLogger(__name__)
#: Handed to ``websockets``: at DEBUG it logs frame payloads (codes, tokens), so it never goes below WARNING.
_WS_LOGGER = logging.getLogger(f"{__name__}.websockets")
_WS_LOGGER.setLevel(logging.WARNING)

PING_INTERVAL_S = 15.0  # §9.1
PONG_TIMEOUT_S = 10.0  # §9.1
BACKOFF_MIN_S = 0.5  # §9.1
BACKOFF_MAX_S = 30.0  # §9.1
RESTART_JITTER_S = 3.0  # §9.3: 4008 → reconnect with 0–3 s jitter
STABLE_AFTER_S = 30.0  # a connection open this long resets the backoff
OPEN_TIMEOUT_S = 10.0  # TCP, TLS, proxy and HTTP upgrade together
CLOSE_TIMEOUT_S = 2.0
STOP_GRACE_S = 2.0  # stop(): final message + closing handshake, then the socket is aborted
SEND_TIMEOUT_S = 60.0  # one frame (≤ 1 MiB) on a slow uplink; the relay gives up on a snapshot after 120 s (§3.3)
#: The slowest uplink a snapshot upload is expected to survive without a reconnect: 1 Mbit/s.
MIN_UPLINK_BYTES_PER_S = 125_000.0
#: What the buffers between ``send()`` and the relay's reader can hold: ``send()`` returns once the library's own
#: write buffer is nearly empty, so the rest of the written bytes sit in the kernel's send buffer, the network and the
#: relay's receive buffer (≈ 4.3 MB on a Linux loopback pair that reads nothing, docs/research/slicer-heartbeat.md).
#: Bounds how much a ``ping`` can wait for, so a peer that reads and never answers is still ended; a link that holds
#: more errs towards an earlier abort.
MAX_UNREAD_BYTES = 8 * 1_048_576
MAX_TEXT_BYTES = 262_144  # §3.3, publisher text message
MAX_BINARY_BYTES = 1_048_576 + 12  # §3.3, chunk payload + header
MAX_INBOUND_BYTES = 1_114_112  # §3.3, the relay's maxPayload
MAX_RETRY_AFTER_S = 3600.0  # bound on a relay-supplied retryAfterS (§9.2, §12)
#: §9.3 close codes after which reconnecting cannot help: the terminal ones, 1000 (the relay closes a publisher
#: normally only after its ``session.close``) and 1009 (the same payload would be refused again).
NO_RECONNECT_CLOSE_CODES = frozenset(TERMINAL_CLOSE_CODES) | {1000, 1009}
_RESTARTING = 4008
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})
# §9.3: "retry later (retryAfterS)", "back off retryAfterS"
_RETRY_AFTER_CLOSE_CODES = frozenset({4005, 4006})
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"  # RFC 1035 label: ≤ 63 characters
_HOST_NAME = re.compile(rf"{_LABEL}(?:\.{_LABEL})*")
MAX_CA_FILE_BYTES = 1_048_576
_NO_CERTIFICATE = "the extra CA file holds no usable certificate (PEM or DER)"
_PEM_CERTIFICATE = re.compile(
    rb"-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----"
)
# OpenSSL X509_V_ERR_* codes (x509_vfy.h, identical in 1.1.1 and 3.x): matched instead of the message text.
_CERT_NOT_YET_VALID, _CERT_EXPIRED, _HOSTNAME_MISMATCH, _IP_MISMATCH = 9, 10, 62, 64


class ErrorKind(enum.Enum):
    TLS_CERTIFICATE = "tls-certificate"
    TLS = "tls"
    PROXY_AUTH = "proxy-auth"
    PROXY_UNSUPPORTED = "proxy-unsupported"
    PROXY = "proxy"
    HTTP_STATUS = "http-status"
    TIMEOUT = "timeout"
    DNS = "dns"
    REFUSED = "refused"
    NETWORK = "network"
    HANDSHAKE = "handshake"
    HEARTBEAT = "heartbeat"
    CLOSED = "closed"
    INTERNAL = "internal"


_GUIDANCE = {
    ErrorKind.TLS: "The secure connection to the relay failed. Check the relay address and the network.",
    ErrorKind.PROXY_AUTH: (
        "Your proxy requires a sign-in method RemoteView does not support (NTLM or Kerberos). Ask your IT "
        "department to allow the relay host without proxy authentication."
    ),
    ErrorKind.PROXY_UNSUPPORTED: (
        "Your proxy setting is not supported (a SOCKS proxy or an invalid proxy address). Ask your IT department "
        "for an HTTP proxy and set wss_proxy=http://<proxy>:<port> before starting Slicer."
    ),
    ErrorKind.PROXY: "Your proxy refused the connection to the relay. Ask your IT department to allow the relay host.",
    ErrorKind.TIMEOUT: "The relay did not answer in time. Check the network connection.",
    ErrorKind.DNS: "The relay host name could not be resolved. Check the relay address and the network connection.",
    ErrorKind.REFUSED: "The relay refused the connection. Check the relay address, or try again later.",
    ErrorKind.NETWORK: "The network connection to the relay failed.",
    ErrorKind.HANDSHAKE: "The relay address did not answer as a RemoteView relay. Check the relay address.",
    ErrorKind.HEARTBEAT: "The relay stopped answering.",
    ErrorKind.INTERNAL: "RemoteView hit an internal error in its connection code. Please report it.",
}


class TransportError(Exception):
    """Why a connection or connection attempt ended, for the panel (R-10): a kind, numbers and fixed English
    guidance — never the original exception's text, which may hold a proxy password."""

    def __init__(
        self,
        kind: ErrorKind,
        *,
        retryable: bool,
        verify_code: int | None = None,
        status: int | None = None,
        close_code: int | None = None,
    ) -> None:
        self.kind = kind
        self.retryable = retryable
        self.verify_code = verify_code  # OpenSSL certificate verification code (TLS_CERTIFICATE)
        self.status = status  # HTTP status of the relay or proxy (HTTP_STATUS, PROXY, PROXY_AUTH)
        self.close_code = close_code  # WebSocket close code received from the relay (CLOSED)
        numbers = {"verify_code": verify_code, "status": status, "close_code": close_code}
        super().__init__(
            " ".join([kind.value, *(f"{k}={v}" for k, v in numbers.items() if v is not None)])
        )

    @property
    def guidance(self) -> str:
        if self.kind is ErrorKind.TLS_CERTIFICATE:
            if self.verify_code in (_HOSTNAME_MISMATCH, _IP_MISMATCH):
                return (
                    f"The relay's certificate belongs to another host (code {self.verify_code}). Check the relay "
                    "address; on a guest network, open a web page first to pass its sign-in page."
                )
            if self.verify_code in (_CERT_NOT_YET_VALID, _CERT_EXPIRED):
                return (
                    f"The relay's certificate is not valid at this computer's date and time (code "
                    f"{self.verify_code}). Check the date, time and time zone."
                )
            return (
                f"The relay's certificate is not trusted (code {self.verify_code}). Your network may inspect HTTPS "
                "traffic: ask your IT department to exempt the relay host, or for your organisation's root CA "
                "certificate (PEM or DER file) to add in the RemoteView settings. Certificate checks are never turned "
                "off: patient data may cross this connection."
            )
        if self.kind is ErrorKind.HTTP_STATUS:
            return f"The relay answered HTTP {self.status} instead of opening the connection. Check the relay address."
        if self.kind is ErrorKind.CLOSED:
            return f"The relay closed the connection (code {self.close_code})."
        return _GUIDANCE[self.kind]


class TlsError(TransportError):
    """A TLS failure: certificate verification (``TLS_CERTIFICATE``, see ``verify_code``) or the handshake."""


@dataclass(frozen=True)
class Connected:
    """A connection is open: send ``session.create``/``session.resume`` on this ``connection`` first (§3.1)."""

    connection: int


@dataclass(frozen=True)
class Received:
    """A message from the relay: the parsed JSON object of a text frame, or the ``bytes`` of a binary frame (the
    relay sends none to a publisher). Not in ``repr``: it may hold the session code or token."""

    connection: int
    message: dict[str, Any] | bytes = field(repr=False)


@dataclass(frozen=True)
class Disconnected:
    """A connection (``connection``) or a connection attempt (``None``) ended. ``retry_in``: seconds until the next
    attempt, or ``None`` when the transport has stopped — after :meth:`RelayTransport.stop` (``error`` is ``None``)
    or because of ``error``. The last event of every transport is a ``Disconnected`` with ``retry_in`` ``None``.
    ``final_sent`` (stop only): the final message of ``stop(final)`` was written; if not, the relay saw a drop and
    keeps the session for its grace period (§9.1)."""

    connection: int | None
    error: TransportError | None
    retry_in: float | None
    final_sent: bool = False

    @property
    def close_code(self) -> int | None:
        """The close code received from the relay, for ``ProtocolClient.transport_lost``."""
        return self.error.close_code if self.error is not None else None


Event = Connected | Received | Disconnected
Frame = Mapping[str, Any] | str | bytes | bytearray | memoryview


class _HeartbeatTimeoutError(Exception):
    pass


class _SendTimeoutError(Exception):
    pass


class _ClosedError(Exception):
    def __init__(self, code: int | None) -> None:
        super().__init__(code)
        self.code = code


def check_relay_url(url: str) -> str:
    """``url`` if it is a relay URL the transport may use (protocol §3.1), else ``ValueError`` (never echoing it)."""
    if (
        not isinstance(url, str)
        or not url.isascii()
        or any(c.isspace() or not c.isprintable() for c in url)
    ):
        raise ValueError("relay URL must be printable ASCII without spaces")
    try:  # urllib's own messages would quote parts of the URL
        parts = urlsplit(url)
        host, _ = parts.hostname, parts.port
    except ValueError:
        raise ValueError("relay URL has an invalid host or port") from None
    # lower-case scheme only: the TLS options are chosen from it (websockets would take WSS:// with its own context)
    if (
        not url.startswith(("wss://", "ws://"))
        or not host
        or not _valid_host(host, "[" in parts.netloc)
    ):
        raise ValueError("relay URL must look like wss://<host>/ws")
    if "@" in parts.netloc or parts.query or parts.fragment or url.endswith(("?", "#")):
        raise ValueError(
            "relay URL must not carry user info, a query or a fragment (no secrets in URLs, §3.1)"
        )
    if parts.scheme == "ws" and host not in _LOOPBACK:
        raise ValueError("plain ws:// is allowed only to localhost (§3.1)")
    return url


def _valid_host(host: str, bracketed: bool) -> bool:
    """A DNS host name (letters, digits, hyphens) or an IP address (``[…]`` only around an IPv6 address)."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return not bracketed and len(host) <= 253 and _HOST_NAME.fullmatch(host) is not None
    return bracketed == (address.version == 6)


def classify(exc: BaseException) -> TransportError:  # noqa: PLR0911, PLR0912 — one branch per type, in order
    """Map an exception from connecting or from an open connection to a :class:`TransportError` (by type and
    numbers only). ``SSLCertVerificationError`` is also an ``OSError`` and a ``ValueError``: the order matters."""
    from websockets import exceptions as wsx  # noqa: PLC0415 — imported by start(); not at module import

    if isinstance(exc, ssl.SSLCertVerificationError):
        return TlsError(ErrorKind.TLS_CERTIFICATE, retryable=False, verify_code=exc.verify_code)
    if isinstance(exc, ssl.SSLError):
        return TlsError(ErrorKind.TLS, retryable=True)
    if isinstance(exc, wsx.InvalidProxyStatus):
        status = exc.response.status_code
        if status == 407:
            return TransportError(ErrorKind.PROXY_AUTH, retryable=False, status=status)
        return TransportError(ErrorKind.PROXY, retryable=_retryable_status(status), status=status)
    if isinstance(exc, (wsx.InvalidProxy, ImportError)):  # ImportError: SOCKS needs python-socks
        return TransportError(ErrorKind.PROXY_UNSUPPORTED, retryable=False)
    if isinstance(exc, wsx.InvalidStatus):  # also a redirect: never followed
        status = exc.response.status_code
        return TransportError(
            ErrorKind.HTTP_STATUS, retryable=_retryable_status(status), status=status
        )
    if isinstance(exc, (wsx.ConnectionClosed, _ClosedError)):
        code = (
            exc.code
            if isinstance(exc, _ClosedError)
            else (exc.rcvd.code if exc.rcvd is not None else None)
        )
        if code is None or code == 1006:  # dropped without a close frame
            return TransportError(ErrorKind.NETWORK, retryable=True)
        return TransportError(
            ErrorKind.CLOSED, retryable=code not in NO_RECONNECT_CLOSE_CODES, close_code=int(code)
        )
    if isinstance(exc, _HeartbeatTimeoutError):
        return TransportError(ErrorKind.HEARTBEAT, retryable=True)
    if isinstance(exc, (TimeoutError, _SendTimeoutError)):  # TimeoutError is an OSError
        return TransportError(ErrorKind.TIMEOUT, retryable=True)
    if isinstance(exc, socket.gaierror):
        return TransportError(ErrorKind.DNS, retryable=True)
    if isinstance(exc, ConnectionRefusedError):
        return TransportError(ErrorKind.REFUSED, retryable=True)
    if isinstance(exc, OSError):
        return TransportError(ErrorKind.NETWORK, retryable=True)
    if isinstance(exc, wsx.InvalidHandshake):
        return TransportError(ErrorKind.HANDSHAKE, retryable=True)
    return TransportError(ErrorKind.INTERNAL, retryable=False)


def _retryable_status(status: int) -> bool:
    return status >= 500 or status in (408, 429)


def _encode(frame: Frame) -> str | bytes:
    """A frame as the transport sends it; checked here, in the caller's thread, against the §3.3 limits."""
    if isinstance(frame, Mapping):
        frame = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if isinstance(frame, str):
        if len(frame.encode("utf-8")) > MAX_TEXT_BYTES:
            raise ValueError(f"text message over {MAX_TEXT_BYTES} bytes (§3.3)")
        return frame
    if isinstance(frame, (bytes, bytearray, memoryview)):
        data = bytes(frame)
        if len(data) > MAX_BINARY_BYTES:
            raise ValueError(f"binary frame over {MAX_BINARY_BYTES} bytes (§3.3)")
        return data
    raise TypeError("a frame is a mapping, a str or bytes")


def _read_ca_file(path: Path) -> str | bytes:
    """The certificates of a PEM file (only its certificate blocks: exports add text headers, a BOM or non-ASCII
    subject lines) or of a DER file, checked by loading them into a context."""
    # One descriptor for the check and the read; O_NONBLOCK: opening a FIFO never waits for a writer
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):  # a FIFO, device or directory is never read
            raise ValueError(_NO_CERTIFICATE)
        data = bytearray()
        # bounded by what is read, not by st_size (procfs says 0)
        while len(data) <= MAX_CA_FILE_BYTES:
            chunk = os.read(fd, MAX_CA_FILE_BYTES + 1 - len(data))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    if len(data) > MAX_CA_FILE_BYTES:
        raise ValueError(_NO_CERTIFICATE)
    raw = bytes(data)
    blocks = _PEM_CERTIFICATE.findall(raw)
    cadata: str | bytes = b"\n".join(blocks).decode("ascii") if blocks else raw
    try:
        ssl.create_default_context().load_verify_locations(cadata=cadata)
    except (ssl.SSLError, ValueError):
        raise ValueError(_NO_CERTIFICATE) from None
    return cadata


def _parse(text: str) -> dict[str, Any] | None:
    try:
        message = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return message if isinstance(message, dict) else None


class RelayTransport:
    """One publisher connection to ``url`` (``wss://<host>/ws``), reconnecting until stopped (see module docstring).

    ``events`` receives :data:`Event` objects from the worker thread. ``extra_ca_file`` is a PEM file of CA
    certificates (or one DER certificate) trusted in addition to the defaults, read once, here: ``OSError`` if it
    cannot be read, ``ValueError`` if it holds no usable certificate.
    ``use_proxy=False`` ignores the system proxy settings (tests).
    ``ping_interval``, ``pong_timeout``, ``send_timeout``, ``min_uplink``, ``sleep`` (the backoff wait) and ``rng``
    exist for tests.
    """

    def __init__(  # noqa: PLR0913 — tuning knobs are keyword-only and default to the protocol values
        self,
        url: str,
        events: queue.Queue[Event],
        *,
        extra_ca_file: str | None = None,
        use_proxy: bool = True,
        ping_interval: float = PING_INTERVAL_S,
        pong_timeout: float = PONG_TIMEOUT_S,
        send_timeout: float = SEND_TIMEOUT_S,
        min_uplink: float = MIN_UPLINK_BYTES_PER_S,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self.url = check_relay_url(url)
        self._events = events
        self._extra_ca: str | bytes | None = None
        if extra_ca_file is not None:  # read and checked here, in the caller's thread
            self._extra_ca = _read_ca_file(Path(extra_ca_file))
        self._proxy: bool | None = True if use_proxy else None
        self._ping_interval = ping_interval
        self._pong_timeout = pong_timeout
        self._send_timeout = send_timeout
        if not min_uplink > 0:
            raise ValueError("min_uplink must be positive")
        self._min_uplink = min_uplink
        self._sleep = sleep or asyncio.sleep
        self._rng = rng or random.SystemRandom()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._connect: Any = None
        # State below belongs to the worker thread (main-thread calls reach it through call_soon_threadsafe).
        self._pending: collections.deque[tuple[int, str | bytes]] = collections.deque()
        self._wakeup = asyncio.Event()
        self._stopping = asyncio.Event()
        self._stop_requested = False
        self._final: str | bytes | None = None
        self._final_sent = False
        self._retry_after: float | None = None  # retryAfterS of an error on the current connection
        self._ws: Any = None
        self._ping_id: str | None = None
        self._pong_deadline: float | None = None
        #: Bytes handed to the socket on this connection; at the outstanding ping; at the last answered ping (and when
        #: that was, on the loop's clock).
        self._written = self._ping_mark = self._confirmed = 0
        self._confirmed_at = 0.0
        #: Inbound text frames that were not a JSON object, and frames dropped because their connection had ended
        #: (counts only; their content is never logged).
        self.dropped_inbound = 0
        self.dropped_outbound = 0
        #: Frames removed by :meth:`discard_queued`.
        self.discarded_outbound = 0

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Start the worker thread (once). Raises ``ImportError`` if ``websockets`` is not installed (SLC-10)."""
        if self._thread is not None:
            raise RuntimeError("RelayTransport.start() called twice")
        from websockets.asyncio.client import connect  # noqa: PLC0415 — installed after consent (SLC-10)
        from websockets.version import version  # noqa: PLC0415

        # 17.2 is the tested version (ADR 0009); ≥ 15 has the proxy and redirect API used here — older ones fail late
        if int(version.split(".")[0]) < 15 or not callable(
            getattr(connect, "process_redirect", None)
        ):
            raise ImportError(
                "RemoteView needs websockets 17.2 (proxy support and redirect control)"
            )

        class _NoRedirect(connect):
            def process_redirect(self, exc: Exception) -> Exception:
                return exc  # a 3xx is an error: data goes only to the configured relay host

        self._connect = _NoRedirect
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._main, name="RemoteView-transport", daemon=True)
        self._thread.start()

    def send(self, frame: Frame, *, connection: int) -> bool:
        """Queue ``frame`` (a JSON-able mapping or ``str`` → text frame, bytes → binary frame) for ``connection``.

        Thread-safe. Raises ``ValueError``/``TypeError`` for a frame the relay would refuse (§3.3). Returns
        ``False`` when the transport is not running; a frame whose connection has ended is dropped later.
        """
        data = _encode(frame)
        if self._loop is None or not self.running:
            return False
        try:
            self._loop.call_soon_threadsafe(self._push, connection, data)
        except RuntimeError:  # the loop closed in between: the thread has ended
            return False
        return True

    def stop(self, final: Frame | None = None, *, timeout: float = STOP_GRACE_S + 1.0) -> bool:
        """Stop for good: drop queued frames, send ``final`` (e.g. ``session.close``) if connected, close with 1000.

        Thread-safe; waits up to ``timeout`` seconds and returns whether the worker thread has ended. Only the first
        call's ``final`` counts: a later ``stop()`` (e.g. a waiting one at exit after ``stop(final, timeout=0)``) only
        waits.
        """
        data = None if final is None else _encode(final)
        if self._loop is None or self._thread is None:
            return True
        with contextlib.suppress(RuntimeError):  # loop already closed: nothing left to stop
            self._loop.call_soon_threadsafe(self._request_stop, data)
        self._thread.join(timeout)
        return not self._thread.is_alive()

    # ------------------------------------------------------------------ worker thread

    def _main(self) -> None:
        loop = self._loop
        if loop is None:  # start() sets it before the thread starts
            return
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._run())
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    def _emit(self, event: Event) -> None:
        self._events.put(event)

    def discard_queued(self, *, connection: int) -> bool:
        """Drop every frame still waiting for ``connection`` — e.g. the rest of a snapshot the relay refused. The frame
        being written is finished; frames of other connections stay. Thread-safe; ``False`` when not running."""
        if self._loop is None or not self.running:
            return False
        try:
            self._loop.call_soon_threadsafe(self._discard, connection)
        except RuntimeError:  # the loop closed in between: the thread has ended
            return False
        return True

    def _discard(self, connection: int) -> None:
        kept = [item for item in self._pending if item[0] != connection]
        self.discarded_outbound += len(self._pending) - len(kept)
        self._pending.clear()
        self._pending.extend(kept)

    def _push(self, connection: int, data: str | bytes) -> None:
        if not self._stop_requested:
            self._pending.append((connection, data))
            self._wakeup.set()

    def _request_stop(self, final: str | bytes | None) -> None:
        # the first stop() wins: a later one must not drop its final message
        if self._stop_requested:
            return
        self._stop_requested = True
        self._pending.clear()
        self._final = final
        self._wakeup.set()
        self._stopping.set()
        # a send stuck on a peer that stopped reading would hold the stop for SEND_TIMEOUT_S: abort it instead
        asyncio.get_running_loop().call_later(STOP_GRACE_S, self._abort)

    def _abort(self) -> None:
        if self._ws is not None:
            self._ws.transport.abort()  # not in the websockets docs; covered by test_transport (websockets==17.2)

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        failures = connections = 0
        current: int | None = None  # the open connection stop() ended, for the final event
        try:
            while not self._stop_requested:
                error: TransportError | None = None
                opened_at = loop.time()
                try:
                    self._ws = await self._open()
                    if self._ws is not None:
                        connections += 1
                        current, opened_at = connections, loop.time()
                        self._emit(Connected(current))
                        error = await self._serve(self._ws, current)
                except Exception as exc:  # noqa: BLE001 — every failure becomes a classified TransportError
                    error = classify(exc)
                finally:
                    self._ws = None
                    # frames queued for the connection that has just ended
                    self.dropped_outbound += len(self._pending)
                    self._pending.clear()
                if error is None or self._stop_requested:
                    break
                lived = loop.time() - opened_at if current is not None else 0.0
                delay, failures = self._backoff(error, failures, lived)
                self._emit(Disconnected(current, error, delay))
                current = None
                if delay is None:
                    return
                await self._wait(delay)
            self._emit(Disconnected(current, None, None, final_sent=self._final_sent))
        except Exception as exc:  # noqa: BLE001 — a bug must still end with a final event
            _log.error("transport: internal error (%s)", type(exc).__name__)
            self._emit(
                Disconnected(None, TransportError(ErrorKind.INTERNAL, retryable=False), None)
            )

    def _backoff(
        self, error: TransportError, failures: int, lived: float
    ) -> tuple[float | None, int]:
        """``(delay, or None to stop; failures for the next round)`` after ``error`` ended a connection open for
        ``lived`` seconds (0 for a failed attempt), following ``failures`` failures in a row."""
        retry_after, self._retry_after = self._retry_after, None
        if not error.retryable:
            return None, failures + 1
        # §9.3: the relay restarts; quick retry, then a fresh backoff
        if error.close_code == _RESTARTING:
            delay, failures = self._rng.uniform(0.0, RESTART_JITTER_S), -1
        else:
            if lived >= STABLE_AFTER_S:
                failures = 0
            base = min(BACKOFF_MAX_S, BACKOFF_MIN_S * 2 ** min(failures, 16))
            delay = min(BACKOFF_MAX_S, base * self._rng.uniform(0.8, 1.2))
        if retry_after is not None and error.close_code in _RETRY_AFTER_CLOSE_CODES:
            delay = max(delay, retry_after)
        return delay, failures + 1

    async def _wait(self, delay: float) -> None:
        """The backoff wait, cut short by stop()."""
        sleeper = asyncio.ensure_future(self._sleep(delay))
        stopper = asyncio.ensure_future(self._stopping.wait())
        await asyncio.wait({sleeper, stopper}, return_when=asyncio.FIRST_COMPLETED)
        for task in (sleeper, stopper):
            task.cancel()
        await asyncio.gather(sleeper, stopper, return_exceptions=True)

    def _tls_context(self) -> ssl.SSLContext:
        context = ssl.create_default_context()  # verifies the chain and the host name
        context.keylog_filename = None  # SSLKEYLOGFILE would write the session keys to disk
        if self._extra_ca is not None:
            # adds to the defaults (cafile= in create_default_context would replace them)
            context.load_verify_locations(cadata=self._extra_ca)
        return context

    async def _open(self) -> Any:
        """A new connection, or ``None`` if stop() came first."""
        secure = urlsplit(self.url).scheme == "wss"
        options: dict[str, Any] = {"ssl": self._tls_context()} if secure else {}
        connecting = asyncio.ensure_future(
            self._connect(
                self.url,
                compression=None,  # §3.1
                user_agent_header=f"SlicerRemoteView/{__version__}",
                proxy=self._proxy if secure else None,  # ws:// is loopback-only: never via a proxy
                open_timeout=OPEN_TIMEOUT_S,
                ping_interval=None,  # one heartbeat: the application ping (§9.1); relay pings are still answered
                close_timeout=CLOSE_TIMEOUT_S,
                max_size=MAX_INBOUND_BYTES,
                logger=_WS_LOGGER,
                **options,
            )
        )
        stopper = asyncio.ensure_future(self._stopping.wait())
        await asyncio.wait({connecting, stopper}, return_when=asyncio.FIRST_COMPLETED)
        stopper.cancel()
        if not self._stop_requested:
            return connecting.result()  # raises the connect error
        connecting.cancel()
        [ws] = await asyncio.gather(connecting, return_exceptions=True)
        if not isinstance(ws, BaseException):
            ws.transport.abort()
        return None

    async def _serve(self, ws: Any, connection: int) -> TransportError | None:
        """Run one open connection until it ends: ``None`` after stop(), else why it ended."""
        self._ping_id = self._pong_deadline = self._retry_after = None
        self._written = self._ping_mark = self._confirmed = 0
        self._confirmed_at = asyncio.get_running_loop().time()
        reader = asyncio.ensure_future(self._read(ws, connection))
        writer = asyncio.ensure_future(self._write(ws, connection))
        done, _ = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
        ended = writer if writer in done else reader
        for task in (reader, writer):
            task.cancel()
        await asyncio.gather(reader, writer, return_exceptions=True)
        exc = ended.exception()
        if exc is None:  # the writer returns only for stop()
            with contextlib.suppress(Exception):
                await ws.close(1000)
            return None
        # heartbeat or send timeout (the peer may be gone: no closing handshake), or an unexpected error; a no-op
        # when the relay already closed the connection
        ws.transport.abort()
        return classify(exc)

    async def _read(self, ws: Any, connection: int) -> None:
        async for frame in ws:  # ends on a normal close, raises ConnectionClosedError otherwise
            if not isinstance(frame, str):
                self._emit(Received(connection, bytes(frame)))
                continue
            message = _parse(frame)
            if message is None:
                self.dropped_inbound += 1
            elif (
                self._ping_id is not None
                and message.get("type") == "pong"
                and (message.get("replyTo") == self._ping_id)
            ):
                self._ping_id = self._pong_deadline = None
                # the relay has read everything written before this ping
                self._confirmed, self._confirmed_at = (
                    self._ping_mark,
                    asyncio.get_running_loop().time(),
                )
                self._wakeup.set()  # the writer waits for the deadline: let it schedule the next ping
            else:
                if message.get("type") == "error":
                    self._note_retry_after(message.get("details"))
                self._emit(Received(connection, message))
        raise _ClosedError(ws.close_code)

    def _note_retry_after(self, details: Any) -> None:
        """Each relay ``error`` replaces the floor: its ``details.retryAfterS`` (bounded), or none."""
        self._retry_after = None
        value = details.get("retryAfterS") if isinstance(details, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return
        # a JSON integer of either sign can be too large for a float (OverflowError)
        if isinstance(value, int):
            value = max(0, min(value, int(MAX_RETRY_AFTER_S)))
        elif not math.isfinite(value):
            return
        self._retry_after = min(MAX_RETRY_AFTER_S, max(0.0, float(value)))

    async def _write(self, ws: Any, connection: int) -> None:
        loop = asyncio.get_running_loop()
        next_ping: float | None = None
        pings = 0
        while True:
            if self._stop_requested:
                if self._final is not None:
                    await self._send(ws, self._final)
                    self._final_sent = True
                return
            now = loop.time()
            awaiting_pong = self._pong_deadline is not None
            if awaiting_pong and now >= self._pong_deadline:
                raise _HeartbeatTimeoutError
            if not awaiting_pong and next_ping is not None and now >= next_ping:
                pings += 1
                self._ping_id = f"hb-{pings}"
                self._ping_mark = self._written
                # at most what is written since the last answered ping, less what a link of the minimum speed has
                # read since, and what the buffers hold
                unread = (
                    self._written - self._confirmed - self._min_uplink * (now - self._confirmed_at)
                )
                unread = max(0.0, min(unread, MAX_UNREAD_BYTES))
                # set before the send: the pong may arrive before the send returns
                self._pong_deadline = now + self._pong_timeout + unread / self._min_uplink
                next_ping = now + self._ping_interval
                await self._send(ws, _encode(envelope("ping", self._ping_id)))
            elif self._pending:
                target, data = self._pending.popleft()
                if target != connection:
                    self.dropped_outbound += 1
                    continue
                await self._send(ws, data)
                if next_ping is None and isinstance(data, str):
                    # §3.1: session.create/resume is the first message; pings follow it
                    next_ping = loop.time() + self._ping_interval
            else:
                self._wakeup.clear()
                wake_at = self._pong_deadline if awaiting_pong else next_ping
                timeout = None if wake_at is None else max(0.0, wake_at - now)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wakeup.wait(), timeout)

    async def _send(self, ws: Any, data: str | bytes) -> None:
        try:
            await asyncio.wait_for(ws.send(data), self._send_timeout)
        except TimeoutError:
            raise _SendTimeoutError from None
        self._written += len(data)
