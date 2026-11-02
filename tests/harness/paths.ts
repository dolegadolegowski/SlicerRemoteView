// Repository paths the harness needs; everything is resolved from this file, so the suite runs from any cwd.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, "..");
export const RELAY_DIR = path.join(REPO_ROOT, "relay-server");
export const RELAY_DIST = path.join(RELAY_DIR, "dist");
export const VIEWER_DIST = path.join(REPO_ROOT, "web-viewer", "dist");
export const FAKE_SLICER_BIN = path.join(REPO_ROOT, "tools", "fake-slicer", "bin", "fake-slicer.js");
export const FAKE_SLICER_DIST = path.join(REPO_ROOT, "tools", "fake-slicer", "dist", "index.js");
export const FIXTURES_DIR = path.join(REPO_ROOT, "shared", "fixtures", "glb");
export const FIXTURE_MANIFEST = path.join(FIXTURES_DIR, "manifest.json");
/** Git-ignored working area: the staged relay (stage.ts) and generated fixtures. */
export const STACK_DIR = path.join(TESTS_DIR, ".stack");

/** Fails with the one instruction that fixes it when the root build is missing (tests/README.md). */
export function assertBuilt(): void {
  const missing = [
    path.join(RELAY_DIST, "index.js"),
    path.join(VIEWER_DIST, "index.html"),
    FAKE_SLICER_DIST,
    path.join(REPO_ROOT, "shared", "dist"),
  ].filter((p) => !existsSync(p));
  if (missing.length > 0)
    throw new Error(
      `build output missing (${missing.map((p) => path.relative(REPO_ROOT, p)).join(", ")}): ` +
        "run `npm ci && npm run build` at the repository root first",
    );
}
