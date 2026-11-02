# Research — Railway Infrastructure as Code (`.railway/railway.ts`) for the relay service

Status/date: research note (`deploy`), 2026-11-02. Sources: Railway docs (read through the Railway docs
search/fetch tools), npm registry (`npm view`), GitHub API (`gh api`, read-only), the `railway` npm package
3.16.0 type definitions and compiled code, and Railway CLI source at tag `v5.71.0`. Anything not confirmed is
marked `[TODO verify]`. No Railway project was read or changed for this note. Names below
(`<service-name>`, `<project-name>`, `<owner>/<repo>`) are placeholders.
Verified by an independent re-check on 2026-11-02; corrections: 10

Starting point: `docs/research/relay.md` §1.1–1.2, ADR 0007 (decisions 6–7), and the dashboard-made live
configuration described in `docs/user-guide/en/own-server.md` §2–§3 and "Good to know". That configuration is:
Dockerfile builder, Dockerfile path `/relay-server/Dockerfile`, root directory `/`, healthcheck `/healthz`,
1 replica in one region, Serverless off, an 11-line watch-path list with `!` negations, and the variables
`ALLOWED_ORIGINS` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`.

## 1. File format and TypeScript package

- One authoring file per project: `.railway/railway.ts`. TypeScript is generally available; `.py`/`.go` are
  beta. Keep only one of these files. Source: https://docs.railway.com/infrastructure-as-code
- The SDK package is `railway` on npm (`npm install railway`). The file imports from `railway/iac`, and its
  default export is `defineRailway(...)`, which returns `project(name, { resources: [...] })`. Services are
  declared with `service(name, config)`. Source: https://docs.railway.com/infrastructure-as-code/reference
- Minimal example from the docs (verified):

  ```ts
  import { defineRailway, project, service } from "railway/iac";

  export default defineRailway(() => {
    const web = service("web");
    return project("my-project", { resources: [web] });
  });
  ```

  Source: https://docs.railway.com/infrastructure-as-code/reference#authoring-railwayrailwayts
- Environment: the SDK exports no `environment(...)` helper. The file describes the desired state of the
  environment that the CLI targets, which is the linked environment or the environment of a project token.
  `defineRailway((ctx) => …)` receives `ctx.command`, `ctx.projectId`, `ctx.projectName`, `ctx.environmentId`,
  `ctx.environment`, `ctx.environmentName` and `ctx.isEnvironment(name)`.
  Source: https://docs.railway.com/infrastructure-as-code/reference#environment-context
  `ctx.shared.NAME` is documented in a different section:
  https://docs.railway.com/infrastructure-as-code/reference#environment-variables
  The `RailwayContext` type in `railway@3.16.0` also has `randomString()`, which is not documented.
  `ProjectDefinition` (the second argument of `project()`) also has an undocumented `environments?: string[]`
  field. Its effect is `[TODO verify]`. Do not use it.
- npm facts (`npm view railway`, 2026-11-02): latest `3.16.0` (published 2026-10-14), MIT license, repo
  `railwayapp/railway-ts-sdk`, `engines.node >=22`. It ships `.d.ts` files for the `./iac` export
  (`dist/iac/index.d.ts`), so no separate `@types` package exists or is needed.
  Source: https://www.npmjs.com/package/railway
- Local type check works (verified 2026-11-02 in a scratch directory). `railway@3.16.0` + `typescript@5.9.3`
  with `"module": "NodeNext", "moduleResolution": "NodeNext", "strict": true` → `tsc --noEmit` passes for a
  service using all fields in §2. A misspelt `deploy.drainingSecs` fails with TS2561 ("Did you mean
  'drainingSeconds'?"). The package's own `typecheck` script is `tsc --noEmit`.
  Source: package contents of https://www.npmjs.com/package/railway/v/3.16.0
- The CLI evaluates the file with Node's native type stripping (`node --experimental-strip-types`, Node ≥ 22.6).
  The SDK refuses to run under a CLI older than **5.42.1** ("The IaC engine now ships in the CLI").
  Sources: https://github.com/railwayapp/config/blob/9e17d413dbe219f19d62538d9c06b5dbb5e9abf8/action.yml ;
  `dist/iac/index.js` (`MINIMUM_IAC_CLI_VERSION`) in https://www.npmjs.com/package/railway/v/3.16.0
- `railway config plan` needs the SDK installed in the repository (`npm install railway`). For this npm
  workspace repo, that means a root `devDependency` recorded in `package-lock.json`, because the Action runs
  `npm ci` at the repository root in plan mode. Sources: https://docs.railway.com/cli/config#import-railway-state ;
  https://github.com/railwayapp/config (README "Notes")

## 2. Field names (mapping of the live configuration)

Fields on `service(name, config)`. "Doc" means shown in the IaC reference. "Type" means present only in the
`railway@3.16.0` type definitions (`IntentServiceConfig`, `BuildConfig`, `DeployConfig`), not documented.

| Setting | IaC field | Basis |
|---|---|---|
| Builder = Dockerfile | `build: { builder: "DOCKERFILE" }` (`"RAILPACK"` default) | Type. Same name/values as CaC `build.builder`: https://docs.railway.com/config-as-code/reference#specify-the-builder |
| Dockerfile path | `build: { dockerfilePath: "/relay-server/Dockerfile" }` | Type. CaC `build.dockerfilePath`: https://docs.railway.com/config-as-code/reference#dockerfile-path |
| Build command | `build: "cmd"` (string shorthand → `buildCommand`) or `build: { buildCommand }` | Doc + type: https://docs.railway.com/infrastructure-as-code/reference#build-and-start-commands |
| Root directory | `root` / `rootDirectory` on the service, or `github(repo, { rootDirectory })` | Doc (`github(..., { rootDirectory })`) + type: https://docs.railway.com/infrastructure-as-code/reference#larger-example. For `/`, omit it (see §4 risk) |
| Watch paths | `build: { watchPatterns: [...] }` | Type. CaC `build.watchPatterns`: https://docs.railway.com/config-as-code/reference#watch-patterns |
| `!` negation in watch paths | supported: gitignore-style; "negations will only work if you include files in a preceding rule" | Doc: https://docs.railway.com/builds/build-configuration#configure-watch-paths |
| Healthcheck path + timeout | `healthcheck: "/healthz"`, `healthcheckTimeout: <seconds>` | Doc: https://docs.railway.com/infrastructure-as-code/reference#healthchecks |
| Restart policy | `deploy: { restartPolicyType: "ON_FAILURE" \| "ALWAYS" \| "NEVER", restartPolicyMaxRetries: n }` | Type. CaC: https://docs.railway.com/config-as-code/reference#restart-policy-type |
| Replicas | `replicas: 1` → `deploy.numReplicas` | Doc: https://docs.railway.com/infrastructure-as-code/reference#replicas |
| Region | `replicas: { "<region id>": 1 }` → `deploy.multiRegionConfig` (`deploy.region` also exists in the type) | Doc (example uses `"europe-west4"`). Region ids from https://docs.railway.com/deployments/regions (EU: `europe-west4-drams3a`). Which id form IaC expects: `[TODO verify]` |
| Draining seconds | `deploy: { drainingSeconds: 30 }` | Type. CaC `deploy.drainingSeconds`: https://docs.railway.com/config-as-code/reference#draining-seconds |
| Overlap seconds | `deploy: { overlapSeconds: n }` | Type. CaC: https://docs.railway.com/config-as-code/reference#overlap-seconds |
| Serverless / app sleeping | `deploy: { sleepApplication: false }` | Type only. Not in IaC or CaC docs `[TODO verify]` |
| Start command | `start: "cmd"` (also `startCommand`, `deploy.startCommand`) | Doc: https://docs.railway.com/infrastructure-as-code/reference#build-and-start-commands |
| Pre-deploy | `preDeploy: "cmd"` | Doc: https://docs.railway.com/infrastructure-as-code/reference#pre-deploy-command |
| Service variables | `env: { KEY: "literal" }`; `db.env.X` / `svc.env.X` references; `ctx.shared.NAME` → `${{shared.NAME}}`; `preserve()` | Doc: https://docs.railway.com/infrastructure-as-code/reference#environment-variables |
| Custom domains | `domains: ["relay.example.org"]` or `[{ domain, port }]` | Doc: https://docs.railway.com/infrastructure-as-code/reference#custom-domains |
| Service (generated) domains | not representable: "Generated Railway service domains are not included in `.railway/railway.ts`"; `pull` "leaves out generated Railway domains" | Doc: https://docs.railway.com/infrastructure-as-code/reference#custom-domains ; https://docs.railway.com/infrastructure-as-code#import-an-existing-project |
| Sealed variables | `env: { KEY: { isSealed: true, value } }` (`VariableConfig.isSealed`) | Type only `[TODO verify]`. Docs only say sealed variables stay `preserve()` on `pull`: https://docs.railway.com/cli/config#import-railway-state |

Details:

- `RAILWAY_PUBLIC_DOMAIN`: Railway's template syntax for a variable of the same service is
  `${{ VARIABLE_NAME }}`, and Railway-provided variables are available inside references. Example in the docs:
  `API_URL=https://${{ backend.RAILWAY_PUBLIC_DOMAIN }}`. Source: https://docs.railway.com/variables#reference-variables
  - In IaC, a plain string is compiled to `{ type: "literal", value: "https://${{RAILWAY_PUBLIC_DOMAIN}}" }`
    (verified by evaluating a sample file locally).
  - The helper `svc.env.RAILWAY_PUBLIC_DOMAIN` returns a reference object, so it cannot be prefixed with
    `https://`. `RailwayProvidedVariable` in the types lists `RAILWAY_PUBLIC_DOMAIN`.
  - Whether Railway resolves a `${{…}}` template that arrives through an IaC literal: `[TODO verify]`.
    Expected yes, because it is the same stored value as a dashboard entry. Check it with a `plan` after `pull`.
