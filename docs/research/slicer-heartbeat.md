# Research — the heartbeat while a snapshot goes out on a slow uplink (SLC-26)

Measured on 2026-10-20 in the sandbox (Linux, loopback, `websockets` 17.2, Node 22) with the real `RelayTransport`, the
relay stub of `tools/fake-slicer` and `slicer-plugin/tests/throttle_proxy.mjs`, a TCP proxy that passes a fixed number of
bytes per second towards the relay. Nothing here ran inside Slicer or on a real WAN (CLAUDE.md rule 10); the manual step
is `docs/testing/slicer.md` §2 step 16.

## What the code does, and why a live upload looked dead

| Fact | Source |
|---|---|
| §9.1: the client sends `ping` every 15 s and closes the socket when no `pong` arrives within 10 s. The relay answers a `ping` when it reads it; it reads the one TCP stream in order, so a `ping` is answered only after every byte written before it | `docs/protocol.md` §9.1, §3.2 |
| `ws.send(frame)` writes the whole frame to the transport and then waits in `drain()` until the user-space write buffer is back under its low-water mark (`write_limit`, default 32 KiB high / 8 KiB low). When `send()` returns, the bytes that are still ahead of the next frame are in the kernel's send buffer, the network and the peer's receive buffer | `websockets` 17.2, `asyncio/connection.py` [`send_context`, the `send_data()` + `drain()` pair at L914–L915](https://github.com/python-websockets/websockets/blob/17.2/src/websockets/asyncio/connection.py#L914-L915), `drain` L1062–L1078 (line numbers of the installed 17.2 wheel) |
| Before SLC-26 the pong deadline was `ping sent + 10 s` whatever was written before the ping. With the bytes ahead of the ping needing longer than that at the uplink's speed, the heartbeat aborted a connection that was working | measured below |

How much the buffers hold, measured on Linux loopback with a peer that accepts the connection and reads nothing:
4.29 MB leave a non-blocking `send()` before it would block (`tcp_wmem` maximum 4 MiB; the receive buffer grows with
auto-tuning). A relay that reads ahead into its own queues holds more. A WAN adds the network's buffers (bufferbloat) and
other operating systems size their buffers differently: `[TODO verify]` on Windows and macOS (manual step 16).

Measurement: the snapshot of a 200×200 sphere (1.43 MB, 11 chunks), timers scaled to `ping_interval` 0.4 s and
`pong_timeout` 1.5 s (so the first `ping` is due long before the chunks are through), the proxy limiting the uplink,
`RelayTransport` with the old rule (`min_uplink=1e15`: no extension) and with the new one (default 125 000 B/s):

| Uplink | Old rule | New rule |
|---|---|---|
| 500 KB/s | heartbeat cut after 1.9 s | acknowledged after 3.0 s |
| 250 KB/s | heartbeat cut after 1.9 s | acknowledged after 6.0 s |
| 125 KB/s (1 Mbit/s) | heartbeat cut after 1.9 s | acknowledged after 11.9 s |
| 60 KB/s | heartbeat cut after 1.9 s | **heartbeat cut after 12.9 s** — slower than the assumed minimum, see below |

## The rule

The deadline of a `ping` is `pong_timeout + unread / MIN_UPLINK_BYTES_PER_S`, where `MIN_UPLINK_BYTES_PER_S` is
125 000 (1 Mbit/s) and

`unread = clamp(written − confirmed − MIN_UPLINK × (now − confirmed_at), 0, MAX_UNREAD_BYTES)`

- `written`: bytes handed to the socket on this connection; `confirmed`: `written` at the last `ping` the relay
  answered (everything before that `ping` is known to be read); `confirmed_at`: when that `pong` arrived (the start of the
  connection before the first one). A link of the minimum speed has read `MIN_UPLINK × elapsed` of the rest by now, so a
  connection that has been uploading steadily is not given the whole backlog again at every `ping`.
- `MAX_UNREAD_BYTES` = 8 MiB: the most the buffers between `send()` and the relay's reader are assumed to hold (measured
  4.3 MB on loopback, above). More written bytes can only mean a link that holds more, which then errs towards an
  earlier abort.

What follows:

- Idle connection: `unread` is 0 (a few hundred bytes of control frames, less than the credit), the deadline is the
  protocol's 10 s.
- A peer that reads but never answers a `ping` behind a full backlog: the heartbeat ends the connection after at most
  10 s + 8 MiB / 1 Mbit/s ≈ 77 s. **This is longer than NFR-21's 25 s** for dead-peer detection: with the backlog
  unread, a dead peer and a slow one look the same to the publisher. The deadline is also checked only between sends, so
  a `send()` blocked on a full buffer can hold it back by up to `send_timeout` (60 s), after which the connection ends
  anyway. Reported to `release`/`protocol` in `docs/testing/reports/2026-10-20-slicer-6.md`.
- A peer that stops *reading* during an upload: `send()` blocks once the buffers are full and `send_timeout` (60 s) ends
  the connection.
- A link slower than 1 Mbit/s with a large backlog is taken for dead (the 60 KB/s row): the session ends with a clear
  text and there is no resume before SLC-17.

Rejected: sending no `ping` while chunks are queued (the `ping` goes out after the chunk anyway — the problem is the
bytes already written), and limiting the kernel's send buffer (`SO_SNDBUF`) — it would cap throughput on high-latency
links to window / RTT.

## Queued frames of a refused snapshot

The relay ignores the chunks of a snapshot it refused (`docs/protocol.md` §6.2), but the panel queues the whole
snapshot at once. `RelayTransport.discard_queued(connection=…)` drops the frames still waiting for a connection; the
panel calls it when the relay refuses the snapshot, so the rest of a 32 MiB scene is not uploaded for nothing. The bytes
already in the buffers still go out.

## Not verified

- A real WAN uplink (bufferbloat, Wi-Fi) and the Windows/macOS socket-buffer sizes — manual §2 step 16.
- How much the relay's own WebSocket-level ping (every 30 s, terminated one tick later) tolerates when the `pong` frame
  waits behind queued chunks on the way out: the library answers it automatically, in order, behind the data already
  written. A connection whose unread bytes need longer than 30–60 s (≤ 0.5 Mbit/s with full buffers) may be closed by the
  relay; `[TODO verify]` against `relay-server` (SRV-14) — reported in `docs/testing/reports/2026-10-20-slicer-7.md`.
