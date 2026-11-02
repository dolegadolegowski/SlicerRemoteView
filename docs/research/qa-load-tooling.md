# Load-test tooling for QA-08: Node `ws` scripts instead of k6

- **Author**: `qa` (`ws/qa`, commit `9cfa302`), 2026-11-02, for QA-08 (`docs/plan/qa.md`).
- **Decision**: the load scenarios in `tests/load/` are Node.js scripts that use the `ws` client, run as
  node-only Playwright specs (projects `load-smoke` and `load-full`, `tests/playwright.config.ts`). k6 is not
  used. The QA-08 row allows either one: "k6 (`k6/ws`) or Node script scenarios".

## Constraints

1. **Binary chunk frames with a 12-byte header** (`docs/protocol.md` §6.3), up to 1 MiB + 12 B each, sent by the
   publisher and validated by every viewer: magic, `sceneVersion`, strictly increasing `chunkIndex`, payload
   size, and the SHA-256 of the whole GLB at `scene.snapshot.end` (§6.4).
2. **The HTTP path** (§6.5, §10). A deferred viewer gets `scene.snapshot.ready` and fetches
   `GET /api/scene/:v` with `Authorization: Bearer <viewerToken>`. Fan-out time is measured up to the last
   viewer that holds the verified GLB, whichever path it took.
3. **One clock for the update latency** (NFR-02, p95 ≤ 500 ms). The send time and the receive time have to be
   read from the same clock.
4. **A per-client `X-Forwarded-For`** on the upgrade. The harness relay runs with `TRUST_PROXY=true`, so each
   simulated client stays inside the per-IP limits (§12).
5. **A viewer that reads nothing** (FR-24). TCP back-pressure has to reach the relay, so the client must be able
   to stop reading its socket, not just ignore messages it has already read.
6. **The relay under test is the built one, started by the harness** (`tests/harness/stack.ts`) on 127.0.0.1,
   with its RSS sampled from outside (`ps -o rss=`).
7. **Secrets** (NFR-12): the session code and tokens stay in memory, and no tool output contains them.

## What k6 offers (verified 2026-11-02)

- `k6/ws` has `Socket.sendBinary(data)` and a `binaryMessage` event. Its page says a module with "a better and
  standard API exists" and recommends it "when possible".
  <https://grafana.com/docs/k6/latest/javascript-api/k6-ws/>
- `k6/websockets` (formerly `k6/experimental/websockets`, which is deprecated in its favour) partially
  implements the WebSockets living standard on a global event loop. It has `binaryType = "arraybuffer"`,
  `bufferedAmount`, and `Params` for request headers. `send()` takes a string, `ArrayBuffer`, `Blob` or
  `ArrayBufferView`.
  <https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/>,
  <https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/websocket/websocket-send/>
- `k6/crypto` has `sha256()` and an incremental `createHash()`. A WebCrypto-based `crypto` module is the
  recommended alternative. <https://grafana.com/docs/k6/latest/javascript-api/k6-crypto/>
- k6 "isn't Node.js or a browser". It does not resolve node modules, packages that need Node APIs (`fs`, `os`,
  …) do not work, and npm code has to be bundled first (webpack).
  <https://grafana.com/docs/k6/latest/using-k6/modules/>
- None of the pages documents a way to stop reading a socket (pausing the TCP read) to simulate a slow consumer.
  `[TODO verify]` if k6 is reconsidered: a k6 VU that ignores `binaryMessage` still reads the socket, so the
  relay's `bufferedAmount` would not grow.

k6 could therefore speak the binary framing (constraint 1) and hash the result (constraint 2). It could not
reuse the product's own code, and constraint 5 is not covered by its documented API.

## Why Node `ws`

- **The product's encoder and checks are reused, not re-implemented.** `@slicerremoteview/shared`
  (`chunkify`, `encodeChunkFrame`, `decodeChunkHeader`, `chunkCountFor`, `LIMITS`) and
  `@slicerremoteview/fake-slicer` (`snapshotBegin`, `envelope`, `loadGlb` with the manifest's `nodeIds`) are
  imported directly. A k6 script would need a second implementation of the §6.3 header and the §6.2 begin
  fields, or a webpack bundle of TypeScript packages that import `node:crypto`, `node:fs` and `ws`, which k6
  cannot run. The relay's own smoke (`relay-server/scripts/load-smoke.ts`, SRV-21) makes the same choice.
- **The SHA-256 checks are the viewers' checks.** `node:crypto` `createHash` hashes each chunk as it arrives and
  checks it against `begin`/`end` (§6.4). The HTTP body is checked against `scene.snapshot.ready`.
- **Slow consumer.** `ws` `WebSocket#pause()` pauses the underlying socket (`tests/node_modules/@types/ws`), so
  the kernel buffers fill and back-pressure reaches the relay's `bufferedAmount`. This is the FR-24 mechanism
  (§3.3: 4 MiB soft watermark, 8 MiB hard).
- **Same clock.** Publisher and viewers run in one process, so `performance.now()` times both the send and the
  receive.
- **Harness integration.** Each test gets a fresh relay from the `stack` fixture: the staged build, with logs in
  the test output directory. `nextIp()` gives each client its own `X-Forwarded-For` address, and CI needs no
  extra binary (k6 is not installed here, `which k6` → not found, and it is not in `tests/package.json`).

## Costs and limits of the choice

- **One Node process drives every client.** The 20 (or 50) viewers share one event loop for frame parsing and
  hashing. This mostly matters when the publisher is unpaced: then the relay receives the whole snapshot in a few
  event-loop turns, and the viewers cannot drain their sockets faster than that. On loopback, every viewer then
  crosses the 4 MiB soft watermark and is deferred to the HTTP path. This is the relay working as specified
  (§6.4, §6.5), the same effect as in report `docs/testing/reports/2026-10-27-release-1.md`. The suites
  therefore run (a) unpaced (the worst case, which measures the HTTP path) and paced at a 10 MiB/s publisher
  uplink (the streaming path). Scenario (e) uses the paced publisher, so "the other 19 are unaffected" can be
  asserted as "the other 19 were streamed". Scenario (b) is paced too. With 10 unpaced 20 MiB publishers, all
  50 viewers reach the soft watermark together (≈ 200 MiB), which is more than `MAX_TOTAL_BUFFERED_BYTES`
  (160 MiB). The relay then closes the largest buffer `4010`, as architecture §4 specifies; this happened in one
  of three runs (`tests/load/REPORT.md`).
- **Loopback only.** There is no real network latency, bandwidth or TLS. Classroom Wi-Fi with 20 phones and
  4G stay manual (`docs/plan/qa.md`, Manual verification), and a staging relay on Railway is a follow-up
  (NFR-34 egress cost).
- **Not limited to 1 vCPU.** NFR-05 says "on 1 vCPU". The relay is one Node event loop, but on macOS it cannot
  be pinned to one core. A Linux CI runner (2–4 vCPU) or `docker run --cpus=1` on the relay image is closer to
  the requirement.
