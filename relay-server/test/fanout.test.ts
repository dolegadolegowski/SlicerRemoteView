import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection } from "../src/ws/connection.js";
import {
  fanout,
  MAX_PAUSE_MS,
  PUBLISHER_BUFFER_LIMIT_BYTES,
  SLOW_CONSUMER_TERMINATE_MS,
  STUCK_MS,
  WATCH_INTERVAL_MS,
} from "../src/ws/fanout.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = new URL("../../shared/fixtures/glb/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", GLB), "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
const LARGE = "large-synthetic.glb";
const bytes = readFileSync(new URL(LARGE, GLB));
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
// Exposed by `execArgv: ["--expose-gc"]` in vitest.config.ts.
declare const gc: () => void;

const KIB = 1024;
const MIB = 1024 * KIB;
const CHUNK = 64 * KIB;
/** `MAX_TOTAL_BUFFERED_BYTES` of the budget tests (SRV-10 criterion 2). */
const BUDGET = 20 * MIB;

let relay: TestRelay | undefined;
afterEach(async () => {
  // Cleared first, so a close that fails does not hand a half-closed relay to the next test.
  const closing = relay;
  relay = undefined;
  await closing?.close();
});

async function publisher(
  env: Record<string, string> = {},
  logger?: ReturnType<typeof createLogger>,
): Promise<{ client: TestClient; session: Session; peer: Connection }> {
  relay ??= await startRelay({
    config: loadConfig({
      TRUST_PROXY: "false",
      ALLOWED_ORIGINS: "https://relay.example.org",
      ...env,
    }),
    ...(logger !== undefined && { logger }),
  });
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  const session = relay.registry.get(created.sessionId as string)!;
  return { client, session, peer: session.publisher as Connection };
}

interface TestViewer {
  client: TestClient;
  /** Every frame as received: text as a string, binary as a `Buffer`. */
  raw: (string | Buffer)[];
  /** The relay's side of the socket. */
  peer: Connection;
}

async function join(session: Session): Promise<TestViewer> {
  const client = await connectClient(relay!.url);
  const raw: (string | Buffer)[] = [];
  client.ws.on("message", (data: RawData, isBinary: boolean) =>
    raw.push(isBinary ? (data as Buffer) : data.toString()),
  );
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
  const joined = await client.next();
  expect(joined.type).toBe("viewer.joined");
  const peer = session.viewers.get(joined.viewerId as string)!.peer as Connection;
  return { client, raw, peer };
}

/** Replaces the relay-side `bufferedAmount` of a socket (the `ws` getter stays untouched). */
function mockBuffered(peer: Connection, amount: number): void {
  Object.defineProperty(peer, "bufferedAmount", { configurable: true, get: () => amount });
}

/** Round trip: everything sent before has been handled; returns what arrived meanwhile. */
async function flush(client: TestClient): Promise<Received[]> {
  const id = `flush-${Math.random()}`;
  client.send({ type: "ping", id });
  const seen: Received[] = [];
  for (;;) {
    const message = await client.next();
    expect(validateMessage(message)).toMatchObject({ ok: true });
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

/** The publisher's frames of one snapshot, exactly as it sends them. */
function snapshotFrames(sceneVersion: number, data: Uint8Array = bytes, chunkSize = CHUNK) {
  // Indented: a relay that re-serialised the message instead of forwarding it would change the bytes.
  const begin = JSON.stringify(
    {
      protocolVersion: "1.0",
      type: "scene.snapshot.begin",
      id: `b-${sceneVersion}`,
      sceneVersion,
      byteLength: data.byteLength,
      sha256: sha256(data),
      chunkCount: Math.ceil(data.byteLength / chunkSize),
      chunkSize,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 4,
    },
    null,
    1,
  );
  const chunks = [...chunkify(data, chunkSize)].map(({ chunkIndex, payload }) =>
    Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)),
  );
  const end = JSON.stringify(
    {
      protocolVersion: "1.0",
      type: "scene.snapshot.end",
      id: `e-${sceneVersion}`,
      sceneVersion,
      sha256: sha256(data),
    },
    null,
    1,
  );
  return { begin, chunks, end };
}

type Frames = ReturnType<typeof snapshotFrames>;

/** Sends `begin` (when `from` is 0), chunks `from`…`to - 1` and `end` (when `to` is the last). */
function send(
  client: TestClient,
  frames: Frames,
  from = 0,
  to = frames.chunks.length,
  end = to === frames.chunks.length,
): void {
  if (from === 0) client.sendRaw(frames.begin);
  for (const chunk of frames.chunks.slice(from, to)) client.sendRaw(chunk, true);
  if (end) client.sendRaw(frames.end);
}

const binaries = (viewer: TestViewer): Buffer[] =>
  viewer.raw.filter((frame): frame is Buffer => Buffer.isBuffer(frame));
/** Frames as comparable strings: a diff of megabyte Buffers would take the test runner minutes. */
const digests = (frames: (string | Buffer)[]): string[] =>
  frames.map((frame) => (typeof frame === "string" ? frame : `binary ${sha256(frame)}`));
/** The acks among the publisher's messages up to a round trip (`viewer.count` may come first). */
const acks = async (client: TestClient): Promise<Received[]> =>
  (await flush(client)).filter((m) => m.type === "scene.snapshot.ack");
const types = (viewer: TestViewer): string[] => viewer.client.received.map((m) => m.type);
const ack = (viewersStreamed: number, viewersDeferred: number) => [
  expect.objectContaining({ type: "scene.snapshot.ack", viewersStreamed, viewersDeferred }),
];

