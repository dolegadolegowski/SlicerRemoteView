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

interface IwerInput {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  updateButtonValue(id: string, value: number): void;
  updatePinchValue(value: number): void;
}
interface Iwer {
  activeSession?: { end(): Promise<void> };
  primaryInputMode: "controller" | "hand";
  controllers: { left: IwerInput; right: IwerInput };
  hands: { left: IwerInput; right: IwerInput };
}

/** A Quest 3 (or `model`) emulated by IWER before the page runs, and the relay's CSP on the page itself. */
async function quest3(
  page: Page,
  model: "metaQuest3" | "metaQuest2" = "metaQuest3",
): Promise<void> {
  await page.addInitScript({ path: IWER });
  await page.addInitScript((name) => {
    const iwer = (window as unknown as { IWER: Record<string, unknown> }).IWER as {
      XRDevice: new (config: unknown) => Iwer;
    } & Record<string, unknown>;
    const device = new iwer.XRDevice(iwer[name]) as Iwer & {
      installRuntime(o: object): void;
    };
    device.installRuntime({ forceInstall: true }); // headless Chromium has a native `navigator.xr`
    (window as unknown as { __iwer: Iwer }).__iwer = device;
  }, model);
  await page.route(/\/(j)?(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": RELAY_CSP },
    });
  });
}

/**
 * The newest socket of a relay stand-in that joins and streams the 2-node fixture as snapshot 1; a join after the first
 * (a rejoin) is answered once `rejoin` resolves.
 */
async function relayWithSocket(
  page: Page,
  rejoin: Promise<void> = Promise.resolve(),
): Promise<() => WebSocketRoute> {
  let latest: WebSocketRoute | null = null;
  let joins = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    latest = ws;
    ws.onMessage(async (frame) => {
      const message = JSON.parse(String(frame)) as { type: string; id?: string };
      if (message.type === "ping") sendJson(ws, { type: "pong", replyTo: message.id });
      if (message.type !== "viewer.join") return;
      if (joins++ > 0) await rejoin;
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

/** The stage's position and uniform scale in the room (the `__rv.xrStage()` test hook). */
const stage = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __rv: { xrStage(): number[] | null } }).__rv.xrStage()!;
    return { x: m[12]!, y: m[13]!, z: m[14]!, scale: Math.hypot(m[0]!, m[1]!, m[2]!) };
  });
const controller = (page: Page, hand: "left" | "right", action: string, ...args: number[]) =>
  page.evaluate(
    ([h, a, rest]) => {
      const input = (window as unknown as { __iwer: Iwer }).__iwer.controllers[
        h as "left" | "right"
      ];
      if (a === "move") input.position.set(rest[0]!, rest[1]!, rest[2]!);
      else input.updateButtonValue(a, rest[0]!);
    },
    [hand, action, args] as const,
  );
const where = (page: Page, hand: "left" | "right") =>
  page.evaluate((h) => {
    const p = (window as unknown as { __iwer: Iwer }).__iwer.controllers[h as "left" | "right"]
      .position;
    return { x: p.x, y: p.y, z: p.z };
  }, hand);

test("grabbing (WEB-20): one controller moves the scene, two scale it up to 5×, the grip button puts it back", async ({
  page,
}) => {
  await quest3(page);
  await joinAndView(page);
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  await expect.poll(async () => (await stage(page)).z).toBeLessThan(-0.5); // placed in front
  const placed = await stage(page);
  expect(placed.scale).toBeCloseTo(1, 6);

  // One hand: trigger, 20 cm to the right, release.
  const right = await where(page, "right");
  await controller(page, "right", "trigger", 1);
  await page.waitForTimeout(100);
  await controller(page, "right", "move", right.x + 0.2, right.y, right.z);
  await expect.poll(async () => (await stage(page)).x - placed.x).toBeCloseTo(0.2, 3);
  await controller(page, "right", "trigger", 0);
  await page.waitForTimeout(100);
  await controller(page, "right", "move", right.x, right.y, right.z);
  await page.waitForTimeout(200);
  expect((await stage(page)).x - placed.x).toBeCloseTo(0.2, 3); // let go: it stays

  // Two hands: both triggers, each hand 1.5 m out at once (0.5 m → 3.5 m apart: 7× uncapped, never 5× on the way)
  // — larger, but never above 5×.
  const left = await where(page, "left");
  await controller(page, "left", "trigger", 1);
  await controller(page, "right", "trigger", 1);
  await page.waitForTimeout(100);
  await page.evaluate(
    ([l, r]) => {
      const iwer = (window as unknown as { __iwer: Iwer }).__iwer;
      iwer.controllers.left.position.set(l.x - 1.5, l.y, l.z);
      iwer.controllers.right.position.set(r.x + 1.5, r.y, r.z);
    },
    [left, right] as const,
  );
  await expect.poll(async () => (await stage(page)).scale).toBeCloseTo(5, 3);
  await page.waitForTimeout(300);
  expect((await stage(page)).scale).toBeCloseTo(5, 3); // settled there
  await controller(page, "left", "trigger", 0);
  await controller(page, "right", "trigger", 0);

  // The grip button: back in front, real size.
  await controller(page, "left", "squeeze", 1);
  await expect.poll(async () => (await stage(page)).scale).toBeCloseTo(1, 6);
  const back = await stage(page);
  expect([back.x, back.y, back.z].map((v) => v.toFixed(4))).toEqual(
    [placed.x, placed.y, placed.z].map((v) => v.toFixed(4)),
  );
});

