// QA-05 helpers for tests/security/join.spec.ts: one `viewer.join` attempt per socket (a failed join closes its
// socket, docs/protocol.md §12), a raw HTTP upgrade probe that reads the refusal status and body (no `ws` client
// in between), and the small statistics the timing-uniformity case needs (median, quantiles, Mann-Whitney U).
//
// Secrets (NFR-12): codes and tokens pass through these functions in memory only; nothing here prints, throws or
// returns them in an error text. A refused join resolves with the relay's `error` message, which by contract
// (§9.2) carries neither.

import { randomBytes, randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { ALPHABET, CODE_LENGTH } from "@slicerremoteview/shared";
import { connect } from "./ws-client.ts";
import type { Client, Closed, Message } from "./ws-client.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The `clientInfo` of a web viewer (§5.1); the same object for every attempt so bodies differ only in `code`. */
export const VIEWER_CLIENT_INFO = {
  app: "web-viewer",
  version: "0.0.0-qa",
  platform: "web",
  profile: "mobile",
  capabilities: { httpScene: true, maxSnapshotBytes: 67_108_864 },
} as const;

export interface JoinAttempt {
  /** The first message the relay answered with: `viewer.joined` or `error`. */
  reply: Message;
  /** Milliseconds from sending `viewer.join` to receiving `reply` (measured in this process). */
  elapsedMs: number;
  client: Client;
  /** The close of a refused join (`undefined` for a successful one, whose socket stays open). */
  closed: Closed | undefined;
}

/**
 * Opens a socket as `ip`, sends one `viewer.join{code}` and waits for the answer; for an `error` also for the
 * close the relay must follow it with (§5.2: `4004`–`4006`). The socket of a successful join is left open
 * (the caller closes it).
 */
export async function attemptJoin(
  wsUrl: string,
  code: string,
  options: { ip: string; id?: string; closeTimeoutMs?: number },
): Promise<JoinAttempt> {
  const client = await connect(wsUrl, { ip: options.ip });
  const started = performance.now();
  client.send({ type: "viewer.join", id: options.id ?? "v-1", code, clientInfo: VIEWER_CLIENT_INFO });
  const reply = await client.next((m) => m.type === "viewer.joined" || m.type === "error", 10_000);
  const elapsedMs = performance.now() - started;
  const closed = reply.type === "error" ? await client.closedWithin(options.closeTimeoutMs ?? 10_000) : undefined;
  return { reply, elapsedMs, client, closed };
}

/** A well-formed code (§4.2 alphabet, 5 symbols) that differs from every code in `exclude`. */
export function unknownCode(exclude: readonly string[] = []): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (!exclude.includes(code)) return code;
  }
}

/**
 * Codes the viewer's normaliser (§12: whitespace removed, upper case) cannot turn into a well-formed one:
 * wrong length, symbols outside the alphabet (`0 O 1 I L`), punctuation, non-ASCII, empty.
 */
export const MALFORMED_CODES: readonly string[] = [
  "ABC",
  "ABCDEF",
  "I0O1L",
  "AB-CD",
  "7KQ4!",
  "ÄÖÜ22",
  "",
  "22222222222222222222",
];

/** Outcome of a raw upgrade request: the HTTP status and body of a refusal, or `101` when it was upgraded. */
export interface UpgradeProbe {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Sends `GET /ws` with WebSocket upgrade headers (RFC 6455 §4.1) through `node:http` and reports whether the
 * relay answered `101` (Node's `upgrade` event; the socket is destroyed at once) or refused with a plain HTTP
 * response (`response` event) before any upgrade. Node docs, `http.ClientRequest` events `upgrade` and
 * `response`: https://nodejs.org/docs/latest-v22.x/api/http.html#event-upgrade
 */
export function probeUpgrade(baseUrl: string, headers: Record<string, string>): Promise<UpgradeProbe> {
  const url = new URL("/ws", baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      // A fresh connection per probe: Node 22's global agent keeps sockets alive, and a refused upgrade's socket
      // is destroyed by the relay after its response (@fastify/websocket `onResponse` hook), so reusing it would
      // fail the next probe with "socket hang up" (https://nodejs.org/docs/latest-v22.x/api/http.html#httprequestoptions-callback, `agent: false`).
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.once("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: "", headers: res.headers });
    });
    req.once("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.once("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("upgrade probe timed out")));
    req.end();
  });
}

/** The `q`-quantile (0…1) by linear interpolation between order statistics (type 7, R's default). */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export const median = (values: readonly number[]) => quantile(values, 0.5);

/** Standard normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Two-sided Mann-Whitney U test (Wilcoxon rank-sum) with the normal approximation, tie correction and
 * continuity correction — adequate for n ≥ 20 per group. Returns U of `a` and the p-value of
 * "both samples come from the same distribution".
 */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): { u: number; z: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((entry, i) => entry.g === 0 && (r1 += ranks[i]!));
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return { u, z: 0, p: 1 };
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.max(0, z))));
  return { u, z, p };
}
