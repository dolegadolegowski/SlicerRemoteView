import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkify,
  encodeChunkFrame,
  MAX_CHUNK_SIZE,
  MAX_SNAPSHOT_BYTES,
  MIN_CHUNK_SIZE,
  sha256Hex,
  validateMessage,
} from "@slicerremoteview/shared";
import { createConnection } from "../../src/protocol/connection";
import { bindSnapshotStream, createSnapshotStream } from "../../src/protocol/snapshot-stream";
import type { SnapshotStream, SnapshotStreamEvents } from "../../src/protocol/snapshot-stream";
import { MockSocket } from "./mock-socket";

const GLB_DIR = fileURLToPath(new URL("../../../shared/fixtures/glb/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${GLB_DIR}manifest.json`, "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
const glb = (name: string) => new Uint8Array(readFileSync(`${GLB_DIR}${name}`));

function beginFor(
  bytes: Uint8Array,
  sceneVersion: number,
  chunkSize = MIN_CHUNK_SIZE,
  sha256?: string,
) {
  const message = {
    protocolVersion: "1.0",
    type: "scene.snapshot.begin" as const,
    sceneVersion,
    byteLength: bytes.byteLength,
    sha256: sha256 ?? "0".repeat(64),
    chunkCount: Math.ceil(bytes.byteLength / chunkSize),
    chunkSize,
    format: "glb" as const,
    extensionsUsed: [],
  };
  return message;
}

async function withHash(bytes: Uint8Array, sceneVersion: number, chunkSize = MIN_CHUNK_SIZE) {
  return beginFor(bytes, sceneVersion, chunkSize, await sha256Hex(bytes));
}

/** `toEqual` on multi-MiB typed arrays takes seconds; compare the bytes directly. */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

const frames = (bytes: Uint8Array, sceneVersion: number, chunkSize = MIN_CHUNK_SIZE) =>
  [...chunkify(bytes, chunkSize)].map(({ chunkIndex, payload }) =>
    encodeChunkFrame({ sceneVersion, chunkIndex }, payload),
  );

const endFor = (begin: { sceneVersion: number; sha256: string }) => ({
  protocolVersion: "1.0",
  type: "scene.snapshot.end" as const,
  sceneVersion: begin.sceneVersion,
  sha256: begin.sha256,
});

let stream: SnapshotStream;
let events: { [K in keyof SnapshotStreamEvents]: SnapshotStreamEvents[K][] };

function make(options: Parameters<typeof createSnapshotStream>[0] = {}): void {
  stream = createSnapshotStream(options);
  events = {
    progress: [],
    ready: [],
    badSequence: [],
    checksumMismatch: [],
    tooLarge: [],
    aborted: [],
  };
  for (const name of Object.keys(events) as (keyof SnapshotStreamEvents)[])
    stream.on(name, (p) => (events[name] as unknown[]).push(p));
}
beforeEach(() => make());

describe("happy path (§6.3, §6.4)", () => {
  it("a progress handler that throws does not stop the handlers after it or the snapshot", async () => {
    const log = vi.fn();
    stream = createSnapshotStream({ log });
    stream.on("progress", () => {
      throw new Error("handler bug");
    });
    const after = vi.fn();
    stream.on("progress", after); // registered after the throwing one
    const ready = vi.fn();
    stream.on("ready", ready);
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 7);
    stream.begin(begin);
    for (const f of frames(bytes, 7)) stream.chunk(f);
    await stream.end(endFor(begin));
    expect(after).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("snapshot stream handler failed", { event: "progress" });
  });

  it("reassembles asymmetric-2nodes.glb and matches manifest.json", async () => {
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 7);
    expect(begin.sha256).toBe(manifest.files["asymmetric-2nodes.glb"]!.sha256);
    expect(validateMessage(begin).ok).toBe(true);
    stream.begin(begin);
    expect(stream.activeVersion).toBe(7);
    expect(stream.bytesHeld).toBe(bytes.byteLength);
    for (const f of frames(bytes, 7)) stream.chunk(f);
    await stream.end(endFor(begin));
    expect(events.ready).toHaveLength(1);
    expect(same(events.ready[0]!.bytes, bytes)).toBe(true);
    expect(await sha256Hex(events.ready[0]!.bytes)).toBe(
      manifest.files["asymmetric-2nodes.glb"]!.sha256,
    );
    expect(events.progress.at(-1)!.fraction).toBe(1);
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
  });

  it.each([MIN_CHUNK_SIZE, 300_000, MAX_CHUNK_SIZE])(
    "large-synthetic.glb in chunks of %i B: progress is monotonic and reaches 1.0",
    async (chunkSize) => {
      const bytes = glb("large-synthetic.glb");
      const begin = await withHash(bytes, 3, chunkSize);
      stream.begin(begin);
      for (const f of frames(bytes, 3, chunkSize)) stream.chunk(f);
      await stream.end(endFor(begin));
      const fractions = events.progress.map((p) => p.fraction);
      expect(fractions).toHaveLength(begin.chunkCount);
      expect(fractions[0]).toBeGreaterThan(0);
      expect(fractions.at(-1)).toBe(1);
      for (let i = 1; i < fractions.length; i++)
        expect(fractions[i]).toBeGreaterThan(fractions[i - 1]!);
      expect(events.ready).toHaveLength(1);
      expect(same(events.ready[0]!.bytes, bytes)).toBe(true);
      expect(events.badSequence).toEqual([]);
    },
  );

  it("works with frames that are views at an offset (as a WebSocket delivers them)", async () => {
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 1);
    stream.begin(begin);
    const [frame] = frames(bytes, 1);
    const padded = new Uint8Array(frame!.byteLength + 5);
    padded.set(frame!, 5);
    stream.chunk(padded.subarray(5));
    await stream.end(endFor(begin));
    expect(events.ready).toHaveLength(1);
  });
});

