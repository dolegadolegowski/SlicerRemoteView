// QA-05: negative tests of the join path and its limits, against the built relay with raw `ws` + `fetch` (no
// browser). Covers the per-IP join limit (10/min → `RATE_LIMITED` + `4006`), the lockout (20 failures in 10 min
// → ban with `details.retryAfterS`), uniform `INVALID_CODE` answers for malformed, unknown and released codes —
// identical bodies and no measurable timing difference (statistical test over 50 + 50 samples) —, `SESSION_FULL`
// + `4005` for the 21st viewer, correct joins not counting as failures, no code accepted or echoed in a URL path
// or query, the upgrade guards (foreign `Origin` → 403, `Sec-WebSocket-Protocol` → 400, 30 upgrades/min → 429,
// refused upgrades not counted) and the 10 s handshake timeout (`4012`).
//
// Requirements / threats: FR-22, FR-26, FR-31, FR-33, NFR-12, NFR-15; T1 (code guessing: limits, lockout, uniform
// answers; a foreign page driving visitors' browsers), T3 (connection floods, idle handshakes), T6 (codes in URL
// paths, queries or `Sec-WebSocket-Protocol`). Protocol: §3.1, §5.1–§5.2, §9.2–§9.3, §10, §12.
//
// Per-IP limits are per simulated client: the harness relay runs `TRUST_PROXY=true`, so each attempt claims its
// address with `X-Forwarded-For` (RFC 5737 documentation ranges). A failed join closes its socket (§12), so every
// attempt uses a new socket. Under `RELAY_TEST_FAST_TIMERS` the limiter's windows, ban and restart grace are 60×
// shorter (minute → 1 s, 10 min → 10 s, the SRV-28 grace 120 s → 2 s); counts stay (relay-server/README.md).
// Secrets (NFR-12): codes and tokens are compared with boolean checks only, never printed or put in a title.

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CLOSE_CODES } from "@slicerremoteview/shared";
import { expect, test } from "../harness/fixtures.ts";
import {
  attemptJoin,
  MALFORMED_CODES,
  mannWhitneyU,
  median,
  probeUpgrade,
  quantile,
  sleep,
  unknownCode,
  VIEWER_CLIENT_INFO,
} from "../harness/qa05-join.ts";
import type { JoinAttempt } from "../harness/qa05-join.ts";
import { connect, createSession, joinViewer, nextIp } from "../harness/ws-client.ts";
import type { Client, Message } from "../harness/ws-client.ts";

/** The `error` body without the envelope fields that legitimately differ per reply (§3.2). */
function bodyOf(message: Message): Record<string, unknown> {
  const { ts: _ts, replyTo: _replyTo, ...rest } = message;
  return rest;
}

/** Every response header as one `name: value` text (`Headers.forEach`, WHATWG Fetch; lib.dom has no iterator here). */
function headerText(headers: Headers): string {
  let text = "";
  headers.forEach((value, name) => (text += `${name}: ${value}\n`));
  return text;
}

function expectRefusal(attempt: JoinAttempt, code: string, close: number): void {
  expect(attempt.reply.type).toBe("error");
  expect(attempt.reply.code).toBe(code);
  expect(attempt.closed?.code).toBe(close);
}

/** `details.retryAfterS` of a `RATE_LIMITED` reply, checked to be a positive integer (§9.2). */
function retryAfterOf(message: Message): number {
  const details = message.details as { retryAfterS?: unknown } | undefined;
  const value = details?.retryAfterS;
  expect(Number.isInteger(value), "RATE_LIMITED carries an integer details.retryAfterS").toBe(true);
  return value as number;
}

