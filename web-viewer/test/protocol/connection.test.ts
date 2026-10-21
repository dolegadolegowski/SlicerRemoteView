import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateMessage } from "@slicerremoteview/shared";
import {
  createConnection,
  endsSession,
  isLocalHost,
  LATE_TIMER_MS,
  OPEN_TIMEOUT_MS,
  relayUrl,
} from "../../src/protocol/connection";
import type { Connection, ConnectionState, LogFn } from "../../src/protocol/connection";
import { describe as describeCode } from "../../src/state/errors";
import { MockSocket } from "./mock-socket";

const CODE = "7KQ4X";
const HTTPS = { protocol: "https:", host: "view.example.com", hostname: "view.example.com" };

let log: ReturnType<typeof vi.fn<LogFn>>;
let conn: Connection;
let states: ConnectionState[];

function make(options: Parameters<typeof createConnection>[0] = {}): Connection {
  conn = createConnection({
    location: HTTPS,
    createSocket: (url) => new MockSocket(url),
    log,
    lang: "en",
    ...options,
  });
  states = [];
  conn.on("state", (s) => states.push(s));
  return conn;
}

const joined = {
  type: "viewer.joined",
  replyTo: "v-1",
  sessionId: "sess_01K7Q4XMB2TJ9RD6",
  viewerId: "vw_4f2a",
  viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  sceneVersion: 42,
  snapshotVersion: 40,
  snapshotAvailable: true,
  publisherOnline: true,
  viewerCount: 4,
  viewerLimit: 20,
  profile: "mobile",
};

beforeEach(() => {
  MockSocket.reset();
  log = vi.fn<LogFn>();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("URL and transport rules (T5)", () => {
  it("derives wss://<host>/ws from an https page and ws:// only on loopback", () => {
    expect(relayUrl(HTTPS)).toBe("wss://view.example.com/ws");
    expect(relayUrl({ protocol: "http:", host: "localhost:5173", hostname: "localhost" })).toBe(
      "ws://localhost:5173/ws",
    );
    expect(relayUrl({ protocol: "http:", host: "[::1]:8787", hostname: "[::1]" })).toBe(
      "ws://[::1]:8787/ws",
    );
    expect(relayUrl({ protocol: "http:", host: "192.168.1.5:8787", hostname: "192.168.1.5" })).toBe(
      null,
    );
    expect(isLocalHost("app.localhost")).toBe(true);
    expect(isLocalHost("localhost.evil.com")).toBe(false);
  });

  it("refuses ws:// outside localhost and never opens a socket", () => {
    make({ location: { protocol: "http:", host: "example.com", hostname: "example.com" } });
    conn.connect({ code: CODE });
    expect(MockSocket.instances).toHaveLength(0);
    expect(conn.state.kind).toBe("stopped");
    make({ url: "ws://example.com/ws" });
    conn.connect({ code: CODE });
    expect(MockSocket.instances).toHaveLength(0);
    expect(conn.state.kind).toBe("stopped");
  });

  it("uses wss for an https page and puts neither code nor token in the URL", () => {
    make();
    conn.connect({ code: CODE });
    expect(MockSocket.last.url).toBe("wss://view.example.com/ws");
    expect(MockSocket.last.url).not.toContain(CODE);
  });
});

describe("join (§5.1)", () => {
  it("sends viewer.join as the first frame and it matches the PRO-04 schema", () => {
    make({ maxSnapshotBytes: 1000 });
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    expect(s.binaryType).toBe("arraybuffer");
    expect(s.sent).toHaveLength(0);
    expect(conn.state.kind).toBe("connecting");
    s.open();
    expect(s.frames).toHaveLength(1);
    const join = s.frames[0]!;
    expect(join).toMatchObject({
      protocolVersion: "1.0",
      type: "viewer.join",
      id: "v-1",
      code: CODE,
      clientInfo: {
        app: "web-viewer",
        platform: "web",
        profile: "mobile",
        capabilities: { httpScene: true, maxSnapshotBytes: 1000 },
      },
    });
    const result = validateMessage(join);
    expect(result.ok, JSON.stringify(!result.ok && result.error)).toBe(true);
  });

  it("rejoins with sessionId + viewerToken and no code", () => {
    make();
    conn.connect({ sessionId: joined.sessionId, viewerToken: joined.viewerToken });
    MockSocket.last.open();
    const join = MockSocket.last.frames[0]!;
    expect(join["code"]).toBeUndefined();
    expect(validateMessage(join).ok).toBe(true);
  });

  it("becomes connected on viewer.joined and delivers it to typed handlers", () => {
    make();
    const handler = vi.fn();
    conn.onMessage("viewer.joined", handler);
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive(joined);
    expect(conn.state.kind).toBe("connected");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].viewerToken).toBe(joined.viewerToken);
  });

  it("never logs the code or the token", () => {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive({ ...joined, type: "bogus.type" });
    MockSocket.last.receiveRaw("not json");
    MockSocket.last.serverClose(4004);
    expect(log).toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(joined.viewerToken);
  });
});

