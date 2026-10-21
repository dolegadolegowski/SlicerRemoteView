import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection } from "../src/ws/connection.js";
import { readFrame } from "../src/ws/frame.js";
import type { TextFrame } from "../src/ws/frame.js";
import { CHUNK_TIMEOUT_MS, snapshotHandlers } from "../src/ws/snapshot.js";
import type { AbortReason } from "../src/ws/snapshot.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

// Exposed by `execArgv: ["--expose-gc"]` in vitest.config.ts.
declare const gc: () => void;

const GLB = new URL("../../shared/fixtures/glb/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", GLB), "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
const glb = (name: string): Buffer => readFileSync(new URL(name, GLB));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const KIB = 1024;
const LARGE = "large-synthetic.glb";

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function publisher(): Promise<{ client: TestClient; session: Session }> {
  relay ??= await startRelay();
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  return { client, session: relay.registry.get(created.sessionId as string)! };
}

function begin(bytes: Uint8Array, sceneVersion: number, chunkSize = 64 * KIB) {
  return {
    type: "scene.snapshot.begin",
    id: `b-${sceneVersion}`,
    sceneVersion,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    chunkCount: Math.ceil(bytes.byteLength / chunkSize),
    chunkSize,
    format: "glb",
    extensionsUsed: [],
  };
}

function frames(bytes: Uint8Array, sceneVersion: number, chunkSize = 64 * KIB): Buffer[] {
  return [...chunkify(bytes, chunkSize)].map(({ chunkIndex, payload }) =>
    Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)),
  );
}

const end = (bytes: Uint8Array, sceneVersion: number, digest = sha256(bytes)) => ({
  type: "scene.snapshot.end",
  id: `e-${sceneVersion}`,
  sceneVersion,
  sha256: digest,
});

/** Sends a whole snapshot: begin, every chunk, end. */
function upload(client: TestClient, bytes: Uint8Array, sceneVersion: number): void {
  client.send(begin(bytes, sceneVersion));
  for (const frame of frames(bytes, sceneVersion)) client.sendRaw(frame, true);
  client.send(end(bytes, sceneVersion));
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

/** Calls a handler the way the dispatcher does: with the message and the frame it came in. */
function invoke(
  handler: (connection: Connection, message: never, frame: TextFrame) => unknown,
  connection: Connection,
  message: Record<string, unknown>,
): void {
  void handler(connection, message as never, readFrame(JSON.stringify(message)));
}

describe("end, verify and cache (SRV-24 criterion 1, §6.4)", () => {
  it("the cached bytes match the manifest; the publisher gets the ack; state resets", async () => {
    const { client, session } = await publisher();
    session.nodeState.set("vtkMRMLModelNode1", { visible: false });
    const bytes = glb(LARGE);
    upload(client, bytes, 1);
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        type: "scene.snapshot.ack",
        replyTo: "e-1",
        sceneVersion: 1,
        viewersStreamed: 0,
        viewersDeferred: 0,
      }),
    ]);
    expect(sha256(session.snapshot!.buffer)).toBe(manifest.files[LARGE]!.sha256);
    expect(session.snapshot).toMatchObject({
      sceneVersion: 1,
      byteLength: bytes.byteLength,
      sha256: manifest.files[LARGE]!.sha256,
      extensionsRequired: [],
    });
    expect([session.sceneVersion, session.phase, session.assembling]).toEqual([
      1,
      "active",
      undefined,
    ]);
    expect(session.nodeState.size).toBe(0);
  });

  it("counts a viewer that was connected at begin as streamed (SRV-10)", async () => {
    const { client, session } = await publisher();
    const viewer = await connectClient(relay!.url);
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    expect((await viewer.next()).type).toBe("viewer.joined");
    await flush(client); // viewer.count
    upload(client, glb("asymmetric-2nodes.glb"), 1);
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        type: "scene.snapshot.ack",
        viewersStreamed: 1,
        viewersDeferred: 0,
      }),
    ]);
  });

  it("a later snapshot needs a higher version than the cached one", async () => {
    const { client } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    upload(client, bytes, 3);
    await flush(client);
    client.send({ ...begin(bytes, 3), id: "same" });
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "BAD_SEQUENCE",
        replyTo: "same",
        details: { field: "sceneVersion" },
      }),
    ]);
  });
});

