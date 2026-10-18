// Reassembly of a GLB snapshot streamed over the WebSocket (WEB-05; docs/protocol.md §6.1–6.4). No DOM, no
// three.js. One `SnapshotStream` holds at most one in-flight snapshot: `scene.snapshot.begin` allocates the
// buffer, binary frames are copied to `chunkIndex × chunkSize`, `scene.snapshot.end` verifies the SHA-256 and
// hands the bytes over (`ready`). Everything that goes wrong frees the buffer first and then reports one event;
// the caller decides what to tell the user (`describeState`) and sends `scene.request{reason:"GAP"}` itself.
//
// Memory (T10, NFR-04): the buffer is only allocated after `begin` passed the §6.2 bounds and fits the size
// this device announced in `capabilities.maxSnapshotBytes`; after `ready` or any failure the stream keeps no
// reference to the bytes.

import {
  MAX_CHUNK_COUNT,
  MAX_CHUNK_SIZE,
  MAX_SNAPSHOT_BYTES,
  MIN_CHUNK_SIZE,
  checkChunk,
  chunkCountFor,
  decodeChunkHeader,
  sha256Hex,
} from "@slicerremoteview/shared";
import type { ChunkHeaderField, MessageOfType } from "@slicerremoteview/shared";
import { DEFAULT_MAX_SNAPSHOT_BYTES } from "./connection";
import type { Connection } from "./connection";

type Begin = MessageOfType<"scene.snapshot.begin">;
type End = MessageOfType<"scene.snapshot.end">;
type Abort = MessageOfType<"scene.snapshot.abort">;