- The SDK compiles `domains: ["x"]` with **port 8080** when no port is given (`normalizeNetworking` in
  `dist/iac/index.js`). Always give the relay's real port: `{ domain, port }`.
- Both `deploy.drainingSeconds` and the variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` exist. Railway does not
  document which one wins when both are set `[TODO verify]`. Choose one: the setting is preferred once IaC owns
  the service. Variable documented at https://docs.railway.com/deployments/deployment-teardown#draining-time.
- Unknown keys fail `tsc` (object-literal excess-property check). The CLI's own validation of `build`/`deploy`
  sub-keys is `[TODO verify]`.

## 3. CLI `railway config`

Subcommands. Source: https://docs.railway.com/cli/config

- `init`: creates `.railway/railway.ts` and `.railway/README.md`. It can scan the repository or import a
  project. Flag: `--force`.
- `pull`: imports the selected project/environment into the authoring file. Flags: `--force`, `--json`
  (prints the graph, writes nothing), `--runner`, `--omit-preserved-variables`, `--include-variables`
  (decrypts non-sealed values into the file; avoid), `--agent`.
  - What the importer does: it "keeps user-facing names, omits platform defaults, leaves out generated Railway
    domains, avoids internal IDs, and renders existing variable values as `preserve()`".
  - After a clean import, `railway config plan` prints "Your Railway configuration is already up to date."
  - Source: https://docs.railway.com/infrastructure-as-code#import-an-existing-project
  - **This is the supported path for the hand-made live service.** It needs no CaC migration, because the
    repository has no `railway.json`/`railway.toml` (checked 2026-11-02).
- `plan`: read-only diff.
  - Flags: `--file`, `--json`, `--decrypt-variables`, `--include-types`, `--runner`, `--verbose/--full`,
    `--detailed-exit-code` (0 = no changes, 2 = pending), `--show-values`, `--out <plan.json>` (pinned
    artifact: change set + `configEtag` + `.railway/` git tree), `--source-tree`.
  - Variable values are redacted (`«hidden»`) by default.
- `apply`: runs a fresh plan, then asks for confirmation.
  - Flags: `--yes`, `--confirm-destructive`, `--plan <file>`, plus the plan flags except
    `--detailed-exit-code`.
  - Non-interactive destructive changes need `--confirm-destructive`.
  - **`apply --json` applies non-destructive changes without prompting.**
  - It is rejected if the environment changed since the plan (etag).
  - Sources: https://docs.railway.com/infrastructure-as-code#apply-changes ; the `apply --json` warning is on
    https://docs.railway.com/cli/config#apply-changes
- `migrate`: converts `railway.json`/`railway.toml` to IaC. Flags: `--apply` (writes the file and clears the
  service's "Railway Config File" setting), `--delete-files`, `--service`, `--lang ts|py|go`, `--force`.
  This repository does not need it.
- `partials list|release|transfer`: ownership for multi-repo setups. We do not use it; one file per project.
  Source: https://docs.railway.com/cli/config#manage-partial-ownership

Authentication:

- Interactive use: `railway login` + `railway link`. If the directory is unlinked, `plan`/`apply`/`pull`
  prompt for project and environment. Source: https://docs.railway.com/infrastructure-as-code#install-or-upgrade-the-cli
- CI: a **project token** in `RAILWAY_TOKEN`, created for the target environment ("A project token is scoped
  to one environment"). Source: https://docs.railway.com/infrastructure-as-code#apply-from-github-actions
- `RAILWAY_API_TOKEN` (account/workspace token) is for account-level actions. Source: https://docs.railway.com/cli#tokens
- `partials` commands accept CLI login, `RAILWAY_API_TOKEN`, or an environment-scoped `RAILWAY_TOKEN`. Source:
  https://docs.railway.com/cli/config#manage-partial-ownership
- Whether `plan`/`apply` also accept `RAILWAY_API_TOKEN` (with `link`): `[TODO verify]`. Not needed: we use
  the project token.

What `apply` does to things not declared in the file:

- **Services/resources are deleted.** In a single-file (whole-project) setup, "omitting a resource means
  deleting it". Deletes are marked destructive. Source: https://docs.railway.com/infrastructure-as-code#one-file-per-project
  CLI code (`change_set.rs`, v5.71.0) emits `resource.delete` for every current resource missing from the
  file. The exception is **volumes, which are never deleted** (warning only).
  Source: https://github.com/railwayapp/cli/blob/v5.71.0/src/iac/change_set.rs
- **Variables are deleted** if the service declares `env` and a live variable is missing from it
  (`variable.delete`, destructive).
  - If a service declares **no** `env` while Railway has variables, plan fails with "declares no env but
    Railway has N variables … Declare them, mark them preserve(), or add them to variables.ignore".
  - A project-level `variables: { managed, ignore }` policy exists in the CLI. It is not in the docs or the
    SDK types `[TODO verify]`.
  - Docs only say "Destructive changes, such as deleting a service or variable, are marked before
    confirmation".
  - Sources: https://github.com/railwayapp/cli/blob/v5.71.0/src/iac/change_set.rs (`diff_variables`) ;
    https://docs.railway.com/infrastructure-as-code#apply-changes
- **Undeclared `build`/`deploy` settings:** the CLI compares the whole `build` and `deploy` objects after
  removing defaults (`RAILPACK`, `Dockerfile`, `V3`, empty build command, …). So a live non-default setting
  missing from the file probably shows as a change back to default. The current region is carried over only
  in one case: the file sets a numeric replica count (`replicas: 1` → `numReplicas`) and no region map, and
  the live service runs in exactly one region (`service_deploy_with_current_region`, `single_deploy_region`).
  Not documented `[TODO verify]` by reading a real `plan` output.
  Source: https://github.com/railwayapp/cli/blob/v5.71.0/src/iac/change_set.rs (`diff_top_level_field`, `normalize_for_diff`)

## 4. Is the file applied on push? Dashboard vs IaC

- **No automatic apply.** "Infrastructure as Code is evaluated by the Railway CLI", and "Railway doesn't read
  `.railway/` during deploys". Committing `.railway/railway.ts` changes nothing in Railway until someone runs
  `railway config apply` (locally or in CI, e.g. the Action in §5).
  Source: https://docs.railway.com/infrastructure-as-code#iac-vs-config-as-code ;
  https://docs.railway.com/infrastructure-as-code#multi-repo-projects
- Contrast with the old system: Config as Code (`railway.json`/`railway.toml`) was read from the repository on
  every deploy and overrode dashboard values. IaC has no repository-file auto-detection.
  Source: https://docs.railway.com/config-as-code
- "A service cannot be managed by both systems" means CaC **and** IaC. If a service is managed by
  `railway.json`/`railway.toml`, `plan` stops until it is migrated. Our service has no CaC file, so the rule
  does not apply. Still, confirm that the dashboard field "Railway Config File" is empty `[TODO verify]` (owner).
  Source: https://docs.railway.com/infrastructure-as-code#iac-vs-config-as-code
- Dashboard edits are **not documented as blocked** once IaC manages a service `[TODO verify]` whether the
  dashboard shows a lock or indicator. What is documented:
  - An apply is rejected when the environment changed between plan and apply ("for example a concurrent
    apply or a dashboard edit").
  - The Action fails on "Environment drifted (dashboard edit, …)" and asks for a re-plan.
  - Inference, not documented `[TODO verify]`: because the file is the desired state, the next fresh plan
    would propose reverting the dashboard edit to the file's value, so the edit would last only until the
    next apply.
  - Sources: https://docs.railway.com/infrastructure-as-code#apply-changes ; https://github.com/railwayapp/config
    ("Failure modes, by design")
- Safe adoption for the running service (keeps it running; an apply that changes `build`/`deploy`/variables
  triggers a deploy, `deployEffect: "deploy"` in the CLI change set, which ends running sessions):
  1. Owner, locally: `railway login`, `railway link` (the live project/environment), then `railway config pull`.
     The import writes `.railway/railway.ts` with `preserve()` for variable values and omits platform
     defaults (documented). That it also writes the GitHub source and every non-default build/deploy
     setting is expected but not documented `[TODO verify]` in the generated file.
  2. Add `railway` as a root devDependency (`npm i -D railway@3.16.0`) so `tsc` and the Action can resolve it.
  3. Run `railway config plan`. It must print "already up to date" before anything is committed. Read the file
     and check that `source`, root directory, watch patterns and region match §2.
  4. Only then make small edits, each reviewed through `plan` (PR comment) and applied on merge.
- Risks to check during step 3 `[TODO verify]`:
  - Omitting `source` compiles to `kind: "empty"` (verified locally). The docs say an omitted source is fine
    ("manage service settings but not declare a GitHub repository"), but the CLI diff code compares `source`
    as a whole. Keep the `github(...)` source that `pull` writes.
  - Setting `root`/`rootDirectory` without a `source` compiles to `source: { type: "empty", rootDirectory }`.
    Do not do this.
  - `project("<name>")` probably has to equal the linked project name. Use `ctx.projectName` or the name
    `pull` writes; the effect of a mismatch is undocumented.

## 5. GitHub Action `railwayapp/config`

- Repository: https://github.com/railwayapp/config ("GitHub Action for railway config plan/apply"), not
  archived. Official: linked from https://docs.railway.com/infrastructure-as-code#apply-from-github-actions
- Latest release: **`v1.2.0`** (published 2026-08-27). It is a lightweight tag →
  commit **`9e17d413dbe219f19d62538d9c06b5dbb5e9abf8`**. The floating tag `v1` points at the same commit.
  Checked with `gh api repos/railwayapp/config/releases/latest` and `…/git/ref/tags/v1.2.0`
  (`object.type: commit`). `main` is 2 commits ahead (README, `action.yml`: the `package-manager` input is not
  in v1.2.0). Pin: `railwayapp/config@9e17d413dbe219f19d62538d9c06b5dbb5e9abf8 # v1.2.0`.
