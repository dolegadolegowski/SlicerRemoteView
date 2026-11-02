// QA-08 load clients: a publisher that streams snapshots and updates, a measuring viewer, a synthetic GLB of any
// (4-byte aligned) size, and a relay RSS sampler. Node `ws` + `fetch` only (docs/research/qa-load-tooling.md:
// why not k6). The encoder is the product's own — `chunkify`/`encodeChunkFrame`/`decodeChunkHeader` from
// `@slicerremoteview/shared` and `snapshotBegin`/`envelope` from fake-slicer (PRO-14) — so the load clients speak
// exactly what the publisher and the viewers speak (docs/protocol.md §6.1–§6.5, §8.1).
//
// Secrets (NFR-12): the session code and the viewer tokens live in private fields; nothing here prints, logs or
// throws them. Error messages carry versions, counts, HTTP statuses and protocol error codes only.

import { execFile } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import type { Hash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { RawData } from "ws";
import { envelope, snapshotBegin } from "@slicerremoteview/fake-slicer";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { chunkify, decodeChunkHeader, encodeChunkFrame, LIMITS, PROTOCOL_VERSION } from "@slicerremoteview/shared";
import { createSession, nextIp } from "../harness/ws-client.ts";
import type { Client, Message } from "../harness/ws-client.ts";

export const MiB = 1_048_576;
/** Recommended `chunkSize` (§6.2). */
export const CHUNK_SIZE = LIMITS.MAX_CHUNK_BYTES;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A GLB-shaped buffer of exactly `byteLength` bytes (a multiple of 4, glTF 2.0 §4.4): a 12-byte header, a JSON
 * chunk padded to 512 bytes (one scene, the `SlicerRemoteView` root with the §7.1 extras and one `T` node) and a
 * BIN chunk of random bytes, so every call has its own SHA-256 (two sessions can never pass each other's check).
 * The relay never parses the GLB (relay-server/src/ws/snapshot.ts: "the relay never looks at GLB content"), so the
 * BIN content does not matter for load; it is not a renderable model.
 */
export function syntheticGlb(byteLength: number, sceneVersion = 1): LoadedGlb {
  const jsonLength = 512;
  const binLength = byteLength - 12 - 8 - jsonLength - 8;
  if (byteLength % 4 !== 0 || binLength < 0) throw new RangeError(`no GLB of ${byteLength} bytes`);
  const nodeId = "vtkMRMLModelNode1";
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "SlicerRemoteView qa-load" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "SlicerRemoteView",
        children: [1],
        extras: { nodeId: "root", kind: "root", sceneVersion, profile: "mobile", units: "m", upAxis: "+Y" },
      },
      { name: "Model 1", extras: { nodeId, kind: "model" } },
    ],
    buffers: [{ byteLength: binLength }],
  });
  if (Buffer.byteLength(json) > jsonLength) throw new Error("synthetic GLB JSON does not fit its chunk");
  const bytes = Buffer.allocUnsafeSlow(byteLength);
  bytes.writeUInt32LE(0x46546c67, 0); // "glTF"
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(byteLength, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  bytes.fill(0x20, 20, 20 + jsonLength); // JSON chunks pad with spaces
  bytes.write(json, 20, "utf8");
  const binAt = 20 + jsonLength;
  bytes.writeUInt32LE(binLength, binAt);
  bytes.writeUInt32LE(0x004e4942, binAt + 4); // "BIN\0"
  randomFillSync(bytes, binAt + 8, binLength);
  return {
    bytes,
    sha256: sha256(bytes),
    extensionsUsed: [],
    extensionsRequired: [],
    nodeCount: 1,
    nodeIds: [nodeId],
    triangleCount: 0,
  };
}

/** `ws` `send` with its callback: resolves once `ws` handed the frame to the socket (back-pressure). */
function sendFrame(socket: WebSocket, frame: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(frame, { binary: typeof frame !== "string" }, (error) => (error ? reject(error) : resolve())),
  );
}

/** A publisher socket (`session.create` from its own address); the code stays in a private field. */
export class LoadPublisher {
  readonly #code: string;
  #ids = 0;

  private constructor(
    readonly client: Client,
    code: string,
  ) {
    this.#code = code;
  }

  static async create(wsUrl: string): Promise<LoadPublisher> {
    const { client, created } = await createSession(wsUrl, { ip: nextIp() });
    return new LoadPublisher(client, created.code as string);
  }

