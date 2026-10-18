# web-viewer — mobile browser 3D viewer (Vite / TypeScript / three.js, optional WebXR)

Part of **SlicerRemoteView**. Owned by the `web` workstream (branch `ws/web`, plan
`docs/plan/web.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

A page that a phone or tablet opens without installing anything: enter the 5-character session code (or follow
the deep link `/j#CODE`), then view, rotate, zoom and filter the 3D Slicer scene live. See
`docs/architecture.md` §7 and `docs/plan/web.md`.

## Layout (planned; directories appear with the tasks of docs/plan/web.md)

| Path                      | Content                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `src/protocol/`           | connection, snapshot reassembly, versions — no DOM, no three.js (unit-tested)     |
| `src/render/`             | three.js wrapper (scene model, viewer, controls)                                  |
| `src/ui/`                 | DOM screens and widgets                                                           |
| `src/i18n/`, `src/state/` | strings (PL/EN) and the error / state catalogue                                   |
| `test/`                   | vitest: `protocol`, `state`, `i18n` run in Node; `ui`, `render` run in jsdom      |
| `e2e/`                    | Playwright component E2E (`iphone15` = WebKit, `pixel7` = Chromium + SwiftShader) |

## How to run

From the repository root (npm workspaces; `npm install` once):

```bash
npm run dev -w web-viewer        # Vite dev server; proxies /ws and /api to the relay on localhost:8787
npm run build -w web-viewer      # typecheck + production build into web-viewer/dist (hashed assets/)
npm run preview -w web-viewer    # serve dist/ locally
```

The relay serves `dist/` on the same origin as `/ws` and `/api` (ADR 0006); the WebSocket URL is derived from
`location` at runtime, so there is no host configuration.

## Test and lint commands

```bash
npm test -w web-viewer           # vitest (unit)
npm run e2e -w web-viewer        # Playwright, builds and serves dist/ itself; both device projects, headless
npm run lint -w web-viewer       # eslint + prettier --check
npm run typecheck -w web-viewer  # tsc --noEmit
```

Root `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` also cover this workspace.

### Playwright version and browsers

`@playwright/test` is pinned to **1.60.0** (Chromium 1223 / WebKit 2287), the version whose browser builds are
already installed on the development Mac (`~/Library/Caches/ms-playwright`). `docs/plan/web.md` names 1.64.1; moving
there means `npx playwright install chromium webkit` (a download of a few hundred MB) and bumping the pin. Playwright
WebKit is **not** Safari — iOS behaviour is verified on a real iPhone (`docs/testing/web.md`).

### Pinned dependencies

`three` is pinned to an exact version (`0.186.1`, NFR-41); upgrade deliberately, three.js has no LTS. `index.html`
loads nothing from a CDN (NFR-09; asserted in `test/toolchain.test.ts`).
