import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ALPHABET, chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { WebSocket } from "ws";
import { createLogger } from "../src/logger.js";
import type { Session } from "../src/registry.js";
import { DEFAULT_MESSAGE_BUDGETS, TokenBucket, messageBudgets } from "../src/ws/budget.js";
import type { BucketLimits, BudgetSubject } from "../src/ws/budget.js";
import { CLOSE_COMPLETE_MS } from "../src/ws/connection.js";
import type { Connection } from "../src/ws/connection.js";
import { MAX_FRAGMENTS } from "../src/ws/endpoint.js";
import { INVALID_CODE_JITTER_MS } from "../src/ws/viewer.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const KIB = 1024;
const MIB = 1024 * KIB;
const HARD = 8 * MIB;
const { unbound, viewer: viewerLimits, publisher: publisherLimits } = DEFAULT_MESSAGE_BUDGETS;

let relay: TestRelay | undefined;
let lines: string[] = [];
afterEach(async () => {
  const closing = relay;
  relay = undefined;
  await closing?.close();
  lines = [];
});

async function start(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  relay = await startRelay({
    logger: createLogger({ level: "info", destination: { write: (l) => lines.push(l) } }),
    ...options,
  });
  return relay;
}

async function flush(client: TestClient): Promise<Received[]> {
  const id = `f-${Math.random().toString(36).slice(2, 10)}`;
  client.send({ type: "ping", id });
  const seen: Received[] = [];
  for (;;) {
    const message = await client.next();
    expect(validateMessage(message)).toMatchObject({ ok: true });
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

async function publisher(): Promise<{ client: TestClient; session: Session; peer: Connection }> {
  relay ??= await start();
  const client = await connectClient(relay.url);
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
  await flush(client); // scene.state, viewer.count
  return { client, peer: session.viewers.get(joined.viewerId as string)!.peer as Connection };
}

/** Frames of `bytes` until a full bucket of `limits` cannot pay one. */
const toLimit = (limits: BucketLimits, bytes: number): number =>
  Math.floor(limits.burst / (bytes + limits.frameCost)) + 1;
/** Frames of `bytes` that take a full bucket of `limits` past its debt of one burst. */
const toExceed = (limits: BucketLimits, bytes: number): number =>
  Math.floor((2 * limits.burst) / (bytes + limits.frameCost)) + 2;

/** Waits until the relay has read everything `client` sent, also before a session is bound. */
async function relayRead(client: TestClient): Promise<void> {
  const local = (client.ws as unknown as { _socket: Socket })._socket;
  const server = [...relay!.app.websocketServer.clients].find(
    (socket) => (socket as unknown as { _socket: Socket })._socket.remotePort === local.localPort,
  ) as unknown as { _socket: Socket };
  await expect.poll(() => server._socket.bytesRead).toBe(local.bytesWritten);
}

/**
 * The close code of a client that flooded past its close: reading again, it gets the close frame;
 * the relay may have stopped reading it (`endpoint.ts` `unread`), so its close timer ends it.
 */
async function closedAfterFlood(client: TestClient): Promise<number> {
  client.ws.resume();
  await expect.poll(() => client.ws.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
  relay!.clock.advance(CLOSE_COMPLETE_MS);
  return client.closed;
}

/** Waits until the relay's socket has read everything `client` sent (and handled it). */
async function received(client: TestClient, peer: Connection): Promise<void> {
  const sent = (client.ws as unknown as { _socket: Socket })._socket.bytesWritten;
  await expect
    .poll(() => (peer.socket as unknown as { _socket: Socket })._socket.bytesRead)
    .toBe(sent);
}

describe("the token bucket", () => {
  const limits = { rate: 1000, burst: 4000, frameCost: 0 };

  it("pays within its burst, runs into debt, then over it; retryAfterS covers the next small frame", () => {
    const bucket = new TokenBucket(limits, 0);
    expect(bucket.take(4000, 0)).toBe("ok");
    expect(bucket.take(1500, 0)).toBe("limited"); // −1,500
    expect(bucket.retryAfterS).toBe(3); // 1,500 + 1 KiB at 1,000/s: 2.52 s, rounded up
    expect(bucket.take(2500, 0)).toBe("limited"); // −4,000: one burst of debt
    expect(bucket.take(1, 0)).toBe("exceeded");
  });

  it("charges frameCost per frame on top of the bytes", () => {
    const bucket = new TokenBucket({ ...limits, frameCost: 1000 }, 0);
    expect(bucket.take(1000, 0)).toBe("ok");
    expect(bucket.take(1000, 0)).toBe("ok"); // 4,000 paid
    expect(bucket.take(0, 0)).toBe("limited");
  });

  it("refills by elapsed time, never above its burst, and not when the clock steps back", () => {
    const bucket = new TokenBucket(limits, 0);
    expect(bucket.take(4000, 0)).toBe("ok");
    expect(bucket.take(2000, 2_000)).toBe("ok"); // 2 s: 2,000 back
    expect(bucket.take(1, 1_000)).toBe("limited"); // stepped back: nothing back
    expect(bucket.take(4000, 60_000)).toBe("ok"); // refilled to the burst only
    expect(bucket.take(1, 60_000)).toBe("limited");
    const full = new TokenBucket(limits, 10_000);
    expect(full.take(1000, 10_000)).toBe("ok");
    expect(full.take(3000, 5_000)).toBe("ok"); // a step back takes nothing away either
  });
});

describe("the budgets of sockets", () => {
  const subject = (role?: "publisher" | "viewer"): BudgetSubject => ({
    role,
    bound: role !== undefined,
  });

  it("parsing cost is counted: a 256 KiB frame weighs as much as 256 KiB of small ones (criterion 3)", () => {
    const { charge } = messageBudgets(new ManualClock());
    const [big, small] = [subject("publisher"), subject("publisher")];
    let bigBytes = 0;
    while (charge(big, "text", 256 * KIB).verdict === "ok") bigBytes += 256 * KIB;
    let smallBytes = 0;
    while (charge(small, "text", 64).verdict === "ok") smallBytes += 64;
    expect(bigBytes).toBeLessThanOrEqual(publisherLimits.burst);
    expect(bigBytes).toBeGreaterThan(
      publisherLimits.burst - 2 * (256 * KIB + publisherLimits.frameCost),
    );
    // Small frames pay their frame cost too: fewer of their bytes get through, never more.
    expect(smallBytes).toBeLessThan(bigBytes);
  });

  it("a publisher at the protocol's ceiling is never limited: one 256 KiB update every 100 ms, or three every 250 ms", () => {
    const clock = new ManualClock();
    const { charge } = messageBudgets(clock);
    const [steady, split] = [subject("publisher"), subject("publisher")];
    // §3.3: ≤ 256 KiB per message; §8.1: debounced to 100–250 ms; SLC-16 splits larger changes.
    for (let ms = 0; ms < 60_000; ms += 50) {
      if (ms % 100 === 0) expect(charge(steady, "text", 256 * KIB).verdict).toBe("ok");
      if (ms % 250 === 0)
        for (let part = 0; part < 3; part++)
          expect(charge(split, "text", 256 * KIB).verdict).toBe("ok");
      clock.advance(50);
    }
  });

  it("the stage decides the bucket: unbound, then the role's — a fresh one at the handshake", () => {
    const { charge } = messageBudgets(new ManualClock());
    const socket = { role: undefined as "publisher" | "viewer" | undefined, bound: false };
    expect(charge(socket, "text", unbound.burst - unbound.frameCost).verdict).toBe("ok");
    expect(charge(socket, "text", 0).verdict).toBe("limited");
    // A role fixed by an invalid first message is not a binding: the small bucket stays.
    Object.assign(socket, { role: "publisher" });
    expect(charge(socket, "text", 0).verdict).toBe("limited");
    Object.assign(socket, { role: "viewer", bound: true });
    expect(charge(socket, "text", 1 * KIB).verdict).toBe("ok"); // the viewer's own bucket
  });

  it("warns at the first limited frame, and again only once retryAfterS has passed", () => {
    const clock = new ManualClock();
    const { charge } = messageBudgets(clock);
    const socket = subject("viewer");
    expect(charge(socket, "text", viewerLimits.burst - viewerLimits.frameCost).verdict).toBe("ok");
    const first = charge(socket, "text", 16 * KIB); // two seconds of the viewer's refill
    expect(first).toMatchObject({ verdict: "limited", warn: true });
    expect(first.retryAfterS).toBeGreaterThanOrEqual(2);
    expect(charge(socket, "text", 16 * KIB)).toMatchObject({ verdict: "limited", warn: false });
    clock.advance(first.retryAfterS * 1000 - 1000);
    expect(charge(socket, "text", 100)).toMatchObject({ verdict: "limited", warn: false });
    clock.advance(1000);
    // The frames after the warning deepened the debt: still limited, but told again (never silent).
    expect(charge(socket, "text", 100)).toMatchObject({ verdict: "limited", warn: true });
  });

  it("a socket that waits retryAfterS after its only dropped frame is served", () => {
    const clock = new ManualClock();
    const { charge } = messageBudgets(clock);
    const socket = subject("viewer");
    expect(charge(socket, "text", viewerLimits.burst - viewerLimits.frameCost).verdict).toBe("ok");
    const { retryAfterS } = charge(socket, "text", 1500); // a debt not a multiple of the rate
    clock.advance(retryAfterS * 1000);
    expect(charge(socket, "text", 100).verdict).toBe("ok");
  });

  it("a tiny binary frame costs 16 KiB: past the chunk burst after ⌊161 MiB / (16 KiB + 12 B)⌋ of them", () => {
    const { charge } = messageBudgets(new ManualClock());
    const socket = subject("publisher");
    const fit = Math.floor(DEFAULT_MESSAGE_BUDGETS.publisherBinary.burst / (16 * KIB + 12));
    for (let i = 0; i < fit; i++) expect(charge(socket, "binary", 12).verdict).toBe("ok");
    expect(charge(socket, "binary", 12).verdict).toBe("limited");
  });

  it("a publisher's chunks have their own bucket: two whole 64 MiB snapshots fit it", () => {
    const { charge } = messageBudgets(new ManualClock());
    const socket = subject("publisher");
    for (let i = 0; i < 2 * 1024; i++)
      expect(charge(socket, "binary", 64 * KIB + 12).verdict).toBe("ok");
    expect(charge(socket, "text", 1 * KIB).verdict).toBe("ok"); // text untouched by the chunks
  });
});

describe("criterion 1: a publisher over its budget gets RATE_LIMITED and 4006", () => {
  it("10× its budget of ping and session.renew in a second: RATE_LIMITED + 4006 at once, nothing dropped and carried on", async () => {
    const { client, session } = await publisher();
    await flush(client);
    const ping = JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "p" });
    const renew = JSON.stringify({ protocolVersion: "1.0", type: "session.renew", id: "r" });
    // 10 × the rate, in one instant of the manual clock.
    const count = 10 * Math.ceil(publisherLimits.rate / (ping.length + publisherLimits.frameCost));
    for (let i = 0; i < count; i++) client.sendRaw(i % 50 === 0 ? renew : ping);
    // It floods on past the close: the relay stops reading it, and its close timer ends it.
    expect(await closedAfterFlood(client)).toBe(4006);
    const errors = client.received.filter((m) => m.type === "error");
    expect(errors).toEqual([expect.objectContaining({ code: "RATE_LIMITED", retryable: true })]);
    expect((errors[0]!.details as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0);
    // The error is the last thing it got: nothing after the frame it could not pay was handled.
    expect(client.received.at(-1)).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    const answered = client.received.filter((m) => m.type !== "error").length;
    expect(answered).toBeLessThanOrEqual(toLimit(publisherLimits, renew.length) + 1); // + flush
    // Logged once, without the session code.
    const closedLines = lines.filter((l) => l.includes("message budget exceeded"));
    expect(closedLines).toHaveLength(1);
    expect(closedLines[0]).not.toContain(session.code);
  });

  it("snapshot chunks are charged to their own bucket: past it the publisher is closed 4006", async () => {
    await start({
      budgets: {
        ...DEFAULT_MESSAGE_BUDGETS,
        publisherBinary: { rate: KIB, burst: 64 * KIB + 12, frameCost: 0 },
      },
    });
    const { client, session } = await publisher();
    const watcher = await viewer(session);
    const forwarded: number[] = [];
    watcher.client.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) forwarded.push(data.readUInt32LE(8)); // chunkIndex (§6.3)
    });
    const data = randomBytes(2 * 64 * KIB);
    const sha256 = createHash("sha256").update(data).digest("hex");
    client.send({
      type: "scene.snapshot.begin",
      sceneVersion: 1,
      byteLength: data.byteLength,
      sha256,
      chunkCount: 2,
      chunkSize: 64 * KIB,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 1,
    });
    for (const { chunkIndex, payload } of chunkify(data, 64 * KIB)) {
      const frame = encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload);
      client.sendRaw(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), true);
    }
    expect(await client.closed).toBe(4006); // the second chunk is over the bucket
    expect(client.received.at(-1)).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    // The refused chunk was never handled: the viewer got the first one, then the abort.
    await expect
      .poll(() => watcher.client.received.some((m) => m.type === "scene.snapshot.abort"))
      .toBe(true);
    expect(forwarded).toEqual([0]);
  });

  it("a well-behaved publisher streaming a 64 MiB snapshot never meets the budget", async () => {
    const { client, session } = await publisher();
    const data = randomBytes(64 * MIB);
    const sha256 = createHash("sha256").update(data).digest("hex");
    client.send({
      type: "scene.snapshot.begin",
      sceneVersion: 1,
      byteLength: data.byteLength,
      sha256,
      chunkCount: 64,
      chunkSize: MIB,
      format: "glb",
      extensionsUsed: [],
      nodeCount: 1,
    });
    for (const { chunkIndex, payload } of chunkify(data, MIB)) {
      const frame = encodeChunkFrame({ sceneVersion: 1, chunkIndex }, payload);
      client.sendRaw(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), true);
    }
    client.send({ type: "scene.snapshot.end", sceneVersion: 1, sha256 });
    const seen = await flush(client);
    expect(seen.map((m) => m.type)).toEqual(["scene.snapshot.ack"]);
    expect(session.snapshot?.sceneVersion).toBe(1);
  }, 30_000);
});

