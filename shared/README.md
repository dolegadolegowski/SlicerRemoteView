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
| `schema/` | JSON Schema files, one per message type plus `envelope` and `defs` (PRO-02…) |
| `fixtures/messages/<type>/` | `valid-*.json` / `invalid-*.json` conformance fixtures (PRO-03…) |
| `ts/` | TypeScript sources of `@slicerremoteview/shared` (entry `ts/index.ts`), built to `dist/` |
| `test/` | vitest suites (`*.test.ts`); file names match the plan's `npm test -w shared -- <name>` filters |
| `scripts/` | generation and check scripts (`*.mjs`) |

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
