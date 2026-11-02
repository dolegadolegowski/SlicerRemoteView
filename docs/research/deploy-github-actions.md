# Research — GitHub Actions and GitHub facts for the `deploy` CI (DEP-01..DEP-13)

Status/date: verified 2026-11-02 against docs.github.com (sources read from the `github/docs` repository, `main`),
action repositories via `gh api` (read-only), and vendor docs. Anything not confirmed by a source is marked
`[TODO verify]`. Scope: `docs/plan/deploy.md` tasks DEP-01..DEP-13.
Verified by an independent re-check on 2026-11-02; corrections: 14

## 1. Pinned actions (latest stable release, resolved 2026-11-02)

Method: `gh api repos/OWNER/REPO/releases/latest --jq .tag_name`, then `gh api repos/OWNER/REPO/git/ref/tags/TAG`.
All nine tags are lightweight tags (`object.type == "commit"`), so the SHA below is the commit SHA directly.
Runtime is the `runs.using` value of `action.yml` at that tag. Input names were read from `action.yml` at that tag.

| Action | Tag | Commit SHA (40 chars) | Runtime | Inputs we will use | Used by |
|---|---|---|---|---|---|
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | node24 | `fetch-depth`, `persist-credentials: false` | all jobs |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0) | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | node24 | `node-version` (22.x / 24.x), `cache: npm`, `cache-dependency-path: package-lock.json` | DEP-01, DEP-10, DEP-13 |
| [actions/setup-python](https://github.com/actions/setup-python/releases/tag/v7.1.0) | v7.1.0 | `6d4fd22b20465ccc0f7354476588e8df7c9ca0e0` | node24 | `python-version: '3.12'`, `cache: pip`, `cache-dependency-path` | DEP-02, DEP-09, DEP-11 |
| [actions/cache](https://github.com/actions/cache/releases/tag/v6.1.0) | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | node24 | `path`, `key`, `restore-keys` | optional (see §12 Playwright) |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | node24 | `name`, `path`, `if-no-files-found`, `retention-days`, `include-hidden-files` | DEP-10, DEP-11 |
| [docker/setup-buildx-action](https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1) | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` | node24 | none (defaults) | DEP-03, DEP-11 |
| [docker/build-push-action](https://github.com/docker/build-push-action/releases/tag/v7.4.0) | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` | node24 | `context: .`, `file: relay-server/Dockerfile`, `load`, `push`, `tags`, `labels`, `cache-from`, `cache-to` | DEP-03, DEP-11 |
| [docker/login-action](https://github.com/docker/login-action/releases/tag/v4.7.0) | v4.7.0 | `81c6f93d4bc991e510b342a00b419b3bb4efc5c6` | node24 | `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}` | DEP-03, DEP-11 |
| [docker/metadata-action](https://github.com/docker/metadata-action/releases/tag/v6.2.0) | v6.2.0 | `dc802804100637a589fabce1cb79ff13a1411302` | node24 | `images`, `tags` (`type=sha,format=long`, `type=semver,pattern={{version}}`) | DEP-03, DEP-11 |

Ready to paste:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
- uses: actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0
- uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
- uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
- uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
- uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
- uses: docker/login-action@81c6f93d4bc991e510b342a00b419b3bb4efc5c6 # v4.7.0
- uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
```

Notes on these actions:

1.1. `actions/checkout` fetches a single commit by default; `fetch-depth: 0` fetches all history for all branches and
tags; the README shows `fetch-depth: 2` + `git checkout HEAD^`. The token is persisted for later git commands unless
`persist-credentials: false`. Recommended token permission: `contents: read`.
https://github.com/actions/checkout/blob/v7.0.1/README.md

1.2. `actions/checkout` v7 refuses to check out fork PR code under `pull_request_target` / `workflow_run` unless
`allow-unsafe-pr-checkout: true` (we do not use those triggers). https://github.com/actions/checkout/blob/v7.0.1/README.md

1.3. `actions/setup-node` v7: automatic npm caching is on only when `package.json` has `packageManager` /
`devEngines.packageManager` set to npm; otherwise set `cache: npm` explicitly. The README recommends
`package-manager-cache: false` for workflows with elevated privileges (relevant to the GHCR push / release jobs).
https://github.com/actions/setup-node/blob/v7.1.0/README.md

1.4. `actions/setup-python` `cache: pip` hashes `requirements.txt` or `pyproject.toml` by default;
`cache-dependency-path` handles files in subdirectories (our `shared/py`, `slicer-plugin`).
https://github.com/actions/setup-python/blob/v7.1.0/README.md

1.5. `docker/build-push-action`: `load` is shorthand for `--output=type=docker` (default `false`) — needed so the
smoke step can `docker run` the image; `context` defaults to the Git context, so `context: .` must be set to use the
checked-out path context (ADR 0007 §5). https://github.com/docker/build-push-action/blob/v7.4.0/README.md

1.6. GHA layer cache: `cache-from: type=gha`, `cache-to: type=gha,mode=max`, after `docker/setup-buildx-action`;
only the GitHub Cache service API v2 is supported (Buildx >= 0.21.0, BuildKit >= 0.20.0).
https://docs.docker.com/build/ci/github-actions/cache/

1.7. `docker/metadata-action` lowercases the image name automatically; `type=sha` gives `sha-<7 chars>`,
`type=sha,format=long` the full SHA. https://github.com/docker/metadata-action/blob/v6.2.0/README.md

1.8. `actions/cache` v5+ runs on Node 24 and needs Actions Runner >= 2.327.1 (only matters for self-hosted runners).
https://github.com/actions/cache/blob/v6.1.0/README.md

## 2. Skipped jobs, path filters and required status checks

2.1. A job skipped by an `if:` conditional reports "Success" and does not block a pull request from merging, even
when it is a required check; the UI shows "This check was skipped."
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions

2.2. Successful check statuses for required checks are `success`, `skipped` and `neutral`.
https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks

2.3. A workflow skipped by path filtering, branch filtering or a skip commit message leaves its checks "Pending"
and blocks merging ("Waiting for status to be reported"); GitHub advises not to require workflows that can be
skipped. This is why DEP-01 uses a `detect` job + job-level `if:` instead of `on.push.paths`.
https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks ·
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore

2.4. `needs`: if a needed job fails or is skipped, all dependent jobs are skipped unless they use a conditional such as
`always()`. A job skipped because its dependency failed "may not block merging" — so a required aggregate job must
use `if: always()` and check `needs.*.result` itself.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds ·
https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks

2.5. Contexts allowed in `jobs.<job_id>.if`: `github, needs, vars, inputs` (functions `always, cancelled, success,
failure`) — no `env`, `secrets`, `matrix` or `hashFiles`. Among the `if` keys, `hashFiles` is available only in
`jobs.<job_id>.steps.if` (it is also allowed in other step keys such as `steps.env`, `steps.with`, `steps.run`). The
job `if` is evaluated before `strategy.matrix` is applied.
https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability ·
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif

2.6. Required checks are only evaluated for checks from workflow runs triggered by `push`, `pull_request`,
`pull_request_review`, `pull_request_target`, `deployment` or `deployment_status`; merge queues additionally need the
`merge_group` trigger or the required check is never reported.
https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks

## 3. Base commit for changed-file detection

3.1. `push` payload: `before` = "The SHA of the most recent commit on `ref` before the push"; `created` = whether the
push created the ref. For a new branch the example payload has `before: "0000000000000000000000000000000000000000"`
and `created: true` (no docs.github.com prose states the all-zero value). The Actions push payload omits
`added/removed/modified` file lists.
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/push/event.schema.json ·
https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/push/with-new-branch.payload.json ·
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push

3.2. `pull_request`: `GITHUB_SHA` is the merge commit on `refs/pull/N/merge` (checked out by default);
`github.event.pull_request.head.sha` is the head-branch tip; `github.event.pull_request.base.sha` exists in the payload.
Workflows do not run on `pull_request` while the PR has a merge conflict.
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request ·
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/common/pull-request.schema.json

3.3. `merge_group` (`checks_requested`): `GITHUB_SHA`/`merge_group.head_sha` = SHA of the merge group;
`merge_group.base_sha` = "The SHA of the merge group's parent commit"; `merge_group.base_ref` = the full ref of the
branch the merge group will be merged into (e.g. `refs/heads/main`, not the short branch name).
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group ·
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/merge_group/checks_requested.schema.json

3.4. Fetch depth: default checkout has one commit, so `git diff <base> HEAD` needs the base object. Options:
`fetch-depth: 0` (documented), or `fetch-depth: 2` and diff `HEAD^1..HEAD` on the PR merge commit
(`[TODO verify]` that the first parent of `refs/pull/N/merge` is the base tip — not stated in docs), or
`git fetch --depth=1 origin <base.sha>` (`[TODO verify]` that fetching by SHA works for the base commit).
Design rule (not a documented fact): `detect` should treat an all-zero `before` (new branch, `created: true`) and a
`before` commit that cannot be fetched or is not an ancestor (force push; the payload has a boolean `forced`) as
"run everything". https://github.com/actions/checkout/blob/v7.0.1/README.md ·
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/push/event.schema.json

## 4. `continue-on-error` on a matrix entry

4.1. `jobs.<job_id>.continue-on-error: true` prevents a workflow run from failing when that job fails; documented
example `continue-on-error: ${{ matrix.experimental }}` with `fail-fast: false` and an `include` entry
`experimental: true`. `matrix` is an allowed context in `jobs.<job_id>.continue-on-error`.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontinue-on-error ·
https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability

4.2. The job itself still fails ("allow a workflow run to pass when this job fails"); therefore the Node 24 job must
not be a required check. Whether its check run is shown as "failure" in the PR checks list: `[TODO verify]` on the
first run.

## 5. GHCR push with `GITHUB_TOKEN`; fork PRs

5.1. Grant `permissions: contents: read, packages: write` and log in to `ghcr.io` with `${{ github.actor }}` /
`${{ secrets.GITHUB_TOKEN }}`; publishing from a workflow with `GITHUB_TOKEN` links the package to the repository
automatically (stated on the Container registry page).
https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions ·
https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images ·
https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

5.2. `GITHUB_TOKEN` cannot push if a package of the same name was previously pushed to the namespace without being
connected to the repository; adding the `org.opencontainers.image.source` label is recommended.
https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

5.3. Image names must be lowercase: the GitHub example lowercases `ghcr.io/${{ github.repository_owner }}/...` with
`tr '[A-Z]' '[a-z]'`; `docker/metadata-action` lowercases automatically (§1.7).
https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions

5.4. In PRs from forks `GITHUB_TOKEN` is read-only; `permissions` cannot grant write to forks unless an admin enables
"Send write tokens to workflows from pull requests" (private repos). Workflows triggered by Dependabot PRs are treated
as if from a fork and get a read-only `GITHUB_TOKEN` by default, but for Dependabot runs the `permissions` key can
increase the token's access.
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request ·
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions

5.5. Fork detection: `pull_request.head.repo` is a repository object or `null` (the schema does not say when it is
`null`; "deleted fork" is `[TODO verify]`); `repository.fork` is
"Whether the repository is a fork". No docs.github.com page prescribes `github.event.pull_request.head.repo.fork`;
proposed robust check: `github.event.pull_request.head.repo.full_name == github.repository` (same-repo PR)
`[TODO verify]` (not a documented recipe). GHCR push itself is gated on `github.ref == 'refs/heads/main' &&
github.event_name == 'push'` (DEP-03), which never runs for PRs.
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/common/pull-request.schema.json ·
https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/common/repository.schema.json

## 6. Secrets in fork PRs and in `if:`

6.1. With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a
forked repository. Dependabot-triggered runs cannot access secrets other than Dependabot secrets.
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request ·
https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets

6.2. "Secrets cannot be directly referenced in `if:` conditionals." Documented workaround: set the secret as a
job-level `env` variable and test `env.X != ''` in `steps[*].if`; an unset secret evaluates to an empty string.
Because `env` is not available in `jobs.<job_id>.if` (§2.5), gating a whole job (DEP-13 plan job) needs a prior
step/job that exports a boolean output (e.g. `has_token`) read via `needs.<job>.outputs`.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-using-secrets ·
https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability

## 7. Environments and manual approval (DEP-13 apply)

7.1. Syntax: `jobs.<job_id>.environment: <name>` or `{ name, url }`; all deployment protection rules must pass before
the job is sent to a runner; environment secrets are available only after approval.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idenvironment ·
https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments

7.2. Required reviewers: up to six users/teams, one approval suffices.
https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments

7.3. Plan availability: environments, environment secrets and deployment branches in private repositories need
Pro, Team or Enterprise; on Free, Pro and Team plans, required reviewers and wait timers are available **only for
public repositories**. Consequence: on a private repo without Enterprise, DEP-13's "manual-approval environment"
cannot use required reviewers; fallbacks are `workflow_dispatch` (manual trigger) + deployment branch restriction to
`main` (Pro/Team), or making the repo public. Decision needed (see Open items).
https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments ·
https://github.com/github/docs/blob/main/data/reusables/gated-features/environments.md

## 8. Dependabot (`.github/dependabot.yml`)

8.1. `version: 2` is required. `package-ecosystem` values: `npm` (also yarn/pnpm), `pip` (pip, pip-compile, pipenv,
poetry), `github-actions`, `docker`, `docker-compose`.
https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem-

8.2. `directory` = one manifest directory; `directories` = list, and only `directories` supports globs and `*`. For
`github-actions` use `/` (scans `/.github/workflows` and root `action.yml`). Multiple blocks for the same ecosystem
and target branch must not overlap directories.
https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#directories-or-directory-

8.3. `groups.<IDENTIFIER>` keys: `applies-to` (`version-updates`|`security-updates`), `dependency-type`
(`development`|`production`), `patterns`, `exclude-patterns`, `update-types` (`minor`|`patch`|`major`), `group-by:
dependency-name` (cross-directory, same ecosystem, version updates only).
https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups-

8.4. `schedule.interval`: `daily`, `weekly`, `monthly`, `quarterly`, `semiannually`, `yearly`, `cron`.
https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#schedule-

8.5. pip: any `.txt` requirements file, plus `pyproject.toml` if it follows PEP 621.
https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories

8.6. npm workspaces: the docs do not state how Dependabot handles npm workspaces; plan assumption "one `npm` entry
with `directory: /` covers all workspaces via the root `package-lock.json`" is `[TODO verify]` (check the first
Dependabot run).

8.7. The Dependabot `reviewers` option has been removed on GitHub.com (changelog 2025-08-08; the options reference no
longer documents it for GitHub.com); use CODEOWNERS for review requests. Do not put `reviewers` in `dependabot.yml`.
https://github.blog/changelog/2025-08-08-dependabot-reviewers-configuration-option-is-replaced-by-code-owners ·
https://github.com/github/docs/blob/main/data/features/dependabot-reviewers-deprecation.yml

## 9. Issue forms, PR template, CODEOWNERS (DEP-12, DEP-09)

9.1. Issue forms live in `/.github/ISSUE_TEMPLATE/*.yml`. Top-level keys: `name` (required, unique), `description`
(required), `body` (required, array), optional `assignees`, `labels` (non-existent labels are not added), `title`,
`type`, `projects`. https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms

9.2. Body element keys: `type` (`markdown`, `textarea`, `input`, `dropdown`, `checkboxes`, `upload`), `id`,
`attributes` (required), `validations`. `validations.required` "Prevents form submission until element is completed.
**Only for public repositories.**" https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema

9.3. PR template: `pull_request_template.md` in the root, `docs/` or `.github/`; multiple templates in a
`PULL_REQUEST_TEMPLATE/` subdirectory (selected via `template` query parameter). "Pull request template filenames
are not case sensitive", so the plan's `.github/PULL_REQUEST_TEMPLATE.md` is valid.
https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository ·
https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates

9.4. CODEOWNERS: file `CODEOWNERS` in `.github/`, root or `docs/` (searched in that order, first wins); per branch;
< 3 MB; gitignore-like patterns, last match wins; `!` negation, `[ ]` ranges and `\#` escaping do not work; owners
need explicit write access. Available on private repos only with Pro, Team or Enterprise.
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners

## 10. actionlint

10.1. Latest release `v1.7.12` (commit `914e7df21a07ef503a81201c76d2b11c789d3fca`, published 2026-03-30).
https://github.com/rhysd/actionlint/releases/tag/v1.7.12

10.2. Checks: workflow syntax (unexpected/missing/duplicate keys), strong type checks of `${{ }}` expressions,
contexts/functions availability, `steps`/`matrix`/`needs` typing, action inputs at `with:` for popular actions,
outdated popular actions, script injection, hard-coded credentials, `needs` dependencies, glob patterns, cron,
runner labels, permissions, reusable workflows, action metadata syntax; shellcheck and pyflakes on `run:` scripts.
https://github.com/rhysd/actionlint/blob/v1.7.12/README.md · https://github.com/rhysd/actionlint/blob/v1.7.12/docs/checks.md

10.3. shellcheck runs only when the `shellcheck` binary is found (or given via `-shellcheck`); applied only to
`bash`/`sh` shells; `${{ }}` is replaced with underscores and rules SC1091, SC2050, SC2194, SC2154, SC2157, SC2043
are disabled. https://github.com/rhysd/actionlint/blob/v1.7.12/docs/checks.md#check-shellcheck-integ

10.4. CI install: `scripts/download-actionlint.bash` (accepts a version argument) or the `rhysd/actionlint` Docker
image. actionlint's documented checks cover workflow files and (local) action metadata only; its docs list no check
for `dependabot.yml` or issue forms, so DEP-09/DEP-12 acceptance wording needs another check `[TODO verify]` a schema
validator choice. https://github.com/rhysd/actionlint/blob/v1.7.12/docs/usage.md ·
https://github.com/rhysd/actionlint/blob/v1.7.12/docs/checks.md

## 11. `gh release create` (DEP-11)

11.1. Flags: `-d/--draft`, `-F/--notes-file <file>` (`-` = stdin), `--verify-tag` (abort if the tag does not exist on
the remote), `-t/--title`, `-p/--prerelease`, `--latest[=false]`. Verified with `gh release create --help`
(gh 2.88.1; latest gh release is v2.103.3). https://cli.github.com/manual/gh_release_create

11.2. `gh` is preinstalled on GitHub-hosted runners; each step must set `GH_TOKEN` (e.g. `${{ secrets.GITHUB_TOKEN }}`).
https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-github-cli

11.3. The REST "Create a release" endpoint requires push access and lists the fine-grained permission "Contents"
repository permissions: write (plus "Workflows" write when the target commit adds or modifies files under
`.github/workflows/`). The `GITHUB_TOKEN` scope table states "`contents: write` allows the action to create a release",
so the job needs `permissions: contents: write`.
https://docs.github.com/en/rest/releases/releases#create-a-release ·
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defining-access-for-the-github_token-scopes

## 12. Playwright in CI (DEP-10)

12.1. Playwright docs: "Caching browser binaries is not recommended" — restoring the cache takes about as long as
downloading, and Linux OS dependencies cannot be cached. The CI page's GitHub Actions example runs
`npx playwright install --with-deps` (no browser arguments). This contradicts DEP-10 "browsers cached"; drop the cache
or measure. https://playwright.dev/docs/ci
Installing only some browsers is documented on the Browsers page (e.g. `npx playwright install --with-deps chromium`;
browser names are passed as arguments). https://playwright.dev/docs/browsers

12.2. Alternative: run the job in the official container `mcr.microsoft.com/playwright:v<version>-noble` (CI example
uses a pinned tag). The Docker page warns that if the image's Playwright version does not match the project's, browser
executables are not found, and recommends pinning the image version. https://playwright.dev/docs/ci ·
https://playwright.dev/docs/docker

## 13. Non-blocking audits (DEP-09)

13.1. `npm audit` exits non-zero if any vulnerability is found; `--audit-level` (`info|low|moderate|high|critical|none`)
only changes the failure threshold; `--omit=dev` is accepted (values `dev|optional|peer`). The page documents the
`workspace`, `workspaces` and `include-workspace-root` configs; whether a plain root `npm audit` (no workspace flags)
covers all workspace dependencies via the root `package-lock.json` is not stated `[TODO verify]`. Make it
non-blocking with job/step `continue-on-error: true`. https://docs.npmjs.com/cli/v11/commands/npm-audit

13.2. `pip-audit` 2.10.1 (2026-06-10): exit 0 = no known vulnerabilities, 1 = vulnerabilities found; the exit code
"cannot be suppressed" internally — use `pip-audit || true` or `continue-on-error`. Flags: `-r/--requirement`
(repeatable), `--strict`, `--desc`, `--format` (`columns|json|cyclonedx-json|cyclonedx-xml|markdown`),
`--progress-spinner off`, `--ignore-vuln ID`; `pip-audit .` audits a `pyproject.toml` project.
https://github.com/pypa/pip-audit/blob/main/README.md · https://pypi.org/project/pip-audit/

## Open / [TODO verify]

1. Repo is private: required reviewers for the DEP-13 apply environment are unavailable on Free/Pro/Team (§7.3) —
   decide: `workflow_dispatch` + `main`-only deployment branch, Enterprise, or public repo.
2. Repo is private: `validations.required` in issue forms has no effect (§9.2); CODEOWNERS needs Pro/Team (§9.4).
3. First parent of `refs/pull/N/merge` = base tip (for `fetch-depth: 2` diff) and fetch-by-SHA of the base (§3.4).
4. Display of a failed `continue-on-error` matrix job in the PR checks list (§4.2).
5. Fork detection expression — `head.repo.full_name == github.repository` vs `head.repo.fork`; when `head.repo` is
   `null` (§5.5).
6. Dependabot npm workspaces with a single root entry (§8.6).
7. Schema validation for `dependabot.yml` and issue forms — actionlint documents no check for them (§10.4).
8. Plain root `npm audit --omit=dev` coverage of workspace dependencies (§13.1).
9. DEP-10 "browsers cached" conflicts with Playwright guidance (§12.1).
10. Re-resolve SHAs before merging if a newer release appears (values valid on 2026-11-02).

Resolved by the re-check: uppercase `PULL_REQUEST_TEMPLATE.md` is valid (§9.3); `contents: write` is the documented
`GITHUB_TOKEN` scope for creating a release (§11.3).

## Sources

- https://github.com/actions/checkout/blob/v7.0.1/README.md
- https://github.com/actions/setup-node/blob/v7.1.0/README.md
- https://github.com/actions/setup-python/blob/v7.1.0/README.md
- https://github.com/actions/cache/blob/v6.1.0/README.md
- https://github.com/actions/upload-artifact/blob/v7.0.2/action.yml
- https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1
- https://github.com/docker/build-push-action/blob/v7.4.0/README.md
- https://github.com/docker/login-action/releases/tag/v4.7.0
- https://github.com/docker/metadata-action/blob/v6.2.0/README.md
- https://docs.docker.com/build/ci/github-actions/cache/
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
- https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- https://github.com/github/docs/blob/main/data/reusables/gated-features/environments.md
- https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions
- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/push/event.schema.json
- https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/push/with-new-branch.payload.json
- https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/merge_group/checks_requested.schema.json
- https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/common/pull-request.schema.json
- https://github.com/octokit/webhooks/blob/main/payload-schemas/api.github.com/common/repository.schema.json
- https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates
- https://github.blog/changelog/2025-08-08-dependabot-reviewers-configuration-option-is-replaced-by-code-owners
- https://github.com/github/docs/blob/main/data/features/dependabot-reviewers-deprecation.yml
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- https://github.com/rhysd/actionlint/releases/tag/v1.7.12
- https://github.com/rhysd/actionlint/blob/v1.7.12/docs/checks.md
- https://github.com/rhysd/actionlint/blob/v1.7.12/docs/usage.md
- https://cli.github.com/manual/gh_release_create
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-github-cli
- https://docs.github.com/en/rest/releases/releases#create-a-release
- https://playwright.dev/docs/ci
- https://playwright.dev/docs/browsers
- https://playwright.dev/docs/docker
- https://docs.npmjs.com/cli/v11/commands/npm-audit
- https://github.com/pypa/pip-audit/blob/main/README.md
- https://pypi.org/project/pip-audit/
