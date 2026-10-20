import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { connect, Socket } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { registerSceneRoute, SCENE_FETCHES_PER_MINUTE, sceneDownloads } from "../src/http/scene.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = new URL("../../shared/fixtures/glb/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", GLB), "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
const glb = (name: string): Buffer => readFileSync(new URL(name, GLB));
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const LARGE = "large-synthetic.glb";
const SMALL = "asymmetric-2nodes.glb";
const CHUNK = 64 * 1024;
const NOT_FOUND = '{"error":"NOT_FOUND"}';
const MIB = 1024 * 1024;
/** Far more than loopback socket buffers take: a reader that stops leaves the response unfinished. */
const STALLING = 32 * MIB;
/** One random payload for all of them (the relay caches its own copy of each upload). */
const stalling = randomBytes(STALLING);

// Exposed by `execArgv: ["--expose-gc"]` in vitest.config.ts.
declare const gc: () => void;

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
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

/** Sends a whole snapshot and waits for its ack. */
async function upload(client: TestClient, bytes: Uint8Array, sceneVersion: number): Promise<void> {
  const chunkSize = bytes.byteLength > 8 * MIB ? MIB : CHUNK;
  client.send({
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    chunkCount: Math.ceil(bytes.byteLength / chunkSize),
    chunkSize,
    format: "glb",
    extensionsUsed: [],
  });
  for (const { chunkIndex, payload } of chunkify(bytes, chunkSize))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
  client.send({ type: "scene.snapshot.end", sceneVersion, sha256: sha256(bytes) });
  expect((await flush(client)).map((m) => m.type)).toContain("scene.snapshot.ack");
}

interface Setup {
  publisher: TestClient;
  session: Session;
  viewer: TestClient;
  joined: Received;
  token: string;
}

/** A session (with `bytes` cached as version 1 unless null) and one joined viewer. */
async function scene(
  bytes: Uint8Array | null = glb(LARGE),
  logger?: ReturnType<typeof createLogger>,
): Promise<Setup> {
  relay ??= await startRelay(logger === undefined ? {} : { logger });
  const publisher = await connectClient(relay.url);
  publisher.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await publisher.next();
  const session = relay.registry.get(created.sessionId as string)!;
  if (bytes !== null) await upload(publisher, bytes, 1);
  const viewer = await connectClient(relay.url);
  viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
  const joined = await viewer.next();
  expect(joined.type).toBe("viewer.joined");
  return { publisher, session, viewer, joined, token: joined.viewerToken as string };
}

function request(
  path: string,
  options: { token?: string; authorization?: string; method?: string } = {},
): Promise<Response> {
  const base = relay!.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  const headers: Record<string, string> = {};
  const authorization =
    options.authorization ?? (options.token === undefined ? undefined : `Bearer ${options.token}`);
  if (authorization !== undefined) headers.authorization = authorization;
  return fetch(base + path, { method: options.method ?? "GET", headers });
}

