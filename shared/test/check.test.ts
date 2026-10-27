import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorCodesFromDoc, messageTypesFromDoc } from "../scripts/lib/protocol-doc.mjs";
import { FIXTURES_DIR, PROTOCOL_DOC, SCHEMA_DIR } from "./helpers.js";

const CHECK = resolve(__dirname, "../scripts/check.mjs");
let work: string;

beforeEach(() => {
  work = mkdtempSync(resolve(tmpdir(), "remoteview-check-"));
  cpSync(SCHEMA_DIR, resolve(work, "schema"), { recursive: true });
  cpSync(FIXTURES_DIR, resolve(work, "fixtures"), { recursive: true });
  cpSync(PROTOCOL_DOC, resolve(work, "protocol.md"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** Runs the static half of check.mjs (steps 1–4) on the temp copy of the tree. */
function staticCheck() {
  return spawnSync(
    process.execPath,
    [
      ...[CHECK, "--static-only", "--schema-dir", resolve(work, "schema")],
      ...["--fixtures-dir", resolve(work, "fixtures"), "--doc", resolve(work, "protocol.md")],
    ],
    { encoding: "utf8" },
  );
}
const editDoc = (edit: (doc: string) => string) =>
  writeFileSync(
    resolve(work, "protocol.md"),
    edit(readFileSync(resolve(work, "protocol.md"), "utf8")),
  );

describe("npm run check (PRO-12)", () => {
  it("exits 0 on the current tree, offline, and reports what it covered", () => {
    const result = staticCheck();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok \(30 schemas, 28 message types, 15 error codes/);
  });

  it("parses the §11 table and the §9.2 codes from docs/protocol.md", () => {
    const doc = readFileSync(PROTOCOL_DOC, "utf8");
    const { types, reserved } = messageTypesFromDoc(doc);
    expect(types).toHaveLength(28);
    expect(types).toContain("scene.snapshot.abort");
    expect(reserved).toEqual(["scene.camera", "viewer.command"]);
    expect(errorCodesFromDoc(doc)).toHaveLength(15);
  });

  it("fails naming the type when a schema is removed", () => {
    rmSync(resolve(work, "schema/scene.update.schema.json"));
    const result = staticCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/scene\.update: listed in docs\/protocol\.md §11 but schema\//);
  });

  it("fails naming the type when §11 gains a type without a schema", () => {
    editDoc((doc) => doc.replace("| `ping` | yes |", "| `ping`, `scene.zoom` | yes |"));
    const result = staticCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/scene\.zoom: listed in docs\/protocol\.md §11 but schema\//);
    expect(result.stderr).toMatch(/scene\.zoom: .*no valid-\*\.json/);
  });

  it("fails when a type has no valid fixture or a schema is not listed in §11", () => {
    rmSync(resolve(work, "fixtures/ping/valid-example.json"));
    const missing = staticCheck();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/ping: .*no valid-\*\.json/);
    editDoc((doc) => doc.replace("| `ping` | yes |", "| `scene.camera` | yes |"));
    expect(staticCheck().stderr).toMatch(
      /ping: schema exists but docs\/protocol\.md §11 does not list it/,
    );
  });

  it("fails when a §9.2 error code is missing from the errorCode enum", () => {
    const defsPath = resolve(work, "schema/defs.schema.json");
    writeFileSync(defsPath, readFileSync(defsPath, "utf8").replace('"CAPACITY",', ""));
    const result = staticCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/CAPACITY: error code of §9\.2 missing from the errorCode enum/);
  });

  it("fails when a schema does not compile in Ajv strict mode", () => {
    const pingPath = resolve(work, "schema/ping.schema.json");
    writeFileSync(
      pingPath,
      readFileSync(pingPath, "utf8").replace('"type": "object"', '"typo": 1'),
    );
    expect(staticCheck().stderr).toMatch(/do not compile in Ajv strict mode/);
  });

  it("fails when a valid fixture is rejected or an invalid one fails elsewhere", () => {
    const validPath = resolve(work, "fixtures/session.created/valid-example.json");
    const valid = JSON.parse(readFileSync(validPath, "utf8")) as Record<string, unknown>;
    writeFileSync(validPath, JSON.stringify({ ...valid, code: "0OIL1" }));
    const invalidPath = resolve(work, "fixtures/ping/invalid-missing-protocolVersion.json");
    const invalid = JSON.parse(readFileSync(invalidPath, "utf8")) as {
      expect: { instancePath: string };
    };
    invalid.expect.instancePath = "/nowhere";
    writeFileSync(invalidPath, JSON.stringify(invalid));
    const result = staticCheck();
    expect(result.stderr).toMatch(
      /session\.created\/valid-example\.json: valid fixture is rejected/,
    );
    expect(result.stderr).toMatch(
      /ping\/invalid-missing-protocolVersion\.json: expected a failure at "\/nowhere"/,
    );
  });

  it("is wired as `npm run check` and the full run passes without network", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["check"]).toBe("node scripts/check.mjs");
    // Static + generate steps; Python and the `slicer-plugin/_vendor` comparison (a directory of the slicer workstream,
    // stale after any change of shared/py until it re-vendors) are covered by `npm run check` itself, which CI runs.
    const out = execFileSync(process.execPath, [CHECK, "--skip-python", "--skip-vendored"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/shared check: ok/);
  });
});
