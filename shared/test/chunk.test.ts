import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHUNK_HEADER_BYTES,
  MAX_CHUNK_COUNT,
  MAX_CHUNK_SIZE,
  MAX_SNAPSHOT_BYTES,
  MIN_CHUNK_SIZE,
  checkChunk,
  chunkCountFor,
  chunkify,
  decodeChunkHeader,
  encodeChunkFrame,
  encodeChunkHeader,
  expectedPayloadLength,
  sha256Hex,
} from "../ts/index.js";
import { readJson } from "./helpers.js";

const BLOB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/blob");
const blob = (file: string) => new Uint8Array(readFileSync(resolve(BLOB_DIR, file)));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

interface Vectors {
  headerBytes: number;
  magic: string;
  valid: { file: string; sceneVersion: number; chunkIndex: number }[];
  invalid: { file: string; field: string }[];
  frames: { file: string; sceneVersion: number; chunkIndex: number; payloadHex: string }[];
  chunkify: {
    byteLength: number;
    chunkSize: number;
    chunkCount: number;
    lastPayloadLength: number;
  }[];
  sha256: { inputHex: string; hex: string }[];
}
const vectors = readJson<Vectors>(resolve(BLOB_DIR, "chunk-headers.json"));

describe("chunk header and chunking helpers (PRO-07, §6.2–6.3)", () => {
  it("encodes the 12-byte little-endian SRVC header exactly as the committed vectors", () => {
    expect(vectors.headerBytes).toBe(CHUNK_HEADER_BYTES);
    expect(vectors.valid.length).toBeGreaterThanOrEqual(3);
    for (const v of vectors.valid) {
      const encoded = encodeChunkHeader(v);
      expect(hex(encoded), v.file).toBe(hex(blob(v.file)));
      expect(encoded.subarray(0, 4)).toEqual(new TextEncoder().encode(vectors.magic));
    }
    expect(hex(encodeChunkHeader({ sceneVersion: 258, chunkIndex: 1023 }))).toBe(
      "53525643" + "02010000" + "ff030000",
    );
  });

  it("round-trips every valid vector and the frame with its payload", () => {
    for (const v of vectors.valid) {
      const decoded = decodeChunkHeader(blob(v.file));
      expect(decoded.ok, v.file).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value.sceneVersion).toBe(v.sceneVersion);
      expect(decoded.value.chunkIndex).toBe(v.chunkIndex);
      expect(decoded.value.payload.byteLength).toBe(0);
      expect(hex(encodeChunkHeader(decoded.value))).toBe(hex(blob(v.file)));
    }
    for (const f of vectors.frames) {
      const decoded = decodeChunkHeader(blob(f.file));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value).toMatchObject({
        sceneVersion: f.sceneVersion,
        chunkIndex: f.chunkIndex,
      });
      expect(hex(decoded.value.payload)).toBe(f.payloadHex);
      expect(hex(encodeChunkFrame(decoded.value, Buffer.from(f.payloadHex, "hex")))).toBe(
        hex(blob(f.file)),
      );
    }
    // Views with a byteOffset decode the same (frames arrive inside larger buffers).
    const padded = new Uint8Array([9, 9, 9, ...blob("chunk-frame-v43-i2-5bytes.bin")]);
    const view = decodeChunkHeader(padded.subarray(3));
    expect(view.ok && view.value.chunkIndex).toBe(2);
    expect(view.ok && hex(view.value.payload)).toBe("0001020304");
  });

  it("rejects wrong magic, out-of-range index and short frames with BAD_SEQUENCE naming the field", () => {
    expect(vectors.invalid.map((i) => i.field).sort()).toEqual(["chunkIndex", "length", "magic"]);
    for (const { file, field } of vectors.invalid) {
      const decoded = decodeChunkHeader(blob(file));
      expect(decoded.ok, file).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.error.code).toBe("BAD_SEQUENCE");
      expect(decoded.error.field).toBe(field);
      expect(decoded.error.message).toContain(field === "length" ? "header" : field);
    }
    expect(decodeChunkHeader(new Uint8Array(0)).ok).toBe(false);
    expect(() => encodeChunkHeader({ sceneVersion: 1, chunkIndex: MAX_CHUNK_COUNT })).toThrow(
      RangeError,
    );
    expect(() => encodeChunkHeader({ sceneVersion: -1, chunkIndex: 0 })).toThrow(RangeError);
    expect(() => encodeChunkHeader({ sceneVersion: 2 ** 32, chunkIndex: 0 })).toThrow(RangeError);
    expect(() => encodeChunkHeader({ sceneVersion: 1.5, chunkIndex: 0 })).toThrow(RangeError);
  });

  it("chunkify: 2.5 MiB at 1 MiB → 3 chunks with a 0.5 MiB tail; count = ceil(byteLength / chunkSize)", () => {
    const glb = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => i & 0xff);
    const chunks = [...chunkify(glb, MAX_CHUNK_SIZE)];
    expect(chunks.map((c) => c.payload.byteLength)).toEqual([1048576, 1048576, 524288]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks[2]!.payload[0]).toBe(glb[2 * 1048576]);
    expect(chunks[0]!.payload.buffer, "views, not copies").toBe(glb.buffer);
    expect([...chunkify(glb)].length, "default chunkSize is 1 MiB").toBe(3);
    for (const c of vectors.chunkify) {
      expect(chunkCountFor(c.byteLength, c.chunkSize), JSON.stringify(c)).toBe(c.chunkCount);
      expect(expectedPayloadLength(c.chunkCount - 1, c)).toBe(c.lastPayloadLength);
      expect(expectedPayloadLength(0, c)).toBe(Math.min(c.chunkSize, c.byteLength));
    }
    expect(
      [...chunkify(new Uint8Array(196609), MIN_CHUNK_SIZE)].map((c) => c.payload.byteLength),
    ).toEqual([65536, 65536, 65536, 1]);
    expect(() => [...chunkify(glb, MIN_CHUNK_SIZE - 1)]).toThrow(RangeError);
    expect(() => [...chunkify(glb, MAX_CHUNK_SIZE + 1)]).toThrow(RangeError);
    expect(() => [...chunkify(new Uint8Array(0))]).toThrow(RangeError);
    expect(() => [...chunkify(new Uint8Array(MAX_SNAPSHOT_BYTES + 1))]).toThrow(RangeError);
    // 64 MiB at 64 KiB is exactly 1024 chunks (§3.3) — one byte more would need 1025.
    expect(chunkCountFor(MAX_SNAPSHOT_BYTES, MIN_CHUNK_SIZE)).toBe(MAX_CHUNK_COUNT);
    expect(chunkCountFor(MAX_SNAPSHOT_BYTES + 1, MIN_CHUNK_SIZE)).toBe(MAX_CHUNK_COUNT + 1);
  });

  it("checkChunk applies the §6.3 receiver rules: version, order, duplicates, payload size", () => {
    const expected = {
      sceneVersion: 43,
      byteLength: 196609,
      chunkSize: 65536,
      chunkCount: 4,
      nextIndex: 0,
    };
    const chunk = (chunkIndex: number, len: number, sceneVersion = 43) => ({
      sceneVersion,
      chunkIndex,
      payload: new Uint8Array(len),
    });
    const field = (r: ReturnType<typeof checkChunk>) => (r.ok ? "ok" : r.error.field);
    expect(checkChunk(chunk(0, 65536), expected)).toEqual({ ok: true, value: { offset: 0 } });
    expect(checkChunk(chunk(3, 1), { ...expected, nextIndex: 3 })).toEqual({
      ok: true,
      value: { offset: 196608 },
    });
    expect(field(checkChunk(chunk(0, 65536, 42), expected))).toBe("sceneVersion");
    expect(field(checkChunk(chunk(1, 65536), expected)), "out of order").toBe("chunkIndex");
    expect(field(checkChunk(chunk(0, 65536), { ...expected, nextIndex: 1 })), "duplicate").toBe(
      "chunkIndex",
    );
    expect(field(checkChunk(chunk(4, 1), { ...expected, nextIndex: 4 })), "beyond chunkCount").toBe(
      "chunkIndex",
    );
    expect(field(checkChunk(chunk(0, 65535), expected)), "short payload").toBe("payload");
    expect(field(checkChunk(chunk(3, 2), { ...expected, nextIndex: 3 })), "long last payload").toBe(
      "payload",
    );
    const r = checkChunk(chunk(0, 65535), expected);
    expect(!r.ok && r.error.code).toBe("BAD_SEQUENCE");
    expect(!r.ok && r.error.message).toContain("65535");
  });

  it("sha256Hex returns 64 lowercase hex characters matching the committed vectors (WebCrypto)", async () => {
    for (const v of vectors.sha256)
      expect(await sha256Hex(Buffer.from(v.inputHex, "hex"))).toBe(v.hex);
    const digest = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // A view into a larger buffer hashes only its own bytes.
    const big = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
    expect(await sha256Hex(big.subarray(1, 4))).toBe(vectors.sha256[1]!.hex);
  });
});
