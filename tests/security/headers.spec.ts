// QA-09 (part h): security headers of the built relay — every HTTP surface of docs/protocol.md §10 answers with
// the helmet policy of ADR 0006 §4 / SRV-16 and the per-path `Cache-Control` of §10, leaks no server banner, and
// the public JSON endpoints carry no code, token or address.
//
// Requirements / threats: architecture §8 T6 (leakage via URL, Referer, logs; `Referrer-Policy: no-referrer`),
// T5-adjacent (HSTS: the relay always sends it; it only takes effect over the HTTPS edge, see below), FR-28
// (immutable assets), FR-31/NFR-15 (no credential in a URL, nothing of the query echoed), NFR-12 (no code in
// any output). Protocol §10 (HTTP endpoints, `/j?code=X`, 404 body), §5.2 (`viewerToken` for `/api/scene`).
// Plan: docs/plan/qa.md QA-09 criterion 2; docs/plan/server.md SRV-16 criterion 2.
//
// Raw `fetch` (Node 22's undici) against the harness relay on 127.0.0.1. `Headers.get()` is case-insensitive and
// joins repeated headers with ", " (Fetch standard, "get" on a header list), so one call covers duplicates too.

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../harness/fixtures.ts";
import { STAGED_RELAY_DIR } from "../harness/stage.ts";
import { joinViewer, nextIp } from "../harness/ws-client.ts";

/** A code-shaped string that is never a live session (publisher:false), for the path/query negatives. */
const FAKE_CODE = "7KQ4X";
const NOT_FOUND = { error: "NOT_FOUND" };
/** 30 days (§10 "immutable, max-age=30d"). */
const ASSET_MAX_AGE_S = 30 * 24 * 60 * 60;
/** One year: the HSTS floor that SRV-16 documents (helmet's default `max-age=31536000; includeSubDomains`). */
const HSTS_MIN_MAX_AGE_S = 365 * 24 * 60 * 60;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

/** `Content-Security-Policy` as directive → sources (names lower-cased, sources kept verbatim). */
function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/** `Cache-Control` as a set of lower-cased directives (`max-age=…` kept with its value). */
function cacheDirectives(header: string | null): Set<string> {
  return new Set((header ?? "").split(",").map((d) => d.trim().toLowerCase()).filter((d) => d !== ""));
}

/**
 * The headers every routed response carries (ADR 0006 §4, SRV-16 criterion 2, architecture §8 T6). `where` names
 * the request in failure messages; it never holds a code or token.
 */
