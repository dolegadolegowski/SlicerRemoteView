import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chunkify, encodeChunkFrame, validateMessage } from "@slicerremoteview/shared";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";
import { Registry, SWEEP_INTERVAL_MS } from "../src/registry.js";
import type { Session } from "../src/registry.js";
import type { Connection } from "../src/ws/connection.js";
import { HANDSHAKE_TIMEOUT_MS } from "../src/ws/endpoint.js";
import { readFrame } from "../src/ws/frame.js";
import { publisherHandlers } from "../src/ws/publisher.js";
import { fixture } from "./helpers/fixtures.js";
import { ManualClock } from "./helpers/manual-clock.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { Received, TestClient, TestRelay } from "./helpers/ws-client.js";

const GLB = readFileSync(
  new URL("../../shared/fixtures/glb/asymmetric-2nodes.glb", import.meta.url),
);
const SHA256 = createHash("sha256").update(GLB).digest("hex");

const relays: TestRelay[] = [];
let lines: string[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  lines = [];
});

async function start(maxViewers?: number): Promise<TestRelay> {
  const relay = await startRelay({
    logger: createLogger({ level: "trace", destination: { write: (l) => lines.push(l) } }),
    ...(maxViewers !== undefined && {
      config: loadConfig({
        TRUST_PROXY: "false",
        ALLOWED_ORIGINS: "https://relay.example.org",
        MAX_VIEWERS: String(maxViewers),
      }),
    }),
  });
  relays.push(relay);
  return relay;
}

async function nextValid(client: TestClient): Promise<Received> {
  const message = await client.next();
  expect(validateMessage(message)).toMatchObject({ ok: true });
  return message;
}

/** Round trip: everything sent before was handled; returns what arrived meanwhile (schema-checked). */
async function flush(client: TestClient): Promise<Received[]> {
  const id = `f-${Math.random().toString(36).slice(2, 10)}`;
  client.send({ type: "ping", id });
  const seen: Received[] = [];
  for (;;) {
    const message = await nextValid(client);
    if (message.type === "pong" && message.replyTo === id) return seen;
    seen.push(message);
  }
}

const types = (messages: Received[]): string[] => messages.map((m) => m.type);

interface Publisher {
  client: TestClient;
  session: Session;
  sessionId: string;
  publisherToken: string;
  code: string;
}

async function publisher(relay: TestRelay): Promise<Publisher> {
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create")));
  const created = await nextValid(client);
  const sessionId = created.sessionId as string;
  return {
    client,
    session: relay.registry.get(sessionId)!,
    sessionId,
    publisherToken: created.publisherToken as string,
    code: created.code as string,
  };
}

function resumeMessage(sessionId: string, publisherToken: string): Record<string, unknown> {
  return {
    ...fixture("session.resume"),
    id: "p-r",
    sessionId,
    publisherToken,
    lastSceneVersion: 1,
  };
}

function sendSnapshot(client: TestClient, sceneVersion: number, end = true): void {
  client.send({
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: GLB.byteLength,
    sha256: SHA256,
    chunkCount: 1,
    chunkSize: 64 * 1024,
    format: "glb",
    extensionsUsed: [],
    nodeCount: 2,
  });
  if (!end) return;
  for (const { chunkIndex, payload } of chunkify(GLB, 64 * 1024))
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
  client.send({ type: "scene.snapshot.end", sceneVersion, sha256: SHA256 });
}

interface Joined {
  client: TestClient;
  joined: Received;
}

/** Joins by code; the first three messages are viewer.joined, scene.state, viewer.count (§5.2). */
async function join(relay: TestRelay, code: string): Promise<Joined> {
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code }));
  const first = [await nextValid(client), await nextValid(client), await nextValid(client)];
  expect(types(first)).toEqual(["viewer.joined", "scene.state", "viewer.count"]);
  return { client, joined: first[0]! };
}

function rejoinMessage(sessionId: string, viewerToken: string): Record<string, unknown> {
  const message: Record<string, unknown> = {
    ...fixture("viewer.join"),
    id: "v-r",
    sessionId,
    viewerToken,
  };
  delete message.code;
  return message;
}

