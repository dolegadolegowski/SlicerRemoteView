// QA-08 load smoke (CI, `npm --prefix tests run load:smoke`): the scaled load scenarios against the built relay
// through the harness, Node `ws` clients in this process (docs/research/qa-load-tooling.md). Sizes:
//   (a) 1 session × 20 viewers, one 20 MiB snapshot: fan-out ≤ 5 s (NFR-05, US-08) — once unpaced (loopback burst:
//       every viewer is deferred to the HTTP path) and once over a 10 MiB/s publisher uplink (all streamed).
//   (b) 10 sessions × 5 viewers, a 4 MiB snapshot each at once (10 MiB/s uplinks), then 20 updates per session
//       at 10/s: per-session fan-out ≤ 5 s, p95 ≤ 500 ms, every viewer holds its own session's GLB, none closed.
//   (c) 64 MiB accepted, 64 MiB + 1 B refused `PAYLOAD_TOO_LARGE`, budget filled → `CAPACITY`, with the global
//       budget scaled to 128 MiB: relay RSS peak < 128 + 256 MiB (NFR-06, T2, T3).
//   (d) 10 `scene.update`/s for 15 s (not 60) to 20 viewers: p95 send → receive ≤ 500 ms (NFR-02, FR-20).
//   (e) one viewer of 20 that reads nothing during a 20 MiB snapshot: deferred at the 4 MiB soft watermark
//       (`scene.snapshot.ready` + HTTP) or closed `4010`; the other 19 streamed within 5 s, none closed (FR-24, T3).
// Protocol: docs/protocol.md §3.3 (limits, watermarks), §6.1–§6.5 (snapshot, ready, HTTP path), §8.1/§8.4
// (updates, versions), §9.2/§9.3 (errors, close codes), §10 (`GET /api/scene/:v`). Full sizes: `full.spec.ts`.
// Results and the report template: tests/load/REPORT.md.

import { test } from "../harness/fixtures.ts";
import { MiB } from "./clients.ts";
import { record, runFanout, runMultiSession, runSnapshotLimits, runUpdateLatency } from "./scenarios.ts";

// In order in one worker (overrides the config's `fullyParallel`, playwright/types/test.d.ts
// `test.describe.configure`): the scenarios must not compete with each other for the machine they measure.
test.describe.configure({ mode: "default" });
// Each test gets its own relay; no fake-slicer process (the publisher runs in this process, one clock).
test.use({ stackOptions: { publisher: false, logLevel: "info" } });

/**
 * Publisher uplink for the streaming-path scenarios: 10 MiB/s (≈ 84 Mbit/s). Unpaced, loopback delivers the whole
 * snapshot to the relay in a few event-loop turns and every viewer crosses the 4 MiB soft watermark at once
 * (REPORT.md, report 2026-10-27-release-1); over a real uplink chunks arrive one by one.
 */
const UPLINK = 10 * MiB;

test("(a) 1 session × 20 viewers: a 20 MiB snapshot reaches all within 5 s", async ({ stack }, testInfo) => {
  const metrics = await runFanout(stack, { viewers: 20, snapshotBytes: 20 * MiB, cycles: 1 });
  await record(testInfo, "smoke-a-fanout", metrics);
});

test("(a) streaming path: a 20 MiB snapshot over a 10 MiB/s uplink is streamed to all 20 within 5 s", async ({
  stack,
}, testInfo) => {
  const metrics = await runFanout(stack, {
    viewers: 20,
    snapshotBytes: 20 * MiB,
    cycles: 1,
    uplinkBytesPerS: UPLINK,
    readersStreamed: true,
  });
  await record(testInfo, "smoke-a-stream", metrics);
});

test("(b) 10 sessions × 5 viewers: concurrent snapshots and updates stay isolated and fast", async ({
  stack,
}, testInfo) => {
  const metrics = await runMultiSession(stack, {
    sessions: 10,
    viewersPerSession: 5,
    snapshotBytes: 4 * MiB,
    uplinkBytesPerS: UPLINK,
    updates: 20,
    rateHz: 10,
  });
  await record(testInfo, "smoke-b-sessions", metrics);
});

test.describe("(c) snapshot size limits", () => {
  const budgetBytes = 128 * MiB; // the smallest MAX_TOTAL_SNAPSHOT_BYTES (2 × MAX_SNAPSHOT_BYTES, config.ts)
  test.use({
    stackOptions: { publisher: false, logLevel: "info", env: { MAX_TOTAL_SNAPSHOT_BYTES: String(budgetBytes) } },
  });

  test("(c) 64 MiB accepted, 64 MiB + 1 B refused, budget full → CAPACITY, RSS bounded", async ({
    stack,
  }, testInfo) => {
    const metrics = await runSnapshotLimits(stack, { budgetBytes });
    await record(testInfo, "smoke-c-limits", metrics);
  });
});

test("(d) 10 updates/s for 15 s to 20 viewers: p95 latency ≤ 500 ms", async ({ stack }, testInfo) => {
  const metrics = await runUpdateLatency(stack, { viewers: 20, rateHz: 10, durationS: 15 });
  await record(testInfo, "smoke-d-updates", metrics);
});

test("(e) one slow consumer among 20: deferred or closed 4010, the other 19 unaffected", async ({
  stack,
}, testInfo) => {
  const metrics = await runFanout(stack, {
    viewers: 20,
    snapshotBytes: 20 * MiB,
    cycles: 1,
    slowViewers: 1,
    uplinkBytesPerS: UPLINK,
    readersStreamed: true,
  });
  await record(testInfo, "smoke-e-slow", metrics);
});
