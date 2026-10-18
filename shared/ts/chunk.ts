/**
 * Binary chunk helpers for GLB snapshots (`docs/protocol.md` §6.2–6.3).
 *
 * Every binary WebSocket frame is a 12-byte little-endian header followed by the payload:
 * `SRVC` magic, `sceneVersion` uint32, `chunkIndex` uint32. Pure functions over `Uint8Array`
 * so the same code runs in Node (relay, fake-slicer) and in browsers (web-viewer).
 */

import { LIMITS } from "./constants.js";

/** ASCII `SRVC` (§6.3). */
export const CHUNK_MAGIC = "SRVC";
export const CHUNK_HEADER_BYTES = 12;
/** Smallest `chunkSize` a publisher may announce: 64 KiB (§6.2). */
export const MIN_CHUNK_SIZE: number = LIMITS.MIN_CHUNK_BYTES;
/** Largest chunk payload, and the recommended `chunkSize`: 1 MiB (§3.3, §6.2). */
export const MAX_CHUNK_SIZE: number = LIMITS.MAX_CHUNK_BYTES;
/** Hard cap on one snapshot: 64 MiB (§3.3). */
export const MAX_SNAPSHOT_BYTES: number = LIMITS.MAX_SNAPSHOT_BYTES;
/** `chunkCount <= 1024` (§3.3), so `chunkIndex` is `0..1023`. */
export const MAX_CHUNK_COUNT: number = LIMITS.MAX_CHUNK_COUNT;
const UINT32_MAX = 0xffff_ffff;
const MAGIC_BYTES = new TextEncoder().encode(CHUNK_MAGIC);

export interface ChunkHeader {
  /** Same value as in `scene.snapshot.begin` (§6.2). */
  sceneVersion: number;
  /** `0..chunkCount-1`, strictly increasing (§6.3). */
  chunkIndex: number;
}

/**
 * Which part of a frame broke a §6.3 receiver rule, reported as `error.details.field`:
 * `length` = frame shorter than the header, `payload` = payload size not matching the expected
 * size, the others name the header field. Python and C# receivers use the same vocabulary.
 */
export type ChunkHeaderField = "length" | "magic" | "sceneVersion" | "chunkIndex" | "payload";

/** Failure a receiver reports as `error` `BAD_SEQUENCE` with `details.field` (§6.3, §9.2). */
export interface ChunkError {
  code: "BAD_SEQUENCE";
  field: ChunkHeaderField;
  message: string;
}

export type ChunkResult<T> = { ok: true; value: T } | { ok: false; error: ChunkError };

const fail = (field: ChunkHeaderField, message: string): ChunkResult<never> => ({
  ok: false,
  error: { code: "BAD_SEQUENCE", field, message },
});

function assertUint32(name: string, value: number, max = UINT32_MAX): void {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError(`${name} must be an integer in 0..${max}, got ${value}`);
}

/** The 12-byte header of §6.3 for one chunk. Throws `RangeError` on values outside the protocol range. */
export function encodeChunkHeader({ sceneVersion, chunkIndex }: ChunkHeader): Uint8Array {
  assertUint32("sceneVersion", sceneVersion);
  assertUint32("chunkIndex", chunkIndex, MAX_CHUNK_COUNT - 1);
  const header = new Uint8Array(CHUNK_HEADER_BYTES);
  header.set(MAGIC_BYTES, 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, sceneVersion, true);
  view.setUint32(8, chunkIndex, true);
  return header;
}

/**
 * Parses the header of a binary frame and returns it with the payload (a view, not a copy).
 * Only frame-local rules are checked here (length, magic, `chunkIndex` within `0..1023`);
 * session-level rules (known `sceneVersion`, order, payload size) are `checkChunk`.
 */
export function decodeChunkHeader(
  frame: Uint8Array,
): ChunkResult<ChunkHeader & { payload: Uint8Array }> {
  if (frame.byteLength < CHUNK_HEADER_BYTES)
    return fail(
      "length",
      `binary frame of ${frame.byteLength} bytes is shorter than the ${CHUNK_HEADER_BYTES}-byte header`,
    );
  for (let i = 0; i < MAGIC_BYTES.length; i++)
    if (frame[i] !== MAGIC_BYTES[i]) return fail("magic", `chunk magic is not ${CHUNK_MAGIC}`);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const sceneVersion = view.getUint32(4, true);
  const chunkIndex = view.getUint32(8, true);
  if (chunkIndex >= MAX_CHUNK_COUNT)
    return fail(
      "chunkIndex",
      `chunkIndex ${chunkIndex} exceeds the maximum of ${MAX_CHUNK_COUNT - 1}`,
    );
  return {
    ok: true,
    value: { sceneVersion, chunkIndex, payload: frame.subarray(CHUNK_HEADER_BYTES) },
  };
}

