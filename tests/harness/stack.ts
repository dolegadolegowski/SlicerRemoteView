// System-test stack (QA-02): the built relay (staged by stage.ts, serving the built web-viewer) on a free local
// port, plus an optional fake-slicer publisher. Never talks to a remote host: every URL is 127.0.0.1.
//
// Secrets stay in memory (NFR-12): the session code is read from fake-slicer's `--code-fd 3 --json` pipe, never
// from its stdout/stderr, and is never printed by the harness. Relay and publisher output go to log files (the
// relay's is the input of the log-grep suite, QA-07); `outputs()` returns the publisher's stdout/stderr so specs
// can assert the code is absent from them.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_SLICER_BIN, REPO_ROOT } from "./paths.ts";
import { stageRelay } from "./stage.ts";

export interface RelayOptions {
  /** Fixed port (a restart reuses it); default: a free one picked before start. */
  port?: number;
  /** pino level; `trace` by default so the log-grep sees everything the relay can log. */
  logLevel?: string;
  /** `RELAY_TEST_FAST_TIMERS=1` (rate-limit windows ÷ 60, 1 s sweep; SRV-29). */
  fastTimers?: boolean;
  /** `TRUST_PROXY` (default true: raw clients pick their address with `X-Forwarded-For`, browsers use 127.0.0.1). */
  trustProxy?: boolean;
  /** Extra environment (e.g. `MAX_VIEWERS`, `SESSION_TTL_S`). */
  env?: Record<string, string>;
  /** Log file; default `<dir>/relay.log`. */
  logPath?: string;
  /** Directory for logs; default a fresh temp dir. */
  dir?: string;
}

export interface Relay {
  readonly port: number;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly logPath: string;
  readonly process: ChildProcess;
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;
  /** SIGTERM (the relay drains with `4008`), then SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** The relay log so far. */
  log(): string;
}

const children = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

/** A free TCP port on 127.0.0.1 (the relay needs it up front: `ALLOWED_ORIGINS` names it). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function exitPromise(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function terminate(child: ChildProcess, exited: Promise<unknown>, graceMs: number, signal: NodeJS.Signals) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
  children.delete(child);
}

/** Environment of a test relay: inherited PATH etc., but never a Railway variable (config.ts refuses fast timers). */
function relayEnv(options: RelayOptions, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("RAILWAY_") && !key.startsWith("RELAY_TEST_")) env[key] = value;
  Object.assign(env, {
    NODE_ENV: "test",
    PORT: String(port),
    LOG_LEVEL: options.logLevel ?? "trace",
    TRUST_PROXY: String(options.trustProxy ?? true),
    ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    ...(options.fastTimers ? { RELAY_TEST_FAST_TIMERS: "1" } : {}),
    ...options.env,
  });
  delete env["NODE_OPTIONS"];
  return env;
}

