import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { LIMITS, chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import type { Session } from "../src/registry.js";
import { CLOSE_COMPLETE_MS } from "../src/ws/connection.js";
import type { Connection } from "../src/ws/connection.js";
import { HARD_WATERMARK_BYTES } from "../src/ws/fanout.js";
import { MAX_STATE_NODES } from "../src/ws/state.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = readFileSync(
  new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url),
);
const CHUNK = 64 * 1024;
const SEGMENT = "vtkMRMLSegmentationNode1/Segment_1";
const MODEL = "vtkMRMLModelNode2";
const MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 1];

let relay: TestRelay | undefined;
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
});

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

async function publisher(): Promise<{ client: TestClient; session: Session }> {
  relay ??= await startRelay();
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  return { client, session: relay.registry.get(created.sessionId as string)! };
}

/** A viewer keeping every text frame as received (to compare bytes). */
async function viewer(
  session: Session,
): Promise<{ client: TestClient; raw: string[]; id: string }> {
  const client = await connectClient(relay!.url);
  const raw: string[] = [];
  client.ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) raw.push(data.toString());
  });
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
  const joined = await client.next();
  expect(joined.type).toBe("viewer.joined");
  return { client, raw, id: joined.viewerId as string };
}

/** Sends a one-chunk snapshot of `sceneVersion`, without waiting. */
function sendSnapshot(client: TestClient, sceneVersion: number, end = true): void {
  const sha256 = createHash("sha256").update(GLB).digest("hex");
  client.send({
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: GLB.byteLength,
    sha256,
    chunkCount: 1,
    chunkSize: CHUNK,
    format: "glb",
    extensionsUsed: [],
    nodeCount: 2,
  });
  for (const { chunkIndex, payload } of chunkify(GLB, CHUNK))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
  if (end) client.send({ type: "scene.snapshot.end", sceneVersion, sha256 });
}

async function snapshot(client: TestClient, sceneVersion: number): Promise<void> {
  sendSnapshot(client, sceneVersion);
  const seen = await flush(client);
  expect(seen.find((m) => m.type === "scene.snapshot.ack")).toMatchObject({ sceneVersion });
}

/** A `scene.update` as the publisher would send it, indented so that re-serialising shows. */
function update(id: string, baseVersion: number, sceneVersion: number, changes: unknown[]): string {
  const message = {
    protocolVersion: "1.0",
    type: "scene.update",
    id,
    sceneVersion,
    baseVersion,
    changes,
  };
  return JSON.stringify(message, null, 1);
}

const errors = (seen: Received[]): Received[] => seen.filter((m) => m.type === "error");

