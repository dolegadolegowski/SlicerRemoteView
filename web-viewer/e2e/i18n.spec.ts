// Language switch (WEB-21; FR-51, NFR-33, CLAUDE.md rule 6): the toggle re-renders the visible texts without a reload
// (the session stays), keeps `<html lang>` in step, and the choice is the only thing the viewer ever stores.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contrast, expectTargetOf44 } from "./a11y";
import { fakeRelay, join, joinAndView } from "./fake-relay";

const storage = (page: Page) =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.keys(sessionStorage),
  }));

test.use({ locale: "en-US" });

test("switching to Polish over the scene re-renders the texts, keeps the session and stores only the language", async ({
  page,
}) => {
  const relay = await joinAndView(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".status-bar__connection")).toHaveText("Connected");
  const toggle = page.locator(".status-bar__lang");
  await expect(toggle).toHaveText("Polski");
  await expect(toggle).toHaveAttribute("lang", "pl");
  await expectTargetOf44(page, ".status-bar__lang");
  expect(await contrast(page, ".status-bar")).toEqual([]);

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  await expect(page.locator(".status-bar__connection")).toHaveText("Połączono");
  await expect(page.locator(".status-bar__viewers")).toHaveText("Widzowie: 1");
  await expect(page.locator(".status-bar__leave")).toHaveText("Wyjdź");
  await expect(page.locator(".node-panel__toggle")).toHaveText("Struktury (2)");
  await expect(page.locator(".viewer__fit")).toHaveText("Dopasuj widok");
  await expect(toggle).toHaveText("English");
  await expect(toggle).toBeFocused(); // the switch keeps its place
  // Still the same live session: an update arrives and is applied.
  relay.send({ type: "viewer.count", viewerCount: 2, viewerLimit: 20, platforms: { web: 2 } });
  await expect(page.locator(".status-bar__viewers")).toHaveText("Widzowie: 2");

  // The code typed and the session's token are nowhere in storage (rule 6).
  expect(await storage(page)).toEqual({ local: { "rv.lang": "pl" }, session: [] });
});

test("the choice is used on the next visit and can be switched back on the code entry", async ({
  page,
}) => {
  await page.goto("/");
  const toggle = page.locator(".code-entry__lang");
  await expect(toggle).toHaveText("Polski");
  await expectTargetOf44(page, ".code-entry__lang");
  await toggle.click();
  await expect(page.locator(".code-entry h1")).toHaveText("Dołącz do sesji");
  await expect(page.locator(".code-entry__join")).toHaveText("Dołącz");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  await expect(page.locator(".code-entry h1")).toHaveText("Dołącz do sesji");
  // A hint shown in Polish follows the switch back to English.
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7KQ0X");
  await expect(page.locator(".code-entry__message")).toContainText("0 ani O");
  await page.locator(".code-entry__lang").click();
  await expect(page.locator(".code-entry__message")).toContainText("never contain 0 or O");
  await expect(page.locator(".code-entry h1")).toHaveText("Join a session");
  expect(await contrast(page, ".code-entry")).toEqual([]);
  expect(await storage(page)).toEqual({ local: { "rv.lang": "en" }, session: [] });
});

test("a scene joined after switching on the code entry opens in the chosen language", async ({
  page,
}) => {
  await fakeRelay(page);
  await page.goto("/");
  await page.locator(".code-entry__lang").click();
  await join(page);
  await expect(page.locator(".viewer__fit")).toHaveText("Dopasuj widok");
  await expect(page.locator(".viewer__canvas")).toHaveAttribute("aria-label", /^Scena 3D/);
  await expect(page.locator(".status-bar__connection")).toHaveText("Połączono");
  await expect(page.locator(".status-bar__lang")).toHaveText("English");
});
