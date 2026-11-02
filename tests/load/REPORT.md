# Load test report (QA-08)

System-level load scenarios against the built relay, started by the harness on 127.0.0.1 (`tests/load/`, docs/plan/qa.md QA-08). Tooling: Node `ws` clients in the Playwright test process (`docs/research/qa-load-tooling.md`). Raw figures of a run: the `[QA-08] <label> {json}` lines on stdout and the `load-metrics-<label>.json` attachments of each test. Metrics hold counts, sizes and times only: never a session code, a token or scene bytes (NFR-12).

Commands (from the repo root; the scenarios run one at a time in one worker):

- CI: `npm --prefix tests run load:smoke` (target < 5 min).
- Local reference run: `npm --prefix tests run load:full`.
- Stability: add `-- --repeat-each=3 --workers=1`.

## Template (copy per run)

```
## Run <YYYY-MM-DD> — <load:smoke | load:full> — <pass | fail>
- Commit: <sha> (<branch>), <uncommitted files, if any>
- Relay: built, staged by the harness (NODE_ENV=test, LOG_LEVEL=info, TRUST_PROXY=true); non-default env: <...>
- Machine: <CPU (sysctl -n machdep.cpu.brand_string / lscpu)>, <cores>, <RAM>, <OS>, Node <v>, Playwright <v>
- Contention: <uptime load averages; other work on the machine>
- Command: <exact command>, <N passed / failed, duration>
```

One row per scenario; results as min / median / max over the runs.

| Scenario | Size | Metric | Criterion | Result | Pass |
|---|---|---|---|---|---|
| (a) unpaced | 20 viewers × 20 MiB | fan-out ms (begin → last viewer holds the verified GLB); ack streamed/deferred | ≤ 5000 (NFR-05) | | |
| (a) 10 MiB/s uplink | 20 viewers × 20 MiB | fan-out ms; all streamed | ≤ 5000, 20/20 via stream | | |
| (b) | 10 sessions × 5 viewers | max per-session fan-out; update p95; closes | ≤ 5000; ≤ 500 ms; none | | |
| (c) | 64 MiB, 64 MiB + 1 B, budget fill | error codes; RSS before / peak / after | `PAYLOAD_TOO_LARGE`, `CAPACITY`; peak < budget + 256 MiB (NFR-06, T2) | | |
| (d) | 20 viewers, 10 updates/s | p50 / p95 / max ms; missing; out of order | p95 ≤ 500 ms (NFR-02); 0; 0 | | |
| (e) | 1 paused of 20 viewers × 20 MiB | slow-viewer outcome, chunks before deferral; others' fan-out, ack, closes | deferred at 4 MiB (≥ 4 chunks, < all) or `4010`; others streamed ≤ 5000, none closed (FR-24) | | |

Also record: close codes of every viewer, deferrals (`ack.viewersDeferred`), relay errors other than the ones (c) provokes, and notes (threshold failures that happen only under contention are marked as such and re-run serially).

## Run 2026-11-02 — load:smoke and load:full — pass

- Commit `9cfa302` (`ws/qa`) plus the QA-08 files, uncommitted.
- Relay: built, staged by the harness (NODE_ENV=test, LOG_LEVEL=info, TRUST_PROXY=true). (c) sets `MAX_TOTAL_SNAPSHOT_BYTES` explicitly: 134217728 (128 MiB) in smoke, 536870912 (the 512 MiB default) in full.
- Machine: Apple M3 Ultra, 28 cores, 96 GiB RAM, macOS 27.0.1, Node v22.23.3, Playwright 1.60.0, ws 8.22.0. Loopback only (no network latency, bandwidth limit or TLS).
- Contention: the machine was shared with about 10 other agents running tests. Load averages were 2.4–6.2 during the review runs below (2026-11-02 23:50 to 2026-11-03 00:05 local) and 4–32 during the implementer's earlier runs. No threshold failed. NFR-05's "on 1 vCPU" is not reproduced: the relay was not pinned to one core (macOS cannot; see the tooling note).
- Commands (from `tests/`):
  - `npx playwright test --project=load-smoke --repeat-each=3 --workers=1`: 18 passed, 1.6 min, twice (review).
  - `npx playwright test --project=load-full --repeat-each=3 --workers=1`: 18 passed, 4.8 min (review).
  - Implementer, same day: load-smoke 18 passed twice. load-full 18 passed once, and once had 11 passed / 1 failed, the failure being (b) unpaced at 20 MiB (note 2). (b) has used 10 MiB/s uplinks since.

