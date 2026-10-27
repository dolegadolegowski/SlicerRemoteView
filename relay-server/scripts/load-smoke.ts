/**
 * Load smoke (SRV-21): one relay process, one publisher, N viewers, several snapshot cycles.
 *
 *   npm run load:smoke -w relay-server -- [--viewers 20] [--cycles 3] [--max-fanout-ms 5000]
 *                                         [--max-growth-factor 2] [--fixture large-synthetic.glb]
 *
 * The relay runs as a child (`src/index.ts`, `NODE_ENV=test`) so its memory is its own, with the
 * test-only preload `memory-probe.ts` (a full GC and the memory figures on `SIGUSR2`). The publisher
 * plays the fixture with fake-slicer's snapshot playback (`tools/fake-slicer`, PRO-14) in this
 * process, so each cycle starts once every viewer is ready. Per cycle it measures the time from
 * `scene.snapshot.begin` to the last viewer holding the whole GLB: its `scene.snapshot.end`, or for
 * a deferred viewer its `scene.snapshot.ready` plus the HTTP download (§6.4, §6.5) — SHA-256 and
 * version checked.
 * - Phase 1 (criteria 1–2): every viewer reads and is streamed; each cycle within `--max-fanout-ms`;
 *   after a full GC the relay's live buffers grow by less than `--max-growth-factor` × the snapshot from
 *   before the first cycle to after the last, and hold less than two snapshots after every cycle
 *   (no leak of released buffers, NFR-06). RSS is reported, not gated (see the README).
 * - Phase 2 (criterion 3): one viewer stops reading; cycles go on until the relay defers it — it
 *   alone — the others within the limit and not slower than phase 1 allows; reading again, it
 *   holds the last snapshot via `ready` and HTTP (FR-24).
 * Every wait fails as soon as a socket closes, a hash or a download is wrong or the relay exits; the
 * run gives up after `runTimeoutMs`, and the relay process and every socket are gone on every path.
 * Exit 0 when every check passes, 1 otherwise. Nothing printed carries the session code or a token.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { LIMITS, decodeChunkHeader } from "@slicerremoteview/shared";
import {
  envelope,
  loadGlb,
  resolveFixture,
  sendSnapshot,
} from "../../tools/fake-slicer/src/index.js";
import type { LoadedGlb } from "../../tools/fake-slicer/src/index.js";
import { ENV_VARIABLES, PLATFORM_INPUTS } from "../src/config.js";

/** `relay-server/`, the relay's working directory. */
const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface SmokeOptions {
  viewers: number;
  /** At least 3: a buffer leaked per cycle then exceeds the growth limit (2×) by the last. */
  cycles: number;
  maxFanoutMs: number;
  /** Live-buffer growth over phase 1, in snapshots (RSS is only printed). */
  maxGrowthFactor: number;
  /** Larger than the 4 MiB soft watermark, or phase 2 never defers the stopped viewer. */
  fixture: string;
  chunkSize: number;
  /** Phase 2 runs at least one and at most this many cycles until the stopped viewer is deferred. */
  maxDeferCycles: number;
  /** The run gives up after this long; a stuck viewer must not hang CI. */
  runTimeoutMs: number;
  /** Told the relay's pid once it is spawned (the tests check it is gone afterwards). */
  onRelay?: (pid: number) => void;
}

export const DEFAULT_SMOKE: SmokeOptions = {
  viewers: 20,
  cycles: 3,
  maxFanoutMs: 5_000,
  maxGrowthFactor: 2,
  fixture: "large-synthetic.glb",
  chunkSize: 1_048_576,
  maxDeferCycles: 30,
  runTimeoutMs: 120_000,
};

/** The relay's memory after a full GC (`scripts/memory-probe.ts`). */
export interface Memory {
  rss: number;
  arrayBuffers: number;
  heapUsed: number;
}

export interface CycleResult {
  sceneVersion: number;
  fanoutMs: number;
  viewersStreamed: number;
  viewersDeferred: number;
  /** The relay's memory right after the cycle, after a full GC. */
  memory: Memory;
}

export interface SmokeResult {
  snapshotBytes: number;
  /** The relay's memory after the joins, before the first snapshot. */
  before: Memory;
  phase1: CycleResult[];
  phase2: CycleResult[];
  /** The stopped viewer was deferred and then held the last snapshot via `ready` + HTTP. */
  stoppedViewerRecovered: boolean;
  failures: string[];
}

