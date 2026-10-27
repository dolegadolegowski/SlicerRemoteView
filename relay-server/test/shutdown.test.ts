import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { SHUTDOWN_FLUSH_MS, shutdownFlushMs } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Connection } from "../src/ws/connection.js";
import { fixture } from "./helpers/fixtures.js";
import { childEnv } from "./helpers/env.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GLB = readFileSync(
  new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url),
);
const SHA256 = createHash("sha256").update(GLB).digest("hex");

async function nextValid(client: TestClient): Promise<Received> {
  const message = await client.next();
  expect(validateMessage(message)).toMatchObject({ ok: true });
  return message;
}

/** A publisher with a cached snapshot, one joined viewer and one socket that never sent a message. */
async function threeSockets(url: string): Promise<{
  publisher: TestClient;
  viewer: TestClient;
  unbound: TestClient;
  secrets: string[];
}> {
  const publisher = await connectClient(url);
  publisher.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await nextValid(publisher);
  publisher.send({
    type: "scene.snapshot.begin",
    sceneVersion: 1,
    byteLength: GLB.byteLength,
    sha256: SHA256,
    chunkCount: 1,
    chunkSize: 64 * 1024,
    format: "glb",
    extensionsUsed: [],
    nodeCount: 2,
  });
  for (const { chunkIndex, payload } of chunkify(GLB, 64 * 1024))
    publisher.sendRaw(
      Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload)),
      true,
    );
  publisher.send({ type: "scene.snapshot.end", sceneVersion: 1, sha256: SHA256 });
  expect((await nextValid(publisher)).type).toBe("scene.snapshot.ack");
  const viewer = await connectClient(url);
  viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: created.code }));
  const joined = await nextValid(viewer);
  expect(joined.type).toBe("viewer.joined");
  for (const type of ["scene.state", "viewer.count"])
    expect((await nextValid(viewer)).type).toBe(type);
  expect((await nextValid(publisher)).type).toBe("viewer.count");
  const unbound = await connectClient(url);
  const secrets = [created.code, created.publisherToken, joined.viewerToken] as string[];
  return { publisher, viewer, unbound, secrets };
}

describe("shutdown shortcuts", () => {
  it("waits ≤ 5 s, within RAILWAY_DEPLOYMENT_DRAINING_SECONDS less 1 s", () => {
    expect(shutdownFlushMs(30)).toBe(SHUTDOWN_FLUSH_MS);
    expect(shutdownFlushMs(4)).toBe(3_000);
    expect(shutdownFlushMs(1)).toBe(0);
    expect(shutdownFlushMs(0)).toBe(0);
  });
});