describe("a viewer over its budget: frames dropped unparsed, told when to retry", () => {
  it("one RATE_LIMITED; a dropped frame is never parsed; after retryAfterS it is served again", async () => {
    const { session } = await publisher();
    const { client, peer } = await viewer(session);
    const ping = JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "p" });
    for (let i = 0; i < toLimit(viewerLimits, ping.length) + 3; i++) client.sendRaw(ping);
    client.sendRaw("{not json"); // dropped too: no INVALID_MESSAGE, no strike
    await received(client, peer);
    const errors = client.received.filter((m) => m.type === "error");
    expect(errors).toEqual([expect.objectContaining({ code: "RATE_LIMITED", retryable: true })]);
    relay!.clock.advance((errors[0]!.details as { retryAfterS: number }).retryAfterS * 1000);
    await flush(client); // served: its own pong arrives
    expect(client.received.filter((m) => m.type === "error")).toHaveLength(1); // and no new error
    expect([peer.violations, peer.isOpen]).toEqual([0, true]);
  });

  it("over twice its burst: RATE_LIMITED + 4006", async () => {
    const { session } = await publisher();
    const { client } = await viewer(session);
    const ping = JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "p" });
    for (let i = 0; i < toExceed(viewerLimits, ping.length); i++) client.sendRaw(ping);
    expect(await closedAfterFlood(client)).toBe(4006);
    expect(client.received.filter((m) => m.type === "error").map((m) => m.code)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
  });
});

