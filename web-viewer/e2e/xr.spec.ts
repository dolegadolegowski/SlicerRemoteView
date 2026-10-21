// WebXR mode (WEB-19; FR-47, NFR-09, ADR 0003/0006, research web-xr.md). Meta's IWER emulates a Quest 3 in the page
// (`navigator.xr` and its Quest Browser user agent), so the button, the session, the controller and hand models and
// the way back run headless. The page is served with the relay's CSP (ADR 0006 §4): controller models must load
// from the self-hosted `/assets/xr-profiles-<version>/` only, their textures included, under `connect-src 'self'`.

import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { settled } from "./canvas";
import { fixture, join, joinAndView, sendJson, streamSnapshot } from "./fake-relay";

const require = createRequire(import.meta.url);
const IWER = require.resolve("iwer/build/iwer.min.js");
/** Where the build puts the input profiles (scripts/copy-xr-profiles.mjs). */
const PROFILES = `/assets/xr-profiles-${(require("@webxr-input-profiles/assets/package.json") as { version: string }).version}/`;
/** The relay's Content-Security-Policy (relay-server README, SRV-16), with `ws:` for this plain-HTTP preview. */
const RELAY_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' data:;form-action 'self';frame-ancestors 'none';" +
  "img-src 'self' data: blob:;object-src 'none';script-src 'self';script-src-attr 'none';" +
  "style-src 'self' 'unsafe-inline';connect-src 'self' ws: wss:;worker-src 'self' blob:";

interface Iwer {
  activeSession?: { end(): Promise<void> };
  primaryInputMode: "controller" | "hand";
}

/** A Quest 3 (IWER) before the page runs, and the relay's CSP on the page itself. */
async function quest3(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER });
  await page.addInitScript(() => {
    const iwer = (
      window as unknown as {
        IWER: { XRDevice: new (config: unknown) => Iwer; metaQuest3: unknown };
      }
    ).IWER;
    const device = new iwer.XRDevice(iwer.metaQuest3) as Iwer & {
      installRuntime(o: object): void;
    };
    device.installRuntime({ forceInstall: true }); // headless Chromium has a native `navigator.xr`
    (window as unknown as { __iwer: Iwer }).__iwer = device;
  });
  await page.route(/\/(j)?(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": RELAY_CSP },
    });
  });
}

/** The newest socket of a relay stand-in that joins and streams the 2-node fixture as snapshot 1. */
async function relayWithSocket(page: Page): Promise<() => WebSocketRoute> {
  let latest: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    latest = ws;
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as { type: string; id?: string };
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
      streamSnapshot(ws, fixture("asymmetric-2nodes.glb"));
    });
  });
  return () => latest!;
}

/** `requestAnimationFrame` calls of the page since the last read (the 2D viewer draws only on demand, FR-39). */
const rafCalls = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __raf: number };
    const n = w.__raf;
    w.__raf = 0;
    return n;
  });

async function countRaf(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __raf: number };
    w.__raf = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      w.__raf++;
      return native(callback);
    };
  });
}

const info = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __rv: { rendererInfo(): { geometries: number; textures: number } | null };
        }
      ).__rv.rendererInfo() ?? { geometries: 0, textures: 0 },
  );

