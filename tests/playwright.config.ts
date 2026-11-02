// One Playwright configuration for every suite (QA-02). Browser projects (`e2e/`) emulate the two phone classes
// the product targets plus a desktop Chromium; the node-only projects (`security/`, `load/`) drive the relay with
// raw `ws` + `fetch` and use a browser only where a spec asks for `page` (GLB fuzzing). Every spec starts its own
// relay through `harness/fixtures.ts` on 127.0.0.1 — never a remote host — so suites run in parallel and each
// relay's per-IP limits start empty.
//
// Playwright 1.60.0 is pinned like web-viewer's (its browser builds Chromium 1223 / WebKit 2287 are the ones
// `npx playwright install chromium webkit` fetches for this version). `iPhone 15` is WebKit, not Safari: iOS
// behaviour stays a manual device check (docs/testing/web.md). `Pixel 7` is Chromium with software WebGL
// (SwiftShader) so WebGL 2 works headless — the same flags as web-viewer/playwright.config.ts.

import { defineConfig, devices } from "@playwright/test";

const swiftShader = {
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl"],
};

export default defineConfig({
  globalSetup: "./harness/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  // No HTML report and no traces in CI: both record step titles and request headers (`Type "<code>"`, the
  // `/j#<code>` navigation, `Authorization: Bearer <viewerToken>`), and CI uploads its artefacts — NFR-12 keeps
  // codes and tokens out of every file CI produces. Locally a failing test keeps its trace (git-ignored).
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  use: {
    trace: process.env["CI"] ? "off" : "retain-on-failure",
  },
  projects: [
    { name: "iphone15", testDir: "e2e", use: { ...devices["iPhone 15"] } },
    {
      name: "pixel7",
      testDir: "e2e",
      use: { ...devices["Pixel 7"], launchOptions: swiftShader },
    },
    {
      name: "desktop-chromium",
      testDir: "e2e",
      // The desktop project only proves the stack boots; device behaviour is the phone projects' job.
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions: swiftShader },
    },
    {
      name: "security",
      testDir: "security",
      use: { ...devices["Desktop Chrome"], launchOptions: swiftShader },
    },
    { name: "load-smoke", testDir: "load", testMatch: /smoke\.spec\.ts/, timeout: 300_000 },
    { name: "load-full", testDir: "load", testMatch: /full\.spec\.ts/, timeout: 1_800_000 },
  ],
});