  /** The session code, for `LoadViewer.join` only. Never print it. */
  code(): string {
    return this.#code;
  }

  nextId(): string {
    return `p-${++this.#ids}`;
  }

  send(frame: string | Uint8Array): Promise<void> {
    return sendFrame(this.client.socket, frame);
  }

  /**
   * `begin`, every chunk and `end` (§6.1) — never paced by the viewers (a real publisher cannot see them). By
   * default as fast as the socket takes them, like fake-slicer's `sendSnapshot`; with `uplinkBytesPerS`, chunk i
   * leaves no earlier than (i × chunkSize) / rate after `begin`, a publisher behind an uplink of that rate.
   * Resolves with `performance.now()` just before `begin`.
   */
  async sendSnapshot(glb: LoadedGlb, sceneVersion: number, uplinkBytesPerS?: number): Promise<number> {
    const beganAt = performance.now();
    await this.send(snapshotBegin({ glb, sceneVersion, chunkSize: CHUNK_SIZE, profile: "mobile" }, this.nextId()));
    for (const { chunkIndex, payload } of chunkify(glb.bytes, CHUNK_SIZE)) {
      if (uplinkBytesPerS !== undefined) {
        const wait = beganAt + (1000 * chunkIndex * CHUNK_SIZE) / uplinkBytesPerS - performance.now();
        if (wait > 0) await delay(wait);
      }
      await this.send(encodeChunkFrame({ sceneVersion, chunkIndex }, payload));
    }
    await this.send(envelope("scene.snapshot.end", this.nextId(), { sceneVersion, sha256: glb.sha256 }));
    return beganAt;
  }

  /** The `scene.snapshot.ack` of `sceneVersion`; throws on an `error` first (its code only). */
  async ack(sceneVersion: number, timeoutMs = 60_000): Promise<Message> {
    const message = await this.client.next(
      (m) => (m.type === "scene.snapshot.ack" && m.sceneVersion === sceneVersion) || m.type === "error",
      timeoutMs,
    );
    if (message.type === "error") throw new Error(`publisher got error ${String(message.code)} instead of ack`);
    return message;
  }

  /** One `scene.update` (§8.1); `id` is returned so a refusal can be matched by `replyTo`. */
  sendUpdate(sceneVersion: number, baseVersion: number, changes: Record<string, unknown>[]): string {
    const id = this.nextId();
    this.client.send({ type: "scene.update", id, ts: Date.now(), sceneVersion, baseVersion, changes });
    return id;
  }

  /** Every `error` the publisher was sent so far. */
  errors(): Message[] {
    return this.client.messages.filter((m) => m.type === "error");
  }

  close(): void {
    this.client.terminate();
  }
}

/** When a viewer held a whole snapshot, how it came, and what it hashed to. */
export interface Held {
  at: number;
  via: "end" | "ready";
  sha256: string;
  byteLength: number;
}

/** One received `scene.update`/`scene.nodeRemoved`, timed on this process's clock. */
export interface UpdateArrival {
  sceneVersion: number;
  baseVersion: number;
  at: number;
}

interface Stream {
  sceneVersion: number;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  sha256: string;
  hash: Hash;
  next: number;
  received: number;
}

/**
 * A measuring viewer (`viewer.join` by code from its own address): it verifies every snapshot it is sent —
 * streamed chunks hashed as they arrive (order, size and SHA-256 per §6.3/§6.4), or `scene.snapshot.ready` plus
 * `GET /api/scene/:v` with its token (§6.5, §10) — without keeping the bytes, and timestamps updates.
 */
export class LoadViewer {
  readonly held = new Map<number, Held>();
  readonly updates: UpdateArrival[] = [];
  /** `error.code` values the relay sent this viewer. */
  readonly errorCodes: string[] = [];
  /** Protocol violations this viewer saw (never secrets). */
  readonly failures: string[] = [];
  /** Versions whose `begin` this viewer got (it was streamed, at least at first). */
  readonly begun = new Set<number>();
  /** For a stream cut short by `scene.snapshot.ready`: how many chunks had arrived (the deferral point). */
  readonly cutAfterChunks = new Map<number, number>();
  readonly readyVersions: number[] = [];
  closeCode: number | undefined;
  #token = "";
  #stream: Stream | undefined;
  #latestReady = 0;
  #discarded = new Set<number>();
  #waiters = new Set<() => void>();

  private constructor(
    readonly socket: WebSocket,
    private readonly httpBase: string,
  ) {}