async function waitHealthy(baseUrl: string, exited: Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  let dead = false;
  void exited.then(() => (dead = true));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead) throw new Error("the relay exited during start-up (see its log)");
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the relay was not healthy within ${timeoutMs} ms`);
}

/** Starts the staged relay build (`node dist/index.js`, like the image's CMD) and waits for `/healthz`. */
export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const entry = stageRelay();
  const port = options.port ?? (await freePort());
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "srv-qa-"));
  mkdirSync(dir, { recursive: true });
  const logPath = options.logPath ?? path.join(dir, "relay.log");
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: relayEnv(options, port),
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  children.add(child);
  const exited = exitPromise(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const relay: Relay = {
    port,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    logPath,
    process: child,
    exited,
    stop: (graceMs = 8_000) => terminate(child, exited, graceMs, "SIGTERM"),
    log: () => readFileSync(logPath, "utf8"),
  };
  try {
    await waitHealthy(baseUrl, exited);
  } catch (error) {
    await relay.stop(1_000);
    throw error;
  }
  return relay;
}

/** One line of fake-slicer's `--json` code pipe: the code line or an event (tools/fake-slicer/README.md). */
export type PublisherEvent =
  | { code: string; url: string }
  | { event: string; [key: string]: unknown };

export interface PublisherOptions {
  /** Fixture name in `shared/fixtures/glb/` or a path (default `asymmetric-2nodes.glb`). */
  fixture?: string;
  /** Bundled script name or a path. */
  script?: string;
  /** Any other CLI options (`--loop`, `--close-after`, `--chunk-size`, `--preferred-code`, …). */
  args?: string[];
  /** Wait for `snapshot 1 acknowledged` before resolving (default true). */
  waitForAck?: boolean;
  /** Log file for stdout+stderr; default next to the relay log. */
  logPath?: string;
}

export interface Publisher {
  /** The current session code (updated when a re-created session got a new one). In memory only. */
  code(): string;
  readonly events: PublisherEvent[];
  readonly process: ChildProcess;
  readonly exited: Promise<number | null>;
  /** Resolves with the first event (code lines included) that matches, or rejects after `timeoutMs`. */
  waitForEvent(match: (e: PublisherEvent) => boolean, timeoutMs?: number): Promise<PublisherEvent>;
  /** Resolves once stderr contains `text` (progress lines carry no code). */
  waitForOutput(text: string | RegExp, timeoutMs?: number): Promise<void>;
  /** stdout and stderr so far (to assert the code is absent). */
  outputs(): { stdout: string; stderr: string };
  /** SIGINT (fake-slicer's Ctrl-C), SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

/** Starts `tools/fake-slicer/bin/fake-slicer.js` directly (npx/npm would not pass fd 3 on) against `wsUrl`. */
export async function startPublisher(wsUrl: string, options: PublisherOptions = {}): Promise<Publisher> {
  const args = [FAKE_SLICER_BIN, "--relay", wsUrl, "--code-fd", "3", "--json"];
  if (options.fixture) args.push("--fixture", options.fixture);
  if (options.script) args.push("--script", options.script);
  args.push(...(options.args ?? []));
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  children.add(child);
  const exited = exitPromise(child);
  let stdout = "";
  let stderr = "";
  const events: PublisherEvent[] = [];
  let code: string | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const record = (d: string) => options.logPath && appendFileSync(options.logPath, d);
  child.stdout!.setEncoding("utf8").on("data", (d: string) => ((stdout += d), record(d), notify()));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => ((stderr += d), record(d), notify()));
  let pending = "";
  const fd3 = child.stdio[3] as NodeJS.ReadableStream;
  fd3.setEncoding("utf8");
  fd3.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as PublisherEvent;
      if ("code" in event && typeof event.code === "string") code = event.code;
      events.push(event);
    }
    notify();
  });
  let dead = false;
  void exited.then(() => ((dead = true), notify()));

  const waitFor = (check: () => boolean, what: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const listener = () => {
        if (check()) {
          cleanup();
          resolve();
        } else if (dead) {
          cleanup();
          // Only the error code part of stderr is ever printed by fake-slicer; still, quote nothing.
          reject(new Error(`fake-slicer exited (code ${child.exitCode}) before ${what}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(listener);
      };
      listeners.add(listener);
      listener();
    });

  const publisher: Publisher = {
    code: () => {
      if (code === undefined) throw new Error("no session code yet");
      return code;
    },
    events,
    process: child,
    exited,
    async waitForEvent(match, timeoutMs = 15_000) {
      let found: PublisherEvent | undefined;
      await waitFor(() => (found = events.find(match)) !== undefined, "a fake-slicer event", timeoutMs);
      return found!;
    },
    waitForOutput: (text, timeoutMs = 15_000) =>
      waitFor(
        () => (typeof text === "string" ? stderr.includes(text) : text.test(stderr)),
        `fake-slicer output ${String(text)}`,
        timeoutMs,
      ),
    outputs: () => ({ stdout, stderr }),
    stop: (graceMs = 5_000) => terminate(child, exited, graceMs, "SIGINT"),
  };
  try {
    await waitFor(() => code !== undefined, "the session code", 15_000);
    if (options.waitForAck ?? true) await publisher.waitForOutput("snapshot 1 acknowledged");
  } catch (error) {
    await publisher.stop(1_000);
    throw error;
  }
  return publisher;
}

export interface StackOptions extends RelayOptions {
  /** `false`: relay only. Otherwise fake-slicer options. */
  publisher?: PublisherOptions | false;
}

export interface Stack {
  readonly relay: Relay;
  readonly publisher: Publisher | undefined;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly logPath: string;
  /** The session code (throws without a publisher). Keep it in memory: never log or attach it. */
  readonly code: string;
  /** Stops the relay (SIGTERM → `4008` drain) and starts a new one on the same port with the same options. */
  restartRelay(): Promise<void>;
  /** Stops publisher and relay; safe to call twice. */
  stop(): Promise<void>;
}

/** Relay + publisher, as QA-02 specifies: `{ baseUrl, code, logPath, stop() }` and a little more. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "srv-qa-"));
  let relay = await startRelay({ ...options, dir });
  let publisher: Publisher | undefined;
  if (options.publisher !== false) {
    try {
      publisher = await startPublisher(relay.wsUrl, {
        logPath: path.join(dir, "publisher.log"),
        ...(options.publisher ?? {}),
      });
    } catch (error) {
      await relay.stop();
      throw error;
    }
  }
  let stopped = false;
  return {
    get relay() {
      return relay;
    },
    publisher,
    get baseUrl() {
      return relay.baseUrl;
    },
    get wsUrl() {
      return relay.wsUrl;
    },
    get logPath() {
      return relay.logPath;
    },
    get code() {
      if (!publisher) throw new Error("this stack has no publisher");
      return publisher.code();
    },
    async restartRelay() {
      await relay.stop();
      relay = await startRelay({ ...options, dir, port: relay.port, logPath: relay.logPath });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await publisher?.stop();
      await relay.stop();
    },
  };
}
