// WCAG 2 AA text contrast through axe-core (NFR-32), shared by the PWA (WEB-17) and Leave (WEB-22) specs.

import { createRequire } from "node:module";
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
