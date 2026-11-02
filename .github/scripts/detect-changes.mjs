#!/usr/bin/env node
/**
 * The `detect` job of `.github/workflows/ci.yml` (DEP-01): which CI jobs a push or pull request needs.
 *
 *   BASE_SHA=<sha> EVENT_NAME=push REF=refs/heads/ws/x node .github/scripts/detect-changes.mjs
 *
 * A job runs when (a) the files it needs exist in the checkout — a component directory may not exist yet on a
 * branch (prompts/06-deploy-ci.md: `hashFiles` does not work in `jobs.<id>.if`, so existence is checked here) — and
 * (b) one of its paths changed against the base, or the run is a full run. A full run is: a push to `main`, a manual
 * or scheduled run, a base that is missing, all zeros (a new branch) or not in the fetched history (a force push),
 * or a change to the CI wiring itself (`.github/workflows/`, `.github/scripts/`).
 *
 * Writes `<job>=true|false` lines to `$GITHUB_OUTPUT` (and a table to `$GITHUB_STEP_SUMMARY`) when they are set,
 * and always prints the decision. Needs the full history (`actions/checkout` with `fetch-depth: 0`).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * One entry per CI job that `detect` gates. `requires`: every path must exist; `paths`: a changed file whose path
 * equals an entry or starts with an entry ending in `/` makes the job run.
 */
export const JOBS = {
  // npm workspaces: lint, typecheck, test, build, `npm run check -w shared`.
  node: {
    requires: ["package.json", "package-lock.json"],
    paths: ["shared/", "relay-server/", "web-viewer/", "tools/", "package.json", "package-lock.json"],
  },
  // shared/py: ruff + pytest + the full `npm run check -w shared` (generated Python, vendored copy).
  python_shared: {
    requires: ["shared/py/pyproject.toml"],
    paths: ["shared/", "slicer-plugin/RemoteView/_vendor/", "package.json", "package-lock.json"],
  },
  // slicer-plugin: ruff + pytest; its end-to-end tests run the relay stub of tools/fake-slicer (Node).
  python_slicer: {
    requires: ["slicer-plugin/requirements-dev.txt"],
    paths: ["slicer-plugin/", "shared/", "tools/fake-slicer/", "package.json", "package-lock.json"],
  },
  // The relay image: the same inputs as the Railway watch paths (docs/user-guide/en/own-server.md).
  docker: {
    requires: ["relay-server/Dockerfile"],
    paths: [
      "relay-server/",
      "shared/",
      "web-viewer/",
      "package.json",
      "package-lock.json",
      "tools/fake-slicer/package.json",
      ".dockerignore",
    ],
  },
  // SRV-21 load smoke (DEP-10): one relay process, fake-slicer's frames.
  load_smoke: {
    requires: ["relay-server/scripts/load-smoke.ts"],
    paths: ["relay-server/", "shared/", "tools/fake-slicer/", "package.json", "package-lock.json"],
  },
  // The qa harness (DEP-10): tests/ is its own npm project (not a workspace) driving relay + viewer + fake-slicer.
  qa: {
    requires: ["tests/package.json"],
    paths: [
      "tests/",
      "relay-server/",
      "shared/",
      "web-viewer/",
      "tools/fake-slicer/",
      "package.json",
      "package-lock.json",
    ],
  },
};

/** A change here re-runs everything: the wiring that decides what runs must itself be exercised. */
export const WIRING = [".github/workflows/", ".github/scripts/", ".github/actions/"];

const ZERO_SHA = /^0+$/;

function matches(file, paths) {
  return paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/**
 * Pure decision: `changed` = changed file paths (repository-relative) or `null` for a full run;
 * `exists(path)` tells whether a path exists in the checkout. Returns `{job: boolean}` and the reason.
 */
export function decide(changed, exists) {
  const full = changed === null || changed.some((f) => matches(f, WIRING));
  const result = {};
  for (const [job, { requires, paths }] of Object.entries(JOBS)) {
    result[job] = requires.every(exists) && (full || changed.some((f) => matches(f, paths)));
  }
  return { full, jobs: result };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Changed files against the base, or `null` (with the reason) when the run must be a full run. */
export function changedFiles(env, run = git) {
  const event = env.EVENT_NAME ?? "";
  const base = (env.BASE_SHA ?? "").trim();
  if (!["push", "pull_request"].includes(event)) return { files: null, reason: `event ${event || "unknown"}` };
  if (event === "push" && env.REF === "refs/heads/main") return { files: null, reason: "push to main" };
  if (!base || ZERO_SHA.test(base)) return { files: null, reason: "no base commit (new branch)" };
  try {
    run("cat-file", "-e", `${base}^{commit}`);
  } catch {
    return { files: null, reason: `base ${base.slice(0, 12)} not in the history (force push?)` };
  }
  // A pull request compares with the merge base (three dots); a push with the commit it replaced.
  const range = event === "pull_request" ? `${base}...HEAD` : `${base}..HEAD`;
  const out = run("diff", "--name-only", "--no-renames", range);
  return { files: out.split("\n").filter(Boolean), reason: `git diff ${range}` };
}

function main() {
  const { files, reason } = changedFiles(process.env);
  const { full, jobs } = decide(files, (p) => existsSync(p));
  const lines = Object.entries(jobs).map(([job, run]) => `${job}=${run}`);
  console.log(`${full ? "full run" : "changed-path run"} (${reason}); ${files?.length ?? "all"} file(s)`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\nfull=${full}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(jobs).map(([job, run]) => `| \`${job}\` | ${run ? "runs" : "skipped"} |`);
    const head = `### Change detection\n\n${full ? "Full run" : "Changed paths only"}: ${reason}.\n\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${head}| Job | Decision |\n|---|---|\n${rows.join("\n")}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
