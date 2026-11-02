// QA-08 load scenarios (a)–(e), shared by `smoke.spec.ts` (CI, scaled) and `full.spec.ts` (local, full sizes).
// Each runner drives one harness stack (the built relay on 127.0.0.1, started without fake-slicer: the publisher
// runs in this process, so sender and receivers share one clock, `performance.now()`), asserts the binding
// criteria of docs/plan/qa.md QA-08 with messages that carry counts and versions only, and returns the metrics
// recorded in tests/load/REPORT.md.
//
// Every client has its own `X-Forwarded-For` address (`nextIp()`; the harness relay runs `TRUST_PROXY=true`), so
// no per-IP limit (§12) is in play. The relay's publisher budget (relay-server/src/ws/budget.ts, SRV-25/SRV-32) is
// kept by construction: chunks are charged to a 161 MiB burst refilled at 32 MiB/s, text frames to a 4 MiB burst
// refilled at 4 MiB/s plus 32 KiB per frame (10 updates/s ≈ 0.3 MiB/s). `assertChunkBurst` refuses a
// configuration that would spend the chunk burst rather than let the relay close the publisher `4006`.

import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { envelope, loadGlb, resolveFixture } from "@slicerremoteview/fake-slicer";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { chunkCountFor, encodeChunkFrame, LIMITS } from "@slicerremoteview/shared";
import type { TestInfo } from "@playwright/test";
import type { Stack } from "../harness/stack.ts";
import { CHUNK_SIZE, closeCodes, LoadPublisher, LoadViewer, MiB, percentile, RssSampler, syntheticGlb } from "./clients.ts";
import type { RssMetrics } from "./clients.ts";

/** How long a viewer may take to hold a snapshot before the run fails (the criterion itself is `maxFanoutMs`). */
const HOLD_WAIT_MS = 60_000;
/** NFR-02: p95 of update latency, publisher send → viewer receive. */
export const MAX_UPDATE_P95_MS = 500;
/** NFR-05: from `scene.snapshot.begin` to the last viewer holding the verified GLB. */
export const MAX_FANOUT_MS = 5_000;

const round = (ms: number): number => Math.round(ms * 10) / 10;

function assertChunkBurst(bytes: number): void {
  // 161 MiB burst (budget.ts `publisherBinary`) minus headroom for the 16 KiB per-chunk cost.
  expect(bytes, "scenario would exceed the relay's publisher chunk burst").toBeLessThanOrEqual(150 * MiB);
}

function relayPid(stack: Stack): number {
  const pid = stack.relay.process.pid;
  if (pid === undefined) throw new Error("relay has no pid");
  return pid;
}

/** `count` viewers of the publisher's session, joined in parallel (each from its own address). */
function joinViewers(stack: Stack, publisher: LoadPublisher, count: number, paused = 0): Promise<LoadViewer[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      LoadViewer.join(stack.wsUrl, stack.baseUrl, publisher.code(), { paused: i < paused }),
    ),
  );
}

export interface CycleMetrics {
  sceneVersion: number;
  fanoutMs: number;
  /** From `scene.snapshot.ack` (§6.4). */
  viewersStreamed: number;
  viewersDeferred: number;
  /** How the measured viewers held it: their stream's `end`, or `ready` + HTTP. */
  viaEnd: number;
  viaReady: number;
  /**
   * For readers whose stream was cut by the relay (soft watermark, §6.4): chunks received before the cut —
   * min / median / max (−1 each when none was cut; a reader deferred at `begin` counts 0).
   */
  cutAfterChunks: [number, number, number];
}

/**
 * One snapshot to `readers`: publish, ack, then every reader holds the GLB with the publisher's SHA-256 (stream or
 * HTTP). Fan-out = last reader's hold time − the time just before `begin` was sent.
 */
