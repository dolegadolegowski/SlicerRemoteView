import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { BufferGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from "three";
import type { Material } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  applyOpacity,
  createSceneModelStore,
  parseSceneModel,
  TRANSLUCENT_RENDER_ORDER,
} from "../../src/render/scene-model";
import type { ParseGlb, SceneModel } from "../../src/render/scene-model";
import { buildGlb, emptySceneJson, glb, jsonOf, manifest, withJson } from "./glb-fixtures";
import type { Json } from "./glb-fixtures";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
/** Edits the `T.extras` of one node of asymmetric-2nodes.glb. */
const withExtras = (nodeId: string, edit: (extras: Json) => void) =>
  withJson(glb("asymmetric-2nodes.glb"), (j) => {
    const node = (j["nodes"] as Json[]).find((n) => (n["extras"] as Json)?.["nodeId"] === nodeId)!;
    edit(node["extras"] as Json);
  });

async function load(name: string, parse?: ParseGlb): Promise<SceneModel> {
  const result = await parseSceneModel(glb(name), parse ? { parse } : {});
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.model;
}

/** Real GLTFLoader, with every geometry and material wrapped in a `dispose` spy. */
function spyingParse() {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const parse: ParseGlb = async (buffer) => {
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    const seen = new Set<BufferGeometry | Material>();
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      for (const r of [o.geometry as BufferGeometry, o.material as Material]) {
        if (seen.has(r)) continue;
        seen.add(r);
        spies.push(vi.spyOn(r, "dispose"));
      }
    });
    return gltf;
  };
  return { parse, spies };
}

