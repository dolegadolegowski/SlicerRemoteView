import { defineConfig } from "vitest/config";

// `src/protocol/` must stay free of DOM and three.js (docs/plan/web.md), so its tests run in plain Node;
// UI units run in jsdom. Rendering code is tested with mocked renderers (jsdom has no WebGL).
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "protocol",
          environment: "node",
          include: [
            "test/protocol/**/*.test.ts",
            "test/state/**/*.test.ts",
            "test/i18n/**/*.test.ts",
            "test/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["test/ui/**/*.test.ts", "test/render/**/*.test.ts"],
        },
      },
    ],
  },
});
