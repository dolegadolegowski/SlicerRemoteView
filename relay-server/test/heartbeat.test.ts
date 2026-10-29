import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
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
    // No publisher frame since that tick: a text frame would now excuse it (SRV-27).
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

  it("sockets that answer stay open, tick after tick: each echo counts (a fresh ping every tick)", async () => {
    const { client, session, peer } = await publisher();
    const watcher = await viewer(session);
    const pings: Buffer[] = [];
    client.ws.on("ping", (data: Buffer) => pings.push(data));
    for (let i = 1; i <= 4; i++) {
      relay!.clock.advance(TICK);
      // The publisher sends no frame, only its automatic echo; a new ping means the last echo counted.
      await expect.poll(() => pings.length).toBe(i);
      await expect.poll(() => session.lastPublisherSeen).toBe(relay!.clock.now());
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

describe("inbound frames count as life (SRV-27, report 2026-10-20-slicer-7, §9.1)", () => {
  /** Every 8 s until `untilMs` (relative): `act` once per step; `act` awaits the relay's I/O. */
  async function every8s(untilMs: number, act: () => Promise<void> | void): Promise<void> {
    for (let t = 8_000; t <= untilMs; t += 8_000) {
      relay!.clock.advance(8_000);
      await act();
    }
  }

  it("criterion 3: a publisher streaming a chunk every 8 s keeps its session with its pongs withheld > 60 s; a mute viewer of it is still closed", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } });
    const { client, session, peer } = await publisher({ autoPong: false }, logger);
    const pings: Buffer[] = [];
    client.ws.on("ping", (data: Buffer) => pings.push(data));
    const watcher = await viewer(session);
    // Reads every chunk forwarded to it, sends nothing, answers no ping: frames of others are no life of its own.
    const mute = await connectClient(relay!.url, {}, { autoPong: false });
    mute.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const muteId = (await mute.next()).viewerId as string;
    // 12 chunks of 64 KiB, one every 8 s (≈ 1 Mbit/s with 1 MiB chunks: 8.4 s): 96 s, past the ticks at 30, 60, 90 s.
    const data = randomBytes(12 * 65_536);
    const sha256 = createHash("sha256").update(data).digest("hex");
    client.send({
      type: "scene.snapshot.begin",
      id: "p-1",
      sceneVersion: 1,
      byteLength: data.byteLength,
      sha256,
      chunkCount: 12,
      chunkSize: 65_536,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 1,
    });
    // The sync points below are relay state and the viewer: the publisher sends no text frame until `end`.
    await expect.poll(() => session.assembling?.sceneVersion).toBe(1);
    const chunks = [...chunkify(data, 65_536)].map(({ chunkIndex, payload }) =>
      Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload)),
    );
    const seen: Received[] = [];
    let sent = 0;
    await every8s(96_000, async () => {
      client.sendRaw(chunks[sent++]!, true);
      await expect.poll(() => session.assembling?.nextIndex).toBe(sent);
      seen.push(...(await flush(watcher.client)));
    });
    expect(pings).toHaveLength(1); // the ping of the first tick, outstanding at 60 s and 90 s: excused, not answered
    expect([peer.isOpen, session.publisher === peer, session.phase]).toEqual([
      true,
      true,
      "allocated",
    ]);
    expect(seen.filter((m) => m.type === "session.publisherState")).toEqual([]);
    expect([4009, 1006]).toContain(await mute.closed);
    client.send({ type: "scene.snapshot.end", id: "p-2", sceneVersion: 1, sha256 });
    for (;;) if ((await client.next()).type === "scene.snapshot.ack") break;
    expect(session.phase).toBe("active");
    // Negative control: `end` was its last frame (at 96 s); tick 120 excuses it, tick 150 closes it.
    relay!.clock.advance(24_000);
    await flush(watcher.client);
    expect(peer.isOpen).toBe(true);
    relay!.clock.advance(TICK);
    await expect.poll(() => session.phase).toBe("grace");
    expect([4009, 1006]).toContain(await client.closed);
    const timeouts = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.errorCode === "HEARTBEAT_TIMEOUT");
    expect(timeouts).toEqual([
      expect.objectContaining({ role: "viewer", viewerId: muteId, sessionId: session.id }),
      expect.objectContaining({ role: "publisher", sessionId: session.id }),
    ]);
    expect(lines.join("")).not.toMatch(
      new RegExp(`(?<![A-Za-z0-9])${session.code}(?![A-Za-z0-9])`, "i"),
    );
  });

  it("criterion 2 on the wire: unsolicited pongs every 8 s from a socket that reads nothing keep nothing open", async () => {
    const { client, session } = await publisher({ autoPong: false });
    await flush(client);
    client.ws.pause(); // reads nothing more
    await every8s(56_000, async () => {
      client.ws.pong(Buffer.from("unsolicited"));
      // Handled before the clock moves on (a pong of the publisher refreshes lastPublisherSeen).
      await expect.poll(() => session.lastPublisherSeen).toBe(relay!.clock.now());
    });
    relay!.clock.advance(8_000); // tick 2 at 60 s
    await expect.poll(() => session.phase).toBe("grace");
    client.ws.resume();
  });

  it("WebSocket pings of the client are no frames: sent every 8 s, they keep nothing open", async () => {
    const { client, session } = await publisher({ autoPong: false });
    const pongs: Buffer[] = [];
    client.ws.on("pong", (data: Buffer) => pongs.push(data));
    await flush(client);
    await every8s(56_000, async () => {
      client.ws.ping(Buffer.from("c"));
      await expect.poll(() => pongs.length).toBeGreaterThan(0); // `ws` answers it; the heartbeat ignores it
      pongs.length = 0;
    });
    relay!.clock.advance(8_000); // tick 2 at 60 s
    await expect.poll(() => session.phase).toBe("grace");
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
    bufferedAmount: number;
  }
  /** A publisher's socket unless `role` says otherwise (only a publisher's frames are life). */
  function fake(role: "publisher" | "viewer" = "publisher"): Fake {
    return {
      id: 1,
      role,
      isOpen: true,
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

  it("criterion 1: frames every 8 s keep a socket whose pong is late past two ticks; a mute one is closed at the second", () => {
    const { clock, beat } = setup();
    const [talking, mute] = [fake(), fake()];
    beat.add(talking);
    beat.add(mute);
    const start = clock.now();
    let muteClosedAt: number | undefined;
    // Ticks at 30, 60, 90, 120 s; the talking socket sends a frame every 8 s and echoes ping 1 at 104 s.
    for (let t = 8_000; t <= 128_000; t += 8_000) {
      clock.advance(8_000);
      if (muteClosedAt === undefined && mute.closes.length > 0) muteClosedAt = clock.now();
      beat.heard(talking);
      if (t === 104_000) beat.pong(talking, talking.pings[0]!);
      if (t > TICK && t < 104_000) expect(talking.pings).toHaveLength(1); // outstanding: no new ping
    }
    expect([talking.closes, talking.terminated]).toEqual([[], 0]);
    expect(talking.pings).toHaveLength(2); // the late echo counted: a fresh ping at 120 s
    expect([mute.closes, mute.terminated, mute.pings.length]).toEqual([[4009], 1, 1]);
    expect(muteClosedAt! - start).toBeLessThanOrEqual(2 * TICK + 8_000); // seen at the next 8 s step
    beat.dispose();
  });

  it("the mute socket goes at the second tick exactly; a frame excuses only the tick right after it", () => {
    const { clock, beat } = setup();
    const [mute, early, late] = [fake(), fake(), fake()];
    for (const socket of [mute, early, late]) beat.add(socket);
    clock.advance(TICK - 1);
    beat.heard(late); // a frame before ping 1 excuses nothing after it
    clock.advance(1); // ping 1 to each
    clock.advance(TICK - 2_000);
    beat.heard(early); // just before tick 2
    clock.advance(1_999);
    expect(mute.closes).toEqual([]);
    clock.advance(1); // tick 2
    expect([mute.closes, early.closes, late.closes]).toEqual([[4009], [], [4009]]);
    // `late` had no frame in (30 s, 60 s]; `early` is excused once, then needs another frame.
    clock.advance(1);
    beat.heard(early);
    clock.advance(TICK - 1); // tick 3: excused by the frame at 60.001 s
    expect(early.closes).toEqual([]);
    clock.advance(TICK - 1);
    expect(early.closes).toEqual([]);
    clock.advance(1); // tick 4: nothing since tick 3 — 59.999 s after its last frame
    expect([early.closes, early.pings.length]).toEqual([[4009], 1]);
    beat.dispose();
  });

  it("a viewer's frames are no sign of life: it is closed at the second tick like a mute one (T3)", () => {
    const { clock, beat } = setup();
    const viewer = fake("viewer");
    beat.add(viewer);
    for (let t = 8_000; t <= 64_000 && viewer.closes.length === 0; t += 8_000) {
      clock.advance(8_000);
      beat.heard(viewer); // e.g. its application `ping` every 8 s
    }
    expect([viewer.closes, viewer.terminated]).toEqual([[4009], 1]);
    beat.dispose();
  });

  it("a socket whose close never completes is handed to close() at the next tick, once", () => {
    const { clock, beat } = setup();
    const closing = fake();
    beat.add(closing);
    (closing as { isOpen: boolean }).isOpen = false; // e.g. its peer half-closed TCP
    clock.advance(TICK);
    expect([closing.closes, closing.pings, closing.terminated]).toEqual([[4009], [], 0]);
    clock.advance(TICK); // no longer watched: Connection.close drops it
    expect(closing.closes).toEqual([4009]);
    beat.dispose();
  });

  it("criterion 2: pongs that echo no ping are no frames: sent every 8 s, they keep nothing open", () => {
    const { clock, beat } = setup();
    const socket = fake();
    beat.add(socket);
    for (let t = 8_000; t <= 64_000 && socket.closes.length === 0; t += 8_000) {
      clock.advance(8_000);
      beat.pong(socket, Buffer.from("unsolicited"));
    }
    expect(socket.closes).toEqual([4009]);
    expect(() => beat.heard(fake())).not.toThrow(); // a socket not (or no longer) watched
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
  it("a viewer that answers no WS ping but sends `ping` every 8 s is closed 4009 at the second tick (T3)", async () => {
    const { session } = await publisher();
    const client = await connectClient(relay!.url, {}, { autoPong: false });
    client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const joined = await client.next();
    const peer = session.viewers.get(joined.viewerId as string)!.peer as Connection;
    for (let t = 8_000; t < 2 * TICK; t += 8_000) {
      relay!.clock.advance(8_000);
      await flush(client); // an application ping, read by the relay before the clock moves on
    }
    expect(peer.isOpen).toBe(true);
    relay!.clock.advance(2 * TICK - 56_000); // tick 2 at 60 s
    expect([4009, 1006]).toContain(await client.closed);
  });

  it("a viewer whose peer half-closed TCP with a backlog leaves its live session at a tick + 5 s", async () => {
    const { client: pub, session } = await publisher();
    const v = await connectClient(relay!.url);
    v.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: session.code }));
    const joined = await v.next();
    const peer = session.viewers.get(joined.viewerId as string)!.peer as Connection;
    v.ws.pause(); // reads nothing: the relay's queue for it fills
    const data = randomBytes(200 * 65_536);
    const sha256 = createHash("sha256").update(data).digest("hex");
    pub.send({
      type: "scene.snapshot.begin",
      sceneVersion: 1,
      byteLength: data.byteLength,
      sha256,
      chunkCount: 200,
      chunkSize: 65_536,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 1,
    });
    await expect.poll(() => session.assembling?.sceneVersion).toBe(1);
    let sent = 0;
    for (const { chunkIndex, payload } of chunkify(data, 65_536)) {
      pub.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload)), true);
      sent += 1;
      await expect.poll(() => session.assembling?.nextIndex).toBe(sent);
      if (peer.bufferedAmount > 150_000) break; // the kernel's buffers are full too
    }
    expect(peer.bufferedAmount).toBeGreaterThan(150_000);
    // A TCP half-close (FIN, no close frame): `ws` arms no timer for it (`_socket` is `ws`'s own).
    (v.ws as unknown as { _socket: Socket })._socket.end();
    await expect.poll(() => peer.isOpen).toBe(false);
    expect(session.viewers.get(joined.viewerId as string)?.peer).toBe(peer); // still in the session
    relay!.clock.advance(TICK); // handed to close() …
    await flush(pub);
    expect(session.viewers.get(joined.viewerId as string)?.peer).toBe(peer); // not dropped at the tick
    relay!.clock.advance(5_000); // … which drops it: its buffer does not shrink
    await expect.poll(() => session.viewers.get(joined.viewerId as string)?.peer).toBeUndefined();
    v.ws.terminate();
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
