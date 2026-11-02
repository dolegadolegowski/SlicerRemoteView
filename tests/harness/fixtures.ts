// Playwright fixtures: `stack` (relay + fake-slicer, fresh per test so rate limits and sessions never leak between
// tests) and `startStack` for specs that need several stacks or custom options. Logs land in the test's output
// directory (`test-results/…/relay.log`), which CI uploads for the log-grep (QA-07, DEP-10). Nothing is attached
// to the report: the code and tokens stay in memory.

import { test as base } from "@playwright/test";
import { startStack } from "./stack.ts";
import type { Stack, StackOptions } from "./stack.ts";

export interface StackFixtures {
  /** Options for the `stack` fixture: `test.use({ stackOptions: { publisher: { script: "move-node" } } })`. */
  stackOptions: StackOptions;
  stack: Stack;
  /** Starts an extra stack, stopped after the test. */
  startStack: (options?: StackOptions) => Promise<Stack>;
}

export const test = base.extend<StackFixtures>({
  stackOptions: [{}, { option: true }],
  startStack: async ({}, use, testInfo) => {
    const stacks: Stack[] = [];
    await use(async (options = {}) => {
      const stack = await startStack({ dir: testInfo.outputPath(`stack-${stacks.length}`), ...options });
      stacks.push(stack);
      return stack;
    });
    await Promise.all(stacks.map((s) => s.stop()));
  },
  stack: async ({ stackOptions, startStack }, use) => {
    await use(await startStack(stackOptions));
  },
});

export { expect } from "@playwright/test";