test("a pinching hand drags the scene by its wrist (WEB-20)", async ({ page }) => {
  await quest3(page);
  await page.addInitScript(() => {
    (window as unknown as { __iwer: Iwer }).__iwer.primaryInputMode = "hand";
  });
  await joinAndView(page);
  await page.locator(".viewer__xr").click();
  await expect.poll(async () => (await stage(page)).z).toBeLessThan(-0.5);
  const placed = await stage(page);
  const start = await page.evaluate(() => {
    const p = (window as unknown as { __iwer: Iwer }).__iwer.hands.right.position;
    return { x: p.x, y: p.y, z: p.z };
  });
  await page.evaluate(() =>
    (window as unknown as { __iwer: Iwer }).__iwer.hands.right.updatePinchValue(1),
  );
  await page.waitForTimeout(100);
  await page.evaluate(
    (p) =>
      (window as unknown as { __iwer: Iwer }).__iwer.hands.right.position.set(p.x, p.y + 0.15, p.z),
    start,
  );
  await expect.poll(async () => (await stage(page)).y - placed.y).toBeCloseTo(0.15, 3);
  expect((await stage(page)).scale).toBeCloseTo(1, 6);
});

/** Text the page draws on canvases (the XR panel is a canvas texture): recorded from `fillText`. */
async function recordCanvasText(page: Page): Promise<() => Promise<string>> {
  await page.addInitScript(() => {
    const texts: string[] = [];
    (window as unknown as { __texts: string[] }).__texts = texts;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      texts.push(String(text));
      return fillText.call(this, text, ...rest);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __texts: string[] }).__texts.join(" "));
}

test("on a Quest 2 a scene above its budget gets a warning in the headset (WEB-20, §7.5)", async ({
  page,
}) => {
  await quest3(page, "metaQuest2");
  const drawn = await recordCanvasText(page);
  await joinAndView(page); // the fixture is not prepared with the quest2 profile
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", /ar|vr/);
  await expect.poll(drawn).toContain("not prepared for Quest 2"); // a small scene from the mobile profile
});

test("on a Quest 3 the same scene gets no warning", async ({ page }) => {
  await quest3(page);
  const drawn = await recordCanvasText(page);
  await joinAndView(page);
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  await expect.poll(async () => (await stage(page)).z).toBeLessThan(-0.5); // placed: a warning would be up now
  expect(await drawn()).not.toContain("Quest 2");
});

/** How many text panels the headset shows (test hook, WEB-23). */
const panels = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rv: { xrPanels(): number } }).__rv.xrPanels());

test("the headset's status line says 'Reconnecting…' while the link is down; the rejoin clears it (WEB-23)", async ({
  page,
}) => {
  await quest3(page);
  const drawn = await recordCanvasText(page);
  let rejoin = () => {};
  const socket = await relayWithSocket(page, new Promise<void>((resolve) => (rejoin = resolve)));
  await page.goto("/");
  await join(page);
  await page.locator(".viewer__xr").click();
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar");
  await expect.poll(async () => (await stage(page)).z).toBeLessThan(-0.5); // placed: a panel would be up now
  expect(await panels(page)).toBe(0); // all is well: nothing to say
  await socket().close(); // the network drops
  await expect(page.locator(".status-bar__connection")).toHaveText("Reconnecting…");
  await expect.poll(drawn).toContain("Reconnecting…");
  expect(await panels(page)).toBe(1);
  rejoin();
  await expect(page.locator(".status-bar__connection")).toHaveText("Connected");
  await expect.poll(() => panels(page)).toBe(0);
  await expect(page.locator(".viewer")).toHaveAttribute("data-xr", "ar"); // in XR all along
});