/** One viewer: joined by code, it collects each snapshot it is sent (stream or HTTP). */
class Viewer {
  /** sceneVersion → when it held the whole GLB, and how it came. */
  readonly done = new Map<number, { at: number; via: "end" | "ready" }>();
  #token = "";
  /** The first thing that went wrong: every wait fails with it from then on. */
  #failure: string | undefined;
  #streams = new Map<number, Uint8Array[]>();
  #waiters: (() => void)[] = [];

  private constructor(
    readonly socket: WebSocket,
    private readonly httpBase: string,
    private readonly glb: LoadedGlb,
  ) {}

  static async join(
    url: string,
    httpBase: string,
    code: string,
    glb: LoadedGlb,
    track: (socket: WebSocket) => void,
  ): Promise<Viewer> {
    const socket = new WebSocket(url);
    track(socket);
    const viewer = new Viewer(socket, httpBase, glb);
    socket.on("error", () => viewer.#fail("socket error"));
    socket.on("close", (closeCode: number) => viewer.#fail(`viewer closed ${closeCode}`));
    socket.on("message", (data: RawData, isBinary: boolean) => viewer.#onMessage(data, isBinary));
    await once(socket, "open");
    socket.send(
      envelope("viewer.join", "v-1", {
        code,
        clientInfo: {
          app: "load-smoke",
          version: "0.0.0",
          platform: "other",
          profile: "mobile",
          capabilities: { httpScene: true }, // §6.5: a viewer supports the HTTP path
        },
      }),
    );
    await viewer.until(() => viewer.#token !== "");
    return viewer;
  }

  /** Resolves when `probe()` holds, re-checked after every message; rejects once anything failed. */
  until(probe: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.#failure !== undefined) reject(new Error(this.#failure));
        else if (probe()) resolve();
        else this.#waiters.push(check);
      };
      check();
    });
  }

  #wake(): void {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const check of waiting) check();
  }

