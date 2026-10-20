import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ASSET_MAX_AGE_S, DEFAULT_STATIC_ROOT } from "../src/http/static.js";
import { createLogger } from "../src/logger.js";

/** A viewer build as Vite lays it out: `index.html` and hashed `assets/`. */
let root: string;
const INDEX =
  "<!doctype html><title>viewer</title><script type=module src=/assets/index-Ab12Cd34.js></script>\n";
const SCRIPT = "export const viewer = 1;\n";
const SCRIPT_BR = Buffer.from([0x1b, 0x18, 0x00, 0xf8]); // any bytes: served as they are

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "srv16-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), INDEX);
  writeFileSync(join(root, "assets", "index-Ab12Cd34.js"), SCRIPT);
  writeFileSync(join(root, "assets", "index-Ab12Cd34.js.br"), SCRIPT_BR);
  writeFileSync(join(root, "assets", ".env"), "SECRET=1\n");
  writeFileSync(join(root, "secret.txt"), "outside assets\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function get(
  url: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) {
  const app = await buildApp({ staticRoot: root });
  try {
    return await app.inject({ method, url, headers });
  } finally {
    await app.close();
  }
}

/** `Content-Security-Policy` as directive → sources. */
function csp(header: unknown): Map<string, string> {
  expect(typeof header).toBe("string");
  return new Map(
    (header as string).split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources.join(" ")] as const;
    }),
  );
}

describe("the viewer's entry points (SRV-16 criterion 1, §10, ADR 0006)", () => {
  it.each(["/", "/j"])("GET %s → 200 index.html, Cache-Control: no-cache", async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe(INDEX);
  });

  it("HEAD /j → the same headers, no body", async () => {
    const res = await get("/j", {}, "HEAD");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(INDEX)));
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe("");
  });

  it("a query string changes nothing and is not echoed (the code travels in the fragment only)", async () => {
    const res = await get("/j?code=7KQ4X&fbclid=x");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(JSON.stringify(res.headers)).not.toContain("7KQ4X");
  });

  it.each([
    "/j/anything",
    "/j/7KQ4X",
    "/j/",
    "/ABCDE",
    "/7KQ4X",
    "/join?code=7KQ4X",
    "/index.html",
    "/secret.txt",
    "/assets",
    "/assets/",
    "/assets/missing-00000000.js",
    "/assets/.env",
    "/assets/../index.html",
    "/assets/%2e%2e/secret.txt",
    "/assets/..%2fsecret.txt",
    "/assets/%00",
  ])("GET %s → 404 {error: NOT_FOUND}, no catch-all, nothing echoed", async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NOT_FOUND" });
    expect(res.body).not.toContain("7KQ4X");
    expect(res.body).not.toContain("SECRET");
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("the committed placeholder is served by default (development)", async () => {
    expect(existsSync(join(DEFAULT_STATIC_ROOT, "index.html"))).toBe(true);
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("SlicerRemoteView");
    } finally {
      await app.close();
    }
  });

  it("without a viewer build, / is a plain 404", async () => {
    const empty = mkdtempSync(join(tmpdir(), "srv16-empty-"));
    const app = await buildApp({ staticRoot: empty });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "NOT_FOUND" });
    } finally {
      await app.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("errors of the viewer routes go to the app's handler (a code only, logged)", () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } });
    return { lines, logger };
  }

  it("a failing file (ELOOP) → 500 {error: INTERNAL}, no file path in the body, one log line", async () => {
    const broken = mkdtempSync(join(tmpdir(), "srv16-loop-"));
    mkdirSync(join(broken, "assets"));
    symlinkSync("index.html", join(broken, "index.html")); // points at itself
    symlinkSync("loop-00000000.js", join(broken, "assets", "loop-00000000.js")); // gets a route all the same
    const { lines, logger } = capture();
    const app = await buildApp({ staticRoot: broken, logger });
    try {
      for (const url of ["/j", "/assets/loop-00000000.js"]) {
        lines.length = 0;
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ error: "INTERNAL" });
        const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(logged.filter((l) => l.message === "http handler failed")).toEqual([
          expect.objectContaining({ level: "error", errorCode: "ELOOP" }),
        ]);
        expect(res.body + lines.join("")).not.toContain(broken);
      }
    } finally {
      await app.close();
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it.each(["/healthz", "/api/scene/1", "/j", "/assets/index-Ab12Cd34.js"])(
    "an error thrown on %s is answered INTERNAL, its text never echoed",
    async (url) => {
      const { lines, logger } = capture();
      const app = await buildApp({ staticRoot: root, logger });
      app.addHook("onRequest", async () => {
        throw new Error("boom 7KQ4X");
      });
      try {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ error: "INTERNAL" });
        expect(lines.some((l) => l.includes("http handler failed"))).toBe(true);
        expect(lines.join("")).not.toContain("7KQ4X");
      } finally {
        await app.close();
      }
    },
  );

  it("the asset routes are made at start: a file added later is not served (wildcard: false)", async () => {
    const later = mkdtempSync(join(tmpdir(), "srv16-later-"));
    mkdirSync(join(later, "assets"));
    writeFileSync(join(later, "assets", "a-00000000.js"), SCRIPT);
    const app = await buildApp({ staticRoot: later });
    try {
      await app.ready();
      writeFileSync(join(later, "assets", "b-11111111.js"), SCRIPT);
      expect((await app.inject({ method: "GET", url: "/assets/a-00000000.js" })).statusCode).toBe(
        200,
      );
      expect((await app.inject({ method: "GET", url: "/assets/b-11111111.js" })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
      rmSync(later, { recursive: true, force: true });
    }
  });

  it.each([
    ["/assets/index-Ab12Cd34.js", { range: "bytes=9999-" }, 416],
    ["/assets/index-Ab12Cd34.js", { "if-match": '"x"' }, 412],
    ["/j", { "if-match": '"x"' }, 412],
  ] as const)("%s with %o stays %i (not a 404)", async (url, headers, status) => {
    const res = await get(url, { ...headers });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: "BAD_REQUEST" });
  });
});

