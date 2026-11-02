# SlicerRemoteView security tests and privacy checklist

Owner: `qa` (QA-09). Status of this record: 2026-11-03, branch `ws/qa`, commit: _to be filled at merge_.
The canonical threat model is `docs/architecture.md` §8 (T1–T12). This document does not restate its
mitigations or residual risks: it maps each threat to the tests that exercise it and records results (NFR-18).
Findings that would change the threat model are proposed to `release` in section 7. They are not edited here.

## 1. Purpose and how to run

The negative tests run against the built relay (`relay-server/dist` + `web-viewer/dist`), started per test on
`127.0.0.1` by the harness in `tests/harness/` (`NODE_ENV=test`, `LOG_LEVEL=trace`, `TRUST_PROXY=true`).
Set-up and the full command table are in `tests/README.md`.

```bash
npm ci && npm run build && npm --prefix tests ci          # once
npm --prefix tests run security                           # all security specs (Playwright project "security")
npm --prefix tests run security -- join                   # one spec: join | payload | auth | logs | glb-fuzz | headers
npm --prefix tests run e2e                                # e2e incl. join (QA-03) and live (QA-04)
npm --prefix tests run load:smoke                         # QA-08 limits and slow consumer (scaled down)
npm test -w relay-server                                  # relay unit/integration tests (relay-server/test/)
npm test -w web-viewer                                    # viewer unit tests (web-viewer/test/)
```

Fuzz reproduction: `GLB_FUZZ_SEED=<n> GLB_FUZZ_ONLY=<i> npm --prefix tests run security -- glb-fuzz`.
CI runs without traces or an HTML report (`tests/playwright.config.ts`), so CI artefacts hold no codes or tokens.

## 2. Threat → test table

"Status" = result of the reviewed implementer runs on the local harness, recorded 2026-11-03 on `ws/qa`
(commit to be filled). "SRV/WEB/SLC" = unit or integration tests of the components, named by file.

