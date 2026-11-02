// QA-06: negative tests for payloads and sequences on the WebSocket endpoint. Raw `ws` clients (harness
// `ws-client.ts`) against a local relay: oversized `scene.snapshot.begin`, malformed chunk geometry, oversized
// binary and text frames per role, chunk order and version violations, checksum mismatches, `scene.update`
// version rules, an idle (slowloris-style) upgrade, and a slow consumer that is deferred then closed `4010`.
// After every case another session can still be created and joined (NFR-23), and the relay's RSS after the
// rejection cases stays within 2× of its start (NFR-06: no leak from rejected payloads).
//
// Requirements / threats: NFR-06, NFR-23, FR-24 (slow consumer deferred, others unaffected); architecture §8
// T2 (oversized payloads / memory exhaustion), T3 (resource exhaustion: idle sockets, slow consumers),
// T10 (malformed scene data reaching receivers — here the relay-side framing and checksum checks).
// Protocol §3.1 (handshake timeout `4012`), §3.3 (limits), §6.2–§6.4 (snapshot begin, chunks, end, ready),
// §8.1/§8.4 (update version rules), §9.2 (error codes, strikes), §9.3 (close codes).
// Plan: docs/plan/qa.md QA-06.
//
// Structure: the rejection cases run serially against ONE relay (`describe` in serial mode, Playwright
// "Serial mode", https://playwright.dev/docs/test-parallel#serial-mode), so the final RSS check covers all of
// them. Each case uses fresh sessions from distinct `X-Forwarded-For` addresses (`nextIp()`), and never more
// than two strikes per socket unless the case is about strikes (3 strikes → `4007`, §9.2). The slow consumer
// runs on its own relay: it caches a 32 MiB snapshot, which is legitimate memory, not a leak.
//
// Secrets (NFR-12): session codes and tokens stay inside `created` objects; assertions on errors print only
// error codes and `details`, which the relay keeps free of codes and tokens (§9.2).

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { chunkCountFor, chunkify, encodeChunkFrame, LIMITS } from "@slicerremoteview/shared";
import { expect, test } from "../harness/fixtures.ts";
import { startStack as bootStack } from "../harness/stack.ts";
import type { Stack } from "../harness/stack.ts";
import { Client, createSession, joinViewer, nextIp } from "../harness/ws-client.ts";
import type { Message } from "../harness/ws-client.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
/** Waits for relay replies: generous, the machine is shared by many concurrent suites. */
const REPLY_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Sends a binary frame and resolves once `ws` handed it to the socket (`WebSocket.send(data, options, cb)`,
 *  tests/node_modules/@types/ws/index.d.ts). */
function sendBinary(client: Client, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    client.socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve())),
  );
}

/** A `ping` and its `pong`: proves the socket is open and every earlier frame was processed (in order). */
async function roundTrip(client: Client, id: string): Promise<void> {
  client.send({ type: "ping", id });
  await client.next((m) => m.type === "pong" && m.replyTo === id, REPLY_MS);
}

const errorsOf = (client: Client): Message[] => client.messages.filter((m) => m.type === "error");

/** The next `error` (after the previous `next` result). */
const nextError = (client: Client): Promise<Message> => client.next("error", REPLY_MS);

interface BeginFields {
  sceneVersion: number;
  byteLength: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
}

/** `scene.snapshot.begin` (§6.2) with any field overridden. */
function begin(id: string, fields: BeginFields): Record<string, unknown> {
  return {
    type: "scene.snapshot.begin",
    id,
    ...fields,
    format: "glb",
    extensionsUsed: [],
    extensionsRequired: [],
    profile: "mobile",
    nodeCount: 0,
    triangleCount: 0,
  };
}

/** Begin fields for real bytes (the relay never parses the GLB, so random bytes with their hash are valid). */
function beginFor(sceneVersion: number, bytes: Uint8Array, chunkSize: number): BeginFields {
  return {
    sceneVersion,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    chunkSize,
    chunkCount: chunkCountFor(bytes.byteLength, chunkSize),
  };
}

/** The SRVC chunk frames of `bytes` (§6.3). */
function chunkFrames(sceneVersion: number, bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  return [...chunkify(bytes, chunkSize)].map(({ chunkIndex, payload }) =>
    encodeChunkFrame({ sceneVersion, chunkIndex }, payload),
  );
}

/** A complete valid snapshot; resolves with its `scene.snapshot.ack`. */
async function publishSnapshot(
  publisher: Client,
  sceneVersion: number,
  bytes: Uint8Array,
  chunkSize = 64 * KIB,
): Promise<Message> {
  const fields = beginFor(sceneVersion, bytes, chunkSize);
  publisher.send(begin(`b-${sceneVersion}`, fields));
  for (const frame of chunkFrames(sceneVersion, bytes, chunkSize)) await sendBinary(publisher, frame);
  publisher.send({ type: "scene.snapshot.end", id: `e-${sceneVersion}`, sceneVersion, sha256: fields.sha256 });
  return publisher.next((m) => m.type === "scene.snapshot.ack" || m.type === "error", REPLY_MS);
}

