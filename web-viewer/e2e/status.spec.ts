// Status bar and device profile (WEB-15; FR-49, US-17; docs/protocol.md §5.1, §5.3). The bar runs on the in-page
// relay of fake-relay.ts; the `clientInfo` cases only answer the join, so they need no WebGL.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixture, joinAndView, sendJson, streamSnapshot } from "./fake-relay";

const QUEST3 =
  "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/136.0.7103.177 VR Safari/537.36";

test("the status bar shows the connection, the viewers and the scene version, and follows viewer.count", async ({
  page,
}) => {
  const relay = await joinAndView(page); // one viewer, snapshot version 1
  const bar = page.locator(".status-bar");
  await expect(bar.locator(".status-bar__connection")).toHaveText("Connected");
  await expect(bar.locator(".status-bar__viewers")).toHaveText("Viewers: 1");
  await expect(bar.locator(".status-bar__version")).toHaveText("Scene v1");
  relay.send({ type: "viewer.count", viewerCount: 4, viewerLimit: 20, platforms: { web: 4 } });
  await expect(bar.locator(".status-bar__viewers")).toHaveText("Viewers: 4");
  relay.send({
    type: "scene.update",
    sceneVersion: 2,
    baseVersion: 1,
    changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
  });
  await expect(bar.locator(".status-bar__version")).toHaveText("Scene v2");
});

test("a late joiner sees the version of the scene.state applied to the snapshot, not the snapshot's (§8.3)", async ({
  page,
}) => {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as Record<string, unknown>;
      if (message["type"] !== "viewer.join") return;
      sendJson(ws, {
        type: "viewer.joined",
        replyTo: message["id"],
        sessionId: "sess_E2E0000000000000",
        viewerId: "vw_e2e",
        viewerToken: `vt_${"A".repeat(43)}`,
        sceneVersion: 5,
        snapshotVersion: 1,
        snapshotAvailable: false,
        publisherOnline: true,
        viewerCount: 2,
        viewerLimit: 20,
        profile: "mobile",
      });
      // The presenter hid the tumour after the snapshot: the state waits for the GLB, then raises the version.
      sendJson(ws, {
        type: "scene.state",
        sceneVersion: 5,
        snapshotVersion: 1,
        nodes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
        removed: [],
      });
      streamSnapshot(ws, fixture("asymmetric-2nodes.glb"), 1);
    });
  });
  await page.goto("/");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ4X");
  await page.locator(".code-entry__join").click();
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v5");
  await page.locator(".node-panel__toggle").click();
  await expect(page.locator('.node-panel__row[data-node-id="vtkMRMLModelNode2"]')).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("the status bar stays inside the safe area of a notched phone (iPhone 15 insets, emulated)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "safe-area insets are emulated over CDP (Chromium)");
  await joinAndView(page);
  const cdp = await page.context().newCDPSession(page);
  // `Emulation.setSafeAreaInsetsOverride` is newer than Playwright's CDP typings, hence the casts.
  const insets = (top: number, right: number, bottom: number, left: number) =>
    cdp.send(
      "Emulation.setSafeAreaInsetsOverride" as never,
      {
        insets: {
          top,
          topMax: top,
          right,
          rightMax: right,
          bottom,
          bottomMax: bottom,
          left,
          leftMax: left,
        },
      } as never,
    );
  await insets(59, 0, 34, 0); // portrait: Dynamic Island and home indicator
  await expect
    .poll(async () => (await page.locator(".status-bar").boundingBox())!.y)
    .toBeGreaterThanOrEqual(59);
  await page.setViewportSize({ width: 852, height: 393 });
  await insets(0, 59, 21, 59); // landscape: the island on a side
  await expect
    .poll(async () => (await page.locator(".status-bar").boundingBox())!.x)
    .toBeGreaterThanOrEqual(59);
  const box = (await page.locator(".status-bar").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(852 - 59);
});

/** Opens the app, joins by code and returns the `viewer.join` the page sent. */
async function joinFrame(page: Page): Promise<Record<string, unknown>> {
  let join: Record<string, unknown> | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as Record<string, unknown>;
      if (message["type"] === "viewer.join") join = message;
    });
  });
  await page.goto("/");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ4X");
  await page.locator(".code-entry__join").click();
  await expect.poll(() => join).toBeDefined();
  return join!;
}

test("a phone reports platform web, profile mobile (§5.1)", async ({ page }) => {
  const join = await joinFrame(page);
  expect(join["clientInfo"]).toMatchObject({
    platform: "web",
    profile: "mobile",
    capabilities: { maxSnapshotBytes: 32 * 1024 * 1024 },
  });
});

test.describe("on Meta Quest Browser", () => {
  test.use({ userAgent: QUEST3 });

  test("a Quest 3 reports platform quest-browser, profile quest3 (§5.1, §7.5)", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Quest Browser is Chromium");
    const join = await joinFrame(page);
    expect(join["clientInfo"]).toMatchObject({
      platform: "quest-browser",
      profile: "quest3",
      capabilities: { maxSnapshotBytes: 64 * 1024 * 1024 }, // the quest3 class (§7.5)
    });
    expect(JSON.stringify(join)).not.toContain("OculusBrowser"); // only the enum values leave the device
  });
});