function expectSecurityHeaders(headers: Headers, where: string): void {
  const csp = headers.get("content-security-policy");
  expect(csp, `${where}: Content-Security-Policy`).not.toBeNull();
  const policy = parseCsp(csp!);
  // No `unsafe-eval` anywhere, and scripts only from the relay's own origin: no inline script, no third party.
  expect(csp!.includes("'unsafe-eval'"), `${where}: CSP allows 'unsafe-eval'`).toBe(false);
  expect(policy.get("default-src"), `${where}: default-src`).toEqual(["'self'"]);
  const scriptSrc = policy.get("script-src") ?? policy.get("default-src")!;
  expect(scriptSrc, `${where}: script-src`).toEqual(["'self'"]);
  expect(policy.get("script-src-attr"), `${where}: script-src-attr`).toEqual(["'none'"]);
  // §10 / SRV-16: `connect-src 'self' wss:` exactly (no `https:`, no `ws:`), `worker-src 'self' blob:`.
  expect(policy.get("connect-src"), `${where}: connect-src`).toEqual(["'self'", "wss:"]);
  expect(policy.get("worker-src"), `${where}: worker-src`).toEqual(["'self'", "blob:"]);
  expect(policy.get("img-src"), `${where}: img-src`).toEqual(["'self'", "data:", "blob:"]);
  expect(policy.get("object-src"), `${where}: object-src`).toEqual(["'none'"]);
  expect(policy.get("frame-ancestors"), `${where}: frame-ancestors`).toEqual(["'none'"]);
  // ADR 0006 §4 allows `'unsafe-inline'` for styles only (Vite fallback); no directive admits any origin.
  for (const [name, sources] of policy)
    for (const source of sources)
      expect(
        source === "*" || /^(https?|ws):$/i.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source),
        `${where}: CSP ${name} admits a foreign origin (${source})`,
      ).toBe(false);

  // HSTS (SRV-16): sent on every response, also over the plain-HTTP harness. Browsers ignore it there (RFC 6797
  // §8.1: a UA must ignore STS received over non-secure transport), so it is harmless locally and effective
  // behind the Railway TLS edge; that it really arrives over `https://` is DEP-06's manual check (T5).
  const hsts = headers.get("strict-transport-security");
  expect(hsts, `${where}: Strict-Transport-Security`).not.toBeNull();
  const maxAge = /(?:^|;)\s*max-age=(\d+)\s*(?:;|$)/i.exec(hsts!);
  expect(maxAge, `${where}: HSTS max-age`).not.toBeNull();
  expect(Number(maxAge![1]), `${where}: HSTS max-age ≥ 1 year`).toBeGreaterThanOrEqual(HSTS_MIN_MAX_AGE_S);
  expect(/(?:^|;)\s*includesubdomains\s*(?:;|$)/i.test(hsts!), `${where}: HSTS includeSubDomains`).toBe(true);

  expect(headers.get("referrer-policy"), `${where}: Referrer-Policy`).toBe("no-referrer");
  expect(headers.get("x-content-type-options"), `${where}: X-Content-Type-Options`).toBe("nosniff");
  expect(headers.get("x-frame-options"), `${where}: X-Frame-Options`).toBe("DENY");
  expectNoBanner(headers, where);
}

/** No software/version banner (Fastify sends neither by default; a proxy or plugin must not add one). */
function expectNoBanner(headers: Headers, where: string): void {
  expect(headers.get("server"), `${where}: Server header`).toBeNull();
  expect(headers.get("x-powered-by"), `${where}: X-Powered-By header`).toBeNull();
}

/** The first file of the staged viewer build's `dir` matching `pattern` (the hashed names change per build). */
function stagedFile(dir: string, pattern: RegExp): string | undefined {
  try {
    return readdirSync(path.join(STAGED_RELAY_DIR, "public", dir)).find((name) => pattern.test(name));
  } catch {
    return undefined;
  }
}

/** One GET (or HEAD) without following redirects: a redirect would itself be a finding. */
async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: "manual", ...init });
}

