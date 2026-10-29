/**
 * A close the relay starts ends within bounded time (`Connection.close`, T3): the socket is dropped
 * unless its peer completes the close, keeps reading, or — at most — until `ws`'s 30 s.
 */
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLOSE_COMPLETE_MS, CLOSE_DRAIN_MAX_MS, Connection } from "../src/ws/connection.js";
import { ManualClock } from "./helpers/manual-clock.js";

/** The part of a `ws` socket that `close()` uses, with what it was asked to do. */
function fakeSocket(readyState: number = WebSocket.OPEN, bufferedAmount = 0) {
  const listeners: (() => void)[] = [];
  return {
    readyState,
    bufferedAmount,
    closes: [] as number[],
    terminated: 0,
    close(code: number) {
      this.closes.push(code);
      this.readyState = WebSocket.CLOSING;
    },
    terminate() {
      this.terminated += 1;
    },
    once(event: string, listener: () => void) {
      if (event === "close") listeners.push(listener);
    },
    /** The peer completed the close. */
    closed() {
      this.readyState = WebSocket.CLOSED;
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

function connect(socket: ReturnType<typeof fakeSocket>) {
  const clock = new ManualClock();
  return { clock, connection: new Connection(socket as unknown as WebSocket, clock, "key") };
}

describe("a close the relay starts (T3)", () => {
  it("a peer that reads nothing is dropped after 5 s; one that completes the close is not", () => {
    const silent = fakeSocket(WebSocket.OPEN, 4096);
    const a = connect(silent);
    a.connection.close(4001);
    expect(silent.closes).toEqual([4001]);
    a.clock.advance(CLOSE_COMPLETE_MS - 1);
    expect(silent.terminated).toBe(0);
    a.clock.advance(1);
    expect(silent.terminated).toBe(1);

    const polite = fakeSocket();
    const b = connect(polite);
    b.connection.close(1000);
    polite.closed();
    expect(b.clock.pending).toBe(0);
    b.clock.advance(CLOSE_DRAIN_MAX_MS);
    expect(polite.terminated).toBe(0);
  });

  it("a peer that started the close itself (a close frame, a half-close) is dropped after 5 s too", () => {
    const zombie = fakeSocket(WebSocket.CLOSING, 6 * 1024 * 1024);
    const { clock, connection } = connect(zombie);
    connection.close(4001); // e.g. its session ends
    expect(zombie.closes).toEqual([]); // `ws` already sent or will send its close frame
    clock.advance(CLOSE_COMPLETE_MS);
    expect(zombie.terminated).toBe(1);
  });

  it("a peer still reading gets up to 30 s for its close code, as long as its buffer shrinks", () => {
    const slow = fakeSocket(WebSocket.OPEN, 4 * 1024 * 1024);
    const { clock, connection } = connect(slow);
    connection.close(4002);
    for (
      let elapsed = CLOSE_COMPLETE_MS;
      elapsed < CLOSE_DRAIN_MAX_MS;
      elapsed += CLOSE_COMPLETE_MS
    ) {
      slow.bufferedAmount -= 64 * 1024;
      clock.advance(CLOSE_COMPLETE_MS);
      expect(slow.terminated).toBe(0);
    }
    slow.bufferedAmount -= 64 * 1024;
    clock.advance(CLOSE_COMPLETE_MS); // 30 s: no longer, even while it reads
    expect(slow.terminated).toBe(1);
  });

  it("a peer whose buffer stops shrinking is dropped at the next check", () => {
    const stalled = fakeSocket(WebSocket.OPEN, 1024 * 1024);
    const { clock, connection } = connect(stalled);
    connection.close(4002);
    stalled.bufferedAmount -= 1024;
    clock.advance(CLOSE_COMPLETE_MS);
    expect(stalled.terminated).toBe(0);
    clock.advance(CLOSE_COMPLETE_MS);
    expect(stalled.terminated).toBe(1);
  });

  it("a socket already closed, or closed twice, arms nothing", () => {
    const gone = fakeSocket(WebSocket.CLOSED);
    const a = connect(gone);
    a.connection.close(4001);
    expect([gone.closes, a.clock.pending]).toEqual([[], 0]);

    const twice = fakeSocket();
    const b = connect(twice);
    b.connection.close(4001);
    b.connection.close(4002);
    expect([twice.closes, b.clock.pending]).toEqual([[4001], 1]);
  });
});
