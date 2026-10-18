import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const cells = (page: Page) => page.locator(".code-entry__cell");

test.describe("code entry", () => {
  test("cells and Join are at least 44x44 CSS px and the page does not scroll", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(cells(page)).toHaveCount(5);
    const boxes = [
      ...(await cells(page).evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect().toJSON()),
      )),
      await page.locator(".code-entry__join").evaluate((e) => e.getBoundingClientRect().toJSON()),
    ] as { width: number; height: number }[];
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const scrolls = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > window.innerWidth,
      y: document.documentElement.scrollHeight > window.innerHeight,
    }));
    expect(scrolls).toEqual({ x: false, y: false });
  });

  test("Join opens the socket without the code in any URL and reports a failed connection", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const sockets: { url: string; frames: string[] }[] = [];
    page.on("websocket", (ws) => {
      const socket = { url: ws.url(), frames: [] as string[] };
      sockets.push(socket);
      ws.on("framesent", (frame) => socket.frames.push(String(frame.payload)));
    });

    await page.goto("/");
    await cells(page).first().click();
    await page.keyboard.type("7kq4x");
    await expect(cells(page).nth(4)).toHaveValue("X");
    const join = page.locator(".code-entry__join");
    await expect(join).toBeEnabled();

    await join.click();
    // `vite preview` has no relay behind /ws, so the socket fails; the viewer must say so and become usable again.
    await expect(page.locator(".code-entry__message")).toBeVisible();
    await expect(join).toBeEnabled();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    expect(page.url()).not.toMatch(/7KQ4X/i);
    expect(new URL(page.url()).search).toBe("");
    expect(new URL(page.url()).hash).toBe("");
    expect(requested.filter((url) => /7KQ4X/i.test(url))).toEqual([]);
  });

  test("a wrong character shows the hint and keeps Join disabled", async ({ page }) => {
    await page.goto("/");
    await cells(page).first().click();
    await page.keyboard.type("7kq0x");
    await expect(page.locator(".code-entry__message")).toBeVisible();
    await expect(page.locator(".code-entry__join")).toBeDisabled();
  });
});
