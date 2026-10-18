import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = resolve(here, "../schema");
export const FIXTURES_DIR = resolve(here, "../fixtures/messages");
export const PROTOCOL_DOC = resolve(here, "../../docs/protocol.md");
export const SCHEMA_BASE = "https://slicerremoteview.dev/schema/";

export interface JsonSchema {
  $schema: string;
  $id: string;
  definitions?: Record<string, unknown>;
  [keyword: string]: unknown;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Every `shared/schema/*.schema.json`, keyed by file name. */
export function loadSchemas(): Map<string, JsonSchema> {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".schema.json"))
    .sort();
  return new Map(files.map((f) => [f, readJson<JsonSchema>(resolve(SCHEMA_DIR, f))]));
}

/** Ajv 2020-12 in strict mode with every schema registered; `$ref`s resolve across files via `$id`. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  for (const schema of loadSchemas().values()) ajv.addSchema(schema);
  return ajv;
}

export function compile(ajv: Ajv2020, file: string): ValidateFunction {
  const validate = ajv.getSchema(SCHEMA_BASE + file);
  if (!validate) throw new Error(`schema not registered: ${file}`);
  return validate;
}

export function instancePaths(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).map((e) => e.instancePath))];
}
