// Local opacity and presenter overrides (WEB-13; FR-40, US-02, US-09, US-10). Touch input is sent over the Chrome
// DevTools Protocol, so the drags run on the Chromium project; iOS Safari drags the thumb on a device
// (docs/testing/web.md §Opacity). The override case sends the presenter's updates from the in-page relay, one at a
// time, so it does not race a script's timing.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { settled } from "./canvas";
import { joinAndView } from "./fake-relay";
import { withExtraNodes } from "./glb";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const TUMOR = "vtkMRMLModelNode2";
const slider = (page: Page, nodeId: string) =>
  page.locator(`.node-panel__opacity[data-node-id="${nodeId}"]`);

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One finger from `from` to `to` in `steps` moves, over CDP (Chromium only). */
async function touchDrag(page: Page, from: Point, to: Point, steps = 10): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", p?: Point) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ ...p, id: 0 }] : [] });
  await send("touchStart", from);
  for (let step = 1; step <= steps; step++)
    await send("touchMove", {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    });
  await send("touchEnd");
}

test("the opacity slider is a 44 px target; a touch drag makes the liver translucent on the next frame", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "touch input is sent over CDP (Chromium); iOS is checked on a device",
  );
  await joinAndView(page);
  const loaded = await settled(page);
  await page.locator(".node-panel__toggle").click();
  const box = (await slider(page, LIVER).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // From the thumb (value 1, right end) to 40 % of the track; the thumb is 44 px wide.
  const y = box.y + box.height / 2;
  const at = (fraction: number) => box.x + 22 + fraction * (box.width - 44);
  await touchDrag(page, { x: at(1), y }, { x: at(0.4), y });
  await expect.poll(async () => Number(await slider(page, LIVER).inputValue())).toBeCloseTo(0.4, 1);
  // A presenter's 0.98 is shown as it is, not rounded to the end stop (the browser rounds to the step).
  expect(
    await slider(page, TUMOR).evaluate((input: HTMLInputElement) => {
      const copy = input.cloneNode() as HTMLInputElement;
      copy.value = "0.98";
      return copy.value;
    }),
  ).toBe("0.98");
  await page.locator(".node-panel__toggle").click(); // closed: the scene only (canvas.ts hides the panel anyway)
  expect((await settled(page)).equals(loaded)).toBe(false); // the tumour inside shows through
});

test("a vertical swipe that starts on a slider's track scrolls the list and changes no opacity", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "touch input is sent over CDP (Chromium)");
  await joinAndView(page, withExtraNodes(38));
  const loaded = await settled(page);
  await page.locator(".node-panel__toggle").click();
  const sliders = page.locator(".node-panel__opacity");
  const before = await sliders.evaluateAll((all) => all.map((s) => (s as HTMLInputElement).value));
  // Blink moves the thumb to the touch point on touchstart, before the swipe turns into a scroll.
  const box = (await sliders.nth(1).boundingBox())!;
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height / 2 };
  await touchDrag(page, from, { x: from.x, y: from.y - 150 }, 15);
  await expect
    .poll(() => page.locator(".node-panel__body").evaluate((body) => body.scrollTop))
    .toBeGreaterThan(0);
  expect(await sliders.evaluateAll((all) => all.map((s) => (s as HTMLInputElement).value))).toEqual(
    before,
  );
  await page.locator(".node-panel__toggle").click();
  expect((await settled(page)).equals(loaded)).toBe(true);
});

test("a presenter opacity change replaces the local value and says so for a moment; without one, no notice", async ({
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
  const relay = await joinAndView(page); // the snapshot is version 1
  const statuses = () =>
    page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
  const presenter = (sceneVersion: number, opacity: number) =>
    relay.send({
      type: "scene.update",
      sceneVersion,
      baseVersion: sceneVersion - 1,
      changes: [{ nodeId: TUMOR, opacity }],
    });
  await page.locator(".node-panel__toggle").click();
  await expect(slider(page, TUMOR)).toHaveValue("0.35");
  presenter(2, 0.5); // nothing set locally: applied, no notice
  await expect(slider(page, TUMOR)).toHaveValue("0.5");
  expect(await statuses()).toEqual([]);
  await slider(page, TUMOR).evaluate((input: HTMLInputElement) => {
    input.value = "0.9"; // the user's own value
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(slider(page, TUMOR)).toHaveValue("0.9");
  presenter(3, 0.35);
  await expect(slider(page, TUMOR)).toHaveValue("0.35"); // the presenter's wins
  await expect.poll(statuses).toEqual(["The presenter changed Tumor"]);
  await expect(page.locator(".viewer__status")).toBeHidden({ timeout: 5_000 }); // only for a moment
});
