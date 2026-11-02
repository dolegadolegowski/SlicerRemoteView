# tests — system E2E, security and load tests (Playwright)

Part of **SlicerRemoteView**. Owned by the `qa` workstream (branch `ws/qa`, plan `docs/plan/qa.md`). Contract:
`docs/protocol.md`. Rules: `CLAUDE.md`. Strategy: `docs/testing/strategy.md`; threat → test map: `docs/security.md`.

## Purpose

Black-box checks of the whole system: the **built** relay (`relay-server/dist`) serving the **built** web viewer
(`web-viewer/dist`), with `tools/fake-slicer` as the publisher. Every suite starts its own relay on `127.0.0.1`
(a free port per test) — never the live Railway relay or any other remote host.

`tests/` is not an npm workspace: it has its own `package.json` and lockfile and is run with `npm --prefix tests`.
The relay's own dependencies and the `@slicerremoteview/*` packages resolve from the root `node_modules`.

## How to run

From the repository root, Node 22:

```bash
npm ci && npm run build                      # root workspaces: shared, relay-server, web-viewer, fake-slicer
npm --prefix tests ci                        # Playwright 1.60.0, ws, typescript
(cd tests && npx playwright install chromium webkit)   # once per machine (CI caches the browsers)
npm --prefix tests run e2e -- --grep smoke   # boots the stack, opens /, stops (a few seconds)
```

| Command | What it runs | CI |
|---|---|---|
| `npm --prefix tests run e2e` | `e2e/` on `iphone15` (WebKit), `pixel7` (Chromium, SwiftShader WebGL) and `desktop-chromium` (smoke only): `smoke`, `join` (QA-03), `live` (QA-04) | yes (`e2e` job, DEP-10) |
| `npm --prefix tests run e2e -- join` | one spec by file-name filter (any Playwright CLI argument works after `--`) | — |
| `npm --prefix tests run security` | `security/`: `join` (QA-05), `payload` (QA-06), `auth` (QA-14), `logs` (QA-07), `glb-fuzz` (QA-13), `headers` (QA-09); raw `ws` + `fetch`, a browser for `logs` and `glb-fuzz` | yes (`security` job) |
| `npm --prefix tests run load:smoke` | `load/smoke.spec.ts` (QA-08): the five load scenarios scaled down, one at a time, ≈ 30 s | yes (`load-smoke` job) |
| `npm --prefix tests run load:full` | `load/full.spec.ts`: full sizes and durations, ≈ 2 min; results go to `load/REPORT.md` | no (reference machine) |
| `npm --prefix tests run triage` | `scripts/report-index.mjs --check`: `docs/testing/reports/TRIAGE.md` is current, every report has an owner and a status (QA-10); `node tests/scripts/report-index.mjs` regenerates it | yes (`lint` job) |
| `npm --prefix tests run lint` | `tsc --noEmit` over the suite | yes |
| `npm --prefix tests run all` | QA-12 release regression: lint, triage, e2e, security, load:smoke in order, a summary table, exit 1 on any failure | release check |

Load specs measure the machine, so run them alone: `-- --repeat-each=3 --workers=1` for a stability run.

Environment knobs: `GLB_FUZZ_SEED` (decimal or `0x…`), `GLB_FUZZ_COUNT` (default 200) and `GLB_FUZZ_ONLY=<index>`
reproduce one fuzz mutant (`GLB_FUZZ_SEED=<n> GLB_FUZZ_ONLY=<i> npm --prefix tests run security -- glb-fuzz`; a
failure prints that command); `LOG_FILE=<relay log or directory>` makes `logs.spec.ts` also grep a CI artefact
with the secret-independent rules.

Logs of every test are kept in `tests/test-results/<test>/stack-<n>/` (`relay.log`, `publisher.log`; git-ignored,
uploaded by CI). They never hold the session code or a token (`logs.spec.ts` checks it). Locally a failing test
also keeps its Playwright trace; under `CI=1` there are **no traces and no HTML report**
(`playwright.config.ts`), because both record step titles and request headers — the typed code, the `/j#<code>`
navigation, `Authorization: Bearer <viewerToken>` — and CI artefacts must not hold them (NFR-12). Codes and tokens
in a local trace belong to a relay that lived for one test only; still, do not share traces.

On macOS, which has no `timeout`, bound a run with `perl -e 'alarm shift; exec @ARGV' 600 npm --prefix tests run e2e`.

## Harness (`harness/`)