describe("failed ends and the chunk timeout (SRV-24 criterion 2, §3.3, §6.4, T2)", () => {
  it("a wrong sha256 → CHECKSUM_MISMATCH, buffer dropped, cache untouched", async () => {
    const { client, session } = await publisher();
    const bytes = glb(LARGE);
    upload(client, glb("asymmetric-2nodes.glb"), 1);
    await flush(client);
    client.send(begin(bytes, 2));
    const corrupted = frames(bytes, 2);
    const target = corrupted[5]!;
    target[100] = target[100]! ^ 0xff; // one flipped byte of payload
    for (const frame of corrupted) client.sendRaw(frame, true);
    client.send(end(bytes, 2));
    expect(await flush(client)).toEqual([
      expect.objectContaining({ code: "CHECKSUM_MISMATCH", replyTo: "e-2", retryable: true }),
    ]);
    expect(session.assembling).toBeUndefined();
    expect(session.snapshot?.sceneVersion).toBe(1);
    expect(relay!.registry.snapshotBytes).toBe(glb("asymmetric-2nodes.glb").byteLength);
  });

  it("an end whose sha256 differs from the begin's → CHECKSUM_MISMATCH", async () => {
    const { client, session } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    client.send(begin(bytes, 1));
    for (const frame of frames(bytes, 1)) client.sendRaw(frame, true);
    client.send(end(bytes, 1, "0".repeat(64)));
    expect(await flush(client)).toEqual([expect.objectContaining({ code: "CHECKSUM_MISMATCH" })]);
    expect([session.snapshot, session.assembling]).toEqual([undefined, undefined]);
  });

  it("an end before every chunk arrived (a length mismatch) → CHECKSUM_MISMATCH, no strike", async () => {
    const { client, session } = await publisher();
    const bytes = glb(LARGE);
    // begin and end name the hash of exactly the bytes sent: only the length check can catch it.
    const prefix = sha256(bytes.subarray(0, 10 * 64 * KIB));
    client.send({ ...begin(bytes, 1), sha256: prefix });
    for (const frame of frames(bytes, 1).slice(0, 10)) client.sendRaw(frame, true);
    client.send(end(bytes, 1, prefix));
    expect(await flush(client)).toEqual([
      expect.objectContaining({ code: "CHECKSUM_MISMATCH", replyTo: "e-1", retryable: true }),
    ]);
    expect([session.assembling, session.snapshot]).toEqual([undefined, undefined]);
    expect(relay!.registry.get(session.id)).toBe(session);
  });

  it("an end for no snapshot in flight → BAD_SEQUENCE{sceneVersion}; for a refused one: ignored", async () => {
    const { client } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    client.send(end(bytes, 4));
    client.send({ ...begin(bytes, 5), byteLength: 67_108_865, chunkCount: 1024 });
    client.send(end(bytes, 5));
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "BAD_SEQUENCE",
        replyTo: "e-4",
        details: { field: "sceneVersion" },
      }),
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    ]);
  });

  it("120 s without a chunk aborts the snapshot; each chunk restarts the 120 s", async () => {
    const { client, session } = await publisher();
    const bytes = glb(LARGE);
    const all = frames(bytes, 1);
    client.send(begin(bytes, 1));
    client.sendRaw(all[0]!, true);
    await flush(client);
    relay!.clock.advance(CHUNK_TIMEOUT_MS - 1);
    client.sendRaw(all[1]!, true);
    await flush(client);
    relay!.clock.advance(CHUNK_TIMEOUT_MS - 1); // 239 s after begin, 119.999 s after the last chunk
    expect(session.assembling?.nextIndex).toBe(2);
    relay!.clock.advance(1);
    expect(session.assembling).toBeUndefined();
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "BAD_SEQUENCE",
      retryable: true,
      details: { field: "chunkIndex", timeoutS: 120 },
    });
    // The rest of version 1 is ignored; no violation, the socket stays open.
    for (const frame of all.slice(2)) client.sendRaw(frame, true);
    client.send(end(bytes, 1));
    expect(await flush(client)).toEqual([]);
    expect(client.ws.readyState).toBe(1);
  });
});

