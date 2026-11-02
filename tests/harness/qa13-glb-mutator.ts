// QA-13 deterministic GLB mutator: turns the valid fixtures `asymmetric-2nodes.glb` and `quantized-1node.glb`
// (shared/fixtures/glb, PRO-08) into hostile or broken snapshots for the viewer's parse path (WEB-07 pre-validator
// `web-viewer/src/render/glb-validate.ts`, then three.js GLTFLoader). Pure Node: no Playwright, no network.
//
// Determinism: mutant `i` of seed `s` depends only on `(s, i)` — its PRNG is mulberry32 seeded with a mix of both —
// so `GLB_FUZZ_SEED=s GLB_FUZZ_ONLY=i` rebuilds exactly the same bytes without generating the others. The mutation
// kind cycles with the index (33 kinds: each runs at least six times in 200 mutants, three or more times on each base); the PRNG
// picks its parameters (which bits, which accessor, which URI, …).
//
// Each mutant carries what the protocol lets us expect of it:
// - `refuse`: §7.1/§7.4 (or the glTF 2.0 container/schema rules §7.1 builds on) forbid it, so the viewer MUST end in
//   `snapshotInvalid` — loading it would mean the pre-validator let a forbidden construct through (T10).
// - `load`: still a valid §7 snapshot (re-encoded JSON, in-range colours, hostile-looking names), so the viewer
//   MUST show it — guards against a suite that "passes" because the viewer refuses everything.
// - `either`: random damage whose validity is not decidable up front; only "no crash, a defined end state" holds.
// Mutants never contain a session code or a token; the URIs they inject point at 127.0.0.1, a relative path on the
// test relay, or the reserved `.invalid` TLD (RFC 6761), and the spec aborts every non-local request anyway.

import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "./paths.ts";

export type Expectation = "refuse" | "load" | "either";

export interface Mutant {
  readonly index: number;
  readonly kind: string;
  /** Fixture file name of the base. */
  readonly base: string;
  readonly bytes: Uint8Array;
  readonly expect: Expectation;
  /** `benign` only: the hostile-looking display name it gave one node (the spec checks it is shown as text). */
  readonly injectedName?: string;
}

/** Marker in every injected URI: a request whose URL contains it means the viewer fetched an external resource. */
export const URI_MARKER = "qa13-fuzz";
/** Set by an injected `onerror` handler if a node name ever reaches the DOM as HTML. */
export const XSS_FLAG = "__qa13Xss";

export const DEFAULT_SEED = 0x5eed13;
export const BASES = ["asymmetric-2nodes.glb", "quantized-1node.glb"] as const;

/** mulberry32 (Tommy Ettinger, public domain): a 32-bit state PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

type Json = Record<string, unknown>;
type Gltf = Json & {
  nodes: Json[];
  scenes: Json[];
  meshes: Json[];
  materials: Json[];
  accessors: Json[];
  bufferViews: Json[];
  buffers: Json[];
};

interface Base {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly json: Gltf;
  readonly bin: Uint8Array;
  /** Offset of the BIN chunk header (= 20 + JSON chunk length). */
  readonly binHeader: number;
}

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const baseCache = new Map<string, Base>();

function loadBase(name: string): Base {
  const cached = baseCache.get(name);
  if (cached) return cached;
  const buffer = readFileSync(path.join(FIXTURES_DIR, name));
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const binHeader = 20 + jsonLength;
  const binLength = view.getUint32(binHeader, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, binHeader))) as Gltf;
  const bin = bytes.slice(binHeader + 8, binHeader + 8 + binLength);
  const base = { name, bytes: bytes.slice(), json, bin, binHeader };
  baseCache.set(name, base);
  return base;
}

/** Raw JSON text spliced over a sentinel string when encoding (`deep-json`): [quoted sentinel, replacement]. */
const RAW_JSON = new WeakMap<object, [string, string]>();

