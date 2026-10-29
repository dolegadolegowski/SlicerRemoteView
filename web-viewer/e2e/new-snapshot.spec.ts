// A new snapshot of the scene on screen (WEB-25): Slicer exports the whole scene again when a structure is edited, and
// the viewer keeps the user's view and local choices; another scene is framed from the front with the presenter's
// values. The presenter's snapshots come from the in-page relay (fake-relay.ts), one at a time. The rotation is real
// touch input over the Chrome DevTools Protocol, so that test runs on the Chromium project; iOS Safari is checked on a
// device (docs/testing/web.md §New snapshot of the same scene).

import { devices, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { difference, footprint, settled } from "./canvas";
import { fixture, joinAndView } from "./fake-relay";
import { withManifest, withNode } from "./glb";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
const slider = (page: Page, nodeId: string) =>
  page.locator(`.node-panel__opacity[data-node-id="${nodeId}"]`);
/** A glTF node matrix (column-major) that moves by x, y, z metres. */
const at = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** asymmetric-2nodes.glb with both structures 5 m along x (the Tumor sits at 0.02, 0.01, −0.03 in the fixture). */
const fiveMetresAway = () =>
  withNode(
    withNode(fixture("asymmetric-2nodes.glb"), LIVER, (node) => (node["matrix"] = at(5))),
    TUMOR,
    (node) => (node["matrix"] = at(5.02, 0.01, -0.03)),
  );

/** One finger 160 px across the middle of the canvas, over CDP (Chromium only): the model turns. */
async function turn(page: Page): Promise<void> {
  const box = (await page.locator(".viewer__canvas").boundingBox())!;
  const [x, y] = [box.x + box.width / 2 - 80, box.y + box.height / 2];
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", dx?: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: dx === undefined ? [] : [{ x: x + dx, y, id: 0 }],
    });
  await send("touchStart", 0);
  for (let step = 1; step <= 12; step++) await send("touchMove", (160 * step) / 12);
  await send("touchEnd");
}

test("the same scene shared again keeps the user's view; another scene is framed from the front", async ({
  page,
  browser,
  browserName,
  baseURL,
}) => {
  test.skip(
    browserName !== "chromium",
    "touch input is sent over CDP (Chromium); iOS Safari is checked on a device",
  );
  const relay = await joinAndView(page);
  const loaded = await settled(page);
  await turn(page);
  const turned = await settled(page);
  relay.snapshot(fixture("asymmetric-2nodes.glb"), 2); // Slicer exported the scene again after an edit
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  const again = await settled(page);
  // The view the user left, up to the damping's last sub-pixel residue (OrbitControls applies it on every update).
  const changed = await difference(page, turned, again);
  expect(changed.share).toBeLessThan(1e-4);
  expect(changed.max).toBeLessThanOrEqual(3);
  const [load, kept] = await Promise.all([footprint(page, loaded), footprint(page, again)]);
  expect(Math.abs(kept.x - load.x)).toBeGreaterThan(0.1); // not the load's framing again

  relay.snapshot(fixture("quantized-1node.glb"), 3); // another scene: no node in common
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v3");
  const other = await settled(page);
  const reference = await browser.newPage({ ...devices["Pixel 7"], baseURL: baseURL! });
  try {
    await joinAndView(reference, fixture("quantized-1node.glb"));
    expect(other.equals(await settled(reference))).toBe(true); // as a fresh join frames it
  } finally {
    await reference.close();
  }
});

test("a structure hidden in the node panel stays hidden when the scene is shared again", async ({
  page,
}) => {
  const relay = await joinAndView(page);
  await page.locator(".node-panel__toggle").click();
  const liver = page.locator(".node-panel__row").filter({ hasText: "Liver" });
  await liver.click();
  await expect(liver).toHaveAttribute("aria-checked", "false");
  const hidden = await settled(page);
  relay.snapshot(fixture("asymmetric-2nodes.glb"), 2);
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  await expect(liver).toHaveAttribute("aria-checked", "false");
  const changed = await difference(page, hidden, await settled(page));
  expect(changed.share).toBeLessThan(1e-4); // the liver, half the model's pixels, is not drawn again
  expect(changed.max).toBeLessThanOrEqual(3);
});

test("another scene under the same ids and names starts from the presenter's values", async ({
  page,
}) => {
  const relay = await joinAndView(page);
  await page.locator(".node-panel__toggle").click();
  const liver = page.locator(".node-panel__row").filter({ hasText: "Liver" });
  await liver.click();
  await expect(liver).toHaveAttribute("aria-checked", "false");
  // Ids Slicer reused for another scene, elsewhere (§7.3): framed from the front, like a fresh join, and shown so.
  relay.snapshot(fiveMetresAway(), 2);
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  await expect(liver).toHaveAttribute("aria-checked", "true");
});

test("local opacities stay unless the new snapshot changes them, which says so for a moment", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    new MutationObserver(() => {
      const status = document.querySelector<HTMLElement>(".viewer__status");
      if (status?.textContent && seen.at(-1) !== status.textContent)
        seen.push(status.textContent ?? "");
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const relay = await joinAndView(page);
  const statuses = () =>
    page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  await page.locator(".node-panel__toggle").click();
  for (const [nodeId, value] of [
    [TUMOR, "0.9"],
    [LIVER, "0.5"],
  ] as const)
    await slider(page, nodeId).evaluate((input: HTMLInputElement, v) => {
      input.value = v; // the user's own values
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  await expect(slider(page, LIVER)).toHaveValue("0.5");
  // The presenter set the tumour's opacity in Slicer; the liver's is unchanged in the snapshot.
  relay.snapshot(withManifest(fixture("asymmetric-2nodes.glb"), TUMOR, { opacity: 0.6 }), 2);
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  await expect(slider(page, TUMOR)).toHaveValue("0.6"); // the presenter's value wins
  await expect(slider(page, LIVER)).toHaveValue("0.5");
  await expect.poll(statuses).toEqual(["The presenter changed Tumor"]);
  await expect(page.locator(".viewer__status")).toBeHidden({ timeout: 5_000 }); // only for a moment
});
