// Accessibility checks shared by the specs (NFR-32): WCAG 2 AA text contrast through axe-core (WEB-17) and 44 × 44 px
// touch targets (WEB-21, WEB-22).

import { createRequire } from "node:module";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { AxeResults, RunOptions } from "axe-core";

// axe-core itself, injected into the page (no Playwright adapter: it would pull a second Playwright version).
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/**
 * Contrast problems of the elements matched by `include` (WCAG 2 AA, NFR-32): violations, and also the nodes axe
 * could not decide (text over the canvas or an image would land there and pass silently). At least one node must
 * have been checked, so an empty or hidden selection fails too.
 */
export async function contrast(page: Page, include: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (selector) => {
    const axe = (
      window as unknown as { axe: { run(c: string, o: RunOptions): Promise<AxeResults> } }
    ).axe;
    const options: RunOptions = { runOnly: { type: "rule", values: ["color-contrast"] } };
    const result = await axe.run(selector, options);
    const problems = [...result.violations, ...result.incomplete].flatMap((v) =>
      v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`),
    );
    const checked = result.passes.reduce((sum, rule) => sum + rule.nodes.length, 0);
    return checked > 0 || problems.length > 0 ? problems : [`${selector}: no text checked`];
  }, include);
}

/**
 * The button's touch target (NFR-32): its box, or the invisible `::after` around it when that is larger, and whether
 * points 21 px from its centre still hit the button — nothing covers the target (1 px short of the edge: hit testing
 * rounds the point).
 */
async function target(
  page: Page,
  selector: string,
): Promise<{ width: number; height: number; hits: boolean }> {
  return page.evaluate((s) => {
    const button = document.querySelector<HTMLElement>(s)!;
    const r = button.getBoundingClientRect();
    const after = getComputedStyle(button, "::after");
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    const d = 21;
    return {
      width: Math.max(r.width, parseFloat(after.width) || 0),
      height: Math.max(r.height, parseFloat(after.height) || 0),
      hits: [
        [x, y - d],
        [x, y + d],
        [x - d, y],
        [x + d, y],
      ].every(([px, py]) => document.elementFromPoint(px!, py!) === button),
    };
  }, selector);
}

export async function expectTargetOf44(page: Page, selector: string): Promise<void> {
  const { width, height, hits } = await target(page, selector);
  expect(width, selector).toBeGreaterThanOrEqual(44);
  expect(height, selector).toBeGreaterThanOrEqual(44);
  expect(hits, selector).toBe(true);
}
