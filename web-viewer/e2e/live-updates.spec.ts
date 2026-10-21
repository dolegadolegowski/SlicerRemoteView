// Live updates end to end (WEB-12; §8.1–8.4, FR-41, FR-42): the fake-slicer CLI plays its bundled update scripts
// through the relay stub of tools/fake-slicer (`[stub: SRV-12, SRV-13]`) after the snapshot; the viewer applies each
// `scene.update` / `scene.nodeAdded` + new snapshot in version order, and the node panel shows the result.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Color, LinearSRGBColorSpace } from "three";
import { settled } from "./canvas";
import { bridge, startPublisher } from "./fake-slicer";
import type { Publisher } from "./fake-slicer";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
const row = (page: Page, nodeId: string) =>
  page.locator(`.node-panel__row[data-node-id="${nodeId}"]`);
/** The CSS colour (as the browser serialises it) of a linear manifest colour. */
const css = (r: number, g: number, b: number) =>
  new Color().setRGB(r, g, b, LinearSRGBColorSpace).getStyle().replace(/,/g, ", ");

/** Joins a fake-slicer session that plays `script`, with the node panel open. */
async function joinPlaying(page: Page, script: string, publishers: Publisher[]): Promise<void> {
  const publisher = await startPublisher({ script });
  publishers.push(publisher);
  await bridge(page, publisher.stub);
  await page.goto("/");
  const webgl2 = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl2, "no WebGL 2 in this headless browser, so the viewer cannot open");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type(publisher.code);
  await page.locator(".code-entry__join").click();
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible({ timeout: 20_000 });
  await page.locator(".node-panel__toggle").click();
}

const publishers: Publisher[] = [];
test.afterEach(async () => {
  await Promise.all(publishers.splice(0).map((p) => p.close()));
});

test("toggle-visibility: the presenter hides and shows each structure in turn", async ({
  page,
}) => {
  await joinPlaying(page, "toggle-visibility", publishers);
  await expect(row(page, LIVER)).toHaveAttribute("aria-checked", "false", { timeout: 5_000 });
  await expect(row(page, LIVER)).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
  await expect(row(page, TUMOR)).toHaveAttribute("aria-checked", "false", { timeout: 5_000 });
  await expect(row(page, TUMOR)).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
});

test("colour-cycle: colours reach the swatches; the last one stays", async ({ page }) => {
  await joinPlaying(page, "colour-cycle", publishers);
  const swatch = (nodeId: string) => row(page, nodeId).locator(".node-panel__swatch");
  await expect(swatch(LIVER)).toHaveCSS("background-color", css(0.9, 0.2, 0.2), { timeout: 5_000 });
  await expect(swatch(TUMOR)).toHaveCSS("background-color", css(0.8, 0.3, 0.8), { timeout: 8_000 });
  await expect(swatch(LIVER)).toHaveCSS("background-color", css(0.3, 0.3, 0.95));
});

test("move-node: a new T.matrix moves the model on screen", async ({ page }) => {
  await joinPlaying(page, "move-node", publishers);
  const canvas = page.locator(".viewer__canvas");
  const style = ".viewer__fit, .viewer__top, .node-panel { visibility: hidden !important; }";
  const loaded = await canvas.screenshot({ style });
  await expect
    .poll(async () => (await canvas.screenshot({ style })).equals(loaded), { timeout: 5_000 })
    .toBe(false);
});

test("reload-scene: scene.nodeAdded, then a new snapshot with other nodes, then an update of the new node", async ({
  page,
}) => {
  // Records every status line the page shows (it is up for a fraction of a second only).
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    new MutationObserver(() => {
      const status = document.querySelector<HTMLElement>(".viewer__status");
      if (status?.textContent && seen.at(-1) !== status.textContent)
        seen.push(status.textContent ?? "");
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await joinPlaying(page, "reload-scene", publishers);
  await expect(page.locator(".node-panel__row")).toHaveText(["Vessel"], { timeout: 10_000 });
  // scene.nodeAdded showed the hint before the new snapshot arrived
  expect(
    await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses),
  ).toContain("Updating the scene…");
  await expect(row(page, "vtkMRMLModelNode3").locator(".node-panel__swatch")).toHaveCSS(
    "background-color",
    css(0.9, 0.5, 0.2),
    { timeout: 5_000 },
  );
  await expect(page.locator(".viewer__status")).toBeHidden(); // the "updating" hint went with the new model
  await settled(page); // and the new scene renders
});
