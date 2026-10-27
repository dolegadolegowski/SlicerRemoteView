import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { chunkify, encodeChunkFrame, ERROR_CODES } from "@slicerremoteview/shared";
import type { ErrorCode } from "@slicerremoteview/shared";
import { buildApp } from "../src/app.js";
import { CodeQuarantine } from "../src/codes.js";
import { loadConfig } from "../src/config.js";
import { SCENE_FETCHES_PER_MINUTE } from "../src/http/scene.js";
import { createLogger } from "../src/logger.js";
import { DEFAULT_MESSAGE_BUDGETS } from "../src/ws/budget.js";
import { HARD_WATERMARK_BYTES, WATCH_INTERVAL_MS } from "../src/ws/fanout.js";
import { CHUNK_TIMEOUT_MS } from "../src/ws/snapshot.js";
import { Metrics, RATE_LIMIT_NAMES, renderMetrics } from "../src/metrics.js";
import { INVALID_CODE_JITTER_MS } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { TestClient, TestRelay } from "./helpers/ws-client.js";

const TOKEN = "m".repeat(40);
const CONFIG = { TRUST_PROXY: "false", ALLOWED_ORIGINS: "https://relay.example.org" };
const GLB = readFileSync(
  new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url),
);
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const TYPES = {
  sessions_active: "gauge",
  viewers_active: "gauge",
  bytes_relayed_total: "counter",
  snapshot_bytes_cached: "gauge",
  join_failures_total: "counter",
  ratelimit_hits_total: "counter",
  reconnects_total: "counter",
  errors_total: "counter",
  buffered_bytes: "gauge",
  codes_evicted_total: "counter",
  heap_size_limit_bytes: "gauge",
  process_resident_memory_bytes: "gauge",
};

let relay: TestRelay | undefined;
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
  vi.restoreAllMocks();
});

/** `name{labels}` → value of every sample in an exposition text. */
function samples(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n"))
    if (line !== "" && !line.startsWith("#")) {
      const [series, value] = line.split(" ");
      values.set(series!, Number(value));
    }
  return values;
}

