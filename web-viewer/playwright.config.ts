import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

// Component E2E runs on emulated devices: `iPhone 15` is WebKit (not Safari — iOS behaviour is verified on a
// device per docs/testing/web.md), `Pixel 7` is Chromium with software WebGL (SwiftShader) so WebGL 2 works
// headless.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "iphone15", use: { ...devices["iPhone 15"] } },
    {
      name: "pixel7",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl"],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse: a leftover preview server would serve a stale dist/.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