| ID | Threat (`docs/architecture.md` §8) | Automated tests | Manual checks | Status / date |
|---|---|---|---|---|
| T1 | Code guessing (§8 T1) | QA-05 `tests/security/join.spec.ts`: all four "join rate limit and lockout" tests, both "uniform INVALID_CODE answers (T1)" tests, "21st viewer gets SESSION_FULL + 4005; …", "foreign Origin → HTTP 403 …". SRV: `relay-server/test/ratelimit.test.ts` ("lockout and upgrade limit (SRV-08 criterion 2, §12, T1, T3)"), `viewer.test.ts` ("uniform INVALID_CODE (SRV-07 criterion 2, §5.2, §12, T1)"), `codes.test.ts` (alphabet, uniformity, quarantine) | Real 600 s ban and 120 s grace (fast timers only); per-IP behind the Railway edge (`X-Forwarded-For`, IPv6 /64) — DEP-06 | green locally, 2026-11-03, `ws/qa` |
| T2 | DoS via large blobs (§8 T2) | QA-06 `tests/security/payload.spec.ts`: `PAYLOAD_TOO_LARGE`/`1009`/`INVALID_MESSAGE` cases, volume + RSS cases. QA-08 `tests/load/smoke.spec.ts` / `full.spec.ts` "(c) …" (64 MiB accepted, +1 B refused, `CAPACITY`). SRV: `budget.test.ts`, `ws-handshake.test.ts` ("binary frames …", "text limits per role …"), `snapshot-ingest.test.ts` | Railway memory metrics — DEP-08; NFR-05's 1 vCPU not reproduced on the local harness (QA-08 remainder) | green locally, 2026-11-03, `ws/qa` |
| T3 | DoS via many connections (§8 T3) | QA-05 upgrade guards (429, `4012`). QA-06 slowloris `4012`, slow consumer `4010`. QA-14 `tests/security/auth.spec.ts` role/handshake tests (`UNAUTHORIZED` + `1008`, `4007`, `4000`), `/api/scene` 429. QA-08 "(e) one slow consumer among 20 …". SRV: `ratelimit.test.ts`, `heartbeat.test.ts` (T3 cases), `fanout.test.ts`, `state.test.ts`, `connection.test.ts` | — (edge-side residual: architecture §8 T3) | green locally, 2026-11-03, `ws/qa` |
| T4 | Publisher impersonation (§8 T4) | QA-14 `auth.spec.ts` "session.resume with a wrong publisherToken → UNAUTHORIZED + 4003 immediately; …", "session.resume for an unknown session → SESSION_NOT_FOUND; …", the three `session.create carrying "${field}" is refused …` tests, and in "no frame of session A reaches a viewer of B …" A's `publisherToken` cannot resume B (`4003`). QA-07 `tests/security/logs.spec.ts` (no `publisherToken` in logs, requests or HAR). SRV: `resume.test.ts` "session.resume (§4.3)" ("criterion 2: a wrong token → UNAUTHORIZED + 4003 at once; …", "half-open: the old socket still open is closed 4011, …"), `codes.test.ts` "tokens (NFR-17, §4.2, §5.2)" (256-bit, stored as SHA-256) | — | green locally, 2026-11-03, `ws/qa` |
| T5 | Eavesdropping (§8 T5) | **Manual / CI audit — no automated negative test.** Supporting evidence only: `headers.spec.ts` asserts HSTS (`max-age ≥ 31536000; includeSubDomains`) on every routed response; WEB `web-viewer/test/protocol/connection.test.ts` "refuses ws:// outside localhost and never opens a socket"; SLC `slicer-plugin/tests/test_transport.py` (TLS with a self-signed CA), `test_consent.py` "test_consent_says_when_the_connection_is_not_encrypted" | Owned by **DEP-06** (first deploy: `/healthz` over HTTPS/TLS 1.2+, `wss://<domain>/ws` from `fake-slicer`, a phone joining over the public domain, edge log sample) and **DEP-07** (custom domain, valid chain and `strict-transport-security` via `curl -I`, `ALLOWED_ORIGINS` switch) — `docs/plan/deploy.md`, results in `docs/deploy.md` §4/§5 | DEP-06 **todo**, DEP-07 **todo** — pending (checked 2026-11-03) |
| T6 | Leakage via logs, URL paths, fragments, Referer (§8 T6) | QA-07 `logs.spec.ts` (all three tests). QA-05 "a code in a URL path or query is never accepted nor echoed (§10)". QA-09 `headers.spec.ts` (all 25 tests: `Referrer-Policy: no-referrer`, 404 without echo, `/healthz`/`/api/version`/`/metrics` content). QA-03 `tests/e2e/join.spec.ts` "(b) the deep link /j#CODE joins, leaves /j without a fragment and adds no history entry" and every scenario's no-code-in-URL check. SRV: `logs.test.ts`, `static.test.ts` "security headers (SRV-16 criterion 2, architecture §8 T6, ADR 0006 §4)", `viewer.test.ts` "privacy (NFR-12, T6)", `ratelimit.test.ts` "privacy of the limiter …". WEB: `web-viewer/test/ui/deep-link.test.ts` (`replaceState`) | Railway edge HTTP log sample for query strings — DEP-06; browser history on real devices — `docs/testing/web.md` | green locally, 2026-11-03, `ws/qa` |
| T7 | PHI in node names (§8 T7) | SLC: `slicer-plugin/tests/test_names.py` (sanitising, 64 UTF-16 units, anonymous substitutes), `test_collect.py` "test_collect_anonymised_segments_are_all_aliased_and_the_json_holds_no_raw_string", `test_glb_writer.py` "test_glb_writer_anonymised_segments_carry_no_raw_id_or_name". QA-07 `logs.spec.ts` (GLB node names and ids absent from relay logs, requests and HAR). QA-13 `glb-fuzz.spec.ts` (injected names rendered as literal text only) | "Hide node names" in a real Slicer — `docs/testing/slicer.md`; user guide wording (section 6) | green locally, 2026-11-03, `ws/qa` |
| T8 | Viewer token replay (§8 T8) | QA-14 "viewer token replay from a second socket → the older socket is closed 4011", "31 requests in a minute with one token → …", "no Bearer → 401, unknown token → 401, another version → 404", "a code or token in the query string → 404, nothing echoed or logged". QA-09 `headers.spec.ts` "GET /api/scene/1 without a token → 401 …", "GET/HEAD /api/scene/<version> with a viewerToken → …". QA-03 "(d) a join after the snapshot ack loads it over GET /api/scene/:v with a Bearer token". SRV: `resume.test.ts` "a second concurrent use of a token closes the older socket 4011; the count stays", `http-scene.test.ts` (401/404/410/429) | — | green locally, 2026-11-03, `ws/qa` |
| T9 | Session loss on redeploy / single replica / crash (§8 T9) | QA-04 `tests/e2e/live.spec.ts` "relay restart: fake-slicer re-creates the session with the same code, … (US-05, NFR-20, T9)", "a dropped viewer socket is rejoined with the viewer token: …". SRV: `shutdown.test.ts` ("SIGTERM on the real entry", "draining in process"), `restart-rejoin.test.ts` "viewer joins after a relay restart (SRV-28)", `resume.test.ts` | SIGTERM drain with `4008` on a real Railway redeploy — DEP-06 | green locally, 2026-11-03, `ws/qa` |
| T10 | Malicious GLB from a rogue publisher (§8 T10) | QA-13 `tests/security/glb-fuzz.spec.ts` (four stream batches, HTTP path, determinism; 200 mutants, default seed). QA-06 `BAD_SEQUENCE` / `CHECKSUM_MISMATCH` / `INVALID_MESSAGE` cases. WEB: `web-viewer/test/render/glb-validate.test.ts`, `model-lifecycle.test.ts` | Real iOS Safari, Android GPU drivers, Quest Browser; Quest glTFast corpus (M3b, QST-07) | green locally, 2026-11-03, `ws/qa` |
| T11 | Cross-session data mixing (§8 T11) | QA-14 "no frame of session A reaches a viewer of B (and back); A's tokens never serve B". QA-08 "(b) 10 sessions × 5 viewers: …" (supporting). SRV: `fanout.test.ts` "session isolation (T11)" ("two sessions streaming at once: chunks, end, ready and aborts stay in their session"), `publisher.test.ts` "session isolation (T11)", `http-scene.test.ts` "a token yields only its own session's scene (T11)", `late-join.test.ts` "answers from the viewer's own session only (T11)", `viewer.test.ts` "stays inside its own session (T11)", `snapshot-ingest.test.ts` "allocates one zero-filled buffer of its own at begin (no pool slice, T11)" | — | green locally, 2026-11-03, `ws/qa` |
| T12 | Dependency supply chain (§8 T12) | **Manual / CI audit — no automated negative test.** Supporting evidence: one-off `npm audit` on 2026-11-02 (section 5, `docs/research/qa-dependency-audit-2026-11-02.md`); SLC `slicer-plugin/tests/test_deps.py` "test_deps_pins_are_exact_and_websockets_is_the_tested_release" | Owned by **DEP-09** (Dependabot, non-blocking `audit` job with `npm audit --omit=dev` and `pip-audit`, SHA-pinned actions via `.github/scripts/check-pinned-actions.mjs`) — `docs/plan/deploy.md` | DEP-09 **todo** — pending (checked 2026-11-03); local npm audit 2026-11-02: 0 high/critical |