function scrape(authorization?: string): Promise<Response> {
  const base = relay!.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
  return fetch(`${base}/metrics`, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function figures(): Promise<Map<string, number>> {
  const response = await scrape(`Bearer ${TOKEN}`);
  expect(response.status).toBe(200);
  return samples(await response.text());
}

/** Round trip: everything sent before has been handled. */
async function flush(client: TestClient): Promise<void> {
  const id = `flush-${Math.random()}`;
  client.send({ type: "ping", id });
  while ((await client.next()).replyTo !== id);
}

async function upload(client: TestClient, sceneVersion: number): Promise<void> {
  const chunkSize = 64 * 1024;
  client.send({
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: GLB.byteLength,
    sha256: sha256(GLB),
    chunkCount: Math.ceil(GLB.byteLength / chunkSize),
    chunkSize,
    format: "glb",
    extensionsUsed: [],
  });
  for (const { chunkIndex, payload } of chunkify(GLB, chunkSize))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
  client.send({ type: "scene.snapshot.end", sceneVersion, sha256: sha256(GLB) });
  await flush(client);
}

describe("GET /metrics (SRV-19)", () => {
  it("is an unknown path without METRICS_TOKEN (FR-32)", async () => {
    const app = await buildApp({ config: loadConfig(CONFIG) });
    const response = await app.inject({ url: "/metrics", headers: { authorization: "Bearer x" } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"NOT_FOUND"}');
    await app.close();
  });

  it("answers 401 without the right bearer token, and the text format with it", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } });
    relay = await startRelay({ config: loadConfig({ ...CONFIG, METRICS_TOKEN: TOKEN }), logger });
    for (const authorization of [
      undefined,
      `Bearer ${TOKEN.slice(1)}x`, // same length, wrong
      `Bearer ${TOKEN.slice(1)}`, // shorter
      `Bearer ${TOKEN}x`, // longer
      "Bearer ",
      `Basic ${TOKEN}`,
      TOKEN,
    ]) {
      const response = await scrape(authorization);
      expect(response.status, authorization).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.text()).toBe('{"error":"UNAUTHORIZED"}');
    }
    const response = await scrape(`bearer ${TOKEN}`); // the scheme is case-insensitive
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    for (const [name, type] of Object.entries(TYPES)) {
      expect(text).toMatch(new RegExp(`^# HELP ${name} .+$`, "m"));
      expect(text).toMatch(new RegExp(`^# TYPE ${name} ${type}$`, "m"));
    }
    expect(text.match(/^# TYPE /gm)).toHaveLength(Object.keys(TYPES).length);
    // Every series of a labelled metric exists from the start, at 0.
    const values = samples(text);
    for (const code of ERROR_CODES) expect(values.get(`errors_total{code="${code}"}`)).toBe(0);
    for (const limit of RATE_LIMIT_NAMES)
      expect(values.get(`ratelimit_hits_total{limit="${limit}"}`)).toBe(0);
    expect(values.get("heap_size_limit_bytes")).toBeGreaterThan(0);
    expect(values.get("process_resident_memory_bytes")).toBeGreaterThan(0);
    // Never in a query string, never in a log line (rule 6).
    const base = relay.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    expect((await fetch(`${base}/metrics?token=${TOKEN}`)).status).toBe(401);
    expect(lines.join("")).not.toContain(TOKEN.slice(1));
  });

  it("counts a scripted session, with no session, code, token or address in the output", async () => {
    const metrics = new Metrics();
    relay = await startRelay({ config: loadConfig({ ...CONFIG, METRICS_TOKEN: TOKEN }), metrics });
    const publisher = await connectClient(relay.url);
    publisher.sendRaw(JSON.stringify(fixture("session.create")));
    const created = await publisher.next();
    const session = relay.registry.get(created.sessionId as string)!;
    const viewer = await connectClient(relay.url);
    // What goes through `forward()`: the `scene.state` after the join (§8.3), then the publisher's
    // begin, chunks and end byte for byte.
    let forwarded = 0;
    viewer.ws.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = data as Buffer;
      const type = isBinary ? "chunk" : (JSON.parse(bytes.toString()) as { type: string }).type;
      if (["chunk", "scene.state", "scene.snapshot.begin", "scene.snapshot.end"].includes(type))
        forwarded += bytes.byteLength;
    });
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const joined = await viewer.next();
    expect(joined.type).toBe("viewer.joined");
    await upload(publisher, 1); // streamed to the viewer
    await flush(viewer);

    let values = await figures();
    expect(values.get("sessions_active")).toBe(1);
    expect(values.get("viewers_active")).toBe(1);
    expect(values.get("snapshot_bytes_cached")).toBe(GLB.byteLength);
    const streamed = values.get("bytes_relayed_total")!;
    expect(streamed).toBe(forwarded);
    expect(values.get("join_failures_total")).toBe(0);

    // A wrong code: one failure, one INVALID_CODE.
    const guess = await connectClient(relay.url);
    const wrong = session.code === "22222" ? "33333" : "22222";
    guess.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: wrong }));
    await expect.poll(() => metrics.joinFailures).toBe(1); // counted before the jitter
    relay.clock.advance(INVALID_CODE_JITTER_MS.max); // the answer waits a random 50–150 ms
    await guess.closed;
    // The GLB over HTTP, and a rejoin by token on a new socket.
    const base = relay.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    const download = await fetch(`${base}/api/scene/1`, {
      headers: { authorization: `Bearer ${joined.viewerToken as string}` },
    });
    expect((await download.arrayBuffer()).byteLength).toBe(GLB.byteLength);
    expect((await figures()).get("bytes_relayed_total")).toBe(streamed + GLB.byteLength);
    viewer.ws.terminate();
    await viewer.closed;
    await expect.poll(() => session.connectedViewers).toBe(0);
    expect((await figures()).get("viewers_active")).toBe(0); // its entry is kept for a rejoin
    const again = await connectClient(relay.url);
    again.sendRaw(
      JSON.stringify({
        ...fixture("viewer.join", "valid-rejoin"),
        sessionId: session.id,
        viewerToken: joined.viewerToken,
      }),
    );
    expect((await again.next()).type).toBe("viewer.joined");
    // The publisher drops and resumes on a new socket.
    publisher.ws.terminate();
    await publisher.closed;
    const resumed = await connectClient(relay.url);
    resumed.sendRaw(
      JSON.stringify({
        ...fixture("session.resume"),
        sessionId: session.id,
        publisherToken: created.publisherToken,
        lastSceneVersion: 1,
      }),
    );
    expect((await resumed.next()).type).toBe("session.resumed");
    // A sixth session.create from the address within the minute is refused.
    for (let i = 0; i < 5; i++) {
      const extra = await connectClient(relay.url);
      extra.sendRaw(JSON.stringify(fixture("session.create")));
      await extra.next();
    }

    const response = await scrape(`Bearer ${TOKEN}`);
    const text = await response.text();
    values = samples(text);
    expect(values.get("join_failures_total")).toBe(1);
    expect(values.get('errors_total{code="INVALID_CODE"}')).toBe(1);
    expect(values.get('reconnects_total{role="viewer"}')).toBe(1);
    expect(values.get('reconnects_total{role="publisher"}')).toBe(1);
    expect(values.get('ratelimit_hits_total{limit="create"}')).toBe(1);
    expect(values.get('errors_total{code="RATE_LIMITED"}')).toBe(1);
    expect(values.get("sessions_active")).toBe(5); // the sixth was refused

    for (const secret of [
      session.id,
      session.code,
      created.publisherToken as string,
      joined.viewerToken as string,
      joined.viewerId as string,
      "127.0.0.1",
    ])
      expect(text).not.toContain(secret);
    // Label values only from the fixed sets.
    const allowed = new Set<string>([...ERROR_CODES, ...RATE_LIMIT_NAMES, "publisher", "viewer"]);
    for (const [, value] of text.matchAll(/\{(?:code|limit|role)="([^"]*)"\}/g))
      expect(allowed.has(value!)).toBe(true);
    expect(text.match(/\{/g)?.length).toBe(text.match(/\{(?:code|limit|role)="[^"]*"\}/g)?.length);
  });
});