describe("the protocol's own answers come first: size and role checks close before any budget", () => {
  it("a viewer's 100 KiB text → PAYLOAD_TOO_LARGE + 1009; its 100 KiB binary frame → UNAUTHORIZED + 1008", async () => {
    const { session } = await publisher();
    const text = await viewer(session);
    text.client.sendRaw(JSON.stringify({ type: "ping", pad: "x".repeat(100 * KIB) }));
    expect(await text.client.closed).toBe(1009);
    expect(text.client.received.at(-1)).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const binary = await viewer(session);
    binary.client.sendRaw(Buffer.alloc(100 * KIB), true);
    expect(await binary.client.closed).toBe(1008);
    expect(binary.client.received.at(-1)).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a role fixed by an invalid session.create is no binding: over the small budget its frames are dropped, not closed", async () => {
    await start();
    const client = await connectClient(relay!.url);
    // INVALID_MESSAGE: the type fixed the role (publisher), but no session is bound.
    client.sendRaw(JSON.stringify({ ...fixture("session.create"), profile: 7 }));
    const ping = JSON.stringify({
      protocolVersion: "1.0",
      type: "ping",
      id: "p",
      pad: "x".repeat(4096),
    });
    for (let i = 0; i < toLimit(unbound, ping.length) + 3; i++) client.sendRaw(ping);
    await relayRead(client);
    const errors = client.received.filter((m) => m.type === "error").map((m) => m.code);
    expect(errors).toEqual(["INVALID_MESSAGE", "RATE_LIMITED"]);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.terminate();
  });

  it("pings during a refused join's delay are not answered: the socket reads nothing more (§12)", async () => {
    await start();
    const client = await connectClient(relay!.url);
    let pongs = 0;
    client.ws.on("pong", () => (pongs += 1));
    client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: ALPHABET[0]!.repeat(5) }));
    for (let i = 0; i < 20; i++) client.ws.ping();
    await relayRead(client);
    relay!.clock.advance(INVALID_CODE_JITTER_MS.max);
    expect(await client.closed).toBe(4004);
    expect(client.received.at(-1)).toMatchObject({ code: "INVALID_CODE" });
    expect(pongs).toBe(0);
  });

  it("a socket not bound yet: a 600 KiB first frame → 1009, not the budget", async () => {
    await start();
    const client = await connectClient(relay!.url);
    client.sendRaw(JSON.stringify({ ...fixture("session.create"), pad: "x".repeat(600 * KIB) }));
    expect(await client.closed).toBe(1009);
  });
});

