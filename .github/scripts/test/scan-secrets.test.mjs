// node --test ".github/scripts/test/*.test.mjs" (run by the `repo-checks` job of ci.yml)
import assert from "node:assert/strict";
import { test } from "node:test";
import { forbiddenPath, scanText } from "../scan-secrets.mjs";

// Built at run time so that this file itself never matches the scan.
const fake = (prefix, n) => prefix + "A1b2C3d4".repeat(Math.ceil(n / 8)).slice(0, n);

test("well-known secret formats are found, with their line", () => {
  const text = [
    "ok line",
    `-----BEGIN ${"OPENSSH "}PRIVATE KEY-----`,
    `token: ${fake("ghp_", 36)}`,
    `key = ${fake("AKIA", 16).toUpperCase()}`,
    `METRICS_TOKEN=${fake("", 44)}`,
    `RAILWAY_TOKEN: "${fake("", 36)}"`,
    `{ "RAILWAY_API_TOKEN": "${fake("", 36)}", "x": 1 }`,
    `  'METRICS_TOKEN': '${fake("", 32)}',`,
  ].join("\n");
  assert.deepEqual(
    scanText(text).map(({ line, kind }) => `${line} ${kind}`),
    [
      "2 private key",
      "3 GitHub token",
      "4 AWS access key",
      "5 secret variable with a value",
      "6 secret variable with a value",
      "7 secret variable with a value",
      "8 secret variable with a value",
    ],
  );
});

test("empty values, placeholders and workflow expressions are not findings", () => {
  const text = [
    "METRICS_TOKEN=",
    "METRICS_TOKEN=<at least 32 characters>",
    "RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}",
    "railway-token: ${{ secrets.RAILWAY_TOKEN }}",
    'METRICS_TOKEN="$(openssl rand -base64 32)"',
    "export RAILWAY_TOKEN=$RAILWAY_TOKEN",
    "| `METRICS_TOKEN` | unset → `/metrics` disabled (404) | bearer for Prometheus scrape |",
    '{ "RAILWAY_TOKEN": "${RAILWAY_TOKEN}", "METRICS_TOKEN": "" }',
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("only .env.example may be tracked", () => {
  assert.equal(forbiddenPath("relay-server/.env.example"), false);
  assert.equal(forbiddenPath("relay-server/.env"), true);
  assert.equal(forbiddenPath(".env.production.local"), true);
  assert.equal(forbiddenPath("docs/env.md"), false);
});
