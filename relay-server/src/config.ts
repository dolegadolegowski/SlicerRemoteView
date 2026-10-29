/**
 * Relay configuration from the environment (architecture §9, ADR 0008 §2, docs/protocol.md §3.3).
 *
 * `loadConfig()` reads every variable once at start-up and fails fast with a `ConfigError` naming
 * the variable (never its value — `METRICS_TOKEN` is a secret). An empty value counts as unset.
 * Every variable in `ENV_VARIABLES` appears in `relay-server/.env.example` with its default (a test
 * compares both lists). Inputs the platform or the test harness provides are read too but are
 * not configuration: `RAILWAY_PUBLIC_DOMAIN` (default of `ALLOWED_ORIGINS`), `NODE_ENV` and the
 * test-only `RELAY_TEST_FAST_TIMERS` (honoured only under exactly `NODE_ENV=test`, refused with
 * `RAILWAY_PUBLIC_DOMAIN` or `RAILWAY_REPLICA_ID` present; SRV-29).
 */
import { LIMITS } from "@slicerremoteview/shared";
import type { LogLevel } from "./logger.js";

export interface Config {
  /** Listen port (`PORT`, injected by Railway); the relay binds `0.0.0.0`. */
  port: number;
  logLevel: LogLevel;
  /** Bearer for `GET /metrics`; `undefined` disables the endpoint (404). */
  metricsToken: string | undefined;
  /** Idle TTL while the session has no connected viewers (§4.4). */
  sessionTtlS: number;
  /** Resume window after the publisher socket is lost (§9.1). */
  publisherGraceS: number;
  /** Hard cap on a session's lifetime. */
  sessionMaxLifetimeS: number;
  /** A released code is not reissued for this long (ADR 0008 §2); at least 60 s. */
  codeQuarantineS: number;
  /** Per-snapshot cap, at most the protocol maximum of 64 MiB (§3.3). */
  maxSnapshotBytes: number;
  /** Global budget for cached + assembling snapshots of all sessions. */
  maxTotalSnapshotBytes: number;
  /** Global cap on the sum of all viewer sockets' `bufferedAmount`. */
  maxTotalBufferedBytes: number;
  /** Viewers per session, at most the protocol maximum of 20. */
  maxViewers: number;
  /** Live sessions. */
  maxSessions: number;
  /** Browser `Origin`s accepted on `/ws` (§3.1); requests without `Origin` are always accepted. */
  allowedOrigins: readonly string[];
  /**
   * Behind the Railway edge: take the client IP from the last `X-Forwarded-For` entry, i.e. the one
   * the edge (the immediate peer) added — never from entries the client could have sent itself.
   */
  trustProxy: boolean;
  /** SIGTERM → SIGKILL window Railway grants for the `4008` drain (SRV-17). */
  drainingSeconds: number;
  /**
   * Rate-limit windows, ban and alarm ÷ 60 and a 1 s registry sweep for integration tests (SRV-29);
   * only ever true under `NODE_ENV=test`, never with a Railway variable present.
   */
  testFastTimers: boolean;
}

/** Every configuration variable, in `.env.example` order. */
export const ENV_VARIABLES = [
  "PORT",
  "LOG_LEVEL",
  "METRICS_TOKEN",
  "SESSION_TTL_S",
  "PUBLISHER_GRACE_S",
  "SESSION_MAX_LIFETIME_S",
  "CODE_QUARANTINE_S",
  "MAX_SNAPSHOT_BYTES",
  "MAX_TOTAL_SNAPSHOT_BYTES",
  "MAX_TOTAL_BUFFERED_BYTES",
  "MAX_VIEWERS",
  "MAX_SESSIONS",
  "ALLOWED_ORIGINS",
  "TRUST_PROXY",
  "RAILWAY_DEPLOYMENT_DRAINING_SECONDS",
] as const;

export type EnvVariable = (typeof ENV_VARIABLES)[number];

/** Read but not configuration (see the module comment); absent from `.env.example`. */
export const PLATFORM_INPUTS = [
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_REPLICA_ID",
  "NODE_ENV",
  "RELAY_TEST_FAST_TIMERS",
] as const;

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    reason: string,
  ) {
    super(`Invalid environment variable ${variable}: ${reason}`);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];
const MIN_METRICS_TOKEN_LENGTH = 32;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function integer(env: Env, name: EnvVariable, fallback: number, min: number, max: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(name, "must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ConfigError(name, `must be an integer between ${min} and ${max}`);
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = read(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigError(name, "must be true, false, 1 or 0");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(name, "each entry must be an origin such as https://host[:port]");
  }
  const bare =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !bare)
    throw new ConfigError(
      name,
      "each entry must be an http(s) origin without path, query or credentials",
    );
  // Exact match only: a `*` would read like a wildcard the relay does not implement.
  if (url.hostname.includes("*")) throw new ConfigError(name, "wildcards are not supported");
  // Plain http only for a local dev server; elsewhere a tampered http page could pass the check.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
    throw new ConfigError(name, "http origins are allowed only for localhost");
  // Browsers send the serialised origin (lower-case host, default port omitted): compare that form.
  return url.origin;
}

function allowedOrigins(env: Env): string[] {
  const raw = read(env, "ALLOWED_ORIGINS");
  if (raw !== undefined)
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => origin(entry, "ALLOWED_ORIGINS"));
  const domain = read(env, "RAILWAY_PUBLIC_DOMAIN");
  return domain === undefined ? [] : [origin(`https://${domain}`, "RAILWAY_PUBLIC_DOMAIN")];
}