async function snapshotCycle(
  publisher: LoadPublisher,
  readers: readonly LoadViewer[],
  glb: LoadedGlb,
  sceneVersion: number,
  uplinkBytesPerS?: number,
): Promise<CycleMetrics> {
  const beganAt = await publisher.sendSnapshot(glb, sceneVersion, uplinkBytesPerS);
  const ack = await publisher.ack(sceneVersion);
  const holds = (v: LoadViewer) => v.held.has(sceneVersion) || v.closeCode !== undefined || v.failures.length > 0;
  await Promise.all(readers.map((v) => v.until(() => holds(v), HOLD_WAIT_MS)));
  expect(readers.flatMap((v) => v.failures), `viewer protocol failures in snapshot ${sceneVersion}`).toEqual([]);
  const missing = readers.filter((v) => !v.held.has(sceneVersion)).length;
  expect(missing, `viewers without snapshot ${sceneVersion}; close codes ${JSON.stringify(closeCodes(readers))}`).toBe(0);
  const wrong = readers.filter((v) => v.held.get(sceneVersion)!.sha256 !== glb.sha256).length;
  expect(wrong, `viewers whose snapshot ${sceneVersion} is not the publisher's GLB`).toBe(0);
  const held = readers.map((v) => v.held.get(sceneVersion)!);
  const cuts = readers
    .filter((v) => v.held.get(sceneVersion)!.via === "ready")
    .map((v) => v.cutAfterChunks.get(sceneVersion) ?? 0)
    .sort((a, b) => a - b);
  return {
    sceneVersion,
    fanoutMs: round(Math.max(...held.map((h) => h.at)) - beganAt),
    viewersStreamed: ack.viewersStreamed as number,
    viewersDeferred: ack.viewersDeferred as number,
    viaEnd: held.filter((h) => h.via === "end").length,
    viaReady: held.filter((h) => h.via === "ready").length,
    cutAfterChunks: cuts.length === 0 ? [-1, -1, -1] : [cuts[0]!, percentile(cuts, 50), cuts.at(-1)!],
  };
}

/** No reader was closed or sent an `error`. */
function expectUnharmed(readers: readonly LoadViewer[], what: string): void {
  const codes = closeCodes(readers);
  expect(codes["open"] ?? 0, `${what}: viewers closed (${JSON.stringify(codes)})`).toBe(readers.length);
  expect(readers.flatMap((v) => v.errorCodes), `${what}: relay errors to viewers`).toEqual([]);
}

export interface FanoutOptions {
  viewers: number;
  snapshotBytes: number;
  cycles: number;
  /** (e): the first `slowViewers` stop reading right after joining (FR-24). */
  slowViewers?: number;
  maxFanoutMs?: number;
  /**
   * Publisher uplink model (`LoadPublisher.sendSnapshot`). Unset: as fast as loopback takes it — every chunk
   * reaches the relay in a burst, which defers every viewer on loopback (REPORT.md). Set: the relay forwards
   * chunks as they arrive, as over a real uplink, and viewers that read are streamed.
   */
  uplinkBytesPerS?: number;
  /**
   * (e) only: also require that the slow viewer was the only one deferred and every reader was streamed (ack
   * `viewersStreamed` = readers, `viewersDeferred` = slow viewers): the slow consumer changed nothing for them.
   */
  readersStreamed?: boolean;
}

export interface SlowViewerMetrics {
  outcome: "deferred" | "closed-slow-consumer";
  /**
   * Per cycle: chunks the slow viewer got before the relay stopped streaming to it (−1: deferred at `begin`;
   * `chunkCount`: not cut in that cycle).
   */
  chunksBeforeDeferral: number[];
  chunkCount: number;
  closeCode: number | null;
  errorCodes: string[];
}

export interface FanoutMetrics {
  viewers: number;
  snapshotMiB: number;
  cycles: CycleMetrics[];
  maxFanoutMs: number;
  rss: RssMetrics;
  closeCodes: Record<string, number>;
  slow?: SlowViewerMetrics;
}

/**
 * (a) and (e): one session, `viewers` viewers, `cycles` synthetic snapshots of `snapshotBytes`. With `slowViewers`,
 * those never read during the cycles; afterwards they read again and must hold the last snapshot via
 * `scene.snapshot.ready` + HTTP (deferred at the 4 MiB soft watermark) or have been closed `SLOW_CONSUMER`/`4010`,
 * while every other viewer was neither closed nor slower than `maxFanoutMs` (§3.3, §6.4, §6.5, FR-24).
 */
