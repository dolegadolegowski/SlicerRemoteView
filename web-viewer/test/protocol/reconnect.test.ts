import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/protocol/connection";
import type { Connection, ConnectionState, LogFn } from "../../src/protocol/connection";
import {
  MAX_RETRY_AFTER_MS,
  STABLE_MS,
  BACKOFF_MAX_MS,
  CODE_FALLBACK_AT_MS,
  CODE_FALLBACK_JITTER_MS,
  RESTART_JITTER_MS,
  backoffDelay,
  createReconnect,
} from "../../src/protocol/reconnect";
import { describe as describeCode } from "../../src/state/errors";
import type { Reconnect } from "../../src/protocol/reconnect";
import { FakeDocument } from "./fake-document";
import { MockSocket } from "./mock-socket";

const CODE = "7KQ4X";
const HTTPS = { protocol: "https:", host: "view.example.com", hostname: "view.example.com" };
const SESSION = "sess_01K7Q4XMB2TJ9RD6";
const TOKEN = "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw";

const joinedMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "viewer.joined",
  replyTo: "v-1",
  sessionId: SESSION,
  viewerId: "vw_4f2a",
  viewerToken: TOKEN,
  sceneVersion: 2,
  snapshotVersion: 1,
  snapshotAvailable: true,
  snapshot: { sceneVersion: 1, byteLength: 1024, sha256: "a".repeat(64), format: "glb" },
  publisherOnline: true,
  viewerCount: 1,
  viewerLimit: 20,
  profile: "mobile",
  ...overrides,
});

let log: ReturnType<typeof vi.fn<LogFn>>;
let connection: Connection;
let reconnect: Reconnect;
let doc: FakeDocument;
let win: EventTarget;
let random: ReturnType<typeof vi.fn<() => number>>;
let states: ConnectionState[];

function make(): void {
  connection = createConnection({
    location: HTTPS,
    createSocket: (url) => new MockSocket(url),
    log,
    lang: "en",
  });
  states = [];
  connection.on("state", (s) => states.push(s));
  doc = new FakeDocument();
  win = new EventTarget();
  random = vi.fn(() => 0);
  reconnect = createReconnect(connection, { random, document: doc, window: win, log });
}

/** The relay accepts the newest socket's join. */
function accept(overrides: Record<string, unknown> = {}): MockSocket {
  const s = MockSocket.last;
  if (s.readyState === 0) s.open();
  s.receive(joinedMessage(overrides));
  return s;
}

/** The `viewer.join` the client sent on `s`, opening the socket first if the test has not. */
function join(s: MockSocket): Record<string, unknown> {
  if (s.readyState === 0) s.open();
  return s.frames.find((f) => f["type"] === "viewer.join")!;
}

beforeEach(() => {
  MockSocket.reset();
  log = vi.fn<LogFn>();
  vi.useFakeTimers();
  make();
});
afterEach(() => {
  reconnect.dispose();
  vi.useRealTimers();
});

describe("backoffDelay (FR-43)", () => {
  it("doubles from 0.5 s to the 30 s cap, jittered within [d/2, d]", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, 0))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(0, 0.999)).toBeCloseTo(250, 0);
    expect(backoffDelay(10, 0.5)).toBe(BACKOFF_MAX_MS * 0.75);
  });
});

