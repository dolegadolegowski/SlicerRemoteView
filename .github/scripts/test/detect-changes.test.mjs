// node --test ".github/scripts/test/*.test.mjs" (run by the `repo-checks` job of ci.yml)
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOBS, changedFiles, decide } from "../detect-changes.mjs";

const all = () => true;
const only = (job) => Object.fromEntries(Object.keys(JOBS).map((j) => [j, j === job]));

test("docs-only change runs no job", () => {
  const { full, jobs } = decide(["docs/deploy.md", "README.md", "CLAUDE.md"], all);
  assert.equal(full, false);
  assert.deepEqual(Object.values(jobs), Object.keys(JOBS).map(() => false));
});

test("relay change runs node, docker, load smoke and qa, not Python", () => {
  const { jobs } = decide(["relay-server/src/app.ts"], all);
  assert.deepEqual(jobs, {
    node: true,
    python_shared: false,
    python_slicer: false,
    docker: true,
    load_smoke: true,
    qa: true,
  });
});

test("slicer change runs only the slicer Python job", () => {
  assert.deepEqual(decide(["slicer-plugin/RemoteView/panel.py"], all).jobs, only("python_slicer"));
});

test("vendored copy change runs the shared drift check and the slicer tests", () => {
  const { jobs } = decide(["slicer-plugin/RemoteView/_vendor/remoteview_protocol/envelope.py"], all);
  assert.equal(jobs.python_shared, true);
  assert.equal(jobs.python_slicer, true);
  assert.equal(jobs.node, false);
});

test("a root file name matches exactly, a directory by prefix", () => {
  assert.equal(decide(["package.json.bak"], all).jobs.node, false);
  assert.equal(decide(["tools/fake-slicer/package.json"], all).jobs.docker, true);
  assert.equal(decide(["tools/fake-slicer/src/main.ts"], all).jobs.docker, false);
  assert.equal(decide([".dockerignore"], all).jobs.docker, true);
});

test("a missing directory skips its job even on a full run", () => {
  const { full, jobs } = decide(null, (p) => !p.startsWith("tests/") && !p.startsWith("slicer-plugin/"));
  assert.equal(full, true);
  assert.equal(jobs.qa, false);
  assert.equal(jobs.python_slicer, false);
  assert.equal(jobs.node, true);
});

test("a change to the CI wiring is a full run", () => {
  const { full, jobs } = decide([".github/scripts/detect-changes.mjs"], all);
  assert.equal(full, true);
  assert.ok(Object.values(jobs).every(Boolean));
  assert.equal(decide([".github/dependabot.yml"], all).full, false);
});

const okGit = (out) => (...args) => (args[0] === "diff" ? out : "");
const failGit = () => {
  throw new Error("fatal: Not a valid object name");
};

test("full runs: main, manual run, new branch, unknown base", () => {
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/main", BASE_SHA: "abc" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "workflow_dispatch" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/x", BASE_SHA: "0".repeat(40) }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/x", BASE_SHA: "" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/x", BASE_SHA: "abc" }, failGit).files, null);
});

test("push diffs two dots, pull request three dots", () => {
  const calls = [];
  const spy = (...args) => {
    calls.push(args.join(" "));
    return args[0] === "diff" ? "a.md\nrelay-server/x.ts\n" : "";
  };
  const push = changedFiles({ EVENT_NAME: "push", REF: "refs/heads/ws/deploy", BASE_SHA: "b1" }, spy);
  assert.deepEqual(push.files, ["a.md", "relay-server/x.ts"]);
  changedFiles({ EVENT_NAME: "pull_request", REF: "refs/pull/1/merge", BASE_SHA: "b2" }, spy);
  assert.ok(calls.includes("diff --name-only --no-renames b1..HEAD"));
  assert.ok(calls.includes("diff --name-only --no-renames b2...HEAD"));
});
