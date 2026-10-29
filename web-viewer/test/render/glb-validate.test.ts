import { describe, expect, it, vi } from "vitest";
import {
  MAX_GLTF_NODES,
  MAX_JSON_BYTES,
  MAX_MANIFEST_NODES,
  validateGlb,
} from "../../src/render/glb-validate";
import {
  appendChunk,
  buildGlb,
  CHUNK_JSON,
  emptySceneJson,
  glb,
  jsonChunk,
  jsonOf,
  withJson,
} from "./glb-fixtures";
import type { Json } from "./glb-fixtures";

const BASE = () => glb("asymmetric-2nodes.glb");
const edited = (edit: (j: Json) => void) => validateGlb(withJson(BASE(), edit));
const at = (j: Json, key: string, i: number) => (j[key] as Json[])[i]!;
const root = (j: Json) => at(j, "nodes", 0);
const prim = (j: Json, mesh: number) => (at(j, "meshes", mesh)["primitives"] as Json[])[0]!;
const attrs = (j: Json, mesh: number) => prim(j, mesh)["attributes"] as Json;
const QUANTIZED = () => glb("quantized-1node.glb");
/** Nested arrays `depth` levels deep, without recursion. */
const nested = (depth: number) => {
  let v: unknown = [];
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};

describe("valid fixtures", () => {
  it.each(["asymmetric-2nodes.glb", "quantized-1node.glb", "large-synthetic.glb"])(
    "%s passes",
    (name) => expect(validateGlb(glb(name))).toEqual({ ok: true }),
  );

  it("an empty Slicer scene (root only) passes, with an empty BIN chunk or none at all", () => {
    expect(validateGlb(buildGlb(emptySceneJson(), new Uint8Array(0)))).toEqual({ ok: true });
    expect(validateGlb(buildGlb(emptySceneJson()))).toEqual({ ok: true });
    const noBuffers = emptySceneJson();
    delete noBuffers["buffers"];
    expect(validateGlb(buildGlb(noBuffers))).toEqual({ ok: true });
  });

  it("also when handed as a view at an offset into a larger buffer", () => {
    const bytes = BASE();
    const padded = new Uint8Array(bytes.byteLength + 16);
    padded.set(bytes, 8);
    expect(validateGlb(padded.subarray(8, 8 + bytes.byteLength))).toEqual({ ok: true });
  });
});

