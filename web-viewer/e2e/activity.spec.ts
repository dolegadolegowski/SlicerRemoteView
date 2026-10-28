// Activity line (WEB-24): the relay-wide counts of `/healthz` (§10, SRV-31) under the code entry while no session is
// live, joining or retrying. `/healthz` is not part of the preview server (it falls through to `index.html`, and the
// line stays hidden): each test here answers it.

import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { sendJson } from "./fake-relay";

const HEALTH = { status: "ok", uptimeS: 60, sessions: 3, viewers: 12, version: "0.1.0" };
const line = (page: Page) => page.locator(".code-entry__activity");

/** Answers `/healthz` with the next of `bodies` (the last one again when they run out); returns the reads. */
async function healthz(page: Page, bodies: { status?: number; json: object }[]) {
  const reads: { url: string; method: string; cookie: string | undefined }[] = [];
  await page.route("**/healthz", async (route) => {
    const request = route.request();
    reads.push({
      url: request.url(),
      method: request.method(),
      cookie: (await request.allHeaders())["cookie"],
    });
    await route.fulfill(bodies.length > 1 ? bodies.shift()! : bodies[0]!);
  });
  return reads;
}

/**
 * A relay that joins every `viewer.join` and then waits for the presenter's scene (the busy code entry with Leave
 * stays). It ignores `ping`, so a joined page's heartbeat drops the socket after ≈ 25 s and the viewer retries.
 * Returns the sockets, newest last.
 */
async function waitingRelay(page: Page): Promise<WebSocketRoute[]> {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as { type: string; id?: string };
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
    });
  });
  return sockets;
}

async function typeAndJoin(page: Page): Promise<void> {
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ4X");
  await page.locator(".code-entry__join").click();
  await expect(page.locator(".code-entry__leave")).toBeVisible();
}

test.describe("activity line (WEB-24)", () => {
  test("the home page shows how many sessions are open and how many viewers use them; nothing scrolls", async ({
    page,
    baseURL,
  }) => {
    // A cookie of this origin, which the read must not carry (`credentials: "omit"`).
    await page.context().addCookies([{ name: "probe", value: "1", url: baseURL! }]);
    const reads = await healthz(page, [{ json: HEALTH }]);
    await page.goto("/");
    await expect(line(page)).toHaveText("Active sessions: 3 · Viewers: 12");
    expect(reads).toEqual([
      { url: new URL("/healthz", page.url()).href, method: "GET", cookie: undefined },
    ]);
    expect(await line(page).evaluate((el) => el.parentElement?.lastElementChild === el)).toBe(true);
    // `#app` is the scroller (html and body do not scroll): the form with the line fits the phone (WEB-03).
    const overflow = await page.evaluate(() => {
      const app = document.getElementById("app")!;
      return { x: app.scrollWidth > app.clientWidth, y: app.scrollHeight > app.clientHeight };
    });
    expect(overflow).toEqual({ x: false, y: false });
  });

  test("gone when the relay stops giving counts (a draining 503 on the next read)", async ({
    page,
  }) => {
    await page.clock.install();
    await healthz(page, [
      { json: HEALTH },
      { status: 503, json: { ...HEALTH, status: "draining" } },
    ]);
    await page.goto("/");
    await expect(line(page)).toBeVisible();
    await page.clock.runFor(30_000);
    await expect(line(page)).toBeHidden();
  });

  test("hidden while a session is joined, waited for or retried; read afresh after Leave", async ({
    page,
  }) => {
    await page.clock.install();
    const reads = await healthz(page, [
      { json: HEALTH },
      { json: { ...HEALTH, sessions: 1, viewers: 4 } },
    ]);
    const sockets = await waitingRelay(page);
    await page.goto("/");
    await expect(line(page)).toHaveText("Active sessions: 3 · Viewers: 12");
    await typeAndJoin(page);
    await expect(line(page)).toBeHidden(); // a relay-wide "Viewers" would read like this session's
    // The relay ignores `ping`: within 90 s the heartbeat drops the socket and the viewer joins again (WEB-14) — the
    // retried states keep the line away too.
    await page.clock.runFor(90_000);
    expect(sockets.length).toBeGreaterThan(1);
    await expect(line(page)).toBeHidden();
    expect(reads).toHaveLength(1);
    await page.locator(".code-entry__leave").click();
    await expect(line(page)).toHaveText("Active sessions: 1 · Viewers: 4"); // at once, not the old counts
    expect(reads).toHaveLength(2);
  });

  test("back at once with fresh counts when the presenter ends the session (4001)", async ({
    page,
  }) => {
    const reads = await healthz(page, [
      { json: HEALTH },
      { json: { ...HEALTH, sessions: 2, viewers: 13 } },
    ]);
    const sockets = await waitingRelay(page);
    await page.goto("/");
    await expect(line(page)).toBeVisible();
    await typeAndJoin(page);
    await expect(line(page)).toBeHidden();
    const ws = sockets.at(-1)!;
    sendJson(ws, {
      type: "session.closed",
      sessionId: "sess_E2E0000000000000",
      reason: "PUBLISHER_CLOSED",
    });
    await ws.close({ code: 4001 });
    await expect(page.locator(".code-entry__leave")).toBeHidden();
    await expect(line(page)).toHaveText("Active sessions: 2 · Viewers: 13");
    expect(reads).toHaveLength(2);
  });

  test("on the idle entry, back from the cache it reads afresh; a later Leave still brings it back", async ({
    page,
  }) => {
    const reads = await healthz(page, [
      { json: HEALTH },
      { json: { ...HEALTH, sessions: 2, viewers: 5 } },
      { json: { ...HEALTH, sessions: 1, viewers: 4 } },
    ]);
    await waitingRelay(page);
    await page.goto("/");
    await expect(line(page)).toHaveText("Active sessions: 3 · Viewers: 12");
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect(line(page)).toBeHidden(); // no read on its way into the cache
    expect(reads).toHaveLength(1);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(line(page)).toHaveText("Active sessions: 2 · Viewers: 5");
    expect(reads).toHaveLength(2);
    // Not stuck in "being left": a session and its Leave work as before.
    await typeAndJoin(page);
    await expect(line(page)).toBeHidden();
    await page.locator(".code-entry__leave").click();
    await expect(line(page)).toHaveText("Active sessions: 1 · Viewers: 4");
    expect(reads).toHaveLength(3);
  });

  test("no read while the page is being left (bfcache, WEB-14), nor for a page that joins from a link", async ({
    page,
  }) => {
    const reads = await healthz(page, [{ json: HEALTH }]);
    const sockets = await waitingRelay(page);
    await page.goto("/");
    await expect(line(page)).toBeVisible();
    await typeAndJoin(page);
    // `pagehide` makes Reconnect leave the session (back on the idle code entry), and a read started then would keep
    // Chromium from caching the page. Restored, it joins by the code again: still no line, still no read.
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect(page.locator(".code-entry__leave")).toBeHidden();
    await expect(line(page)).toBeHidden();
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(page.locator(".code-entry__leave")).toBeVisible();
    expect(sockets).toHaveLength(2);
    expect(reads).toHaveLength(1);

    // A QR link joins as the page loads: the line never starts, so nothing is read (and aborted) for it.
    await page.goto("/j#7KQ4X");
    await expect(page.locator(".code-entry__leave")).toBeVisible();
    await expect(line(page)).toBeHidden();
    expect(reads).toHaveLength(1);
  });
});
