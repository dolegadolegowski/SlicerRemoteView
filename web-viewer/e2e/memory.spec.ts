// Memory and robustness (WEB-16; FR-45, FR-46, R-02; research web.md §2.3). GPU resources are read through the
// `window.__rv.rendererInfo()` test hook (counts only); the context is lost and restored for real with
// `WEBGL_lose_context`; the wake lock is a recording stand-in installed before the page runs.

import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { settled } from "./canvas";
import { fixture, joinAndView, sendJson, streamSnapshot } from "./fake-relay";
import { withExtraNodes } from "./glb";

const geometries = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __rv: { rendererInfo(): { geometries: number } | null } }
      ).__rv.rendererInfo()?.geometries ?? -1,
  );

test("three snapshots in a row leave as many geometries on the GPU as the last one has nodes (FR-45, R-02)", async ({
  page,
}) => {
  let relay: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    relay = ws;
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as Record<string, unknown>;
      if (message["type"] !== "viewer.join") return;
      sendJson(ws, {
        type: "viewer.joined",
        replyTo: message["id"],
        sessionId: "sess_E2E0000000000000",
        viewerId: "vw_e2e",
        viewerToken: `vt_${"A".repeat(43)}`,
        sceneVersion: 0,
        snapshotVersion: null,
        snapshotAvailable: false,
        publisherOnline: true,
        viewerCount: 1,
        viewerLimit: 20,
        profile: "mobile",
      });
      sendJson(ws, {
        type: "scene.state",
        sceneVersion: 0,
        snapshotVersion: null,
        nodes: [],
        removed: [],
      });
      streamSnapshot(ws, fixture("asymmetric-2nodes.glb"), 1); // 2 nodes
    });
  });
  await page.goto("/");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ4X");
  await page.locator(".code-entry__join").click();
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect.poll(() => geometries(page)).toBe(2);
  streamSnapshot(relay!, withExtraNodes(5), 2); // 7 nodes
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  await expect.poll(() => geometries(page)).toBe(7);
  streamSnapshot(relay!, fixture("quantized-1node.glb"), 3); // 1 node
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v3");
  await expect.poll(() => geometries(page)).toBe(1); // the previous models were disposed
});

test("a lost WebGL context says so and stops; a restored one draws the same scene again (web.md §2.3)", async ({
  page,
}) => {
  await joinAndView(page);
  const before = await settled(page);
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".viewer__canvas")!;
    const lose = canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    (window as unknown as { __lose: WEBGL_lose_context }).__lose = lose;
    lose.loseContext();
  });
  await expect(page.locator(".viewer")).toHaveAttribute("data-context", "lost");
  await expect(page.locator(".viewer__notice")).toContainText("3D view paused");
  await page.evaluate(() =>
    (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext(),
  );
  await expect(page.locator(".viewer")).not.toHaveAttribute("data-context", "lost");
  await expect(page.locator(".viewer__notice")).toBeHidden();
  await expect.poll(async () => (await settled(page)).equals(before)).toBe(true);
});

test("the screen wake lock is requested after the join and again when the page is visible (FR-46)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __wake: string[] }).__wake = calls;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (type: string) => {
          calls.push(type);
          const sentinel = new EventTarget() as EventTarget & {
            released: boolean;
            release(): Promise<void>;
          };
          sentinel.released = false;
          sentinel.release = async () => {
            sentinel.released = true;
          };
          (window as unknown as { __sentinel: typeof sentinel }).__sentinel = sentinel;
          return sentinel;
        },
      },
    });
  });
  await joinAndView(page);
  const wake = () => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake);
  await expect.poll(wake).toEqual(["screen"]);
  // The browser releases the lock while the page is hidden; back in view it is requested again.
  await page.evaluate(async () => {
    await (window as unknown as { __sentinel: { release(): Promise<void> } }).__sentinel.release();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(wake).toEqual(["screen", "screen"]);
});