- Inputs (v1.2.0 `action.yml`):
  - `command` (required): `plan` | `apply`.
  - `railway-token` (required): project token for the target environment.
  - `cli-version` (default `latest`; **pin it**, e.g. `5.71.0`).
  - `artifact-name` (default `railway-plan`), `plan-path` (default `railway-plan.json`).
  - `comment` (default `"true"`): posts or updates the PR plan comment.
  - `confirm-destructive` (default `"true"`; set `"false"` so destructive applies fail).
  - `github-token` (default `github.token`).
  - Source: https://github.com/railwayapp/config/blob/9e17d413dbe219f19d62538d9c06b5dbb5e9abf8/action.yml
- Behaviour:
  - Plan runs `railway config plan --out`, uploads the artifact and comments on the PR.
  - Apply downloads the artifact pinned to the PR head SHA and runs
    `railway config apply --plan … --yes [--confirm-destructive]`. It never re-plans.
  - Fork PRs get no secrets. The calling workflow skips them with its
    `head.repo.full_name == github.repository` guard; the action itself does not check this.
  - The action installs Node 24 (`actions/setup-node@v4`) and `npm install -g @railway/cli@<cli-version>`.
  - Source: same `action.yml` and README.
- Permissions:
  - Single workflow (README): `contents: read`, `pull-requests: write`, `actions: read`. The docs' copy of
    the same workflow also grants `id-token: write`:
    https://docs.railway.com/infrastructure-as-code#apply-from-github-actions
  - `id-token: write` is optional: with the Railway GitHub App installed, comments are posted as the Railway
    bot; otherwise they are posted as github-actions.
  - Split apply-on-push workflow: `contents: read`, `actions: read`, `pull-requests: read`.
  - Source: https://github.com/railwayapp/config (README)
