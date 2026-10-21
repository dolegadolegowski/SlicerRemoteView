/**
 * The web viewer on the relay's own origin (docs/protocol.md §10; ADR 0006; architecture §8 T6).
 *
 * - `GET`/`HEAD` `/` and `/j` → `index.html` of the viewer build with `Cache-Control: no-cache`. The
 *   code travels only in the fragment (`/j#CODE`, never sent, RFC 3986 §3.5), which the viewer reads
 *   and replaces with `/j` before it connects (WEB-11). A query string is ignored — the answer never
 *   depends on it, so nothing of it is echoed, and links that messengers decorate (`?fbclid=…`) still
 *   open the viewer.
 * - `/assets/*` → the hashed files of the build with `Cache-Control: public, max-age=2592000,
 *   immutable` (30 days, §10); a precompressed `.br`/`.gz` variant is preferred when the build has
 *   one and the client accepts it (`Vary: Accept-Encoding`).
 * - The few unhashed root files of the build that `index.html` and the manifest name (WEB-17):
 *   `/manifest.webmanifest` and `/icons/<name>.png`, typed by the file server's MIME table
 *   (`application/manifest+json`, `image/png`), each with `Cache-Control: no-cache` because their
 *   names do not change with their content. They are looked up per request: `/icons/` accepts plain
 *   PNG names only (`[A-Za-z0-9][A-Za-z0-9_-]*.png`) and refuses anything else, `..` included, before
 *   any lookup; a build without them answers 404 (report 2026-10-21-web, SRV-26). The relay itself
 *   never opens a file (`fs` stays out of `src/`).
 * - Nothing else: no directory listing, no redirect, no dotfiles, no catch-all (a `/<CODE>` URL never
 *   works). The asset routes are made once from the files present at start (`wildcard: false`, ADR
 *   0006); apart from them only the root files above reach the file system. Any other path, and a
 *   path the file server refuses, is `404 {"error":"NOT_FOUND"}` without echoing the path. Other
 *   errors (`412`/`416` of a conditional or range request, a 5xx such as `EACCES` or `ELOOP`) go to
 *   the app's error handler:
 *   a code only, never a file path, and a 5xx is logged.
 *
 * In the image the viewer build sits in `public/` next to `dist/` (SRV-20, ADR 0007); a placeholder
 * `index.html` is committed for development. Symbolic links are followed (`@fastify/static`, `@fastify/send`),
 * so the build must not contain any (the SRV-20 image build refuses them).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** `relay-server/public/`, from `src/http/` (tsx) and from `dist/http/` (build) alike. */
export const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("../../public/", import.meta.url));
/** `immutable, max-age=30d` for hashed assets (§10). */
export const ASSET_MAX_AGE_S = 30 * 24 * 60 * 60;
/** The SPA entry points (§10); the code entry screen and the deep-link target. */
const VIEWER_PATHS = ["/", "/j"] as const;
const NOT_FOUND = { error: "NOT_FOUND" };
/** The web app manifest at the root of the build (WEB-17); a missing file is a 404 like any other. */
const MANIFEST_PATH = "/manifest.webmanifest";
/** Icons named by `index.html` and the manifest: plain file names only, PNG only. */
const ICON_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/;

/**
 * Registers the viewer routes; `root` holds `index.html`, `assets/` and optionally the manifest
 * and `icons/`.
 */
export async function registerStatic(
  app: FastifyInstance,
  { root }: { root: string },
): Promise<void> {
  await app.register(async (scope) => {
    // Defensive: with one route per file, the file server has no path to refuse (`..`, dotfiles and
    // malformed URLs never reach it); were it to, that is another unknown path. Anything else goes
    // on to the app's error handler (registered before this scope, `app.ts`).
    scope.setErrorHandler(async (error, _request, reply) => {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 400 || status === 403 || status === 404)
        return reply.code(404).send(NOT_FOUND);
      throw error;
    });
    await scope.register(fastifyStatic, {
      root: join(root, "assets"),
      prefix: "/assets/",
      wildcard: false,
      index: false,
      redirect: false,
      list: false,
      dotfiles: "ignore",
      immutable: true,
      maxAge: ASSET_MAX_AGE_S * 1000,
      preCompressed: true,
    });
    for (const path of VIEWER_PATHS)
      scope.get(path, (_request, reply) =>
        reply
          .header("Cache-Control", "no-cache")
          .sendFile("index.html", root, { cacheControl: false }),
      );
    scope.get(MANIFEST_PATH, (_request, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .sendFile(MANIFEST_PATH.slice(1), root, { cacheControl: false }),
    );
    // Icons: one route for the folder; only a plain PNG name reaches the file server (anything else is
    // answered here, before any file is looked up), and a missing folder or file is the file server's
    // 404. Unhashed names, so `no-cache` instead of `immutable`.
    scope.get<{ Params: { name: string } }>("/icons/:name", (request, reply) => {
      const { name } = request.params;
      if (!ICON_NAME.test(name)) return reply.code(404).send(NOT_FOUND);
      return reply
        .header("Cache-Control", "no-cache")
        .sendFile(name, join(root, "icons"), { cacheControl: false });
    });
  });
}
