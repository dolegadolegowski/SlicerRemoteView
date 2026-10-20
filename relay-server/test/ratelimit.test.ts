import { afterEach, describe, expect, it } from "vitest";
import { ALPHABET, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { addressBucket, MAX_TRACKED_KEYS, RATE_LIMITS, RateLimiter } from "../src/ratelimit.js";
import { INVALID_CODE_JITTER_MS } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const MINUTE = 60_000;

function setup(options: { maxKeys?: number } = {}) {
  const clock = new ManualClock();
  const lines: string[] = [];
  const limiter = new RateLimiter({
    clock,
    logger: createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
    ...options,
  });
  return { clock, limiter, lines, key: limiter.clientKey("203.0.113.7") };
}

describe("RateLimiter (unit, §12)", () => {
  it("keys are HMACs of the address under a per-boot secret", () => {
    const a = setup();
    const b = setup();
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(a.limiter.clientKey("203.0.113.7")).toBe(a.key);
    expect(b.key).not.toBe(a.key); // another boot, another secret
    expect(a.limiter.clientKey("203.0.113.8")).not.toBe(a.key);
  });

  it("sliding windows: 30 upgrades and 5 creates per minute", () => {
    const { clock, limiter, key } = setup();
    for (let i = 0; i < RATE_LIMITS.upgradesPerMinute; i++)
      expect(limiter.upgrade(key).ok).toBe(true);
    expect(limiter.upgrade(key)).toEqual({ ok: false, retryAfterS: 60 });
    clock.advance(30_000);
    expect(limiter.upgrade(key)).toEqual({ ok: false, retryAfterS: 30 });
    clock.advance(30_000);
    expect(limiter.upgrade(key).ok).toBe(true);
    for (let i = 0; i < RATE_LIMITS.createsPerMinute; i++)
      expect(limiter.create(key).ok).toBe(true);
    expect(limiter.create(key).ok).toBe(false);
  });

  it("10 join attempts per minute; a successful join gives its attempt back", () => {
    const { limiter, key } = setup();
    for (let i = 0; i < 25; i++) {
      expect(limiter.join(key).ok).toBe(true);
      limiter.joinSucceeded(key);
    }
    for (let i = 0; i < RATE_LIMITS.joinsPerMinute; i++) expect(limiter.join(key).ok).toBe(true);
    expect(limiter.join(key)).toMatchObject({ ok: false });
  });

  it("20 failures within 10 minutes ban the client for 10 minutes", () => {
    const { clock, limiter, key, lines } = setup();
    for (let i = 0; i < RATE_LIMITS.failuresBeforeBan - 1; i++) {
      clock.advance(25_000);
      limiter.joinFailed(key);
    }
    expect(limiter.checkBan(key).ok).toBe(true);
    limiter.joinFailed(key);
    expect(limiter.checkBan(key)).toEqual({ ok: false, retryAfterS: 600 });
    expect(limiter.join(key)).toEqual({ ok: false, retryAfterS: 600 });
    clock.advance(5 * MINUTE);
    expect(limiter.join(key)).toEqual({ ok: false, retryAfterS: 300 });
    clock.advance(5 * MINUTE);
    expect(limiter.join(key).ok).toBe(true);
    expect(lines.join("")).not.toContain("203.0.113.7");
  });

  it("failures older than 10 minutes do not count", () => {
    const { clock, limiter, key } = setup();
    for (let i = 0; i < 40; i++) {
      clock.advance(32_000); // at most 19 within any 10 minutes
      limiter.joinFailed(key);
    }
    expect(limiter.checkBan(key).ok).toBe(true);
  });

  it("global alarm above 1,000 failures per hour: one warn with counts, 3 joins/min for an hour", () => {
    const { clock, limiter, lines } = setup();
    for (let i = 0; i <= RATE_LIMITS.alarmFailuresPerHour; i++)
      limiter.joinFailed(limiter.clientKey(`10.0.${i >> 8}.${i & 255}`));
    expect(limiter.alarmActive).toBe(true);
    const alarms = lines.filter((l) => l.includes("join_failure_alarm"));
    expect(alarms).toHaveLength(1);
    expect(JSON.parse(alarms[0]!)).toMatchObject({ level: "warn", failuresLastHour: 1_001 });
    const key = limiter.clientKey("192.0.2.1");
    for (let i = 0; i < RATE_LIMITS.joinsPerMinuteAlarm; i++)
      expect(limiter.join(key).ok).toBe(true);
    expect(limiter.join(key).ok).toBe(false);
    // Further failures within the hour neither repeat nor extend the alarm.
    clock.advance(30 * MINUTE);
    for (let i = 0; i < 50; i++) limiter.joinFailed(limiter.clientKey(`10.1.0.${i}`));
    expect(lines.filter((l) => l.includes("join_failure_alarm"))).toHaveLength(1);
    clock.advance(30 * MINUTE);
    // The first 1,001 failures are an hour old now: one more failure raises nothing.
    limiter.joinFailed(limiter.clientKey("10.3.0.1"));
    expect(limiter.alarmActive).toBe(false);
    // 50 (minute 30) + 1 + 950 more = 1,001 within the hour → the second alarm, exactly then.
    for (let i = 0; i < 949; i++)
      limiter.joinFailed(limiter.clientKey(`10.2.${i >> 8}.${i & 255}`));
    expect(limiter.alarmActive).toBe(false);
    limiter.joinFailed(limiter.clientKey("10.3.0.2"));
    const both = lines.filter((l) => l.includes("join_failure_alarm"));
    expect(both).toHaveLength(2);
    expect(JSON.parse(both[1]!)).toMatchObject({ failuresLastHour: 1_001 });
  });

  it("pins the §12 values", () => {
    expect(RATE_LIMITS).toEqual({
      upgradesPerMinute: 30,
      joinsPerMinute: 10,
      joinsPerMinuteAlarm: 3,
      createsPerMinute: 5,
      failuresBeforeBan: 20,
      failureWindowMs: 600_000,
      banMs: 600_000,
      alarmFailuresPerHour: 1_000,
      alarmMs: 3_600_000,
    });
  });

  it("sweep forgets idle clients; bans survive it", () => {
    const { clock, limiter, key } = setup();
    const other = limiter.clientKey("192.0.2.2");
    limiter.upgrade(other);
    for (let i = 0; i < RATE_LIMITS.failuresBeforeBan; i++) limiter.joinFailed(key);
    clock.advance(2 * MINUTE);
    limiter.sweep();
    expect([...limiter.keys()]).toEqual([]); // no window holds anything any more …
    expect(limiter.checkBan(key)).toEqual({ ok: false, retryAfterS: 480 }); // … the ban stays
    clock.advance(8 * MINUTE);
    limiter.sweep();
    expect(limiter.checkBan(key).ok).toBe(true);
    // A key holding only one failure is forgotten when the failure leaves its 10-minute window.
    const failed = limiter.clientKey("192.0.2.3");
    limiter.joinFailed(failed);
    clock.advance(9 * MINUTE);
    limiter.sweep();
    expect([...limiter.keys()]).toEqual([failed]);
    clock.advance(2 * MINUTE);
    limiter.sweep();
    expect([...limiter.keys()]).toEqual([]);
  });

  it("at the cap, the ban that started first is dropped to make room for a new one", () => {
    const { limiter } = setup({ maxKeys: 2 });
    const [a, b, c] = ["a", "b", "c"].map((ip) => limiter.clientKey(ip)) as [
      string,
      string,
      string,
    ];
    for (const key of [a, b, c])
      for (let i = 0; i < RATE_LIMITS.failuresBeforeBan; i++) limiter.joinFailed(key);
    expect([a, b, c].map((key) => limiter.checkBan(key).ok)).toEqual([true, false, false]);
  });

  it(`tracks at most ${MAX_TRACKED_KEYS} keys, least recently used first; evicting never lifts a ban`, () => {
    const { limiter } = setup({ maxKeys: 3 });
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((ip) => limiter.clientKey(ip)) as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const key of [a, b, c]) limiter.upgrade(key);
    limiter.upgrade(a); // a is now the most recently used
    limiter.upgrade(d);
    expect([...limiter.keys()]).toEqual([c, a, d]);
    for (let i = 0; i < RATE_LIMITS.failuresBeforeBan; i++) limiter.joinFailed(c);
    limiter.upgrade(a);
    limiter.upgrade(d); // c (banned) is now the least recently used
    limiter.upgrade(e);
    expect([...limiter.keys()]).toEqual([a, d, e]);
    expect(limiter.checkBan(c).ok).toBe(false);
  });

  it("retryAfterS names the slot that frees first when the alarm lowered the limit", () => {
    const { clock, limiter, key } = setup();
    for (let i = 0; i < RATE_LIMITS.joinsPerMinute; i++) {
      expect(limiter.join(key).ok).toBe(true);
      clock.advance(5_000);
    }
    // 10 attempts at 0, 5, …, 45 s; now 50 s. The alarm lowers the limit to 3.
    for (let i = 0; i <= RATE_LIMITS.alarmFailuresPerHour; i++)
      limiter.joinFailed(limiter.clientKey(`10.0.${i >> 8}.${i & 255}`));
    // The 3rd-newest attempt (35 s) expires at 95 s.
    expect(limiter.join(key)).toEqual({ ok: false, retryAfterS: 45 });
    clock.advance(44_999);
    expect(limiter.join(key).ok).toBe(false);
    clock.advance(1);
    expect(limiter.join(key).ok).toBe(true);
  });
});

