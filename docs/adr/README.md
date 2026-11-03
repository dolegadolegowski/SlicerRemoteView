# Architecture Decision Records

Decisions that shape SlicerRemoteView. Each ADR is immutable once **Accepted**; a change is a new ADR that
**Supersedes** the old one (the old file gets `Status: Superseded by NNNN`). Facts cited in ADRs come from
`docs/research/*.md` and carry source URLs. Anyone who makes an architectural decision may add an ADR
(CLAUDE.md rule 4); `release` keeps this index current.

## Index

| No.  | Title                                                                                   | Status   | Date       |
|------|-----------------------------------------------------------------------------------------|----------|------------|
| 0001 | [Scene transport — GLB geometry rendered locally plus incremental JSON state updates](0001-scene-transport-glb-and-incremental-updates.md) | Accepted | 2026-10-17 |
| 0002 | [Relay and web-viewer stack — Node.js 22 / TypeScript / Fastify 5 / `ws`, Vite 8 / three.js r186, shared JSON Schema](0002-relay-and-web-stack.md) | Accepted | 2026-10-17 |
| 0003 | [Meta Quest client — Unity 6.3 LTS native app (M3b) with a WebXR intermediate milestone (M3a)](0003-quest-engine-unity-with-webxr-intermediate.md) | Accepted | 2026-10-17 |
| 0004 | [MVP scope — one Slicer publisher, up to 20 read-only viewers per session, local camera](0004-mvp-scope-one-publisher-many-viewers.md) | Accepted | 2026-10-17 |
| 0005 | [Slicer export — custom pure-Python GLB writer, RAS→glTF conversion in Slicer, stable `nodeId`](0005-slicer-glb-export-coordinates-and-node-ids.md) | Accepted | 2026-10-17 |
| 0006 | [Web viewer hosted by the relay on the same origin (`@fastify/static`, `/j` route, CSP)](0006-viewer-hosting-same-origin-as-relay.md) | Accepted | 2026-10-17 |
| 0007 | [Monorepo wiring — npm workspaces, vendored shared types, root Docker context, single Railway replica, Railway IaC](0007-monorepo-wiring-and-docker-context.md) | Accepted | 2026-10-17 |
| 0008 | [Session code format (5 × 31-symbol alphabet), lifecycle, tokens and anti-guessing controls](0008-session-code-format-and-anti-guessing.md) | Accepted | 2026-10-17 |
| 0009 | [Slicer transport — `websockets` asyncio client on a private event loop in one worker thread](0009-slicer-transport-asyncio-worker-thread.md) | Accepted | 2026-10-20 |
| 0010 | [The Slicer extension's top level at the repository root (Extensions Index layout)](0010-slicer-extension-top-level-at-repository-root.md) | Accepted | 2026-11-03 |

> **Note (2026-10-17, pre-implementation review).** Message, error and close-code names quoted in ADRs 0001–0008
> predate protocol v1.0; `docs/protocol.md` is authoritative. Errata sections record known deviations.
>
> **Same-day errata.** An Accepted ADR may receive an append-only `## Errata (<date>, <reason>)` section with dated
> bullets when the deviation is found on the acceptance day and before any implementation exists: the decision is
> unchanged, only its wording is reconciled with the contract, so no superseding ADR is needed. The body above the
> errata is never rewritten; a change of the decision itself still requires a new ADR that supersedes the old one.

## Template

File name `NNNN-short-kebab-title.md` (next free number, four digits), written in English, 60–120 lines:

1. `# ADR NNNN: Title`, then a bullet header: **Status** (`Proposed` | `Accepted (date)` | `Superseded by NNNN` | `Deprecated`), **Component(s)** from the `CLAUDE.md` map, **Related** documents/ADRs by path.
2. `## Context` — the problem and the *verified* facts that constrain it (versions, limits, URLs; unverified claims marked `[TODO verify]`).
3. `## Decision` — numbered, concrete, testable statements (what, not how to implement).
4. `## Consequences` — **Positive**, **Negative**, **Follow-ups** (tasks for named components/workstreams).
5. `## Alternatives considered` — each in one or two lines with the reason it was rejected or deferred; then `## Sources` — the URLs the Context relies on, copied from `docs/research/`.
6. Optional, append-only: `## Errata (<date>, <reason>)` — dated bullets reconciling names or numbers with `docs/protocol.md`/`docs/architecture.md` without changing the decision (see the note above).