describe("errors and close codes", () => {
  it("error INVALID_CODE + close 4004 → enterCode with the FR-44 message", () => {
    make();
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    s.receive({
      type: "error",
      replyTo: "v-1",
      code: "INVALID_CODE",
      message: "Unknown code",
      retryable: false,
    });
    expect(conn.state.kind).toBe("connecting");
    s.serverClose(4004);
    const state = conn.state;
    expect(state.kind).toBe("enterCode");
    if (state.kind !== "enterCode") return;
    // Close 4004 and the error INVALID_CODE describe the same thing: the same text (their `subject`s differ).
    expect({ ...state.description, subject: null }).toEqual({
      ...describeCode("INVALID_CODE", "en"),
      subject: null,
    });
    expect(state.description.action).toBe("enterCode");
    expect(state.description.body).not.toMatch(/INVALID_CODE|4004/);
  });

  it.each([
    [4000, "stopped", false],
    [1008, "stopped", false],
    [1009, "stopped", false],
    [4001, "sessionEnded", false],
    [4002, "sessionEnded", false],
    [4003, "enterCode", false],
    [4011, "enterCode", false],
    [4005, "disconnected", false],
    [4006, "disconnected", false],
    [4007, "disconnected", false],
    [4008, "disconnected", true],
    [4009, "disconnected", false],
    [4010, "disconnected", false],
    [4012, "disconnected", false],
    [1001, "disconnected", false],
    [1006, "disconnected", false],
    [1011, "disconnected", false],
  ] as const)("close %i → %s (immediate: %s)", (code, kind, immediate) => {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.serverClose(code);
    const state = conn.state;
    expect(state.kind).toBe(kind);
    if (state.kind === "idle" || state.kind === "connecting" || state.kind === "connected") return;
    expect(state.closeCode).toBe(code);
    expect(state.description.title).not.toMatch(/\d{4}|[A-Z]{3,}_[A-Z_]+/);
    if (state.kind === "disconnected") expect(state.immediate).toBe(immediate);
  });

  it("carries retryAfterS from the preceding error", () => {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive({
      type: "error",
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
      details: { retryAfterS: 30 },
    });
    MockSocket.last.serverClose(4006);
    expect(conn.state).toMatchObject({ kind: "disconnected", retryAfterS: 30, closeCode: 4006 });
  });

  it("a bare drop after a fatal error uses the error's meaning", () => {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive({ type: "error", code: "UNAUTHORIZED", message: "no" });
    MockSocket.last.serverClose(1006);
    expect(conn.state.kind).toBe("enterCode");
  });

  it("a failed socket construction becomes a retryable disconnect", () => {
    make({
      createSocket: () => {
        throw new Error("blocked");
      },
    });
    conn.connect({ code: CODE });
    expect(conn.state.kind).toBe("disconnected");
  });
});