/** `session.close` (§4.5) and the relay's `1000`; a no-op for a socket that is already closed. */
async function closeSession(publisher: Client): Promise<void> {
  if (publisher.closeInfo) return;
  publisher.send({ type: "session.close", reason: "USER_STOPPED" });
  await publisher.closedWithin(REPLY_MS).catch(() => publisher.terminate());
}

/**
 * NFR-23: the relay still serves another session — a new publisher creates one, a new viewer joins it, and the
 * session ends cleanly (viewer closed `4001`).
 */
async function assertServing(wsUrl: string): Promise<void> {
  const { client: publisher, created } = await createSession(wsUrl, { ip: nextIp() });
  expect(created.type).toBe("session.created");
  const { client: viewer, joined } = await joinViewer(wsUrl, String(created.code), { ip: nextIp() });
  expect(joined.type).toBe("viewer.joined");
  await closeSession(publisher);
  expect((await viewer.closedWithin(REPLY_MS)).code).toBe(4001);
}

/** A publisher with a fresh session; `viewers` viewers joined (the code never leaves this function). */
async function sessionWithViewers(
  wsUrl: string,
  viewers = 0,
): Promise<{ publisher: Client; viewers: Client[] }> {
  const { client: publisher, created } = await createSession(wsUrl, { ip: nextIp() });
  const joined: Client[] = [];
  for (let i = 0; i < viewers; i++)
    joined.push((await joinViewer(wsUrl, String(created.code), { ip: nextIp() })).client);
  return { publisher, viewers: joined };
}

/** A JSON `ping` envelope padded to exactly `bytes` UTF-8 bytes (unknown fields are accepted, §14). */
function paddedPing(id: string, bytes: number): string {
  const base = JSON.stringify({ protocolVersion: "1.0", type: "ping", id, pad: "" });
  const text = JSON.stringify({ protocolVersion: "1.0", type: "ping", id, pad: "x".repeat(bytes - base.length) });
  if (Buffer.byteLength(text) !== bytes) throw new Error(`padded ping is ${Buffer.byteLength(text)} bytes`);
  return text;
}

