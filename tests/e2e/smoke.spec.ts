// QA-02 smoke: the harness boots the built relay with fake-slicer on a random port, the relay serves the built
// viewer at `/`, and everything stops cleanly. The code reaches this spec through memory only.

import { expect, test } from "../harness/fixtures.ts";

test("smoke: the stack boots, serves the viewer and stops", async ({ stack, page }) => {
  expect(stack.code).toMatch(/^[2-9A-HJKMNP-Z]{5}$/);
  const health = await (await fetch(`${stack.baseUrl}/healthz`)).json();
  expect(health).toMatchObject({ status: "ok", sessions: 1 });
  await page.goto(stack.baseUrl + "/");
  await expect(page.locator(".code-entry__join")).toBeVisible();
  // fake-slicer never prints the code (NFR-12): only its fd 3 pipe carried it.
  const { stdout, stderr } = stack.publisher!.outputs();
  expect(stdout.includes(stack.code) || stderr.includes(stack.code)).toBe(false);
  await stack.stop();
  expect(await stack.relay.exited).toBe(0);
});
