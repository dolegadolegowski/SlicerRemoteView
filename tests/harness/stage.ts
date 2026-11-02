// Stages the built relay the way the Docker image lays it out (relay-server/Dockerfile, ADR 0007):
// `relay-server/dist` + `package.json` with `web-viewer/dist` as its `public/` (the relay serves `public/` next to
// `dist/`, src/http/static.ts). The copy lives in the git-ignored `tests/.stack/relay-server/`; the relay's
// dependencies resolve from the repository root's `node_modules` (npm workspaces), so nothing is installed.
// The main checkout's `relay-server/public/` is never touched.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RELAY_DIR, RELAY_DIST, STACK_DIR, VIEWER_DIST, assertBuilt } from "./paths.ts";

export const STAGED_RELAY_DIR = path.join(STACK_DIR, "relay-server");
export const STAGED_RELAY_ENTRY = path.join(STAGED_RELAY_DIR, "dist", "index.js");

/** Newest modification time of the two build outputs, so a rebuild re-stages. */
function buildStamp(): string {
  return [path.join(RELAY_DIST, "index.js"), path.join(VIEWER_DIST, "index.html")]
    .map((p) => statSync(p).mtimeMs)
    .join(":");
}

/** Copies the build into `tests/.stack/relay-server/` unless the copy is already from the same build. */
export function stageRelay(): string {
  assertBuilt();
  const stampFile = path.join(STAGED_RELAY_DIR, ".build-stamp");
  const stamp = buildStamp();
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return STAGED_RELAY_ENTRY;
  rmSync(STAGED_RELAY_DIR, { recursive: true, force: true });
  mkdirSync(STAGED_RELAY_DIR, { recursive: true });
  cpSync(RELAY_DIST, path.join(STAGED_RELAY_DIR, "dist"), { recursive: true });
  cpSync(path.join(RELAY_DIR, "package.json"), path.join(STAGED_RELAY_DIR, "package.json"));
  cpSync(VIEWER_DIST, path.join(STAGED_RELAY_DIR, "public"), { recursive: true });
  writeFileSync(stampFile, stamp);
  return STAGED_RELAY_ENTRY;
}
