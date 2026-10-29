// §7.1 pre-validation of a GLB snapshot (WEB-07; docs/protocol.md §7.1, §7.2, §7.4). Pure — no three.js — and run
// *before* `GLTFLoader` sees the bytes, so a hostile or broken snapshot cannot make the loader fetch an external
// `uri`, decode images, run a plugin (instancing, lights, KHR_materials_* — three.js runs them for any `extensions`
// object, whatever `extensionsUsed` says) or spend memory, GPU uploads or triangles per frame out of proportion to
// the file (T10). The bounds: every accessor lies inside a buffer view, views are disjoint and inside the one BIN
// chunk, accessor bytes ≤ BIN and GPU uploads ≤ 2 × BIN, the node graph is a tree, and every mesh, accessor and
// material has a single user (§7.2), with only POSITION, NORMAL and indices per primitive (no morph targets).

/** Why a snapshot was refused; the UI shows `snapshotInvalid` for every reason. */
export type InvalidReason =
  | "container" // GLB header / chunk layout / alignment
  | "json" // JSON chunk does not decode, or a top-level collection is not an array
  | "scene" // not exactly one scene (index 0) with one root
  | "root" // root node without the §7.1 extras
  | "buffers" // not exactly one buffer, an external `uri`, or a buffer/view outside the BIN chunk or overlapping
  | "forbidden" // images, textures, animations, skins, cameras, texture references … (§7.1)
  | "extensions" // an extension other than `KHR_mesh_quantization`, or any per-object `extensions` object
  | "nodes" // more than MAX_MANIFEST_NODES entries
  | "accessors" // an accessor without a buffer view, sparse, malformed, reaching past its view, or too many bytes
  | "meshes" // not one TRIANGLES primitive with POSITION/NORMAL (+ UNSIGNED_SHORT/INT indices) per mesh
  | "materials" // a material factor or alpha mode outside §7.4 (colour/opacity/metallic/roughness in 0..1)
  | "structure" // T/M pairs do not follow §7.2 (checked after parsing)
  | "parse"; // GLTFLoader rejected the file

export type GlbCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: InvalidReason };

export const MAX_MANIFEST_NODES = 1000;
/** One Slicer node = two glTF nodes (§7.2), plus the root. */
export const MAX_GLTF_NODES = 2 * MAX_MANIFEST_NODES + 1;

const ALLOWED_EXTENSIONS = new Set(["KHR_mesh_quantization"]);
/** Present in any form other than an empty array → refused (an object form would still reach the loader). */
const FORBIDDEN_KEYS = ["images", "textures", "samplers", "animations", "skins", "cameras"];
/** Must be arrays when present; the loader indexes them. */
const COLLECTIONS = [
  "scenes",
  "nodes",
  "meshes",
  "accessors",
  "bufferViews",
  "materials",
  "buffers",
];
const TEXTURE_SLOTS = ["normalTexture", "occlusionTexture", "emissiveTexture"];
const PBR_TEXTURE_SLOTS = ["baseColorTexture", "metallicRoughnessTexture"];
// Maps, not object literals: a lookup of "constructor" or "__proto__" must miss.
const COMPONENT_BYTES: ReadonlyMap<unknown, number> = new Map([
  [5120, 1], // BYTE
  [5121, 1], // UNSIGNED_BYTE
  [5122, 2], // SHORT
  [5123, 2], // UNSIGNED_SHORT
  [5125, 4], // UNSIGNED_INT
  [5126, 4], // FLOAT
]);
const TYPE_COMPONENTS: ReadonlyMap<unknown, number> = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);
const INDEX_COMPONENTS = new Set([5123, 5125]); // §7.1: UNSIGNED_SHORT or UNSIGNED_INT
const ATTRIBUTES = new Set(["POSITION", "NORMAL"]); // §7.4: NORMAL required, no vertex colours, no textures
const TRIANGLES = 4;
/** A v1 snapshot nests fewer than 10 levels outside `extras`; deeper JSON is refused, not walked. */
const MAX_JSON_DEPTH = 64;
/**
 * Largest JSON chunk decoded at all (8 MiB): a 1,000-node manifest needs ≈ 1.5 MB (fixtures: 1.1–1.4 KB per entity),
 * while a 32 MiB chunk of tiny arrays costs ≈ 0.8 GiB in `JSON.parse` alone — and GLTFLoader parses it again.
 */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