describe("heartbeat (§9.1, NFR-21)", () => {
  function connected(): MockSocket {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive(joined);
    return MockSocket.last;
  }

  it("pings every 15 s and stays alive while pongs arrive", () => {
    const s = connected();
    const dead = vi.fn();
    conn.on("dead", dead);
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(15_000);
      const pings = s.frames.filter((f) => f["type"] === "ping");
      expect(pings).toHaveLength(i);
      s.receive({ type: "pong", replyTo: pings.at(-1)!["id"] });
      vi.advanceTimersByTime(1);
    }
    expect(dead).not.toHaveBeenCalled();
    expect(conn.state.kind).toBe("connected");
    expect(s.frames.filter((f) => f["type"] === "ping").every((f) => validateMessage(f).ok)).toBe(
      true,
    );
  });

  it("no pong within 10 s closes the socket and emits dead", () => {
    const s = connected();
    const dead = vi.fn();
    conn.on("dead", dead);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(9_999);
    expect(dead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dead).toHaveBeenCalledOnce();
    expect(s.closedWith?.code).toBe(1000);
    expect(conn.state).toMatchObject({ kind: "disconnected", dead: true, immediate: false });
    // A late close event from the dead socket must not change anything.
    s.onclose?.({ code: 1006 });
    expect(states.filter((x) => x.kind === "disconnected")).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(dead).toHaveBeenCalledOnce();
  });

  it("any inbound frame after a ping counts as liveness (pong queued behind a snapshot stream)", () => {
    const s = connected();
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(5_000);
    s.receiveRaw(new ArrayBuffer(16));
    vi.advanceTimersByTime(9_000);
    expect(conn.state.kind).toBe("connected");
  });

  it("stops pinging after the socket closed", () => {
    const s = connected();
    s.serverClose(4009);
    const before = s.sent.length;
    vi.advanceTimersByTime(120_000);
    expect(s.sent.length).toBe(before);
  });

  it("a pong timer that fires late (frozen page) asks again instead of declaring the link dead (WEB-14)", () => {
    let skew = 0; // how far the page's clock ran ahead of its timers
    make({ now: () => Date.now() + skew });
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    s.receive(joined);
    vi.advanceTimersByTime(15_000);
    skew = LATE_TIMER_MS + 1; // the timer runs long after its time (iOS background)
    vi.advanceTimersByTime(10_000);
    expect(conn.state.kind).toBe("connected");
    expect(s.frames.filter((f) => f["type"] === "ping")).toHaveLength(2);
    // The new ping gets a fresh timeout; on time and unanswered, it is dead.
    vi.advanceTimersByTime(9_999);
    expect(conn.state.kind).toBe("connected");
    vi.advanceTimersByTime(1);
    expect(conn.state).toMatchObject({ kind: "disconnected", dead: true });
  });

  it("a timer late by no more than LATE_TIMER_MS still declares the link dead", () => {
    let skew = 0;
    make({ now: () => Date.now() + skew });
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive(joined);
    vi.advanceTimersByTime(15_000);
    skew = LATE_TIMER_MS;
    vi.advanceTimersByTime(10_000);
    expect(conn.state).toMatchObject({ kind: "disconnected", dead: true });
  });

  it("checkAlive pings at once and expects a pong within the timeout; only while connected", () => {
    const s = connected();
    vi.advanceTimersByTime(5_000);
    conn.checkAlive();
    const pings = s.frames.filter((f) => f["type"] === "ping");
    expect(pings).toHaveLength(1);
    expect(validateMessage(pings[0]!).ok).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(conn.state.kind).toBe("connected");
    vi.advanceTimersByTime(1);
    expect(conn.state).toMatchObject({ kind: "disconnected", dead: true });
    const before = s.sent.length;
    conn.checkAlive();
    expect(s.sent.length).toBe(before);
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open(); // joining, not yet joined
    conn.checkAlive();
    expect(MockSocket.last.frames.filter((f) => f["type"] === "ping")).toHaveLength(0);
  });

  it("checkAlive keeps the deadline of a ping that is already unanswered", () => {
    const s = connected();
    vi.advanceTimersByTime(15_000); // the interval ping, due at 25 s
    vi.advanceTimersByTime(7_000);
    conn.checkAlive(); // back in view at 22 s
    expect(s.frames.filter((f) => f["type"] === "ping")).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(conn.state).toMatchObject({ kind: "disconnected", dead: true });
  });

  it("checkAlive answered in time keeps the connection", () => {
    const s = connected();
    conn.checkAlive();
    s.receive({ type: "pong", replyTo: s.frames.at(-1)!["id"] });
    vi.advanceTimersByTime(14_999);
    expect(conn.state.kind).toBe("connected");
  });
});