const DAY_S = 86_400;
const MIN_CODE_QUARANTINE_S = 60;

/** Parses and validates the environment; throws `ConfigError` on the first invalid variable. */
export function loadConfig(env: Env = process.env): Config {
  const logLevel = read(env, "LOG_LEVEL")?.toLowerCase() ?? "info";
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel))
    throw new ConfigError("LOG_LEVEL", `must be one of ${LOG_LEVELS.join(", ")}`);

  const metricsToken = read(env, "METRICS_TOKEN");
  if (metricsToken !== undefined && !/^[\x21-\x7e]+$/.test(metricsToken))
    throw new ConfigError("METRICS_TOKEN", "must be printable ASCII without spaces");
  if (metricsToken !== undefined && metricsToken.length < MIN_METRICS_TOKEN_LENGTH)
    throw new ConfigError(
      "METRICS_TOKEN",
      `must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`,
    );

  const maxSnapshotBytes = integer(
    env,
    "MAX_SNAPSHOT_BYTES",
    LIMITS.MAX_SNAPSHOT_BYTES,
    1,
    LIMITS.MAX_SNAPSHOT_BYTES,
  );
  const maxTotalSnapshotBytes = integer(
    env,
    "MAX_TOTAL_SNAPSHOT_BYTES",
    LIMITS.MAX_TOTAL_SNAPSHOT_BYTES_DEFAULT,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  // A session holds up to two snapshots while replacing one (cached + assembling, architecture §4).
  if (maxTotalSnapshotBytes < 2 * maxSnapshotBytes)
    throw new ConfigError("MAX_TOTAL_SNAPSHOT_BYTES", "must be at least 2 × MAX_SNAPSHOT_BYTES");

  // Test-only (SRV-29): honoured under exactly NODE_ENV=test, and refused when a variable Railway
  // injects is present (even empty) — a service variable can override the image's
  // NODE_ENV=production, and the flag weakens T1. `RAILWAY_PUBLIC_DOMAIN` exists only with a
  // generated domain; `RAILWAY_REPLICA_ID` on every replica (docs/research/relay.md). Other Railway
  // variables (`RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, …) are [TODO verify].
  const onRailway = env.RAILWAY_PUBLIC_DOMAIN !== undefined || env.RAILWAY_REPLICA_ID !== undefined;
  const testFastTimers = env.NODE_ENV === "test" && boolean(env, "RELAY_TEST_FAST_TIMERS", false);
  if (testFastTimers && onRailway)
    throw new ConfigError(
      "RELAY_TEST_FAST_TIMERS",
      "is test-only and must not be set with RAILWAY_PUBLIC_DOMAIN or RAILWAY_REPLICA_ID",
    );
  return {
    port: integer(env, "PORT", 8787, 0, 65_535),
    logLevel: logLevel as LogLevel,
    metricsToken,
    // The three session timers are protocol maximums (§3.3, §14): a relay may only shorten them.
    sessionTtlS: integer(env, "SESSION_TTL_S", LIMITS.SESSION_TTL_S, 1, LIMITS.SESSION_TTL_S),
    publisherGraceS: integer(
      env,
      "PUBLISHER_GRACE_S",
      LIMITS.PUBLISHER_GRACE_S,
      1,
      LIMITS.PUBLISHER_GRACE_S,
    ),
    sessionMaxLifetimeS: integer(
      env,
      "SESSION_MAX_LIFETIME_S",
      LIMITS.SESSION_MAX_LIFETIME_S,
      1,
      LIMITS.SESSION_MAX_LIFETIME_S,
    ),
    // The quarantine is an anti-guessing control (ADR 0008 §2, T1): it can be shortened, not disabled.
    codeQuarantineS: integer(env, "CODE_QUARANTINE_S", 600, MIN_CODE_QUARANTINE_S, DAY_S),
    maxSnapshotBytes,
    maxTotalSnapshotBytes,
    maxTotalBufferedBytes: integer(
      env,
      "MAX_TOTAL_BUFFERED_BYTES",
      167_772_160,
      LIMITS.SLOW_CONSUMER_HARD_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
    maxViewers: integer(env, "MAX_VIEWERS", LIMITS.MAX_VIEWERS, 1, LIMITS.MAX_VIEWERS),
    maxSessions: integer(env, "MAX_SESSIONS", LIMITS.MAX_SESSIONS_DEFAULT, 1, 10_000),
    allowedOrigins: allowedOrigins(env),
    trustProxy: boolean(env, "TRUST_PROXY", true),
    drainingSeconds: integer(env, "RAILWAY_DEPLOYMENT_DRAINING_SECONDS", 30, 0, 3_600),
    testFastTimers,
  };
}

/** The effective limits a relay announces (`GET /api/version` §10; `session.created.limits` §4.2, §14). */
export interface PublicLimits {
  maxSnapshotBytes: number;
  maxChunkBytes: number;
  maxTextBytes: number;
  maxViewers: number;
}

/** Configured snapshot and viewer caps, protocol maximums for the rest (§3.3, §14). */
export function publicLimits(config: Config): PublicLimits {
  return {
    maxSnapshotBytes: config.maxSnapshotBytes,
    maxChunkBytes: LIMITS.MAX_CHUNK_BYTES,
    maxTextBytes: LIMITS.MAX_TEXT_BYTES_PUBLISHER,
    maxViewers: config.maxViewers,
  };
}
