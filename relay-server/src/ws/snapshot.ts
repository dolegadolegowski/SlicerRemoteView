/**
 * Snapshot ingest and completion (docs/protocol.md §3.3, §6.1–§6.4; architecture §3, §5): the checks
 * of `scene.snapshot.begin`, the binary chunk stream into one buffer allocated at `begin`, and its
 * end — verified and swapped into the cache, or aborted. Forwarding to viewers is SRV-10, which
 * plugs into `SnapshotEvents`.
 *
 * - `begin`: `sceneVersion` a uint32 (`INVALID_MESSAGE{instancePath:"/sceneVersion"}`, the chunk
 *   header carries no more) above every version used so far — the last accepted one and every one
 *   a begin announced, refused by this handler or not — else `BAD_SEQUENCE{field:"sceneVersion"}`,
 *   which also discards a snapshot of that version in flight (§9.2); `byteLength` above
 *   `MAX_SNAPSHOT_BYTES` → `PAYLOAD_TOO_LARGE{maxSnapshotBytes}`, also above the protocol maximum
 *   (a limit, §6.2 — the schema's `maximum` would otherwise make it `INVALID_MESSAGE`);
 *   `chunkCount ≠ ceil(byteLength / chunkSize)` → `INVALID_MESSAGE{instancePath:"/chunkCount"}` (the
 *   schema itself bounds `chunkSize` to 64 KiB–1 MiB, `chunkCount` to 1,024 and `extensionsUsed` to
 *   `KHR_mesh_quantization`); cached + in-flight snapshots of all sessions above
 *   `MAX_TOTAL_SNAPSHOT_BYTES` → `CAPACITY`. The chunks of a version this handler refused are
 *   ignored (§6.2); a begin the schema already rejects reserves nothing, so its chunks are
 *   unknown-version violations. A begin with a new version supersedes the snapshot in flight
 *   (`abort{SUPERSEDED}`, §6.2), accepted or not. Accepted: a zero-filled buffer of `byteLength`,
 *   never pooled (T11).
 * - Binary frames (only from the bound publisher, `endpoint.ts`): above 1 MiB + 12 B →
 *   `PAYLOAD_TOO_LARGE` + `1009` (§3.3; `ws` allows up to 1 MiB + 64 KiB); the header and order rules of
 *   `shared` (`decodeChunkHeader`, `checkChunk`) → `BAD_SEQUENCE{field}`, and the snapshot is
 *   discarded; its later chunks are ignored and the publisher starts again with a new version
 *   (§6.3). A payload is copied to `chunkIndex × chunkSize` and fed into a running SHA-256; the relay
 *   never looks at GLB content (T10 is the viewers' job).
 * - `end`: every chunk received and the SHA-256 of the bytes equal to the one of `begin` and `end` →
 *   the snapshot replaces the cached one at once (the old buffer is only dropped, never reused), the
 *   merged node state is reset, the session becomes `active` and the publisher gets
 *   `scene.snapshot.ack`; a missing chunk or another hash → `CHECKSUM_MISMATCH` and the buffer is
 *   dropped (§6.4).
 * - Aborts (`SnapshotEvents.aborted`): a newer begin (`SUPERSEDED`), a sequence error
 *   (`BAD_SEQUENCE`), a checksum mismatch, the publisher's own `scene.snapshot.abort`, its socket lost
 *   (`PUBLISHER_GONE`), and 120 s without a chunk or `end` (`TIMEOUT`; the publisher also gets
 *   `BAD_SEQUENCE{field:"chunkIndex"}`, §3.3). Session close or expiry drops the buffer with the
 *   session (`Registry`). Only the latest refused or discarded version is remembered: a stray chunk
 *   of an older, superseded version (sent after a newer begin) is a sequence violation (§6.3).
 * `INVALID_MESSAGE` and `BAD_SEQUENCE` answers to the publisher's own messages count as protocol
 * violations (the third closes `4007`).
 */
import { createHash } from "node:crypto";
import {
  CHUNK_HEADER_BYTES,
  checkChunk,
  chunkCountFor,
  CLOSE_CODES,
  decodeChunkHeader,
  LIMITS,
} from "@slicerremoteview/shared";
import type { MessageOfType } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "../clock.js";
import type { Config } from "../config.js";
import type { AssemblingSnapshot, CachedSnapshot, Registry, Session } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable, NormalizerTable } from "./dispatch.js";

