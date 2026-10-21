/**
 * The relay with fake-slicer (PRO-14…16) as its publisher (SRV-22; docs/protocol.md §6.4, §6.5,
 * §13 steps 2–4). fake-slicer runs as a child process from its sources (tsx, with the relay's
 * tsconfig, so `shared` comes from its sources too) and hands out the session code only through
 * file descriptor 3 (`--code-fd 3 --json`, NFR-12); a test viewer joins with it and gets the fixture
 * GLB over HTTP (late join) or streamed over the WebSocket (joined before the snapshot), checked
 * against `shared/fixtures/glb/manifest.json`. Failure messages never carry the code or a token.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RawData } from "ws";
import { CHUNK_HEADER_BYTES, decodeChunkHeader } from "@slicerremoteview/shared";
import { childEnv } from "./helpers/env.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO, "tools/fake-slicer/src/cli.ts");
const FIXTURE = "asymmetric-2nodes.glb";
const manifest = JSON.parse(
  readFileSync(join(REPO, "shared/fixtures/glb/manifest.json"), "utf8"),
) as { files: Record<string, { byteLength: number; sha256: string }> };
const expected = manifest.files[FIXTURE]!;
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const WAIT_MS = 10_000;
/** Between the symbols of a code shown in groups: whitespace and the dashes `normalizeCode` drops. */
const SEPARATORS = "[\\s\\u002D\\u2010-\\u2015\\u2212]*";

/** A running fake-slicer: the JSON lines of its fd 3, and what it printed. */
interface FakeSlicer {
  child: ChildProcess;
  /** Resolves with the first fd-3 line that matches. */
  line(match: (entry: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  /** Resolves once stdout/stderr contain `text`. */
  printed(text: string): Promise<void>;
  /** The exit code, once the process has ended and its output is complete. */
  ended: Promise<number | null>;
  output(): string;
}

let relay: TestRelay | undefined;
const children: ChildProcess[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  const closing = relay;
  relay = undefined;
  await closing?.close();
});

function fakeSlicer(url: string, ...args: string[]): FakeSlicer {
  // node itself, not `npm run`/`npx`: those wrappers do not pass fd 3 on (fake-slicer README).
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      CLI,
      "--relay",
      url,
      "--fixture",
      FIXTURE,
      "--code-fd",
      "3",
      "--json",
      ...args,
    ],
    { cwd: ROOT, env: childEnv({}), stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let output = "";
  const entries: Record<string, unknown>[] = [];
  let broken: Error | undefined;
  const waiting = new Set<() => void>();
  const codes = (): string[] =>
    entries.flatMap((entry) => (typeof entry.code === "string" ? [entry.code] : []));
  const wake = (): void => {
    for (const check of [...waiting]) check();
  };
  child.stdout!.on("data", (chunk: Buffer) => ((output += chunk.toString()), wake()));
  child.stderr!.on("data", (chunk: Buffer) => ((output += chunk.toString()), wake()));
  createInterface({ input: child.stdio[3] as Readable }).on("line", (line) => {
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      broken = new Error("an fd-3 line is not JSON"); // never the line: it may hold the code
    }
    wake();
  });
  // `close`, not `exit`: by then stdout, stderr and fd 3 are drained.
  let exitCode: number | null | undefined;
  const ended = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      exitCode = code;
      wake();
      resolve(code);
    }),
  );
  const until = <T>(what: string, probe: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`fake-slicer: no ${what}`)), WAIT_MS);
      const finish = (error?: Error, found?: T): void => {
        waiting.delete(check);
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve(found!);
      };
      const check = (): void => {
        const found = probe();
        if (found !== undefined) finish(undefined, found);
        else if (broken !== undefined) finish(broken);
        else if (exitCode !== undefined)
          finish(
            new Error(
              `fake-slicer ended (${exitCode}) before ${what}: ${redacted(output, codes())}`,
            ),
          );
      };
      waiting.add(check);
      check();
    });
  return {
    child,
    line: (match) => until("fd-3 line", () => entries.find(match)),
    printed: (text) =>
      until(`"${text}"`, () => (output.includes(text) ? true : undefined)).then(() => undefined),
    ended,
    output: () => output,
  };
}

/**
 * fake-slicer's output for a failure message: every run of five or more code symbols (any case, any
 * surroundings — `relay-server/src/codes.ts`) and every prefixed token or id becomes `…`.
 */
function redacted(text: string, codes: readonly string[] = []): string {
  let out = text.replace(/(?:pt|vt|sess|vw)_[A-Za-z0-9_-]+/g, "…");
  // A known code also when shown in groups (`AB CDE`, ADR 0008 §1).
  for (const code of codes)
    out = out.replace(new RegExp(code.split("").join(SEPARATORS), "gi"), "…");
  return out.replace(/[2-9A-HJKMNP-Z]{5,}/gi, "…");
}

/** NFR-12: the code, a token or a session id on fake-slicer's stdout/stderr — without printing it. */
function expectNoSecrets(slicer: FakeSlicer, code: string): void {
  const out = slicer.output();
  expect(
    new RegExp(code.split("").join(SEPARATORS), "i").test(out),
    "session code on stdout/stderr",
  ).toBe(false);
  expect(/(pt|vt|sess|vw)_[A-Za-z0-9_-]{8,}/.test(out), "token or id on stdout/stderr").toBe(false);
}

