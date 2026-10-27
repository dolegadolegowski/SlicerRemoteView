#!/usr/bin/env node
/**
 * Schema lint / CI check for `shared/` (`npm run check -w shared`, PRO-12; DEP-01 calls it).
 *
 * Offline, no network. Exit 0 = the contract, fixtures and generated files agree; exit 1 lists every problem:
 *
 * 1. every `schema/*.schema.json` compiles in Ajv 2020-12 `strict` mode;
 * 2. every message type of `docs/protocol.md` §11 has `schema/<type>.schema.json` and a `valid-*.json` fixture,
 *    and every schema is listed in §11 (no orphan);
 * 3. the §9.2 error codes equal the `errorCode` enum of `defs.schema.json`;
 * 4. fixture partition: valid fixtures pass, invalid ones fail at their `expect.instancePath`
 *    (the Python run is replayed by `py/tests/test_conformance.py`, step 6);
 * 5. generated files are current (`generate.mjs --check`: TypeScript, Python and — limited to `shared/cs` — C#, PRO-17);
 * 6. Python: `pytest py/tests/test_conformance.py`, and — when the directory exists —
 *    `vendor-py.mjs slicer-plugin/RemoteView/_vendor/remoteview_protocol --check` (ADR 0007 §3).
 *
 * Flags: `--skip-python` (no venv: skips the Python half of 5 and 6), `--static-only` (steps 1–4 only; tests),
 * `--schema-dir`, `--fixtures-dir`, `--doc <path>` (point steps 1–4 at another tree; tests).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { errorCodesFromDoc, messageTypesFromDoc } from "./lib/protocol-doc.mjs";

const shared = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) =>
  args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : fallback;
const schemaDir = option("--schema-dir", resolve(shared, "schema"));
const fixturesDir = option("--fixtures-dir", resolve(shared, "fixtures/messages"));
const docPath = option("--doc", resolve(shared, "../docs/protocol.md"));
const skipPython = flag("--skip-python");
const SCHEMA_BASE = "https://slicerremoteview.dev/schema/";
const NON_MESSAGE = new Set(["envelope", "defs"]);

const problems = [];
const fail = (message) => problems.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

// 1. Ajv strict
const schemaNames = listDir(schemaDir)
  .filter((f) => f.endsWith(".schema.json"))
  .map((f) => f.slice(0, -".schema.json".length))
  .sort();
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
const validators = new Map();
try {
  for (const name of schemaNames)
    ajv.addSchema(readJson(resolve(schemaDir, `${name}.schema.json`)));
  for (const name of schemaNames)
    validators.set(name, ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`));
} catch (error) {
  fail(`schemas do not compile in Ajv strict mode: ${error.message}`);
}

// 2. §11 types ↔ schemas ↔ valid fixtures
const doc = readFileSync(docPath, "utf8");
const { types: docTypes } = messageTypesFromDoc(doc);
if (docTypes.length === 0) fail(`${docPath}: the §11 table lists no message type`);
for (const type of docTypes) {
  if (!schemaNames.includes(type))
    fail(`${type}: listed in docs/protocol.md §11 but schema/${type}.schema.json is missing`);
  const fixtures = listDir(resolve(fixturesDir, type));
  if (!fixtures.some((f) => f.startsWith("valid-") && f.endsWith(".json")))
    fail(
      `${type}: listed in docs/protocol.md §11 but fixtures/messages/${type}/ has no valid-*.json`,
    );
}
for (const name of schemaNames)
  if (!NON_MESSAGE.has(name) && !docTypes.includes(name))
    fail(`${name}: schema exists but docs/protocol.md §11 does not list it`);

// 3. §9.2 error codes ↔ errorCode enum
const defs = existsSync(resolve(schemaDir, "defs.schema.json"))
  ? readJson(resolve(schemaDir, "defs.schema.json"))
  : null;
const enumCodes = defs?.definitions?.errorCode?.enum ?? [];
const docCodes = errorCodesFromDoc(doc);
for (const code of docCodes)
  if (!enumCodes.includes(code))
    fail(`${code}: error code of §9.2 missing from the errorCode enum in defs.schema.json`);
for (const code of enumCodes)
  if (!docCodes.includes(code)) fail(`${code}: in the errorCode enum but not in the §9.2 table`);

// 4. fixture partition
const fixtureTypes = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];
for (const type of fixtureTypes) {
  const validate = validators.get(type);
  if (!validate) {
    if (listDir(schemaDir).length > 0)
      fail(`fixtures/messages/${type}/: no schema/${type}.schema.json for these fixtures`);
    continue;
  }
  for (const file of listDir(resolve(fixturesDir, type)).sort()) {
    if (!file.endsWith(".json")) continue;
    const label = `fixtures/messages/${type}/${file}`;
    const content = readJson(resolve(fixturesDir, type, file));
    if (file.startsWith("valid-")) {
      if (!validate(content))
        fail(
          `${label}: valid fixture is rejected (${validate.errors?.[0]?.instancePath}: ${validate.errors?.[0]?.message})`,
        );
    } else if (file.startsWith("invalid-")) {
      if (typeof content.expect?.instancePath !== "string")
        fail(`${label}: invalid fixture needs expect.instancePath`);
      else if (validate(content.message)) fail(`${label}: invalid fixture is accepted`);
      else if (!validate.errors.some((e) => e.instancePath === content.expect.instancePath))
        fail(
          `${label}: expected a failure at "${content.expect.instancePath}", got ${[...new Set(validate.errors.map((e) => `"${e.instancePath}"`))].join(", ")}`,
        );
    } else fail(`${label}: fixture name must start with valid- or invalid-`);
  }
}

// 5.–6. generated files, Python conformance, vendored copy
function run(label, command, commandArgs) {
  try {
    execFileSync(command, commandArgs, {
      cwd: shared,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    fail(
      `${label} failed:\n${`${error.stdout ?? ""}${error.stderr ?? ""}`.trim().replace(/^/gm, "    ")}`,
    );
  }
}
if (!flag("--static-only")) {
  run("generate --check", process.execPath, [
    "scripts/generate.mjs",
    "--check",
    ...(skipPython ? ["--skip-python"] : []),
  ]);
  const pytest = resolve(shared, "py/.venv/bin/pytest");
  if (skipPython) console.warn("skipping Python conformance (--skip-python)");
  else if (!existsSync(pytest))
    fail(`missing ${pytest} — create the venv first (shared/README.md, "Python package")`);
  else run("pytest py/tests/test_conformance.py", pytest, ["py/tests/test_conformance.py"]);
  const vendored = resolve(shared, "../slicer-plugin/RemoteView/_vendor/remoteview_protocol");
  if (existsSync(vendored))
    run("vendor-py --check", process.execPath, ["scripts/vendor-py.mjs", vendored, "--check"]);
}

if (problems.length > 0) {
  console.error(`shared check: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `shared check: ok (${schemaNames.length} schemas, ${docTypes.length} message types, ${docCodes.length} error codes${flag("--static-only") ? ", static only" : ""})`,
);
