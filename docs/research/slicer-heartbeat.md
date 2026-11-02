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

Protocol v1.1 §9.1 (SLC-40; SLC-26 before it with an 8 MiB cap instead of the time cap):

- **Deadline.** A `ping`'s deadline is `pong_timeout + min(MAX_PONG_EXTENSION_S, B / MIN_UPLINK_BYTES_PER_S)`, with
  `MIN_UPLINK_BYTES_PER_S` = 125 000 (1 Mbit/s), `MAX_PONG_EXTENSION_S` = 60 s (the relay's own silence bound, two 30 s
  ticks) and `B` the bytes the relay may not have read yet. §9.1 defines `B` as the bytes written before the `ping`,
  less what 1 Mbit/s has moved *since they were written*: the transport keeps it as a queue that a link of the minimum
  speed drains, `B ← max(0, B − MIN_UPLINK × (now − then)) + size(frame)` (bytes; UTF-8 for text) at every frame written
  (dated when `send()` returns, so `B` errs on the long side), and never more than the bytes written since the last
  `ping` the relay answered (its `pong` says everything before it was read). An idle spell earns no credit: SLC-26's
  `written − confirmed − MIN_UPLINK × (now − confirmed_at)` credited the time since the last `pong`, so an upload that
  started more than ≈ 10 s after one was cut on a link within ≈ 15 % of 1 Mbit/s (SLC-40 review; the scaled test
  `…_after_an_idle_spell_at_exactly_the_minimum_uplink`).
- **Any frame answers for the downlink.** The connection ends only when nothing at all arrives from the relay within
  the deadline — another frame (an ack, `viewer.count`, an error, a binary frame) counts as much as the `pong`. Only
  the `pong` confirms what the relay read. Since another frame clears a `ping`'s deadline, the next `ping` can go
  before its `pong`; the transport remembers the last few `ping`s it sent, and a `pong` for any of them confirms what
  was written before that `ping` (`pong`s come in order, so the older ones are done too).
- **Write-ahead.** `B` stays at most `WRITE_AHEAD_BYTES` = 4 MiB (≈ 34 s at 1 Mbit/s; three full chunks): a frame that
  would take it past that waits until a `pong` confirms more or the queue drains enough (a lone frame larger than the
  write-ahead goes once `B` is 0). A `ping` goes out of cycle after every 2 MiB written, so on a fast uplink its `pong`
  is back before the writer reaches the 4 MiB and the writer is not held to 4 MiB per 15 s. A `ping`'s deadline is
  then at most 10 s + 4 MiB / 125 000 B/s ≈ 44 s.

What follows:

- Idle connection: `B` is about 0 (a few hundred bytes of control frames, carried in milliseconds), the deadline is
  the protocol's 10 s.
- A peer that reads but never answers and sends nothing: the heartbeat ends the connection within 10 s + 60 s = 70 s,
  ≈ 44 s with the write-ahead. **This is longer than NFR-21's 25 s** for dead-peer detection: with the backlog unread, a
  dead peer and a slow one look the same to the publisher. The deadline is also checked only between sends, so a
  `send()` blocked on a full buffer can hold it back by up to `send_timeout` (60 s), after which the connection ends
  anyway (`MAX_SILENCE_S` = 205 s adds these up). Reported in `docs/testing/reports/2026-10-20-slicer-6.md`; protocol
  v1.1 adopted the rule.
- A peer that stops *reading* during an upload: once `B` reaches the write-ahead the writer slows to the 1 Mbit/s
  pace, the `ping` goes unanswered and the deadline ends the connection; a `send()` that blocks first is ended by
  `send_timeout` (60 s).
- A link slower than 1 Mbit/s with a large backlog is taken for dead (the 60 KB/s row): the connection is resumed
  (SLC-44) and the snapshot sent again.