describe("scene.update, scene.nodeRemoved, scene.nodeAdded (SRV-12, §8.1–§8.4)", () => {
  it("criterion 1: a correct update advances sceneVersion and reaches every viewer byte for byte", async () => {
    const { client, session } = await publisher();
    const [a, b] = [await viewer(session), await viewer(session)];
    await snapshot(client, 1);
    await flush(a.client);
    await flush(b.client);
    const text = update("p-2", 1, 2, [{ nodeId: MODEL, visible: false }]);
    client.sendRaw(text);
    expect(errors(await flush(client))).toEqual([]);
    expect(session.sceneVersion).toBe(2);
    for (const v of [a, b]) {
      await flush(v.client);
      expect(v.raw).toContain(text);
    }
  });

  it("one Buffer of the frame's UTF-8 bytes goes to every viewer as a text frame (NFR-05, §11)", async () => {
    const { client, session } = await publisher();
    const [a, b] = [await viewer(session), await viewer(session)];
    await snapshot(client, 1);
    const sends = [...session.viewers.values()].map(({ peer }) =>
      vi.spyOn((peer as Connection).socket, "send"),
    );
    // An unknown key (§2) with characters of three UTF-8 bytes each.
    const text = update("p-2", 1, 2, [{ nodeId: MODEL, visible: false, note: "€".repeat(100) }]);
    client.sendRaw(text);
    expect(errors(await flush(client))).toEqual([]);
    const [first, second] = sends.map((spy) => spy.mock.calls.at(-1)!);
    expect(first![0]).toBeInstanceOf(Buffer);
    expect(first![0]).toBe(second![0]); // the same Buffer, not a copy per socket
    expect((first![0] as Buffer).equals(Buffer.from(text))).toBe(true);
    expect(first![1]).toMatchObject({ binary: false });
    for (const v of [a, b]) {
      await flush(v.client);
      expect(v.raw).toContain(text);
    }
  });

  it("criterion 1: a wrong baseVersion → BAD_SEQUENCE{baseVersion}, nothing forwarded or merged", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    await snapshot(client, 1);
    await flush(watcher.client);
    const before = watcher.raw.length;
    client.sendRaw(update("p-2", 3, 4, [{ nodeId: MODEL, visible: false }]));
    expect(errors(await flush(client))).toEqual([
      expect.objectContaining({
        code: "BAD_SEQUENCE",
        replyTo: "p-2",
        retryable: true,
        details: { field: "baseVersion" },
      }),
    ]);
    await flush(watcher.client);
    expect(watcher.raw.slice(before).filter((t) => t.includes("scene.update"))).toEqual([]);
    expect([session.sceneVersion, session.nodeState.size]).toEqual([1, 0]);
    // A stale one, below the current version, too.
    client.sendRaw(update("p-3", 1, 2, [{ nodeId: MODEL, visible: false }]));
    client.sendRaw(update("p-4", 2, 3, [{ nodeId: MODEL, visible: true }]));
    client.sendRaw(update("stale", 1, 4, [{ nodeId: MODEL, opacity: 0.1 }]));
    expect(
      errors(await flush(client)).map((e) => [e.replyTo, (e.details as { field: string }).field]),
    ).toEqual([["stale", "baseVersion"]]);
    expect([session.sceneVersion, session.nodeState.get(MODEL)]).toEqual([3, { visible: true }]);
  });

  it("before the first snapshot → BAD_SEQUENCE{noSnapshot} for all three, nothing forwarded (§8.4)", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    client.sendRaw(update("early", 0, 1, [{ nodeId: MODEL, visible: false }]));
    client.send({
      type: "scene.nodeRemoved",
      id: "removed",
      baseVersion: 0,
      sceneVersion: 1,
      nodeIds: [MODEL],
    });
    client.send({
      type: "scene.nodeAdded",
      id: "added",
      baseVersion: 0,
      sceneVersion: 1,
      nodes: [{ nodeId: MODEL, kind: "model" }],
      snapshotFollows: true,
    });
    sendSnapshot(client, 1, false); // the first one in flight: queue and resend after end
    client.sendRaw(update("queued", 0, 2, [{ nodeId: MODEL, visible: false }]));
    expect(
      errors(await flush(client)).map((e) => [e.replyTo, (e.details as { field: string }).field]),
    ).toEqual([
      ["early", "noSnapshot"],
      ["removed", "noSnapshot"],
      ["added", "noSnapshot"],
      ["queued", "snapshotInFlight"],
    ]);
    await flush(watcher.client);
    expect(watcher.raw.filter((t) => /scene\.(update|node)/.test(t))).toEqual([]);
    expect([session.sceneVersion, session.nodeState.size]).toEqual([0, 0]);
  });

  it("criterion 1: in flight → BAD_SEQUENCE{snapshotInFlight} and ignored; the same after end is accepted", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    await snapshot(client, 1);
    sendSnapshot(client, 2, false); // begin and the chunk, no end yet
    for (const type of ["scene.update", "scene.nodeRemoved", "scene.nodeAdded"]) {
      const body =
        type === "scene.update"
          ? { changes: [{ nodeId: MODEL, opacity: 0.5 }] }
          : type === "scene.nodeRemoved"
            ? { nodeIds: [MODEL] }
            : { nodes: [{ nodeId: "vtkMRMLModelNode3", kind: "model" }], snapshotFollows: true };
      client.send({ type, id: type, baseVersion: 1, sceneVersion: 3, ...body });
    }
    const refused = errors(await flush(client));
    expect(refused.map((e) => [e.code, e.replyTo, (e.details as { field: string }).field])).toEqual(
      [
        ["BAD_SEQUENCE", "scene.update", "snapshotInFlight"],
        ["BAD_SEQUENCE", "scene.nodeRemoved", "snapshotInFlight"],
        ["BAD_SEQUENCE", "scene.nodeAdded", "snapshotInFlight"],
      ],
    );
    expect([session.sceneVersion, session.nodeState.size]).toEqual([1, 0]);
    client.send({
      type: "scene.snapshot.end",
      sceneVersion: 2,
      sha256: createHash("sha256").update(GLB).digest("hex"),
    });
    const text = update("again", 2, 3, [{ nodeId: MODEL, opacity: 0.5 }]);
    client.sendRaw(text);
    const seen = await flush(client);
    expect(errors(seen)).toEqual([]);
    expect(session.sceneVersion).toBe(3);
    await flush(watcher.client);
    expect(watcher.raw).toContain(text);
  });

  it("a version a refused begin announced is used: an update must go above it (§8.4)", async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    // A begin of version 5 that is refused (byteLength above the protocol maximum).
    client.send({
      ...fixture("scene.snapshot.begin"),
      sceneVersion: 5,
      byteLength: 2 ** 31,
      chunkSize: 1048576,
      chunkCount: 1024,
    });
    await flush(client);
    expect(session.lastSnapshotVersion).toBe(5);
    client.sendRaw(update("p-5", 1, 5, [{ nodeId: MODEL, visible: true }]));
    expect(errors(await flush(client))).toEqual([
      expect.objectContaining({ code: "BAD_SEQUENCE", details: { field: "sceneVersion" } }),
    ]);
    client.sendRaw(update("p-6", 1, 6, [{ nodeId: MODEL, visible: true }]));
    expect(errors(await flush(client))).toEqual([]);
    expect(session.sceneVersion).toBe(6);
  });

  it("sceneVersion not above baseVersion → BAD_SEQUENCE{sceneVersion}; above uint32 → INVALID_MESSAGE", async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    client.sendRaw(update("same", 1, 1, [{ nodeId: MODEL, visible: true }]));
    client.sendRaw(update("huge", 1, 2 ** 32, [{ nodeId: MODEL, visible: true }]));
    expect(errors(await flush(client)).map((e) => [e.replyTo, e.code])).toEqual([
      ["same", "BAD_SEQUENCE"],
      ["huge", "INVALID_MESSAGE"],
    ]);
    expect(session.sceneVersion).toBe(1);
    // After an update too: the base is now above the snapshot's version.
    client.sendRaw(update("u2", 1, 2, [{ nodeId: MODEL, visible: true }]));
    client.sendRaw(update("again", 2, 2, [{ nodeId: MODEL, visible: false }]));
    expect(errors(await flush(client)).map((e) => [e.replyTo, e.code])).toEqual([
      ["again", "BAD_SEQUENCE"],
    ]);
    // The largest uint32 is a version.
    client.sendRaw(update("last", 2, 0xffff_ffff, [{ nodeId: MODEL, visible: false }]));
    expect(errors(await flush(client))).toEqual([]);
    expect(session.sceneVersion).toBe(0xffff_ffff);
  });

  it("a sceneVersion above uint32 is a strike, as for begin: the third closes 4007 (§9.2)", async () => {
    const { client } = await publisher();
    await snapshot(client, 1);
    for (let i = 0; i < 3; i++)
      client.sendRaw(update(`huge-${i}`, 1, 2 ** 32 + i, [{ nodeId: MODEL, visible: true }]));
    expect(await client.closed).toBe(4007);
  });

  it(`more than ${LIMITS.MAX_CHANGES} changes in one update → INVALID_MESSAGE (§3.3), nothing changed`, async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    const changes = Array.from({ length: LIMITS.MAX_CHANGES + 1 }, (_, i) => ({
      nodeId: `n${i}`,
      visible: true,
    }));
    client.sendRaw(update("too-many", 1, 2, changes));
    expect(errors(await flush(client))).toEqual([
      expect.objectContaining({ code: "INVALID_MESSAGE", replyTo: "too-many" }),
    ]);
    expect([session.sceneVersion, session.nodeState.size]).toEqual([1, 0]);
  });

  it("BAD_SEQUENCE answers close nothing and are no strike towards 4007 (§9.2)", async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    for (let i = 0; i < 5; i++)
      client.sendRaw(update(`bad-${i}`, 9, 10, [{ nodeId: MODEL, visible: true }]));
    expect(errors(await flush(client))).toHaveLength(5);
    client.sendRaw(update("good", 1, 2, [{ nodeId: MODEL, visible: true }]));
    expect(errors(await flush(client))).toEqual([]);
    expect(session.sceneVersion).toBe(2);
  });

  it("criterion 2: merged state keeps both properties; nodeRemoved marks removed; a snapshot resets it", async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    client.sendRaw(update("u1", 1, 2, [{ nodeId: MODEL, visible: false }]));
    client.sendRaw(
      update("u2", 2, 3, [
        { nodeId: MODEL, color: [0.2, 0.4, 0.6], matrix: MATRIX },
        { nodeId: SEGMENT, opacity: 0.25 },
      ]),
    );
    client.send({ type: "scene.nodeRemoved", baseVersion: 3, sceneVersion: 4, nodeIds: [SEGMENT] });
    client.sendRaw(update("u3", 4, 5, [{ nodeId: SEGMENT, visible: true }])); // stays removed
    expect(errors(await flush(client))).toEqual([]);
    expect(Object.fromEntries(session.nodeState)).toEqual({
      [MODEL]: { visible: false, color: [0.2, 0.4, 0.6], matrix: MATRIX },
      [SEGMENT]: "removed",
    });
    // A late viewer gets the same as scene.state (§8.3).
    const late = await viewer(session);
    expect(await late.client.next()).toMatchObject({
      type: "scene.state",
      sceneVersion: 5,
      snapshotVersion: 1,
      nodes: [{ nodeId: MODEL, visible: false, color: [0.2, 0.4, 0.6], matrix: MATRIX }],
      removed: [SEGMENT],
    });
    await snapshot(client, 6);
    expect(session.nodeState.size).toBe(0);
  });

  it("scene.nodeAdded advances the version and is forwarded, without changing the state (§8.2)", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    await snapshot(client, 1);
    const text = JSON.stringify(
      {
        protocolVersion: "1.0",
        type: "scene.nodeAdded",
        sceneVersion: 2,
        baseVersion: 1,
        nodes: [{ nodeId: "vtkMRMLModelNode9", kind: "model" }],
        snapshotFollows: true,
      },
      null,
      2,
    );
    client.sendRaw(text);
    expect(errors(await flush(client))).toEqual([]);
    expect([session.sceneVersion, session.nodeState.size]).toEqual([2, 0]);
    await flush(watcher.client);
    expect(watcher.raw).toContain(text);
    await snapshot(client, 3); // the snapshot that must follow
  });

  it("criterion 3: only the four properties are stored; a name is INVALID_MESSAGE, another key is not copied", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    await snapshot(client, 1);
    client.sendRaw(
      update("named", 1, 2, [{ nodeId: MODEL, visible: false, name: "Liver of J. Doe" }]),
    );
    expect(errors(await flush(client))).toEqual([
      expect.objectContaining({ code: "INVALID_MESSAGE", replyTo: "named" }),
    ]);
    const text = update("extra", 1, 2, [
      { nodeId: MODEL, opacity: 0.5, label: "kept out of the state" },
    ]);
    client.sendRaw(text);
    expect(errors(await flush(client))).toEqual([]);
    expect(session.nodeState.get(MODEL)).toEqual({ opacity: 0.5 });
    expect(JSON.stringify([...session.nodeState])).not.toContain("kept out");
    await flush(watcher.client);
    expect(watcher.raw).toContain(text); // forwarded as received (§11)
  });

  it(`the state holds at most ${MAX_STATE_NODES} node ids; the next new id → BAD_SEQUENCE{nodeState} until a snapshot`, async () => {
    const { client, session } = await publisher();
    await snapshot(client, 1);
    const many = Array.from({ length: MAX_STATE_NODES - 1 }, (_, i) => ({
      nodeId: `vtkMRMLModelNode${100 + i}`,
      visible: true,
    }));
    client.sendRaw(update("fill", 1, 2, many));
    // One new id named twice is one id: the state is then full, not over.
    client.send({
      type: "scene.nodeRemoved",
      baseVersion: 2,
      sceneVersion: 3,
      nodeIds: ["vtkMRMLModelNode3", "vtkMRMLModelNode3"],
    });
    expect(errors(await flush(client))).toEqual([]);
    expect(session.nodeState.size).toBe(MAX_STATE_NODES);
    client.sendRaw(update("one-more", 3, 4, [{ nodeId: "vtkMRMLModelNode1", visible: true }]));
    client.send({
      type: "scene.nodeRemoved",
      id: "remove-new",
      baseVersion: 3,
      sceneVersion: 4,
      nodeIds: ["vtkMRMLModelNode2"],
    });
    expect(
      errors(await flush(client)).map((e) => [e.replyTo, (e.details as { field: string }).field]),
    ).toEqual([
      ["one-more", "nodeState"],
      ["remove-new", "nodeState"],
    ]);
    client.sendRaw(update("known", 3, 4, [{ nodeId: "vtkMRMLModelNode100", visible: false }]));
    expect(errors(await flush(client))).toEqual([]);
    await snapshot(client, 5);
    client.sendRaw(update("after", 5, 6, [{ nodeId: "vtkMRMLModelNode1", visible: true }]));
    expect(errors(await flush(client))).toEqual([]);
    expect(session.nodeState.size).toBe(1);
  });

  it("a viewer may not send them (§11), and a socket the session no longer has is ignored", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    await snapshot(client, 1);
    await flush(watcher.client);
    watcher.client.sendRaw(update("v-1", 1, 2, [{ nodeId: MODEL, visible: false }]));
    expect(errors(await flush(watcher.client))).toEqual([
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    ]);
    const own = session.publisher;
    session.publisher = undefined; // as if a resumed socket had replaced it (SRV-15)
    client.sendRaw(update("stale", 1, 2, [{ nodeId: MODEL, visible: false }]));
    expect(await flush(client)).toEqual([]);
    session.publisher = own;
    expect([session.sceneVersion, session.nodeState.size]).toEqual([1, 0]);
  });
});

