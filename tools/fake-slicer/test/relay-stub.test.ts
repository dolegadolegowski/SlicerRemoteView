import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { CODE_PATTERN, validateMessage } from "@slicerremoteview/shared";
import { startRelayStub } from "../src/index.js";
import type { RelayStub } from "../src/index.js";

let stub: RelayStub | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await stub?.close();
  stub = undefined;
});

/** Opens a socket and collects every frame; `next()` resolves with the next one. */
async function connect(url: string) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const inbox: { data: RawData; isBinary: boolean }[] = [];
  const waiting: (() => void)[] = [];
  socket.on("message", (data, isBinary) => {
    inbox.push({ data, isBinary });
    waiting.shift()?.();
  });
  await once(socket, "open");
  return {
    socket,
    async next() {
      if (inbox.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
      return inbox.shift()!;
    },
    async nextJson() {
      return JSON.parse((await this.next()).data.toString()) as Record<string, unknown>;
    },
  };
}

const create = (extra: object = {}) =>
  JSON.stringify({
    protocolVersion: "1.0",
    type: "session.create",
    id: "p-1",
    clientInfo: { app: "test", version: "0", platform: "test" },
    preferredCode: null,
    profile: "mobile",
    ...extra,
  });
const join = (code: string) =>
  JSON.stringify({
    protocolVersion: "1.0",
    type: "viewer.join",
    id: "v-1",
    code,
    clientInfo: { app: "test", version: "0", platform: "web" },
  });

describe("in-process relay stub (PRO-13)", () => {
  it("listens on a random port and answers session.create with a schema-valid session.created", async () => {
    stub = await startRelayStub();
    expect(stub.port).toBeGreaterThan(0);
    const publisher = await connect(stub.url);
    publisher.socket.send(create());
    const created = await publisher.nextJson();
    expect(validateMessage(created)).toMatchObject({ ok: true });
    expect(created).toMatchObject({ type: "session.created", replyTo: "p-1" });
    expect(String(created["code"])).toMatch(CODE_PATTERN);
    expect(stub.code).toBe(created["code"]);
  });

  it("grants a well-formed preferredCode and generates fresh codes otherwise", async () => {
    stub = await startRelayStub();
    const publisher = await connect(stub.url);
    publisher.socket.send(create({ preferredCode: "7KQ4X" }));
    expect((await publisher.nextJson())["code"]).toBe("7KQ4X");
  });

  it("forwards publisher text and binary frames to viewers byte-for-byte", async () => {
    stub = await startRelayStub();
    const publisher = await connect(stub.url);
    publisher.socket.send(create());
    const { code } = (await publisher.nextJson()) as { code: string };

    const viewer = await connect(stub.url);
    viewer.socket.send(join(code.toLowerCase())); // typed input is normalised
    const joined = await viewer.nextJson();
    expect(validateMessage(joined)).toMatchObject({ ok: true });
    expect(joined).toMatchObject({ type: "viewer.joined", replyTo: "v-1", viewerCount: 1 });
    expect(await viewer.nextJson()).toMatchObject({ type: "viewer.count", viewerCount: 1 });
    expect(await publisher.nextJson()).toMatchObject({ type: "viewer.count", viewerCount: 1 });

    // Deliberately odd spacing and key order: forwarding must not re-serialise.
    const text =
      '{ "type" :"scene.update",  "protocolVersion":"1.0",\n"sceneVersion":1,"baseVersion":0,"changes":[] }';
    const binary = Buffer.from([0x53, 0x52, 0x56, 0x43, 0, 255, 128, 1, 2, 3]);
    publisher.socket.send(text);
    publisher.socket.send(binary);
    const textFrame = await viewer.next();
    const binaryFrame = await viewer.next();
    expect(textFrame.isBinary).toBe(false);
    expect(textFrame.data.toString()).toBe(text);
    expect(binaryFrame.isBinary).toBe(true);
    expect(Buffer.compare(binaryFrame.data as Buffer, binary)).toBe(0);
    expect(stub.publisherFrames.map((f) => f.binary)).toEqual([false, true]);
  });

  it("refuses an unknown code, a second publisher and a malformed first message", async () => {
    stub = await startRelayStub();
    const publisher = await connect(stub.url);
    publisher.socket.send(create());
    await publisher.nextJson();

    const stranger = await connect(stub.url);
    stranger.socket.send(join("ZZZZZ"));
    expect(await stranger.nextJson()).toMatchObject({ type: "error", code: "INVALID_CODE" });
    expect((await once(stranger.socket, "close"))[0]).toBe(4004);

    const second = await connect(stub.url);
    second.socket.send(create());
    expect(await second.nextJson()).toMatchObject({ type: "error", code: "CAPACITY" });

    const garbage = await connect(stub.url);
    garbage.socket.send("not json");
    expect(await garbage.nextJson()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    expect((await once(garbage.socket, "close"))[0]).toBe(4007);
  });

  it("closes viewers with 4001 when the publisher leaves", async () => {
    stub = await startRelayStub();
    const publisher = await connect(stub.url);
    publisher.socket.send(create());
    const { code } = (await publisher.nextJson()) as { code: string };
    const viewer = await connect(stub.url);
    viewer.socket.send(join(code));
    await viewer.nextJson();
    publisher.socket.close();
    expect((await once(viewer.socket, "close"))[0]).toBe(4001);
  });
});

describe("stub version checker (PRO-15)", () => {
  async function publisher() {
    stub = await startRelayStub();
    const p = await connect(stub.url);
    p.socket.send(create());
    await p.nextJson(); // session.created
    const send = (message: object) =>
      p.socket.send(JSON.stringify({ protocolVersion: "1.0", ...message }));
    return { p, send };
  }

  it("accepts a clean sequence and flags every §6.2 / §8.1 / §8.4 violation with BAD_SEQUENCE", async () => {
    const { p, send } = await publisher();
    const begin = (sceneVersion: number) =>
      send({ type: "scene.snapshot.begin", id: `b${sceneVersion}`, sceneVersion });
    begin(1);
    send({ type: "scene.snapshot.end", sceneVersion: 1 });
    expect((await p.nextJson())["type"]).toBe("scene.snapshot.ack");
    send({ type: "scene.update", sceneVersion: 2, baseVersion: 1, changes: [] });
    send({ type: "scene.update", id: "bad-base", sceneVersion: 4, baseVersion: 1, changes: [] });
    expect(await p.nextJson()).toMatchObject({
      type: "error",
      code: "BAD_SEQUENCE",
      replyTo: "bad-base",
    });
    send({ type: "scene.update", id: "bad-order", sceneVersion: 2, baseVersion: 2, changes: [] });
    expect((await p.nextJson())["code"]).toBe("BAD_SEQUENCE");
    begin(2);
    expect((await p.nextJson())["code"]).toBe("BAD_SEQUENCE");
    begin(3);
    send({ type: "scene.update", sceneVersion: 4, baseVersion: 3, changes: [] });
    expect((await p.nextJson())["code"]).toBe("BAD_SEQUENCE");
    expect(stub!.versionViolations).toEqual([
      "baseVersion 1 is not 2",
      "sceneVersion 2 is not above 2",
      "snapshot version 2 is not above 2",
      "scene.update inside a snapshot",
    ]);
  });
});
