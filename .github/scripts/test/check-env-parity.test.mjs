// node --test ".github/scripts/test/*.test.mjs" (run by the `repo-checks` job of ci.yml)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOCS, compare, namesFromEnvExample, namesFromMarkdownSection, namesFromRailwayTs } from "../check-env-parity.mjs";

const RAILWAY = `
const relay = service("relay", {
  deploy: { numReplicas: 1 },
  env: {
    LOG_LEVEL: "info",
    // a comment with NOT_A_NAME: inside
    METRICS_TOKEN: preserve(),
  },
});
const other = { env: { LATER: "x" } };
`;

test("railway.ts: the keys of the env block only", () => {
  assert.deepEqual(namesFromRailwayTs(RAILWAY), ["LOG_LEVEL", "METRICS_TOKEN"]);
});

test(".env.example: NAME= lines, not comments", () => {
  assert.deepEqual(namesFromEnvExample("# FOO=1\nPORT=8787\nMETRICS_TOKEN=\n\nLOG_LEVEL=info\n"), [
    "PORT",
    "METRICS_TOKEN",
    "LOG_LEVEL",
  ]);
});

test("a name on one side only is reported with both labels", () => {
  const problems = compare({ a: ["LOG_LEVEL", "FOO"], b: ["LOG_LEVEL", "BAR"] });
  assert.deepEqual(problems, ["BAR: in b, missing from a", "FOO: in a, missing from b"]);
});

test("exceptions may be missing anywhere; the test-only switch is forbidden on Railway", () => {
  assert.deepEqual(compare({ r: ["LOG_LEVEL"], e: ["LOG_LEVEL", "PORT", "RELAY_TEST_FAST_TIMERS"] }, { railwayLabel: "r" }), []);
  assert.deepEqual(compare({ r: ["RELAY_TEST_FAST_TIMERS"], e: [] }, { railwayLabel: "r" }), [
    "RELAY_TEST_FAST_TIMERS: test-only (docs/architecture.md §9), must not be in r",
  ]);
  assert.equal(compare({ r: ["PORT", "NODE_OPTIONS"], e: [] }, { railwayLabel: "r" }).length, 2);
});

test("the repository's own files agree", () => {
  const railway = namesFromRailwayTs(readFileSync(".railway/railway.ts", "utf8"));
  const example = namesFromEnvExample(readFileSync("relay-server/.env.example", "utf8"));
  assert.deepEqual(compare({ railway, example }, { railwayLabel: "railway" }), []);
  assert.ok(railway.includes("MAX_TOTAL_BUFFERED_BYTES") && railway.includes("TRUST_PROXY"));
});

test("Markdown: first-column names of the section's tables, up to the next heading of its level", () => {
  const md = [
    "## 9. Deployment view",
    "| Variable | Default |",
    "|---|---|",
    "| `PORT` | injected |",
    "| `LOG_LEVEL` | `info` |",
    "### 9.1 Sub-section",
    "| `MAX_VIEWERS` | `20` |",
    "text with `NOT_A_ROW` |",
    "## 10. Next",
    "| `LATER` | x |",
  ].join("\n");
  assert.deepEqual(namesFromMarkdownSection(md, "## 9. Deployment view"), ["PORT", "LOG_LEVEL", "MAX_VIEWERS"]);
  assert.throws(() => namesFromMarkdownSection(md, "## 11."), /not found/);
});

test("the documentation tables agree with railway.ts and .env.example (--with-docs)", () => {
  const sources = {
    railway: namesFromRailwayTs(readFileSync(".railway/railway.ts", "utf8")),
    example: namesFromEnvExample(readFileSync("relay-server/.env.example", "utf8")),
  };
  for (const [file, heading] of DOCS) sources[file] = namesFromMarkdownSection(readFileSync(file, "utf8"), heading);
  assert.deepEqual(compare(sources, { railwayLabel: "railway" }), []);
  for (const [file] of DOCS) assert.ok(!sources[file].includes("RELAY_TEST_FAST_TIMERS"), file);
});