/** A viewer that keeps every frame (text as parsed JSON, binary as it arrived). */
async function joinViewer(code: string): Promise<{
  client: TestClient;
  joined: Received;
  frames: (Received | Buffer)[];
  /** Resolves with the index of the first frame that matches, from now or from the past. */
  frame(match: (frame: Received | Buffer) => boolean): Promise<number>;
}> {
  const client = await connectClient(relay!.url);
  const frames: (Received | Buffer)[] = [];
  const waiting = new Set<() => void>();
  client.ws.on("message", (data: RawData, isBinary: boolean) => {
    frames.push(isBinary ? (data as Buffer) : (JSON.parse(data.toString()) as Received));
    for (const check of [...waiting]) check();
  });
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code }));
  const joined = await within(client.next(), "answer to viewer.join");
  expect(joined.type).toBe("viewer.joined");
  const frame = (match: (frame: Received | Buffer) => boolean): Promise<number> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(check);
        // Types and versions only: `viewer.joined` carries the viewer's token.
        const got = frames.map((f) =>
          Buffer.isBuffer(f) ? "chunk" : `${f.type}@${String(f.sceneVersion)}`,
        );
        reject(new Error(`the viewer got no such frame; it got ${got.join(", ")}`));
      }, WAIT_MS);
      const check = (): void => {
        const at = frames.findIndex(match);
        if (at < 0) return;
        waiting.delete(check);
        clearTimeout(timer);
        resolve(at);
      };
      waiting.add(check);
      check();
    });
  return { client, joined, frames, frame };
}

/** `promise`, or a fixed error after `WAIT_MS` (never a hang until the test timeout). */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no ${what} within ${WAIT_MS} ms`)), WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const httpBase = (): string => relay!.url.replace("ws://", "http://").replace(/\/ws$/, "");
const isText = (frame: Received | Buffer): frame is Received => !Buffer.isBuffer(frame);

describe("fake-slicer as the publisher (SRV-22, §13 steps 2–4)", () => {
  it("late join: the code comes through fd 3, the viewer fetches the cached GLB over HTTP", async () => {
    relay = await startRelay();
    const slicer = fakeSlicer(relay.url);
    const { code } = (await slicer.line((l) => typeof l.code === "string")) as { code: string };
    await slicer.printed("snapshot 1 acknowledged");

    const viewer = await joinViewer(code);
    expect(viewer.joined.snapshotVersion).toBe(1);
    const res = await fetch(`${httpBase()}/api/scene/1`, {
      headers: { Authorization: `Bearer ${viewer.joined.viewerToken as string}` },
    });
    expect(res.status).toBe(200);
    const glb = Buffer.from(await res.arrayBuffer());
    expect(glb.byteLength).toBe(expected.byteLength);
    expect(sha256(glb)).toBe(expected.sha256);
    expect(res.headers.get("etag")).toBe(`"${expected.sha256}"`);

    // FR-17's data source: the publisher hears of the viewer (criterion 2).
    expect(await slicer.line((l) => l.event === "viewer.count" && l.count === 1)).toEqual({
      event: "viewer.count",
      count: 1,
    });

    viewer.client.sendRaw(JSON.stringify(fixture("viewer.leave")));
    expect(await viewer.client.closed).toBe(1000);
    slicer.child.kill("SIGINT"); // Ctrl-C: a normal end
    expect(await slicer.ended).toBe(0);
    expectNoSecrets(slicer, code); // the code only ever travelled through fd 3
  }, 30_000);

  it("live: a viewer that joined before the snapshot gets it streamed, byte for byte", async () => {
    relay = await startRelay();
    const dir = mkdtempSync(join(tmpdir(), "srv22-"));
    temporary.push(dir);
    // A second snapshot (version 2) three seconds after the first is acknowledged: the margin for the
    // viewer to join before it begins.
    const script = join(dir, "snapshot-again.json");
    writeFileSync(script, JSON.stringify([{ afterMs: 3_000, type: "scene.snapshot" }]));
    const slicer = fakeSlicer(relay.url, "--script", script);
    const { code } = (await slicer.line((l) => typeof l.code === "string")) as { code: string };

    const viewer = await joinViewer(code);
    // The viewer's own frames decide, not fake-slicer's stderr (two channels, no order between them):
    // version 2 must end streamed (`end`), not deferred (`ready`).
    const last = await viewer.frame(
      (f) =>
        isText(f) &&
        f.sceneVersion === 2 &&
        (f.type === "scene.snapshot.end" || f.type === "scene.snapshot.ready"),
    );
    expect((viewer.frames[last] as Received).type).toBe("scene.snapshot.end");
    const begin = viewer.frames.findIndex(
      (f) => isText(f) && f.type === "scene.snapshot.begin" && f.sceneVersion === 2,
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(last);
    const chunks = viewer.frames
      .slice(begin + 1, last)
      .filter((f): f is Buffer => Buffer.isBuffer(f))
      .map((frame) => {
        expect(decodeChunkHeader(frame)).toMatchObject({ ok: true, value: { sceneVersion: 2 } });
        return frame.subarray(CHUNK_HEADER_BYTES);
      });
    const glb = Buffer.concat(chunks);
    expect(glb.byteLength).toBe(expected.byteLength);
    expect(sha256(glb)).toBe(expected.sha256);
    expect(viewer.frames[begin]).toMatchObject({
      sha256: expected.sha256,
      byteLength: expected.byteLength,
    });
    await slicer.printed("snapshot 2 acknowledged"); // and the publisher got its ack

    slicer.child.kill("SIGINT");
    expect(await slicer.ended).toBe(0);
    expectNoSecrets(slicer, code);
  }, 30_000);
});
