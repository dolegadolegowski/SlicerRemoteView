/**
 * Update scripts (PRO-15, §8): a JSON array of `{afterMs, type, ...fields}` entries that `fake-slicer` plays
 * after the first snapshot. `type` is `scene.update`, `scene.nodeRemoved`, `scene.nodeAdded` or
 * `scene.snapshot` (re-sends a GLB, optionally another `fixture`). `afterMs` is the pause **since the previous
 * entry** (the first entry waits since the snapshot ack). Entries never carry `sceneVersion`/`baseVersion`:
 * the player owns the counter (§8.4) and fills them in.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMessage } from "@slicerremoteview/shared";
import { loadGlb, resolveFixture } from "./glb.js";
import type { LoadedGlb } from "./glb.js";

/** `tools/fake-slicer/scripts`, reachable from `src/` and from `dist/` alike. */
export const SCRIPT_DIR = fileURLToPath(new URL("../scripts/", import.meta.url));

export const SCRIPT_TYPES = [
  "scene.update",
  "scene.nodeRemoved",
  "scene.nodeAdded",
  "scene.snapshot",
] as const;
export type ScriptType = (typeof SCRIPT_TYPES)[number];

export type ScriptEntry =
  | {
      afterMs: number;
      type: Exclude<ScriptType, "scene.snapshot">;
      fields: Record<string, unknown>;
    }
  | { afterMs: number; type: "scene.snapshot"; glb: LoadedGlb | undefined };

const BOOKKEEPING = ["sceneVersion", "baseVersion", "protocolVersion", "id", "replyTo", "ts"];

/** `--script` resolution: an existing path as given, else a bundled script by name (`.json` optional). */
export function resolveScript(spec: string): string {
  if (existsSync(spec)) return resolve(spec);
  if (basename(spec) === spec) {
    const bundled = resolve(SCRIPT_DIR, spec.endsWith(".json") ? spec : `${spec}.json`);
    if (existsSync(bundled)) return bundled;
  }
  throw new Error(`script not found: ${spec}`);
}

/**
 * Reads and validates a script. Every entry is checked against the real message schema with placeholder
 * versions, so a typo fails at start-up, not halfway through a lecture demo.
 */
export async function loadScript(spec: string): Promise<ScriptEntry[]> {
  const file = resolveScript(spec);
  const label = basename(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}: not valid JSON (${(error as Error).message})`, { cause: error });
  }
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${label}: expected a non-empty JSON array of entries`);
  const entries: ScriptEntry[] = [];
  for (const [index, item] of (raw as unknown[]).entries()) {
    const where = `${label}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error(`${where}: expected an object`);
    const { afterMs, type, fixture, ...fields } = item as Record<string, unknown>;
    if (typeof afterMs !== "number" || !Number.isInteger(afterMs) || afterMs < 0)
      throw new Error(`${where}: "afterMs" must be a non-negative integer`);
    if (!(SCRIPT_TYPES as readonly unknown[]).includes(type))
      throw new Error(`${where}: "type" must be one of ${SCRIPT_TYPES.join(", ")}`);
    for (const key of BOOKKEEPING)
      if (key in fields)
        throw new Error(`${where}: "${key}" is filled in by fake-slicer (§8.4); remove it`);
    if (type === "scene.snapshot") {
      if (Object.keys(fields).length > 0)
        throw new Error(`${where}: scene.snapshot accepts only "fixture"`);
      if (fixture !== undefined && typeof fixture !== "string")
        throw new Error(`${where}: "fixture" must be a string`);
      let glb: LoadedGlb | undefined;
      try {
        glb = fixture === undefined ? undefined : await loadGlb(resolveFixture(fixture));
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
      }
      entries.push({ afterMs, type, glb });
      continue;
    }
    if (fixture !== undefined)
      throw new Error(`${where}: "fixture" only applies to scene.snapshot`);
    const checked = validateMessage(updateMessage(type as string, fields, 1, "p-0"));
    if (!checked.ok)
      throw new Error(
        `${where}: ${checked.error.message} (${checked.error.issues[0]?.instancePath || "/"} ${checked.error.issues[0]?.message ?? ""})`.trim(),
      );
    entries.push({ afterMs, type: type as Exclude<ScriptType, "scene.snapshot">, fields });
  }
  return entries;
}

/** The wire message of an update-type entry: `sceneVersion = baseVersion + 1` (§8.1, §8.4). */
export function updateMessage(
  type: string,
  fields: Record<string, unknown>,
  baseVersion: number,
  id: string,
): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    type,
    id,
    ts: Date.now(),
    sceneVersion: baseVersion + 1,
    baseVersion,
    ...fields,
  };
}

/** Total pause of one pass; a looping script must have some, or it would spin. */
export const scriptDuration = (entries: readonly ScriptEntry[]): number =>
  entries.reduce((sum, entry) => sum + entry.afterMs, 0);
