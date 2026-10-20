import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/protocol/connection";
import type { Connection } from "../../src/protocol/connection";
import { bindModelLifecycle } from "../../src/render/model-lifecycle";
import type { SnapshotSource } from "../../src/render/model-lifecycle";
import type { SceneModelStore, StoreLoadResult } from "../../src/render/scene-model";
import { MockSocket } from "../protocol/mock-socket";

function source() {
  const handlers = new Set<(p: { bytes: Uint8Array }) => void>();
  const s: SnapshotSource & { emit(bytes: Uint8Array): void } = {
    on: (_event, handler) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    emit: (bytes) => handlers.forEach((h) => h({ bytes })),
  };
  return s;
}

function store(result: () => Promise<StoreLoadResult>) {
  return {
    load: vi.fn<SceneModelStore["load"]>(() => result()),
    clear: vi.fn(),
    current: null,
    onChange: vi.fn(() => () => undefined),
  } satisfies SceneModelStore;
}

const joined = (sessionId: string) => ({
  type: "viewer.joined",
  sessionId,
  viewerId: "vw_1",
  viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  sceneVersion: 0,
  snapshotVersion: null,
  snapshotAvailable: false,
  publisherOnline: true,
  viewerCount: 1,
  viewerLimit: 20,
  profile: "mobile",
});

let conn: Connection;
let socket: MockSocket;
function connect(): void {
  conn = createConnection({
    location: { protocol: "https:", host: "x.example", hostname: "x.example" },
    createSocket: (url) => new MockSocket(url),
    log: vi.fn(),
    lang: "en",
  });
}
function open(): void {
  conn.connect({ code: "7KQ4X" });
  socket = MockSocket.last;
  socket.open();
}

beforeEach(() => {
  MockSocket.reset();
  connect();
});

describe("snapshots → store", () => {
  it("parses snapshots from every source; a refusal or a rejected load reports invalid once", async () => {
    const stream = source();
    const loader = source();
    const results: StoreLoadResult[] = [
      { ok: false, reason: "accessors" },
      { ok: false, reason: "superseded" },
    ];
    const models = store(() => {
      const next = results.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("bug"));
    });
    const onInvalid = vi.fn();
    bindModelLifecycle(conn, [stream, loader], models, onInvalid);
    stream.emit(new Uint8Array(4));
    loader.emit(new Uint8Array(8));
    loader.emit(new Uint8Array(12));
    await vi.waitFor(() => expect(models.load).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(onInvalid).toHaveBeenCalledTimes(2)); // refused + rejected, not superseded
    await new Promise((resolve) => setTimeout(resolve, 0)); // let every pending load settle
    expect(onInvalid).toHaveBeenCalledTimes(2);
    expect(models.load.mock.calls.map(([b]) => b.byteLength)).toEqual([4, 8, 12]);
  });

  it.each<[string, StoreLoadResult]>([
    ["superseded", { ok: false, reason: "superseded" }],
    ["successful", { ok: true, model: {} as never }],
  ])("a %s load reports nothing", async (_label, result) => {
    const stream = source();
    const models = store(() => Promise.resolve(result));
    const onInvalid = vi.fn();
    bindModelLifecycle(conn, [stream], models, onInvalid);
    stream.emit(new Uint8Array(4));
    await vi.waitFor(() => expect(models.load).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("keeps no reference to the snapshot bytes", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const freed = new Set<string>();
    const registry = new FinalizationRegistry<string>((label) => freed.add(label));
    const stream = source();
    const models = store(() => Promise.resolve({ ok: false, reason: "superseded" }));
    bindModelLifecycle(conn, [stream], models, vi.fn());
    (() => {
      const bytes = new Uint8Array(1 << 16);
      registry.register(bytes.buffer, "bytes");
      stream.emit(bytes);
    })();
    models.load.mockClear(); // the spy's call log would keep the bytes alive
    for (let i = 0; i < 20 && !freed.has("bytes"); i++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(freed.has("bytes")).toBe(true);
  });
});

describe("model lifetime", () => {
  it.each([
    ["stopped (1008)", 1008],
    ["sessionEnded (4001)", 4001],
    ["enterCode (4004)", 4004],
  ])("a terminal state clears the model: %s", (_label, code) => {
    const models = store(() => Promise.resolve({ ok: false, reason: "superseded" }));
    bindModelLifecycle(conn, [], models, vi.fn());
    open();
    socket.receive(joined("sess_A"));
    expect(models.clear).not.toHaveBeenCalled();
    socket.serverClose(code);
    expect(models.clear).toHaveBeenCalledTimes(1);
  });

  it("leaving clears the model; a dropped socket (reconnect) keeps it", () => {
    const models = store(() => Promise.resolve({ ok: false, reason: "superseded" }));
    bindModelLifecycle(conn, [], models, vi.fn());
    open();
    socket.receive(joined("sess_A"));
    socket.serverClose(1006);
    expect(conn.state.kind).toBe("disconnected");
    expect(models.clear).not.toHaveBeenCalled();
    open();
    socket.receive(joined("sess_A"));
    expect(models.clear).not.toHaveBeenCalled();
    conn.leave();
    expect(models.clear).toHaveBeenCalledTimes(1);
  });

  it("joining a different session clears the previous scene; the same session keeps it", () => {
    const models = store(() => Promise.resolve({ ok: false, reason: "superseded" }));
    bindModelLifecycle(conn, [], models, vi.fn());
    open();
    socket.receive(joined("sess_A"));
    socket.receive(joined("sess_A"));
    expect(models.clear).not.toHaveBeenCalled();
    socket.receive(joined("sess_B"));
    expect(models.clear).toHaveBeenCalledTimes(1);
  });

  it("the returned function unsubscribes everything", () => {
    const stream = source();
    const models = store(() => Promise.resolve({ ok: false, reason: "superseded" }));
    const off = bindModelLifecycle(conn, [stream], models, vi.fn());
    off();
    open();
    stream.emit(new Uint8Array(1));
    socket.receive(joined("sess_A"));
    socket.receive(joined("sess_B"));
    socket.serverClose(4001);
    expect(models.load).not.toHaveBeenCalled();
    expect(models.clear).not.toHaveBeenCalled();
  });
});
