import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the sources of `shared/` so `npm test` needs no prior `npm run build -w shared`.
    alias: {
      "@slicerremoteview/shared": fileURLToPath(
        new URL("../../shared/ts/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