const ALPHA_MODES = new Set(["OPAQUE", "BLEND", "MASK"]);

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown, length: number): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < length;
const isCount = (v: unknown, min = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min;
const list = (json: Json, key: string): unknown[] =>
  Array.isArray(json[key]) ? (json[key] as unknown[]) : [];

interface Container {
  readonly json: Json;
  /** Length of the BIN chunk; 0 when the file has none (allowed only without buffer views). */
  readonly binLength: number;
}

/**
 * Decodes the GLB container (glTF 2.0 §4.4): 12-byte header with the exact file length, one 4-byte aligned JSON
 * chunk, then at most one aligned BIN chunk that ends the file. Anything after the BIN chunk is refused:
 * `GLTFLoader` would read a later JSON chunk instead of the one validated here.
 */
function readContainer(bytes: Uint8Array): Container | InvalidReason {
  if (bytes.byteLength < 20) return "container";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) return "container";
  if (view.getUint32(8, true) !== bytes.byteLength) return "container";
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength === 0 || jsonLength % 4 !== 0)
    return "container";
  const binHeader = 20 + jsonLength;
  if (binHeader > bytes.byteLength) return "container";
  let binLength = 0;
  if (binHeader < bytes.byteLength) {
    if (binHeader + 8 > bytes.byteLength || view.getUint32(binHeader + 4, true) !== CHUNK_BIN)
      return "container";
    binLength = view.getUint32(binHeader, true);
    if (binLength % 4 !== 0 || binHeader + 8 + binLength !== bytes.byteLength) return "container";
  }
  if (jsonLength > MAX_JSON_BYTES) return "json";
  try {
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, binHeader)),
    );
    return isObject(json) ? { json, binLength } : "json";
  } catch {
    return "json";
  }
}

const extensionsAllowed = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.every((e) => typeof e === "string" && ALLOWED_EXTENSIONS.has(e)));

/**
 * Walks the JSON chunk depth-first with one frame per level, so memory is bounded by the depth, not by the number
 * of siblings, and a deeply nested chunk cannot overflow the call stack: `json` when it nests deeper than
 * MAX_JSON_DEPTH, `extensions` when some object carries a non-empty `extensions` object. `KHR_mesh_quantization`
 * defines no extension objects, so a v1 snapshot needs none; `extras` (free-form manifest data) is not searched.
 */
