# ADR 0004: MVP scope — one Slicer publisher, up to 20 read-only viewers per session, local camera

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `protocol`, `server`, `web`, `quest`, `slicer`
- **Related:** `docs/requirements.md` (FR/NFR on viewers, latency; out-of-scope list), `docs/architecture.md`
  (session model, limits, threat model), `docs/protocol.md` (roles and permissions), `docs/plan/00-overview.md`
  (milestones M1–M4), ADR 0001 (transport), ADR 0008 (codes and tokens)

## Context

`prompts/00-goal.md` requires "one Slicer → many viewers at once (state the limit and justify it)" and proposes
an MVP of one publisher, read-only viewers and locally controlled cameras, with camera/pointer synchronisation
and device-to-Slicer interactions in later milestones. Personas (`docs/requirements.md`): a clinician presenting
a case, a lecturer running a lab session, students on phones or headsets.

Facts bearing on the viewer limit (`docs/research/relay.md`, `web.md`, `quest.md`):

- The relay fans out every snapshot to every viewer: egress = snapshot bytes × viewers. Railway egress is
  **$0.05/GB**; Hobby includes $5 usage per month, Pro $20.
- `ws` can pass one shared `Buffer` to N `send()` calls without copying the payload, but each slow socket can
  hold up to a whole snapshot in `bufferedAmount` (user-space) — memory grows with viewers × snapshot size.
  Railway bills RAM at $10/GB-month and autoscales vertically up to the plan cap, so a leak costs money first.
- Railway offers no sticky sessions and random load balancing → one replica (ADR 0007); the whole relay is one
  Node process, so fan-out CPU and buffers are per process.
- Railway edge: ~10,000 concurrent connections per domain; WebSockets have no edge timeout. Edge egress
  bandwidth per service is not documented `[TODO verify]`.
- Research example limits: `MAX_VIEWERS_PER_SESSION` 10, `MAX_SNAPSHOT_BYTES` 64 MiB, `MAX_SESSIONS` 200
  (`relay.md` §3). Mobile memory budget: < 1 GB per page on iPhone (`web.md` §2).

## Decision

1. **M1 scope:** exactly **one publisher** (a Slicer instance) per session; **up to 20 concurrent viewers**
   per session (`MAX_VIEWERS_PER_SESSION = 20`, configurable by environment variable, enforced by the relay with
   a protocol error `session_full`); viewers are **read-only** (join, heartbeat, request current scene); every
   viewer controls its **own camera**; the publisher owns visibility/colour/opacity/transform state.
2. **Why 20:** (a) *classroom size* — a lab group (15–20 students plus the lecturer) must fit in one session,
   each on their own phone or headset; (b) *fan-out bandwidth* — a 30 MB snapshot to 20 viewers is 0.6 GB
   (≈ $0.03 egress), 50 MB is 1.0 GB (≈ $0.05); a weekly course of ~10 sessions with ~3 snapshots each stays
   around 20–30 GB/month (≈ $1–1.5), inside Hobby's included usage, whereas an unbounded viewer count makes egress
   and fan-out time unbounded; (c) *memory* — worst case 20 slow viewers × 64 MiB buffered = 1.25 GiB, which only
   fits with the backpressure policy of ADR 0002 (skip/coalesce viewers above a high-water mark, cap total
   buffered bytes) and a ≥ 2 GB container; above 20 that policy alone no longer bounds memory for a Hobby-sized
   service; (d) *time to first model* — fan-out of 0.6–1 GB per snapshot is the dominant cost of the NFR
   "time from code entry to visible model"; 20 keeps it within the budget set in `docs/requirements.md`
   `[TODO verify]` with a load test (`QA-`, k6) once egress bandwidth is measured.
3. **Deferred to M4:** camera synchronisation (publisher → viewers, opt-in "follow presenter"), telepointer,
   device → Slicer commands (toggle visibility from a phone/headset). The protocol v1 reserves message types
   and a permission matrix for them (`docs/protocol.md`) so M4 needs no breaking change.
4. **Out of scope (all milestones):** multiple publishers per session, viewer-to-viewer messaging, persistence
   of scenes on the relay, recording/replay.

## Consequences

**Positive**

- Simple session model: one source of truth (Slicer), N passive sinks; no conflict resolution, no authority
  negotiation, minimal permission matrix in the protocol.
- Local cameras give each viewer zero-latency interaction and work identically on phones and Quest.
- The 20-viewer cap bounds egress, memory and fan-out time, which lets the relay run on Hobby-class resources.
- Read-only viewers mean viewer sockets carry only small JSON (64 KiB `maxPayload`), closing the "DoS by large
  blob from a viewer" branch of the threat model.

