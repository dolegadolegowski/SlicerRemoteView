import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection, Outgoing } from "../src/ws/connection.js";
import { HARD_WATERMARK_BYTES } from "../src/ws/fanout.js";
import { readFrame } from "../src/ws/frame.js";
import { SCENE_REQUEST_INTERVAL_MS, viewerHandlers } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = readFileSync(
  new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url),
);
const SHA256 = createHash("sha256").update(GLB).digest("hex");
const MODEL = "vtkMRMLModelNode2";
const SEGMENT = "vtkMRMLSegmentationNode1/Segment_1";

let relay: TestRelay | undefined;
let lines: string[] = [];
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
  lines = [];
});

async function nextValid(client: TestClient): Promise<Received> {
  const message = await client.next();
  expect(validateMessage(message)).toMatchObject({ ok: true });
  return message;
}

/** Round trip: everything sent before was handled; returns what arrived meanwhile (schema-checked). */
async function flush(client: TestClient): Promise<Received[]> {
  const id = `f-${Math.random().toString(36).slice(2, 10)}`;
  client.send({ type: "ping", id });
  const seen: Received[] = [];
  for (;;) {
    const message = await nextValid(client);
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

async function publisher(maxBuffered?: number): Promise<{ client: TestClient; session: Session }> {
  relay ??= await startRelay({
    logger: createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } }),
    ...(maxBuffered !== undefined && {
      config: loadConfig({
        TRUST_PROXY: "false",
        ALLOWED_ORIGINS: "https://relay.example.org",
        MAX_TOTAL_BUFFERED_BYTES: String(maxBuffered),
      }),
    }),
  });
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await nextValid(client);
  return { client, session: relay.registry.get(created.sessionId as string)! };
}

/** Joins; the first three messages must be viewer.joined, scene.state, viewer.count (§5.2, §8.3). */
async function join(
  session: Session,
): Promise<{ client: TestClient; first: Received[]; peer: Connection }> {
  const client = await connectClient(relay!.url);
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
  const first = [await nextValid(client), await nextValid(client), await nextValid(client)];
  expect(types(first)).toEqual(["viewer.joined", "scene.state", "viewer.count"]);
  const peer = session.viewers.get(first[0]!.viewerId as string)!.peer as Connection;
  return { client, first, peer };
}

function sendSnapshot(client: TestClient, sceneVersion: number, end = true): void {
  client.send({
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: GLB.byteLength,
    sha256: SHA256,
    chunkCount: 1,
    chunkSize: 64 * 1024,
    format: "glb",
    extensionsUsed: [],
    nodeCount: 2,
  });
  for (const { chunkIndex, payload } of chunkify(GLB, 64 * 1024))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
  if (end) client.send({ type: "scene.snapshot.end", sceneVersion, sha256: SHA256 });
}

async function snapshot(client: TestClient, sceneVersion: number): Promise<void> {
  sendSnapshot(client, sceneVersion);
  expect(types(await flush(client))).toContain("scene.snapshot.ack");
}

async function update(client: TestClient, base: number, change: Record<string, unknown>) {
  client.send({
    type: "scene.update",
    baseVersion: base,
    sceneVersion: base + 1,
    changes: [change],
  });
  expect(errors(await flush(client))).toEqual([]);
}

function request(client: TestClient, id: string, haveSnapshotVersion: number | null): void {
  client.send({
    type: "scene.request",
    id,
    haveSnapshotVersion,
    haveSceneVersion: 0,
    reason: "GAP",
  });
}

const types = (seen: Received[]): string[] => seen.map((m) => m.type);
const errors = (seen: Received[]): Received[] => seen.filter((m) => m.type === "error");

