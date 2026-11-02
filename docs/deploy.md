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

## 2. Variables

The relay reads these variables (`relay-server/src/config.ts`; the same names in `docs/architecture.md` §9,
`relay-server/.env.example` and `.railway/railway.ts`). `.github/scripts/check-env-parity.mjs --with-docs`, run by
CI, fails when a name is added to one of these four places only. An invalid value stops the relay at start with a
`fatal` log line naming the variable (never its value), so a typo shows as a failed deploy, not a running relay
with surprising limits.

| Variable | Default | Where it is set | Who may change it | Meaning |
|---|---|---|---|---|
| `PORT` | injected by Railway (`8787` locally) | Railway, automatically | nobody — never add it as a variable | listen port, `0.0.0.0` |
| `LOG_LEVEL` | `info` | `.railway/railway.ts` | owner (`debug` only briefly: more volume, same redaction) | pino level |
| `METRICS_TOKEN` | unset → `/metrics` answers `404` | Railway dashboard, sealed (§3); `preserve()` in the file | owner | bearer token of `GET /metrics` |
| `SESSION_TTL_S` | `1800` | `.railway/railway.ts` | owner, ≤ the protocol maximum | idle TTL without viewers |
| `PUBLISHER_GRACE_S` | `120` | `.railway/railway.ts` | owner, ≤ 120 | resume window after the publisher's drop |
| `SESSION_MAX_LIFETIME_S` | `43200` | `.railway/railway.ts` | owner, ≤ 43200 | hard cap per session |
| `CODE_QUARANTINE_S` | `600` | `.railway/railway.ts` | owner, ≥ 60 | a released code is not reissued for this long (ADR 0008) |
| `MAX_SNAPSHOT_BYTES` | `67108864` | `.railway/railway.ts` | owner, ≤ 64 MiB | per-snapshot cap |
| `MAX_TOTAL_SNAPSHOT_BYTES` | `536870912` | `.railway/railway.ts` | owner with `server` (memory budget, §6) | cached + assembling snapshots of all sessions |
| `MAX_TOTAL_BUFFERED_BYTES` | `167772160` | `.railway/railway.ts` | owner with `server` (memory budget, §6) | Σ viewer send buffers; slowest viewers closed `4010` above it |
| `MAX_VIEWERS` | `20` | `.railway/railway.ts` | owner, ≤ 20 | viewers per session |
| `MAX_SESSIONS` | `100` | `.railway/railway.ts` | owner | live sessions |
| `TRUST_PROXY` | `true` | `.railway/railway.ts` | owner after the hop count of §4 | client IP from the `X-Forwarded-For` entry the Railway edge adds; `false` locally |
| `ALLOWED_ORIGINS` | `https://${RAILWAY_PUBLIC_DOMAIN}` when empty | Railway dashboard (`https://<your-domain>`); `preserve()` in the file | owner, with every domain change (§5) | browser `Origin` allow-list of `/ws`, comma-separated, exact |
| `NODE_OPTIONS` | `--max-old-space-size-percentage=75` | `relay-server/Dockerfile` | `server` (a Railway variable would override the image) | heap size relative to the container memory |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` (Railway's own default is 0) | `.railway/railway.ts` | owner | SIGTERM → SIGKILL window; the relay drains with close `4008` inside it |

`RAILWAY_PUBLIC_DOMAIN` is injected by Railway (the generated domain) and only feeds the default of
`ALLOWED_ORIGINS`. The relay's test-only timer switch is never set on Railway, in `.railway/railway.ts` or in
`.env.example` (the parity check fails if it reaches `railway.ts`).

A changed variable takes effect with the next deploy, and every deploy ends the running sessions: change variables
when no session is running. With IaC in use (§1.4), change the declared ones in `.railway/railway.ts` through a
pull request; a dashboard edit of a declared variable is reverted by the next apply.

### 2.1 Local development

`cp relay-server/.env.example relay-server/.env` (git-ignored, CLAUDE.md rule 6), then for direct local access
`TRUST_PROXY=false` and `ALLOWED_ORIGINS=http://localhost:5173`. Put no real token in a local `.env` you build
images next to: the root `.dockerignore` excludes only a root-level `.env`, so `relay-server/.env` reaches the
image's build stage and the build cache (report 2026-10-20-server-9; not in the shipped image).

## 3. Secrets