/** What a receiver knows from `scene.snapshot.begin` plus the index it expects next (§6.3). */
export interface ExpectedChunk {
  sceneVersion: number;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  /** `0` for the first chunk, then the previous `chunkIndex + 1`. */
  nextIndex: number;
}

/** Number of chunks for a snapshot: `ceil(byteLength / chunkSize)` (§6.2). */
export function chunkCountFor(byteLength: number, chunkSize: number): number {
  return Math.ceil(byteLength / chunkSize);
}

/** Payload bytes chunk `chunkIndex` must carry: `chunkSize` except for a shorter last chunk (§6.3). */
export function expectedPayloadLength(
  chunkIndex: number,
  { byteLength, chunkSize }: Pick<ExpectedChunk, "byteLength" | "chunkSize">,
): number {
  return Math.min((chunkIndex + 1) * chunkSize, byteLength) - chunkIndex * chunkSize;
}

/**
 * Applies the §6.3 receiver rules to a decoded chunk: unknown `sceneVersion`, out-of-order or
 * duplicate `chunkIndex`, index beyond `chunkCount`, payload size not matching the expected size
 * → `BAD_SEQUENCE` naming the field; the caller discards the snapshot.
 */
export function checkChunk(
  chunk: ChunkHeader & { payload: Uint8Array },
  expected: ExpectedChunk,
): ChunkResult<{ offset: number }> {
  if (chunk.sceneVersion !== expected.sceneVersion)
    return fail(
      "sceneVersion",
      `chunk for sceneVersion ${chunk.sceneVersion}, expected ${expected.sceneVersion}`,
    );
  if (chunk.chunkIndex !== expected.nextIndex)
    return fail(
      "chunkIndex",
      `chunkIndex ${chunk.chunkIndex} out of order, expected ${expected.nextIndex}`,
    );
  if (chunk.chunkIndex >= expected.chunkCount)
    return fail(
      "chunkIndex",
      `chunkIndex ${chunk.chunkIndex} beyond chunkCount ${expected.chunkCount}`,
    );
  const want = expectedPayloadLength(chunk.chunkIndex, expected);
  if (chunk.payload.byteLength !== want)
    return fail(
      "payload",
      `chunk ${chunk.chunkIndex} carries ${chunk.payload.byteLength} bytes, expected ${want}`,
    );
  return { ok: true, value: { offset: chunk.chunkIndex * expected.chunkSize } };
}

/**
 * Splits a GLB into `ceil(byteLength / chunkSize)` payload views (no copies) in order (§6.2).
 * Throws `RangeError` when `chunkSize` is outside 64 KiB..1 MiB or the result would exceed
 * 1024 chunks or 64 MiB, i.e. when the relay would reject `scene.snapshot.begin`.
 */
export function* chunkify(
  glb: Uint8Array,
  chunkSize: number = MAX_CHUNK_SIZE,
): Generator<{ chunkIndex: number; payload: Uint8Array }, void, undefined> {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE)
    throw new RangeError(
      `chunkSize must be ${MIN_CHUNK_SIZE}..${MAX_CHUNK_SIZE}, got ${chunkSize}`,
    );
  if (glb.byteLength < 1 || glb.byteLength > MAX_SNAPSHOT_BYTES)
    throw new RangeError(`snapshot must be 1..${MAX_SNAPSHOT_BYTES} bytes, got ${glb.byteLength}`);
  const count = chunkCountFor(glb.byteLength, chunkSize);
  if (count > MAX_CHUNK_COUNT)
    throw new RangeError(`${count} chunks exceed the maximum of ${MAX_CHUNK_COUNT}`);
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex++)
    yield {
      chunkIndex,
      payload: glb.subarray(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
    };
}

/** One complete binary frame: header + payload (what a publisher sends, §6.1). */
export function encodeChunkFrame(header: ChunkHeader, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  frame.set(encodeChunkHeader(header), 0);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}

/** SHA-256 as 64 lowercase hex characters (the `sha256` def), via WebCrypto in Node and browsers (§6.4). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto wants an ArrayBuffer-backed view; copy only when the view sits on a SharedArrayBuffer.
  const data =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
