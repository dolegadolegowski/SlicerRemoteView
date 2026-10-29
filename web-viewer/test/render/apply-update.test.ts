import { describe, expect, it, vi } from "vitest";
import { Color, Matrix4, Mesh, SRGBColorSpace } from "three";
import type { BufferGeometry, Material } from "three";
import { createLiveScene } from "../../src/render/apply-update";
import { applyOpacity, parseSceneModel } from "../../src/render/scene-model";
import type { SceneModel } from "../../src/render/scene-model";
import { glb, withJson } from "./glb-fixtures";
import type { Json } from "./glb-fixtures";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
const QUANTIZED = "vtkMRMLModelNode3";

async function parsed(bytes: Uint8Array): Promise<SceneModel> {
  const result = await parseSceneModel(bytes);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

const load = (name = "asymmetric-2nodes.glb") => parsed(glb(name));

/** asymmetric-2nodes.glb exported again, with `edit` applied to the manifest entries (`T.extras`) of its nodes. */
const reexport = (edit: (extras: { liver: Json; tumor: Json }) => void = () => undefined) =>
  parsed(
    withJson(glb("asymmetric-2nodes.glb"), (json) => {
      const nodes = json["nodes"] as { extras: Json }[];
      edit({ liver: nodes[1]!.extras, tumor: nodes[3]!.extras });
    }),
  );

const translation = (x: number, y: number, z: number) => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

describe("scene.update changes (§8.1)", () => {
  it("visible toggles T only, and reports that something changed", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    expect(live.apply([{ nodeId: LIVER, visible: false }])).toEqual({
      changed: true,
      removed: false,
      overridden: [],
    });
    expect(liver.T.visible).toBe(false);
    expect(liver.M.visible).toBe(true);
  });

  it("color and opacity go to the node's own material (linear, like baseColorFactor)", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const tumor = model.nodes.get(TUMOR)!;
    const liver = model.nodes.get(LIVER)!;
    const liverColor = (liver.material as unknown as { color: Color }).color.clone();
    live.apply([{ nodeId: TUMOR, color: [0.5, 0.5, 0.5], opacity: 1 }]);
    const color = (tumor.material as unknown as { color: Color }).color;
    expect(color.r).toBeCloseTo(0.5, 6); // linear working space
    expect(color.getStyle(SRGBColorSpace)).toBe(new Color().setRGB(0.5, 0.5, 0.5).getStyle());
    expect(tumor.material.transparent).toBe(false); // opacity 1: opaque again (applyOpacity)
    expect(tumor.material.depthWrite).toBe(true);
    expect((liver.material as unknown as { color: Color }).color.equals(liverColor)).toBe(true);
  });

  it("matrix replaces T.matrix and leaves M's dequantisation matrix alone (§7.2)", async () => {
    const model = await load("quantized-1node.glb");
    const live = createLiveScene(model);
    const node = model.nodes.get(QUANTIZED)!;
    const dequantisation = node.M.matrix.clone();
    expect(dequantisation.equals(new Matrix4())).toBe(false); // the fixture really has one
    const m = translation(0.012, -0.004, 0.03);
    live.apply([{ nodeId: QUANTIZED, matrix: m }]);
    model.root.updateMatrixWorld(true);
    expect(node.T.matrix.toArray()).toEqual(m);
    expect(node.M.matrix.equals(dequantisation)).toBe(true);
    const expected = model.content.matrixWorld
      .clone()
      .multiply(new Matrix4().fromArray(m))
      .multiply(dequantisation);
    node.M.matrixWorld.toArray().forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i]!, 9));
  });

  it("unknown node ids and invalid items are skipped; the valid ones still apply", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const result = live.apply([
      { nodeId: "vtkMRMLModelNode99", visible: false },
      { nodeId: LIVER, color: [2, 0, 0] },
      "nonsense",
      { nodeId: TUMOR, visible: false },
    ]);
    expect(result.changed).toBe(true);
    expect(model.nodes.get(TUMOR)!.T.visible).toBe(false);
    expect(model.nodes.get(LIVER)!.T.visible).toBe(true);
  });

  it("nothing new changes nothing", async () => {
    const model = await load();
    const live = createLiveScene(model);
    expect(
      live.apply([{ nodeId: LIVER, visible: true, color: [0.8, 0.33, 0.27], opacity: 1 }]).changed,
    ).toBe(false);
  });
});