describe("scene.state right after viewer.joined (SRV-13 criterion 1, §5.2, §8.3, §13 steps 3, 6, 9)", () => {
  it("no snapshot yet: empty, snapshotVersion null", async () => {
    const pub = await publisher();
    const { first } = await join(pub.session);
    expect(first[1]).toEqual(
      expect.objectContaining({ sceneVersion: 0, snapshotVersion: null, nodes: [], removed: [] }),
    );
  });

  it("right after a snapshot: empty at its version (the updates before it are gone)", async () => {
    const pub = await publisher();
    await snapshot(pub.client, 1);
    await update(pub.client, 1, { nodeId: MODEL, visible: false });
    await snapshot(pub.client, 3);
    const { first } = await join(pub.session);
    expect(first[0]).toMatchObject({ sceneVersion: 3, snapshotVersion: 3 });
    expect(first[1]).toMatchObject({ sceneVersion: 3, snapshotVersion: 3, nodes: [], removed: [] });
  });

  it("after two updates: both nodes, sceneVersion = the last update (FR-23, FR-42)", async () => {
    const pub = await publisher();
    await snapshot(pub.client, 1);
    await update(pub.client, 1, { nodeId: MODEL, visible: false });
    await update(pub.client, 2, { nodeId: SEGMENT, opacity: 0.25 });
    const { first } = await join(pub.session);
    expect(first[1]).toMatchObject({ sceneVersion: 3, snapshotVersion: 1, removed: [] });
    expect(first[1]!.nodes).toEqual(
      expect.arrayContaining([
        { nodeId: MODEL, visible: false },
        { nodeId: SEGMENT, opacity: 0.25 },
      ]),
    );
    expect(first[1]!.nodes).toHaveLength(2);
  });

  it("held to the budget like broadcast: the largest buffer is closed 4010 before the joiner's state", async () => {
    const pub = await publisher(HARD_WATERMARK_BYTES); // the smallest MAX_TOTAL_BUFFERED_BYTES
    const holder = await join(pub.session);
    Object.defineProperty(holder.peer, "bufferedAmount", { get: () => HARD_WATERMARK_BYTES - 64 });
    await join(pub.session); // below the budget, so no CAPACITY; its scene.state would pass it
    expect(holder.peer.isOpen).toBe(false);
    expect(await holder.client.closed).toBe(4010);
    expect(holder.client.received.at(-1)).toMatchObject({ type: "error", code: "SLOW_CONSUMER" });
  });
});