describe("receiver rules (§6.3)", () => {
  it("drops chunks of an aborted snapshot silently", async () => {
    const bytes = glb("large-synthetic.glb");
    const first = await withHash(bytes, 5);
    stream.begin(first);
    const old = frames(bytes, 5);
    stream.chunk(old[0]!);
    stream.abort({
      protocolVersion: "1.0",
      type: "scene.snapshot.abort",
      sceneVersion: 5,
      reason: "SUPERSEDED",
    });
    expect(events.aborted).toEqual([{ sceneVersion: 5, reason: "SUPERSEDED" }]);
    expect(stream.bytesHeld).toBe(0);
    // trailing chunks of the aborted snapshot, with and without a new snapshot in flight
    stream.chunk(old[1]!);
    const second = await withHash(glb("asymmetric-2nodes.glb"), 6);
    stream.begin(second);
    stream.chunk(old[2]!);
    expect(events.badSequence).toEqual([]);
    expect(stream.activeVersion).toBe(6);
    expect(events.progress).toHaveLength(1); // only chunk 0 of v5 before the abort
  });

  it("a new begin aborts the one in flight and ignores its remaining chunks", async () => {
    const bytes = glb("large-synthetic.glb");
    stream.begin(await withHash(bytes, 5));
    const old = frames(bytes, 5);
    stream.chunk(old[0]!);
    const small = glb("asymmetric-2nodes.glb");
    const begin = await withHash(small, 6);
    stream.begin(begin);
    stream.chunk(old[1]!);
    for (const f of frames(small, 6)) stream.chunk(f);
    await stream.end(endFor(begin));
    expect(events.badSequence).toEqual([]);
    expect(events.ready.map((r) => r.sceneVersion)).toEqual([6]);
    expect(events.aborted).toEqual([{ sceneVersion: 5, reason: "SUPERSEDED" }]);
    // the relay's own abort for the superseded version arrives late: no second event
    stream.abort({
      protocolVersion: "1.0",
      type: "scene.snapshot.abort",
      sceneVersion: 5,
      reason: "SUPERSEDED",
    });
    expect(events.aborted).toHaveLength(1);
  });

  it("a skipped chunkIndex emits badSequence{field:'chunkIndex'} and frees the buffer", async () => {
    const bytes = glb("large-synthetic.glb");
    stream.begin(await withHash(bytes, 9));
    const f = frames(bytes, 9);
    stream.chunk(f[0]!);
    stream.chunk(f[2]!);
    expect(events.badSequence).toEqual([{ sceneVersion: 9, field: "chunkIndex" }]);
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
    stream.chunk(f[3]!); // rest of the discarded snapshot: silent
    expect(events.badSequence).toHaveLength(1);
  });

  it("duplicate, wrong-size, wrong-magic and unknown-version chunks are bad sequences", async () => {
    const bytes = glb("large-synthetic.glb");
    const f = frames(bytes, 4);
    const cases: [string, (s: SnapshotStream) => void, string][] = [
      ["duplicate", (s) => (s.chunk(f[0]!), s.chunk(f[0]!)), "chunkIndex"],
      ["short payload", (s) => s.chunk(f[0]!.subarray(0, f[0]!.byteLength - 1)), "payload"],
      [
        "bad magic",
        (s) => s.chunk(Uint8Array.from(f[0]!, (b, i) => (i === 0 ? 0x58 : b))),
        "magic",
      ],
      ["too short", (s) => s.chunk(f[0]!.subarray(0, 5)), "length"],
      ["other version", (s) => s.chunk(frames(bytes, 99)[0]!), "sceneVersion"],
    ];
    for (const [label, act, field] of cases) {
      make();
      stream.begin(await withHash(bytes, 4));
      act(stream);
      expect(events.badSequence, label).toEqual([{ sceneVersion: 4, field }]);
      expect(stream.bytesHeld, label).toBe(0);
    }
  });

  it("chunks with no snapshot in flight are dropped silently", () => {
    stream.chunk(frames(glb("asymmetric-2nodes.glb"), 1)[0]!);
    stream.chunk(new Uint8Array(3));
    expect(events.badSequence).toEqual([]);
  });

  it("end before all chunks arrived is a bad sequence; end with a different sha256 too", async () => {
    const bytes = glb("large-synthetic.glb");
    const begin = await withHash(bytes, 2);
    stream.begin(begin);
    stream.chunk(frames(bytes, 2)[0]!);
    await stream.end(endFor(begin));
    expect(events.badSequence).toEqual([{ sceneVersion: 2, field: "chunkIndex" }]);

    make();
    const small = glb("asymmetric-2nodes.glb");
    const b2 = await withHash(small, 3);
    stream.begin(b2);
    for (const f of frames(small, 3)) stream.chunk(f);
    await stream.end({ ...endFor(b2), sha256: "f".repeat(64) });
    expect(events.badSequence).toEqual([{ sceneVersion: 3, field: "end" }]);
    expect(events.ready).toEqual([]);
  });

  it("end for a version that is not in flight is ignored", async () => {
    await stream.end(endFor({ sceneVersion: 12, sha256: "0".repeat(64) }));
    expect(events).toMatchObject({ ready: [], badSequence: [], checksumMismatch: [] });
  });
});

