import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMessage } from "@slicerremoteview/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection } from "../src/ws/connection.js";
import { heartbeat, RELAY_PING_INTERVAL_MS } from "../src/ws/heartbeat.js";
import type { Pingable } from "../src/ws/heartbeat.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const TICK = RELAY_PING_INTERVAL_MS;

// Exposed by `execArgv: ["--expose-gc"]` in vitest.config.ts.
declare const gc: () => void;

let relay: TestRelay | undefined;
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
});

/** Round trip: everything sent before has been handled; returns what arrived meanwhile. */
async function flush(client: TestClient): Promise<Received[]> {
  const id = `flush-${Math.random()}`;
  client.send({ type: "ping", id });
  const seen: Received[] = [];
  for (;;) {
    const message = await client.next();
    expect(validateMessage(message)).toMatchObject({ ok: true });
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

async function publisher(
  options: { autoPong?: boolean } = {},
  logger?: ReturnType<typeof createLogger>,
): Promise<{ client: TestClient; session: Session; peer: Connection }> {
  relay ??= await startRelay({ heartbeat: true, ...(logger !== undefined && { logger }) });
  const client = await connectClient(relay.url, {}, options);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await client.next();
  expect(created.type).toBe("session.created");
  const session = relay.registry.get(created.sessionId as string)!;
  return { client, session, peer: session.publisher as Connection };
}

async function viewer(session: Session): Promise<{ client: TestClient; peer: Connection }> {
  const client = await connectClient(relay!.url);
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
  const joined = await client.next();
  expect(joined.type).toBe("viewer.joined");
  return { client, peer: session.viewers.get(joined.viewerId as string)!.peer as Connection };
}

describe("application ping (SRV-14 criterion 1, §9.1)", () => {
  it("a viewer and a publisher each get pong{replyTo, serverTs}", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    for (const each of [client, watcher.client]) {
      await flush(each);
      each.send({ type: "ping", id: "hb-1" });
      const pong = await each.next();
      expect(pong).toEqual({
        protocolVersion: "1.0",
        type: "pong",
        replyTo: "hb-1",
        ts: relay!.clock.now(),
        serverTs: relay!.clock.now(),
      });
      expect(validateMessage(pong)).toMatchObject({ ok: true });
    }
  });
});

describe("WebSocket heartbeat (SRV-14 criterion 2, §9.1, §9.3, FR-21, NFR-21)", () => {
  it("no pong by the next tick → 4009 and terminated; the publisher's session enters grace", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { client, session } = await publisher({ autoPong: false }, logger);
    const watcher = await viewer(session);
    await flush(client);
    relay!.clock.advance(TICK); // pings both
    await flush(watcher.client); // the viewer's automatic pong has been read
    await flush(client);
    relay!.clock.advance(TICK); // at most 60 s of silence
    await expect.poll(() => session.phase).toBe("grace");
    expect([4009, 1006]).toContain(await client.closed);
    expect(await watcher.client.next()).toMatchObject({
      type: "session.publisherState",
      online: false,
    });
    expect(watcher.peer.isOpen).toBe(true);
    // The timeout is told apart from a network drop in the logs (ids only).
    const timeout = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.errorCode === "HEARTBEAT_TIMEOUT");
    expect(timeout).toMatchObject({ role: "publisher", sessionId: session.id });
  });

  it("a socket that reads nothing is gone at that tick too, even if it sends pongs of its own", async () => {
    const { client, session } = await publisher({ autoPong: false });
    await flush(client);
    client.ws.pause(); // reads nothing more: not the pings, not the close frame
    relay!.clock.advance(TICK);
    client.ws.pong(Buffer.from("unsolicited")); // RFC 6455 allows it; it answers no ping
    // The relay has handled it (any pong of the publisher refreshes lastPublisherSeen).
    await expect.poll(() => session.lastPublisherSeen).toBe(relay!.clock.now());
    relay!.clock.advance(TICK);
    await expect.poll(() => session.phase).toBe("grace");
    client.ws.resume();
  });

  it("sockets that answer stay open, tick after tick", async () => {
    const { client, session, peer } = await publisher();
    const watcher = await viewer(session);
    for (let i = 0; i < 4; i++) {
      relay!.clock.advance(TICK);
      await flush(client);
      await flush(watcher.client);
    }
    expect(peer.isOpen && watcher.peer.isOpen).toBe(true);
  });

  it("a pong the relay could not read (reading paused) is excused while frames keep coming", async () => {
    const { client, peer } = await publisher({ autoPong: false });
    const pings: Buffer[] = [];
    client.ws.on("ping", (data: Buffer) => pings.push(data));
    await flush(client);
    relay!.clock.advance(TICK); // ping 1
    await expect.poll(() => pings.length).toBe(1);
    await flush(client); // a text frame since the tick: a sign of life
    peer.pauseReading(); // as the fan-out does: what comes now waits unread
    client.ws.pong(pings[0]);
    relay!.clock.advance(TICK); // excused: ping 1 stays outstanding, no new ping
    expect(peer.isOpen).toBe(true);
    peer.resumeReading(); // the late echo is read and counts
    await flush(client);
    relay!.clock.advance(TICK); // ping 2
    await expect.poll(() => pings.length).toBe(2);
    client.sendRaw(Buffer.from("SRVC not a valid chunk"), true); // a binary frame counts too
    expect(await client.next()).toMatchObject({ type: "error", code: "BAD_SEQUENCE" });
    peer.pauseReading();
    client.ws.pong(pings[1]);
    relay!.clock.advance(TICK); // excused
    peer.resumeReading();
    await flush(client);
    relay!.clock.advance(TICK); // ping 3
    await expect.poll(() => pings.length).toBe(3);
    expect(peer.isOpen).toBe(true);
  });

  it("a paused socket that sends nothing is closed at the next tick all the same", async () => {
    const { client, session, peer } = await publisher({ autoPong: false });
    await flush(client);
    relay!.clock.advance(TICK); // ping
    peer.pauseReading();
    relay!.clock.advance(TICK); // no sign of life: a dead publisher is not kept by the fan-out's pauses
    await expect.poll(() => session.phase).toBe("grace");
    expect([4009, 1006]).toContain(await client.closed);
  });

  it("closed sockets are no longer watched (nothing keeps them alive)", async () => {
    const { client, session } = await publisher();
    // Only a weak reference to the relay's side of the socket stays in the test.
    const { client: watcher, ref } = await viewer(session).then(({ client: c, peer }) => ({
      client: c,
      ref: new WeakRef(peer),
    }));
    watcher.send({ type: "viewer.leave" });
    expect(await watcher.closed).toBe(1000);
    await expect.poll(() => session.connectedViewers).toBe(0);
    relay!.clock.advance(TICK);
    await flush(client);
    let collected = false;
    for (let i = 0; i < 20 && !collected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gc();
      collected = ref.deref() === undefined;
    }
    expect(collected).toBe(true);
  });

  it("a plain buildApp() runs it (production default)", async () => {
    const clock = new ManualClock();
    const config = loadConfig({ TRUST_PROXY: "false" });
    const registry = new Registry({ ...config, clock });
    const app = await buildApp({ config, clock, registry });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as AddressInfo;
      const client = await connectClient(`ws://127.0.0.1:${port}/ws`);
      client.sendRaw(JSON.stringify(fixture("session.create")));
      const created = await client.next();
      const peer = registry.get(created.sessionId as string)!.publisher as Connection;
      const ping = vi.spyOn(peer.socket, "ping");
      clock.advance(TICK);
      expect(ping).toHaveBeenCalledTimes(1);
      client.ws.close();
    } finally {
      await app.close();
    }
  });

  it("a throwing open or pong hook is logged and the socket keeps working", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    relay = await startRelay({
      logger,
      heartbeat: true,
      wsHandlers: {
        opened: () => {
          throw new Error("secret 7KQ4X");
        },
        pong: () => {
          throw new Error("secret 7KQ4X");
        },
      },
    });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect((await client.next()).type).toBe("session.created");
    client.ws.pong(Buffer.from("x"));
    await flush(client);
    const text = lines.join("");
    expect(text).toContain("websocket open handler failed");
    expect(text).toContain("websocket pong handler failed");
    expect(text).not.toContain("secret");
  });
});

