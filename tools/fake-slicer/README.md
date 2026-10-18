# tools/fake-slicer — Slicer simulator for relay/viewer development (sends fixture GLBs and updates)

Part of **SlicerRemoteView**. Owned by the `protocol` workstream (branch `ws/protocol`, plan
`docs/plan/protocol.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

Lets `relay-server`, `web-viewer` and QA work without a real 3D Slicer: it connects to a relay as the
**publisher**, creates a session, hands out the session code (only through `--code-fd`) and streams a fixture GLB
as snapshot version 1 (`scene.snapshot.begin` → `SRVC` chunks → `scene.snapshot.end`, §6), then plays an optional
update script (`--script`, §8). It keeps the session alive like the plugin would: application heartbeat, reconnect with
`session.resume` and the `session.create{preferredCode}` fallback (§4.3, §9), plus a QA late-join mode.
This package also ships the **in-process relay stub** the tests (and WEB-10 until `relay-server` exists) use.

## How to run

From the repository root (Node 22):

```bash
npm install                      # links the workspace and the `fake-slicer` bin
npm run build                    # shared/ first, then tools/fake-slicer (bin runs dist/)
npx fake-slicer --help
npx fake-slicer --relay ws://localhost:8787/ws --fixture large-synthetic.glb --chunk-size 65536
```

| Option                               | Meaning                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--relay <url>`                      | relay WebSocket endpoint, default `ws://localhost:8787/ws`; plain `ws://` only for localhost, no query/credentials (§3.1)                                       |
| `--fixture <glb>`                    | GLB to publish: a path, or a bare file name from `shared/fixtures/glb/` (default `asymmetric-2nodes.glb`)                                                       |
| `--chunk-size <bytes>`               | snapshot chunk payload, 65,536 … 1,048,576 (default 1 MiB); the last chunk is shorter (§6.2)                                                                    |
| `--script <name\|file>`              | play an update script after the first snapshot ack (see below); a path, or the name of a bundled script                                                         |
| `--loop`                             | with `--script`: start over after the last entry; `sceneVersion` keeps increasing                                                                               |
| `--close-after <ms>`                 | `ms` after the first snapshot ack send `session.close{reason:"USER_STOPPED"}` (§4.5) and exit `0`                                                               |
| `--exit-after-ack`                   | exit `0` as soon as the relay sends `scene.snapshot.ack`; **by default the publisher stays connected** so viewers can join and updates can follow, until Ctrl-C |
| `--profile <mobile\|quest2\|quest3>` | budget profile sent in `session.create` (default `mobile`)                                                                                                      |
| `--preferred-code <code>`            | ask for this code (§4.1); typed input such as `7kq-4x` is normalised, `0 O 1 I L` are rejected with the ADR 0008 hint                                           |
| `--code-fd <n>`                      | write `<CODE> <JOIN-URL>` to file descriptor `n` (≥ 3). **The code is never printed to stdout/stderr**, so CI logs do not contain it (NFR-12)                   |
| `--json`                             | with `--code-fd`: one `{"code","url"}` JSON line instead                                                                                                        |

Exit codes: `0` snapshot acknowledged with `--exit-after-ack` (a relay close before the ack is `1`), or normal end (Ctrl-C); `1` usage error (bad option,
unusable fixture), local failure or relay unreachable; `2` the relay answered with `error` (only the error code is
printed — `relay error: CHECKSUM_MISMATCH` — never session data). Progress lines (`snapshot 1: 3400 bytes in 1 chunks sent`,
`snapshot 1 acknowledged`) go to stderr and contain no code.

Harnesses (SRV-22, WEB-10, QA-02) read the code from a pipe. Start the bin **directly**, not through `npx` or
`npm run` — those wrappers do not pass extra file descriptors on:

```bash
node_modules/.bin/fake-slicer --relay ws://localhost:8787/ws --code-fd 3 3>code.txt   # shell
```

```ts
spawn("node_modules/.bin/fake-slicer", ["--code-fd", "3", "--json"], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
// child.stdio[3] receives {"code":"…","url":"http://localhost:8787/j#…"}
```

## Resilience (PRO-16)

- **Heartbeat** (§9.1): an application `ping` every 15 s; no `pong` within 10 s → the socket is dropped and re-opened.
- **Reconnect**: after a network error or close `1006`/`1011`/`4007`/`4009`/`4010`/`4012` the publisher waits
  0.5 s → 30 s (exponential, jittered); after `4008` (relay restarting) a random 0–3 s (§9.3). The first connection must
  work: if the relay is unreachable before any session exists, the run exits `1` without retrying.
- **Resume** (§4.3): the first message of a new connection is `session.resume{sessionId, publisherToken,
lastSceneVersion}`. `session.resumed` → the publisher continues from the relay's `sceneVersion` and re-sends the
  snapshot (as the next version) only when the relay's `snapshotVersion` is `null` or older than its own.
  `SESSION_NOT_FOUND` (relay redeploy, §13 step 9) → `session.create{preferredCode: <old code>}` on the same socket and
  the snapshot restarts at `sceneVersion` 1 (§8.4); a running script continues.
- **No reconnect** after close `1008`, `1009`, `4000`, `4001`, `4002`, `4003`, `4011` (session ended, token rejected,
  replaced): the run ends with exit `2` and `relay closed the connection (code N); not reconnecting` on stderr.
- Reconnecting never gives up by itself (capped at 30 s between attempts); end the run with Ctrl-C or `--close-after`.
- Session id, token and code live in memory only and are never printed. Reconnect progress lines carry close codes and
  delays, nothing else.
- With `--json` the `--code-fd` pipe carries one line per event after the first `{"code","url"}` line:
  `{"event":"viewer.count","count":2}`, `{"event":"session.resumed","viewerCount":2}`,
  `{"event":"session.recreated","codeChanged":false}`. If the relay did not grant the old code (§4.1) a new
  `{"code","url"}` line (plain mode: `<CODE> <URL>`) follows the `session.recreated` event. So with `--json` the pipe is
  **JSON Lines**, not one object: parse line by line (QA-03 reads the viewer count there); without `--json` it holds the
  code line(s) only.

## Update scripts (`--script`)

A script is a JSON array of entries `{ "afterMs": <int>, "type": <type>, …fields }`. `afterMs` is the pause **since the
previous entry** (the first entry waits since the snapshot ack). `type` is one of

| `type`              | Fields                                                                                          | Sent as                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `scene.update`      | `changes[]` (§8.1: `nodeId` plus `visible`/`color`/`opacity`/`matrix`)                          | `scene.update`                                                                                            |
| `scene.nodeRemoved` | `nodeIds[]`                                                                                     | `scene.nodeRemoved`                                                                                       |
| `scene.nodeAdded`   | `nodes[{nodeId, kind}]`, `snapshotFollows: true` — must be followed by a `scene.snapshot` entry | `scene.nodeAdded`                                                                                         |
| `scene.snapshot`    | optional `"fixture"` (path or name from `shared/fixtures/glb`; default: the `--fixture` GLB)    | a full snapshot (`begin`, chunks, `end`); the player waits for `scene.snapshot.ack` before the next entry |

Entries must not contain `sceneVersion`/`baseVersion`: fake-slicer owns the counter (§8.4) — snapshot = last + 1,
update = `{baseVersion: last, sceneVersion: last + 1}` — so versions increase strictly across snapshots, updates and
loop passes. Every entry is checked against the message schema at start-up (bad scripts exit `1` before connecting).
`--loop` needs a script with a non-zero total pause. Bundled in `tools/fake-slicer/scripts/` (nodeIds of
`asymmetric-2nodes.glb`: `vtkMRMLSegmentationNode1/Segment_1`, `vtkMRMLModelNode2`):

| Script              | What it does                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `toggle-visibility` | hides and shows the segment, then the model, 1 s apart                                                                           |
| `colour-cycle`      | three colour/opacity changes of both nodes, 1 s apart                                                                            |
| `move-node`         | moves the model through four `T.matrix` translations (glTF metres) and back, 0.5 s apart                                         |
| `reload-scene`      | `scene.nodeAdded{vtkMRMLModelNode3}` → new snapshot of `quantized-1node.glb` (a different node set) → one update of the new node |

```bash
node_modules/.bin/fake-slicer --relay ws://localhost:8787/ws --code-fd 3 --script toggle-visibility --loop 3>code.txt
```

## In-process relay stub (`src/relay-stub.ts`)

```ts
import { startRelayStub } from "@slicerremoteview/fake-slicer/relay-stub";
const stub = await startRelayStub(); // random port; { port: 8787 } to pick one
stub.url; // ws://127.0.0.1:<port>/ws
await stub.close();
```

Accepts one publisher (`session.create` → schema-valid `session.created` with a code from the protocol alphabet;
a valid `preferredCode` is granted), lets viewers `viewer.join` by code (→ `viewer.joined`, wrong code →
`error INVALID_CODE` + close `4004`), forwards every publisher frame — text and binary — to the joined
viewers **byte-for-byte** (§11) and answers `scene.snapshot.end` with `scene.snapshot.ack` (`autoAck: false`
switches that off) and checks the publisher's version bookkeeping (§6.2, §8.1, §8.4): offenders are answered with
`error BAD_SEQUENCE`, not forwarded, and listed in `stub.versionViolations`. It also answers `session.resume` while the session is in grace (`publisherGraceMs`; unknown session →
`SESSION_NOT_FOUND` with the socket kept open, wrong token → `UNAUTHORIZED` + `4003`), replies `pong` (`answerPings: false`
simulates a dead link) and sends `viewer.count`. Test knobs: `holdFramesUntilViewers: n` keeps publisher frames back while fewer than `n` viewers are joined
(a viewer can only join after `session.created`, so this makes "the viewer receives the whole snapshot" deterministic),
`stub.sendToPublisher(message)`, `stub.closePublisher(closeCode)` and `stub.restart()` (forget the session, close
everything with `4008`) inject relay messages, closes and a redeploy; `dropPublisherAfterChunks: n` cuts the first upload
short; `stub.handshakes` lists every `session.create`/`session.resume` the stub received. Validation stops at the envelope: it is not the relay (no limits, TTL, rate
limiting, snapshot cache or heartbeat; a malformed first message is answered with `INVALID_MESSAGE` and an
immediate close `4007`, where the relay would count strikes, §9). It logs nothing. Publisher frames are recorded in `stub.publisherFrames`.

Other workspaces (WEB-10) import the stub from `@slicerremoteview/fake-slicer/relay-stub`, which resolves to
`dist/`: run `npm run build` first, or alias the sources the way this package's `vitest.config.ts` does for `shared`.

## Test and lint commands

| Command                                  | What it does                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -w tools/fake-slicer`          | vitest (`test/options`, `test/relay-stub`, `test/run`, `test/snapshot`, `test/script`, `test/resume`); resolves `@slicerremoteview/shared` from its sources, no build needed |
| `npm run lint -w tools/fake-slicer`      | `eslint .` + `prettier --check .`                                                                                                                                            |
| `npm run typecheck -w tools/fake-slicer` | `tsc --noEmit` (strict)                                                                                                                                                      |
| `npm run build -w tools/fake-slicer`     | `tsc` → `dist/` (needs `npm run build -w shared` first; the root `npm run build` orders them)                                                                                |
