// QA-08 load, full sizes (local reference-machine run, `npm --prefix tests run load:full`; not in CI): the same
// scenarios as `smoke.spec.ts` at the sizes and durations of docs/plan/qa.md QA-08, against the built relay
// through the harness with Node `ws` clients (docs/research/qa-load-tooling.md):
//   (a) 1 session × 20 viewers, three 20 MiB snapshots, unpaced and over a 10 MiB/s uplink: each ≤ 5 s (NFR-05).
//   (b) 10 sessions × 5 viewers, a 20 MiB snapshot each at once over 10 MiB/s uplinks (200 MiB cached, 1000 MiB
//       egress), then 100 updates per session at 10/s: per-session fan-out ≤ 5 s, p95 ≤ 500 ms, no cross-session
//       bytes, no viewer closed.
//   (c) 64 MiB accepted, 64 MiB + 1 B refused `PAYLOAD_TOO_LARGE`; eight sessions fill the default 512 MiB
//       `MAX_TOTAL_SNAPSHOT_BYTES`, a ninth is refused `CAPACITY`; relay RSS peak < 512 + 256 MiB (NFR-06, T2).
//   (d) 10 `scene.update`/s for 60 s to 20 viewers: p95 send → receive ≤ 500 ms (NFR-02).
//   (e) one viewer of 20 reads nothing through three 20 MiB snapshots: deferred at the 4 MiB soft watermark
//       (`ready` + HTTP once it reads) or closed `4010`; the other 19 streamed each time within 5 s (FR-24, T3).
// Protocol: docs/protocol.md §3.3, §6.1–§6.5, §8.1/§8.4, §9.2/§9.3, §10. Results: tests/load/REPORT.md.

import { test } from "../harness/fixtures.ts";
import { LIMITS } from "@slicerremoteview/shared";
import { MiB } from "./clients.ts";
import { record, runFanout, runMultiSession, runSnapshotLimits, runUpdateLatency } from "./scenarios.ts";

// In order in one worker (playwright/types/test.d.ts `test.describe.configure`): scenarios must not share the
// machine they measure.
test.describe.configure({ mode: "default" });
test.use({ stackOptions: { publisher: false, logLevel: "info" } });

/** Publisher uplink for the streaming-path scenarios (see smoke.spec.ts): 10 MiB/s. */
const UPLINK = 10 * MiB;

test("(a) 1 session × 20 viewers: three 20 MiB snapshots, each within 5 s", async ({ stack }, testInfo) => {
  const metrics = await runFanout(stack, { viewers: 20, snapshotBytes: 20 * MiB, cycles: 3 });
  await record(testInfo, "full-a-fanout", metrics);
});

test("(a) streaming path: three 20 MiB snapshots over a 10 MiB/s uplink, all 20 streamed", async ({
  stack,
}, testInfo) => {
  const metrics = await runFanout(stack, {
    viewers: 20,
    snapshotBytes: 20 * MiB,
    cycles: 3,
    uplinkBytesPerS: UPLINK,
    readersStreamed: true,
  });
  await record(testInfo, "full-a-stream", metrics);
});

test("(b) 10 sessions × 5 viewers: 20 MiB each at once over 10 MiB/s uplinks, then 10 s of updates", async ({
  stack,
}, testInfo) => {
  const metrics = await runMultiSession(stack, {
    sessions: 10,
    viewersPerSession: 5,
    snapshotBytes: 20 * MiB,
    uplinkBytesPerS: UPLINK,
    updates: 100,
    rateHz: 10,
  });
  await record(testInfo, "full-b-sessions", metrics);
});

test.describe("(c) snapshot size limits", () => {
  // The relay's default MAX_TOTAL_SNAPSHOT_BYTES (protocol §3.3; shared LIMITS.MAX_TOTAL_SNAPSHOT_BYTES_DEFAULT),
  // set explicitly: the harness passes the caller's environment through (stack.ts `relayEnv`).
  const budgetBytes = LIMITS.MAX_TOTAL_SNAPSHOT_BYTES_DEFAULT;
  test.use({
    stackOptions: { publisher: false, logLevel: "info", env: { MAX_TOTAL_SNAPSHOT_BYTES: String(budgetBytes) } },
  });

  test("(c) 64 MiB accepted, 64 MiB + 1 B refused, 512 MiB budget full → CAPACITY, RSS bounded", async ({
    stack,
  }, testInfo) => {
    const metrics = await runSnapshotLimits(stack, { budgetBytes });
    await record(testInfo, "full-c-limits", metrics);
  });
});

test("(d) 10 updates/s for 60 s to 20 viewers: p95 latency ≤ 500 ms", async ({ stack }, testInfo) => {
  const metrics = await runUpdateLatency(stack, { viewers: 20, rateHz: 10, durationS: 60 });
  await record(testInfo, "full-d-updates", metrics);
});

test("(e) one slow consumer among 20 through three snapshots: the other 19 unaffected", async ({
  stack,
}, testInfo) => {
  const metrics = await runFanout(stack, {
    viewers: 20,
    snapshotBytes: 20 * MiB,
    cycles: 3,
    slowViewers: 1,
    uplinkBytesPerS: UPLINK,
    readersStreamed: true,
  });
  await record(testInfo, "full-e-slow", metrics);
});