describe("session.resume (§4.3)", () => {
  it("criterion 1: a publisher that dropped resumes within grace — same code, cached snapshot, viewers told offline then online, no re-upload", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    sendSnapshot(pub.client, 1);
    expect(types(await flush(pub.client))).toContain("scene.snapshot.ack");
    const v = await join(relay, pub.code);
    pub.client.ws.terminate(); // the uplink is gone
    const offline = await nextValid(v.client);
    expect(offline).toMatchObject({ type: "session.publisherState", online: false });
    expect(pub.session.phase).toBe("grace");

    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    const resumed = await nextValid(again);
    expect(resumed).toEqual({
      protocolVersion: "1.0",
      type: "session.resumed",
      replyTo: "p-r",
      sessionId: pub.sessionId,
      code: pub.code,
      sceneVersion: 1,
      snapshotVersion: 1,
      viewerCount: 1,
      ttl: relay.registry.ttl(pub.session),
      ts: relay.clock.now(),
    });
    expect(await nextValid(v.client)).toEqual({
      protocolVersion: "1.0",
      type: "session.publisherState",
      online: true,
      ts: relay.clock.now(),
    });
    expect(pub.session.phase).toBe("active");
    // No re-upload: an update on the cached snapshot reaches the viewer.
    again.send({
      type: "scene.update",
      baseVersion: 1,
      sceneVersion: 2,
      changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
    });
    expect(await flush(again)).toEqual([]);
    expect(await nextValid(v.client)).toMatchObject({ type: "scene.update", sceneVersion: 2 });
    // Logged without the code or the token.
    const resumedLines = lines.filter((l) => l.includes("session resumed"));
    expect(resumedLines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(["info"]);
    for (const line of lines) {
      expect(line).not.toContain(pub.publisherToken);
      expect(line).not.toContain(`"${pub.code}"`);
    }
  });

  it("half-open: the old socket still open is closed 4011, its snapshot in flight aborted PUBLISHER_GONE; viewers are not told offline", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    sendSnapshot(pub.client, 1);
    expect(types(await flush(pub.client))).toContain("scene.snapshot.ack");
    const v = await join(relay, pub.code);
    sendSnapshot(pub.client, 2, false); // begin only: in flight
    await flush(pub.client);
    expect(await nextValid(v.client)).toMatchObject({
      type: "scene.snapshot.begin",
      sceneVersion: 2,
    });

    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await nextValid(again)).toMatchObject({
      type: "session.resumed",
      sceneVersion: 2, // the aborted begin's version is used (§8.4)
      snapshotVersion: 1,
    });
    expect(await pub.client.closed).toBe(4011);
    expect(await nextValid(v.client)).toMatchObject({
      type: "scene.snapshot.abort",
      sceneVersion: 2,
      reason: "PUBLISHER_GONE",
    });
    expect(await flush(v.client)).toEqual([]); // no publisherState: it never went offline
    // A takeover's only trace: logged at warn.
    const resumedLines = lines.filter((l) => l.includes("session resumed"));
    expect(resumedLines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(["warn"]);
    expect(pub.session.publisher).not.toBeUndefined();
    expect(pub.session.phase).toBe("active");
    // The new socket is the publisher: its snapshot is accepted.
    sendSnapshot(again, 3);
    expect(types(await flush(again))).toContain("scene.snapshot.ack");
  });

  it("after accepted updates the resumed sceneVersion is the last update's; viewerCount counts connected viewers only (§13 step 10)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    sendSnapshot(pub.client, 1);
    await flush(pub.client);
    const gone = await join(relay, pub.code);
    gone.client.ws.terminate(); // an entry kept for rejoin, not connected
    await join(relay, pub.code);
    await expect.poll(() => pub.session.connectedViewers).toBe(1);
    pub.client.send({
      type: "scene.update",
      baseVersion: 1,
      sceneVersion: 2,
      changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
    });
    await flush(pub.client);
    pub.client.ws.terminate();
    await expect.poll(() => pub.session.phase).toBe("grace");
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await nextValid(again)).toMatchObject({
      type: "session.resumed",
      sceneVersion: 2,
      snapshotVersion: 1,
      viewerCount: 1,
    });
    expect(pub.session.viewers.size).toBe(2);
  });

  it("after an aborted begin the resumed sceneVersion is the highest version used (§8.4)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    sendSnapshot(pub.client, 1);
    await flush(pub.client);
    sendSnapshot(pub.client, 5, false);
    await flush(pub.client);
    pub.client.ws.terminate();
    await expect.poll(() => pub.session.phase).toBe("grace");
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await nextValid(again)).toMatchObject({ sceneVersion: 5, snapshotVersion: 1 });
    expect(await flush(again)).toEqual([]); // no idle warning: none is due
  });

  it("criterion 2: a wrong token → UNAUTHORIZED + 4003 at once; a create sent after it is never processed", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const client = await connectClient(relay.url);
    const t0 = relay.clock.now();
    const wrong = `pt_${"B".repeat(43)}`;
    client.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, wrong)));
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect(await client.closed).toBe(4003);
    expect(client.received).toEqual([
      expect.objectContaining({
        type: "error",
        code: "UNAUTHORIZED",
        replyTo: "p-r",
        retryable: false,
      }),
    ]);
    expect(relay.registry.size).toBe(1);
    expect(relay.clock.now()).toBe(t0); // no timer was involved: at once
    expect(pub.session.publisher).not.toBeUndefined(); // the session's publisher is untouched
  });

  it("criterion 2: after a registry wipe → SESSION_NOT_FOUND; the socket stays open for a fresh 10 s and session.create{preferredCode} gets the same code", async () => {
    const before = await start();
    const pub = await publisher(before);
    const after = await start(); // a redeploy: an empty registry
    const client = await connectClient(after.url);
    after.clock.advance(HANDSHAKE_TIMEOUT_MS - 2_000);
    client.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await nextValid(client)).toMatchObject({
      type: "error",
      code: "SESSION_NOT_FOUND",
      replyTo: "p-r",
      retryable: false,
    });
    after.clock.advance(HANDSHAKE_TIMEOUT_MS - 1_000); // past the first window, inside the new one
    client.send({ ...fixture("session.create"), preferredCode: pub.code });
    const created = await nextValid(client);
    expect(created).toMatchObject({ type: "session.created", code: pub.code });
    expect(after.registry.isCodeQuarantined(pub.code)).toBe(false);
  });

  it("criterion 2: 10 s after SESSION_NOT_FOUND without a create → 4012", async () => {
    const relay = await start();
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(resumeMessage("sess_0123456789ABCDEF", `pt_${"C".repeat(43)}`)));
    expect(await nextValid(client)).toMatchObject({ code: "SESSION_NOT_FOUND" });
    relay.clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(await flush(client)).toEqual([]); // a round trip: still open 1 ms before the window ends
    relay.clock.advance(1);
    expect(await client.closed).toBe(4012);
  });

  it("one resume per socket: a second one after SESSION_NOT_FOUND → UNAUTHORIZED + 1008", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(resumeMessage("sess_0123456789ABCDEF", pub.publisherToken)));
    expect(await nextValid(client)).toMatchObject({ code: "SESSION_NOT_FOUND" });
    client.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await client.closed).toBe(1008);
    expect(client.received.at(-1)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(pub.session.publisher).not.toBeUndefined();
  });

  it("an idle warning that fell due while the publisher was offline is sent again after session.resumed (§4.4)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const idleMs = relay.registry.limits.sessionTtlS * 1000;
    relay.clock.advance(idleMs - 100_000); // 100 s before the idle expiry, no viewer
    pub.client.ws.terminate();
    await expect.poll(() => pub.session.phase).toBe("grace");
    expect(pub.session.idleWarned).toBe(false); // not due yet when the publisher dropped
    relay.clock.advance(50_000); // the warning falls due (60 s before) with no socket to get it
    expect(pub.session.idleWarned).toBe(true);
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect((await nextValid(again)).type).toBe("session.resumed");
    expect(await nextValid(again)).toMatchObject({
      type: "session.expiring",
      reason: "IDLE",
      closesAt: relay.registry.idleDeadline(pub.session),
    });
    expect(await flush(again)).toEqual([]);
  });

  it("a grace that has run out still resumes until the sweep releases the session (≤ 10 s)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    relay.clock.advance(5_000); // off the sweep's 10 s beat
    pub.client.ws.terminate();
    await expect.poll(() => pub.session.phase).toBe("grace");
    relay.clock.advance(pub.session.graceEndsAt! + 1 - relay.clock.now());
    expect(pub.session.phase).toBe("grace"); // not swept yet
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect(await nextValid(again)).toMatchObject({ type: "session.resumed", code: pub.code });
    relay.clock.advance(SWEEP_INTERVAL_MS);
    expect(relay.registry.get(pub.sessionId)).toBe(pub.session); // live: the sweep leaves it be
  });

  it("session.close acts only from the session's current publisher socket (unit)", () => {
    const clock = new ManualClock();
    const config = loadConfig({});
    const logger = createLogger({ level: "silent" });
    const registry = new Registry({ ...config, clock });
    const { handlers } = publisherHandlers({
      registry,
      config,
      limiter: new RateLimiter({ clock, logger }),
      logger,
    });
    const { session } = registry.createSession("mobile");
    const closed: number[] = [];
    const socket = (): Connection =>
      ({ session, close: (code: number) => closed.push(code) }) as unknown as Connection;
    const current = socket();
    session.publisher = current;
    const close = (connection: Connection): void =>
      void handlers["session.close"]!(
        connection,
        { type: "session.close", reason: "USER_STOPPED" } as never,
        readFrame(JSON.stringify({ type: "session.close", reason: "USER_STOPPED" })),
      );
    close(socket()); // a socket a resume replaced
    expect(registry.get(session.id)).toBe(session);
    expect(closed).toEqual([]);
    close(current); // the control: the session's own publisher socket
    expect(registry.get(session.id)).toBeUndefined();
    expect(closed).toEqual([1000]);
  });

  it("a resumed session.close from the new socket ends the session; the replaced one can no longer", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(resumeMessage(pub.sessionId, pub.publisherToken)));
    expect((await nextValid(again)).type).toBe("session.resumed");
    pub.client.send({ type: "session.close", reason: "USER_STOPPED" }); // closing: never handled
    expect(await pub.client.closed).toBe(4011);
    expect(relay.registry.get(pub.sessionId)).toBe(pub.session);
    again.send({ type: "session.close", reason: "USER_STOPPED" });
    expect(await again.closed).toBe(1000);
    expect(relay.registry.get(pub.sessionId)).toBeUndefined();
  });
});

