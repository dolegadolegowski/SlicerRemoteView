/**
 * Process entry point: read the configuration, build the app and listen on `PORT` (Railway) on
 * all interfaces. An invalid environment stops the process before anything listens.
 */
import { buildApp, systemErrorCode } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

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
  await app.listen({ port, host: "0.0.0.0", listenTextResolver: () => "http server listening" });
} catch (error) {
  logger.fatal({ errorCode: systemErrorCode(error) }, "listen failed");
  process.exit(1);
}
const address = app.server.address();
logger.info(
  { port: typeof address === "object" && address ? address.port : port },
  "relay listening",
);

// Graceful drain with close 4008 is SRV-17; until then stop listening and exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
