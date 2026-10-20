import { describe, expect, it, vi } from "vitest";
import { Color, Matrix4, Mesh, SRGBColorSpace } from "three";
import type { BufferGeometry, Material } from "three";
import { createLiveScene } from "../../src/render/apply-update";
import { parseSceneModel } from "../../src/render/scene-model";
import type { SceneModel } from "../../src/render/scene-model";
import { glb } from "./glb-fixtures";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
const QUANTIZED = "vtkMRMLModelNode3";

async function load(name = "asymmetric-2nodes.glb"): Promise<SceneModel> {
  const result = await parseSceneModel(glb(name));
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

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

  it("without a local choice a presenter change reports no override", async () => {
    const model = await load();
    const live = createLiveScene(model);
    expect(live.apply([{ nodeId: LIVER, visible: false }]).overridden).toEqual([]);
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
