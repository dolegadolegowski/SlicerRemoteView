import { afterEach, describe, expect, it } from "vitest";
import { validateMessage } from "@slicerremoteview/shared";
import { BIND_ON_HANDSHAKE } from "./helpers/binding.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { TestClient, TestRelay } from "./helpers/ws-client.js";

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

/** A client bound by a stub handshake handler (`BIND_ON_HANDSHAKE`) after a valid first message. */
async function handshaken(first: "session.create" | "viewer.join"): Promise<TestClient> {
  relay ??= await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture(first)));
  expect(await client.next()).toMatchObject({ type: "pong", replyTo: expect.any(String) });
  return client;
}

/** A client whose first message fixed the publisher role but bound no session. */
async function unbound(): Promise<TestClient> {
  relay ??= await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
  const client = await connectClient(relay.url);
  client.sendRaw(JSON.stringify(fixture("session.create", "invalid-missing-profile")));
  expect(await client.next()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  return client;
}

async function expectPong(client: TestClient, id: string): Promise<void> {
  client.send({ type: "ping", id });
  expect(await client.next()).toMatchObject({ type: "pong", replyTo: id });
}

describe("protocol version (SRV-23 criterion 1, §2)", () => {
  it.each([
    ["first message", false],
    ["later message", true],
  ])("protocolVersion 2.0 on a %s → error UNSUPPORTED_VERSION then 4000", async (_name, later) => {
    relay = await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
    const client = later ? await handshaken("viewer.join") : await connectClient(relay.url);
    client.sendRaw(JSON.stringify({ protocolVersion: "2.0", type: "hello.v2", id: "v-9" }));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "UNSUPPORTED_VERSION",
      replyTo: "v-9",
      retryable: false,
      details: { protocolVersions: ["1.0"] },
    });
    expect(await client.closed).toBe(4000);
  });

  it("a minor version above 1.0 is accepted (§2, §14)", async () => {
    relay = await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
    const client = await handshaken("viewer.join");
    client.sendRaw(JSON.stringify({ protocolVersion: "1.7", type: "ping", id: "p-1" }));
    expect(await client.next()).toMatchObject({
      type: "pong",
      replyTo: "p-1",
      protocolVersion: "1.0",
    });
    client.ws.close();
  });
});

describe("INVALID_MESSAGE strikes (SRV-23 criterion 1, §9.2, §9.3)", () => {
  it("three invalid frames → error each time, then close 4007", async () => {
    const client = await handshaken("session.create");
    for (const frame of [
      "{not json",
      "[]",
      JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "x".repeat(33) }),
    ]) {
      client.sendRaw(frame);
      const error = await client.next();
      expect(error).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
      expect((error.details as { instancePath: string }).instancePath).toEqual(expect.any(String));
    }
    expect(await client.closed).toBe(4007);
  });

  it("two invalid frames then a valid one → still open", async () => {
    const client = await handshaken("session.create");
    client.sendRaw("{not json");
    client.sendRaw(JSON.stringify(fixture("ping", "invalid-missing-protocolVersion")));
    expect((await client.next()).code).toBe("INVALID_MESSAGE");
    expect((await client.next()).code).toBe("INVALID_MESSAGE");
    await expectPong(client, "p-3");
    expect(client.ws.readyState).toBe(1);
    client.ws.close();
  });

  it("names the failing field in details.instancePath and echoes a valid id", async () => {
    const client = await handshaken("session.create");
    client.send({
      type: "scene.update",
      id: "p-41",
      sceneVersion: 2,
      baseVersion: 1,
      changes: [{ nodeId: "n1", visible: "no" }],
    });
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "INVALID_MESSAGE",
      replyTo: "p-41",
      details: { instancePath: "/changes/0/visible" },
    });
    client.ws.close();
  });

  it("parses each frame once, also a large invalid first frame (branch audit, T3)", async () => {
    relay = await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
    const client = await connectClient(relay.url);
    // Within the publisher limit, invalid (no profile): before, the endpoint, parseEnvelope and the
    // dispatcher's peek each parsed it.
    const text = JSON.stringify({
      ...fixture("session.create", "invalid-missing-profile"),
      pad: Array.from({ length: 20_000 }, () => [0]),
    });
    expect(text.length).toBeGreaterThan(16_384);
    const parse = JSON.parse;
    let calls = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === text) calls += 1;
      return parse(...args);
    }) as typeof JSON.parse;
    try {
      for (const strike of [1, 2]) {
        client.sendRaw(text);
        expect(await client.next()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
        expect(calls).toBe(strike);
      }
    } finally {
      JSON.parse = parse;
    }
    client.ws.close();
  });

  it("a schema-invalid handshake message still fixes the role", async () => {
    relay = await startRelay({ messageHandlers: BIND_ON_HANDSHAKE });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("viewer.join", "invalid-neither-code-nor-token")));
    expect(await client.next()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    client.sendRaw(Buffer.alloc(16), true);
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008); // a viewer's binary frame
  });
});