describe("rate-limit hits (SRV-19)", () => {
  it("counts the message-budget, join, ban and upgrade refusals by limit", async () => {
    const metrics = new Metrics();
    const tiny = { rate: 1, burst: 2_048, frameCost: 512 };
    relay = await startRelay({
      config: loadConfig({ ...CONFIG, METRICS_TOKEN: TOKEN }),
      metrics,
      budgets: { ...DEFAULT_MESSAGE_BUDGETS, publisher: tiny },
    });
    // A publisher past its budget: `RATE_LIMITED` and close `4006`.
    const flooder = await connectClient(relay.url);
    flooder.sendRaw(JSON.stringify(fixture("session.create")));
    await flooder.next();
    for (let i = 0; i < 8; i++) flooder.send({ type: "ping", id: `p-${i}` });
    await expect.poll(() => metrics.rateLimitHits.get("messages")).toBe(1);
    await expect.poll(() => flooder.received.at(-1)?.code).toBe("RATE_LIMITED");
    // The 11th join within a minute is refused `join`; 20 failed joins ban the address, and the
    // next join is refused `ban`.
    const key = relay.limiter.clientKey("127.0.0.1");
    for (let i = 0; i < 10; i++) expect(relay.limiter.join(key).ok).toBe(true);
    expect(relay.limiter.join(key).ok).toBe(false);
    for (let i = 0; i < 20; i++) relay.limiter.joinFailed(key);
    expect(relay.limiter.join(key).ok).toBe(false);
    // The 31st upgrade within a minute: HTTP 429.
    for (let i = 0; i < 40 && metrics.rateLimitHits.get("upgrade") === 0; i++)
      await connectClient(relay.url).catch(() => undefined);
    const values = await figures();
    expect(values.get('ratelimit_hits_total{limit="join"}')).toBe(1);
    expect(values.get('ratelimit_hits_total{limit="ban"}')).toBe(1);
    expect(values.get('ratelimit_hits_total{limit="upgrade"}')).toBe(1);
    expect(values.get('ratelimit_hits_total{limit="messages"}')).toBe(1);
    expect(values.get("join_failures_total")).toBe(20);
  });

  it("counts a refused scene fetch as `scene`", async () => {
    const metrics = new Metrics();
    relay = await startRelay({ config: loadConfig({ ...CONFIG, METRICS_TOKEN: TOKEN }), metrics });
    const publisher = await connectClient(relay.url);
    publisher.sendRaw(JSON.stringify(fixture("session.create")));
    const session = relay.registry.get((await publisher.next()).sessionId as string)!;
    await upload(publisher, 1);
    const viewer = await connectClient(relay.url);
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const token = (await viewer.next()).viewerToken as string;
    const base = relay.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    const before = (await figures()).get("bytes_relayed_total");
    const statuses: number[] = [];
    for (let i = 0; i <= SCENE_FETCHES_PER_MINUTE; i++) {
      const response = await fetch(`${base}/api/scene/1`, {
        method: "HEAD", // no body: HEAD sends no bytes and counts none
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
    const values = await figures();
    expect(values.get('ratelimit_hits_total{limit="scene"}')).toBe(1);
    expect(values.get("bytes_relayed_total")).toBe(before);
  });
});

describe("figures read at each scrape, and errors sent outside sendError (SRV-19)", () => {
  it("buffered bytes, evicted codes, a slow consumer's SLOW_CONSUMER and a chunk timeout's BAD_SEQUENCE", async () => {
    const metrics = new Metrics();
    relay = await startRelay({ config: loadConfig({ ...CONFIG, METRICS_TOKEN: TOKEN }), metrics });
    const publisher = await connectClient(relay.url);
    publisher.sendRaw(JSON.stringify(fixture("session.create")));
    const session = relay.registry.get((await publisher.next()).sessionId as string)!;
    const viewer = await connectClient(relay.url);
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    expect((await viewer.next()).type).toBe("viewer.joined");
    let buffered = 12_345;
    Object.defineProperty([...session.viewers.values()][0]!.peer!, "bufferedAmount", {
      get: () => buffered,
    });
    vi.spyOn(CodeQuarantine.prototype, "evicted", "get").mockReturnValue(7);
    let values = await figures();
    expect(values.get("buffered_bytes")).toBe(12_345);
    expect(values.get("codes_evicted_total")).toBe(7);
    // The fan-out's watch closes a viewer above the hard watermark with its own error.
    buffered = HARD_WATERMARK_BYTES + 1;
    relay.clock.advance(WATCH_INTERVAL_MS);
    await expect.poll(() => metrics.errors.get("SLOW_CONSUMER")).toBe(1);
    // A snapshot whose chunks stop: the chunk timer's own error.
    publisher.send({
      type: "scene.snapshot.begin",
      sceneVersion: 1,
      byteLength: GLB.byteLength,
      sha256: sha256(GLB),
      chunkCount: 1,
      chunkSize: 64 * 1024,
      format: "glb",
      extensionsUsed: [],
    });
    await flush(publisher);
    relay.clock.advance(CHUNK_TIMEOUT_MS);
    await expect.poll(() => metrics.errors.get("BAD_SEQUENCE")).toBe(1);
    values = await figures();
    expect(values.get('errors_total{code="SLOW_CONSUMER"}')).toBe(1);
    expect(values.get('errors_total{code="BAD_SEQUENCE"}')).toBe(1);
  });
});

describe("renderMetrics", () => {
  it("prints each counter and gauge with its value", () => {
    const metrics = new Metrics();
    metrics.relayed(10);
    metrics.relayed(5);
    metrics.joinFailed();
    metrics.rateLimited("ban");
    metrics.reconnected("publisher");
    metrics.error("SESSION_FULL");
    metrics.error("SESSION_FULL");
    // Not a protocol code: no series of its own (the label set stays fixed).
    metrics.error("NOT_A_CODE" as ErrorCode);
    metrics.error('X"} 1\nfoo' as ErrorCode);
    expect(metrics.errors.size).toBe(ERROR_CODES.length);
    const text = renderMetrics(metrics, {
      sessions: 3,
      viewers: 7,
      snapshotBytes: 100,
      bufferedBytes: 42,
      codesEvicted: 4,
    });
    expect(text).not.toContain("NOT_A_CODE");
    expect(text.match(/^errors_total\{/gm)).toHaveLength(ERROR_CODES.length);
    const values = samples(text);
    expect(values.get("bytes_relayed_total")).toBe(15);
    expect(values.get("join_failures_total")).toBe(1);
    expect(values.get('ratelimit_hits_total{limit="ban"}')).toBe(1);
    expect(values.get('reconnects_total{role="publisher"}')).toBe(1);
    expect(values.get('errors_total{code="SESSION_FULL"}')).toBe(2);
    expect(values.get("sessions_active")).toBe(3);
    expect(values.get("viewers_active")).toBe(7);
    expect(values.get("snapshot_bytes_cached")).toBe(100);
    expect(values.get("buffered_bytes")).toBe(42);
    expect(values.get("codes_evicted_total")).toBe(4);
  });
});
