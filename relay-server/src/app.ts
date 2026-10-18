/**
 * Fastify application factory (docs/protocol.md §10, architecture §5).
 *
 * `buildApp()` wires the HTTP surface without listening, so tests use `app.inject()` and
 * `src/index.ts` adds `listen()`. Per-request logging is off (request lines carry paths and
 * headers; T6) and every unknown path answers `404 {"error":"NOT_FOUND"}` without echoing it.
 */
import type { Duplex } from "node:stream";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import { LIMITS } from "@slicerremoteview/shared";
import { createLogger } from "./logger.js";
import { PROTOCOL_VERSIONS, RELAY_NAME, RELAY_VERSION } from "./version.js";

/** The `limits` object of `GET /api/version` (§10). */
export interface PublicLimits {
  maxSnapshotBytes: number;
  maxChunkBytes: number;
  maxTextBytes: number;
  maxViewers: number;
}

export interface AppOptions {
  /** Defaults to a silent logger, so `buildApp()` in tests prints nothing. */
  logger?: Logger;
  /** Effective limits announced on `GET /api/version`; defaults to the protocol maximums (§3.3). */
  limits?: PublicLimits;
  /** Live session count for `GET /healthz`; `0` until the registry exists. */
  sessionCount?: () => number;
  /** Fastify `trustProxy` (client IP from `X-Forwarded-For` behind the Railway edge). */
  trustProxy?: boolean;
  /** Clock for `uptimeS`; defaults to `Date.now`. */
  now?: () => number;
}

export const PROTOCOL_LIMITS: PublicLimits = {
  maxSnapshotBytes: LIMITS.MAX_SNAPSHOT_BYTES,
  maxChunkBytes: LIMITS.MAX_CHUNK_BYTES,
  maxTextBytes: LIMITS.MAX_TEXT_BYTES_PUBLISHER,
  maxViewers: LIMITS.MAX_VIEWERS,
};

const NOT_FOUND = { error: "NOT_FOUND" } as const;

/**
 * The `code` of a Fastify (`FST_ERR_*`), Node (`ERR_*`), HTTP parser (`HPE_*`) or system error
 * (`E*` with `errno`/`syscall`) — fixed identifiers that carry no request data and are safe to log.
 * Anything else (which could be arbitrary text, even a session code) becomes `INTERNAL`.
 */
export function systemErrorCode(error: unknown): string {
  const { code, errno, syscall } = (error ?? {}) as {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
  };
  if (typeof code !== "string") return "INTERNAL";
  if (/^(FST_ERR|ERR|HPE)_[A-Z0-9_]+$/.test(code)) return code;
  const isSystemError = typeof errno === "number" || typeof syscall === "string";
  return isSystemError && /^E[A-Z0-9]+$/.test(code) ? code : "INTERNAL";
}

/**
 * Answers a request Node's HTTP parser rejected (malformed request line, oversized headers) on
 * the raw socket. Replaces Fastify's default, which logs the error object at `trace` — including
 * `rawPacket`, the raw request bytes with any `Authorization` header (T6, T8).
 */
function clientErrorHandler(logger: Logger) {
  return (error: NodeJS.ErrnoException, socket: Duplex): void => {
    if (error.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    logger.debug({ errorCode: systemErrorCode(error) }, "http client error");
    const status =
      error.code === "HPE_HEADER_OVERFLOW"
        ? "431 Request Header Fields Too Large"
        : error.code === "ERR_HTTP_REQUEST_TIMEOUT"
          ? "408 Request Timeout"
          : "400 Bad Request";
    const body = JSON.stringify({ error: "BAD_REQUEST" });
    // Destroy once written, like Node's default: a peer that keeps its half open must not hold
    // the socket until the header timeout (and delay a shutdown drain).
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      () => socket.destroy(),
    );
  };
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const limits = options.limits ?? PROTOCOL_LIMITS;
  const sessionCount = options.sessionCount ?? (() => 0);
  const logger = options.logger ?? createLogger({ level: "silent" });

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustProxy ?? false,
    clientErrorHandler: clientErrorHandler(logger),
    // A URL that does not decode (`/7KQ4X%zz`) is just another unknown path: Fastify's default
    // answer would echo it in a 400 body and bypass the not-found handler below.
    frameworkErrors: (error, _request, reply) => {
      const plain = reply as FastifyReply;
      if (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH")
        void plain.code(404).send(NOT_FOUND);
      else void plain.code(400).send({ error: "BAD_REQUEST" });
    },
  });

  // No endpoint takes a request body (§10); without parsers a POST to an unknown path is a plain 404.
  app.removeAllContentTypeParsers();

  // `/healthz` is the Railway healthcheck target: status only, no codes, no IPs, no memory figures.
  app.get("/healthz", async () => ({
    status: "ok",
    uptimeS: Math.floor((now() - startedAt) / 1000),
    sessions: sessionCount(),
    version: RELAY_VERSION,
  }));

  app.get("/api/version", async () => ({
    name: RELAY_NAME,
    version: RELAY_VERSION,
    protocolVersions: PROTOCOL_VERSIONS,
    limits,
  }));

  // No SPA fallback and no echo of the requested path: a leaked `/7KQ4X` style URL never works (§10).
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(NOT_FOUND));

  // Fastify's default error body repeats parser and validation messages; answer with a code only.
  app.setErrorHandler(async (error, request, reply) => {
    const raw = (error as { statusCode?: unknown }).statusCode;
    const status = typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500)
      request.log.error({ errorCode: systemErrorCode(error) }, "http handler failed");
    return reply.code(status).send({ error: status >= 500 ? "INTERNAL" : "BAD_REQUEST" });
  });

  return app;
}