/** Relay RSS in KiB (`ps -o rss=` works on macOS and Linux). */
function rssKiB(pid: number): number {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

/**
 * A `scene.update` (§8.1) of `count` matrix changes on stable node ids (the merged state stays at `count` ids,
 * below the 1,000 of §8.3), close to — never above — the 256 KiB publisher text limit for `count` ≈ 780
 * (≈ 251 KB).
 */
function bigUpdate(baseVersion: number, count: number): string {
  const changes = Array.from({ length: count }, (_, i) => ({
    nodeId: `qa06/node-${String(i).padStart(4, "0")}`,
    matrix: Array.from({ length: 16 }, (_, k) => 0.1234567890123 + i * 1e-9 + k * 1e-11),
  }));
  return JSON.stringify({
    protocolVersion: "1.0",
    type: "scene.update",
    id: `u-${baseVersion}`,
    sceneVersion: baseVersion + 1,
    baseVersion,
    changes,
  });
}

/** A `scene.update` with one small change. */
function smallUpdate(id: string, baseVersion: number, sceneVersion: number): Record<string, unknown> {
  return { type: "scene.update", id, baseVersion, sceneVersion, changes: [{ nodeId: "qa06/node-a", visible: false }] };
}

// ---------------------------------------------------------------------------------------------------------------
// Rejection cases against one relay, then its RSS
// ---------------------------------------------------------------------------------------------------------------

test.describe("payload and sequence rejections (one relay)", () => {
  test.describe.configure({ mode: "serial" });

  let stack: Stack;
  let baselineRssKiB = 0;

  test.beforeAll(async ({}, testInfo) => {
    stack = await bootStack({ publisher: false, dir: testInfo.outputPath("stack") });
    // Warm-up before the baseline: one session, a viewer and a small snapshot, so JIT and heap growth from the
    // first use of each code path are not counted as a leak.
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    expect((await publishSnapshot(publisher, 1, randomBytes(256 * KIB))).type).toBe("scene.snapshot.ack");
    await closeSession(publisher);
    await viewers[0]!.closedWithin(REPLY_MS);
    baselineRssKiB = rssKiB(stack.relay.process.pid!);
  });

  test.afterAll(async () => {
    await stack?.stop();
  });

  test.afterEach(async () => {
    await assertServing(stack.wsUrl);
  });

  test("begin with byteLength above 64 MiB → PAYLOAD_TOO_LARGE, no close, no strike (§6.2)", async () => {
    const { publisher } = await sessionWithViewers(stack.wsUrl);
    const oversized = [LIMITS.MAX_SNAPSHOT_BYTES + 1, LIMITS.MAX_SNAPSHOT_BYTES * 4, Number.MAX_SAFE_INTEGER];
    // Three refusals on one socket: PAYLOAD_TOO_LARGE is no strike, so no `4007` (§9.2).
    for (const [i, byteLength] of oversized.entries()) {
      const sceneVersion = i + 1;
      publisher.send(
        begin(`big-${i}`, { sceneVersion, byteLength, sha256: "0".repeat(64), chunkSize: MIB, chunkCount: 1024 }),
      );
      const error = await nextError(publisher);
      expect(error.code).toBe("PAYLOAD_TOO_LARGE");
      expect(error.replyTo).toBe(`big-${i}`);
      expect(error.retryable).toBe(false);
      expect(error.details).toEqual({ maxSnapshotBytes: LIMITS.MAX_SNAPSHOT_BYTES });
    }
    // The chunks of a refused version are ignored (§6.2): no error for this one.
    await sendBinary(publisher, encodeChunkFrame({ sceneVersion: 3, chunkIndex: 0 }, new Uint8Array(64 * KIB)));
    await roundTrip(publisher, "big-rt");
    expect(errorsOf(publisher)).toHaveLength(3);
    expect(publisher.closeInfo).toBeUndefined();
    // The session still takes a valid snapshot with a higher version.
    expect((await publishSnapshot(publisher, 4, randomBytes(128 * KIB))).type).toBe("scene.snapshot.ack");
    await closeSession(publisher);
  });

  test("begin with chunkCount 1025 or chunkSize 32 KiB → INVALID_MESSAGE (§3.3, §6.2)", async () => {
    // chunkCount above 1,024 (byteLength 64 MiB in 64 KiB chunks needs exactly 1,024).
    const a = await sessionWithViewers(stack.wsUrl);
    a.publisher.send(
      begin("cc", {
        sceneVersion: 1,
        byteLength: LIMITS.MAX_SNAPSHOT_BYTES,
        sha256: "0".repeat(64),
        chunkSize: 64 * KIB,
        chunkCount: 1025,
      }),
    );
    let error = await nextError(a.publisher);
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(error.replyTo).toBe("cc");
    expect((error.details as { instancePath?: string } | undefined)?.instancePath).toBe("/chunkCount");
    // chunkCount ≠ ceil(byteLength / chunkSize) is the relay's own check (second strike on this socket).
    a.publisher.send(
      begin("cc2", {
        sceneVersion: 2,
        byteLength: 3 * 64 * KIB,
        sha256: "0".repeat(64),
        chunkSize: 64 * KIB,
        chunkCount: 2,
      }),
    );
    error = await nextError(a.publisher);
    expect(error.code).toBe("INVALID_MESSAGE");
    expect((error.details as { instancePath?: string } | undefined)?.instancePath).toBe("/chunkCount");
    await roundTrip(a.publisher, "cc-rt");
    expect(a.publisher.closeInfo).toBeUndefined();
    await closeSession(a.publisher);

    // chunkSize below 64 KiB.
    const b = await sessionWithViewers(stack.wsUrl);
    b.publisher.send(
      begin("cs", {
        sceneVersion: 1,
        byteLength: 128 * KIB,
        sha256: "0".repeat(64),
        chunkSize: 32 * KIB,
        chunkCount: 4,
      }),
    );
    error = await nextError(b.publisher);
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(error.replyTo).toBe("cs");
    expect((error.details as { instancePath?: string } | undefined)?.instancePath).toBe("/chunkSize");
    // chunkSize above 1 MiB (§6.2: "between 64 KiB and 1 MiB"; second strike on this socket).
    b.publisher.send(
      begin("cs2", {
        sceneVersion: 2,
        byteLength: 4 * MIB,
        sha256: "0".repeat(64),
        chunkSize: 2 * MIB,
        chunkCount: 2,
      }),
    );
    error = await nextError(b.publisher);
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(error.replyTo).toBe("cs2");
    expect((error.details as { instancePath?: string } | undefined)?.instancePath).toBe("/chunkSize");
    await roundTrip(b.publisher, "cs-rt");
    expect(b.publisher.closeInfo).toBeUndefined();
    await closeSession(b.publisher);
  });

  test("binary frame above 1 MiB + 64 KiB → 1009; above 1 MiB + 12 B → PAYLOAD_TOO_LARGE + 1009", async () => {
    // Above `ws` maxPayload (1,114,112 B): `ws` itself closes 1009 before reading the payload.
    const a = await sessionWithViewers(stack.wsUrl);
    a.publisher.sendRaw(Buffer.alloc(LIMITS.WS_MAX_PAYLOAD_BYTES + 1), true);
    expect((await a.publisher.closedWithin(REPLY_MS)).code).toBe(1009);

    // Within maxPayload but above the chunk limit: the relay's own check, with an error first.
    const b = await sessionWithViewers(stack.wsUrl);
    const frame = encodeChunkFrame({ sceneVersion: 1, chunkIndex: 0 }, new Uint8Array(LIMITS.MAX_CHUNK_BYTES + 1));
    b.publisher.sendRaw(Buffer.from(frame), true);
    const error = await nextError(b.publisher);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.retryable).toBe(false);
    expect((await b.publisher.closedWithin(REPLY_MS)).code).toBe(1009);
  });

  test("viewer text above 16 KiB → PAYLOAD_TOO_LARGE + 1009; exactly 16 KiB is accepted (§3.3)", async () => {
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    const viewer = viewers[0]!;
    viewer.sendRaw(paddedPing("v-max", LIMITS.MAX_TEXT_BYTES_VIEWER));
    await viewer.next((m) => m.type === "pong" && m.replyTo === "v-max", REPLY_MS);
    viewer.sendRaw(paddedPing("v-over", LIMITS.MAX_TEXT_BYTES_VIEWER + 1));
    const error = await nextError(viewer);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.details).toEqual({ maxTextBytes: LIMITS.MAX_TEXT_BYTES_VIEWER });
    expect((await viewer.closedWithin(REPLY_MS)).code).toBe(1009);
    // The publisher is unaffected.
    await roundTrip(publisher, "p-rt");
    await closeSession(publisher);
  });

  test("publisher text above 256 KiB → PAYLOAD_TOO_LARGE + 1009; exactly 256 KiB is accepted (§3.3)", async () => {
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    publisher.sendRaw(paddedPing("p-max", LIMITS.MAX_TEXT_BYTES_PUBLISHER));
    await publisher.next((m) => m.type === "pong" && m.replyTo === "p-max", REPLY_MS);
    publisher.sendRaw(paddedPing("p-over", LIMITS.MAX_TEXT_BYTES_PUBLISHER + 1));
    const error = await nextError(publisher);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.details).toEqual({ maxTextBytes: LIMITS.MAX_TEXT_BYTES_PUBLISHER });
    expect((await publisher.closedWithin(REPLY_MS)).code).toBe(1009);
    // The viewer stays connected: its session is in publisher grace, not closed.
    await viewer0Online(viewers[0]!);
  });

  test("duplicate and skipped chunkIndex → BAD_SEQUENCE{chunkIndex}, snapshot discarded (§6.3)", async () => {
    const bytes = randomBytes(3 * 64 * KIB);
    for (const [label, order] of [
      ["duplicate", [0, 0]],
      ["skipped", [0, 2]],
    ] as const) {
      const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
      const viewer = viewers[0]!;
      const fields = beginFor(1, bytes, 64 * KIB);
      const frames = chunkFrames(1, bytes, 64 * KIB);
      publisher.send(begin(`${label}-b`, fields));
      for (const index of order) await sendBinary(publisher, frames[index]!);
      const error = await nextError(publisher);
      expect(error.code, label).toBe("BAD_SEQUENCE");
      expect(error.retryable, label).toBe(true);
      expect(error.details, label).toEqual({ field: "chunkIndex" });
      // Viewers that got the begin are told the snapshot is gone (§6.4).
      const abort = await viewer.next("scene.snapshot.abort", REPLY_MS);
      expect(abort).toMatchObject({ sceneVersion: 1, reason: "BAD_SEQUENCE" });
      // Later chunks and the end of the discarded version are ignored, not more strikes.
      await sendBinary(publisher, frames[1]!);
      publisher.send({ type: "scene.snapshot.end", id: `${label}-e`, sceneVersion: 1, sha256: fields.sha256 });
      await roundTrip(publisher, `${label}-rt`);
      expect(errorsOf(publisher), label).toHaveLength(1);
      // The publisher starts again with a new version (§6.3).
      expect((await publishSnapshot(publisher, 2, bytes)).type, label).toBe("scene.snapshot.ack");
      await closeSession(publisher);
    }
  });

  test("stale sceneVersion on begin or chunk → BAD_SEQUENCE{sceneVersion} (§6.3, §8.4)", async () => {
    const { publisher } = await sessionWithViewers(stack.wsUrl);
    const bytes = randomBytes(64 * KIB);
    expect((await publishSnapshot(publisher, 5, bytes)).type).toBe("scene.snapshot.ack");
    // A begin with a version already used (equal, then lower).
    for (const sceneVersion of [5, 3]) {
      publisher.send(begin(`stale-${sceneVersion}`, beginFor(sceneVersion, bytes, 64 * KIB)));
      const error = await nextError(publisher);
      expect(error.code).toBe("BAD_SEQUENCE");
      expect(error.replyTo).toBe(`stale-${sceneVersion}`);
      expect(error.details).toEqual({ field: "sceneVersion" });
    }
    await roundTrip(publisher, "stale-rt");
    expect(publisher.closeInfo).toBeUndefined();
    await closeSession(publisher);

    // A chunk for a version that has no snapshot in flight.
    const other = await sessionWithViewers(stack.wsUrl);
    await sendBinary(other.publisher, encodeChunkFrame({ sceneVersion: 9, chunkIndex: 0 }, bytes));
    const error = await nextError(other.publisher);
    expect(error.code).toBe("BAD_SEQUENCE");
    expect(error.details).toEqual({ field: "sceneVersion" });
    await closeSession(other.publisher);
  });

  test("wrong sha256 or missing chunk at end → CHECKSUM_MISMATCH, no close (§6.4)", async () => {
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    const viewer = viewers[0]!;
    const bytes = randomBytes(4 * MIB);
    const wrong = sha256(new Uint8Array(16));
    const cases: { label: string; beginSha: string; endSha: string; drop: boolean }[] = [
      { label: "begin+end hash wrong", beginSha: wrong, endSha: wrong, drop: false },
      { label: "end hash differs", beginSha: sha256(bytes), endSha: wrong, drop: false },
      { label: "last chunk missing", beginSha: sha256(bytes), endSha: sha256(bytes), drop: true },
    ];
    for (const [i, c] of cases.entries()) {
      const sceneVersion = i + 1;
      const frames = chunkFrames(sceneVersion, bytes, MIB);
      publisher.send(begin(`cm-b${i}`, { ...beginFor(sceneVersion, bytes, MIB), sha256: c.beginSha }));
      for (const frame of c.drop ? frames.slice(0, -1) : frames) await sendBinary(publisher, frame);
      publisher.send({ type: "scene.snapshot.end", id: `cm-e${i}`, sceneVersion, sha256: c.endSha });
      const error = await nextError(publisher);
      expect(error.code, c.label).toBe("CHECKSUM_MISMATCH");
      expect(error.replyTo, c.label).toBe(`cm-e${i}`);
      expect(error.retryable, c.label).toBe(true);
      const abort = await viewer.next("scene.snapshot.abort", REPLY_MS);
      expect(abort, c.label).toMatchObject({ sceneVersion, reason: "CHECKSUM_MISMATCH" });
    }
    expect(publisher.closeInfo).toBeUndefined();
    expect(publisher.messages.some((m) => m.type === "scene.snapshot.ack")).toBe(false);
    // A correct snapshot is accepted afterwards and streamed to the viewer.
    const ack = await publishSnapshot(publisher, 4, bytes, MIB);
    expect(ack).toMatchObject({ type: "scene.snapshot.ack", sceneVersion: 4, viewersStreamed: 1, viewersDeferred: 0 });
    await closeSession(publisher);
  });

  test("scene.update with a wrong baseVersion or stale sceneVersion → BAD_SEQUENCE, no close (§8.1)", async () => {
    // §8.1 exempts only `noSnapshot` (and `nodeState`) from strikes explicitly; §9.3 lets repeated
    // `BAD_SEQUENCE` close `4007`. So each socket gets at most two of the other refusals: the test then holds
    // whether or not the relay counts them (today it does not, relay-server/src/ws/state.ts).
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    const viewer = viewers[0]!;
    // Before the first snapshot (no strike by contract).
    publisher.send(smallUpdate("u-none", 0, 1));
    let error = await nextError(publisher);
    expect(error.code).toBe("BAD_SEQUENCE");
    expect(error.replyTo).toBe("u-none");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ field: "noSnapshot" });
    expect((await publishSnapshot(publisher, 1, randomBytes(64 * KIB))).type).toBe("scene.snapshot.ack");
    // baseVersion ≠ the session's sceneVersion (1): below, then above it.
    for (const [i, baseVersion] of [0, 7].entries()) {
      publisher.send(smallUpdate(`u-base${i}`, baseVersion, baseVersion + 1));
      error = await nextError(publisher);
      expect(error.code).toBe("BAD_SEQUENCE");
      expect(error.replyTo).toBe(`u-base${i}`);
      expect(error.retryable).toBe(true);
      expect(error.details).toEqual({ field: "baseVersion" });
    }
    // None of them reached the viewer; a correct one does.
    publisher.send(smallUpdate("u-ok", 1, 2));
    const update = await viewer.next("scene.update", REPLY_MS);
    expect(update).toMatchObject({ baseVersion: 1, sceneVersion: 2 });
    await roundTrip(publisher, "u-rt");
    expect(viewer.messages.filter((m) => m.type === "scene.update")).toHaveLength(1);
    expect(publisher.closeInfo).toBeUndefined();
    await closeSession(publisher);

    // sceneVersion not above baseVersion, on a second session (one strike-capable refusal).
    const other = await sessionWithViewers(stack.wsUrl, 1);
    expect((await publishSnapshot(other.publisher, 1, randomBytes(64 * KIB))).type).toBe("scene.snapshot.ack");
    other.publisher.send(smallUpdate("u-stale", 1, 1));
    error = await nextError(other.publisher);
    expect(error.code).toBe("BAD_SEQUENCE");
    expect(error.replyTo).toBe("u-stale");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ field: "sceneVersion" });
    await roundTrip(other.publisher, "u-rt2");
    expect(other.viewers[0]!.messages.some((m) => m.type === "scene.update")).toBe(false);
    expect(other.publisher.closeInfo).toBeUndefined();
    await closeSession(other.publisher);
  });

  test("scene.update or nodeRemoved between begin and end → BAD_SEQUENCE{snapshotInFlight} (§6.2)", async () => {
    const { publisher, viewers } = await sessionWithViewers(stack.wsUrl, 1);
    const viewer = viewers[0]!;
    expect((await publishSnapshot(publisher, 1, randomBytes(64 * KIB))).type).toBe("scene.snapshot.ack");
    const bytes = randomBytes(2 * 64 * KIB);
    const fields = beginFor(2, bytes, 64 * KIB);
    const frames = chunkFrames(2, bytes, 64 * KIB);
    publisher.send(begin("f-b", fields));
    await sendBinary(publisher, frames[0]!);
    publisher.send(smallUpdate("f-u", 1, 3));
    publisher.send({ type: "scene.nodeRemoved", id: "f-r", baseVersion: 1, sceneVersion: 3, nodeIds: ["qa06/node-a"] });
    for (const id of ["f-u", "f-r"]) {
      const error = await nextError(publisher);
      expect(error.code, id).toBe("BAD_SEQUENCE");
      expect(error.replyTo, id).toBe(id);
      expect(error.retryable, id).toBe(true);
      expect(error.details, id).toEqual({ field: "snapshotInFlight" });
    }
    // The snapshot in flight is unaffected and completes.
    await sendBinary(publisher, frames[1]!);
    publisher.send({ type: "scene.snapshot.end", id: "f-e", sceneVersion: 2, sha256: fields.sha256 });
    expect(await publisher.next("scene.snapshot.ack", REPLY_MS)).toMatchObject({ sceneVersion: 2 });
    // Resent after end with baseVersion = the snapshot version, it is accepted (§6.2).
    publisher.send(smallUpdate("f-u2", 2, 3));
    expect(await viewer.next("scene.update", REPLY_MS)).toMatchObject({ baseVersion: 2, sceneVersion: 3 });
    expect(viewer.messages.some((m) => m.type === "scene.nodeRemoved")).toBe(false);
    await closeSession(publisher);
  });

  test("volume: 4 refused and 4 superseded 8 MiB snapshots, the input of the RSS check (T2)", async () => {
    // ≈ 32 MiB of refused snapshot bytes fully written into relay buffers, and 4 more 8 MiB buffers allocated
    // (2 MiB of each written), so the RSS check covers real rejected volume. V8 frees dropped `Buffer`s only at
    // its next collection: on macOS 8 + 8 rounds left RSS at ≈ 1.9× of the baseline for 10–25 s (no leak: it
    // fell afterwards), too close to the 2× bound, hence 4 + 4. Neither refusal is a strike.
    const { publisher } = await sessionWithViewers(stack.wsUrl);
    const bytes = randomBytes(8 * MIB);
    const frames = (sceneVersion: number) => chunkFrames(sceneVersion, bytes, MIB);
    let sceneVersion = 0;
    for (let round = 0; round < 4; round++) {
      // Fully sent, wrong hash at end → CHECKSUM_MISMATCH, buffer freed (§6.4).
      sceneVersion++;
      publisher.send(begin(`v-b${sceneVersion}`, beginFor(sceneVersion, bytes, MIB)));
      for (const frame of frames(sceneVersion)) await sendBinary(publisher, frame);
      publisher.send({ type: "scene.snapshot.end", id: `v-e${sceneVersion}`, sceneVersion, sha256: "0".repeat(64) });
      expect((await nextError(publisher)).code).toBe("CHECKSUM_MISMATCH");
      // Two chunks in, then superseded by the next begin (§6.2): its buffer is dropped too.
      sceneVersion++;
      publisher.send(begin(`v-b${sceneVersion}`, beginFor(sceneVersion, bytes, MIB)));
      for (const frame of frames(sceneVersion).slice(0, 2)) await sendBinary(publisher, frame);
      // Pace the binary budget (32 MiB/s refill, budget.ts) a little: ≈ 10 MiB per round.
      await new Promise((r) => setTimeout(r, 100));
    }
    await roundTrip(publisher, "v-rt");
    expect(errorsOf(publisher)).toHaveLength(4);
    expect(publisher.closeInfo).toBeUndefined();
    await closeSession(publisher);
  });

  test("idle or trickling upgraded sockets that never bind → 4012 after 10 s (§3.1, slowloris)", async () => {
    test.setTimeout(60_000);
    const port = new URL(stack.wsUrl).port;
    /** Milliseconds from `since` until `closed` settles. */
    const after = async <T>(since: number, closed: Promise<T>): Promise<[T, number]> => {
      const value = await closed;
      return [value, Date.now() - since];
    };
    // (a) upgraded, then silent.
    const idle = new Client(stack.wsUrl, { ip: nextIp() });
    await idle.opened;
    const idleClosed = after(Date.now(), idle.closedWithin(25_000));
    // (b) a `session.resume` for no live session → SESSION_NOT_FOUND, which keeps the socket open for 10 s for a
    //     fallback `session.create` (§4.3); it only pings (allowed then, §3.1) and never binds.
    const pinger = new Client(stack.wsUrl, { ip: nextIp() });
    await pinger.opened;
    pinger.send({
      type: "session.resume",
      id: "sl-r",
      sessionId: "qa06-no-such-session",
      publisherToken: "A".repeat(43),
      clientInfo: { app: "SlicerRemoteView", version: "0.0.0-qa", platform: "qa-harness" },
      lastSceneVersion: 0,
    });
    const notFound = await pinger.next("error", REPLY_MS);
    expect(notFound.code).toBe("SESSION_NOT_FOUND");
    const pingerClosed = after(Date.now(), pinger.closedWithin(25_000));
    const timer = setInterval(() => {
      if (!pinger.closeInfo) pinger.send({ type: "ping", id: `sl-${Date.now() % 100_000}` });
    }, 2_000);
    // (c) a raw socket that upgrades, then trickles the first bytes of a frame header and never finishes it.
    const rawStarted = Date.now();
    const raw = await rawTrickle(Number(port), nextIp());
    const rawClosed = after(rawStarted, raw.closeCode(25_000));
    try {
      const [[a, aMs], [b, bMs], [c, cMs]] = await Promise.all([idleClosed, pingerClosed, rawClosed]);
      expect(a.code).toBe(4012);
      expect(b.code).toBe(4012);
      expect(c).toBe(4012);
      expect(pinger.messages.some((m) => m.type === "pong")).toBe(true);
      // The relay's timer is 10 s from the upgrade (or from the SESSION_NOT_FOUND reply); the lower bound allows
      // for our clock starting after the relay's, the upper bound for a loaded machine.
      for (const ms of [aMs, bMs, cMs]) {
        expect(ms).toBeGreaterThanOrEqual(9_000);
        expect(ms).toBeLessThan(20_000);
      }
    } finally {
      clearInterval(timer);
      raw.socket.destroy();
    }
  });

  test("relay RSS after the rejection cases is within 2× of the start (NFR-06)", async () => {
    test.setTimeout(90_000);
    expect(baselineRssKiB).toBeGreaterThan(0);
    // RSS lags freed buffers until V8 collects the `Buffer`s that held them (no `--expose-gc` in the relay; on
    // macOS a collection came 10–25 s after the volume case): poll rather than sampling once.
    const firstKiB = rssKiB(stack.relay.process.pid!);
    await expect
      .poll(() => rssKiB(stack.relay.process.pid!), { timeout: 60_000, intervals: [1_000, 2_000, 5_000] })
      .toBeLessThanOrEqual(2 * baselineRssKiB);
    // Numbers only (no secrets): the plan row quotes them.
    test.info().annotations.push({
      type: "rss",
      description:
        `relay RSS baseline ${baselineRssKiB} KiB, right after the cases ${firstKiB} KiB, ` +
        `passed at ${rssKiB(stack.relay.process.pid!)} KiB`,
    });
    // The relay is still the same process and healthy.
    expect(stack.relay.process.exitCode).toBeNull();
    expect((await fetch(`${stack.baseUrl}/healthz`)).status).toBe(200);
  });
});

