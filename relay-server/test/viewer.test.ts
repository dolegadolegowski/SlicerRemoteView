import { afterEach, describe, expect, it } from "vitest";
import { ALPHABET, validateMessage } from "@slicerremoteview/shared";
import { tokenMatches } from "../src/codes.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection } from "../src/ws/connection.js";
import {
  INVALID_CODE_JITTER_MS,
  normalizeCode,
  sceneState,
  viewerHandlers,
  viewerPlatform,
} from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

let relay: TestRelay | undefined;
let lines: string[] = [];
afterEach(async () => {
  await relay?.close();
  relay = undefined;
  lines = [];
});

/** A relay whose log lines (level trace) land in `lines`. */
async function start(): Promise<TestRelay> {
  relay ??= await startRelay({
    logger: createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
  });
  return relay;
}

/** Waits for the next message and checks it against the protocol schema. */
async function nextValid(client: TestClient): Promise<Received> {
  const message = await client.next();
  expect(validateMessage(message)).toMatchObject({ ok: true });
  return message;
}

async function publisher(): Promise<{ client: TestClient; code: string; session: Session }> {
  const { url, registry } = await start();
  const client = await connectClient(url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await nextValid(client);
  expect(created.type).toBe("session.created");
  return {
    client,
    code: created.code as string,
    session: registry.get(created.sessionId as string)!,
  };
}

function joinMessage(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture("viewer.join"), code, ...extra };
}

/** Joins with `code` and drains viewer.joined, scene.state and viewer.count. */
async function viewer(
  code: string,
  extra: Record<string, unknown> = {},
): Promise<{ client: TestClient; joined: Received; state: Received; count: Received }> {
  const client = await connectClient(relay!.url);
  client.sendRaw(JSON.stringify(joinMessage(code, extra)));
  const joined = await nextValid(client);
  expect(joined.type).toBe("viewer.joined");
  const state = await nextValid(client);
  const count = await nextValid(client);
  expect([state.type, count.type]).toEqual(["scene.state", "viewer.count"]);
  return { client, joined, state, count };
}

function withPlatform(platform: string): Record<string, unknown> {
  const { clientInfo } = fixture("viewer.join") as { clientInfo: Record<string, unknown> };
  return { clientInfo: { ...clientInfo, platform } };
}

/** A well-formed code that is neither live nor quarantined. */
function unusedCode(registry: Registry): string {
  for (const a of ALPHABET)
    for (const b of ALPHABET) {
      const code = `${a}${b}222`;
      if (registry.getByCode(code) === undefined && !registry.isCodeQuarantined(code)) return code;
    }
  throw new Error("no unused code");
}

const refusals = (): number =>
  lines.filter((l) => (JSON.parse(l) as { errorCode?: string }).errorCode === "INVALID_CODE")
    .length;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("viewer limit (SRV-07 criterion 1, FR-22, US-16)", () => {
  it("20 viewers join; the 21st gets SESSION_FULL{viewerLimit:20} + 4005, the others stay", async () => {
    const pub = await publisher();
    const viewers: TestClient[] = [];
    for (let i = 1; i <= 20; i++) {
      const { client, joined } = await viewer(pub.code);
      expect(joined.viewerCount).toBe(i);
      viewers.push(client);
    }
    const extra = await connectClient(relay!.url);
    extra.sendRaw(JSON.stringify(joinMessage(pub.code, { id: "v-21" })));
    expect(await nextValid(extra)).toMatchObject({
      type: "error",
      code: "SESSION_FULL",
      replyTo: "v-21",
      retryable: true,
      details: { viewerLimit: 20, retryAfterS: 30 },
    });
    expect(await extra.closed).toBe(4005);
    expect(pub.session.connectedViewers).toBe(20);
    for (const [i, client] of viewers.entries()) {
      // Each viewer saw the counts of the joins after its own; the 21st changed nothing.
      await expect.poll(() => client.received.length).toBe(3 + 19 - i);
      expect(client.received.slice(3).every((m) => m.type === "viewer.count")).toBe(true);
      expect(client.ws.readyState).toBe(1);
      client.send({ type: "ping", id: `hb-${i}` });
      await expect
        .poll(() => client.received.at(-1))
        .toMatchObject({ type: "pong", replyTo: `hb-${i}` });
    }
    // A free slot is usable again.
    viewers[0]!.ws.close();
    await expect.poll(() => pub.session.connectedViewers).toBe(19);
    await viewer(pub.code);
  });
});