export async function runFanout(stack: Stack, options: FanoutOptions): Promise<FanoutMetrics> {
  const { viewers: count, snapshotBytes, cycles } = options;
  const slowCount = options.slowViewers ?? 0;
  const maxFanoutMs = options.maxFanoutMs ?? MAX_FANOUT_MS;
  assertChunkBurst(cycles * snapshotBytes);
  const glbs = Array.from({ length: cycles }, (_, i) => syntheticGlb(snapshotBytes, i + 1)); // before any timing
  const publisher = await LoadPublisher.create(stack.wsUrl);
  const all = await joinViewers(stack, publisher, count, slowCount);
  const slow = all.slice(0, slowCount);
  const readers = all.slice(slowCount);
  const rss = new RssSampler(relayPid(stack));
  await rss.start();
  const results: CycleMetrics[] = [];
  let slowMetrics: SlowViewerMetrics | undefined;
  let codes: Record<string, number> = {};
  let rssMetrics: RssMetrics | undefined;
  try {
    for (let i = 0; i < cycles; i++)
      results.push(await snapshotCycle(publisher, readers, glbs[i]!, i + 1, options.uplinkBytesPerS));
    expectUnharmed(readers, slowCount > 0 ? "the reading viewers" : "fan-out");
    for (const c of results)
      expect(c.fanoutMs, `snapshot ${c.sceneVersion}: fan-out to ${readers.length} viewers (NFR-05)`).toBeLessThanOrEqual(
        maxFanoutMs,
      );
    if (options.readersStreamed)
      for (const c of results) {
        expect(c.viaEnd, `snapshot ${c.sceneVersion}: readers that held it from their own stream`).toBe(readers.length);
        expect(c.viewersStreamed, `snapshot ${c.sceneVersion}: ack viewersStreamed`).toBe(readers.length);
        expect(c.viewersDeferred, `snapshot ${c.sceneVersion}: ack viewersDeferred`).toBe(slowCount);
      }
    if (slowCount > 0) slowMetrics = await recoverSlow(stack, slow, results, snapshotBytes);
    codes = closeCodes(all);
  } finally {
    for (const v of all) v.close();
    publisher.close();
    rssMetrics = await rss.stop();
  }
  return {
    viewers: count,
    snapshotMiB: round(snapshotBytes / MiB),
    cycles: results,
    maxFanoutMs: Math.max(...results.map((c) => c.fanoutMs)),
    rss: rssMetrics,
    closeCodes: codes,
    ...(slowMetrics ? { slow: slowMetrics } : {}),
  };
}

/** (e): the slow viewer reads again; it holds the last version via `ready` + HTTP, or was closed as slow. */
async function recoverSlow(
  stack: Stack,
  slow: readonly LoadViewer[],
  results: readonly CycleMetrics[],
  snapshotBytes: number,
): Promise<SlowViewerMetrics> {
  const last = results.at(-1)!.sceneVersion;
  const viewer = slow[0]!;
  const chunkCount = chunkCountFor(snapshotBytes, CHUNK_SIZE);
  for (const v of slow) v.resume();
  await viewer.until(() => viewer.held.has(last) || viewer.closeCode !== undefined, 30_000);
  expect(viewer.failures, "slow viewer protocol failures").toEqual([]);
  const deferred = viewer.held.get(last)?.via === "ready" && results.some((c) => c.viewersDeferred >= slow.length);
  // A `4010` close frame can be lost when the relay terminates the socket 5 s later (fanout.ts
  // SLOW_CONSUMER_TERMINATE_MS); the relay's own log line then proves the rule that closed it.
  const closedSlow =
    viewer.closeCode === 4010 ||
    viewer.errorCodes.includes("SLOW_CONSUMER") ||
    (viewer.closeCode !== undefined && stack.relay.log().includes('"slow consumer closed"'));
  expect(deferred || closedSlow, "slow viewer was neither deferred (ready + HTTP) nor closed 4010").toBe(true);
  const chunksBeforeDeferral = results.map((c) =>
    viewer.begun.has(c.sceneVersion) ? (viewer.cutAfterChunks.get(c.sceneVersion) ?? chunkCount) : -1,
  );
  if (deferred) {
    // "Deferred at the 4 MiB soft watermark" (QA-08 criterion 3, §3.3, §6.4 a): it had just joined with an empty
    // send buffer, so the first snapshot was streamed to it at `begin`, and the relay stopped forwarding only once
    // its `bufferedAmount` reached 4 MiB — at least 4 MiB of chunks sent to it (the kernel buffers may have taken
    // more) — and before the last chunk. Later cycles may defer it at `begin` (−1): its buffer is still full.
    const first = chunksBeforeDeferral[0]!;
    const softChunks = Math.ceil(LIMITS.SLOW_CONSUMER_SOFT_BYTES / CHUNK_SIZE);
    expect(first, "snapshot 1 was not streamed to the slow viewer at begin").not.toBe(-1);
    expect(first, "slow viewer cut before its send buffer could reach the soft watermark").toBeGreaterThanOrEqual(
      softChunks,
    );
    expect(first, "slow viewer was never cut from the stream of snapshot 1").toBeLessThan(chunkCount);
  }
  return {
    outcome: deferred ? "deferred" : "closed-slow-consumer",
    chunksBeforeDeferral,
    chunkCount,
    closeCode: viewer.closeCode ?? null,
    errorCodes: [...viewer.errorCodes],
  };
}

