/**
 * Fastify application factory (docs/protocol.md §10, architecture §5).
 *
 * `buildApp()` wires the HTTP surface without listening, so tests use `app.inject()` and
 * `src/index.ts` adds `listen()`. Per-request logging is off (request lines carry paths and
 * headers; T6) and every unknown path answers `404 {"error":"NOT_FOUND"}` without echoing it.
 *
 * `app.drain()` is the SIGTERM drain (SRV-17, architecture §5, §9.3 `4008`): from then on
 * `/healthz` answers `503` and upgrades are refused `503`; every socket is closed `4008` — no
 * `session.*` message, sessions do not survive a restart — and gets `shutdownFlushMs()` to complete
 * its close; the ones left are terminated. It resolves when no socket is left; the caller then closes the app.
 */
import type { Duplex } from "node:stream";
import { getHeapStatistics } from "node:v8";
import helmet from "@fastify/helmet";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import { CLOSE_CODES, defaultSchemas } from "@slicerremoteview/shared";
import { systemClock } from "./clock.js";
import type { Clock, TimerHandle } from "./clock.js";
import { loadConfig, publicLimits } from "./config.js";
import type { Config } from "./config.js";
import { registerSceneRoute, sceneDownloads } from "./http/scene.js";
import { DEFAULT_STATIC_ROOT, registerStatic } from "./http/static.js";
import { createLogger } from "./logger.js";
import { Metrics, registerMetricsRoute } from "./metrics.js";
import { FAST_TIMER_SCALE, RateLimiter } from "./ratelimit.js";
import { FAST_SWEEP_INTERVAL_MS, Registry } from "./registry.js";
import { PROTOCOL_VERSIONS, RELAY_NAME, RELAY_VERSION } from "./version.js";
import type { Connection } from "./ws/connection.js";
import { createDispatcher } from "./ws/dispatch.js";
import type { HandlerTable } from "./ws/dispatch.js";
import { registerWsEndpoint } from "./ws/endpoint.js";
import type { MessageBudgets } from "./ws/budget.js";
import { fanout } from "./ws/fanout.js";
import { heartbeat } from "./ws/heartbeat.js";
import { publisherHandlers } from "./ws/publisher.js";
import { snapshotHandlers } from "./ws/snapshot.js";
import { stateHandlers } from "./ws/state.js";
import { viewerHandlers } from "./ws/viewer.js";
import type { FrameHandlers } from "./ws/endpoint.js";

export interface AppOptions {
  /** Defaults to `loadConfig({})`, i.e. every documented default (architecture §9). */
  config?: Config;
  /** Defaults to a silent logger, so `buildApp()` in tests prints nothing. */
  logger?: Logger;
  /** Time source for uptime, TTLs and timeouts; tests pass a manual clock. */
  clock?: Clock;
  /** Session registry; by default one is built from `config` and `clock`. */
  registry?: Registry;
  /**
   * Per-IP limits (SRV-08); by default one with a fresh per-boot key and `metrics`. A limiter passed
   * here counts into `/metrics` only if it was built with the same `metrics`.
   */
  limiter?: RateLimiter;
  /** Overrides for the WebSocket frame hooks (tests record frames); default: dispatch (SRV-23). */
  wsHandlers?: Partial<FrameHandlers>;
  /** Extra message-type handlers merged into the dispatch table (tests). */
  messageHandlers?: HandlerTable;
  /**
   * Runs the WebSocket heartbeat (default `true`). Tests that move a manual clock by minutes at a
   * time turn it off: every tick would pass before a real pong could arrive.
   */
  heartbeat?: boolean;
  /** The viewer build (`index.html`, `assets/`); default `relay-server/public/` (SRV-16). */
  staticRoot?: string;
  /** Per-socket message budgets (SRV-25); default `DEFAULT_MESSAGE_BUDGETS` (tests that flood raise them). */
  budgets?: MessageBudgets;
  /** The counters behind `/metrics` (SRV-19); by default a fresh set. */
  metrics?: Metrics;
}

