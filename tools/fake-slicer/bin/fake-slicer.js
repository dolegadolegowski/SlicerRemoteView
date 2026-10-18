#!/usr/bin/env node
// Tracked shim so `npm install` can link the bin before the first build (dist/ is git-ignored).
try {
  await import("../dist/cli.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.error("fake-slicer is not built yet — run `npm run build` from the repository root.");
  process.exitCode = 1;
}