test.describe("headers on every HTTP surface (no publisher)", () => {
  // An empty `METRICS_TOKEN` counts as unset (config.ts), so `/metrics` is disabled even if the caller's shell sets it.
  test.use({ stackOptions: { publisher: false, env: { METRICS_TOKEN: "" } } });

  for (const target of ["/", "/j", `/j?code=${FAKE_CODE}`, `/j?fbclid=abc&code=${FAKE_CODE}`]) {
    test(`GET ${target} → viewer HTML, no-cache, full header set`, async ({ stack }) => {
      const response = await get(stack.baseUrl + target);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html\b/);
      const cache = cacheDirectives(response.headers.get("cache-control"));
      expect(cache.has("no-cache"), "the viewer entry is served with Cache-Control: no-cache (§10)").toBe(true);
      expect(cache.has("immutable"), "the viewer entry must not be immutable").toBe(false);
      expectSecurityHeaders(response.headers, `GET ${target}`);
      const body = await response.text();
      // §10: the query changes nothing and nothing of it is echoed.
      expect(body.includes(FAKE_CODE), `GET ${target} echoed the query`).toBe(false);
      if (target !== "/j") {
        const plain = await (await get(stack.baseUrl + "/j")).text();
        expect(body === plain, `GET ${target} differs from GET /j`).toBe(true);
      }
    });
  }

  test("HEAD / and HEAD /j carry the same headers", async ({ stack }) => {
    for (const target of ["/", "/j"]) {
      const response = await get(stack.baseUrl + target, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(cacheDirectives(response.headers.get("cache-control")).has("no-cache")).toBe(true);
      expectSecurityHeaders(response.headers, `HEAD ${target}`);
    }
  });

  test("GET /assets/* (hashed JS and CSS) → public, max-age=30d, immutable", async ({ stack }) => {
    const js = stagedFile("assets", /\.js$/);
    const css = stagedFile("assets", /\.css$/);
    expect(js, "the staged viewer build has a hashed .js asset").toBeDefined();
    for (const name of [js!, ...(css ? [css] : [])]) {
      const response = await get(`${stack.baseUrl}/assets/${name}`);
      expect(response.status, `GET /assets/${name}`).toBe(200);
      expect(response.headers.get("content-type")).toMatch(name.endsWith(".js") ? /javascript/ : /^text\/css\b/);
      const cache = cacheDirectives(response.headers.get("cache-control"));
      expect(cache.has("immutable"), `/assets/${name} immutable`).toBe(true);
      expect(cache.has(`max-age=${ASSET_MAX_AGE_S}`), `/assets/${name} max-age=${ASSET_MAX_AGE_S}`).toBe(true);
      expect(cache.has("private") || cache.has("no-store"), `/assets/${name} must be cacheable`).toBe(false);
      expectSecurityHeaders(response.headers, `GET /assets/${name}`);
      await response.arrayBuffer();
    }
  });

  test("GET /manifest.webmanifest and /icons/*.png → no-cache, full header set", async ({ stack }) => {
    const targets = ["/manifest.webmanifest"];
    const icon = stagedFile("icons", /^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/);
    if (icon) targets.push(`/icons/${icon}`);
    for (const target of targets) {
      const response = await get(stack.baseUrl + target);
      // §10: 404 when the build has no manifest; the staged viewer build has one.
      expect(response.status, `GET ${target}`).toBe(200);
      // §10: `application/manifest+json` and `image/png`; with `nosniff` the declared type is the one used.
      expect(response.headers.get("content-type"), `GET ${target} Content-Type`).toMatch(
        target.endsWith(".png") ? /^image\/png\b/ : /^application\/manifest\+json\b/,
      );
      expect(cacheDirectives(response.headers.get("cache-control")).has("no-cache"), `${target} no-cache`).toBe(true);
      expectSecurityHeaders(response.headers, `GET ${target}`);
      await response.arrayBuffer();
    }
  });

  test("GET /healthz → JSON with relay-wide counts only, full header set", async ({ stack }) => {
    const response = await get(stack.baseUrl + "/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
    expectSecurityHeaders(response.headers, "GET /healthz");
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    // §10: status, uptimeS, sessions, viewers, version — nothing per session, no codes, IPs or tokens.
    expect(Object.keys(body).sort()).toEqual(["sessions", "status", "uptimeS", "version", "viewers"]);
    expect(body).toMatchObject({ status: "ok", sessions: 0, viewers: 0 });
    expect(IPV4.test(text) || text.includes("::1") || text.includes("localhost"), "/healthz names an address").toBe(
      false,
    );
  });

  test("GET /api/version → JSON with name, versions and limits only, full header set", async ({ stack }) => {
    const response = await get(stack.baseUrl + "/api/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
    expectSecurityHeaders(response.headers, "GET /api/version");
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["limits", "name", "protocolVersions", "version"]);
    expect(body["protocolVersions"]).toContain("1.0");
    expect(IPV4.test(text) || text.includes("::1") || text.includes("localhost"), "/api/version names an address").toBe(
      false,
    );
  });

  test("GET /api/scene/1 without a token → 401 UNAUTHORIZED, Bearer challenge, full header set", async ({
    stack,
  }) => {
    const response = await get(stack.baseUrl + "/api/scene/1");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer\b/i);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    expectSecurityHeaders(response.headers, "GET /api/scene/1 (401)");
  });

  // §10: any other path → 404 {"error":"NOT_FOUND"}, no SPA fallback, no echo of a code-shaped path or query.
  for (const target of [
    "/does-not-exist",
    `/${FAKE_CODE}`,
    `/j/${FAKE_CODE}`,
    `/join?code=${FAKE_CODE}`,
    `/api/scene/1?code=${FAKE_CODE}`,
    "/index.html",
    "/assets/",
    "/assets/%2e%2e/index.html",
    "/icons/manifest.webmanifest",
    // §10: `/metrics` is disabled (404) while `METRICS_TOKEN` is unset (see `test.use` above).
    "/metrics",
  ]) {
    test(`GET ${target} → 404 NOT_FOUND without echo, full header set`, async ({ stack }) => {
      const response = await get(stack.baseUrl + target);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(NOT_FOUND);
      expect(text.includes(FAKE_CODE), `GET ${target} echoed the path or query`).toBe(false);
      expectSecurityHeaders(response.headers, `GET ${target} (404)`);
    });
  }

  // §10 lists methods with each path: anything else (here POST to the routed paths) is "any other path" → 404.
  test("POST / | /j | /healthz | /api/scene/1 → 404 NOT_FOUND, full header set", async ({ stack }) => {
    for (const target of ["/", "/j", "/healthz", "/api/scene/1"]) {
      const response = await get(stack.baseUrl + target, { method: "POST", body: "x" });
      expect(response.status, `POST ${target}`).toBe(404);
      expect(JSON.parse(await response.text()), `POST ${target} body`).toEqual(NOT_FOUND);
      expectSecurityHeaders(response.headers, `POST ${target} (404)`);
    }
  });

  test("a URL that does not decode → 404 NOT_FOUND without echo and without a banner", async ({ stack }) => {
    // Fastify answers these from its frameworkErrors hook before helmet's onRequest hook runs, so this 404 has no
    // helmet headers — documented in SRV-16 ("not the 404s of URLs that do not decode"); it is a JSON body of a
    // fixed string, so only the body, the absent echo and the absent banner are asserted here.
    const response = await get(`${stack.baseUrl}/${FAKE_CODE}%zz`);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(NOT_FOUND);
    expect(text.includes(FAKE_CODE), "the undecodable path was echoed").toBe(false);
    expectNoBanner(response.headers, "GET /<code>%zz (404)");
  });
});

