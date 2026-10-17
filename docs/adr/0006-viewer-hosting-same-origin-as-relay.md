# ADR 0006: Web viewer hosted by the relay on the same origin (`@fastify/static`, `/j` route, CSP)

- **Status:** Accepted (2026-10-17, confirmed by the project owner)
- **Component(s):** `server`, `web`, `deploy`
- **Related:** `docs/architecture.md` (deployment view, threat model: leaks via URL paths/logs),
  `docs/protocol.md` (HTTP endpoints `/`, `/j`, `/api/scene/:version`, `/healthz`, `/metrics`),
  ADR 0002 (Fastify stack), ADR 0007 (Docker context builds the viewer), ADR 0008 (code in URL fragment)

## Context

Phones and tablets open a web page, enter or scan a code and connect over WSS to the relay (`prompts/00-goal.md`).
The viewer is a static Vite build (`web-viewer/dist`). It can be served by the relay container or by a separate
static host. Verified facts (`docs/research/relay.md`, `web.md`):

- `@fastify/static` 10.1.6 (Fastify ^5) serves a directory with `prefix`, `wildcard`, per-file cache headers and
  `preCompressed: true` (`.br`/`.gz` with `Vary: Accept-Encoding`); it has **no SPA fallback option** — an explicit
  route or `setNotFoundHandler` + `reply.sendFile('index.html')` is needed for `/j`.
- `@fastify/helmet` 13.2.0 (helmet ^8) sets a default CSP; the viewer needs `connect-src 'self' wss:`,
  `worker-src blob:` (three.js decoder workers), `img-src data: blob:`; Vite output has no inline scripts by default.
- The relay and viewer on one origin means no CORS plugin; the relay should still check the `Origin` header on
  WebSocket upgrades for browser clients (Slicer/Quest send none or a custom one).
- RFC 3986 §3.5: the URL fragment is never sent to the server → `/j#ABCDE` reaches the relay as `GET /j`; Railway
  edge HTTP logs record method, path, host, status, client IP, user agent (query-string inclusion `[TODO verify]`).
- Railway: one service = one generated `*.up.railway.app` domain with Let's Encrypt TLS; custom domains need
  CNAME + TXT; Hobby allows 2 custom domains per service. Each additional service is billed separately (vCPU/RAM).
- WebXR and `wss://` require a secure context; Wake Lock too (`web.md` §2.5, §3).
- The late-join endpoint `/api/scene/:version` (viewer token in a header) and the WebSocket endpoint `/ws` live on
  the relay; a separate viewer host would call them cross-origin.

## Decision

1. The **web viewer is built to static files inside the relay's Docker image** (ADR 0007) and **served by the relay
   process with `@fastify/static`** from `web-viewer/dist` → `/` on the **same origin** as `/ws` and `/api/*`.
2. **Routes:** `GET /` and `GET /j` return `index.html` (`Cache-Control: no-cache`); hashed assets under `/assets/`
   get `max-age=30d, immutable`; `preCompressed: true` with `.br`/`.gz` generated at build. No other path serves
   `index.html` (no catch-all), so unknown paths 404 and never echo a code.
3. **The viewer derives the WebSocket URL at runtime**: `wss://${location.host}/ws`; no `VITE_*` host variable in
   production builds (one image runs on any Railway domain).
4. **Security headers** via `@fastify/helmet`: CSP `default-src 'self'; connect-src 'self' wss:; worker-src 'self'
   blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'` (Vite CSS-in-JS fallback; tighten once
   verified), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; `crossOriginEmbedderPolicy` disabled only if
   WebXR assets break `[TODO verify]`. `Origin` of browser WebSocket upgrades must equal the service's public domain
   (`RAILWAY_PUBLIC_DOMAIN` or configured custom domain); absent `Origin` (Slicer, Unity) is allowed.
5. **One Railway service**, one domain, one TLS certificate, one deploy pipeline (ADR 0007).

## Consequences

**Positive**

- No CORS configuration, no preflight for `/api/scene/:version`, no cross-origin WebSocket policy to maintain.
- A single deploy produces a consistent viewer + relay pair (the viewer always matches the protocol version
  the relay speaks); rollbacks are atomic.
