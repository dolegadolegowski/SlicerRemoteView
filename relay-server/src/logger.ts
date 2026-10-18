/**
 * pino logger factory for the relay (architecture §5 "Logging", CLAUDE.md rule 6).
 *
 * One JSON object per line with `level` (label), `time` (epoch ms) and `message`. Values under the
 * keys below are censored at the top level and one level deep (belt and braces: the relay never
 * passes codes, tokens or payloads to the logger in the first place; pino `redact` works on object
 * keys only and does not scrub interpolated strings, ADR 0002). Because `*.code` is censored, protocol and
 * system error codes are logged under the key `errorCode`. `rawPacket` is Node's copy of the raw
 * request bytes on HTTP parser errors (headers included). SRV-18 adds the log-grep test.
 */
import { pino } from "pino";
import type { DestinationStream, Level, Logger } from "pino";

/** Object paths whose values never reach a log line. */
export const REDACT_PATHS: readonly string[] = [
  "code",
  "*.code",
  "preferredCode",
  "*.preferredCode",
  "token",
  "*.token",
  "publisherToken",
  "*.publisherToken",
  "viewerToken",
  "*.viewerToken",
  "metricsToken",
  "*.metricsToken",
  "rawPacket",
  "*.rawPacket",
  // @fastify/websocket logs `{path: request.url}` (query string included) for upgrades to non-WS routes.
  "path",
  "*.path",
  "req.headers.authorization",
  "headers.authorization",
];

export type LogLevel = Level | "silent";

export interface LoggerOptions {
  level?: LogLevel;
  /** Where lines go; default stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      messageKey: "message",
      // No pid/hostname: they add nothing on a single-replica service.
      base: null,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
}
