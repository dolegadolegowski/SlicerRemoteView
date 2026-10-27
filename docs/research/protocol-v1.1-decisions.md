# Protocol v1.1 — decision memo (options and defaults)

- **Status**: **decided 2026-10-27 — the owner chose every recommended default** (see "Outcome" at the end). The
  options below stay as the record of what was considered. Written as a proposal; the text of the memo itself is
  unchanged except for this status and the Outcome section.
- **Written**: 2026-10-27 by the `protocol` workstream (`ws/protocol`, on `main` b8ab99b), after reading every report in
  `docs/testing/reports/` that names `protocol` under *Affects* (23 reports) and the current `docs/protocol.md` v1.0,
  `shared/schema/`, the relay (`relay-server/`), the Slicer plugin (`slicer-plugin/RemoteView/remoteview_core/`) and
  the web viewer as they are on `main`.
- **Scope**: the six open questions named by the owner (D1–D6), then a triage of the other open reports
  (Appendix A). All reports still read `Status: open`; none has been triaged into `docs/plan/protocol.md` yet.

## How a change is classified (protocol §2, §14)

- **Clarification of v1.0** — the wire stays as it is, the text catches up with what the components already do. No
  version change needed (a `docs(protocol)` commit; the schemas are the normative source where the prose is ambiguous).
- **Additive 1.1** — optional fields, new rules a 1.0 peer never sees, looser limits. A 1.0 client keeps working
  (§14: unknown fields and enum values are tolerated). Bumps `PROTOCOL_VERSION` to `"1.1"` (regex `^1\.\d+$` already
  accepts it).
- **Breaking (2.0)** — nothing below needs it, and no option below is recommended that would.

Every protocol change also needs schemas + fixtures + the three generated type sets regenerated
(`npm run generate -w shared`, PRO-11/PRO-17), and `[protocol change: v1.1]` marks in the component plans (done by
`release`, since plans of other components are not ours to edit).

---

## D1. Segment IDs outside the `nodeId` grammar

**Report**: `2026-10-19-slicer-3` (medium). **Plan hooks**: slicer SLC-07/SLC-27 (skip such segments today).

**Problem.** §3.3 restricts `nodeId` to `[A-Za-z0-9_./:-]{1,128}` and §7.3 defines a segment's `nodeId` as exactly
`<segmentationNodeID>/<segmentID>`. Slicer keeps caller-supplied segment IDs verbatim (`"left lung"`, `"Läsion"`,
`"Tumor(1)"`, 110+ characters from importers or scripts), so those segments cannot be exported: the writer correctly
refuses the whole snapshot, and the stop-gap is to skip the segment and tell the user. A presenter silently loses a
structure of the scene.

| Option | Description | protocol / schemas / fixtures | relay | plugin | web / quest |
|---|---|---|---|---|---|
| **A (recommended)** — alias only when needed | If `<segmentID>` is outside the §3.3 set, or the resulting `nodeId` would exceed 128 characters, the publisher uses a per-session alias `<segmentationNodeID>/s_<n>` (n from a counter, skipping any value that equals a real segment ID of that segmentation). `extras.segmentId` carries the raw ID (omitted when names are hidden, see D2). Aliases are stable for the scene's lifetime (§7.3 already requires only that). | §7.3 text + a sentence in §3.3; **no schema change** (the pattern is untouched, the GLB extras are not schema-validated); optional fixture: a GLB with one aliased segment. Additive 1.1 (a 1.0 viewer already treats `nodeId` as opaque). | none — `nodeId` is opaque, only the pattern is checked | relax `nodeId == mrmlId/segmentId` in `glb_writer._validate_identity`; keep a per-session `raw ID → alias` map next to `SentScene` so SLC-30 updates reuse it; remove the skip-and-report path | none (they only look up `extras.nodeId`; the UI shows `name`) |
| B — widen the grammar | `nodeId` becomes any string without control characters, ≤ 128 UTF-16 units. | `defs.nodeId.pattern` replaced, fixtures `invalid-nodeId-*` change, README/§3.3 limits row; **tightening→loosening of a schema pattern**: a deployed 1.0 relay or viewer with the old schema would reject the new IDs, so it only works with a lock-step deploy | schema-driven; log hygiene review (IDs may now hold names → PHI in `details`/logs; relay must never log them) | no alias bookkeeping, but name-derived IDs leave Slicer (conflicts with D2) | UI code that builds DOM ids/URLs from `nodeId` needs escaping review |
| C — keep skipping | No protocol change; the plugin keeps skipping and reporting such segments. | none | none | already the behaviour | none |