- Example workflow (docs and README, single file, `on: pull_request` types
  `[opened, synchronize, reopened, closed]`, `paths: [".railway/**"]`):
  - Job `plan`: `if: github.event.action != 'closed' && <same-repo guard>`, steps `actions/checkout@v4` and
    `railwayapp/config@v1` with `command: plan`, `railway-token: ${{ secrets.RAILWAY_TOKEN }}`.
  - Job `apply`: `if: github.event.action == 'closed' && github.event.pull_request.merged && <guard>`, checks
    out `merge_commit_sha`, then `command: apply`.
  - Source: https://docs.railway.com/infrastructure-as-code#apply-from-github-actions
- In this repository:
  - Pin the actions by SHA (README examples use `@v4`/`@v1` tags).
  - The composite action itself uses tag-pinned `actions/setup-node@v4`, `actions/upload-artifact@v4` and
    `actions/github-script@v7`, which we cannot pin from outside.
  - Direct pushes to `main` that skip a PR have no pinned plan, so apply fails by design.

## 6. Config as Code deprecation timeline

- Docs: "Existing Config as Code files stop being read on **2026-12-01** (hard cutoff)" and "New services
  cannot opt into Config as Code." Source: https://docs.railway.com/infrastructure-as-code#iac-vs-config-as-code ;
  https://docs.railway.com/config-as-code