| File | Role |
|---|---|
| `paths.ts` | repository paths; `assertBuilt()` fails with "run `npm ci && npm run build`" when a build output is missing |
| `stage.ts` | copies `relay-server/dist` + `package.json` and `web-viewer/dist` (as `public/`) into the git-ignored `tests/.stack/relay-server/`, the Docker image's layout; re-staged when either build changes (Playwright `globalSetup`) |
| `stack.ts` | `startRelay()` — `node dist/index.js` with `NODE_ENV=test`, a free `PORT`, `LOG_LEVEL=trace`, `TRUST_PROXY=true`, `ALLOWED_ORIGINS` = its own origin, optional `RELAY_TEST_FAST_TIMERS`; log to a file; waits for `/healthz`. `startPublisher()` — `tools/fake-slicer/bin/fake-slicer.js --code-fd 3 --json` (started directly: npx/npm would not pass fd 3 on), the code read **only** from that pipe; `events`, `waitForEvent`, `waitForOutput`. `startStack()` — both, returning `{ baseUrl, wsUrl, code, logPath, relay, publisher, restartRelay(), stop() }` |
| `ws-client.ts` | raw protocol client for the security/load suites: per-client `X-Forwarded-For` address (`nextIp()`), `next(type)`, `closedWithin()`, `joinViewer()`, `createSession()` |
| `fixtures.ts` | Playwright fixtures `stack` (fresh per test, configured with `test.use({ stackOptions })`) and `startStack` |
| `qa05-join.ts`, `qa14-auth.ts` | raw-protocol helpers of the join-limit and auth suites |
| `qa07-log-grep.ts` | the log/HAR grep rules as pure functions (with a mutation test in `logs.spec.ts`) |
| `qa13-glb-mutator.ts` | deterministic GLB mutator (seeded PRNG) for `glb-fuzz.spec.ts` |

Other helpers: `e2e/support/viewer.ts` (join by code, node-panel locators, canvas probes, `leaks()`),
`e2e/support/qa03-join.ts` (network/secret detectors, `redacted()` which strips the code from Playwright errors),
`e2e/support/qa04-publisher.ts` (the spec as publisher, for latency), `load/clients.ts` and `load/scenarios.ts` (load
viewers/publishers and the five scenarios). Load tooling choice (Node `ws`, not k6): `docs/research/qa-load-tooling.md`.

Rules the harness keeps (and specs must keep): the code is passed to tests in memory and never printed,
attached or written to a file (NFR-12); `TRUST_PROXY=true` lets each simulated client use its own address, so
per-IP limits are tested per client (relay-server/README.md "Test and lint commands"); browsers have no
`X-Forwarded-For` and count as `127.0.0.1`, so a browser spec stays under 10 code joins and 30 upgrades a minute
per relay — each test has its own relay.

## Release checklist (QA-12)

Maps `docs/plan/00-overview.md` §5 item 2 (release checks before closing a milestone) to what `tests/` provides.
Record each run in `docs/testing/strategy.md` §10 *Release runs* (date, commit, result).

| Release check (§5.2) | How | Evidence |
|---|---|---|
| automated system suites green | `npm --prefix tests run all` (lint, triage, e2e, security, load:smoke; exit 1 on any failure) | the summary table it prints; the CI run of DEP-10 once its jobs are required |
| no open `high` report, every report has an owner | `node tests/scripts/report-index.mjs --check --release` | `docs/testing/reports/TRIAGE.md` |
| root build, tests, lint, Docker image | `npm run build && npm test && npm run lint`; `docker build -f relay-server/Dockerfile .` | CI (DEP-01…DEP-03) |
| load at full size | `npm --prefix tests run load:full` on the reference machine | a new run section in `load/REPORT.md` |
| manual device and Slicer scenarios | each scenario below has a result dated **within 14 days of the tag**, on the tagged build | its results table |

Manual scenarios that need a dated result for a release (the steps are the owning workstream's):

- `docs/testing/web.md`: W01 *Join and view* (incl. the NFR-01 4G figure), W02 *Deep link*, W03 *Code entry*, W06
  *Viewer and controls*, W07 *Node panel*, W08 *Live updates*, W11 *Reconnect*, W13 *Memory and wake lock* — on one
  iPhone (iOS ≥ 16.4) and one Android Chrome; from M3a also Q01 and Q02 (Quest 2 and Quest 3/3S, QA-11).
- `docs/testing/slicer.md`: §1 *Module loads*, §2 *Session panel*, §4 *QR code*, §6 *Live scene changes*, §13
  *Segments*, §14 *Decimation*, §16 *The toolbar* — in a real 3D Slicer 5.x against the deployed relay.
- `docs/testing/quest.md` (once QST-16 creates it, M3b).
- `docs/deploy.md` §4 first-deploy checklist on the release's deployment (DEP-06), incl. `wss://` and HSTS (T5).

## Test and lint commands

See the table above. `npm --prefix tests run lint` type-checks the suite; `npm --prefix tests run triage` checks the
report index.