**Consequence of C**: the scene on the headset differs from the one in Slicer without any error on the viewer side —
the same class of problem the project treats seriously for handedness (§7). **Consequence of B**: breaks the PHI
posture of D2 unless D2 is solved separately by an alias anyway.

**Recommended default: A**, together with D2 in one `docs(protocol)` commit (§7.3 + §3.3), version label 1.1.

---

## D2. "Hide node names" leaks name-derived segment IDs

**Report**: `2026-10-18-slicer-3` (medium after the branch audit). **Plan hooks**: slicer SLC-27 gate.

**Problem.** With *Hide node names* the root gets `anonymizedNames: true` and every `extras.name` becomes
`Model <n>`/`Segment <n>` (§7.3, threat model T7), but `nodeId` and `extras.segmentId` still carry the segment ID
verbatim. Current Slicer generates random IDs (`S_` + 16 alphanumerics), yet scenes from older Slicer versions, DICOM
SEG imports and scripts can set an ID from a patient- or finding-derived name. The writer's own check
(`_ANONYMOUS_NAME`) cannot see it, and the promise `anonymizedNames: true` is then false.

| Option | Description | consequences |
|---|---|---|
| **A (recommended)** — alias whenever names are hidden | In anonymised mode the publisher always uses `<segmentationNodeID>/s_<n>` for segments and omits `extras.segmentId`. Models keep their MRML ID (generated, `vtkMRMLModelNode12`). Also require, in §7.3: when `anonymizedNames: true`, no string derived from a display name appears in the GLB or in any message. | Same wording and mechanism as D1-A (one alias function, one map). Protocol: §7.3 sentence; no schema change; the anonymised fixture (`asymmetric-2nodes.glb` is not anonymised) may gain a sibling. Relay/web/quest: none. Plugin: the alias is chosen when `anonymized_names` or the ID does not fit; writer validation extended to reject a verbatim segment ID under `anonymizedNames`. Cost: `scene.update` logs are less readable in anonymised mode (intended). |
| B — alias for **every** segment, always | One rule instead of two; `Segment_2` in all documents becomes `s_1`. | Simplest to test, but every example in §7.3/§8/§13, six fixtures and the web debugging habits change; stable IDs across *sessions* are not promised anyway. Not worth the churn. |
| C — document the residual risk | Say in T7 that a name-derived segment ID can leave Slicer; recommend Slicer-generated IDs. | No code change, but `anonymizedNames: true` stays a promise the publisher cannot keep → rejected for a medical product. |

**Recommended default: A.**

---

## D3. Sheared linear transforms cannot be a glTF `node.matrix`

**Report**: `2026-10-18-slicer-4` (medium, updated 2026-10-21 after SLC-13).

**Problem.** glTF requires `node.matrix` to be decomposable into translation, rotation and scale; three.js and Unity
transforms are TRS, so a shear (common after affine registration) would be dropped silently by viewers, showing a
wrong pose without an error. **The plugin already handles this**: from SLC-13 the publisher bakes every world matrix
the writer refuses (shear, zero scale, float32 overflow) into the vertices with `baked: true` and an identity
`T.matrix`, and the SLC-30 classifier answers a later change that makes a node non-TRS with a re-export (snapshot)
instead of a `scene.update.matrix`. What is missing is the contract text.

