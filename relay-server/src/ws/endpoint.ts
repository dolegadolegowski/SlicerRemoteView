/**
 * WebSocket endpoint `/ws`, part 1: upgrade, origin, handshake timeout and frame limits
 * (docs/protocol.md §3.1–§3.3, §9.3; architecture §5). The role gate, envelope validation, the
 * permissions matrix and the per-type dispatch are part 2 (`dispatch.ts`, SRV-23).
 *
 * - One `ws` server for both roles with `maxPayload` 1 MiB + 64 KiB and no `permessage-deflate`:
 *   `ws` closes an oversized message with `1009` before reading its payload.
 * - More than 30 accepted upgrades per minute from one client address (an IPv6 /64) get HTTP 429
 *   before the upgrade (§12); upgrades refused for their Origin or subprotocol do not count.
 * - A browser `Origin` outside `ALLOWED_ORIGINS` gets HTTP 403 before the upgrade; requests without
 *   `Origin` (Slicer, Unity) pass. An upgrade offering a subprotocol gets HTTP 400 (§3.1 keeps codes
 *   and tokens out of `Sec-WebSocket-Protocol`). A plain HTTP `GET /ws` is just an unknown path (404).
 * - A socket that is not bound to a session (`Connection.completeHandshake()`, called by the
 *   create/resume/join handlers) 10 s after the upgrade is closed `4012`.
 * - Text limits per role: publisher 256 KiB, viewer 16 KiB → `error PAYLOAD_TOO_LARGE` + `1009`. The
 *   first message gets the limit of the role its type would fix (16 KiB if none). Binary frames
 *   from anyone but a publisher → `error UNAUTHORIZED` + `1008`.
 * - Upgrade requests to any other route are refused with 404 before the upgrade (the plugin would
 *   otherwise accept them on every HTTP route and close them right after).
 * - Every text frame, binary frame and WebSocket `ping`/`pong` that passes the role's size limit and
 *   the binary-role check (both close the socket before parsing) is charged to the socket's message
 *   budget before it is parsed or handled (`budget.ts`): a viewer's or an unbound socket's frame the
 *   budget cannot pay is dropped — a pong too — with `error RATE_LIMITED{retryAfterS}` (sent again
 *   if it is still limited once that time has passed); a publisher is closed `RATE_LIMITED` + `4006`
 *   at once (a dropped `begin`, `end` or update would leave a snapshot or the versions half applied,
 *   §6.2, §8.1); and any socket that sends on until it owes a second burst is closed `4006`. The
 *   relay answers a client's `ping` itself (`autoPong` off), within that budget and the 8 MiB hard
 *   watermark (§3.3): a client that pings without reading cannot make the relay queue pongs beyond
 *   it, bound or not. A socket not bound yet is held to the same watermark at every frame (the
 *   fan-out only watches bound ones). Frames of a closing socket are charged too (`unread`), and a
 *   message has at most `MAX_FRAGMENTS` fragments (`1008` beyond).
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
import { messageBudgets } from "./budget.js";
import type { MessageBudgets } from "./budget.js";
import { Connection, HANDSHAKE_ROLES } from "./connection.js";
import { HARD_WATERMARK_BYTES } from "./fanout.js";
import type { Role } from "./connection.js";
import type { RateLimiter } from "../ratelimit.js";
import { readFrame } from "./frame.js";
import type { TextFrame } from "./frame.js";

export const HANDSHAKE_TIMEOUT_MS = LIMITS.HANDSHAKE_TIMEOUT_S * 1000;

/**
 * What the later tasks plug in. Hooks may be async: a synchronous throw and a rejected promise
 * are handled alike (logged as an error code; a frame hook's failure closes `INTERNAL` + `1011`).
 * Async hooks are not serialised per connection — a hook that awaits must not rely on running
 * before the connection's next frame (a failed join's jitter uses `Connection.awaitClose()`).
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
  /** The upgrade is done (the heartbeat starts watching, SRV-14). */
  opened?(connection: Connection): void;
  /** The peer sent a WebSocket-level pong (§9.1), with its payload. */
  pong?(connection: Connection, data: Buffer): void;
}

export interface WsEndpointOptions {
  allowedOrigins: readonly string[];
  clock: Clock;
  logger: Logger;
  /** Per-IP limits (SRV-08): the upgrade limit here, the client key for the message handlers. */
  limiter: RateLimiter;
  handlers: FrameHandlers;
  /** Maps an error to a code that is safe to log (`systemErrorCode` of the app). */
  errorCode: (error: unknown) => string;
  /** Per-socket message budgets (SRV-25); default `DEFAULT_MESSAGE_BUDGETS`. */
  budgets?: MessageBudgets;
}

