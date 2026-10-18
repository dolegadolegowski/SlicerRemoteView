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

/** Invalid fixtures are wrapped so the expected failure travels with the message (shared/README.md). */
export interface InvalidFixture {
  $comment?: string;
  expect: { instancePath: string; keyword?: string };
  message: unknown;
}

export interface FixtureSet {
  type: string;
  valid: { file: string; message: Record<string, unknown> }[];
  invalid: { file: string; fixture: InvalidFixture }[];
}

/** All fixture directories under `fixtures/messages` whose name starts with `prefix` (e.g. `session.`). */
export function loadFixtures(prefix = ""): FixtureSet[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => d.name)
    .sort()
    .map((type) => {
      const dir = resolve(FIXTURES_DIR, type);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      return {
        type,
        valid: files
          .filter((f) => f.startsWith("valid-"))
          .map((file) => ({
            file,
            message: readJson<Record<string, unknown>>(resolve(dir, file)),
          })),
        invalid: files
          .filter((f) => f.startsWith("invalid-"))
          .map((file) => ({ file, fixture: readJson<InvalidFixture>(resolve(dir, file)) })),
      };
    });
}

/** JSON examples of `docs/protocol.md` between two headings, keyed by message `type` (one block may hold one object per line). */
export function protocolExamples(
  fromHeading: string,
  toHeading: string,
): Map<string, Record<string, unknown>[]> {
  const doc = readFileSync(PROTOCOL_DOC, "utf8");
  const start = doc.indexOf(fromHeading);
  const end = doc.indexOf(toHeading);
  if (start < 0 || end < 0)
    throw new Error(
      `heading not found in docs/protocol.md: ${start < 0 ? fromHeading : toHeading}`,
    );
  const section = doc.slice(start, end);
  const out = new Map<string, Record<string, unknown>[]>();
  for (const [, block] of section.matchAll(/```json\n([\s\S]*?)```/g)) {
    const texts =
      block!.trim().startsWith("{") &&
      block!
        .trim()
        .split("\n")
        .every((l) => l.startsWith("{"))
        ? block!.trim().split("\n")
        : [block!];
    for (const text of texts) {
      const message = JSON.parse(text) as Record<string, unknown>;
      const list = out.get(message.type as string) ?? [];
      list.push(message);
      out.set(message.type as string, list);
    }
  }
  return out;
}
