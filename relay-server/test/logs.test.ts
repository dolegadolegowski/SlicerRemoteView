import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame } from "@slicerremoteview/shared";
import { buildApp } from "../src/app.js";
import { generateCode } from "../src/codes.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB_FILE = new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url);
const glb = readFileSync(GLB_FILE);
const CHUNK = 64 * 1024; // the smallest chunk size (§6.2): one chunk here
const PUBLISHER_IP = "203.0.113.7";
const VIEWER_IP = "198.51.100.9";

let relay: TestRelay | undefined;
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
});

/**
 * The strings of the GLB's JSON chunk that must never reach a log: the generator, every `name`
 * (scenes, nodes, meshes, materials, extras) and the MRML ids in the extras.
 */
function glbStrings(data: Buffer): string[] {
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString("utf8")) as {
    asset: { generator?: string };
  };
  const found = new Set<string>(json.asset.generator === undefined ? [] : [json.asset.generator]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null)
      for (const [key, inner] of Object.entries(value)) {
        if (["name", "nodeId", "mrmlId", "segmentId"].includes(key) && typeof inner === "string")
          found.add(inner);
        walk(inner);
      }
  };
  walk(json);
  return [...found];
}

/**
 * How any part of the GLB would look in a log line: the magic, and at every offset 16 bytes as hex,
 * 18 as base64 (every alignment) and 12 as a number list (a Buffer or typed array serialised).
 */
function byteForms(data: Buffer): string[] {
  const forms = [data.subarray(0, 4).toString("latin1")];
  for (let offset = 0; offset + 12 <= data.length; offset++) {
    forms.push(Array.from(data.subarray(offset, offset + 12)).join(","));
    if (offset + 16 <= data.length) forms.push(data.subarray(offset, offset + 16).toString("hex"));
    if (offset + 18 <= data.length)
      forms.push(data.subarray(offset, offset + 18).toString("base64"));
  }
  return forms;
}

async function next(client: TestClient, type: string): Promise<Received> {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message;
  }
}