describe("permissions matrix (SRV-23 criterion 2, §11)", () => {
  it("viewer sending scene.update → error UNAUTHORIZED; a second disallowed type → 1008", async () => {
    const client = await handshaken("viewer.join");
    client.sendRaw(JSON.stringify(fixture("scene.update")));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "UNAUTHORIZED",
      retryable: false,
    });
    expect(client.ws.readyState).toBe(1);
    client.sendRaw(JSON.stringify(fixture("session.create")));
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008);
  });

  it.each([
    ["session.create", "viewer.join"],
    ["session.create", "scene.request"],
    ["session.create", "pong"],
    ["session.create", "viewer.joined"],
    ["viewer.join", "error"],
    ["viewer.join", "session.renew"],
    ["viewer.join", "scene.snapshot.begin"],
  ])("after %s, a valid %s is UNAUTHORIZED", async (first, type) => {
    const client = await handshaken(first as "session.create" | "viewer.join");
    client.sendRaw(JSON.stringify({ ...fixture(type), id: "x-1" }));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "UNAUTHORIZED",
      replyTo: "x-1",
    });
    client.ws.close();
  });

  it("a message allowed for the role but sent before the session handshake completed is UNAUTHORIZED", async () => {
    const client = await unbound();
    client.sendRaw(JSON.stringify(fixture("scene.update")));
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    client.ws.close();
  });

  it("an unknown type before the session handshake completed is an UNAUTHORIZED offence", async () => {
    const client = await unbound();
    client.send({ type: "hello.world", id: "u-1" });
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "UNAUTHORIZED",
      replyTo: "u-1",
    });
    client.send({ type: "hello.world" });
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008);
  });

  it.each(["session.create", "viewer.join"] as const)(
    "once bound by %s, a second handshake message is UNAUTHORIZED; the next offence closes 1008",
    async (first) => {
      const client = await handshaken(first);
      client.sendRaw(JSON.stringify(fixture(first)));
      expect(await client.next()).toMatchObject({
        type: "error",
        code: "UNAUTHORIZED",
        replyTo: expect.any(String),
      });
      expect(client.ws.readyState).toBe(1);
      client.sendRaw(JSON.stringify(fixture(first)));
      expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
      expect(await client.closed).toBe(1008);
    },
  );

  it("a known type outside the role is UNAUTHORIZED even when it fails its schema, without echoing its keys", async () => {
    const client = await handshaken("viewer.join");
    const key = `SECRET-7KQ4X-${"k".repeat(200)}`;
    client.send({
      type: "viewer.count",
      id: "c-1",
      viewerCount: 1,
      viewerLimit: 20,
      platforms: { [key]: -1 },
    });
    const error = await client.next();
    expect(error).toMatchObject({ type: "error", code: "UNAUTHORIZED", replyTo: "c-1" });
    expect(JSON.stringify(error)).not.toContain("SECRET");
    client.ws.close();
  });
});

describe("dispatch table (SRV-23, used by SRV-06 onwards)", () => {
  it("a bound socket's allowed message reaches its handler", async () => {
    const seen: string[] = [];
    relay = await startRelay({
      messageHandlers: {
        ...BIND_ON_HANDSHAKE,
        "scene.request": (_connection, message) => {
          seen.push(message.reason);
        },
      },
    });
    const client = await handshaken("viewer.join");
    client.sendRaw(JSON.stringify(fixture("scene.request")));
    await expect.poll(() => seen).toEqual([fixture("scene.request").reason]);
    client.ws.close();
  });

  it("an allowed type without a handler yet answers UNSUPPORTED_TYPE and stays open", async () => {
    const client = await handshaken("viewer.join");
    client.sendRaw(JSON.stringify({ ...fixture("scene.request"), id: "r-1" }));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "UNSUPPORTED_TYPE",
      replyTo: "r-1",
    });
    await expectPong(client, "p-9");
    client.ws.close();
  });
});

describe("unknown types and fields (SRV-23 criterion 3, §2, §14)", () => {
  it("an unknown type → error UNSUPPORTED_TYPE, the socket stays open", async () => {
    const client = await handshaken("viewer.join");
    for (const type of ["scene.camera", "viewer.command", "hello.world"]) {
      client.send({ type, id: "u-1" });
      expect(await client.next()).toMatchObject({
        type: "error",
        code: "UNSUPPORTED_TYPE",
        replyTo: "u-1",
      });
    }
    await expectPong(client, "p-2");
    client.ws.close();
  });

  it("a valid message with an extra top-level field is accepted", async () => {
    const client = await handshaken("viewer.join");
    client.send({ type: "ping", id: "p-7", futureField: { nested: true } });
    expect(await client.next()).toMatchObject({ type: "pong", replyTo: "p-7" });
    client.ws.close();
  });
});

describe("ping (§9.1)", () => {
  it.each(["session.create", "viewer.join"] as const)(
    "after %s: ping → pong with replyTo and serverTs",
    async (first) => {
      const client = await handshaken(first);
      client.send({ type: "ping", id: "hb-1" });
      const pong = await client.next();
      expect(pong).toEqual({
        protocolVersion: "1.0",
        type: "pong",
        replyTo: "hb-1",
        serverTs: relay!.clock.now(),
        ts: relay!.clock.now(),
      });
      expect(validateMessage(pong)).toMatchObject({ ok: true });
      client.ws.close();
    },
  );
});

describe("every relay message matches the protocol schema", () => {
  it("errors sent by the dispatcher validate", async () => {
    const client = await handshaken("viewer.join");
    client.sendRaw("{not json");
    client.sendRaw(JSON.stringify(fixture("scene.update")));
    client.send({ type: "hello.world" });
    for (let i = 0; i < 3; i++)
      expect(validateMessage(await client.next())).toMatchObject({ ok: true });
    client.ws.close();
  });
});
