// Canvas screenshots for the viewer specs: wait until rendering stops, and find the model in the image.

import type { Page } from "@playwright/test";

/** The scene only: controls over the canvas would count as model pixels (not `mask`: its colour counts too). */
const SCENE_ONLY = ".viewer__fit, .viewer__top, .node-panel { visibility: hidden !important; }";

/** Waits until the canvas stops changing (damping settled; render on demand stops). */
export async function settled(page: Page): Promise<Buffer> {
  const canvas = page.locator(".viewer__canvas");
  const shot = () => canvas.screenshot({ style: SCENE_ONLY });
  let previous = await shot();
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(250);
    const current = await shot();
    if (current.equals(previous)) return current;
    previous = current;
  }
  throw new Error("the canvas never settled");
}

export interface Footprint {
  /** Share of the canvas covered by the model (pixels that differ from the background). */
  readonly area: number;
  /** Centroid of those pixels, 0..1 across the canvas. */
  readonly x: number;
  readonly y: number;
}

/** Where the model is in a screenshot: decoded in the page (no image library in the test runner). */
export async function footprint(page: Page, png: Buffer): Promise<Footprint> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < data.length; i += 4) {
      // background #0b0f14
      if (Math.abs(data[i]! - 11) + Math.abs(data[i + 1]! - 15) + Math.abs(data[i + 2]! - 20) < 24)
        continue;
      const p = i / 4;
      count++;
      sx += p % width;
      sy += Math.floor(p / width);
    }
    return {
      area: count / (width * height),
      x: count ? sx / count / width : 0,
      y: count ? sy / count / height : 0,
    };
  }, png.toString("base64"));
}