/**
 * Makes the relay-side socket of every viewer of `session` read nothing: each frame forwarded to it
 * stays in its `bufferedAmount` (the client gets none of them; replies and closes still reach it).
 */
function stopReading(session: Session): Map<Connection, number> {
  const held = new Map<Connection, number>();
  for (const { peer } of session.viewers.values()) {
    const connection = peer as Connection;
    held.set(connection, 0);
    Object.defineProperty(connection, "bufferedAmount", { get: () => held.get(connection) });
    connection.forward = (frame) => {
      held.set(connection, held.get(connection)! + onWire(frame));
    };
  }
  return held;
}

/** What a frame adds to `bufferedAmount`: its bytes and its WebSocket header (RFC 6455 §5.2). */
function onWire(frame: string | Buffer): number {
  const bytes = Buffer.byteLength(frame);
  return bytes + (bytes < 126 ? 2 : bytes < 65_536 ? 4 : 10);
}

/** A `scene.update` of 1,000 matrices, near the publisher's 256 KiB text limit (§3.3). */
function maximalUpdate(baseVersion: number): string {
  const matrix = Array.from({ length: 16 }, (_, i) => Number(((i + 1) / 7).toFixed(10)));
  const changes = Array.from({ length: LIMITS.MAX_CHANGES }, (_, i) => ({
    nodeId: `vtkMRMLModelNode${1000 + i}`,
    matrix,
  }));
  const text = JSON.stringify({
    protocolVersion: "1.0",
    type: "scene.update",
    id: `max-${baseVersion}`,
    sceneVersion: baseVersion + 1,
    baseVersion,
    changes,
  });
  expect(Buffer.byteLength(text)).toBeGreaterThan(200 * 1024);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262_144);
  return text;
}

