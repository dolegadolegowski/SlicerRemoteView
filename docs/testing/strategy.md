# Test strategy — SlicerRemoteView

Owned by `qa` (task QA-01, `docs/plan/qa.md`; CLAUDE.md rule 4 exception). Requirements: `docs/requirements.md`;
contract: `docs/protocol.md` v1.0; threat model: `docs/architecture.md` §8 (test map: `docs/security.md`, QA-09);
milestones and release checks: `docs/plan/00-overview.md` §2 and §5. Commands below are copied from each
component's `README.md`, which stays the source of truth — when they disagree, the README wins and this file is
updated.

## 1. Test pyramid

| Level | What it proves | Where | Runs |
|---|---|---|---|
| 1. Unit | pure logic of one module: schemas and validators, code generator, rate limiter, chunk codec, GLB writer, decimation, transform maths | each component's own suite (vitest, pytest, Unity EditMode) | every push (CI `node` / `python` jobs, DEP-01/DEP-02) |
| 2. Component | one component against a real neighbour or a stub over real sockets: relay + fake-slicer (SRV-22), viewer + relay stub in Playwright (WEB-10), Slicer core + relay stub (`slicer-plugin/tests/test_panel*.py`), relay load smoke (SRV-21), Docker image smoke (DEP-03) | component suites | every push |
| 3. System E2E | the built relay serving the built viewer, `fake-slicer` as publisher, browsers with device descriptors; negative/security and load suites | `tests/` (this workstream; harness `tests/harness/`) | CI `e2e`, `security`, `load-smoke` jobs (DEP-10) |
| 4. Manual device | what no sandbox can run: real 3D Slicer, real iPhone/Android/Quest, the Railway edge, 4G and classroom Wi-Fi | `docs/testing/<component>.md` | before a milestone closes / within 14 days of a release tag (QA-12) |

Rule of thumb: a bug is reproduced at the lowest level that can show it; a system test that finds a bug in
another component leads to a report (§6) and the owner adds the unit test.

## 2. Components, commands and manual documents

All commands run from the repository root with Node 22 after `npm ci` (and `npm run build` where a built output
is needed). The root `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` run every npm workspace
(`shared`, `relay-server`, `web-viewer`, `tools/fake-slicer`) with `--if-present`.