- Changelog #0304, published 2026-08-21 (URL slug `2026-08-20`):
  - "Starting August 28, services in new projects will no longer be deployed using Config as Code".
  - It also says "new services in existing projects should be fine". The docs now say "New services cannot
    opt into Config as Code"; the two texts differ, and the docs are the newer source `[TODO verify]` which
    applies. It does not matter for us: we never use CaC.
  - The old system goes away "on December 1".
  - Source: https://railway.com/changelog/2026-08-20-railway-anon
- Effect on us: none. There is no `railway.json`/`railway.toml` in the repository. The live service is
  configured in the dashboard, and dashboard settings are unaffected by the cutoff.

## 7. Railway CLI on npm

- `npm view @railway/cli version` → **`5.71.0`** (2026-11-02). GitHub release `v5.71.0` was published
  2026-10-19. Source: https://www.npmjs.com/package/@railway/cli ; https://github.com/railwayapp/cli/releases/tag/v5.71.0
- `railway config` needs CLI ≥ 5.42.1 for the current SDK (SDK check, §1). `tracing` in a config file needs
  CLI ≥ 5.63.0 and `railway` ≥ 3.12.0. Source: https://docs.railway.com/infrastructure-as-code/reference#tracing
- Install options: `npm i -g @railway/cli`, Homebrew, the install script, pre-built binaries, or the
  `ghcr.io/railwayapp/cli` container used in the PR-environment guide. In CI, prefer
  `npm install -g @railway/cli@5.71.0` (exact version), or the Action's `cli-version: 5.71.0`.
  Source: https://docs.railway.com/cli#installing-the-cli ; https://docs.railway.com/cli/deploying#pr-environments-with-github-actions