/** The exact request target on the wire (`fetch` normalises some, e.g. drops an empty `?`). */
function raw(path: string, token: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(relay!.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, path, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the cached scene (SRV-11 criterion 1, §10, §6.5)", () => {
  it("the version announced in viewer.joined, with its bytes and headers; HEAD without a body", async () => {
    const { joined, token } = await scene();
    expect(joined).toMatchObject({ snapshotVersion: 1, snapshotAvailable: true });
    const response = await request(`/api/scene/${joined.snapshotVersion as number}`, { token });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(sha256(body)).toBe(manifest.files[LARGE]!.sha256);
    expect(sha256(body)).toBe((joined.snapshot as { sha256: string }).sha256);
    const headers = {
      "content-type": "model/gltf-binary",
      "content-length": String(manifest.files[LARGE]!.byteLength),
      etag: `"${manifest.files[LARGE]!.sha256}"`,
      "x-scene-version": "1",
      "cache-control": "private, no-store",
    };
    expect(Object.fromEntries(response.headers)).toMatchObject(headers);

    const head = await request("/api/scene/1", { token, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toMatchObject(headers);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("a viewer that left keeps its entry, and its token, until the session ends", async () => {
    const { viewer, token } = await scene(glb(SMALL));
    viewer.send({ type: "viewer.leave" });
    expect(await viewer.closed).toBe(1000);
    expect((await request("/api/scene/1", { token })).status).toBe(200);
  });

  it("a token yields only its own session's scene (T11)", async () => {
    const a = await scene(glb(SMALL));
    const b = await scene(glb("quantized-1node.glb"));
    const bodyOf = async (token: string) =>
      sha256(Buffer.from(await (await request("/api/scene/1", { token })).arrayBuffer()));
    expect(await bodyOf(a.token)).toBe(manifest.files[SMALL]!.sha256);
    expect(await bodyOf(b.token)).toBe(manifest.files["quantized-1node.glb"]!.sha256);
  });
});

describe("refusals (SRV-11 criterion 2, §10, §12, T8)", () => {
  it("401 without a well-formed Bearer token or with an unknown one", async () => {
    const { token } = await scene(glb(SMALL));
    for (const authorization of [
      undefined,
      "",
      "Bearer",
      `Basic ${token}`,
      `Bearer ${token}!`,
      `Bearer vt_${"A".repeat(43)}`,
      `Bearer ${"A".repeat(200)}`,
    ]) {
      const response = await request(
        "/api/scene/1",
        authorization === undefined ? {} : { authorization },
      );
      expect(response.status, String(authorization)).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.text()).toBe('{"error":"UNAUTHORIZED"}');
    }
    // RFC 9110 §11.1: the scheme is case-insensitive, then one or more spaces.
    for (const authorization of [`bearer ${token}`, `BEARER  ${token}`])
      expect((await request("/api/scene/1", { authorization })).status).toBe(200);
  });

  it("404 for another version, or while nothing is cached yet", async () => {
    const { token } = await scene(glb(SMALL));
    for (const version of ["0", "2", "4294967295"]) {
      const response = await request(`/api/scene/${version}`, { token });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(NOT_FOUND);
    }
    const empty = await scene(null);
    expect((await request("/api/scene/1", { token: empty.token })).status).toBe(404);
  });

  it("410 after session.close and after an expiry; 401 once the relay has forgotten the token", async () => {
    const closed = await scene(glb(SMALL));
    closed.publisher.sendRaw(JSON.stringify(fixture("session.close")));
    await expect.poll(() => relay!.registry.get(closed.session.id)).toBeUndefined();
    const gone = await request("/api/scene/1", { token: closed.token });
    expect(gone.status).toBe(410);
    expect(await gone.text()).toBe('{"error":"GONE"}');

    const expired = await scene(glb(SMALL));
    relay!.registry.expireSession(expired.session, "MAX_LIFETIME");
    expect((await request("/api/scene/1", { token: expired.token })).status).toBe(410);

    relay!.clock.advance(relay!.registry.limits.codeQuarantineS * 1000 + 10_000);
    expect((await request("/api/scene/1", { token: closed.token })).status).toBe(401);
  });

  it(`429 + Retry-After above ${SCENE_FETCHES_PER_MINUTE} requests per minute per token`, async () => {
    const { session, token } = await scene(glb(SMALL));
    const other = await scene(glb(SMALL));
    // A second viewer of the same session has its own allowance.
    const sibling = await connectClient(relay!.url);
    sibling.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const siblingToken = (await sibling.next()).viewerToken as string;
    // Every authenticated request counts, a 404 for another version too.
    for (let i = 0; i < SCENE_FETCHES_PER_MINUTE; i++) {
      const path = i % 2 === 0 ? "/api/scene/1" : "/api/scene/2";
      expect((await request(path, { token, method: "HEAD" })).status).toBe(i % 2 === 0 ? 200 : 404);
    }
    const limited = await request("/api/scene/1", { token });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "RATE_LIMITED", retryAfterS: 60 });
    // Per token: other viewers, in this session or another, are not affected.
    expect((await request("/api/scene/1", { token: siblingToken })).status).toBe(200);
    expect((await request("/api/scene/1", { token: other.token })).status).toBe(200);
    relay!.clock.advance(59_000);
    expect((await request("/api/scene/1", { token })).headers.get("retry-after")).toBe("1");
    relay!.clock.advance(1_000);
    expect((await request("/api/scene/1", { token })).status).toBe(200);
  });
});

describe("nothing in the URL (SRV-11 criterion 3, §10, T6)", () => {
  it("a query string, a code-like path or a malformed version → 404 JSON, nothing echoed", async () => {
    const { session, token } = await scene(glb(SMALL));
    for (const path of [
      `/api/scene/1?code=${session.code}`,
      `/api/scene/1?token=${token}`,
      "/api/scene/1?",
      `/${session.code}`,
      `/j/${session.code}`,
      "/api/scene/01",
      "/api/scene/+1",
      "/api/scene/1.0",
      "/api/scene/-1",
      "/api/scene/4294967296",
      "/api/scene/1/",
      "/api/scene/",
      `/api/scene/${"9".repeat(200)}`, // FST_ERR_MAX_PARAM_LENGTH
      `/api/scene/1#code=${session.code}`,
      "/api/scene/%31",
      "/api/scene/1%3F",
    ]) {
      const response = await raw(path, token);
      expect(response.status, path).toBe(404);
      expect(response.body, path).toBe(NOT_FOUND);
    }
  });
});

describe("logs (NFR-12)", () => {
  it("carry no token and no code on any path", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { session, token } = await scene(glb(SMALL), logger);
    await request("/api/scene/1", { token });
    await request("/api/scene/2", { token });
    await request(`/api/scene/1?code=${session.code}`, { token });
    await request("/api/scene/1", { authorization: `Bearer vt_${"B".repeat(43)}` });
    for (let i = 0; i < SCENE_FETCHES_PER_MINUTE; i++) await request("/api/scene/1", { token });
    relay!.registry.closeSession(session);
    await request("/api/scene/1", { token });
    const fetched = lines.find((l) => l.includes("scene fetched"));
    expect(JSON.parse(fetched!)).toMatchObject({ sessionId: session.id, sceneVersion: 1 });
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(session.code);
      expect(line).not.toContain("Bearer");
    }
  });
});

