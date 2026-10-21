// No third-party requests (WEB-18; NFR-09, NFR-16 "no third-party scripts", ADR 0006 same origin): from opening the
// page to a live update, every HTTP request and every WebSocket goes to the page's own origin, and the session code
// is in none of their URLs (NFR-15).

import { expect, test } from "@playwright/test";
import { fakeRelay, join } from "./fake-relay";

test("join and view talk only to the page's origin and put the code in no URL", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const relay = await fakeRelay(page);
  // After the route: the page's WebSocket constructor is the routed one, recorded here (routed sockets raise no
  // `websocket` event).
  await page.addInitScript(() => {
    const urls: string[] = [];
    (window as unknown as { __sockets: string[] }).__sockets = urls;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        urls.push(String(url));
      }
    };
  });
  await page.goto("/");
  await join(page); // types 7KQ4X and waits for the model
  relay.send({
    type: "scene.update",
    sceneVersion: 2,
    baseVersion: 1,
    changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
  });
  await page.locator(".node-panel__toggle").click();
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");

  const origin = new URL(page.url()).origin;
  const sockets = await page.evaluate(
    () => (window as unknown as { __sockets: string[] }).__sockets,
  );
  expect(sockets.length).toBeGreaterThan(0);
  for (const url of sockets) expect(new URL(url).host, url).toBe(new URL(origin).host);
  const foreign = requests.filter((url) => {
    const u = new URL(url);
    return u.protocol !== "data:" && u.protocol !== "blob:" && u.origin !== origin;
  });
  expect(foreign).toEqual([]);
  expect(requests.length).toBeGreaterThan(2); // the page, its script and stylesheet at least
  for (const url of [...requests, ...sockets]) expect(url.toUpperCase()).not.toContain("7KQ4X");
});