describe("updates to viewers that read nothing stay within the send-buffer limits (T3, §3.3, architecture §4)", () => {
  it("no viewer gets an update that would take it above 8 MiB: it is closed 4010 instead, before any watch", async () => {
    const { client, session } = await publisher();
    const viewers = [await viewer(session), await viewer(session)];
    await snapshot(client, 1);
    for (const v of viewers) await flush(v.client);
    const held = stopReading(session);
    const bytes = onWire(maximalUpdate(1));
    const rounds = Math.ceil(HARD_WATERMARK_BYTES / bytes) + 3;
    for (let v = 1; v <= rounds; v++) client.sendRaw(maximalUpdate(v));
    expect(errors(await flush(client))).toEqual([]);
    expect(session.sceneVersion).toBe(rounds + 1); // all accepted; the manual clock never moved
    for (const amount of held.values()) {
      expect(amount).toBeLessThanOrEqual(HARD_WATERMARK_BYTES);
      expect(amount).toBeGreaterThan(HARD_WATERMARK_BYTES - bytes); // it got all that fitted
    }
    for (const v of viewers) {
      expect(await v.client.closed).toBe(4010);
      expect(v.client.received.at(-1)).toMatchObject({ type: "error", code: "SLOW_CONSUMER" });
    }
  });

  it("Σ over 20 viewers never passes MAX_TOTAL_BUFFERED_BYTES: the largest are closed 4010 before a send", async () => {
    const budget = 16 * 1024 * 1024;
    relay = await startRelay({
      config: loadConfig({
        TRUST_PROXY: "false",
        ALLOWED_ORIGINS: "https://relay.example.org",
        MAX_TOTAL_BUFFERED_BYTES: String(budget),
      }),
    });
    const { client, session } = await publisher();
    const viewers = [];
    for (let i = 0; i < 20; i++) viewers.push(await viewer(session));
    await snapshot(client, 1);
    for (const v of viewers) await flush(v.client);
    const held = stopReading(session);
    let sent = 0;
    for (let v = 1; v <= 12; v++) {
      const text = maximalUpdate(v);
      sent += onWire(text);
      client.sendRaw(text);
      expect(errors(await flush(client))).toEqual([]);
      const live = [...held].filter(([connection]) => connection.isOpen);
      expect(live.reduce((sum, [, amount]) => sum + amount, 0)).toBeLessThanOrEqual(budget);
      for (const [, amount] of live) expect(amount).toBe(sent); // the survivors got every update
    }
    const live = [...held.keys()].filter((connection) => connection.isOpen);
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(20);
    for (const v of viewers)
      if (!live.some((connection) => connection.viewer?.id === v.id))
        expect(await v.client.closed).toBe(4010);
  });

  it("a viewer that leaves and never completes the close is dropped after 5 s", async () => {
    const { client, session } = await publisher();
    const v = await viewer(session);
    await snapshot(client, 1);
    await flush(v.client);
    const connection = [...session.viewers.values()][0]!.peer as Connection;
    v.client.send({ type: "viewer.leave" });
    v.client.ws.pause(); // reads nothing more: never answers the relay's close
    await expect.poll(() => connection.socket.readyState).toBe(WebSocket.CLOSING);
    relay!.clock.advance(CLOSE_COMPLETE_MS - 1);
    expect(connection.socket.readyState).toBe(WebSocket.CLOSING);
    relay!.clock.advance(1);
    await expect.poll(() => connection.socket.readyState).toBe(WebSocket.CLOSED);
  });
});