describe("addressBucket (an IPv6 subscriber is one client)", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:aaaa::1", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["::ffff:0:c000:201", "192.0.2.1"],
    ["::192.0.2.1", "192.0.2.1"],
    ["::", "0:0:0:0::/64"],
    ["203.0.113.7:5678", "203.0.113.7"],
    ["[2001:db8:1:2::1]:443", "2001:db8:1:2::/64"],
    [" 203.0.113.7 ", "203.0.113.7"],
    [undefined, "unknown"],
    ["not-an-ip", "not-an-ip"],
  ])("%s → %s", (ip, bucket) => {
    expect(addressBucket(ip)).toBe(bucket);
  });

  it("reports an address that is no IP literal once, without the value", () => {
    const { limiter, lines } = setup();
    limiter.clientKey("edge-host-7");
    limiter.clientKey("edge-host-8");
    limiter.clientKey("2001:db8::1");
    const warned = lines.filter((l) => l.includes("client_address_not_ip"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain("edge-host");
  });

  it("two addresses of one /64 share a key; another /64 does not", () => {
    const { limiter } = setup();
    expect(limiter.clientKey("2001:db8:1:2::a")).toBe(limiter.clientKey("2001:db8:1:2:9::b"));
    expect(limiter.clientKey("2001:db8:1:3::a")).not.toBe(limiter.clientKey("2001:db8:1:2::a"));
    expect(limiter.clientKey("::ffff:192.0.2.1")).toBe(limiter.clientKey("192.0.2.1"));
  });
});

