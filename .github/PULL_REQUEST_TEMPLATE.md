<!--
SlicerRemoteView pull request. Rules: CLAUDE.md (repository root). Keep the title in Conventional Commits form
with the task IDs, e.g. `feat(server): session code generator (SRV-02)` or `merge: ws/web into main (WEB-04, WEB-05)`.
Never paste session codes, resume tokens, METRICS_TOKEN, RAILWAY_TOKEN or scene data here (CLAUDE.md rule 6).
-->

## Tasks

<!-- Task IDs from docs/plan/<component>.md, one line each: what changed and why. -->

- 

## Checklist

- [ ] One task = one commit, each with its task ID; tasks of different components are not mixed in one commit (CLAUDE.md rules 3 and 11).
- [ ] Tests added or updated for the change; `npm test`, `npm run lint`, `npm run typecheck` (and `pytest` for Python) pass locally.
- [ ] The plan row of every task is set to `done` in the same commit as the task (CLAUDE.md rule 3).
- [ ] Protocol: unchanged, **or** a separate `docs(protocol): …` commit with the new version comes first and the affected plans are marked `[protocol change: vX.Y]` (CLAUDE.md rule 2); decisions recorded in an ADR.
- [ ] Only the component's own files are edited; problems in another component are filed under `docs/testing/reports/` (CLAUDE.md rules 4 and 9).
- [ ] No secrets, `.env` files, session codes or tokens in the diff, the logs or this description (CLAUDE.md rule 6).
- [ ] Steps that need Slicer, Unity, a device or the Railway account are written as manual steps in `docs/testing/<component>.md` (CLAUDE.md rule 10).
- [ ] Merging touches `relay-server/`, `shared/`, `web-viewer/`, `package*.json`, `tools/fake-slicer/package.json` or `.dockerignore`? It redeploys the live relay and ends running sessions: merge when no session is running (`docs/deploy.md` §4).

## Manual verification

<!-- What was checked by hand (device, browser, Slicer version, Railway), or "none". -->
