import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "../scripts/vendor-py.mjs");
const SOURCE = resolve(here, "../py/remoteview_protocol");

/** Runs the script; returns `{ status, stderr }` instead of throwing. */
function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { stdio: "pipe" }).toString();
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status: number; stdout: Buffer; stderr: Buffer };
    return { status: e.status, stdout: e.stdout.toString(), stderr: e.stderr.toString() };
  }
}

describe("vendor-py.mjs (PRO-10, ADR 0007 §3)", () => {
  let target: string;
  beforeAll(() => {
    target = join(mkdtempSync(join(tmpdir(), "vendor-py-")), "remoteview_protocol");
  });
  afterAll(() => rmSync(dirname(target), { recursive: true, force: true }));

  it("copies the package with its schemas and a manifest, then --check exits 0", () => {
    expect(run(target).status).toBe(0);
    const files = readdirSync(target).sort();
    expect(files).toContain("VENDORED.json");
    expect(files).toContain("__init__.py");
    expect(files).toContain("schemas.py");
    expect(files).toContain("chunk_header.py");
    expect(files).toContain("alphabet.py");
    expect(files).toContain("envelope.py");
    expect(files).toContain("schema");
    expect(files).not.toContain("__pycache__");
    const schemas = readdirSync(join(target, "schema")).sort();
    expect(schemas).toEqual(readdirSync(join(SOURCE, "schema")).sort());
    expect(schemas).toContain("envelope.schema.json");
    const manifest = JSON.parse(readFileSync(join(target, "VENDORED.json"), "utf8")) as {
      source: string;
      files: Record<string, string>;
    };
    expect(manifest.source).toBe("shared/py/remoteview_protocol");
    expect(Object.keys(manifest.files)).toContain("schema/defs.schema.json");
    expect(Object.keys(manifest.files)).toContain("schemas.py");
    for (const hash of Object.values(manifest.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run(target, "--check").status).toBe(0);
  });

  it("--check exits 1 on a modified, an extra and a missing file, and copying again repairs the tree", () => {
    const victim = join(target, "schema", "ping.schema.json");
    const original = readFileSync(victim);
    writeFileSync(victim, Buffer.concat([original, Buffer.from("\n")]));
    let result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("modified: schema/ping.schema.json");

    writeFileSync(join(target, "stray.py"), "# not from shared/py\n");
    result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("extra: stray.py");

    rmSync(join(target, "schemas.py"));
    result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing: schemas.py");

    writeFileSync(join(target, ".DS_Store"), "ignored");
    expect(result.stderr).not.toContain(".DS_Store");
    const manifestPath = join(target, "VENDORED.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8") + "\n");
    result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("modified: VENDORED.json");
    expect(result.stderr).not.toContain(".DS_Store");

    expect(run(target).status).toBe(0);
    expect(readdirSync(target)).not.toContain("stray.py");
    expect(readFileSync(victim)).toEqual(original);
    expect(run(target, "--check").status).toBe(0);
  });

  it("--check exits 1 when the target does not exist and 2 without a target", () => {
    expect(run(join(dirname(target), "nope"), "--check").status).toBe(1);
    expect(run().status).toBe(2);
  });
});