QA-09 criterion 1 check: T1–T4 and T6–T11 each have at least one automated test ID above. T5 and T12 are
"manual / CI audit" rows naming DEP-06/DEP-07 and DEP-09 with the date of the check.

## 3. Negative-case catalogue

Titles are exact as in the spec files (template titles keep their `${…}` placeholders). Describe-block prefixes
are shown where Playwright prints them. "Threats" are the implementers' IDs (QA-05/06/14/07/13 criterion 3),
corrected against architecture §8 where a case tests a different threat (the `/api/scene` token cases are T8, not
T4; the `/j?code=` no-echo case is T6, not T1).

### 3.1 QA-05 join and limits — `tests/security/join.spec.ts`

| Test title | Expected | Threats | Requirements |
|---|---|---|---|
| join rate limit and lockout › 11th failed viewer.join from one IP within a minute is RATE_LIMITED + 4006, decided before the lookup | 10× `INVALID_CODE` + `4004`, then `RATE_LIMITED` (0 < `retryAfterS` ≤ 60) + `4006`, also for the live code; another IP still `INVALID_CODE` + `4004` | T1 | FR-26, NFR-13; protocol §12, §9.2 |
| join rate limit and lockout › a correct join gives its attempt back: 9 failures + 5 correct joins + 1 failure is not limited | 9× `INVALID_CODE` + `4004`, 5× `viewer.joined`, 10th failure `INVALID_CODE` + `4004`, next `RATE_LIMITED` + `4006` | T1 | FR-26; ADR 0008 |
| join rate limit and lockout › lockout (fast timers) › 20 failed joins within the (scaled) 10 min window ban the IP; retryAfterS counts the ban down | 20× `INVALID_CODE` + `4004`, then `RATE_LIMITED` + `4006`, `retryAfterS` decreasing; `viewer.joined` after the ban | T1 | FR-26, NFR-11, NFR-13; §12 |
| join rate limit and lockout › lockout (fast timers) › correct joins neither count towards the ban nor reset it: 19 failures + 3 joins + 1 failure ban | 19× `4004`, 3× `viewer.joined`, 20th `4004`, then `RATE_LIMITED` + `4006` | T1 | FR-26; §12 |
| uniform INVALID_CODE answers (T1) › malformed, unknown and released codes get identical error bodies and close 4004 | `INVALID_CODE` (retryable false), identical body apart from `ts`/`replyTo`, close `4004` with identical reason, no echo | T1 | NFR-12; §5.2, §12 |
| uniform INVALID_CODE answers (T1) › timing: malformed and unknown codes are indistinguishable over 50 + 50 samples | 100× `INVALID_CODE` + `4004`; \|median diff\| < 25 ms; Mann-Whitney p > 0.01 | T1 | §12 (QA-05 criterion 2) |
| 21st viewer gets SESSION_FULL + 4005; a full session does not count as a failed join | `SESSION_FULL` (`viewerLimit` 20, `retryAfterS` 30) + `4005`; never `RATE_LIMITED` | T3, T1 | FR-22; §3.3, §9.2 |
| a code in a URL path or query is never accepted nor echoed (§10) | HTTP 404 `{"error":"NOT_FOUND"}` for path/query variants; `/j?code=` → 200, same bytes as `/j`; controls 401/200 | T6 | FR-31, NFR-15; §10 |
| upgrade guards (§3.1, §12) › foreign Origin → HTTP 403 and Sec-WebSocket-Protocol → HTTP 400, both before the upgrade | HTTP 403 `FORBIDDEN`; HTTP 400 `BAD_REQUEST`; own/absent Origin → 101 | T1, T6 | FR-33; §3.1 |
| upgrade guards (§3.1, §12) › 30 accepted upgrades/min per IP, the 31st → 429; refused upgrades do not spend the budget | 30× 101, then HTTP 429 `RATE_LIMITED` with 0 < `Retry-After` ≤ 60 | T3 | §12 |
| upgrade guards (§3.1, §12) › no first message within 10 s → close 4012; a SESSION_NOT_FOUND rejoin restarts the 10 s window | close `4012` after 9.5–15 s; `SESSION_NOT_FOUND`, then `4012` | T3 | §3.1, §9.3 |