describe("checksum (T10)", () => {
  it("a tampered last byte → checksumMismatch and no bytes are kept", async () => {
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 8);
    const tampered = bytes.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    stream.begin(begin);
    for (const f of frames(tampered, 8)) stream.chunk(f);
    expect(stream.bytesHeld).toBe(bytes.byteLength);
    await stream.end(endFor(begin));
    expect(events.checksumMismatch).toEqual([{ sceneVersion: 8 }]);
    expect(events.ready).toEqual([]);
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
  });

  it("a failing digest is treated as a mismatch", async () => {
    make({ sha256: () => Promise.reject(new Error("no subtle")) });
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 1);
    stream.begin(begin);
    for (const f of frames(bytes, 1)) stream.chunk(f);
    await stream.end(endFor(begin));
    expect(events.checksumMismatch).toHaveLength(1);
    expect(events.ready).toEqual([]);
  });

  it("a snapshot superseded while hashing is not delivered", async () => {
    let release!: (hex: string) => void;
    make({ sha256: () => new Promise((resolve) => (release = resolve)) });
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 1);
    stream.begin(begin);
    for (const f of frames(bytes, 1)) stream.chunk(f);
    const ending = stream.end(endFor(begin));
    stream.begin(await withHash(bytes, 2));
    release(begin.sha256);
    await ending;
    expect(events.ready).toEqual([]);
    expect(events.aborted).toEqual([{ sceneVersion: 1, reason: "SUPERSEDED" }]);
    expect(stream.activeVersion).toBe(2);
  });

  it.each([
    [
      "abort",
      (s: SnapshotStream) =>
        s.abort({
          protocolVersion: "1.0",
          type: "scene.snapshot.abort",
          sceneVersion: 1,
          reason: "PUBLISHER_GONE",
        }),
      { aborted: [{ sceneVersion: 1, reason: "PUBLISHER_GONE" }], badSequence: [] },
    ],
    ["reset", (s: SnapshotStream) => s.reset(), { aborted: [], badSequence: [] }],
    [
      "a stray chunk",
      (s: SnapshotStream) => s.chunk(frames(glb("asymmetric-2nodes.glb"), 1)[0]!),
      { aborted: [], badSequence: [{ sceneVersion: 1, field: "chunkIndex" }] },
    ],
  ])(
    "%s while hashing: nothing is delivered and the buffer is freed",
    async (_l, act, expected) => {
      let release!: (hex: string) => void;
      make({ sha256: () => new Promise((resolve) => (release = resolve)) });
      const bytes = glb("asymmetric-2nodes.glb");
      const begin = await withHash(bytes, 1);
      stream.begin(begin);
      for (const f of frames(bytes, 1)) stream.chunk(f);
      const ending = stream.end(endFor(begin));
      act(stream);
      expect(stream.bytesHeld).toBe(0);
      release(begin.sha256);
      await ending;
      expect(events.ready).toEqual([]);
      expect(events.checksumMismatch).toEqual([]);
      expect(events).toMatchObject(expected);
    },
  );
});

