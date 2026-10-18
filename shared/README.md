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
| `ts/` | TypeScript sources of `@slicerremoteview/shared` (entry `ts/index.ts`), built to `dist/`: `validate.ts` (`compileSchemas`, `parseEnvelope`, `validateMessage`), `permissions.ts` (§11 `PERMISSIONS`, `isAllowed`), `constants.ts` (`ERROR_CODES`, `CLOSE_CODES`, `LIMITS`), `chunk.ts` (§6.3 chunk header, `chunkify`, `checkChunk`, `sha256Hex`), `code.ts` (session-code alphabet, `normalizeCode`) |
| `py/` | Python package `remoteview_protocol` (pyproject, `remoteview_protocol/`, `tests/`, own `README.md`) — vendored into the Slicer extension (ADR 0007 §3); `py/remoteview_protocol/schema/` is a **generated** copy of `schema/` |
| `ts/generated/` | **generated, committed** (`npm run generate -w shared`): `schemas.ts` embeds every file of `schema/` so validation needs no file system (browsers, bundlers); PRO-11 adds `messages.ts` |
| `fixtures/messages/expected.json` | **generated**: the valid/invalid partition of every fixture with the expected `instancePath` — the reference the Python and C# conformance tests must reproduce (PRO-09, PRO-17) |
| `fixtures/blob/` | binary test vectors of the chunk header (`chunk-header-*.bin`, table in `chunk-headers.json`, see its `README.md`) shared with Python/C# |
| `fixtures/codes/` | `normalize-cases.json`: `normalizeCode` inputs and expected codes/hints (ADR 0008 §7) |
| `test/` | vitest suites (`*.test.ts`); file names match the plan's `npm test -w shared -- <name>` filters |
| `fixtures/glb/` | GLB snapshot fixtures of §7 (`asymmetric-2nodes.glb`, `quantized-1node.glb`, `large-synthetic.glb` ≈ 5 MiB) and five broken files for §7.1 pre-validators; `manifest.json` (byteLength, sha256, nodeIds, triangleCount) — generated, never edited by hand |
| `scripts/` | generation and check scripts; `generate.mjs` writes `ts/generated/schemas.ts` + `fixtures/messages/expected.json` (`npm run generate`, `--check` for drift), `make-glb-fixtures.ts` regenerates `fixtures/glb/` (`npm run fixtures`), `check-generators.mjs` = the PRO-02 generator spike |

## How to run

From the repository root (Node 22, npm workspaces — one `package-lock.json`):

```bash
npm install            # resolves every workspace, including @slicerremoteview/shared
npm test -w shared     # vitest, all suites
npm test -w shared -- toolchain   # one suite by file-name filter (defs, session, viewer, snapshot, scene, lib, chunk, code, glb)
```

Consumers import the package as a workspace dependency: `import { PROTOCOL_VERSION } from "@slicerremoteview/shared"`
(also exported as `@slicerremoteview/shared/ts`; schemas via `@slicerremoteview/shared/schema/<name>.schema.json`).

## Validation library (`ts/validate.ts`, `ts/permissions.ts`, `ts/constants.ts`, PRO-06)

Browser-safe: the schemas come from `ts/generated/schemas.ts`, Ajv 2020 compiles them in `strict` mode once per
process. The relay validates client messages with the strict default; clients validate inbound relay messages
with `compileSchemas({ tolerateUnknownEnums: true })` so a newer relay's error codes or reasons do not break a
`1.0` viewer (§14 "tolerate unknown enum values", PRO-02 review follow-up).

```ts
import { compileSchemas, parseEnvelope, isAllowed, ERROR_CODES, CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";

const validators = compileSchemas(); // once; or compileSchemas({ tolerateUnknownEnums: true }) on clients
const result = parseEnvelope(text, validators);
if (!result.ok) {
  // result.error.code is INVALID_MESSAGE | UNSUPPORTED_TYPE | UNSUPPORTED_VERSION (§9.2),
  // result.error.instancePath a JSON Pointer, result.error.issues Ajv's data-free messages — safe for error.details
}
if (!isAllowed("viewer", result.value.type)) {
  /* error UNAUTHORIZED (§11) */
}
```

