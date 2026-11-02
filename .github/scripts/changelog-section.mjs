#!/usr/bin/env node
/**
 * The release notes of one version from `CHANGELOG.md` (DEP-11; the changelog is the single source of a GitHub
 * Release's text, maintained by `release`):
 *
 *   node .github/scripts/changelog-section.mjs <version> [CHANGELOG.md]   # prints the section body
 *
 * Accepts the headings `## [1.2.0]`, `## [1.2.0] - 2026-11-30`, `## 1.2.0`, `## v1.2.0 — …` (a leading `v` in
 * `<version>` is ignored). The body runs to the next `## ` heading. Exit 1 with a clear message when the file or
 * the heading is missing or the section is empty, so a tag without changelog entry fails the release.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The trimmed body of `version`'s section, or `null`. */
export function section(text, version) {
  const v = version.replace(/^v/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[?v?${v}\\]?(?=\\s|$)`);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

function main() {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]");
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`${file} does not exist: add it with a "## [${version.replace(/^v/, "")}]" section first`);
    process.exit(1);
  }
  const body = section(readFileSync(file, "utf8"), version);
  if (body === null) {
    console.error(`${file} has no non-empty "## [${version.replace(/^v/, "")}]" section: add it before tagging`);
    process.exit(1);
  }
  console.log(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