### load:smoke (6 runs per test)

| Scenario | Size | Result | Pass |
|---|---|---|---|
| (a) unpaced | 20 × 20 MiB | fan-out 473 / 482 / 485 ms; ack 0 streamed / 20 deferred, all 20 held it via `ready` + HTTP; streams cut after 4–5 chunks | yes |
| (a) 10 MiB/s uplink | 20 × 20 MiB | fan-out 1919 / 1924 / 1927 ms; 20 / 20 streamed | yes |
| (b) | 10 × 5, 4 MiB each at 10 MiB/s, 20 updates per session at 10/s | per-session fan-out 322 / 346 / 369 ms; update p50 0.6–1.6, p95 1.7 / 3.0 / 3.3, max ≤ 6.9 ms; 1000 samples per run, 0 missing, 0 out of order; 50 / 50 open; RSS peak 169–183 MiB | yes |
| (c) | budget 128 MiB | 64 MiB accepted (fan-out to one viewer 163 / 166 / 168 ms); 64 MiB + 1 B → `PAYLOAD_TOO_LARGE` (`replyTo` = begin id, `retryable: false`, `details.maxSnapshotBytes` 67108864, no close; a chunk of that version ignored); with 2 × 64 MiB cached a third begin → `CAPACITY` (`retryable: true`); first cache still served intact. RSS before / peak / after 86–90 / 259–319 / 259–318 MiB, limit 384 | yes |
| (d) | 20 viewers, 10/s for 15 s | p50 0.9–1.3, p95 1.6 / 2.4 / 2.9, max 3.5–7.2 ms; 3000 samples per run, 0 missing, 0 out of order, 10.0 Hz kept | yes |
| (e) | 1 paused of 20, 20 MiB at 10 MiB/s | slow viewer streamed at `begin`, cut after 6 of 20 chunks, then `ready` + HTTP once it read again; ack 19 streamed / 1 deferred; the other 19 streamed in 1919 / 1924 / 1927 ms, none closed, no errors | yes |

### load:full (3 runs per test in the review)

| Scenario | Size | Result | Pass |
|---|---|---|---|
| (a) unpaced | 20 viewers, 3 × 20 MiB | fan-out 466 / 510 / 582 ms (implementer: up to 2520 ms at load average ≈ 13); every cycle 0 / 20 streamed, all via HTTP; streams cut after 4–5 chunks in cycle 1, 9–17 in cycles 2–3 | yes |
| (a) 10 MiB/s uplink | 20 viewers, 3 × 20 MiB | fan-out 1918 / 1922 / 1927 ms; 20 / 20 streamed every cycle | yes |
| (b) | 10 × 5, 20 MiB each at 10 MiB/s (200 MiB cached, 1000 MiB egress), 100 updates per session | per-session fan-out 1920 / 1943 / 1963 ms; p50 1.2–1.4, p95 2.5 / 2.7 / 2.7, max ≤ 8.5 ms; 5000 samples per run, 0 missing; 50 / 50 open; RSS peak 340–352 MiB | yes |
| (c) | default 512 MiB budget | `PAYLOAD_TOO_LARGE` as in smoke; 8 × 64 MiB cached, the 9th begin → `CAPACITY`. RSS 87–89 / 656–667 / 656–667 MiB, limit 768 | yes |
| (d) | 20 viewers, 10/s for 60 s | p50 1.1–1.3, p95 2.2 / 2.2 / 2.2, max 7.1–8.7 ms; 12000 samples per run, 0 missing, 0 out of order; RSS flat at ≈ 89 MiB | yes |
| (e) | 1 paused of 20, 3 × 20 MiB at 10 MiB/s | slow viewer cut after 6 of 20 chunks in cycle 1 and deferred at `begin` in cycles 2–3 (its buffer still full); afterwards it held version 3 via `ready` + HTTP; ack 19 / 1 every cycle; the others 1917 / 1921 / 1924 ms, all streamed, none closed | yes |