test.describe("join rate limit and lockout", () => {
  // Real timers: the 10/min window is a minute, so sequential attempts cannot drift out of it.
  test("11th failed viewer.join from one IP within a minute is RATE_LIMITED + 4006, decided before the lookup", async ({
    stack,
  }) => {
    const ip = "203.0.113.11";
    const live = stack.code;
    for (let i = 1; i <= 10; i++) {
      const attempt = await attemptJoin(stack.wsUrl, unknownCode([live]), { ip });
      expectRefusal(attempt, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
    }
    const limited = await attemptJoin(stack.wsUrl, unknownCode([live]), { ip });
    expectRefusal(limited, "RATE_LIMITED", CLOSE_CODES.RATE_LIMITED);
    expect(limited.reply.retryable).toBe(true);
    const retryAfterS = retryAfterOf(limited.reply);
    expect(retryAfterS).toBeGreaterThan(0);
    expect(retryAfterS).toBeLessThanOrEqual(60);
    // Before the code is looked up (§12, T1): the live code gets the same refusal, so it is not revealed.
    const right = await attemptJoin(stack.wsUrl, live, { ip });
    expectRefusal(right, "RATE_LIMITED", CLOSE_CODES.RATE_LIMITED);
    expect(bodyOf(right.reply)).toEqual({ ...bodyOf(limited.reply), details: right.reply.details });
    // Per IP only: another address is unaffected.
    const other = await attemptJoin(stack.wsUrl, unknownCode([live]), { ip: "203.0.113.12" });
    expectRefusal(other, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
  });

  test("a correct join gives its attempt back: 9 failures + 5 correct joins + 1 failure is not limited", async ({
    stack,
  }) => {
    const ip = "203.0.113.21";
    const live = stack.code;
    for (let i = 0; i < 9; i++)
      expectRefusal(await attemptJoin(stack.wsUrl, unknownCode([live]), { ip }), "INVALID_CODE", 4004);
    const viewers: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const { client, joined } = await joinViewer(stack.wsUrl, live, { ip });
      expect(joined.type).toBe("viewer.joined");
      viewers.push(client);
    }
    // 15 attempts within the minute, but only the 10 failures stay in the window (RateLimiter.joinSucceeded).
    expectRefusal(await attemptJoin(stack.wsUrl, unknownCode([live]), { ip }), "INVALID_CODE", 4004);
    // The 10/min limit itself is unchanged: the next attempt is the 11th counted one.
    expectRefusal(await attemptJoin(stack.wsUrl, unknownCode([live]), { ip }), "RATE_LIMITED", 4006);
    for (const viewer of viewers) viewer.close();
  });

  test.describe("lockout (fast timers)", () => {
    test.use({ stackOptions: { fastTimers: true } });

    test("20 failed joins within the (scaled) 10 min window ban the IP; retryAfterS counts the ban down", async ({
      stack,
    }) => {
      test.setTimeout(90_000);
      const ip = "203.0.113.31";
      const live = stack.code;
      // SRV-28: failures in the first 120 s (2 s under fast timers) after start do not count towards the ban.
      await sleep(2_500);
      // ≥ 150 ms between attempt starts keeps every 1 s (scaled minute) window at ≤ 7 attempts, under the 10/min
      // limit, while 20 attempts still fit well inside the 10 s (scaled 10 min) failure window.
      const started = performance.now();
      for (let i = 1; i <= 20; i++) {
        const at = performance.now();
        const attempt = await attemptJoin(stack.wsUrl, unknownCode([live]), { ip });
        expectRefusal(attempt, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
        await sleep(Math.max(0, 150 - (performance.now() - at)));
      }
      const spentMs = performance.now() - started;
      expect(spentMs, "20 failures must land inside the 10 s scaled window (machine overloaded?)").toBeLessThan(9_000);

      const banned = await attemptJoin(stack.wsUrl, unknownCode([live]), { ip });
      expectRefusal(banned, "RATE_LIMITED", CLOSE_CODES.RATE_LIMITED);
      expect(banned.reply.retryable).toBe(true);
      const retryAfterS = retryAfterOf(banned.reply);
      // §12: seconds left of the ban, 600 at its start; 600 ÷ 60 = 10 under fast timers. A 1 s per-minute
      // refusal would report 1, so ≥ 5 shows it is the ban.
      expect(retryAfterS).toBeGreaterThan(0);
      expect(retryAfterS).toBeLessThanOrEqual(600);
      expect(retryAfterS).toBeGreaterThanOrEqual(5);
      expect(retryAfterS).toBeLessThanOrEqual(10);

      // The ban outlives the 1 s per-minute window and is decided before the lookup: the live code is refused.
      await sleep(1_200);
      const stillBanned = await attemptJoin(stack.wsUrl, live, { ip });
      expectRefusal(stillBanned, "RATE_LIMITED", CLOSE_CODES.RATE_LIMITED);
      const later = retryAfterOf(stillBanned.reply);
      expect(later).toBeGreaterThan(0);
      expect(later).toBeLessThan(retryAfterS);

      // Another address is not banned.
      const { client: bystander } = await joinViewer(stack.wsUrl, live, { ip: "203.0.113.32" });
      bystander.close();

      // Once the ban has run out the address joins again.
      await sleep(later * 1_000 + 500);
      await expect
        .poll(
          async () => {
            const attempt = await attemptJoin(stack.wsUrl, live, { ip });
            attempt.client.close();
            return attempt.reply.type === "error" ? String(attempt.reply.code) : attempt.reply.type;
          },
          { timeout: 10_000, intervals: [500, 1_000] },
        )
        .toBe("viewer.joined");
    });

    test("correct joins neither count towards the ban nor reset it: 19 failures + 3 joins + 1 failure ban", async ({
      stack,
    }) => {
      test.setTimeout(60_000);
      const ip = "203.0.113.33";
      const live = stack.code;
      await sleep(2_500); // SRV-28 restart grace (2 s under fast timers), as above.
      const started = performance.now();
      // One attempt per ≥ 150 ms: under the 10 per (scaled) minute, well inside the 10 s failure window.
      const paced = async <T>(attempt: () => Promise<T>): Promise<T> => {
        const at = performance.now();
        const result = await attempt();
        await sleep(Math.max(0, 150 - (performance.now() - at)));
        return result;
      };
      for (let i = 1; i <= 19; i++) {
        const attempt = await paced(() => attemptJoin(stack.wsUrl, unknownCode([live]), { ip }));
        expectRefusal(attempt, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
      }
      // Were a correct join a failure, the first of these would be the 20th and the next ones RATE_LIMITED.
      const viewers: Client[] = [];
      for (let i = 0; i < 3; i++) {
        const attempt = await paced(() => attemptJoin(stack.wsUrl, live, { ip }));
        expect(attempt.reply.type, `correct join ${i + 1} after 19 failures`).toBe("viewer.joined");
        viewers.push(attempt.client);
      }
      // … and they did not reset the count either: one more failure is the 20th and bans the address.
      expectRefusal(await paced(() => attemptJoin(stack.wsUrl, unknownCode([live]), { ip })), "INVALID_CODE", 4004);
      const spentMs = performance.now() - started;
      expect(spentMs, "23 attempts must land inside the 10 s scaled window (machine overloaded?)").toBeLessThan(9_000);
      const banned = await attemptJoin(stack.wsUrl, live, { ip });
      expectRefusal(banned, "RATE_LIMITED", CLOSE_CODES.RATE_LIMITED);
      // ≥ 5 s left: the 10 s ban, not a 1 s per-minute refusal (see the case above).
      expect(retryAfterOf(banned.reply)).toBeGreaterThanOrEqual(5);
      expect(retryAfterOf(banned.reply)).toBeLessThanOrEqual(10);
      for (const viewer of viewers) viewer.close();
    });
  });
});

test.describe("uniform INVALID_CODE answers (T1)", () => {
  test("malformed, unknown and released codes get identical error bodies and close 4004", async ({ stack }) => {
    const live = stack.code;
    // A released code: a session created and closed again (its code goes to the quarantine, §4.5).
    const { client: publisher, created } = await createSession(stack.wsUrl, { ip: nextIp() });
    const released = String(created.code);
    publisher.send({ type: "session.close", id: "p-2", reason: "USER_STOPPED" });
    await publisher.closedWithin(5_000);

    const cases: { kind: string; code: string }[] = [
      ...MALFORMED_CODES.map((code) => ({ kind: "malformed", code })),
      ...Array.from({ length: 6 }, () => ({ kind: "unknown", code: unknownCode([live, released]) })),
      { kind: "unknown, lower case", code: unknownCode([live, released]).toLowerCase() },
      { kind: "released", code: released },
    ];
    const attempts = await Promise.all(
      cases.map((c) => attemptJoin(stack.wsUrl, c.code, { ip: nextIp(), id: "v-1" })),
    );
    const reference = bodyOf(attempts[0]!.reply);
    expect(reference).toMatchObject({ protocolVersion: "1.0", type: "error", code: "INVALID_CODE", retryable: false });
    for (const [i, attempt] of attempts.entries()) {
      const kind = cases[i]!.kind;
      expectRefusal(attempt, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
      // §9.2: the reply never carries the code that was tried. Checked first, so a failing `toEqual` below can
      // never print a code in its diff.
      const tried = cases[i]!.code.trim().toUpperCase();
      const text = (JSON.stringify(attempt.reply) + String(attempt.closed?.reason)).toUpperCase();
      if (tried.length >= 3) expect(text.includes(tried), `${kind}: code echoed in the error or close`).toBe(false);
      expect(attempt.reply.replyTo, `${kind}: replyTo echoes the id`).toBe("v-1");
      expect(typeof attempt.reply.ts, `${kind}: ts is a number`).toBe("number");
      expect(bodyOf(attempt.reply), `${kind}: body identical to the first refusal`).toEqual(reference);
      expect(attempt.closed?.reason, `${kind}: close reason identical`).toBe(attempts[0]!.closed?.reason);
    }
  });

  test("timing: malformed and unknown codes are indistinguishable over 50 + 50 samples", async ({ stack }) => {
    const live = stack.code;
    const samples = { malformed: [] as number[], unknown: [] as number[] };
    // Interleaved batches (5 + 5 in parallel), so load drift on the shared machine hits both groups alike. Every
    // attempt has its own address: 100 attempts from one IP would hit the 10/min limit and the ban.
    for (let batch = 0; batch < 10; batch++) {
      const jobs: Promise<void>[] = [];
      for (let k = 0; k < 5; k++) {
        const malformed = MALFORMED_CODES[(batch * 5 + k) % MALFORMED_CODES.length]!;
        jobs.push(
          attemptJoin(stack.wsUrl, malformed, { ip: nextIp() }).then((a) => {
            expectRefusal(a, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
            samples.malformed.push(a.elapsedMs);
          }),
          attemptJoin(stack.wsUrl, unknownCode([live]), { ip: nextIp() }).then((a) => {
            expectRefusal(a, "INVALID_CODE", CLOSE_CODES.INVALID_CODE);
            samples.unknown.push(a.elapsedMs);
          }),
        );
      }
      await Promise.all(jobs);
    }
    expect(samples.malformed).toHaveLength(50);
    expect(samples.unknown).toHaveLength(50);

    const stats = (values: number[]) => ({
      min: Math.min(...values),
      q10: quantile(values, 0.1),
      median: median(values),
      q90: quantile(values, 0.9),
    });
    const m = stats(samples.malformed);
    const u = stats(samples.unknown);
    const test_ = mannWhitneyU(samples.malformed, samples.unknown);
    const round = (x: number) => Math.round(x * 10) / 10;
    test.info().annotations.push({
      type: "timing",
      description:
        `malformed min/q10/median/q90 ${round(m.min)}/${round(m.q10)}/${round(m.median)}/${round(m.q90)} ms; ` +
        `unknown ${round(u.min)}/${round(u.q10)}/${round(u.median)}/${round(u.q90)} ms; ` +
        `Mann-Whitney U ${test_.u}, z ${round(test_.z)}, p ${test_.p.toFixed(3)}`,
    });

    // The relay delays every INVALID_CODE by a uniform random 50–150 ms (ws/viewer.ts INVALID_CODE_JITTER_MS):
    // both groups must show that band — nothing answered before 50 ms, a spread of tens of ms.
    for (const s of [m, u]) {
      expect(s.min).toBeGreaterThanOrEqual(45);
      expect(s.q90 - s.q10).toBeGreaterThanOrEqual(30);
      expect(s.median).toBeLessThan(400);
    }
    // No measurable difference: the medians agree well inside the 100 ms jitter band (the standard error of a
    // median of 50 uniform(50, 150) draws is ≈ 5 ms, so 25 ms is ≈ 3.5 σ of the difference), and a rank test
    // finds no shift (false-alarm rate 1 % by design; CI retries once).
    expect(Math.abs(m.median - u.median)).toBeLessThan(25);
    expect(test_.p).toBeGreaterThan(0.01);
  });
});

test("21st viewer gets SESSION_FULL + 4005; a full session does not count as a failed join", async ({ stack }) => {
  const live = stack.code;
  const joins = await Promise.all(
    Array.from({ length: 20 }, () => joinViewer(stack.wsUrl, live, { ip: nextIp() })),
  );
  expect(joins.every((j) => j.joined.viewerLimit === 20)).toBe(true);
  await stack.publisher!.waitForEvent((e) => "event" in e && e.event === "viewer.count" && e.count === 20);

  const ip = "203.0.113.41";
  const full = await attemptJoin(stack.wsUrl, live, { ip, id: "v-21" });
  expectRefusal(full, "SESSION_FULL", CLOSE_CODES.SESSION_FULL);
  expect(full.reply.replyTo).toBe("v-21");
  expect(full.reply.retryable).toBe(true);
  expect(full.reply.details).toEqual({ viewerLimit: 20, retryAfterS: 30 });
  // SESSION_FULL means the code was right (RateLimiter.joinSucceeded): 11 more from the same IP are still
  // SESSION_FULL, never RATE_LIMITED.
  for (let i = 0; i < 11; i++)
    expectRefusal(await attemptJoin(stack.wsUrl, live, { ip }), "SESSION_FULL", CLOSE_CODES.SESSION_FULL);

  // A freed slot can be taken again.
  const seen = stack.publisher!.events.length;
  joins[0]!.client.send({ type: "viewer.leave" });
  await joins[0]!.client.closedWithin(5_000);
  // Only counts after the leave (the ramp-up already reported 19 once).
  await expect
    .poll(() => stack.publisher!.events.slice(seen).some((e) => "event" in e && e.event === "viewer.count" && e.count === 19))
    .toBe(true);
  const { client } = await joinViewer(stack.wsUrl, live, { ip });
  client.close();
  for (const j of joins) j.client.close();
});

test("a code in a URL path or query is never accepted nor echoed (§10)", async ({ stack }) => {
  const live = stack.code;
  const { client, joined } = await joinViewer(stack.wsUrl, live, { ip: nextIp() });
  const token = String(joined.viewerToken);
  const leaks = (text: string) => text.includes(live) || text.includes(live.toLowerCase()) || text.includes(token);
  // The stack's publisher has a snapshot cached (waitForAck), so `/api/scene/<that version>` is a real resource.
  expect(joined.snapshotAvailable).toBe(true);
  const scene = `/api/scene/${String(joined.snapshotVersion)}`;
  const bearer = { Authorization: `Bearer ${token}` };

  // Controls: without a query the same target answers 401 (no token) and 200 (token), so the 404s below come
  // from the code in the query and not from a wrong version or a missing token (§10).
  expect((await fetch(stack.baseUrl + scene, { redirect: "manual" })).status, "scene without token").toBe(401);
  const served = await fetch(stack.baseUrl + scene, { redirect: "manual", headers: bearer });
  expect(served.status, "scene with token").toBe(200);
  await served.arrayBuffer();

  const notFound: { path: string; headers?: Record<string, string> }[] = [
    { path: `/${live}` },
    { path: `/j/${live}` },
    { path: `${scene}?code=${live}` },
    // Even with a valid viewer token: the target check comes before the Bearer check (http/scene.ts).
    { path: `${scene}?code=${live}`, headers: bearer },
    { path: `/join?code=${live}` },
    { path: `/ws?code=${live}` },
  ];
  for (const [i, c] of notFound.entries()) {
    const response = await fetch(stack.baseUrl + c.path, { redirect: "manual", headers: c.headers ?? {} });
    const body = await response.text();
    expect(leaks(body), `case ${i}: code or token echoed in the body`).toBe(false);
    expect(leaks(headerText(response.headers)), `case ${i}: code or token echoed in a header`).toBe(false);
    expect(response.status, `case ${i}: status`).toBe(404);
    expect(JSON.parse(body), `case ${i}: body`).toEqual({ error: "NOT_FOUND" });
  }

  // `/j?code=X` is the SPA, byte for byte the same as `/j`, nothing of the query echoed.
  const plain = Buffer.from(await (await fetch(`${stack.baseUrl}/j`)).arrayBuffer());
  const decorated = await fetch(`${stack.baseUrl}/j?code=${live}`, { redirect: "manual" });
  const decoratedBody = Buffer.from(await decorated.arrayBuffer());
  expect(leaks(decoratedBody.toString("utf8")), "code echoed by /j?code=").toBe(false);
  expect(leaks(headerText(decorated.headers)), "code echoed in a /j header").toBe(false);
  expect(decorated.status).toBe(200);
  expect(decoratedBody.equals(plain), "/j?code= serves the same bytes as /j").toBe(true);
  client.close();
});

test.describe("upgrade guards (§3.1, §12)", () => {
  test.use({ stackOptions: { publisher: false } });

  test("foreign Origin → HTTP 403 and Sec-WebSocket-Protocol → HTTP 400, both before the upgrade", async ({
    stack,
  }) => {
    const ip = nextIp();
    const foreign = await probeUpgrade(stack.baseUrl, { Origin: "https://evil.example", "X-Forwarded-For": ip });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body)).toEqual({ error: "FORBIDDEN" });
    // Look-alikes of the relay's own origin are foreign too (exact match).
    for (const origin of [`http://127.0.0.1:${stack.relay.port}.evil.example`, "null", `https://127.0.0.1:${stack.relay.port}`])
      expect((await probeUpgrade(stack.baseUrl, { Origin: origin, "X-Forwarded-For": ip })).status, origin).toBe(403);

    const subprotocol = await probeUpgrade(stack.baseUrl, { "Sec-WebSocket-Protocol": "srv.v1", "X-Forwarded-For": ip });
    expect(subprotocol.status).toBe(400);
    expect(JSON.parse(subprotocol.body)).toEqual({ error: "BAD_REQUEST" });
    expect(subprotocol.headers["sec-websocket-protocol"]).toBeUndefined();

    // Controls: the relay's own origin and no Origin (Slicer, Unity) are upgraded.
    expect((await probeUpgrade(stack.baseUrl, { Origin: stack.baseUrl, "X-Forwarded-For": ip })).status).toBe(101);
    expect((await probeUpgrade(stack.baseUrl, { "X-Forwarded-For": ip })).status).toBe(101);
  });

  test("30 accepted upgrades/min per IP, the 31st → 429; refused upgrades do not spend the budget", async ({
    stack,
  }) => {
    const ip = "203.0.113.51";
    for (let i = 0; i < 35; i++)
      expect((await probeUpgrade(stack.baseUrl, { Origin: "https://evil.example", "X-Forwarded-For": ip })).status).toBe(403);
    for (let i = 0; i < 5; i++)
      expect((await probeUpgrade(stack.baseUrl, { "Sec-WebSocket-Protocol": "x", "X-Forwarded-For": ip })).status).toBe(400);
    for (let i = 1; i <= 30; i++)
      expect((await probeUpgrade(stack.baseUrl, { "X-Forwarded-For": ip })).status, `upgrade ${i}`).toBe(101);
    const limited = await probeUpgrade(stack.baseUrl, { "X-Forwarded-For": ip });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({ error: "RATE_LIMITED" });
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await probeUpgrade(stack.baseUrl, { "X-Forwarded-For": "203.0.113.52" })).status).toBe(101);
  });

  test("no first message within 10 s → close 4012; a SESSION_NOT_FOUND rejoin restarts the 10 s window", async ({
    stack,
  }) => {
    test.setTimeout(60_000);
    const started = performance.now();
    const silent = await connect(stack.wsUrl, { ip: nextIp() });
    const rejoining = await connect(stack.wsUrl, { ip: nextIp() });
    // §3.1 / §9.3: a token `viewer.join` answered SESSION_NOT_FOUND keeps the socket for a fresh 10 s window, in
    // which `ping` is allowed (it binds nothing). Sent 3 s in, so its 4012 comes ≈ 13 s after the upgrade.
    await sleep(3_000);
    rejoining.send({
      type: "viewer.join",
      id: "v-1",
      sessionId: "sess_qa05unknown",
      viewerToken: `vt_${randomBytes(32).toString("base64url")}`,
      clientInfo: VIEWER_CLIENT_INFO,
    });
    expect((await rejoining.next("error")).code).toBe("SESSION_NOT_FOUND");
    const answeredAt = performance.now();
    rejoining.send({ type: "ping", id: "hb-1" });
    expect((await rejoining.next("pong")).replyTo).toBe("hb-1");

    const a = await silent.closedWithin(20_000);
    const silentS = (performance.now() - started) / 1000;
    expect(a.code).toBe(CLOSE_CODES.HANDSHAKE_TIMEOUT);
    expect(silentS).toBeGreaterThanOrEqual(9.5);
    expect(silentS).toBeLessThan(15);
    expect(silent.messages).toHaveLength(0);
    // The rejoining socket outlived the first window …
    expect(rejoining.closeInfo, "socket closed at the first 10 s mark").toBeUndefined();
    const b = await rejoining.closedWithin(20_000);
    const rejoinS = (performance.now() - answeredAt) / 1000;
    // … and closed 4012 about 10 s after its SESSION_NOT_FOUND.
    expect(b.code).toBe(CLOSE_CODES.HANDSHAKE_TIMEOUT);
    expect(rejoinS).toBeGreaterThanOrEqual(9.5);
    expect(rejoinS).toBeLessThan(15);
  });
});
