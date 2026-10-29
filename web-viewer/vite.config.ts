import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Dev proxy: the relay (SRV-*) listens on 8787; the viewer derives its WebSocket URL from
// `location` (ADR 0006), so the same code runs behind the proxy and behind the real relay.
const RELAY = "http://localhost:8787";
const PROXY = {
  "/ws": { target: RELAY, ws: true },
  "/api": { target: RELAY },
};

export default defineConfig({
  base: "/",
  resolve: {
    // Use the sources of `shared/` (like tools/fake-slicer) so dev, build and tests need no prior
    // `npm run build -w shared`.
    alias: {
      "@slicerremoteview/shared": fileURLToPath(new URL("../shared/ts/index.ts", import.meta.url)),
    },
  },
  build: {
    // Vite's default (`baseline-widely-available`: Safari/iOS 16.4+, ADR 0002). Stated explicitly so a
    // Vite upgrade cannot move the floor silently.
    target: "baseline-widely-available",
    sourcemap: false,
    // three.js is one ≈ 740 kB (≈ 190 kB gzip) chunk; the real gate is the 1 MiB gzip budget of
    // scripts/check-bundle.mjs (WEB-18, NFR-09), so Vite's 500 kB minified warning is raised to that.
    chunkSizeWarningLimit: 1024,
  },
  // `/healthz` too in dev: the code entry shows the relay's counts (WEB-24). Not in preview, the
  // E2E server: there it falls through to `index.html` and the line stays hidden, unless a spec
  // routes it (e2e/activity.spec.ts); proxied, every page load would log a refused connection.
  server: { proxy: { ...PROXY, "/healthz": { target: RELAY } } },
  preview: { proxy: PROXY },
});
