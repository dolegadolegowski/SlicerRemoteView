/**
 * The cached scene over HTTP (docs/protocol.md §10, §6.5, §12; architecture §5): `GET` and `HEAD`
 * `/api/scene/:sceneVersion` with `Authorization: Bearer <viewerToken>`.
 *
 * Checked in this order: a request target other than exactly `/api/scene/<canonical decimal>` — a
 * query string, a fragment, percent-encoding — → `404` (§10: no credential ever travels in a URL,
 * and nothing of the URL is echoed); no `Bearer` token (scheme case-insensitive, RFC 9110 §11.1) →
 * `401` (`WWW-Authenticate: Bearer`); the token of a viewer entry of a live session
 * (connected or not) → at most 30 requests per minute per token (`429` + `Retry-After`, §12); the
 * token of a session that ended less than `CODE_QUARANTINE_S` ago → `410`; any other token → `401`;
 * a version other than the cached one → `404` (the viewer sends `scene.request`, §8.3). Otherwise
 * `200 model/gltf-binary` with the cached `Buffer` (Node's socket handles backpressure, §6.5),
 * `Content-Length`, `ETag: "<sha256>"`, `X-Scene-Version` and `Cache-Control: private, no-store`;
 * `HEAD` answers the same headers without a body. Every other body is `{"error": <code>}` (plus
 * `retryAfterS` with `429`). Logs carry ids, versions, byte counts and error codes, never the token.
 *
 * A download holds the `Buffer` it sends, so `sceneDownloads` ends it when that `Buffer` leaves the
 * cache — the session ends (NFR-10) or a newer snapshot replaces it (§6.4) — and when its connection
 * has been inactive for `SCENE_STALL_MS` (like the WebSocket "stuck" rule, §3.3): no scene bytes
 * outlive `MAX_TOTAL_SNAPSHOT_BYTES` because a reader stopped reading.
 */
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import type { Clock } from "../clock.js";
import type { Metrics } from "../metrics.js";
import type { Registry, Session, Viewer } from "../registry.js";

/** `GET /api/scene` 30/min per token (§12). */
export const SCENE_FETCHES_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
/** A download whose connection has been inactive this long is dropped (like `STUCK_MS`, §3.3). */
export const SCENE_STALL_MS = 60_000;
/** The whole raw target: canonical decimal (no sign, no leading zero, ≤ 10 digits), nothing else. */
const TARGET = /^\/api\/scene\/(0|[1-9][0-9]{0,9})$/;
/** `vt_` + 43 base64url symbols in practice; a loose bound keeps garbage out of the hash. */
const BEARER = /^bearer +([A-Za-z0-9_-]{16,128})$/i;
const NOT_FOUND = { error: "NOT_FOUND" };

/** The scene downloads in progress, ended when the `Buffer` they send leaves the cache. */
export function sceneDownloads({
  registry,
  stallMs = SCENE_STALL_MS,
}: {
  registry: Registry;
  stallMs?: number;
}) {
  interface Download {
    session: Session;
    socket: Socket;
  }
  /** The socket-level watch shared by the downloads of one connection. */
  interface Connection {
    downloads: Set<Download>;
    stalled: () => void;
    closed: () => void;
  }
  const inFlight = new Map<Session, Set<Download>>();
  const connections = new WeakMap<Socket, Connection>();

  /**
   * Follows one download until its response or its connection closes. Both are watched: a
   * pipelined response queued behind another one has no socket yet and never emits `close` when
   * the connection dies. The stall deadline is the connection's inactivity timeout, which also
   * reaches such queued responses. One pair of listeners per connection, however many downloads
   * are pipelined on it.
   */
  function track(session: Session, response: ServerResponse, socket: Socket): void {
    if (socket.destroyed) return; // gone before the handler ran: nothing will be sent
    const download: Download = { session, socket };
    let downloads = inFlight.get(session);
    if (downloads === undefined) inFlight.set(session, (downloads = new Set()));
    downloads.add(download);
    let connection = connections.get(socket);
    if (connection === undefined) {
      const watched: Connection = {
        downloads: new Set(),
        stalled: () => void socket.destroy(),
        closed: () => {
          for (const each of [...watched.downloads]) forget(each);
        },
      };
      connections.set(socket, (connection = watched));
      socket.setTimeout(stallMs);
      socket.on("timeout", watched.stalled);
      socket.once("close", watched.closed);
    }
    connection.downloads.add(download);
    response.once("close", () => forget(download));
  }

  function forget(download: Download): void {
    const { session, socket } = download;
    const downloads = inFlight.get(session);
    if (downloads?.delete(download) === true && downloads.size === 0) inFlight.delete(session);
    const connection = connections.get(socket);
    if (connection?.downloads.delete(download) !== true || connection.downloads.size > 0) return;
    socket.off("timeout", connection.stalled);
    socket.off("close", connection.closed);
    connections.delete(socket);
  }

  /** Ends the session's downloads: their entries go at once and their connections are destroyed. */
  function end(session: Session): void {
    for (const download of [...(inFlight.get(session) ?? [])]) {
      forget(download);
      download.socket.destroy();
    }
  }

  const released = (session: Session): void => end(session);
  registry.on("released", released);

  return {
    track,
    /**
     * A newer snapshot was just cached: the session's downloads all send the previous `Buffer` (it
     * runs at the swap, before any request could fetch the new one) and end with it (§6.4).
     */
    replaced: (session: Session): void => end(session),
    /** Downloads in progress (tests, metrics). */
    get size(): number {
      let total = 0;
      for (const downloads of inFlight.values()) total += downloads.size;
      return total;
    },
    /** Sessions with a download in progress (tests). */
    get sessions(): number {
      return inFlight.size;
    },
    /** Detaches from the registry (a shutdown's `server.close()` ends the downloads itself). */
    dispose: (): void => {
      registry.off("released", released);
    },
  };
}

