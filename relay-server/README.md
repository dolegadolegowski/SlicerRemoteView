# relay-server — session codes, WebSocket relay, static web-viewer hosting (Node.js 22 / Fastify / ws)

Part of **SlicerRemoteView**. Owned by the `server` workstream (branch `ws/server`, plan
`docs/plan/server.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

The relay accepts one 3D Slicer publisher per session, hands out a 5-character session code, lets up to 20
viewers (web-viewer, Quest) join with it and forwards the scene to them. Everything is held in memory only
(single replica); nothing is written to disk and codes, tokens and scene bytes never reach a log. Design:
`docs/architecture.md` §3–§5, §8–§9; task list: `docs/plan/server.md`.

## How to run

From the repository root (Node 22, `npm ci` once):

```bash
npm run dev -w relay-server        # tsx watch, sources of shared/ via tsconfig paths, http://localhost:8787
npm run build                      # shared/ first, then relay-server/dist (and the other workspaces)
npm start -w relay-server          # node dist/index.js (needs the build above)
```

`PORT` selects the port (default `8787`; Railway injects it); the relay listens on `0.0.0.0`.

| Endpoint           | Answer                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /healthz`     | `200 {"status":"ok","uptimeS":…,"sessions":…,"version":"…"}` — no codes, IPs or memory figures      |
| `GET /api/version` | `200 {"name":"slicer-remote-view-relay","version":…,"protocolVersions":["1.0"],"limits":{…}}` (§10) |
| anything else      | `404 {"error":"NOT_FOUND"}` — no SPA fallback, the path is never echoed                             |

Logs are JSON lines (`level`, `time`, `message`) on stdout; per-request logging is disabled.

## Test and lint commands

```bash
npm test -w relay-server             # vitest (all relay tests)
npm test -w relay-server -- app      # one file by name filter, e.g. `app`, `config`, `codes`
npm run lint -w relay-server         # eslint + prettier --check
npm run typecheck -w relay-server
npm run build -w relay-server        # tsc → relay-server/dist (needs `npm run build -w shared` first)
```

The root `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` run every workspace. The Docker image
(`docker build -f relay-server/Dockerfile .` from the repo root) arrives with SRV-20.
