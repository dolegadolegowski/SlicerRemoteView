import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUDGET_BYTES, initialAssets, measure } from "../scripts/check-bundle.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/check-bundle.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function dist(files: Record<string, string | Buffer>, html: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rv-bundle-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), html);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const HTML = `<!doctype html><head>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/icon-192.png" />
  <script type="module" crossorigin src="/assets/index.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/three.js">
  <link rel="stylesheet" crossorigin href="/assets/index.css">
  <script>/* inline, not an asset */</script>
</head>`;

describe("bundle budget (WEB-18, NFR-09)", () => {
  it("counts module scripts, module preloads and stylesheets — not icons or the manifest", () => {
    expect(initialAssets(HTML)).toEqual([
      "/assets/index.js",
      "/assets/three.js",
      "/assets/index.css",
    ]);
  });

  it("refuses an initial asset from another origin (no third-party scripts, NFR-16)", () => {
    expect(() =>
      initialAssets('<script type="module" src="https://cdn.example/x.js"></script>'),
    ).toThrow(/another origin/);
    expect(() => initialAssets('<link rel="stylesheet" href="//cdn.example/x.css">')).toThrow(
      /another origin/,
    );
  });

  it("measures each asset's gzipped size", () => {
    const js = "const a = 1;\n".repeat(1000);
    const dir = dist(
      { "assets/index.js": js, "assets/three.js": "x", "assets/index.css": "a{}" },
      HTML,
    );
    const files = measure(dir);
    expect(files.map((f) => f.url)).toEqual([
      "/assets/index.js",
      "/assets/three.js",
      "/assets/index.css",
    ]);
    expect(files[0]!.bytes).toBe(js.length);
    expect(files[0]!.gzip).toBeLessThan(200); // it compresses well
  });

  it("the CLI prints the total and fails above 1 MiB gzip, passes below", () => {
    const html = '<script type="module" src="/assets/index.js"></script>';
    const big = dist({ "assets/index.js": randomBytes(BUDGET_BYTES + 1024) }, html); // incompressible
    const over = spawnSync(process.execPath, [SCRIPT, big], { encoding: "utf8" });
    expect(over.status).toBe(1);
    expect(over.stderr).toContain("over budget");
    const small = dist({ "assets/index.js": "export {};" }, html);
    const under = spawnSync(process.execPath, [SCRIPT, small], { encoding: "utf8" });
    expect(under.status).toBe(0);
    expect(under.stdout).toMatch(/initial JS \+ CSS: \d+ B gzip \(budget 1048576 B/);
  });
});