test("on a Quest 3 the viewer offers AR; the controllers' models come from the self-hosted profiles under the relay's CSP; the 2D view comes back", async ({
  page,
}) => {
  await quest3(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const errors: string[] = [];
  page.on("console", (message) => {
    // Errors, and three.js warnings such as "Can't change size while VR device is presenting".
    if (message.type() === "error" || message.text().startsWith("THREE."))
      errors.push(message.text());
  });
  await countRaf(page);
  page.on("pageerror", (error) => errors.push(error.message));
  await joinAndView(page);
  const button = page.locator(".viewer__xr");
  await expect(button).toHaveText("View in AR");
  const before = await info(page);
  const view = await settled(page);

  await button.click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  // Both controllers' models with their textures (an image each, loaded through <img>, not fetch(blob:)).
  await expect
    .poll(async () => (await info(page)).textures, { timeout: 15_000 })
    .toBeGreaterThan(before.textures);
  const xrAssets = requests.filter((url) => new URL(url).pathname.startsWith(PROFILES));
  expect(xrAssets.map((url) => new URL(url).pathname.slice(PROFILES.length))).toEqual(
    expect.arrayContaining([
      "profilesList.json",
      "meta-quest-touch-plus/profile.json",
      "meta-quest-touch-plus/left.glb",
      "meta-quest-touch-plus/right.glb",
    ]),
  );
  const origin = new URL(page.url()).origin;
  expect(
    requests.filter((url) => !/^(data|blob):/.test(url) && new URL(url).origin !== origin),
  ).toEqual([]);

  await page.evaluate(() => (window as unknown as { __iwer: Iwer }).__iwer.activeSession?.end());
  await expect(page.locator(".viewer")).not.toHaveAttribute("data-xr", /.*/);
  await expect(button).toBeEnabled();
  // The 2D view as it was: camera, clip planes, background and the millimetre stage restored.
  await expect.poll(async () => (await settled(page)).equals(view)).toBe(true);
  // And idle again: no animation loop left running after the session (render on demand, FR-39).
  await rafCalls(page);
  await page.waitForTimeout(1_000);
  expect(await rafCalls(page)).toBe(0);
  expect(errors.filter((text) => !/IWER|Download the React DevTools/.test(text))).toEqual([]);
});

test("hands get the self-hosted hand meshes", async ({ page }) => {
  await quest3(page);
  await page.addInitScript(() => {
    (window as unknown as { __iwer: Iwer }).__iwer.primaryInputMode = "hand";
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await joinAndView(page);
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  await expect
    .poll(() => requests.filter((path) => path.endsWith(".glb")).sort())
    .toEqual([`${PROFILES}generic-hand/left.glb`, `${PROFILES}generic-hand/right.glb`]);
});

test("a new snapshot during XR stands in front of the user, and the 2D view is fitted to it afterwards", async ({
  page,
}) => {
  await quest3(page);
  const socket = await relayWithSocket(page);
  await page.goto("/");
  await join(page);
  const fresh = await settled(page); // a fit from the front, as after any new snapshot
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  streamSnapshot(socket(), fixture("asymmetric-2nodes.glb"), 2); // the presenter shares the scene again
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
  await page.evaluate(() => (window as unknown as { __iwer: Iwer }).__iwer.activeSession?.end());
  await expect(page.locator(".viewer")).not.toHaveAttribute("data-xr", /.*/);
  // Fitted with the 2D field of view, not the headset's (three restores it before the viewer refits).
  await expect.poll(async () => (await settled(page)).equals(fresh)).toBe(true);
});

test("the end of the presentation during XR takes the user out of XR, to the message", async ({
  page,
}) => {
  await quest3(page);
  const socket = await relayWithSocket(page);
  await page.goto("/");
  await join(page);
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  await socket().close({ code: 4001, reason: "" }); // the presenter closed the session
  await expect(page.locator(".code-entry__message")).toContainText("Presentation ended");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __iwer: Iwer }).__iwer.activeSession ?? null),
    )
    .toBeNull();
  await expect(page.locator(".viewer")).not.toHaveAttribute("data-xr", /.*/);
});

test("on a narrow window the XR button stays clear of Fit and the node panel's toggle", async ({
  page,
}) => {
  await quest3(page);
  await page.addInitScript(() => localStorage.setItem("rv.lang", "pl")); // the longer labels
  await page.setViewportSize({ width: 412, height: 800 });
  await joinAndView(page);
  const boxes = await Promise.all(
    [".viewer__xr", ".viewer__fit", ".node-panel__toggle"].map(async (s) => {
      await expect(page.locator(s)).toBeVisible();
      return (await page.locator(s).boundingBox())!;
    }),
  );
  const [xr, ...others] = boxes as [NonNullable<(typeof boxes)[0]>, ...typeof boxes];
  for (const other of others) {
    const apart =
      xr.x + xr.width <= other!.x ||
      other!.x + other!.width <= xr.x ||
      xr.y + xr.height <= other!.y ||
      other!.y + other!.height <= xr.y;
    expect(apart).toBe(true);
  }
});

test("a phone gets no XR button, even with WebXR AR available", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __ua: string }).__ua = navigator.userAgent;
  });
  await quest3(page); // navigator.xr supports immersive-ar …
  await page.addInitScript(() => {
    // … but the browser is the phone's own (IWER made the property configurable).
    Object.defineProperty(navigator, "userAgent", {
      value: (window as unknown as { __ua: string }).__ua,
      configurable: true,
    });
  });
  await joinAndView(page);
  await expect(page.locator(".viewer__fit")).toBeVisible();
  expect(await page.evaluate(() => navigator.xr?.isSessionSupported("immersive-ar"))).toBe(true);
  await page.waitForTimeout(500); // the support check is asynchronous; a Quest gets its button within it
  await expect(page.locator(".viewer__xr")).toHaveCount(0);
});