| Export | Purpose |
|---|---|
| `compileSchemas({ allErrors?, tolerateUnknownEnums? })` | one Ajv validator per message type (`byType`) plus the `envelope` validator; `tolerateUnknownEnums` opens `errorCode` and every `*Reason` definition to any 1–64-char string (`LENIENT_ENUM_DEFINITIONS`; `clientInfo.platform` is a plain string in the schema already) |
| `parseEnvelope(text, validators?)` | text frame → `{ok, value: Message}` or `{ok: false, error: {code, instancePath, message, issues}}`; checks JSON → object → `protocolVersion` major (`UNSUPPORTED_VERSION`, §2) → envelope (`INVALID_MESSAGE`) → known `type` (`UNSUPPORTED_TYPE`) → type schema (`INVALID_MESSAGE`). Unknown fields and higher minors (`1.7`) pass (§2, §14). The error never contains data values. Note for ports: a fixture whose `type` is wrong (`invalid-type-const.json`) or whose major is foreign therefore yields `UNSUPPORTED_TYPE` / `UNSUPPORTED_VERSION` from `parseEnvelope`, and `INVALID_MESSAGE` only from `validateMessage(message, <directory type>)` |
| `validateMessage(message, type?, validators?)` | the same for an already-parsed object, optionally against a named schema (conformance tests, relay-built messages) |
| `defaultSchemas()` | lazily compiled strict validators used when none are passed |
| `PERMISSIONS`, `isAllowed(sender, type, recipient = "relay")`, `isBinaryAllowed(sender, recipient?)`, `BINARY_FRAME_PERMISSION` | §11 matrix with the four directions (`publisherToRelay`, `viewerToRelay`, `relayToPublisher`, `relayToViewer`); unknown and `RESERVED_TYPES` (`scene.camera`, `viewer.command`) are never allowed; `test/lib.test.ts` parses the §11 table from `docs/protocol.md` and checks every cell |
| `MESSAGE_TYPES`, `MessageType`, `isMessageType`, `Message`, `Result`, `ParseError`, `ValidationIssue` | the 28 v1.0 types and the result types; `Message` is the envelope plus `unknown` payload fields until PRO-11 generates per-type interfaces |
| `PROTOCOL_VERSION` (`"1.0"`), `PROTOCOL_MAJOR`, `ERROR_CODES` (15 codes of §9.2), `CLOSE_CODES` (§9.3: `NORMAL` 1000 … `HANDSHAKE_TIMEOUT` 4012), `LIMITS` (§3.3 maximums in bytes / seconds, e.g. `MAX_TEXT_BYTES_PUBLISHER`, `MAX_SNAPSHOT_BYTES`, `MAX_VIEWERS`, `HEARTBEAT_INTERVAL_S`) | constants; the test cross-checks them against the §3.3, §9.2 and §9.3 tables of `docs/protocol.md` |

## Python package (`py/`, PRO-09)

`shared/py/remoteview_protocol` is the Python mirror of `ts/` for the Slicer extension (vendored, never pip-installed —
ADR 0007 §3; details and API in `py/README.md`). The schemas are **copied into the package** by `npm run generate -w
shared` (`py/remoteview_protocol/schema/`, byte-identical to `schema/`, drift-checked by `--check` and by pytest), so the
vendored copy works without the repository. `tests/test_conformance.py` replays `fixtures/messages/expected.json`: the
valid/invalid partition and the expected `instancePath` of every fixture are identical to the TypeScript run.

Tooling lives in a local virtual environment (`py/.venv`, git-ignored; the dev Mac has `uv` but no system `pytest`):

```bash
uv venv --python 3.12 shared/py/.venv && uv pip install --python shared/py/.venv/bin/python -e "shared/py[dev]"
npm run test:py -w shared     # = shared/py/.venv/bin/pytest shared/py
npm run lint:py -w shared     # = ruff check + ruff format --check over shared/py
```

## Runtime helpers (`ts/chunk.ts`, `ts/code.ts`, PRO-07)

Browser-safe (no `node:` imports, WebCrypto for hashing):

