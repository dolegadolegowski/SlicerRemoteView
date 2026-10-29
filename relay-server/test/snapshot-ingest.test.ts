import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import type { Session } from "../src/registry.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = new URL("../../shared/fixtures/glb/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", GLB), "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
const glb = (name: string): Buffer => readFileSync(new URL(name, GLB));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const KIB = 1024;

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function publisher(
  env: Record<string, string> = {},
): Promise<{ client: TestClient; session: Session }> {
  relay ??= await startRelay({
    config: loadConfig({
      TRUST_PROXY: "false",
      ALLOWED_ORIGINS: "https://relay.example.org",
      ...env,
    }),
  });
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  return { client, session: relay.registry.get(created.sessionId as string)! };
}

function begin(bytes: Uint8Array, sceneVersion: number, chunkSize = 64 * KIB, extra = {}) {
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
    ...extra,
  };
}

function sendChunks(
  client: TestClient,
  bytes: Uint8Array,
  sceneVersion: number,
  chunkSize = 64 * KIB,
) {
  for (const { chunkIndex, payload } of chunkify(bytes, chunkSize))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
}

/** Round trip: everything sent before has been handled. */
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

describe("chunk ingest (SRV-09 criterion 1, §6.1–§6.3)", () => {
  it.each(["asymmetric-2nodes.glb", "large-synthetic.glb"])(
    "streaming %s in 64 KiB chunks fills the buffer with the manifest's bytes",
    async (name) => {
      const { client, session } = await publisher();
      const bytes = glb(name);
      client.send(begin(bytes, 1));
      sendChunks(client, bytes, 1);
      expect(await flush(client)).toEqual([]);
      expect(session.assembling).toMatchObject({
        sceneVersion: 1,
        nextIndex: Math.ceil(bytes.byteLength / (64 * KIB)),
      });
      expect(sha256(session.assembling!.buffer)).toBe(manifest.files[name]!.sha256);
    },
  );

  it("allocates one zero-filled buffer of its own at begin (no pool slice, T11)", async () => {
    const { client, session } = await publisher();
    const bytes = glb("large-synthetic.glb");
    client.send(begin(bytes, 1));
    expect(await flush(client)).toEqual([]);
    const { buffer } = session.assembling!;
    expect(buffer.byteLength).toBe(bytes.byteLength);
    expect([buffer.byteOffset, buffer.buffer.byteLength]).toEqual([0, bytes.byteLength]);
    expect(buffer.every((b) => b === 0)).toBe(true);
  });

  it.each([
    ["chunkCount 1025", { chunkCount: 1025 }, "/chunkCount"],
    ["chunkSize 32 KiB", { chunkSize: 32 * KIB }, "/chunkSize"],
    ["chunkCount ≠ ceil(byteLength / chunkSize)", { chunkCount: 2 }, "/chunkCount"],
  ])("%s → INVALID_MESSAGE", async (_name, extra, instancePath) => {
    const { client, session } = await publisher();
    client.send(begin(glb("asymmetric-2nodes.glb"), 1, 64 * KIB, extra));
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "INVALID_MESSAGE",
        replyTo: "b-1",
        details: { instancePath },
      }),
    ]);
    expect(session.assembling).toBeUndefined();
  });
});