- Stop during an upload: `stop()`'s final `session.close` is never held by the write-ahead, but it still goes behind the
  bytes written before it, and `stop()` aborts the socket `STOP_GRACE_S` = 2 s later. `final_sent` is true when a 1
  Mbit/s link carries the close and the bytes ahead of it within those 2 s less a 0.5 s margin (framing, latency) and no
  close frame came back, or when the relay's close 1000 came back — it follows everything ahead of ours, so on a fast
  link it proves what the estimate cannot; a close frame with another code says it did not handle it (e.g. a refusal —
  1008 for a `session.close` that went as the first frame of a new socket, 4006 over the budget — or a drop: 1009, 1011,
  4007, 4009–4011), so `final_sent` is false — also for 4001, 4002 and 4008, after which the relay keeps no session, so
  the warning is needless there (follow-up for SLC-59). This relies on the relay answering a close only after it has
  handled the frames before it: `relay-server` does (`ws` parses frames in order and its handlers are synchronous); a
  WebSocket stack with a receive queue (like the tests' fake relay) or a proxy that terminates WebSocket could answer
  first — `[TODO verify]` that Railway's edge forwards close frames and never answers one itself. So on a link of at
  least 1 Mbit/s the panel warns (`FINAL_NOT_SENT`) whenever the relay may keep the session; on a slower one it may not
  (SLC-59). (SLC-40 review: a writer held at the write-ahead hands the close over at once, behind up to 4 MiB.) On a
  real slow path the socket buffers hold much less than 4 MiB, so the writer is usually inside the `send()` of a 1 MiB
  chunk (≈ 8 s at 1 Mbit/s) when the abort fires and the close is not sent at all. When it was handed to the socket, the
  abort can still lose it: after the abort the relay's `pong` to a `ping` in the backlog meets a closed socket, which
  answers with a reset that discards the queued bytes (reproduced in the SLC-40 review with a forwarding proxy at a
  scaled 1 MB/s: no `session.close` at the relay in 3 of 3 runs). The relay then keeps the session in grace; report
  `2026-10-20-slicer-6` (second part) stays open: Stop → SLC-59, Slicer exit (≤ 3 s) a residual for `release`.

Rejected: sending no `ping` while chunks are queued (the `ping` goes out after the chunk anyway — the problem is the
bytes already written), and limiting the kernel's send buffer (`SO_SNDBUF`) — it would cap throughput on high-latency
links to window / RTT; the write-ahead holds frames in the transport's own queue instead, with a `pong` (not a fixed
window) or the drained estimate deciding when to go on.

## Queued frames of a refused snapshot

The relay ignores the chunks of a snapshot it refused (`docs/protocol.md` §6.2), but the panel queues the whole
snapshot at once. `RelayTransport.discard_queued(connection=…)` drops the frames still waiting for a connection; the
panel calls it when the relay refuses the snapshot, so the rest of a 32 MiB scene is not uploaded for nothing. The bytes
already in the buffers still go out.

## Not verified

- A real WAN uplink (bufferbloat, Wi-Fi) and the Windows/macOS socket-buffer sizes — manual §2 step 16.
- `[TODO verify]` Whether a `session.close` handed to the socket before `stop()`'s abort ever reaches the relay on a
  real link: the abort (`transport.abort()`, not in the `websockets` docs) drops what the user-space buffer still
  holds, and a reset from the peer side drops the kernel's queue too. It needs a real slow link (`tc netem`, a phone
  hotspot) — the throttle proxy of manual §2 step 16 drops its own queue when the client closes — SLC-59.
- The relay's own WebSocket-level ping (every 30 s) while its `pong` waits behind queued chunks: *answered* — since
  SRV-27 a publisher's complete frames excuse a late pong one interval at a time (report `2026-10-27-server-2`), and a
  run against `relay-server` from `main` (6.7 MB at 1 Mbit/s, the real 30 s heartbeat) was acknowledged without a
  `4009` (report `2026-10-20-slicer-7`, status update).
