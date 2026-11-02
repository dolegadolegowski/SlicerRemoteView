// QA-14 — negative tests for roles, tokens and session isolation against the built relay (raw `ws` + `fetch`).
// Covers: the role gate and permissions matrix (a viewer sending publisher types or binary frames, a first message
// that declares no role, unknown types before the handshake), envelope strikes (invalid JSON ×3 → `4007`), the
// major-version check, viewer-token replay (`4011`), `session.resume` with a wrong token (`4003` at once) or for an
// unknown session (`SESSION_NOT_FOUND`, then the `session.create{preferredCode}` fallback on the same socket),
// `session.create` carrying a token field, `GET /api/scene/:v` authorisation (401 / 404 / 429 / no URL
// credentials), and two sessions side by side (no frame or token of A ever serves B; when B closes, B's tokens get
// `410` and A is untouched). Every negative case ends by checking that the relay still serves the bystander session
// (NFR-23).
// Requirements / threats: FR-33, NFR-12, NFR-17, NFR-23; architecture §8 T3 (abuse), T4 (token theft / replay),
// T8 (concurrent token use), T11 (cross-session isolation).
// Protocol: §2 (versioning), §3.1–§3.2 (first message, binary frames), §4.1, §4.3, §4.5, §5.1–§5.3, §9.2–§9.3, §10,
// §11, §12 (`/api/scene` 30/min per token).
//
// Contract note (first message `ping`): §3.1 says the role is declared by the first message — `session.create`,
// `session.resume` or `viewer.join` — and that *until the session is bound* only handshake messages and `ping` are
// accepted. A `ping` as the very first message declares no role, so it is an `UNAUTHORIZED` violation with close
// `1008`, as docs/plan/qa.md states; a `ping` sent after the first message but before binding (here: after a
// `SESSION_NOT_FOUND` resume) is answered with `pong`. Both are tested below.
//
// Secrets: codes, session ids and tokens are compared with boolean assertions only (a failing `toBe(secret)` would
// print them); no message that carries one is ever passed to `toMatchObject`.

import { createHash } from "node:crypto";
import { decodeChunkHeader, encodeChunkFrame } from "@slicerremoteview/shared";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { expect, test } from "../harness/fixtures.ts";
import {
  PUBLISHER_INFO,
  VIEWER_INFO,
  expectPong,
  expectStillServing,
  fetchScene,
  fixtureInfo,
  forgedToken,
  rawPublisher,
  rejoin,
  viewerByCode,
} from "../harness/qa14-auth.ts";
import type { JoinedViewer } from "../harness/qa14-auth.ts";
import { connect, joinViewer, nextIp } from "../harness/ws-client.ts";
import type { Client, Message } from "../harness/ws-client.ts";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** A well-formed session id (defs `sessionId`) that no relay issued. */
const UNKNOWN_SESSION_ID = "sess_QA14NOSUCHSESSION0";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A well-formed code different from `avoid` (boolean comparison only: `avoid` is a live code). */
function otherCode(avoid: string): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (code !== avoid) return code;
  }
}

/** `GET /healthz` (§10): relay-wide live sessions and open viewer sockets, no secrets. */
async function healthz(baseUrl: string): Promise<{ sessions: number; viewers: number }> {
  return (await (await fetch(`${baseUrl}/healthz`)).json()) as { sessions: number; viewers: number };
}

/** `error` fields that may be shown (they never carry secrets, §9.2). */
function errorOf(message: Message): { type: string; code: unknown; replyTo: unknown; retryable: unknown } {
  return { type: message.type, code: message["code"], replyTo: message["replyTo"], retryable: message["retryable"] };
}