describe("begin validation and limits", () => {
  it("refuses a snapshot above maxSnapshotBytes without allocating (snapshotTooLarge)", async () => {
    make({ maxSnapshotBytes: 1000 });
    const bytes = glb("asymmetric-2nodes.glb"); // 3400 B
    stream.begin(await withHash(bytes, 1));
    expect(events.tooLarge).toEqual([{ sceneVersion: 1, byteLength: bytes.byteLength }]);
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
    for (const f of frames(bytes, 1)) stream.chunk(f); // silently dropped
    expect(events.badSequence).toEqual([]);
  });

  it("the 64 MiB hard cap (§3.3) holds even when maxSnapshotBytes is set higher", () => {
    make({ maxSnapshotBytes: 2 ** 30 });
    const byteLength = MAX_SNAPSHOT_BYTES + 1;
    stream.begin({
      ...beginFor(new Uint8Array(1), 1),
      byteLength,
      chunkSize: MAX_CHUNK_SIZE,
      chunkCount: Math.ceil(byteLength / MAX_CHUNK_SIZE),
    });
    expect(events.badSequence).toEqual([{ sceneVersion: 1, field: "begin" }]);
    expect(stream.bytesHeld).toBe(0);
  });

  it("a huge announced byteLength is refused without allocating", () => {
    const begin = {
      ...beginFor(new Uint8Array(1), 1),
      byteLength: 2 ** 40,
      chunkCount: 2 ** 40 / MAX_CHUNK_SIZE,
      chunkSize: MAX_CHUNK_SIZE,
    };
    stream.begin(begin);
    expect(events.badSequence).toEqual([{ sceneVersion: 1, field: "begin" }]);
    expect(stream.bytesHeld).toBe(0);
  });

  it.each([
    ["chunkSize below 64 KiB", { chunkSize: 1000, chunkCount: 4 }],
    ["chunkSize above 1 MiB", { chunkSize: MAX_CHUNK_SIZE + 1, chunkCount: 1 }],
    ["chunkCount inconsistent", { chunkCount: 2 }],
    ["zero byteLength", { byteLength: 0, chunkCount: 0 }],
    ["fractional byteLength", { byteLength: 10.5 }],
    ["too many chunks", { byteLength: 65_536 * 1025, chunkCount: 1025 }],
    ["format", { format: "gltf" }],
    ["sha256 not lowercase hex", { sha256: "ABC" }],
    ["fractional sceneVersion", { sceneVersion: 1.5 }],
    ["sceneVersion above uint32", { sceneVersion: 2 ** 32 }],
  ])("rejects an invalid begin: %s", (_label, patch) => {
    stream.begin({ ...beginFor(new Uint8Array(3400), 1), ...patch } as Parameters<
      SnapshotStream["begin"]
    >[0]);
    expect(events.badSequence).toHaveLength(1);
    expect(events.badSequence[0]!.field).toBe("begin");
    expect(stream.bytesHeld).toBe(0);
  });

  it("reset drops the partial buffer", async () => {
    const bytes = glb("large-synthetic.glb");
    stream.begin(await withHash(bytes, 1));
    stream.chunk(frames(bytes, 1)[0]!);
    stream.reset();
    expect(stream.bytesHeld).toBe(0);
    expect(stream.activeVersion).toBeNull();
  });
});