export interface UpdateMetrics {
  updatesSent: number;
  rateHz: number;
  /** Updates per second actually sent (the schedule kept under load). */
  achievedHz: number;
  samples: number;
  missing: number;
  outOfOrder: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Valid §8.1 changes for node `i mod n`: visibility, colour, opacity and a translation (TRS-decomposable). */
function changesFor(i: number, nodeIds: readonly string[]): Record<string, unknown>[] {
  const x = ((i % 100) - 50) / 1000;
  return [
    {
      nodeId: nodeIds[i % nodeIds.length]!,
      visible: i % 7 !== 0,
      color: [0.9, 0.5, (i % 10) / 10],
      opacity: 0.5 + (i % 6) / 10,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1],
    },
  ];
}

interface UpdateRun {
  latencies: number[];
  sent: number;
  sendSpanMs: number;
  missing: number;
  outOfOrder: number;
}

/**
 * `count` updates at `rateHz` on a fixed schedule (drift-free: update i is due at start + i / rate), versions
 * `fromVersion + 1 …` chained by `baseVersion` (§8.4); then every viewer must have received each one, in order.
 */
async function playUpdates(
  publisher: LoadPublisher,
  viewers: readonly LoadViewer[],
  options: { fromVersion: number; count: number; rateHz: number; nodeIds: readonly string[] },
): Promise<UpdateRun> {
  const { fromVersion, count, rateHz, nodeIds } = options;
  const sentAt = new Map<number, number>();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const wait = start + (i * 1000) / rateHz - performance.now();
    if (wait > 0) await delay(wait);
    const sceneVersion = fromVersion + i + 1;
    sentAt.set(sceneVersion, performance.now());
    publisher.sendUpdate(sceneVersion, sceneVersion - 1, changesFor(i, nodeIds));
  }
  const sendSpanMs = performance.now() - start;
  const last = fromVersion + count;
  const done = (v: LoadViewer) => v.closeCode !== undefined || v.updates.some((u) => u.sceneVersion === last);
  await Promise.all(viewers.map((v) => v.until(() => done(v), 15_000)));
  const latencies: number[] = [];
  let missing = 0;
  let outOfOrder = 0;
  for (const viewer of viewers) {
    const arrivals = viewer.updates.filter((u) => u.sceneVersion > fromVersion && u.sceneVersion <= last);
    missing += count - arrivals.length;
    arrivals.forEach((u, k) => {
      if (u.sceneVersion !== fromVersion + k + 1 || u.baseVersion !== u.sceneVersion - 1) outOfOrder += 1;
      latencies.push(u.at - sentAt.get(u.sceneVersion)!);
    });
  }
  return { latencies, sent: count, sendSpanMs, missing, outOfOrder };
}

function updateMetrics(runs: readonly UpdateRun[], rateHz: number): UpdateMetrics {
  const latencies = runs.flatMap((r) => r.latencies);
  const sent = runs.reduce((sum, r) => sum + r.sent, 0);
  const spanS = Math.max(...runs.map((r) => r.sendSpanMs)) / 1000;
  return {
    updatesSent: sent,
    rateHz,
    // Per session: (count − 1) intervals over the span of one session's sends.
    achievedHz: round(spanS > 0 ? (runs[0]!.sent - 1) / spanS : 0),
    samples: latencies.length,
    missing: runs.reduce((sum, r) => sum + r.missing, 0),
    outOfOrder: runs.reduce((sum, r) => sum + r.outOfOrder, 0),
    p50Ms: round(percentile(latencies, 50)),
    p95Ms: round(percentile(latencies, 95)),
    maxMs: round(Math.max(...latencies)),
  };
}