/** A GLB container (glTF 2.0 §4.4): JSON padded with spaces, BIN with zeros, both to 4 bytes. */
export function encodeGlb(json: unknown, bin: Uint8Array | null): Uint8Array {
  let source = JSON.stringify(json);
  const raw = typeof json === "object" && json !== null ? RAW_JSON.get(json) : undefined;
  if (raw) source = source.replace(raw[0], () => raw[1]);
  const text = new TextEncoder().encode(source);
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const binLength = bin ? Math.ceil(bin.byteLength / 4) * 4 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (bin) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, CHUNK_BIN, true);
    out.set(bin, 28 + jsonLength);
  }
  return out;
}

const setU32 = (bytes: Uint8Array, offset: number, value: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
const getU32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

function flipBits(bytes: Uint8Array, rng: Rng, count: number, from: number, to: number): void {
  for (let i = 0; i < count; i++) bytes[rng.int(from, to - 1)]! ^= 1 << rng.int(0, 7);
}

/** Every (container, key) slot of the JSON tree, for the structure-blind mutations. */
function slots(root: unknown): [Json | unknown[], string | number][] {
  const out: [Json | unknown[], string | number][] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value))
      value.forEach((item, i) => {
        out.push([value, i]);
        walk(item);
      });
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) {
        out.push([value as Json, key]);
        walk(item);
      }
  };
  walk(root);
  return out;
}

const randomValue = (rng: Rng): unknown =>
  rng.pick<() => unknown>([
    () => null,
    () => true,
    () => -1,
    () => 0,
    () => 2 ** 31,
    () => 2 ** 53,
    () => 1e308,
    () => -1e308,
    () => 0.5,
    () => "",
    () => "x".repeat(rng.int(1, 4096)),
    () => [],
    () => [rng.int(-5, 5)],
    () => ({}),
    () => ({ uri: `${URI_MARKER}.bin` }),
    () => "__proto__",
    () => JSON.parse('{"__proto__":{"polluted":true}}') as unknown, // an own `__proto__` key
  ])();

/** URIs that must never be fetched; all local or unresolvable, all carrying the marker. */
const injectedUri = (rng: Rng): string =>
  rng.pick([
    `${URI_MARKER}.bin`,
    `./${URI_MARKER}/../${URI_MARKER}.bin`,
    `http://127.0.0.1:9/${URI_MARKER}.bin`,
    `https://${URI_MARKER}.invalid/scene.bin`,
    `//${URI_MARKER}.invalid/scene.bin`,
    `file:///tmp/${URI_MARKER}.bin`,
    `data:application/octet-stream;base64,AAAAAAAAAAA=#${URI_MARKER}`,
    `blob:http://127.0.0.1:9/${URI_MARKER}`,
  ]);

/** Returns the injected display name when the mutation sets one (`benign`), else nothing. */
type JsonMutation = (gltf: Gltf, rng: Rng, base: Base) => string | void;

const accessorOf = (g: Gltf, rng: Rng) => rng.pick(g.accessors);
const rootOf = (g: Gltf) => g.nodes[(g.scenes[0]!["nodes"] as number[])[0]!]!;

