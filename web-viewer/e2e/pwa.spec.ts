// PWA and mobile polish (WEB-17; NFR-25, NFR-26, NFR-32; research web.md §2.6): what the built page serves for
// "Add to Home Screen", that no service worker exists, and text contrast of the status line, the status bar and the
// node panel (axe, WCAG 2 AA: 4.5:1).

import { expect, test } from "@playwright/test";
import { contrast } from "./axe";
import { joinAndView } from "./fake-relay";

test("the manifest and its icons are served, and the page links them", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const response = await request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(
    /application\/manifest\+json|application\/json/,
  );
  const manifest = (await response.json()) as {
    icons: { src: string; type: string }[];
    start_url: string;
  };
  expect(manifest.start_url).toBe("/");
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  for (const src of [...manifest.icons.map((i) => i.src), touch!]) {
    const icon = await request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toBe("image/png");
  }
});

test("no service worker is registered, also after joining a session", async ({ page }) => {
  await joinAndView(page);
  expect(
    await page.evaluate(async () =>
      "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    ),
  ).toBe(0);
});

test("text on the code entry has at least 4.5:1 contrast, also with an error and a status shown", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ0X"); // a hint for the 0
  await expect(page.locator(".code-entry__message")).toBeVisible();
  expect(await contrast(page, ".code-entry")).toEqual([]);
});

test("the status bar, the notice line and the node panel have at least 4.5:1 contrast over the scene", async ({
  page,
}) => {
  const relay = await joinAndView(page);
  relay.send({ type: "session.publisherState", online: false, graceEndsAt: Date.now() + 60_000 });
  await expect(page.locator(".status-bar__connection")).toHaveText("Presenter is offline");
  await page.locator(".node-panel__toggle").click();
  relay.send({
    type: "scene.nodeAdded",
    sceneVersion: 2,
    baseVersion: 1,
    nodes: [{ nodeId: "vtkMRMLModelNode9", kind: "model" }],
    snapshotFollows: true,
  });
  await expect(page.locator(".viewer__status")).toHaveText("Updating the scene…");
  expect(await contrast(page, ".viewer__top")).toEqual([]);
  expect(await contrast(page, ".node-panel")).toEqual([]);
});