describe("publisher activity (§9.1)", () => {
  it("any publisher frame or pong refreshes lastPublisherSeen; viewer frames do not", async () => {
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    const created = session.lastPublisherSeen;
    relay!.clock.advance(5_000);
    await flush(watcher.client);
    expect(session.lastPublisherSeen).toBe(created);
    await flush(client);
    expect(session.lastPublisherSeen).toBe(relay!.clock.now());
    relay!.clock.advance(1_000);
    client.sendRaw(Buffer.from("SRVC not a valid chunk"), true); // any frame counts
    expect(await client.next()).toMatchObject({ type: "error", code: "BAD_SEQUENCE" });
    expect(session.lastPublisherSeen).toBe(relay!.clock.now()); // before any text frame
    relay!.clock.advance(TICK); // WS ping; the publisher's pong counts too
    const pinged = relay!.clock.now();
    await expect.poll(() => session.lastPublisherSeen).toBe(pinged);
  });
});

describe("idle expiry warning and renew (SRV-14 criterion 3, §4.4)", () => {
  it("session.expiring 60 s before the idle expiry; session.renew restarts the idle period", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    const created = await client.next();
    const session = relay.registry.get(created.sessionId as string)!;
    const ttlS = relay.registry.limits.sessionTtlS;
    const start = relay.clock.now();

    relay.clock.advance((ttlS - 60) * 1000 - 10_000);
    expect(await flush(client)).toEqual([]);
    relay.clock.advance(10_000);
    const expiring = await client.next();
    expect(expiring).toEqual({
      protocolVersion: "1.0",
      type: "session.expiring",
      reason: "IDLE",
      closesAt: start + ttlS * 1000,
      ts: relay.clock.now(),
    });
    expect(validateMessage(expiring)).toMatchObject({ ok: true });

    client.send({ type: "session.renew", id: "p-20" });
    const renewed = await client.next();
    expect(renewed).toMatchObject({
      type: "session.renewed",
      replyTo: "p-20",
      ttl: { ...(created.ttl as object) },
    });
    expect(validateMessage(renewed)).toMatchObject({ ok: true });
    const renewedAt = relay.clock.now();

    // Past the old deadline: still live, warned again before the new one.
    relay.clock.advance(120_000);
    expect(relay.registry.get(session.id)).toBe(session);
    relay.clock.set(renewedAt + (ttlS - 60) * 1000);
    expect(await client.next()).toMatchObject({
      type: "session.expiring",
      closesAt: renewedAt + ttlS * 1000,
    });
    relay.clock.set(renewedAt + ttlS * 1000);
    expect(await client.next()).toMatchObject({ type: "session.expired", reason: "IDLE" });
    expect(await client.closed).toBe(4002);
  });

  it("session.renew from a publisher socket the session no longer has is ignored", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    const created = await client.next();
    const session = relay.registry.get(created.sessionId as string)!;
    const own = session.publisher;
    session.publisher = undefined; // as if a resumed socket had replaced it (SRV-15)
    client.send({ type: "session.renew", id: "p-21" });
    expect(await flush(client)).toEqual([]);
    session.publisher = own;
  });

  it("session.renew from a viewer is UNAUTHORIZED", async () => {
    relay = await startRelay();
    const publisherClient = await connectClient(relay.url);
    publisherClient.sendRaw(JSON.stringify(fixture("session.create")));
    const created = await publisherClient.next();
    const session = relay.registry.get(created.sessionId as string)!;
    const watcher = await viewer(session);
    await flush(watcher.client); // scene.state, viewer.count
    watcher.client.send({ type: "session.renew", id: "v-1" });
    expect(await watcher.client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
  });
});

