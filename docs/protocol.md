# SlicerRemoteView protocol v1.1 (contract)

Status: **contract**. Protocol version `1.1` (revision of 2026-10-27, see section 14; no new message type, field or error code; two schema bounds change, see section 14), written by `architect` on 2026-10-17 from the decisions
D1–D7 (see `docs/adr/0001`–`0008`) and the research notes in `docs/research/`. Every component
(`slicer-plugin`, `relay-server`, `web-viewer`, `quest-app`, `tools/fake-slicer`) implements exactly what is
written here. Changes follow CLAUDE.md rule 2: edit this file and bump the version first, separate
`docs(protocol): …` commit, then code. Requirements are referenced generically (see `docs/requirements.md`);
the canonical threat model lives in `docs/architecture.md` and is not repeated here.

Keywords MUST / SHOULD / MAY are used in the RFC 2119 sense. Byte sizes use IEC units (1 KiB = 1024 B).
Items marked `[TODO verify]` are design choices that still need a measurement or a vendor confirmation.

## 1. Roles and overview

| Role        | Who                                   | Connects how                              | Sends geometry? |
|-------------|---------------------------------------|-------------------------------------------|-----------------|
| `publisher` | 3D Slicer extension (one per session) | outbound WSS to the relay                 | yes (GLB)       |
| `viewer`    | web-viewer (phone/tablet/Quest Browser), quest-app | outbound WSS (+ HTTPS for cached scene) | never |
| `relay`     | Node.js service on Railway            | accepts both; owns sessions, codes, cache | forwards only   |

One session = one publisher + 0..20 viewers, identified to humans by a **5-character code** and internally
by a random `sessionId`. The relay keeps everything in memory (no disk, no payload logging) and forwards
the publisher's scene to viewers: a **GLB snapshot** (full geometry) plus **incremental JSON state updates**
(visibility, colour, opacity, transform). Viewers render locally and control their own camera (MVP, ADR-0004).

## 2. Versioning

- Every JSON message carries `"protocolVersion": "1.0"` (or `"1.1"`) in its envelope (string, `MAJOR.MINOR`).
  Revision `1.1` of this document adds publisher-side conventions (section 7.2–7.3), limits and clarifications of
  behaviour the components already share; it adds **no** message type, field or error code (two schema bounds change: section 14), so every receiver
  accepts `1.0` and `1.1` alike. A publisher announces `"1.1"` once it follows the `1.1` rules of sections 7
  and 9.1, the relay and the viewers once they have adopted this revision; announcing `"1.0"` stays valid and
  receivers accept any `1.x`.
- **Minor** versions are additive: new optional fields, new message types, new error codes. A receiver MUST
  ignore unknown fields. The **relay** MUST reply `error` `UNSUPPORTED_TYPE` (not close) to an unknown message
  type of a known major version; **clients** (publisher, viewers) silently ignore an unknown type (section 14).
- **Major** versions are breaking. The relay rejects a first message whose major is not supported with
  `error` `UNSUPPORTED_VERSION` and WebSocket close `4000`. Clients MUST NOT silently downgrade.
- The relay answers with its own `protocolVersion`; a client whose minor is lower than the relay's MUST still
  work (it simply never sees the new fields). `GET /api/version` lists the supported versions (section 10).
- Changelog: section 14.

## 3. Transport

### 3.1 WebSocket endpoint

- One endpoint for both roles: `wss://<host>/ws` (plain `ws://` only on `localhost` in development).
- No code, token or role in the URL path, query string, cookies or `Sec-WebSocket-Protocol`. The role is
  declared by the **first message** (`session.create`, `session.resume` or `viewer.join`), which MUST arrive
  within 10 s of the upgrade (or of a `SESSION_NOT_FOUND` reply to `session.resume` or to a token `viewer.join`, sections 4.3 and 13 step 9), otherwise
  the relay closes with `4012`. Until `session.created`, `session.resumed` or `viewer.joined` has been sent, the
  relay accepts only handshake messages and `ping`; anything else is an `UNAUTHORIZED` offence (an unknown type
  too, close `1008`).
- Clients MUST NOT follow HTTP redirects on `/ws` or `/api/scene/:sceneVersion`, and send credentials (the
  `Authorization` header, the first WebSocket message) only to the configured relay origin.