describe("container (glTF 2.0 §4.4, §7.1)", () => {
  const patch = (offset: number, value: number) => {
    const bytes = BASE();
    new DataView(bytes.buffer).setUint32(offset, value, true);
    return validateGlb(bytes);
  };

  it.each([
    ["bad-magic.glb", "container"],
    ["truncated.glb", "container"],
    ["external-uri.glb", "buffers"],
    ["two-scenes.glb", "scene"],
    ["no-root-extras.glb", "root"],
  ])("broken fixture %s → %s", (name, reason) => {
    expect(validateGlb(glb(name))).toEqual({ ok: false, reason });
  });

  it("refuses version ≠ 2, a header length that disagrees with the file and a second chunk that is not BIN", () => {
    expect(patch(4, 1)).toEqual({ ok: false, reason: "container" });
    expect(patch(8, BASE().byteLength + 4)).toEqual({ ok: false, reason: "container" });
    const jsonLength = new DataView(BASE().buffer).getUint32(12, true);
    expect(patch(20 + jsonLength + 4, CHUNK_JSON)).toEqual({ ok: false, reason: "container" });
  });

  it("refuses a chunk after BIN (GLTFLoader would use a later JSON chunk than the validated one)", () => {
    const evil = jsonOf(BASE());
    (evil["buffers"] as Json[])[0]!["uri"] = "https://attacker.example/x.bin";
    expect(validateGlb(appendChunk(BASE(), CHUNK_JSON, jsonChunk(evil)))).toEqual({
      ok: false,
      reason: "container",
    });
  });

  it("refuses a JSON chunk that is not UTF-8 (fatal decoding), and an empty JSON object has no scene", () => {
    const bytes = BASE();
    // inside a string value, so only strict UTF-8 decoding — not JSON syntax — can catch it
    const at = new TextDecoder().decode(bytes.subarray(20, 200)).indexOf("SlicerRemoteView");
    expect(at).toBeGreaterThan(0);
    bytes[20 + at] = 0xff;
    expect(validateGlb(bytes)).toEqual({ ok: false, reason: "json" });
    expect(
      validateGlb(withJson(BASE(), (j) => Object.keys(j).forEach((k) => delete j[k]))),
    ).toEqual({ ok: false, reason: "scene" });
  });

  it("refuses files too short for a header and a JSON chunk length past the end, without throwing", () => {
    for (const length of [0, 4, 12, 19]) {
      expect(validateGlb(BASE().subarray(0, length)), String(length)).toEqual({
        ok: false,
        reason: "container",
      });
    }
    const bytes = BASE();
    new DataView(bytes.buffer).setUint32(12, 0xfffffff0, true);
    expect(validateGlb(bytes)).toEqual({ ok: false, reason: "container" });
  });

  it("refuses a JSON chunk that is not 4-byte aligned (§7.1, glTF §4.4.3)", () => {
    const json = emptySceneJson();
    json["asset"] = { version: "2.0", generator: "x" }; // length chosen below
    let unaligned = buildGlb(json, new Uint8Array(0), false);
    for (let pad = 0; new DataView(unaligned.buffer).getUint32(12, true) % 4 === 0; pad++) {
      json["asset"] = { version: "2.0", generator: "x".repeat(pad + 2) };
      unaligned = buildGlb(json, new Uint8Array(0), false);
    }
    expect(validateGlb(unaligned)).toEqual({ ok: false, reason: "container" });
    expect(validateGlb(buildGlb(json, new Uint8Array(0)))).toEqual({ ok: true });
  });

  it("never throws on random bytes", () => {
    for (let n = 0; n < 200; n++) {
      const bytes = BASE();
      const i = (n * 7919) % bytes.byteLength;
      bytes[i] = bytes[i]! ^ 0x5a;
      expect(() => validateGlb(bytes)).not.toThrow();
    }
  });
});