export interface SnapshotStreamOptions {
  /**
   * Largest snapshot this device accepts; must equal what `viewer.join` announced. Default 32 MiB; never more
   * than the §3.3 hard cap of 64 MiB.
   */
  readonly maxSnapshotBytes?: number;
  /** SHA-256 as lowercase hex; default WebCrypto (`crypto.subtle.digest`). */
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

export interface SnapshotStreamEvents {
  /** `received / byteLength`, `0 < fraction ≤ 1`, strictly increasing within one snapshot. */
  progress: { readonly sceneVersion: number; readonly fraction: number };
  /** The complete, hash-verified GLB. The stream no longer references `bytes`. */
  ready: { readonly sceneVersion: number; readonly bytes: Uint8Array };
  /** The snapshot was discarded because a §6.3 receiver rule broke; the caller sends `scene.request`. */
  badSequence: {
    readonly sceneVersion: number;
    readonly field: ChunkHeaderField | "begin" | "end";
  };
  /** SHA-256 of the assembled bytes differs from `begin.sha256` (or could not be computed). */
  checksumMismatch: { readonly sceneVersion: number };
  /** `begin.byteLength` exceeds `maxSnapshotBytes`: nothing was allocated; show `snapshotTooLarge`. */
  tooLarge: { readonly sceneVersion: number; readonly byteLength: number };
  /**
   * The in-flight snapshot was aborted by the relay or publisher (`reason` is the §6.4 enum value), or replaced
   * by a newer `scene.snapshot.begin` (`SUPERSEDED`, emitted by the stream itself).
   */
  aborted: { readonly sceneVersion: number; readonly reason: string };
}

export interface SnapshotStream {
  begin(message: Begin): void;
  /** One binary frame: 12-byte header + payload. */
  chunk(frame: Uint8Array): void;
  end(message: End): Promise<void>;
  abort(message: Abort): void;
  /** Drops the in-flight snapshot, e.g. when the socket closed. */
  reset(): void;
  /** `sceneVersion` of the snapshot being assembled, or `null`. */
  readonly activeVersion: number | null;
  /** Bytes currently allocated for reassembly (`0` when idle) — for tests and the dev overlay. */
  readonly bytesHeld: number;
  on<K extends keyof SnapshotStreamEvents>(
    event: K,
    handler: (payload: SnapshotStreamEvents[K]) => void,
  ): () => void;
}

interface Active {
  readonly begin: Begin;
  readonly buffer: Uint8Array;
  nextIndex: number;
  received: number;
}

/** `sceneVersion` is a uint32 (§6.3 header, §8.4). */
const MAX_SCENE_VERSION = 0xffffffff;

/** How many dropped snapshot versions are remembered so their trailing chunks vanish silently. */
const IGNORED_VERSIONS = 8;

export function createSnapshotStream(options: SnapshotStreamOptions = {}): SnapshotStream {
  const maxBytes = Math.min(
    options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_BYTES,
  );
  const digest = options.sha256 ?? sha256Hex;
  const handlers = new Map<keyof SnapshotStreamEvents, Set<(payload: never) => void>>();
  const ignored: number[] = [];
  let active: Active | null = null;

  function emit<K extends keyof SnapshotStreamEvents>(
    event: K,
    payload: SnapshotStreamEvents[K],
  ): void {
    for (const handler of [...(handlers.get(event) ?? [])])
      (handler as (p: typeof payload) => void)(payload);
  }

  function ignore(sceneVersion: number): void {
    if (!ignored.includes(sceneVersion)) ignored.push(sceneVersion);
    if (ignored.length > IGNORED_VERSIONS) ignored.shift();
  }

  /** Frees the buffer and remembers the version so its remaining chunks are dropped silently. */
  function discard(): number | null {
    if (!active) return null;
    const { sceneVersion } = active.begin;
    active = null;
    ignore(sceneVersion);
    return sceneVersion;
  }

  function fail(sceneVersion: number, field: SnapshotStreamEvents["badSequence"]["field"]): void {
    if (active?.begin.sceneVersion === sceneVersion) discard();
    else ignore(sceneVersion);
    emit("badSequence", { sceneVersion, field });
  }

  /** §6.2 bounds the relay enforces too; a begin outside them is a protocol violation, never allocated. */
  function validBegin(m: Begin): boolean {
    return (
      m.format === "glb" &&
      Number.isInteger(m.sceneVersion) &&
      m.sceneVersion >= 0 &&
      m.sceneVersion <= MAX_SCENE_VERSION &&
      Number.isSafeInteger(m.byteLength) &&
      m.byteLength >= 1 &&
      m.byteLength <= MAX_SNAPSHOT_BYTES &&
      Number.isSafeInteger(m.chunkSize) &&
      m.chunkSize >= MIN_CHUNK_SIZE &&
      m.chunkSize <= MAX_CHUNK_SIZE &&
      m.chunkCount === chunkCountFor(m.byteLength, m.chunkSize) &&
      m.chunkCount <= MAX_CHUNK_COUNT &&
      /^[0-9a-f]{64}$/.test(m.sha256)
    );
  }

  return {
    begin(message) {
      // A new begin aborts the one in flight (§6.2); a later `abort` for it then finds nothing and stays silent.
      const superseded = discard();
      if (superseded !== null) emit("aborted", { sceneVersion: superseded, reason: "SUPERSEDED" });
      const { sceneVersion, byteLength } = message;
      const at = ignored.indexOf(sceneVersion);
      if (at !== -1) ignored.splice(at, 1);
      if (!validBegin(message)) return fail(sceneVersion, "begin");
      if (byteLength > maxBytes) {
        ignore(sceneVersion);
        return emit("tooLarge", { sceneVersion, byteLength });
      }
      active = { begin: message, buffer: new Uint8Array(byteLength), nextIndex: 0, received: 0 };
    },

    chunk(frame) {
      const header = decodeChunkHeader(frame);
      if (!active) return; // no snapshot in flight: stale data, drop silently
      if (!header.ok) return fail(active.begin.sceneVersion, header.error.field);
      const { sceneVersion, chunkIndex, payload } = header.value;
      if (ignored.includes(sceneVersion) && sceneVersion !== active.begin.sceneVersion) return;
      const checked = checkChunk(
        { sceneVersion, chunkIndex, payload },
        {
          sceneVersion: active.begin.sceneVersion,
          byteLength: active.begin.byteLength,
          chunkSize: active.begin.chunkSize,
          chunkCount: active.begin.chunkCount,
          nextIndex: active.nextIndex,
        },
      );
      if (!checked.ok) return fail(active.begin.sceneVersion, checked.error.field);
      active.buffer.set(payload, checked.value.offset);
      active.nextIndex++;
      active.received += payload.byteLength;
      emit("progress", {
        sceneVersion,
        fraction: active.received / active.begin.byteLength,
      });
    },

    async end(message) {
      const current = active;
      if (!current || current.begin.sceneVersion !== message.sceneVersion) return;
      const { sceneVersion } = current.begin;
      if (
        current.nextIndex !== current.begin.chunkCount ||
        current.received !== current.begin.byteLength
      )
        return fail(sceneVersion, "chunkIndex");
      if (message.sha256 !== current.begin.sha256) return fail(sceneVersion, "end");
      let actual: string | null;
      try {
        actual = await digest(current.buffer);
      } catch {
        actual = null; // cannot verify (e.g. no WebCrypto): do not trust the bytes
      }
      if (active !== current) return; // superseded or aborted while hashing
      active = null;
      if (actual !== current.begin.sha256) {
        ignore(sceneVersion);
        return emit("checksumMismatch", { sceneVersion });
      }
      ignore(sceneVersion);
      emit("ready", { sceneVersion, bytes: current.buffer });
    },

    abort(message) {
      if (active?.begin.sceneVersion !== message.sceneVersion) return ignore(message.sceneVersion);
      discard();
      emit("aborted", { sceneVersion: message.sceneVersion, reason: message.reason });
    },

    reset() {
      discard();
    },

    get activeVersion() {
      return active?.begin.sceneVersion ?? null;
    },
    get bytesHeld() {
      return active?.buffer.byteLength ?? 0;
    },

    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      const h = handler as (payload: never) => void;
      set.add(h);
      return () => void set.delete(h);
    },
  };
}

/**
 * Feeds a stream from a connection: `scene.snapshot.begin|end|abort` and binary frames go in. The partial
 * buffer is dropped when the socket is replaced or closes, and when the relay switches this viewer to the HTTP
 * path mid-stream (`scene.snapshot.ready` for the same or a newer version: slow-consumer soft watermark, §3.3,
 * §6.4 (a)) — otherwise up to 32 MiB would stay allocated next to the HTTP download. Returns the unsubscribe
 * function.
 */
export function bindSnapshotStream(connection: Connection, stream: SnapshotStream): () => void {
  const offs = [
    connection.onMessage("scene.snapshot.begin", (m) => stream.begin(m)),
    // A throwing `ready`/`checksumMismatch` handler must not become an unhandled rejection.
    connection.onMessage(
      "scene.snapshot.end",
      (m) => void stream.end(m).catch(() => console.warn("[viewer] snapshot end handler failed")),
    ),
    connection.onMessage("scene.snapshot.abort", (m) => stream.abort(m)),
    connection.onMessage("scene.snapshot.ready", (m) => {
      const active = stream.activeVersion;
      if (active !== null && active <= m.sceneVersion) stream.reset();
    }),
    connection.on("binary", (frame) => stream.chunk(frame)),
    // `begin` only follows `viewer.joined`, so any other state (including `connecting` for a replaced socket)
    // means the partial buffer belongs to a socket that is gone.
    connection.on("state", (s) => {
      if (s.kind !== "connected") stream.reset();
    }),
  ];
  return () => offs.forEach((off) => off());
}
