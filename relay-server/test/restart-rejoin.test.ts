import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, listenTextResolver } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Metrics } from "../src/metrics.js";
import { RateLimiter } from "../src/ratelimit.js";
import { INVALID_CODE_JITTER_MS } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient } from "./helpers/ws-client.js";
import type { TestClient } from "./helpers/ws-client.js";

const CONFIG = { TRUST_PROXY: "false", ALLOWED_ORIGINS: "https://relay.example.org" };
/** The presenter's code before the restart; it asks for it again (`preferredCode`, §13 step 9). */
const CODE = "7KQ4X";
const VIEWERS = 20;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A freshly started relay, as `src/index.ts` builds it unless `noGrace` swaps in a limiter without the grace. */
async function restarted(noGrace: boolean) {
  const clock = new ManualClock();
  const metrics = new Metrics();
  const logger = createLogger({ level: "silent" });
  app = await buildApp({
    config: loadConfig(CONFIG),
    clock,
    metrics,
    logger,
    heartbeat: false,
    ...(noGrace && { limiter: new RateLimiter({ clock, logger, metrics }) }),
  });
  await app.listen({ port: 0, host: "127.0.0.1", listenTextResolver });
  const { port } = app.server.address() as AddressInfo;
  return { clock, metrics, url: `ws://127.0.0.1:${port}/ws` };
}

const codeJoin = (client: TestClient): void =>
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: CODE }));

/**
 * One round of the room's code joins before the presenter is back: each viewer's join is refused
 * `INVALID_CODE` (counted a failure) or `RATE_LIMITED` (10/min from the address, or a ban); every
 * socket ends.
 */
async function round(
  clock: ManualClock,
  metrics: Metrics,
  clients: TestClient[],
): Promise<string[]> {
  const answered = (): number =>
    metrics.joinFailures + metrics.rateLimitHits.get("join")! + metrics.rateLimitHits.get("ban")!;
  const before = answered();
  for (const client of clients) codeJoin(client);
  await expect.poll(answered).toBe(before + clients.length);
  clock.advance(INVALID_CODE_JITTER_MS.max);
  const answers = await Promise.all(clients.map((client) => client.next()));
  await Promise.all(clients.map((client) => client.closed));
  return answers.map((answer) => answer.code as string);
}

describe("viewer joins after a relay restart (SRV-28)", () => {
  it("20 viewers behind one address: token rejoins, two rounds of code joins, no ban; all join once the presenter is back", async () => {
    const { clock, metrics, url } = await restarted(false);
    // Each viewer's token died with the old instance: SESSION_NOT_FOUND, then its code join on
    // the same socket (§9.2, SRV-15).
    const sockets: TestClient[] = [];
    for (let i = 0; i < VIEWERS; i++) {
      const client = await connectClient(url);
      client.sendRaw(JSON.stringify(fixture("viewer.join", "valid-rejoin")));
      expect(await client.next()).toMatchObject({ type: "error", code: "SESSION_NOT_FOUND" });
      sockets.push(client);
    }
    // WEB-14 waits ≈ 5 s before the code join. More joins per viewer within a minute (its 15 and
    // 35 s retries) would only add RATE_LIMITED answers, which never count towards the ban.
    clock.advance(5_000);
    const first = await round(clock, metrics, sockets);
    expect(first.filter((c) => c === "INVALID_CODE")).toHaveLength(10);
    expect(first.filter((c) => c === "RATE_LIMITED")).toHaveLength(10);
    // A minute later the room tries again on new sockets: 20 failures in all, within the grace.
    clock.advance(60_000);
    const retries: TestClient[] = [];
    for (let i = 0; i < VIEWERS; i++) retries.push(await connectClient(url));
    const second = await round(clock, metrics, retries);
    expect(second.filter((c) => c === "INVALID_CODE")).toHaveLength(10);
    expect(metrics.joinFailures).toBe(20);
    expect(metrics.rateLimitHits.get("ban")).toBe(0);

    // The presenter is back with its code (a probe, within the grace too).
    clock.advance(1_000);
    const presenter = await connectClient(url);
    presenter.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode: CODE }));
    expect(await presenter.next()).toMatchObject({ type: "session.created", code: CODE });
    // After the grace and a free minute, all 20 join: right codes give their attempts back.
    clock.advance(60_000);
    for (let i = 0; i < VIEWERS; i++) {
      const viewer = await connectClient(url);
      codeJoin(viewer);
      expect((await viewer.next()).type).toBe("viewer.joined");
    }
    expect(metrics.rateLimitHits.get("ban")).toBe(0);
  });

  it("one code join per SESSION_NOT_FOUND socket: a second one is refused (criterion 3)", async () => {
    const { clock, url } = await restarted(false);
    clock.advance(1_000);
    const presenter = await connectClient(url);
    presenter.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode: CODE }));
    expect(await presenter.next()).toMatchObject({ code: CODE });
    const viewer = await connectClient(url);
    viewer.sendRaw(JSON.stringify(fixture("viewer.join", "valid-rejoin")));
    expect(await viewer.next()).toMatchObject({ code: "SESSION_NOT_FOUND" });
    codeJoin(viewer);
    expect((await viewer.next()).type).toBe("viewer.joined");
    codeJoin(viewer);
    let answer = await viewer.next();
    while (answer.type !== "error") answer = await viewer.next(); // scene.state, viewer.count
    expect(answer).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("without the grace the same room bans itself for 10 minutes", async () => {
    const { clock, metrics, url } = await restarted(true);
    for (let r = 0; r < 2; r++) {
      const clients: TestClient[] = [];
      for (let i = 0; i < VIEWERS; i++) clients.push(await connectClient(url));
      await round(clock, metrics, clients);
      clock.advance(60_000);
    }
    expect(metrics.joinFailures).toBe(20);
    const late = await connectClient(url);
    codeJoin(late);
    const refused = await late.next();
    expect(refused).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    expect((refused.details as { retryAfterS: number }).retryAfterS).toBeGreaterThan(400);
  });
});