describe("SIGTERM on the real entry (criterion 1)", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  /** Starts `src/index.ts`; resolves with its port, its log lines and its exit code. */
  async function relayProcess(env: Record<string, string>): Promise<{
    port: number;
    lines: string[];
    exited: Promise<number | null>;
  }> {
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env: childEnv({ PORT: "0", NODE_ENV: "test", ...env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // `close`, not `exit`: by then its stdout has been read to the end.
    const exited = new Promise<number | null>((resolve) => child!.once("close", resolve));
    const port = await new Promise<number>((resolve, reject) => {
      createInterface({ input: child!.stdout! }).on("line", (line) => {
        lines.push(line);
        try {
          const entry = JSON.parse(line) as { message?: string; port?: number };
          if (entry.message === "relay listening" && entry.port) resolve(entry.port);
        } catch (error) {
          reject(error as Error); // every line is one JSON object (SRV-18)
        }
      });
      void exited.then((code) => reject(new Error(`relay exited early with ${code}: ${stderr}`)));
    });
    return { port, lines, exited };
  }

  it("3 connected sockets each get close 4008 within 1 s and nothing else; the process exits 0 within 6 s", async () => {
    const relay = await relayProcess({
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
      LOG_LEVEL: "debug",
    });
    const sockets = await threeSockets(`ws://127.0.0.1:${relay.port}/ws`);
    const clients = [sockets.publisher, sockets.viewer, sockets.unbound];
    const before = clients.map((c) => c.received.length);

    const killedAt = performance.now();
    child!.kill("SIGTERM");
    const closedAfter = await Promise.all(
      clients.map((c) => c.closed.then((code) => ({ code, ms: performance.now() - killedAt }))),
    );
    for (const { code, ms } of closedAfter) {
      expect(code).toBe(4008);
      expect(ms).toBeLessThan(1_000);
    }
    // No session.* message (§4.5, §9.3): sessions do not survive a restart.
    expect(clients.map((c) => c.received.length)).toEqual(before);
    expect(await relay.exited).toBe(0);
    expect(performance.now() - killedAt).toBeLessThan(6_000);
    const entries = relay.lines.map(
      (l) => JSON.parse(l) as { message?: string; closeCode?: number },
    );
    const messages = entries.map((entry) => entry.message);
    expect(messages).toContain("draining for a restart");
    // Out through the drain, not the safety exit: every socket's close completed first.
    expect(messages).not.toContain("shutdown timed out");
    expect(entries.filter((e) => e.message === "websocket closed").map((e) => e.closeCode)).toEqual(
      [4008, 4008, 4008],
    );
    // Nothing secret on the way out either, debug lines included.
    for (const line of relay.lines)
      for (const secret of sockets.secrets) expect(line).not.toContain(secret);
  }, 30_000);

  it("a half-sent HTTP request does not hold the exit (the app closes every connection)", async () => {
    const relay = await relayProcess({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30" });
    const half = connect(relay.port, "127.0.0.1");
    half.on("error", () => {}); // ECONNRESET when the relay cuts it on the way out is the point
    onTestFinished(() => void half.destroy());
    await once(half, "connect");
    half.write("GET /healthz HTTP/1.1\r\nHost: relay\r\n"); // the headers never end
    const killedAt = performance.now();
    child!.kill("SIGTERM");
    expect(await relay.exited).toBe(0);
    expect(performance.now() - killedAt).toBeLessThan(2_000); // not the 5.5 s safety exit
  }, 30_000);

  it("a second signal during the drain forces the exit (1) at once", async () => {
    const relay = await relayProcess({ RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30" });
    const stuck = await connectClient(`ws://127.0.0.1:${relay.port}/ws`);
    stuck.ws.pause(); // holds the drain for its 5 s
    child!.kill("SIGTERM");
    await expect
      .poll(() => relay.lines.some((l) => l.includes('"shutting down"')), { timeout: 5_000 })
      .toBe(true);
    const forcedAt = performance.now();
    child!.kill("SIGINT");
    expect(await relay.exited).toBe(1);
    expect(performance.now() - forcedAt).toBeLessThan(2_000);
  }, 30_000);
});

describe("draining in process", () => {
  let relay: TestRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it("criterion 2: while draining /healthz answers 503 and a new upgrade is refused 503", async () => {
    relay = await startRelay();
    const stuck = await connectClient(relay.url);
    stuck.ws.pause(); // never reads its close: the drain waits for it
    const drained = relay.app.drain();
    const health = await relay.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({ status: "draining", sessions: 0 });
    // The Origin check still comes first (FR-33): a foreign page learns nothing about the drain.
    await expect(
      connectClient(relay.url, { Origin: "https://evil.example.com" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const limited = vi.spyOn(relay.limiter, "upgrade");
    // More than the 30 a minute an address may make: all 503, none 429 — nothing is spent.
    for (let i = 0; i < 31; i++)
      await expect(connectClient(relay.url)).rejects.toMatchObject({ statusCode: 503 });
    expect(limited).not.toHaveBeenCalled();
    expect(relay.app.drain()).toBe(drained); // idempotent
    relay.clock.advance(SHUTDOWN_FLUSH_MS); // the peer that never completed its close is cut
    await drained;
    expect(relay.app.websocketServer.clients.size).toBe(0); // resolved only once it is gone
    stuck.ws.resume();
    expect(await stuck.closed).toBe(4008);
  });

  it("respects RAILWAY_DEPLOYMENT_DRAINING_SECONDS: with 3 s the drain cuts a stuck peer after 2 s", async () => {
    relay = await startRelay({
      config: loadConfig({
        TRUST_PROXY: "false",
        ALLOWED_ORIGINS: "https://relay.example.org",
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "3",
      }),
    });
    const stuck = await connectClient(relay.url);
    stuck.ws.pause();
    const cut = vi.spyOn(Connection.prototype, "terminate");
    const drained = relay.app.drain();
    relay.clock.advance(2_000 - 1);
    await new Promise(setImmediate);
    expect(cut).not.toHaveBeenCalled();
    relay.clock.advance(1); // before the socket's own 5 s close timer: the drain terminates it
    await drained;
    expect(cut).toHaveBeenCalledTimes(1);
    expect(relay.app.websocketServer.clients.size).toBe(0);
    stuck.ws.resume();
    expect(await stuck.closed).toBe(4008);
  });

  it("sockets that complete their close end the drain at once, before the flush deadline", async () => {
    relay = await startRelay();
    const sockets = await threeSockets(relay.url);
    const timers = relay.clock.pending;
    const cut = vi.spyOn(Connection.prototype, "terminate");
    // The manual clock never moves here: only the closes completing can end the drain.
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 2_000));
    expect(await Promise.race([relay.app.drain().then(() => "drained"), late])).toBe("drained");
    // Its deadline timer cleared: only the unbound socket's handshake timer is gone besides.
    expect(relay.clock.pending).toBe(timers - 1);
    expect(cut).not.toHaveBeenCalled(); // every close completed: none was cut
    for (const client of [sockets.publisher, sockets.viewer, sockets.unbound])
      expect(await client.closed).toBe(4008);
  });

  it("criterion 3: nothing is written to the file system on the way out (NFR-10)", async () => {
    relay = await startRelay();
    const writes = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "createWriteStream",
      "open",
      "openSync",
      "copyFile",
      "copyFileSync",
      "rename",
      "renameSync",
      "mkdir",
      "mkdirSync",
    ] as const;
    const spies = writes.map((name) => vi.spyOn(fs, name));
    const promises = (
      ["writeFile", "appendFile", "open", "copyFile", "rename", "mkdir"] as const
    ).map((name) => vi.spyOn(fs.promises, name));
    syncBuiltinESMExports();
    await threeSockets(relay.url); // a cached snapshot in memory
    await relay.app.drain();
    const closing = relay;
    relay = undefined;
    await closing.close();
    for (const spy of [...spies, ...promises]) expect(spy).not.toHaveBeenCalled();
  });
});