function expectUpdates(metrics: UpdateMetrics, publishers: readonly LoadPublisher[]): void {
  const refused = publishers.flatMap((p) => p.errors().map((e) => String(e.code)));
  expect(refused, "relay errors to the publisher during updates").toEqual([]);
  expect(metrics.missing, "updates a viewer never received").toBe(0);
  expect(metrics.outOfOrder, "updates received out of order").toBe(0);
  expect(metrics.achievedHz, "update schedule not kept (the load was not applied)").toBeGreaterThanOrEqual(
    0.9 * metrics.rateHz,
  );
  expect(metrics.p95Ms, "p95 update latency, send → receive (NFR-02)").toBeLessThanOrEqual(MAX_UPDATE_P95_MS);
}

export interface UpdateLatencyOptions {
  viewers: number;
  rateHz: number;
  durationS: number;
}

export interface UpdateLatencyMetrics extends UpdateMetrics {
  viewers: number;
  durationS: number;
  rss: RssMetrics;
  closeCodes: Record<string, number>;
}

/**
 * (d): a valid fixture snapshot (`asymmetric-2nodes.glb`, node ids from shared/fixtures/glb/manifest.json via
 * fake-slicer's `loadGlb`), then `rateHz` × `durationS` updates to `viewers` viewers; p95 ≤ 500 ms (NFR-02).
 */
export async function runUpdateLatency(stack: Stack, options: UpdateLatencyOptions): Promise<UpdateLatencyMetrics> {
  const glb = await loadGlb(resolveFixture("asymmetric-2nodes.glb"));
  const publisher = await LoadPublisher.create(stack.wsUrl);
  const viewers = await joinViewers(stack, publisher, options.viewers);
  const rss = new RssSampler(relayPid(stack));
  let metrics: UpdateMetrics;
  let codes: Record<string, number>;
  let rssMetrics: RssMetrics | undefined;
  try {
    await snapshotCycle(publisher, viewers, glb, 1);
    await rss.start();
    const run = await playUpdates(publisher, viewers, {
      fromVersion: 1,
      count: options.rateHz * options.durationS,
      rateHz: options.rateHz,
      nodeIds: glb.nodeIds,
    });
    metrics = updateMetrics([run], options.rateHz);
    codes = closeCodes(viewers);
    expectUnharmed(viewers, "updates");
    expectUpdates(metrics, [publisher]);
  } finally {
    for (const v of viewers) v.close();
    publisher.close();
    rssMetrics = await rss.stop();
  }
  return { ...metrics, viewers: options.viewers, durationS: options.durationS, rss: rssMetrics, closeCodes: codes };
}

export interface MultiSessionOptions {
  sessions: number;
  viewersPerSession: number;
  snapshotBytes: number;
  updates: number;
  rateHz: number;
  maxFanoutMs?: number;
  /** Uplink model of every publisher (see `FanoutOptions.uplinkBytesPerS`). */
  uplinkBytesPerS?: number;
}

export interface MultiSessionMetrics {
  sessions: number;
  viewersPerSession: number;
  snapshotMiB: number;
  fanoutMs: number[];
  maxFanoutMs: number;
  deferred: number;
  updates: UpdateMetrics;
  rss: RssMetrics;
  closeCodes: Record<string, number>;
}

/**
 * (b): `sessions` sessions × `viewersPerSession` viewers on one relay; all sessions publish their own synthetic
 * snapshot at once (each viewer must hold its own session's GLB — no cross-session bytes), then all send updates
 * at `rateHz` at once. No viewer may be closed. Unpaced 20 MiB publishers are not used here: on loopback all 50
 * viewers then sit at the 4 MiB soft watermark together (≈ 200 MiB), above `MAX_TOTAL_BUFFERED_BYTES` (160 MiB),
 * and the relay evicts the largest buffer `4010` as architecture §4 specifies (REPORT.md, 2026-11-02 run).
 */