test.describe("headers with a live session (fake-slicer publisher)", () => {
  test("GET/HEAD /api/scene/<version> with a viewerToken → 200 GLB, private, no-store, full header set", async ({
    stack,
  }) => {
    const { client, joined } = await joinViewer(stack.wsUrl, stack.code, { ip: nextIp() });
    try {
      const token = joined["viewerToken"];
      const snapshot = joined["snapshot"] as { sceneVersion?: unknown } | undefined;
      expect(typeof token === "string", "viewer.joined carries a viewerToken").toBe(true);
      expect(typeof snapshot?.sceneVersion, "viewer.joined announces the cached snapshot").toBe("number");
      const url = `${stack.baseUrl}/api/scene/${String(snapshot!.sceneVersion)}`;
      for (const method of ["GET", "HEAD"]) {
        const response = await get(url, { method, headers: { Authorization: `Bearer ${String(token)}` } });
        expect(response.status, `${method} /api/scene/<version>`).toBe(200);
        expect(response.headers.get("content-type")).toBe("model/gltf-binary");
        const cache = cacheDirectives(response.headers.get("cache-control"));
        // §10: `Cache-Control: private, no-store` — no shared or browser cache keeps scene bytes (NFR-10).
        expect(cache.has("private") && cache.has("no-store"), `${method} /api/scene private, no-store`).toBe(true);
        expect(cache.has("public") || cache.has("immutable"), `${method} /api/scene must not be cacheable`).toBe(false);
        expectSecurityHeaders(response.headers, `${method} /api/scene/<version> (200)`);
        // The token never comes back in a response header (T6).
        let echoed = false;
        response.headers.forEach((value) => (echoed ||= value.includes(String(token))));
        expect(echoed, `${method} /api/scene echoed the viewerToken in a header`).toBe(false);
        await response.arrayBuffer();
      }

      // The refusals of the same route carry the same headers and no scene bytes (§10).
      const refusals: [string, Record<string, string>, number, string][] = [
        // A well-formed bearer value that is no viewer's token → 401.
        [url, { Authorization: `Bearer vt_${"A".repeat(43)}` }, 401, "UNAUTHORIZED"],
        // The real token, a version other than the cached one → 404 (the viewer would send `scene.request`).
        [
          `${stack.baseUrl}/api/scene/${String(Number(snapshot!.sceneVersion) + 1000)}`,
          { Authorization: `Bearer ${String(token)}` },
          404,
          "NOT_FOUND",
        ],
      ];
      for (const [target, headers, status, error] of refusals) {
        const response = await get(target, { headers });
        expect(response.status, `GET /api/scene refusal ${error}`).toBe(status);
        expect(await response.json(), `GET /api/scene refusal ${error} body`).toEqual({ error });
        expectSecurityHeaders(response.headers, `GET /api/scene/<version> (${status})`);
      }
    } finally {
      client.close();
    }
  });

  test("the live code in /j?code= is not echoed; /healthz and /api/version never carry it", async ({ stack }) => {
    const code = stack.code;
    const response = await get(`${stack.baseUrl}/j?code=${code}`);
    expect(response.status).toBe(200);
    expectSecurityHeaders(response.headers, "GET /j?code=<live code>");
    const body = await response.text();
    expect(body.includes(code), "GET /j?code= echoed the live code").toBe(false);
    let inHeaders = false;
    response.headers.forEach((value) => (inHeaders ||= value.includes(code)));
    expect(inHeaders, "GET /j?code= echoed the live code in a header").toBe(false);
    expect(body === (await (await get(stack.baseUrl + "/j")).text()), "GET /j?code= differs from GET /j").toBe(true);

    // A live code in a path or a query is still "any other path" (§10): 404, nothing echoed, full header set.
    for (const [target, where] of [
      [`/${code}`, "/<live code>"],
      [`/j/${code}`, "/j/<live code>"],
      [`/join?code=${code}`, "/join?code=<live code>"],
    ]) {
      const notFound = await get(stack.baseUrl + target);
      expect(notFound.status, `GET ${where}`).toBe(404);
      expectSecurityHeaders(notFound.headers, `GET ${where} (404)`);
      expect((await notFound.text()).includes(code), `GET ${where} echoed the code`).toBe(false);
    }

    for (const target of ["/healthz", "/api/version"]) {
      const text = await (await get(stack.baseUrl + target)).text();
      expect(text.includes(code), `${target} carries the live code`).toBe(false);
      expect(IPV4.test(text), `${target} names an address`).toBe(false);
    }
    const health = (await (await get(stack.baseUrl + "/healthz")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", sessions: 1 });
  });
});

test.describe("/metrics enabled (METRICS_TOKEN set)", () => {
  // A fresh per-run test secret (config.ts: printable ASCII, ≥ 32 characters); never printed or logged.
  const metricsToken = randomBytes(32).toString("base64url");
  test.use({ stackOptions: { env: { METRICS_TOKEN: metricsToken } } });

  test("GET /metrics → 401 without the token, 200 text no-store with it, full header set, no code or address", async ({
    stack,
  }) => {
    const refused = await get(stack.baseUrl + "/metrics");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer\b/i);
    expect(await refused.json()).toEqual({ error: "UNAUTHORIZED" });
    expectSecurityHeaders(refused.headers, "GET /metrics (401)");

    const response = await get(stack.baseUrl + "/metrics", { headers: { Authorization: `Bearer ${metricsToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain\b/);
    expect(cacheDirectives(response.headers.get("cache-control")).has("no-store"), "/metrics no-store").toBe(true);
    expectSecurityHeaders(response.headers, "GET /metrics (200)");
    let echoed = false;
    response.headers.forEach((value) => (echoed ||= value.includes(metricsToken)));
    expect(echoed, "/metrics echoed METRICS_TOKEN in a header").toBe(false);
    const text = await response.text();
    // §10: counters only — with a live session (the fake-slicer publisher), still no code, token or address.
    expect(text.includes(stack.code), "/metrics carries the live code").toBe(false);
    expect(text.includes(metricsToken), "/metrics carries METRICS_TOKEN").toBe(false);
    expect(IPV4.test(text), "/metrics names an address").toBe(false);
  });
});
