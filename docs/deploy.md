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

## 1. Railway project, service and Infrastructure as Code

The relay is one Railway service built from `relay-server/Dockerfile` with the repository root as build context
(ADR 0007 §5–§6). Its desired settings live in `.railway/railway.ts` (Railway Infrastructure as Code, ADR 0007 §7).

**Railway never reads `.railway/railway.ts` by itself.** Committing or merging it changes nothing on Railway; only
`railway config apply` does (the owner locally, or `.github/workflows/railway.yml` once opted in, §1.4). Railway's
older `railway.json`/`railway.toml` files ("config as code") stop being read on 2026-12-01; this repository has
none and must not add one.

### 1.1 Create the project and link the repository (new setup only)

The live service already exists (it was set up by hand). For a new project, follow
`docs/user-guide/en/own-server.md` sections 1–3 click by click (new project from the GitHub repository, Dockerfile
builder, **Dockerfile Path** `/relay-server/Dockerfile`, **Root Directory** `/`, **Healthcheck Path** `/healthz`,
**Serverless** off, one region your rules for patient data allow — an EU region, ADR 0007 §6 — 1 replica,
**Generate Domain**, the variables `ALLOWED_ORIGINS` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`), then:

1. Service **Settings** → service name: **`relay`** (the name `.railway/railway.ts` declares; or change
   `SERVICE_NAME` in that file before the first plan). A different name makes the plan *create* `relay` and
   *delete* the existing service — never apply such a plan.
2. Turn on **Wait for CI** (§7.3), so that a commit whose CI failed is never deployed.
3. Continue with §1.3 to put the service under IaC.

### 1.2 What `.railway/railway.ts` declares

| Setting | Value | Note |
|---|---|---|
| Service | `relay`, GitHub source `<owner>/<repo>`, branch `main`, root directory `/` | a fork puts its own repository into `REPOSITORY` |
| Build | Dockerfile builder, `/relay-server/Dockerfile`, the eleven watch patterns of `own-server.md` | pushes that touch nothing else do not deploy |
| Deploy | 1 replica, serverless (sleeping) off, healthcheck `/healthz` with 300 s timeout, restart on failure (10 retries) | in-memory sessions: never more than one replica (ADR 0006) |
| Variables | §2: every variable of `docs/architecture.md` §9 except `PORT`, `NODE_OPTIONS`, `RAILWAY_PUBLIC_DOMAIN` | `ALLOWED_ORIGINS` and `METRICS_TOKEN` are `preserve()`: declared, their dashboard values kept |
| Not declared | the region, the generated `*.up.railway.app` domain, custom domains | the region stays what the dashboard says; IaC cannot express the generated domain |

`apply` makes the project equal to the file: a service missing from the file is **deleted**, and so is a variable
of `relay` missing from its `env` block (both are marked destructive in the plan). A dashboard edit of a declared
setting lasts until the next apply, which reverts it to the file — change such settings in the file instead.

### 1.3 Put the live service under IaC (owner, once, locally)

Needs Node 22 and the Railway CLI ≥ 5.42.1 (`.github/workflows/railway.yml` pins 5.71.0). Nothing in this
procedure changes Railway until step 6.

1. Install and sign in: `npm install -g @railway/cli@5.71.0`, then `railway login`, and in the repository root
   `railway link` (choose the project, the `production` environment and the relay service).
2. Install the SDK the file imports: `npm ci --prefix .railway`, then `npm run typecheck --prefix .railway`
   (type-checks `.railway/railway.ts` against `railway` 3.16.0; a misspelt field fails here).
3. See what Railway has today without writing anything: `railway config pull --json` (prints the imported
   graph; never use `--include-variables`, it writes variable values into the file). Compare its service name,
   source, `build` and `deploy` blocks with §1.2.
4. Plan: `railway config plan`. Read every line. Expected: only **non-destructive** changes on `relay` — "Set
   variable" for the variables the dashboard does not have yet (`LOG_LEVEL`, `SESSION_TTL_S`, … with their default
   values, so the relay behaves exactly as before), and possibly settings the dashboard left at Railway's
   defaults (healthcheck timeout, restart policy, sleeping off). **Stop** if the plan wants to create or delete a
   service, delete a variable, change the source or the root directory, or shows anything marked destructive:
   correct `.railway/railway.ts` (service name, repository, a setting) and plan again.
5. Record the result (no values, no domain) in §1.5.
6. Apply when no session is running: `railway config apply`. Every apply that changes `build`, `deploy` or
   variables redeploys the relay and ends all sessions. A second `railway config plan` must then print "Your
   Railway configuration is already up to date."

Field names that only the SDK types confirm (builder, Dockerfile path, watch patterns, restart policy,
`sleepApplication`) are `[TODO verify]` until step 4 shows no unexpected change for them
(`docs/research/deploy-railway-iac.md` §2).

### 1.4 Plan and apply from GitHub Actions (optional, after §1.3)

`.github/workflows/railway.yml` plans every pull request that touches `.railway/**` and comments the plan on it;
after the merge it applies exactly that reviewed plan. Opt in:

1. Railway: project **Settings** → **Tokens** → create a **project token** for the `production` environment
   `[TODO verify]` (menu path). GitHub: **Settings** → **Secrets and variables** → **Actions** → **New repository
   secret** `RAILWAY_TOKEN` (§3).
2. GitHub: **Settings** → **Environments** → **New environment** `railway-production`; add **Required reviewers**
   (yourself) where your GitHub plan offers them — on a private repository they need GitHub Enterprise, so
   without it the opt-in variable below is the only gate.
3. Only after §1.3 ended with "already up to date": **Settings** → **Secrets and variables** → **Actions** →
   **Variables** → `RAILWAY_IAC_APPLY` = `true`.

Without `RAILWAY_TOKEN` the plan job skips its steps and stays green (forks, Dependabot); without
`RAILWAY_IAC_APPLY=true` no apply ever runs. A plan with destructive changes cannot be applied by CI
(`confirm-destructive: "false"`); a direct push to `main` has no reviewed plan, so its apply fails by design.
Merge `.railway/**` changes like deploys: when no session is running.

### 1.5 Plan record

| Date | CLI | Result of `railway config plan` (summary, no values) | By |
|---|---|---|---|
| — | — | not run yet (§1.3) | owner |

## 7. CI and branch protection

### 7.1 What runs

`.github/workflows/ci.yml` runs on every push to any branch, on every pull request and by hand (**Actions** →
**CI** → **Run workflow**). Its first job, `detect` (`.github/scripts/detect-changes.mjs`), compares the changed
files with the base and checks which components exist on the branch; the other jobs run only when they are needed:

| Job | Runs when | What it checks | Blocking |
|---|---|---|---|
| `detect` | always | change detection; the step summary lists each job's decision | yes |
| `repo-checks` | always | unit tests of `.github/scripts/`; `.railway/railway.ts` type-check | yes |
| `node 22` | `shared/`, `relay-server/`, `web-viewer/`, `tools/`, `package*.json` changed | `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check -w shared` (TypeScript half) | yes |
| `node 24 (non-blocking)` | as `node 22` | the same on the next Node LTS (NFR-41) | no |
| `python 3.12` | `shared/`, `slicer-plugin/`, `tools/fake-slicer/`, `package*.json` changed | vendored copy of `shared/py` up to date; `shared/py`: ruff, mypy, pytest, the Python half of `npm run check -w shared`; `slicer-plugin`: ruff, pytest with every opt-in gate required | yes |
| `docker` | the relay image's inputs changed (the Railway watch paths) | build of `relay-server/Dockerfile` from the repository root; smoke test (`/healthz` 200 within 10 s, `/api/version`, uid 1000); `docker-smoke` tests; on `main` only: push to `ghcr.io/<owner>/slicerremoteview-relay:sha-<commit>` | yes |
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