describe("streamed and deferred viewers (SRV-10 criterion 1, §6.4, architecture §2.3)", () => {
  it("a fast viewer gets begin, every chunk and end byte for byte; a 5 MiB one only ready", async () => {
    const { client, session } = await publisher();
    const fast = await join(session);
    const slow = await join(session);
    await flush(client);
    mockBuffered(slow.peer, 5 * MIB);
    const frames = snapshotFrames(1);
    send(client, frames);
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(fast.client);
    await flush(slow.client);

    const start = fast.raw.indexOf(frames.begin);
    expect(start).toBeGreaterThan(0);
    expect(digests(fast.raw.slice(start, start + frames.chunks.length + 2))).toEqual(
      digests([frames.begin, ...frames.chunks, frames.end]),
    );
    const assembled = Buffer.concat(binaries(fast).map((frame) => frame.subarray(12)));
    expect(sha256(assembled)).toBe(manifest.files[LARGE]!.sha256);
    expect(types(fast)).not.toContain("scene.snapshot.ready");

    expect(binaries(slow)).toHaveLength(0);
    expect(types(slow)).not.toContain("scene.snapshot.begin");
    expect(types(slow)).not.toContain("scene.snapshot.end");
    const ready = slow.client.received.find((m) => m.type === "scene.snapshot.ready");
    expect(ready).toEqual({
      protocolVersion: "1.0",
      type: "scene.snapshot.ready",
      sceneVersion: 1,
      byteLength: manifest.files[LARGE]!.byteLength,
      sha256: manifest.files[LARGE]!.sha256,
      format: "glb",
      extensionsRequired: [],
      ts: expect.any(Number),
    });
  });

  it("at begin, below 4 MiB is streamed and exactly 4 MiB deferred (§6.5)", async () => {
    const { client, session } = await publisher();
    const below = await join(session);
    const at = await join(session);
    await flush(client);
    mockBuffered(below.peer, 4 * MIB - 1);
    mockBuffered(at.peer, 4 * MIB);
    send(client, snapshotFrames(1, bytes.subarray(0, 3 * CHUNK)));
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(below.client);
    await flush(at.client);
    expect(binaries(below)).toHaveLength(3);
    expect(binaries(at)).toHaveLength(0);
    expect(types(at)).not.toContain("scene.snapshot.begin");
  });

  it("a viewer that joins mid-stream gets no chunks, only ready after end (§6.4 b)", async () => {
    const { client, session } = await publisher();
    const early = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 10);
    await flush(client);
    const late = await join(session);
    send(client, frames, 10);
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(late.client);
    await flush(early.client);
    expect(binaries(early)).toHaveLength(frames.chunks.length);
    expect(binaries(late)).toHaveLength(0);
    expect(types(late)).toContain("scene.snapshot.ready");
    expect(types(late)).not.toContain("scene.snapshot.end");
  });

  it("a streamed viewer crossing 4 MiB mid-stream gets no more chunks and ready, not end", async () => {
    const { client, session } = await publisher();
    const fast = await join(session);
    const lagging = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 10);
    await flush(client);
    mockBuffered(lagging.peer, 4 * MIB);
    send(client, frames, 10);
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(lagging.client);
    await flush(fast.client);
    expect(digests(binaries(lagging))).toEqual(digests(frames.chunks.slice(0, 10)));
    expect(types(lagging)).toEqual(expect.arrayContaining(["scene.snapshot.begin"]));
    expect(types(lagging)).toContain("scene.snapshot.ready");
    expect(types(lagging)).not.toContain("scene.snapshot.end");
    expect(binaries(fast)).toHaveLength(frames.chunks.length);
  });

  it("a viewer that left mid-stream is neither streamed nor deferred", async () => {
    const { client, session } = await publisher();
    const staying = await join(session);
    const leaving = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 5);
    await flush(client);
    leaving.client.send({ type: "viewer.leave" });
    expect(await leaving.client.closed).toBe(1000);
    send(client, frames, 5);
    expect(await acks(client)).toEqual(ack(1, 0));
    await flush(staying.client);
    expect(binaries(staying)).toHaveLength(frames.chunks.length);
  });
});

describe("a viewer that left mid-stream", () => {
  it("no longer counts for the chunks still to come (no eviction for its share)", async () => {
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const staying = await join(session);
    const leaving = await join(session);
    const holders = [await join(session), await join(session), await join(session)];
    await flush(client);
    mockBuffered(staying.peer, 3 * MIB);
    for (const holder of holders) mockBuffered(holder.peer, 4 * MIB); // deferred at begin
    const frames = snapshotFrames(1);
    send(client, frames, 0, 3);
    await flush(client);
    leaving.client.send({ type: "viewer.leave" });
    expect(await leaving.client.closed).toBe(1000);
    // Σ one chunk (+ header) under the budget: the next chunk to the one streamed viewer fits exactly.
    mockBuffered(holders[0]!.peer, 7 * MIB);
    mockBuffered(holders[1]!.peer, 6 * MIB);
    mockBuffered(holders[2]!.peer, 4 * MIB - (CHUNK + 12));
    send(client, frames, 3);
    expect(await acks(client)).toEqual(ack(1, 3));
    expect(holders.every((holder) => holder.peer.isOpen)).toBe(true);
  });
});

describe("one Buffer for every viewer (SRV-10 criterion 3, NFR-05)", () => {
  it("each chunk goes to every socket's send as the identical Buffer instance", async () => {
    const { client, session } = await publisher();
    const viewers = [await join(session), await join(session), await join(session)];
    const spies = viewers.map((viewer) => vi.spyOn(viewer.peer.socket, "send"));
    const frames = snapshotFrames(1);
    send(client, frames);
    expect(await acks(client)).toEqual(ack(3, 0));
    const sent = spies.map((spy) =>
      spy.mock.calls.map((call) => call[0]).filter((data) => Buffer.isBuffer(data)),
    );
    expect(sent[0]).toHaveLength(frames.chunks.length);
    for (const other of sent.slice(1)) {
      expect(other).toHaveLength(frames.chunks.length);
      expect(other.every((data, index) => data === sent[0]![index])).toBe(true);
    }
  });
});

