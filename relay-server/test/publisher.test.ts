import { afterEach, describe, expect, it } from "vitest";
import { validateMessage } from "@slicerremoteview/shared";
import { tokenMatches } from "../src/codes.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { Peer, Session } from "../src/registry.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const S = 1_000;

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

type ViewerEvent = Received | { close: number };

/**
 * An in-memory viewer socket (viewer.join arrives with SRV-07): records what the relay sends, when
 * (`at`, performance.now()), and checks every message against the protocol schema on arrival.
 */
function fakeViewer(session: Session, id: string) {
  const events: ViewerEvent[] = [];
  const at: number[] = [];
  const peer: Peer = {
    send: (message) => {
      expect(validateMessage({ protocolVersion: "1.0", ts: 0, ...message })).toMatchObject({
        ok: true,
      });
      events.push(message as Received);
      at.push(performance.now());
    },
    close: (code) => {
      events.push({ close: code });
      at.push(performance.now());
    },
  };
  session.viewers.set(id, { id, peer });
  return Object.assign(events, { at });
}

async function createSession(
  options: Parameters<typeof startRelay>[0] = {},
  message: Record<string, unknown> = fixture("session.create"),
): Promise<{ client: TestClient; created: Received; session: Session }> {
  relay ??= await startRelay(options);
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(message));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  return { client, created, session: relay.registry.get(created.sessionId as string)! };
}