describe("uniform INVALID_CODE (SRV-07 criterion 2, §5.2, §12, T1)", () => {
  it("unknown, malformed and quarantined codes: identical errors after 50–150 ms, then 4004", async () => {
    const live = await publisher();
    const ended = await publisher();
    ended.client.send({ type: "session.close", reason: "USER_STOPPED" });
    await ended.client.closed;
    const registry = relay!.registry;
    expect(registry.isCodeQuarantined(ended.code)).toBe(true);
    const codes = [
      unusedCode(registry), // unknown
      ended.code, // quarantined (after session.close)
      `${live.code.slice(0, 4)}O`, // outside the alphabet
      live.code.slice(0, 4), // too short
      `${live.code}2`, // too long
      "", // empty
      "7KQ4X-7KQ4X-7KQ4X-7KQ4X-7KQ4X-7KQ4X", // long junk
    ];
    const clients: TestClient[] = [];
    for (const [i, code] of codes.entries()) {
      const client = await connectClient(relay!.url);
      client.sendRaw(JSON.stringify(joinMessage(code, { id: `j-${i}` })));
      clients.push(client);
    }
    await expect.poll(refusals).toBe(codes.length);
    relay!.clock.advance(INVALID_CODE_JITTER_MS.min - 1);
    await settle();
    expect(clients.map((c) => c.received.length)).toEqual(codes.map(() => 0));
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max - INVALID_CODE_JITTER_MS.min + 1);
    const errors = await Promise.all(clients.map((c) => nextValid(c)));
    for (const [i, error] of errors.entries()) expect(error.replyTo).toBe(`j-${i}`);
    const bodies = errors.map(({ ts: _ts, replyTo: _replyTo, ...rest }) => JSON.stringify(rest));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({
      protocolVersion: "1.0",
      type: "error",
      code: "INVALID_CODE",
      message: "no live session has this code",
      retryable: false,
    });
    expect(await Promise.all(clients.map((c) => c.closed))).toEqual(codes.map(() => 4004));
    expect(live.session.viewers.size).toBe(0);
  });

  it("a malformed code never reaches a lookup, not even of the validation placeholder", async () => {
    const { registry } = await start();
    const { session } = registry.createSession("mobile", "22222");
    expect(session.code).toBe("22222");
    const malformed = ["AAAAO", "", "2222", "222222", "2222ß", "ſ2222", "22\u00a02O2"];
    const clients: TestClient[] = [];
    for (const code of malformed) {
      const client = await connectClient(relay!.url);
      client.sendRaw(JSON.stringify(joinMessage(code)));
      clients.push(client);
    }
    await expect.poll(refusals).toBe(malformed.length);
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
    for (const client of clients) {
      expect(await client.next()).toMatchObject({ type: "error", code: "INVALID_CODE" });
      expect(await client.closed).toBe(4004);
    }
    expect(session.viewers.size).toBe(0);
  });

  it("a join refused just before the handshake deadline still answers INVALID_CODE + 4004", async () => {
    await start();
    const client = await connectClient(relay!.url);
    relay!.clock.advance(9_990);
    client.sendRaw(JSON.stringify(joinMessage(unusedCode(relay!.registry))));
    await expect.poll(refusals).toBe(1);
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
    expect(await client.next()).toMatchObject({ code: "INVALID_CODE" });
    expect(await client.closed).toBe(4004);
  });

  it("normalises the code first: lower case and whitespace still join (§12)", async () => {
    const pub = await publisher();
    const typed = ` ${pub.code.slice(0, 2).toLowerCase()} ${pub.code.slice(2).toLowerCase()}\t`;
    const { joined } = await viewer(typed);
    expect(joined.sessionId).toBe(pub.session.id);
  });

  it("reads nothing more from a socket whose join failed (no retries on one socket, §12)", async () => {
    const pub = await publisher();
    const client = await connectClient(relay!.url);
    client.sendRaw(JSON.stringify(joinMessage(unusedCode(relay!.registry), { id: "j-1" })));
    await expect.poll(refusals).toBe(1);
    client.sendRaw(JSON.stringify(joinMessage(pub.code, { id: "j-2" })));
    client.send({ type: "ping", id: "hb-1" });
    await settle();
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
    expect(await client.next()).toMatchObject({ code: "INVALID_CODE", replyTo: "j-1" });
    expect(await client.closed).toBe(4004);
    expect(client.received).toHaveLength(1);
    expect(pub.session.viewers.size).toBe(0);
  });

  it("the delay is crypto-random within the band (unit)", () => {
    const clock = new ManualClock();
    const calls: [number, number][] = [];
    const { handlers, normalizers } = viewerHandlers({
      ...unitDeps(clock),
      rng: (min, max) => (calls.push([min, max]), 97),
    });
    const { connection, sent } = fakeConnection();
    const message = joinMessage("AAAAO");
    normalizers["viewer.join"]!(message);
    void handlers["viewer.join"]!(connection, message as never);
    expect(calls).toEqual([[INVALID_CODE_JITTER_MS.min, INVALID_CODE_JITTER_MS.max + 1]]);
    clock.advance(96);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual([{ code: "INVALID_CODE", close: 4004 }]);
  });
});