**Negative**

- A presenter cannot direct attention (no shared camera/pointer) until M4; lecturers must talk viewers through
  the scene ("look at the left kidney").
- Students cannot change visibility on their own device in M1 if the publisher's state is authoritative — v1
  viewers may apply *local* overrides (hide a node locally) without sending anything; this must be made visible in
  the UI so a viewer knows they diverge from the presenter.
- 20 is a policy number; a larger lecture needs either a bigger container with a higher cap or a second session
  (two Slicer instances / two codes).
- Multiple Slicer users cannot co-present in one session.

**Follow-ups**

- `server`: implement `MAX_VIEWERS_PER_SESSION`, buffered-bytes high-water mark and coalescing; expose counts
  in `/health` (no codes). `qa`: k6 scenario 1 publisher × 20 viewers × 50 MB snapshot; record egress and time
  to last viewer; revisit the cap with data.
- `protocol`: reserve `camera`, `pointer`, `command` message types and the permission matrix for M4.
- `web`/`quest`: local-only overrides clearly marked ("local view differs from presenter").
- `requirements`: state 20 viewers and the egress estimate as NFRs; list multi-publisher as out of scope.

## Alternatives considered

- **Unlimited viewers.** Rejected: egress, fan-out time and buffered memory grow linearly with viewers on a
  single process with no horizontal scaling (no sticky sessions on Railway); a limit is required for the threat
  model (resource exhaustion by joining a public code many times).
- **10 viewers (research example).** Rejected: too small for a lab group; 20 remains affordable with the
  backpressure policy.
- **Shared (presenter-driven) camera from day one.** Rejected for M1: adds a message type, a "follow/unfollow"
  UI and motion-sickness considerations on Quest; local cameras are strictly simpler and most valuable for
  self-paced exploration. Delivered in M4 as opt-in.
- **Viewer commands to Slicer in M1.** Rejected: requires authorisation, conflict handling with the presenter and
  Slicer-side main-thread application of remote changes; deferred to M4.
- **Multi-publisher sessions.** Rejected entirely for this project (no use case in the personas).

## Sources

- Railway pricing (egress $0.05/GB, RAM $10/GB-month, plan allowances): https://docs.railway.com/reference/pricing/plans ; https://railway.com/pricing
- Railway scaling (random distribution, no sticky sessions): https://docs.railway.com/reference/scaling
- Railway specs & limits (connections per domain, WebSocket exemption): https://docs.railway.com/networking/public-networking/specs-and-limits.md
- `ws` 8.22.0 `bufferedAmount` / `send` callback / `maxPayload`: https://github.com/websockets/ws/blob/master/doc/ws.md ; sender: https://github.com/websockets/ws/blob/master/lib/sender.js
- WebKit bug 268816 (iPhone WebContent memory budget): https://bugs.webkit.org/show_bug.cgi?id=268816
- Meta device budgets (viewer-side limits that bound snapshot size): https://developers.meta.com/horizon/resources/device-optimization-comparison/

## Errata (2026-10-17, pre-implementation review)

- 2026-10-17 — Names: the environment variable is **`MAX_VIEWERS`** (not `MAX_VIEWERS_PER_SESSION`), the error is
  **`SESSION_FULL`** with close `4005` (not `session_full`), the health endpoint is **`/healthz`** (not `/health`)
  — protocol §9.2, §10; architecture §9.
- 2026-10-17 — "64 KiB `maxPayload`" for viewers: `maxPayload` is **1 MiB + 64 KiB server-wide**; viewer **text
  frames are capped at 16 KiB** (close `1009`) and any viewer binary frame is `UNAUTHORIZED` + close `1008`
  (protocol §3.2, §3.3).
- 2026-10-17 — Memory budget (Decision 2c, "≥ 2 GB container"): with the slow-consumer **hard watermark 8 MiB**
  per viewer (close `4010`), the soft watermark 4 MiB, and the global **`MAX_TOTAL_BUFFERED_BYTES` = 160 MiB**
  (protocol §3.3, architecture §4/§9), buffered sends are bounded at 160 MiB regardless of viewer count; together
  with `MAX_TOTAL_SNAPSHOT_BYTES` a **1 GiB container is sufficient**. The "≥ 2 GB" remark is superseded.
- 2026-10-17 — Reserved v1.1 types are **`scene.camera`** and **`viewer.command`** (protocol §8.5, §11), not
  `camera`/`pointer`/`command`.