| Component | Automated command(s) | Manual document |
|---|---|---|
| `protocol` — `shared/` | `npm test -w shared` (vitest) · `npm run lint -w shared` · `npm run typecheck -w shared` · `npm run check -w shared` (schemas ↔ §11, fixtures, generated drift; CI entry point; also needs `shared/py/.venv`, it fails without it) · `npm run test:py -w shared` and `npm run lint:py -w shared` (needs `shared/py/.venv`) · `npm run check:cs -w shared` (needs `dotnet`; `-- --require-dotnet` in CI) | `docs/testing/protocol.md` (C# generated types, PRO-17) |
| `protocol` — `tools/fake-slicer` | `npm test -w tools/fake-slicer` · `npm run lint -w tools/fake-slicer` · `npm run typecheck -w tools/fake-slicer` | none (a test tool; exercised by every level-2/3 suite) |
| `server` — `relay-server/` | `npm test -w relay-server` (vitest unit + integration incl. `e2e-fake-slicer`, SRV-22) · `npm run lint -w relay-server` · `npm run typecheck -w relay-server` · `npm run load:smoke -w relay-server` (SRV-21) · `docker build -f relay-server/Dockerfile -t slicerremoteview-relay:local .` then `RELAY_IMAGE=slicerremoteview-relay:local npm test -w relay-server -- docker-smoke` (skipped without `RELAY_IMAGE`) | none yet; Railway-side checks live in `docs/deploy.md` (DEP-06, not in this checkout yet) |
| `web` — `web-viewer/` | `npm test -w web-viewer` (vitest) · `npm run e2e -w web-viewer` (Playwright, both device projects, against the fake-slicer relay stub, WEB-10) · `npm run lint -w web-viewer` · `npm run typecheck -w web-viewer` · `npm run build -w web-viewer` (bundle budget check, WEB-18) | `docs/testing/web.md` (iPhone Safari, Android Chrome, Quest Browser, Results) |
| `slicer` — `slicer-plugin/` | `slicer-plugin/.venv/bin/pytest slicer-plugin` (pure core + adapter against stub `slicer`/`qt`/`ctk`; set `REMOTEVIEW_REQUIRE_GLTF_VALIDATOR=1`, `REMOTEVIEW_REQUIRE_OPENSSL=1`, `REMOTEVIEW_REQUIRE_RELAY_STUB=1` in CI so skips become failures) · `slicer-plugin/.venv/bin/ruff check slicer-plugin` · `slicer-plugin/.venv/bin/ruff format --check slicer-plugin` · `python3 slicer-plugin/scripts/vendor_shared.py --check` | `docs/testing/slicer.md` (§1–§6, §12–§16; `ScriptedLoadableModuleTest` inside Slicer is manual, NFR-39) |
| `quest` — `quest-app/` | Unity Test Framework EditMode — not set up yet (`quest-app/README.md` is a TODO; `dotnet test quest-app/Tests.NET` planned in `docs/plan/quest.md`; Unity CI waits for the licence question R-07) | `docs/testing/quest.md` — **does not exist yet** (QST-16, M3b); M3a Quest Browser runs are in `docs/testing/web.md` §Quest Browser |
| `deploy` — `.github/`, `.railway/` | not in this checkout yet. Planned: `actionlint` and the CI jobs of DEP-01…DEP-03, DEP-09, DEP-10 (§5) | `docs/deploy.md` §4 first-deploy checklist (DEP-06), §5 TLS (DEP-07), §6 region/cost/log retention (DEP-08) — not in this checkout yet |
| `qa` — `tests/` | `npm --prefix tests run e2e` (projects `iphone15`, `pixel7`, `desktop-chromium`) · `npm --prefix tests run security` · `npm --prefix tests run load:smoke` · `npm --prefix tests run load:full` (local only) · `npm --prefix tests run lint` (`tsc --noEmit`) · `npm --prefix tests run triage` · `npm --prefix tests run all` (every suite, QA-12) — see `tests/README.md` | records results in the documents above; this file and `docs/security.md` |

## 3. Automated vs manual

| Area | Automated (where) | Manual only (why) |
|---|---|---|
| 3D Slicer | pure-Python core, adapter on stub modules, Slicer core ↔ relay stub (pytest); the Slicer role on the wire is played by `tools/fake-slicer` in every system test | the module in a real Slicer 5.x: load, Start/Stop, consent, dependencies, live MRML events, segments, decimation timing (`docs/testing/slicer.md`) — no Slicer in the sandbox (CLAUDE.md rule 10) |
| iPhone (Safari) | Playwright WebKit with the `iPhone 15` descriptor (`tests/` project `iphone15`, `web-viewer` e2e) | real Safari on iOS ≥ 16.4 and 15.x: touch controls, memory limits, backgrounding, Add to Home Screen, 4G timing — Playwright WebKit is not Safari |
| Android (Chrome) | Playwright Chromium with the `Pixel 7` descriptor and software WebGL (project `pixel7`) | real Chrome on a mid-range phone: GPU, frame rate (NFR-07), wake lock |
| Quest Browser (M3a) | unit tests of the XR transform maths (WEB-20); `web-viewer` `e2e/xr.spec.ts` emulates a Quest 3 with IWER (WEB-19) | WebXR entry, hands/controllers, 72 Hz on Quest 2 and Quest 3/3S (QA-11, `docs/testing/web.md` §Quest Browser) |
| Quest native (M3b) | EditMode tests of protocol parsing, nodeId mapping, transforms (planned, QST-) | device, IL2CPP `wss://` smoke, passthrough, 72 Hz (`docs/testing/quest.md`, QST-16) |
| Relay on Railway | none (automated suites never target it) | first deploy, TLS/HSTS from devices, EU region, log retention, alerts (DEP-06…DEP-08) |

## 4. Environments

- **Local stack (all automated suites).** `tests/harness/stack.ts` stages the built relay and viewer
  (`tests/.stack/`, the Docker image's layout) and starts, per test, a relay on `127.0.0.1` with a free port,
  `NODE_ENV=test`, `LOG_LEVEL=trace`, `TRUST_PROXY=true` (each simulated client gets its own `X-Forwarded-For`)
  and optional `RELAY_TEST_FAST_TIMERS`, plus `fake-slicer` with a chosen fixture/script whose code is read only
  from fd 3 and kept in memory. Component suites (`relay-server`, `web-viewer`, `slicer-plugin`) start their own
  relay or the fake-slicer relay stub on localhost.
- **Railway relay (manual device runs only).** Phones and headsets need an HTTPS origin (secure context), so
  device scenarios in `docs/testing/web.md`, `docs/testing/slicer.md` and `docs/testing/quest.md` run against the
  deployed relay (or a staging relay, a follow-up in `docs/plan/qa.md`). **No automated suite ever targets the
  Railway relay or any other remote host**; load tests across the real edge are a coordinated follow-up (egress
  cost, NFR-34).
- **Reference machine** for timing-gated load runs (`load:full`, QA-08): its CPU and OS are recorded in each
  `tests/load/REPORT.md` run, so numbers are comparable.

## 5. CI

Planned by DEP-01/DEP-02/DEP-03/DEP-09/DEP-10; `.github/` is not in this checkout yet, so this section states the
contract the workflow must implement. QA jobs start as `continue-on-error: true` and become required after two
stable weeks (DEP-10; recorded by QA-12).

| Job | Commands |
|---|---|
| `node` (DEP-01) | `npm ci` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run build` · `npm run check -w shared` |
| `python` (DEP-02) | `ruff check` + `pytest` for `shared/py` and `slicer-plugin`; vendoring drift check |
| `docker` (DEP-03) | `docker build -f relay-server/Dockerfile .`, `/healthz` and `/api/version` smoke |
| `audit` (DEP-09) | `npm audit --omit=dev`, `pip-audit` (non-blocking) |
| `e2e` (DEP-10) | after the root build: `npm --prefix tests ci`, `(cd tests && npx playwright install chromium webkit)` (browsers cached), `npm --prefix tests run e2e` |
| `security` (DEP-10) | same setup, `npm --prefix tests run security` |
| `load-smoke` (DEP-10) | `npm --prefix tests run load:smoke` and `npm run load:smoke -w relay-server` (the DEP-10 row names only the latter today; the QA suite is added) |
| `lint` (tests) | `npm --prefix tests run lint` |

Artefacts uploaded on failure: Playwright report and traces, `tests/test-results/**/stack-*/relay.log` and
`publisher.log`. They never contain codes or tokens by design (QA-07 checks it), but a trace can show a code typed
on screen: artefacts are internal.

## 6. Test data policy

- Scenes come **only** from `shared/fixtures/glb/` (generated deterministically by `npm run fixtures -w shared`,
  described in `manifest.json`) and message fixtures from `shared/fixtures/messages/`. No patient data, no real
  DICOM-derived models, anywhere — not in tests, reports, screenshots or manual runs.
- Node and segment names are synthetic (`Segment_1`, `vtkMRMLModelNode2`); manual Slicer runs use sample data or
  synthetic shapes and, where a name could identify a person, the anonymised-names option.
- Larger or mutated inputs (20 MiB / 64 MiB load snapshots, QA-08; fuzzed GLBs, QA-13) are generated in memory
  from a fixture and a seed, or into git-ignored directories (`tests/.stack/`, `tests/test-results/`) — never
  committed. A failing fuzz case is reported by its seed, not by the file.
- Session codes, `publisherToken` and `viewerToken` are never printed, attached, annotated or written to a file
  by a test (NFR-12, CLAUDE.md rule 6); assertions about them are boolean.

## 7. Reports and triage

Bugs found in another component's code are filed as `docs/testing/reports/<date>-<reporter>-<n>.md` in the
format of [`docs/testing/reports/README.md`](reports/README.md) (counts only — never codes, tokens or scene
payloads). The owning workstream triages at its next start (CLAUDE.md rule 9) and copies the report into its plan
as a `todo` task (status `triaged (<ID>)`). A system test that exposes such a bug stays in the suite marked
`test.fail` (or `test.fixme` when it would hang) with the report's file name, so CI stays green and the test flips
when the fix lands. Release checks (`00-overview.md` §5) require no open `high` report and an owner on every
report. QA-10 extends the README with the triage flow, SLAs per severity and a generated `TRIAGE.md` index.

## 8. Non-functional requirements → measurement

Exact wording in `docs/requirements.md`. "Gating" = the test fails above the bound.

| NFR | Bound (short) | Automated measurement (ID) | Manual measurement |
|---|---|---|---|
| NFR-01 | Join → first model ≤ 4 s Wi-Fi; ≤ 10 s p90 on 4G for 10 MB | QA-03: Join click → first rendered frame on the harness, `asymmetric-2nodes.glb`, < 4 s, recorded as a metric (not gating) | `docs/testing/web.md` *Join and view* (WEB-10) over real 4G and Wi-Fi; the 10 MB case needs a 10 MB synthetic GLB (largest fixture today: `large-synthetic.glb`, ≈ 4.7 MiB) |
| NFR-02 | change → render on every viewer ≤ 500 ms p95 | QA-04: update-to-render p95 over 50 updates (gating); QA-08(d): 10 updates/s for 60 s to 20 viewers, p95 | Slicer → phone in `docs/testing/slicer.md` §6/§16 (includes the debounce) |
| NFR-03 | snapshot cap 64 MiB, recommendations per profile | QA-08(c) and QA-06: 64 MiB accepted, 64 MiB + 1 B refused `PAYLOAD_TOO_LARGE`; Slicer budget tests (SLC-14, pytest) | `docs/testing/slicer.md` §14 |
| NFR-04 | triangle / node budgets | SLC-14, SLC-41 pytest | `docs/testing/slicer.md` §14; QST-14 |
| NFR-05 | 20 viewers; 20 MiB fan-out ≤ 5 s on 1 vCPU | QA-08(a): 1 session × 20 viewers × 20 MiB (`load:full`, reference machine); SRV-21 load smoke (20 viewers, `large-synthetic.glb`, `--max-fanout-ms 5000`, CI) | classroom Wi-Fi with 20 phones (ADR 0008 NAT case) |
| NFR-06 | relay memory bounds | QA-06: relay RSS after the suite ≤ 2× start; QA-08(c): RSS < `MAX_TOTAL_SNAPSHOT_BYTES` + 256 MiB; SRV-21: RSS growth factor | Railway metrics during a manual run (DEP-08) |
| NFR-07 | ≥ 30 fps mobile budget; 72 Hz Quest | none (software WebGL in CI is not representative) | WEB-19/WEB-20 manual steps, executed and recorded by QA-11 (Quest 2, Quest 3/3S); phones in `docs/testing/web.md`; native: `docs/testing/quest.md` §12 (QST-14) |
| NFR-08 | idle viewer renders 0 fps in 2D | WEB-08 (web-viewer tests) | `docs/testing/web.md` *Viewer and controls* |
| NFR-09 | initial bundle ≤ 1 MB gzip, no CDN | WEB-18: `npm run build -w web-viewer` size check; same-origin network assertion in E2E | — |
| NFR-10 | no persistence | SRV integration tests (no filesystem writes; SRV-04, SRV-11, SRV-17) | Railway: no volume attached (DEP-06) |
| NFR-12 | no codes, tokens, names, raw IPs, payloads in logs | QA-07 log-grep (gating, mutation-checked); SRV-18; QA-02 smoke asserts no code on fake-slicer stdout/stderr | Railway log sample (DEP-08) |
| NFR-13 | brute-force limits | QA-05 (rate limit, ban, uniform errors, timing band); SRV-08 | — |
| NFR-14 | TLS 1.2+, HSTS | QA-09 `headers.spec.ts` (headers only) | DEP-06/DEP-07 TLS chain, HSTS, `wss://` from devices |
| NFR-15 | no codes/tokens in URLs, cookies, `Referer` | QA-03 criterion 2 (no request URL contains the code); QA-07 HAR check; WEB-11 | deep link on real Safari/Chrome (`docs/testing/web.md` *Deep link*) |
| NFR-19, NFR-20 | reconnect, rejoin after redeploy | QA-04 criterion 3 (socket kill, relay restart) | `docs/testing/web.md` *Reconnect*; a real Railway redeploy |
| NFR-23 | malformed / oversized snapshots never crash | QA-06; QA-13 (GLB fuzzing, viewer) | — |
| NFR-39 | per-component automated tests in CI | §5 jobs | — |

Threats T1–T12 → tests are mapped in `docs/security.md` (QA-09), not here.

## 9. Milestone gates

Consistent with `docs/plan/00-overview.md` §2 and §5:

- **M0** — unit and component suites of `shared`, `relay-server`, `web-viewer`, `fake-slicer`, `slicer-plugin`
  green in CI; this strategy exists (QA-01).
- **M1** — QA-02 harness, QA-03 happy paths on `iphone15` and `pixel7`, QA-05 join negatives, QA-07 log-grep pass;
  manual Slicer → relay → phone run (`docs/testing/slicer.md` §2), the NFR-01 4G run (`docs/testing/web.md` *Join
  and view*) and first deploy (DEP-06) recorded.
- **M2** — QA-04, QA-06, QA-14, QA-13, QA-08 (NFR-02, NFR-05, NFR-06), QA-09 (`docs/security.md`), QA-10.
- **M3a** — QA-11 Quest Browser results on Quest 2 and Quest 3/3S. **M3b** — `docs/testing/quest.md` results.
- **M4** — QA-12: `npm --prefix tests run all` gates the release; every manual scenario listed in the
  `tests/README.md` release checklist has a result dated within 14 days of the tag; zero open `high` reports.

Every closed milestone needs, per §5 of the overview: root `npm run build`, `npm test`, `npm run lint` green,
Docker image builds, DoD boxes ticked with evidence (CI run, E2E run, manual entry with date and version), no
open `high` report and every report `triaged`, `fixed` or `rejected`.

## 10. Release runs

Filled by QA-12 for each release candidate and tag (one row per run of `npm --prefix tests run all` plus the
manual checklist).

| Date | Commit | Result | Notes |
|---|---|---|---|
| 2026-11-03 | `ws/qa` `2f03c3f` + QA-12 files (pre-merge, not a release candidate) | pass — lint, triage, e2e 23/23 (19 s), security 76 + 1 skipped (19 s), load:smoke 6/6 (32 s); `CI=1`, Apple M3 Ultra | first run of `npm --prefix tests run all`; manual checklist not run (no release); 0 open `high` reports |