describe("security headers (SRV-16 criterion 2, architecture §8 T6, ADR 0006 §4)", () => {
  it("the viewer page: CSP for the viewer only, no-referrer, HSTS, no framing", async () => {
    const res = await get("/j");
    const policy = csp(res.headers["content-security-policy"]);
    expect(policy.get("connect-src")).toBe("'self' wss:");
    expect(policy.get("default-src")).toBe("'self'");
    expect(policy.get("script-src")).toBe("'self'");
    expect(policy.get("worker-src")).toBe("'self' blob:");
    expect(policy.get("img-src")).toBe("'self' data: blob:");
    expect(policy.get("frame-ancestors")).toBe("'none'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.has("upgrade-insecure-requests")).toBe(false); // a plain-HTTP local run must work
    // Nothing from elsewhere: no `https:` source in any directive, no eval.
    expect(res.headers["content-security-policy"]).not.toContain("https:");
    expect(res.headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toMatch(/^max-age=\d{8,}; includeSubDomains$/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each(["/healthz", "/api/version", "/nope", "/api/scene/1", "/assets/index-Ab12Cd34.js"])(
    "%s carries them too",
    async (url) => {
      const res = await get(url);
      expect(csp(res.headers["content-security-policy"]).get("connect-src")).toBe("'self' wss:");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["strict-transport-security"]).toBeDefined();
    },
  );
});

describe("hashed assets (SRV-16 criterion 3, FR-28)", () => {
  it("a hashed asset is served immutable for 30 days", async () => {
    const res = await get("/assets/index-Ab12Cd34.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(`public, max-age=${ASSET_MAX_AGE_S}, immutable`);
    expect(ASSET_MAX_AGE_S).toBe(2_592_000);
    expect(res.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(res.body).toBe(SCRIPT);
  });

  it("the precompressed variant when the client accepts it", async () => {
    const res = await get("/assets/index-Ab12Cd34.js", { "accept-encoding": "br, gzip" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toMatch(/accept-encoding/i);
    expect(res.rawPayload.equals(SCRIPT_BR)).toBe(true);
    expect(res.headers["cache-control"]).toBe(`public, max-age=${ASSET_MAX_AGE_S}, immutable`);
  });

  const built = fileURLToPath(new URL("../../web-viewer/dist/", import.meta.url));
  it.skipIf(!existsSync(join(built, "index.html")))(
    "the web viewer's own build (when built): every file index.html refers to is served",
    async () => {
      const app = await buildApp({ staticRoot: built });
      try {
        const html = readFileSync(join(built, "index.html"), "utf8");
        const page = await app.inject({ method: "GET", url: "/j" });
        expect(page.statusCode).toBe(200);
        expect(page.body).toBe(html);
        const refs = [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]!);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          expect(ref.startsWith("/assets/")).toBe(true); // nothing else is served (§10)
          const asset = await app.inject({ method: "GET", url: ref });
          expect(asset.statusCode).toBe(200);
          expect(asset.headers["cache-control"]).toBe(
            `public, max-age=${ASSET_MAX_AGE_S}, immutable`,
          );
        }
      } finally {
        await app.close();
      }
    },
  );
});