describe("presenter vs local choice (FR-40, US-09)", () => {
  it("a replayed state with the same presenter value keeps what the user hid locally", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    liver.T.visible = false; // hidden in the node panel
    expect(live.apply([{ nodeId: LIVER, visible: true }])).toMatchObject({
      changed: false,
      overridden: [],
    });
    expect(liver.T.visible).toBe(false);
  });

  it("a presenter change of visible ends the local choice and names the node; later ones apply plainly", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    liver.T.visible = false; // the user hid it; the presenter still shows it
    expect(live.apply([{ nodeId: LIVER, visible: false }]).overridden).toEqual([LIVER]); // presenter hides
    expect(liver.T.visible).toBe(false);
    const shown = live.apply([{ nodeId: LIVER, visible: true }]); // presenter shows: no local choice any more
    expect(shown).toMatchObject({ changed: true, overridden: [] });
    expect(liver.T.visible).toBe(true);
  });

  it("a presenter opacity change replaces a local slider value and names the node (WEB-13)", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    applyOpacity(liver, 0.4); // the user's slider
    expect(live.apply([{ nodeId: LIVER, opacity: 1 }]).changed).toBe(false); // the presenter's value: unchanged
    expect(liver.material.opacity).toBe(0.4);
    const result = live.apply([{ nodeId: LIVER, opacity: 0.6 }]);
    expect(result.overridden).toEqual([LIVER]);
    expect(liver.material.opacity).toBe(0.6);
  });

  it("a presenter colour change keeps a local hide and stores the colour (US-02)", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    liver.T.visible = false;
    const result = live.apply([{ nodeId: LIVER, color: [0.1, 0.2, 0.3] }]);
    expect(result.overridden).toEqual([]);
    expect(liver.T.visible).toBe(false);
    expect((liver.material as unknown as { color: Color }).color.r).toBeCloseTo(0.1, 6);
  });

  it("a node changed in two ways at once is named once", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const liver = model.nodes.get(LIVER)!;
    liver.T.visible = false;
    applyOpacity(liver, 0.4);
    expect(live.apply([{ nodeId: LIVER, visible: false, opacity: 0.5 }]).overridden).toEqual([
      LIVER,
    ]);
  });

  it("without a local choice a presenter change reports no override", async () => {
    const model = await load();
    const live = createLiveScene(model);
    expect(live.apply([{ nodeId: LIVER, visible: false }]).overridden).toEqual([]);
    expect(live.apply([{ nodeId: TUMOR, opacity: 0.5 }]).overridden).toEqual([]);
    expect(live.apply([{ nodeId: TUMOR, opacity: 0.8, visible: false }]).overridden).toEqual([]);
  });
});

describe("removal (§8.2)", () => {
  it("removes T from the scene, disposes its geometry and material once, forgets the node", async () => {
    const model = await load();
    const live = createLiveScene(model);
    const tumor = model.nodes.get(TUMOR)!;
    const geometry = vi.spyOn(tumor.M.geometry as BufferGeometry, "dispose");
    const material = vi.spyOn(tumor.material as Material, "dispose");
    expect(live.remove([TUMOR, "vtkMRMLModelNode99", 5])).toEqual({
      changed: true,
      removed: true,
      overridden: [],
    });
    expect(model.nodes.has(TUMOR)).toBe(false);
    expect(tumor.T.parent).toBeNull();
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(live.apply([{ nodeId: TUMOR, visible: false }]).changed).toBe(false); // gone
    model.dispose();
    expect(geometry).toHaveBeenCalledTimes(1); // not disposed twice
    let meshes = 0;
    model.content.traverse((o) => void (o instanceof Mesh && meshes++));
    expect(meshes).toBe(1);
  });

  it("removing nothing known reports nothing", async () => {
    const model = await load();
    expect(createLiveScene(model).remove(["vtkMRMLModelNode99"])).toEqual({
      changed: false,
      removed: false,
      overridden: [],
    });
  });
});

