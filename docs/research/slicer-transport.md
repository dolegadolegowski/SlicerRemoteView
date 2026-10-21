# Research — the publisher's WebSocket transport inside Slicer (SLC-08, ADR 0009)

Verified on 2026-10-19/20 for `slicer-plugin/RemoteView/remoteview_core/transport.py`. "Run" means reproduced in the
dev venv (Python 3.12.3, OpenSSL 3.0.13, `websockets` 17.2, whose sources were diffed against the 17.2 tag); Slicer
5.12.4 itself ships Python 3.12.10 and OpenSSL 1.1.1 (manual checks: `docs/testing/slicer.md`, "Re-run after SLC-08").

## 1. `websockets` 17.2

| Fact | Source |
|---|---|
| Sync client: a library thread reads (`SSL_read`) while the caller writes on the same `SSL` object; with TLS 1.3 session tickets (OpenSSL's default 2) ≈ 10–15 % of connects stall until `open_timeout` (29–41 of 300 per run; 15 of 100 re-run on 2026-10-20). No stall with the asyncio client in one thread (0 of 300), TLS 1.2 or `ws://` | [sync/connection.py#L135-L141](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/sync/connection.py#L135-L141), [openssl-threads](https://github.com/openssl/openssl/blob/openssl-3.0.13/doc/man7/openssl-threads.pod), run |
| Sync `send()` holds a mutex around a blocking `sendall()` without timeout; `close()` from another thread waits on it | [sync/connection.py#L961-L1087](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/sync/connection.py#L961-L1087), run |
| Asyncio `send()` writes the frame, then awaits `drain()` with no timeout; `close()` goes through the same path. `ClientConnection.transport.abort()` ends both (attribute set in `connection_made`, not in the docs) | [asyncio/connection.py#L860-L990](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/connection.py#L860-L990), [#L1001-L1079](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/connection.py#L1001-L1079), run |
| Asyncio `connect(uri, *, compression, user_agent_header, proxy, open_timeout, ping_interval, close_timeout, max_size, logger, ssl, …)`; `open_timeout` covers DNS (run in the loop's executor), TCP, proxy, TLS and the upgrade | [asyncio/client.py#L264-L345](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/client.py#L271-L345), [#L520-L560](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/client.py#L520-L560) |
| `connect` follows 3xx redirects (up to 10, also to another host over TLS); `process_redirect(exc)` returning `exc` refuses them | [asyncio/client.py#L448-L518](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/client.py#L448-L518), run |
| `compression=None` sends no `Sec-WebSocket-Extensions`; the default `user_agent_header` is `Python/3.12 websockets/17.2`; `max_size` default 1 MiB (inbound only) | [http11.py#L30-L36](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/http11.py#L30-L36), run |
| `proxy=True` (since 15.0): `wss_proxy`, then SOCKS, then `https_proxy`, `no_proxy`; static Windows registry / macOS proxies; no PAC/WPAD, no NTLM/Kerberos (`InvalidProxyStatus` 407), SOCKS needs `python-socks` (`ImportError`); `InvalidProxy.__str__` contains the proxy URL with its password | [proxy.py#L97-L130](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/proxy.py#L97-L130), [changelog 15.0](https://github.com/python-websockets/websockets/blob/17.2/docs/project/changelog.rst), run |
| At DEBUG the connection logger prints frame payloads (up to 75 characters: a session code or token fits); the level is read when the connection is created | [frames.py#L143](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/frames.py#L143), [protocol.py#L609](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/protocol.py#L609), run |
| Errors come out unwrapped: `SSLCertVerificationError` (also `SSLError`, `OSError`, `ValueError`; `verify_code` 18 self-signed, 19/20/2 unknown issuer, 9/10 dates, 62/64 host/IP mismatch — same codes in OpenSSL 1.1.1, different wording), `InvalidStatus` (`response.status_code`), `TimeoutError`, `gaierror`, `ConnectionRefusedError`, `InvalidMessage`, `ConnectionClosed` (`rcvd.code`, `None` after a drop) | [x509_vfy.h (1.1.1w)](https://github.com/openssl/openssl/blob/OpenSSL_1_1_1w/include/openssl/x509_vfy.h#L101-L166), [exceptions.py](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/exceptions.py), run |

## 2. TLS trust inside Slicer 5.12.4

| Fact | Source |
|---|---|
| Slicer's launcher and `qSlicerCoreApplication` set `SSL_CERT_FILE` to `<Slicer>/share/Slicer-5.12/Slicer.crt` (119 Mozilla roots, incl. ISRG Root X1/X2) on every OS, overwriting a user's value | [SlicerBlockCTKAppLauncherSettings.cmake#L282-L285](https://github.com/Slicer/Slicer/blob/v5.12.4/CMake/SlicerBlockCTKAppLauncherSettings.cmake#L282-L285), [qSlicerCoreApplication.cxx#L304-L349](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerCoreApplication.cxx#L304-L349) |
| `ssl.create_default_context()` loads the Windows "CA"/"ROOT" stores on Windows, then `SSL_CERT_FILE`: Windows trusts `Slicer.crt` + the system store (incl. Group Policy CAs), macOS/Linux only `Slicer.crt`; each new context re-reads the file | [ssl.py#L515-L534, #L682-L718](https://github.com/python/cpython/blob/v3.12.10/Lib/ssl.py#L682-L718), run |
| `create_default_context(cafile=…)` replaces the defaults (1 CA left); `load_verify_locations` adds (120) | [ssl.py#L706-L712](https://github.com/python/cpython/blob/v3.12.10/Lib/ssl.py#L706-L712), run |
| `create_default_context()` honours `SSLKEYLOGFILE` (992 bytes of secrets for one connection); `keylog_filename = None` afterwards stops it (the header line is already written) | [ssl.py#L713-L717](https://github.com/python/cpython/blob/v3.12.10/Lib/ssl.py#L713-L717), run |
| Slicer builds CPython against OpenSSL 1.1.1w (Linux/macOS) and a pre-built 1.1.1g (Windows), both end of life | [External_OpenSSL.cmake#L54-L71](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_OpenSSL.cmake#L54-L71) |
| `certifi` is installed in Slicer but only `requests` uses it; `websockets`, `python-socks` and `truststore` are not part of Slicer | [External_python-requests-requirements.cmake](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_python-requests-requirements.cmake#L18-L62) |

**Consequences in `transport.py`:** asyncio client on a private loop in one worker thread (ADR 0009); a fresh
default context per attempt with `keylog_filename = None` and an optional CA file (PEM or DER) added with
`load_verify_locations`; errors classified by type and `verify_code`, never by text; certificate, proxy and HTTP 4xx
errors stop reconnecting;
redirects refused; `compression=None`, `ping_interval=None` (application heartbeat), `max_size` 1,114,112, a
dedicated logger at WARNING, `user_agent_header` without the Python version; `send()` bounded by a timeout and
`stop()` by an abort.

## 3. Not verified

- The stall and the error codes inside a real Slicer 5.12.4 (OpenSSL 1.1.1) on Windows, macOS and Linux.
- Whether the Railway edge sends TLS 1.3 session tickets, and the issuer of `*.up.railway.app`.
- Real Windows-registry and macOS SOCKS proxies (simulated only); PAC-only networks (not run).
