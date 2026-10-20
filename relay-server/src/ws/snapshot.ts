/**
 * Snapshot ingest, part 1 (docs/protocol.md §3.3, §6.1–§6.3; architecture §5): the checks of
 * `scene.snapshot.begin` and the binary chunk stream into one buffer allocated at `begin`.
 * Verification at `end`, abort, the chunk timeout and the cache swap are part 2 (SRV-24); forwarding
 * to viewers is SRV-10.
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
 *   unknown-version violations. Accepted: a zero-filled buffer of `byteLength`, never pooled (T11),
 *   replaces any in-flight one.
 * - Binary frames (only from the bound publisher, `endpoint.ts`): above 1 MiB + 12 B →
 *   `PAYLOAD_TOO_LARGE` + `1009` (§3.3; `ws` allows up to 1 MiB + 64 KiB); the header and order rules of
 *   `shared` (`decodeChunkHeader`, `checkChunk`) → `BAD_SEQUENCE{field}`, and the snapshot is
 *   discarded; its later chunks are ignored and the publisher starts again with a new version
 *   (§6.3). A payload is copied to `chunkIndex × chunkSize`; the relay never looks at GLB content
 *   (T10 is the viewers' job).
 * `INVALID_MESSAGE` and `BAD_SEQUENCE` count as protocol violations (the third closes `4007`).
 */
import {
  CHUNK_HEADER_BYTES,
  checkChunk,
  chunkCountFor,
  CLOSE_CODES,
  decodeChunkHeader,
  LIMITS,
} from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Registry, Session } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable, NormalizerTable } from "./dispatch.js";

export interface SnapshotDeps {
  registry: Registry;
  config: Config;
  logger: Logger;
  clock: Clock;
}

const UINT32_MAX = 0xffff_ffff;
/** At most one `CAPACITY` warning per minute (a publisher can repeat refused begins at will). */
const CAPACITY_WARN_INTERVAL_MS = 60_000;

export function snapshotHandlers({ registry, config, logger, clock }: SnapshotDeps) {
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

  /** Drops the in-flight snapshot (if any) and ignores the rest of `sceneVersion`'s chunks. */
  function ignore(session: Session, sceneVersion: number): void {
    if (session.assembling?.sceneVersion === sceneVersion) session.assembling = undefined;
    session.ignoredSnapshotVersion = sceneVersion;
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
        ignore(session, sceneVersion);
        connection.violation(
          "BAD_SEQUENCE",
          "sceneVersion must exceed every version used so far (§6.2)",
          { replyTo, retryable: true, details: { field: "sceneVersion" } },
        );
        return;
      }
      session.lastSnapshotVersion = sceneVersion;
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
      // The in-flight snapshot of this session gives way to the new one (§6.2), so it does not
      // count against the budget.
      const inFlight = session.assembling?.buffer.byteLength ?? 0;
      if (registry.snapshotBytes - inFlight + byteLength > config.maxTotalSnapshotBytes) {
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
      session.assembling = {
        buffer: Buffer.alloc(byteLength),
        sceneVersion,
        byteLength,
        chunkSize,
        chunkCount,
        nextIndex: 0,
        sha256: message.sha256,
        extensionsRequired: message.extensionsRequired ?? [],
        lastChunkAt: clock.now(),
      };
      logger.debug(
        { sessionId: session.id, sceneVersion, byteLength, chunkCount },
        "snapshot begin",
      );
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
      if (assembling !== undefined) ignore(session, assembling.sceneVersion);
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
    assembling.nextIndex += 1;
    assembling.lastChunkAt = clock.now();
  }

  return { handlers, normalizers, chunk };
}