- Clients offer no WebSocket subprotocol; the relay refuses an upgrade that carries `Sec-WebSocket-Protocol`
  with HTTP 400 (it would otherwise echo the client's first offer).
- Browsers send an `Origin` header; the relay accepts only its own origin(s) (`ALLOWED_ORIGINS`). Requests
  without `Origin` (Slicer, Unity) are accepted; foreign origins get HTTP 403 before the upgrade.
- `permessage-deflate` is disabled (relay.md: zlib memory fragmentation; GLB does not compress well).

### 3.2 Frames

- **Text frames** carry exactly one JSON object, UTF-8, the *envelope*:

  ```json
  { "protocolVersion": "1.0", "type": "<namespace.verb>", "id": "c-17", "replyTo": "c-16", "ts": 1792238400000, "...payload fields..." : "" }
  ```

  `type` is required. `id` (string, ≤ 32 chars) is optional and chosen by the sender; a response or `error`
  that answers a specific message echoes it in `replyTo`. `ts` is optional, milliseconds since the Unix epoch
  (integer), informational only (clocks are not synchronised). Payload fields are flat in the envelope.
  Field order is irrelevant; numbers are IEEE doubles; colours are `[r, g, b]` floats in `0..1`.
- **Binary frames** carry only GLB snapshot chunks (section 6) and only from the publisher. A binary frame
  from a viewer is a protocol violation: `error` `UNAUTHORIZED`, close `1008`.
- Senders MUST NOT fragment at the application level beyond what is specified here; the relay treats every
  WebSocket message as one unit (`ws` reassembles frames up to `maxPayload`, relay.md §2).

### 3.3 Limits

| Limit | Value | Enforced by | Rationale |
|---|---|---|---|
| Max text message, publisher | 256 KiB (262,144 B) | relay (`1009` if exceeded) | a `scene.update` for 1,000 nodes with matrices is ≈ 250 KiB; larger updates MUST be split |
| Max text message, viewer | 16 KiB (16,384 B) | relay (`1009`) | viewers only send join/ping/request; small cap limits abuse |
| Max binary chunk payload | 1 MiB (1,048,576 B) + 12 B header | relay (`PAYLOAD_TOO_LARGE`, `1009`) | bounded reassembly buffers; progress UI; browser WS message limits are undocumented (web.md §5) |
| `ws` `maxPayload` (server-wide) | 1 MiB + 64 KiB (1,114,112 B) | relay | `@fastify/websocket` has one server-wide limit (relay.md §2); chunking lets it be small for everyone |
| Max snapshot (`MAX_SNAPSHOT_BYTES`) | 64 MiB (67,108,864 B) hard | relay (`PAYLOAD_TOO_LARGE` on `scene.snapshot.begin`; the schema of `begin.byteLength` has no 64 MiB maximum, so every receiver reaches this rule, section 6.2) | 1 M quantized triangles with normals ≈ 20–30 MiB; 64 MiB leaves headroom and bounds relay memory at 2× per session (architecture.md §5) |
| Recommended snapshot, `mobile` profile | ≤ 32 MiB (33,554,432 B) | publisher (decimation) | Safari WebContent process limit ≈ 1.5 GB (web.md §2); GLB + three.js copies ≈ 4× the file; keep well under 1 GB |
| Max chunks per snapshot | 1,024 | relay (`INVALID_MESSAGE` on `scene.snapshot.begin`) | 64 MiB / 64 KiB (smallest `chunkSize`); the relay checks `chunkCount == ceil(byteLength / chunkSize) <= 1024` |
| Chunk inter-arrival timeout | 120 s | relay (abort snapshot, `BAD_SEQUENCE`) | stalled publisher must not pin memory |
| Global snapshot budget (`MAX_TOTAL_SNAPSHOT_BYTES`) | 512 MiB default (cached + in-flight, all sessions) | relay (`CAPACITY` on `scene.snapshot.begin`) | `Buffer`s are off-heap, so an application budget is the only effective guard (relay.md §6); ≈ 50 % of a 1 GiB container |
| Max live sessions (`MAX_SESSIONS`) | 100 default | relay (`CAPACITY` on `session.create`) | bounds memory and the live-code population `S` (section 12) |
| Max viewers per session (`MAX_VIEWERS`) | 20 | relay (`SESSION_FULL`) | fan-out of a 32 MiB snapshot to 20 viewers = 640 MiB egress per snapshot; also Railway ~10,000 connections per domain (relay.md §1.3) |
| Max `changes` per `scene.update` | 1,000 | relay (`INVALID_MESSAGE`) | with the text limit above |
| `sceneVersion`, `snapshotVersion`, `baseVersion` and their echoes | uint32: `snapshotVersion` and the `sceneVersion` of updates `1 … 4,294,967,295`; `sceneVersion` / `baseVersion` elsewhere `0 …` (0 = nothing published) | schema | the chunk header carries the version as uint32 (section 6.3) |
| `nodeId` length | ≤ 128 chars, `[A-Za-z0-9_./:-]` | relay, viewers | MRML IDs are short ASCII; a segment ID that does not fit is replaced by an alias (section 7.3) |
| Node `name` length (GLB extras) | ≤ 64 chars (UTF-16 code units, the length JavaScript and C# report) after sanitisation | publisher | UI labels; see section 7.3 |
| Merged scene state (`scene.state`) | ≤ 1,000 node ids | relay (`BAD_SEQUENCE`, `details.field: "nodeState"`) | bounds relay memory; a snapshot empties the state (section 8.3) |
| Application heartbeat | client `ping` every 15 s; `pong` expected within 10 s (publishers uploading a snapshot: section 9.1) | clients | browsers cannot send WS pings (web.md §5) |
| Relay WS ping | every 30 s; terminate if no pong, no publisher frame and no draining by the next tick (section 9.1) | relay | `ws` README pattern (relay.md §2) |
| Publisher grace (`PUBLISHER_GRACE_S`) | 120 s | relay | resume after network blip or relay redeploy |
| Idle TTL without viewers (`SESSION_TTL_S`) | 1,800 s | relay | shrinks the live-code population (anti-guessing) |
| Max session lifetime (`SESSION_MAX_LIFETIME_S`) | 43,200 s (12 h) | relay | memory hygiene |
| Handshake timeout | 10 s | relay (`4012`) | idle upgraded sockets |
| Publisher send buffer | 1 MiB, no soft watermark: `SLOW_CONSUMER` + close `4010` | relay | a publisher only receives short replies; a publisher that reads nothing must not grow relay memory (T3) |
| Viewer slow-consumer watermarks | soft **4 MiB**: stop forwarding live chunks to that viewer (it fetches via HTTP after `scene.snapshot.ready`); hard **8 MiB** or stuck > 60 s: close `4010` `SLOW_CONSUMER` | relay | `ws` backpressure is `bufferedAmount` only (relay.md §2); Σ over all viewers is capped by `MAX_TOTAL_BUFFERED_BYTES` (architecture.md §4) |

## 4. Session lifecycle (publisher)

### 4.1 `session.create` (publisher → relay)

```json
{ "protocolVersion": "1.0", "type": "session.create", "id": "p-1", "ts": 1792238400000,
  "clientInfo": { "app": "SlicerRemoteView", "version": "0.3.0", "platform": "Slicer 5.12.4 / win32" },
  "preferredCode": null,
  "profile": "mobile" }
```

- `preferredCode` (string|null): a code the publisher previously held (after a relay restart the registry is
  empty, so the code shown on the lecture screen can stay valid). Granted only if the code is well-formed and
  currently free, that is neither live nor in the post-release quarantine (`CODE_QUARANTINE_S`, ADR 0008);
  otherwise a fresh code is generated silently. A well-formed `preferredCode` counts as a failed join of the
  sender's address (section 12). `session.create` carries no token field (`publisherToken`, `viewerToken`,
  `token` are refused).
- `profile`: `"mobile" | "quest2" | "quest3"` — the decimation budget the publisher exported for (section 7.5).
  Informational for viewers.

### 4.2 `session.created` (relay → publisher)

```json
{ "protocolVersion": "1.0", "type": "session.created", "replyTo": "p-1", "ts": 1792238400120,
  "sessionId": "sess_01K7Q4XMB2TJ9RD6", "code": "7KQ4X",
  "publisherToken": "pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA",
  "viewerLimit": 20,
  "ttl": { "graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120 },
  "limits": { "maxSnapshotBytes": 67108864, "maxChunkBytes": 1048576, "maxTextBytes": 262144, "maxChanges": 1000 } }
```

- `code`: 5 characters from the alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols, no `0 O 1 I L`;
  31^5 = 28,629,151 codes), generated by the relay with `crypto.randomInt`, unique among live sessions.
- `publisherToken`: ≥ 128-bit random, base64url, shown once; the relay stores only its SHA-256. It is the
  **resume credential** and MUST be kept in memory by the plugin (never written to disk, never logged).
- `sceneVersion` starts at `0` (nothing published).

### 4.3 `session.resume` (publisher → relay, first message after reconnect)

```json
{ "protocolVersion": "1.0", "type": "session.resume", "id": "p-9",
  "sessionId": "sess_01K7Q4XMB2TJ9RD6",
  "publisherToken": "pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA",
  "clientInfo": { "app": "SlicerRemoteView", "version": "0.3.0", "platform": "Slicer 5.12.4 / win32" },
  "lastSceneVersion": 42 }
```

Success → `session.resumed`:

```json
{ "protocolVersion": "1.0", "type": "session.resumed", "replyTo": "p-9",
  "sessionId": "sess_01K7Q4XMB2TJ9RD6", "code": "7KQ4X",
  "sceneVersion": 42, "snapshotVersion": 40, "viewerCount": 3,
  "ttl": { "graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120 } }
```

- Allowed while the session is in `grace` (publisher offline ≤ `PUBLISHER_GRACE_S`) **or** while the old
  publisher socket is still open (then the old socket is closed with `4011` — handles half-open sockets).
- `snapshotVersion` tells the publisher which snapshot the relay still caches; if `null` or older than the
  publisher's current scene, the publisher MUST send a new snapshot.
- Failure `SESSION_NOT_FOUND` (after a relay redeploy): the relay replies `error` and keeps the socket open
  for 10 s so the publisher can fall back to `session.create` with `preferredCode` set to the old code. Failure
  `UNAUTHORIZED` (token mismatch): `error` then close `4003` **immediately** — no fallback on that socket
  (section 9.2). Viewers meanwhile retry the same code (section 11, walkthrough step 9).

### 4.4 `session.renew`, `session.expiring`, `session.renewed`

The idle timer (`SESSION_TTL_S`) runs only while a session has **no connected viewers**. 60 s before expiry
the relay sends `session.expiring`; the publisher MAY answer `session.renew` (the plugin decides whether this
needs a user click) and receives `session.renewed`.

```json
{ "protocolVersion": "1.0", "type": "session.expiring", "reason": "IDLE", "closesAt": 1792240260000 }
{ "protocolVersion": "1.0", "type": "session.renew", "id": "p-20" }
{ "protocolVersion": "1.0", "type": "session.renewed", "replyTo": "p-20", "ttl": { "graceS": 120, "idleS": 1800, "maxLifetimeS": 43200, "expiresAt": 1792281600120 } }
```

### 4.5 `session.close` (publisher → relay) and relay broadcasts

```json
{ "protocolVersion": "1.0", "type": "session.close", "id": "p-77", "reason": "USER_STOPPED" }
```

The relay releases the code into the quarantine (`CODE_QUARANTINE_S`, ADR 0008), drops the snapshot buffer,
and sends to every viewer:

```json
{ "protocolVersion": "1.0", "type": "session.closed", "sessionId": "sess_01K7Q4XMB2TJ9RD6", "reason": "PUBLISHER_CLOSED" }
```

followed by WebSocket close `4001`. Relay-initiated expiry uses `session.expired` + close `4002`:

```json
{ "protocolVersion": "1.0", "type": "session.expired", "sessionId": "sess_01K7Q4XMB2TJ9RD6", "reason": "PUBLISHER_GONE" }
```

`reason` ∈ `PUBLISHER_CLOSED | PUBLISHER_GONE | IDLE | MAX_LIFETIME | CAPACITY`. A relay restart sends no
`session.*` message, only close `4008` (section 9.3).

### 4.6 `session.publisherState` (relay → viewers)

Sent when the publisher disconnects (grace starts) and when it resumes, so viewers can show
"presenter reconnecting…" instead of a dead scene.

```json
{ "protocolVersion": "1.0", "type": "session.publisherState", "online": false, "graceEndsAt": 1792238520000 }
```