/** Fragments per message (`ws` closes `1008` beyond them). */
export const MAX_FRAGMENTS = 64;

/** The longest pong `ws` writes for a client's ping: a 125-byte payload and a 2-byte header. */
const MAX_PONG_BYTES = 127;

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
  const { clock, logger, limiter, handlers, errorCode } = options;
  const budget = messageBudgets(clock, options.budgets);
  const allowed = new Set(options.allowedOrigins);
  /** The limiter key of each upgrade request, computed once in `checkUpgrade`. */
  const clientKeys = new WeakMap<object, string>();
  let firstUpgrade = true;
  /** Sockets no longer read while closing (`unread`): they cannot complete a close at shutdown. */
  const unreadSockets = new Set<Connection>();
  app.addHook("preClose", async () => {
    for (const connection of unreadSockets) connection.terminate();
  });

  await app.register(websocket, {
    options: {
      maxPayload: LIMITS.WS_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      // Pings are answered below, within the socket's budget and the hard watermark (SRV-25).
      autoPong: false,
      // Each fragment is decoded on its own but a message is charged once (SRV-25): clients send
      // one frame per message (browsers, Python `websockets`, .NET; `[TODO verify]` for Chromium's
      // largest messages), so 64 leaves room and a 16,384-fragment message (`ws`'s default) is
      // refused `1008` instead of costing 16,384 frames for the price of one.
      maxFragments: MAX_FRAGMENTS,
      // Never select a subprotocol (upgrades offering one are refused below; defence in depth).
      handleProtocols: () => false,
    },
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

  // Runs before the upgrade (§3.1): the cross-site WebSocket hijacking guard (FR-33), and no
  // subprotocols — codes and tokens never travel in `Sec-WebSocket-Protocol`, and selecting one
  // would reflect the client's value in the 101 response. Neither value is logged. Only then the
  // per-address upgrade limit (30/min, §12, T3): refused upgrades do not spend it, so a foreign page
  // cannot lock a shared NAT out. The key is an HMAC of the address; only the error code is logged
  // (debug: a flood must not flood the logs too).
  const checkUpgrade = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { origin } = request.headers;
    if (origin !== undefined && !allowed.has(origin)) {
      logger.debug({ errorCode: "FORBIDDEN_ORIGIN" }, "websocket upgrade refused");
      await reply.code(403).send({ error: "FORBIDDEN" });
      return;
    }
    if (!request.ws) return;
    if (request.headers["sec-websocket-protocol"] !== undefined) {
      logger.debug({ errorCode: "SUBPROTOCOL_REFUSED" }, "websocket upgrade refused");
      await reply.code(400).send({ error: "BAD_REQUEST" });
      return;
    }
    // `request.ip` is undefined once the client has gone; that request is counted as "unknown".
    const clientKey = limiter.clientKey(request.ip as string | undefined);
    // For the deploy checklist (DEP-06): whether the edge sends `X-Forwarded-For` and how many hops it
    // lists (with `TRUST_PROXY=true` but no header, or more than one internal hop, clients share one
    // limiter key), with the HMAC'd key of this client — once, never an address.
    if (firstUpgrade) {
      firstUpgrade = false;
      const header = request.headers["x-forwarded-for"];
      const forwarded = Array.isArray(header) ? header.join(",") : header;
      logger.info(
        {
          xff: forwarded === undefined ? "absent" : "present",
          ...(forwarded !== undefined && { xffEntries: forwarded.split(",").length }),
          clientKey,
        },
        "first websocket upgrade",
      );
    }
    clientKeys.set(request.raw, clientKey);
    const verdict = limiter.upgrade(clientKey);
    if (!verdict.ok) {
      logger.debug({ errorCode: "RATE_LIMITED" }, "websocket upgrade refused");
      await reply
        .code(429)
        .header("retry-after", String(verdict.retryAfterS))
        .send({ error: "RATE_LIMITED" });
    }
  };

  app.route({
    method: "GET",
    url: "/ws",
    preValidation: checkUpgrade,
    // A plain HTTP request to /ws is just another unknown path (§10).
    handler: async (_request, reply) => reply.code(404).send({ error: "NOT_FOUND" }),
    wsHandler: (socket: WebSocket, request) =>
      accept(socket, clientKeys.get(request.raw) ?? limiter.clientKey(request.ip)),
  });

  function accept(socket: WebSocket, clientKey: string): void {
    const connection = new Connection(socket, clock, clientKey);
    connection.armHandshakeTimer(HANDSHAKE_TIMEOUT_MS, () =>
      connection.close(CLOSE_CODES.HANDSHAKE_TIMEOUT),
    );

    guarded(connection, "open", () => handlers.opened?.(connection));

    socket.on("message", (data: RawData, isBinary: boolean) => {
      guarded(connection, "frame", () => onFrame(connection, asBuffer(data), isBinary));
    });

    socket.on("pong", (data: Buffer) =>
      guarded(connection, "pong", () => {
        // Pongs cost as much CPU per byte as text: charged too, a dropped one is not handled.
        if (closing(connection)) unread(connection, "text", data.byteLength);
        else if (admitted(connection, "text", data.byteLength)) handlers.pong?.(connection, data);
      }),
    );

    socket.on("ping", (data: Buffer) =>
      guarded(connection, "ping", () => onPing(connection, data)),
    );

    socket.on("close", (closeCode: number) => {
      connection.markClosed();
      unreadSockets.delete(connection);
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
    stage: "open" | "frame" | "ping" | "pong" | "close",
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

  /** `error SLOW_CONSUMER` + `4010` (§9.3), logged like the fan-out's (ids and bytes only). */
  function closeSlow(connection: Connection): void {
    logger.info(
      {
        connection: connection.id,
        role: connection.role ?? "none",
        bufferedBytes: connection.bufferedAmount,
        errorCode: "SLOW_CONSUMER",
      },
      "slow consumer closed",
    );
    connection.fail(
      "SLOW_CONSUMER",
      "the socket does not read fast enough; reconnect (§3.3)",
      CLOSE_CODES.SLOW_CONSUMER,
      { retryable: true },
    );
  }

  /**
   * Charges a frame of `bytes` to the socket's budget: false when it must not be handled — dropped
   * (the socket is told `RATE_LIMITED`), or the socket closed: `4006` for a publisher over its
   * budget or anyone two bursts over it (§9.3), `4010` for an unbound socket over the hard
   * watermark (the fan-out watches bound sockets only).
   */
  function admitted(connection: Connection, kind: "text" | "binary", bytes: number): boolean {
    const { verdict, warn, retryAfterS } = budget.charge(connection, kind, bytes);
    const publisher = connection.bound && connection.role === "publisher";
    if (verdict === "exceeded" || (verdict === "limited" && publisher)) {
      logger.info(
        { connection: connection.id, role: connection.role ?? "none", errorCode: "RATE_LIMITED" },
        "message budget exceeded: closed",
      );
      connection.fail("RATE_LIMITED", "message budget exceeded", CLOSE_CODES.RATE_LIMITED, {
        retryable: true,
        details: { retryAfterS },
      });
      return false;
    }
    if (verdict === "limited") {
      if (warn)
        connection.sendError("RATE_LIMITED", "message budget exhausted: frames are dropped", {
          retryable: true,
          details: { retryAfterS },
        });
      return false;
    }
    if (!connection.bound && connection.bufferedAmount > HARD_WATERMARK_BYTES) {
      closeSlow(connection);
      return false;
    }
    return true;
  }

  /** Reads nothing more: closing, or waiting to be closed (`Connection.awaitClose`, §12). */
  const closing = (connection: Connection): boolean => !connection.isOpen || !connection.reading;

  /**
   * A frame of a socket that is closing (or waits to be closed, `Connection.awaitClose`): never
   * handled, but charged — `ws` decodes what the peer sends until its close frame arrives, so a peer
   * that floods instead of completing the close is not read any more once it owes a second burst,
   * instead of keeping the relay busy until the close timer ends it (`Connection.close`, ≥ 5 s).
   */
  function unread(connection: Connection, kind: "text" | "binary", bytes: number): void {
    if (budget.charge(connection, kind, bytes).verdict !== "exceeded") return;
    connection.stopReading();
    unreadSockets.add(connection);
  }

  /** A client's WebSocket ping: answered within its budget and the hard watermark (§3.3). */
  function onPing(connection: Connection, data: Buffer): void {
    if (closing(connection)) return unread(connection, "text", data.byteLength);
    if (!admitted(connection, "text", data.byteLength)) return;
    if (connection.bufferedAmount + MAX_PONG_BYTES > HARD_WATERMARK_BYTES) closeSlow(connection);
    else connection.pong(data);
  }

  function onFrame(connection: Connection, frame: Buffer, isBinary: boolean): void | Promise<void> {
    if (closing(connection))
      return unread(connection, isBinary ? "binary" : "text", frame.byteLength);
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
      if (!admitted(connection, "binary", frame.byteLength)) return;
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
    if (!admitted(connection, "text", frame.byteLength)) return;
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
