/**
 * WebSocket endpoint `/ws`, part 1: upgrade, origin, handshake timeout and frame limits
 * (docs/protocol.md §3.1–§3.3, §9.3; architecture §5). The role gate, envelope validation, the
 * permissions matrix and the per-type dispatch are part 2 (`dispatch.ts`, SRV-23).
 *
 * - One `ws` server for both roles with `maxPayload` 1 MiB + 64 KiB and no `permessage-deflate`:
 *   `ws` closes an oversized message with `1009` before reading its payload.
 * - A browser `Origin` outside `ALLOWED_ORIGINS` gets HTTP 403 before the upgrade; requests without
 *   `Origin` (Slicer, Unity) pass. A plain HTTP `GET /ws` is just an unknown path (404).
 * - A socket that is not bound to a session (`Connection.completeHandshake()`, called by the
 *   create/resume/join handlers) 10 s after the upgrade is closed `4012`.
 * - Text limits per role: publisher 256 KiB, viewer 16 KiB → `error PAYLOAD_TOO_LARGE` + `1009`. The
 *   first message gets the limit of the role its type would fix (16 KiB if none). Binary frames
 *   from anyone but a publisher → `error UNAUTHORIZED` + `1008`.
 * - Upgrade requests to any other route are refused with 404 before the upgrade (the plugin would
 *   otherwise accept them on every HTTP route and close them right after).
 * - `message` listeners catch everything themselves (`@fastify/websocket` error handlers do not
 *   see them): an unexpected failure answers `error INTERNAL` + `1011` and logs only an error code.
 */
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Clock } from "../clock.js";
import { Connection, HANDSHAKE_ROLES } from "./connection.js";
import type { Role } from "./connection.js";
import { readFrame } from "./frame.js";
import type { TextFrame } from "./frame.js";

export const HANDSHAKE_TIMEOUT_MS = LIMITS.HANDSHAKE_TIMEOUT_S * 1000;

/**
 * What the later tasks plug in. Hooks may be async: a synchronous throw and a rejected promise
 * are handled alike (logged as an error code; a frame hook's failure closes `INTERNAL` + `1011`).
 * Async hooks are not serialised per connection — a hook that awaits (e.g. the join jitter of
 * SRV-07) must not rely on running before the connection's next frame.
 */
export interface FrameHandlers {
  /**
   * A text frame within the role's size limit, parsed once (`frame.ts`); `connection.role` is
   * `undefined` for the first one.
   */
  text(connection: Connection, frame: TextFrame): void | Promise<void>;
  /** A binary frame from a publisher (snapshot chunks, SRV-09). */
  binary(connection: Connection, frame: Buffer): void | Promise<void>;
  /** The socket closed, by either side. */
  closed(connection: Connection, closeCode: number): void | Promise<void>;
}

export interface WsEndpointOptions {
  allowedOrigins: readonly string[];
  clock: Clock;
  logger: Logger;
  handlers: FrameHandlers;
  /** Maps an error to a code that is safe to log (`systemErrorCode` of the app). */
  errorCode: (error: unknown) => string;
}

