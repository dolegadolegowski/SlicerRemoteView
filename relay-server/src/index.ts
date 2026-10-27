/**
 * Process entry point: read the configuration, build the app and listen on `PORT` (Railway) on
 * all interfaces. An invalid environment stops the process before anything listens. `SIGTERM`
 * (Railway's redeploy) and `SIGINT` drain the relay (`app.drain()`: close `4008` to every socket,
 * ≤ 5 s within `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`), close it and exit 0 (SRV-17, FR-30); a second
 * signal exits 1 at once.
 * Nothing is written anywhere on the way out: the sessions and their snapshots live in memory only
 * (NFR-10).
 */
import { buildApp, listenTextResolver, shutdownFlushMs, systemErrorCode } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

/** After the drain window, the longest closing the app may take before the process just exits. */
const SHUTDOWN_EXIT_MS = 500;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  createLogger().fatal({ variable: error.variable }, error.message);
  process.exit(1);
}
const logger = createLogger({ level: config.logLevel });
const port = config.port;

const app = await buildApp({ config, logger });
try {
  // Fastify logs one line per bound address; keep the addresses out of it (our line has the port).
  await app.listen({ port, host: "0.0.0.0", listenTextResolver });
} catch (error) {
  logger.fatal({ errorCode: systemErrorCode(error) }, "listen failed");
  process.exit(1);
}
const address = app.server.address();
logger.info(
  { port: typeof address === "object" && address ? address.port : port },
  "relay listening",
);

// One shutdown: a second signal (Ctrl-C twice) forces the exit at once.
let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) {
    logger.warn({ signal }, "shutdown forced");
    process.exit(1);
  }
  stopping = true;
  logger.info({ signal }, "shutting down");
  // Should closing the app hang anyway, the process goes before Railway's SIGKILL (the drain window
  // leaves 1 s of `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`).
  setTimeout(
    () => {
      logger.warn({ signal }, "shutdown timed out");
      process.exit(0);
    },
    shutdownFlushMs(config.drainingSeconds) + SHUTDOWN_EXIT_MS,
  ).unref();
  app
    .drain()
    .then(() => app.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ errorCode: systemErrorCode(error) }, "shutdown failed");
        process.exit(1);
      },
    );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
