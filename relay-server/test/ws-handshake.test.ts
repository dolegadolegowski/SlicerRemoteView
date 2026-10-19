import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import type { FrameHandlers } from "../src/ws/endpoint.js";
import { BIND_ON_HANDSHAKE } from "./helpers/binding.js";
import { fixture } from "./helpers/fixtures.js";
import { connectClient, startRelay } from "./helpers/ws-client.js";
import type { TestClient, TestRelay } from "./helpers/ws-client.js";

const ALLOWED = "https://relay.example.org";

/** Records what the endpoint hands on (instead of dispatching it), so tests see a frame passed. */
function recordingHandlers() {
  const texts: string[] = [];
  const binaries: number[] = [];
  const handlers: FrameHandlers = {
    text: (_connection, frame) => {
      texts.push(frame.text);
    },
    binary: (_connection, frame) => {
      binaries.push(frame.byteLength);
    },
    closed: () => {},
  };
  return { handlers, texts, binaries };
}

/** A JSON text frame of exactly `bytes` bytes (valid `ping` when `type` is "ping"). */
function frameOf(type: string, bytes: number): string {
  const head = JSON.stringify({ protocolVersion: "1.0", type, id: "big", pad: "" });
  return head.replace('"pad":""', `"pad":"${"x".repeat(bytes - head.length)}"`);
}

/** Sends a valid first message of `type` (the dispatcher fixes the role) and drains its answer. */
async function handshake(
  client: TestClient,
  type: "session.create" | "viewer.join",
): Promise<void> {
  client.sendRaw(JSON.stringify(fixture(type)));
  await client.next();
}

let relay: TestRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("upgrade and Origin (SRV-05 criterion 1, §3.1, FR-33)", () => {
  it("refuses a foreign Origin with HTTP 403 before the upgrade", async () => {
    relay = await startRelay();
    for (const origin of [
      "https://evil.example",
      "null",
      `${ALLOWED}.evil.example`,
      "http://relay.example.org",
    ])
      await expect(connectClient(relay.url, { origin })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("accepts the allowed Origin and clients without Origin", async () => {
    relay = await startRelay();
    const browser = await connectClient(relay.url, { origin: ALLOWED });
    const slicer = await connectClient(relay.url);
    expect([browser.ws.readyState, slicer.ws.readyState]).toEqual([1, 1]);
    browser.ws.close();
    slicer.ws.close();
  });

  it("disables permessage-deflate", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    expect(client.ws.extensions).toBe("");
    client.ws.close();
  });
});

describe("handshake timeout (SRV-05 criterion 1, §3.1)", () => {
  it("closes 4012 when no first message arrives within 10 s", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    const pending = relay.clock.pending; // the sweep and this socket's handshake timer
    relay.clock.advance(9_999);
    expect(relay.clock.pending).toBe(pending);
    expect(client.ws.readyState).toBe(1);
    relay.clock.advance(1);
    expect(await client.closed).toBe(4012);
    expect(client.received).toEqual([]);
  });

  it("still closes 4012 when the socket never gets bound to a session", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create", "invalid-missing-profile")));
    expect(await client.next()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    relay.clock.advance(10_000);
    expect(await client.closed).toBe(4012);
  });
});

describe("role fixed by the first message (SRV-05 criterion 1, §3.1)", () => {
  it.each([
    ["ping", JSON.stringify({ protocolVersion: "1.0", type: "ping" })],
    ["scene.update", JSON.stringify({ protocolVersion: "1.0", type: "scene.update" })],
    ["no type", JSON.stringify({ protocolVersion: "1.0" })],
    ["not JSON", "hello"],
    ["a JSON array", "[]"],
    ["an inherited property name", JSON.stringify({ protocolVersion: "1.0", type: "constructor" })],
    ["__proto__", '{"protocolVersion":"1.0","type":"__proto__"}'],
  ])("first message %s → error UNAUTHORIZED + 1008", async (_name, frame) => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    client.sendRaw(frame);
    expect(await client.next()).toMatchObject({
      protocolVersion: "1.0",
      type: "error",
      code: "UNAUTHORIZED",
      ts: relay.clock.now(),
    });
    expect(await client.closed).toBe(1008);
  });

  it.each(["session.create", "session.resume", "viewer.join"])(
    "first message %s is accepted and keeps the socket open",
    async (type) => {
      relay = await startRelay();
      const client = await connectClient(relay.url);
      client.sendRaw(JSON.stringify(fixture(type)));
      await client.next();
      client.send({ type: "ping", id: "hb-1" });
      expect(await client.next()).toMatchObject({ type: "pong", replyTo: "hb-1" });
      client.ws.close();
    },
  );
});