export type AbortReason = MessageOfType<"scene.snapshot.abort">["reason"];

/** What the viewer fan-out (SRV-10) plugs in. */
export interface SnapshotEvents {
  /** A snapshot in flight was dropped; viewers that got its `begin` get `scene.snapshot.abort`. */
  aborted?(session: Session, sceneVersion: number, reason: AbortReason): void;
  /** A snapshot was verified and cached; returns the counts of `scene.snapshot.ack`. */
  completed?(
    session: Session,
    snapshot: CachedSnapshot,
  ): { viewersStreamed: number; viewersDeferred: number };
}

export interface SnapshotDeps {
  registry: Registry;
  config: Config;
  logger: Logger;
  clock: Clock;
  events?: SnapshotEvents;
}

const UINT32_MAX = 0xffff_ffff;
/** No chunk (or `end`) for this long aborts the snapshot in flight (§3.3). */
export const CHUNK_TIMEOUT_MS = LIMITS.CHUNK_TIMEOUT_S * 1000;
/** At most one `CAPACITY` warning per minute (a publisher can repeat refused begins at will). */
const CAPACITY_WARN_INTERVAL_MS = 60_000;

export function snapshotHandlers({ registry, config, logger, clock, events = {} }: SnapshotDeps) {
  /**
   * The chunk timeout of each session with a snapshot in flight. Keyed by session and holding only
   * the version, so a timer never keeps a buffer alive; cleared when the session is released.
   */
  const timers = new Map<Session, TimerHandle>();
  let lastCapacityWarn = -Infinity;
  let capacityRefusals = 0;
  /** `begin` objects whose `byteLength` was above the protocol maximum (clamped for validation). */
  const oversized = new WeakSet<object>();

  const normalizers: NormalizerTable = {
    "scene.snapshot.begin": (value) => {
      if (typeof value.byteLength === "number" && value.byteLength > LIMITS.MAX_SNAPSHOT_BYTES) {
        oversized.add(value);
        value.byteLength = LIMITS.MAX_SNAPSHOT_BYTES;
      }
    },
  };

  function cancelChunkTimeout(session: Session): void {
    const timer = timers.get(session);
    if (timer !== undefined) clock.clearTimeout(timer);
    timers.delete(session);
  }

  /** Runs a fan-out hook; a throwing hook is logged and must not break the stream or the timer. */
  function hook<T>(session: Session, run: () => T, fallback: T): T {
    try {
      return run();
    } catch {
      // Never the error itself: its text could carry anything.
      logger.error(
        { sessionId: session.id, errorCode: "INTERNAL" },
        "snapshot fan-out hook failed",
      );
      return fallback;
    }
  }

  /** Drops the snapshot in flight, if any: its buffer is freed and its later chunks are ignored. */
  function discard(session: Session, reason: AbortReason): void {
    const assembling = session.assembling;
    if (assembling === undefined) return;
    cancelChunkTimeout(session);
    session.assembling = undefined;
    session.ignoredSnapshotVersion = assembling.sceneVersion;
    hook(session, () => events.aborted?.(session, assembling.sceneVersion, reason), undefined);
    logger.debug(
      { sessionId: session.id, sceneVersion: assembling.sceneVersion, reason },
      "snapshot aborted",
    );
  }

  /** Ignores the rest of a refused version's chunks (§6.2). */
  function ignore(session: Session, sceneVersion: number): void {
    session.ignoredSnapshotVersion = sceneVersion;
  }

  /**
   * 120 s without a chunk or `end` aborts the snapshot of `sceneVersion` in flight (§3.3), checked
   * when the time is up.
   */
  function armTimeout(session: Session, sceneVersion: number, ms: number): void {
    cancelChunkTimeout(session);
    const timer = clock.setTimeout(() => {
      timers.delete(session);
      const assembling = session.assembling;
      if (assembling?.sceneVersion !== sceneVersion) return;
      const idle = clock.now() - assembling.lastChunkAt;
      if (idle < CHUNK_TIMEOUT_MS) {
        armTimeout(session, sceneVersion, CHUNK_TIMEOUT_MS - idle);
        return;
      }
      discard(session, "TIMEOUT");
      session.publisher?.send({
        type: "error",
        code: "BAD_SEQUENCE",
        message: `no chunk for ${LIMITS.CHUNK_TIMEOUT_S} s; snapshot aborted (§3.3)`,
        retryable: true,
        details: { field: "chunkIndex", timeoutS: LIMITS.CHUNK_TIMEOUT_S },
      });
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    timers.set(session, timer);
  }

  const handlers: HandlerTable = {
    "scene.snapshot.begin": (connection, message) => {
      const session = connection.session;
      if (session === undefined) return;
      const replyTo = message.id;
      const { sceneVersion, byteLength, chunkSize, chunkCount } = message;
      if (sceneVersion > UINT32_MAX) {
        connection.violation("INVALID_MESSAGE", "sceneVersion must fit the uint32 of §6.3", {
          replyTo,
          details: { instancePath: "/sceneVersion" },
        });
        return;
      }
      if (sceneVersion <= Math.max(session.sceneVersion, session.lastSnapshotVersion)) {
        // Discards a snapshot of that version in flight (§9.2); its chunks, like those of any stale
        // version, would otherwise each be a violation of their own.
        if (session.assembling?.sceneVersion === sceneVersion) discard(session, "BAD_SEQUENCE");
        ignore(session, sceneVersion);
        connection.violation(
          "BAD_SEQUENCE",
          "sceneVersion must exceed every version used so far (§6.2)",
          { replyTo, retryable: true, details: { field: "sceneVersion" } },
        );
        return;
      }
      session.lastSnapshotVersion = sceneVersion;
      // A newer begin, accepted or not, ends the snapshot in flight (§6.2).
      discard(session, "SUPERSEDED");
      if (oversized.has(message) || byteLength > config.maxSnapshotBytes) {
        ignore(session, sceneVersion);
        connection.sendError(
          "PAYLOAD_TOO_LARGE",
          `snapshot above MAX_SNAPSHOT_BYTES (${config.maxSnapshotBytes} bytes, §3.3)`,
          { replyTo, retryable: false, details: { maxSnapshotBytes: config.maxSnapshotBytes } },
        );
        return;
      }
      if (chunkCount !== chunkCountFor(byteLength, chunkSize)) {
        ignore(session, sceneVersion);
        connection.violation(
          "INVALID_MESSAGE",
          "chunkCount must be ceil(byteLength / chunkSize) (§6.2)",
          { replyTo, details: { instancePath: "/chunkCount" } },
        );
        return;
      }
      if (registry.snapshotBytes + byteLength > config.maxTotalSnapshotBytes) {
        ignore(session, sceneVersion);
        connection.sendError("CAPACITY", "the relay's snapshot budget is exhausted", {
          replyTo,
          retryable: true,
        });
        capacityRefusals += 1;
        if (clock.now() - lastCapacityWarn >= CAPACITY_WARN_INTERVAL_MS) {
          lastCapacityWarn = clock.now();
          logger.warn(
            { errorCode: "CAPACITY", refusals: capacityRefusals },
            "snapshots refused: MAX_TOTAL_SNAPSHOT_BYTES exhausted",
          );
          capacityRefusals = 0;
        }
        return;
      }
      const assembling: AssemblingSnapshot = {
        buffer: Buffer.alloc(byteLength),
        sceneVersion,
        byteLength,
        chunkSize,
        chunkCount,
        nextIndex: 0,
        sha256: message.sha256,
        hash: createHash("sha256"),
        extensionsRequired: message.extensionsRequired ?? [],
        lastChunkAt: clock.now(),
      };
      session.assembling = assembling;
      armTimeout(session, sceneVersion, CHUNK_TIMEOUT_MS);
      logger.debug(
        { sessionId: session.id, sceneVersion, byteLength, chunkCount },
        "snapshot begin",
      );
    },

    "scene.snapshot.end": (connection, message) => {
      const session = connection.session;
      if (session === undefined) return;
      const replyTo = message.id;
      const { sceneVersion } = message;
      if (sceneVersion === session.ignoredSnapshotVersion) return; // refused or discarded before
      const assembling = session.assembling;
      if (assembling?.sceneVersion !== sceneVersion) {
        connection.violation(
          "BAD_SEQUENCE",
          `no snapshot of sceneVersion ${sceneVersion} in flight`,
          {
            replyTo,
            retryable: true,
            details: { field: "sceneVersion" },
          },
        );
        return;
      }
      // Fewer bytes than announced is a length mismatch, answered like a wrong hash (§6.4).
      const complete = assembling.nextIndex === assembling.chunkCount;
      const digest = complete ? assembling.hash.digest("hex") : undefined;
      if (digest !== assembling.sha256 || message.sha256 !== assembling.sha256) {
        discard(session, "CHECKSUM_MISMATCH");
        connection.sendError(
          "CHECKSUM_MISMATCH",
          "the assembled snapshot does not match its sha256 (§6.4)",
          { replyTo, retryable: true },
        );
        logger.info(
          { sessionId: session.id, sceneVersion, errorCode: "CHECKSUM_MISMATCH" },
          "snapshot refused",
        );
        return;
      }
      cancelChunkTimeout(session);
      session.assembling = undefined;
      const snapshot: CachedSnapshot = {
        buffer: assembling.buffer,
        sha256: assembling.sha256,
        byteLength: assembling.byteLength,
        sceneVersion,
        extensionsRequired: assembling.extensionsRequired,
      };
      // One assignment swaps the cache; the previous buffer is only dropped (§6.4, T11).
      session.snapshot = snapshot;
      session.sceneVersion = sceneVersion;
      session.nodeState.clear();
      registry.markActive(session);
      const fallback = { viewersStreamed: 0, viewersDeferred: session.connectedViewers };
      const counts = hook(
        session,
        () => events.completed?.(session, snapshot) ?? fallback,
        fallback,
      );
      connection.send({
        type: "scene.snapshot.ack",
        ...(replyTo !== undefined && { replyTo }),
        sceneVersion,
        ...counts,
      });
      logger.info(
        { sessionId: session.id, sceneVersion, byteLength: snapshot.byteLength },
        "snapshot cached",
      );
    },

    "scene.snapshot.abort": (connection, message) => {
      const session = connection.session;
      // Only the snapshot in flight can be aborted; anything else is already over.
      if (session?.assembling?.sceneVersion === message.sceneVersion)
        discard(session, message.reason);
    },
  };

  /** One binary frame of the bound publisher (§6.3). */
  function chunk(connection: Connection, frame: Buffer): void {
    const session = connection.session;
    if (session === undefined) return;
    if (frame.byteLength > CHUNK_HEADER_BYTES + LIMITS.MAX_CHUNK_BYTES) {
      connection.fail(
        "PAYLOAD_TOO_LARGE",
        `binary chunk above ${LIMITS.MAX_CHUNK_BYTES} bytes + header (§3.3)`,
        CLOSE_CODES.MESSAGE_TOO_BIG,
        { retryable: false, details: { maxChunkBytes: LIMITS.MAX_CHUNK_BYTES } },
      );
      return;
    }
    const decoded = decodeChunkHeader(frame);
    if (decoded.ok && decoded.value.sceneVersion === session.ignoredSnapshotVersion) return;
    const assembling = session.assembling;
    const badSequence = (field: string, text: string): void => {
      discard(session, "BAD_SEQUENCE");
      connection.violation("BAD_SEQUENCE", text, { retryable: true, details: { field } });
    };
    if (!decoded.ok) {
      badSequence(decoded.error.field, decoded.error.message);
      return;
    }
    if (assembling === undefined) {
      badSequence(
        "sceneVersion",
        `no snapshot of sceneVersion ${decoded.value.sceneVersion} in flight`,
      );
      return;
    }
    const checked = checkChunk(decoded.value, assembling);
    if (!checked.ok) {
      badSequence(checked.error.field, checked.error.message);
      return;
    }
    assembling.buffer.set(decoded.value.payload, checked.value.offset);
    assembling.hash.update(decoded.value.payload);
    assembling.nextIndex += 1;
    assembling.lastChunkAt = clock.now();
  }

  /** The publisher's socket is gone: the snapshot in flight cannot complete (§6.4). */
  function publisherGone(session: Session): void {
    discard(session, "PUBLISHER_GONE");
  }

  // A released session (close, expiry) took its buffer with it; only its timer is left to cancel.
  const released = (session: Session): void => cancelChunkTimeout(session);
  registry.on("released", released);

  /** Cancels the chunk timeouts and detaches from the registry (the app calls it on close). */
  const dispose = (): void => {
    for (const timer of timers.values()) clock.clearTimeout(timer);
    timers.clear();
    registry.off("released", released);
  };

  return { handlers, normalizers, chunk, publisherGone, dispose };
}
