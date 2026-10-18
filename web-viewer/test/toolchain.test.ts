import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("toolchain invariants", () => {
  it("pins three to an exact version (NFR-41)", () => {
    expect(pkg.dependencies["three"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("loads nothing from a CDN (NFR-09)", () => {
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("declares the mobile viewport shell", () => {
    expect(html).toContain("viewport-fit=cover");
  });
});
