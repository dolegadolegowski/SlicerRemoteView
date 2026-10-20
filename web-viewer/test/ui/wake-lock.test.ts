import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/protocol/connection";
import type { Connection, LogFn } from "../../src/protocol/connection";
import { bindWakeLock } from "../../src/ui/wake-lock";
import type { SentinelLike } from "../../src/ui/wake-lock";
import { FakeDocument } from "../protocol/fake-document";
import { MockSocket } from "../protocol/mock-socket";

class FakeSentinel extends EventTarget implements SentinelLike {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}

const joined = {
  type: "viewer.joined",
  sessionId: "sess_01K7Q4XMB2TJ9RD6",
  viewerId: "vw_1",
  viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  sceneVersion: 0,
  snapshotVersion: null,
  snapshotAvailable: false,
  publisherOnline: true,
  viewerCount: 1,
  viewerLimit: 20,
  profile: "mobile",
};

let connection: Connection;
let doc: FakeDocument;
let sentinels: FakeSentinel[];
let request: ReturnType<typeof vi.fn<(type: "screen") => Promise<SentinelLike>>>;
let log: ReturnType<typeof vi.fn<LogFn>>;

beforeEach(() => {
  MockSocket.reset();
  connection = createConnection({
    location: { protocol: "https:", host: "x.example", hostname: "x.example" },
    createSocket: (url) => new MockSocket(url),
    log: vi.fn(),
    lang: "en",
  });
  doc = new FakeDocument();
  sentinels = [];
  request = vi.fn(async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s;
  });
  log = vi.fn<LogFn>();
});

function join(): MockSocket {
  connection.connect({ code: "7KQ4X" });
  const s = MockSocket.last;
  s.open();
  s.receive(joined);
  return s;
}

/** Lets the wake lock's promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("screen wake lock (WEB-16, FR-46)", () => {
  it("is requested after the join, not before", async () => {
    bindWakeLock(connection, { wakeLock: { request }, document: doc, log });
    connection.connect({ code: "7KQ4X" });
    MockSocket.last.open();
    expect(request).not.toHaveBeenCalled();
    MockSocket.last.receive(joined);
    expect(request).toHaveBeenCalledWith("screen");
    await settle();
    expect(sentinels).toHaveLength(1);
  });

  it("is requested again when the page becomes visible after the browser released it", async () => {
    bindWakeLock(connection, { wakeLock: { request }, document: doc, log });
    join();
    await settle();
    doc.show("hidden");
    await sentinels[0]!.release(); // the browser releases it with the page hidden
    expect(request).toHaveBeenCalledTimes(1);
    doc.show("visible");
    expect(request).toHaveBeenCalledTimes(2);
    await settle();
    doc.show("visible"); // still held: not requested a third time
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("is released when the session ends; a drop that will be retried keeps it", async () => {
    let retried = true;
    bindWakeLock(connection, {
      wakeLock: { request },
      document: doc,
      log,
      ends: (state) => state.kind !== "connected" && state.kind !== "connecting" && !retried,
    });
    const s = join();
    await settle();
    s.serverClose(1006);
    expect(sentinels[0]!.release).not.toHaveBeenCalled();
    retried = false;
    connection.connect({ code: "7KQ4X" });
    MockSocket.last.serverClose(4001);
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
    doc.show("visible"); // not wanted any more
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a lock granted after the session ended is released at once", async () => {
    let grant: (s: SentinelLike) => void = () => undefined;
    const slow = vi.fn(() => new Promise<SentinelLike>((resolve) => (grant = resolve)));
    bindWakeLock(connection, { wakeLock: { request: slow }, document: doc, log });
    join();
    connection.leave();
    const late = new FakeSentinel();
    grant(late);
    await settle();
    expect(late.release).toHaveBeenCalledTimes(1);
  });

  it("a refusal is logged without its reason, and a hidden page does not ask", async () => {
    const refusing = vi.fn(() =>
      Promise.reject(new DOMException("NotAllowedError: Battery saver", "NotAllowedError")),
    );
    bindWakeLock(connection, { wakeLock: { request: refusing }, document: doc, log });
    join();
    await settle();
    expect(log).toHaveBeenCalledWith("screen wake lock refused");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Battery");
    doc.show("hidden");
    MockSocket.last.receive(joined);
    expect(refusing).toHaveBeenCalledTimes(1);
  });

  it("without the API nothing happens; the unsubscribe releases the lock", async () => {
    const off = bindWakeLock(connection, { wakeLock: undefined, document: doc, log });
    join();
    off();
    const off2 = bindWakeLock(connection, { wakeLock: { request }, document: doc, log });
    MockSocket.last.receive(joined);
    await settle();
    off2();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });
});
