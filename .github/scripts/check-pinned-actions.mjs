#!/usr/bin/env node
/**
 * Every `uses:` of a workflow or composite action names a full commit SHA (DEP-09, threat model T12):
 *
 *   node .github/scripts/check-pinned-actions.mjs [file …]   # default: .github/workflows/*.yml, .github/actions/**
 *
 * A tag or branch can be moved to other code; a 40-character SHA cannot. Local actions (`./…`) and `docker://`
 * images with a `@sha256:` digest pass. Exit 1 lists every unpinned reference as `file:line: uses`.
 * Dependabot (`.github/dependabot.yml`) keeps the pins current and updates the `# vX.Y.Z` comment beside them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USES = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

/** `{line, ref}` of every unpinned `uses:` in the YAML text. */
export function unpinned(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    const ref = USES.exec(line)?.[1];
    if (ref && !ref.startsWith("./") && !PINNED.test(ref) && !DIGEST.test(ref)) found.push({ line: i + 1, ref });
  });
  return found;
}

function yamlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(name) ? [path] : [];
  });
}

function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2) : [...yamlFiles(".github/workflows"), ...yamlFiles(".github/actions")];
  const problems = files.flatMap((file) =>
    unpinned(readFileSync(file, "utf8")).map(({ line, ref }) => `${file}:${line}: ${ref}`),
  );
  if (problems.length > 0) {
    console.error(`${problems.length} action reference(s) not pinned to a 40-character commit SHA:`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`pinned actions: ok (${files.length} file(s))`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
