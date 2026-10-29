/**
 * The relay image (SRV-20 criteria 2–3), opt-in: it runs against the image `RELAY_IMAGE` names,
 * built from the current tree just before —
 *
 *   docker build -f relay-server/Dockerfile -t slicerremoteview-relay:local .
 *   RELAY_IMAGE=slicerremoteview-relay:local npm test -w relay-server -- docker-smoke
 *
 * Without `RELAY_IMAGE` it is skipped (an image lying around from an older tree proves nothing);
 * with it, a missing image or Docker fails it. Running it on the image CI builds (DEP-03) is proposed in
 * docs/testing/reports/2026-10-20-server-9.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const IMAGE = process.env.RELAY_IMAGE;
/**
 * Scopes of the relay's production dependencies (and the workspace links); npm leaves the others as
 * empty directories. A tripwire: a dependency bump that adds a production scope fails here — check
 * the new package, then extend the list.
 */
const PRODUCTION_SCOPES = ["@fastify", "@lukeed", "@pinojs", "@slicerremoteview"];
/** Every container the tests start carries it, so that even one that failed to start is removed. */
const LABEL = "slicerremoteview.test=docker-smoke";

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 60_000 });
  return stdout;
}

/** Polls until the relay answers or the deadline passes. */
async function healthz(port: number): Promise<Response> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe.skipIf(IMAGE === undefined)(`the relay image ${IMAGE ?? ""} (SRV-20)`, () => {
  const image = IMAGE!;
  const started: string[] = [];
  beforeAll(async () => {
    await docker("image", "inspect", image); // a missing image fails here, it is not a skip
  });
  afterEach(async () => {
    for (const id of started.splice(0)) await docker("rm", "-f", id).catch(() => undefined);
  });
  afterAll(async () => {
    const left = (await docker("ps", "-aq", "--filter", `label=${LABEL}`))
      .split("\n")
      .filter(Boolean);
    if (left.length > 0) await docker("rm", "-f", ...left);
  });

  /** Starts the image with `PORT=8787` published on a loopback port Docker picks. */
  async function start(...args: string[]): Promise<{ id: string; port: number }> {
    const id = (
      await docker(
        "run",
        "-d",
        "--label",
        LABEL,
        "-e",
        "PORT=8787",
        "-p",
        "127.0.0.1::8787",
        ...args,
        image,
      )
    ).trim();
    started.push(id);
    const mapping = (await docker("port", id, "8787/tcp")).trim().split("\n")[0]!;
    return { id, port: Number(mapping.slice(mapping.lastIndexOf(":") + 1)) };
  }

  it("answers /healthz and serves the viewer, as uid 1000 under dumb-init, and stops on SIGTERM", async () => {
    const { id, port } = await start();
    const res = await healthz(port);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", sessions: 0 });
    const page = await fetch(`http://127.0.0.1:${port}/j`, { signal: AbortSignal.timeout(2_000) });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await docker("exec", id, "id", "-u")).trim()).toBe("1000");
    // The binary itself, not just a process of that name (a stand-in script would pass `comm`).
    expect((await docker("exec", id, "readlink", "/proc/1/exe")).trim()).toBe("/usr/bin/dumb-init");
    // The relay cannot rewrite what it serves or runs (everything belongs to root).
    await expect(docker("exec", id, "touch", "/app/relay-server/public/x")).rejects.toThrow();
    await expect(docker("exec", id, "touch", "/app/relay-server/dist/x")).rejects.toThrow();

    const stopping = Date.now();
    await docker("stop", "-t", "10", id);
    expect(Date.now() - stopping).toBeLessThan(5_000); // SIGTERM reached Node (not the 10 s kill)
    expect((await docker("inspect", "-f", "{{.State.ExitCode}}", id)).trim()).toBe("0");
    const logs = (await docker("logs", id)).trim().split("\n");
    for (const line of logs) expect(line).not.toMatch(/127\.0\.0\.1|0\.0\.0\.0|http:\/\//);
  }, 60_000);

  it("sizes the heap from the container's memory limit (NODE_OPTIONS, DEP-06)", async () => {
    const { id, port } = await start("--memory", "256m");
    await healthz(port);
    const line = (await docker("logs", id))
      .split("\n")
      .map((l) => (l.startsWith("{") ? (JSON.parse(l) as Record<string, unknown>) : {}))
      .find((l) => l.message === "relay starting");
    const limit = line?.heapSizeLimit as number;
    // 75 % of 256 MiB, plus what V8 adds for its young generation.
    expect(limit).toBeGreaterThan(0.6 * 256 * 1024 * 1024);
    expect(limit).toBeLessThan(0.9 * 256 * 1024 * 1024);
  }, 60_000);

  it("holds the relay's production dependencies and builds only (no dev tools, docs or other apps)", async () => {
    expect(
      JSON.parse(await docker("image", "inspect", "-f", "{{json .Config.Cmd}}", image)),
    ).toEqual(["dumb-init", "node", "dist/index.js"]);
    const listing = await docker(
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      image,
      "-c",
      [
        "cd /app",
        "ls -A",
        "echo ---",
        "ls -A relay-server",
        "echo ---",
        "ls node_modules",
        "echo ---",
        'for s in node_modules/@*; do [ -n "$(ls -A $s)" ] && echo ${s#node_modules/}; done',
        "echo ---",
        "find relay-server/public -type l",
        "echo ---",
        "ls relay-server/dist/index.js relay-server/public/index.html shared/dist/index.js",
      ].join("; "),
    );
    const [root, relay, modules, scopes, links, built] = listing.split("---\n");
    expect(root!.split("\n").filter(Boolean).sort()).toEqual(
      [
        "node_modules",
        "package-lock.json",
        "package.json",
        "relay-server",
        "shared",
        "tools",
        "web-viewer",
      ].sort(),
    );
    expect(relay!.split("\n").filter(Boolean).sort()).toEqual(["dist", "package.json", "public"]);
    const names = modules!.split("\n").filter(Boolean);
    for (const dev of [
      "typescript",
      "vitest",
      "eslint",
      "vite",
      "three",
      "tsx",
      "prettier",
      "jsdom",
    ])
      expect(names).not.toContain(dev);
    for (const prod of ["fastify", "ws", "pino", "@fastify"]) expect(names).toContain(prod);
    expect(scopes!.split("\n").filter(Boolean).sort()).toEqual(PRODUCTION_SCOPES);
    expect(links!.trim()).toBe("");
    expect(built!.trim().split("\n")).toHaveLength(3);
  }, 60_000);
});
