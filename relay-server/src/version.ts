/**
 * Relay identity for `GET /healthz` and `GET /api/version` (docs/protocol.md §10).
 */
import { createRequire } from "node:module";
import { PROTOCOL_VERSION } from "@slicerremoteview/shared";

/** `name` field of `GET /api/version` (§10). */
export const RELAY_NAME = "slicer-remote-view-relay";

/** Protocol versions this relay speaks (§2, §10). */
export const PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

/**
 * `version` of `relay-server/package.json`. Resolved relative to this module, which sits one level
 * below the package root both as `src/version.ts` (dev, tests) and as `dist/version.js` (build).
 */
export const RELAY_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