Every passing run ended with every viewer open. The only publisher errors were the two that (c) provokes.

### Notes

1. Unpaced, the relay receives a whole 20 MiB snapshot from a loopback publisher in a few event-loop turns. Every viewer then reaches the 4 MiB soft watermark after 4–5 chunks and is deferred to `ready` + HTTP (§6.4, §6.5; the same effect as report `docs/testing/reports/2026-10-27-release-1.md`). NFR-05 is still met through the HTTP path. The streaming path is measured with a 10 MiB/s publisher uplink.
2. In one of the implementer's full runs, (b) with ten unpaced 20 MiB publishers closed one reading viewer `4010` (reason `BUDGET`, 4.0 MiB buffered). All 50 viewers sat at the soft watermark together (≈ 200 MiB), above `MAX_TOTAL_BUFFERED_BYTES` (160 MiB). This is the specified rule, not a bug: protocol §3.3, and §9.2 `SLOW_CONSUMER` "evicted under `MAX_TOTAL_BUFFERED_BYTES`", architecture §4. `server` may consider whether a viewer that is merely at the soft watermark should be deferred instead while the publisher pause applies. That run's figures: max per-session fan-out 1575 ms, 50 deferred, RSS peak 421 MiB.
3. RSS is sampled with `ps -o rss=` every 100 ms, so the peak is a lower bound. "After" is not a leak check: there is no forced GC, and Node keeps freed off-heap memory. The relay's own SRV-21 smoke covers leaks.
4. Loopback has no network latency, so NFR-02 is barely stressed here. Classroom Wi-Fi with 20 phones, 4G and a 1-vCPU container (`docker run --cpus=1`) remain manual.
5. The (e) runs end well before 60 s, so the `STUCK` (> 60 s) and hard-watermark `4010` paths are not exercised. The deferral outcome is the one asserted; the test also accepts a `4010` close if the relay chooses it.

## Run 2026-11-03 — load:smoke and load:full (serial, quiet machine) — pass

- Commit `09a3efc`…`5682e33` (`ws/qa`; `tests/load/` uncommitted, identical to the QA-08 commit).
- Machine: Apple M3 Ultra, 28 cores, 96 GiB, macOS 27.0.1, Node v22.23.3, Playwright 1.60.0. Nothing else ran: load
  averages 3.4 → 2.7 during load:full.
- Commands (from the repo root, `CI=1`): `npm --prefix tests run load:smoke` — 6 passed, 31.6 s (after e2e and security in
  the same serial pass); `npm --prefix tests run load:full -- --workers=1` — 6 passed, 1.6 min.

| Scenario | load:full result | Pass |
|---|---|---|
| (a) unpaced, 20 × 20 MiB, 3 cycles | fan-out 506 / 515 / 508 ms; 0 streamed / 20 deferred each cycle (cut after 4–13 chunks), all via `ready` + HTTP | yes |
| (a) 10 MiB/s uplink | fan-out 1924 / 1925 / 1926 ms; 20 / 20 streamed | yes |
| (b) 10 × 5, 20 MiB each | max per-session fan-out 1961 ms, 0 deferred; 5000 update samples p50 1, p95 2.6, max 3.8 ms, 0 missing; RSS 88 → peak 347 MiB | yes |
| (c) 512 MiB budget | 64 MiB accepted (171.6 ms), 64 MiB + 1 B → `PAYLOAD_TOO_LARGE`, 8 × 64 MiB cached then `CAPACITY`; RSS 90 → peak 662 MiB (limit 768) | yes |
| (d) 20 viewers, 10/s for 60 s | 12000 samples, p50 1, p95 2.0, max 6.5 ms, 0 missing, 0 out of order; RSS flat ≈ 89 MiB; 20 / 20 open | yes |
| (e) 1 paused of 20, 3 × 20 MiB | ack 19 streamed / 1 deferred each cycle; the others 1923–1924 ms; the slow viewer held version 3 via `ready` + HTTP | yes |

The figures of the shared-machine runs above hold on a quiet machine; no threshold is near its limit on loopback.