## 5. Viewer join

### 5.1 `viewer.join` (viewer → relay, first message)

Typed or deep-linked code (the viewer uppercases the input and rejects characters outside the alphabet):

```json
{ "protocolVersion": "1.0", "type": "viewer.join", "id": "v-1", "ts": 1792238405000,
  "code": "7KQ4X",
  "clientInfo": { "app": "web-viewer", "version": "0.3.0", "platform": "web", "profile": "mobile",
                  "capabilities": { "httpScene": true, "maxSnapshotBytes": 33554432 } } }
```

Rejoin after a disconnect, without spending a rate-limit slot on the code:

```json
{ "protocolVersion": "1.0", "type": "viewer.join", "id": "v-1",
  "sessionId": "sess_01K7Q4XMB2TJ9RD6", "viewerToken": "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  "clientInfo": { "app": "quest-app", "version": "0.1.0", "platform": "quest3", "profile": "quest3",
                  "capabilities": { "httpScene": true, "maxSnapshotBytes": 67108864 } } }
```

`platform` ∈ `web | quest-browser | quest2 | quest3 | other`; `clientInfo.profile` (`mobile | quest2 | quest3`)
is **informational** — the budget is chosen by the publisher (section 7.5). No device identifiers, no user
names. Exactly one of `code` or (`sessionId` + `viewerToken`) is present.

### 5.2 `viewer.joined` (relay → viewer)

```json
{ "protocolVersion": "1.0", "type": "viewer.joined", "replyTo": "v-1", "ts": 1792238405080,
  "sessionId": "sess_01K7Q4XMB2TJ9RD6", "viewerId": "vw_4f2a",
  "viewerToken": "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  "sceneVersion": 42, "snapshotVersion": 40, "snapshotAvailable": true,
  "snapshot": { "sceneVersion": 40, "byteLength": 18874368, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "format": "glb" },
  "publisherOnline": true, "viewerCount": 4, "viewerLimit": 20, "profile": "mobile" }
```

- `viewerToken` (≥ 128-bit, base64url, relay stores the hash) authorises `GET /api/scene/:sceneVersion`
  and rejoin. It is bound to the session and dies with it.
- `snapshotAvailable: true` means the viewer SHOULD immediately fetch the cached GLB over HTTP (section 6.5).
  A `scene.state` message **always** follows `viewer.joined` (empty when nothing changed since the snapshot;
  section 8.3), so clients have one code path.
- Failure: `error` with `code` ∈ `INVALID_CODE | SESSION_NOT_FOUND | SESSION_FULL | RATE_LIMITED |
  UNAUTHORIZED | CAPACITY`, then close `4004`–`4006` (section 9). `INVALID_CODE` covers both "malformed"
  and "no such live session" so that responses do not reveal which codes are live.

### 5.3 `viewer.count` (relay → publisher and viewers)

Sent on every join/leave. Aggregated, no PII:

```json
{ "protocolVersion": "1.0", "type": "viewer.count", "viewerCount": 4, "viewerLimit": 20,
  "platforms": { "web": 3, "quest3": 1 } }
```

### 5.4 `viewer.leave` (viewer → relay, optional)

```json
{ "protocolVersion": "1.0", "type": "viewer.leave" }
```

Followed by client close `1000`. Viewers that simply vanish are removed after the WS ping timeout.

## 6. Scene snapshot (GLB)

### 6.1 Sequence

```
publisher → relay:   scene.snapshot.begin {sceneVersion, byteLength, sha256, chunkCount, chunkSize, format, extensionsUsed}
publisher → relay:   binary chunk 0 … chunk N-1   (12-byte header + payload each)
publisher → relay:   scene.snapshot.end {sceneVersion, sha256}
relay    → viewers:  same three steps, forwarded as they arrive (streaming fan-out) …
relay    → viewers:  … or scene.snapshot.ready {sceneVersion, byteLength, sha256} for viewers that were skipped
```

### 6.2 `scene.snapshot.begin` (publisher → relay → viewers)

```json
{ "protocolVersion": "1.0", "type": "scene.snapshot.begin", "id": "p-30", "ts": 1792238410000,
  "sceneVersion": 43, "byteLength": 18874368,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "chunkCount": 18, "chunkSize": 1048576, "format": "glb",
  "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
  "profile": "mobile", "nodeCount": 14, "triangleCount": 412876 }
```

- `sceneVersion` MUST be greater than every version used so far in the session (section 8.4).
- `sceneVersion` and `profile` MUST equal the `extras.sceneVersion` and `extras.profile` of the GLB root (section
  7.1); `nodeCount` is the number of `T` nodes (section 7.2) and `triangleCount` the sum of their
  `triangleCount`.
- `chunkSize` MUST be between 64 KiB and 1 MiB (SHOULD be 1 MiB) and is identical for all chunks except the
  last; the relay checks `chunkCount == ceil(byteLength / chunkSize) <= 1024` (`INVALID_MESSAGE` otherwise).