describe("the heartbeat itself (fake sockets)", () => {
  interface Fake extends Pingable {
    pings: Buffer[];
    closes: number[];
    terminated: number;
    pauseCount: number;
    readingPaused: boolean;
    bufferedAmount: number;
  }
  function fake(): Fake {
    return {
      id: 1,
      isOpen: true,
      pauseCount: 0,
      readingPaused: false,
      bufferedAmount: 0,
      pings: [],
      closes: [],
      terminated: 0,
      ping(payload: Buffer) {
        this.pings.push(payload);
      },
      close(code: number) {
        this.closes.push(code);
        (this as { isOpen: boolean }).isOpen = false;
      },
      terminate() {
        this.terminated += 1;
      },
    };
  }
  function setup(logger = createLogger({ level: "silent" })) {
    const clock = new ManualClock();
    const beat = heartbeat({ clock, logger });
    beat.start();
    return { clock, beat };
  }

  it("ping with a fresh payload; only its echo counts; then 4009 and terminate at once", () => {
    const { clock, beat } = setup();
    const socket = fake();
    beat.add(socket);
    clock.advance(TICK);
    expect(socket.pings).toHaveLength(1);
    beat.pong(socket, Buffer.from("not the payload"));
    beat.pong(socket, socket.pings[0]!);
    clock.advance(TICK);
    expect(socket.pings).toHaveLength(2);
    expect(socket.pings[1]!.equals(socket.pings[0]!)).toBe(false);
    beat.pong(socket, socket.pings[0]!); // the old one does not answer the new ping
    clock.advance(TICK);
    expect([socket.closes, socket.terminated]).toEqual([[4009], 1]);
    expect(beat.size).toBe(0);
    beat.dispose();
  });

  it("a pause since the last tick is excused only for a socket that kept sending frames", () => {
    const { clock, beat } = setup();
    const [late, talking, mute] = [fake(), fake(), fake()];
    for (const socket of [late, talking, mute]) beat.add(socket);
    clock.advance(TICK); // pings
    for (const socket of [late, talking, mute]) socket.pauseCount += 1; // paused, resumed meanwhile
    beat.heard(late);
    beat.heard(talking);
    clock.advance(TICK);
    expect([late.closes, talking.closes, mute.closes]).toEqual([[], [], [4009]]);
    // Excused: the ping stays outstanding (no new one) and its late echo counts.
    expect([late.pings.length, talking.pings.length]).toEqual([1, 1]);
    beat.pong(late, late.pings[0]!);
    beat.heard(talking); // frames, but no pause in this interval: no excuse
    clock.advance(TICK);
    expect([late.pings.length, late.closes, talking.closes]).toEqual([2, [], [4009]]);
    beat.dispose();
  });

  it("a socket paused since before the last tick counts as paused; each excuse needs new frames", () => {
    const { clock, beat } = setup();
    const socket = fake();
    beat.add(socket);
    clock.advance(TICK); // ping
    socket.readingPaused = true; // the pause count is unchanged: paused all along
    beat.heard(socket);
    clock.advance(TICK); // excused
    expect(socket.closes).toEqual([]);
    clock.advance(TICK); // still paused, nothing heard since
    expect([socket.pings.length, socket.closes]).toEqual([1, [4009]]);
    beat.dispose();
  });

  it("frames alone do not excuse a socket the relay did not pause", () => {
    const { clock, beat } = setup();
    const socket = fake();
    beat.add(socket);
    clock.advance(TICK);
    beat.heard(socket);
    clock.advance(TICK);
    expect(socket.closes).toEqual([4009]);
    expect(() => beat.heard(fake())).not.toThrow(); // a socket no longer watched
    beat.dispose();
  });

  it("a ping queued behind data is excused while the peer takes some of it; a stuck queue is not", () => {
    const { clock, beat } = setup();
    const [draining, stuck, idle] = [fake(), fake(), fake()];
    draining.bufferedAmount = 1000;
    stuck.bufferedAmount = 5 * 1024 * 1024; // even above the soft watermark: a dead peer takes nothing
    for (const socket of [draining, stuck, idle]) beat.add(socket);
    clock.advance(TICK); // pings, queued behind 1000 B, 5 MiB and nothing
    draining.bufferedAmount = 999;
    clock.advance(TICK);
    expect([draining.closes, stuck.closes, idle.closes]).toEqual([[], [4009], [4009]]);
    expect(draining.pings).toHaveLength(1); // still outstanding
    clock.advance(TICK); // took nothing in this interval
    expect(draining.closes).toEqual([4009]);
    beat.dispose();
  });

  it("one failing socket is logged without its text; the others are still served", () => {
    const lines: string[] = [];
    const { clock, beat } = setup(
      createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
    );
    const broken = fake();
    broken.ping = () => {
      throw new Error("secret 7KQ4X");
    };
    const healthy = fake();
    beat.add(broken);
    beat.add(healthy);
    clock.advance(TICK);
    expect(healthy.pings).toHaveLength(1);
    expect(lines.join("")).toContain("heartbeat check failed");
    expect(lines.join("")).not.toContain("secret");
    beat.dispose();
    clock.advance(TICK);
    expect(healthy.pings).toHaveLength(1);
  });
});

describe("wiring (real sockets)", () => {
  it("Connection counts one pause per pause, however often pauseReading() is called", async () => {
    const { client, peer } = await publisher();
    expect([peer.pauseCount, peer.readingPaused]).toEqual([0, false]);
    peer.pauseReading();
    peer.pauseReading();
    expect([peer.pauseCount, peer.readingPaused]).toEqual([1, true]);
    peer.resumeReading();
    peer.pauseReading();
    expect(peer.pauseCount).toBe(2);
    peer.resumeReading();
    await flush(client);
  });

  it("the app runs it only when asked (tests drive the clock in big steps)", async () => {
    relay = await startRelay();
    const { client, peer } = await publisher({ autoPong: false });
    const ping = vi.spyOn(peer.socket, "ping");
    relay.clock.advance(3 * TICK);
    await flush(client);
    expect(ping).not.toHaveBeenCalled();
    expect(peer.isOpen).toBe(true);
  });
});
