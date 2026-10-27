/**
 * Operator metrics (SRV-19; docs/protocol.md §10, FR-32, NFR-36): `GET /metrics` in the Prometheus
 * text format 0.0.4, registered only when `METRICS_TOKEN` is set (otherwise the path is unknown,
 * `404`) and answered only with `Authorization: Bearer <METRICS_TOKEN>` (`401` otherwise).
 *
 * Relay-wide figures only: no label value names a session, code, token, viewer or address (NFR-12,
 * T6) — label values come from fixed sets (error codes, limit names, roles), so the series are
 * bounded too. Memory figures are exposed here and nowhere else (SRV-18: `/healthz` has none).
 */
import { getHeapStatistics } from "node:v8";
import type { FastifyInstance } from "fastify";
import { ERROR_CODES } from "@slicerremoteview/shared";
import type { ErrorCode } from "@slicerremoteview/shared";
import { hashToken, tokenMatches } from "./codes.js";

/**
 * What refused a request: upgrades, `session.create`, `viewer.join`, the join ban, the per-socket
 * message budget, `GET /api/scene`.
 */
export const RATE_LIMIT_NAMES = ["upgrade", "create", "join", "ban", "messages", "scene"] as const;
export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number];
export type ReconnectRole = "publisher" | "viewer";

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const BEARER = /^bearer +([\x21-\x7e]+)$/i;

/** The relay's counters; components get it from `buildApp()` and count as things happen. */
export class Metrics {
  /** Bytes forwarded to viewer sockets (`Connection.forward`) and GLB bodies sent over HTTP. */
  bytesRelayed = 0;
  /**
   * Failed code joins and every `preferredCode` probe, granted or not — what the limiter counts as a
   * guess (T1, SRV-04; `RateLimiter.joinFailed`).
   */
  joinFailures = 0;
  readonly rateLimitHits = new Map<RateLimitName, number>(RATE_LIMIT_NAMES.map((n) => [n, 0]));
  readonly reconnects = new Map<ReconnectRole, number>([
    ["publisher", 0],
    ["viewer", 0],
  ]);
  /** `error` messages sent, by code (§9.2). */
  readonly errors = new Map<ErrorCode, number>(ERROR_CODES.map((code) => [code, 0]));

  relayed(bytes: number): void {
    this.bytesRelayed += bytes;
  }

  joinFailed(): void {
    this.joinFailures += 1;
  }

  rateLimited(limit: RateLimitName): void {
    this.rateLimitHits.set(limit, this.rateLimitHits.get(limit)! + 1);
  }

  reconnected(role: ReconnectRole): void {
    this.reconnects.set(role, this.reconnects.get(role)! + 1);
  }

  /** Codes outside the protocol's list are not counted: the label set stays fixed. */
  error(code: ErrorCode): void {
    const count = this.errors.get(code);
    if (count !== undefined) this.errors.set(code, count + 1);
  }
}

/** Figures read from the relay's state at each scrape. */
export interface Readings {
  sessions: number;
  viewers: number;
  snapshotBytes: number;
  bufferedBytes: number;
  /** Codes the full quarantine released early (`CodeQuarantine.evicted`; T1 residual, SRV-03). */
  codesEvicted: number;
}

type Sample = readonly [labels: string, value: number];

/** The exposition text: `# HELP`, `# TYPE` and the samples of each metric. */
export function renderMetrics(metrics: Metrics, readings: Readings): string {
  const lines: string[] = [];
  const metric = (name: string, type: "counter" | "gauge", help: string, samples: Sample[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  };
  const labelled = <K extends string>(label: string, values: Map<K, number>): Sample[] =>
    [...values].map(([key, value]) => [`{${label}="${key}"}`, value]);

  metric("sessions_active", "gauge", "Live sessions.", [["", readings.sessions]]);
  metric("viewers_active", "gauge", "Connected viewer sockets.", [["", readings.viewers]]);
  metric("bytes_relayed_total", "counter", "Frames forwarded to viewers and GLBs sent over HTTP.", [
    ["", metrics.bytesRelayed],
  ]);
  metric("snapshot_bytes_cached", "gauge", "Bytes of cached and assembling snapshots.", [
    ["", readings.snapshotBytes],
  ]);
  metric("join_failures_total", "counter", "Failed code joins and preferred-code probes.", [
    ["", metrics.joinFailures],
  ]);
  metric(
    "ratelimit_hits_total",
    "counter",
    "Requests refused by a rate limit.",
    labelled("limit", metrics.rateLimitHits),
  );
  metric(
    "reconnects_total",
    "counter",
    "Publisher resumes and viewer rejoins.",
    labelled("role", metrics.reconnects),
  );
  metric(
    "errors_total",
    "counter",
    "Error messages sent, by code.",
    labelled("code", metrics.errors),
  );
  metric("buffered_bytes", "gauge", "Bytes queued in viewer send buffers.", [
    ["", readings.bufferedBytes],
  ]);
  metric("codes_evicted_total", "counter", "Codes released early from a full quarantine.", [
    ["", readings.codesEvicted],
  ]);
  metric("heap_size_limit_bytes", "gauge", "V8 heap size limit.", [
    ["", getHeapStatistics().heap_size_limit],
  ]);
  metric("process_resident_memory_bytes", "gauge", "Resident set size.", [
    ["", process.memoryUsage.rss()],
  ]);
  return `${lines.join("\n")}\n`;
}

/** `GET /metrics` behind the bearer token; call only when `METRICS_TOKEN` is set. */
export function registerMetricsRoute(
  app: FastifyInstance,
  { token, metrics, read }: { token: string; metrics: Metrics; read: () => Readings },
): void {
  // Compared as hashes in constant time: neither the token's bytes nor its length leak (SRV-03).
  const expected = hashToken(token);
  app.get("/metrics", async (request, reply) => {
    const sent = BEARER.exec(request.headers.authorization ?? "")?.[1];
    if (sent === undefined || !tokenMatches(sent, expected))
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "UNAUTHORIZED" });
    return reply
      .header("Content-Type", CONTENT_TYPE)
      .header("Cache-Control", "no-store")
      .send(renderMetrics(metrics, read()));
  });
}