// --- Integration: real sockets, one relay with TRUST_PROXY so tests choose the client address ---

let relay: TestRelay | undefined;
let lines: string[] = [];
afterEach(async () => {
  await relay?.close();
  relay = undefined;
  lines = [];
});

async function start(): Promise<TestRelay> {
  relay = await startRelay({
    config: loadConfig({ TRUST_PROXY: "true", ALLOWED_ORIGINS: "https://relay.example.org" }),
    logger: createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
  });
  return relay;
}

/** A client whose address, as the relay sees it behind the edge, is `ip`. */
const from = (ip: string): Promise<TestClient> =>
  connectClient(relay!.url, { "x-forwarded-for": ip });

async function nextValid(client: TestClient): Promise<Received> {
  const message = await client.next();
  expect(validateMessage(message)).toMatchObject({ ok: true });
  return message;
}

async function liveCode(ip = "192.0.2.200"): Promise<string> {
  const client = await from(ip);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  return (await nextValid(client)).code as string;
}

function unusedCode(): string {
  for (const a of ALPHABET) {
    const code = `${a}3333`;
    if (relay!.registry.getByCode(code) === undefined && !relay!.registry.isCodeQuarantined(code))
      return code;
  }
  throw new Error("no unused code");
}

/** A failed join from `ip`, answered after the jitter; returns the error. */
async function failedJoin(ip: string): Promise<Received> {
  const client = await from(ip);
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: unusedCode() }));
  const before = lines.length;
  await expect.poll(() => lines.slice(before).some((l) => l.includes("INVALID_CODE"))).toBe(true);
  relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
  const error = await nextValid(client);
  expect(await client.closed).toBe(4004);
  return error;
}