describe("container edge cases (never throws)", () => {
  it("refuses a 16-byte file whose header claims 16 bytes, and trailing bytes after the JSON chunk", () => {
    const short = BASE().slice(0, 16);
    new DataView(short.buffer).setUint32(8, 16, true);
    expect(validateGlb(short)).toEqual({ ok: false, reason: "container" });
    const empty = buildGlb(emptySceneJson());
    const trailing = new Uint8Array(empty.byteLength + 4);
    trailing.set(empty);
    new DataView(trailing.buffer).setUint32(8, trailing.byteLength, true);
    expect(validateGlb(trailing)).toEqual({ ok: false, reason: "container" });
  });

  it("refuses a first chunk that is not JSON and a BIN chunk that is not 4-byte aligned", () => {
    const bytes = BASE();
    new DataView(bytes.buffer).setUint32(16, 0x12345678, true);
    expect(validateGlb(bytes)).toEqual({ ok: false, reason: "container" });
    expect(validateGlb(buildGlb(emptySceneJson(), new Uint8Array(3)))).toEqual({
      ok: false,
      reason: "container",
    });
  });

  it("refuses a JSON chunk above 8 MiB before decoding it; a large manifest below the cap passes", () => {
    const sized = (bytes: number) =>
      withJson(BASE(), (j) => ((j["asset"] as Json)["generator"] = "x".repeat(bytes)));
    const over = sized(MAX_JSON_BYTES);
    expect(new DataView(over.buffer).getUint32(12, true)).toBeGreaterThan(MAX_JSON_BYTES);
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      expect(validateGlb(over)).toEqual({ ok: false, reason: "json" });
      expect(decode).not.toHaveBeenCalled(); // refused before decoding, not after parsing
    } finally {
      decode.mockRestore();
    }
    expect(validateGlb(sized(2 * 1024 * 1024))).toEqual({ ok: true });
    expect(MAX_JSON_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses a JSON chunk that is `null`", () => {
    expect(validateGlb(buildGlb(null as unknown as Json))).toEqual({ ok: false, reason: "json" });
  });

  it("refuses JSON nested deeper than the validator walks, instead of overflowing the stack", () => {
    const deep = withJson(BASE(), (j) => ((j["asset"] as Json)["x"] = nested(3000)));
    expect(() => validateGlb(deep)).not.toThrow();
    expect(validateGlb(deep)).toEqual({ ok: false, reason: "json" });
    // deep nesting inside extras is manifest data and is not walked
    const inExtras = withJson(BASE(), (j) => ((root(j)["extras"] as Json)["deep"] = nested(3000)));
    expect(validateGlb(inExtras)).toEqual({ ok: true });
  });

  it.each<[string, (j: Json) => void, string]>([
    ["scenes: [null]", (j) => (j["scenes"] = [null]), "scene"],
    ["a null root node", (j) => ((j["nodes"] as unknown[])[0] = null), "scene"],
    ["a null node", (j) => ((j["nodes"] as unknown[])[2] = null), "nodes"],
    ["buffers: [null]", (j) => (j["buffers"] = [null]), "buffers"],
    ["a null buffer view", (j) => ((j["bufferViews"] as unknown[])[0] = null), "buffers"],
    ["a null accessor", (j) => ((j["accessors"] as unknown[])[0] = null), "accessors"],
    ["a null mesh", (j) => ((j["meshes"] as unknown[])[0] = null), "meshes"],
    ["primitives: [null]", (j) => (at(j, "meshes", 0)["primitives"] = [null]), "meshes"],
    ["extensions: null", (j) => (j["extensions"] = null), "extensions"],
    ["indices out of range", (j) => (prim(j, 0)["indices"] = 99), "meshes"],
  ])("refuses %s without throwing", (_label, edit, reason) => {
    const bytes = withJson(BASE(), edit);
    expect(() => validateGlb(bytes)).not.toThrow();
    expect(validateGlb(bytes)).toEqual({ ok: false, reason });
  });
});

describe("accepted variants of valid glTF", () => {
  it.each<[string, (j: Json) => void]>([
    ["no top-level scene (defaults to 0)", (j) => delete j["scene"]],
    ["a primitive without mode (defaults to TRIANGLES)", (j) => delete prim(j, 0)["mode"]],
    ["an empty extensions object", (j) => (at(j, "nodes", 1)["extensions"] = {})],
    [
      "an `extensions` key inside extras",
      (j) => ((at(j, "nodes", 1)["extras"] as Json)["extensions"] = { x: 1 }),
    ],
    [
      "a material without pbrMetallicRoughness",
      (j) => delete at(j, "materials", 0)["pbrMetallicRoughness"],
    ],
    [
      "buffer views not listed in byte order",
      (j) => {
        const views = j["bufferViews"] as Json[];
        [views[0], views[1]] = [views[1]!, views[0]!];
        at(j, "accessors", 0)["bufferView"] = 1;
        at(j, "accessors", 1)["bufferView"] = 0;
      },
    ],
    [
      "exactly 2,001 glTF nodes",
      (j) => {
        const nodes = j["nodes"] as Json[];
        while (nodes.length < 2001) nodes.push({});
      },
    ],
    [
      "exactly 1,000 root children",
      (j) => {
        const nodes = j["nodes"] as Json[];
        const children = root(j)["children"] as number[];
        while (children.length < 1000) children.push(nodes.push({}) - 1);
      },
    ],
  ])("%s", (_label, edit) => {
    expect(edited(edit)).toEqual({ ok: true });
  });

  it("node limits are the documented ones", () => {
    expect(MAX_GLTF_NODES).toBe(2001);
    expect(MAX_MANIFEST_NODES).toBe(1000);
  });

  it("normalised BYTE normals (§7.4) in a 4-byte strided view and unstrided, bounded exactly", () => {
    const normals = (count: number, view: Json) =>
      validateGlb(
        withJson(QUANTIZED(), (j) => {
          Object.assign(at(j, "accessors", 1), { componentType: 5120, normalized: true, count });
          Object.assign(at(j, "bufferViews", 1), view);
        }),
      );
    expect(normals(66, { byteLength: 264, byteStride: 4 })).toEqual({ ok: true });
    expect(normals(67, { byteLength: 264, byteStride: 4 })).toEqual({
      ok: false,
      reason: "accessors",
    });
    expect(normals(66, { byteLength: 198 })).toEqual({ ok: true });
    expect(normals(66, { byteLength: 197 })).toEqual({ ok: false, reason: "accessors" });
  });
});