describe("rejoin after a drop (FR-43, US-12, NFR-19)", () => {
  it("a killed socket is retried at 0.5, 1, 2 … ≤ 30 s, each time with the token, never the code", () => {
    reconnect.join(CODE);
    expect(join(MockSocket.last)).toMatchObject({ code: CODE });
    accept();
    MockSocket.last.serverClose(1006);
    expect(connection.state.kind).toBe("disconnected");
    expect(reconnect.willRetry(connection.state)).toBe(true);
    const waits = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const wait of waits) {
      const sockets = MockSocket.instances.length;
      vi.advanceTimersByTime(wait - 1);
      expect(MockSocket.instances).toHaveLength(sockets);
      vi.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(sockets + 1);
      const s = MockSocket.last;
      const frame = join(s);
      expect(frame).toMatchObject({ sessionId: SESSION, viewerToken: TOKEN });
      expect(frame).not.toHaveProperty("code");
      s.serverClose(1006); // still down
    }
  });

  it("a rejoin that holds for STABLE_MS resets the backoff", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(500);
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(1_000);
    accept();
    expect(connection.state.kind).toBe("connected");
    vi.advanceTimersByTime(STABLE_MS);
    MockSocket.last.serverClose(1011);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(500);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("a relay that accepts the rejoin and drops it at once is still backed off up to 30 s", () => {
    reconnect.join(CODE);
    accept();
    vi.advanceTimersByTime(STABLE_MS); // the first session was stable
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      MockSocket.last.serverClose(1011);
      const before = Date.now();
      const sockets = MockSocket.instances.length;
      while (MockSocket.instances.length === sockets) vi.advanceTimersByTime(100);
      waits.push(Date.now() - before);
      accept(); // accepted … and dropped again on the next turn
    }
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("a dead heartbeat (no pong) is retried like a drop", () => {
    reconnect.join(CODE);
    accept();
    vi.advanceTimersByTime(25_000); // ping at 15 s, no pong by 25 s
    expect(connection.state).toMatchObject({ kind: "disconnected", dead: true });
    vi.advanceTimersByTime(500);
    expect(join(MockSocket.last)).toMatchObject({ viewerToken: TOKEN });
  });

  it("4008 (relay restart) is retried within 0–3 s with jitter", () => {
    reconnect.join(CODE);
    accept();
    random.mockReturnValue(0.999);
    MockSocket.last.serverClose(4008);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(RESTART_JITTER_MS * 0.999 - 1);
    expect(MockSocket.instances).toHaveLength(sockets);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("the relay's retryAfterS wins over a shorter backoff (session full, rate limited)", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(500);
    const s = MockSocket.last;
    s.open();
    s.receive({
      type: "error",
      code: "SESSION_FULL",
      message: "full",
      retryable: true,
      details: { retryAfterS: 30 },
    });
    s.serverClose(4005);
    expect(reconnect.willRetry(connection.state)).toBe(true);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(29_999);
    expect(MockSocket.instances).toHaveLength(sockets);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it.each([
    [4001, "sessionEnded"],
    [4002, "sessionEnded"],
    [4000, "stopped"],
    [1008, "stopped"],
    [4003, "enterCode"],
    [4011, "enterCode"],
  ])("close %i ends the session: %s and no further retries (§9.3)", (code, kind) => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(code);
    expect(connection.state.kind).toBe(kind);
    expect(reconnect.willRetry(connection.state)).toBe(false);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(MockSocket.instances).toHaveLength(sockets);
  });

  it("a session that ended forgets its credentials: a drop of the next join (not yet joined) is not retried", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(4001);
    reconnect.join("AB2CD");
    MockSocket.last.serverClose(1006);
    expect(reconnect.willRetry(connection.state)).toBe(false);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(sockets);
  });
});

describe("first join", () => {
  it("a first join that fails is not retried: the code entry reports it and Join tries again", () => {
    reconnect.join(CODE);
    MockSocket.last.serverClose(1006);
    expect(reconnect.willRetry(connection.state)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
    reconnect.join(CODE);
    expect(MockSocket.instances).toHaveLength(2);
    expect(join(MockSocket.last)).toMatchObject({ code: CODE });
  });
});

describe("relay restart: SESSION_NOT_FOUND → join by code (§13 step 9, US-11, NFR-20, §12)", () => {
  const NEW_SESSION = "sess_NEW0000000000000";
  const NEW_TOKEN = `vt_${"B".repeat(43)}`;

  /** Joined, the relay restarts (4008), the token rejoin finds no session. Returns that socket. */
  function lostSession(): MockSocket {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(4008);
    vi.advanceTimersByTime(RESTART_JITTER_MS);
    const s = MockSocket.last;
    expect(join(s)).toMatchObject({ viewerToken: TOKEN });
    s.receive({
      type: "error",
      replyTo: "v-2",
      code: "SESSION_NOT_FOUND",
      message: "no such session",
      retryable: false,
    });
    return s;
  }

  /** The code join of the newest socket is refused: the presenter has not re-created the session. */
  function unknown(): void {
    const s = MockSocket.last;
    expect(join(s)).toMatchObject({ code: CODE });
    s.receive({ type: "error", code: "INVALID_CODE", message: "no", retryable: false });
    s.serverClose(4004);
  }

  it("gives the presenter a head start, then joins by the code it still holds on a new socket", () => {
    const old = lostSession();
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]! - 1);
    expect(MockSocket.instances).toHaveLength(sockets); // the old socket waits; no code join yet
    vi.advanceTimersByTime(1);
    expect(old.closedWith?.code).toBe(1000);
    const s = MockSocket.last;
    expect(s).not.toBe(old);
    expect(join(s)).toMatchObject({ code: CODE });
    expect(join(s)).not.toHaveProperty("viewerToken");
    s.receive(
      joinedMessage({
        sessionId: NEW_SESSION,
        viewerToken: NEW_TOKEN,
        sceneVersion: 0,
        snapshotVersion: null,
        snapshotAvailable: false,
        snapshot: undefined,
      }),
    );
    expect(connection.state.kind).toBe("connected");
    // The next drop rejoins the new session with its token.
    s.serverClose(1006);
    vi.advanceTimersByTime(500);
    expect(join(MockSocket.last)).toMatchObject({ sessionId: NEW_SESSION, viewerToken: NEW_TOKEN });
    // Neither the code nor a token reaches a log line.
    expect(JSON.stringify(log.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("leave() during the head start or between the code joins cancels them and goes idle (WEB-22)", () => {
    const old = lostSession();
    reconnect.leave(); // the old socket is still open: it gets viewer.leave + 1000
    expect(old.closedWith?.code).toBe(1000);
    expect(connection.state.kind).toBe("idle");
    let sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(MockSocket.instances).toHaveLength(sockets); // no code join

    lostSession();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    unknown(); // closed, no socket left: the next code join is only a timer
    expect(reconnect.willRetry(connection.state)).toBe(true);
    sockets = MockSocket.instances.length;
    reconnect.leave();
    expect(connection.state.kind).toBe("idle");
    vi.advanceTimersByTime(10 * 60_000);
    expect(MockSocket.instances).toHaveLength(sockets);
  });

  it("the head start is jittered so a room does not join at the same moment", () => {
    random.mockReturnValue(0.5);
    lostSession();
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]! + CODE_FALLBACK_JITTER_MS * 0.5 - 1);
    expect(MockSocket.instances).toHaveLength(sockets);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("INVALID_CODE is retried only on the schedule (≈ 4, 15, 35, 60 s), then 'presentation ended'", () => {
    lostSession();
    const since = Date.now();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    const at: number[] = [];
    for (let i = 0; i < CODE_FALLBACK_AT_MS.length; i++) {
      at.push(Date.now() - since);
      const sockets = MockSocket.instances.length;
      unknown();
      expect(connection.state.kind).toBe("enterCode");
      const last = i === CODE_FALLBACK_AT_MS.length - 1;
      expect(reconnect.willRetry(connection.state)).toBe(!last);
      if (last) break;
      expect(reconnect.explain(connection.state)).toBeNull();
      vi.advanceTimersToNextTimer();
      expect(MockSocket.instances).toHaveLength(sockets + 1);
    }
    expect(at).toEqual(CODE_FALLBACK_AT_MS); // four code joins in a minute: few failures for the room's IP (§12)
    expect(reconnect.explain(connection.state)).toEqual(describeCode("SESSION_CLOSED", "en"));
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(MockSocket.instances).toHaveLength(sockets);
  });

  it("the presenter back by the second code join: joined, the schedule is over", () => {
    lostSession();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    unknown();
    vi.advanceTimersToNextTimer();
    accept({ sessionId: NEW_SESSION, viewerToken: NEW_TOKEN });
    expect(connection.state.kind).toBe("connected");
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(500);
    expect(join(MockSocket.last)).toMatchObject({ viewerToken: NEW_TOKEN });
    // The fallback is over: an INVALID_CODE now (a first code join of a later session) is not retried.
    reconnect.join(CODE);
    MockSocket.last.serverClose(4004);
    expect(reconnect.willRetry(connection.state)).toBe(false);
  });

  it("a joined session ends the fallback: its later INVALID_CODE is not retried", () => {
    lostSession();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    accept({ sessionId: NEW_SESSION, viewerToken: NEW_TOKEN });
    const s = MockSocket.last;
    s.receive({ type: "error", code: "INVALID_CODE", message: "x", retryable: false });
    s.serverClose(4004);
    expect(reconnect.willRetry(connection.state)).toBe(false);
  });

  it("INVALID_CODE followed by a bare drop (1006) during the fallback waits for the next scheduled code join", () => {
    lostSession();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    const s = MockSocket.last;
    expect(join(s)).toMatchObject({ code: CODE });
    s.receive({ type: "error", code: "INVALID_CODE", message: "x", retryable: false });
    s.serverClose(1006);
    expect(connection.state.kind).toBe("enterCode"); // the error coloured the bare drop
    expect(reconnect.willRetry(connection.state)).toBe(true);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[1]! - CODE_FALLBACK_AT_MS[0]! - 1);
    expect(MockSocket.instances).toHaveLength(sockets);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("a network drop during the fallback is retried by code with the normal backoff", () => {
    lostSession();
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]!);
    MockSocket.last.serverClose(1006);
    expect(reconnect.willRetry(connection.state)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(join(MockSocket.last)).toMatchObject({ code: CODE });
  });

  it.each([1000, 1006, 4012])(
    "the relay closing the failed token join's socket (%i) does not cut the head start short",
    (code) => {
      const old = lostSession();
      old.serverClose(code);
      expect(reconnect.willRetry(connection.state)).toBe(true);
      const sockets = MockSocket.instances.length;
      vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]! - 1);
      expect(MockSocket.instances).toHaveLength(sockets);
      vi.advanceTimersByTime(1);
      expect(join(MockSocket.last)).toMatchObject({ code: CODE });
    },
  );

  it("back in view does not cut the head start short", () => {
    lostSession();
    const sockets = MockSocket.instances.length;
    doc.show("visible");
    expect(MockSocket.instances).toHaveLength(sockets);
  });

  it("INVALID_CODE outside the fallback (a first join) is not retried and keeps its own message", () => {
    reconnect.join(CODE);
    MockSocket.last.serverClose(4004);
    expect(reconnect.willRetry(connection.state)).toBe(false);
    expect(reconnect.explain(connection.state)).toBeNull();
  });

  it("SESSION_NOT_FOUND on a live session or for a code join does not switch credentials", () => {
    reconnect.join(CODE);
    const s = MockSocket.last;
    s.open();
    s.receive({ type: "error", code: "SESSION_NOT_FOUND", message: "x", retryable: false });
    accept();
    s.receive({ type: "error", code: "SESSION_NOT_FOUND", message: "x", retryable: false });
    vi.advanceTimersByTime(CODE_FALLBACK_AT_MS[0]! + CODE_FALLBACK_JITTER_MS); // no code join scheduled
    expect(MockSocket.instances).toHaveLength(1);
    expect(connection.state.kind).toBe("connected");
  });
});

describe("visibility and page lifecycle (§13 step 8, §5.4)", () => {
  it("back in view while connected checks the link at once", () => {
    reconnect.join(CODE);
    const s = accept();
    doc.show("hidden");
    expect(s.frames.filter((f) => f["type"] === "ping")).toHaveLength(0);
    doc.show("visible");
    expect(s.frames.filter((f) => f["type"] === "ping")).toHaveLength(1);
    vi.advanceTimersByTime(10_000); // no pong: dead, then retried
    expect(connection.state.kind).toBe("disconnected");
    vi.advanceTimersByTime(500);
    expect(join(MockSocket.last)).toMatchObject({ viewerToken: TOKEN });
  });

  it("a retryAfterS above an hour is capped at MAX_RETRY_AFTER_MS", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(500);
    const s = MockSocket.last;
    s.open();
    s.receive({
      type: "error",
      code: "RATE_LIMITED",
      message: "x",
      retryable: true,
      details: { retryAfterS: 999_999 },
    });
    s.serverClose(4006);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(MAX_RETRY_AFTER_MS - 1);
    expect(MockSocket.instances).toHaveLength(sockets);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("the relay's retryAfterS holds against a visibility change even when the backoff is longer", () => {
    reconnect.join(CODE);
    accept();
    for (let i = 0; i < 6; i++) {
      MockSocket.last.serverClose(1006);
      vi.advanceTimersToNextTimer();
    }
    const s = MockSocket.last; // the backoff is at 30 s now
    s.open();
    s.receive({
      type: "error",
      code: "SESSION_FULL",
      message: "full",
      retryable: true,
      details: { retryAfterS: 10 },
    });
    s.serverClose(4005);
    const sockets = MockSocket.instances.length;
    vi.advanceTimersByTime(1_000);
    doc.show("visible");
    vi.advanceTimersByTime(20_000);
    expect(MockSocket.instances).toHaveLength(sockets); // neither at once nor before the backoff
  });

  it("back in view during a backoff wait retries at once; not during the relay's retryAfterS", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      MockSocket.last.serverClose(1006);
    }
    const sockets = MockSocket.instances.length;
    doc.show("visible");
    expect(MockSocket.instances).toHaveLength(sockets + 1);
    const s = MockSocket.last;
    s.open();
    s.receive({
      type: "error",
      code: "RATE_LIMITED",
      message: "x",
      retryable: true,
      details: { retryAfterS: 60 },
    });
    s.serverClose(4006);
    doc.show("visible");
    expect(MockSocket.instances).toHaveLength(sockets + 1);
  });

  it("pagehide sends viewer.leave and closes 1000; a page restored from the bfcache joins by code again", () => {
    reconnect.join(CODE);
    const s = accept();
    win.dispatchEvent(new Event("pagehide"));
    expect(s.frames.at(-1)).toMatchObject({ type: "viewer.leave" });
    expect(s.closedWith?.code).toBe(1000);
    expect(connection.state.kind).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
    const restored = Object.assign(new Event("pageshow"), { persisted: true });
    win.dispatchEvent(restored);
    expect(MockSocket.instances).toHaveLength(2);
    MockSocket.last.open();
    expect(join(MockSocket.last)).toMatchObject({ code: CODE });
  });

  it("a fresh pageshow (not from the bfcache) or one without a session does nothing", () => {
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(MockSocket.instances).toHaveLength(0);
    reconnect.join(CODE);
    accept();
    win.dispatchEvent(new Event("pagehide"));
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(MockSocket.instances).toHaveLength(1);
  });

  it("leave() during a backoff wait cancels the retry and goes idle", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    reconnect.leave();
    expect(connection.state.kind).toBe("idle");
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it("a caller's connection.leave() also ends the session for the reconnect logic", () => {
    reconnect.join(CODE);
    accept();
    connection.leave();
    expect(connection.state.kind).toBe("idle");
    MockSocket.last.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it("dispose removes the listeners and the pending retry", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    reconnect.dispose();
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1); // the pending retry is gone
    connection.connect({ code: CODE }); // connected again by someone else
    const s = accept();
    doc.show("visible"); // no checkAlive ping from a disposed reconnect
    expect(s.frames.filter((f) => f["type"] === "ping")).toHaveLength(0);
    s.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(2); // no state listener either
  });
});

describe("willRetry", () => {
  it("is stable for one state object whatever happens afterwards", () => {
    reconnect.join(CODE);
    accept();
    MockSocket.last.serverClose(1006);
    const dropped = connection.state;
    expect(reconnect.willRetry(dropped)).toBe(true);
    reconnect.leave();
    expect(reconnect.willRetry(dropped)).toBe(true);
    expect(reconnect.willRetry(connection.state)).toBe(false);
    expect(states.map((s) => s.kind)).toEqual(["connecting", "connected", "disconnected", "idle"]);
  });
});