  #fail(reason: string): void {
    this.#failure ??= reason;
    this.#wake();
  }

  #held(version: number, bytes: Uint8Array, via: "end" | "ready"): void {
    if (createHash("sha256").update(bytes).digest("hex") !== this.glb.sha256)
      return this.#fail(`snapshot ${version} via ${via}: SHA-256 mismatch`);
    if (this.done.has(version)) return this.#fail(`snapshot ${version}: both end and ready`);
    this.done.set(version, { at: performance.now(), via });
    this.#wake();
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    const bytes = data as Buffer;
    if (isBinary) {
      const header = decodeChunkHeader(bytes);
      if (!header.ok) return this.#fail(`bad chunk header (${header.error.field})`);
      this.#streams.get(header.value.sceneVersion)?.push(header.value.payload);
      return;
    }
    const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
    const version = message.sceneVersion as number;
    switch (message.type) {
      case "viewer.joined":
        this.#token = message.viewerToken as string;
        break;
      case "error":
        return this.#fail(`relay error ${String(message.code)}`);
      case "scene.snapshot.begin":
        this.#streams.set(version, []);
        break;
      case "scene.snapshot.end": {
        const parts = this.#streams.get(version) ?? [];
        this.#streams.delete(version);
        this.#held(version, Buffer.concat(parts), "end");
        break;
      }
      case "scene.snapshot.abort":
        this.#streams.delete(version);
        break;
      case "scene.snapshot.ready":
        this.#streams.delete(version); // a stream cut short by the deferral
        this.#download(version).catch((error: unknown) =>
          this.#fail(`GET /api/scene/${version}: ${(error as Error).message}`),
        );
        break;
    }
    this.#wake();
  }

  async #download(version: number): Promise<void> {
    const response = await fetch(`${this.httpBase}/api/scene/${version}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) return this.#fail(`GET /api/scene/${version}: ${response.status}`);
    if (response.headers.get("x-scene-version") !== String(version))
      return this.#fail(`GET /api/scene/${version}: another version`);
    this.#held(version, new Uint8Array(await response.arrayBuffer()), "ready");
  }
}

/** What the run must take down on every path: the relay process and every socket. */
interface Resources {
  child: ChildProcess | undefined;
  closed: Promise<unknown> | undefined;
  sockets: WebSocket[];
  /** Set by `teardown()`: a run that timed out before the spawn must not start a relay after it. */
  tornDown: boolean;
}

async function teardown(resources: Resources): Promise<void> {
  resources.tornDown = true;
  for (const socket of resources.sockets) socket.terminate();
  const { child, closed } = resources;
  if (child === undefined || closed === undefined) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await closed;
    clearTimeout(kill);
  } else await closed;
}

/**
 * The relay as a child process: `src/index.ts` under `NODE_ENV=test` on a free port, with the
 * memory probe preloaded (`--expose-gc`; test-only, nothing of it is in `src/`). Its stdin is a
 * pipe the probe watches: the relay is killed when this process ends, however it ends.
 */
async function startRelay(
  resources: Resources,
  onRelay: ((pid: number) => void) | undefined,
): Promise<{ port: number; memory: () => Promise<Memory> }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...ENV_VARIABLES, ...PLATFORM_INPUTS]) delete env[name];
  // One client address for all: ≤ 21 upgrades a run (30 a minute are allowed), and a join with the
  // right code gives its attempt back (`RateLimiter.joinSucceeded`, ADR 0008) — no
  // `X-Forwarded-For` spread needed as long as the joins run one after another (`smoke()`).
  Object.assign(env, { PORT: "0", NODE_ENV: "test", TRUST_PROXY: "false", LOG_LEVEL: "info" });
  if (resources.tornDown) throw new Error("torn down before the relay was started");
  // Its own process group (`detached`): a Ctrl-C in the terminal reaches this process only, and the
  // probe then kills the relay. The relay's own SIGINT exit could hang once this process stopped
  // reading its stdout (see `memory-probe.ts`).
  const child = spawn(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "--import", "./scripts/memory-probe.ts", "src/index.ts"],
    { cwd: RELAY_DIR, env, stdio: ["pipe", "pipe", "inherit"], detached: true },
  );
  resources.child = child;
  resources.closed = once(child, "close");
  if (child.pid !== undefined) onRelay?.(child.pid);
  const probes: { resolve: (memory: Memory) => void; reject: (error: Error) => void }[] = [];
  const problems: string[] = []; // the relay's fatal/error lines (ids and error codes only, SRV-18)
  const exited = once(child, "exit").then(([code, signal]) => {
    const reasons = problems.length > 0 ? `: ${problems.join("; ")}` : "";
    const error = new Error(`relay exited (${String(code ?? signal)})${reasons}`);
    for (const probe of probes.splice(0)) probe.reject(error);
    throw error;
  });
  exited.catch(() => {}); // observed by the race below; later, the probes carry the error
  const port = await Promise.race([
    new Promise<number>((resolve) => {
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          const entry = JSON.parse(line) as Memory & Record<string, unknown>;
          if (entry.message === "relay listening") resolve(entry.port as number);
          else if (entry.message === "load-smoke memory") probes.shift()?.resolve(entry);
          else if (entry.level === "fatal" || entry.level === "error")
            problems.push(`${String(entry.message)} ${String(entry.errorCode ?? entry.variable)}`);
        } catch {
          // not a log line of the relay
        }
      });
    }),
    exited,
  ]);
  const memory = (): Promise<Memory> =>
    new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return reject(new Error("relay exited"));
      probes.push({ resolve, reject });
      child.kill("SIGUSR2");
    });
  return { port, memory };
}

export async function runLoadSmoke(options: SmokeOptions = DEFAULT_SMOKE): Promise<SmokeResult> {
  const resources: Resources = {
    child: undefined,
    closed: undefined,
    sockets: [],
    tornDown: false,
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no result within ${options.runTimeoutMs} ms`)),
      options.runTimeoutMs,
    );
  });
  try {
    return await Promise.race([smoke(options, resources), timeout]);
  } finally {
    clearTimeout(timer);
    await teardown(resources);
  }
}