describe("binary frames (SRV-05 criterion 2, §3.2, §3.3)", () => {
  it("a binary first message → error UNAUTHORIZED + 1008", async () => {
    relay = await startRelay();
    const client = await connectClient(relay.url);
    client.sendRaw(Buffer.from("SRVC"), true);
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008);
  });

  it("a viewer's binary frame → error UNAUTHORIZED + 1008", async () => {
    const { handlers, binaries } = recordingHandlers();
    relay = await startRelay({ wsHandlers: { binary: handlers.binary } });
    const client = await connectClient(relay.url, { origin: ALLOWED });
    await handshake(client, "viewer.join");
    client.sendRaw(Buffer.alloc(64), true);
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008);
    expect(binaries).toEqual([]);
  });

  it("a publisher without a session (handshake not complete) → error UNAUTHORIZED + 1008", async () => {
    const { handlers, binaries } = recordingHandlers();
    relay = await startRelay({ wsHandlers: { binary: handlers.binary } });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("session.create", "invalid-missing-profile")));
    expect(await client.next()).toMatchObject({ code: "INVALID_MESSAGE" });
    client.sendRaw(Buffer.alloc(64), true);
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await client.closed).toBe(1008);
    expect(binaries).toEqual([]);
  });

  it("a publisher's binary frame up to maxPayload is handed on", async () => {
    const { handlers, binaries } = recordingHandlers();
    relay = await startRelay({
      messageHandlers: BIND_ON_HANDSHAKE,
      wsHandlers: { binary: handlers.binary },
    });
    const client = await connectClient(relay.url);
    await handshake(client, "session.create");
    client.sendRaw(Buffer.alloc(1_114_112), true);
    await expect.poll(() => binaries).toEqual([1_114_112]);
    client.ws.close();
  });

  it("a publisher's binary frame of 1,114,113 B → 1009 before the payload is read", async () => {
    const { handlers, binaries } = recordingHandlers();
    relay = await startRelay({
      messageHandlers: BIND_ON_HANDSHAKE,
      wsHandlers: { binary: handlers.binary },
    });
    const client = await connectClient(relay.url);
    await handshake(client, "session.create");
    client.sendRaw(Buffer.alloc(1_114_113), true);
    expect(await client.closed).toBe(1009);
    expect(binaries).toEqual([]);
  });
});

describe("text limits per role (SRV-05 criterion 3, §3.3)", () => {
  it.each([
    ["viewer.join", 16_384, 16_385],
    ["session.create", 262_144, 262_145],
  ] as const)(
    "after %s: %i B accepted, %i B → PAYLOAD_TOO_LARGE + 1009",
    async (first, ok, tooBig) => {
      relay = await startRelay();
      const client = await connectClient(relay.url);
      await handshake(client, first);
      client.sendRaw(frameOf("ping", ok));
      expect(await client.next()).toMatchObject({ type: "pong", replyTo: "big" });
      client.sendRaw(frameOf("ping", tooBig));
      expect(await client.next()).toMatchObject({
        type: "error",
        code: "PAYLOAD_TOO_LARGE",
        retryable: false,
        details: { maxTextBytes: ok },
      });
      expect(await client.closed).toBe(1009);
    },
  );

  it.each([
    ["session.create", 262_144, 262_145],
    ["session.resume", 262_144, 262_145],
    ["viewer.join", 16_384, 16_385],
    ["ping", 16_384, 16_385],
  ])("a first %s gets its role's limit: %i B handed on, %i B → 1009", async (type, ok, tooBig) => {
    const { handlers, texts } = recordingHandlers();
    relay = await startRelay({ wsHandlers: handlers });
    const accepted = await connectClient(relay.url);
    accepted.sendRaw(frameOf(type, ok));
    await expect.poll(() => texts.length).toBe(1);
    accepted.ws.close();
    const refused = await connectClient(relay.url);
    refused.sendRaw(frameOf(type, tooBig));
    const error = await refused.next();
    expect(error).toMatchObject({
      type: "error",
      code: "PAYLOAD_TOO_LARGE",
      details: { maxTextBytes: ok },
    });
    // Above the publisher limit nothing is parsed; below it the frame's id is echoed (§3.2).
    expect(error.replyTo).toBe(ok === 262_144 ? undefined : "big");
    expect(await refused.closed).toBe(1009);
  });
});