/** A viewer whose session's publisher dropped still answers pings (its session is in grace, §9.1). */
async function viewer0Online(viewer: Client): Promise<void> {
  await viewer.next("session.publisherState", REPLY_MS);
  await roundTrip(viewer, "v-rt");
  expect(viewer.closeInfo).toBeUndefined();
  viewer.close();
}

/**
 * Raw TCP client: completes a WebSocket upgrade (RFC 6455 §4.1), then sends the first two bytes of a masked text
 * frame header (FIN+text, MASK + 16-bit length marker) one second apart and never the rest. `closeCode` resolves
 * with the status code of the relay's close frame (opcode 0x8, unmasked from a server, RFC 6455 §5.5.1).
 */
async function rawTrickle(
  port: number,
  ip: string,
): Promise<{ socket: Socket; closeCode(ms: number): Promise<number> }> {
  const socket = netConnect({ host: "127.0.0.1", port });
  let received = Buffer.alloc(0);
  const listeners = new Set<() => void>();
  socket.on("data", (data: Buffer) => {
    received = Buffer.concat([received, data]);
    listeners.forEach((l) => l());
  });
  socket.on("close", () => listeners.forEach((l) => l()));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    "GET /ws HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
      "Sec-WebSocket-Version: 13\r\n" +
      `X-Forwarded-For: ${ip}\r\n\r\n`,
  );
  const headerEnd = (): number => received.indexOf("\r\n\r\n");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("raw upgrade got no response")), REPLY_MS);
    const check = () => {
      if (headerEnd() < 0) return;
      clearTimeout(timer);
      listeners.delete(check);
      if (!received.subarray(0, 12).toString().startsWith("HTTP/1.1 101")) reject(new Error("raw upgrade refused"));
      else resolve();
    };
    listeners.add(check);
    check();
  });
  socket.write(Buffer.from([0x81]));
  setTimeout(() => socket.writable && socket.write(Buffer.from([0x80 | 126])), 1_000).unref();

  const parseClose = (): number | undefined => {
    let offset = headerEnd() + 4;
    while (offset + 2 <= received.length) {
      const opcode = received[offset]! & 0x0f;
      let length = received[offset + 1]! & 0x7f;
      let start = offset + 2;
      if (length === 126) {
        if (start + 2 > received.length) return undefined;
        length = received.readUInt16BE(start);
        start += 2;
      } else if (length === 127) {
        if (start + 8 > received.length) return undefined;
        length = Number(received.readBigUInt64BE(start));
        start += 8;
      }
      if (start + length > received.length) return undefined;
      if (opcode === 0x8 && length >= 2) return received.readUInt16BE(start);
      offset = start + length;
    }
    return undefined;
  };
  return {
    socket,
    closeCode: (ms) =>
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`raw socket got no close frame within ${ms} ms`)), ms);
        const check = () => {
          const code = parseClose();
          if (code !== undefined || socket.destroyed) {
            clearTimeout(timer);
            listeners.delete(check);
            if (code === undefined) reject(new Error("raw socket closed without a close frame"));
            else resolve(code);
          }
        };
        listeners.add(check);
        check();
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Slow consumer (own relay)
// ---------------------------------------------------------------------------------------------------------------