  /**
   * Joins by code and waits for `viewer.joined`. `paused`: the socket stops reading right after it (ws
   * `WebSocket#pause()`, tests/node_modules/@types/ws/index.d.ts) — the slow consumer of FR-24.
   */
  static async join(wsUrl: string, httpBase: string, code: string, options: { paused?: boolean } = {}) {
    const socket = new WebSocket(wsUrl, {
      headers: { "X-Forwarded-For": nextIp() },
      perMessageDeflate: false,
      maxPayload: 2 * MiB,
    });
    const viewer = new LoadViewer(socket, httpBase);
    socket.on("message", (data: RawData, isBinary: boolean) => viewer.#onMessage(data as Buffer, isBinary));
    socket.on("close", (closeCode: number) => {
      viewer.closeCode = closeCode;
      viewer.#wake();
    });
    socket.on("error", () => viewer.#fail("socket error"));
    await once(socket, "open"); // rejects on an `error` event (node:events `once`)
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "viewer.join",
        id: "v-1",
        code,
        clientInfo: {
          app: "qa-load",
          version: "0.0.0-qa",
          platform: "other",
          profile: "mobile",
          capabilities: { httpScene: true, maxSnapshotBytes: LIMITS.MAX_SNAPSHOT_BYTES },
        },
      }),
    );
    if (!(await viewer.until(() => viewer.#token !== "", 15_000)))
      throw new Error(`viewer.join not answered (errors ${viewer.errorCodes.join(",") || "none"})`);
    if (options.paused) socket.pause();
    return viewer;
  }

  /** Resolves `true` once `probe()` holds (re-checked on every frame and close), `false` after `timeoutMs`. */
  until(probe: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (!probe()) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        resolve(false);
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  resume(): void {
    this.socket.resume();
  }

  close(): void {
    this.socket.terminate();
  }

  /** `GET /api/scene/:v` with this viewer's token: status, and for a 200 the hash and size of the body. */
  async fetchScene(sceneVersion: number): Promise<{ status: number; sha256?: string; byteLength?: number }> {
    const response = await fetch(`${this.httpBase}/api/scene/${sceneVersion}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (response.headers.get("x-scene-version") !== String(sceneVersion))
      this.#fail(`GET /api/scene/${sceneVersion}: X-Scene-Version differs`);
    return { status: response.status, sha256: sha256(body), byteLength: body.byteLength };
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  #fail(reason: string): void {
    this.failures.push(reason);
    this.#wake();
  }

  #onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) this.#onChunk(data);
    else this.#onText(JSON.parse(data.toString()) as Message);
    this.#wake();
  }

  #onChunk(frame: Buffer): void {
    const header = decodeChunkHeader(frame);
    if (!header.ok) return this.#fail(`bad chunk header (${header.error.field})`);
    const { sceneVersion, chunkIndex, payload } = header.value;
    const stream = this.#stream;
    if (stream === undefined || stream.sceneVersion !== sceneVersion) {
      if (!this.#discarded.has(sceneVersion)) this.#fail(`chunk of version ${sceneVersion} outside its stream`);
      return; // a viewer ignores later chunks of a version it fetches over HTTP (§6.4)
    }
    const expected = Math.min((chunkIndex + 1) * stream.chunkSize, stream.byteLength) - chunkIndex * stream.chunkSize;
    if (chunkIndex !== stream.next) return this.#fail(`chunk ${chunkIndex} out of order (expected ${stream.next})`);
    if (payload.byteLength !== expected) return this.#fail(`chunk ${chunkIndex}: ${payload.byteLength} B`);
    stream.hash.update(payload);
    stream.next += 1;
    stream.received += payload.byteLength;
  }

  #onText(message: Message): void {
    const version = message.sceneVersion as number;
    switch (message.type) {
      case "viewer.joined":
        this.#token = message.viewerToken as string;
        return;
      case "error":
        this.errorCodes.push(String(message.code));
        return;
      case "scene.snapshot.begin":
        this.begun.add(version);
        this.#stream = {
          sceneVersion: version,
          byteLength: message.byteLength as number,
          chunkSize: message.chunkSize as number,
          chunkCount: message.chunkCount as number,
          sha256: message.sha256 as string,
          hash: createHash("sha256"),
          next: 0,
          received: 0,
        };
        return;
      case "scene.snapshot.end": {
        const stream = this.#stream;
        this.#stream = undefined;
        if (stream === undefined || stream.sceneVersion !== version) {
          if (!this.#discarded.has(version)) this.#fail(`end of version ${version} without its stream`);
          return;
        }
        if (stream.next !== stream.chunkCount || stream.received !== stream.byteLength)
          return this.#fail(`end of ${version} after ${stream.next}/${stream.chunkCount} chunks`);
        const digest = stream.hash.digest("hex");
        if (digest !== stream.sha256 || digest !== message.sha256)
          return this.#fail(`snapshot ${version} via end: SHA-256 mismatch`);
        this.held.set(version, { at: performance.now(), via: "end", sha256: digest, byteLength: stream.received });
        return;
      }
      case "scene.snapshot.abort":
        if (this.#stream?.sceneVersion === version) this.#stream = undefined;
        this.#discarded.add(version);
        return;
      case "scene.snapshot.ready":
        this.readyVersions.push(version);
        this.#latestReady = Math.max(this.#latestReady, version);
        if (this.#stream?.sceneVersion === version) {
          this.cutAfterChunks.set(version, this.#stream.next);
          this.#stream = undefined;
        }
        this.#discarded.add(version);
        void this.#download(version, message.sha256 as string, message.byteLength as number);
        return;
      case "scene.update":
      case "scene.nodeRemoved":
        this.updates.push({ sceneVersion: version, baseVersion: message.baseVersion as number, at: performance.now() });
        return;
    }
  }

  /**
   * The HTTP path of §6.5; a 404 for a version a newer `ready` superseded is not a failure (§10). A viewer that
   * was paused through several snapshots reads their `ready`s in one burst after resuming, so the 404 of an older
   * version can come back before the newer `ready` is parsed: wait a moment for it before calling it a failure.
   */
  async #download(version: number, expectedSha: string, byteLength: number): Promise<void> {
    try {
      const result = await this.fetchScene(version);
      if (result.status === 404 && (await this.until(() => this.#latestReady > version, 5_000))) return;
      if (result.status !== 200) return this.#fail(`GET /api/scene/${version}: HTTP ${result.status}`);
      if (result.sha256 !== expectedSha || result.byteLength !== byteLength)
        return this.#fail(`snapshot ${version} via ready: SHA-256 or length mismatch`);
      this.held.set(version, { at: performance.now(), via: "ready", sha256: result.sha256, byteLength });
      this.#wake();
    } catch (error) {
      this.#fail(`GET /api/scene/${version}: ${(error as Error).name}`);
    }
  }
}

const execFileAsync = promisify(execFile);

/** The resident set size of `pid` in bytes (`ps -o rss=` reports KiB; macOS and procps alike). */
export async function rssBytes(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

export interface RssMetrics {
  beforeMiB: number;
  peakMiB: number;
  afterMiB: number;
  samples: number;
}

const toMiB = (bytes: number): number => Math.round((bytes / MiB) * 10) / 10;

/**
 * Samples the relay's RSS every `intervalMs` from `start()` to `stop()` (the peak can fall between two samples:
 * 100 ms is about three 1 MiB chunks to 20 viewers on this machine, so it is a lower bound of the true peak).
 */
export class RssSampler {
  #before = 0;
  #peak = 0;
  #samples = 0;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly pid: number,
    private readonly intervalMs = 100,
  ) {}

  async start(): Promise<void> {
    this.#before = await rssBytes(this.pid);
    this.#peak = this.#before;
    this.#running = (async () => {
      while (!this.#stopped) {
        await this.sample();
        await delay(this.intervalMs);
      }
    })();
  }

  async sample(): Promise<number> {
    const rss = await rssBytes(this.pid);
    this.#samples += 1;
    this.#peak = Math.max(this.#peak, rss);
    return rss;
  }

  /** Stops sampling; `after` is taken `settleMs` later (sockets closed, buffers dropped — no forced GC). */
  async stop(settleMs = 1_000): Promise<RssMetrics> {
    this.#stopped = true;
    await this.#running;
    await delay(settleMs);
    const after = await this.sample();
    return { beforeMiB: toMiB(this.#before), peakMiB: toMiB(this.#peak), afterMiB: toMiB(after), samples: this.#samples };
  }

  get peakBytes(): number {
    return this.#peak;
  }
}

/** Nearest-rank percentile (`p` in 0..100) of `values`; `NaN` for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** How many viewers ended with which close code (`open` while still connected). */
export function closeCodes(viewers: readonly LoadViewer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const viewer of viewers) {
    const key = viewer.closeCode === undefined ? "open" : String(viewer.closeCode);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