/** JSON-level mutations: re-encoded into a well-formed container, so the JSON content is what is under test. */
const JSON_MUTATIONS: Record<string, { expect: Expectation; apply: JsonMutation }> = {
  identity: { expect: "load", apply: () => undefined },
  // §7.3/§7.4-valid edits: names that look like markup or are huge/unicode, in-range colours and opacity.
  benign: {
    expect: "load",
    apply(g, rng) {
      const named = g.nodes.filter((n) => typeof (n["extras"] as Json | undefined)?.["name"] === "string");
      const node = rng.pick(named);
      // §7.3: ≤ 64 UTF-16 code units, no control characters — but markup, quotes and non-Latin scripts.
      const name = rng.pick([
        `<img src=${URI_MARKER}-x.png onerror=window.${XSS_FLAG}=1>`,
        `"><svg onload=window.${XSS_FLAG}=1>`,
        "Ünïcødé \ud83e\udec0 \u05d0\u05d1 \u0627\u0644",
        "{{constructor}} ${x} %s %n",
        "N".repeat(64),
      ]);
      node["name"] = name;
      const extras = node["extras"] as Json;
      extras["name"] = name;
      // In-range colour; the alpha (opacity, which decides alphaMode, §7.4) is kept.
      const material = rng.pick(g.materials);
      const pbr = material["pbrMetallicRoughness"] as Json;
      const rgb = [rng.next(), rng.next(), rng.next()];
      pbr["baseColorFactor"] = [...rgb, (pbr["baseColorFactor"] as number[])[3]!];
      return name;
    },
  },
  "huge-accessor-count": {
    expect: "refuse", // glTF 2.0: count ≥ 1, integer, and the accessor fits its buffer view
    apply(g, rng) {
      accessorOf(g, rng)["count"] = rng.pick([2 ** 31, 2 ** 32 - 1, 1e9, 2 ** 53, 2 ** 53 + 2, 1e300, -1, 0, 1.5]);
    },
  },
  "accessor-offset": {
    expect: "refuse", // accessor or view outside the BIN chunk
    apply(g, rng) {
      const choice = rng.int(0, 3);
      if (choice === 0) accessorOf(g, rng)["byteOffset"] = rng.pick([2 ** 31, 1e12, -4]);
      else if (choice === 1) rng.pick(g.bufferViews)["byteLength"] = rng.pick([2 ** 31, 1e12, 0, -8]);
      else if (choice === 2) rng.pick(g.bufferViews)["byteOffset"] = rng.pick([2 ** 31, 1e12, -4]);
      else g.buffers[0]!["byteLength"] = rng.pick([2 ** 40, 2 ** 53, 1e15]);
    },
  },
  "buffer-uri": {
    expect: "refuse", // §7.1: no external `uri`s; the one buffer is the BIN chunk
    apply(g, rng) {
      if (rng.chance(0.5)) g.buffers[0]!["uri"] = injectedUri(rng);
      else g.buffers.push({ byteLength: 16, uri: injectedUri(rng) });
    },
  },
  "image-uri": {
    expect: "refuse", // §7.1: no textures, images or samplers
    apply(g, rng) {
      g["images"] = [{ uri: injectedUri(rng) }];
      g["textures"] = [{ source: 0 }];
      if (rng.chance(0.5)) g["samplers"] = [{}];
      const pbr = rng.pick(g.materials)["pbrMetallicRoughness"] as Json;
      pbr["baseColorTexture"] = { index: 0 };
    },
  },
  "two-scenes": {
    expect: "refuse", // §7.1: exactly one scene with one root
    apply(g, rng) {
      const choice = rng.int(0, 3);
      if (choice <= 1) {
        g.scenes.push(structuredClone(g.scenes[0]!));
        if (choice === 1) g["scene"] = 1;
      } else if (choice === 2) g["scene"] = rng.pick([1, 5, -1, "0"]);
      else (g.scenes[0]!["nodes"] as number[]).push(1); // two roots
    },
  },
  "no-root-extras": {
    expect: "refuse", // §7.1: the single root carries `nodeId: "root"`, `kind: "root"`
    apply(g, rng) {
      const root = rootOf(g);
      const choice = rng.int(0, 3);
      if (choice === 0) delete root["extras"];
      else if (choice === 1) (root["extras"] as Json)["nodeId"] = rng.pick(["Root", "", 0, null]);
      else if (choice === 2) (root["extras"] as Json)["kind"] = rng.pick(["model", "segment", null]);
      else root["extras"] = rng.pick([null, "root", [], 42]);
    },
  },
  extensions: {
    expect: "refuse", // §7.1: extensionsRequired ⊆ {KHR_mesh_quantization}, no lights / KHR_materials_* / Draco
    apply(g, rng) {
      const choice = rng.int(0, 2);
      const name = rng.pick([
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
        "KHR_materials_variants",
      ]);
      if (choice === 0) {
        g["extensionsUsed"] = [...((g["extensionsUsed"] as string[] | undefined) ?? []), name];
        g["extensionsRequired"] = [...((g["extensionsRequired"] as string[] | undefined) ?? []), name];
      } else if (choice === 1) {
        g["extensionsUsed"] = ["KHR_lights_punctual"];
        g["extensions"] = { KHR_lights_punctual: { lights: [{ type: "point", intensity: 1e30 }] } };
        rng.pick(g.nodes)["extensions"] = { KHR_lights_punctual: { light: 0 } };
      } else {
        rng.pick(g.materials)["extensions"] = { KHR_materials_emissive_strength: { emissiveStrength: 1e30 } };
        g["extensionsUsed"] = ["KHR_materials_emissive_strength"];
      }
    },
  },
  "forbidden-collections": {
    expect: "refuse", // §7.1: no animations, skins, cameras
    apply(g, rng) {
      const choice = rng.int(0, 2);
      if (choice === 0)
        g["animations"] = [{ channels: [{ sampler: 0, target: { node: 1, path: "scale" } }], samplers: [{ input: 0, output: 0 }] }];
      else if (choice === 1) {
        g["skins"] = [{ joints: [1] }];
        rng.pick(g.nodes)["skin"] = 0;
      } else {
        g["cameras"] = [{ type: "perspective", perspective: { yfov: 1, znear: 0.01 } }];
        rng.pick(g.nodes)["camera"] = 0;
      }
    },
  },
  "sparse-accessor": {
    expect: "refuse", // §7.1: no sparse accessors
    apply(g, rng) {
      accessorOf(g, rng)["sparse"] = {
        count: rng.pick([1, 2 ** 31]),
        indices: { bufferView: 0, componentType: 5123 },
        values: { bufferView: 0 },
      };
    },
  },
  "primitive-mode": {
    expect: "refuse", // §7.1: TRIANGLES (4) only
    apply(g, rng) {
      const primitive = (rng.pick(g.meshes)["primitives"] as Json[])[0]!;
      primitive["mode"] = rng.pick([0, 1, 2, 3, 5, 6, 7, -1]);
    },
  },
  "index-type": {
    expect: "refuse", // §7.1: indices UNSIGNED_SHORT or UNSIGNED_INT
    apply(g, rng) {
      const primitive = (rng.pick(g.meshes)["primitives"] as Json[])[0]!;
      g.accessors[primitive["indices"] as number]!["componentType"] = rng.pick([5120, 5121, 5122, 5126, 1234]);
    },
  },
  "node-cycle": {
    expect: "refuse", // glTF 2.0: nodes form disjoint strict trees
    apply(g, rng) {
      const node = g.nodes[rng.int(1, g.nodes.length - 1)]!;
      const target = rng.pick([0, g.nodes.indexOf(node), 1]);
      node["children"] = [...((node["children"] as number[] | undefined) ?? []), target];
    },
  },
  "material-factors": {
    expect: "refuse", // §7.4 / glTF 2.0: factors in 0..1, alphaMode one of three
    apply(g, rng) {
      const material = rng.pick(g.materials);
      const pbr = material["pbrMetallicRoughness"] as Json;
      const choice = rng.int(0, 3);
      if (choice === 0) pbr["baseColorFactor"] = rng.pick([[2, -1, 0, 1], [1e308, 0, 0, 1], [1, 1, 1], "red"]);
      else if (choice === 1) pbr[rng.pick(["metallicFactor", "roughnessFactor"])] = rng.pick([-1, 7, 1e308]);
      else if (choice === 2) material["alphaMode"] = rng.pick(["ADDITIVE", "", 1]);
      else material["emissiveFactor"] = rng.pick([[9, 9, 9], [0, 0]]);
    },
  },
  "byte-stride": {
    expect: "either", // some strides are invalid glTF (not 4..252), others merely make an accessor overrun
    apply(g, rng) {
      rng.pick(g.bufferViews)["byteStride"] = rng.pick([0, 1, 3, 12, 256, 1e9, -8]);
    },
  },
  "too-many-nodes": {
    expect: "either", // valid glTF; the viewer bounds its manifest (MAX_MANIFEST_NODES) but either end is fine
    apply(g, rng) {
      const extra = rng.int(1_500, 3_000);
      const root = rootOf(g);
      const children = root["children"] as number[];
      for (let i = 0; i < extra; i++) {
        children.push(g.nodes.length);
        g.nodes.push({ name: `n${i}` });
      }
    },
  },
  "deep-json": {
    expect: "either",
    apply(g, rng) {
      const depth = rng.int(100, 5_000);
      // Built as text, innermost level first (the same draws as nesting objects): `JSON.stringify` of a value
      // nested ~5,000 deep recurses past the V8 stack of Node on x64 Linux (CI), though not on arm64 macOS.
      const open: string[] = [];
      for (let i = 0; i < depth; i++) open.push(rng.chance(0.5) ? "[" : '{"a":');
      const close = open.map((o) => (o === "[" ? "]" : "}")).join("");
      const sentinel = "\u0000qa13-deep\u0000";
      if (rng.chance(0.5)) (rootOf(g)["extras"] as Json)["deep"] = sentinel; // `extras` is free-form
      else (g["asset"] as Json)["deep"] = sentinel;
      RAW_JSON.set(g, [JSON.stringify(sentinel), open.reverse().join("") + "0" + close]);
    },
  },
  "random-value": {
    expect: "either",
    apply(g, rng) {
      const all = slots(g);
      for (let i = rng.int(1, 3); i > 0; i--) {
        const [container, key] = rng.pick(all);
        (container as Record<string | number, unknown>)[key] = randomValue(rng);
      }
    },
  },
  "delete-key": {
    expect: "either",
    apply(g, rng) {
      const objects = slots(g).filter(([c]) => !Array.isArray(c));
      for (let i = rng.int(1, 2); i > 0; i--) {
        const [container, key] = rng.pick(objects);
        delete (container as Json)[key as string];
      }
    },
  },
};