| Secret | Where it lives | Used by | Create | Rotate |
|---|---|---|---|---|
| `RAILWAY_TOKEN` | GitHub → **Settings** → **Secrets and variables** → **Actions** → repository secret | `.github/workflows/railway.yml` only (§1.4) | Railway project → **Settings** → **Tokens** → project token for `production` `[TODO verify]` (menu path) | create a new token, replace the secret, delete the old token in Railway |
| `METRICS_TOKEN` | Railway → service **Variables**, sealed `[TODO verify]` (seal option) | the relay (`GET /metrics`) and whoever scrapes it | `openssl rand -base64 32` (≥ 32 printable characters) | set a new value; it takes effect with the deploy that follows (ends sessions); update the scraper |
| `GITHUB_TOKEN` | provided by GitHub per job | CI (GHCR push on `main`, plan comments) | automatic | automatic |

- Never put a secret into the repository, a workflow file, a pull request, an issue, a log line, a URL or a query
  string. `.github/scripts/scan-secrets.mjs` scans every tracked file in CI (non-blocking: it reports, it does not
  stop the run). A finding means: rotate the secret first, then remove it from the git history — deleting the line
  is not enough.
- CI needs no secret at all; pull requests from forks and from Dependabot get none.
- `/metrics`: without `METRICS_TOKEN` it answers `404` (endpoint disabled); with it, a request without or with
  another `Authorization: Bearer` token gets `401` with `WWW-Authenticate: Bearer`, the right token gets the
  Prometheus text format with relay-wide counters and gauges only — sessions, viewers, bytes, failed joins,
  rate-limit hits, reconnects, errors by code, quarantine evictions, memory (`relay-server/README.md`, "HTTP
  endpoints"; report 2026-10-27-server-7). No label carries a code, session, token or address, but a leaked token
  still shows activity and headroom over time: rotate it when in doubt.

## 4. First deploy checklist

Run once after the relay is deployed on Railway (DEP-06), and again after a change of the Dockerfile, the region or
the plan. It is the owner's check against the owner's relay; the agents never send traffic to it. Use a computer on
a direct connection (no corporate or hospital proxy), because the `X-Forwarded-For` count of item 4 is read from
your own request. Fill the result column with `pass`/`fail` and the date; a `fail` becomes a report in
`docs/testing/reports/` for the component that owns it. Write no domain, code or token into this table.

Commands use `<your-domain>`; `fake-slicer` is the repository's publisher simulator (`npm ci && npm run build -w
shared -w tools/fake-slicer` at the repository root first). Its session code goes only to the file descriptor given
with `--code-fd`, never to the terminal.

| # | Check | How | Expected | Result (date) |
|---|---|---|---|---|
| 1 | The image builds on Railway with the repository root as context | Deployments → newest → **Build Logs** | the Dockerfile `/relay-server/Dockerfile` is used, both stages succeed (`COPY shared/…` works, ADR 0007) | |
| 2 | `/healthz` over HTTPS, TLS 1.2+ only | `curl -sS -w '\n%{http_code} %{ssl_version}\n' https://<your-domain>/healthz`; `curl -sS --tls-max 1.1 https://<your-domain>/healthz` | `{"status":"ok","uptimeS":…,"sessions":…,"viewers":…,"version":…}` and `200 TLSv1.3` (or 1.2); the second command fails | |
| 3 | `/healthz` has no memory figures and no session data | the body of item 2 | only `status`, `uptimeS`, `sessions`, `viewers`, `version` (NFR-38) | |
| 4 | `X-Forwarded-For`: how many entries the edge adds | right after a deploy, as the **first** WebSocket of that deployment: `node tools/fake-slicer/bin/fake-slicer.js --relay wss://<your-domain>/ws --exit-after-ack --code-fd 3 3>/dev/null`; then the deploy log line `first websocket upgrade` | `xff: "present"`, `xffEntries: 1` (the edge is the only hop: `TRUST_PROXY=true` is right). More than 1: report to `server` (report 2026-10-18-server-1) | |
| 5 | The relay starts as configured | deploy log line `relay starting` | `trustProxy: true`, `testFastTimers: false`; note `heapSizeLimit` (item 9) | |
| 6 | Publish over `wss://` and join from a phone | `node tools/fake-slicer/bin/fake-slicer.js --relay wss://<your-domain>/ws --code-fd 3 3>code.txt` (keeps running); open `https://<your-domain>/` on a phone on mobile data, type the code from `code.txt`; then delete `code.txt` | the phone shows the fixture scene (NFR-14) | |
| 7 | A foreign browser origin is refused | `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://example.com' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://<your-domain>/ws` | `403` (FR-33); the phone of item 6 (its own origin) works | |
| 8 | Redeploy drains instead of cutting | with item 6 still connected, **Deployments** → **Redeploy**; watch the old deployment's log and fake-slicer's output | the old relay logs `shutting down` and ends within `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (30 s) without `shutdown timed out`; clients are closed with `4008` and the publisher resumes on the new deployment (T9; SRV-17) `[TODO verify]` exact client output | |
| 9 | Heap size inside the container | `heapSizeLimit` of item 5 | about 75 % of the container memory (`NODE_OPTIONS=--max-old-space-size-percentage=75`). Railway sizes the container to the plan's per-replica cap (Hobby: 8 GB), so expect ~6 GB: lower it with **Settings** → **Deploy** → **Replica Limits** (memory, e.g. 1–2 GB, §6) `[TODO verify]` that `heapSizeLimit` follows | |
| 10 | Query strings in the edge's HTTP logs | `curl -sS -o /dev/null 'https://<your-domain>/healthz?probe=1'`; **Observability** → HTTP logs, filter the path | record whether `path` shows `?probe=1` (T6; the relay never puts codes or tokens in a URL, so either answer is safe — it decides whether query strings may ever be used) | |
| 11 | `ALLOWED_ORIGINS` names the domain phones open | service **Variables** | exactly `https://<your-domain>` (or empty for the generated domain); otherwise phones show "Connection lost" | |

## 5. Custom domain and TLS

The generated `<name>.up.railway.app` domain is enough to run (HTTPS, a Let's Encrypt certificate). A domain of your
own (DEP-07) gives a stable address for the Slicer setting, the QR code and the user guides, and lets the relay's
HSTS header (`includeSubDomains`, SRV-16) cover a dedicated host name only (report 2026-10-27-protocol-4, item 7).
Use a **dedicated subdomain** such as `relay.example.org`, never the apex of a domain that serves other sites.

1. Railway: service **Settings** → **Networking** → **Public Networking** → **+ Custom Domain**, enter
   `relay.example.org`. Railway shows a `CNAME` record (target `<something>.up.railway.app`) and a `TXT` record
   (ownership). Add **both** at your DNS provider; without the TXT record the domain answers `404`.
2. Wait until Railway shows the certificate as issued (usually within an hour, up to 72 h). Behind Cloudflare's
   proxy, set SSL/TLS to **Full** (not Flexible: redirect loop; not Full (strict) during issuance).
3. Check: `curl -sSI https://relay.example.org/healthz` → `HTTP/2 200` with a `strict-transport-security` header,
   and `openssl s_client -connect relay.example.org:443 -servername relay.example.org < /dev/null | grep -E
   'Verify return code|subject='` → `Verify return code: 0 (ok)`. Hospital networks that inspect TLS replace the
   chain with their own; the relay cannot change that (R-10) — test from such a network before relying on it.
4. Variables: `ALLOWED_ORIGINS=https://relay.example.org` (only the new origin once everyone uses it; both,
   comma-separated, during the switch). Deploy when no session runs. Item 7 of §4 must still answer `403`.
5. Slicer: the relay address becomes `wss://relay.example.org/ws`. The QR code fits a host of at most 48 characters
   (report 2026-10-21-slicer-1); a short subdomain keeps the link scannable.
6. Keep the generated domain as a fallback: it stays on the service next to the custom one (Railway allows one
   generated domain and several custom ones per service; that adding a custom domain never removes the generated
   one is `[TODO verify]` at the first setup). A phone opening the fallback needs its origin in `ALLOWED_ORIGINS`
   too.

Limits: Hobby 2 custom domains per service, Pro 20. Do not delete and re-add a domain repeatedly: Let's Encrypt
issues at most 5 duplicate certificates per week. With IaC (§1.4), a custom domain can be declared as
`domains: [{ domain: "relay.example.org", port: <the port of the "relay listening" log line> }]` — the SDK assumes
port 8080 when none is given; until that is verified with a plan, keep domains in the dashboard `[TODO verify]`.

Record (no domain): date the custom domain went live, certificate check result, `ALLOWED_ORIGINS` switched on.

## 6. Cost, egress and log retention

Railway bills usage per second: RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB (2026-11). Hobby costs
$5/month including $5 of usage; Pro $20 including $20 (`docs/research/deploy-railway-ops.md` §4).

| Item | Where | Setting (DEP-08) |
|---|---|---|
| Spending alert | workspace **Usage** → **Set Usage Limits** → **Custom email alert** | e.g. $10 on Hobby: an email, nothing stops |
| Hard limit | same page → **Hard limit** | optional; when reached **every service goes offline** (sessions end); minimum $10 |
| Egress alert (NFR-34: warn at 150 GB, alert at 200 GB per month) | only with **Pro**: project **Observability** → network egress widget → **Add monitor** | Hobby has no per-metric alert: 150 GB ≈ $7.50 of egress, so a dollar alert near the expected monthly total is the proxy; check **Usage** monthly |
| Memory per replica | service **Settings** → **Deploy** → **Replica Limits** | cap memory (e.g. 1–2 GB) so that a leak fails fast instead of growing to the plan cap (8 GB on Hobby) and costing money |
| Metrics | service **Metrics** tab (CPU, memory, network; up to 30 days) | look at memory after a busy day (NFR-06): it should return near the idle level |
| Logs | service **Logs**, **Observability** → HTTP logs | retention Hobby 7 days, Pro 30 days; 500 lines/s per replica; no export without extra services |

Estimate (one replica, mostly idle, relay.md §1.7): ~0.1 vCPU and ~0.2 GB RAM average ≈ $2 + $2 a month, plus
egress — a 20 MB scene sent to 20 viewers is 0.4 GB, so 150 GB is ~375 such sends a month. The memory budgets of the
relay (`MAX_TOTAL_SNAPSHOT_BYTES` 512 MiB + `MAX_TOTAL_BUFFERED_BYTES` 160 MiB, outside the heap) plus the heap must
fit the replica's memory limit: with a 1 GB limit and the default 75 % heap share they do not (report
2026-10-20-server-9) — pick the limit with `server` (`docs/architecture.md` §4), e.g. 1.5 GB, or lower the budgets.

Privacy (T5, for an institutional review, `docs/security.md`): Railway publishes a GDPR data processing agreement
(railway.com/legal/dpa) and a sub-processor list (trust.railway.com). Its primary processing is in the United States;
an EU region places the relay's compute in the EU, but whether logs and metadata stay in the EU is `[TODO verify]`.
The relay stores nothing on disk and logs no scene data, codes or tokens (CLAUDE.md rule 6), so what passes through
Railway is transient traffic plus the HTTP edge log (paths, source IPs, user agents).

## 7. CI and branch protection

### 7.1 What runs

`.github/workflows/ci.yml` runs on every push to any branch, on every pull request and by hand (**Actions** →
**CI** → **Run workflow**). Its first job, `detect` (`.github/scripts/detect-changes.mjs`), compares the changed
files with the base and checks which components exist on the branch; the other jobs run only when they are needed:

| Job | Runs when | What it checks | Blocking |
|---|---|---|---|
| `detect` | always | change detection; the step summary lists each job's decision | yes |
| `repo-checks` | always | unit tests of `.github/scripts/`; actions pinned to SHAs; env parity (§2); `.railway/railway.ts` type-check; secret scan (non-blocking step, §3) | yes |
| `node 22` | `shared/`, `relay-server/`, `web-viewer/`, `tools/`, `package*.json` changed | `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check -w shared` (TypeScript half) | yes |
| `node 24 (non-blocking)` | as `node 22` | the same on the next Node LTS (NFR-41) | no |
| `python 3.12` | `shared/`, `slicer-plugin/`, `tools/fake-slicer/`, `package*.json` changed | vendored copy of `shared/py` up to date; `shared/py`: ruff, mypy, pytest, the Python half of `npm run check -w shared`; `slicer-plugin`: ruff, pytest with every opt-in gate required | yes |
| `docker` | the relay image's inputs changed (the Railway watch paths) | build of `relay-server/Dockerfile` from the repository root; smoke test (`/healthz` 200 within 10 s, `/api/version`, uid 1000); `docker-smoke` tests; on `main` only: push to `ghcr.io/<owner>/slicerremoteview-relay:sha-<commit>` | yes |
| `e2e (non-blocking)` | `tests/package.json` exists and `tests/`, the relay, the viewer, `shared/`, fake-slicer or `package*.json` changed | `npm --prefix tests run lint`, then `run e2e` (Playwright: iPhone 15/WebKit, Pixel 7/Chromium, desktop Chromium) against a locally started relay | no (§7.5) |
| `security (non-blocking)` | as `e2e` | `npm --prefix tests run security` (passes while there is no spec yet) | no (§7.5) |
| `load smoke (non-blocking)` | the relay, `shared/`, fake-slicer or `package*.json` changed, or as `e2e` | `npm run load:smoke -w relay-server` (SRV-21); with `tests/`: `npm --prefix tests run load:smoke` | no (§7.5) |
| `audit (non-blocking)` | always | `npm audit --omit=dev`, `pip-audit` (§7.4) | no |
| `ci-ok` | always | fails when a blocking job failed or was cancelled; passes when they passed or were skipped | **the required check** |

A push to a branch is compared with `main` and a pull request with its base, both through the merge base: every run
checks everything the branch changed, so a failed or cancelled earlier run cannot be hidden by a later docs-only
push. A full run (every job whose component exists) happens on a push to `main`, a manual run, and whenever
`.github/workflows/` or `.github/scripts/` change. A branch that changes only `docs/` runs `detect`, `repo-checks`,
`audit (non-blocking)` and `ci-ok`. A newer push cancels the older run of the same branch or pull request; on `main`
every commit has its own run, never cancelled.

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
not fail its run. Railway asks that runs are not cancelled while queued: on `main` each commit has its own
concurrency group in `ci.yml`, so none is.

### 7.4 Supply chain (Dependabot, audit, pinned actions)

- **Dependabot** (`.github/dependabot.yml`, weekly): npm at the root (all workspaces share one lockfile) and in
  `.railway/`, pip in `shared/py` and `slicer-plugin`, the pinned GitHub Actions, and the relay's base image
  (`node:22-alpine`, no major bumps). Minor and patch updates come grouped, one pull request per ecosystem. Its pull
  requests get no secrets and run the same CI. Merging an npm update changes `package-lock.json` and therefore
  **redeploys the relay**: merge them when no session is running. A pip bump of `slicer-plugin` must be followed by
  regenerating `slicer-plugin/requirements-dev.txt` (`slicer-plugin/README.md`). Check after the first run that the
  root npm entry covers every workspace `[TODO verify]`.
- **`audit (non-blocking)`** runs on every push: `npm audit --omit=dev` (the relay image's production tree) and
  `pip-audit` (the Python dev/test pins and `shared/py`). It reports and never blocks; a finding goes to the owning
  component as a report under `docs/testing/reports/` (the first one: `2026-11-02-deploy-1.md`).
- **Pinned actions**: every `uses:` names a 40-character commit SHA with the version as a comment;
  `.github/scripts/check-pinned-actions.mjs` (in `repo-checks`) fails on a tag or branch reference. Dependabot keeps
  the SHAs and comments current. `railwayapp/config` itself uses tag-pinned actions inside; that cannot be pinned
  from here.
- **CODEOWNERS** is not added: on a private repository it needs GitHub Pro, Team or Enterprise, and every component
  has the same maintainer today.

### 7.5 Making the qa jobs required

`e2e`, `security` and `load smoke` start as non-blocking (DEP-10): they report, and their artefacts
(`e2e-results`, `security-results`, `load-smoke-results`: Playwright traces and the relay's `relay.log` for the
QA-07 log grep, kept 7 days) can be downloaded from the run page. A trace can show a session code typed on screen,
so treat artefacts as internal and never attach them to an issue. Each suite starts its own relay on `127.0.0.1`;
none of them ever contacts a deployed relay.

Once a job has been green for two weeks, make it blocking in `.github/workflows/ci.yml`: delete its
`continue-on-error: true` line and add the job's id to the `needs:` list of `ci-ok` (one line each, for example
`needs: [detect, repo-checks, node, python, docker, e2e]`). Branch protection needs no change: `ci-ok` stays the
only required check.

## 8. Releasing

`.github/workflows/release.yml` runs when a tag `v*` is pushed (DEP-11). It never deploys: the relay on Railway
follows `main`, not tags.

1. On `main`, `release` adds a section `## [X.Y.Z] - YYYY-MM-DD` to `CHANGELOG.md` (the only source of the release
   text) and aligns the versions (prompts/08).
2. Tag the commit and push the tag: `git tag vX.Y.Z` then `git push origin vX.Y.Z` (a tag with a hyphen, such as
   `v0.0.1-rc.1`, makes a pre-release).
3. The workflow:
   - takes the tag's section from `CHANGELOG.md` (`.github/scripts/changelog-section.mjs`) and fails with a clear
     message when there is none;
   - builds `SlicerRemoteView-X.Y.Z.zip` with `slicer-plugin/scripts/package.py` (SLC-20; fails while that script
     does not exist) and fails if the archive lists a `.env`, `.npmrc`, key or keystore file;
   - builds the relay image and pushes `ghcr.io/<owner>/slicerremoteview-relay:X.Y.Z` (and `:sha-<commit>`);
   - creates a **draft** release with the notes, the zip and a checklist line for the Quest APK.
4. Open **Releases**, attach the APK by hand (QST-15), read the draft, **Publish release**.

A failed run leaves no release behind except, possibly, a pushed image; fix the cause, delete the tag
(`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`) and tag again.
