/**
 * Bundles `shared/schema/*.schema.json` into one in-memory schema for the code generators (PRO-11).
 *
 * The generators (json-schema-to-typescript, datamodel-code-generator) cannot follow the schemas'
 * `https://slicerremoteview.dev/...` `$id`s without network access, and emit inheritance chains
 * (`Envelope & X`) that clash with the narrowed `type` const. The bundle therefore
 *
 * - puts `defs.schema.json#/definitions/*` and every message under one `definitions` map; messages are
 *   named in PascalCase after the file (`scene.update` → `SceneUpdate`, `envelope` → `Envelope`);
 * - inlines the envelope into each message (`allOf: [{$ref: envelope}]` is replaced by the envelope's
 *   `properties` and `required`; the message's own `type` const wins);
 * - adds `AnyMessage`, the `oneOf` of every message type.
 *
 * Validation keeps using the original files; the bundle only feeds generators.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA_SUFFIX = ".schema.json";

/** `scene.snapshot.begin` → `SceneSnapshotBegin`; `error` → `ErrorMessage` (would shadow the global `Error`). */
export const pascalCase = (messageType) =>
  messageType === "error"
    ? "ErrorMessage"
    : messageType
        .split(".")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("");

/** Rewrites `$ref`s of the file-per-schema layout to `#/definitions/*` of the bundle. */
function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref") {
      out[key] = rewriteRefs(value);
      continue;
    }
    const defs = /^defs\.schema\.json#\/definitions\/(.+)$/.exec(value);
    const file = /^(.+)\.schema\.json$/.exec(value);
    if (defs) out[key] = `#/definitions/${defs[1]}`;
    else if (file) out[key] = `#/definitions/${pascalCase(file[1])}`;
    else out[key] = value;
  }
  return out;
}

/**
 * @param {string} schemaDir directory holding `*.schema.json`
 * @returns {{ bundle: object, messageNames: string[], typeByName: Record<string, string> }}
 *   `typeByName` maps `SceneUpdate` → `"scene.update"` (the `type` const of the message).
 */
export function bundleSchemas(schemaDir) {
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith(SCHEMA_SUFFIX))
    .sort();
  const read = (file) => JSON.parse(readFileSync(resolve(schemaDir, file), "utf8"));
  const envelope = rewriteRefs(read(`envelope${SCHEMA_SUFFIX}`));

  const definitions = {};
  const messageNames = [];
  const typeByName = {};
  for (const file of files) {
    const messageType = file.slice(0, -SCHEMA_SUFFIX.length);
    if (messageType === "defs") {
      Object.assign(definitions, rewriteRefs(read(file)).definitions);
      continue;
    }
    if (messageType === "envelope") continue;
    const name = pascalCase(messageType);
    const schema = rewriteRefs(read(file));
    delete schema.$schema;
    delete schema.$id;
    const rest = (schema.allOf ?? []).filter((e) => e.$ref !== "#/definitions/Envelope");
    if (rest.length === schema.allOf?.length) {
      throw new Error(`${file}: expected allOf: [{$ref: envelope.schema.json}]`);
    }
    if (rest.length > 0) schema.allOf = rest;
    else delete schema.allOf;
    schema.title = name;
    schema.properties = { ...envelope.properties, ...schema.properties };
    schema.required = [...new Set([...envelope.required, ...(schema.required ?? [])])];
    definitions[name] = schema;
    messageNames.push(name);
    typeByName[name] = schema.properties.type.const;
  }
  const bundle = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "AnyMessage",
    description: "Every protocol message of docs/protocol.md v1.0 (discriminated by `type`).",
    oneOf: messageNames.map((name) => ({ $ref: `#/definitions/${name}` })),
    definitions,
  };
  return { bundle, messageNames, typeByName };
}