describe("session.create → session.created (SRV-06 criterion 1, §4.1, §4.2)", () => {
  it("matches the schema and announces TTLs, limits and a one-time token", async () => {
    const { client, created, session } = await createSession();
    expect(validateMessage(created)).toMatchObject({ ok: true });
    const now = relay!.clock.now();
    expect(created).toMatchObject({
      replyTo: "p-1",
      sessionId: session.id,
      code: session.code,
      viewerLimit: 20,
      ttl: { graceS: 120, idleS: 1_800, maxLifetimeS: 43_200, expiresAt: now + 43_200 * S },
      limits: {
        maxSnapshotBytes: 67_108_864,
        maxChunkBytes: 1_048_576,
        maxTextBytes: 262_144,
        maxChanges: 1_000,
      },
    });
    expect(created.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    expect(tokenMatches(created.publisherToken as string, session.publisherTokenHash)).toBe(true);
    expect(session.phase).toBe("allocated");
    client.ws.close();
  });

  it("binds the socket: no 4012 after 10 s, a second session.create is UNAUTHORIZED", async () => {
    const { client } = await createSession();
    relay!.clock.advance(10 * S);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(client.ws.readyState).toBe(1);
    client.ws.close();
  });

  it("announces the configured limits", async () => {
    const config = loadConfig({
      MAX_VIEWERS: "5",
      MAX_SNAPSHOT_BYTES: "33554432",
      SESSION_TTL_S: "600",
    });
    const { created } = await createSession({ config });
    expect(created).toMatchObject({
      viewerLimit: 5,
      ttl: { idleS: 600 },
      limits: { maxSnapshotBytes: 33_554_432 },
    });
  });

  it("grants a free preferredCode (§4.1)", async () => {
    const { created } = await createSession(
      {},
      { ...fixture("session.create"), preferredCode: "7KQ4X" },
    );
    expect(created.code).toBe("7KQ4X");
  });

  it("at MAX_SESSIONS answers error CAPACITY + 4006", async () => {
    await createSession({ config: loadConfig({ MAX_SESSIONS: "1" }) });
    const second = await connectClient(relay!.url);
    second.sendRaw(JSON.stringify(fixture("session.create")));
    expect(await second.next()).toMatchObject({
      type: "error",
      code: "CAPACITY",
      retryable: true,
      replyTo: "p-1",
    });
    expect(await second.closed).toBe(4006);
  });
});

describe("session.close (SRV-06 criterion 2, §4.5)", () => {
  it("viewers get session.closed then 4001 within 100 ms, the publisher 1000; code and buffer released", async () => {
    const { client, session } = await createSession();
    const viewers = [fakeViewer(session, "vw_a"), fakeViewer(session, "vw_b")];
    session.snapshot = {
      buffer: Buffer.alloc(1024),
      sha256: "x",
      byteLength: 1024,
      sceneVersion: 1,
    };
    const started = performance.now();
    client.send({ type: "session.close", id: "p-77", reason: "USER_STOPPED" });
    expect(await client.closed).toBe(1000);
    for (const events of viewers) {
      expect([...events]).toEqual([
        { type: "session.closed", sessionId: session.id, reason: "PUBLISHER_CLOSED" },
        { close: 4001 },
      ]);
      // Measured where the viewer receives it, not at the publisher's close handshake.
      expect(events.at[1]! - started).toBeLessThan(100);
    }
    expect(session.phase).toBe("closed");
    expect(session.snapshot).toBeUndefined();
    expect(relay!.registry.getByCode(session.code)).toBeUndefined();
    // A later viewer.join with this code finds nothing (SRV-07 answers INVALID_CODE on the wire).
    expect(relay!.registry.isCodeQuarantined(session.code)).toBe(true);
  });

  it("the messages viewers receive validate against the schema", async () => {
    const { client, session } = await createSession();
    const events = fakeViewer(session, "vw_a");
    client.send({ type: "session.close", reason: "USER_STOPPED" });
    await client.closed;
    const [closed] = events as Received[];
    expect(validateMessage({ protocolVersion: "1.0", ...closed })).toMatchObject({ ok: true });
  });
});

describe("publisher socket lost → grace → expiry (SRV-06 criterion 3, §4.6, §9.1)", () => {
  it("viewers get publisherState{online:false}; after PUBLISHER_GRACE_S session.expired{PUBLISHER_GONE} + 4002", async () => {
    const { client, session } = await createSession();
    const events = fakeViewer(session, "vw_a");
    client.ws.terminate();
    await expect.poll(() => events.length).toBe(1);
    const graceEndsAt = relay!.clock.now() + 120 * S;
    expect(events[0]).toEqual({ type: "session.publisherState", online: false, graceEndsAt });
    expect(relay!.clock.now()).toBeLessThan(graceEndsAt);
    expect(session.phase).toBe("grace");
    relay!.clock.advance(119 * S);
    expect(events).toHaveLength(1);
    relay!.clock.advance(10 * S); // the next sweep after the grace deadline
    expect(events.slice(1)).toEqual([
      { type: "session.expired", sessionId: session.id, reason: "PUBLISHER_GONE" },
      { close: 4002 },
    ]);
    expect(session.phase).toBe("expired");
    expect(relay!.registry.getByCode(session.code)).toBeUndefined();
  });

  it("a session.close that ends the socket does not start a grace period", async () => {
    const { client, session } = await createSession();
    const events = fakeViewer(session, "vw_a");
    client.send({ type: "session.close", reason: "USER_STOPPED" });
    await client.closed;
    expect(events.map((e) => ("type" in e ? e.type : e.close))).toEqual(["session.closed", 4001]);
  });
});

describe("relay-initiated expiry reaches the publisher too (§4.5, §11)", () => {
  it("idle expiry: the connected publisher gets session.expired{IDLE} + 4002", async () => {
    const { client, session } = await createSession();
    relay!.clock.advance(1_800 * S + 10 * S);
    // session.expiring (60 s before) is SRV-14; until then session.expired is the only message.
    const expired = await client.next();
    expect(expired).toMatchObject({
      type: "session.expired",
      sessionId: session.id,
      reason: "IDLE",
    });
    expect(validateMessage(expired)).toMatchObject({ ok: true });
    expect(await client.closed).toBe(4002);
  });
});

describe("session isolation (T11)", () => {
  it("closing, dropping or expiring one session sends nothing to another session's viewers", async () => {
    const a = await createSession();
    const b = await createSession();
    const c = await createSession();
    const [va, vb, vc] = [
      fakeViewer(a.session, "vw_a"),
      fakeViewer(b.session, "vw_b"),
      fakeViewer(c.session, "vw_c"),
    ];
    relay!.registry.setConnectedViewers(c.session, 1); // c keeps a viewer: no idle expiry
    a.client.ws.terminate();
    await expect.poll(() => va.length).toBe(1);
    b.client.send({ type: "session.close", reason: "USER_STOPPED" });
    await b.client.closed;
    relay!.clock.advance(130 * S); // a: grace over
    expect([...va].map((e) => ("type" in e ? e.type : e.close))).toEqual([
      "session.publisherState",
      "session.expired",
      4002,
    ]);
    expect([...vb].map((e) => ("type" in e ? e.type : e.close))).toEqual(["session.closed", 4001]);
    expect([...vc]).toEqual([]);
    expect(c.session.phase).toBe("allocated");
    // The other publishers' sockets: a round trip on c flushes anything sent to it before.
    c.client.send({ type: "ping", id: "c-1" });
    await expect.poll(() => c.client.received.at(-1)?.type).toBe("pong");
    expect(c.client.received.map((m) => m.type)).toEqual(["session.created", "pong"]);
    expect(b.client.received.map((m) => m.type)).toEqual(["session.created"]);
    c.client.ws.close();
  });
});

describe("app lifecycle", () => {
  it("closing the app detaches the expiry listener from an injected registry", async () => {
    relay = await startRelay();
    expect(relay.registry.listenerCount("expired")).toBe(1);
    await relay.close();
    expect(relay.registry.listenerCount("expired")).toBe(0);
    relay = undefined;
  });
});

describe("logs (NFR-12)", () => {
  it("never contain codes or publisher tokens, on any lifecycle path", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const config = loadConfig({ MAX_SESSIONS: "2" });
    const closed = await createSession(
      { logger, config },
      { ...fixture("session.create"), preferredCode: "7KQ4X" },
    );
    const dropped = await createSession();
    // CAPACITY: a third publisher is refused.
    const refused = await connectClient(relay!.url);
    refused.sendRaw(JSON.stringify({ ...fixture("session.create"), preferredCode: "ABCDE" }));
    expect(await refused.next()).toMatchObject({ code: "CAPACITY" });
    // close, drop → grace → expiry
    closed.client.send({ type: "session.close", reason: "USER_STOPPED" });
    await closed.client.closed;
    dropped.client.ws.terminate();
    await expect.poll(() => dropped.session.phase).toBe("grace");
    relay!.clock.advance(130 * S);
    expect(dropped.session.phase).toBe("expired");
    const log = lines.join("");
    for (const created of [closed.created, dropped.created]) {
      expect(log).toContain(created.sessionId as string);
      expect(log).not.toContain(created.code as string);
      expect(log).not.toContain((created.publisherToken as string).slice(3));
    }
    expect(log).not.toContain("ABCDE");
    for (const message of [
      "session created",
      "session refused",
      "session closed by publisher",
      "publisher lost, grace period started",
      "session expired",
    ])
      expect(log).toContain(message);
  });
});