export type SceneDownloads = ReturnType<typeof sceneDownloads>;

export interface SceneRouteDeps {
  registry: Registry;
  clock: Clock;
  logger: Logger;
  downloads: SceneDownloads;
  /** Counts refusals and the GLB bytes sent (`/metrics`, SRV-19). */
  metrics?: Metrics;
}

export function registerSceneRoute(
  app: FastifyInstance,
  { registry, clock, logger, downloads, metrics }: SceneRouteDeps,
): void {
  /** Request times of the last minute per viewer entry; they go with the entry. */
  const fetches = new WeakMap<Viewer, number[]>();

  /** Counts one request; the seconds to wait when it is over the limit. */
  function overLimit(viewer: Viewer): number | undefined {
    const now = clock.now();
    const recent = (fetches.get(viewer) ?? []).filter((at) => now - at < MINUTE_MS);
    fetches.set(viewer, recent);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= SCENE_FETCHES_PER_MINUTE)
      return Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000));
    recent.push(now);
    return undefined;
  }

  const unauthorized = (reply: FastifyReply) =>
    reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "UNAUTHORIZED" });

  app.get("/api/scene/:sceneVersion", async (request, reply) => {
    const target = TARGET.exec(request.url);
    if (target === null) return reply.code(404).send(NOT_FOUND);
    const sceneVersion = Number(target[1]);
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) return unauthorized(reply);
    const found = registry.viewerByToken(token);
    if (found === undefined) {
      if (!registry.tokenEnded(token)) return unauthorized(reply);
      logger.debug({ errorCode: "GONE" }, "scene fetch refused");
      return reply.code(410).send({ error: "GONE" });
    }
    const { session, viewer } = found;
    const retryAfterS = overLimit(viewer);
    if (retryAfterS !== undefined) {
      metrics?.rateLimited("scene");
      logger.debug(
        { sessionId: session.id, viewerId: viewer.id, errorCode: "RATE_LIMITED" },
        "scene fetch refused",
      );
      return reply
        .code(429)
        .header("Retry-After", String(retryAfterS))
        .send({ error: "RATE_LIMITED", retryAfterS });
    }
    const snapshot = session.snapshot;
    if (snapshot?.sceneVersion !== sceneVersion) return reply.code(404).send(NOT_FOUND);
    logger.info(
      {
        sessionId: session.id,
        viewerId: viewer.id,
        sceneVersion,
        byteLength: snapshot.byteLength,
        method: request.method,
      },
      "scene fetched",
    );
    downloads.track(session, reply.raw, request.raw.socket);
    if (request.method === "GET") metrics?.relayed(snapshot.byteLength);
    return reply
      .code(200)
      .header("Content-Type", "model/gltf-binary")
      .header("ETag", `"${snapshot.sha256}"`)
      .header("X-Scene-Version", String(sceneVersion))
      .header("Cache-Control", "private, no-store")
      .send(snapshot.buffer);
  });
}