describe("scene.request (SRV-13 criteria 2–3, §8.3)", () => {
  it("criterion 2: haveSnapshotVersion 1 while the cache holds 4 → ready{4} then scene.state", async () => {
    const pub = await publisher();
    await snapshot(pub.client, 1);
    const v = await join(pub.session);
    await snapshot(pub.client, 4);
    await update(pub.client, 4, { nodeId: MODEL, visible: false });
    await update(pub.client, 5, { nodeId: SEGMENT, opacity: 0.25 });
    await flush(v.client); // the streamed snapshot 4 and the updates
    request(v.client, "r-1", 1);
    const seen = await flush(v.client);
    expect(types(seen)).toEqual(["scene.snapshot.ready", "scene.state"]);
    expect(seen[0]).toMatchObject({
      replyTo: "r-1",
      sceneVersion: 4,
      byteLength: GLB.byteLength,
      sha256: SHA256,
      format: "glb",
      extensionsRequired: [],
    });
    expect(seen[1]).toMatchObject({ replyTo: "r-1", sceneVersion: 6, snapshotVersion: 4 });
    expect(seen[1]!.nodes).toHaveLength(2);
  });

  it("ready only if haveSnapshotVersion differs: equal → state only; newer or null → both; no cache → state", async () => {
    const pub = await publisher();
    const v = await join(pub.session);
    request(v.client, "none", 43);
    expect(await flush(v.client)).toEqual([
      expect.objectContaining({ type: "scene.state", replyTo: "none", snapshotVersion: null }),
    ]);
    await snapshot(pub.client, 1);
    await flush(v.client); // the streamed snapshot
    relay!.clock.advance(SCENE_REQUEST_INTERVAL_MS);
    request(v.client, "same", 1);
    expect(types(await flush(v.client))).toEqual(["scene.state"]);
    relay!.clock.advance(SCENE_REQUEST_INTERVAL_MS);
    request(v.client, "newer", 2); // "differs" (§8.3): newer than the cache too
    expect(await flush(v.client)).toEqual([
      expect.objectContaining({ type: "scene.snapshot.ready", replyTo: "newer", sceneVersion: 1 }),
      expect.objectContaining({ type: "scene.state", replyTo: "newer" }),
    ]);
    relay!.clock.advance(SCENE_REQUEST_INTERVAL_MS);
    // Without an id (as the web viewer sends it): the replies carry no replyTo.
    v.client.send({
      type: "scene.request",
      haveSnapshotVersion: null,
      haveSceneVersion: 0,
      reason: "USER",
    });
    const seen = await flush(v.client);
    expect(types(seen)).toEqual(["scene.snapshot.ready", "scene.state"]);
    for (const m of seen) expect(m).not.toHaveProperty("replyTo");
  });

  it("criterion 3: within 5 s nothing — no reply, no error, no strike, no log line; then answered", async () => {
    const pub = await publisher();
    await snapshot(pub.client, 1);
    const v = await join(pub.session);
    const other = await join(pub.session);
    await flush(v.client);
    request(v.client, "r-1", 1);
    expect(types(await flush(v.client))).toEqual(["scene.state"]);
    for (const [i, step] of [1_000, SCENE_REQUEST_INTERVAL_MS - 1_001].entries()) {
      relay!.clock.advance(step);
      request(v.client, `x-${i}`, 1);
      request(v.client, `y-${i}`, null);
      expect(await flush(v.client)).toEqual([]);
    }
    request(other.client, "o-1", 1); // per viewer: another one is answered meanwhile
    expect(types(await flush(other.client))).toEqual(["scene.state"]);
    relay!.clock.advance(1); // 5 s after the last answer: ignored requests did not extend the window
    request(v.client, "r-2", 1);
    expect(await flush(v.client)).toEqual([expect.objectContaining({ replyTo: "r-2" })]);
    expect([v.peer.violations, v.peer.offences, v.peer.isOpen]).toEqual([0, 0, true]);
    expect(lines.filter((l) => l.includes("scene.request"))).toHaveLength(3);
  });

  it("a wall clock that steps back does not hold answers off", async () => {
    const pub = await publisher();
    const v = await join(pub.session);
    request(v.client, "r-1", null);
    expect(await flush(v.client)).toHaveLength(1);
    relay!.clock.advance(-60_000);
    request(v.client, "r-2", null);
    expect(await flush(v.client)).toHaveLength(1);
  });

  it("an invalid one is INVALID_MESSAGE and uses no window; a publisher's is UNAUTHORIZED (§11)", async () => {
    const pub = await publisher();
    const v = await join(pub.session);
    v.client.send({ type: "scene.request", id: "bad", haveSnapshotVersion: 1, reason: "GAP" });
    expect(await flush(v.client)).toEqual([
      expect.objectContaining({ type: "error", code: "INVALID_MESSAGE", replyTo: "bad" }),
    ]);
    request(v.client, "r-1", null);
    expect(types(await flush(v.client))).toEqual(["scene.state"]);
    request(pub.client, "p-1", null);
    expect(errors(await flush(pub.client))).toEqual([
      expect.objectContaining({ code: "UNAUTHORIZED", replyTo: "p-1" }),
    ]);
  });

  it("answers from the viewer's own session only (T11)", async () => {
    const a = await publisher();
    const b = await publisher();
    await snapshot(a.client, 1);
    await snapshot(b.client, 7);
    await update(b.client, 7, { nodeId: MODEL, visible: false });
    const v = await join(a.session);
    request(v.client, "r-1", null);
    const seen = await flush(v.client);
    expect(seen.map((m) => [m.type, m.sceneVersion])).toEqual([
      ["scene.snapshot.ready", 1],
      ["scene.state", 1],
    ]);
    expect(JSON.stringify(seen)).not.toContain(MODEL);
  });

  it("while a snapshot is in flight the cached one answers; the stream still ends with end", async () => {
    const pub = await publisher();
    await snapshot(pub.client, 1);
    const v = await join(pub.session);
    sendSnapshot(pub.client, 2, false);
    await flush(pub.client);
    request(v.client, "r-1", null);
    const seen = (await flush(v.client)).filter((m) => m.type !== "scene.snapshot.begin");
    expect(seen.map((m) => [m.type, m.sceneVersion])).toEqual([
      ["scene.snapshot.ready", 1],
      ["scene.state", 1],
    ]);
    pub.client.send({ type: "scene.snapshot.end", sceneVersion: 2, sha256: SHA256 });
    await flush(pub.client);
    expect(types(await flush(v.client))).toEqual(["scene.snapshot.end"]);
  });

  it("a reply that would take the viewer above 8 MiB closes it 4010 instead (T3)", async () => {
    const pub = await publisher();
    const v = await join(pub.session);
    Object.defineProperty(v.peer, "bufferedAmount", { get: () => HARD_WATERMARK_BYTES - 16 });
    request(v.client, "r-1", null);
    expect(await v.client.closed).toBe(4010);
    expect(v.client.received.slice(3).map((m) => [m.type, m.code])).toEqual([
      ["error", "SLOW_CONSUMER"],
    ]);
  });
});