type ByteMutation = (bytes: Uint8Array, rng: Rng, base: Base) => Uint8Array;

/** Byte-level mutations of the original file (its own JSON encoding and layout). */
const BYTE_MUTATIONS: Record<string, { expect: Expectation; apply: ByteMutation }> = {
  bitflip: {
    expect: "either",
    apply(bytes, rng) {
      flipBits(bytes, rng, rng.int(1, 16), 0, bytes.byteLength);
      return bytes;
    },
  },
  "bitflip-header": {
    expect: "either",
    apply(bytes, rng, base) {
      // The 12-byte header, the JSON chunk header, or the BIN chunk header.
      const region = rng.pick([[0, 20], [base.binHeader, base.binHeader + 8]] as const);
      flipBits(bytes, rng, rng.int(1, 3), region[0], region[1]);
      return bytes;
    },
  },
  "bin-bitflip": {
    expect: "either", // geometry garbage: NaN positions, out-of-range indices
    apply(bytes, rng, base) {
      flipBits(bytes, rng, rng.int(1, 64), base.binHeader + 8, bytes.byteLength);
      return bytes;
    },
  },
  "json-splat": {
    expect: "either",
    apply(bytes, rng, base) {
      for (let i = rng.int(1, 8); i > 0; i--) bytes[rng.int(20, base.binHeader - 1)] = rng.int(0, 255);
      return bytes;
    },
  },
  truncate: {
    expect: "refuse", // glTF 2.0 §4.4: header length = file length, chunks complete
    apply(bytes, rng) {
      const cut = bytes.slice(0, rng.int(1, bytes.byteLength - 1));
      if (cut.byteLength >= 12 && rng.chance(0.5)) setU32(cut, 8, cut.byteLength); // header "fixed"
      return cut;
    },
  },
  "json-chunk-length": {
    expect: "refuse", // the BIN chunk header no longer sits where the JSON chunk length says
    apply(bytes, rng, base) {
      const jl = base.binHeader - 20;
      setU32(bytes, 12, rng.pick([0, jl - 4, jl + 4, jl + 1, jl - 1, jl + 8, bytes.byteLength, 0xffffffff, 0x7fffffff]));
      return bytes;
    },
  },
  "chunk-type": {
    expect: "refuse", // §4.4: first chunk JSON, second BIN
    apply(bytes, rng, base) {
      const choice = rng.int(0, 2);
      if (choice === 0) setU32(bytes, 16, rng.pick([CHUNK_BIN, 0x6e6f736a, 0, 0xffffffff]));
      else if (choice === 1) setU32(bytes, base.binHeader + 4, rng.pick([CHUNK_JSON, 0x006e6962, 0, 0x12345678]));
      else {
        setU32(bytes, 16, CHUNK_BIN);
        setU32(bytes, base.binHeader + 4, CHUNK_JSON);
      }
      return bytes;
    },
  },
  "header-length": {
    expect: "refuse",
    apply(bytes, rng) {
      const length = getU32(bytes, 8);
      setU32(bytes, 8, rng.pick([0, length - 4, length + 4, length * 2, 0xffffffff]));
      return bytes;
    },
  },
  "glb-version": {
    expect: "refuse", // glTF 2.0 container only
    apply(bytes, rng) {
      setU32(bytes, 4, rng.pick([0, 1, 3, 0xffffffff]));
      return bytes;
    },
  },
  magic: {
    expect: "refuse",
    apply(bytes, rng) {
      setU32(bytes, 0, rng.pick([0x58546c67, 0x46546c66, 0, 0x53525643])); // glTX, flTF, 0, SRVC
      return bytes;
    },
  },
  "trailing-chunk": {
    expect: "refuse", // §7.1: one JSON chunk, one BIN chunk; nothing may follow
    apply(bytes, rng, base) {
      let tail: Uint8Array;
      if (rng.chance(0.5)) {
        tail = new Uint8Array(rng.int(1, 16) * 4);
        for (let i = 0; i < tail.length; i++) tail[i] = rng.int(0, 255);
      } else {
        // A second JSON chunk with another scene: GLTFLoader would read the later one.
        const other = new TextEncoder().encode(
          JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 8, uri: injectedUri(rng) }] }),
        );
        const padded = Math.ceil(other.byteLength / 4) * 4;
        tail = new Uint8Array(8 + padded).fill(0x20);
        setU32(tail, 0, padded);
        setU32(tail, 4, CHUNK_JSON);
        tail.set(other, 8);
      }
      const out = new Uint8Array(bytes.byteLength + tail.byteLength);
      out.set(bytes);
      out.set(tail, bytes.byteLength);
      if (rng.chance(0.7)) setU32(out, 8, out.byteLength);
      void base;
      return out;
    },
  },
};