export async function runMultiSession(stack: Stack, options: MultiSessionOptions): Promise<MultiSessionMetrics> {
  const maxFanoutMs = options.maxFanoutMs ?? MAX_FANOUT_MS;
  assertChunkBurst(options.snapshotBytes);
  const sessions = await Promise.all(
    Array.from({ length: options.sessions }, async () => {
      const publisher = await LoadPublisher.create(stack.wsUrl);
      const viewers = await joinViewers(stack, publisher, options.viewersPerSession);
      return { publisher, viewers, glb: syntheticGlb(options.snapshotBytes, 1) };
    }),
  );
  const everyone = sessions.flatMap((s) => s.viewers);
  const rss = new RssSampler(relayPid(stack));
  await rss.start();
  let cycles: CycleMetrics[];
  let updates: UpdateMetrics;
  let codes: Record<string, number>;
  let rssMetrics: RssMetrics | undefined;
  try {
    cycles = await Promise.all(
      sessions.map((s) => snapshotCycle(s.publisher, s.viewers, s.glb, 1, options.uplinkBytesPerS)),
    );
    const runs = await Promise.all(
      sessions.map((s) =>
        playUpdates(s.publisher, s.viewers, {
          fromVersion: 1,
          count: options.updates,
          rateHz: options.rateHz,
          nodeIds: s.glb.nodeIds,
        }),
      ),
    );
    updates = updateMetrics(runs, options.rateHz);
    codes = closeCodes(everyone);
    expectUnharmed(everyone, "multi-session");
    for (const c of cycles)
      expect(c.fanoutMs, "per-session fan-out with all sessions publishing at once").toBeLessThanOrEqual(maxFanoutMs);
    expectUpdates(
      updates,
      sessions.map((s) => s.publisher),
    );
  } finally {
    for (const v of everyone) v.close();
    for (const s of sessions) s.publisher.close();
    rssMetrics = await rss.stop();
  }
  return {
    sessions: options.sessions,
    viewersPerSession: options.viewersPerSession,
    snapshotMiB: round(options.snapshotBytes / MiB),
    fanoutMs: cycles.map((c) => c.fanoutMs),
    maxFanoutMs: Math.max(...cycles.map((c) => c.fanoutMs)),
    deferred: cycles.reduce((sum, c) => sum + c.viewersDeferred, 0),
    updates,
    rss: rssMetrics,
    closeCodes: codes,
  };
}

export interface LimitsMetrics {
  /** `MAX_TOTAL_SNAPSHOT_BYTES` the relay ran with. */
  budgetMiB: number;
  acceptedBytes: number;
  acceptedFanoutMs: number;
  refusedBytes: number;
  refusedCode: string;
  /** Sessions holding a 64 MiB snapshot when the budget was full. */
  sessionsAtBudget: number;
  capacityCode: string;
  rss: RssMetrics;
  rssLimitMiB: number;
}

/** A `begin` of `byteLength` bytes (§6.2) with a version and id of the caller's; no chunks follow. */
function beginOnly(id: string, sceneVersion: number, byteLength: number, sha256: string): string {
  return envelope("scene.snapshot.begin", id, {
    sceneVersion,
    byteLength,
    sha256,
    chunkCount: chunkCountFor(byteLength, CHUNK_SIZE),
    chunkSize: CHUNK_SIZE,
    format: "glb",
    extensionsUsed: [],
    extensionsRequired: [],
    profile: "mobile",
    nodeCount: 1,
    triangleCount: 0,
  });
}

/**
 * (c): a snapshot of exactly `MAX_SNAPSHOT_BYTES` (64 MiB) is accepted and reaches a viewer; one of 64 MiB + 1 B
 * is refused `PAYLOAD_TOO_LARGE` (`details.maxSnapshotBytes`, no close) and a chunk of that version is ignored
 * (§6.2); further sessions fill `MAX_TOTAL_SNAPSHOT_BYTES` with 64 MiB snapshots and one more is refused
 * `CAPACITY`; the relay's RSS peak stays under the budget + 256 MiB (NFR-06, T2); the first cache is intact.
 */