### 3.2 QA-06 payloads and sequences — `tests/security/payload.spec.ts`

Every case also checks that the relay keeps serving a new session afterwards (NFR-23).

| Test title (describe "payload and sequence rejections (one relay)" unless noted) | Expected | Threats | Requirements |
|---|---|---|---|
| begin with byteLength above 64 MiB → PAYLOAD_TOO_LARGE, no close, no strike (§6.2) | `PAYLOAD_TOO_LARGE` (`maxSnapshotBytes` 67108864), socket open, no `4007` | T2 | NFR-23, FR-34; §3.3, §6.2 |
| begin with chunkCount 1025 or chunkSize 32 KiB → INVALID_MESSAGE (§3.3, §6.2) | `INVALID_MESSAGE` (`/chunkCount`, `/chunkSize`), no close | T2, T10 | NFR-23; §3.3, §6.2 |
| binary frame above 1 MiB + 64 KiB → 1009; above 1 MiB + 12 B → PAYLOAD_TOO_LARGE + 1009 | close `1009`; `PAYLOAD_TOO_LARGE` + `1009` | T2 | NFR-23; §3.3, §9.3 |
| viewer text above 16 KiB → PAYLOAD_TOO_LARGE + 1009; exactly 16 KiB is accepted (§3.3) | 16,384 B → `pong`; 16,385 B → `PAYLOAD_TOO_LARGE` + `1009` | T2, T3 | §3.3 |
| publisher text above 256 KiB → PAYLOAD_TOO_LARGE + 1009; exactly 256 KiB is accepted (§3.3) | 262,144 B → `pong`; 262,145 B → `PAYLOAD_TOO_LARGE` + `1009` | T2 | §3.3 |
| duplicate and skipped chunkIndex → BAD_SEQUENCE{chunkIndex}, snapshot discarded (§6.3) | `BAD_SEQUENCE` `{field: chunkIndex}`; viewers get `scene.snapshot.abort` | T10 | §6.3, §9.2 |
| stale sceneVersion on begin or chunk → BAD_SEQUENCE{sceneVersion} (§6.3, §8.4) | `BAD_SEQUENCE` `{field: sceneVersion}` | T10 | §6.3, §8.4 |
| wrong sha256 or missing chunk at end → CHECKSUM_MISMATCH, no close (§6.4) | `CHECKSUM_MISMATCH`; viewers get abort; no close | T10 | §6.4 |
| scene.update with a wrong baseVersion or stale sceneVersion → BAD_SEQUENCE, no close (§8.1) | `BAD_SEQUENCE` (`noSnapshot`/`baseVersion`/`sceneVersion`), not forwarded | T10 | §8.1, §8.4 |
| scene.update or nodeRemoved between begin and end → BAD_SEQUENCE{snapshotInFlight} (§6.2) | `BAD_SEQUENCE` `{field: snapshotInFlight}` | T10 | §6.2, §8.1 |
| volume: 4 refused and 4 superseded 8 MiB snapshots, the input of the RSS check (T2) | 4× `CHECKSUM_MISMATCH`, 4 superseded begins without an error (4 errors in all), socket open | T2 | NFR-06 |
| idle or trickling upgraded sockets that never bind → 4012 after 10 s (§3.1, slowloris) | idle socket, a pinging socket after `SESSION_NOT_FOUND` (gets `pong`) and a raw socket trickling a frame header: each closed `4012` within 9–20 s | T3 | §3.1, §4.3, §9.3 |
| relay RSS after the rejection cases is within 2× of the start (NFR-06) | RSS ≤ 2× baseline (measured 1.65–1.75×); `/healthz` 200 | T2 | NFR-06, NFR-23 |
| slow consumer › a paused viewer is deferred, then closed 4010 above 8 MiB; others unaffected (§3.3) | ack `viewersDeferred` 1; `scene.snapshot.ready`; `SLOW_CONSUMER` + `4010`; others unaffected | T3 | FR-24; §3.3 |

### 3.3 QA-14 roles, tokens and isolation — `tests/security/auth.spec.ts`

Every case then checks that a bystander session is still served (NFR-23).