describe("a whole session at trace level leaves no secret in the logs (SRV-18, FR-29, NFR-12, T6)", () => {
  it("no code, token, client address, node name or GLB byte; every line is one JSON object", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } });
    const config = loadConfig({
      TRUST_PROXY: "true",
      ALLOWED_ORIGINS: "https://relay.example.org",
      MAX_TOTAL_BUFFERED_BYTES: String(96 * 1024 * 1024),
    });
    relay = await startRelay({ logger, config });

    // Publisher: create.
    const publisher = await connectClient(relay.url, { "X-Forwarded-For": PUBLISHER_IP });
    publisher.sendRaw(JSON.stringify(fixture("session.create")));
    const created = await publisher.next();
    expect(created.type).toBe("session.created");
    const code = created.code as string;
    const publisherToken = created.publisherToken as string;

    // A viewer with a wrong code (criterion 2), then one with the right code.
    const wrongCode = generateCode((c) => c === code);
    const guesser = await connectClient(relay.url, { "X-Forwarded-For": VIEWER_IP });
    guesser.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: wrongCode }));
    // Logged when refused; the answer follows after the 50–150 ms jitter (on the manual clock).
    await expect.poll(() => lines.some((l) => l.includes('"errorCode":"INVALID_CODE"'))).toBe(true);
    relay.clock.advance(200);
    expect(await guesser.next()).toMatchObject({ type: "error", code: "INVALID_CODE" });
    expect(await guesser.closed).toBe(4004);

    const viewer = await connectClient(relay.url, { "X-Forwarded-For": VIEWER_IP });
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: code.toLowerCase() }));
    const joined = await viewer.next();
    expect(joined.type).toBe("viewer.joined");
    const viewerToken = joined.viewerToken as string;

    // Snapshot: begin, chunks, end; the viewer gets it streamed, then also fetches it over HTTP.
    const sha256 = createHash("sha256").update(glb).digest("hex");
    publisher.send({
      type: "scene.snapshot.begin",
      id: "b-1",
      sceneVersion: 1,
      byteLength: glb.byteLength,
      sha256,
      chunkCount: Math.ceil(glb.byteLength / CHUNK),
      chunkSize: CHUNK,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 2,
    });
    for (const { chunkIndex, payload } of chunkify(glb, CHUNK))
      publisher.sendRaw(
        Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload)),
        true,
      );
    publisher.send({ type: "scene.snapshot.end", id: "e-1", sceneVersion: 1, sha256 });
    expect(await next(publisher, "scene.snapshot.ack")).toMatchObject({ sceneVersion: 1 });
    await next(viewer, "scene.snapshot.end");

    const base = relay.url.replace("ws://", "http://").replace(/\/ws$/, "");
    const fetched = await fetch(`${base}/api/scene/1`, {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-Forwarded-For": VIEWER_IP },
    });
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(glb)).toBe(true);
    const refused = await fetch(`${base}/api/scene/1`, {
      headers: { Authorization: `Bearer ${publisherToken}`, "X-Forwarded-For": VIEWER_IP },
    });
    expect(refused.status).toBe(401);

    // Leave and close; the relay too, so that its shutdown lines are part of the grep.
    viewer.sendRaw(JSON.stringify(fixture("viewer.leave")));
    expect(await viewer.closed).toBe(1000);
    publisher.sendRaw(JSON.stringify(fixture("session.close")));
    expect(await publisher.closed).toBe(1000);
    const closing = relay;
    relay = undefined;
    await closing.close();

    // NFR-35: one JSON object per line with `level`, `time`, `message`.
    expect(lines.length).toBeGreaterThan(5);
    const parsed = lines.map((line) => {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trimEnd()).not.toContain("\n");
      return JSON.parse(line) as Record<string, unknown>;
    });
    for (const [i, entry] of parsed.entries()) {
      // No line long enough to hold the 3,400-byte scene in any encoding.
      expect(lines[i]!.length).toBeLessThan(1024);
      expect(typeof entry.level).toBe("string");
      expect(typeof entry.time).toBe("number");
      expect(typeof entry.message).toBe("string");
    }

    // Criterion 1 (and 2: the refused join is logged by its error code only).
    const text = lines.join("");
    // A code as a word of its own, in either case: five letters may well occur inside other words
    // (`start`, `cache` are valid codes).
    for (const c of [code, wrongCode])
      expect(text).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`, "i"));
    const secrets = [
      publisherToken,
      viewerToken,
      "127.0.0.1",
      PUBLISHER_IP,
      VIEWER_IP,
      ...glbStrings(glb),
      ...byteForms(glb),
    ];
    expect(secrets).toContain("SlicerRemoteView 0.1.0-fixtures");
    expect(secrets).toContain("vtkMRMLModelNode2");
    expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
    expect(text).not.toContain("SlicerRemoteView");
    expect(text).not.toMatch(/"type":"Buffer"|"0":\d+,"1":\d+/);
    expect(parsed.some((l) => l.errorCode === "INVALID_CODE")).toBe(true);

    // The startup and first-upgrade lines for the DEP-06 checklist.
    expect(parsed.filter((l) => l.message === "relay starting")).toEqual([
      expect.objectContaining({
        level: "info",
        heapSizeLimit: expect.any(Number) as number,
        maxTotalBufferedBytes: config.maxTotalBufferedBytes,
        maxTotalSnapshotBytes: config.maxTotalSnapshotBytes,
        trustProxy: true,
      }),
    ]);
    expect(parsed.filter((l) => l.message === "first websocket upgrade")).toEqual([
      expect.objectContaining({
        level: "info",
        xff: "present",
        xffEntries: 1,
        clientKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      }),
    ]);
  });

  it("xff: absent (and no entry count) when the edge sends no X-Forwarded-For", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (l) => lines.push(l) } });
    relay = await startRelay({ logger });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect((await client.next()).type).toBe("session.created");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const [first, ...more] = parsed.filter((l) => l.message === "first websocket upgrade");
    expect(more).toEqual([]);
    expect(first).toMatchObject({ xff: "absent" });
    expect(first).not.toHaveProperty("xffEntries");
  });
});

describe("GET /healthz stays status-only (SRV-18 criterion 3)", () => {
  it("exactly {status, uptimeS, sessions, version}: no heap, rss or memory figures", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["sessions", "status", "uptimeS", "version"]);
      expect(res.body).not.toMatch(/heap|rss|memory/i);
    } finally {
      await app.close();
    }
  });
});