test.describe("QA-14 roles and handshake (§3.1, §3.2, §11)", () => {
  test("a viewer sending scene.update → UNAUTHORIZED, the second offence → 1008, nothing forwarded", async ({
    stack,
  }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const offender = await viewerByCode(stack.wsUrl, stack.code);
    const update = {
      type: "scene.update",
      sceneVersion: 2,
      baseVersion: 1,
      changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
    };
    offender.client.send({ ...update, id: "x-1" });
    expect(errorOf(await offender.client.next("error"))).toEqual({
      type: "error",
      code: "UNAUTHORIZED",
      replyTo: "x-1",
      retryable: false,
    });
    // One offence does not close the socket (§11: "for binary frames or a second offence").
    await expectPong(offender.client);
    offender.client.send({ ...update, id: "x-2" });
    expect(errorOf(await offender.client.next("error"))).toMatchObject({ code: "UNAUTHORIZED", replyTo: "x-2" });
    expect((await offender.client.closedWithin()).code).toBe(1008);

    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
    // The relay never forwarded or applied the viewer's update: the bystander saw none (its pong above is a
    // barrier — a forwarded frame would have been queued before it) and a new viewer's state is still version 1.
    expect(bystander.client.messages.some((m) => m.type === "scene.update")).toBe(false);
    const { client: fresh, state } = await joinViewer(stack.wsUrl, stack.code, { ip: nextIp() });
    expect(state["sceneVersion"]).toBe(1);
    expect(state["nodes"]).toEqual([]);
    fresh.close();
  });

  test("a viewer sending a binary frame → UNAUTHORIZED + 1008 at once, nothing forwarded", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const offender = await viewerByCode(stack.wsUrl, stack.code);
    const chunk = encodeChunkFrame({ sceneVersion: 2, chunkIndex: 0 }, new Uint8Array(1024).fill(7));
    offender.client.sendRaw(Buffer.from(chunk), true);
    expect(errorOf(await offender.client.next("error"))).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
    expect((await offender.client.closedWithin()).code).toBe(1008);

    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
    expect(bystander.client.binary.length).toBe(0);
  });

  test("a binary frame as the first message → UNAUTHORIZED + 1008", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const client = await connect(stack.wsUrl, { ip: nextIp() });
    client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion: 1, chunkIndex: 0 }, new Uint8Array(16))), true);
    expect(errorOf(await client.next("error"))).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await client.closedWithin()).code).toBe(1008);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("ping as the first message declares no role → UNAUTHORIZED + 1008", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const client = await connect(stack.wsUrl, { ip: nextIp() });
    client.send({ type: "ping", id: "hb-1" });
    expect(errorOf(await client.next("error"))).toEqual({
      type: "error",
      code: "UNAUTHORIZED",
      replyTo: "hb-1",
      retryable: false,
    });
    expect((await client.closedWithin()).code).toBe(1008);
    expect(client.messages.some((m) => m.type === "pong")).toBe(false);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("an unknown type as the first message → UNAUTHORIZED + 1008", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const client = await connect(stack.wsUrl, { ip: nextIp() });
    client.send({ type: "qa.probe", id: "u-1" });
    expect(errorOf(await client.next("error"))).toMatchObject({ code: "UNAUTHORIZED", replyTo: "u-1" });
    expect((await client.closedWithin()).code).toBe(1008);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("an unknown type while the handshake is pending is an UNAUTHORIZED offence; once bound it is UNSUPPORTED_TYPE", async ({
    stack,
  }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    // Pending: a resume answered SESSION_NOT_FOUND fixed the role but bound no session (§3.1, §4.3).
    const pending = await connect(stack.wsUrl, { ip: nextIp() });
    pending.send({
      type: "session.resume",
      id: "p-1",
      sessionId: UNKNOWN_SESSION_ID,
      publisherToken: forgedToken("pt_"),
      clientInfo: PUBLISHER_INFO,
      lastSceneVersion: 1,
    });
    expect(errorOf(await pending.next("error"))).toMatchObject({ code: "SESSION_NOT_FOUND" });
    pending.send({ type: "qa.probe", id: "u-1" });
    expect(errorOf(await pending.next("error"))).toMatchObject({ code: "UNAUTHORIZED", replyTo: "u-1" });
    pending.send({ type: "qa.probe", id: "u-2" });
    expect(errorOf(await pending.next("error"))).toMatchObject({ code: "UNAUTHORIZED", replyTo: "u-2" });
    expect((await pending.closedWithin()).code).toBe(1008);

    // Bound: an unknown type of major 1 is answered UNSUPPORTED_TYPE and the socket stays open (§2).
    bystander.client.send({ type: "qa.probe", id: "u-3" });
    expect(errorOf(await bystander.client.next("error"))).toMatchObject({ code: "UNSUPPORTED_TYPE", replyTo: "u-3" });
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("invalid JSON ×3 on a bound viewer → INVALID_MESSAGE ×3, then 4007", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const offender = await viewerByCode(stack.wsUrl, stack.code);
    for (let strike = 1; strike <= 3; strike++) {
      offender.client.sendRaw(`{"protocolVersion":"1.0","type":"ping",${strike}`);
      expect(errorOf(await offender.client.next("error"))).toMatchObject({ code: "INVALID_MESSAGE" });
      // The first two strikes keep the socket (§9.2 "3 strikes → 4007"); a ping is no strike.
      if (strike < 3) await expectPong(offender.client);
    }
    expect((await offender.client.closedWithin()).code).toBe(4007);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test('protocolVersion "2.0" → UNSUPPORTED_VERSION + 4000, for a viewer and a publisher', async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const viewer = await connect(stack.wsUrl, { ip: nextIp() });
    // The live code: a 2.x client is refused before any lookup, not joined.
    viewer.send({ protocolVersion: "2.0", type: "viewer.join", id: "v-1", code: stack.code, clientInfo: VIEWER_INFO });
    expect(errorOf(await viewer.next("error"))).toEqual({
      type: "error",
      code: "UNSUPPORTED_VERSION",
      replyTo: "v-1",
      retryable: false,
    });
    expect((await viewer.closedWithin()).code).toBe(4000);
    expect(viewer.messages.some((m) => m.type === "viewer.joined")).toBe(false);

    const publisher = await connect(stack.wsUrl, { ip: nextIp() });
    publisher.send({
      protocolVersion: "2.0",
      type: "session.create",
      id: "p-1",
      clientInfo: PUBLISHER_INFO,
      preferredCode: null,
      profile: "mobile",
    });
    expect(errorOf(await publisher.next("error"))).toMatchObject({ code: "UNSUPPORTED_VERSION", replyTo: "p-1" });
    expect((await publisher.closedWithin()).code).toBe(4000);
    const health = (await (await fetch(`${stack.baseUrl}/healthz`)).json()) as { sessions: number };
    expect(health.sessions).toBe(1);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });
});

test.describe("QA-14 tokens (§4.1, §4.3, §5.1–§5.2, T4, T8)", () => {
  test("viewer token replay from a second socket → the older socket is closed 4011", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const first = await viewerByCode(stack.wsUrl, stack.code);
    const second = await rejoin(stack.wsUrl, first.sessionId, first.token);
    expect(second.reply.type).toBe("viewer.joined");
    expect(second.reply["viewerId"] === first.viewerId, "the rejoin got another viewer entry").toBe(true);
    expect((await first.client.closedWithin()).code).toBe(4011);
    // The replaced socket's slot is reused: still two viewers (bystander + this entry), in the reply, in the
    // count the bystander is sent after the rejoin (§5.3), and in the relay-wide open viewer sockets (§10).
    expect(second.reply["viewerCount"]).toBe(2);
    const countsBefore = 2; // bystander's own join, then `first`'s
    await expect
      .poll(() => bystander.client.messages.filter((m) => m.type === "viewer.count").length)
      .toBeGreaterThan(countsBefore);
    expect(bystander.client.messages.filter((m) => m.type === "viewer.count").at(-1)?.["viewerCount"]).toBe(2);
    await expect.poll(async () => (await healthz(stack.baseUrl)).viewers).toBe(2);
    await expectPong(second.client);

    // A third use of the same token replaces the second socket in turn.
    const third = await rejoin(stack.wsUrl, first.sessionId, first.token);
    expect(third.reply.type).toBe("viewer.joined");
    expect((await second.client.closedWithin()).code).toBe(4011);
    await expectPong(third.client);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("session.resume with a wrong publisherToken → UNAUTHORIZED + 4003 immediately; the publisher keeps its session", async ({
    stack,
  }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    // Session ids reach every viewer (§5.2), so an attacker has one; the token is the only secret (T4).
    const attacker = await connect(stack.wsUrl, { ip: nextIp() });
    const sentAt = Date.now();
    attacker.send({
      type: "session.resume",
      id: "p-9",
      sessionId: bystander.sessionId,
      publisherToken: forgedToken("pt_"),
      clientInfo: PUBLISHER_INFO,
      lastSceneVersion: 1,
    });
    expect(errorOf(await attacker.next("error"))).toEqual({
      type: "error",
      code: "UNAUTHORIZED",
      replyTo: "p-9",
      retryable: false,
    });
    expect((await attacker.closedWithin(3_000)).code).toBe(4003);
    // "Immediately": far below the 10 s handshake window a SESSION_NOT_FOUND socket would get (§4.3).
    expect(Date.now() - sentAt).toBeLessThan(3_000);
    expect(attacker.messages.some((m) => m.type === "session.resumed")).toBe(false);

    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
    // The real publisher was neither replaced (4011) nor reported offline to the viewers (§4.6).
    expect(bystander.client.messages.some((m) => m.type === "session.publisherState")).toBe(false);
    expect(stack.publisher!.process.exitCode).toBeNull();
    expect(stack.publisher!.outputs().stderr.includes("not reconnecting")).toBe(false);
  });

  test("session.resume for an unknown session → SESSION_NOT_FOUND; the socket stays open for session.create{preferredCode}", async ({
    stack,
  }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const client = await connect(stack.wsUrl, { ip: nextIp() });
    client.send({
      type: "session.resume",
      id: "p-1",
      sessionId: UNKNOWN_SESSION_ID,
      publisherToken: forgedToken("pt_"),
      clientInfo: PUBLISHER_INFO,
      lastSceneVersion: 42,
    });
    expect(errorOf(await client.next("error"))).toEqual({
      type: "error",
      code: "SESSION_NOT_FOUND",
      replyTo: "p-1",
      retryable: false,
    });
    // Not bound yet, but a ping is accepted before the handshake completes (§3.1) and the socket stays open.
    await expectPong(client);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.closeInfo).toBeUndefined();

    const preferred = otherCode(stack.code);
    client.send({
      type: "session.create",
      id: "p-2",
      clientInfo: PUBLISHER_INFO,
      preferredCode: preferred,
      profile: "mobile",
    });
    const created = await client.next((m) => m.type === "session.created" || m.type === "error");
    expect(created.type).toBe("session.created");
    expect(created["replyTo"]).toBe("p-2");
    expect(created["code"] === preferred, "the free preferredCode was not granted").toBe(true);
    const health = (await (await fetch(`${stack.baseUrl}/healthz`)).json()) as { sessions: number };
    expect(health.sessions).toBe(2);
    await expectPong(client);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  for (const field of ["publisherToken", "viewerToken", "token"] as const) {
    test(`session.create carrying "${field}" is refused (INVALID_MESSAGE, no session)`, async ({ stack }) => {
      const bystander = await viewerByCode(stack.wsUrl, stack.code);
      const client = await connect(stack.wsUrl, { ip: nextIp() });
      client.send({
        type: "session.create",
        id: "p-1",
        clientInfo: PUBLISHER_INFO,
        preferredCode: null,
        profile: "mobile",
        [field]: forgedToken(field === "viewerToken" ? "vt_" : "pt_"),
      });
      expect(errorOf(await client.next("error"))).toMatchObject({ code: "INVALID_MESSAGE", replyTo: "p-1" });
      // Give a wrongly accepted create time to answer, then check none did.
      await expectPong(client);
      expect(client.messages.some((m) => m.type === "session.created")).toBe(false);
      const health = (await (await fetch(`${stack.baseUrl}/healthz`)).json()) as { sessions: number };
      expect(health.sessions).toBe(1);
      client.close();
      await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
    });
  }
});

test.describe("QA-14 GET /api/scene authorisation (§10, §12)", () => {
  test("no Bearer → 401, unknown token → 401, another version → 404", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const viewer = await viewerByCode(stack.wsUrl, stack.code);

    const none = await fetchScene(stack.baseUrl, 1);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(none.body.byteLength).toBeLessThan(100);
    const basic = await fetch(`${stack.baseUrl}/api/scene/1`, {
      headers: { Authorization: `Basic ${Buffer.from(`x:${viewer.token}`).toString("base64")}` },
    });
    expect(basic.status).toBe(401);
    expect((await fetchScene(stack.baseUrl, 1, forgedToken("vt_"))).status).toBe(401);
    // A publisher token is no viewer token.
    expect((await fetchScene(stack.baseUrl, 1, forgedToken("pt_"))).status).toBe(401);

    for (const version of [0, 2, 4_294_967_295]) {
      const other = await fetchScene(stack.baseUrl, version, viewer.token);
      expect(other.status, `version ${version}`).toBe(404);
      expect(other.body.byteLength).toBeLessThan(100);
    }
    const ok = await fetchScene(stack.baseUrl, 1, viewer.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("model/gltf-binary");
    expect(sha256(ok.body)).toBe(fixtureInfo("asymmetric-2nodes.glb").sha256);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("31 requests in a minute with one token → the 31st is 429; other tokens are not affected", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const viewer = await viewerByCode(stack.wsUrl, stack.code);
    const other = await viewerByCode(stack.wsUrl, stack.code);
    const started = Date.now();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await fetchScene(stack.baseUrl, 1, viewer.token)).status);
    // The window is one minute (§12); the 31 requests must all fall inside it for the assertion to mean anything.
    expect(Date.now() - started).toBeLessThan(50_000);
    expect(statuses.slice(0, 30).every((s) => s === 200), `first 30: ${statuses.slice(0, 30).join(",")}`).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await fetchScene(stack.baseUrl, 1, viewer.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect((await fetchScene(stack.baseUrl, 1, viewer.token, "HEAD")).status).toBe(429);
    // Per token, not per address: another viewer of the same session is still served.
    expect((await fetchScene(stack.baseUrl, 1, other.token)).status).toBe(200);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });

  test("a code or token in the query string → 404, nothing echoed or logged", async ({ stack }) => {
    const bystander = await viewerByCode(stack.wsUrl, stack.code);
    const viewer = await viewerByCode(stack.wsUrl, stack.code);
    const code = stack.code;
    const probes = [
      { path: `/api/scene/1?code=${code}`, token: viewer.token },
      { path: `/api/scene/1?code=${code}`, token: undefined },
      { path: `/api/scene/1?viewerToken=${viewer.token}`, token: undefined },
      { path: `/api/scene/1?access_token=${viewer.token}`, token: undefined },
    ];
    for (const [i, probe] of probes.entries()) {
      const response = await fetchScene(stack.baseUrl, probe.path, probe.token);
      expect(response.status, `probe ${i}`).toBe(404);
      const text = response.body.toString("utf8");
      // `Headers.forEach` (the tsconfig's DOM lib has no `DOM.Iterable`, so no `entries()`).
      let headers = "";
      response.headers.forEach((value, key) => (headers += `${key}: ${value}\n`));
      expect(text.includes(code) || headers.includes(code), `probe ${i} echoed the code`).toBe(false);
      expect(text.includes(viewer.token) || headers.includes(viewer.token), `probe ${i} echoed the token`).toBe(false);
      expect(JSON.parse(text)).toEqual({ error: "NOT_FOUND" });
    }
    // The relay log records paths without the query (§10, NFR-12).
    const log = stack.relay.log();
    expect(log.includes(code), "the code reached the relay log").toBe(false);
    expect(log.includes(viewer.token), "a viewer token reached the relay log").toBe(false);
    await expectStillServing(stack.wsUrl, stack.baseUrl, stack.code, bystander.client);
  });
});

/** What a session legitimately sends its viewers, and what of the other session must never reach them. */
interface SessionView {
  label: string;
  sessionId: string;
  /** Published snapshots by version. */
  snapshots: Map<number, LoadedGlb>;
  maxVersion: number;
  nodeIds: string[];
  viewers: number;
}

/**
 * Every frame `viewer` received belongs to `own` (T11): chunks carry one of its snapshot versions and exactly its
 * bytes, text frames name none of `other`'s session id, snapshot hashes or node ids, versions stay within `own`'s.
 */
function expectOnlyOwnFrames(viewer: Client, name: string, own: SessionView, other: SessionView): void {
  for (const [i, frame] of viewer.binary.entries()) {
    const decoded = decodeChunkHeader(frame);
    expect(decoded.ok, `${name}: binary frame ${i} is no chunk`).toBe(true);
    if (!decoded.ok) continue;
    const { sceneVersion, chunkIndex, payload } = decoded.value;
    const glb = own.snapshots.get(sceneVersion);
    expect(glb !== undefined, `${name}: chunk of version ${sceneVersion}, not a ${own.label} snapshot`).toBe(true);
    const start = chunkIndex * 65_536;
    const expected = glb!.bytes.subarray(start, start + payload.byteLength);
    expect(Buffer.compare(Buffer.from(payload), Buffer.from(expected)) === 0, `${name}: chunk ${i} bytes`).toBe(true);
  }
  const foreign = [
    other.sessionId,
    ...[...other.snapshots.values()].map((g) => g.sha256),
    ...other.nodeIds.filter((id) => !own.nodeIds.includes(id)).map((id) => JSON.stringify(id)),
  ];
  for (const [i, message] of viewer.messages.entries()) {
    const text = JSON.stringify(message);
    const leaked = foreign.some((f) => text.includes(f));
    expect(leaked, `${name}: message ${i} (${message.type}) names ${other.label}`).toBe(false);
    const version = message["sceneVersion"];
    if (typeof version === "number")
      expect(version, `${name}: ${message.type} version`).toBeLessThanOrEqual(own.maxVersion);
    if (message.type === "viewer.count")
      expect(message["viewerCount"] as number, `${name}: viewer.count`).toBeLessThanOrEqual(own.viewers);
  }
}

/** Waits until a live viewer has the whole snapshot `version` (streamed, or deferred to HTTP under load). */
const snapshotDone = (viewer: Client, version: number) =>
  viewer.next(
    (m) => (m.type === "scene.snapshot.end" || m.type === "scene.snapshot.ready") && m["sceneVersion"] === version,
    30_000,
  );

test.describe("QA-14 two sessions side by side (T11)", () => {
  test.use({ stackOptions: { publisher: false } });

  test("no frame of session A reaches a viewer of B (and back); A's tokens never serve B", async ({ stack }) => {
    test.setTimeout(120_000);
    const { wsUrl, baseUrl } = stack;
    const pubA = await rawPublisher(wsUrl);
    const pubB = await rawPublisher(wsUrl);
    expect(pubA.code !== pubB.code && pubA.sessionId !== pubB.sessionId, "two sessions got one identity").toBe(true);

    // Live viewers join before anything is published, so they receive the streamed chunks.
    const a1 = await viewerByCode(wsUrl, pubA.code);
    const a2 = await viewerByCode(wsUrl, pubA.code);
    const b1 = await viewerByCode(wsUrl, pubB.code);
    expect(a1.sessionId === pubA.sessionId && b1.sessionId === pubB.sessionId, "joined the wrong session").toBe(true);

    // A streams the 4.9 MB fixture in 76 chunks while B streams its own, interleaved on the relay.
    const [snapA1, snapB1] = await Promise.all([
      pubA.publish("large-synthetic.glb", 1),
      pubB.publish("quantized-1node.glb", 1),
    ]);
    await Promise.all([snapshotDone(a1.client, 1), snapshotDone(a2.client, 1), snapshotDone(b1.client, 1)]);

    pubA.update(2, [{ nodeId: "vtkMRMLModelNode10", opacity: 0.25 }]);
    pubB.update(2, [{ nodeId: "vtkMRMLModelNode3", color: [0.1, 0.2, 0.3] }]);
    const isUpdate2 = (m: Message) => m.type === "scene.update" && m["sceneVersion"] === 2;
    await Promise.all([a1.client.next(isUpdate2), a2.client.next(isUpdate2), b1.client.next(isUpdate2)]);

    // Late joiners see only their own session's snapshot.
    const a3 = await viewerByCode(wsUrl, pubA.code);
    const b2 = await viewerByCode(wsUrl, pubB.code);
    const metaOf = (v: JoinedViewer) => v.joined["snapshot"] as { sha256: string; sceneVersion: number };
    expect(metaOf(a3).sha256 === snapA1.glb.sha256 && a3.sessionId === pubA.sessionId, "A late joiner").toBe(true);
    expect(metaOf(b2).sha256 === snapB1.glb.sha256 && b2.sessionId === pubB.sessionId, "B late joiner").toBe(true);

    // Both cache version 1: each token gets its own session's bytes, never the other's.
    const aV1 = await fetchScene(baseUrl, 1, a3.token);
    const bV1 = await fetchScene(baseUrl, 1, b2.token);
    expect([aV1.status, bV1.status]).toEqual([200, 200]);
    expect(sha256(aV1.body) === snapA1.glb.sha256, "A's token got other bytes than A's scene").toBe(true);
    expect(sha256(bV1.body) === snapB1.glb.sha256, "B's token got other bytes than B's scene").toBe(true);

    // A moves on to version 3: B's version 1 is still cached, but A's token must not reach it.
    const snapA3 = await pubA.publish("aliased-segments.glb", 3);
    await Promise.all([snapshotDone(a1.client, 3), snapshotDone(a2.client, 3)]);
    for (const version of [1, 2]) {
      const response = await fetchScene(baseUrl, version, a3.token);
      expect(response.status, `A's token on version ${version}`).toBe(404);
      expect(sha256(response.body) === snapB1.glb.sha256, "A's token got B's bytes").toBe(false);
    }
    const aV3 = await fetchScene(baseUrl, 3, a1.token);
    expect(aV3.status).toBe(200);
    expect(sha256(aV3.body) === snapA3.glb.sha256, "A's version 3").toBe(true);
    const bV3 = await fetchScene(baseUrl, 3, b2.token);
    expect(bV3.status, "B's token on A's version").toBe(404);
    expect(sha256(bV3.body) === snapA3.glb.sha256, "B's token got A's bytes").toBe(false);
    expect((await fetchScene(baseUrl, 1, b2.token)).status).toBe(200);

    // Credentials of one session never open the other: a viewer token with the other session id...
    for (const [token, sessionId] of [
      [a1.token, pubB.sessionId],
      [b1.token, pubA.sessionId],
    ] as const) {
      const attempt = await rejoin(wsUrl, sessionId, token);
      expect(errorOf(attempt.reply)).toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expectPong(attempt.client);
      const content = attempt.client.messages.filter((m) => m.type !== "error" && m.type !== "pong");
      expect(attempt.client.binary.length + content.length, "a refused rejoin received session content").toBe(0);
      attempt.client.close();
    }
    // ...and A's publisher token cannot resume B.
    const hijack = await connect(wsUrl, { ip: nextIp() });
    hijack.send({
      type: "session.resume",
      id: "p-9",
      sessionId: pubB.sessionId,
      publisherToken: pubA.token,
      clientInfo: PUBLISHER_INFO,
      lastSceneVersion: 2,
    });
    expect(errorOf(await hijack.next("error"))).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await hijack.closedWithin(3_000)).code).toBe(4003);
    expect(pubB.client.closeInfo, "B's publisher was replaced").toBeUndefined();
    expect(pubA.client.closeInfo, "A's publisher was closed").toBeUndefined();

    // Barrier: every socket answers a ping, so anything misrouted earlier is already in its buffer.
    const viewersA = { a1: a1.client, a2: a2.client, a3: a3.client };
    const viewersB = { b1: b1.client, b2: b2.client };
    const everyone = [pubA.client, pubB.client, ...Object.values(viewersA), ...Object.values(viewersB)];
    await Promise.all(everyone.map((c) => expectPong(c)));

    const viewA: SessionView = {
      label: "A",
      sessionId: pubA.sessionId,
      snapshots: new Map([
        [1, snapA1.glb],
        [3, snapA3.glb],
      ]),
      maxVersion: 3,
      nodeIds: [...snapA1.glb.nodeIds, ...snapA3.glb.nodeIds],
      viewers: 3,
    };
    const viewB: SessionView = {
      label: "B",
      sessionId: pubB.sessionId,
      snapshots: new Map([[1, snapB1.glb]]),
      maxVersion: 2,
      nodeIds: snapB1.glb.nodeIds,
      viewers: 2,
    };
    for (const [name, client] of Object.entries(viewersA)) expectOnlyOwnFrames(client, name, viewA, viewB);
    for (const [name, client] of Object.entries(viewersB)) expectOnlyOwnFrames(client, name, viewB, viewA);

    // Positive control: the streamed viewers did get their own session's content (so the check above saw frames).
    // (The first chunks are always streamed: a viewer is deferred only above the 4 MiB soft watermark, §3.3.)
    expect(a1.client.binary.length).toBeGreaterThan(0);
    expect(b1.client.binary.length).toBeGreaterThan(0);
    const updated = (c: Client, nodeId: string) =>
      c.messages.some((m) => m.type === "scene.update" && JSON.stringify(m).includes(JSON.stringify(nodeId)));
    expect(updated(b1.client, "vtkMRMLModelNode3")).toBe(true);
    expect(updated(a1.client, "vtkMRMLModelNode10")).toBe(true);
    // Each session counts only its own viewers.
    const lastCount = (c: Client) => c.messages.filter((m) => m.type === "viewer.count").at(-1)?.["viewerCount"];
    expect([lastCount(a1.client), lastCount(b1.client)]).toEqual([3, 2]);

    // B ends its session (§4.5): only B's viewers are closed; B's tokens are dead (410, §10) while A's keep
    // working and A's viewers never hear of it.
    pubB.client.send({ type: "session.close", id: "p-77", reason: "USER_STOPPED" });
    for (const [name, client] of Object.entries(viewersB)) {
      const closed = await client.next((m) => m.type === "session.closed" || m.type === "session.expired");
      expect(closed.type, `${name}: end of B`).toBe("session.closed");
      expect(closed["reason"]).toBe("PUBLISHER_CLOSED");
      expect((await client.closedWithin()).code, `${name}: close`).toBe(4001);
    }
    expect((await fetchScene(baseUrl, 1, b2.token)).status, "B's token after B closed").toBe(410);
    const afterClose = await rejoin(wsUrl, pubB.sessionId, b1.token);
    expect(errorOf(afterClose.reply)).toMatchObject({ code: "SESSION_NOT_FOUND" });
    afterClose.client.close();

    await Promise.all([pubA.client, ...Object.values(viewersA)].map((c) => expectPong(c)));
    for (const [name, client] of Object.entries(viewersA)) {
      expect(client.closeInfo, `${name} was closed with B`).toBeUndefined();
      const heard = client.messages.some((m) => m.type.startsWith("session."));
      expect(heard, `${name} received a session.* message of B's end`).toBe(false);
    }
    const aStill = await fetchScene(baseUrl, 3, a2.token);
    expect(aStill.status).toBe(200);
    expect(sha256(aStill.body) === snapA3.glb.sha256, "A's version 3 after B closed").toBe(true);
    const a4 = await viewerByCode(wsUrl, pubA.code);
    expect(a4.sessionId === pubA.sessionId && metaOf(a4).sha256 === snapA3.glb.sha256, "A joinable").toBe(true);
    a4.client.close();
    expect((await healthz(baseUrl)).sessions).toBe(1);
  });
});