describe("handler failures (architecture §5)", () => {
  it.each([
    ["text", "a rejected promise of the text hook"],
    ["closed", "a rejected promise of the close hook"],
  ] as const)("%s: %s neither crashes the relay nor leaks", async (hook, _what) => {
    const lines: string[] = [];
    relay = await startRelay({
      logger: createLogger({ level: "error", destination: { write: (s) => lines.push(s) } }),
      wsHandlers: {
        ...recordingHandlers().handlers,
        [hook]: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("async boom 7KQ4X");
        },
      },
    });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify(fixture("viewer.join")));
    if (hook === "text") {
      expect(await client.next()).toMatchObject({
        type: "error",
        code: "INTERNAL",
        replyTo: fixture("viewer.join").id,
        retryable: true,
      });
      expect(await client.closed).toBe(1011);
    } else {
      client.ws.close();
      await client.closed;
    }
    await expect.poll(() => lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", errorCode: "INTERNAL" });
    expect(lines[0]).not.toContain("7KQ4X");
    const other = await connectClient(relay.url);
    expect(other.ws.readyState).toBe(1);
    other.ws.close();
  });

  it("an exception in a frame handler → error INTERNAL + 1011, the relay keeps serving", async () => {
    relay = await startRelay({
      wsHandlers: {
        text: () => {
          throw new Error("boom");
        },
      },
    });
    const client = await connectClient(relay.url);
    client.sendRaw(JSON.stringify({ ...fixture("viewer.join"), id: "j-77" }));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "INTERNAL",
      replyTo: "j-77",
      retryable: true,
    });
    expect(await client.closed).toBe(1011);
    const other = await connectClient(relay.url);
    expect(other.ws.readyState).toBe(1);
    other.ws.close();
  });
});

describe("upgrade requests to other paths (T6)", () => {
  it("a plain HTTP GET /ws is an unknown path", async () => {
    relay = await startRelay();
    const res = await relay.app.inject("/ws");
    expect([res.statusCode, res.json()]).toEqual([404, { error: "NOT_FOUND" }]);
  });

  it("never logs the URL of an upgrade elsewhere, query string included", async () => {
    const lines: string[] = [];
    relay = await startRelay({
      logger: createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
    });
    for (const path of ["/healthz?code=7KQ4X", "/7KQ4X", "/j?code=7KQ4X"])
      await expect(connectClient(relay.url.replace("/ws", path))).rejects.toMatchObject({
        statusCode: 404,
      });
    expect(lines.join("")).not.toContain("7KQ4X");
  });

  it.each(["/healthz", "/api/version", "/nope"])(
    "an upgrade to %s is refused with 404 before the upgrade, without a log line",
    async (path) => {
      const lines: string[] = [];
      relay = await startRelay({
        logger: createLogger({ level: "trace", destination: { write: (s) => lines.push(s) } }),
      });
      await expect(
        connectClient(relay.url.replace("/ws", path), { origin: "https://evil.example" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(lines.join("")).not.toContain("websocket");
    },
  );
});