describe("viewer.join{sessionId, viewerToken} (§5.1)", () => {
  it("a viewer that dropped rejoins as the same entry: viewer.joined (its token echoed), scene.state, viewer.count", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    sendSnapshot(pub.client, 1);
    await flush(pub.client);
    const v = await join(relay, pub.code);
    const viewerId = v.joined.viewerId as string;
    const viewerToken = v.joined.viewerToken as string;
    v.client.ws.terminate();
    await expect.poll(() => pub.session.connectedViewers).toBe(0);

    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, viewerToken)));
    const first = [await nextValid(again), await nextValid(again), await nextValid(again)];
    expect(types(first)).toEqual(["viewer.joined", "scene.state", "viewer.count"]);
    expect(first[0]).toMatchObject({
      replyTo: "v-r",
      sessionId: pub.sessionId,
      viewerId,
      viewerToken,
      snapshotVersion: 1,
      publisherOnline: true,
      viewerCount: 1,
    });
    expect(pub.session.viewers.size).toBe(1);
    expect(pub.session.connectedViewers).toBe(1);
    const rejoined = lines.filter((l) => l.includes("viewer rejoined"));
    expect(rejoined).toHaveLength(1);
    expect(rejoined[0]).not.toContain(viewerToken);
  });

  it("criterion 3: a banned address still rejoins with its token (§12: rejoins do not count)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const v = await join(relay, pub.code);
    v.client.ws.terminate();
    await expect.poll(() => pub.session.connectedViewers).toBe(0);
    const key = relay.limiter.clientKey("127.0.0.1");
    for (let i = 0; i < 25; i++) relay.limiter.joinFailed(key);
    const banned = await connectClient(relay.url);
    banned.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: pub.code }));
    expect(await banned.closed).toBe(4006); // a code join is refused: the address is banned
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, v.joined.viewerToken as string)));
    expect(await nextValid(again)).toMatchObject({
      type: "viewer.joined",
      viewerId: v.joined.viewerId,
    });
  });

  it("a second concurrent use of a token closes the older socket 4011; the count stays", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const v = await join(relay, pub.code);
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, v.joined.viewerToken as string)));
    expect(await nextValid(again)).toMatchObject({ type: "viewer.joined", viewerCount: 1 });
    expect(await v.client.closed).toBe(4011);
    await flush(again);
    expect(pub.session.connectedViewers).toBe(1);
    expect([...pub.session.viewers.values()][0]!.peer).not.toBeUndefined();
  });

  it("in a full session an entry still connected keeps its slot: its rejoin replaces the older socket (T8)", async () => {
    const relay = await start(1);
    const pub = await publisher(relay);
    const v = await join(relay, pub.code); // the only slot
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, v.joined.viewerToken as string)));
    expect(await nextValid(again)).toMatchObject({ type: "viewer.joined", viewerCount: 1 });
    expect(await v.client.closed).toBe(4011);
  });

  it("a disconnected entry needs a free slot again: SESSION_FULL + 4005", async () => {
    const relay = await start(1);
    const pub = await publisher(relay);
    const v = await join(relay, pub.code);
    v.client.ws.terminate();
    await expect.poll(() => pub.session.connectedViewers).toBe(0);
    await join(relay, pub.code); // takes the only slot
    const again = await connectClient(relay.url);
    again.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, v.joined.viewerToken as string)));
    expect(await again.closed).toBe(4005);
    expect(again.received.at(-1)).toMatchObject({ code: "SESSION_FULL", retryable: true });
  });

  it("a token of another session, of an ended session or none at all → SESSION_NOT_FOUND, socket kept open", async () => {
    const relay = await start();
    const a = await publisher(relay);
    const b = await publisher(relay);
    const v = await join(relay, a.code);
    const token = v.joined.viewerToken as string;
    const tryRejoin = async (sessionId: string, viewerToken: string): Promise<void> => {
      const client = await connectClient(relay.url);
      client.sendRaw(JSON.stringify(rejoinMessage(sessionId, viewerToken)));
      expect(await nextValid(client)).toMatchObject({ code: "SESSION_NOT_FOUND", replyTo: "v-r" });
      expect(client.ws.readyState).toBe(client.ws.OPEN);
      client.ws.terminate();
    };
    await tryRejoin(b.sessionId, token); // the token names a viewer of a, not of b
    await tryRejoin(a.sessionId, `vt_${"D".repeat(43)}`);
    a.client.send({ type: "session.close", reason: "USER_STOPPED" });
    expect(await v.client.closed).toBe(4001);
    await tryRejoin(a.sessionId, token);
  });

  it("SESSION_NOT_FOUND opens a fresh 10 s window for the code join (§9.2)", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const client = await connectClient(relay.url);
    relay.clock.advance(HANDSHAKE_TIMEOUT_MS - 2_000);
    client.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, `vt_${"F".repeat(43)}`)));
    expect(await nextValid(client)).toMatchObject({ code: "SESSION_NOT_FOUND" });
    relay.clock.advance(HANDSHAKE_TIMEOUT_MS - 1_000); // past the first window, inside the new one
    client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), code: pub.code }));
    expect(await nextValid(client)).toMatchObject({ type: "viewer.joined" });
  });

  it("one rejoin per socket: after SESSION_NOT_FOUND a code join may follow, a second rejoin → UNAUTHORIZED + 1008", async () => {
    const relay = await start();
    const pub = await publisher(relay);
    const v = await join(relay, pub.code);
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, `vt_${"E".repeat(43)}`)));
    expect(await nextValid(client)).toMatchObject({ code: "SESSION_NOT_FOUND" });
    client.sendRaw(JSON.stringify(rejoinMessage(pub.sessionId, v.joined.viewerToken as string)));
    expect(await client.closed).toBe(1008);
    expect(client.received.at(-1)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await flush(v.client)).toEqual([]); // the entry's own socket was not replaced
  });
});
