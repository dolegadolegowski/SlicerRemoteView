import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateMessage } from "@slicerremoteview/shared";
import { createConnection, endsSession } from "../../src/protocol/connection";
import type { Connection } from "../../src/protocol/connection";
import type { FetchLike } from "../../src/protocol/scene-http";
import { bindStreamToLoader, createSceneLoader } from "../../src/protocol/scene-loader";
import type { SceneLoader, SceneLoaderEvents } from "../../src/protocol/scene-loader";
import { describe as describeCode } from "../../src/state/errors";
import {
  glb,
  hanging,
  manifest,
  response,
  same,
  serving,
  SMALL,
  target,
  TOKEN,
} from "./http-fixtures";
import { MockSocket } from "./mock-socket";

describe("createSceneLoader", () => {
  let conn: Connection;
  let socket: MockSocket;
  let loader: SceneLoader;
  let events: { [K in keyof SceneLoaderEvents]: SceneLoaderEvents[K][] };

  const joined = (patch: Record<string, unknown> = {}) => ({
    type: "viewer.joined",
    replyTo: "v-1",
    sessionId: "sess_01K7Q4XMB2TJ9RD6",
    viewerId: "vw_4f2a",
    viewerToken: TOKEN,
    sceneVersion: 2,
    snapshotVersion: 1,
    snapshotAvailable: true,
    snapshot: { ...target(SMALL, 1), format: "glb" },
    publisherOnline: true,
    viewerCount: 1,
    viewerLimit: 20,
    profile: "mobile",
    ...patch,
  });

  const ready = (name: string, sceneVersion: number) => ({
    type: "scene.snapshot.ready",
    ...target(name, sceneVersion),
    format: "glb",
    extensionsRequired: [],
  });

  const sentRequests = () => socket.frames.filter((f) => f["type"] === "scene.request");

  function make(fetch: FetchLike, options: Parameters<typeof createSceneLoader>[1] = {}): void {
    conn = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
      lang: "en",
    });
    loader = createSceneLoader(conn, { fetch, log: vi.fn(), lang: "en", ...options });
    events = { progress: [], ready: [], enterCode: [], sessionEnded: [], tooLarge: [], failed: [] };
    for (const name of Object.keys(events) as (keyof SceneLoaderEvents)[])
      loader.on(name, (p) => (events[name] as unknown[]).push(p));
    conn.connect({ code: "7KQ4X" });
    socket = MockSocket.last;
    socket.open();
  }

  beforeEach(() => {
    MockSocket.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    loader.dispose();
    vi.useRealTimers();
  });

  it("fetches on viewer.joined{snapshotAvailable:true} with the token and emits ready", async () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(events.ready[0]!.sceneVersion).toBe(1);
    expect(same(events.ready[0]!.bytes, glb(SMALL))).toBe(true);
    expect(events.progress.at(-1)).toEqual({ sceneVersion: 1, fraction: 1 });
    expect(loader.loadedVersion).toBe(1);
    expect(loader.pendingVersion).toBeNull();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/scene/1");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("does nothing on viewer.joined{snapshotAvailable:false}", () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(
      joined({ snapshotAvailable: false, snapshotVersion: null, snapshot: undefined }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(loader.viewerToken).toBe(TOKEN);
  });

  it("404 sends scene.request{haveSnapshotVersion, reason:'GAP'}; the following ready is fetched", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(new Uint8Array(0), { status: 404 }))
      .mockImplementation(async () =>
        response(glb(SMALL), { sha256: manifest.files[SMALL]!.sha256 }),
      );
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(sentRequests()).toHaveLength(1));
    const request = sentRequests()[0]!;
    expect(request).toMatchObject({
      haveSnapshotVersion: null,
      haveSceneVersion: 0,
      reason: "GAP",
    });
    expect(validateMessage(request).ok).toBe(true);
    socket.receive(ready(SMALL, 3));
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(events.ready[0]!.sceneVersion).toBe(3);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/scene/1", "/api/scene/3"]);
  });

  it("410 → sessionEnded and the token is dropped", async () => {
    make(serving(SMALL, { status: 410 }));
    socket.receive(joined());
    await vi.waitFor(() => expect(events.sessionEnded).toHaveLength(1));
    expect(events.sessionEnded[0]!.description).toEqual(describeCode(4001, "en"));
    expect(loader.viewerToken).toBeNull();
  });

  it("401 → enterCode, the token is dropped and later announcements are not fetched", async () => {
    const fetch = serving(SMALL, { status: 401 });
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(events.enterCode).toHaveLength(1));
    expect(events.enterCode[0]!.description).toEqual(describeCode(4003, "en"));
    expect(loader.viewerToken).toBeNull();
    socket.receive(ready(SMALL, 5));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("429 backs off Retry-After seconds and retries", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        response(new Uint8Array(0), { status: 429, headers: { "Retry-After": "4" } }),
      )
      .mockImplementation(async () =>
        response(glb(SMALL), { sha256: manifest.files[SMALL]!.sha256 }),
      );
    make(fetch);
    socket.receive(joined());
    await vi.advanceTimersByTimeAsync(3_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
  });

  it("gives up after maxAttempts and emits failed", async () => {
    const fetch = serving(SMALL, { status: 429, headers: { "Retry-After": "1" } });
    make(fetch, { maxAttempts: 3 });
    socket.receive(joined());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.failed).toEqual([{ sceneVersion: 1, reason: "rateLimited" }]);
    expect(loader.pendingVersion).toBeNull();
  });

  it("network failures retry with exponential back-off (1 s, 2 s)", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError("Failed to fetch")));
    make(fetch);
    socket.receive(joined());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.failed).toEqual([{ sceneVersion: 1, reason: "network" }]);
  });

  it("a bad hash asks once for a resync; the same version failing again gives up (no download loop)", async () => {
    const bad = { ...target(SMALL, 1), sha256: "0".repeat(64), format: "glb" };
    const fetch = serving(SMALL, { headers: { ETag: "" } });
    make(fetch);
    socket.receive(joined({ snapshot: bad }));
    await vi.waitFor(() => expect(sentRequests()).toHaveLength(1));
    expect(sentRequests()[0]).toMatchObject({ reason: "CHECKSUM_MISMATCH" });
    expect(events.failed).toEqual([]);
    // the relay answers with the same (still broken) version
    socket.receive({ type: "scene.snapshot.ready", ...bad, extensionsRequired: [] });
    await vi.waitFor(() => expect(events.failed).toHaveLength(1));
    expect(events.failed[0]).toEqual({ sceneVersion: 1, reason: "checksumMismatch" });
    socket.receive({ type: "scene.snapshot.ready", ...bad, extensionsRequired: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sentRequests()).toHaveLength(1);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("a 404 for the same version twice gives up instead of looping", async () => {
    const fetch = serving(SMALL, { status: 404 });
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(sentRequests()).toHaveLength(1));
    socket.receive(ready(SMALL, 1));
    await vi.waitFor(() =>
      expect(events.failed).toEqual([{ sceneVersion: 1, reason: "notFound" }]),
    );
    expect(sentRequests()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("viewer.joined{snapshotAvailable:true} without a snapshot description asks for scene.snapshot.ready", () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(joined({ snapshot: undefined }));
    expect(fetch).not.toHaveBeenCalled();
    expect(sentRequests()).toEqual([
      expect.objectContaining({ haveSnapshotVersion: null, reason: "GAP" }),
    ]);
  });

  it("a newer scene.snapshot.ready aborts the older download", async () => {
    const signals: AbortSignal[] = [];
    const slow = hanging();
    const fetch = vi.fn<FetchLike>((url, init) => {
      signals.push(init.signal!);
      return url === "/api/scene/1"
        ? slow(url, init)
        : Promise.resolve(response(glb(SMALL), { sha256: manifest.files[SMALL]!.sha256 }));
    });
    make(fetch);
    socket.receive(joined());
    expect(loader.pendingVersion).toBe(1);
    socket.receive(ready(SMALL, 4));
    expect(signals[0]!.aborted).toBe(true);
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(events.ready.map((r) => r.sceneVersion)).toEqual([4]);
  });

  it("an announcement of the version already loaded (or older) is not fetched again", async () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    socket.receive(ready(SMALL, 1));
    loader.noteLoaded(6); // e.g. version 6 arrived over the WebSocket stream
    socket.receive(ready(SMALL, 5));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(loader.loadedVersion).toBe(6);
  });

  it("noteLoaded cancels an older download in flight", () => {
    const fetch = hanging();
    make(fetch);
    socket.receive(joined());
    const signal = fetch.mock.calls[0]![1].signal!;
    loader.noteLoaded(2);
    expect(signal.aborted).toBe(true);
    expect(loader.pendingVersion).toBeNull();
  });

  it("joining a new session (relay restart) resets the loaded version so version 1 is fetched again", async () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(joined({ snapshot: { ...target(SMALL, 4), format: "glb" } }));
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    socket.receive(joined({ sessionId: "sess_NEWSESSION000000" }));
    await vi.waitFor(() => expect(events.ready).toHaveLength(2));
    expect(events.ready.map((r) => r.sceneVersion)).toEqual([4, 1]);
  });

  it("sessionEnded on the socket cancels the download and drops the token", () => {
    const fetch = hanging();
    make(fetch);
    socket.receive(joined());
    const signal = fetch.mock.calls[0]![1].signal!;
    socket.serverClose(4001);
    expect(signal.aborted).toBe(true);
    expect(loader.viewerToken).toBeNull();
  });

  it("a dropped socket (retryable) keeps the HTTP download going", () => {
    const fetch = hanging();
    make(fetch);
    socket.receive(joined());
    const signal = fetch.mock.calls[0]![1].signal!;
    socket.serverClose(1006);
    expect(signal.aborted).toBe(false);
    expect(loader.pendingVersion).toBe(1);
  });

  it("a snapshot above maxSnapshotBytes emits tooLarge without fetching", () => {
    const fetch = serving(SMALL);
    make(fetch, { maxSnapshotBytes: 1000 });
    socket.receive(joined());
    return vi.waitFor(() => {
      expect(events.tooLarge).toEqual([{ sceneVersion: 1, byteLength: 3400 }]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("logs never contain the token", async () => {
    const log = vi.fn();
    make(serving(SMALL, { status: 401 }), { log });
    socket.receive(joined());
    await vi.waitFor(() => expect(events.enterCode).toHaveLength(1));
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("an announcement older than the download in flight is ignored", () => {
    const fetch = hanging();
    make(fetch);
    socket.receive(joined({ snapshot: { ...target(SMALL, 5), format: "glb" } }));
    socket.receive(ready(SMALL, 3));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false);
    expect(loader.pendingVersion).toBe(5);
  });

  it("4008 (relay restart) cancels the download: its tokens die with the instance (§9.3)", async () => {
    const fetch = hanging();
    make(fetch);
    socket.receive(joined());
    const signal = fetch.mock.calls[0]![1].signal!;
    socket.serverClose(4008);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.enterCode).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a 401 or 410 that arrives after the socket dropped waits for the rejoin instead of ending the session", async () => {
    for (const status of [401, 410]) {
      let answer!: (r: Response) => void;
      const fetch = vi.fn<FetchLike>(() => new Promise<Response>((resolve) => (answer = resolve)));
      make(fetch);
      socket.receive(joined());
      socket.serverClose(1006);
      answer(response(new Uint8Array(0), { status }));
      await vi.advanceTimersByTimeAsync(10);
      expect(events.enterCode, String(status)).toEqual([]);
      expect(events.sessionEnded, String(status)).toEqual([]);
      expect(loader.viewerToken).toBeNull();
      expect(loader.pendingVersion).toBeNull();
      loader.dispose();
    }
  });

  it("a 401 for a request made with a token replaced by a rejoin is retried with the new token", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
      .mockImplementation(async () =>
        response(glb(SMALL), { sha256: manifest.files[SMALL]!.sha256 }),
      );
    make(fetch);
    socket.receive(joined());
    socket.receive(joined({ viewerToken: "vt_NEWTOKENNEWTOKENNEWTOKENNEWTOKENNEWTOKEN000" }));
    answer(response(new Uint8Array(0), { status: 401 }));
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(events.enterCode).toEqual([]);
    expect(new Headers(fetch.mock.calls[1]![1].headers).get("Authorization")).toBe(
      "Bearer vt_NEWTOKENNEWTOKENNEWTOKENNEWTOKENNEWTOKEN000",
    );
  });

  it.each([
    ["leave()", () => conn.leave()],
    ["a stop (1009)", () => socket.serverClose(1009)],
    ["refused credentials (4003)", () => socket.serverClose(4003)],
  ])(
    "after %s, joining the same session downloads its snapshot again (the model was dropped)",
    async (_label, end) => {
      const fetch = serving(SMALL);
      make(fetch);
      socket.receive(joined());
      await vi.waitFor(() => expect(events.ready).toHaveLength(1));
      end();
      expect(loader.loadedVersion).toBeNull();
      conn.connect({ code: "7KQ4X" });
      socket = MockSocket.last;
      socket.open();
      socket.receive(joined());
      await vi.waitFor(() => expect(events.ready).toHaveLength(2));
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("after a retryable drop (1006), rejoining the same session keeps the loaded snapshot (no second download)", async () => {
    const fetch = serving(SMALL);
    make(fetch);
    socket.receive(joined());
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    socket.serverClose(1006);
    expect(loader.loadedVersion).toBe(1);
    conn.connect({ code: "7KQ4X" });
    socket = MockSocket.last;
    socket.open();
    socket.receive(joined());
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a terminal state that `ends` says is retried keeps the token and the loaded version (WEB-14)", async () => {
    const fetch = serving(SMALL);
    make(fetch, { ends: (s) => endsSession(s) && s.kind !== "enterCode" });
    socket.receive(joined());
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    socket.serverClose(4004);
    expect(loader.viewerToken).not.toBeNull();
    expect(loader.loadedVersion).toBe(1);
  });

  it("leaving the session drops the token", () => {
    make(hanging());
    socket.receive(joined());
    conn.leave();
    expect(loader.viewerToken).toBeNull();
    expect(loader.pendingVersion).toBeNull();
  });

  it("a throwing event handler does not break the loader", async () => {
    const log = vi.fn();
    make(serving(SMALL), { log });
    loader.on("progress", () => {
      throw new Error("ui bug");
    });
    socket.receive(joined());
    await vi.waitFor(() => expect(events.ready).toHaveLength(1));
    expect(log).toHaveBeenCalledWith("scene loader handler failed", { event: "progress" });
  });

  it("dispose() unsubscribes from the connection", () => {
    const fetch = serving(SMALL);
    make(fetch);
    loader.dispose();
    socket.receive(joined());
    expect(fetch).not.toHaveBeenCalled();
    expect(loader.viewerToken).toBeNull();
  });
});

describe("bindStreamToLoader", () => {
  function setup() {
    MockSocket.reset();
    const conn = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
    });
    const loader = { requestResync: vi.fn(() => true), noteLoaded: vi.fn() };
    const handlers: Record<string, (p: { sceneVersion: number }) => void> = {};
    const stream = {
      on: (event: string, handler: (p: { sceneVersion: number }) => void) => {
        handlers[event] = handler;
        return () => undefined;
      },
    };
    bindStreamToLoader(
      conn,
      stream as unknown as Parameters<typeof bindStreamToLoader>[1],
      loader as unknown as SceneLoader,
    );
    conn.connect({ code: "7KQ4X" });
    const socket = MockSocket.last;
    socket.open();
    const end = (sceneVersion: number) =>
      socket.receive({ type: "scene.snapshot.end", sceneVersion, sha256: "0".repeat(64) });
    return {
      loader,
      emit: (e: string, v: number) => handlers[e]!({ sceneVersion: v }),
      end,
      socket,
    };
  }

  it("a broken stream asks for the snapshot only after that version's end (the relay caches it then)", () => {
    const { loader, emit, end } = setup();
    emit("badSequence", 7);
    expect(loader.requestResync).not.toHaveBeenCalled();
    end(6);
    expect(loader.requestResync).not.toHaveBeenCalled();
    end(7);
    expect(loader.requestResync).toHaveBeenCalledWith("GAP");
    expect(loader.requestResync).toHaveBeenCalledTimes(1);
  });

  it("a failure detected at end (end already seen) asks right away; an abort cancels the pending ask", () => {
    const { loader, emit, end, socket } = setup();
    end(8);
    emit("badSequence", 8);
    expect(loader.requestResync).toHaveBeenCalledTimes(1);
    emit("badSequence", 9);
    socket.receive({ type: "scene.snapshot.abort", sceneVersion: 9, reason: "SUPERSEDED" });
    end(9);
    expect(loader.requestResync).toHaveBeenCalledTimes(1);
  });

  it("a streamed snapshot counts as loaded; a bad hash asks with CHECKSUM_MISMATCH", () => {
    const { loader, emit } = setup();
    emit("ready", 4);
    expect(loader.noteLoaded).toHaveBeenCalledWith(4);
    emit("checksumMismatch", 5);
    expect(loader.requestResync).toHaveBeenCalledWith("CHECKSUM_MISMATCH");
  });
});