- `extensionsUsed` MUST be a subset of what v1 allows: `KHR_mesh_quantization` only (Draco is planned for
  v1.1 — ADR-0001; meshopt is excluded because Unity's decoder is experimental, quest.md §4).
- The relay rejects the message with `error` `PAYLOAD_TOO_LARGE` (`details.maxSnapshotBytes`, no strike) if
  `byteLength > MAX_SNAPSHOT_BYTES`, or `CAPACITY` if the global snapshot budget would be exceeded; it then
  ignores the chunks of that version. The schema of `begin.byteLength` has no maximum beyond 2^53 − 1 (the largest exactly representable integer), and
  the relay compares it with `MAX_SNAPSHOT_BYTES` **before** any chunk arithmetic (`byteLength` of
  `scene.snapshot.ready` and `viewer.joined.snapshot` keeps the 64 MiB maximum), so a publisher can tell
  "scene too large for this relay" (reduce the profile) from a malformed message.
- A `scene.snapshot.begin` while another snapshot is in flight **aborts** the in-flight one (relay sends
  `scene.snapshot.abort` for the old version to viewers). The publisher MUST NOT send `scene.update` or
  `scene.nodeRemoved` or `scene.nodeAdded` between `scene.snapshot.begin` and `scene.snapshot.end`: the relay
  answers `error` `BAD_SEQUENCE` (`retryable: true`, `details.field: "snapshotInFlight"`) and ignores the
  message. The publisher queues state changes locally and
  sends them after `end` with `baseVersion` = the new snapshot version.

### 6.3 Binary chunk format

Each binary WebSocket message = **12-byte little-endian header + payload**:

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 4 | magic | ASCII `SRVC` (`0x53 0x52 0x56 0x43`) |
| 4 | 4 | `sceneVersion` | uint32 LE, same as in `scene.snapshot.begin` |
| 8 | 4 | `chunkIndex` | uint32 LE, `0..chunkCount-1`, strictly increasing |
| 12 | n | payload | bytes `[chunkIndex*chunkSize, min((chunkIndex+1)*chunkSize, byteLength))` of the GLB |

Why a header instead of raw frames counted by the relay: a stale chunk from an aborted snapshot, a chunk that
arrives after a reconnect, or a bug that drops one frame would otherwise corrupt the reassembly silently.
With `sceneVersion` + `chunkIndex` every receiver (relay and viewers) can validate order, discard stale data
and report `BAD_SEQUENCE` with a precise `details`. The cost is 12 bytes per MiB. Receivers pre-allocate one
buffer of `byteLength` and copy each payload to `chunkIndex * chunkSize` (web.md §5).

Receiver rules: wrong magic, unknown `sceneVersion`, out-of-order or duplicate `chunkIndex`, payload size not
matching the expected size, or total exceeding `byteLength` → `error` `BAD_SEQUENCE`, snapshot discarded;
the publisher MUST start again with a new `sceneVersion`.

### 6.4 `scene.snapshot.end`, `scene.snapshot.abort`, `scene.snapshot.ready`

```json
{ "protocolVersion": "1.0", "type": "scene.snapshot.end", "sceneVersion": 43,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }
```

The relay verifies `byteLength` and the SHA-256 of the assembled buffer before accepting the snapshot
(mismatch → `error` `CHECKSUM_MISMATCH` to the publisher, `scene.snapshot.abort` to viewers, buffer freed).
On success the relay atomically replaces the cached snapshot (previous buffer released), resets the
merged state (section 8.3) to empty, and forwards `scene.snapshot.end` to the viewers that received the
stream. Viewers SHOULD verify the hash too (`crypto.subtle.digest` / `SHA256.HashData`) — cheap defence
against a buggy relay. The relay also replies to the publisher:

```json
{ "protocolVersion": "1.0", "type": "scene.snapshot.ack", "sceneVersion": 43, "viewersStreamed": 3, "viewersDeferred": 1 }
```

```json
{ "protocolVersion": "1.0", "type": "scene.snapshot.abort", "sceneVersion": 43, "reason": "SUPERSEDED" }
```

`reason` ∈ `SUPERSEDED | CHECKSUM_MISMATCH | BAD_SEQUENCE | PUBLISHER_GONE | TIMEOUT`. May be sent by the
publisher (user cancelled export) or by the relay. Receivers free the partial buffer.

```json
{ "protocolVersion": "1.0", "type": "scene.snapshot.ready", "sceneVersion": 43, "byteLength": 18874368,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "format": "glb",
  "extensionsRequired": ["KHR_mesh_quantization"] }
```

`scene.snapshot.ready` tells a viewer "fetch this version over HTTP". The relay sends it (a) to viewers that
were connected but skipped during streaming because their `bufferedAmount` exceeded the soft watermark (4 MiB),
(b) to viewers that joined while a snapshot was in flight, (c) in answer to `scene.request`.
A viewer that is assembling the stream of the same `sceneVersion` when `scene.snapshot.ready` arrives
discards the partial buffer (and ignores any later chunk of that version) and fetches the version over HTTP. A
scene download that ends before `Content-Length` bytes (the session ended or a newer snapshot replaced the
cache) is a failed download: drop the bytes and fetch the version the latest `scene.snapshot.ready` or
`viewer.joined` announced, if the session is still live.

### 6.5 Late joiners and the HTTP path — which one viewers should prefer

Two ways exist to obtain the latest complete snapshot:

1. **Streaming over the WebSocket** — only while the publisher is sending it. Lowest latency (chunks are
   forwarded as they arrive), progress for free. Downside: head-of-line blocking on a slow viewer (updates
   queue behind 30 MiB of chunks on one TCP stream; `ws` offers only `bufferedAmount` to notice, relay.md §2).
2. **`GET /api/scene/:sceneVersion`** with `Authorization: Bearer <viewerToken>` (section 10). Separate
   connection, so live JSON updates keep flowing on the WebSocket; Node streams the cached `Buffer` with
   native TCP backpressure and the browser gets `fetch` progress via `ReadableStream`; the same single
   `Buffer` serves all 20 viewers without copies; Railway's edge has no response-size limit and allows
   15 min per request (relay.md §1.3). Downside: one extra round trip and a second TLS handshake.

Rule: a viewer MUST support the HTTP path (`capabilities.httpScene: true`) and SHOULD use it whenever the
relay announces an existing snapshot (`viewer.joined.snapshotAvailable`, `scene.snapshot.ready`). Streaming is
what a connected viewer receives for *new* snapshots; the relay decides per viewer at `scene.snapshot.begin`
(stream if `bufferedAmount` < 4 MiB, otherwise defer to `scene.snapshot.ready`). A viewer that cannot keep the
HTTP path (e.g. a future constrained client) is out of scope in v1: the relay never streams a copy on request,
it answers `scene.request` with `scene.snapshot.ready` (section 8.3).

## 7. Scene manifest inside the GLB

The GLB is self-describing; the JSON protocol never repeats node names. Rules (checked in CI with
`gltf-validator` on fixtures from `tools/fake-slicer`):

### 7.1 Container and global rules

- glTF 2.0 binary container: 12-byte header, one JSON chunk, one BIN chunk; little-endian; chunk and
  accessor alignment per spec §4 (slicer.md §4). `asset.generator = "SlicerRemoteView <version>"`.
- **Units metres, +Y up, right-handed** (glTF spec). The publisher converts from RAS millimetres per vertex
  and per matrix: `[x, y, z]_gltf = [R, S, -A] × 0.001` (determinant +1 — winding preserved; ADR-0005).
  Patient faces −Z; viewers MAY rotate the root 180° about Y for presentation but MUST NOT change the data.
- Exactly one scene; its single root node is named `SlicerRemoteView` with extras:

  ```json
  { "nodeId": "root", "kind": "root", "sceneVersion": 43, "profile": "mobile",
    "source": { "app": "3D Slicer", "version": "5.12.4" }, "units": "m", "upAxis": "+Y",
    "rasToGltf": "x=R*0.001, y=S*0.001, z=-A*0.001", "anonymizedNames": false }
  ```

- No textures, images, samplers, animations, skins, cameras, lights, sparse accessors, external `uri`s or
  `KHR_materials_*` extensions in v1. `extensionsRequired` ⊆ `{KHR_mesh_quantization}`.
- Buffers: exactly one (the BIN chunk). Indices `UNSIGNED_SHORT` or `UNSIGNED_INT`. Primitive mode
  `TRIANGLES` (4) only.

### 7.2 One Slicer node = two glTF nodes

Each exported Slicer entity (model node or segment) becomes a **transform node** `T` under the root and
exactly one **mesh node** `M` as its only child:

- `T.name` = sanitised display name; `T.extras` = the manifest entry (7.3); `T.matrix` = the entity's
  world transform in glTF space (column-major, 16 floats; identity if none). Updates (section 8) address `T`.
  `T.matrix` MUST be **TRS-decomposable**: an affine matrix (last row `0 0 0 1`) whose upper 3×3 is a rotation
  times a non-zero, finite scale, without shear (columns orthogonal: the cosine of the angle between any two column axes is at most 1e-6 for the publisher's check, at most 1e-4 for a viewer's check on float32 values; a negative scale, i.e. a mirror, is decomposable and flips the winding as glTF defines). glTF
  requires it (`NODE_MATRIX_NON_TRS` in the validator) and three.js and Unity decompose node matrices, so a
  shear would be dropped silently. A transform that is not TRS-decomposable — shear (common after affine
  registration), zero or non-finite scale, a scale that overflows float32, or a non-linear transform — is
  applied to the vertices by the publisher (`baked: true`, `T.matrix` identity, section 7.3). A viewer treats a
  node whose `matrix` is not TRS-decomposable as a malformed snapshot.
- `M` has no extras (or `{"role":"mesh"}`), owns exactly **one mesh with one primitive and one material**,
  and `M.matrix` carries only the **dequantisation** transform when `KHR_mesh_quantization` is used
  (`POSITION` as `SHORT`, non-normalised, `M.matrix = scale ⊕ offset`), identity otherwise.

This split keeps `scene.update.matrix` safe: replacing `T.matrix` never destroys the quantisation scale.
Viewers map `extras.nodeId → T`, set visibility/transform on `T`, and material properties on `M`'s material.

### 7.3 Manifest entry (`T.extras`)

```json
{ "nodeId": "vtkMRMLSegmentationNode1/Segment_2", "kind": "segment",
  "mrmlId": "vtkMRMLSegmentationNode1", "segmentId": "Segment_2",
  "name": "Liver", "color": [0.80, 0.33, 0.27], "opacity": 1.0, "visible": true,
  "triangleCount": 58212, "baked": false }
```

- `nodeId`: stable for the lifetime of the Slicer scene — `node.GetID()` for models,
  `"<segmentationNodeID>/<segmentID>"` for segments (slicer.md §2). When Slicer closes/reloads the scene the
  publisher MUST start a new snapshot; IDs may be reused with new meaning only after a new snapshot.
  **Segment aliases (1.1):** Slicer keeps caller-supplied segment IDs verbatim (`left lung`, `Tumor(1)`, 100+
  characters, IDs an importer derived from a name). When `<segmentID>` is outside the `nodeId` character set
  (section 3.3), when the resulting `nodeId` would exceed 128 characters, or whenever `anonymizedNames` is `true`,
  the publisher uses the alias `"<segmentationNodeID>/s_<n>"` instead (`n` from a per-session counter that never
  repeats). The namespace `s_<digits>` is **reserved**: a raw segment ID of the form `s_<digits>` is itself
  aliased, so a real segment can never share an alias's `nodeId`, however late it is added or imported. The
  publisher keeps a raw ID → alias map for the lifetime of the Slicer scene: an alias is never reissued or
  shadowed, and every later `scene.update` and snapshot reuses it. `extras.segmentId` carries the raw ID, or is
  **omitted** when `anonymizedNames` is `true`. A model, and the segmentation node whose ID prefixes every segment `nodeId` (and `mrmlId`), keeps its MRML ID only if it matches
  `^vtkMRML[A-Za-z]+Node[0-9]+$` (what Slicer generates); an ID that does not (scripted and singleton IDs can be
  name-like) is replaced by `m_<n>` (own counter that never repeats), a reserved namespace handled like `s_<n>`. Viewers treat `nodeId` as an
  opaque string. Switching `anonymizedNames` on during a session MUST be followed by a new snapshot (the merged state
  is cleared, section 8.3), so no earlier verbatim `nodeId` stays in use.
- `kind` ∈ `model | segment`. `name`: display name with control characters removed, trimmed, ≤ 64 UTF-16 code
  units (the length JavaScript and C# report); when the user enables "anonymise names" the publisher
  substitutes `"Model 3"`/`"Segment 7"` and sets `anonymizedNames: true` on the root. With `anonymizedNames:
  true` **no string derived from a display name leaves Slicer**: every string in the GLB JSON chunk — node,
  mesh and material names, `scenes[].name`, `asset` fields, every `extras` value — is either a fixed constant
  (generator, `source`, `units`, `rasToGltf`, `kind`, ...), an alias or generated MRML ID, or `Model <n>` /
  `Segment <n>`; and nothing name-derived appears in any `nodeId` (hence the alias above) or any message. **Names may contain PHI** (patient names in file-derived node names);
  see the threat model in `docs/architecture.md`.
- `color`/`opacity`/`visible` duplicate the material and node state at export time so a viewer can rebuild
  its UI list without reading materials. `baked: true` means the node's world transform was applied to the
  vertices because it is not TRS-decomposable (non-linear, sheared, zero or overflowing scale; section 7.2) and
  `T.matrix` is identity (slicer.md §2).

### 7.4 Material rules

`pbrMetallicRoughness.baseColorFactor = [r, g, b, opacity]`, `metallicFactor: 0`, `roughnessFactor: 0.6`
(publisher may tune 0.4–0.9), `alphaMode: "BLEND"` iff `opacity < 1` else `"OPAQUE"`, `doubleSided` MAY be
`true` for open meshes (cut surfaces). `NORMAL` is REQUIRED (`vtkPolyDataNormals`, `SplittingOff`), stored as
`FLOAT` or normalised `BYTE` (padded to 4-byte stride). No vertex colours in v1 (scalar colouring deferred).

### 7.5 Budget profiles (publisher-side decimation, ADR-0005)

| Profile | Total triangles | Per node (after decimation) | Snapshot size target | Max visible nodes | Source |
|---|---|---|---|---|---|
| `mobile` | ≤ 500 k | ≤ 100,000 | ≤ 32 MiB recommended (64 MiB hard) | ≤ 120 meshes | Safari memory (web.md §2), mid-range Android draw calls `[TODO verify]` |
| `quest2` | ≤ 500 k | ≤ 100,000 | ≤ 32 MiB recommended (64 MiB hard) | ≤ 60 | Meta: < 750 k tris, < 100 draw calls (quest.md §7) |
| `quest3` | ≤ 1 M | ≤ 100,000 | ≤ 64 MiB (hard) | ≤ 120 | Meta: < 1.5 M tris, < 200 draw calls (quest.md §7) |

The profile is **chosen by the publisher** (Slicer UI) and announced in `session.create.profile`; viewers only
report `platform` and an informational `profile` (section 5.1). Nodes above the per-node cap are decimated
further, **never dropped** (requirements FR-10 / NFR-04).

## 8. Incremental updates

### 8.1 `scene.update` (publisher → relay → viewers)

```json
{ "protocolVersion": "1.0", "type": "scene.update", "id": "p-41", "ts": 1792238430000,
  "sceneVersion": 44, "baseVersion": 43,
  "changes": [
    { "nodeId": "vtkMRMLSegmentationNode1/Segment_2", "visible": false },
    { "nodeId": "vtkMRMLModelNode3", "color": [0.95, 0.85, 0.70], "opacity": 0.35 },
    { "nodeId": "vtkMRMLModelNode5",
      "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0.012,-0.004,0.000,1] }
  ] }
```

- `changes[]`: each item has `nodeId` and at least one of `visible` (bool), `color` (`[r,g,b]` 0..1),
  `opacity` (0..1), `matrix` (16 floats, column-major, **glTF space**, TRS-decomposable, replaces `T.matrix`;
  section 7.2). A change that makes a node non-TRS-decomposable (or a baked node's transform change) is not a
  `scene.update`: the publisher sends a new snapshot. Semantics: last-writer-wins per property. Unknown `nodeId` → viewer ignores the item (and MAY log).
- `baseVersion` is the version the receiver must currently hold; `sceneVersion` is the new version.
  The relay enforces `baseVersion == session.sceneVersion` and `sceneVersion > baseVersion`, else `error`
  `BAD_SEQUENCE` to the publisher (the publisher then re-syncs by sending a snapshot). A `scene.update` or
  `scene.nodeRemoved` (and `scene.nodeAdded`) received **while a snapshot is in flight** (between `begin` and `end`)
  is always `BAD_SEQUENCE` (`retryable: true`) and ignored (section 6.2); the publisher resends it after `end` with
  `baseVersion` = the snapshot version.
- An update or removal received before the session's first snapshot is `BAD_SEQUENCE`
  (`details.field: "noSnapshot"`), and one that would take the merged state beyond 1,000 node ids is
  `BAD_SEQUENCE` (`details.field: "nodeState"`, section 8.3); both are ignored, not forwarded, and count no
  strike; the publisher re-syncs with a snapshot. `details.field` of `BAD_SEQUENCE` is one of
  `snapshotInFlight`, `noSnapshot`, `baseVersion`, `sceneVersion`, `nodeState`, or, for a chunk (section 6.3),
  `magic`, `length`, `sceneVersion`, `chunkIndex`, `payload`. A viewer whose send buffer an
  update would push over the hard watermark (8 MiB) is closed `4010` before the send; it re-syncs on
  reconnect with `scene.snapshot.ready` and `scene.state`.
- Debounce guidance for the publisher: coalesce MRML events for 100–250 ms; mesh-level events 500–1000 ms
  (slicer.md §3).

### 8.2 `scene.nodeRemoved` and `scene.nodeAdded`

```json
{ "protocolVersion": "1.0", "type": "scene.nodeRemoved", "sceneVersion": 45, "baseVersion": 44,
  "nodeIds": ["vtkMRMLModelNode5"] }
```

Viewers dispose geometry and material of `T`/`M` and drop the id from their UI list.

```json
{ "protocolVersion": "1.0", "type": "scene.nodeAdded", "sceneVersion": 46, "baseVersion": 45,
  "nodes": [ { "nodeId": "vtkMRMLModelNode9", "kind": "model" } ], "snapshotFollows": true }
```

In v1 **adding geometry requires a new full snapshot**: there is no per-node GLB delta format, the GLB is
one buffer, and a partial GLB would need its own container, chunking and node-merge rules on three clients.
`scene.nodeAdded` is therefore only a hint ("a snapshot with these new nodes is coming; show a spinner") and
MUST be followed by `scene.snapshot.begin` with a higher `sceneVersion`. Viewers MAY ignore it. v1.1 may
carry a per-node GLB in `scene.nodeAdded` (see Changelog/roadmap).

### 8.3 `scene.state` (relay → viewer) and `scene.request` (viewer → relay)

The relay merges every accepted `scene.update`/`scene.nodeRemoved` into a per-session map
`nodeId → {visible?, color?, opacity?, matrix?} | removed`, reset at each accepted snapshot. The map holds
visual properties only — never names — so the relay stays free of PHI beyond the opaque GLB bytes.

```json
{ "protocolVersion": "1.0", "type": "scene.state", "sceneVersion": 46, "snapshotVersion": 43,
  "nodes": [
    { "nodeId": "vtkMRMLSegmentationNode1/Segment_2", "visible": false },
    { "nodeId": "vtkMRMLModelNode3", "color": [0.95, 0.85, 0.70], "opacity": 0.35 } ],
  "removed": ["vtkMRMLModelNode5"] }
```

The merged state holds at most 1,000 node ids (section 3.3). Sent (a) **always** right after `viewer.joined` — with `nodes: []`, `removed: []` when nothing accumulated
since the snapshot (and `snapshotVersion: null` while no snapshot exists), so clients have one code path —,
(b) after `scene.snapshot.ready` (also after a `ready` sent to a viewer that was deferred or skipped during
streaming: an empty `scene.state{sceneVersion = snapshotVersion, nodes: [], removed: []}` without `replyTo`
follows), (c) in reply to `scene.request`. A viewer applies it after the GLB of
`snapshotVersion` is loaded and then continues with live messages whose `baseVersion ≥ sceneVersion` of the state.

```json
{ "protocolVersion": "1.0", "type": "scene.request", "id": "v-12",
  "haveSnapshotVersion": 43, "haveSceneVersion": 44, "reason": "GAP" }
```

Viewer-side rule (version monotonicity): keep `sceneVersion`; on an incoming update with
`baseVersion != sceneVersion` (missed message, reconnect, clock of events out of order) do **not** apply it;
send `scene.request`. The relay answers with `scene.snapshot.ready` if `haveSnapshotVersion` differs from its
cached snapshot, then `scene.state`. `haveSnapshotVersion` is the last snapshot version whose bytes the viewer
**verified** (a version whose hash failed is not "had"). `reason` ∈ `GAP | RECONNECT | CHECKSUM_MISMATCH |
USER`. The relay answers at most one `scene.request` per viewer every 5 s and ignores the others without an
error or a strike; a viewer that gets no `scene.state` within 5 s sends its request again (once per gap).

### 8.4 Version rules

- `sceneVersion` is a single per-session `uint32` counter owned by the publisher, strictly increasing across
  snapshots **and** updates, starting at 1 for the first snapshot. The relay tracks the last accepted value and
  `snapshotVersion` (version of the cached GLB). Values are uint32 (section 3.3).
- The relay treats **every version a `scene.snapshot.begin` announced, accepted, refused or aborted** as used:
  a later `begin`, update, removal or addition must be higher (`BAD_SEQUENCE`, `details.field: "sceneVersion"`); a publisher that burned its range (for example by announcing 2^32 − 1) re-syncs with a new `session.create`.
  The first versioned message of a session is a snapshot (updates before it: section 8.1).
- After `session.resume` the publisher continues from `session.resumed.sceneVersion`; after a fallback
  `session.create` it restarts at 1 and MUST send a snapshot.

### 8.5 Reserved for v1.1 (M4)

`scene.camera` (publisher → viewers: camera pose sync), `viewer.command` (viewer → publisher: visibility
toggle, telepointer), `scene.annotation`. The relay forwards unknown-but-reserved types of the same major
version unchanged once v1.1 defines them; in v1.0 they are rejected with `UNSUPPORTED_TYPE`.

## 9. Heartbeat, timeouts, errors, close codes

### 9.1 Heartbeat

```json
{ "protocolVersion": "1.0", "type": "ping", "id": "hb-102", "ts": 1792238445000 }
{ "protocolVersion": "1.0", "type": "pong", "replyTo": "hb-102", "ts": 1792238445031, "serverTs": 1792238445031 }
```

- Clients send `ping` every 15 s; if nothing at all arrives from the relay within 10 s of a `ping` (no `pong`
  and no other text or binary frame, for instance snapshot chunks that are queued ahead of the `pong` on a slow
  link) they close the socket and reconnect with exponential backoff (0.5 s → 30 s, jitter). The relay never
  initiates application `ping`.
- **Publisher uploading a snapshot.** The relay reads the publisher's stream in order, so it answers a `ping`
  only after every byte written before it, and the buffers of the operating system and the network can hold
  several MiB ahead of it. A publisher therefore MAY extend its `pong` deadline for that `ping` to
  `10 s + min(60 s, B / 125,000 B/s)`, where `B` estimates the bytes written **before** the `ping` that the
  relay has not read yet: the bytes written minus what an uplink of 1 Mbit/s = 125,000 B/s (the slowest the
  contract supports) has moved since they were written; any better estimate, such as the socket's unsent byte
  count, is allowed. The 60 s cap equals the relay's own silence bound (two 30 s ticks): a publisher that keeps
  sending is not cut by the relay, so a longer wait would detect nothing the relay does not already handle. An
  idle connection keeps the plain 10 s. A publisher SHOULD keep `B` at or below 4 MiB (≈ 34 s at 1 Mbit/s), so
  that `session.close` (Stop) reaches the relay in about 35 s; its deadline is then at most ≈ 44 s, and one that
  writes further ahead is still bounded by 70 s. To keep `B` small without throttling a fast uplink to 4 MiB per
  15 s, a publisher MAY send an extra `ping` out of cycle (for example after every 4 MiB written). Viewers upload
  no scenes and have no extension.
- The relay sends a WebSocket-level ping every 30 s and terminates sockets that did not pong by the next
  tick (max 60 s of silence), unless since the previous tick the **publisher** sent a complete text or binary
  frame, or the socket's send buffer shrank (the peer is reading; the ping may still be queued behind older
  data); the ping then stays outstanding and a late echo counts. A viewer's frames do not count. A socket
  with no echo, no such frame and no shrinking buffer is closed `4009` at the second tick. Browsers answer WS
  pings automatically (web.md §5). Liveness is thus split by direction: the relay detects dead or silent
  uplinks, a client detects a dead downlink by its own `pong` timeout.
- Publisher disconnect → session enters `grace` (`PUBLISHER_GRACE_S` = 120 s), viewers get
  `session.publisherState{online:false}`; resume within grace restores everything (snapshot cache included);
  otherwise `session.expired{reason:"PUBLISHER_GONE"}`, close `4002`, code released.

### 9.2 `error` message

```json
{ "protocolVersion": "1.0", "type": "error", "replyTo": "v-1", "ts": 1792238405090,
  "code": "SESSION_FULL", "message": "Session has reached its viewer limit", "retryable": true,
  "details": { "viewerLimit": 20, "retryAfterS": 30 } }
```

| `code` | Meaning | `retryable` | Typical close |
|---|---|---|---|
| `INVALID_CODE` | malformed code or no live session with it | false | `4004` |
| `SESSION_NOT_FOUND` | `sessionId`/token refer to no live session (resume/rejoin) | false | socket kept open 10 s for fallback |
| `SESSION_FULL` | viewer limit reached | true | `4005` |
| `SESSION_CLOSED` | message for a session that is closing | false | `4001` |
| `RATE_LIMITED` | join/create attempts exceeded; `details.retryAfterS` = seconds until the ban ends (≤ 600) | true | `4006` |
| `UNSUPPORTED_VERSION` | unknown protocol major | false | `4000` |
| `UNSUPPORTED_TYPE` | unknown message type (same major) | — | none |
| `INVALID_MESSAGE` | JSON/schema validation failed | — | none (3 strikes → `4007`) |
| `PAYLOAD_TOO_LARGE` | snapshot/chunk/text above limits; for `begin`, `details.maxSnapshotBytes` | false | `1009` for frames; none for `begin` |
| `BAD_SEQUENCE` | version/chunk ordering violated; `details.field` names the field (section 8.1) | true | none; snapshot discarded |
| `CHECKSUM_MISMATCH` | SHA-256 mismatch at `scene.snapshot.end` | true | none |
| `UNAUTHORIZED` | wrong token, role not allowed to send this type, binary from viewer | false | `4003` / `1008` |
| `SLOW_CONSUMER` | socket send buffer over its hard limit: viewer `bufferedAmount` over 8 MiB, stuck > 60 s, or evicted under `MAX_TOTAL_BUFFERED_BYTES`; publisher over 1 MiB | true | `4010` |
| `CAPACITY` | relay global budget (sessions/bytes) exhausted | true | `4006` |
| `INTERNAL` | unexpected relay failure | true | `1011` |

`message` is human-readable English for developers (never shown raw to end users; viewers map `code` to
localised UI text). `details`, `message`, logs and metrics MUST NOT contain codes, tokens or scene content; node ids count as scene
content (raw segment IDs may be PHI).

### 9.3 WebSocket close codes

| Code | Sender | Meaning / client reaction |
|---|---|---|
| `1000` | any | normal close (`viewer.leave`, `session.close` acknowledged) |
| `1001` | client | page unload / app background; relay treats like a drop |
| `1008` | relay | policy violation (bad origin, binary from viewer, role violation) — do not retry automatically |
| `1009` | relay | message too big — fix the client; do not retry the same payload |
| `1011` | relay | internal error — retry with backoff |
| `4000` | relay | `UNSUPPORTED_VERSION` — stop, show "update required" |
| `4001` | relay | session closed by publisher — show "presentation ended", offer code entry |
| `4002` | relay | session expired (grace/idle/lifetime) — same UI as `4001` |
| `4003` | relay | unauthorized (token mismatch) — forget token, re-enter code |
| `4004` | relay | invalid code — re-enter code |
| `4005` | relay | session full — retry later (`retryAfterS`) |
| `4006` | relay | rate limited / capacity — back off `retryAfterS` |
| `4007` | relay | protocol violation (repeated `INVALID_MESSAGE`/`BAD_SEQUENCE`) — reconnect, resync |
| `4008` | relay | relay restarting (SIGTERM drain) — reconnect immediately with jitter 0–3 s; publisher uses `session.resume` then falls back to `session.create{preferredCode}` |
| `4009` | relay | heartbeat timeout — reconnect |
| `4010` | relay | slow consumer — reconnect; the viewer gets `scene.snapshot.ready` instead of a stream; a publisher treats it like a drop (backoff, then `session.resume` within `PUBLISHER_GRACE_S`) |
| `4011` | relay | replaced by a newer connection with the same credentials — do not reconnect |
| `4012` | relay | handshake timeout (no session bound within 10 s of the upgrade or of a `SESSION_NOT_FOUND` reply to `session.resume` or to a token `viewer.join`) — reconnect if intended |

## 10. HTTP endpoints

All over HTTPS (Railway edge terminates TLS, relay.md §1.5). **No endpoint accepts a session code or a token
in the path or query string**; credentials travel only in WebSocket message bodies or the `Authorization`
header (edge logs record method + path + host + status + IP + UA, relay.md §1.10).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /` | none | web-viewer SPA (code entry screen) |
| `GET /j` | none | same SPA; the code is in the **fragment** `/j#7KQ4X` (RFC 3986 §3.5: never sent to the server). The viewer reads `location.hash`, validates, then `history.replaceState(null, '', '/j')` (web.md §4). Served with `Cache-Control: no-cache` |
| `GET /assets/*` | none | hashed static assets, `immutable, max-age=30d` |
| `GET /manifest.webmanifest` | none | web app manifest of the viewer build (`application/manifest+json`, `Cache-Control: no-cache`); `404` when the build has none |
| `GET /icons/<name>.png` | none | PNG icons named by `index.html` and the manifest (`image/png`, `no-cache`); only plain names `[A-Za-z0-9][A-Za-z0-9_-]*.png`, anything else `404` |
| `GET /api/scene/:sceneVersion` | `Authorization: Bearer <viewerToken>` | the cached GLB of exactly that version. `200` with `Content-Type: model/gltf-binary`, `Content-Length`, `ETag: "<sha256>"`, `X-Scene-Version`, `Cache-Control: private, no-store`. `401` unknown token, or one the relay no longer remembers (more than `CODE_QUARANTINE_S` after its session ended), `404` if the cached version differs (viewer sends `scene.request`), `410` the token's session was closed or expired, `429` > 30 requests/min per token. Supports `HEAD`. No `Range` in v1 |
| `GET /healthz` | none | `{ "status": "ok", "uptimeS": 1234, "sessions": 3, "version": "0.3.0" }` — no codes, no IPs. Railway deploy healthcheck target |
| `GET /api/version` | none | `protocolVersions` lists the versions the relay speaks (a `1.1` relay accepts every `1.x` client); example: `{ "name": "slicer-remote-view-relay", "version": "0.3.0", "protocolVersions": ["1.0"], "limits": { "maxSnapshotBytes": 67108864, "maxChunkBytes": 1048576, "maxTextBytes": 262144, "maxViewers": 20 } }` |
| `GET /metrics` | `Authorization: Bearer <METRICS_TOKEN>` | Prometheus text format; `404` when `METRICS_TOKEN` is unset (endpoint disabled). Counters only (sessions, viewers, bytes, errors by code) |
| `GET /ws` (Upgrade) | first WS message | section 3 |

Any other path → `404` JSON `{ "error": "NOT_FOUND" }` (no SPA fallback beyond `/` and `/j`, so a leaked
`/7KQ4X` style URL can never work). Security headers (`@fastify/helmet` CSP with `connect-src 'self' wss:`,
`worker-src 'self' blob:`, ADR 0006 §4) are a relay implementation detail. `GET /j?code=X` answers `200` with the
same bytes as `/j` and echoes nothing of the query. This is a convenience for links that messengers decorate, not a
supported entry: the viewer strips the query at once, the relay's request logs and metrics record the path only,
never the query string, and the viewer is served with `Referrer-Policy: no-referrer`; `/ABCDE`, `/j/ABCDE` and `/join?code=X` are `404`.

## 11. Permissions matrix

| Message type | publisher → relay | viewer → relay | relay → publisher | relay → viewer |
|---|---|---|---|---|
| `session.create`, `session.resume`, `session.renew`, `session.close` | yes (first message: create/resume) | — | — | — |
| `session.created`, `session.resumed`, `session.renewed`, `session.expiring` | — | — | yes | — |
| `session.closed`, `session.expired` | — | — | yes (`expired` only) | yes |
| `session.publisherState` | — | — | — | yes |
| `viewer.join`, `viewer.leave`, `scene.request` | — | yes (`join` first message) | — | — |
| `viewer.joined`, `scene.state`, `scene.snapshot.ready` | — | — | — | yes |
| `viewer.count` | — | — | yes | yes |
| `scene.snapshot.begin/end/abort`, binary chunks | yes | — | — | yes (forwarded) |
| `scene.snapshot.ack` | — | — | yes | — |
| `scene.update`, `scene.nodeRemoved`, `scene.nodeAdded` | yes | — | — | yes (forwarded) |
| `ping` | yes | yes | — | — |
| `pong`, `error` | — | — | yes | yes |
| `scene.camera`, `viewer.command` (v1.1) | reserved | reserved | — | — |

A message outside the sender's column → `error` `UNAUTHORIZED` and, for binary frames or a second offence,
close `1008`. The relay never originates scene content; it forwards publisher messages byte-for-byte
(after envelope validation) except that it strips nothing and adds nothing.

## 12. Rate limiting and anti-guessing

- Code space: 31^5 = **28,629,151**. With `S` live sessions, one guess hits with probability `S / 28.6 M`.
  At the per-IP limit of 10 join attempts/min, an attacker from one IP needs on average
  `28.6 M / (S × 10)` minutes: **≈ 20 days for S = 100**, ≈ 200 days for S = 10; the chance of any hit within
  an hour at S = 100 is 0.21 %. Entropy is therefore not the wall — rate limits, lockouts and short code
  lifetimes are (relay.md §4). Codes are released immediately on close/expiry, and idle sessions without
  viewers expire after `SESSION_TTL_S`, keeping `S` small.
- Per IP — the client address as determined by the relay's trusted-proxy configuration, i.e. the address the
  edge appended to `X-Forwarded-For` (`[TODO verify]` the number of proxy hops and the header on the first
  deploy, DEP-06); "IP" is an IPv4 address or an IPv6 /64, an IPv4-mapped IPv6 address counts as its IPv4
  address: WebSocket upgrades 30/min (upgrades refused for their `Origin` or subprotocol do not count); `viewer.join` with a `code` **10/min**, counted inside the
  socket handler as well as at the HTTP layer; after **20 failed joins within 10 min** the IP is banned for
  **10 min** (`RATE_LIMITED`, `details.retryAfterS` = seconds left of the ban, 600 at its start); `session.create` 5/min;
  a well-formed `session.create{preferredCode}` counts as a failed join (not as a join attempt) because
  whether the code is granted reveals whether it is free, and it is ignored (a fresh code is drawn) while the
  address is banned; `GET /api/scene` 30/min
  per token. Rejoins with a valid `viewerToken` do not count. Every failed `viewer.join` closes its socket
  (`4004`–`4006`, section 5.2) — there is no per-socket retry allowance, except that a token `viewer.join` answered `SESSION_NOT_FOUND` keeps its socket for a code `viewer.join` (section 13 step 9); the limits above are per IP only.
- Global alarm: > 1,000 failed joins/hour across all IPs → `warn` log event (counts only), per-IP join limit
  tightened to 3/min for one hour, `/metrics` counter `join_failures_total` for operators.
- Responses to failed joins are uniform (`INVALID_CODE`, same timing ± jitter) so they do not reveal which
  codes are live. Input normalisation: uppercase, strip whitespace, reject anything outside the alphabet
  before any lookup.

## 13. Complete sequence walkthrough

1. Slicer: user clicks **Start session** (explicit opt-in). Plugin connects `wss://relay/ws`, sends
   `session.create{profile:"mobile"}` → `session.created{code:"7KQ4X", publisherToken, …}`. UI shows the code
   and a QR of `https://relay/j#7KQ4X`.
2. Plugin exports the scene (decimation to the `mobile` budget, GLB writer), sends `scene.snapshot.begin
   {sceneVersion:1, byteLength:18874368, chunkCount:18, sha256}`, 18 binary chunks, `scene.snapshot.end`.
   Relay verifies the hash, caches the buffer, replies `scene.snapshot.ack`. No viewers yet; idle timer runs.
3. Phone A scans the QR → `GET /j` (fragment stays local) → SPA reads `#7KQ4X`, cleans the URL, opens the
   WebSocket, sends `viewer.join{code:"7KQ4X"}` → `viewer.joined{sceneVersion:1, snapshotVersion:1,
   snapshotAvailable:true, viewerToken}` + empty `scene.state{sceneVersion:1, snapshotVersion:1, nodes:[],
   removed:[]}`; relay sends `viewer.count{1}` to Slicer and A.
4. A fetches `GET /api/scene/1` with the Bearer token, verifies SHA-256, parses the GLB, builds its node list
   from `extras`, renders. Elapsed since scan: a few seconds on Wi-Fi.
5. Lecturer hides the liver: Slicer `scene.update{sceneVersion:2, baseVersion:1, changes:[{nodeId:
   "vtkMRMLSegmentationNode1/Segment_2", visible:false}]}` → relay checks versions, merges into state,
   forwards to A; A applies (its version becomes 2).
6. Phone B types the code → `viewer.join` → `viewer.joined{sceneVersion:2, snapshotVersion:1}` followed by
   `scene.state{sceneVersion:2, nodes:[{… visible:false}]}`; B fetches `/api/scene/1`, applies the state, now
   equals A. `viewer.count{2}` to all.
7. Lecturer loads a new model: plugin sends `scene.nodeAdded{sceneVersion:3, baseVersion:2, snapshotFollows:true}`
   then `scene.snapshot.begin{sceneVersion:4, …}` + chunks + `end`. A has `bufferedAmount` ≈ 0 → streamed;
   B is on slow 4G with 5 MiB buffered (over the 4 MiB soft watermark) → deferred, gets
   `scene.snapshot.ready{sceneVersion:4}` and an empty `scene.state{sceneVersion:4, snapshotVersion:4}` after `end`
   and fetches over HTTP. A visibility change made in
   Slicer during the upload is queued by the plugin and sent after `end` as `scene.update{sceneVersion:5,
   baseVersion:4}`. Both viewers end at version 5; relay state holds that one change.
8. B's Safari goes to the background; the relay's WS ping gets no pong, B is removed, `viewer.count{1}`.
   B returns, `visibilitychange` triggers reconnect with `viewer.join{sessionId, viewerToken}` (no rate-limit
   cost), gets `viewer.joined{sceneVersion:5, snapshotVersion:4}` and the `scene.state` that always follows;
   its cached GLB version matches, so it only applies the state and continues.
9. Operator redeploys the relay. The new instance passes `/healthz`; the old one receives SIGTERM and, within
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, sends close `4008` to every socket (no `session.*` message —
   sessions cannot survive a redeploy, relay.md §1.8). Slicer reconnects after 0–3 s and sends
   `session.resume{sessionId, publisherToken}` → `error SESSION_NOT_FOUND` → falls back to
   `session.create{preferredCode:"7KQ4X"}` → granted (registry empty) → re-sends the snapshot as version 1.
   Viewers reconnect with `viewer.join{sessionId, viewerToken}` → `error SESSION_NOT_FOUND` → they fall back
   to `viewer.join{code:"7KQ4X"}` with the code they still hold → `viewer.joined{sceneVersion:0,
   snapshotAvailable:false, publisherOnline:true}` + empty `scene.state{snapshotVersion:null}` and wait for
   the stream. Total disruption: seconds; the code on the lecture screen never changed.
10. Lecturer's laptop loses Wi-Fi for 40 s: relay marks the publisher offline, viewers get
    `session.publisherState{online:false, graceEndsAt}` and keep the frozen scene; Slicer reconnects within
    grace with `session.resume` → `session.resumed{sceneVersion:5, snapshotVersion:4}` → no re-upload
    needed; viewers get `session.publisherState{online:true}`.
11. Lecture ends: Slicer `session.close{reason:"USER_STOPPED"}` → viewers receive `session.closed` and close
    `4001`, show "presentation ended". Relay frees the buffer and the code.

## 14. Compatibility and changelog

### Compatibility rules

- A client MUST accept and ignore unknown fields in every message and ignore a message of an unknown type (only
  the relay answers `UNSUPPORTED_TYPE`, section 2); MUST tolerate unknown enum values in
  `reason`/`platform` fields (treat as `other`).
- A relay running `1.x` accepts clients `1.0 … 1.x`; a client `1.y` with `y > x` connects but MUST NOT rely on
  fields the relay does not emit (check `GET /api/version` first if a feature matters).
- JSON Schema for every message lives in `shared/schema/` (draft 2020-12 restricted to a draft-07-compatible
  subset: `definitions` instead of `$defs`, no `unevaluatedProperties`); TS/Python/C# types are generated from it and vendored as described
  in ADR-0007. The schema is normative where this prose is ambiguous; this document is normative for
  behaviour (sequencing, limits, timeouts).
- Limits in section 3.3 are protocol maximums; a relay MAY run with lower configured values and announces
  the effective ones in `session.created.limits` and `GET /api/version`.

### Changelog

| Version | Date | Changes |
|---|---|---|
| `1.0` | 2026-10-17 | Initial contract: session lifecycle with resume token, viewer join by code or token, chunked GLB snapshot with 12-byte chunk header and SHA-256, HTTP cached-scene endpoint, incremental `scene.update`/`scene.nodeRemoved`, relay-merged `scene.state`, heartbeat, error model, close codes `4000–4012`, permissions matrix, rate limits. Reserved: `scene.camera`, `viewer.command` (v1.1 / M4), Draco (`KHR_draco_mesh_compression`) and per-node GLB in `scene.nodeAdded` (v1.1 candidates). |
| `1.0` | 2026-10-17 | Review fixes before any implementation: chunk limit 1024 (`chunkSize` 64 KiB–1 MiB), in-flight update rule (`BAD_SEQUENCE`, publisher queues until `end`), `scene.state` always sent after `viewer.joined`, slow-consumer watermarks 4/8 MiB, per-node triangle cap 100 k, `UNAUTHORIZED` on resume closes `4003` immediately. |
| `1.0` | 2026-10-21 | Documentation only, no wire change: §10 lists the two static paths of the viewer build that the relay serves (`/manifest.webmanifest`, `/icons/<name>.png`, SRV-26, report 2026-10-21-web). |
| `1.1` | 2026-10-27 | Revision decided by the project owner (`docs/research/protocol-v1.1-decisions.md`); **no new message type, field or error code; two schema bounds change** (`begin.byteLength` has no 64 MiB maximum, versions are uint32 — the latter unreachable on the wire); a `1.0` peer interoperates. Added: segment `nodeId` aliases `<segmentationNodeID>/s_<n>` for IDs outside the grammar and for all segments when names are anonymised (7.3); TRS-only `T.matrix` / `scene.update.matrix`, `baked` covers shear and degenerate scales (7.2, 7.3, 8.1); `begin.byteLength` has no 64 MiB schema maximum (bounded by 2^53 − 1), `PAYLOAD_TOO_LARGE` for oversize (6.2); uint32 bound on versions (3.3); publisher `pong` deadline extension while uploading and liveness by publisher frames (9.1); neutral per-IP wording (12). Clarified to match the relay and plugin: handshake gate and no subprotocol (3.1), `4012` (9.3), `preferredCode` and quarantine (4.1, 4.5), `begin` vs root extras (6.2), partial stream vs `ready` (6.4), no streamed copy on request (6.5), publisher `SLOW_CONSUMER`/`4010`, state cap, `BAD_SEQUENCE` fields (3.3, 8.1, 9.2), `scene.request` throttle and empty `scene.state` (8.3), uint-version bookkeeping (8.4), `401`/`410` and `/j?code=` (10), rate-limit details (12), UNSUPPORTED_TYPE for the relay only (2). |