describe("asymmetric-2nodes.glb (§7.1–7.3, FR-64, FR-65, R-11)", () => {
  it("maps both T nodes by nodeId with the manifest values from T.extras", async () => {
    const model = await load("asymmetric-2nodes.glb");
    expect([...model.nodes.keys()]).toEqual(manifest.files["asymmetric-2nodes.glb"]!.nodeIds);
    const liver = model.nodes.get("vtkMRMLSegmentationNode1/Segment_1")!;
    const tumor = model.nodes.get("vtkMRMLModelNode2")!;
    expect(liver.manifest).toMatchObject({
      name: "Liver",
      kind: "segment",
      color: [0.8, 0.33, 0.27],
      opacity: 1,
      visible: true,
    });
    expect(tumor.manifest).toMatchObject({
      name: "Tumor",
      kind: "model",
      color: [0.95, 0.85, 0.7],
      opacity: 0.35,
      visible: true,
    });
    // cross-check against the GLB JSON itself
    const json = jsonOf(glb("asymmetric-2nodes.glb"));
    const extras = (json["nodes"] as Json[])
      .map((n) => n["extras"] as Json | undefined)
      .filter((e): e is Json => typeof e?.["nodeId"] === "string" && e["nodeId"] !== "root");
    for (const e of extras) {
      const node = model.nodes.get(e["nodeId"] as string)!;
      for (const key of ["name", "color", "opacity", "visible"])
        expect(node.manifest[key as keyof typeof node.manifest], key).toEqual(e[key]);
    }
    expect(model.info).toEqual({ sceneVersion: 1, profile: "mobile", anonymizedNames: false });
  });

  it("keeps glTF +X: the vertex at (+0.1,0,0) is at +0.1 on X in the model, the root only rotates", async () => {
    const model = await load("asymmetric-2nodes.glb");
    const { M } = model.nodes.get("vtkMRMLSegmentationNode1/Segment_1")!;
    const position = M.geometry.getAttribute("position");
    const local = new Vector3();
    let index = -1;
    for (let i = 0; i < position.count; i++) {
      local.fromBufferAttribute(position, i);
      if (Math.abs(local.x - 0.1) < 1e-6 && Math.abs(local.y) < 1e-6 && Math.abs(local.z) < 1e-6)
        index = i;
    }
    expect(index).toBeGreaterThanOrEqual(0);
    model.root.updateMatrixWorld(true);
    const world = new Vector3().fromBufferAttribute(position, index).applyMatrix4(M.matrixWorld);
    const inModel = world.clone().applyMatrix4(model.content.matrixWorld.clone().invert());
    expect(inModel.x).toBeCloseTo(0.1, 6);
    expect(inModel.z).toBeCloseTo(0, 6);
    // presentation: 180° about Y — a rotation (det +1), not a mirror
    expect(model.root.rotation.y).toBeCloseTo(Math.PI, 12);
    expect(model.root.matrixWorld.determinant()).toBeCloseTo(1, 12);
    expect(M.matrixWorld.determinant()).toBeGreaterThan(0);
    expect(world.x).toBeCloseTo(-0.1, 6);
    // the vertex at glTF (0,0,−0.1): −Z in the model, +Z after the presentation rotation
    let zIndex = -1;
    for (let i = 0; i < position.count; i++) {
      local.fromBufferAttribute(position, i);
      if (Math.abs(local.x) < 1e-6 && Math.abs(local.y) < 1e-6 && Math.abs(local.z + 0.1) < 1e-6)
        zIndex = i;
    }
    expect(zIndex).toBeGreaterThanOrEqual(0);
    const zWorld = new Vector3().fromBufferAttribute(position, zIndex).applyMatrix4(M.matrixWorld);
    const zModel = zWorld.clone().applyMatrix4(model.content.matrixWorld.clone().invert());
    expect(zModel.z).toBeCloseTo(-0.1, 6);
    expect(zWorld.z).toBeCloseTo(0.1, 6);
  });

  it("translucent nodes do not write depth and draw after opaque ones", async () => {
    const model = await load("asymmetric-2nodes.glb");
    const liver = model.nodes.get("vtkMRMLSegmentationNode1/Segment_1")!;
    const tumor = model.nodes.get("vtkMRMLModelNode2")!;
    expect(tumor.material).toMatchObject({ transparent: true, depthWrite: false, opacity: 0.35 });
    expect(tumor.M.renderOrder).toBe(TRANSLUCENT_RENDER_ORDER + 1); // manifest position 1
    expect(liver.material).toMatchObject({ transparent: false, depthWrite: true, opacity: 1 });
    expect(liver.M.renderOrder).toBe(0);
  });

  it("translucent nodes get distinct render orders that follow the manifest (stable blending, R-08)", async () => {
    const result = await parseSceneModel(withExtras(LIVER, (e) => (e["opacity"] = 0.5)));
    if (!result.ok) throw new Error(result.reason);
    const liver = result.model.nodes.get(LIVER)!;
    const tumor = result.model.nodes.get(TUMOR)!;
    expect([liver.order, tumor.order]).toEqual([0, 1]);
    expect(liver.M.renderOrder).toBe(TRANSLUCENT_RENDER_ORDER);
    expect(tumor.M.renderOrder).toBe(TRANSLUCENT_RENDER_ORDER + 1);
  });

  /** Both primitives without `material`: GLTFLoader gives them one shared default material. */
  const withDefaultMaterial = (edit: (j: Json) => void = () => undefined) =>
    withJson(glb("asymmetric-2nodes.glb"), (j) => {
      for (const m of j["meshes"] as Json[]) delete (m["primitives"] as Json[])[0]!["material"];
      delete j["materials"];
      edit(j);
    });

  it("the shared default material is cloned per node, so opacity stays per node", async () => {
    const result = await parseSceneModel(withDefaultMaterial());
    if (!result.ok) throw new Error(result.reason);
    const liver = result.model.nodes.get(LIVER)!;
    const tumor = result.model.nodes.get(TUMOR)!;
    expect(tumor.material).not.toBe(liver.material);
    expect(liver.material.opacity).toBe(1); // the tumour's 0.35 did not leak
    expect(tumor.material.opacity).toBe(0.35);
    const spies = [vi.spyOn(liver.material, "dispose"), vi.spyOn(tumor.material, "dispose")];
    result.model.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a clone does not inherit the first node's opacity (fallback path)", async () => {
    const bytes = withDefaultMaterial((j) => {
      const nodes = j["nodes"] as Json[];
      (nodes[1]!["extras"] as Json)["opacity"] = 0.5; // liver made translucent first …
      delete (nodes[3]!["extras"] as Json)["opacity"]; // … tumour falls back to its (default) material
    });
    const result = await parseSceneModel(bytes);
    if (!result.ok) throw new Error(result.reason);
    const tumor = result.model.nodes.get(TUMOR)!;
    expect(tumor.manifest.opacity).toBe(1);
    expect(tumor.material).toMatchObject({ transparent: false, depthWrite: true });
    expect(result.model.nodes.get(LIVER)!.material.opacity).toBe(0.5);
  });

  it("cloning a shared material does not copy its extras (no per-node deep copies)", async () => {
    const material = new MeshStandardMaterial();
    material.userData = { big: "x".repeat(1000) };
    const content = new Group();
    const root = new Object3D();
    root.userData = { nodeId: "root", kind: "root" };
    for (const nodeId of ["a", "b", "c"]) {
      const T = new Object3D();
      T.userData = { nodeId };
      T.add(new Mesh(new BufferGeometry(), material));
      root.add(T);
    }
    content.add(root);
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.resolve({ scene: content }),
    });
    if (!result.ok) throw new Error(result.reason);
    const [a, b, c] = [...result.model.nodes.values()].map((n) => n.material);
    expect(a).toBe(material);
    expect(material.userData).toEqual({ big: "x".repeat(1000) });
    expect(b!.userData).toEqual({});
    expect(c!.userData).toEqual({});
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("missing or malformed manifest values fall back to the material (§7.3, §7.4)", async () => {
    const result = await parseSceneModel(
      withExtras(TUMOR, (e) => {
        delete e["opacity"];
        delete e["visible"];
        e["color"] = [2, 0, 0];
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    const tumor = result.model.nodes.get(TUMOR)!;
    expect(tumor.manifest.opacity).toBeCloseTo(0.35, 6);
    expect(tumor.manifest.visible).toBe(true);
    expect(tumor.manifest.color.map((c) => Math.round(c * 100) / 100)).toEqual([0.95, 0.85, 0.7]);
    expect(tumor.manifest).toMatchObject({ triangleCount: 32, baked: false });
  });

  /** Edits the tumour's extras and removes its glTF `name` (GLTFLoader copies that into userData.name). */
  const tumorWith = (edit: (extras: Json) => void) =>
    withJson(glb("asymmetric-2nodes.glb"), (j) => {
      const node = (j["nodes"] as Json[])[3]!;
      delete node["name"];
      edit(node["extras"] as Json);
    });

  it.each<[string, (e: Json) => void]>([
    [
      "out of range or missing",
      (e) => {
        Object.assign(e, { opacity: -0.5, color: [0.1, 0.2], visible: 0 });
        delete e["kind"];
        delete e["name"];
      },
    ],
    [
      "of the wrong type",
      (e) => Object.assign(e, { opacity: "0.5", color: "red", visible: "yes", kind: 3, name: 7 }),
    ],
  ])(
    "manifest values %s fall back (opacity/colour → material, visible → true, kind → model, name → nodeId)",
    async (_label, edit) => {
      const result = await parseSceneModel(tumorWith(edit));
      if (!result.ok) throw new Error(result.reason);
      const { manifest: m, T } = result.model.nodes.get(TUMOR)!;
      expect(m).toMatchObject({
        opacity: expect.closeTo(0.35, 6) as number,
        visible: true,
        kind: "model",
        name: TUMOR,
      });
      expect(m.color.map((c) => Math.round(c * 100) / 100)).toEqual([0.95, 0.85, 0.7]);
      expect(T.visible).toBe(true);
    },
  );

  it("fallbacks taken from the material are type-checked too (GLTFLoader copies factors unchecked)", async () => {
    const material = new MeshStandardMaterial();
    (material as unknown as { opacity: unknown }).opacity = "0.5";
    (material.color as unknown as { r: unknown }).r = "red";
    const content = new Group();
    const root = new Object3D();
    root.userData = { nodeId: "root", kind: "root" };
    const T = new Object3D();
    T.userData = { nodeId: "a" }; // no opacity, no colour in extras
    T.add(new Mesh(new BufferGeometry(), material));
    root.add(T);
    content.add(root);
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.resolve({ scene: content }),
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.model.nodes.get("a")!.manifest).toMatchObject({ opacity: 1, color: [1, 1, 1] });
    expect(material.opacity).toBe(1);
  });

  it("root info: anonymizedNames only when exactly true; sceneVersion and profile type-checked (§7.1, §7.3)", async () => {
    const withRoot = (extras: Json) =>
      withJson(glb("asymmetric-2nodes.glb"), (j) =>
        Object.assign((j["nodes"] as Json[])[0]!["extras"] as Json, extras),
      );
    const anonymised = await parseSceneModel(
      withRoot({ anonymizedNames: true, sceneVersion: "1", profile: 5 }),
    );
    expect(anonymised.ok && anonymised.model.info).toEqual({
      sceneVersion: null,
      profile: null,
      anonymizedNames: true,
    });
    const truthy = await parseSceneModel(withRoot({ anonymizedNames: "yes" }));
    expect(truthy.ok && truthy.model.info.anonymizedNames).toBe(false);
  });

  it("nodeId is limited to 128 characters (§3.3)", async () => {
    expect(
      (await parseSceneModel(withExtras(TUMOR, (e) => (e["nodeId"] = "a".repeat(128))))).ok,
    ).toBe(true);
    expect(
      await parseSceneModel(withExtras(TUMOR, (e) => (e["nodeId"] = "a".repeat(129)))),
    ).toEqual({
      ok: false,
      reason: "structure",
    });
  });
});

describe("other valid fixtures", () => {
  it("quantized-1node.glb keeps the dequantisation matrix on M and the transform on T (§7.2)", async () => {
    const model = await load("quantized-1node.glb");
    const node = model.nodes.get("vtkMRMLModelNode3")!;
    expect(node.M.scale.x).toBeCloseTo(0.0000018311105685598315, 15);
    expect(node.T.position.toArray()).toEqual([0.05, -0.02, 0.01]);
    expect(node.T.children).toEqual([node.M]);
  });

  it("large-synthetic.glb: four nodes, the hidden one has T.visible = false", async () => {
    const model = await load("large-synthetic.glb");
    expect([...model.nodes.keys()]).toEqual(manifest.files["large-synthetic.glb"]!.nodeIds);
    const hidden = [...model.nodes.values()].filter((n) => !n.manifest.visible);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.T.visible).toBe(false);
    expect([...model.nodes.values()].some((n) => n.material.transparent)).toBe(true);
  });
});

describe("refused snapshots (§7.1, T10)", () => {
  it.each([
    ["bad-magic.glb", "container"],
    ["truncated.glb", "container"],
    ["external-uri.glb", "buffers"],
    ["two-scenes.glb", "scene"],
    ["no-root-extras.glb", "root"],
  ])("%s is refused before GLTFLoader runs (%s)", async (name, reason) => {
    expect(manifest.files[name]!.valid).toBe(false);
    const parse = vi.fn<ParseGlb>();
    const result = await parseSceneModel(glb(name), { parse });
    expect(result).toEqual({ ok: false, reason });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each<[string, Uint8Array, string]>([
    [
      "textures as an object",
      withJson(glb("asymmetric-2nodes.glb"), (j) => (j["textures"] = { 0: {} })),
      "forbidden",
    ],
    ["default scene 1", withJson(glb("asymmetric-2nodes.glb"), (j) => (j["scene"] = 1)), "scene"],
  ])("%s is refused before GLTFLoader runs", async (_label, bytes, reason) => {
    const parse = vi.fn<ParseGlb>();
    expect(await parseSceneModel(bytes, { parse })).toEqual({ ok: false, reason });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    ["a duplicate nodeId", (e: Json) => (e["nodeId"] = LIVER)],
    ["an invalid nodeId", (e: Json) => (e["nodeId"] = "has spaces")],
    ["no nodeId", (e: Json) => delete e["nodeId"]],
  ])("a T node with %s is refused as structure", async (_label, edit) => {
    expect(await parseSceneModel(withExtras(TUMOR, edit))).toEqual({
      ok: false,
      reason: "structure",
    });
  });

  it("a mesh node M with children is refused as structure", async () => {
    const bytes = withJson(glb("asymmetric-2nodes.glb"), (j) => {
      const nodes = j["nodes"] as Json[];
      nodes.push({ name: "extra" });
      nodes[4]!["children"] = [nodes.length - 1];
    });
    expect(await parseSceneModel(bytes)).toEqual({ ok: false, reason: "structure" });
  });

  it("an exception while mapping nodes is refused as structure and the parsed scene is disposed", async () => {
    const geometry = new BufferGeometry();
    const material = new MeshStandardMaterial();
    const spies = [vi.spyOn(geometry, "dispose"), vi.spyOn(material, "dispose")];
    const content = new Group();
    const root = new Object3D();
    root.userData = { nodeId: "root", kind: "root" };
    const T = new Object3D();
    (T as { userData: unknown }).userData = null; // reading T.extras throws
    T.add(new Mesh(geometry, material));
    root.add(T);
    content.add(root);
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.resolve({ scene: content }),
    });
    expect(result).toEqual({ ok: false, reason: "structure" });
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("an empty Slicer scene parses to a model with no nodes", async () => {
    for (const bytes of [
      buildGlb(emptySceneJson(), new Uint8Array(0)),
      buildGlb(emptySceneJson()),
    ]) {
      const result = await parseSceneModel(bytes);
      expect(result.ok && result.model.nodes.size).toBe(0);
      expect(result.ok && result.model.info.sceneVersion).toBe(3);
    }
  });

  it("an empty-scene file with bufferView-less accessors never reaches the parser", async () => {
    const bomb = emptySceneJson();
    (bomb["nodes"] as Json[])[0]!["children"] = [1];
    (bomb["nodes"] as Json[]).push(
      { extras: { nodeId: "vtkMRMLModelNode1" }, children: [2] },
      { mesh: 0 },
    );
    bomb["meshes"] = [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }];
    bomb["accessors"] = [0, 1].map(() => ({
      componentType: 5126,
      type: "VEC3",
      count: 50_000_000,
    }));
    delete bomb["buffers"];
    const parse = vi.fn<ParseGlb>();
    expect(await parseSceneModel(buildGlb(bomb), { parse })).toEqual({
      ok: false,
      reason: "accessors",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("a parser result without a scene is refused instead of throwing", async () => {
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.resolve({} as { scene: Object3D }),
    });
    expect(result).toEqual({ ok: false, reason: "parse" });
  });

  it("parses a GLB handed as a view at an offset into a larger buffer", async () => {
    const bytes = glb("asymmetric-2nodes.glb");
    const padded = new Uint8Array(bytes.byteLength + 16);
    padded.set(bytes, 8);
    const result = await parseSceneModel(padded.subarray(8, 8 + bytes.byteLength));
    expect(result.ok).toBe(true);
  });

  it("a parser error becomes snapshotInvalid instead of throwing", async () => {
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.reject(new Error("boom")),
    });
    expect(result).toEqual({ ok: false, reason: "parse" });
  });

  it("a scene without the T → one mesh M structure is refused and its resources disposed", async () => {
    const geometry = new BufferGeometry();
    const material = new MeshStandardMaterial();
    const disposeG = vi.spyOn(geometry, "dispose");
    const disposeM = vi.spyOn(material, "dispose");
    const content = new Group();
    const root = new Object3D();
    root.userData = { nodeId: "root", kind: "root" };
    const T = new Object3D();
    T.userData = { nodeId: "vtkMRMLModelNode1", name: "x" };
    T.add(new Mesh(geometry, material), new Mesh(geometry, material)); // two meshes: not §7.2
    root.add(T);
    content.add(root);
    const result = await parseSceneModel(glb("asymmetric-2nodes.glb"), {
      parse: () => Promise.resolve({ scene: content }),
    });
    expect(result).toEqual({ ok: false, reason: "structure" });
    expect(disposeG).toHaveBeenCalledTimes(1);
    expect(disposeM).toHaveBeenCalledTimes(1);
  });
});

describe("scene model store and disposal (FR-45)", () => {
  it("loading a second GLB disposes every geometry and material of the first exactly once", async () => {
    const first = spyingParse();
    const store = createSceneModelStore({ parse: first.parse, log: vi.fn() });
    const a = await store.load(glb("asymmetric-2nodes.glb"));
    expect(a.ok).toBe(true);
    const modelA = store.current!;
    const spiesA = first.spies.slice(); // the same parser also wraps model B's resources
    const scene = new Group();
    scene.add(modelA.root);
    expect(spiesA.length).toBeGreaterThanOrEqual(4); // 2 geometries + 2 materials
    for (const spy of spiesA) expect(spy).not.toHaveBeenCalled();

    const b = await store.load(glb("quantized-1node.glb"));
    expect(b.ok).toBe(true);
    for (const spy of spiesA) expect(spy).toHaveBeenCalledTimes(1);
    expect(modelA.root.parent).toBeNull();
    expect(store.current).not.toBe(modelA);
    modelA.dispose(); // idempotent
    for (const spy of spiesA) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of first.spies.slice(spiesA.length)) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps no reference to the raw GLB buffer after parsing (garbage-collected while the model lives)", async () => {
    // `--expose-gc` at runtime: V8 creates `gc` in contexts made after the flag is set. A FinalizationRegistry, not a
    // WeakRef: Node keeps WeakRef targets alive across tasks here, which would make this test always fail.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const freed = new Set<string>();
    const registry = new FinalizationRegistry<string>((label) => freed.add(label));
    // Also watch the buffer the parser actually receives (a copy, if the input were a view at an offset).
    const store = createSceneModelStore({
      log: vi.fn(),
      parse: (buffer) => {
        registry.register(buffer, "parsed");
        return new GLTFLoader().parseAsync(buffer, "");
      },
    });
    const control = glb("asymmetric-2nodes.glb"); // deliberately kept: proves the check can fail
    registry.register(control.buffer, "control");
    await (async () => {
      const bytes = glb("asymmetric-2nodes.glb"); // only this scope holds the bytes
      registry.register(bytes.buffer, "raw");
      expect((await store.load(bytes)).ok).toBe(true);
    })();
    for (let i = 0; i < 20 && !(freed.has("raw") && freed.has("parsed")); i++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(store.current).not.toBeNull(); // the model is alive …
    expect(freed.has("raw")).toBe(true); // … but the GLB bytes were collected
    expect(freed.has("parsed")).toBe(true);
    expect(freed.has("control")).toBe(false);
    expect(control.byteLength).toBeGreaterThan(0);
  });

  it("the parsed geometry does not alias the input buffer", async () => {
    const bytes = glb("asymmetric-2nodes.glb");
    const raw = bytes.buffer;
    const store = createSceneModelStore({ log: vi.fn() });
    await store.load(bytes);
    const buffers = new Set<ArrayBufferLike>();
    store.current!.root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = o.geometry as BufferGeometry;
      for (const attr of Object.values(g.attributes)) buffers.add(attr.array.buffer);
      if (g.index) buffers.add(g.index.array.buffer);
    });
    expect(buffers.size).toBeGreaterThan(0);
    expect(buffers.has(raw)).toBe(false);
  });

  it("a refused snapshot keeps the previous model", async () => {
    const log = vi.fn();
    const store = createSceneModelStore({ log });
    await store.load(glb("asymmetric-2nodes.glb"));
    const previous = store.current;
    const result = await store.load(glb("external-uri.glb"));
    expect(result).toEqual({ ok: false, reason: "buffers" });
    expect(store.current).toBe(previous);
    expect(log).toHaveBeenCalledWith("snapshot refused", { reason: "buffers" });
  });

  it("only the latest of two overlapping loads wins; the other model is disposed", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const firstSpies = spyingParse();
    let calls = 0;
    const parse: ParseGlb = async (buffer) => {
      calls++;
      if (calls === 1) {
        await gate;
        return firstSpies.parse(buffer);
      }
      return new GLTFLoader().parseAsync(buffer, "");
    };
    const store = createSceneModelStore({ parse, log: vi.fn() });
    const slow = store.load(glb("asymmetric-2nodes.glb"));
    const fast = await store.load(glb("quantized-1node.glb"));
    releaseFirst();
    expect(await slow).toEqual({ ok: false, reason: "superseded" });
    expect(fast.ok && store.current === fast.model).toBe(true);
    for (const spy of firstSpies.spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("an older load that fails after a newer one started reports superseded, not a refusal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const log = vi.fn();
    const parse: ParseGlb = async (buffer) => {
      if (++calls === 1) {
        await gate;
        throw new Error("broken");
      }
      return new GLTFLoader().parseAsync(buffer, "");
    };
    const store = createSceneModelStore({ parse, log });
    const slow = store.load(glb("asymmetric-2nodes.glb"));
    await store.load(glb("quantized-1node.glb"));
    release();
    expect(await slow).toEqual({ ok: false, reason: "superseded" });
    expect(log).not.toHaveBeenCalled();
  });

  it("clear() during a load keeps the result from being installed and disposes it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spying = spyingParse();
    const store = createSceneModelStore({
      parse: async (buffer) => {
        await gate;
        return spying.parse(buffer);
      },
      log: vi.fn(),
    });
    const loading = store.load(glb("asymmetric-2nodes.glb"));
    store.clear();
    release();
    expect(await loading).toEqual({ ok: false, reason: "superseded" });
    expect(store.current).toBeNull();
    expect(spying.spies.length).toBeGreaterThan(0);
    for (const spy of spying.spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("onChange reports each new current model and the clear, not refusals; a throwing handler is isolated", async () => {
    const log = vi.fn();
    const store = createSceneModelStore({ log });
    const seen: (SceneModel | null)[] = [];
    store.onChange(() => {
      throw new Error("ui bug");
    });
    const off = store.onChange((m) => seen.push(m));
    store.clear(); // nothing loaded: no event
    await store.load(glb("asymmetric-2nodes.glb"));
    await store.load(glb("external-uri.glb")); // refused
    const first = store.current;
    await store.load(glb("quantized-1node.glb"));
    store.clear();
    expect(seen).toEqual([first, expect.anything(), null]);
    expect(seen[1]).not.toBe(first);
    expect(log).toHaveBeenCalledWith("scene model handler failed");
    off();
    await store.load(glb("asymmetric-2nodes.glb"));
    expect(seen).toHaveLength(3);
  });

  it("clear() disposes the current model", async () => {
    const { parse, spies } = spyingParse();
    const store = createSceneModelStore({ parse, log: vi.fn() });
    await store.load(glb("asymmetric-2nodes.glb"));
    store.clear();
    expect(store.current).toBeNull();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("applyOpacity", () => {
  it("switches blending state and render order with the opacity", () => {
    const material = new MeshStandardMaterial();
    const mesh = new Mesh(new BufferGeometry(), material);
    const node = { M: mesh, material, order: 0 };
    const version = material.version;
    applyOpacity(node, 0.4);
    expect(material).toMatchObject({ opacity: 0.4, transparent: true, depthWrite: false });
    expect(mesh.renderOrder).toBe(TRANSLUCENT_RENDER_ORDER);
    expect(material.version).toBeGreaterThan(version); // needsUpdate
    applyOpacity(node, 1);
    expect(material).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    expect(mesh.renderOrder).toBe(0);
    applyOpacity({ ...node, order: 7 }, 0.2);
    expect(mesh.renderOrder).toBe(TRANSLUCENT_RENDER_ORDER + 7);
  });
});
