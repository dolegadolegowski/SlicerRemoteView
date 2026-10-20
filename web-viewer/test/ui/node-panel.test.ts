import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Color, SRGBColorSpace } from "three";
import { t } from "../../src/i18n/strings";
import { parseSceneModel } from "../../src/render/scene-model";
import type { SceneModel } from "../../src/render/scene-model";
import { createNodePanel, swatchColor } from "../../src/ui/node-panel";
import type { NodePanel } from "../../src/ui/node-panel";
import { glb, manifest, withJson } from "../render/glb-fixtures";
import type { Json } from "../render/glb-fixtures";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";

async function load(bytes: Uint8Array): Promise<SceneModel> {
  const result = await parseSceneModel(bytes);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.model;
}

/** asymmetric-2nodes.glb as a publisher with "anonymise names" sends it (§7.3). */
const anonymised = () =>
  withJson(glb("asymmetric-2nodes.glb"), (j) => {
    const nodes = j["nodes"] as Json[];
    (nodes[0]!["extras"] as Json)["anonymizedNames"] = true;
    const names = ["Segment 7", "Model 3"];
    for (const node of nodes) {
      const extras = node["extras"] as Json | undefined;
      if (extras && extras["kind"] !== "root") extras["name"] = names.shift();
    }
  });

let model: SceneModel;
let panel: NodePanel;
let onChange: ReturnType<typeof vi.fn<() => void>>;

beforeAll(async () => {
  model = await load(glb("asymmetric-2nodes.glb"));
});

function setup(m: SceneModel | null = model): void {
  onChange = vi.fn<() => void>();
  panel = createNodePanel({ lang: "en", onChange });
  document.body.replaceChildren(panel.element);
  panel.setModel(m);
  panel.setOpen(true);
}

const rows = () => [...panel.element.querySelectorAll<HTMLButtonElement>(".node-panel__row")];
const row = (nodeId: string) => rows().find((r) => r.dataset["nodeId"] === nodeId)!;
const toggle = () => panel.element.querySelector<HTMLButtonElement>(".node-panel__toggle")!;
const showAll = () => panel.element.querySelector<HTMLButtonElement>(".node-panel__show-all")!;
const body = () => panel.element.querySelector<HTMLElement>(".node-panel__body")!;

afterEach(() => {
  for (const node of model.nodes.values()) node.T.visible = true; // the fixture shows both
  document.body.replaceChildren();
});

