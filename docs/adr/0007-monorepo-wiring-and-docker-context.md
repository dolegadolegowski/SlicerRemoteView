# ADR 0007: Monorepo wiring — npm workspaces, vendored shared types, root Docker context, single Railway replica, Railway IaC

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `protocol` (`shared/`, `tools/`), `server`, `web`, `slicer`, `quest`, `deploy`
- **Related:** `CLAUDE.md` (component map, deploy row), `docs/architecture.md` (deployment view, single-replica
  limit in the threat model), `docs/protocol.md` (schema is the source of generated types), ADR 0002 (stack),
  ADR 0006 (viewer served by relay), ADR 0008 (resume token covers redeploys)

## Context

One repository holds five deployables in four languages: `shared/` (JSON Schema + generated TS/Python/C#),
`relay-server/` (Node), `web-viewer/` (Vite), `tools/fake-slicer/` (Node), `slicer-plugin/` (Python inside
Slicer), `quest-app/` (Unity). Constraints and verified facts (`docs/research/relay.md`, `slicer.md`, `quest.md`):

- An installed Slicer extension is a self-contained directory; its Python module cannot import from `../shared`
  outside the extension. Slicer forbids pip installs at import and only bundles numpy etc.
- Unity consumes C# sources from `Assets/` (or a local UPM package); generated DTOs need Newtonsoft annotations
  and a `link.xml` for IL2CPP (`quest.md` §6).
- Railway auto-detects a root `Dockerfile`; another path via `RAILWAY_DOCKERFILE_PATH`. **Build context is not
  documented**; the *Root Directory* setting "only pull[s] down files from that directory" → with Root Directory
  `relay-server/` the Dockerfile could not `COPY shared/ web-viewer/` `[TODO verify]`. `.dockerignore` support is
  not mentioned (standard Docker behaviour expected).
- `railway.json`/`railway.toml` **config-as-code is deprecated**: new services cannot opt in; existing files stop
  being read on **2026-12-01**. Replacement: Infrastructure as Code `.railway/railway.ts` with
  `railway config init | pull | plan | apply`, GitHub Action `railwayapp/config`. IaC field names for draining/
  overlap seconds, region, restart policy and Dockerfile path are `[TODO verify]` in the IaC reference.
- Railway load-balances **randomly** across replicas and has **no sticky sessions**; a redeploy drops all in-memory
  state and WebSockets (SIGTERM with 0 s grace by default; `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`).
- `node:22-alpine` is 60.7 MB compressed (`node:22-bookworm-slim` 79.8 MB); no native add-ons needed
  (`bufferutil` unnecessary on Node ≥ 18.14). docker-node best practices: `USER node`, `CMD ["node", …]` (not
  `npm start`, which swallows SIGTERM), `dumb-init`/`--init` because Node is not designed as PID 1.

## Decision

1. **npm workspaces** in the root `package.json`: `shared`, `relay-server`, `web-viewer`, `tools/fake-slicer`;
   **one `package-lock.json`**; root scripts `build`, `test`, `lint`, `generate` (schema → types). Node 22 / npm 10
   `[TODO verify]` npm version bundled with the chosen `node:22-alpine` tag.
2. **`shared/`** holds the JSON Schema (`shared/schema/*.json`) and generated outputs: `shared/ts/` (consumed via
   workspace dependency), `shared/py/` (Python types + pure helpers), `shared/cs/` (Newtonsoft DTOs via NJsonSchema
   or quicktype `[TODO verify]` draft support). Generated files are committed so Slicer/Unity builds need no Node.
3. **Vendoring for Slicer:** a build script (`slicer-plugin/scripts/vendor_shared.py` or npm `vendor:slicer`)
   copies `shared/py/` into `slicer-plugin/RemoteView/_vendor/remoteview_protocol/`; the module imports from the
   vendored package only. CI fails if the vendored copy differs from `shared/py/`.
4. **Generation for Unity:** `shared/cs/` is generated into `quest-app/Assets/RemoteView/Protocol/Generated/`
   (own `.asmdef` + `link.xml`); CI fails on drift. No runtime dependency between `quest-app/` and Node.
5. **Docker:** `relay-server/Dockerfile`, **build context = repository root**, root `.dockerignore` excluding
   `quest-app/`, `slicer-plugin/`, `docs/`, `tests/`, `.git/`, `node_modules/`. Multi-stage: stage 1 `node:22-alpine`
   `npm ci` (workspaces) → `npm run build -w shared -w web-viewer -w relay-server`; stage 2 `node:22-alpine` with
   `npm ci --omit=dev -w relay-server`, `relay-server/dist`, `web-viewer/dist` → `public/`, `dumb-init`,
   `USER node`, `ENV NODE_OPTIONS=--max-old-space-size-percentage=75`, `CMD ["dumb-init","node","dist/index.js"]`.
6. **Railway:** one service, Root Directory `/`, `RAILWAY_DOCKERFILE_PATH=relay-server/Dockerfile`, watch paths
   `relay-server/**`, `shared/**`, `web-viewer/**`, `package*.json`; **exactly one replica** (in-memory sessions);
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`; healthcheck `/healthz`; EU region (`europe-west4-drams3a`,
   plan gating `[TODO verify]`); Serverless/app sleeping off.
7. **Railway configuration as IaC:** `.railway/railway.ts` managed with `railway config plan/apply` (GitHub Action
   plans on PRs touching `.railway/**`, applies on merge to `main`). No `railway.json`/`railway.toml` is created.
   **Consequence applied to `CLAUDE.md`:** the `deploy` row lists `.github/`, `.railway/`, `Dockerfile`
   instead of `railway.*` (updated 2026-10-17 by `release`).

## Consequences

**Positive**

- One install, one lockfile, one `npm run build` for everything Node; the relay image builds the viewer with the
  exact `shared/` version it serves (ADR 0006).
- Slicer and Unity stay buildable without Node; generated code is reviewed in PRs like any other code.
- The single-replica constraint is explicit and documented where it matters (threat model: session loss on
  redeploy/crash; mitigated by resume tokens, ADR 0008).
- IaC avoids the 2026-12-01 config-as-code cutoff and gives reviewable infrastructure diffs.

**Negative**

- Generated artefacts in git create drift risk → CI drift checks are mandatory.
- Root build context sends more files to the Docker daemon; `.dockerignore` must be maintained (Unity assets are
  large).
- Railway's build-context behaviour is undocumented; the first deploy must confirm `COPY shared/ …` works with
  Root Directory `/` `[TODO verify]`; fallback is building the image in GitHub Actions and deploying the image.
- One replica = no horizontal scaling and a hard restart on every deploy (all sessions dropped).
- IaC field names are unverified until `deploy` reads the reference; the dashboard remains the fallback.

**Follow-ups**

- `deploy` (`DEP-`): first deploy verifies context, `X-Forwarded-For`, PID 1 behaviour, IaC fields; writes
  `docs/deploy.md`.
- `protocol` (`PRO-`): generator choice + drift-check scripts (`npm run generate && git diff --exit-code`).
- `slicer` (`SLC-`): vendoring script + CMake `MODULE_PYTHON_RESOURCES`/scripts list including `_vendor/`.
- `quest` (`QST-`): `.asmdef` + `link.xml` for the generated DTO assembly.
- `release`: keep `CLAUDE.md` "Komendy projektu" in sync with root workspace scripts.

## Alternatives considered

- **pnpm + Turborepo (or Nx).** Not evaluated in the research notes; rejected on scope: four small Node packages
  do not need task graph caching, and npm workspaces ship with Node 22 (no extra toolchain in the Docker image).
- **Git submodules for `shared/`.** Rejected: protocol changes must land atomically with relay/viewer changes
  (CLAUDE.md rule 2); submodules make that a multi-repo dance.
- **Per-package Dockerfiles with `relay-server/` as context.** Rejected: the relay image needs `web-viewer/dist`
  and `shared/`; would require publishing build artefacts between images or committing `dist/`.
- **Railway "build from subdirectory" (Root Directory `relay-server/`).** Rejected pending `[TODO verify]`: the
  documented behaviour implies files outside the root directory are not pulled, breaking `COPY shared/`.
- **Multiple replicas with Redis pub/sub.** Rejected for this project: adds a stateful service holding medical
  bytes (rule 6), and Railway's edge cannot route by session code.
- **Keep `railway.json`.** Rejected: deprecated, stops being read 2026-12-01.

## Sources

- Railway Dockerfiles: https://docs.railway.com/guides/dockerfiles ; https://docs.railway.com/builds/dockerfiles.md
- Railway monorepo / root directory / watch paths: https://docs.railway.com/guides/monorepo
- Railway config-as-code (deprecated): https://docs.railway.com/reference/config-as-code ; Infrastructure as Code: https://docs.railway.com/infrastructure-as-code ; changelog: https://railway.com/changelog/2026-08-20-railway-anon
- Railway scaling (random distribution, no sticky sessions): https://docs.railway.com/reference/scaling ; deployments (SIGTERM, draining): https://docs.railway.com/reference/deployments
- Railway healthchecks / variables / regions / app sleeping: https://docs.railway.com/reference/healthchecks ; https://docs.railway.com/reference/variables ; https://docs.railway.com/reference/regions ; https://docs.railway.com/reference/app-sleeping
- docker-node README and best practices (`USER node`, `CMD node`, `dumb-init`): https://github.com/nodejs/docker-node ; https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md ; image sizes: https://hub.docker.com/_/node
- Node CLI (`--max-old-space-size-percentage`): https://nodejs.org/api/cli.html
- Slicer Python FAQ (no pip at import; packaging): https://slicer.readthedocs.io/en/latest/developer_guide/python_faq.html ; Extensions guide: https://slicer.readthedocs.io/en/latest/developer_guide/extensions.html ; scripted module CMakeLists: https://github.com/Slicer/Slicer/blob/main/Utilities/Templates/Modules/Scripted/CMakeLists.txt
- Unity IL2CPP stripping / Newtonsoft package: https://docs.unity3d.com/Manual/IL2CPP-BytecodeStripping.html ; https://docs.unity3d.com/Packages/com.unity.nuget.newtonsoft-json@3.2/changelog/CHANGELOG.html ; NJsonSchema: https://github.com/RicoSuter/NJsonSchema
