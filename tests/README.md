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
| `npm --prefix tests run e2e` | `e2e/` on `iphone15` (WebKit), `pixel7` (Chromium, SwiftShader WebGL) and `desktop-chromium` (smoke only) | yes (`e2e` job, DEP-10) |
| `npm --prefix tests run e2e -- join` | one spec by file-name filter (any Playwright CLI argument works after `--`) | — |
| `npm --prefix tests run security` | `security/` (raw `ws` + `fetch`; a browser only for the GLB fuzz) | yes (`security` job) |
| `npm --prefix tests run load:smoke` | `load/smoke.spec.ts`: scaled load scenarios, minutes | yes (`load-smoke` job) |
| `npm --prefix tests run load:full` | `load/full.spec.ts`: full-size load scenarios, local only | no (reference machine) |
| `npm --prefix tests run lint` | `tsc --noEmit` over the suite | yes |

A failing test keeps its Playwright trace and the logs in `tests/test-results/<test>/stack-<n>/` (`relay.log`,
`publisher.log`). Those directories are git-ignored; CI uploads them as artefacts. They never hold the session
code or a token by design (the log-grep suite checks it), but a trace can show the code typed on screen: treat
artefacts as internal.

On macOS, which has no `timeout`, bound a run with `perl -e 'alarm shift; exec @ARGV' 600 npm --prefix tests run e2e`.

## Harness (`harness/`)

| File | Role |
|---|---|
| `paths.ts` | repository paths; `assertBuilt()` fails with "run `npm ci && npm run build`" when a build output is missing |
| `stage.ts` | copies `relay-server/dist` + `package.json` and `web-viewer/dist` (as `public/`) into the git-ignored `tests/.stack/relay-server/`, the Docker image's layout; re-staged when either build changes (Playwright `globalSetup`) |
| `stack.ts` | `startRelay()` — `node dist/index.js` with `NODE_ENV=test`, a free `PORT`, `LOG_LEVEL=trace`, `TRUST_PROXY=true`, `ALLOWED_ORIGINS` = its own origin, optional `RELAY_TEST_FAST_TIMERS`; log to a file; waits for `/healthz`. `startPublisher()` — `tools/fake-slicer/bin/fake-slicer.js --code-fd 3 --json` (started directly: npx/npm would not pass fd 3 on), the code read **only** from that pipe; `events`, `waitForEvent`, `waitForOutput`. `startStack()` — both, returning `{ baseUrl, wsUrl, code, logPath, relay, publisher, restartRelay(), stop() }` |
| `ws-client.ts` | raw protocol client for the security/load suites: per-client `X-Forwarded-For` address (`nextIp()`), `next(type)`, `closedWithin()`, `joinViewer()`, `createSession()` |
| `fixtures.ts` | Playwright fixtures `stack` (fresh per test, configured with `test.use({ stackOptions })`) and `startStack` |

Rules the harness keeps (and specs must keep): the code is passed to tests in memory and never printed,
attached or written to a file (NFR-12); `TRUST_PROXY=true` lets each simulated client use its own address, so
per-IP limits are tested per client (relay-server/README.md "Test and lint commands"); browsers have no
`X-Forwarded-For` and count as `127.0.0.1`, so a browser spec stays under 10 code joins and 30 upgrades a minute
per relay — each test has its own relay.

## Test and lint commands

See the table above. `npm --prefix tests run lint` type-checks the suite.