function textLimit(role: Role | undefined): number {
  return role === "publisher" ? LIMITS.MAX_TEXT_BYTES_PUBLISHER : LIMITS.MAX_TEXT_BYTES_VIEWER;
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Registers `@fastify/websocket` and the `/ws` route. Must run before any other route is added:
 * the plugin wraps every route registered after it to intercept upgrade requests.
 */
export async function registerWsEndpoint(
  app: FastifyInstance,
  options: WsEndpointOptions,
): Promise<void> {
  const { clock, logger, handlers, errorCode } = options;
  const allowed = new Set(options.allowedOrigins);

  await app.register(websocket, {
    options: { maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES, perMessageDeflate: false },
    // Called for `error` events of an established socket and for errors thrown by the route
    // handler. The default logs the whole error and terminates the socket, which would drop the
    // close frame `ws` has just queued (e.g. `1009` for an oversized message).
    errorHandler: (error, socket) => {
      logger.debug({ errorCode: errorCode(error) }, "websocket error");
      if (socket.readyState === WebSocket.OPEN) socket.close(CLOSE_CODES.INTERNAL_ERROR);
    },
  });

  // `/ws` is the only WebSocket endpoint (§10): refuse upgrades elsewhere before they happen.
  app.addHook("onRequest", async (request, reply) => {
    if (request.ws && request.routeOptions.url !== "/ws")
      await reply.code(404).send({ error: "NOT_FOUND" });
  });

  // Cross-site WebSocket hijacking guard (§3.1, FR-33): runs before the upgrade.
  const checkOrigin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { origin } = request.headers;
    if (origin !== undefined && !allowed.has(origin)) {
      logger.info({ errorCode: "FORBIDDEN_ORIGIN" }, "websocket upgrade refused");
      await reply.code(403).send({ error: "FORBIDDEN" });
    }
  };

  app.route({
    method: "GET",
    url: "/ws",
    preValidation: checkOrigin,
    // A plain HTTP request to /ws is just another unknown path (§10).
    handler: async (_request, reply) => reply.code(404).send({ error: "NOT_FOUND" }),
    wsHandler: (socket: WebSocket) => accept(socket),
  });

  function accept(socket: WebSocket): void {
    const connection = new Connection(socket, clock);
    connection.armHandshakeTimer(HANDSHAKE_TIMEOUT_MS, () =>
      connection.close(CLOSE_CODES.HANDSHAKE_TIMEOUT),
    );

    socket.on("message", (data: RawData, isBinary: boolean) => {
      guarded(connection, "frame", () => onFrame(connection, asBuffer(data), isBinary));
    });

    socket.on("close", (closeCode: number) => {
      connection.markClosed();
      guarded(connection, "close", () => handlers.closed(connection, closeCode));
      logger.debug(
        { connection: connection.id, role: connection.role ?? "none", closeCode },
        "websocket closed",
      );
    });
  }

  /**
   * Runs a hook so that neither a throw nor a rejected promise escapes: listeners of `ws` events are
   * outside Fastify's error handling, and an unhandled rejection would stop the whole relay.
   */
  function guarded(
    connection: Connection,
    stage: "frame" | "close",
    run: () => void | Promise<void>,
    replyTo?: string,
  ): void {
    const failed = (error: unknown): void => {
      logger.error(
        { errorCode: errorCode(error), connection: connection.id },
        `websocket ${stage} handler failed`,
      );
      if (stage === "frame")
        connection.fail("INTERNAL", "unexpected relay failure", CLOSE_CODES.INTERNAL_ERROR, {
          replyTo,
          retryable: true,
        });
    };
    try {
      const result = run();
      if (result instanceof Promise) result.catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  function onFrame(connection: Connection, frame: Buffer, isBinary: boolean): void | Promise<void> {
    if (!connection.isOpen) return;
    if (isBinary) {
      // Snapshot chunks only from a publisher whose session exists (§3.2, §11).
      if (connection.role !== "publisher" || !connection.bound) {
        connection.fail(
          "UNAUTHORIZED",
          "binary frames are accepted only from the publisher of a session (§3.2)",
          CLOSE_CODES.POLICY_VIOLATION,
          { retryable: false },
        );
        return;
      }
      return handlers.binary(connection, frame);
    }
    const tooBig = (limit: number, replyTo?: string): boolean => {
      if (frame.byteLength <= limit) return false;
      connection.fail(
        "PAYLOAD_TOO_LARGE",
        `text message above ${limit} bytes (§3.3)`,
        CLOSE_CODES.MESSAGE_TOO_BIG,
        { replyTo, retryable: false, details: { maxTextBytes: limit } },
      );
      return true;
    };
    // Before the role is known, nothing above the publisher limit is even parsed.
    if (tooBig(textLimit(connection.role ?? "publisher"))) return;
    // The only JSON.parse of this frame: the dispatcher works on its result.
    const textFrame = readFrame(frame.toString("utf8"));
    // The first message's own type decides its limit: 256 KiB for session.create/resume (§3.3
    // allows unknown fields, §14), 16 KiB for viewer.join and for anything that is no handshake.
    // The role itself is fixed by the dispatcher, after the protocol version check (§2).
    if (
      connection.role === undefined &&
      tooBig(textLimit(HANDSHAKE_ROLES.get(textFrame.type ?? "")), textFrame.id)
    )
      return;
    // A failure answers the frame it was handling (`replyTo`, §3.2).
    guarded(connection, "frame", () => handlers.text(connection, textFrame), textFrame.id);
  }
}