async function join(ip: string, code: string): Promise<Received> {
  const client = await from(ip);
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code }));
  const answer = await nextValid(client);
  return Object.assign(answer, { client });
}

describe("join limit (SRV-08 criterion 1, §12)", () => {
  it("the 11th join attempt within a minute → RATE_LIMITED{retryAfterS} + 4006; right codes do not count", async () => {
    await start();
    const code = await liveCode();
    const classroom = "203.0.113.10";
    // 15 students behind one NAT join within the same minute (ADR 0008 consequences); with the 10
    // failures and the 11th attempt below that is 26 upgrades, under the 30/min upgrade limit.
    for (let i = 0; i < 15; i++) expect((await join(classroom, code)).type).toBe("viewer.joined");
    for (let i = 0; i < RATE_LIMITS.joinsPerMinute; i++)
      expect((await failedJoin(classroom)).code).toBe("INVALID_CODE");
    const limited = await join(classroom, code); // even a right code waits now
    expect(limited).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      retryable: true,
      // The oldest failure is 10 × 150 ms of jitter old: its slot frees in 58.5 s.
      details: { retryAfterS: 59 },
    });
    expect(await (limited as unknown as { client: TestClient }).client.closed).toBe(4006);
    // Another address is unaffected; the window slides.
    expect((await join("198.51.100.20", code)).type).toBe("viewer.joined");
    relay!.clock.advance(60_000);
    expect((await join(classroom, code)).type).toBe("viewer.joined");
  });
});