/** The kinds in index order; `bitflip` and `random-value` appear twice (cheap, broad coverage). */
export const KINDS: readonly string[] = [
  "identity",
  "bitflip",
  "truncate",
  "huge-accessor-count",
  "buffer-uri",
  "two-scenes",
  "no-root-extras",
  "json-chunk-length",
  "chunk-type",
  "random-value",
  "image-uri",
  "extensions",
  "bitflip-header",
  "accessor-offset",
  "forbidden-collections",
  "sparse-accessor",
  "primitive-mode",
  "index-type",
  "node-cycle",
  "material-factors",
  "benign",
  "bitflip",
  "bin-bitflip",
  "json-splat",
  "header-length",
  "glb-version",
  "magic",
  "trailing-chunk",
  "byte-stride",
  "too-many-nodes",
  "deep-json",
  "random-value",
  "delete-key",
];

/** Per-mutant PRNG seed: depends only on (seed, index). */
export function mutantSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Mutant `index` of `seed`. The base alternates per full pass over KINDS, so every kind runs on both fixtures. */
export function generateMutant(seed: number, index: number): Mutant {
  const rng = new Rng(mutantSeed(seed, index));
  const kind = KINDS[index % KINDS.length]!;
  const baseName = BASES[Math.floor(index / KINDS.length) % BASES.length]!;
  const base = loadBase(baseName);
  const jsonMutation = JSON_MUTATIONS[kind];
  if (jsonMutation) {
    const gltf = structuredClone(base.json);
    const injectedName = jsonMutation.apply(gltf, rng, base);
    const bytes = encodeGlb(gltf, base.bin);
    const named = injectedName ? { injectedName } : {};
    return { index, kind, base: baseName, bytes, expect: jsonMutation.expect, ...named };
  }
  const byteMutation = BYTE_MUTATIONS[kind];
  if (!byteMutation) throw new Error(`unknown mutation kind ${kind}`);
  const bytes = byteMutation.apply(base.bytes.slice(), rng, base);
  return { index, kind, base: baseName, bytes, expect: byteMutation.expect };
}

/** The unmodified base file (the "reset" snapshot shown before every mutant). */
export function baseBytes(name: string): Uint8Array {
  return loadBase(name).bytes.slice();
}