describe("swap and supersede (SRV-24 criterion 3, §6.2, §6.4, T11)", () => {
  it("the previous cached buffer is released on swap", async () => {
    const { client, session } = await publisher();
    upload(client, glb(LARGE), 1);
    await flush(client);
    const old = new WeakRef(session.snapshot!.buffer);
    upload(client, glb("asymmetric-2nodes.glb"), 2);
    await flush(client);
    expect(session.snapshot?.sceneVersion).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    expect(old.deref() === undefined).toBe(true);
  });

  it("a second begin mid-stream supersedes the first; the new stream completes normally", async () => {
    const { client, session } = await publisher();
    const first = glb(LARGE);
    const second = glb("quantized-1node.glb");
    client.send(begin(first, 1));
    for (const frame of frames(first, 1).slice(0, 20)) client.sendRaw(frame, true);
    upload(client, second, 2);
    expect(await flush(client)).toEqual([
      expect.objectContaining({ type: "scene.snapshot.ack", sceneVersion: 2 }),
    ]);
    expect(sha256(session.snapshot!.buffer)).toBe(manifest.files["quantized-1node.glb"]!.sha256);
  });

  it("the publisher's own abort drops the snapshot; its later chunks are ignored", async () => {
    const { client, session } = await publisher();
    const bytes = glb(LARGE);
    const all = frames(bytes, 1);
    client.send(begin(bytes, 1));
    for (const frame of all.slice(0, 5)) client.sendRaw(frame, true);
    client.send({ type: "scene.snapshot.abort", sceneVersion: 1, reason: "SUPERSEDED" });
    for (const frame of all.slice(5)) client.sendRaw(frame, true);
    expect(await flush(client)).toEqual([]);
    expect(session.assembling).toBeUndefined();
  });

  it("a publisher abort for another version changes nothing", async () => {
    const { client, session } = await publisher();
    const bytes = glb(LARGE);
    const all = frames(bytes, 1);
    client.send(begin(bytes, 1));
    for (const frame of all.slice(0, 5)) client.sendRaw(frame, true);
    client.send({ type: "scene.snapshot.abort", sceneVersion: 99, reason: "SUPERSEDED" });
    for (const frame of all.slice(5)) client.sendRaw(frame, true);
    client.send(end(bytes, 1));
    expect(await flush(client)).toEqual([
      expect.objectContaining({ type: "scene.snapshot.ack", sceneVersion: 1 }),
    ]);
    expect(session.snapshot?.sceneVersion).toBe(1);
  });

  it.each([
    [
      "session.close",
      (r: TestRelay, p: { client: TestClient; session: Session }) =>
        p.client.send({ type: "session.close", reason: "USER_STOPPED" }),
    ],
    [
      "relay expiry",
      (r: TestRelay, p: { client: TestClient; session: Session }) =>
        r.registry.expireSession(p.session, "IDLE"),
    ],
  ])(
    "%s mid-stream frees the buffer at once and cancels its chunk timeout",
    async (_name, end_) => {
      const p = await publisher();
      p.client.send(begin(glb(LARGE), 1));
      for (const frame of frames(glb(LARGE), 1).slice(0, 10)) p.client.sendRaw(frame, true);
      await flush(p.client);
      const buffer = new WeakRef(p.session.assembling!.buffer);
      const pendingBefore = relay!.clock.pending;
      end_(relay!, p);
      await p.client.closed;
      expect(relay!.clock.pending).toBeLessThan(pendingBefore); // the chunk timeout is gone
      await new Promise((resolve) => setImmediate(resolve));
      gc();
      expect(buffer.deref() === undefined).toBe(true);
    },
  );

  it("losing the publisher's socket or closing the session drops the buffer in flight", async () => {
    const a = await publisher();
    const b = await publisher();
    for (const p of [a, b]) {
      p.client.send(begin(glb(LARGE), 1));
      p.client.sendRaw(frames(glb(LARGE), 1)[0]!, true);
      await flush(p.client);
    }
    a.client.ws.terminate();
    b.client.send({ type: "session.close", reason: "USER_STOPPED" });
    // Booleans: a failing poll must not diff 5 MB buffers.
    await expect
      .poll(() => [a.session.assembling === undefined, b.session.assembling === undefined])
      .toEqual([true, true]);
    expect(relay!.registry.snapshotBytes).toBe(0);
    await b.client.closed;
    await relay!.close();
    await expect.poll(() => relay!.clock.pending).toBe(0); // chunk timeouts cancelled too
    relay = undefined;
  });
});

