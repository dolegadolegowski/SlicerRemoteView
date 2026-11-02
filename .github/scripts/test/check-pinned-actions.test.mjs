// node --test ".github/scripts/test/*.test.mjs" (run by the `repo-checks` job of ci.yml)
import assert from "node:assert/strict";
import { test } from "node:test";
import { unpinned } from "../check-pinned-actions.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a SHA pin, a local action and a digest-pinned image pass", () => {
  const yaml = [
    `      - uses: actions/checkout@${SHA} # v6.0.0`,
    `        uses: "docker/build-push-action@${SHA}"`,
    "      - uses: ./.github/actions/setup",
    `      - uses: docker://alpine@sha256:${"a".repeat(64)}`,
  ].join("\n");
  assert.deepEqual(unpinned(yaml), []);
});

test("tags, branches, short SHAs and tag-pinned images fail with their line", () => {
  const yaml = [
    "steps:",
    "  - uses: actions/checkout@v6",
    "    uses: actions/setup-node@main",
    `  - uses: actions/cache@${SHA.slice(0, 12)}`,
    "  - uses: docker://alpine:3.22",
    "    uses: owner/repo/path@v1 # comment",
  ].join("\n");
  assert.deepEqual(
    unpinned(yaml).map(({ line, ref }) => `${line} ${ref}`),
    [
      "2 actions/checkout@v6",
      "3 actions/setup-node@main",
      `4 actions/cache@${SHA.slice(0, 12)}`,
      "5 docker://alpine:3.22",
      "6 owner/repo/path@v1",
    ],
  );
});

test("a reusable workflow call is checked too", () => {
  assert.equal(unpinned("    uses: owner/repo/.github/workflows/x.yml@v2").length, 1);
});