## Open / [TODO verify]

- [ ] IaC-documented names for builder, Dockerfile path, watch patterns, restart policy, draining/overlap
      seconds and `sleepApplication`. Only the SDK types and CaC docs confirm them; confirm with
      `railway config pull` output on the live service.
- [ ] Region key form in `replicas: { … }`: `europe-west4-drams3a` (regions page/CaC) vs `europe-west4`
      (IaC example).
- [ ] Whether the `https://${{RAILWAY_PUBLIC_DOMAIN}}` literal is stored and resolved like a dashboard
      reference, and plans as "no change" after `pull`.
- [ ] Precedence of `deploy.drainingSeconds` vs the `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable.
- [ ] Effect of undeclared `build`/`deploy` keys and of an omitted `source` on an existing GitHub-sourced
      service (CLI source suggests a reset to default, docs are silent).
- [ ] Project-level `variables: { managed, ignore }` policy (CLI code only, not in docs or SDK types).
- [ ] IaC support for sealing (`isSealed`): not documented. Do not put secrets in the file (use `preserve()`).
- [ ] Whether the dashboard shows or blocks IaC-managed settings, and whether a later plan reverts a
      dashboard edit (inferred, not documented).
- [ ] What `railway config pull` writes for the live service (GitHub source, build/deploy settings).
- [ ] Undocumented `ProjectDefinition.environments` and `ctx.randomString()` in the SDK types. Do not use them.
- [ ] Owner to confirm the service's "Railway Config File" setting is empty.
- [ ] Whether `plan`/`apply` accept `RAILWAY_API_TOKEN`. Not needed if we use a project token.
- [ ] Every apply that touches `build`/`deploy`/variables redeploys and drops running sessions. Schedule
      merges of `.railway/**` like deploys.

## Sources

- https://docs.railway.com/infrastructure-as-code
- https://docs.railway.com/infrastructure-as-code/reference
- https://docs.railway.com/cli/config
- https://docs.railway.com/cli
- https://docs.railway.com/cli/deploying#pr-environments-with-github-actions
- https://docs.railway.com/config-as-code
- https://docs.railway.com/config-as-code/reference
- https://docs.railway.com/builds/build-configuration#configure-watch-paths
- https://docs.railway.com/variables
- https://docs.railway.com/deployments/regions
- https://docs.railway.com/deployments/deployment-teardown#draining-time
- https://railway.com/changelog/2026-08-20-railway-anon
- https://www.npmjs.com/package/railway (v3.16.0 tarball: `dist/iac/index.d.ts`, `dist/index-*.d.ts`, `dist/iac/index.js`)
- https://www.npmjs.com/package/@railway/cli
- https://github.com/railwayapp/config ; https://github.com/railwayapp/config/blob/9e17d413dbe219f19d62538d9c06b5dbb5e9abf8/action.yml
- https://github.com/railwayapp/cli/blob/v5.71.0/src/iac/change_set.rs ; https://github.com/railwayapp/cli/blob/v5.71.0/src/iac/compiler.rs
- https://github.com/railwayapp/railway-ts-sdk
