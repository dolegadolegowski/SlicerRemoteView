// Node panel on a phone (WEB-09, FR-40, US-09, NFR-32): the fake relay (fake-relay.ts) streams asymmetric-2nodes.glb
// ("Liver", opaque, and "Tumor", translucent) through the real pipeline; the panel is used by tapping like a user.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { footprint, settled } from "./canvas";
import { fakeRelay, join } from "./fake-relay";
import { withExtraNodes } from "./glb";

const toggle = (page: Page) => page.locator(".node-panel__toggle");
const rows = (page: Page) => page.locator(".node-panel__row");

/** Joins and shows the model; skipped where the browser has no WebGL 2 (the viewer cannot open there). */
async function view(page: Page, glb?: Buffer): Promise<void> {
  await fakeRelay(page, glb);
  await page.goto("/");
  const webgl2 = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl2, "no WebGL 2 in this headless browser, so the viewer cannot open");
  await join(page);
}

const pageNeitherScrolled = async (page: Page) =>
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);

/** No element matching `a` overlaps an element matching `b` (a tap meant for one cannot land on the other). */
async function expectApart(page: Page, a: string, b: string): Promise<void> {
  const boxes = async (selector: string) =>
    Promise.all((await page.locator(selector).all()).map(async (l) => (await l.boundingBox())!));
  for (const p of await boxes(a))
    for (const q of await boxes(b))
      expect(
        p.x + p.width <= q.x ||
          q.x + q.width <= p.x ||
          p.y + p.height <= q.y ||
          q.y + q.height <= p.y,
        `${a} ${JSON.stringify(p)} overlaps ${b} ${JSON.stringify(q)}`,
      ).toBe(true);
}

/** The open panel's box as a share of the viewport (its toggle row included). */
async function coverage(page: Page): Promise<number> {
  const box = (await page.locator(".node-panel").boundingBox())!;
  const viewport = page.viewportSize()!;
  return (box.width * box.height) / (viewport.width * viewport.height);
}

test.describe("node panel (WEB-09)", () => {
  test("lists the fixture's structures in 44 px rows and covers at most half of the screen, upright and on its side", async ({
    page,
  }) => {
    await view(page);
    await expect(page.locator(".node-panel__body")).toBeHidden(); // closed at first: the model gets the screen
    const size = (await toggle(page).boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(44);
    await toggle(page).click();
    await expect(rows(page)).toHaveText(["Liver", "Tumor"]);
    for (const row of await rows(page).all())
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await coverage(page)).toBeLessThanOrEqual(0.5);

    const { width, height } = page.viewportSize()!;
    await page.setViewportSize({ width: height, height: width });
    await expect.poll(() => coverage(page)).toBeLessThanOrEqual(0.5);
    for (const row of await rows(page).all()) await expect(row).toBeInViewport({ ratio: 1 });
    await expectApart(page, ".node-panel__body, .node-panel__toggle", ".viewer__fit");
  });

  test("tapping a structure hides it on the next frame; 'Show all' brings it back", async ({
    page,
  }) => {
    await view(page);
    const loaded = await settled(page); // the panel is left out of the screenshots (canvas.ts)
    await toggle(page).click();
    const liver = rows(page).filter({ hasText: "Liver" });
    await liver.click();
    await expect(liver).toHaveAttribute("aria-checked", "false");
    // The opaque Liver encloses the small Tumor: without it, far fewer pixels show a model.
    const hidden = await footprint(page, await settled(page));
    expect(hidden.area).toBeLessThan((await footprint(page, loaded)).area / 2);

    await page.locator(".node-panel__show-all").click();
    await expect(liver).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".node-panel__show-all")).toHaveAttribute("aria-disabled", "true");
    // Taps on the panel never reach the canvas: the camera did not move, the image is the one of the load.
    expect((await settled(page)).equals(loaded)).toBe(true);
  });

  test("a long list stays within half of the screen and scrolls inside, upright and on its side", async ({
    page,
  }) => {
    await view(page, withExtraNodes(38)); // 40 structures
    await toggle(page).click();
    // A scene notice (e.g. a refused update) shown meanwhile must not cover the list either.
    await page.evaluate(() => {
      const notice = document.querySelector<HTMLElement>(".viewer__notice")!;
      notice.querySelector(".viewer__notice-title")!.textContent = "Scene could not be opened";
      notice.querySelector(".viewer__notice-body")!.textContent =
        "The scene that was shared is damaged or uses features this viewer does not support.";
      notice.hidden = false;
    });
    await expect(rows(page)).toHaveCount(40);
    const body = page.locator(".node-panel__body");
    const last = rows(page).last();
    for (const turn of [false, true]) {
      if (turn) {
        const { width, height } = page.viewportSize()!;
        await page.setViewportSize({ width: height, height: width });
      }
      await expect.poll(() => coverage(page)).toBeLessThanOrEqual(0.5);
      await expectApart(
        page,
        ".node-panel__body, .node-panel__toggle",
        ".viewer__fit, .viewer__notice",
      );
      expect(await body.evaluate((b) => b.scrollHeight > b.clientHeight)).toBe(true);
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport({ ratio: 0.9 }); // sub-pixel rounding at DPR 2.625
      await last.click();
      await expect(last).toHaveAttribute("aria-checked", turn ? "true" : "false");
      await pageNeitherScrolled(page);
    }
  });
});