describe("criterion 2: control frames without reading cannot fill the relay's buffer, bound or not", () => {
  function flood(client: TestClient, count: number, kind: "ping" | "pong"): void {
    client.ws.pause(); // reads nothing: every pong the relay queues stays with it
    const payload = Buffer.alloc(125, 1);
    for (let i = 0; i < count; i++) client.ws[kind](payload);
  }

  it("a socket not bound yet that floods pings: closed 4006 after its small budget", async () => {
    await start();
    const client = await connectClient(relay!.url);
    flood(client, toExceed(unbound, 125), "ping");
    expect(await closedAfterFlood(client)).toBe(4006);
  });

  it("a joined viewer that floods pings: only those within its budget are answered, then 4006", async () => {
    const { session } = await publisher();
    const { client } = await viewer(session);
    let pongs = 0;
    client.ws.on("pong", () => (pongs += 1));
    flood(client, toExceed(viewerLimits, 125), "ping");
    expect(await closedAfterFlood(client)).toBe(4006);
    // A burst's worth at most (≈ 100 of the ≈ 200 pings): the dropped ones queue nothing.
    expect(pongs).toBeGreaterThan(0);
    expect(pongs).toBeLessThan(toLimit(viewerLimits, 125));
  });

  it.each(["ping", "pong", "text"] as const)(
    "a closing socket that floods %s frames instead of completing the close is not read once it owes a second burst",
    async (kind) => {
      const { session } = await publisher();
      const { client, peer } = await viewer(session);
      client.ws.pause(); // never reads the close frame, so never answers it
      client.send({ type: "viewer.leave" }); // closed 1000, its bucket nearly full
      await expect.poll(() => peer.isOpen).toBe(false);
      const text = JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "x".repeat(70) });
      const send = (count: number): void => {
        if (kind === "text") for (let i = 0; i < count; i++) client.sendRaw(text);
        else flood(client, count, kind);
      };
      const size = kind === "text" ? text.length : 125;
      send(toLimit(viewerLimits, size));
      await received(client, peer);
      expect(peer.socket.isPaused).toBe(false); // still read while it owes less than a second burst
      send(toExceed(viewerLimits, size));
      await expect.poll(() => peer.socket.isPaused).toBe(true);
      expect(await closedAfterFlood(client)).toBe(1000); // the close code still reaches it
    },
  );

  it("at shutdown a socket that is no longer read is terminated: the relay does not wait for it", async () => {
    const { session } = await publisher();
    const { client, peer } = await viewer(session);
    flood(client, 2 * toExceed(viewerLimits, 125), "ping");
    await expect.poll(() => peer.socket.isPaused).toBe(true);
    const closing = relay!;
    relay = undefined;
    await closing.close(); // its close timer runs on the manual clock: it would never fire
    expect(peer.socket.readyState).toBe(WebSocket.CLOSED);
    client.ws.terminate();
  });

  it(`a message of more than ${MAX_FRAGMENTS} fragments is refused 1008 before it is decoded`, async () => {
    const { session } = await publisher();
    const { client } = await viewer(session);
    const fragments = (count: number, id: string): void => {
      const text = JSON.stringify({ protocolVersion: "1.0", type: "ping", id });
      const size = Math.ceil(text.length / count);
      for (let i = 0; i < count; i++)
        client.ws.send(text.slice(i * size, (i + 1) * size), { fin: i === count - 1 });
    };
    fragments(MAX_FRAGMENTS, "in");
    expect(await client.next()).toMatchObject({ type: "pong", replyTo: "in" });
    fragments(MAX_FRAGMENTS + 1, "over");
    expect(await client.closed).toBe(1008);
  });

  it("a joined viewer that floods pongs: charged like any frame, closed 4006", async () => {
    const { session } = await publisher();
    const { client } = await viewer(session);
    flood(client, toExceed(viewerLimits, 125), "pong");
    expect(await closedAfterFlood(client)).toBe(4006);
  });

  it("whatever the budget: a ping whose pong would take the buffer above 8 MiB closes 4010 instead", async () => {
    await start({
      budgets: {
        ...DEFAULT_MESSAGE_BUDGETS,
        publisher: { rate: MIB, burst: 64 * MIB, frameCost: 0 },
      },
    });
    const { client, peer } = await publisher();
    const pongs: Buffer[] = [];
    client.ws.on("pong", (data: Buffer) => pongs.push(data));
    Object.defineProperty(peer, "bufferedAmount", { configurable: true, get: () => HARD - 127 });
    client.ws.ping(Buffer.alloc(125));
    await expect.poll(() => pongs.length).toBe(1); // exactly up to 8 MiB: answered
    Object.defineProperty(peer, "bufferedAmount", { configurable: true, get: () => HARD - 126 });
    client.ws.ping(Buffer.alloc(125));
    expect(await client.closed).toBe(4010);
    expect(pongs).toHaveLength(1);
    expect(lines.filter((l) => l.includes("slow consumer closed"))).toHaveLength(1);
  });

  it("a socket not bound yet is held to 8 MiB at every frame (the fan-out sees bound ones only)", async () => {
    let unboundPeer: Connection | undefined;
    await start({ wsHandlers: { opened: (connection) => (unboundPeer = connection) } });
    const client = await connectClient(relay!.url);
    await expect.poll(() => unboundPeer).toBeDefined();
    Object.defineProperty(unboundPeer!, "bufferedAmount", {
      configurable: true,
      get: () => HARD + 1,
    });
    client.send({ type: "ping", id: "p-1" });
    expect(await client.closed).toBe(4010);
  });
});
