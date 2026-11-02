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

const okGit = (out) => (...args) => (args.includes("diff") ? out : "");
const failGit = () => {
  throw new Error("fatal: Needed a single revision");
};

test("full runs: main, manual run, a base that is not in the history", () => {
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/main" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "workflow_dispatch" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "pull_request", BASE_SHA: "" }, okGit("")).files, null);
  assert.equal(changedFiles({ EVENT_NAME: "push", REF: "refs/heads/x" }, failGit).files, null);
});

test("a push compares the whole branch with main, a pull request with its base, via the merge base", () => {
  const calls = [];
  const spy = (...args) => {
    calls.push(args.join(" "));
    return args.includes("diff") ? "a.md\0relay-server/x.ts\0web-viewer/ü ber.ts\0" : "";
  };
  const push = changedFiles({ EVENT_NAME: "push", REF: "refs/heads/ws/deploy", BASE_SHA: "ignored" }, spy);
  assert.deepEqual(push.files, ["a.md", "relay-server/x.ts", "web-viewer/ü ber.ts"]);
  changedFiles({ EVENT_NAME: "pull_request", REF: "refs/pull/1/merge", BASE_SHA: "b2" }, spy);
  assert.ok(calls.includes("rev-parse --verify --quiet origin/main^{commit}"));
  assert.ok(calls.includes("-c core.quotepath=off diff --name-only -z --no-renames origin/main...HEAD"));
  assert.ok(calls.includes("-c core.quotepath=off diff --name-only -z --no-renames b2...HEAD"));
});

test("a docs-only push after a relay commit on the same branch still runs the relay's jobs", () => {
  const { files } = changedFiles({ EVENT_NAME: "push", REF: "refs/heads/ws/x" }, okGit("relay-server/a.ts\0docs/b.md\0"));
  assert.equal(decide(files, all).jobs.docker, true);
});