- One Railway service to pay for and monitor; one domain to put in the QR code (`https://<host>/j#ABCDE`).
- Fragment-only code transport plus no catch-all route means the relay's access logs never contain a code.
- Secure context for free (Railway TLS) → WebXR, Wake Lock and `wss://` work out of the box.

**Negative**

- Static file serving consumes relay CPU/egress; no CDN caching (`@fastify/static` README recommends a reverse
  proxy/CDN for production caching). Acceptable at our scale (viewer bundle ≈ 1 MB; Draco decoders only if
  ADR 0001's optional milestone lands).
- Every viewer-only change redeploys the relay, which drops all sessions (Railway redeploy = in-memory state loss,
  ADR 0007). Mitigation: deploy windows, publisher resume (ADR 0008), `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`.
- The Docker build must include Node tooling for the Vite build (multi-stage image, ADR 0007).
- CSP must be revisited when adding decoders (`/draco/` WASM → `script-src`/`worker-src`) or WebXR input profiles.

**Follow-ups**

- `server`: `@fastify/static` registration with explicit `/` and `/j` routes, `wildcard: false`; helmet CSP as
  above; `Origin` check on upgrade; `/healthz` without session data.
- `web`: `history.replaceState(null, '', '/j')` after reading `location.hash`; derive WS URL from `location`.
- `deploy`: generate `.br`/`.gz` in the Docker build; set draining seconds; document the single domain in
  `docs/deploy.md`.
- `qa`: negative tests — `GET /j?code=X` and `GET /ABCDE` must not serve the viewer with the code, logs must not
  contain codes (`docs/security.md`).

## Alternatives considered

- **Separate Railway static service (or second Fastify service) for the viewer.** Rejected: two deploys to keep in
  sync, CORS and WebSocket `Origin` allow-lists, two domains/certificates, double base cost, and no benefit since
  the relay is the only API the viewer talks to.
- **External CDN / object storage (e.g. Cloudflare Pages, S3 + CDN).** Rejected for v1: cross-origin API/WS,
  another provider in the privacy story (`docs/architecture.md` threat model), another deploy credential; CDN
  caching gains are negligible for a ~1 MB bundle at ≤ 20 viewers per session. Can be revisited if egress for
  static assets ever dominates.
- **Catch-all SPA fallback (`/*` → `index.html`).** Rejected: would make `/<CODE>` deep links "work" and thereby
  leak codes into edge logs; only `/` and `/j` are valid entry points.
- **Hard-coded WebSocket URL via `VITE_WS_URL`.** Rejected: ties the image to one domain and risks pointing a
  viewer at a foreign relay; runtime derivation keeps a single build.

## Sources

- `@fastify/static` README (no SPA option, `preCompressed`, cache options): https://github.com/fastify/fastify-static ; npm: https://registry.npmjs.org/@fastify/static/latest
- `@fastify/helmet` 13.2.0: https://github.com/fastify/fastify-helmet
- Fastify 5 server options (`trustProxy`, `bodyLimit`): https://fastify.dev/docs/latest/Reference/Server/
- RFC 3986 §3.5 (fragment never sent): https://www.rfc-editor.org/rfc/rfc3986#section-3.5 ; MDN `Location.hash` / `History.replaceState`: https://developer.mozilla.org/en-US/docs/Web/API/Location/hash ; https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
- Railway HTTP edge logs (fields recorded): https://docs.railway.com/reference/logging
- Railway domains & TLS: https://docs.railway.com/networking/domains/working-with-domains ; public networking: https://docs.railway.com/guides/public-networking
- Railway pricing (per-service billing): https://docs.railway.com/reference/pricing/plans
- Railway deployments lifecycle (redeploy drops state, draining seconds): https://docs.railway.com/reference/deployments
- WebXR secure context: https://immersive-web.github.io/webxr/#navigator-xr-attribute ; Screen Wake Lock: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- Vite static asset handling / env variables: https://vite.dev/guide/assets ; https://vite.dev/guide/env-and-mode