| Export | Purpose |
|---|---|
| `encodeChunkHeader({sceneVersion, chunkIndex})`, `decodeChunkHeader(frame)` | 12-byte little-endian `SRVC` header of `docs/protocol.md` §6.3; decode returns `{ok, value: {sceneVersion, chunkIndex, payload}}` or `{ok: false, error: {code: "BAD_SEQUENCE", field, message}}` |
| `checkChunk(chunk, expected)` | §6.3 receiver rules (known `sceneVersion`, strict order, payload size) → `offset` to copy to, or `BAD_SEQUENCE` naming the field (`magic`, `length`, `sceneVersion`, `chunkIndex`, `payload` — the vocabulary Python/C# mirror) |
| `chunkify(glb, chunkSize = 1 MiB)`, `encodeChunkFrame`, `chunkCountFor`, `expectedPayloadLength` | publisher side of §6.2: views over the GLB, `ceil(byteLength / chunkSize)` chunks, `RangeError` outside 64 KiB..1 MiB / 1024 chunks / 64 MiB |
| `sha256Hex(bytes)` | SHA-256 as 64 lowercase hex (the `sha256` def), Node and browsers |
| `normalizeCode(input)`, `isCode`, `ALPHABET`, `CODE_PATTERN`, `CODE_HINTS` | ADR 0008 §7: trim, strip `-`/spaces, upper-case; `{code}` or `{error: "INVALID_CODE", hint, offendingChar?}` with the `0`/`O` and `1`/`I`/`L` hints — confusables are rejected, never mapped |
| `MIN_CHUNK_SIZE`, `MAX_CHUNK_SIZE`, `MAX_CHUNK_COUNT`, `MAX_SNAPSHOT_BYTES`, `CHUNK_HEADER_BYTES` | the §3.3 limits the helpers enforce (same values as `LIMITS.MIN_CHUNK_BYTES`, `MAX_CHUNK_BYTES`, `MAX_CHUNK_COUNT`, `MAX_SNAPSHOT_BYTES`) |

## Test, lint and build commands

| Command | What it does |
|---|---|
| `npm test -w shared` | `vitest run` over `test/**/*.test.ts` |
| `npm run lint -w shared` | `eslint .` (flat config, typescript-eslint) + `prettier --check .` |
| `npm run format -w shared` | `prettier --write .` |
| `npm run typecheck -w shared` | `tsc --noEmit` over `ts/`, `test/` (strict) |
| `npm run build -w shared` | `tsc -p tsconfig.build.json` → `dist/` (ESM + `.d.ts`) |
| `npm run generate -w shared` | `node scripts/generate.mjs`: rewrites `ts/generated/schemas.ts`, `fixtures/messages/expected.json` and `py/remoteview_protocol/schema/*.json`; `npm run generate:check -w shared` (= `--check`) exits 1 on drift and is run by `test/lib.test.ts` |
| `npm run test:py -w shared` | `py/.venv/bin/pytest py` (needs the venv below) |
| `npm run lint:py -w shared` | `ruff check` + `ruff format --check` over `py/` |
| `npm run fixtures -w shared` | `node scripts/make-glb-fixtures.ts`: rewrites `fixtures/glb/*.glb` + `manifest.json` deterministically (Node type stripping, flag `--experimental-strip-types` for 22.12–22.17; `git diff --exit-code shared/fixtures/glb` is the drift check, also run by `test/glb.test.ts` in a temp dir) |

Runtime dependency policy: only the schema validator (`ajv` in TS, `jsonschema` in Python); everything else is a
devDependency (`prompts/01-protocol.md`). `gltf-validator` (Khronos, Dart compiled to JS, offline) is a devDependency used as a
**library** by `test/glb.test.ts` (`validateBytes`); the package ships no CLI, so there is no `npx gltf-validator`. The C# (`cs/`) toolchain arrives with PRO-17.

## Schema conventions

- Declared draft: **JSON Schema 2020-12** (`$schema` in every file), but restricted to a
  **draft-07-compatible subset**: shared definitions live under `definitions` (not `$defs`), and
  `unevaluatedProperties` / `$dynamicRef` / `$dynamicAnchor` are not used (`test/defs.test.ts` enforces this).
- Cross-file references are relative to the `$id` base `https://slicerremoteview.dev/schema/`, e.g.
  `{ "$ref": "defs.schema.json#/definitions/code" }`. Message schemas extend the envelope with
  `"allOf": [{ "$ref": "envelope.schema.json" }]` and fix `type` with `"const"` **and** `"type": "string"`.
- The envelope never sets `additionalProperties: false`: unknown fields must be accepted (`docs/protocol.md` §14).
- Shapes shared by several messages are `definitions` in `defs.schema.json` (e.g. `nodeChange` = one item of
  `scene.update.changes` and of `scene.state.nodes`: `nodeId` + at least one of `visible`/`color`/`opacity`/`matrix`
  via `anyOf`, and a `not` rule that forbids `name` — the JSON protocol never carries node names, §7/§8.3).
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
- Valid fixtures other than `valid-example.json` are shape fixtures with synthetic `byteLength`/`sha256` values
  (e.g. `scene.snapshot.begin/valid-chunk-64k.json`, 3 full 64 KiB chunks + 1 byte), **except**
  `scene.snapshot.begin/valid-<name>.json` where `<name>.glb` exists in `fixtures/glb/manifest.json`: those carry the
  manifest's `byteLength`/`sha256`/`nodeCount`/`triangleCount` and `test/glb.test.ts` fails when they drift.
- `fixtures/messages/expected.json` is generated from the directories above (`npm run generate -w shared`) and lists
  every fixture with `type` (the schema to validate against — not the message's own `type`, which is wrong on purpose
  in `invalid-type-const.json`), `valid` and, for invalid ones, the expected `instancePath`; every language's
  conformance test reproduces this partition.
- The TS runner is `loadFixtures()` in `test/helpers.ts`; `test/lib.test.ts` runs every fixture through
  `validateMessage`/`parseEnvelope` (PRO-06), `test/session.test.ts` covers `session.*`,
  `test/viewer.test.ts` covers `viewer.*`, `ping`, `pong` and `error`, `test/snapshot.test.ts` covers `scene.snapshot.*`,
  `test/scene.test.ts` covers the incremental-update types `scene.update`, `scene.nodeRemoved`, `scene.nodeAdded`,
  `scene.state`, `scene.request` (it filters the `scene.snapshot.*` directories out of `loadFixtures("scene.")`),
  `test/chunk.test.ts` / `test/code.test.ts` cover the runtime helpers and `test/glb.test.ts` the GLB fixtures.

## GLB fixtures (`fixtures/glb/`, PRO-08)

`make-glb-fixtures.ts` builds every file from procedural geometry that uses only additions and square roots (an
octahedron subdivided onto a sphere, an asymmetric tetrahedron), so the output is byte-identical on every platform:

| File | Content |
|---|---|
| `asymmetric-2nodes.glb` | §7 reference scene: root `SlicerRemoteView` with the §7.1 extras; segment `Liver` (opaque tetrahedron with vertices at glTF `(+0.1, 0, 0)` and `(0, 0, −0.1)` — a mirrored load shows up immediately) and model `Tumor` (translucent, `T.matrix` translation) |
| `quantized-1node.glb` | `KHR_mesh_quantization` in `extensionsUsed`/`extensionsRequired`: `POSITION` as `SHORT` (8-byte stride), dequantisation scale/offset in `M.matrix`, `M.extras = {"role": "mesh"}` |
| `large-synthetic.glb` | ≈ 5 MiB, four spheres, the first with > 65,535 vertices (`UNSIGNED_INT` indices), one translucent, one hidden — load tests and multi-chunk snapshots |
| `bad-magic.glb`, `truncated.glb`, `external-uri.glb`, `two-scenes.glb`, `no-root-extras.glb` | broken on purpose: each fails the §7.1 pre-validation a viewer runs before its loader (WEB / QST plans); all but `no-root-extras.glb` also fail `gltf-validator` |

`manifest.json` lists `byteLength`, `sha256`, `nodeIds`, `nodeCount`, `triangleCount`, `extensionsRequired` per file;
fake-slicer (PRO-14) and the derived `scene.snapshot.begin` fixtures read these values.

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