| Test title | Expected | Threats | Requirements |
|---|---|---|---|
| QA-14 roles and handshake (§3.1, §3.2, §11) › a viewer sending scene.update → UNAUTHORIZED, the second offence → 1008, nothing forwarded | `UNAUTHORIZED`, then `UNAUTHORIZED` + `1008` | T3 | §11, NFR-23 |
| … › a viewer sending a binary frame → UNAUTHORIZED + 1008 at once, nothing forwarded | `UNAUTHORIZED` + `1008` | T3 | §3.2, §11 |
| … › a binary frame as the first message → UNAUTHORIZED + 1008 | `UNAUTHORIZED` + `1008` | T3 | §3.1, §3.2 |
| … › ping as the first message declares no role → UNAUTHORIZED + 1008 | `UNAUTHORIZED` + `1008`, no `pong` | T3 | §3.1 |
| … › an unknown type as the first message → UNAUTHORIZED + 1008 | `UNAUTHORIZED` + `1008` | T3 | §3.1 |
| … › an unknown type while the handshake is pending is an UNAUTHORIZED offence; once bound it is UNSUPPORTED_TYPE | pending (after a `SESSION_NOT_FOUND` resume): `UNAUTHORIZED`, second offence `UNAUTHORIZED` + `1008`; bound: `UNSUPPORTED_TYPE`, socket open | T3 | §2, §3.1, §11 |
| … › invalid JSON ×3 on a bound viewer → INVALID_MESSAGE ×3, then 4007 | 3× `INVALID_MESSAGE`, close `4007` | T3 | §9.2, §9.3 |
| … › protocolVersion "2.0" → UNSUPPORTED_VERSION + 4000, for a viewer and a publisher | `UNSUPPORTED_VERSION` + `4000` | T3 | §2 |
| QA-14 tokens (§4.1, §4.3, §5.1–§5.2, T4, T8) › viewer token replay from a second socket → the older socket is closed 4011 | new socket `viewer.joined`; older closed `4011` | T4, T8 | NFR-17; §5.1, §9.3 |
| … › session.resume with a wrong publisherToken → UNAUTHORIZED + 4003 immediately; the publisher keeps its session | `UNAUTHORIZED` + `4003` within 3 s | T4 | NFR-17; §4.3 |
| … › session.resume for an unknown session → SESSION_NOT_FOUND; the socket stays open for session.create{preferredCode} | `SESSION_NOT_FOUND`, socket open, then `session.created` | T4 | §4.3, §3.1 |
| … › session.create carrying "${field}" is refused (INVALID_MESSAGE, no session) — for `publisherToken`, `viewerToken`, `token` | `INVALID_MESSAGE`, no session created | T4 | §4.1 |
| QA-14 GET /api/scene authorisation (§10, §12) › no Bearer → 401, unknown token → 401, another version → 404 | HTTP 401 + `WWW-Authenticate: Bearer`; 404 | T8 | NFR-17; §10 |
| … › 31 requests in a minute with one token → the 31st is 429; other tokens are not affected | 30× 200, then HTTP 429 with `Retry-After` 1..60 | T8, T3 | §10, §12 |
| … › a code or token in the query string → 404, nothing echoed or logged | HTTP 404 `NOT_FOUND`; absent from body, headers, relay log | T6, T8 | FR-31, NFR-12, NFR-15; §10 |
| QA-14 two sessions side by side (T11) › no frame of session A reaches a viewer of B (and back); A's tokens never serve B | no foreign frame; cross token → own bytes or 404; cross rejoin `SESSION_NOT_FOUND`; cross resume `UNAUTHORIZED` + `4003`; after B closes: `4001`, HTTP 410 | T11, T4 | §4.5, §5.2, §10 |

### 3.4 QA-07 log grep — `tests/security/logs.spec.ts`

| Test title (describe "QA-07 log grep (FR-29, FR-31, NFR-12, NFR-15, T6)") | Expected | Threats | Requirements |
|---|---|---|---|
| mutation: the grep flags each injected kind of leak in a clean log, by kind and line only | every injected kind (code, tokens, node name/id, IP, GLB bytes, non-JSON) flagged by kind + line, value never reported | T6 | FR-29, NFR-12 |
| a whole session at trace level leaves no code, token, address, node name or GLB byte in logs or requests | zero findings in relay/publisher logs, requests, headers, HAR; `INVALID_CODE` + `4004`; `4001`; HTTP 410; bare `/ws` URL | T6, T4 | FR-29, FR-31, NFR-12, NFR-15 |
| LOG_FILE artefact: JSON lines, no IP literal, glTF magic, token- or code-shaped value | zero findings per `relay.log`; skipped without `LOG_FILE` | T6 | FR-29, NFR-12 |

### 3.5 QA-13 GLB fuzz — `tests/security/glb-fuzz.spec.ts`

Template titles; with the defaults `BATCHES = 4`, 200 mutants, `HTTP_MUTANTS = 12`.