export async function runSnapshotLimits(stack: Stack, options: { budgetBytes: number }): Promise<LimitsMetrics> {
  const max = LIMITS.MAX_SNAPSHOT_BYTES;
  const { budgetBytes } = options;
  expect(budgetBytes % max, "the budget must be a whole number of 64 MiB snapshots").toBe(0);
  const glb = syntheticGlb(max, 1); // one buffer for every session: the relay copies it into its own
  const rss = new RssSampler(relayPid(stack));
  const first = await LoadPublisher.create(stack.wsUrl);
  const viewer = await LoadViewer.join(stack.wsUrl, stack.baseUrl, first.code());
  const fillers: LoadPublisher[] = [];
  await rss.start();
  let rssMetrics: RssMetrics | undefined;
  let accepted: CycleMetrics;
  let refusedCode: string;
  let capacityCode: string;
  try {
    // Exactly 64 MiB: accepted, verified by a viewer.
    accepted = await snapshotCycle(first, [viewer], glb, 1);

    // 64 MiB + 1 B: refused at `begin`, before any chunk arithmetic (§6.2); its chunks are ignored.
    const id = first.nextId();
    await first.send(beginOnly(id, 2, max + 1, glb.sha256));
    const refusal = await first.client.next((m) => m.type === "error" || m.type === "scene.snapshot.ack", 10_000);
    refusedCode = String(refusal.code);
    expect(refusal.type, "answer to a 64 MiB + 1 B begin").toBe("error");
    expect(refusedCode, "error code for 64 MiB + 1 B").toBe("PAYLOAD_TOO_LARGE");
    expect(refusal.replyTo, "the refusal answers the begin").toBe(id);
    expect(refusal.retryable, "PAYLOAD_TOO_LARGE is not retryable (§9.2)").toBe(false);
    expect((refusal.details as Record<string, unknown> | undefined)?.maxSnapshotBytes).toBe(max);
    await first.send(encodeChunkFrame({ sceneVersion: 2, chunkIndex: 0 }, glb.bytes.subarray(0, CHUNK_SIZE)));
    await delay(1_000);
    expect(first.errors().length, "errors after a chunk of the refused version (ignored, §6.2)").toBe(1);
    expect(first.client.closeInfo?.code, "publisher closed after the refusal").toBeUndefined();
    expect(viewer.begun.has(2), "the refused begin reached a viewer").toBe(false);

    // Fill the global budget (cached + in flight, all sessions), then one more 64 MiB begin → CAPACITY.
    const more = budgetBytes / max - 1;
    for (let i = 0; i < more; i++) fillers.push(await LoadPublisher.create(stack.wsUrl));
    await Promise.all(
      fillers.map(async (p) => {
        await p.sendSnapshot(glb, 1);
        await p.ack(1, 120_000);
      }),
    );
    const extra = await LoadPublisher.create(stack.wsUrl);
    fillers.push(extra);
    const extraId = extra.nextId();
    await extra.send(beginOnly(extraId, 1, max, glb.sha256));
    const full = await extra.client.next((m) => m.type === "error" || m.type === "scene.snapshot.ack", 10_000);
    capacityCode = String(full.code);
    expect(capacityCode, "a 64 MiB begin with the global snapshot budget full").toBe("CAPACITY");
    expect(full.replyTo).toBe(extraId);
    expect(full.retryable, "CAPACITY is retryable (§9.2)").toBe(true);

    // The first session's cache survived all of it.
    const again = await viewer.fetchScene(1);
    expect(again.status, "GET /api/scene/1 after the refusals").toBe(200);
    expect(again.sha256 === glb.sha256 && again.byteLength === max, "cached 64 MiB snapshot intact").toBe(true);
  } finally {
    viewer.close();
    first.close();
    for (const p of fillers) p.close();
    rssMetrics = await rss.stop();
  }
  const rssLimitMiB = (budgetBytes + 256 * MiB) / MiB;
  expect(rssMetrics.peakMiB, "relay RSS peak vs MAX_TOTAL_SNAPSHOT_BYTES + 256 MiB (NFR-06, T2)").toBeLessThan(
    rssLimitMiB,
  );
  return {
    budgetMiB: budgetBytes / MiB,
    acceptedBytes: max,
    acceptedFanoutMs: accepted.fanoutMs,
    refusedBytes: max + 1,
    refusedCode,
    sessionsAtBudget: budgetBytes / max,
    capacityCode,
    rss: rssMetrics,
    rssLimitMiB,
  };
}

/**
 * Attaches a scenario's metrics to the report (`load-metrics-<label>.json`) and prints one summary line. Metrics
 * hold counts, sizes and times only — never a code, a token or scene bytes (NFR-12).
 */
export async function record(testInfo: TestInfo, label: string, metrics: object): Promise<void> {
  const body = JSON.stringify({ label, ...metrics }, null, 2);
  await testInfo.attach(`load-metrics-${label}.json`, { body, contentType: "application/json" });
  console.log(`[QA-08] ${label} ${JSON.stringify(metrics)}`);
}
