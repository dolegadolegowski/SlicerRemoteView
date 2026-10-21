#!/usr/bin/env node
// WebXR input profiles, self-hosted (WEB-19; ADR 0003, NFR-09, NFR-16): three.js' controller and hand model factories
// fetch from a jsDelivr CDN unless told otherwise, so the build copies the profiles Meta Quest controllers and hands
// use from the pinned `@webxr-input-profiles/assets` package into `public/assets/xr-profiles-<version>/` (copied to
// `dist/` by Vite; not committed). Under `/assets/` the relay already serves it, with its immutable cache — right
// because the version is in the path. `profilesList.json` lists only what is copied: a listed profile without its
// files would be fetched and fail instead of falling back to `generic-trigger`.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Quest 3/3S (`meta-quest-touch-plus`, `-v2` on newer controllers), Quest Pro, Quest 2 (`oculus-touch-v3`), Quest 1
 * (`oculus-touch-v2`), the factory's fallback `generic-trigger` and the hand mesh `generic-hand`
 * (docs/research/web-xr.md §2).
 */
export const PROFILES = [
  "meta-quest-touch-plus",
  "meta-quest-touch-plus-v2",
  "meta-quest-touch-pro",
  "oculus-touch-v3",
  "oculus-touch-v2",
  "generic-trigger",
  "generic-hand",
];

const PACKAGE = createRequire(import.meta.url).resolve("@webxr-input-profiles/assets/package.json");

/** `dist/profiles` of the installed `@webxr-input-profiles/assets`. */
export function sourceDir() {
  return join(dirname(PACKAGE), "dist", "profiles");
}

/** `xr-profiles-<version>`: the directory name under `/assets/` (src/xr/session.ts builds the same). */
export function targetName() {
  return `xr-profiles-${JSON.parse(readFileSync(PACKAGE, "utf8")).version}`;
}

/** Copies `PROFILES` (each `profile.json` and the GLBs it names), a filtered list and the licence to `dest`. */
export function copyXrProfiles(source, dest) {
  rmSync(dest, { recursive: true, force: true });
  const list = JSON.parse(readFileSync(join(source, "profilesList.json"), "utf8"));
  const kept = {};
  for (const id of PROFILES) {
    if (!list[id]) throw new Error(`profile ${id} is not in profilesList.json`);
    kept[id] = list[id];
    const profile = JSON.parse(readFileSync(join(source, id, "profile.json"), "utf8"));
    mkdirSync(join(dest, id), { recursive: true });
    copyFileSync(join(source, id, "profile.json"), join(dest, id, "profile.json"));
    const assets = new Set(Object.values(profile.layouts).map((layout) => layout.assetPath));
    for (const asset of assets) copyFileSync(join(source, id, asset), join(dest, id, asset));
  }
  writeFileSync(join(dest, "profilesList.json"), JSON.stringify(kept));
  // MIT: the notice travels with the copies.
  copyFileSync(join(source, "..", "..", "LICENSE.md"), join(dest, "LICENSE.md"));
  return Object.keys(kept);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assets = fileURLToPath(new URL("../public/assets/", import.meta.url));
  mkdirSync(assets, { recursive: true });
  for (const old of readdirSync(assets).filter((name) => name.startsWith("xr-profiles-")))
    rmSync(join(assets, old), { recursive: true, force: true }); // a previous version's copy
  const count = copyXrProfiles(sourceDir(), join(assets, targetName())).length;
  console.log(`${targetName()}: ${count} profiles copied`);
}