describe("abort events for the fan-out (unit)", () => {
  function setup() {
    const clock = new ManualClock();
    const config = loadConfig({});
    const registry = new Registry({ ...config, clock });
    const { session } = registry.createSession("mobile");
    const aborted: [number, AbortReason][] = [];
    const deps = { registry, config, clock, logger: createLogger({ level: "silent" }) };
    const snapshot = snapshotHandlers({
      ...deps,
      events: { aborted: (_session, version, reason) => aborted.push([version, reason]) },
    });
    const sent: Record<string, unknown>[] = [];
    const connection = {
      session,
      violation: (code: string) => sent.push({ code }),
      sendError: (code: string) => sent.push({ code }),
      send: (message: Record<string, unknown>) => sent.push(message),
    } as unknown as Connection;
    session.publisher = {
      send: (m) => sent.push(m),
      forward: () => {},
      bufferedAmount: 0,
      close: () => {},
    };
    const bytes = glb("asymmetric-2nodes.glb");
    const start = (version: number) =>
      invoke(snapshot.handlers["scene.snapshot.begin"]!, connection, begin(bytes, version));
    return { clock, session, snapshot, connection, aborted, sent, bytes, start };
  }

  it.each<[string, (s: ReturnType<typeof setup>) => void, AbortReason]>([
    ["a newer begin", (s) => s.start(2), "SUPERSEDED"],
    ["a bad chunk", (s) => s.snapshot.chunk(s.connection, frames(s.bytes, 9)[0]!), "BAD_SEQUENCE"],
    [
      "the publisher's abort",
      (s) =>
        invoke(s.snapshot.handlers["scene.snapshot.abort"]!, s.connection, {
          type: "scene.snapshot.abort",
          sceneVersion: 1,
          reason: "TIMEOUT",
        }),
      "TIMEOUT",
    ],
    ["the publisher gone", (s) => s.snapshot.publisherGone(s.session), "PUBLISHER_GONE"],
    ["120 s of silence", (s) => s.clock.advance(CHUNK_TIMEOUT_MS), "TIMEOUT"],
    [
      "a checksum mismatch",
      (s) => {
        s.snapshot.chunk(s.connection, frames(s.bytes, 1)[0]!);
        invoke(
          s.snapshot.handlers["scene.snapshot.end"]!,
          s.connection,
          end(s.bytes, 1, "f".repeat(64)),
        );
      },
      "CHECKSUM_MISMATCH",
    ],
  ])("%s → aborted(%s)", (_name, act, reason) => {
    const s = setup();
    s.start(1);
    act(s);
    expect(s.aborted).toEqual([[1, reason]]);
    expect(s.session.assembling?.sceneVersion).not.toBe(1);
    // The aborted snapshot's chunk timeout went with it (a newer begin arms its own).
    expect(s.clock.pending).toBe(s.session.assembling === undefined ? 0 : 1);
  });

  it("dispose() cancels every chunk timeout and detaches from the registry", () => {
    const s = setup();
    s.start(1);
    expect(s.clock.pending).toBe(1);
    s.snapshot.dispose();
    expect(s.clock.pending).toBe(0);
    s.clock.advance(CHUNK_TIMEOUT_MS);
    expect(s.aborted).toEqual([]);
  });

  it.each([
    ["too large", { byteLength: 67_108_865, chunkCount: 1024 }],
    ["a wrong chunkCount", { chunkCount: 7 }],
  ])("a newer begin refused as %s still supersedes the snapshot in flight", (_name, extra) => {
    const s = setup();
    s.start(1);
    invoke(s.snapshot.handlers["scene.snapshot.begin"]!, s.connection, {
      ...begin(s.bytes, 2),
      ...extra,
    });
    expect(s.aborted).toEqual([[1, "SUPERSEDED"]]);
    expect(s.session.assembling).toBeUndefined();
  });

  it("a throwing fan-out hook neither breaks the timeout nor the ack, and its text is not logged", () => {
    const clock = new ManualClock();
    const config = loadConfig({});
    const registry = new Registry({ ...config, clock });
    const { session } = registry.createSession("mobile");
    const lines: string[] = [];
    const snapshot = snapshotHandlers({
      registry,
      config,
      clock,
      logger: createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } }),
      events: {
        aborted: () => {
          throw new Error(`hook ${session.code}`);
        },
        completed: () => {
          throw new Error(`hook ${session.code}`);
        },
      },
    });
    const sent: Record<string, unknown>[] = [];
    const connection = {
      session,
      send: (message: Record<string, unknown>) => sent.push(message),
    } as unknown as Connection;
    session.publisher = {
      send: (m) => sent.push(m),
      forward: () => {},
      bufferedAmount: 0,
      close: () => {},
    };
    const bytes = glb("asymmetric-2nodes.glb");
    invoke(snapshot.handlers["scene.snapshot.begin"]!, connection, begin(bytes, 1));
    expect(() => clock.advance(CHUNK_TIMEOUT_MS)).not.toThrow();
    expect(session.assembling).toBeUndefined();
    invoke(snapshot.handlers["scene.snapshot.begin"]!, connection, begin(bytes, 2));
    for (const frame of frames(bytes, 2)) snapshot.chunk(connection, frame);
    invoke(snapshot.handlers["scene.snapshot.end"]!, connection, end(bytes, 2));
    expect(sent.at(-1)).toMatchObject({ type: "scene.snapshot.ack", sceneVersion: 2 });
    const failures = lines.filter((l) => l.includes("hook failed"));
    expect(failures).toHaveLength(2);
    expect(JSON.parse(failures[0]!)).toMatchObject({
      sessionId: session.id,
      errorCode: "INTERNAL",
    });
    expect(lines.join("")).not.toContain(session.code);
  });
});