describe("JSON chunk rules (§7.1)", () => {
  it.each<[string, (j: Json) => void, string]>([
    ["nodes as an object", (j) => (j["nodes"] = { 0: root(j) }), "json"],
    ["images (array)", (j) => (j["images"] = [{ uri: "x.png" }]), "forbidden"],
    // An object form is still read by GLTFLoader (`json.images[index]`): it must not slip through.
    [
      "images (object)",
      (j) => (j["images"] = { 0: { uri: "https://x.example/a.png" } }),
      "forbidden",
    ],
    ["textures (object)", (j) => (j["textures"] = { 0: { source: 0 } }), "forbidden"],
    ["samplers", (j) => (j["samplers"] = [{}]), "forbidden"],
    ["animations", (j) => (j["animations"] = [{ channels: [], samplers: [] }]), "forbidden"],
    ["skins", (j) => (j["skins"] = [{ joints: [1] }]), "forbidden"],
    ["cameras", (j) => (j["cameras"] = [{ type: "perspective" }]), "forbidden"],
    [
      "Draco required",
      (j) => (j["extensionsRequired"] = ["KHR_draco_mesh_compression"]),
      "extensions",
    ],
    ["lights used", (j) => (j["extensionsUsed"] = ["KHR_lights_punctual"]), "extensions"],
    ["meshopt used", (j) => (j["extensionsUsed"] = ["EXT_meshopt_compression"]), "extensions"],
    [
      "extensionsUsed not an array",
      (j) => (j["extensionsUsed"] = "KHR_mesh_quantization"),
      "extensions",
    ],
    ["default scene 1", (j) => (j["scene"] = 1), "scene"],
    ["two root nodes", (j) => (at(j, "scenes", 0)["nodes"] = [0, 1]), "scene"],
    ["root index out of range", (j) => (at(j, "scenes", 0)["nodes"] = [99]), "scene"],
    ["root kind is not root", (j) => ((root(j)["extras"] as Json)["kind"] = "model"), "root"],
    [
      "too many glTF nodes",
      (j) => {
        const nodes = j["nodes"] as Json[];
        while (nodes.length <= MAX_GLTF_NODES) nodes.push({});
      },
      "nodes",
    ],
    [
      "too many manifest nodes",
      (j) => (root(j)["children"] = Array.from({ length: MAX_MANIFEST_NODES + 1 }, () => 1)),
      "nodes",
    ],
    [
      "two buffers",
      (j) => (j["buffers"] = [...(j["buffers"] as Json[]), { byteLength: 4 }]),
      "buffers",
    ],
    [
      "data: uri",
      (j) => (at(j, "buffers", 0)["uri"] = "data:application/octet-stream;base64,AAAA"),
      "buffers",
    ],
    [
      "buffer longer than the BIN chunk",
      (j) => (at(j, "buffers", 0)["byteLength"] = 1e6),
      "buffers",
    ],
    ["view on buffer 1", (j) => (at(j, "bufferViews", 0)["buffer"] = 1), "buffers"],
    ["view past the buffer", (j) => (at(j, "bufferViews", 5)["byteLength"] = 1e6), "buffers"],
    ["view with byteStride 2", (j) => (at(j, "bufferViews", 0)["byteStride"] = 2), "buffers"],
    // A bufferView-less accessor makes GLTFLoader allocate count × itemSize zeros: a 3 KB file, 600 MB of memory.
    ["accessor without bufferView", (j) => delete at(j, "accessors", 0)["bufferView"], "accessors"],
    ["huge accessor count", (j) => (at(j, "accessors", 0)["count"] = 50_000_000), "accessors"],
    ["accessor past its view", (j) => (at(j, "accessors", 2)["byteOffset"] = 4), "accessors"],
    ["sparse accessor", (j) => (at(j, "accessors", 0)["sparse"] = { count: 1 }), "accessors"],
    ["unknown componentType", (j) => (at(j, "accessors", 0)["componentType"] = 5130), "accessors"],
    ["NaN count", (j) => (at(j, "accessors", 0)["count"] = "4"), "accessors"],
    [
      "two primitives",
      (j) => {
        const p = (at(j, "meshes", 0)["primitives"] as Json[])[0]!;
        at(j, "meshes", 0)["primitives"] = [p, p];
      },
      "meshes",
    ],
    [
      "LINES primitive",
      (j) => ((at(j, "meshes", 0)["primitives"] as Json[])[0]!["mode"] = 1),
      "meshes",
    ],
    ["accessors as an object", (j) => (j["accessors"] = { 0: at(j, "accessors", 0) }), "json"],
    ["meshes as an object", (j) => (j["meshes"] = { 0: at(j, "meshes", 0) }), "json"],
    [
      "a base colour texture reference",
      (j) =>
        ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["baseColorTexture"] = {
          index: 0,
        }),
      "forbidden",
    ],
    [
      "a normal texture reference",
      (j) => (at(j, "materials", 0)["normalTexture"] = { index: 0 }),
      "forbidden",
    ],
    // three.js runs its plugins for any `extensions` object, whatever extensionsUsed says (T10):
    [
      "GPU instancing on a mesh node",
      (j) =>
        (at(j, "nodes", 2)["extensions"] = {
          EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } },
        }),
      "extensions",
    ],
    [
      "a punctual light",
      (j) => {
        j["extensions"] = { KHR_lights_punctual: { lights: [{ type: "point", intensity: 1e6 }] } };
        at(j, "nodes", 1)["extensions"] = { KHR_lights_punctual: { light: 0 } };
      },
      "extensions",
    ],
    [
      "KHR_materials_transmission",
      (j) =>
        (at(j, "materials", 0)["extensions"] = {
          KHR_materials_transmission: { transmissionFactor: 1 },
        }),
      "extensions",
    ],
    [
      "Draco on a primitive",
      (j) =>
        ((at(j, "meshes", 0)["primitives"] as Json[])[0]!["extensions"] = {
          KHR_draco_mesh_compression: {},
        }),
      "extensions",
    ],
    [
      "meshopt on a buffer view",
      (j) => (at(j, "bufferViews", 0)["extensions"] = { EXT_meshopt_compression: {} }),
      "extensions",
    ],
    [
      "overlapping buffer views",
      (j) => (j["bufferViews"] as Json[]).push({ buffer: 0, byteOffset: 0, byteLength: 744 }),
      "buffers",
    ],
    [
      "accessors adding up to more than the BIN chunk",
      (j) => {
        const accessors = j["accessors"] as Json[];
        for (let n = 0; n < 40; n++) accessors.push({ ...accessors[3]! });
      },
      "accessors",
    ],
    [
      "type 'constructor' with a huge count",
      (j) => Object.assign(at(j, "accessors", 0), { type: "constructor", count: 2 ** 40 }),
      "accessors",
    ],
    [
      "componentType '__proto__'",
      (j) => (at(j, "accessors", 0)["componentType"] = "__proto__"),
      "accessors",
    ],
    [
      "morph targets",
      (j) => ((at(j, "meshes", 0)["primitives"] as Json[])[0]!["targets"] = [{ POSITION: 0 }]),
      "meshes",
    ],
    ["mesh weights", (j) => (at(j, "meshes", 0)["weights"] = [1]), "meshes"],
    ["node weights", (j) => (at(j, "nodes", 2)["weights"] = [1]), "meshes"],
    [
      "a TEXCOORD_0 attribute",
      (j) =>
        (((at(j, "meshes", 0)["primitives"] as Json[])[0]!["attributes"] as Json)["TEXCOORD_0"] =
          0),
      "meshes",
    ],
    [
      "a COLOR_0 attribute (no vertex colours in v1)",
      (j) =>
        (((at(j, "meshes", 0)["primitives"] as Json[])[0]!["attributes"] as Json)["COLOR_0"] = 0),
      "meshes",
    ],
    [
      "no NORMAL (§7.4 requires it)",
      (j) =>
        delete ((at(j, "meshes", 0)["primitives"] as Json[])[0]!["attributes"] as Json)["NORMAL"],
      "meshes",
    ],
    ["UNSIGNED_BYTE indices", (j) => (at(j, "accessors", 2)["componentType"] = 5121), "meshes"],
    // count 6 keeps the FLOAT accessor inside its 24-byte view, so the index rule (not the bound) refuses it
    [
      "FLOAT indices",
      (j) => Object.assign(at(j, "accessors", 2), { componentType: 5126, count: 6 }),
      "meshes",
    ],
    ["materials as an object", (j) => (j["materials"] = { 0: at(j, "materials", 0) }), "json"],
    ["buffers as an object", (j) => (j["buffers"] = { 0: at(j, "buffers", 0) }), "json"],
    [
      "bufferViews as an object",
      (j) => (j["bufferViews"] = { 0: at(j, "bufferViews", 0) }),
      "json",
    ],
    ["scenes as an object", (j) => (j["scenes"] = { 0: at(j, "scenes", 0) }), "json"],
    [
      "an occlusion texture reference",
      (j) => (at(j, "materials", 0)["occlusionTexture"] = { index: 0 }),
      "forbidden",
    ],
    [
      "an emissive texture reference",
      (j) => (at(j, "materials", 0)["emissiveTexture"] = { index: 0 }),
      "forbidden",
    ],
    [
      "a metallic-roughness texture reference",
      (j) =>
        ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["metallicRoughnessTexture"] = {
          index: 0,
        }),
      "forbidden",
    ],
    ["a null material", (j) => ((j["materials"] as unknown[])[0] = null), "forbidden"],
    ["a camera on a node", (j) => (at(j, "nodes", 1)["camera"] = 0), "forbidden"],
    ["a skin on a node", (j) => (at(j, "nodes", 2)["skin"] = 0), "forbidden"],
    ["root nodeId other than 'root'", (j) => ((root(j)["extras"] as Json)["nodeId"] = "x"), "root"],
    // the node graph must be a tree under the root (no repeats, cycles or second parents)
    ["a repeated child", (j) => (at(j, "nodes", 1)["children"] = [2, 2]), "nodes"],
    ["a self-loop", (j) => (at(j, "nodes", 2)["children"] = [2]), "nodes"],
    ["a node with two parents", (j) => (at(j, "nodes", 3)["children"] = [4, 2]), "nodes"],
    ["the root as a child", (j) => (at(j, "nodes", 2)["children"] = [0]), "nodes"],
    ["children that is not an array", (j) => (at(j, "nodes", 1)["children"] = 2), "nodes"],
    ["a child index out of range", (j) => (at(j, "nodes", 1)["children"] = [99]), "nodes"],
    // §7.2: an M owns its mesh, its accessors and its material
    ["a mesh used by two nodes", (j) => (at(j, "nodes", 4)["mesh"] = 0), "meshes"],
    ["a mesh index out of range", (j) => (at(j, "nodes", 2)["mesh"] = 99), "meshes"],
    ["a material used by two primitives", (j) => (prim(j, 1)["material"] = 0), "meshes"],
    ["a material index out of range", (j) => (prim(j, 0)["material"] = 99), "meshes"],
    ["an accessor shared by two meshes", (j) => (attrs(j, 1)["POSITION"] = 0), "meshes"],
    ["POSITION and NORMAL on one accessor", (j) => (attrs(j, 0)["NORMAL"] = 0), "meshes"],
    ["a SCALAR POSITION", (j) => (at(j, "accessors", 0)["type"] = "SCALAR"), "meshes"],
    [
      "VEC3 indices",
      (j) => Object.assign(at(j, "accessors", 2), { type: "VEC3", count: 4 }),
      "meshes",
    ],
    // numeric fields
    ["a buffer without byteLength", (j) => delete at(j, "buffers", 0)["byteLength"], "buffers"],
    ["a negative view offset", (j) => (at(j, "bufferViews", 0)["byteOffset"] = -8), "buffers"],
    [
      "a zero-length view",
      (j) => (j["bufferViews"] as Json[]).push({ buffer: 0, byteOffset: 744, byteLength: 0 }),
      "buffers",
    ],
    ["byteStride 256 (max 252)", (j) => (at(j, "bufferViews", 0)["byteStride"] = 256), "buffers"],
    [
      "a view overlapping only its neighbour",
      (j) => Object.assign(at(j, "bufferViews", 1), { byteOffset: 40, byteLength: 56 }),
      "buffers",
    ],
    ["a negative accessor offset", (j) => (at(j, "accessors", 0)["byteOffset"] = -4), "accessors"],
    ["accessor count 0", (j) => (at(j, "accessors", 0)["count"] = 0), "accessors"],
    ["accessor count 1.5", (j) => (at(j, "accessors", 0)["count"] = 1.5), "accessors"],
    [
      "an accessor one element past its view",
      (j) => (at(j, "accessors", 0)["count"] = 5),
      "accessors",
    ],
    [
      "accessors exceeding the BIN chunk by one index buffer",
      (j) => (j["accessors"] as Json[]).push({ ...at(j, "accessors", 2) }),
      "accessors",
    ],
    // §7.4 factors: GLTFLoader copies them into the material unchecked
    [
      "a string in baseColorFactor",
      (j) =>
        ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["baseColorFactor"] = [
          "red",
          0,
          0,
          1,
        ]),
      "materials",
    ],
    [
      "a null alpha in baseColorFactor",
      (j) =>
        ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["baseColorFactor"] = [
          1,
          0,
          0,
          null,
        ]),
      "materials",
    ],
    [
      "a 3-element baseColorFactor",
      (j) =>
        ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["baseColorFactor"] = [1, 0, 0]),
      "materials",
    ],
    [
      "metallicFactor 2",
      (j) => ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["metallicFactor"] = 2),
      "materials",
    ],
    [
      "roughnessFactor -1",
      (j) => ((at(j, "materials", 0)["pbrMetallicRoughness"] as Json)["roughnessFactor"] = -1),
      "materials",
    ],
    [
      "emissiveFactor out of range",
      (j) => (at(j, "materials", 0)["emissiveFactor"] = [2, 0, 0]),
      "materials",
    ],
    ["an unknown alphaMode", (j) => (at(j, "materials", 0)["alphaMode"] = "WEIRD"), "materials"],
    [
      "pbrMetallicRoughness that is not an object",
      (j) => (at(j, "materials", 0)["pbrMetallicRoughness"] = 1),
      "materials",
    ],
  ])("refuses %s", (_label, edit, reason) => {
    expect(edited(edit)).toEqual({ ok: false, reason });
  });

  it("accepts empty forbidden arrays and KHR_mesh_quantization as used and required", () => {
    expect(
      edited((j) => {
        j["images"] = [];
        j["animations"] = [];
        j["extensionsUsed"] = ["KHR_mesh_quantization"];
        j["extensionsRequired"] = ["KHR_mesh_quantization"];
      }),
    ).toEqual({ ok: true });
  });

  it("bounds strided accessors by (count − 1) × stride + element size", () => {
    // quantized-1node.glb stores POSITION as SHORT VEC3 (6 B) in a view with byteStride 8.
    expect(validateGlb(glb("quantized-1node.glb"))).toEqual({ ok: true });
    const q = jsonOf(glb("quantized-1node.glb"));
    const strided = (q["accessors"] as Json[]).findIndex(
      (a) => (q["bufferViews"] as Json[])[a["bufferView"] as number]!["byteStride"] !== undefined,
    );
    expect(strided).toBeGreaterThanOrEqual(0);
    const bumped = withJson(glb("quantized-1node.glb"), (j) => {
      const a = at(j, "accessors", strided);
      a["count"] = (a["count"] as number) + 1;
    });
    expect(validateGlb(bumped)).toEqual({ ok: false, reason: "accessors" });
  });
});