describe("scene.state after scene.snapshot.ready (§8.3 b)", () => {
  it("a viewer that joined mid-stream gets ready, then the empty state; a streamed one only end", async () => {
    const pub = await publisher();
    const streamed = await join(pub.session);
    sendSnapshot(pub.client, 1, false);
    await flush(pub.client);
    const late = await join(pub.session);
    pub.client.send({ type: "scene.snapshot.end", sceneVersion: 1, sha256: SHA256 });
    await flush(pub.client);
    const seen = await flush(late.client);
    expect(types(seen)).toEqual(["scene.snapshot.ready", "scene.state"]);
    expect(seen[1]).toEqual(
      expect.objectContaining({ sceneVersion: 1, snapshotVersion: 1, nodes: [], removed: [] }),
    );
    expect(seen[1]).not.toHaveProperty("replyTo");
    expect(types(await flush(streamed.client)).filter((t) => t !== "viewer.count")).toEqual([
      "scene.snapshot.begin",
      "scene.snapshot.end",
    ]);
  });
});

describe("scene.request (unit)", () => {
  it("only the entry's current socket is answered; the window belongs to the entry (SRV-15 rejoin)", () => {
    const clock = new ManualClock();
    const logger = createLogger({ level: "silent" });
    const registry = new Registry({ ...loadConfig({}), clock });
    const { session } = registry.createSession("mobile");
    const replies: unknown[] = [];
    const { handlers } = viewerHandlers({
      registry,
      limiter: new RateLimiter({ clock, logger }),
      logger,
      clock,
      deliver: (_session, _viewer, messages: readonly Outgoing[]) => {
        replies.push(...messages.map((m) => m.replyTo));
        return true;
      },
    });
    const [a, b] = [{}, {}] as unknown as Connection[];
    const { viewer } = registry.addViewer(session, a!, "web");
    for (const socket of [a, b]) Object.assign(socket!, { session, viewer });
    const ask = (connection: Connection, id: string): void => {
      const message = { ...fixture("scene.request", "valid-no-snapshot"), id };
      void handlers["scene.request"]!(
        connection,
        message as never,
        readFrame(JSON.stringify(message)),
      );
    };
    ask(a!, "a-1");
    viewer.peer = b; // as a rejoin would (SRV-15)
    clock.advance(1_000);
    ask(a!, "a-2"); // the replaced socket: dropped without using the window
    ask(b!, "b-1"); // inside the entry's window
    clock.advance(SCENE_REQUEST_INTERVAL_MS - 1_000);
    ask(a!, "a-3");
    ask(b!, "b-2");
    expect(replies).toEqual(["a-1", "b-2"]);
  });
});
