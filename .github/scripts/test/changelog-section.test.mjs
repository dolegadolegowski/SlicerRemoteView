// node --test ".github/scripts/test/*.test.mjs" (run by the `repo-checks` job of ci.yml)
import assert from "node:assert/strict";
import { test } from "node:test";
import { section } from "../changelog-section.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "- next",
  "",
  "## [1.10.0] - 2026-12-01",
  "### Added",
  "- ten",
  "",
  "## [1.1.0] - 2026-11-30",
  "- one-one",
  "",
  "## v1.0.0 — first release",
  "- first",
  "",
  "## [0.9.0]",
  "",
].join("\n");

test("the section of a version, up to the next level-2 heading", () => {
  assert.equal(section(CHANGELOG, "1.10.0"), "### Added\n- ten");
  assert.equal(section(CHANGELOG, "v1.1.0"), "- one-one");
  assert.equal(section(CHANGELOG, "1.0.0"), "- first");
});

test("no prefix match: 1.1.0 is not 1.10.0, 1.1 is not 1.1.0", () => {
  assert.equal(section("## [1.10.0]\n- ten\n", "1.1.0"), null);
  assert.equal(section(CHANGELOG, "1.1"), null);
});

test("a missing or empty section is null; regex characters in the version are literal", () => {
  assert.equal(section(CHANGELOG, "2.0.0"), null);
  assert.equal(section(CHANGELOG, "0.9.0"), null);
  assert.equal(section("## [0.0.1-rc.1]\n- rc\n", "v0.0.1-rc.1"), "- rc");
  assert.equal(section("## [0x0x1]\n- no\n", "0.0.1"), null);
});
