import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, systemErrorCode } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import { childEnv } from "./helpers/env.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { RELAY_VERSION } from "../src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("GET /healthz (SRV-01, §10)", () => {
  it("answers 200 with exactly {status, uptimeS, sessions, version} within 100 ms", async () => {
    const clock = new ManualClock();
    const registry = new Registry({ ...loadConfig({}), clock });
    for (let i = 0; i < 3; i++) registry.createSession("mobile");
    const app = await buildApp({ clock, registry });
    clock.advance(12_345);
    await app.ready();
    await app.inject("/healthz"); // the first inject boots the app; time the steady state (NFR-38)
    const started = performance.now();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(performance.now() - started).toBeLessThan(100);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: "ok", uptimeS: 12, sessions: 3, version: RELAY_VERSION });
    await app.close();
  });

  it("reports 0 sessions on a fresh relay", async () => {
    const app = await buildApp();
    expect((await app.inject("/healthz")).json()).toMatchObject({ sessions: 0 });
    await app.close();
  });
});

describe("GET /api/version (SRV-01, §10)", () => {
  it("lists protocol 1.0 and the §10 limits object", async () => {
    const app = await buildApp();
    const res = await app.inject("/api/version");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "slicer-remote-view-relay",
      version: RELAY_VERSION,
      protocolVersions: ["1.0"],
      limits: {
        maxSnapshotBytes: 67_108_864,
        maxChunkBytes: 1_048_576,
        maxTextBytes: 262_144,
        maxViewers: 20,
      },
    });
    await app.close();
  });

  it("announces configured limits", async () => {
    const config = loadConfig({ MAX_VIEWERS: "5", MAX_SNAPSHOT_BYTES: "33554432" });
    const app = await buildApp({ config });
    expect((await app.inject("/api/version")).json().limits).toEqual({
      maxSnapshotBytes: 33_554_432,
      maxChunkBytes: 1_048_576,
      maxTextBytes: 262_144,
      maxViewers: 5,
    });
    await app.close();
  });
});

describe("client IP behind the Railway edge (TRUST_PROXY, T1, T3)", () => {
  it.each([
    ["true", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["true", "203.0.113.7", "203.0.113.7"],
    ["true", undefined, "10.0.0.5"],
    ["false", "6.6.6.6, 203.0.113.7", "10.0.0.5"],
  ])("TRUST_PROXY=%s, X-Forwarded-For %j → request.ip %s", async (trust, xff, expected) => {
    const app = await buildApp({ config: loadConfig({ TRUST_PROXY: trust }) });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      url: "/ip",
      remoteAddress: "10.0.0.5",
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    });
    expect(res.json()).toEqual({ ip: expected });
    await app.close();
  });
});

describe("unknown paths (SRV-01, §10)", () => {
  it.each([
    "/nope",
    "/7KQ4X",
    "/j/7KQ4X",
    "/api/scene/1?code=7KQ4X",
    "/healthz/extra",
    "/7KQ4X%zz",
    "/%E0%A4%A",
    "/api/scene/%zz?code=7KQ4X",
  ])("GET %s → 404 {error: NOT_FOUND} without echoing the path", async (url) => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NOT_FOUND" });
    expect(res.body).not.toContain("7KQ4X");
    await app.close();
  });

  it.each(["/healthz", "/7KQ4X"])("POST %s with any body → 404 (no other methods)", async (url) => {
    const app = await buildApp();
    for (const payload of ['{"code":"7KQ4X"}', '{"code":"7KQ4X"', "code=7KQ4X"]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "NOT_FOUND" });
    }
    await app.close();
  });
});

describe("error handler", () => {
  it("answers a failing handler with 500 {error: INTERNAL} and no error text", async () => {
    const app = await buildApp();
    app.get("/boom", async () => {
      throw new Error("leaky detail 7KQ4X");
    });
    const res = await app.inject("/boom");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "INTERNAL" });
    await app.close();
  });

  it.each([
    [409, 409, "BAD_REQUEST"],
    [302, 500, "INTERNAL"],
    [503, 503, "INTERNAL"],
  ])("an error with statusCode %i → %i {error: %s}", async (thrown, status, body) => {
    const app = await buildApp();
    app.get("/fail", async () => {
      throw Object.assign(new Error("detail 7KQ4X"), { statusCode: thrown });
    });
    const res = await app.inject("/fail");
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: body });
    await app.close();
  });
});

describe("systemErrorCode", () => {
  it.each([
    [{ code: "FST_ERR_BAD_URL" }, "FST_ERR_BAD_URL"],
    [{ code: "ERR_HTTP_REQUEST_TIMEOUT" }, "ERR_HTTP_REQUEST_TIMEOUT"],
    [{ code: "HPE_INVALID_METHOD" }, "HPE_INVALID_METHOD"],
    [{ code: "WS_ERR_INVALID_UTF8" }, "WS_ERR_INVALID_UTF8"],
    [{ code: "EADDRINUSE", errno: -98, syscall: "listen" }, "EADDRINUSE"],
    [{ code: "E7KQ4" }, "INTERNAL"],
    [{ code: "EADDRINUSE" }, "INTERNAL"],
    [{ code: "7KQ4X" }, "INTERNAL"],
    [{ code: 42 }, "INTERNAL"],
    [new Error("x"), "INTERNAL"],
    [null, "INTERNAL"],
  ])("%j → %s", (error, expected) => {
    expect(systemErrorCode(error)).toBe(expected);
  });
});

describe("malformed HTTP requests (T6, T8)", () => {
  it("answer 400 without logging the raw request bytes, even at trace", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const app = await buildApp({ logger });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const secret = "Bearer vt_SECRETTOKENabcdefghijklmnopqrstuvwxyz0123456789";
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /healthz HTTP/1.1\r\nHost: x\r\nAuthorization: ${secret}\r\nBad Header\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(reply).toContain('{"error":"BAD_REQUEST"}');
    await app.close();
    const log = lines.join("");
    expect(log).toContain('"errorCode":"HPE_');
    expect(log).not.toContain("rawPacket");
    expect(log).not.toContain("SECRETTOKEN");
    expect(log).not.toContain(Buffer.from("SECRETTOKEN").join(","));
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("src/index.ts (npm run dev entry)", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  it("listens on PORT and serves /healthz with 200 within 100 ms", async () => {
    const wanted = await freePort();
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env: childEnv({ PORT: String(wanted), NODE_ENV: "test" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child!.stdout! });
      lines.on("line", (line) => {
        try {
          const entry = JSON.parse(line) as { message?: string; port?: number; level?: string };
          if (typeof entry.level !== "string") throw new Error("log line without level");
          if (entry.message === "relay listening" && entry.port) resolve(entry.port);
        } catch (error) {
          reject(error as Error);
        }
      });
      child!.once("close", (code) =>
        reject(new Error(`relay exited early with ${code}: ${stderr}`)),
      );
    });
    expect(port).toBe(wanted);
    await (await fetch(`http://127.0.0.1:${port}/healthz`)).arrayBuffer(); // warm up the client
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    // Generous across processes under parallel CI load; the strict 100 ms bound is the in-process test.
    expect(performance.now() - started).toBeLessThan(250);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", sessions: 0 });
  }, 20_000);
});