async function smoke(options: SmokeOptions, resources: Resources): Promise<SmokeResult> {
  const glb = await loadGlb(resolveFixture(options.fixture));
  const { port, memory } = await startRelay(resources, options.onRelay);
  const url = `ws://127.0.0.1:${port}/ws`;
  const httpBase = `http://127.0.0.1:${port}`;
  const track = (socket: WebSocket): void => void resources.sockets.push(socket);
  const failures: string[] = [];

  // The publisher.
  const publisher = new WebSocket(url);
  track(publisher);
  const inbox: Record<string, unknown>[] = [];
  let publisherClosed: number | undefined;
  let wake: (() => void) | undefined;
  publisher.on("error", () => {});
  publisher.on("close", (closeCode: number) => {
    publisherClosed = closeCode;
    wake?.();
  });
  publisher.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    // Only what `next()` waits for; viewer counts and pongs are not kept.
    if (["session.created", "scene.snapshot.ack", "error"].includes(message.type as string))
      inbox.push(message);
    wake?.();
  });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const index = inbox.findIndex((m) => m.type === type || m.type === "error");
      if (index >= 0) {
        const [message] = inbox.splice(index, 1);
        if (message!.type === "error") throw new Error(`relay error ${String(message!.code)}`);
        return message!;
      }
      if (publisherClosed !== undefined) throw new Error(`publisher closed ${publisherClosed}`);
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  await once(publisher, "open");
  let ids = 0;
  const nextId = (): string => `p-${++ids}`;
  publisher.send(
    envelope("session.create", nextId(), {
      clientInfo: { app: "load-smoke", version: "0.0.0", platform: "load-smoke" },
      profile: "mobile",
    }),
  );
  const code = (await next("session.created")).code as string; // kept in memory only

  // One after another: parallel joins would hold up to 20 of the 10 join attempts a minute at once.
  const viewers: Viewer[] = [];
  for (let i = 0; i < options.viewers; i++)
    viewers.push(await Viewer.join(url, httpBase, code, glb, track));
  const before = await memory();

  let sceneVersion = 0;
  const cycle = async (waitFor: Viewer[]): Promise<CycleResult> => {
    sceneVersion += 1;
    const version = sceneVersion;
    const started = performance.now();
    await sendSnapshot(
      publisher,
      { glb, sceneVersion: version, chunkSize: options.chunkSize, profile: "mobile" },
      nextId,
    );
    const ack = await next("scene.snapshot.ack");
    if (ack.sceneVersion !== version)
      throw new Error(`ack for ${String(ack.sceneVersion)}, not ${version}`);
    await Promise.all(waitFor.map((viewer) => viewer.until(() => viewer.done.has(version))));
    const last = Math.max(...waitFor.map((viewer) => viewer.done.get(version)!.at));
    return {
      sceneVersion: version,
      fanoutMs: Math.round(last - started),
      viewersStreamed: ack.viewersStreamed as number,
      viewersDeferred: ack.viewersDeferred as number,
      memory: await memory(),
    };
  };

  // Phase 1: every viewer reads and is streamed.
  const phase1: CycleResult[] = [];
  for (let i = 0; i < options.cycles; i++) phase1.push(await cycle(viewers));
  const limit = options.maxGrowthFactor * glb.bytes.byteLength;
  const counts = (c: CycleResult): string =>
    `streamed ${c.viewersStreamed}, deferred ${c.viewersDeferred}`;
  for (const c of phase1) {
    if (c.fanoutMs > options.maxFanoutMs)
      failures.push(`cycle ${c.sceneVersion}: ${c.fanoutMs} ms > ${options.maxFanoutMs}`);
    if (c.viewersStreamed !== options.viewers || c.viewersDeferred !== 0)
      failures.push(`cycle ${c.sceneVersion}: ${counts(c)}, not all ${options.viewers} streamed`);
    // One cached snapshot is expected; a second one would be a buffer the relay did not release.
    if (c.memory.arrayBuffers - before.arrayBuffers >= 2 * glb.bytes.byteLength)
      failures.push(`cycle ${c.sceneVersion}: live buffers ${c.memory.arrayBuffers} B`);
  }
  // From before the first snapshot: one cached snapshot is normal growth, a leaked one per cycle
  // reaches three after three cycles — the limit (2×) sits between.
  const growth = phase1.at(-1)!.memory.arrayBuffers - before.arrayBuffers;
  if (growth >= limit) failures.push(`live buffers grew ${growth} B ≥ ${limit} B`);

  // Phase 2: one viewer stops reading until the relay defers it, and it alone.
  const [stopped, ...others] = viewers;
  stopped!.socket.pause();
  const slowest = Math.max(...phase1.map((c) => c.fanoutMs));
  const allowed = Math.min(options.maxFanoutMs, Math.max(2 * slowest, slowest + 1_000));
  const phase2: CycleResult[] = [];
  do {
    const c = await cycle(others);
    phase2.push(c);
    if (c.fanoutMs > allowed)
      failures.push(`cycle ${c.sceneVersion} (one viewer stopped): ${c.fanoutMs} ms > ${allowed}`);
    if (c.viewersStreamed === options.viewers && c.viewersDeferred === 0) continue; // not yet
    // Someone was deferred or dropped: it must be the stopped viewer alone, deferred.
    if (c.viewersStreamed === others.length && c.viewersDeferred === 0)
      failures.push(`cycle ${c.sceneVersion}: the stopped viewer was dropped, not deferred`);
    else if (c.viewersStreamed !== others.length || c.viewersDeferred !== 1)
      failures.push(`cycle ${c.sceneVersion}: ${counts(c)}, not only the stopped viewer deferred`);
    break;
  } while (phase2.length < options.maxDeferCycles);
  const last = phase2.at(-1)!;
  let stoppedViewerRecovered = false;
  if (last.viewersStreamed === options.viewers && last.viewersDeferred === 0)
    failures.push(`the stopped viewer was not deferred in ${options.maxDeferCycles} cycles`);
  else if (last.viewersDeferred > 0) {
    stopped!.socket.resume();
    await stopped!.until(() => stopped!.done.has(sceneVersion));
    stoppedViewerRecovered = stopped!.done.get(sceneVersion)!.via === "ready";
    if (!stoppedViewerRecovered) failures.push("the stopped viewer got no scene.snapshot.ready");
  }
  return {
    snapshotBytes: glb.bytes.byteLength,
    before,
    phase1,
    phase2,
    stoppedViewerRecovered,
    failures,
  };
}

