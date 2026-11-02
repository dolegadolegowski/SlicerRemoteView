// Viewer-side helpers shared by the browser specs: join by typing the code, node-panel locators, request
// recording, and canvas probes (adapted from web-viewer/e2e/canvas.ts; decoded in the page, no image library).
// Selectors are the viewer's own (web-viewer/src): `.code-entry__cell`, `.code-entry__join`,
// `.viewer[data-model='loaded']` (render/viewer.ts), `.node-panel__row[data-node-id]` with `aria-checked`.

import type { Page, Request } from "@playwright/test";
import { expect } from "@playwright/test";

/** Hidden in canvas screenshots: controls over the canvas would count as model pixels. */
export const SCENE_ONLY = ".viewer__fit, .viewer__top, .node-panel { visibility: hidden !important; }";

/** True when the page's browser has WebGL 2 (the viewer cannot open without it). */
export async function hasWebGl2(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
}

/** Opens `/`, types the code into the cells and presses Join. The code is typed, never logged. */
export async function joinByCode(page: Page, baseUrl: string, code: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type(code);
  await page.locator(".code-entry__join").click();
}

/** Waits until the viewer reports a loaded model. */
export async function expectModelLoaded(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible({ timeout });
}

export const nodeRow = (page: Page, nodeId: string) =>
  page.locator(`.node-panel__row[data-node-id="${nodeId}"]`);

/** Opens the node panel (rows are in the DOM only while it is open). */
export async function openNodePanel(page: Page): Promise<void> {
  await page.locator(".node-panel__toggle").click();
}

/** Records every request the page makes (URL, method, headers) for "no code in any URL" assertions. */
export function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  return requests;
}

/**
 * Whether `secret` occurs in `text`, as a boolean: specs assert on this (`expect(...).toBe(false)`) rather than
 * `not.toContain(secret)`, whose failure message would print the secret into the CI log.
 */
export const leaks = (text: string, secret: string): boolean => text.includes(secret);

/** Waits until the canvas stops changing (damping settled; the viewer renders on demand). */
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
  /** Share of the canvas covered by the model (pixels that differ from the background #0b0f14). */
  readonly area: number;
  /** Centroid of those pixels, 0..1 across the canvas. */
  readonly x: number;
  readonly y: number;
}

/** Where the model is in a canvas screenshot. */
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
      if (Math.abs(data[i]! - 11) + Math.abs(data[i + 1]! - 15) + Math.abs(data[i + 2]! - 20) < 24) continue;
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