describe("begin limits and chunk order (SRV-09 criterion 2, §3.3, §6.3, FR-34, NFR-23, T2)", () => {
  it("byteLength 67,108,865 → PAYLOAD_TOO_LARGE, and that version's chunks are ignored", async () => {
    const { client, session } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    client.send({ ...begin(bytes, 1), byteLength: 67_108_865, chunkCount: 1024 });
    sendChunks(client, bytes, 1);
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
        replyTo: "b-1",
        retryable: false,
        details: { maxSnapshotBytes: 67_108_864 },
      }),
    ]);
    expect(session.assembling).toBeUndefined();
  });

  it("a byteLength above a lower configured MAX_SNAPSHOT_BYTES → PAYLOAD_TOO_LARGE", async () => {
    const { client } = await publisher({ MAX_SNAPSHOT_BYTES: String(1024 * KIB) });
    client.send({
      ...begin(glb("asymmetric-2nodes.glb"), 1),
      byteLength: 1024 * KIB + 1,
      chunkCount: 17,
    });
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "PAYLOAD_TOO_LARGE",
        details: { maxSnapshotBytes: 1024 * KIB },
      }),
    ]);
  });

  const frames = (bytes: Uint8Array, sceneVersion: number) =>
    [...chunkify(bytes, 64 * KIB)].map(({ chunkIndex, payload }) =>
      Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)),
    );

  it.each([
    ["a duplicate chunkIndex", (f: Buffer[]) => [f[0]!, f[1]!, f[1]!], "chunkIndex"],
    ["a skipped chunkIndex", (f: Buffer[]) => [f[0]!, f[2]!], "chunkIndex"],
    [
      "a wrong payload size",
      (f: Buffer[]) => [f[0]!, f[1]!.subarray(0, f[1]!.byteLength - 1)],
      "payload",
    ],
    ["a stale sceneVersion", (f: Buffer[], stale: Buffer[]) => [f[0]!, stale[1]!], "sceneVersion"],
    [
      "wrong magic",
      (f: Buffer[]) => [f[0]!, Buffer.concat([Buffer.from("XXXX"), f[1]!.subarray(4)])],
      "magic",
    ],
    ["a frame shorter than the header", (f: Buffer[]) => [f[0]!, f[1]!.subarray(0, 8)], "length"],
  ])(
    "%s → BAD_SEQUENCE naming the field; the snapshot is discarded and its later chunks ignored",
    async (_name, pick, field) => {
      const { client, session } = await publisher();
      const bytes = glb("large-synthetic.glb");
      const f = frames(bytes, 2);
      const stale = frames(bytes, 1);
      client.send(begin(bytes, 2));
      for (const frame of pick(f, stale)) client.sendRaw(frame, true);
      for (const frame of f.slice(3)) client.sendRaw(frame, true); // the rest of version 2: ignored
      expect(await flush(client)).toEqual([
        expect.objectContaining({
          type: "error",
          code: "BAD_SEQUENCE",
          retryable: true,
          details: { field },
        }),
      ]);
      expect(session.assembling).toBeUndefined();
      // The publisher starts again with a new version, which streams normally.
      client.send(begin(bytes, 3));
      sendChunks(client, bytes, 3);
      expect(await flush(client)).toEqual([]);
      expect(sha256(session.assembling!.buffer)).toBe(
        manifest.files["large-synthetic.glb"]!.sha256,
      );
    },
  );

  it("a begin whose sceneVersion is not above every version used so far → BAD_SEQUENCE", async () => {
    const { client, session } = await publisher();
    const bytes = glb("large-synthetic.glb");
    client.send(begin(bytes, 5));
    client.send({ ...begin(bytes, 5), id: "again" }); // also discards v5 in flight (§9.2)
    sendChunks(client, bytes, 5); // ignored, no further violation
    client.send({ ...begin(bytes, 4), id: "older" });
    sendChunks(client, bytes, 4); // chunks of the refused version: ignored as well
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "BAD_SEQUENCE",
        replyTo: "again",
        details: { field: "sceneVersion" },
      }),
      expect.objectContaining({
        code: "BAD_SEQUENCE",
        replyTo: "older",
        details: { field: "sceneVersion" },
      }),
    ]);
    expect(session.assembling).toBeUndefined();
    expect(relay!.registry.snapshotBytes).toBe(0);
  });

  it("a sceneVersion above uint32 → INVALID_MESSAGE (the chunk header carries a uint32)", async () => {
    const { client, session } = await publisher();
    client.send(begin(glb("asymmetric-2nodes.glb"), 2 ** 32));
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "INVALID_MESSAGE",
        details: { instancePath: "/sceneVersion" },
      }),
    ]);
    expect(session.lastSnapshotVersion).toBe(0);
  });

  it("the chunks of a begin refused for its chunkCount are ignored", async () => {
    const { client, session } = await publisher();
    const bytes = glb("large-synthetic.glb");
    client.send({ ...begin(bytes, 1), chunkCount: 75 });
    sendChunks(client, bytes, 1);
    expect(await flush(client)).toEqual([
      expect.objectContaining({
        code: "INVALID_MESSAGE",
        details: { instancePath: "/chunkCount" },
      }),
    ]);
    expect(session.assembling).toBeUndefined();
  });

  it("a begin the schema rejects reserves nothing: its chunks are unknown-version violations", async () => {
    const { client } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    client.send({ ...begin(bytes, 1), chunkSize: 32 * KIB });
    sendChunks(client, bytes, 1);
    expect(await flush(client)).toEqual([
      expect.objectContaining({ code: "INVALID_MESSAGE", details: { instancePath: "/chunkSize" } }),
      expect.objectContaining({ code: "BAD_SEQUENCE", details: { field: "sceneVersion" } }),
    ]);
  });

  it("a binary frame above 1 MiB + 12 B → PAYLOAD_TOO_LARGE + 1009 (§3.3)", async () => {
    const { client } = await publisher();
    const payload = Buffer.alloc(1024 * KIB + 1);
    client.send({ ...begin(payload, 1, 1024 * KIB) });
    client.sendRaw(
      Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex: 0 }, payload)),
      true,
    );
    expect(await client.next()).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      retryable: false,
      details: { maxChunkBytes: 1024 * KIB },
    });
    expect(await client.closed).toBe(1009);
  });

  it("INVALID_MESSAGE and BAD_SEQUENCE share one strike counter; PAYLOAD_TOO_LARGE is no strike", async () => {
    const { client } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    client.sendRaw("{not json");
    expect(await client.next()).toMatchObject({ code: "INVALID_MESSAGE" });
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion: 9, chunkIndex: 0 }, bytes)), true);
    expect(await client.next()).toMatchObject({ code: "BAD_SEQUENCE" });
    client.send({ ...begin(bytes, 1), byteLength: 67_108_865, chunkCount: 1024 });
    expect(await client.next()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(client.ws.readyState).toBe(1);
    client.sendRaw("{not json either");
    expect(await client.next()).toMatchObject({ code: "INVALID_MESSAGE" });
    expect(await client.closed).toBe(4007);
  });

  it("a chunk with no snapshot in flight → BAD_SEQUENCE{sceneVersion}; the third violation closes 4007", async () => {
    const { client } = await publisher();
    const bytes = glb("asymmetric-2nodes.glb");
    for (let version = 1; version <= 3; version++)
      client.sendRaw(
        Buffer.from(encodeChunkFrame({ sceneVersion: 7 + version, chunkIndex: 0 }, bytes)),
        true,
      );
    for (let strike = 0; strike < 3; strike++)
      expect(await client.next()).toMatchObject({
        code: "BAD_SEQUENCE",
        details: { field: "sceneVersion" },
      });
    expect(await client.closed).toBe(4007);
  });

  it("CAPACITY when cached + in-flight snapshots of all sessions would exceed MAX_TOTAL_SNAPSHOT_BYTES", async () => {
    const env = {
      MAX_SNAPSHOT_BYTES: String(4 * 1024 * KIB),
      MAX_TOTAL_SNAPSHOT_BYTES: String(8 * 1024 * KIB),
    };
    const a = await publisher(env);
    const b = await publisher(env);
    const big = (version: number, byteLength: number) => ({
      ...begin(glb("asymmetric-2nodes.glb"), version),
      byteLength,
      chunkSize: 1024 * KIB,
      chunkCount: Math.ceil(byteLength / (1024 * KIB)),
    });
    a.client.send(big(1, 4 * 1024 * KIB));
    b.client.send(big(1, 3 * 1024 * KIB));
    expect(await flush(a.client)).toEqual([]);
    expect(await flush(b.client)).toEqual([]);
    // 7 MiB in flight: 2 MiB more would exceed 8 MiB …
    b.client.send({ ...big(2, 2 * 1024 * KIB), id: "b-over" });
    expect(await flush(b.client)).toEqual([]); // … unless it replaces b's own 3 MiB in flight
    a.client.send({ ...big(2, 4 * 1024 * KIB), id: "a-same" }); // replaces a's own 4 MiB: fits
    expect(await flush(a.client)).toEqual([]);
    const c = await publisher(env);
    c.client.send({ ...big(1, 3 * 1024 * KIB), id: "c-over" }); // 4 + 2 + 3 > 8
    const filler = Buffer.alloc(3 * 1024 * KIB);
    sendChunks(c.client, filler, 1, 1024 * KIB); // that version's chunks: ignored
    expect(await flush(c.client)).toEqual([
      expect.objectContaining({ code: "CAPACITY", replyTo: "c-over", retryable: true }),
    ]);
    expect(relay!.registry.snapshotBytes).toBe(6 * 1024 * KIB);
  });
});

describe("the relay never parses GLB content (SRV-09 criterion 3, T10)", () => {
  it.each(["bad-magic.glb", "truncated.glb"])(
    "%s is assembled byte for byte like any other payload",
    async (name) => {
      const { client, session } = await publisher();
      const bytes = glb(name);
      client.send(begin(bytes, 1));
      sendChunks(client, bytes, 1);
      expect(await flush(client)).toEqual([]);
      expect(Buffer.compare(session.assembling!.buffer, bytes)).toBe(0);
    },
  );

  it("random bytes too", async () => {
    const { client, session } = await publisher();
    const bytes = Buffer.from(Array.from({ length: 200 * KIB }, (_, i) => (i * 7919) % 251));
    client.send(begin(bytes, 1));
    sendChunks(client, bytes, 1);
    expect(await flush(client)).toEqual([]);
    expect(Buffer.compare(session.assembling!.buffer, bytes)).toBe(0);
  });
});