/** Command-line options onto `DEFAULT_SMOKE`; throws on a value it cannot use. */
export function smokeOptions(argv: string[]): SmokeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      viewers: { type: "string" },
      cycles: { type: "string" },
      "max-fanout-ms": { type: "string" },
      "max-growth-factor": { type: "string" },
      fixture: { type: "string" },
    },
  });
  const positive = (name: string, value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!(parsed > 0 && Number.isFinite(parsed))) throw new Error(`--${name} must be positive`);
    return parsed;
  };
  const count = (
    name: string,
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const parsed = positive(name, value, fallback);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
    return parsed;
  };
  return {
    ...DEFAULT_SMOKE,
    // Two at least (phase 2 stops one and times the others); a session takes MAX_VIEWERS (§3.3).
    viewers: count("viewers", values.viewers, DEFAULT_SMOKE.viewers, 2, LIMITS.MAX_VIEWERS),
    cycles: count("cycles", values.cycles, DEFAULT_SMOKE.cycles, 3, 100),
    maxFanoutMs: positive("max-fanout-ms", values["max-fanout-ms"], DEFAULT_SMOKE.maxFanoutMs),
    maxGrowthFactor: positive(
      "max-growth-factor",
      values["max-growth-factor"],
      DEFAULT_SMOKE.maxGrowthFactor,
    ),
    fixture: values.fixture ?? DEFAULT_SMOKE.fixture,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result: SmokeResult;
  try {
    result = await runLoadSmoke(smokeOptions(process.argv.slice(2)));
  } catch (error) {
    console.log(`FAIL ${(error as Error).message}`);
    process.exit(1);
  }
  const mib = (bytes: number): string => (bytes / 1_048_576).toFixed(1);
  const after = (m: Memory): string =>
    `relay after GC: RSS ${mib(m.rss)} MiB, buffers ${mib(m.arrayBuffers)} MiB`;
  console.log(
    `snapshot ${mib(result.snapshotBytes)} MiB; before the first: ${after(result.before)}`,
  );
  const line = (label: string, c: CycleResult): string =>
    `${label} ${c.sceneVersion}: ${c.fanoutMs} ms (streamed ${c.viewersStreamed}, deferred ` +
    `${c.viewersDeferred}); ${after(c.memory)}`;
  for (const c of result.phase1) console.log(line("cycle", c));
  for (const c of result.phase2) console.log(line("one viewer stopped, cycle", c));
  console.log(`stopped viewer recovered via ready + HTTP: ${result.stoppedViewerRecovered}`);
  for (const failure of result.failures) console.log(`FAIL ${failure}`);
  process.exit(result.failures.length === 0 ? 0 : 1);
}
