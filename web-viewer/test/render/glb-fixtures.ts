// GLB fixtures from shared/fixtures/glb and helpers to derive broken variants (WEB-07 tests).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Not `new URL(…, import.meta.url)`: Vite rewrites that pattern to an asset URL in the jsdom project.
const GLB_DIR = `${resolve(dirname(fileURLToPath(import.meta.url)), "../../../shared/fixtures/glb")}/`;

export const manifest = JSON.parse(readFileSync(`${GLB_DIR}manifest.json`, "utf8")) as {
  files: Record<string, { nodeIds: string[]; valid: boolean }>;
};
export const glb = (name: string) => new Uint8Array(readFileSync(`${GLB_DIR}${name}`));

export type Json = Record<string, unknown>;

/** The JSON chunk of a GLB (independent of the code under test). */
export function jsonOf(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Json;
}

function header(out: Uint8Array): DataView {
  const w = new DataView(out.buffer, out.byteOffset, out.byteLength);
  w.setUint32(0, 0x46546c67, true);
  w.setUint32(4, 2, true);
  w.setUint32(8, out.byteLength, true);
  return w;
}

/** UTF-8 bytes of `text`, padded with spaces to a multiple of 4 bytes (glTF 2.0 §4.4.3). */
const padded = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(0x20);
  out.set(bytes);
  return out;
};

/** Re-encodes a GLB with a modified JSON chunk and the original BIN chunk. */
export function withJson(bytes: Uint8Array, edit: (json: Json) => void): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const oldLength = view.getUint32(12, true);
  const json = jsonOf(bytes);
  edit(json);
  const jsonBytes = padded(JSON.stringify(json));
  const bin = bytes.subarray(20 + oldLength);
  const out = new Uint8Array(20 + jsonBytes.byteLength + bin.byteLength);
  const w = header(out);
  w.setUint32(12, jsonBytes.byteLength, true);
  w.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.set(bin, 20 + jsonBytes.byteLength);
  return out;
}

/** Appends a chunk after the last one and fixes the header length. */
export function appendChunk(bytes: Uint8Array, type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength + 8 + payload.byteLength);
  out.set(bytes);
  const w = header(out);
  w.setUint32(bytes.byteLength, payload.byteLength, true);
  w.setUint32(bytes.byteLength + 4, type, true);
  out.set(payload, bytes.byteLength + 8);
  return out;
}

export const CHUNK_JSON = 0x4e4f534a;
export const jsonChunk = (json: Json) => padded(JSON.stringify(json));

/** A GLB from scratch: header, JSON chunk (`align: false` leaves it unpadded) and an optional BIN chunk. */
export function buildGlb(json: Json, bin?: Uint8Array, align = true): Uint8Array {
  const jsonBytes = align
    ? padded(JSON.stringify(json))
    : new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(20 + jsonBytes.byteLength + (bin ? 8 + bin.byteLength : 0));
  const w = header(out);
  w.setUint32(12, jsonBytes.byteLength, true);
  w.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  if (bin) {
    const at = 20 + jsonBytes.byteLength;
    w.setUint32(at, bin.byteLength, true);
    w.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}

/** A snapshot of an empty Slicer scene (root only), as shared/scripts/make-glb-fixtures.ts writes it. */
export const emptySceneJson = (): Json => ({
  asset: { version: "2.0", generator: "SlicerRemoteView test" },
  scene: 0,
  scenes: [{ name: "SlicerRemoteView", nodes: [0] }],
  nodes: [
    {
      name: "SlicerRemoteView",
      extras: { nodeId: "root", kind: "root", sceneVersion: 3, profile: "mobile" },
    },
  ],
  buffers: [{ byteLength: 0 }],
});