describe("viewer.count (SRV-07 criterion 3, §5.3, FR-17)", () => {
  it("reaches the publisher and every viewer after each join and leave", async () => {
    const pub = await publisher();
    // Exact match: a departed viewer's platform must not linger in `platforms`.
    const count = (viewerCount: number, platforms: Record<string, number>) => ({
      protocolVersion: "1.0",
      type: "viewer.count",
      viewerCount,
      viewerLimit: 20,
      platforms,
      ts: expect.any(Number),
    });
    const web = await viewer(pub.code, withPlatform("web"));
    expect(web.count).toEqual(count(1, { web: 1 }));
    expect(await nextValid(pub.client)).toEqual(count(1, { web: 1 }));

    const quest = await viewer(pub.code, withPlatform("quest3"));
    const two = count(2, { web: 1, quest3: 1 });
    expect(quest.count).toEqual(two);
    for (const c of [pub.client, web.client]) expect(await nextValid(c)).toEqual(two);

    // An unknown platform is counted as `other`: the relay never echoes sender-chosen keys.
    const odd = await viewer(pub.code, withPlatform("toaster<script>"));
    const three = count(3, { web: 1, quest3: 1, other: 1 });
    expect(odd.count).toEqual(three);
    for (const c of [pub.client, web.client, quest.client])
      expect(await nextValid(c)).toEqual(three);

    quest.client.send({ type: "viewer.leave" });
    expect(await quest.client.closed).toBe(1000);
    const afterLeave = count(2, { web: 1, other: 1 });
    for (const c of [pub.client, web.client, odd.client])
      expect(await nextValid(c)).toEqual(afterLeave);

    odd.client.ws.terminate();
    const afterDrop = count(1, { web: 1 });
    for (const c of [pub.client, web.client]) expect(await nextValid(c)).toEqual(afterDrop);

    // Entries and tokens stay for rejoin (architecture §3); only the socket is gone.
    expect(pub.session.viewers.size).toBe(3);
    expect([...pub.session.viewers.values()].map((v) => v.peer !== undefined)).toEqual([
      true,
      false,
      false,
    ]);
    expect(relay!.registry.viewerByToken(quest.joined.viewerToken as string)?.viewer.id).toBe(
      quest.joined.viewerId,
    );
    expect(pub.session.connectedViewers).toBe(1);
  });

  it("stays inside its own session (T11)", async () => {
    const a = await publisher();
    const b = await publisher();
    const va = await viewer(a.code);
    expect((await nextValid(a.client)).type).toBe("viewer.count");
    const vb = await viewer(b.code);
    vb.client.send({ type: "viewer.leave" });
    await vb.client.closed;
    await expect.poll(() => b.client.received.length).toBe(3); // created + two counts
    for (const c of [a.client, va.client]) {
      c.send({ type: "ping", id: "flush" });
      await expect.poll(() => c.received.at(-1)?.type).toBe("pong");
    }
    expect(a.client.received.map((m) => m.type)).toEqual([
      "session.created",
      "viewer.count",
      "pong",
    ]);
    expect(va.client.received.map((m) => m.type)).toEqual([
      "viewer.joined",
      "scene.state",
      "viewer.count",
      "pong",
    ]);
  });
});