describe("rows (§7.3)", () => {
  it("one switch per node in manifest order, with the fixture names and colours", () => {
    setup();
    expect(rows().map((r) => r.dataset["nodeId"])).toEqual(
      manifest.files["asymmetric-2nodes.glb"]!.nodeIds,
    );
    expect(rows().map((r) => r.textContent)).toEqual(["Liver", "Tumor"]);
    const swatches = rows().map(
      (r) => r.querySelector<HTMLElement>(".node-panel__swatch")!.style.backgroundColor,
    );
    // linear [0.8, 0.33, 0.27] and [0.95, 0.85, 0.7] in sRGB (IEC 61966-2-1 transfer function)
    expect(swatches).toEqual(["rgb(231, 155, 142)", "rgb(249, 237, 218)"]);
    expect(toggle().textContent).toBe(t("en", "nodePanel.toggle", { count: 2 }));
  });

  it("each row is a switch named by the structure; checked = shown", () => {
    setup();
    for (const r of rows()) {
      expect(r.getAttribute("role")).toBe("switch");
      expect(r.getAttribute("aria-checked")).toBe("true");
      expect(r.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("with anonymised names, the names are shown exactly as the GLB carries them", async () => {
    const anon = await load(anonymised());
    expect(anon.info.anonymizedNames).toBe(true);
    setup(anon);
    expect(rows().map((r) => r.textContent)).toEqual(["Segment 7", "Model 3"]);
    anon.dispose();
  });

  it("a name keeps its own writing direction (right-to-left names are cut at their end)", () => {
    setup();
    for (const r of rows())
      expect(r.querySelector<HTMLElement>(".node-panel__name")!.dir).toBe("auto");
  });

  it("a name is text, never markup", async () => {
    const hostile = await load(
      withJson(glb("asymmetric-2nodes.glb"), (j) => {
        const tumor = (j["nodes"] as Json[]).find(
          (n) => (n["extras"] as Json | undefined)?.["nodeId"] === TUMOR,
        )!;
        (tumor["extras"] as Json)["name"] = '<img src=x onerror="alert(1)">';
      }),
    );
    setup(hostile);
    expect(panel.element.querySelector("img")).toBeNull();
    expect(rows()[1]!.textContent).toBe('<img src=x onerror="alert(1)">');
    hostile.dispose();
  });

  it("an empty name gets a numbered placeholder", async () => {
    const blank = await load(
      withJson(glb("asymmetric-2nodes.glb"), (j) => {
        const liver = (j["nodes"] as Json[]).find(
          (n) => (n["extras"] as Json | undefined)?.["nodeId"] === LIVER,
        )!;
        (liver["extras"] as Json)["name"] = "  ";
      }),
    );
    setup(blank);
    expect(rows()[0]!.textContent).toBe(t("en", "nodePanel.unnamed", { n: 1 }));
    blank.dispose();
  });

  it("a node hidden in the snapshot starts unchecked", async () => {
    const hidden = await load(
      withJson(glb("asymmetric-2nodes.glb"), (j) => {
        const tumor = (j["nodes"] as Json[]).find(
          (n) => (n["extras"] as Json | undefined)?.["nodeId"] === TUMOR,
        )!;
        (tumor["extras"] as Json)["visible"] = false;
      }),
    );
    setup(hidden);
    expect(row(TUMOR).getAttribute("aria-checked")).toBe("false");
    expect(showAll().getAttribute("aria-disabled")).toBe("false");
    hidden.dispose();
  });

  it("no model: an empty list with a short explanation and no 'show all'", () => {
    setup(null);
    expect(rows()).toHaveLength(0);
    expect(panel.element.querySelector<HTMLElement>(".node-panel__empty")!.hidden).toBe(false);
    expect(showAll().hidden).toBe(true);
  });

  it("a rebuild keeps keyboard focus on the same structure, or moves it to the toggle", async () => {
    setup();
    row(TUMOR).focus();
    panel.setModel(model); // e.g. a new snapshot of the same scene
    expect(document.activeElement).toBe(row(TUMOR));
    expect(document.activeElement!.isConnected).toBe(true);
    const quantized = await load(glb("quantized-1node.glb"));
    panel.setModel(quantized); // the focused structure is gone
    expect(document.activeElement).toBe(toggle());
    quantized.dispose();
  });

  it("a new model replaces the rows; the panel stays open", async () => {
    setup();
    const quantized = await load(glb("quantized-1node.glb"));
    panel.setModel(quantized);
    expect(rows().map((r) => r.dataset["nodeId"])).toEqual(["vtkMRMLModelNode3"]);
    expect(panel.open).toBe(true);
    quantized.dispose();
  });
});

describe("local visibility (FR-40, US-09)", () => {
  it("tapping a row hides its T node and asks for one frame; tapping again shows it", () => {
    setup();
    const tumor = model.nodes.get(TUMOR)!;
    row(TUMOR).click();
    expect(tumor.T.visible).toBe(false);
    expect(tumor.M.visible).toBe(true); // M carries the dequantisation; only T is toggled (§7.2)
    expect(row(TUMOR).getAttribute("aria-checked")).toBe("false");
    expect(model.nodes.get(LIVER)!.T.visible).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    row(TUMOR).click();
    expect(tumor.T.visible).toBe(true);
    expect(row(TUMOR).getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("a tap on the swatch, the name or the eye counts as a tap on the row", () => {
    setup();
    for (const part of [".node-panel__swatch", ".node-panel__name", ".node-panel__eye"]) {
      const before = model.nodes.get(LIVER)!.T.visible;
      row(LIVER)
        .querySelector(part)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(model.nodes.get(LIVER)!.T.visible).toBe(!before);
    }
  });

  it("'show all' shows every node and is unavailable while nothing is hidden", () => {
    setup();
    expect(showAll().getAttribute("aria-disabled")).toBe("true");
    showAll().click();
    expect(onChange).not.toHaveBeenCalled(); // nothing to show: no frame
    row(LIVER).click();
    row(TUMOR).click();
    expect(showAll().getAttribute("aria-disabled")).toBe("false");
    onChange.mockClear();
    showAll().click();
    expect([...model.nodes.values()].every((n) => n.T.visible)).toBe(true);
    expect(rows().every((r) => r.getAttribute("aria-checked") === "true")).toBe(true);
    expect(showAll().getAttribute("aria-disabled")).toBe("true");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keyboard focus stays on 'show all' after using it (it is never `disabled`)", () => {
    setup();
    row(LIVER).click();
    showAll().focus();
    showAll().click();
    expect(showAll().disabled).toBe(false);
    expect(document.activeElement).toBe(showAll());
  });

  it("refresh() shows changes made elsewhere (presenter updates, WEB-12)", () => {
    setup();
    model.nodes.get(LIVER)!.T.visible = false;
    expect(row(LIVER).getAttribute("aria-checked")).toBe("true");
    panel.refresh();
    expect(row(LIVER).getAttribute("aria-checked")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("collapsible", () => {
  it("starts closed; the toggle opens and closes the list and reports it", () => {
    onChange = vi.fn<() => void>();
    panel = createNodePanel({ lang: "en", onChange });
    document.body.replaceChildren(panel.element);
    panel.setModel(model);
    expect(panel.open).toBe(false);
    expect(body().hidden).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe(body().id);
    toggle().click();
    expect(panel.open).toBe(true);
    expect(body().hidden).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    toggle().click();
    expect(body().hidden).toBe(true);
  });

  it("two panels have distinct list ids", () => {
    const a = createNodePanel({ lang: "en" });
    const b = createNodePanel({ lang: "en" });
    expect(a.element.querySelector(".node-panel__body")!.id).not.toBe(
      b.element.querySelector(".node-panel__body")!.id,
    );
  });

  it("dispose removes the element and its listeners", () => {
    setup();
    const listeners = [".node-panel__list", ".node-panel__show-all", ".node-panel__toggle"].map(
      (selector) => vi.spyOn(panel.element.querySelector(selector)!, "removeEventListener"),
    );
    const r = row(TUMOR);
    panel.dispose();
    expect(panel.element.isConnected).toBe(false);
    for (const spy of listeners) expect(spy).toHaveBeenCalledWith("click", expect.any(Function));
    toggle().click();
    expect(panel.open).toBe(true); // the toggle no longer reacts
    r.click();
    expect(model.nodes.get(TUMOR)!.T.visible).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("swatchColor", () => {
  it("converts the linear manifest colour to the sRGB CSS colour the renderer outputs", () => {
    expect(swatchColor([1, 1, 1])).toBe("rgb(255,255,255)");
    expect(swatchColor([0, 0, 0])).toBe("rgb(0,0,0)");
    // linear 0.214 ≈ sRGB 0.5
    const mid = new Color().setRGB(0.5, 0.5, 0.5, SRGBColorSpace).getStyle();
    expect(swatchColor([0.214041, 0.214041, 0.214041])).toBe(mid);
  });
});