describe("a new snapshot of the scene (WEB-25)", () => {
  it("keeps a local hide and a local opacity that the snapshot did not change", async () => {
    const before = await load();
    const live = createLiveScene(before);
    before.nodes.get(LIVER)!.T.visible = false; // the node panel's switch
    applyOpacity(before.nodes.get(TUMOR)!, 1); // its slider at 100 % (the presenter's value is 0.35)
    before.dispose(); // the store disposes the old model before anyone hears of the new one
    const next = await reexport();
    expect(live.carryTo(next)).toEqual({ changed: true, removed: false, overridden: [] });
    expect(next.nodes.get(LIVER)!.T.visible).toBe(false);
    const tumor = next.nodes.get(TUMOR)!;
    expect(tumor.material.opacity).toBe(1);
    expect(tumor.material.transparent).toBe(false); // opaque again: applyOpacity
    expect(tumor.material.depthWrite).toBe(true);
    // The new scene's presenter values are the snapshot's: a presenter change still ends the choice carried over.
    expect(createLiveScene(next).apply([{ nodeId: LIVER, visible: false }]).overridden).toEqual([
      LIVER,
    ]);
  });

  it("a property the snapshot changed takes its value and names the node; the others' choices stay (FR-40)", async () => {
    const before = await load();
    const live = createLiveScene(before);
    before.nodes.get(LIVER)!.T.visible = false;
    applyOpacity(before.nodes.get(TUMOR)!, 0.8);
    const next = await reexport(({ tumor }) => (tumor["opacity"] = 0.6)); // changed in Slicer
    expect(live.carryTo(next)).toEqual({ changed: true, removed: false, overridden: [TUMOR] });
    expect(next.nodes.get(TUMOR)!.material.opacity).toBe(0.6);
    expect(next.nodes.get(LIVER)!.T.visible).toBe(false);
  });

  it("a hide the presenter made too names the node; its other local value stays", async () => {
    const before = await load();
    const live = createLiveScene(before);
    const liver = before.nodes.get(LIVER)!;
    liver.T.visible = false;
    applyOpacity(liver, 0.5);
    const next = await reexport(({ liver }) => (liver["visible"] = false)); // hidden in Slicer as well
    expect(live.carryTo(next)).toEqual({ changed: true, removed: false, overridden: [LIVER] });
    expect(next.nodes.get(LIVER)!.T.visible).toBe(false);
    expect(next.nodes.get(LIVER)!.material.opacity).toBe(0.5);
  });

  it("the presenter's last value includes the live updates since the snapshot", async () => {
    const before = await load();
    const live = createLiveScene(before);
    live.apply([{ nodeId: TUMOR, opacity: 0.5 }]); // the presenter, live
    applyOpacity(before.nodes.get(TUMOR)!, 0.9); // then the user
    const next = await reexport(({ tumor }) => (tumor["opacity"] = 0.5)); // the snapshot says 0.5 too
    expect(live.carryTo(next)).toEqual({ changed: true, removed: false, overridden: [] });
    expect(next.nodes.get(TUMOR)!.material.opacity).toBe(0.9);
  });

  it("another name under the same id, or no node in common, carries nothing", async () => {
    const before = await load();
    const live = createLiveScene(before);
    before.nodes.get(LIVER)!.T.visible = false;
    const renamed = await reexport(({ liver }) => (liver["name"] = "Liver (left lobe)"));
    expect(live.carryTo(renamed)).toEqual({ changed: false, removed: false, overridden: [] });
    expect(renamed.nodes.get(LIVER)!.T.visible).toBe(true);
    const other = await load("quantized-1node.glb");
    expect(live.carryTo(other)).toEqual({ changed: false, removed: false, overridden: [] });
  });

  it("under hidden names, numbered in export order (§7.3), the id alone decides", async () => {
    const SEGMENT_2 = "vtkMRMLSegmentationNode1/s_2";
    const anonymized = glb("anonymized-segments.glb");
    const before = await parsed(anonymized);
    const live = createLiveScene(before);
    before.nodes.get(SEGMENT_2)!.T.visible = false;
    // The segments were reordered in Slicer: their substitute names swap.
    const reordered = await parsed(
      withJson(anonymized, (json) => {
        const nodes = json["nodes"] as { extras: Json }[];
        nodes[1]!.extras["name"] = "Segment 2";
        nodes[3]!.extras["name"] = "Segment 1";
      }),
    );
    expect(live.carryTo(reordered).changed).toBe(true);
    expect(reordered.nodes.get(SEGMENT_2)!.T.visible).toBe(false);
  });
});
