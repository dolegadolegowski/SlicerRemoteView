#!/usr/bin/env node
/**
 * Variable-name parity between the relay's configuration sources (DEP-13):
 *
 *   node .github/scripts/check-env-parity.mjs [--with-docs]
 *
 * - `.railway/railway.ts` — the `env: { … }` block of the relay service (what Railway gets);
 * - `relay-server/.env.example` — every variable `relay-server/src/config.ts` reads, with its default;
 * - with `--with-docs` (DEP-05) also the variable tables of `docs/architecture.md` §9 and `docs/deploy.md` §2
 *   (first-column names in backticks).
 *
 * Every name must be in every source, except the known exceptions below. Exit 1 names each name and the source that
 * lacks it, e.g. `FOO: in relay-server/.env.example, missing from .railway/railway.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Names a source may lack, with the reason. `RELAY_TEST_FAST_TIMERS` is test-only and must never reach Railway
 * (docs/architecture.md §9), so it is also forbidden in railway.ts.
 */
export const EXCEPTIONS = {
  PORT: "injected by Railway; declaring it breaks the edge's port detection (docs/user-guide/en/own-server.md)",
  RAILWAY_PUBLIC_DOMAIN: "injected by Railway; only the default of ALLOWED_ORIGINS (report 2026-10-18-server-2)",
  NODE_OPTIONS: "set by relay-server/Dockerfile and read by Node, not by config.ts (report 2026-10-18-server-2)",
  RELAY_TEST_FAST_TIMERS: "test-only (docs/architecture.md §9)",
};
export const FORBIDDEN_ON_RAILWAY = ["RELAY_TEST_FAST_TIMERS"];

const NAME = "[A-Z][A-Z0-9_]*";
/** `--with-docs`: the variable tables of the documentation. */
export const DOCS = [
  ["docs/architecture.md", "## 9. Deployment view"],
  ["docs/deploy.md", "## 2. Variables"],
];

/** Keys of the first `env: { … }` object literal (one key per line, as in the file). */
export function namesFromRailwayTs(text) {
  const start = text.search(/^\s*env:\s*\{/m);
  if (start < 0) throw new Error("no `env: {` block found");
  const body = text.slice(start);
  const end = body.search(/^\s*\},?\s*$/m);
  const block = end < 0 ? body : body.slice(0, end);
  return [...block.matchAll(new RegExp(`^\\s*(${NAME}):`, "gm"))].map((m) => m[1]);
}

/** `NAME=value` lines; comments and blank lines ignored. */
export function namesFromEnvExample(text) {
  return [...text.matchAll(new RegExp(`^(${NAME})=`, "gm"))].map((m) => m[1]);
}

/**
 * First-column `` `NAME` `` cells of the Markdown tables between the heading that starts with `heading` and the next
 * heading of the same or a higher level.
 */
export function namesFromMarkdownSection(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`heading "${heading}" not found`);
  const level = heading.match(/^#+/)[0].length;
  const names = [];
  for (const line of lines.slice(start + 1)) {
    const h = line.match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    const m = line.match(new RegExp(`^\\|\\s*\`(${NAME})\`\\s*\\|`));
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * `sources`: `{label: names[]}`. Returns problem strings: a name missing from a source (unless an exception),
 * and a forbidden name present on Railway.
 */
export function compare(sources, { railwayLabel } = {}) {
  const problems = [];
  const all = new Set(Object.values(sources).flat());
  for (const name of [...all].sort()) {
    if (name in EXCEPTIONS) continue;
    const have = Object.keys(sources).filter((label) => sources[label].includes(name));
    for (const label of Object.keys(sources)) {
      if (!sources[label].includes(name)) problems.push(`${name}: in ${have.join(", ")}, missing from ${label}`);
    }
  }
  if (railwayLabel) {
    for (const name of FORBIDDEN_ON_RAILWAY) {
      if (sources[railwayLabel]?.includes(name)) problems.push(`${name}: ${EXCEPTIONS[name]}, must not be in ${railwayLabel}`);
    }
  }
  return problems;
}

function main() {
  const RAILWAY = ".railway/railway.ts";
  const ENV_EXAMPLE = "relay-server/.env.example";
  if (!existsSync(RAILWAY) || !existsSync(ENV_EXAMPLE)) {
    console.log(`env parity: skipped (${existsSync(RAILWAY) ? ENV_EXAMPLE : RAILWAY} does not exist on this branch)`);
    return;
  }
  const sources = {
    [RAILWAY]: namesFromRailwayTs(readFileSync(RAILWAY, "utf8")),
    [ENV_EXAMPLE]: namesFromEnvExample(readFileSync(ENV_EXAMPLE, "utf8")),
  };
  if (process.argv.includes("--with-docs")) {
    for (const [file, heading] of DOCS) sources[`${file} (${heading})`] = namesFromMarkdownSection(readFileSync(file, "utf8"), heading);
  }
  const problems = compare(sources, { railwayLabel: RAILWAY });
  if (problems.length > 0) {
    console.error(`env parity: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  const counts = Object.entries(sources).map(([label, names]) => `${label} ${names.length}`);
  console.log(`env parity: ok (${counts.join(", ")}; exceptions: ${Object.keys(EXCEPTIONS).join(", ")})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