describe("viewer.joined (§5.2)", () => {
  it("carries the session view and a one-time token whose hash alone is stored", async () => {
    const pub = await publisher();
    const { joined, state } = await viewer(pub.code, { id: "v-1" });
    expect(joined).toMatchObject({
      replyTo: "v-1",
      sessionId: pub.session.id,
      viewerId: expect.stringMatching(/^vw_[0-9A-Z]{8}$/),
      viewerToken: expect.stringMatching(/^vt_[A-Za-z0-9_-]{43}$/),
      sceneVersion: 0,
      snapshotVersion: null,
      snapshotAvailable: false,
      publisherOnline: true,
      viewerCount: 1,
      viewerLimit: 20,
      profile: pub.session.profile,
    });
    expect(joined).not.toHaveProperty("snapshot");
    expect(state).toMatchObject({ sceneVersion: 0, snapshotVersion: null, nodes: [], removed: [] });
    const entry = pub.session.viewers.get(joined.viewerId as string)!;
    expect(tokenMatches(joined.viewerToken as string, entry.tokenHash)).toBe(true);
    const stored = [...pub.session.viewers.values()].map(({ peer: _peer, ...rest }) => rest);
    expect(JSON.stringify(stored)).not.toContain((joined.viewerToken as string).slice(3));
  });

  it("announces a cached snapshot and an offline publisher", async () => {
    const pub = await publisher();
    pub.session.snapshot = {
      buffer: Buffer.alloc(8),
      byteLength: 8,
      sceneVersion: 3,
      sha256: "a".repeat(64),
      extensionsRequired: [],
    };
    pub.session.sceneVersion = 4;
    pub.client.ws.terminate();
    await expect.poll(() => pub.session.phase).toBe("grace");
    const { joined, state } = await viewer(pub.code);
    expect(joined).toMatchObject({
      sceneVersion: 4,
      snapshotVersion: 3,
      snapshotAvailable: true,
      snapshot: { sceneVersion: 3, byteLength: 8, sha256: "a".repeat(64), format: "glb" },
      publisherOnline: false,
    });
    expect(state).toMatchObject({ sceneVersion: 4, snapshotVersion: 3 });
  });

  it("a connected viewer stops the idle timer; the last one leaving restarts it (§4.4)", async () => {
    const pub = await publisher();
    const { client } = await viewer(pub.code);
    expect(relay!.registry.idleDeadline(pub.session)).toBeUndefined();
    relay!.clock.advance(5_000);
    client.send({ type: "viewer.leave" });
    await client.closed;
    await expect
      .poll(() => relay!.registry.idleDeadline(pub.session))
      .toBe(relay!.clock.now() + 1_800_000);
  });

  it("rejoin with a token is SRV-15: until then SESSION_NOT_FOUND, socket kept open for a code join", async () => {
    const pub = await publisher();
    const { joined } = await viewer(pub.code);
    const client = await connectClient(relay!.url);
    const rejoin = joinMessage(pub.code, {
      id: "v-2",
      sessionId: joined.sessionId,
      viewerToken: joined.viewerToken,
    });
    delete rejoin.code;
    client.sendRaw(JSON.stringify(rejoin));
    expect(await nextValid(client)).toMatchObject({
      code: "SESSION_NOT_FOUND",
      replyTo: "v-2",
      retryable: false,
    });
    // Still unbound: a code join on the same socket works.
    client.sendRaw(JSON.stringify(joinMessage(pub.code)));
    expect((await nextValid(client)).type).toBe("viewer.joined");
  });
});

describe("session end with joined viewers (§4.5)", () => {
  it("session.close → session.closed + 4001 to every viewer, no viewer.count afterwards", async () => {
    const pub = await publisher();
    const a = await viewer(pub.code);
    const b = await viewer(pub.code);
    expect((await nextValid(a.client)).type).toBe("viewer.count");
    pub.client.send({ type: "session.close", reason: "USER_STOPPED" });
    for (const v of [a, b]) {
      expect(await nextValid(v.client)).toMatchObject({
        type: "session.closed",
        reason: "PUBLISHER_CLOSED",
      });
      expect(await v.client.closed).toBe(4001);
      expect(v.client.received.at(-1)?.type).toBe("session.closed");
    }
    expect(relay!.registry.viewerByToken(a.joined.viewerToken as string)).toBeUndefined();
  });
});

describe("privacy (NFR-12, T6)", () => {
  it("never logs a code or a token, at trace level, on success and failure", async () => {
    const pub = await publisher();
    const { client, joined } = await viewer(pub.code);
    client.send({ type: "viewer.leave" });
    await client.closed;
    const bad = await connectClient(relay!.url);
    const wrong = unusedCode(relay!.registry);
    bad.sendRaw(JSON.stringify(joinMessage(wrong.toLowerCase())));
    await expect.poll(refusals).toBe(1);
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
    await bad.closed;
    const log = lines.join("");
    expect(log).toContain("viewer joined");
    for (const secret of [pub.code, wrong, wrong.toLowerCase(), joined.viewerToken as string])
      expect(log).not.toContain(secret);
  });

  it("pending refusals are cancelled when the relay closes", async () => {
    await start();
    const client = await connectClient(relay!.url);
    client.sendRaw(JSON.stringify(joinMessage(unusedCode(relay!.registry))));
    await expect.poll(refusals).toBe(1);
    await relay!.close();
    // The sweep and refusal timers at once (awaitClose() already stopped the handshake timer).
    await expect.poll(() => relay!.clock.pending).toBe(0);
    relay = undefined;
  });
});