| Option | Description | consequences |
|---|---|---|
| **A (recommended)** — doc-only clarification (v1.0 errata) | §7.2/§7.3: `T.matrix` and `scene.update.matrix` MUST be TRS-decomposable (affine, no shear, no zero or non-finite scale); otherwise the publisher bakes and sets `baked: true`, as for non-linear transforms; `baked` is redefined as "the world transform was applied to the vertices (non-linear, sheared or otherwise not representable as TRS)". §8.1: a change that makes a node non-TRS is sent as a new snapshot. State the decomposability tolerance (relative 1e-6 on column orthogonality) so publisher and viewers agree. | No schema change (JSON Schema cannot express decomposability; the relay cannot check it cheaply and should not try). No relay/web/quest code change. Plugin already conforms. ADR 0005 errata and `architecture.md` §6.4 need the same sentence (`release`, rule 4). |
| B — viewers decode a general 4×4 | Allow sheared matrices; viewers apply the matrix directly. | Not possible in glTFast/three.js `GLTFLoader` without custom node handling; a different behaviour per viewer. Rejected. |
| C — viewers detect shear and refuse the scene | Add a viewer pre-validation (`NODE_MATRIX_NON_TRS` like the glTF validator). | Defence in depth, cheap (web and quest snapshot receivers, WEB-05 / QST-05 area): worth adding **in addition** to A as a viewer requirement, not instead of it. |