describe("bindSnapshotStream", () => {
  beforeEach(() => MockSocket.reset());

  it("feeds a stream from connection messages and binary frames, and resets on close", async () => {
    const conn = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
    });
    bindSnapshotStream(conn, stream);
    conn.connect({ code: "7KQ4X" });
    const s = MockSocket.last;
    s.open();
    const bytes = glb("large-synthetic.glb");
    const begin = await withHash(bytes, 11);
    s.receive(begin);
    for (const f of frames(bytes, 11).slice(0, 3))
      s.receiveRaw(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
    expect(events.progress).toHaveLength(3);
    expect(stream.activeVersion).toBe(11);
    s.serverClose(1006);
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
  });

  it("completes a snapshot end to end through the connection", async () => {
    const conn = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
    });
    bindSnapshotStream(conn, stream);
    conn.connect({ code: "7KQ4X" });
    const s = MockSocket.last;
    s.open();
    const bytes = glb("asymmetric-2nodes.glb");
    const begin = await withHash(bytes, 1);
    s.receive(begin);
    for (const f of frames(bytes, 1))
      s.receiveRaw(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
    s.receive(endFor(begin));
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(same(events.ready[0]!.bytes, bytes)).toBe(true);
  });

  function joinedStream() {
    const conn = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
    });
    bindSnapshotStream(conn, stream);
    conn.connect({ code: "7KQ4X" });
    const s = MockSocket.last;
    s.open();
    s.receive({
      type: "viewer.joined",
      sessionId: "sess_01K7Q4XMB2TJ9RD6",
      viewerId: "vw_4f2a",
      viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
      sceneVersion: 0,
      snapshotVersion: null,
      snapshotAvailable: false,
      publisherOnline: true,
      viewerCount: 1,
      viewerLimit: 20,
      profile: "mobile",
    });
    expect(conn.state.kind).toBe("connected");
    return { conn, s };
  }

  async function startLarge(s: MockSocket, sceneVersion: number) {
    const bytes = glb("large-synthetic.glb");
    const begin = await withHash(bytes, sceneVersion);
    s.receive(begin);
    for (const f of frames(bytes, sceneVersion).slice(0, 2))
      s.receiveRaw(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
    expect(stream.bytesHeld).toBe(bytes.byteLength);
    return begin;
  }

  it("scene.snapshot.ready mid-stream (deferred to HTTP) frees the partial buffer", async () => {
    const { s } = joinedStream();
    const begin = await startLarge(s, 21);
    s.receive({
      type: "scene.snapshot.ready",
      sceneVersion: 20, // an older cached version leaves the newer stream alone
      byteLength: 3400,
      sha256: begin.sha256,
      format: "glb",
      extensionsRequired: [],
    });
    expect(stream.activeVersion).toBe(21);
    s.receive({
      type: "scene.snapshot.ready",
      sceneVersion: 21,
      byteLength: begin.byteLength,
      sha256: begin.sha256,
      format: "glb",
      extensionsRequired: [],
    });
    expect(stream.activeVersion).toBeNull();
    expect(stream.bytesHeld).toBe(0);
  });

  it("replacing the socket with connect() while connected drops the partial buffer", async () => {
    const { conn, s } = joinedStream();
    await startLarge(s, 3);
    conn.connect({ code: "7KQ4X" });
    expect(stream.bytesHeld).toBe(0);
  });
});