/** `pipelined` GETs on one connection whose client reads the first response head, then nothing. */
async function stalledDownload(token: string, pipelined = 1): Promise<Socket> {
  const { hostname, port } = new URL(relay?.url ?? "ws://127.0.0.1:0/ws");
  return stalledAt(hostname, Number(port), token, pipelined);
}

function stalledAt(host: string, port: number, token: string, pipelined = 1): Promise<Socket> {
  const socket = connect(port, host);
  socket.on("error", () => {});
  const get = `GET /api/scene/1 HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer ${token}\r\n\r\n`;
  socket.write(get.repeat(pipelined));
  return new Promise((resolve) =>
    socket.once("data", (head: Buffer) => {
      expect(head.toString("latin1")).toMatch(/^HTTP\/1\.1 200/);
      socket.pause();
      resolve(socket);
    }),
  );
}

/** Lets the response settle, then reports whether the Buffer was collected. */
async function collected(ref: WeakRef<Buffer>): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

// 32 MiB uploads and downloads: slow on a loaded CI runner.
describe(
  "a download never outlives the cached Buffer it sends (NFR-10, §6.4)",
  { timeout: 30_000 },
  () => {
    it("the session ending ends a stalled download and frees its Buffer", async () => {
      const { publisher, session, token } = await scene(stalling);
      const socket = await stalledDownload(token);
      const ref = new WeakRef(session.snapshot!.buffer);
      publisher.sendRaw(JSON.stringify(fixture("session.close")));
      await expect.poll(() => relay!.registry.get(session.id)).toBeUndefined();
      expect(await collected(ref)).toBe(true);
      socket.destroy();
    });

    it("a newer snapshot ends a stalled download of the old one and frees the old Buffer", async () => {
      const { publisher, session, token } = await scene(stalling);
      const socket = await stalledDownload(token);
      const ref = new WeakRef(session.snapshot!.buffer);
      await upload(publisher, glb(SMALL), 2);
      expect(session.snapshot?.sceneVersion).toBe(2);
      expect(await collected(ref)).toBe(true);
      // The new version downloads normally.
      expect((await request("/api/scene/2", { token })).status).toBe(200);
      socket.destroy();
    });

    it("…also with pipelined requests queued behind it: session end", async () => {
      const { publisher, session, token } = await scene(stalling);
      const socket = await stalledDownload(token, 3);
      const ref = new WeakRef(session.snapshot!.buffer);
      publisher.sendRaw(JSON.stringify(fixture("session.close")));
      await expect.poll(() => relay!.registry.get(session.id)).toBeUndefined();
      expect(await collected(ref)).toBe(true);
      socket.destroy();
    });

    it("…also with pipelined requests queued behind it: newer snapshot", async () => {
      const { publisher, session, token } = await scene(stalling);
      const socket = await stalledDownload(token, 3);
      const ref = new WeakRef(session.snapshot!.buffer);
      await upload(publisher, glb(SMALL), 2);
      expect(await collected(ref)).toBe(true);
      socket.destroy();
    });

    it("a shutdown does not wait for a stalled download", async () => {
      const { token } = await scene(stalling);
      const socket = await stalledDownload(token);
      const started = performance.now();
      const closing = relay!;
      relay = undefined;
      await closing.close();
      expect(performance.now() - started).toBeLessThan(2_000);
      socket.destroy();
    });

    /** The route on a bare Fastify instance, so the download tracker can be inspected. */
    async function bare(stallMs = 60_000) {
      const config = loadConfig({});
      const registry = new Registry({ ...config, clock: new ManualClock() });
      const downloads = sceneDownloads({ registry, stallMs });
      const app = Fastify();
      registerSceneRoute(app, {
        registry,
        clock: new ManualClock(),
        logger: createLogger({ level: "silent" }),
        downloads,
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const session = registry.createSession("mobile").session;
      const buffer = Buffer.from(stalling);
      session.snapshot = {
        buffer,
        sha256: sha256(buffer),
        byteLength: buffer.byteLength,
        sceneVersion: 1,
        extensionsRequired: [],
      };
      const peer = { send: () => {}, forward: () => {}, bufferedAmount: 0, close: () => {} };
      const { viewerToken } = registry.addViewer(session, peer, "web");
      const { port } = app.server.address() as { port: number };
      const close = async () => {
        downloads.dispose();
        await app.close();
      };
      return { registry, downloads, session, port, token: viewerToken, close, server: app.server };
    }

    it("a client that takes nothing for the stall time is dropped, pipelined requests too", async () => {
      const b = await bare(300);
      try {
        const socket = await stalledAt("127.0.0.1", b.port, b.token, 3);
        expect(b.downloads.size).toBe(3);
        await expect.poll(() => b.downloads.size, { timeout: 3_000 }).toBe(0);
        expect(b.downloads.sessions).toBe(0);
        socket.destroy();
      } finally {
        await b.close();
      }
    });

    it("a client that hangs up forgets its downloads, pipelined ones included", async () => {
      const b = await bare();
      try {
        const socket = await stalledAt("127.0.0.1", b.port, b.token, 5);
        expect(b.downloads.size).toBe(5);
        socket.resetAndDestroy();
        await expect.poll(() => b.downloads.size).toBe(0);
        expect(b.downloads.sessions).toBe(0);
      } finally {
        await b.close();
      }
    });

    it("the session ending forgets its downloads at once", async () => {
      const b = await bare();
      try {
        const socket = await stalledAt("127.0.0.1", b.port, b.token, 3);
        b.registry.closeSession(b.session);
        expect([b.downloads.size, b.downloads.sessions]).toEqual([0, 0]);
        socket.destroy();
      } finally {
        await b.close();
      }
    });

    it("many pipelined downloads share one pair of connection listeners (no MaxListeners warning)", async () => {
      const b = await bare();
      const warnings: Error[] = [];
      const onWarning = (warning: Error) => warnings.push(warning);
      process.on("warning", onWarning);
      try {
        const socket = await stalledAt("127.0.0.1", b.port, b.token, 12);
        await expect.poll(() => b.downloads.size).toBe(12);
        socket.resetAndDestroy();
        await expect.poll(() => b.downloads.size).toBe(0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(warnings.map((w) => w.name)).not.toContain("MaxListenersExceededWarning");
      } finally {
        process.off("warning", onWarning);
        await b.close();
      }
    });

    it("finished downloads leave no listener on a keep-alive connection", async () => {
      const b = await bare();
      let server: Socket | undefined;
      b.server.on("connection", (socket: Socket) => (server = socket));
      try {
        const socket = connect(b.port, "127.0.0.1");
        await new Promise((resolve) => socket.once("connect", resolve));
        await expect.poll(() => server !== undefined).toBe(true);
        const baseline = [server!.listenerCount("close"), server!.listenerCount("timeout")];
        for (let i = 0; i < 3; i++) {
          const done = new Promise<void>((resolve) => {
            let received = 0;
            const onData = (data: Buffer) => {
              received += data.byteLength;
              if (received >= STALLING) {
                socket.off("data", onData);
                resolve();
              }
            };
            socket.on("data", onData);
          });
          socket.write(
            `GET /api/scene/1 HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer ${b.token}\r\n\r\n`,
          );
          await done;
          await expect.poll(() => b.downloads.size).toBe(0);
          expect([server!.listenerCount("close"), server!.listenerCount("timeout")]).toEqual(
            baseline,
          );
        }
        socket.destroy();
      } finally {
        await b.close();
      }
    });

    it("a request whose connection is already gone is not tracked", () => {
      const registry = new Registry({ ...loadConfig({}), clock: new ManualClock() });
      const downloads = sceneDownloads({ registry });
      const session = registry.createSession("mobile").session;
      const socket = new Socket();
      socket.destroy();
      downloads.track(session, new EventEmitter() as unknown as ServerResponse, socket);
      expect([downloads.size, downloads.sessions]).toEqual([0, 0]);
      downloads.dispose();
    });

    it("a download that keeps progressing outlives the stall time", async () => {
      const b = await bare(300);
      try {
        const socket = connect(b.port, "127.0.0.1");
        socket.write(
          `GET /api/scene/1 HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer ${b.token}\r\nConnection: close\r\n\r\n`,
        );
        let received = 0;
        socket.on("data", (data: Buffer) => (received += data.byteLength));
        // Short reads with pauses: never 300 ms without progress, but well over 300 ms in all.
        const pacer = setInterval(() => {
          socket.resume();
          setTimeout(() => socket.pause(), 5);
        }, 150);
        socket.pause();
        const started = performance.now();
        await new Promise((resolve) => socket.once("close", resolve));
        clearInterval(pacer);
        expect(performance.now() - started).toBeGreaterThan(300);
        expect(received).toBeGreaterThan(STALLING);
        expect(b.downloads.size).toBe(0);
      } finally {
        await b.close();
      }
    });
  },
);