const NOT_FOUND = { error: "NOT_FOUND" } as const;

/** The longest the drain waits for closes to complete (architecture §5: "≤ 5 s"). */
export const SHUTDOWN_FLUSH_MS = 5_000;
/** Left of `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` for closing the app before Railway's SIGKILL. */
export const SHUTDOWN_MARGIN_MS = 1_000;

/** How long the drain waits: ≤ 5 s, and within the draining window Railway gives (architecture §9). */
export function shutdownFlushMs(drainingSeconds: number): number {
  return Math.min(SHUTDOWN_FLUSH_MS, Math.max(0, drainingSeconds * 1000 - SHUTDOWN_MARGIN_MS));
}

declare module "fastify" {
  interface FastifyInstance {
    /** The SIGTERM drain (SRV-17); see the module comment. Idempotent. */
    drain(): Promise<void>;
  }
}

/**
 * The text of Fastify's line per bound address in `listen()`; its default names the address (for
 * `0.0.0.0`, every IPv4 interface's). Shared by `src/index.ts` (which logs the port itself) and the
 * tests' `startRelay`.
 */
export const listenTextResolver = (): string => "http server listening";

/**
 * The `code` of a Fastify (`FST_ERR_*`), Node (`ERR_*`), HTTP parser (`HPE_*`), `ws` (`WS_ERR_*`) or system error
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
  if (/^(FST_ERR|ERR|HPE|WS_ERR)_[A-Z0-9_]+$/.test(code)) return code;
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
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  const config = options.config ?? loadConfig({});
  const limits = publicLimits(config);
  const logger = options.logger ?? createLogger({ level: "silent" });
  const registry =
    options.registry ??
    new Registry({
      ...config,
      clock,
      onListenerError: (error) =>
        logger.error({ errorCode: systemErrorCode(error) }, "registry event handler failed"),
    });

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    // Trust only the immediate peer (the Railway edge): `request.ip` is the address it appended to
    // `X-Forwarded-For`, not a leftmost entry a client could forge (T1, T3). `trustProxy: true`
    // would trust every hop.
    trustProxy: config.trustProxy ? (_address: string, hop: number) => hop === 0 : false,
    clientErrorHandler: clientErrorHandler(logger),
    // `app.close()` destroys every HTTP connection instead of waiting: a half-sent request would
    // otherwise hold a shutdown until the safety exit (SRV-17). Upgraded sockets are the drain's.
    forceCloseConnections: true,
    // A URL that does not decode (`/7KQ4X%zz`) is just another unknown path: Fastify's default
    // answer would echo it in a 400 body and bypass the not-found handler below.
    frameworkErrors: (error, _request, reply) => {
      const plain = reply as FastifyReply;
      if (error.code === "FST_ERR_BAD_URL" || error.code === "FST_ERR_MAX_PARAM_LENGTH")
        void plain.code(404).send(NOT_FOUND);
      else void plain.code(400).send({ error: "BAD_REQUEST" });
    },
  });

  // Both handlers first: a plugin scope (the viewer routes, SRV-16) chains to the handlers set when
  // it loads, and every `await app.register()` below loads the routes registered so far.
  // No SPA fallback beyond `/` and `/j` and no echo of the requested path: a leaked `/7KQ4X` style
  // URL never works (§10).
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(NOT_FOUND));
  // Fastify's default error body repeats parser and validation messages (and file paths); answer
  // with a code only, and log the 5xx (per-request logging, Fastify's own error log included, is off).
  app.setErrorHandler(async (error, request, reply) => {
    const raw = (error as { statusCode?: unknown }).statusCode;
    const status = typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500)
      request.log.error({ errorCode: systemErrorCode(error) }, "http handler failed");
    return reply.code(status).send({ error: status >= 500 ? "INTERNAL" : "BAD_REQUEST" });
  });

  // Compile every protocol schema now, not on the first client message (≈ 250 ms of blocked loop).
  const validators = defaultSchemas();
  const metrics = options.metrics ?? new Metrics();
  const limiter =
    options.limiter ??
    new RateLimiter({
      clock,
      logger,
      metrics,
      ...(config.testFastTimers && { timeScale: FAST_TIMER_SCALE }),
    });
  const publisher = publisherHandlers({
    registry,
    config,
    limiter,
    logger,
    metrics,
    // A resume that replaces a still-open publisher socket ends its snapshot in flight (§4.3).
    publisherReplaced: (session) => snapshot.publisherGone(session),
  });
  const fan = fanout({ registry, config, logger, clock });
  const viewer = viewerHandlers({
    registry,
    limiter,
    logger,
    clock,
    overCapacity: fan.overCapacity,
    deliver: fan.deliver,
    metrics,
  });
  const downloads = sceneDownloads({ registry });
  const snapshot = snapshotHandlers({
    registry,
    config,
    logger,
    clock,
    events: {
      ...fan.events,
      // The cache swap also ends the HTTP downloads of the replaced buffer (§6.4).
      completed: (session, cached, text) => {
        downloads.replaced(session);
        return fan.events.completed(session, cached, text);
      },
    },
  });

  const beat = heartbeat({ clock, logger });
  /**
   * Any frame or pong of a bound publisher counts as activity (§9.1); the idle timer is separate
   * (`registry.renew`).
   */
  const seen = (connection: Connection): void => {
    const session = connection.session;
    if (connection.role === "publisher" && session?.publisher === connection)
      registry.touchPublisher(session);
  };
  const dispatch = createDispatcher({
    clock,
    validators,
    normalizers: { ...viewer.normalizers, ...snapshot.normalizers },
    handlers: {
      ...publisher.handlers,
      ...viewer.handlers,
      ...snapshot.handlers,
      ...stateHandlers({ logger, broadcast: fan.broadcast }).handlers,
      ...options.messageHandlers,
    },
  });

  // Security headers on every response (ADR 0006 §4, architecture §8 T6). The CSP fits the viewer:
  // its own scripts, styles (Vite may inline some), workers and blobs for the three.js decoders,
  // `wss:` for the relay itself; no `unsafe-eval`, no third-party origin. No
  // `upgrade-insecure-requests`: every URL is relative, production is HTTPS behind the edge (HSTS),
  // and it would break a plain-HTTP local run of the image (SRV-20).
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:"],
        workerSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
  });

  // Then the WebSocket plugin, which wraps every route registered after it (upgrade interception).
  /** Set by `app.drain()` (below): from then on upgrades are refused and `/healthz` answers 503. */
  let draining: Promise<void> | undefined;
  const endpoint = await registerWsEndpoint(app, {
    draining: () => draining !== undefined,
    allowedOrigins: config.allowedOrigins,
    clock,
    logger,
    limiter,
    ...(options.budgets !== undefined && { budgets: options.budgets }),
    metrics,
    handlers: {
      opened: (connection) => beat.add(connection),
      pong: (connection, data) => {
        beat.pong(connection, data);
        seen(connection);
      },
      text: (connection, frame) => {
        beat.heard(connection);
        seen(connection);
        return dispatch(connection, frame);
      },
      binary: (connection, frame) => {
        beat.heard(connection);
        seen(connection);
        return snapshot.chunk(connection, frame);
      },
      closed: (connection, closeCode) => {
        beat.remove(connection);
        if (connection.role === "publisher") {
          const session = connection.session;
          try {
            if (session?.publisher === connection) snapshot.publisherGone(session);
          } finally {
            publisher.publisherClosed(connection, closeCode);
          }
        } else if (connection.role === "viewer") viewer.viewerClosed(connection);
      },
      ...options.wsHandlers,
    },
    errorCode: systemErrorCode,
  });

  // The TTL sweep runs while the server is up (architecture §5). One startup line for the DEP-06
  // checklist, before the port is bound: the heap limit Node derived from the container
  // (`--max-old-space-size-percentage`) next to the budgets that have to fit in it — figures only.
  app.addHook("onReady", async () => {
    logger.info(
      {
        heapSizeLimit: getHeapStatistics().heap_size_limit,
        maxTotalBufferedBytes: config.maxTotalBufferedBytes,
        maxTotalSnapshotBytes: config.maxTotalSnapshotBytes,
        trustProxy: config.trustProxy,
        testFastTimers: config.testFastTimers,
      },
      "relay starting",
    );
    if (config.testFastTimers)
      logger.warn(
        { event: "test_fast_timers", timeScale: FAST_TIMER_SCALE, sweepMs: FAST_SWEEP_INTERVAL_MS },
        "RELAY_TEST_FAST_TIMERS is on: rate-limit windows, ban and alarm shortened (test only)",
      );
    registry.start(config.testFastTimers ? FAST_SWEEP_INTERVAL_MS : undefined);
    limiter.start();
    fan.start();
    if (options.heartbeat !== false) beat.start();
  });
  // Before the server waits for its sockets: a publisher paused by the fan-out must read its close.
  app.addHook("preClose", async () => {
    fan.dispose();
  });
  app.addHook("onClose", async () => {
    registry.stop();
    limiter.stop();
    publisher.dispose();
    viewer.dispose();
    snapshot.dispose();
    downloads.dispose();
    beat.dispose();
  });

  // The SIGTERM drain (see the module comment); `index.ts` closes the app once it resolved.
  app.decorate("drain", () => {
    draining ??= (async () => {
      const sockets = [...endpoint.sockets];
      logger.info({ sockets: sockets.length }, "draining for a restart");
      for (const connection of sockets) connection.close(CLOSE_CODES.RELAY_RESTARTING);
      let timer!: TimerHandle;
      const late = new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, shutdownFlushMs(config.drainingSeconds));
      });
      await Promise.race([endpoint.emptied(), late]);
      clock.clearTimeout(timer);
      // Peers that did not complete the close in time (nor read it): the process is going.
      for (const connection of endpoint.sockets) connection.terminate();
      await endpoint.emptied();
    })();
    return draining;
  });

  // No endpoint takes a request body (§10); without parsers a POST to an unknown path is a plain 404.
  app.removeAllContentTypeParsers();

  // `/healthz` is the Railway healthcheck target: status only, no codes, no IPs, no memory figures.
  // `503` while draining, so the edge stops routing here (architecture §9).
  app.get("/healthz", async (_request, reply) => {
    if (draining !== undefined) reply.code(503);
    return {
      status: draining === undefined ? "ok" : "draining",
      uptimeS: Math.floor((clock.now() - startedAt) / 1000),
      sessions: registry.size,
      version: RELAY_VERSION,
    };
  });

  app.get("/api/version", async () => ({
    name: RELAY_NAME,
    version: RELAY_VERSION,
    protocolVersions: PROTOCOL_VERSIONS,
    limits,
  }));

  registerSceneRoute(app, { registry, clock, logger, downloads, metrics });
  // Only with a token (FR-32): otherwise `/metrics` is an unknown path, `404`.
  if (config.metricsToken !== undefined)
    registerMetricsRoute(app, {
      token: config.metricsToken,
      metrics,
      read: () => {
        let viewers = 0;
        for (const session of registry.sessions()) viewers += session.connectedViewers;
        return {
          sessions: registry.size,
          viewers,
          snapshotBytes: registry.snapshotBytes,
          bufferedBytes: fan.bufferedBytes(),
          codesEvicted: registry.codesEvicted,
        };
      },
    });
  await registerStatic(app, { root: options.staticRoot ?? DEFAULT_STATIC_ROOT });

  return app;
}
