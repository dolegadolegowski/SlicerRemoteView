import { defineConfig } from "vite";

// Dev proxy: the relay (SRV-*) listens on 8787; the viewer derives its WebSocket URL from
// `location` (ADR 0006), so the same code runs behind the proxy and behind the real relay.
const RELAY = "http://localhost:8787";

export default defineConfig({
  base: "/",
  build: {
    // Vite's default (`baseline-widely-available`: Safari/iOS 16.4+, ADR 0002). Stated explicitly so a
    // Vite upgrade cannot move the floor silently.
    target: "baseline-widely-available",
    sourcemap: false,
  },
  server: {
    proxy: {
      "/ws": { target: RELAY, ws: true },
      "/api": { target: RELAY },
    },
  },
});
