#!/usr/bin/env node
// QA-12 release regression: runs every automated suite of `tests/` one after another (the load smoke measures the
// machine, so nothing runs beside it), prints one summary table and exits 1 if any suite failed. Each suite's
// output streams through unchanged; no suite prints a session code or a token (NFR-12), and neither does this.
//
//   npm --prefix tests run all                 # every suite
//   npm --prefix tests run all -- --skip load:smoke
//
// Needs the root build (`npm ci && npm run build`) and the Playwright browsers, like the suites themselves.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));

/** In order: cheap checks first, so a broken checkout fails in seconds. */
const SUITES = [
  { name: "lint", script: "lint", what: "tsc --noEmit over tests/" },
  { name: "triage", script: "triage", what: "report index current; every report has an owner and a status" },
  { name: "e2e", script: "e2e", what: "join, live, smoke on iphone15 / pixel7 / desktop-chromium" },
  { name: "security", script: "security", what: "join, payload, auth, logs, glb-fuzz, headers" },
  { name: "load:smoke", script: "load:smoke", what: "five load scenarios, scaled" },
];

const skip = new Set();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--skip" && argv[i + 1]) skip.add(argv[++i]);
  else {
    console.error(`usage: run-all.mjs [--skip <suite>]… (suites: ${SUITES.map((s) => s.name).join(", ")})`);
    process.exit(2);
  }
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rows = [];
for (const suite of SUITES) {
  if (skip.has(suite.name)) {
    rows.push({ ...suite, result: "skipped", seconds: 0 });
    continue;
  }
  console.log(`\n=== ${suite.name}: ${suite.what} ===`);
  const started = Date.now();
  const run = spawnSync(npm, ["run", suite.script], { cwd: TESTS_DIR, stdio: "inherit" });
  const seconds = Math.round((Date.now() - started) / 1000);
  rows.push({ ...suite, result: run.status === 0 ? "pass" : `FAIL (exit ${run.status ?? run.signal})`, seconds });
}

console.log("\n| Suite | Result | Seconds | Covers |\n|---|---|---|---|");
for (const row of rows) console.log(`| ${row.name} | ${row.result} | ${row.seconds} | ${row.what} |`);
const failed = rows.filter((r) => r.result.startsWith("FAIL"));
console.log(failed.length ? `\n${failed.length} suite(s) failed.` : "\nAll suites passed.");
process.exit(failed.length ? 1 : 0);