describe("opening (WEB-14)", () => {
  it("a socket that has not opened within OPEN_TIMEOUT_MS is given up as a drop", () => {
    make();
    conn.connect({ code: CODE });
    const s = MockSocket.last; // never opens (black-holed route)
    vi.advanceTimersByTime(OPEN_TIMEOUT_MS - 1);
    expect(conn.state.kind).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(conn.state).toMatchObject({ kind: "disconnected", closeCode: 1006, dead: false });
    expect(s.closedWith?.code).toBe(1000);
    s.onclose?.({ code: 1006 }); // a late close event changes nothing
    expect(states.filter((x) => x.kind === "disconnected")).toHaveLength(1);
  });

  it("a socket that opened in time is not timed out (the heartbeat watches it from then on)", () => {
    make();
    conn.connect({ code: CODE });
    vi.advanceTimersByTime(OPEN_TIMEOUT_MS - 1);
    MockSocket.last.open();
    vi.advanceTimersByTime(5_000);
    expect(conn.state.kind).toBe("connecting");
  });
});

describe("session.closed / session.expired (§4.5)", () => {
  function connected(): MockSocket {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive(joined);
    return MockSocket.last;
  }

  it.each(["session.closed", "session.expired"])(
    "%s then a bare drop ends the session (no retry state)",
    (type) => {
      const s = connected();
      s.receive({ type, sessionId: joined.sessionId, reason: "PUBLISHER_CLOSED" });
      s.serverClose(1006);
      expect(conn.state).toMatchObject({
        kind: "sessionEnded",
        description: describeCode("SESSION_CLOSED", "en"),
      });
    },
  );

  it("session.closed then a dead heartbeat ends the session too", () => {
    const s = connected();
    s.receive({ type: "session.expired", sessionId: joined.sessionId, reason: "IDLE" });
    vi.advanceTimersByTime(25_000);
    expect(conn.state.kind).toBe("sessionEnded");
    expect(s.closedWith?.code).toBe(1000);
  });

  it("the close code still wins when it comes", () => {
    const s = connected();
    s.receive({ type: "session.closed", sessionId: joined.sessionId, reason: "PUBLISHER_CLOSED" });
    s.serverClose(4002);
    expect(conn.state).toMatchObject({ kind: "sessionEnded", closeCode: 4002 });
  });
});

