/**
 * Process entry point: build the app and listen on `PORT` (Railway) on all interfaces.
 */
import { buildApp, systemErrorCode } from "./app.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ level: "info" });
const port = Number(process.env.PORT ?? 8787);

const app = await buildApp({ logger });
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