**Recommended default: A**, plus a one-line viewer requirement from C ("a node whose `matrix` is not TRS-decomposable
is a malformed snapshot"). No version bump needed.

---

## D4. `byteLength` above 64 MiB: which error?

**Report**: `2026-10-20-server-2` (low) and the `sceneVersion` upper-bound note in it.

**Problem.** §6.2 and §9.2 say the relay answers `scene.snapshot.begin{byteLength > MAX_SNAPSHOT_BYTES}` with
`PAYLOAD_TOO_LARGE`. The shared `byteLength` definition has `"maximum": 67108864`, so a strict receiver answers
`INVALID_MESSAGE` (a protocol-violation strike towards `4007`) for anything above the protocol maximum; only values
between a lower configured `MAX_SNAPSHOT_BYTES` and 64 MiB reach `PAYLOAD_TOO_LARGE`. The relay today clamps the value
before validation to follow §6.2 (SRV-09). The consequence for the user is real: `PAYLOAD_TOO_LARGE{maxSnapshotBytes}`
tells the Slicer panel "the scene is too large, reduce the profile", while `INVALID_MESSAGE` looks like a bug and
earns a strike.

| Option | Description | protocol / schemas / fixtures | relay | plugin / web / quest |
|---|---|---|---|---|
| **A (recommended)** — no `maximum` on `begin.byteLength` | A new def (e.g. `announcedByteLength`, integer ≥ 1, **no maximum**) used only by `scene.snapshot.begin`; `byteLength` (with the 64 MiB maximum) stays for `ready` and `viewer.joined.snapshot`, where a larger value would be a relay bug. §6.2 keeps its text. | `defs` + `begin` schema; fixture `invalid-byteLength-over.json` becomes a **valid** shape fixture (`valid-byteLength-over-limit.json`, rejected by relay rule, not by schema); `expected.json` and the three conformance runs follow; generated types unchanged in shape. Clarification of v1.0 (a looser schema; strict 1.0 relays that clamp keep working). | may drop its clamp hack; answers `PAYLOAD_TOO_LARGE` straight from the rule | plugin: show "scene too large" on this error; web/quest: not senders |
| B — keep the schema, change the text | §6.2: above the protocol maximum the answer is `INVALID_MESSAGE`; `PAYLOAD_TOO_LARGE` only between a configured limit and 64 MiB. | prose only; SRV-09 acceptance criterion (67,108,865 B → `PAYLOAD_TOO_LARGE`) must change | removes the clamp; strike for oversize | the panel cannot tell "too big" from "bug" above 64 MiB |
| C — status quo | Relay special-cases it. | none | keeps the clamp | other receivers (fake-slicer stub, future relays) answer differently from the relay → rejected |

**Bundle with it (recommended)**: add `"maximum": 4294967295` to `sceneVersion` and `snapshotVersion` (§6.3 carries the
version as uint32 in the chunk header, §8.4 says uint32; a `begin` with 2^32 passes the schema today but no chunk can
name it). That tightens an unreachable range; fixtures: one invalid fixture per def. **Recommended default: A + the
uint32 bound**, labelled as 1.0 clarification.

---

## D5. TLS-inspecting proxies and Slicer's end-of-life OpenSSL (threat model T5)

**Report**: `2026-10-20-slicer-1` (medium; *Affects* `release`/`architect`, protocol only through §3.1).

**Problem.** T5 lists Railway's edge as the party that reads the WebSocket. On Windows CPython trusts the Windows root
store, so a hospital's TLS-inspecting proxy (Zscaler, Fortinet, …) verifies and can read the scene, the session code and
the `publisherToken`; on macOS/Linux only `Slicer.crt` is trusted, so the same network fails verification until the
user adds the institution's CA (`extra_ca_file`, SLC-08/SLC-09). Slicer 5.12.4 also bundles OpenSSL 1.1.1 (end of life).
None of this is expressible in the wire protocol; it is a risk statement and a deployment instruction.

| Option | Description | consequences |
|---|---|---|
| **A (recommended)** — no protocol change; route to `release` | `architecture.md` §8 T5 *Residual risk* gets the two sentences proposed in the report; the user guide tells institutions to exempt the relay host from inspection; `docs/research/slicer.md` gets the per-OS trust fix (`release`/`architect`). Protocol §3.1 stays "WSS only". | Zero effect on schemas, fixtures, relay, web, quest. The report stays open for `release`; protocol marks it "no protocol impact". |
| B — normative security note in §3.1 | Add: "clients MUST verify the relay certificate against the platform trust store and MUST NOT offer to disable verification; an institution's TLS-inspecting proxy that is trusted by the client can read the session". | Documents behaviour all clients already implement; no wire change; makes the "no disable-verification" control testable for web/quest/slicer. Small, low risk, but duplicates T5. |
| C — end-to-end encryption of the payload | Encrypt GLB chunks with a key carried only in the join link's fragment. | Protects against Railway **and** inspecting proxies, but a 5-character typed code carries no key, so the typed-code join flow (FR-35) cannot work; a large new protocol (2.0-class). Out of scope; recorded as a possible future ADR. |

**Recommended default: A** (B only if the owner wants the security note in the contract).

---

## D6. Railway `X-Forwarded-For` hop count (`TRUST_PROXY`)

**Report**: `2026-10-18-server-1` (medium; *Affects* `deploy`/`release`, protocol only through the §12 wording).

**Problem.** Per-IP limits (§12, ADR 0008) key on the client address. The relay implements `TRUST_PROXY=true` as
"trust exactly one hop" (the last `X-Forwarded-For` entry); Railway documents neither whether it adds one hop nor
whether there is an inner proxy. With two hops every user would share one rate-limit bucket (one bad actor bans
everybody); with zero hops a client could forge its address. This is a **measurement on the first deploy (DEP-06)**,
not a design choice. §12 also names "Fastify `trustProxy`", which couples the contract to a library.

| Option | Description | consequences |
|---|---|---|
| **A (recommended)** — neutral wording now, decide after DEP-06 | §12: "client address as determined by the relay's trusted-proxy configuration (the address the edge appended)"; keep the `[TODO verify]` until DEP-06 writes the result into `docs/deploy.md`. If the measurement shows more than one hop, the **server** workstream replaces the boolean with a hop-count/trusted-list function (plan note in `docs/plan/server.md` SRV-02). | Protocol: one wording change, no schema/fixture. Relay: nothing until DEP-06. Needs the owner to run the deploy checklist (forged-header curl, step in the report). |
| B — decide the hop count now | Pick 1 and document it. | Guessing; a wrong number silently disables the limits or merges all users. Rejected until measured. |
| C — ignore `X-Forwarded-For`, use the socket address | Simple and unforgeable. | Behind Railway's edge every client has the edge address → limits useless (and one ban locks everybody out). Rejected. |

**Recommended default: A.** The one-line action for the owner is to run DEP-06 (or tell us when it is scheduled).

---

## Proposed packaging

| Commit (after the owner's answers) | Contents | Version |
|---|---|---|
| `docs(protocol): segment aliases and anonymised ids (D1, D2)` | §7.3, §3.3; plan marks; optional GLB fixture with an aliased segment | **1.1** (additive rule) |
| `docs(protocol): TRS-only matrices, baked meaning (D3)` | §7.2, §7.3, §8.1 | 1.0 errata |
| `docs(protocol): begin.byteLength has no schema maximum; uint32 versions (D4)` | §6.2 note, `defs`/`begin` schema, fixtures, `expected.json`, regenerate | 1.0 errata |
| `docs(protocol): neutral wording of the per-IP limit (D6)` | §12 | 1.0 errata |
| D5 | `release` only (A) | — |

If the owner prefers a single label, the whole set can ship as **1.1** (nothing in it breaks a 1.0 client); the cost of
labelling the errata as 1.1 too is only a version bump of `PROTOCOL_VERSION` and the examples (`"protocolVersion":
"1.0"` stays valid for clients, §2).

---

## Appendix A — other open reports addressed to `protocol` (triage)

None needs a decision from the owner except where marked **decide**. "Wording" = clarification of v1.0 to match the
relay/plugin behaviour (no wire change), batchable into one `docs(protocol): v1.0 wording sync` commit.

| Report | Topic | Proposal |
|---|---|---|
| 2026-10-18-server-5 | §9.3 `4012` wording (no session bound in 10 s, also after `SESSION_NOT_FOUND`) | wording |
| 2026-10-18-server-6 | `parseEnvelope` issues can echo sender-chosen keys in `instancePath`; pre-handshake rule "only handshake messages and `ping`" (§3.1) | `shared/ts` change in `toIssues` (replace segments under `additionalProperties` by `*`) + §3.1 sentence — protocol task, low risk |
| 2026-10-18-server-7 | `session.publisherState` has no `sessionId` (T11 wording); answer for a just-ended code | **decide**: add optional `sessionId` (additive, 1.1) or narrow T11 (release) — default: narrow T11, no field |
| 2026-10-19-server-1 | §4.1/§4.5 quarantine wording; export `parseEnvelopeValue(value)` from `shared`; §3.1 "clients offer no subprotocol, relay answers 400" | wording + small `shared/ts` addition (additive API) |
| 2026-10-19-slicer-2 | §2 "MUST reply `UNSUPPORTED_TYPE`" should say the relay replies, clients ignore | wording |
| 2026-10-19-slicer-4 | `begin.sceneVersion`/`profile` must equal the GLB root extras; `nodeCount`/`triangleCount` definitions | wording + regenerate two fixtures |
| 2026-10-19-slicer-5 | "name ≤ 64 chars" → "≤ 64 UTF-16 code units" (also `shared/ts/constants.ts`) | wording |
| 2026-10-20-server-1 | §12: `retryAfterS` = time left; per-IP = IPv4 or IPv6 /64; `preferredCode` counts as a failed join | wording |
| 2026-10-20-server-3 | receiver rule: `scene.snapshot.ready` for the version being assembled = discard the partial buffer, fetch over HTTP | wording (§6.4 a) + receiver tests in web/quest |
| 2026-10-20-server-4 | §10 `401` vs `410` wording after `CODE_QUARANTINE_S`; a cut download is a failed one | wording |
| 2026-10-20-server-5 | `SLOW_CONSUMER`/`4010` can reach a publisher (1 MiB buffer); publisher reconnects and resumes; §9.1 "no other sign of life" | wording |
| 2026-10-20-server-6 | clients count any inbound frame as liveness for the 10 s `pong` timeout (§9.1) | wording; web/quest implement |
| 2026-10-20-server-7 | §10 security headers pointer; `/j?code=` answers 200 | wording (§10) + `release` |
| 2026-10-26-server-1 | update rules the contract does not state: 1,000-node state cap (`BAD_SEQUENCE{field:"nodeState"}`), `nodeAdded` refused during a snapshot, version monotonicity after resume, no update before the first snapshot, hard watermark applies before an update | wording into §8.1–§8.4, §9.2; **decide** the 1,000-node cap as normative (default: yes, it is the architecture §5 bound) |
| 2026-10-27-server-1 | `scene.request` answered at most once per 5 s without error; empty `scene.state` after `ready`; `haveSnapshotVersion` = last verified; drop the "streamed copy" sentence in §6.5 | wording; web/quest re-send after 5 s |
| 2026-10-27-server-2 | §9.1: relay WS-ping liveness also counts publisher frames and a draining send buffer; FR-21 is tagged non-negotiable | **decide** (release/owner): accept (default, the relay already behaves so) or revert to SRV-14's rule |
| 2026-10-20-slicer-6 | the 10 s `pong` deadline cuts a live upload on a slow uplink; Stop during a slow upload leaves the session in grace | **decide**: allow publishers to extend the deadline by the time their unsent backlog needs at the slowest supported uplink (default; idle bound stays 10 s), amend §9.1/NFR-21/ADR 0009 |
| 2026-10-18-slicer-2 | `shared/py` imports `jsonschema` unconditionally; no `.gitattributes`; bandit rules | protocol task in `shared/py` (lazy imports, `.gitattributes`) — no contract change |

---

## Questions for the user

Answer with one word each (a letter, `yes`/`no`, or a version). Defaults in bold; "default" means "go with the
recommendation".

1. **D1 segment IDs outside the grammar**: A (alias only when needed) / B (widen grammar) / C (keep skipping)? Default: **A**.
2. **D2 hidden names**: always alias segments in anonymised mode — **yes** / no?
3. **D3 shear**: record it as v1.0 errata (TRS-only, wider `baked`) — **yes** / no?
4. **D4 byteLength > 64 MiB**: A (no schema maximum on `begin`) / B (error becomes `INVALID_MESSAGE`) / C (status quo)? Default: **A**.
5. **D4 uint32 bound** on `sceneVersion`/`snapshotVersion` — **yes** / no?
6. **D5 TLS inspection**: A (forward to `release`, no protocol text) / B (add a §3.1 note)? Default: **A**.
7. **D6 hop count**: A (neutral wording, wait for the Railway measurement) — **yes** / no? And is the first deploy (DEP-06) scheduled: yes / no?
8. **Version label** for D1+D2 (additive rule): **1.1** / 1.0.1? (D3, D4, D6 stay errata either way.)
9. **Appendix A wording batch**: approve one `docs(protocol): v1.0 wording sync` commit for all "wording" rows — **yes** / no?
10. **Appendix A, `session.publisherState.sessionId`**: add the field (1.1) / **narrow T11 instead**?
11. **Appendix A, FR-21 heartbeat** (publisher frames count as life): **accept** / reject?
12. **Appendix A, publisher `pong` deadline on slow uplinks**: **extend** / keep 10 s?

---

## Outcome (2026-10-27)

All twelve questions were answered with the default. Implementation:

| Decision | Where |
|---|---|
| D1, D2 (alias A; always alias when names are hidden), D3 (TRS-only erratum), D4 text (no `begin` maximum), D6 (neutral wording), versions as uint32, version label 1.1, Annex A wording batch, T11 narrowed (no `sessionId`), FR-21 accepted, publisher `pong` deadline extended | `docs/protocol.md` v1.1, task **PRO-20** (docs only) |
| D4 schema + uint32 bound | **PRO-21** |
| `PROTOCOL_VERSION = "1.1"` | **PRO-22** |
| Alias fixture | **PRO-23** |
| `toIssues` masking, `parseEnvelopeValue`, Python lazy imports | **PRO-24** (`todo`) |
| D5 (T5) | no protocol text; `release` (report `2026-10-27-protocol-4`) |
| Work for the other components | reports `2026-10-27-protocol-1` (server), `-2` (slicer), `-3` (web, quest), `-4` (release); the originating reports of Annex A read `triaged` |

The publisher `pong` rule decided in PRO-20: deadline `10 s + min(60 s, B / 125,000 B/s)`, hence at most 70 s —
two relay ticks, beyond which a longer deadline would detect nothing — plus "do not write more than 4 MiB ahead of
the last answered `ping`" so that Stop reaches the relay within about 35 s at 1 Mbit/s.
