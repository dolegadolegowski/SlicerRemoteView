# Deployment and CI — owner's guide

Part of **SlicerRemoteView**, owned by the `deploy` workstream (`docs/plan/deploy.md`). This guide is for the
repository owner: what the GitHub Actions workflows do, how the relay runs on Railway, and the steps only the owner
can take (secrets, branch protection, Railway settings). End users who want their own relay read
`docs/user-guide/en/own-server.md` instead.

Placeholders: `<your-domain>` is the relay's public host name (for example the generated `<name>.up.railway.app`
or `relay.example.org`), `<owner>/<repo>` the GitHub repository. Never write the real domain, project name, tokens
or session codes into the repository (CLAUDE.md rule 6).

**Every push to `main` that touches the relay's inputs redeploys the live relay and ends every running session**
(Railway watch paths: `relay-server/`, `shared/`, `web-viewer/`, `package*.json`, `tools/fake-slicer/package.json`,
`.dockerignore`). Files of this workstream (`.github/`, `.railway/`, `docs/`) do not trigger a deploy.

Facts and their sources: `docs/research/deploy-github-actions.md`, `docs/research/deploy-railway-iac.md`,
`docs/research/deploy-railway-ops.md`; anything not confirmed there is marked `[TODO verify]`.

## Contents

1. Railway project, service and Infrastructure as Code
2. Variables
3. Secrets
4. First deploy checklist
5. Custom domain and TLS
6. Cost, egress and log retention
7. CI and branch protection
8. Releasing

## 7. CI and branch protection

### 7.1 What runs

`.github/workflows/ci.yml` runs on every push to any branch, on every pull request and by hand (**Actions** →
**CI** → **Run workflow**). Its first job, `detect` (`.github/scripts/detect-changes.mjs`), compares the changed
files with the base and checks which components exist on the branch; the other jobs run only when they are needed:

| Job | Runs when | What it checks | Blocking |
|---|---|---|---|
| `detect` | always | change detection; the step summary lists each job's decision | yes |
| `repo-checks` | always | unit tests of `.github/scripts/` | yes |
| `node 22` | `shared/`, `relay-server/`, `web-viewer/`, `tools/`, `package*.json` changed | `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check -w shared` (TypeScript half) | yes |
| `node 24 (non-blocking)` | as `node 22` | the same on the next Node LTS (NFR-41) | no |
| `ci-ok` | always | fails when a blocking job failed or was cancelled; passes when they passed or were skipped | **the required check** |

A full run (every job whose component exists) happens on a push to `main`, a manual run, the first push of a new
branch, after a force push, and whenever `.github/workflows/` or `.github/scripts/` change. A change to `docs/` only
runs `detect`, `repo-checks` and `ci-ok`.

No job needs a secret, so pull requests from forks and from Dependabot pass with the read-only `GITHUB_TOKEN`.

### 7.2 Branch protection (owner, once)

GitHub treats a job skipped by its `if:` as passing a required check, but a workflow that never started (for
example because of `on.push.paths`) leaves the check "Expected" forever; that is why CI starts on every push and
skips jobs inside the workflow.

1. **Settings** → **Rules** → **Rulesets** → **New branch ruleset** (or **Branches** → **Add branch protection
   rule** on older plans). Target: the default branch `main`.
2. Enable **Require a pull request before merging** and **Require status checks to pass**; add the check
   **`ci-ok`** (it appears in the list after the first CI run on any branch). Do not add the other jobs: `ci-ok`
   already covers the blocking ones, and the non-blocking ones must never block.
3. Enable **Block force pushes**.

Branch protection and rulesets on a private repository need GitHub Pro, Team or Enterprise `[TODO verify]` for the
owner's plan; without them, keep merging through pull requests and look at `ci-ok` before merging.

### 7.3 Railway waits for CI (recommended)

In the Railway service settings, turn on **Wait for CI** (its section: `[TODO verify]` in the dashboard). Railway then deploys a commit on `main` only
after the GitHub Actions runs on that commit finished, and skips the deploy when one failed
(`docs/research/deploy-railway-ops.md` §10). The toggle appears once a workflow runs on `push` to `main` — `ci.yml`
does — and after accepting the updated Railway GitHub App permissions. A non-blocking job (`continue-on-error`) does
not fail its run. `ci.yml` never cancels runs on `main`, as Railway asks.