function unitDeps(clock: ManualClock) {
  const config = loadConfig({});
  const logger = createLogger({ level: "silent" });
  return {
    registry: new Registry({ ...config, clock }),
    limiter: new RateLimiter({ clock, logger }),
    logger,
    clock,
  };
}

/** Just enough of `Connection` for the handler unit tests. */
function fakeConnection() {
  const sent: Record<string, unknown>[] = [];
  const connection = {
    clientKey: "k",
    awaitClose: () => {},
    completeHandshake: () => {},
    send: (message: Record<string, unknown>) => sent.push(message),
    sendError: (code: string) => sent.push({ code }),
    fail: (code: string, _message: string, close: number) => sent.push({ code, close }),
    close: (close: number) => sent.push({ close }),
  };
  return { connection: connection as unknown as Connection, sent };
}

describe("unit", () => {
  it("CAPACITY + 4006 while a global budget refuses viewers, for live and unknown codes alike", () => {
    const clock = new ManualClock();
    const deps = unitDeps(clock);
    const { session } = deps.registry.createSession("mobile");
    const { handlers, normalizers } = viewerHandlers({ ...deps, overCapacity: () => true });
    for (const code of [session.code, unusedCode(deps.registry), "AAAAO"]) {
      const { connection, sent } = fakeConnection();
      const message = joinMessage(code);
      normalizers["viewer.join"]!(message);
      void handlers["viewer.join"]!(connection, message as never);
      expect(sent).toEqual([{ code: "CAPACITY", close: 4006 }]);
    }
    expect(clock.pending).toBe(0); // answered at once: no jitter timer either way
    expect(session.viewers.size).toBe(0);
  });

  it("fails closed: a join the normaliser did not see is refused, whatever its code says", () => {
    const clock = new ManualClock();
    const deps = unitDeps(clock);
    const { session } = deps.registry.createSession("mobile");
    const { handlers } = viewerHandlers(deps);
    const { connection, sent } = fakeConnection();
    void handlers["viewer.join"]!(connection, joinMessage(session.code) as never);
    clock.advance(INVALID_CODE_JITTER_MS.max);
    expect(sent).toEqual([{ code: "INVALID_CODE", close: 4004 }]);
    expect(session.viewers.size).toBe(0);
  });

  it.each([
    [" 7kq4x ", "7KQ4X"],
    ["7 K Q 4 X", "7KQ4X"],
    ["7kq4o", "7KQ4O"],
    // Only ASCII letters change case: no Unicode mapping can turn junk into a code (ADR 0008 §7).
    ["7kqﬀ", "7KQﬀ"],
    ["7ßkq", "7ßKQ"],
    ["ſ2345", "ſ2345"],
  ])("normalizeCode(%j) = %j", (input, output) => {
    expect(normalizeCode(input)).toBe(output);
  });

  it.each([
    ["web", "web"],
    ["quest-browser", "quest-browser"],
    ["quest2", "quest2"],
    ["quest3", "quest3"],
    ["Quest3", "other"],
    ["constructor", "other"],
    [undefined, "other"],
  ])("viewerPlatform(%j) = %j", (input, output) => {
    expect(viewerPlatform(input)).toBe(output);
  });

  it("sceneState lists merged nodes and removals without names (§8.3)", () => {
    const deps = unitDeps(new ManualClock());
    const { session } = deps.registry.createSession("mobile");
    session.nodeState.set("n1", { visible: false, opacity: 0.5 });
    session.nodeState.set("n2", "removed");
    const state = sceneState(session);
    expect(state).toEqual({
      type: "scene.state",
      sceneVersion: 0,
      snapshotVersion: null,
      nodes: [{ nodeId: "n1", visible: false, opacity: 0.5 }],
      removed: ["n2"],
    });
    expect(validateMessage({ protocolVersion: "1.0", ...state })).toMatchObject({ ok: true });
  });
});
