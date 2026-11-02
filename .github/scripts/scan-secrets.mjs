#!/usr/bin/env node
/**
 * A light, gitleaks-style scan of the tracked files for committed secrets (DEP-05, CLAUDE.md rule 6):
 *
 *   node .github/scripts/scan-secrets.mjs            # every file `git ls-files` lists
 *   node .github/scripts/scan-secrets.mjs <file …>   # only these
 *
 * Reports private keys, well-known token formats, a value assigned to one of this project's secret variables
 * (`METRICS_TOKEN`, `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`) and tracked `.env` files (only `.env.example` may be
 * tracked). Prints `file:line: kind` — never the matched text. Exit 1 on a finding. CI runs it non-blocking: a
 * finding means "rotate the secret, then remove it from the history", not just "delete the line".
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RULES = [
  { kind: "private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // An assignment with a real-looking value (not empty, not a placeholder such as <…>, ${…}, $X or …).
  {
    kind: "secret variable with a value",
    // The key may be quoted (`"RAILWAY_TOKEN": "…"` in JSON such as .mcp.json or settings files).
    re: /\b(?:METRICS_TOKEN|RAILWAY_TOKEN|RAILWAY_API_TOKEN)["']?\s*[=:]\s*["'`]?(?![<$"'`{.…]|\*{3}|secrets\.)[A-Za-z0-9+/_\-]{16,}/,
  },
];

/** `{line, kind}` findings of one file's text. */
export function scanText(text) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    for (const { kind, re } of RULES) if (re.test(line)) findings.push({ line: i + 1, kind });
  });
  return findings;
}

/** A tracked file that must not be in git at all. */
export function forbiddenPath(path) {
  const name = path.split("/").pop();
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

function main() {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const problems = [];
  for (const file of files) {
    if (forbiddenPath(file)) problems.push(`${file}: tracked .env file`);
    let text;
    try {
      text = readFileSync(file);
    } catch {
      continue; // deleted in the working tree, a submodule, …
    }
    if (text.includes(0)) continue; // binary (GLB fixtures, images)
    for (const { line, kind } of scanText(text.toString("utf8"))) problems.push(`${file}:${line}: ${kind}`);
  }
  if (problems.length > 0) {
    console.error(`secret scan: ${problems.length} finding(s) — rotate the secret, then remove it from the history:`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`secret scan: ok (${files.length} file(s))`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