| Test title | Expected | Threats | Requirements |
|---|---|---|---|
| glb-fuzz stream batch ${batch + 1}/${BATCHES} (mutants ${from}–${to - 1}): snapshotInvalid or a rendered model, no pageerror (T10) — 4 tests | loaded model or the snapshotInvalid notice; 0 `pageerror`/crash; 0 foreign-origin or injected-URI requests; no XSS; §7.1-forbidden mutants never rendered | T10 | NFR-23; protocol §6, §7.1–§7.4 |
| glb-fuzz HTTP path (mutants 0–${HTTP_MUTANTS - 1} via /api/scene): snapshotInvalid or a rendered model, no pageerror (T10) | same, via `GET /api/scene/:v` | T10 | NFR-23; §6.5, §7.1, §10 |
| glb-fuzz: the mutator is deterministic and its reset snapshots are the fixtures | reset SHA-256 = fixture manifest; same bytes per (seed, index) | T10 | QA-13 criterion 2 |

Default seed result: 27/200 rendered, 173 refused (`snapshotInvalid`), 0 page errors.

### 3.6 Security headers — `tests/security/headers.spec.ts` (QA-09)

All routed responses must carry the full header set of section 4 (the undecodable-URL 404 is the documented exception); status per test:

| Test title | Expected | Threats | Requirements |
|---|---|---|---|
| headers on every HTTP surface (no publisher) › GET ${target} → viewer HTML, no-cache, full header set — for `/`, `/j`, `/j?code=${FAKE_CODE}`, `/j?fbclid=abc&code=${FAKE_CODE}` | 200 HTML, `no-cache`, query not echoed | T6 | FR-31; §10; SRV-16 |
| … › HEAD / and HEAD /j carry the same headers | 200, full set | T6 | §10 |
| … › GET /assets/* (hashed JS and CSS) → public, max-age=30d, immutable | 200, `immutable`, `max-age=2592000` | T6 | FR-28; §10 |
| … › GET /manifest.webmanifest and /icons/*.png → no-cache, full header set | 200, correct content types | T6 | §10 |
| … › GET /healthz → JSON with relay-wide counts only, full header set | 200, keys exactly status/uptimeS/sessions/viewers/version | T6 | NFR-12, NFR-38; §10 |
| … › GET /api/version → JSON with name, versions and limits only, full header set | 200, fixed key set | T6 | §10 |
| … › GET /api/scene/1 without a token → 401 UNAUTHORIZED, Bearer challenge, full header set | HTTP 401 + `WWW-Authenticate: Bearer` | T6, T8 | §10 |
| … › GET ${target} → 404 NOT_FOUND without echo, full header set — 10 paths (code-shaped path/query, `/index.html`, `/assets/`, encoded traversal, `/metrics` disabled, …) | HTTP 404 `{"error":"NOT_FOUND"}`, no echo | T6 | FR-31; §10 |
| … › POST / \| /j \| /healthz \| /api/scene/1 → 404 NOT_FOUND, full header set | HTTP 404 | T6 | §10 |
| … › a URL that does not decode → 404 NOT_FOUND without echo and without a banner | HTTP 404, no `Server`/`X-Powered-By` (no helmet headers, accepted in SRV-16) | T6 | §10 |
| headers with a live session (fake-slicer publisher) › GET/HEAD /api/scene/<version> with a viewerToken → 200 GLB, private, no-store, full header set | 200 `model/gltf-binary`, `private, no-store`; unknown token 401; wrong version 404 | T6, T8 | NFR-10; §10 |
| … › the live code in /j?code= is not echoed; /healthz and /api/version never carry it | 200 same bytes as `/j`; path variants 404; no code or IPv4 in bodies | T6 | NFR-12, FR-31; §10 |
| /metrics enabled (METRICS_TOKEN set) › GET /metrics → 401 without the token, 200 text no-store with it, full header set, no code or address | HTTP 401 + Bearer challenge; 200 `text/plain`, `no-store`, no code/token/IPv4 | T6 | NFR-12; §10 |

Related e2e checks (not negative cases): QA-03 `tests/e2e/join.spec.ts` asserts in every scenario that no code
appears in any request URL, WebSocket URL or request header, and in scenario (d) that the viewer token travels only
as `Authorization` (NFR-15, T6); QA-04
`tests/e2e/live.spec.ts` covers T9 (section 2).

## 4. Security headers

`headers.spec.ts` (`expectSecurityHeaders`) asserts on every routed response of the built relay (25 tests;
25/25 and 75/75 with `--repeat-each=3` as reported by the implementer run on 2026-11-03, not re-run for this
record — QA-09 criterion 2 is confirmed by the acceptance run):

- **CSP**: no `'unsafe-eval'`; `default-src 'self'`; `script-src 'self'` only; `script-src-attr 'none'`;
  `connect-src 'self' wss:` exactly; `worker-src 'self' blob:`; `img-src 'self' data: blob:`;
  `object-src 'none'`; `frame-ancestors 'none'`; no directive admits `*`, the bare schemes `http:`, `https:` or
  `ws:`, or any `scheme://` origin (`wss:`, `data:` and `blob:` appear only where listed above).
- **HSTS**: `max-age ≥ 31536000` with `includeSubDomains` (also over the plain-HTTP harness, where browsers ignore
  it — RFC 6797 §8.1; delivery over `https://` is DEP-06/DEP-07, T5).
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- No `Server` and no `X-Powered-By` header.
- Protocol §10 `Cache-Control`, per path (not on every response): `no-cache` for `/`, `/j`, manifest and icons;
  `immutable` and `max-age=2592000`, without `private`/`no-store`, for `/assets/*`; `private, no-store` (and
  neither `public` nor `immutable`) for `/api/scene`; `no-store` for `/metrics`.

Exception (accepted in SRV-16): the 404 for an undecodable URL is produced before helmet runs and carries no
security headers; the test asserts its body, no echo and no banner only.

## 5. Dependency audit summary

Source: `docs/research/qa-dependency-audit-2026-11-02.md` (one-off run 2026-11-02 for QA-09, part h).

| Scope | Audited | critical | high | moderate | low |
|---|---|---|---|---|---|
| root `npm audit --omit=dev` (ships in the relay image) | 93 prod | 0 | 0 | 4 | 0 |
| root, dev included | 355 | 0 | 0 | 15 | 0 |
| `tests/` | 9 | 0 | 0 | 0 | 0 |
| Python (`slicer-plugin`, `shared/py`) | — | not run | | | |

- Production moderates: `fast-uri` 4.2.2 / 3.1.8 (in-range fix 4.2.3 / 3.1.9 available); `@fastify/static`
  10.1.6 via `glob` 13.0.6 (GHSA-3g3m-2fjr-6pw4) and `minimatch` 10.2.6 (GHSA-g3hv-75wg-m249), no forward fix
  yet. Exposure assessed low: no request input reaches the affected code paths (see the research note).
- Dev-only moderates: the eslint / typescript-eslint chain, same `minimatch` advisory; never in the image.
- **Not run**: `pip-audit` is not installed on the audit machine and was deliberately not installed.
- **Owner of the continuous audit**: DEP-09 (non-blocking `audit` job with `npm audit --omit=dev` and `pip-audit`;
  Dependabot for npm, pip and github-actions; SHA-pinned actions checked by `.github/scripts/check-pinned-actions.mjs`,
  which does not exist yet). Status `todo` on 2026-11-03. Proposed in the research note (follow-up 3), not yet in
  DEP-09's text: add `npm --prefix tests audit` and run `pip-audit` for both `slicer-plugin` and `shared/py`.

## 6. GDPR / privacy checklist

| Item | Fact | Source / verification |
|---|---|---|
| What leaves the Slicer PC (**FR-15**, **NFR-16**) | Only after **Start session**: surface geometry of the models/segments shown in 3D (no images, volumes, DICOM tags, file paths or MRML attributes); node names unless **"Hide node names"** is on (then `Model <n>` / `Segment <n>`, `anonymizedNames: true`, segment IDs aliased, no name-derived string in the GLB or any message); colours; opacity; visibility; transforms (world matrix); plus `nodeId`s (MRML IDs, segment IDs), triangle counts and software versions (`clientInfo`, GLB `source`) | FR-15, NFR-16; protocol §4.1, §7.1, §7.3; Slicer help text in `slicer-plugin/RemoteView/RemoteView.py`; SLC tests in section 2 T7 |
| Pre-send list | The panel lists the nodes to be exported before the first send and offers "Hide node names" (default off, T7) | FR-15; manual: `docs/testing/slicer.md` |
| No persistence (**NFR-10**) | Relay memory only: no volume, no scene data written to disk or external services, snapshot buffers freed on session end; no payload logging | NFR-10, FR-29; SRV `shutdown.test.ts` "criterion 3: nothing is written to the file system on the way out (NFR-10)", `registry.test.ts` "releasing a session (SRV-04 criterion 2, NFR-10)", `fanout.test.ts` "a session released mid-stream (NFR-10)"; QA-07 `logs.spec.ts` (no codes, tokens, IPs, node names or GLB bytes in logs) |
| Logs | Metadata only (sizes, counts, close codes, internal ids; client IPs hashed per boot); Railway keeps stdout 7 days (Hobby) | NFR-12, NFR-35; QA-07 |
| Retention = TTL (**NFR-11**) | Idle session/unused code without viewers: `SESSION_TTL_S` **1800 s** (30 min); publisher grace `PUBLISHER_GRACE_S` **120 s**; hard lifetime `SESSION_MAX_LIFETIME_S` **43,200 s (12 h)**; released codes quarantined `CODE_QUARANTINE_S` **600 s** (a closed session's viewer-token hash answers 410 for that long, then 401); rate-limit lockout 10 min; tokens valid for the session only | NFR-11; protocol §3.3, §10; architecture §9 env table |
| Hosting region (**NFR-16**) | Railway, single replica, **EU West `europe-west4-drams3a`** (Hobby availability `[TODO verify]`, architecture §9). DPA/EU-region note for institutions: `docs/deploy.md` §6 (DEP-08, **todo** — the file does not exist in this checkout on 2026-11-03). Self-hosters are told to pick a region their patient-data rules allow (`docs/user-guide/en/own-server.md`) | NFR-16; architecture §9; DEP-08 |
| No analytics / third-party scripts (NFR-16) | CSP `script-src 'self'`, no foreign origin in any directive | `headers.spec.ts`; WEB `web-viewer/test/bundle.test.ts` "refuses an initial asset from another origin (no third-party scripts, NFR-16)" |
| Transport | TLS at the Railway edge; relay can read the scene (no end-to-end encryption, architecture §8 non-goals) | T5 row (DEP-06/DEP-07) |

### What to tell users (input for `docs/user-guide/`)

Existing: `docs/user-guide/{en,pl}/install-plugin.md` "What is sent" / "Co jest wysyłane" (geometry, names, IDs, colours, opacity,
visibility, positions, versions; nothing before **Start session**; server keeps the last scene until the session
ends; encrypted connection, but the server can read the scene) and the session-end times (30 min without viewers,
12 h); `own-server.md` (region choice, sessions only in memory). Proposed additions for the user-guide owner:

1. Name **"Hide node names"** and when to use it: names (and segment IDs) may contain patient identifiers.
2. State the hosting region of the default server (EU West) and that nothing is stored on disk.
3. Give the retention in one sentence: the scene exists only in server memory until the session ends
   (Stop session, 30 min without viewers, 12 h at most, or a server restart); logs hold no scene data and
   are kept 7 days.
4. Geometry itself (for example a face surface) can identify a person; hiding names does not change that (T7).

## 7. Findings proposed to `release` (threat model not edited here)

1. **T6 — test artefacts.** Local Playwright traces and HTML reports record typed codes, the `/j#<code>`
   navigation and `Authorization: Bearer` headers (QA-03, QA-07). Mitigated in `tests/playwright.config.ts`
   (no traces, no HTML report under `CI`) and documented in `tests/README.md` (local traces git-ignored, not to be
   shared; codes belong to a per-test relay). Proposal: record as an accepted test-tooling residual under T6.
2. **NFR-16 / T7 wording.** NFR-16 says the export contains "geometry, names (optionally hidden), colours,
   opacity, visibility and transforms only", but `nodeId`s (raw segment IDs unless aliased — protocol §9.2 treats
   them as possible PHI), triangle counts and software/OS versions (`clientInfo`) also leave the PC; the Slicer
   help text and user guide already say so. Proposal: align NFR-16 and the T7 vector with protocol §7.3.
3. **T6 — `/healthz` totals.** Re-confirmed by `headers.spec.ts` (keys exactly status/uptimeS/sessions/viewers/version);
   already accepted on 2026-10-28. No change proposed.
4. **T12 — known moderates.** Four production moderates without high/critical (section 5); `fast-uri` has an
   in-range fix. Proposal: track via DEP-09 / Dependabot; no threat-model change.
5. **T6 — undecodable-URL 404 without helmet headers.** Accepted in SRV-16; body and absence of echo/banner
   verified. No change proposed unless `release` wants it listed as a residual.

## 8. Known gaps and manual items

- **T5, T12**: no automated negative test by design; pending DEP-06/DEP-07 and DEP-09 (all `todo` on 2026-11-03).
- **Railway edge**: real `X-Forwarded-For` hops, IPv6 /64 bucketing, edge HTTP log contents and SIGTERM `4008`
  drain on a real redeploy — DEP-06. Every local relay runs on `127.0.0.1` with `TRUST_PROXY=true`.
- **Real timers**: the 600 s ban and 120 s restart grace are exercised only in their scaled form (÷ 60) under
  `RELAY_TEST_FAST_TIMERS`, never at full length; the `/api/scene`
  30/min window reset is covered by `relay-server/test/http-scene.test.ts`, not by QA-14.
- **Timing uniformity**: a sub-10 ms difference cannot be detected with 50 + 50 samples against the 50–150 ms
  jitter; the Mann-Whitney check has a ≈ 1 % false-failure rate (CI `retries: 1`).
- **Memory**: QA-06 RSS check detects only leaks roughly the size of the baseline (no forced GC); NFR-05's
  1 vCPU and real network bandwidth are not reproducible on the local harness (QA-08).
- **Fuzzing**: Desktop Chromium/SwiftShader only; real iOS Safari, Android GPU drivers and Quest Browser are not
  fuzzed; Quest glTFast corpus is the M3b follow-up (QST-07); no per-mutant CPU/memory measurement.
- **Python audit**: `pip-audit` not run (DEP-09).
- **Devices and Slicer**: browser history after `/j#CODE` on real phones, "Hide node names" in a real Slicer and
  the pre-send node list — `docs/testing/web.md`, `docs/testing/slicer.md`.
- **`docs/deploy.md`** (§4–§6) does not exist yet; the T5 row and the region/DPA item link to it once DEP-06/07/08
  land.