function scanJson(root: Json): InvalidReason | null {
  const stack: {
    readonly value: Json | unknown[];
    readonly keys: string[] | null;
    index: number;
  }[] = [];
  const open = (value: unknown): InvalidReason | null => {
    if (Array.isArray(value)) stack.push({ value, keys: null, index: 0 });
    else if (isObject(value)) {
      const extensions = value["extensions"];
      if (
        extensions !== undefined &&
        !(isObject(extensions) && Object.keys(extensions).length === 0)
      )
        return "extensions";
      stack.push({ value, keys: Object.keys(value), index: 0 });
    } else return null;
    return stack.length > MAX_JSON_DEPTH ? "json" : null;
  };
  let reason = open(root);
  while (reason === null && stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const { value, keys } = frame;
    if (frame.index >= (keys ?? (value as unknown[])).length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    if (keys === null) reason = open((value as unknown[])[index]);
    else if (keys[index] !== "extras" && keys[index] !== "extensions")
      reason = open((value as Json)[keys[index]!]);
  }
  return reason;
}

const unit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;
const factors = (v: unknown, length: number): boolean =>
  Array.isArray(v) && v.length === length && v.every(unit);

/**
 * §7.1/§7.4 materials: no textures — not even references, which the loader would try to resolve — and factors in
 * range, because GLTFLoader copies `baseColorFactor` and friends into the material unchecked.
 */
function checkMaterials(json: Json): InvalidReason | null {
  for (const m of list(json, "materials")) {
    if (!isObject(m)) return "forbidden";
    const pbr = m["pbrMetallicRoughness"] ?? {};
    if (!isObject(pbr)) return "materials";
    if (TEXTURE_SLOTS.some((slot) => m[slot] !== undefined)) return "forbidden";
    if (PBR_TEXTURE_SLOTS.some((slot) => pbr[slot] !== undefined)) return "forbidden";
    if (pbr["baseColorFactor"] !== undefined && !factors(pbr["baseColorFactor"], 4))
      return "materials";
    if (m["emissiveFactor"] !== undefined && !factors(m["emissiveFactor"], 3)) return "materials";
    for (const key of ["metallicFactor", "roughnessFactor"])
      if (pbr[key] !== undefined && !unit(pbr[key])) return "materials";
    if (m["alphaMode"] !== undefined && !ALPHA_MODES.has(m["alphaMode"] as string))
      return "materials";
  }
  return null;
}

/** §7.1 scene rules: the default scene is the only one and has exactly one root carrying the root extras. */
function checkScene(json: Json): InvalidReason | null {
  if (json["scene"] !== undefined && json["scene"] !== 0) return "scene";
  const scenes = list(json, "scenes");
  if (scenes.length !== 1 || !isObject(scenes[0])) return "scene";
  const nodes = list(json, "nodes");
  if (nodes.length > MAX_GLTF_NODES) return "nodes";
  const roots = scenes[0]["nodes"];
  if (!Array.isArray(roots) || roots.length !== 1 || !isIndex(roots[0], nodes.length))
    return "scene";
  const root = nodes[roots[0]];
  if (!isObject(root)) return "scene";
  const extras = root["extras"];
  if (!isObject(extras) || extras["nodeId"] !== "root" || extras["kind"] !== "root") return "root";
  if (list(root, "children").length > MAX_MANIFEST_NODES) return "nodes";
  return null;
}

/**
 * The node graph must be a tree under the root — every node is somebody's child at most once and the root never is —
 * so the loader cannot be made to walk one child millions of times or follow a cycle. A node uses its own mesh
 * (§7.2: M owns one mesh), so one geometry cannot be drawn once per node. No cameras or skins (§7.1).
 */
function checkNodes(json: Json): InvalidReason | null {
  const nodes = list(json, "nodes");
  const meshes = list(json, "meshes");
  const root = (list(json, "scenes")[0] as Json)["nodes"] as number[];
  const parented = new Set<number>(root);
  const meshUsers = new Set<number>();
  for (const n of nodes) {
    if (!isObject(n)) return "nodes";
    if (n["camera"] !== undefined || n["skin"] !== undefined) return "forbidden";
    if (n["weights"] !== undefined) return "meshes";
    const children = n["children"];
    if (children !== undefined) {
      if (!Array.isArray(children)) return "nodes";
      for (const child of children) {
        if (!isIndex(child, nodes.length) || parented.has(child)) return "nodes";
        parented.add(child);
      }
    }
    const mesh = n["mesh"];
    if (mesh !== undefined) {
      if (!isIndex(mesh, meshes.length) || meshUsers.has(mesh)) return "meshes";
      meshUsers.add(mesh);
    }
  }
  return null;
}

/**
 * Bounds every byte range the loader will slice or allocate: buffer ⊆ BIN chunk, views ⊆ buffer and disjoint
 * (the loader copies each view), accessor ⊆ view, Σ accessor bytes ≤ BIN. GPU uploads are bounded too: an accessor
 * in a strided view becomes an InterleavedBuffer of `count × byteStride` bytes per distinct
 * `view:componentType:⌊offset/stride⌋:count` (three.js GLTFLoader's cache key), so many accessors with different
 * counts on one wide-stride view would multiply the file; the upload total may be at most 2 × BIN (two interleaved
 * attributes of different component types in one view upload it twice). A snapshot without geometry may have an
 * empty buffer and no BIN chunk — but then no accessor either.
 */
function checkBuffers(json: Json, binLength: number): InvalidReason | null {
  const buffers = list(json, "buffers");
  const views = list(json, "bufferViews");
  if (views.length > 0 || buffers.length > 0) {
    const buffer = buffers[0];
    if (buffers.length !== 1 || !isObject(buffer) || buffer["uri"] !== undefined) return "buffers";
    const bufferLength = buffer["byteLength"];
    if (!isCount(bufferLength, views.length > 0 ? 1 : 0) || bufferLength > binLength)
      return "buffers";
    const ranges: [number, number][] = [];
    for (const v of views) {
      if (!isObject(v) || v["buffer"] !== 0) return "buffers";
      const offset = v["byteOffset"] ?? 0;
      const length = v["byteLength"];
      const stride = v["byteStride"];
      if (!isCount(offset) || !isCount(length, 1) || offset + length > bufferLength)
        return "buffers";
      if (stride !== undefined && (!isCount(stride, 4) || stride > 252)) return "buffers";
      ranges.push([offset, offset + length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) return "buffers";
  }

  let total = 0;
  let upload = 0;
  const interleaved = new Set<string>();
  for (const a of list(json, "accessors")) {
    if (!isObject(a) || a["sparse"] !== undefined) return "accessors";
    // Without a buffer view GLTFLoader allocates a zero-filled `count × itemSize` array: unbounded by the file.
    if (!isIndex(a["bufferView"], views.length)) return "accessors";
    const view = views[a["bufferView"]] as Json;
    const componentBytes = COMPONENT_BYTES.get(a["componentType"]);
    const components = TYPE_COMPONENTS.get(a["type"]);
    const count = a["count"];
    const offset = a["byteOffset"] ?? 0;
    if (!componentBytes || !components || !isCount(count, 1) || !isCount(offset))
      return "accessors";
    const element = componentBytes * components;
    const stride = (view["byteStride"] as number | undefined) ?? element;
    const end = offset + (count - 1) * stride + element;
    if (!(end <= (view["byteLength"] as number))) return "accessors"; // NaN fails closed
    total += count * element;
    if (stride === element) upload += count * element;
    else {
      const key = `${a["bufferView"]}:${a["componentType"]}:${Math.floor(offset / stride)}:${count}`;
      if (!interleaved.has(key)) upload += count * stride;
      interleaved.add(key);
    }
  }
  return total <= binLength && upload <= 2 * binLength ? null : "accessors";
}

/**
 * §7.1/§7.2/§7.4: one TRIANGLES primitive per mesh with POSITION + NORMAL (VEC3) and optional integer indices; each
 * accessor fills one slot of one primitive and each material serves one primitive (an M owns its mesh and material),
 * so the triangles drawn per frame are bounded by the file and no material is deep-copied per node.
 */
function checkMeshes(json: Json): InvalidReason | null {
  const accessors = list(json, "accessors");
  const materials = list(json, "materials");
  const usedAccessors = new Set<number>();
  const usedMaterials = new Set<number>();
  const use = (index: unknown): Json | undefined => {
    if (!isIndex(index, accessors.length) || usedAccessors.has(index)) return undefined;
    usedAccessors.add(index);
    return accessors[index] as Json;
  };
  for (const m of list(json, "meshes")) {
    if (!isObject(m) || m["weights"] !== undefined) return "meshes";
    const primitives = m["primitives"];
    if (!Array.isArray(primitives) || primitives.length !== 1 || !isObject(primitives[0]))
      return "meshes";
    const p = primitives[0];
    if (p["mode"] !== undefined && p["mode"] !== TRIANGLES) return "meshes";
    if (p["targets"] !== undefined) return "meshes"; // morph targets: allocations per target at first render
    const material = p["material"];
    if (material !== undefined) {
      if (!isIndex(material, materials.length) || usedMaterials.has(material)) return "meshes";
      usedMaterials.add(material);
    }
    const attributes = p["attributes"];
    if (!isObject(attributes) || !Object.keys(attributes).every((name) => ATTRIBUTES.has(name)))
      return "meshes";
    for (const name of ATTRIBUTES) if (use(attributes[name])?.["type"] !== "VEC3") return "meshes";
    if (p["indices"] !== undefined) {
      const indices = use(p["indices"]);
      if (
        indices?.["type"] !== "SCALAR" ||
        !INDEX_COMPONENTS.has(indices["componentType"] as number)
      )
        return "meshes";
    }
  }
  return null;
}

/** §7.1 pre-validation of the container and the JSON chunk; never throws. */
export function validateGlb(bytes: Uint8Array): GlbCheck {
  try {
    const container = readContainer(bytes);
    if (typeof container === "string") return { ok: false, reason: container };
    const { json, binLength } = container;
    const reason =
      (COLLECTIONS.some((k) => json[k] !== undefined && !Array.isArray(json[k])) ? "json" : null) ??
      scanJson(json) ??
      (FORBIDDEN_KEYS.some(
        (k) => json[k] !== undefined && !(Array.isArray(json[k]) && json[k].length === 0),
      )
        ? "forbidden"
        : null) ??
      checkMaterials(json) ??
      (extensionsAllowed(json["extensionsUsed"]) && extensionsAllowed(json["extensionsRequired"])
        ? null
        : "extensions") ??
      checkScene(json) ??
      checkNodes(json) ??
      checkBuffers(json, binLength) ??
      checkMeshes(json);
    return reason ? { ok: false, reason } : { ok: true };
  } catch {
    return { ok: false, reason: "json" }; // defence in depth: a check that throws refuses the snapshot
  }
}