describe("slow consumers (SRV-10 criterion 2, §3.3, §9.3)", () => {
  it("above 8 MiB mid-stream → SLOW_CONSUMER + 4010; a rejoin mid-stream gets ready", async () => {
    const { client, session } = await publisher();
    const fast = await join(session);
    const stalled = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 10);
    await flush(client);
    mockBuffered(stalled.peer, 8 * MIB + 1);
    send(client, frames, 10, 11);
    expect(await stalled.client.closed).toBe(4010);
    expect(stalled.client.received.at(-1)).toMatchObject({
      type: "error",
      code: "SLOW_CONSUMER",
      retryable: true,
    });
    expect(digests(binaries(stalled))).toEqual(digests(frames.chunks.slice(0, 10)));
    await expect.poll(() => session.connectedViewers).toBe(1);

    const rejoined = await join(session);
    send(client, frames, 11);
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(rejoined.client);
    expect(types(rejoined)).toContain("scene.snapshot.ready");
    expect(binaries(rejoined)).toHaveLength(0);
    await flush(fast.client);
    expect(binaries(fast)).toHaveLength(frames.chunks.length);
  });

  it("above the soft watermark for more than 60 s → 4010; below it stays", async () => {
    const { client, session } = await publisher();
    const stuck = await join(session);
    const draining = await join(session);
    await flush(client);
    mockBuffered(stuck.peer, 5 * MIB);
    mockBuffered(draining.peer, 3 * MIB);
    relay!.clock.advance(STUCK_MS);
    await flush(stuck.client);
    expect(types(stuck)).not.toContain("error");
    relay!.clock.advance(2 * WATCH_INTERVAL_MS);
    expect(await stuck.client.closed).toBe(4010);
    expect(stuck.client.received.at(-1)).toMatchObject({ code: "SLOW_CONSUMER" });
    expect(types(draining)).not.toContain("error");
    await flush(draining.client);
  });

  it("Σ above MAX_TOTAL_BUFFERED_BYTES: the slowest of three 7 MiB viewers is closed", async () => {
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const [a, b, c] = [await join(session), await join(session), await join(session)];
    await flush(client);
    // c has been above the soft watermark for longest: the slowest of three equal buffers.
    mockBuffered(c!.peer, 7 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    mockBuffered(a!.peer, 7 * MIB);
    mockBuffered(b!.peer, 7 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(await c!.client.closed).toBe(4010);
    expect(c!.client.received.at(-1)).toMatchObject({ code: "SLOW_CONSUMER" });
    await expect.poll(() => session.connectedViewers).toBe(2);
    expect(a!.peer.isOpen && b!.peer.isOpen).toBe(true);
    expect(a!.peer.bufferedAmount + b!.peer.bufferedAmount).toBeLessThanOrEqual(BUDGET);
  });

  it("a chunk that would push Σ over the budget closes the largest buffer first", async () => {
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const streamed = [await join(session), await join(session)];
    const [largest, smaller] = [await join(session), await join(session)];
    await flush(client);
    // 64 KiB under the budget: the watch has nothing to do; the first chunk to the two streamed
    // sockets (2 × (64 KiB + 12 B)) overflows it.
    for (const viewer of streamed) mockBuffered(viewer.peer, 3 * MIB);
    mockBuffered(largest!.peer, 7 * MIB);
    mockBuffered(smaller!.peer, 7 * MIB - CHUNK);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(largest!.peer.isOpen && smaller!.peer.isOpen).toBe(true);

    const frames = snapshotFrames(1);
    send(client, frames);
    expect(await largest!.client.closed).toBe(4010);
    expect(largest!.client.received.at(-1)).toMatchObject({ code: "SLOW_CONSUMER" });
    expect(await acks(client)).toEqual(ack(2, 1));
    for (const viewer of streamed) {
      await flush(viewer.client);
      expect(binaries(viewer)).toHaveLength(frames.chunks.length);
    }
    expect(smaller!.peer.isOpen).toBe(true);
    expect(types(smaller!)).toContain("scene.snapshot.ready");
  });
});

describe("a publisher's own send buffer (T3)", () => {
  it("above 1 MiB → SLOW_CONSUMER + 4010, logged once; its session enters grace", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { client, session, peer } = await publisher({}, logger);
    await flush(client);
    mockBuffered(peer, PUBLISHER_BUFFER_LIMIT_BYTES + 1);
    // Closed at the first watch; the next ones see it closing (its close event is still on its way).
    relay!.clock.advance(3 * WATCH_INTERVAL_MS);
    expect([4010, 1006]).toContain(await client.closed);
    expect(client.received.at(-1)).toMatchObject({ type: "error", code: "SLOW_CONSUMER" });
    await expect.poll(() => session.phase).toBe("grace");
    const closes = lines.filter((l) => l.includes("slow consumer closed"));
    expect(closes).toHaveLength(1);
    expect(JSON.parse(closes[0]!)).toMatchObject({
      sessionId: session.id,
      role: "publisher",
      bufferedBytes: PUBLISHER_BUFFER_LIMIT_BYTES + 1,
      reason: "PUBLISHER_LIMIT",
    });
  });

  it("at exactly 1 MiB it stays, however long (no stuck rule: the heartbeat watches it)", async () => {
    const { client, peer } = await publisher();
    await flush(client);
    mockBuffered(peer, PUBLISHER_BUFFER_LIMIT_BYTES);
    relay!.clock.advance(STUCK_MS + 2 * WATCH_INTERVAL_MS);
    expect(peer.isOpen).toBe(true);
  });
});

