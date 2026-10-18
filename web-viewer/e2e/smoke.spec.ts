import { expect, test } from "@playwright/test";

test("page loads with the app title and a full-height shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("SlicerRemoteView");
  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
  const overflows = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(overflows).toBe(false);
});
