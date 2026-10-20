# ADR 0009: Slicer transport — `websockets` asyncio client on a private event loop in one worker thread

- **Status:** Accepted (2026-10-20, `slicer` workstream; an implementation detail behind `RelayTransport`, reversible
  without a protocol change)
- **Component(s):** `slicer`
- **Related:** `docs/plan/slicer.md` (SLC-08, SLC-10, SLC-17), `docs/protocol.md` §3.1, §3.3, §9.1, §9.3,
  `docs/architecture.md` §8 (T5 TLS, T7 privacy), `docs/research/slicer.md` (Python environment),
  `docs/research/slicer-transport.md` (verified facts behind this ADR)

## Context

The publisher keeps one WebSocket to the relay (`wss://<host>/ws`, protocol §3.1) while Slicer's Qt main thread stays
responsive: socket I/O must not run on the main thread, and VTK/MRML must not run anywhere else. The plan (SLC-08)
assumed `websockets.sync.client.connect` in a `threading.Thread`. Facts verified by running `websockets` 17.2 on
Python 3.12.3 / OpenSSL 3.0.13 (`docs/research/slicer-transport.md`):

- The sync client runs a library thread that reads (`SSL_read`) while the caller writes (`SSL_write`) on the same
  `SSL` object. When the server sends TLS 1.3 session tickets (OpenSSL's default), about 10 % of connects stall until
  `open_timeout` (29–41 of 300 per run, also on Python 3.13). No stall with the `websockets.asyncio` client driven by
  one thread (0 of 300), with TLS 1.2, or with plain `ws://`. OpenSSL documents most objects as unsafe for
  simultaneous use. Whether the Railway edge sends tickets is `[TODO verify]`.
- In the sync client `send()` holds a mutex around a blocking `sendall()` with no timeout after the handshake; a peer
  that stops reading blocks it for ever, and `close()` from another thread blocks on the same mutex. Only shutting the
  socket down from outside unblocks it. In the asyncio client a send waits on `drain()`, which a task timeout can
  cancel, and the transport can be aborted from the loop.
- Both clients raise `ssl.SSLCertVerificationError` (an `OSError` and a `ValueError`) unwrapped; certificate errors
  never fix themselves, but the library's default reconnect classifier retries every `OSError`.
- At DEBUG level the `websockets` loggers print frame payloads (up to 75 characters: enough for a session code or a
  token). `ssl.create_default_context()` honours `SSLKEYLOGFILE` and writes TLS secrets to disk.
- Inside Slicer 5.12.4 `SSL_CERT_FILE` points at Slicer's `Slicer.crt`: on macOS and Linux only that bundle is
  trusted, on Windows also the system store. `create_default_context(cafile=…)` *replaces* the defaults;
  `load_verify_locations` adds to them.
- `proxy=True` (the default since `websockets` 15.0) honours `wss_proxy`/`https_proxy`/`no_proxy` and the static
  Windows/macOS proxy settings; PAC/WPAD, NTLM/Kerberos and SOCKS (without `python-socks`) are not supported.

## Decision

1. `remoteview_core/transport.py` runs the `websockets.asyncio.client` on its **own event loop in one daemon worker
   thread** per `RelayTransport`; the main thread never touches the loop except through thread-safe calls
   (`call_soon_threadsafe`) and a `queue.Queue` of events. No other code in the extension uses asyncio.
2. TLS: a fresh `ssl.create_default_context()` per connection attempt (an edited CA bundle takes effect without a
   restart), `keylog_filename = None`, an optional user-supplied CA file (PEM or DER) added with
   `load_verify_locations`. There is no code path that disables verification (`CERT_NONE`,
   `check_hostname = False`); a test greps for it. Only the lower-case schemes are accepted (the TLS options are chosen
   from the scheme); `ws://` only for `localhost`/`127.0.0.1`/`::1` and never through a proxy (protocol §3.1); URLs
   with user info, a query or a fragment are refused (no secrets in URLs); HTTP redirects are not followed (data goes
   only to the relay host the consent text names).
3. Connection options: `compression=None` (§3.1), `max_size` = 1,114,112 B (the relay's `maxPayload`, §3.3),
   `ping_interval=None` (one heartbeat: the application `ping`/`pong` of §9.1, owned by the transport thread; the
   library still answers the relay's WebSocket pings), `open_timeout` 10 s, `close_timeout` 2 s, `proxy=True`,
   `user_agent_header` `SlicerRemoteView/<version>` (no Python version), a dedicated logger pinned at `WARNING` so
   frame payloads are never logged.
4. The transport sends `ping` every 15 s once the first text message of a connection has gone out (the relay requires
   `session.create`/`session.resume` first, §3.1), and aborts the connection when the `pong` is 10 s late. Each send is
   bounded by a timeout; a stuck send or close aborts the connection instead of hanging.
5. Errors are classified by type, never by message text: certificate verification (by `verify_code`), other TLS,
   proxy authentication (407), unsupported proxy, HTTP status, timeout, DNS, refused, other network, handshake,
   heartbeat, and WebSocket close codes. Certificate, proxy, HTTP 3xx/4xx (except 408/429), the terminal close codes
   of §9.3, 1000 and 1009 stop reconnecting and are reported to the UI with guidance text; everything else reconnects
   with exponential backoff 0.5 s → 30 s with jitter (4008: 0–3 s; after 4005/4006 never sooner than the
   `retryAfterS` of the relay's last `error` on that connection). Exception text is never logged or shown (proxy URLs
   may hold credentials).
6. Frames queued for a connection are never sent on a later one: every `send` names the connection it belongs to,
   so a stale snapshot chunk cannot precede `session.resume` (SLC-17).
7. Runtime requirement: exactly the tested `websockets==17.2` (T12: exact pins; SLC-10 installs it). The API used
   here — asyncio `connect`, `process_redirect`, `ClientConnection.transport` — also exists in 15.0 and 16.0
   (checked in their sources), and `start()` refuses a `websockets` older than 15 or whose `connect` has no
   `process_redirect`.

## Consequences

**Positive:** no TLS 1.3 stall; stop/close/abort are bounded; one thread owns the socket, so `send`, `ping` and
`close` cannot race; the main thread only drains a queue (SLC-09's 50 ms `QTimer`).

**Negative:** an asyncio loop inside Slicer's Python (isolated in its own thread; nothing else may share it);
aborting a stuck connection uses `ClientConnection.transport`, an attribute the `websockets` docs do not list (covered
by a regression test); a DNS lookup that outlives `open_timeout` keeps running in the loop's executor thread, which
Python joins at exit.

**Follow-ups:** SLC-09 — the pump and an "Additional trusted CA certificate" setting; SLC-10 — install
`websockets==17.2`; SLC-17 — resume on `Connected`; manual check in Slicer 5.12.4 (OpenSSL 1.1.1) that a TLS
connection to the relay works on Windows, macOS and Linux (`docs/testing/slicer.md`); `release` — a hospital
TLS-inspection proxy trusted by Windows can read the session (threat model T5, report
`docs/testing/reports/2026-10-20-slicer-1.md`); SLC-09 — `ProtocolClient.build_ping` is no longer used (the
heartbeat lives in the transport thread, so it does not wait for the Qt pump to drain events; like any Python thread it
still needs the GIL, which long VTK calls on the main thread hold — `docs/research/slicer.md` §3).

## Alternatives considered

- **Sync client, stall treated as a retryable connect failure:** simplest, but a 10 s stall on one connect in ten and
  a `send` that can block for ever; rejected.
- **Sync client capped at TLS 1.2:** no stall, weaker transport security for medical data; rejected.
- **Sync client with a subclass that gates the library's reader thread:** relies on private methods; rejected.
- **Qt's `QWebSocket` on the main thread:** no worker thread, but PythonQt's binding of `QtWebSockets` in Slicer is
  `[TODO verify]` and Qt's CA list (`Slicer.crt` loaded once at start-up) differs from Python's; deferred.
- **`truststore` for the OS trust store on macOS/Linux:** one more runtime dependency (FR-16 allows only `websockets`
  and `segno`); deferred — the user-supplied CA file (PEM or DER) covers private CAs.

## Sources

- websockets 17.2 asyncio client: https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/client.py ;
  connection: https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/connection.py
- websockets 17.2 sync client (mutex, reader thread): https://github.com/python-websockets/websockets/blob/17.2/src/websockets/sync/connection.py
- OpenSSL 3.0 threads: https://github.com/openssl/openssl/blob/openssl-3.0.13/doc/man7/openssl-threads.pod
- CPython 3.12.10 `ssl.create_default_context`: https://github.com/python/cpython/blob/v3.12.10/Lib/ssl.py#L682-L718
- Slicer sets `SSL_CERT_FILE`: https://github.com/Slicer/Slicer/blob/v5.12.4/CMake/SlicerBlockCTKAppLauncherSettings.cmake#L282-L285
- websockets proxies: https://github.com/python-websockets/websockets/blob/17.2/src/websockets/proxy.py#L97-L130
