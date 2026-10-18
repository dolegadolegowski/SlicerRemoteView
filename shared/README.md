# shared — protocol contract (JSON Schema, fixtures, generated TS/Python/C# types)

Part of **SlicerRemoteView**. Owned by the `protocol` workstream (branch `ws/protocol`, plan
`docs/plan/protocol.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

`docs/protocol.md` v1.0 as an executable contract: one JSON Schema (draft 2020-12) per message type,
valid/invalid fixtures shared by every language, and generated types (`ts/`, `py/`, `cs/`). See
`docs/architecture.md` and `docs/plan/protocol.md` for the task list.

## Layout

| Path | Content |
|---|---|
| `schema/` | JSON Schema files: `envelope.schema.json`, `defs.schema.json` (common definitions) and one `<type>.schema.json` per message type |
| `fixtures/messages/<type>/` | `valid-*.json` / `invalid-*.json` conformance fixtures, one directory per message type |
| `ts/` | TypeScript sources of `@slicerremoteview/shared` (entry `ts/index.ts`), built to `dist/` |
| `test/` | vitest suites (`*.test.ts`); file names match the plan's `npm test -w shared -- <name>` filters |
| `scripts/` | generation and check scripts (`*.mjs`); `check-generators.mjs` = the PRO-02 generator spike |

## How to run

From the repository root (Node 22, npm workspaces — one `package-lock.json`):

```bash
npm install            # resolves every workspace, including @slicerremoteview/shared
npm test -w shared     # vitest, all suites
npm test -w shared -- toolchain   # one suite by file-name filter (e.g. defs, session from PRO-02/03)
```

Consumers import the package as a workspace dependency: `import { PROTOCOL_VERSION } from "@slicerremoteview/shared"`
(also exported as `@slicerremoteview/shared/ts`; schemas via `@slicerremoteview/shared/schema/<name>.schema.json`).

## Test, lint and build commands

| Command | What it does |
|---|---|
| `npm test -w shared` | `vitest run` over `test/**/*.test.ts` |
| `npm run lint -w shared` | `eslint .` (flat config, typescript-eslint) + `prettier --check .` |
| `npm run format -w shared` | `prettier --write .` |
| `npm run typecheck -w shared` | `tsc --noEmit` over `ts/`, `test/` (strict) |
| `npm run build -w shared` | `tsc -p tsconfig.build.json` → `dist/` (ESM + `.d.ts`) |

Runtime dependency policy: only the schema validator (`ajv`); everything else is a devDependency
(`prompts/01-protocol.md`). Python (`py/`, pytest) and C# (`cs/`) toolchains arrive with PRO-09 and PRO-17.

## Schema conventions

- Declared draft: **JSON Schema 2020-12** (`$schema` in every file), but restricted to a
  **draft-07-compatible subset**: shared definitions live under `definitions` (not `$defs`), and
  `unevaluatedProperties` / `$dynamicRef` / `$dynamicAnchor` are not used (`test/defs.test.ts` enforces this).
- Cross-file references are relative to the `$id` base `https://slicerremoteview.dev/schema/`, e.g.
  `{ "$ref": "defs.schema.json#/definitions/code" }`. Message schemas extend the envelope with
  `"allOf": [{ "$ref": "envelope.schema.json" }]` and fix `type` with `"const"` **and** `"type": "string"`.
- The envelope never sets `additionalProperties: false`: unknown fields must be accepted (`docs/protocol.md` §14).
- Conditional requirements use draft-07 `if`/`then` (e.g. `session.publisherState`: `graceEndsAt` required when
  `online` is `false`; `viewer.joined`: `snapshot` required when `snapshotAvailable` is `true`), and
  "exactly one of" rules use `oneOf` (`viewer.join`). Both only list required/forbidden combinations; the property
  shapes stay in the top-level `properties`, so generated types carry them as optional fields and the rule itself is
  enforced by validators (Ajv, Python `jsonschema`), not by the types. Ajv `strict` (`strictRequired`) demands that
  every name in a branch's `required` also appears in that branch's `properties`, hence the repeated `$ref`s.
- Validation in TS: Ajv 2020 (`ajv/dist/2020.js`) in `strict` mode with `allowUnionTypes` (for `string|null`),
  all files registered with `addSchema` — see `test/helpers.ts`.

## Fixture conventions

- `fixtures/messages/<type>/valid-*.json` is a **raw message**; `valid-example.json` is the example of
  `docs/protocol.md` value for value (a test parses the document's JSON blocks and compares).
- `fixtures/messages/<type>/invalid-*.json` wraps the message with the failure it must produce, so every language
  can assert the same thing:

  ```json
  { "$comment": "why it is invalid (§ reference)",
    "expect": { "instancePath": "/code", "keyword": "pattern" },
    "message": { "...": "the invalid message" } }
  ```

  `instancePath` is the JSON Pointer of the offending value (`""` for a missing required property, as Ajv and
  Python `jsonschema` both report it on the parent); `keyword` is optional. There is one invalid fixture per
  required field (including the envelope-required `type` and `protocolVersion`) and per enum, plus the boundary cases
  named in the plan's acceptance criteria.
- Valid fixtures other than `valid-example.json` are shape fixtures: their `byteLength`/`sha256` values are synthetic
  (e.g. `scene.snapshot.begin/valid-chunk-64k.json`, 3 full 64 KiB chunks + 1 byte) until PRO-08 adds fixtures
  derived from the real GLB files in `fixtures/glb/manifest.json`.
- The TS runner is `loadFixtures()` in `test/helpers.ts`; `test/session.test.ts` covers `session.*`,
  `test/viewer.test.ts` covers `viewer.*`, `ping`, `pong` and `error`, `test/snapshot.test.ts` covers `scene.snapshot.*`.

## Generator spike (PRO-02, ADR 0002 errata)

`node shared/scripts/check-generators.mjs` runs quicktype (C# and TypeScript) over every file in `schema/` — so the
evidence grows with each schema task — and, when `nswag` is on `PATH`, NJsonSchema's CLI. Result recorded 2026-10-18 (quicktype 26.0.0; NJsonSchema checked in
its sources and issue tracker because `.NET` is not in the sandbox):

| Feature | quicktype 26 | NJsonSchema (master, 2026-10) |
|---|---|---|
| `definitions` + cross-file `$ref` | consumed (`Profile` enum, `ClientInfo` class generated from `defs`) | consumed (`definitions` is the only container it resolves) |
| `$defs` | consumed | **not resolved** — open PR RicoSuter/NJsonSchema#1913, issue #1536 |
| `const` | → single-value enum (`type Type = "viewer.join"`, C# `enum TypeEnum { ViewerJoin }`) | **not supported** for generation — issue #1329, PRs #1891/#1897 open; the sibling `"type": "string"` keeps the property a `string` |
| `if`/`then` (draft-07) | ignored for typing: output identical with and without the conditional (`graceEndsAt?: number`, C# `long? GraceEndsAt`), checked 2026-10-18 on `session.publisherState` | parsed into `If`/`Then`/`Else`, not used for C# generation — `[TODO verify]` with the first `dotnet` run (PRO-17) |
| `oneOf` of required-sets | branches merged into optional properties (re-checked 2026-10-18 on the real `viewer.join`: `code?: string`, `sessionId?: string`, `viewerToken?: string`); a property that appears **only** as `required` in a branch, without a schema anywhere, becomes `unknown`/`object` — a property with a `$ref` in the branch is typed correctly | `[TODO verify]` with the first `dotnet` run (PRO-17) |

Decisions taken from the spike: (1) schemas use `definitions`, never `$defs`; (2) every `type` keyword is
`{"type": "string", "const": "…"}`; (3) `oneOf` and `if`/`then` are used only for required/forbidden combinations, while
the property shapes are declared in the top-level `properties` (PRO-18 `session.publisherState`, PRO-04 `viewer.join`); (4) C# generation (PRO-17)
defaults to quicktype with `--framework NewtonSoft` unless NJsonSchema ships `$defs`/`const` by then.
Sources: https://github.com/RicoSuter/NJsonSchema/pull/1913, https://github.com/RicoSuter/NJsonSchema/issues/1536,
https://github.com/RicoSuter/NJsonSchema/issues/1329.
