# Dependency audit — 2026-11-02 (QA-09h)

- **Run by**: `qa` (`ws/qa`, commit `9cfa302`), as input for the T12 (supply chain) row of `docs/security.md`
  (QA-09). The continuous, CI-side audit is DEP-09's (`audit` job, Dependabot); this is a one-off snapshot.
- **Tools**: npm 10.9.9 on Node v22.23.3, against the GitHub Advisory Database (online, read-only: nothing was
  installed, updated or fixed). `pip-audit` is **not installed** on this machine (`which pip-audit` → not found,
  `python3 -m pip_audit` → no module) and was deliberately not installed: the Python audit was **not run**.
- **Scope**: the root workspaces' lockfile (`package-lock.json`: `shared`, `relay-server`, `web-viewer`,
  `tools/fake-slicer`) and the separate `tests/` lockfile. No secret, code or token is involved in any of this.

## Commands

```bash
npm audit --omit=dev --json          # repository root: what ships (relay image = relay prod deps + shared)
npm audit --json                     # repository root, dev included (for context)
npm --prefix tests audit --json      # the test suite's own lockfile (dev-only tooling)
which pip-audit                      # not found → Python audit not run
```

## Results

| Scope | Dependencies audited | critical | high | moderate | low | info | total |
|---|---|---|---|---|---|---|---|
| root, `--omit=dev` (production) | 93 prod (355 total in the lockfile) | 0 | 0 | 4 | 0 | 0 | 4 |
| root, all (dev included) | 355 | 0 | 0 | 15 | 0 | 0 | 15 |
| `tests/` (all; dev-only) | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| `slicer-plugin/requirements-dev.txt` (34 pins), `shared/py` | — | not run (no `pip-audit`) | | | | | |

### Production (root `--omit=dev`): 4 moderate

| Package (installed) | Pulled in by | Advisories | Fix |
|---|---|---|---|
| `fast-uri` 4.2.2, 3.1.8 | `fastify` 5.12.7 → `@fastify/ajv-compiler` 4.0.7, `fast-json-stringify` 7.1.0 (4.2.2); `shared` → `ajv` 8.20.0 (3.1.8) | GHSA-w74x-v6f9-j3xg (scheme spoofing via percent-encoded scheme), GHSA-xhq7-xmqj-769h (path equivalence in relative-reference normalisation), GHSA-wjr9-j795-jxcr (host confusion, WHATWG host canonicalisation), GHSA-333x-w4r6-6crp (scheme injection via first-segment colon); fixed in 4.2.3 / 3.1.9 | available within the semver range (`fixAvailable: true`): a lockfile refresh of `fast-uri` |
| `@fastify/static` 10.1.6 (direct, `relay-server`) | — | via `glob` | npm proposes 6.12.0, a semver-major **downgrade**: no fixed 7.x+ release yet |
| `glob` 13.0.6 | `@fastify/static` | GHSA-3g3m-2fjr-6pw4 (AbortSignal cancellation bypass, post-timeout traversal; ≥ 9.0.0 ≤ 14.0.1) | upstream (`@fastify/static` must move to a fixed `glob`) |
| `minimatch` 10.2.6 | `glob` ← `@fastify/static` | GHSA-g3hv-75wg-m249 (DoS via globparts amplification; < 11.0.1) | upstream, as above |

Exposure notes (assessment by `qa`, not a fix; the owners decide):

- `glob`/`minimatch`: `@fastify/static` calls `glob('**/**', …)` once at start-up over the relay's own
  `public/assets` (with `wildcard: false`, SRV-16), with a fixed pattern and no request input and no
  `AbortSignal`. Neither advisory's trigger (attacker-controlled patterns, cancelled walks) is reachable from a
  request. Residual: low.
- `fast-uri`: used by Ajv to resolve schema `$ref`s/`$id`s and the `uri` formats. The relay's schemas are
  static and compiled at start (`defaultSchemas()` in `relay-server/src/app.ts`); no `"format": "uri"` appears
  in `shared/` schemas (grep, 2026-11-02), so client data is not parsed as a URI by it. Residual: low; still
  the cheapest item to clear (in-range update).

### Dev only (root, all minus production): 11 more moderate

`eslint` 10.13.0, `@eslint/js`, `@eslint/config-array` 0.23.5, `@eslint-community/eslint-utils`,
`eslint-config-prettier`, `typescript-eslint` 8.71.2 and `@typescript-eslint/{eslint-plugin,parser,type-utils,
typescript-estree,utils}` — every one of them reaches the same `minimatch` 10.2.6 advisory (GHSA-g3hv-75wg-m249);
npm's proposed "fixes" are semver-major downgrades (`eslint` 4.0.0, `typescript-eslint` 8.14.0), i.e. no forward
fix yet. Lint tooling only: never in the relay image (SRV-20 criterion 3), never fed untrusted globs.

### `tests/`

0 vulnerabilities (`@playwright/test` 1.60.0, `ws` 8.22.0, `typescript` 5.9.3, `@types/*`).

### Python (`slicer-plugin`, `shared/py`)

Not run: `pip-audit` is not available here and was not installed for this snapshot. `slicer-plugin` declares
no runtime dependencies (`dependencies = []`; `requirements-dev.txt` pins 34 dev/test wheels, never installed
into Slicer); `shared/py` depends on `jsonschema>=4.18`. To be covered by DEP-09's `pip-audit` job, e.g.
`pip-audit -r slicer-plugin/requirements-dev.txt` and `pip-audit` over `shared/py`.

## Follow-ups (proposed, not filed as bug reports: none of them contradicts `docs/protocol.md`)

1. `server`/`protocol` (root lockfile): refresh `fast-uri` to ≥ 4.2.3 / ≥ 3.1.9 (`npm update fast-uri`,
   lockfile-only).
2. `server`: watch `@fastify/static` for a release on a fixed `glob` (≥ 14.0.2 or as published) and bump the
   exact pin then (Dependabot, DEP-09).
3. `deploy` (DEP-09): make the `audit` job run `npm audit --omit=dev` at the root, `npm --prefix tests audit`,
   and `pip-audit` for both Python projects; record the date of its first green/known-moderate run in
   `docs/security.md` T12.