describe("over the budget: publishers paused, joins refused (architecture §5, §5.2)", () => {
  it("Σ at the budget pauses the publisher of a snapshot in flight; joins get CAPACITY + 4006", async () => {
    const { client, session, peer } = await publisher({
      MAX_TOTAL_BUFFERED_BYTES: String(BUDGET),
    });
    const viewers = [await join(session), await join(session), await join(session)];
    await flush(client);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 2);
    await flush(client);
    const pause = vi.spyOn(peer, "pauseReading");
    const resume = vi.spyOn(peer, "resumeReading");
    mockBuffered(viewers[0]!.peer, 7 * MIB);
    mockBuffered(viewers[1]!.peer, 7 * MIB);
    mockBuffered(viewers[2]!.peer, 6 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(pause).toHaveBeenCalled();
    expect(viewers.every((viewer) => viewer.peer.isOpen)).toBe(true);

    const refused = await connectClient(relay!.url);
    refused.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    expect(await refused.next()).toMatchObject({ type: "error", code: "CAPACITY" });
    expect(await refused.closed).toBe(4006);

    // The publisher's frames wait in its socket meanwhile.
    client.send({ type: "ping", id: "while-paused" });
    await flush(viewers[0]!.client);
    await delay(50);
    expect(client.received.at(-1)?.replyTo).not.toBe("while-paused");

    mockBuffered(viewers[2]!.peer, 0);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(resume).toHaveBeenCalled();
    expect(await client.next()).toMatchObject({ type: "pong", replyTo: "while-paused" });
    send(client, frames, 2);
    // The two 7 MiB viewers left the stream at the next chunk.
    expect(await acks(client)).toEqual(ack(1, 2));
    const admitted = await join(session);
    expect(admitted.peer.isOpen).toBe(true);
  });

  it("only publishers whose own streamed viewers hold their chunks are paused (§9.1)", async () => {
    const first = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const viewers = [
      await join(first.session),
      await join(first.session),
      await join(first.session),
    ];
    await flush(first.client);
    send(first.client, snapshotFrames(1), 0, 2);
    await flush(first.client);
    // A publisher without a stream, one streaming to a viewer that reads, one to a viewer that lags.
    const idle = await publisher();
    const reading = await publisher();
    const readingViewer = await join(reading.session);
    const lagging = await publisher();
    const laggingViewer = await join(lagging.session);
    await flush(reading.client);
    await flush(lagging.client);
    const spies = [idle, reading, lagging].map((p) => ({
      pause: vi.spyOn(p.peer, "pauseReading"),
      resume: vi.spyOn(p.peer, "resumeReading"),
    }));
    mockBuffered(readingViewer.peer, 0);
    mockBuffered(laggingViewer.peer, MIB);
    mockBuffered(viewers[0]!.peer, 7 * MIB);
    mockBuffered(viewers[1]!.peer, 7 * MIB);
    mockBuffered(viewers[2]!.peer, 4 * MIB);
    const small = bytes.subarray(0, 4 * CHUNK);
    send(reading.client, snapshotFrames(1, small), 0, 1, false);
    send(lagging.client, snapshotFrames(1, small), 0, 1, false);
    await flush(reading.client);
    await flush(lagging.client);
    // Exactly the budget: nobody is evicted, the watch pauses.
    mockBuffered(viewers[2]!.peer, 5 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(spies[2]!.pause).toHaveBeenCalled();
    expect(spies[0]!.pause).not.toHaveBeenCalled();
    expect(spies[1]!.pause).not.toHaveBeenCalled();
    expect(await flush(idle.client)).toEqual([]);
    await flush(reading.client);
    expect([...viewers, readingViewer, laggingViewer].every((v) => v.peer.isOpen)).toBe(true);

    mockBuffered(viewers[2]!.peer, MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(spies[2]!.resume).toHaveBeenCalled();
    await flush(lagging.client);
  });

  it("a pause lasts at most 5 s; the publisher is then read and its pings answered (§9.1)", async () => {
    const { client, session, peer } = await publisher({
      MAX_TOTAL_BUFFERED_BYTES: String(BUDGET),
    });
    const holder = await join(session);
    const others = [await join(session), await join(session), await join(session)];
    await flush(client);
    send(client, snapshotFrames(1), 0, 1, false);
    await flush(client);
    const pause = vi.spyOn(peer, "pauseReading");
    const resume = vi.spyOn(peer, "resumeReading");
    // Exactly the budget, nobody to evict: held there for as long as the test likes.
    mockBuffered(holder.peer, MIB);
    mockBuffered(others[0]!.peer, 7 * MIB);
    mockBuffered(others[1]!.peer, 7 * MIB);
    mockBuffered(others[2]!.peer, 5 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(pause).toHaveBeenCalledTimes(1);
    client.send({ type: "ping", id: "held" });
    relay!.clock.advance(MAX_PAUSE_MS - WATCH_INTERVAL_MS);
    await delay(50);
    expect(resume).not.toHaveBeenCalled();
    expect(client.received.at(-1)?.replyTo).not.toBe("held");
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(await client.next()).toMatchObject({ type: "pong", replyTo: "held" });
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(pause).toHaveBeenCalledTimes(2);
    expect([holder, ...others].every((viewer) => viewer.peer.isOpen)).toBe(true);
  });

  it("every bound stays below the clients' 10 s pong timeout (§9.1)", () => {
    expect(MAX_PAUSE_MS + WATCH_INTERVAL_MS).toBeLessThan(10_000);
    expect(SLOW_CONSUMER_TERMINATE_MS + WATCH_INTERVAL_MS).toBeLessThan(10_000);
  });
});

describe("a paused publisher still completes a close", () => {
  async function pausedPublisher() {
    const { client, session, peer } = await publisher({
      MAX_TOTAL_BUFFERED_BYTES: String(BUDGET),
    });
    const holder = await join(session);
    const big = await join(session);
    await flush(client);
    send(client, snapshotFrames(1), 0, 1, false);
    await flush(client);
    const pause = vi.spyOn(peer, "pauseReading");
    // `big` is closed (hard watermark) and still counts; `holder` holds the stream's chunks.
    mockBuffered(holder.peer, MIB);
    mockBuffered(big.peer, BUDGET);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(pause).toHaveBeenCalled();
    return { client, session };
  }

  it("a socket being closed is not paused again", async () => {
    const { peer } = await publisher();
    const pause = vi.spyOn(peer.socket, "pause");
    peer.close(1000);
    peer.pauseReading();
    expect(pause).not.toHaveBeenCalled();
  });

  it("the session ending closes its socket at once, not after the 30 s close timeout", async () => {
    const { client, session } = await pausedPublisher();
    relay!.registry.expireSession(session, "MAX_LIFETIME");
    expect(await client.closed).toBeGreaterThan(0);
  });

  it("a shutdown does not wait for the paused socket", async () => {
    const { client } = await pausedPublisher();
    const started = performance.now();
    await relay!.close();
    relay = undefined;
    expect(await client.closed).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("aborts reach the viewers that got the begin (§6.2, §6.4)", () => {
  it("a newer begin → abort{SUPERSEDED} to streamed viewers, not to late joiners", async () => {
    const { client, session } = await publisher();
    const early = await join(session);
    const v1 = snapshotFrames(1);
    send(client, v1, 0, 5);
    await flush(client);
    const late = await join(session);
    const v2 = snapshotFrames(2);
    send(client, v2);
    expect(await acks(client)).toEqual(ack(2, 0));
    await flush(early.client);
    await flush(late.client);
    const abort = { type: "scene.snapshot.abort", sceneVersion: 1, reason: "SUPERSEDED" };
    expect(early.client.received).toContainEqual(expect.objectContaining(abort));
    const abortAt = early.raw.findIndex(
      (frame) => typeof frame === "string" && frame.includes('"scene.snapshot.abort"'),
    );
    expect(abortAt).toBeGreaterThan(early.raw.indexOf(v1.begin));
    expect(abortAt).toBeLessThan(early.raw.indexOf(v2.begin));
    expect(types(late)).not.toContain("scene.snapshot.abort");
    expect(late.raw).toContain(v2.begin);
    expect(digests(binaries(late))).toEqual(digests(v2.chunks));
  });

  it("a viewer dropped from the stream mid-snapshot still gets its abort, and no ready", async () => {
    const { client, session } = await publisher();
    const streamed = await join(session);
    const dropped = await join(session);
    const v1 = snapshotFrames(1);
    send(client, v1, 0, 3);
    await flush(client);
    mockBuffered(dropped.peer, 4 * MIB);
    send(client, v1, 3, 6, false);
    const v2 = snapshotFrames(2);
    send(client, v2);
    expect(await acks(client)).toEqual(ack(1, 1));
    await flush(dropped.client);
    await flush(streamed.client);
    const abortsOf = (viewer: TestViewer) =>
      viewer.client.received
        .filter((m) => m.type === "scene.snapshot.abort")
        .map((m) => `${m.sceneVersion}:${m.reason}`);
    expect(abortsOf(dropped)).toEqual(["1:SUPERSEDED"]);
    expect(abortsOf(streamed)).toEqual(["1:SUPERSEDED"]);
    expect(digests(binaries(dropped))).toEqual(digests(v1.chunks.slice(0, 3)));
    const readies = dropped.client.received.filter((m) => m.type === "scene.snapshot.ready");
    expect(readies.map((m) => m.sceneVersion)).toEqual([2]);
  });

  it("the publisher's own abort is forwarded byte for byte", async () => {
    const { client, session } = await publisher();
    const viewer = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 3);
    const abort = JSON.stringify(
      {
        protocolVersion: "1.0",
        type: "scene.snapshot.abort",
        sceneVersion: 1,
        reason: "SUPERSEDED",
        note: "unknown fields pass (§14)",
      },
      null,
      1,
    );
    client.sendRaw(abort);
    await flush(client);
    await flush(viewer.client);
    expect(viewer.raw).toContain(abort);
  });

  it("a checksum mismatch or a sequence error aborts; later chunks are not forwarded", async () => {
    const { client, session } = await publisher();
    const viewer = await join(session);
    const v1 = snapshotFrames(1);
    send(client, v1, 0, v1.chunks.length, false);
    client.send({ type: "scene.snapshot.end", sceneVersion: 1, sha256: "0".repeat(64) });
    expect((await flush(client)).filter((m) => m.type === "error")).toEqual([
      expect.objectContaining({ code: "CHECKSUM_MISMATCH" }),
    ]);
    const v2 = snapshotFrames(2);
    send(client, v2, 0, 3);
    client.sendRaw(v2.chunks[4]!, true); // chunk 3 skipped
    send(client, v2, 5);
    await flush(client);
    await flush(viewer.client);
    const aborts = viewer.client.received.filter((m) => m.type === "scene.snapshot.abort");
    expect(aborts).toEqual([
      expect.objectContaining({ sceneVersion: 1, reason: "CHECKSUM_MISMATCH" }),
      expect.objectContaining({ sceneVersion: 2, reason: "BAD_SEQUENCE" }),
    ]);
    expect(digests(binaries(viewer))).toEqual(digests([...v1.chunks, ...v2.chunks.slice(0, 3)]));
    expect(types(viewer)).not.toContain("scene.snapshot.end");
    expect(types(viewer)).not.toContain("scene.snapshot.ready");
  });

  it("the publisher's socket lost mid-stream → abort{PUBLISHER_GONE}", async () => {
    const { client, session } = await publisher();
    const viewer = await join(session);
    send(client, snapshotFrames(1), 0, 3);
    await flush(client);
    client.ws.close();
    await expect
      .poll(() => viewer.client.received.some((m) => m.type === "scene.snapshot.abort"))
      .toBe(true);
    expect(viewer.client.received.find((m) => m.type === "scene.snapshot.abort")).toMatchObject({
      sceneVersion: 1,
      reason: "PUBLISHER_GONE",
    });
  });
});

describe("logs (NFR-12)", () => {
  it("a slow-consumer close logs ids and byte counts, never the code or a token", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { client, session } = await publisher({}, logger);
    const viewer = await join(session);
    await flush(client);
    mockBuffered(viewer.peer, 9 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(await viewer.client.closed).toBe(4010);
    const line = lines.find((l) => l.includes("slow consumer closed"));
    expect(JSON.parse(line!)).toMatchObject({
      sessionId: session.id,
      bufferedBytes: 9 * MIB,
      reason: "HARD_WATERMARK",
      errorCode: "SLOW_CONSUMER",
    });
    const joined = viewer.client.received[0]!;
    for (const l of lines) {
      expect(l).not.toContain(session.code);
      expect(l).not.toContain(joined.viewerToken as string);
    }
  });
});

describe("boundaries of the watermarks and the budget (§3.3, architecture §4)", () => {
  it("exactly 8 MiB is not over the hard watermark: deferred, not closed", async () => {
    const { client, session } = await publisher();
    const viewer = await join(session);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 5);
    await flush(client);
    mockBuffered(viewer.peer, 8 * MIB);
    send(client, frames, 5);
    expect(await acks(client)).toEqual(ack(0, 1));
    relay!.clock.advance(WATCH_INTERVAL_MS);
    await flush(viewer.client);
    expect(viewer.peer.isOpen).toBe(true);
    expect(types(viewer)).not.toContain("error");
    expect(types(viewer)).toContain("scene.snapshot.ready");
    expect(binaries(viewer)).toHaveLength(5);
  });

  it("a chunk that brings Σ exactly to the budget evicts nobody", async () => {
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const streamed = [await join(session), await join(session)];
    const deferred = [await join(session), await join(session)];
    await flush(client);
    for (const viewer of streamed) mockBuffered(viewer.peer, 3 * MIB);
    mockBuffered(deferred[0]!.peer, 7 * MIB);
    // The first chunk adds 2 × (64 KiB + 12 B): Σ is then exactly the budget.
    mockBuffered(deferred[1]!.peer, 7 * MIB - 2 * (CHUNK + 12));
    send(client, snapshotFrames(1));
    expect(await acks(client)).toEqual(ack(2, 2));
    expect([...streamed, ...deferred].every((viewer) => viewer.peer.isOpen)).toBe(true);
  });

  it("stuck means 60 s in a row at or above 4 MiB: a dip below restarts the count", async () => {
    const { client, session } = await publisher();
    const viewer = await join(session);
    await flush(client);
    mockBuffered(viewer.peer, 5 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS); // above since t = 1 s
    mockBuffered(viewer.peer, MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS); // below: the count restarts
    relay!.clock.advance(STUCK_MS - 3 * WATCH_INTERVAL_MS);
    mockBuffered(viewer.peer, 5 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS); // above again since t = 60 s
    relay!.clock.advance(STUCK_MS);
    await flush(viewer.client);
    expect(viewer.peer.isOpen).toBe(true);
    expect(types(viewer)).not.toContain("error");
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(await viewer.client.closed).toBe(4010);
  });
});

describe("sockets closed as slow consumers until they are gone", () => {
  it("count neither in the ack nor for CAPACITY, and are terminated after 5 s", async () => {
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const fast = await join(session);
    const stalled = await join(session);
    await flush(client);
    // Its client reads nothing, so the relay's close handshake stays pending.
    stalled.client.ws.pause();
    const frames = snapshotFrames(1);
    send(client, frames, 0, 5);
    await flush(client);
    mockBuffered(stalled.peer, 9 * MIB);
    send(client, frames, 5);
    expect(await acks(client)).toEqual(ack(1, 0));
    expect(session.viewers.get(stalled.peer.viewer!.id)?.peer).toBe(stalled.peer);

    // On its way out: a chain of evictions must not refuse every join on the relay.
    mockBuffered(stalled.peer, BUDGET);
    expect((await join(session)).peer.isOpen).toBe(true);

    relay!.clock.advance(SLOW_CONSUMER_TERMINATE_MS - 1);
    await flush(fast.client);
    expect(session.viewers.get(stalled.peer.viewer!.id)?.peer).toBe(stalled.peer);
    relay!.clock.advance(1);
    await expect.poll(() => session.connectedViewers).toBe(2);
    expect(binaries(fast)).toHaveLength(frames.chunks.length);
    stalled.client.ws.resume();
    expect([4010, 1006]).toContain(await stalled.client.closed);
  });

  it("a shutdown terminates them at once instead of waiting for their close", async () => {
    const { client, session } = await publisher();
    const stalled = await join(session);
    await flush(client);
    stalled.client.ws.pause();
    mockBuffered(stalled.peer, 9 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(stalled.peer.isOpen).toBe(false);
    const started = performance.now();
    const closing = relay!;
    relay = undefined;
    await closing.close();
    expect(performance.now() - started).toBeLessThan(2_000);
    stalled.client.ws.resume();
    expect([4010, 1006]).toContain(await stalled.client.closed);
  });
});

describe("pausing publishers on a chunk (§5)", () => {
  it("a chunk that leaves Σ at the budget pauses the publisher before the next watch", async () => {
    const budget = 8 * MIB; // the smallest MAX_TOTAL_BUFFERED_BYTES
    const { client, session, peer } = await publisher({
      MAX_TOTAL_BUFFERED_BYTES: String(budget),
    });
    const fast = await join(session);
    const stalled = await join(session);
    await flush(client);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 5);
    await flush(client);
    const pause = vi.spyOn(peer, "pauseReading");
    // Over the hard watermark: closed at the next chunk, and still counted until its socket is gone;
    // the fast viewer holds the stream's chunks.
    mockBuffered(fast.peer, MIB);
    mockBuffered(stalled.peer, budget + 1);
    send(client, frames, 5, 6, false);
    await expect.poll(() => pause.mock.calls.length).toBeGreaterThan(0);
    expect(await stalled.client.closed).toBe(4010);
    await expect.poll(() => session.connectedViewers).toBe(1);

    const resume = vi.spyOn(peer, "resumeReading");
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(resume).toHaveBeenCalled();
    send(client, frames, 6);
    expect(await acks(client)).toEqual(ack(1, 0));
    await flush(fast.client);
    expect(binaries(fast)).toHaveLength(frames.chunks.length);
  });
});

describe("session isolation (T11)", () => {
  it("two sessions streaming at once: chunks, end, ready and aborts stay in their session", async () => {
    const a = await publisher();
    const b = await publisher();
    const [a1, a2] = [await join(a.session), await join(a.session)];
    const [b1, b2] = [await join(b.session), await join(b.session)];
    await flush(a.client);
    await flush(b.client);
    mockBuffered(a2!.peer, 5 * MIB);
    mockBuffered(b2!.peer, 5 * MIB);
    // The same sceneVersion in both sessions, other bytes in B.
    const fa = snapshotFrames(1);
    const other = Buffer.from(bytes.subarray(0, 10 * CHUNK + 100)).reverse();
    const fb = snapshotFrames(1, other);
    a.client.sendRaw(fa.begin);
    b.client.sendRaw(fb.begin);
    for (let i = 0; i < fa.chunks.length; i++) {
      a.client.sendRaw(fa.chunks[i]!, true);
      if (i < fb.chunks.length) b.client.sendRaw(fb.chunks[i]!, true);
    }
    a.client.sendRaw(fa.end);
    b.client.sendRaw(fb.end);
    expect(await acks(a.client)).toEqual(ack(1, 1));
    expect(await acks(b.client)).toEqual(ack(1, 1));
    for (const viewer of [a1!, a2!, b1!, b2!]) await flush(viewer.client);

    expect(digests(binaries(a1!))).toEqual(digests(fa.chunks));
    expect(digests(binaries(b1!))).toEqual(digests(fb.chunks));
    expect(a1!.raw).toEqual(expect.arrayContaining([fa.begin, fa.end]));
    expect(a1!.raw).not.toContain(fb.begin);
    expect(a1!.raw).not.toContain(fb.end);
    expect(b1!.raw).toEqual(expect.arrayContaining([fb.begin, fb.end]));
    expect(b1!.raw).not.toContain(fa.begin);
    expect(b1!.raw).not.toContain(fa.end);
    const readies = (viewer: TestViewer) =>
      viewer.client.received.filter((m) => m.type === "scene.snapshot.ready").map((m) => m.sha256);
    expect(readies(a2!)).toEqual([sha256(bytes)]);
    expect(readies(b2!)).toEqual([sha256(other)]);
    expect(readies(a1!)).toEqual([]);
    expect(readies(b1!)).toEqual([]);

    // An abort in one session (the publisher's own, then a relay SUPERSEDED) reaches only its viewers.
    const own = JSON.stringify({
      protocolVersion: "1.0",
      type: "scene.snapshot.abort",
      sceneVersion: 2,
      reason: "SUPERSEDED",
      note: "session A",
    });
    send(a.client, snapshotFrames(2), 0, 2);
    a.client.sendRaw(own);
    send(b.client, snapshotFrames(2, other), 0, 2);
    b.client.sendRaw(snapshotFrames(3, other).begin);
    await flush(a.client);
    await flush(b.client);
    for (const viewer of [a1!, a2!, b1!, b2!]) await flush(viewer.client);
    const aborts = (viewer: TestViewer) =>
      viewer.client.received
        .filter((m) => m.type === "scene.snapshot.abort")
        .map((m) => `${m.sceneVersion}:${m.reason}:${m.note ?? "relay"}`);
    expect(aborts(a1!)).toEqual(["2:SUPERSEDED:session A"]);
    expect(aborts(b1!)).toEqual(["2:SUPERSEDED:relay"]);
    expect(aborts(a2!)).toEqual([]);
    expect(aborts(b2!)).toEqual([]);
  });

  it("the budget evicts the largest buffer of any session; the other session's stream goes on", async () => {
    const a = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(BUDGET) });
    const b = await publisher();
    const streamed = [await join(a.session), await join(a.session)];
    const deferred = await join(a.session);
    const largest = await join(b.session);
    await flush(a.client);
    await flush(b.client);
    for (const viewer of streamed) mockBuffered(viewer.peer, 3 * MIB);
    mockBuffered(deferred.peer, 7 * MIB - CHUNK - 1);
    mockBuffered(largest.peer, 7 * MIB);
    const frames = snapshotFrames(1);
    send(a.client, frames);
    expect(await largest.client.closed).toBe(4010);
    expect(largest.client.received.at(-1)).toMatchObject({ code: "SLOW_CONSUMER" });
    expect(binaries(largest)).toHaveLength(0);
    expect(types(largest)).not.toContain("scene.snapshot.ready");
    expect(await acks(a.client)).toEqual(ack(2, 1));
    expect(deferred.peer.isOpen).toBe(true);
    for (const viewer of streamed) {
      await flush(viewer.client);
      expect(binaries(viewer)).toHaveLength(frames.chunks.length);
    }
  });
});

describe("a session released mid-stream (NFR-10)", () => {
  it("leaves nothing of itself in the fan-out", async () => {
    const config = loadConfig({});
    const clock = new ManualClock();
    const registry = new Registry({ ...config, clock });
    const fan = fanout({ registry, config, logger: createLogger({ level: "silent" }), clock });
    const peer = {
      send: () => {},
      forward: () => {},
      bufferedAmount: 0,
      close: () => {},
    };
    // Its own scope, so nothing in the test keeps the session alive.
    const stream = (release: boolean): WeakRef<Session> => {
      const { session } = registry.createSession("mobile");
      registry.addViewer(session, peer, "web");
      fan.events.begun?.(session, 1, "{}");
      fan.events.chunk?.(session, Buffer.alloc(16));
      if (release) registry.closeSession(session);
      return new WeakRef(session);
    };
    const released = stream(true);
    const live = stream(false);
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    expect(released.deref() === undefined).toBe(true);
    expect(live.deref() === undefined).toBe(false);
    fan.dispose();
  });
});

describe("the budget before a chunk: streamed victims (architecture §4)", () => {
  it("a streamed viewer holding the most is closed before the chunk is sent; the others get it", async () => {
    const budget = 8 * MIB;
    const { client, session, peer } = await publisher({
      MAX_TOTAL_BUFFERED_BYTES: String(budget),
    });
    const largest = await join(session);
    const others = [await join(session), await join(session)];
    await flush(client);
    // All below the soft watermark at begin, so all streamed.
    mockBuffered(largest.peer, 4 * MIB - 1);
    for (const viewer of others) mockBuffered(viewer.peer, 4 * MIB - 80 * KIB);
    const frames = snapshotFrames(1);
    send(client, frames, 0, 1, false);
    expect(await largest.client.closed).toBe(4010);
    expect(largest.client.received.at(-1)).toMatchObject({ code: "SLOW_CONSUMER" });
    expect(binaries(largest)).toHaveLength(0);
    expect(others.every((viewer) => viewer.peer.isOpen)).toBe(true);

    // Its bytes counted until its socket was gone: the publisher resumes at the next watch.
    for (const viewer of others) mockBuffered(viewer.peer, 0);
    await expect.poll(() => session.connectedViewers).toBe(2);
    const resume = vi.spyOn(peer, "resumeReading");
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(resume).toHaveBeenCalled();
    send(client, frames, 1);
    expect(await acks(client)).toEqual(ack(2, 0));
    for (const viewer of others) {
      await flush(viewer.client);
      expect(binaries(viewer)).toHaveLength(frames.chunks.length);
    }
  });

  it("streamed viewers that hold nothing are deferred, not closed, when the chunks do not fit", async () => {
    const budget = 8 * MIB;
    const { client, session } = await publisher({ MAX_TOTAL_BUFFERED_BYTES: String(budget) });
    const viewers: TestViewer[] = [];
    for (let i = 0; i < 10; i++) viewers.push(await join(session));
    await flush(client);
    for (const viewer of viewers) mockBuffered(viewer.peer, 0);
    // A few bytes in another session: closing it would free next to nothing.
    const other = await publisher();
    const bystander = await join(other.session);
    mockBuffered(bystander.peer, 200);
    // 10 × (1 MiB + 12 B) per chunk; 7 of them fit in 8 MiB.
    const frames = snapshotFrames(1, bytes, MIB);
    send(client, frames);
    expect(await acks(client)).toEqual(ack(7, 3));
    expect(viewers.every((viewer) => viewer.peer.isOpen)).toBe(true);
    for (const viewer of viewers) await flush(viewer.client);
    const counts = viewers.map((viewer) => binaries(viewer).length).sort();
    expect(counts).toEqual([0, 0, 0, ...Array<number>(7).fill(frames.chunks.length)]);
    expect(bystander.peer.isOpen).toBe(true);
  });
});

describe("the watch (every second)", () => {
  it("a failure is logged without its text and the watch goes on", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { client, session } = await publisher({}, logger);
    const broken = await join(session);
    const slow = await join(session);
    await flush(client);
    let fail = true;
    Object.defineProperty(broken.peer, "bufferedAmount", {
      configurable: true,
      get: () => {
        if (fail) throw new Error("secret detail 7KQ4X");
        return 0;
      },
    });
    mockBuffered(slow.peer, 9 * MIB);
    relay!.clock.advance(WATCH_INTERVAL_MS);
    const failure = lines.find((l) => l.includes("fan-out watch failed"));
    expect(JSON.parse(failure!)).toMatchObject({ level: "error", errorCode: "INTERNAL" });
    expect(lines.join("")).not.toContain("secret detail");
    fail = false;
    relay!.clock.advance(WATCH_INTERVAL_MS);
    expect(await slow.client.closed).toBe(4010);
  });
});

/** The fan-out over fake sockets whose `bufferedAmount` a test sets. */
function setup() {
  const config = loadConfig({ MAX_TOTAL_BUFFERED_BYTES: String(8 * MIB) });
  const clock = new ManualClock();
  const registry = new Registry({ ...config, clock });
  const fan = fanout({ registry, config, logger: createLogger({ level: "silent" }), clock });
  const fake = (amount = 0) => ({
    amount,
    out: [] as unknown[],
    closes: [] as number[],
    pauses: 0,
    resumes: 0,
    get bufferedAmount() {
      return this.amount;
    },
    send(message: unknown) {
      this.out.push(message);
    },
    forward(frame: unknown, asText?: boolean) {
      // An update arrives as the UTF-8 bytes of a text frame: recorded as its text.
      this.out.push(asText === true ? { text: String(frame) } : frame);
    },
    close(code: number) {
      this.closes.push(code);
    },
    pauseReading() {
      this.pauses += 1;
    },
    resumeReading() {
      this.resumes += 1;
    },
    terminate() {},
  });
  const session = registry.createSession("mobile").session;
  const publisher = fake();
  session.publisher = publisher;
  return { registry, fan, fake, session, publisher, clock };
}

describe("pausing and dispose with fake sockets", () => {
  const snapshot = {
    buffer: Buffer.alloc(0),
    sha256: "0".repeat(64),
    byteLength: 0,
    sceneVersion: 1,
    extensionsRequired: [],
  };

  /** A streamed viewer holding 1 MiB, a closed 7 MiB one: Σ at the budget, publisher paused. */
  function paused() {
    const setupResult = setup();
    const { registry, fan, fake, session, publisher } = setupResult;
    const holder = fake();
    const big = fake();
    registry.addViewer(session, holder, "web");
    registry.addViewer(session, big, "web");
    fan.events.begun?.(session, 1, "{}");
    holder.amount = MIB;
    big.amount = 7 * MIB;
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(big.closes).toEqual([4010]);
    expect([publisher.pauses, publisher.resumes]).toEqual([1, 0]);
    return { ...setupResult, holder, big };
  }

  it("a publisher paused for its stream is resumed when the stream completes", () => {
    const { fan, session, publisher } = paused();
    fan.events.completed?.(session, snapshot, "{}");
    expect(publisher.resumes).toBe(1);
  });

  it("…or is aborted", () => {
    const { fan, session, publisher } = paused();
    fan.events.aborted?.(session, 1, "TIMEOUT");
    expect(publisher.resumes).toBe(1);
  });

  it("…or its session is released (which drops the session's publisher first)", () => {
    const { registry, session, publisher } = paused();
    session.publisher = undefined;
    registry.closeSession(session);
    expect(publisher.resumes).toBe(1);
  });

  it("a publisher resumed early (its viewers drained) is read for a watch interval too", () => {
    const { fan, session, publisher, clock, holder, big } = paused();
    fan.start();
    big.amount = 8 * MIB; // closed, still counted: Σ stays at the budget
    holder.amount = 0;
    clock.advance(WATCH_INTERVAL_MS);
    expect([publisher.pauses, publisher.resumes]).toEqual([1, 1]);
    holder.amount = MIB;
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(1);
    clock.advance(WATCH_INTERVAL_MS);
    expect(publisher.pauses).toBe(2);
    fan.dispose();
  });

  it("a stream is paused once its viewers hold one chunk, not one byte less", () => {
    const { registry, fan, fake, session, publisher, clock } = setup();
    const holder = fake();
    const big = fake(5 * MIB); // deferred at begin
    registry.addViewer(session, holder, "web");
    registry.addViewer(session, big, "web");
    fan.events.begun?.(session, 1, "{}");
    fan.start();
    big.amount = 9 * MIB; // closed by the watch, still counted
    clock.advance(WATCH_INTERVAL_MS);
    expect(big.closes).toEqual([4010]);
    holder.amount = 1023;
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(0);
    holder.amount = 1024;
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(1);
    fan.dispose();
  });

  it("for the budget, a socket holding exactly the chunk is closed, not deferred", () => {
    const { registry, fan, fake, session } = setup();
    const exact = fake();
    const idle = fake();
    registry.addViewer(session, exact, "web");
    registry.addViewer(session, idle, "web");
    fan.events.begun?.(session, 1, "{}");
    exact.amount = 3 * MIB;
    // 3 MiB held + 2 × 3 MiB projected > 8 MiB: closing `exact` frees its bytes and its chunk.
    fan.events.chunk?.(session, Buffer.alloc(3 * MIB));
    expect(exact.closes).toEqual([4010]);
    expect(idle.closes).toEqual([]);
    expect(idle.out).toHaveLength(2); // begin and the chunk
  });

  it("after the longest pause the publisher is read for a watch interval before the next one", () => {
    const { fan, session, publisher, clock } = paused();
    clock.advance(MAX_PAUSE_MS);
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect([publisher.pauses, publisher.resumes]).toEqual([1, 1]);
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(1);
    clock.advance(WATCH_INTERVAL_MS);
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(2);
  });

  it("a stream that feeds no viewer is not paused", () => {
    const { registry, fan, fake, session, publisher } = setup();
    const other = registry.createSession("mobile").session;
    registry.addViewer(other, fake(8 * MIB), "web");
    registry.addViewer(session, fake(5 * MIB), "web"); // deferred at begin
    fan.events.begun?.(session, 1, "{}");
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(publisher.pauses).toBe(0);
  });

  it("after dispose the events forward nothing and close nobody", () => {
    const { registry, fan, fake, session } = setup();
    const streamed = fake();
    registry.addViewer(session, streamed, "web");
    fan.events.begun?.(session, 1, "{}"); // a stream in flight at shutdown
    fan.dispose();
    streamed.amount = 9 * MIB;
    fan.events.chunk?.(session, Buffer.alloc(1024));
    expect(streamed.out).toEqual(["{}"]);
    expect(streamed.closes).toEqual([]);
    const other = registry.createSession("mobile").session;
    const late = fake();
    registry.addViewer(other, late, "web");
    fan.events.begun?.(other, 1, "{}");
    fan.events.chunk?.(other, Buffer.alloc(1024));
    expect(late.out).toEqual([]);
  });
});

describe("updates with fake sockets (`broadcast`, §3.3, architecture §4)", () => {
  it("a frame that would take a viewer above 8 MiB closes it instead; up to exactly 8 MiB it is sent", () => {
    const { registry, fan, fake, session } = setup();
    const text = "x".repeat(1024); // with its 4-byte WebSocket header: 1,028 bytes
    const exact = fake(8 * MIB - 1028);
    const over = fake(8 * MIB - 1027);
    registry.addViewer(session, exact, "web");
    registry.addViewer(session, over, "web");
    fan.broadcast(session, text);
    expect([exact.out, exact.closes]).toEqual([[{ text }], []]);
    expect(over.closes).toEqual([4010]);
    expect(over.out).toEqual([expect.objectContaining({ type: "error", code: "SLOW_CONSUMER" })]);
    fan.broadcast(session, text); // closed here: skipped from now on
    expect(over.out).toHaveLength(1);
  });

  it("it is measured in UTF-8 bytes, not string length: 3-byte characters count three times", () => {
    const { registry, fan, fake, session } = setup();
    const text = "€".repeat(1024); // 1,024 UTF-16 units, 3,072 bytes + a 4-byte header
    const fits = fake(8 * MIB - 3076);
    const over = fake(8 * MIB - 3075);
    registry.addViewer(session, fits, "web");
    registry.addViewer(session, over, "web");
    fan.broadcast(session, text);
    expect(fits.out).toEqual([{ text }]);
    expect(over.closes).toEqual([4010]);
  });

  it("for the budget, buffers of any size are closed, largest first, until the sum with the frame fits", () => {
    const { registry, fan, fake, session } = setup(); // budget 8 MiB
    const other = registry.createSession("mobile").session;
    // Twelve viewers elsewhere at about 0.5 MiB, each less than the frame: closing the two largest
    // makes room.
    const elsewhere = Array.from({ length: 12 }, (_, i) => fake(MIB / 2 - i));
    for (const peer of elsewhere) registry.addViewer(other, peer, "web");
    const recipients = [fake(), fake(), fake()];
    for (const peer of recipients) registry.addViewer(session, peer, "web");
    fan.broadcast(session, "x".repeat(MIB)); // 6 MiB held + 3 × 1 MiB > 8 MiB
    expect(elsewhere.filter((peer) => peer.closes.length > 0)).toEqual([
      elsewhere[0],
      elsewhere[1],
    ]);
    for (const peer of recipients) expect(peer.out).toEqual([{ text: "x".repeat(MIB) }]);
    const held = elsewhere.filter((peer) => peer.closes.length === 0);
    const sent = 3 * (MIB + 10); // the frame and its header, to each recipient
    expect(held.reduce((sum, peer) => sum + peer.amount, 0) + sent).toBeLessThanOrEqual(8 * MIB);
    for (const peer of held) expect(peer.out).toEqual([]); // another session's viewers get nothing
  });

  it("when nothing else holds bytes, a recipient is closed instead of sent the frame", () => {
    const { registry, fan, fake, session } = setup(); // budget 8 MiB
    const recipients = [fake(), fake(), fake()];
    for (const peer of recipients) registry.addViewer(session, peer, "web");
    fan.broadcast(session, "x".repeat(3 * MIB)); // 3 × 3 MiB > 8 MiB
    const [closed, ...sent] = recipients;
    expect(closed!.closes).toEqual([4010]);
    expect(closed!.out).toEqual([
      expect.objectContaining({ type: "error", code: "SLOW_CONSUMER" }),
    ]);
    for (const peer of sent)
      expect([peer.out, peer.closes]).toEqual([[{ text: "x".repeat(3 * MIB) }], []]);
  });

  it("a snapshot chunk still defers small viewers instead of closing them", () => {
    const { registry, fan, fake, session } = setup(); // budget 8 MiB
    const other = registry.createSession("mobile").session;
    const elsewhere = Array.from({ length: 12 }, () => fake(MIB / 2));
    for (const peer of elsewhere) registry.addViewer(other, peer, "web");
    const streamed = fake();
    registry.addViewer(session, streamed, "web");
    fan.events.begun?.(session, 1, "{}");
    fan.events.chunk?.(session, Buffer.alloc(3 * MIB)); // 6 MiB held + 3 MiB > 8 MiB
    expect(elsewhere.every((peer) => peer.closes.length === 0)).toBe(true);
    expect(streamed.out).toEqual(["{}"]); // deferred: no chunk
  });

  it("after dispose nothing is sent", () => {
    const { registry, fan, fake, session } = setup();
    const here = fake();
    registry.addViewer(session, here, "web");
    fan.dispose();
    fan.broadcast(session, "{}");
    expect(here.out).toEqual([]);
  });
});