describe("allocation bounds", () => {
  it("strided and 4-byte element bounds are exact on the other fixtures", () => {
    const q = withJson(QUANTIZED(), (j) => (at(j, "bufferViews", 0)["byteLength"] = 525)); // needs 526
    expect(validateGlb(q)).toEqual({ ok: false, reason: "accessors" });
    const large = withJson(
      glb("large-synthetic.glb"),
      (j) => (at(j, "accessors", 2)["count"] = 393217),
    );
    expect(validateGlb(large)).toEqual({ ok: false, reason: "accessors" });
  });

  it("an empty-scene file cannot smuggle bufferView-less accessors (a 0.5 KB file asking for 1.2 GB)", () => {
    const bomb = emptySceneJson();
    const nodes = bomb["nodes"] as Json[];
    nodes[0]!["children"] = [1];
    nodes.push({ name: "T", extras: { nodeId: "vtkMRMLModelNode1" }, children: [2] }, { mesh: 0 });
    bomb["meshes"] = [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }];
    bomb["accessors"] = [0, 1].map(() => ({
      componentType: 5126,
      type: "VEC3",
      count: 50_000_000,
    }));
    delete bomb["buffers"];
    expect(validateGlb(buildGlb(bomb))).toEqual({ ok: false, reason: "accessors" });
    expect(validateGlb(buildGlb(bomb, new Uint8Array(0)))).toEqual({
      ok: false,
      reason: "accessors",
    });
  });

  it("GPU uploads of strided accessors count once per InterleavedBuffer and stay ≤ 2 × BIN", () => {
    // One 1,008-byte view with byteStride 252 and BYTE VEC3 accessors: GLTFLoader makes one InterleavedBuffer of
    // count × 252 bytes per distinct count, although each accessor only "uses" count × 3 bytes.
    const strided = (counts: number[]) => {
      const json = emptySceneJson();
      json["buffers"] = [{ byteLength: 1008 }];
      json["bufferViews"] = [{ buffer: 0, byteLength: 1008, byteStride: 252 }];
      json["accessors"] = counts.map((count) => ({
        bufferView: 0,
        componentType: 5120,
        type: "VEC3",
        count,
      }));
      return validateGlb(buildGlb(json, new Uint8Array(1008)));
    };
    expect(strided([4, 4])).toEqual({ ok: true }); // same key: one 1,008-byte upload
    expect(strided([4, 3])).toEqual({ ok: true }); // 1,008 + 756 = 1,764 ≤ 2,016
    expect(strided([4, 3, 2])).toEqual({ ok: false, reason: "accessors" }); // + 504 = 2,268 > 2,016
  });
});