describe("lockout and upgrade limit (SRV-08 criterion 2, §12, T1, T3)", () => {
  it("20 failed joins within 10 minutes ban the address for 10 minutes", async () => {
    await start();
    const code = await liveCode();
    const attacker = "203.0.113.66";
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 10; i++) expect((await failedJoin(attacker)).code).toBe("INVALID_CODE");
      relay!.clock.advance(60_000);
    }
    // The ban started at the 20th failure, 60 s (+ jitter) ago.
    const banned = await join(attacker, code);
    expect(banned).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterS: 540 } });
    expect(await (banned as unknown as { client: TestClient }).client.closed).toBe(4006);
    expect((await join("198.51.100.21", code)).type).toBe("viewer.joined");
    relay!.clock.advance(540_000);
    expect((await join(attacker, code)).type).toBe("viewer.joined");
  });

  it("answers RATE_LIMITED{retryAfterS:600} right after the ban starts", async () => {
    await start();
    const attacker = "203.0.113.67";
    for (let i = 0; i < 10; i++) await failedJoin(attacker);
    relay!.clock.advance(60_000);
    for (let i = 0; i < 9; i++) await failedJoin(attacker);
    await failedJoin(attacker); // the 20th: banned from here
    const client = await from(attacker);
    client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: unusedCode() }));
    expect(await nextValid(client)).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterS: 600 },
    });
    expect(await client.closed).toBe(4006);
  });

  it("the 31st upgrade from one address within a minute → HTTP 429 + Retry-After, before the upgrade", async () => {
    await start();
    for (let i = 0; i < RATE_LIMITS.upgradesPerMinute; i++) (await from("203.0.113.80")).ws.close();
    await expect(from("203.0.113.80")).rejects.toMatchObject({
      statusCode: 429,
      headers: { "retry-after": "60" },
    });
    (await from("203.0.113.81")).ws.close();
    expect(lines.join("")).not.toContain("203.0.113.8");
    relay!.clock.advance(60_000);
    (await from("203.0.113.80")).ws.close();
  });

  it("upgrades refused for their Origin do not spend the budget (no NAT lockout from a foreign page)", async () => {
    await start();
    for (let i = 0; i < RATE_LIMITS.upgradesPerMinute + 5; i++)
      await expect(
        connectClient(relay!.url, {
          "x-forwarded-for": "203.0.113.82",
          origin: "https://ads.example",
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    (await from("203.0.113.82")).ws.close();
  });

  it("rotating through one IPv6 /64 does not buy a fresh budget", async () => {
    await start();
    for (let i = 0; i < RATE_LIMITS.upgradesPerMinute; i++)
      (await from(`2001:db8:5:6::${(i + 1).toString(16)}`)).ws.close();
    await expect(from("2001:db8:5:6:ffff::1")).rejects.toMatchObject({ statusCode: 429 });
    (await from("2001:db8:5:7::1")).ws.close();
  });

  it("the limiter sweep runs with the server: idle addresses are forgotten", async () => {
    await start();
    (await from("203.0.113.83")).ws.close();
    expect([...relay!.limiter.keys()]).toHaveLength(1);
    relay!.clock.advance(60_000);
    expect([...relay!.limiter.keys()]).toEqual([]);
  });

  it("SESSION_FULL gives the attempt back: a full session does not lock its address out", async () => {
    relay = await startRelay({
      config: loadConfig({
        TRUST_PROXY: "true",
        MAX_VIEWERS: "1",
        ALLOWED_ORIGINS: "https://relay.example.org",
      }),
    });
    const code = await liveCode();
    expect((await join("203.0.113.84", code)).type).toBe("viewer.joined");
    for (let i = 0; i <= RATE_LIMITS.joinsPerMinute; i++)
      expect(await join("203.0.113.84", code)).toMatchObject({ code: "SESSION_FULL" });
  });

  it("session.create: 5 per minute, then RATE_LIMITED + 4006", async () => {
    await start();
    for (let i = 0; i < RATE_LIMITS.createsPerMinute; i++) await liveCode("203.0.113.90");
    const client = await from("203.0.113.90");
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect(await nextValid(client)).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { retryAfterS: 60 },
    });
    expect(await client.closed).toBe(4006);
  });

  it("failed joins of viewers behind the presenter's NAT do not cost a redeployed presenter the code (§4.3)", async () => {
    await start();
    const presenterNat = "203.0.113.96";
    const old = unusedCode(); // the code on the screen before the relay restarted
    for (let i = 0; i < RATE_LIMITS.joinsPerMinute; i++) {
      const client = await from(presenterNat);
      client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: old }));
      const before = lines.length;
      await expect
        .poll(() => lines.slice(before).some((l) => l.includes("INVALID_CODE")))
        .toBe(true);
      relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
      expect((await nextValid(client)).code).toBe("INVALID_CODE");
    }
    const presenter = await from(presenterNat);
    presenter.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode: old }));
    expect(await nextValid(presenter)).toMatchObject({ type: "session.created", code: old });
  });

  it("a create without a preferredCode, or with a malformed one, costs no join budget", async () => {
    await start();
    const code = await liveCode();
    const address = "203.0.113.98";
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % RATE_LIMITS.createsPerMinute === 0) relay!.clock.advance(60_000);
      const client = await from(address);
      const preferredCode = [null, "abc1", "0OIL1"][i % 3];
      client.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode }));
      const answer = await nextValid(client);
      expect(answer.type, JSON.stringify(answer)).toMatch(/^(session\.created|error)$/);
    }
    expect(relay!.limiter.checkBan(relay!.limiter.clientKey(address)).ok).toBe(true);
    expect((await join(address, code)).type).toBe("viewer.joined");
  });

  it("during the global alarm a preferredCode probe stays within the 3/min join window", async () => {
    await start();
    for (let i = 0; i <= RATE_LIMITS.alarmFailuresPerHour; i++)
      relay!.limiter.joinFailed(relay!.limiter.clientKey(`10.9.${i >> 8}.${i & 255}`));
    expect(relay!.limiter.alarmActive).toBe(true);
    const address = "203.0.113.99";
    for (let i = 0; i < RATE_LIMITS.joinsPerMinuteAlarm; i++) await failedJoin(address);
    const free = unusedCode();
    const client = await from(address);
    client.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode: free }));
    expect(await nextValid(client)).toMatchObject({ type: "session.created" });
    expect(client.received.at(-1)!.code).not.toBe(free);
  });

  it("token rejoins are not counted (§12)", async () => {
    await start();
    const code = await liveCode();
    const address = "203.0.113.97";
    for (let i = 0; i < 25; i++) {
      const client = await from(address);
      client.sendRaw(
        JSON.stringify({
          ...fixture("viewer.join", "valid-rejoin"),
        }),
      );
      expect((await nextValid(client)).code).toBe("SESSION_NOT_FOUND");
      client.ws.close();
      if (i % 20 === 19) relay!.clock.advance(60_000); // stay under the upgrade limit
    }
    expect(relay!.limiter.checkBan(relay!.limiter.clientKey(address)).ok).toBe(true);
    expect((await join(address, code)).type).toBe("viewer.joined");
  });

  it("every preferredCode probe counts like a failed join, granted or not; a banned address gets none", async () => {
    await start();
    const taken = await liveCode("192.0.2.1");
    const prober = "203.0.113.95";
    const create = async (preferredCode: string): Promise<string> => {
      const client = await from(prober);
      client.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode }));
      const created = await nextValid(client);
      expect(created.type).toBe("session.created");
      return created.code as string;
    };
    // Mostly misses (free codes, granted), as a guesser would see them, plus one hit.
    for (let i = 0; i < RATE_LIMITS.failuresBeforeBan; i++) {
      if (i > 0 && i % RATE_LIMITS.createsPerMinute === 0) relay!.clock.advance(60_000);
      if (i === 7) expect(await create(taken)).not.toBe(taken);
      else {
        const free = unusedCode();
        expect(await create(free)).toBe(free);
      }
    }
    expect(relay!.limiter.checkBan(relay!.limiter.clientKey(prober)).ok).toBe(false);
    relay!.clock.advance(60_000);
    const free = unusedCode();
    expect(await create(free)).not.toBe(free); // ignored while banned: no oracle
  });
});

describe("privacy of the limiter (SRV-08 criterion 3, NFR-12, NFR-13, FR-26)", () => {
  it("keeps only HMAC keys and never logs an address", async () => {
    await start();
    const code = await liveCode("192.0.2.33");
    for (let i = 0; i < 10; i++) await failedJoin("203.0.113.44");
    await join("203.0.113.44", code); // rate limited
    await join("198.51.100.55", code);
    const keys = [...relay!.limiter.keys()];
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    const state = JSON.stringify(keys);
    const log = lines.join("");
    for (const ip of ["192.0.2.33", "203.0.113.44", "198.51.100.55", "127.0.0.1"]) {
      expect(state).not.toContain(ip);
      expect(log).not.toContain(ip);
    }
  });
});
