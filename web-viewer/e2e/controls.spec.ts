// Viewer controls on a touch device (WEB-08, FR-38, US-08, NFR-32). The fake relay (fake-relay.ts) streams a fixture
// GLB through the real pipeline (join → stream → verify → parse → render). Gestures are real touch input sent over
// the Chrome DevTools Protocol, so this spec runs on the Chromium project; on iOS Safari the same checks are manual
// (docs/testing/web.md §iPhone Safari).

import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { footprint, settled } from "./canvas";
import { fakeRelay, joinAndView } from "./fake-relay";

type Point = readonly [number, number];
/** A touch gesture: every finger moves in a straight line from `from[i]` to `to[i]`. */
async function gesture(cdp: CDPSession, from: Point[], to: Point[], steps = 12): Promise<void> {
  const at = (f: number) =>
    from.map(([x, y], id) => ({
      x: x + (to[id]![0] - x) * f,
      y: y + (to[id]![1] - y) * f,
      id,
    }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let step = 1; step <= steps; step++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(step / steps),
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function centre(page: Page): Promise<{ cx: number; cy: number }> {
  const box = (await page.locator(".viewer__canvas").boundingBox())!;
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

const pageNeitherScrolledNorZoomed = async (page: Page) =>
  expect(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scale: window.visualViewport?.scale ?? 1,
    })),
  ).toEqual({ scrollX: 0, scrollY: 0, scale: 1 });

test.describe("viewer controls (WEB-08)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "touch input is sent over CDP (Chromium); iOS Safari is checked on a device",
  );

  test("one finger rotates the model about its centre; the page does not scroll", async ({
    page,
  }) => {
    await joinAndView(page);
    const loaded = await settled(page);
    const before = await footprint(page, loaded);
    expect(before.area).toBeGreaterThan(0.01); // the model is on screen
    const { cx, cy } = await centre(page);
    const cdp = await page.context().newCDPSession(page);
    await gesture(cdp, [[cx - 80, cy]], [[cx + 80, cy]]);
    const rotated = await settled(page);
    expect(rotated.equals(loaded)).toBe(false);
    const after = await footprint(page, rotated);
    // A rotation turns the model about its bounding-sphere centre, which stays at the screen centre: the asymmetric
    // silhouette swings across it (centroid x ≈ 0.61 → 0.44) but stays near it. A pan by the same 160 px drag would
    // move it 160 / 412 ≈ 0.39 of the width away.
    for (const { x, y } of [before, after]) {
      expect(Math.abs(x - 0.5)).toBeLessThan(0.15);
      expect(Math.abs(y - 0.5)).toBeLessThan(0.15);
    }
    await pageNeitherScrolledNorZoomed(page);
  });

  test("two fingers spreading apart zoom in; the page does not zoom", async ({ page }) => {
    await joinAndView(page);
    const loaded = await settled(page);
    const before = await footprint(page, loaded);
    const { cx, cy } = await centre(page);
    const cdp = await page.context().newCDPSession(page);
    await gesture(
      cdp,
      [
        [cx - 30, cy],
        [cx + 30, cy],
      ],
      [
        [cx - 140, cy],
        [cx + 140, cy],
      ],
    );
    const zoomed = await footprint(page, await settled(page));
    expect(zoomed.area).toBeGreaterThan(before.area * 1.5); // the model got bigger on screen
    await pageNeitherScrolledNorZoomed(page);
  });

  test("the canvas fills the viewport at a device pixel ratio capped at 2, also after a rotation", async ({
    page,
  }) => {
    // Playwright's viewport has no collapsing toolbar, so 100vh and 100dvh cannot be told apart here; the dynamic
    // toolbar case is a manual step on iPhone Safari and Android Chrome (docs/testing/web.md).
    await joinAndView(page);
    const measure = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(".viewer__canvas")!;
        const rect = canvas.getBoundingClientRect();
        return {
          buffer: [canvas.width, canvas.height],
          css: [rect.left, rect.top, rect.width, rect.height],
          viewport: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
        };
      });
    const portrait = await measure();
    expect(portrait.dpr).toBeGreaterThan(2); // Pixel 7: 2.625
    expect(portrait.css).toEqual([0, 0, ...portrait.viewport]);
    expect(portrait.buffer).toEqual([
      Math.floor(portrait.css[2]! * 2),
      Math.floor(portrait.css[3]! * 2),
    ]);

    await page.setViewportSize({ width: 839, height: 412 }); // rotate to landscape
    await expect
      .poll(async () => {
        const m = await measure();
        return m.css.join() === [0, 0, ...m.viewport].join() && m.buffer.join();
      })
      .toBe([839 * 2, 412 * 2].join());
  });

  test("the Fit button is a 44 px target that restores the load framing", async ({ page }) => {
    await joinAndView(page);
    const loaded = await settled(page);
    const fit = page.locator(".viewer__fit");
    const size = (await fit.boundingBox())!;
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    const { cx, cy } = await centre(page);
    const cdp = await page.context().newCDPSession(page);
    await gesture(
      cdp,
      [
        [cx - 20, cy],
        [cx + 20, cy],
      ],
      [
        [cx - 150, cy],
        [cx + 150, cy],
      ],
    );
    const zoomed = await settled(page);
    expect(zoomed.equals(loaded)).toBe(false);
    await fit.tap();
    // Fit keeps the direction (unchanged here: the pinch did not rotate) and restores the framing of the load.
    expect((await settled(page)).equals(loaded)).toBe(true);
  });

  test("a page pinch-zoomed on the code entry still shows the whole viewer and its Fit button", async ({
    page,
  }) => {
    await fakeRelay(page);
    await page.goto("/");
    // Two fingers spreading apart on the code entry (no touch-action there): the browser pinch-zooms the page.
    const cdp = await page.context().newCDPSession(page);
    await gesture(
      cdp,
      [
        [160, 400],
        [250, 400],
      ],
      [
        [130, 400],
        [280, 400],
      ],
      20,
    );
    await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBeGreaterThan(1.2);
    // The zoom settles with inertia: wait until it stops, then join by keyboard (a click on a page still zooming
    // can land beside its target).
    const zoom = () =>
      page.evaluate(() => {
        const vv = window.visualViewport!;
        return [vv.scale, vv.offsetLeft, vv.offsetTop].join();
      });
    await expect
      .poll(async () => {
        const before = await zoom();
        await page.waitForTimeout(200);
        return before === (await zoom());
      })
      .toBe(true);
    await page.locator(".code-entry__cell").first().focus();
    await page.keyboard.type("7kq4x");
    await page.keyboard.press("Enter");
    await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
    const placement = await page.evaluate(() => {
      const vv = window.visualViewport!;
      const fit = document.querySelector(".viewer__fit")!.getBoundingClientRect();
      const viewer = document.querySelector(".viewer")!.getBoundingClientRect();
      const canvas = document.querySelector<HTMLCanvasElement>(".viewer__canvas")!;
      return {
        buffer: canvas.width,
        unzoomedBuffer: window.innerWidth * 2,
        fitInside:
          fit.left >= vv.offsetLeft - 1 &&
          fit.top >= vv.offsetTop - 1 &&
          fit.right <= vv.offsetLeft + vv.width + 1 &&
          fit.bottom <= vv.offsetTop + vv.height + 1,
        viewer: [viewer.left, viewer.top, viewer.width, viewer.height].map(Math.round),
        visual: [vv.offsetLeft, vv.offsetTop, vv.width, vv.height].map(Math.round),
      };
    });
    expect(placement.fitInside).toBe(true);
    // The zoomed viewer is smaller in CSS px but fills the screen: it keeps the unzoomed drawing buffer.
    expect(Math.abs(placement.buffer - placement.unzoomedBuffer)).toBeLessThanOrEqual(2);
    expect(placement.viewer).toEqual(placement.visual);
  });
});
