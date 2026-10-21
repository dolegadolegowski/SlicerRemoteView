// Leave (WEB-22; §5.4, NFR-32): the installed app has no address bar, reload or (iOS) back button, so the viewer
// itself must get out of a session — from the status bar over the scene, and from the code entry while it waits or
// reconnects. The relay stand-in records what each socket sent and how the page closed it.

import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { contrast } from "./axe";
import { fixture, sendJson, streamSnapshot } from "./fake-relay";

interface Socket {
  readonly ws: WebSocketRoute;
  readonly types: string[];
  closeCode?: number | undefined;
}

/** A relay that joins every `viewer.join`; with `scene` it streams the 2-node fixture, else the presenter waits. */
async function relay(page: Page, scene: boolean): Promise<Socket[]> {
  const sockets: Socket[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const socket: Socket = { ws, types: [] };
    sockets.push(socket);
    ws.onClose((code) => (socket.closeCode = code));
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as { type: string; id?: string };
      socket.types.push(message.type);
      if (message.type === "ping") sendJson(ws, { type: "pong", replyTo: message.id });
      if (message.type !== "viewer.join") return;
      sendJson(ws, {
        type: "viewer.joined",
        replyTo: message.id,
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
      if (scene) streamSnapshot(ws, fixture("asymmetric-2nodes.glb"));
    });
  });
  return sockets;
}

async function typeAndJoin(page: Page): Promise<void> {
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ4X");
  await page.locator(".code-entry__join").click();
}

/** The code entry is back: usable, every cell empty, focus in the first one. */
async function backOnEmptyEntry(page: Page): Promise<void> {
  await expect(page.locator(".code-entry")).toBeVisible();
  await expect(page.locator(".code-entry__cell").first()).toBeFocused();
  for (const cell of await page.locator(".code-entry__cell").all())
    await expect(cell).toHaveValue("");
  await expect(page.locator(".code-entry__leave")).toBeHidden();
  await expect(page.locator(".code-entry__status")).toHaveText("");
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

async function expectTargetOf44(page: Page, selector: string): Promise<void> {
  const { width, height, hits } = await target(page, selector);
  expect(width, selector).toBeGreaterThanOrEqual(44);
  expect(height, selector).toBeGreaterThanOrEqual(44);
  expect(hits, selector).toBe(true);
}

const geometries = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __rv: { rendererInfo(): { geometries: number } | null } }
      ).__rv.rendererInfo()?.geometries ?? 0,
  );

test("Leave in the status bar: viewer.leave and 1000, the scene freed, an empty code entry; joining again works", async ({
  page,
}) => {
  const sockets = await relay(page, true);
  await page.goto("/");
  await typeAndJoin(page);
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect.poll(() => geometries(page)).toBe(2);
  const leave = page.locator(".status-bar__leave");
  await expect(leave).toHaveText("Leave");
  await expectTargetOf44(page, ".status-bar__leave");
  expect(await contrast(page, ".status-bar")).toEqual([]);

  await leave.click();
  await backOnEmptyEntry(page);
  await expect(page.locator(".viewer")).toBeHidden();
  await expect.poll(() => sockets[0]!.closeCode).toBe(1000);
  expect(sockets[0]!.types.at(-1)).toBe("viewer.leave");
  await expect.poll(() => geometries(page)).toBe(0); // the model was disposed (FR-45)

  await typeAndJoin(page);
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  expect(sockets).toHaveLength(2);
});

test("Leave on the code entry while waiting for the presenter (installed app: no other way out)", async ({
  page,
}) => {
  const sockets = await relay(page, false);
  await page.goto("/");
  await typeAndJoin(page);
  await expect(page.locator(".code-entry__status")).toHaveText("Waiting for the presenter");
  const leave = page.locator(".code-entry__leave");
  await expect(leave).toHaveText("Leave session");
  await expectTargetOf44(page, ".code-entry__leave");
  expect(await contrast(page, ".code-entry")).toEqual([]);

  await leave.click();
  await backOnEmptyEntry(page);
  await expect.poll(() => sockets[0]!.closeCode).toBe(1000);
  expect(sockets[0]!.types.at(-1)).toBe("viewer.leave");
});

test("Leave while reconnecting cancels the pending retry: no socket opens afterwards", async ({
  page,
}) => {
  await page.clock.install(); // runs in real time until paused
  const sockets = await relay(page, false);
  await page.goto("/");
  await typeAndJoin(page);
  await expect(page.locator(".code-entry__status")).toHaveText("Waiting for the presenter");
  // Paused before the drop: the backoff retry (0.25–0.5 s) cannot fire before the click, only in `runFor` below.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  await sockets[0]!.ws.close({ code: 1011, reason: "" }); // the relay drops the socket
  await expect(page.locator(".code-entry__status")).toHaveText("Reconnecting…");
  expect(sockets).toHaveLength(1); // no retry yet

  await page.locator(".code-entry__leave").click();
  await backOnEmptyEntry(page);
  await page.clock.runFor(60_000);
  expect(sockets).toHaveLength(1);
});
