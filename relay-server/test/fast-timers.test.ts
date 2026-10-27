import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, listenTextResolver } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { FAST_TIMER_SCALE, RESTART_GRACE_MS } from "../src/ratelimit.js";
import { FAST_SWEEP_INTERVAL_MS, Registry } from "../src/registry.js";
import { INVALID_CODE_JITTER_MS } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient } from "./helpers/ws-client.js";

/** The 31st upgrade from one address within the window: its `Retry-After`, in seconds. */
async function upgradeRetryAfter(url: string): Promise<string | undefined> {
  for (let i = 0; i < 30; i++) await connectClient(url);
  const refused = (await connectClient(url).then(
    () => ({}),
    (error: unknown) => error,
  )) as { statusCode?: number; headers?: Record<string, string> };
  expect(refused.statusCode).toBe(429);
  return refused.headers?.["retry-after"];
}

const CONFIG = { TRUST_PROXY: "false", ALLOWED_ORIGINS: "https://relay.example.org" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The app as `src/index.ts` builds it (its own limiter), on a manual clock. */
async function relay(env: Record<string, string>) {
  const clock = new ManualClock();
  const config = loadConfig({ ...CONFIG, ...env });
  const registry = new Registry({ ...config, clock });
  const start = vi.spyOn(registry, "start");
  const lines: string[] = [];
  const metrics = new Metrics();
  app = await buildApp({
    config,
    clock,
    registry,
    metrics,
    logger: createLogger({ level: "info", destination: { write: (l) => lines.push(l) } }),
    heartbeat: false,
  });
  await app.listen({ port: 0, host: "127.0.0.1", listenTextResolver });
  const { port } = app.server.address() as AddressInfo;
  const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { clock, registry, start, metrics, logged, url: `ws://127.0.0.1:${port}/ws` };
}

describe("RELAY_TEST_FAST_TIMERS (SRV-29)", () => {
  it("QA-05 in seconds: 20 failed joins within 10 s ban the address for 10 s, then it joins", async () => {
    const { clock, start, metrics, logged, url } = await relay({
      NODE_ENV: "test",
      RELAY_TEST_FAST_TIMERS: "1",
    });
    expect(start).toHaveBeenCalledWith(FAST_SWEEP_INTERVAL_MS);
    expect(logged().find((l) => l.message === "relay starting")).toMatchObject({
      testFastTimers: true,
      restartGraceS: 2,
    });
    expect(logged().filter((l) => l.level === "warn")).toEqual([
      expect.objectContaining({ event: "test_fast_timers", timeScale: 60, sweepMs: 1_000 }),
    ]);

    const publisher = await connectClient(url);
    publisher.sendRaw(JSON.stringify(fixture("session.create")));
    const code = (await publisher.next()).code as string;
    clock.advance(RESTART_GRACE_MS / FAST_TIMER_SCALE); // the restart grace (SRV-28), 2 s here
    const wrong = code === "22222" ? "33333" : "22222";
    for (let i = 1; i <= 20; i++) {
      const guess = await connectClient(url);
      guess.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: wrong }));
      await expect.poll(() => metrics.joinFailures).toBe(i);
      clock.advance(INVALID_CODE_JITTER_MS.max + 250); // 20 × 400 ms: 8 s, ≤ 10 joins a second
      expect(await guess.closed).toBe(4004);
    }
    const banned = await connectClient(url);
    banned.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code }));
    const refused = await banned.next();
    expect(refused).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    expect((refused.details as { retryAfterS: number }).retryAfterS).toBe(10);
    expect(await banned.closed).toBe(4006);

    clock.advance(10_000);
    const viewer = await connectClient(url);
    viewer.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code }));
    expect((await viewer.next()).type).toBe("viewer.joined");
  });

  it("the app's own limiter: a second under the flag", async () => {
    const { url } = await relay({ NODE_ENV: "test", RELAY_TEST_FAST_TIMERS: "1" });
    expect(await upgradeRetryAfter(url)).toBe("1");
  });

  it.each([
    { NODE_ENV: "test" },
    { NODE_ENV: "production", RELAY_TEST_FAST_TIMERS: "1" },
    { NODE_ENV: " test", RELAY_TEST_FAST_TIMERS: "1" },
  ])("without it in effect (%o): real windows, the 10 s sweep, no warn line", async (env) => {
    const { start, logged, url } = await relay(env);
    expect(await upgradeRetryAfter(url)).toBe("60");
    expect(start).toHaveBeenCalledWith(undefined);
    expect(logged().find((l) => l.message === "relay starting")).toMatchObject({
      testFastTimers: false,
      restartGraceS: 120,
    });
    expect(logged().filter((l) => l.level === "warn")).toEqual([]);
  });
});