describe("inbound frames", () => {
  it("a handler that throws neither stops the others nor the connection; only the event name is logged", () => {
    make();
    const after = vi.fn();
    conn.on("state", () => {
      throw new Error(`state ${CODE}`);
    });
    conn.on("state", after);
    conn.onMessage("viewer.joined", () => {
      throw new Error(joined.viewerToken);
    });
    const joinedAfter = vi.fn();
    conn.onMessage("viewer.joined", joinedAfter);
    conn.on("binary", () => {
      throw new Error("binary");
    });
    const binaryAfter = vi.fn();
    conn.on("binary", binaryAfter);
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    s.receive(joined);
    s.receiveRaw(new Uint8Array([1, 2, 3]).buffer);
    expect(after).toHaveBeenCalledWith({ kind: "connected" });
    expect(joinedAfter).toHaveBeenCalledOnce();
    expect(binaryAfter).toHaveBeenCalledOnce();
    expect(conn.state.kind).toBe("connected");
    expect(log.mock.calls).toEqual([
      ["connection handler failed", { event: "state" }],
      ["connection handler failed", { event: "state" }],
      ["connection handler failed", { event: "viewer.joined" }],
      ["connection handler failed", { event: "binary" }],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(new RegExp(`${CODE}|${joined.viewerToken}`));
  });

  it("ignores and logs unknown message types, tolerates unknown fields (§14)", () => {
    make();
    const count = vi.fn();
    conn.onMessage("viewer.count", count);
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    s.receive({ type: "scene.hologram", payload: { secret: "x" } });
    s.receive({
      type: "viewer.count",
      viewerCount: 3,
      viewerLimit: 20,
      platforms: { web: 3 },
      futureField: 1,
    });
    expect(count).toHaveBeenCalledOnce();
    expect(count.mock.calls[0]![0].futureField).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      "ignored message of unknown type",
      { type: "scene.hologram" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    expect(conn.state.kind).toBe("connecting");
  });

  it("ignores malformed JSON and a different major version without throwing", () => {
    make();
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    expect(() => {
      s.receiveRaw("{");
      s.receiveRaw(JSON.stringify({ protocolVersion: "2.0", type: "viewer.count" }));
      s.receiveRaw(new Blob(["x"]));
    }).not.toThrow();
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("emits binary frames as Uint8Array", () => {
    make();
    const binary = vi.fn();
    conn.on("binary", binary);
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receiveRaw(new Uint8Array([1, 2, 3]).buffer);
    expect(binary).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("unsubscribes handlers", () => {
    make();
    const handler = vi.fn();
    const off = conn.onMessage("viewer.count", handler);
    conn.connect({ code: CODE });
    MockSocket.last.open();
    off();
    MockSocket.last.receive({
      type: "viewer.count",
      viewerCount: 1,
      viewerLimit: 20,
      platforms: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("send and leave", () => {
  it("send fails before the socket is open and adds the envelope after", () => {
    make();
    expect(conn.send({ type: "scene.request" })).toBe(false);
    conn.connect({ code: CODE });
    expect(conn.send({ type: "scene.request" })).toBe(false);
    MockSocket.last.open();
    expect(
      conn.send({
        type: "scene.request",
        haveSnapshotVersion: 1,
        haveSceneVersion: 2,
        reason: "GAP",
      }),
    ).toBe(true);
    const frame = MockSocket.last.frames[1]!;
    expect(frame).toMatchObject({ protocolVersion: "1.0", type: "scene.request", id: "v-2" });
    expect(validateMessage(frame).ok).toBe(true);
  });

  it("leave sends viewer.leave, closes with 1000 and goes idle without a retry state", () => {
    make();
    conn.connect({ code: CODE });
    const s = MockSocket.last;
    s.open();
    s.receive(joined);
    conn.leave();
    expect(s.frames.at(-1)).toMatchObject({ type: "viewer.leave" });
    expect(s.closedWith?.code).toBe(1000);
    expect(conn.state.kind).toBe("idle");
    s.onclose?.({ code: 1000 });
    expect(conn.state.kind).toBe("idle");
  });

  it("leave without a socket goes idle from a disconnected or an end state (WEB-22), once", () => {
    make();
    conn.connect({ code: CODE });
    MockSocket.last.open();
    MockSocket.last.receive(joined);
    MockSocket.last.serverClose(1006);
    expect(conn.state.kind).toBe("disconnected");
    conn.leave();
    expect(conn.state.kind).toBe("idle");
    conn.connect({ code: CODE });
    MockSocket.last.serverClose(4004);
    expect(conn.state.kind).toBe("enterCode");
    const states: string[] = [];
    conn.on("state", (s) => states.push(s.kind));
    conn.leave();
    conn.leave();
    expect(states).toEqual(["idle"]); // nothing to close, and no second `idle`
  });

  it("a new connect() discards the previous socket", () => {
    make();
    conn.connect({ code: CODE });
    const first = MockSocket.last;
    first.open();
    conn.connect({ code: "AB2CD" });
    expect(first.closedWith?.code).toBe(1000);
    first.onclose?.({ code: 1000 });
    expect(conn.state.kind).toBe("connecting");
  });
});

describe("endsSession", () => {
  it("is true exactly for left, ended, refused and stopped", () => {
    const closed = { description: describeCode(1000, "en"), closeCode: 1000 };
    const states: [ConnectionState, boolean][] = [
      [{ kind: "idle" }, true],
      [{ kind: "connecting" }, false],
      [{ kind: "connected" }, false],
      [{ kind: "disconnected", ...closed, immediate: false, dead: false }, false],
      [{ kind: "enterCode", ...closed }, true],
      [{ kind: "sessionEnded", ...closed }, true],
      [{ kind: "stopped", ...closed }, true],
    ];
    for (const [state, expected] of states) expect(endsSession(state), state.kind).toBe(expected);
  });
});
