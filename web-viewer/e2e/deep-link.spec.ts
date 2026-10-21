// Deep link `/j#CODE` (WEB-11; FR-36, US-07, NFR-15, T6): the QR opens `/j#<code>`; the viewer must take the code out of
// the address bar and history before it opens the WebSocket, join with it, and never put it into a request.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface Seen {
  /** `location.href` at the moment the page constructed each WebSocket. */
  readonly hrefAtSocket: string[];
}

/** Records, inside the page, where the address bar was when a WebSocket was created. */
async function watchSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: Seen }).__seen = { hrefAtSocket: seen };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        seen.push(location.href);
        super(url, protocols);
      }
    };
  });
}

/** A relay stand-in that records the first frame (`viewer.join`) and answers nothing else. */
async function recordJoin(page: Page): Promise<string[]> {
  const frames: string[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => ws.onMessage((m) => frames.push(String(m))));
  return frames;
}

const webgl2 = (page: Page) =>
  page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
const cells = (page: Page) =>
  page
    .locator(".code-entry__cell")
    .evaluateAll((all) => all.map((c) => (c as HTMLInputElement).value).join(""));
const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: Seen }).__seen.hrefAtSocket);

test("opening /j#7kq4x joins with 7KQ4X; the address bar shows /j before the socket opens", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const frames = await recordJoin(page);
  await watchSockets(page); // after the route: it wraps the routed WebSocket
  await page.goto("/j#7kq4x");
  await expect(page).toHaveURL(/\/j$/);
  expect(await cells(page)).toBe("7KQ4X"); // in the cells: Join retries if the join fails
  if (await webgl2(page)) {
    await expect.poll(() => frames.length).toBe(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
    expect((await seen(page)).map((href) => new URL(href).pathname + new URL(href).hash)).toEqual([
      "/j",
    ]);
  } else {
    // headless WebKit on Linux may lack WebGL 2: Join is refused up front, the URL is cleaned all the same
    await expect(page.locator(".code-entry__message")).toContainText("3D");
    expect(await seen(page)).toEqual([]);
  }
  expect(requests.filter((url) => /7KQ4X/i.test(url))).toEqual([]);
});

test("/j#7KQ0X shows the code entry with the 0/O hint and does not connect", async ({ page }) => {
  await watchSockets(page);
  await page.goto("/j#7KQ0X");
  await expect(page).toHaveURL(/\/j$/);
  await expect(page.locator(".code-entry__message")).toContainText("0 or O");
  await expect(page.locator(".code-entry__join")).toBeDisabled();
  expect(await seen(page)).toEqual([]);
});

test("opened as a new page (the QR path), the deep link adds no history entry and leaves no fragment", async ({
  page,
}) => {
  await recordJoin(page);
  await page.goto("/");
  const before = await page.evaluate(() => history.length);
  const marker = await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  await page.goto("/j#7KQ4X"); // another path: a new document, like a camera app opening the link
  expect(
    await page.evaluate(() => (window as unknown as { marker?: number }).marker),
  ).toBeUndefined();
  expect(marker).toBe(1);
  await expect(page).toHaveURL(/\/j$/);
  expect(await page.evaluate(() => history.length)).toBe(before + 1); // the load only, not the rewrite
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/j$/); // the entry itself was rewritten
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("/j without a code is the plain code entry and joins nothing", async ({ page }) => {
  const frames = await recordJoin(page);
  await page.goto("/j");
  await expect(page).toHaveURL(/\/j$/);
  await expect(page.locator(".code-entry__join")).toBeDisabled();
  expect(await cells(page)).toBe("");
  await expect(page.locator(".code-entry__message")).toBeHidden(); // no "link has no valid code"
  expect(frames).toEqual([]);
});

test("a link opened again in the same tab (fragment only, no reload) is taken the same way", async ({
  page,
}) => {
  const frames = await recordJoin(page);
  await page.goto("/j");
  test.skip(
    !(await webgl2(page)),
    "no WebGL 2 in this headless browser, so Join is refused up front",
  );
  await page.evaluate(() => (location.hash = "#7kq4x")); // what pasting /j#7kq4x into the address bar does
  await expect(page).toHaveURL(/\/j$/);
  await expect.poll(() => frames.length).toBe(1);
  expect(JSON.parse(frames[0]!)).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
});