test.describe("slow consumer", () => {
  test.use({ stackOptions: { publisher: false } });

  test("a paused viewer is deferred, then closed 4010 above 8 MiB; others unaffected (§3.3)", async ({ stack }) => {
    test.setTimeout(120_000);
    const { client: publisher, created } = await createSession(stack.wsUrl, { ip: nextIp() });
    const slow = (await joinViewer(stack.wsUrl, String(created.code), { ip: nextIp() })).client;
    // Stop reading: the kernel buffers on loopback fill (a few MiB), then the relay's `bufferedAmount` grows.
    slow.socket.pause();
    const fast = (await joinViewer(stack.wsUrl, String(created.code), { ip: nextIp() })).client;

    // 1. A 32 MiB snapshot (random bytes: the relay never parses the GLB), paced on the reading viewer like the
    //    relay's load smoke (`sendPaced`, relay-server/README.md): chunk i goes out once `fast` holds 0 … i−2,
    //    so `fast` never nears the 4 MiB soft watermark, while `slow` crosses it and is deferred.
    const bytes = randomBytes(32 * MIB);
    const fields = beginFor(1, bytes, MIB);
    publisher.send(begin("sc-b", fields));
    const frames = chunkFrames(1, bytes, MIB);
    for (const [i, frame] of frames.entries()) {
      if (i >= 2)
        await expect
          .poll(() => fast.binary.length, { timeout: REPLY_MS, intervals: [5, 10, 20, 50] })
          .toBeGreaterThanOrEqual(i - 1);
      await sendBinary(publisher, frame);
    }
    publisher.send({ type: "scene.snapshot.end", id: "sc-e", sceneVersion: 1, sha256: fields.sha256 });
    const ack = await publisher.next((m) => m.type === "scene.snapshot.ack" || m.type === "error", REPLY_MS);
    expect(ack).toMatchObject({ type: "scene.snapshot.ack", sceneVersion: 1, viewersStreamed: 1, viewersDeferred: 1 });
    await fast.next("scene.snapshot.end", REPLY_MS);
    expect(fast.binary).toHaveLength(frames.length);

    // 2. Updates cannot be deferred: ≈ 240 KiB each, paced under the publisher's 4 MiB/s budget (budget.ts), until
    //    one would take `slow` over the 8 MiB hard watermark and the relay closes it (its log says so; the
    //    line carries ids, byte counts and the rule only).
    const closedLine = new RegExp(
      '"message":"slow consumer closed"[^\\n]*"reason":"HARD_WATERMARK"|' +
        '"reason":"HARD_WATERMARK"[^\\n]*"message":"slow consumer closed"',
    );
    let sent = 0;
    for (let base = 1; base <= 80 && !closedLine.test(stack.relay.log()); base++) {
      const update = bigUpdate(base, 780);
      expect(Buffer.byteLength(update)).toBeLessThanOrEqual(LIMITS.MAX_TEXT_BYTES_PUBLISHER);
      publisher.sendRaw(update);
      sent++;
      await new Promise((r) => setTimeout(r, 150));
    }
    await expect.poll(() => closedLine.test(stack.relay.log()), { timeout: REPLY_MS }).toBe(true);
    // 3. `slow` reads again: everything queued for it arrives, then `error SLOW_CONSUMER` and close 4010
    //    (it must read within the relay's 5 s termination window to see the close code).
    slow.socket.resume();
    expect((await slow.closedWithin(REPLY_MS)).code).toBe(4010);
    const types = slow.messages.map((m) => m.type);
    const ready = slow.messages.find((m) => m.type === "scene.snapshot.ready");
    expect(ready).toMatchObject({ sceneVersion: 1, byteLength: bytes.byteLength, sha256: fields.sha256 });
    expect(types.indexOf("scene.state", types.indexOf("scene.snapshot.ready"))).toBeGreaterThan(-1);
    const last = slow.messages.at(-1);
    expect(last).toMatchObject({ type: "error", code: "SLOW_CONSUMER", retryable: true });
    // Deferred mid-stream: it got fewer chunks than the snapshot has, and no `end`.
    expect(slow.binary.length).toBeLessThan(frames.length);
    expect(types.includes("scene.snapshot.end")).toBe(false);

    test.info().annotations.push({
      type: "slow-consumer",
      description:
        `slow viewer got ${slow.binary.length}/${frames.length} chunks before deferral; ` +
        `${sent} updates of ≈ 251 KB sent before 4010`,
    });
    // 4. The reading viewer got every update and stays connected; the publisher too (FR-24).
    await roundTrip(publisher, "sc-rt");
    await expect
      .poll(() => fast.messages.filter((m) => m.type === "scene.update").length, { timeout: REPLY_MS })
      .toBe(sent);
    await roundTrip(fast, "sc-frt");
    expect(fast.closeInfo).toBeUndefined();
    expect(publisher.closeInfo).toBeUndefined();
    expect(errorsOf(publisher)).toHaveLength(0);
    // The publisher sees the count drop back to one viewer (after it had reached two).
    await expect
      .poll(() => publisher.messages.filter((m) => m.type === "viewer.count").at(-1)?.viewerCount, {
        timeout: REPLY_MS,
      })
      .toBe(1);
    expect(publisher.messages.some((m) => m.type === "viewer.count" && m.viewerCount === 2)).toBe(true);

    await assertServing(stack.wsUrl);
    await closeSession(publisher);
  });
});
