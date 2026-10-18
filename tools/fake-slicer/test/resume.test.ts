import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnvelope } from "@slicerremoteview/shared";
import {
  DEFAULT_TIMING,
  EXIT,
  FATAL_CLOSE_CODES,
  Heartbeat,
  main,
  reconnectDelayMs,
  startRelayStub,
} from "../src/index.js";
import type { Io, RelayStub, Timing } from "../src/index.js";
import { TestViewer } from "./viewer.js";

describe("Heartbeat (PRO-16, fake timers)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("pings every 15 s and times out 10 s after an unanswered ping (§9.1)", () => {
    const pings: string[] = [];
    const onTimeout = vi.fn();
    const heartbeat = new Heartbeat(DEFAULT_TIMING, (id) => void pings.push(id), onTimeout);
    heartbeat.start();
    vi.advanceTimersByTime(14_999);
    expect(pings).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual(["hb-1"]);
    vi.advanceTimersByTime(9_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1); // stopped after the timeout; the caller reconnects
    heartbeat.stop();
  });

  it("a matching pong keeps the link alive, a foreign replyTo does not", () => {
    const pings: string[] = [];
    const onTimeout = vi.fn();
    const heartbeat = new Heartbeat(DEFAULT_TIMING, (id) => void pings.push(id), onTimeout);
    heartbeat.start();
    vi.advanceTimersByTime(15_000);
    heartbeat.onPong("hb-99");
    heartbeat.onPong(undefined);
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    heartbeat.start();
    pings.length = 0;
    for (let round = 0; round < 4; round++) {
      vi.advanceTimersByTime(15_000);
      heartbeat.onPong(pings.at(-1));
    }
    expect(pings).toHaveLength(4);
    expect(onTimeout).toHaveBeenCalledTimes(1); // still only the first, unanswered one
    heartbeat.stop();
  });
});

describe("reconnect delays (PRO-16)", () => {
  const timing = (random: number): Timing => ({ ...DEFAULT_TIMING, random: () => random });

  it("4008 reconnects after 0–3 s (§9.3)", () => {
    expect(reconnectDelayMs(4008, 0, timing(0))).toBe(0);
    expect(reconnectDelayMs(4008, 5, timing(0.999))).toBeLessThan(3000);
    expect(reconnectDelayMs(4008, 5, timing(0.5))).toBe(1500);
  });

  it("everything else backs off 0.5 s → 30 s with jitter (§9.1)", () => {
    const caps = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
    caps.forEach((cap, attempt) => {
      expect(reconnectDelayMs(1006, attempt, timing(0))).toBe(cap / 2);
      expect(reconnectDelayMs(1006, attempt, timing(0.999))).toBeLessThanOrEqual(cap);
      expect(reconnectDelayMs(1006, attempt, timing(0.999))).toBeGreaterThan(cap * 0.99);
    });
  });

  it("does not reconnect after session end, auth or replacement closes", () => {
    for (const code of [1008, 1009, 4000, 4001, 4002, 4003, 4011])
      expect(FATAL_CLOSE_CODES.has(code)).toBe(true);
    for (const code of [1006, 1011, 4007, 4008, 4009, 4010, 4012])
      expect(FATAL_CLOSE_CODES.has(code)).toBe(false);
  });
});

describe("publisher resilience against the stub (PRO-16)", () => {
  let stub: RelayStub | undefined;
  const viewers: TestViewer[] = [];
  afterEach(async () => {
    for (const viewer of viewers.splice(0)) viewer.close();
    await stub?.close();
    stub = undefined;
  });

  const fast: Partial<Timing> = {
    backoffMinMs: 10,
    backoffMaxMs: 40,
    drainJitterMs: 50,
    random: () => 0.5,
  };

  /** Runs the CLI against the stub; `fd` collects the `--code-fd` lines, `abort()` ends the run like Ctrl-C. */
  function start(argv: string[], timing: Partial<Timing> = fast) {
    const controller = new AbortController();
    const err: string[] = [];
    const fd: string[] = [];
    const io: Io = {
      stdout: () => undefined,
      stderr: (text) => void err.push(text),
      writeFd: (_fd, text) => void fd.push(text),
      signal: controller.signal,
      timing,
    };
    const running = main(["--relay", stub!.url, "--code-fd", "3", ...argv], io);
    return { running, err, fd, abort: () => controller.abort() };
  }
  const types = (): string[] =>
    stub!.publisherFrames
      .filter((f) => !f.binary)
      .map((f) => String((JSON.parse(f.data.toString()) as { type: string }).type));
  const wait = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
  const dir = mkdtempSync(join(tmpdir(), "fake-slicer-resume-"));
  let scripts = 0;
  const scriptFile = (entries: unknown): string => {
    const file = join(dir, `s${++scripts}.json`);
    writeFileSync(file, JSON.stringify(entries));
    return file;
  };

  it("close 4008 → reconnects within 3 s with session.resume and keeps the code (§9.3, §4.3)", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000 });
    const file = scriptFile([
      {
        afterMs: 150,
        type: "scene.update",
        changes: [{ nodeId: "vtkMRMLModelNode2", visible: false }],
      },
    ]);
    const run = start(["--script", file], { ...DEFAULT_TIMING, random: () => 0.5 }); // 4008 → 1.5 s
    await wait(() => expect(types()).toContain("scene.snapshot.end"));
    const code = stub.code;
    const closedAt = Date.now();
    stub.closePublisher(4008);
    await wait(() => expect(stub!.handshakes).toHaveLength(2));
    expect(Date.now() - closedAt).toBeLessThan(3000);
    const [create, resume] = stub.handshakes;
    expect(create).toMatchObject({ type: "session.create" });
    expect(resume).toMatchObject({ type: "session.resume", lastSceneVersion: 1 });
    expect(resume!["sessionId"]).toMatch(/^sess_/);
    expect(resume!["publisherToken"]).toMatch(/^pt_/);
    expect(parseEnvelope(JSON.stringify(resume)).ok).toBe(true);
    expect(stub.code).toBe(code);
    // no second snapshot: the relay still held version 1; the script's update continues at 2
    await wait(() => expect(types()).toContain("scene.update"));
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(types().filter((t) => t === "scene.snapshot.begin")).toHaveLength(1);
    expect(stub.versionViolations).toEqual([]);
    expect(run.err.join("")).toContain("reconnecting in");
  });

  it("SESSION_NOT_FOUND → session.create with the old code as preferredCode, snapshot restarts at version 1 (§4.3, §8.4)", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000 });
    const run = start(["--json"]);
    await wait(() => expect(types()).toContain("scene.snapshot.end"));
    const code = stub.code!;
    stub.restart(); // relay redeploy: close 4008, registry empty
    await wait(() => expect(stub!.handshakes).toHaveLength(3));
    expect(stub.handshakes.map((h) => h["type"])).toEqual([
      "session.create",
      "session.resume",
      "session.create",
    ]);
    expect(stub.handshakes[2]!["preferredCode"]).toBe(code);
    await wait(() => expect(types().filter((t) => t === "scene.snapshot.end")).toHaveLength(2));
    expect(stub.code).toBe(code); // the stub granted the same code again
    const begins = stub.publisherFrames
      .filter((f) => !f.binary)
      .map((f) => JSON.parse(f.data.toString()) as { type: string; sceneVersion?: number })
      .filter((m) => m.type === "scene.snapshot.begin");
    expect(begins.map((b) => b.sceneVersion)).toEqual([1, 1]);
    expect(stub.versionViolations).toEqual([]);
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(run.fd.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ code }),
      { event: "session.recreated", codeChanged: false },
    ]);
    expect(run.err.join("")).not.toContain(code);
  });

  it("a snapshot cut off by the drop is re-sent after the resume as the next version (§4.3)", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000, dropPublisherAfterChunks: 3 });
    const run = start(["--fixture", "large-synthetic.glb", "--chunk-size", "65536"]);
    await wait(() => expect(stub!.handshakes).toHaveLength(2));
    await wait(() => expect(types().filter((t) => t === "scene.snapshot.end")).toHaveLength(1));
    const begins = stub.publisherFrames
      .filter((f) => !f.binary)
      .map((f) => JSON.parse(f.data.toString()) as { type: string; sceneVersion?: number })
      .filter((m) => m.type === "scene.snapshot.begin");
    expect(begins.map((b) => b.sceneVersion)).toEqual([1, 2]);
    expect(stub.handshakes[1]).toMatchObject({ type: "session.resume", lastSceneVersion: 1 });
    expect(stub.versionViolations).toEqual([]);
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
  });

  it("a snapshot of a script cut off by a close frame is re-sent after the resume (no 'script failed')", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000, dropPublisherAfterChunks: 5 });
    const file = scriptFile([
      { afterMs: 20, type: "scene.snapshot", fixture: "large-synthetic.glb" },
    ]);
    const run = start(["--script", file, "--chunk-size", "65536"]);
    await wait(() => expect(stub!.handshakes).toHaveLength(2));
    await wait(() => expect(types().filter((t) => t === "scene.snapshot.end")).toHaveLength(2));
    expect(stub.handshakes[1]).toMatchObject({ type: "session.resume", lastSceneVersion: 2 });
    const begins = stub.publisherFrames
      .filter((f) => !f.binary)
      .map(
        (f) =>
          JSON.parse(f.data.toString()) as {
            type: string;
            sceneVersion?: number;
            byteLength?: number;
          },
      )
      .filter((m) => m.type === "scene.snapshot.begin");
    expect(begins.map((b) => b.sceneVersion)).toEqual([1, 2, 3]);
    expect(begins[2]!.byteLength).toBe(begins[1]!.byteLength); // the interrupted scene, not the first one
    expect(stub.versionViolations).toEqual([]);
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(run.err.join("")).not.toContain("script failed");
  });

  it("publishes a fresh code when the relay does not grant the old one (§4.1)", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000, ignorePreferredCode: true });
    const run = start(["--json"]);
    await wait(() => expect(types()).toContain("scene.snapshot.end"));
    const first = stub.code!;
    stub.restart();
    await wait(() => expect(run.fd.length).toBeGreaterThanOrEqual(3));
    const lines = run.fd.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[1]).toEqual({ event: "session.recreated", codeChanged: true });
    expect(lines[2]).toMatchObject({ code: stub.code });
    expect(stub.code).not.toBe(first);
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(run.err.join("")).not.toContain(stub.code!);
  });

  it("a missing pong triggers a reconnect (§9.1)", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000, answerPings: false });
    const run = start([], { ...fast, pingIntervalMs: 60, pongTimeoutMs: 60 });
    await wait(() => expect(stub!.handshakes.length).toBeGreaterThanOrEqual(2));
    expect(stub.pings).toBeGreaterThanOrEqual(1);
    expect(stub.handshakes[1]).toMatchObject({ type: "session.resume" });
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(run.err.join("")).toContain("no pong in time");
  });

  it("answered pings keep one connection", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000 });
    const run = start([], { ...fast, pingIntervalMs: 20, pongTimeoutMs: 200 });
    await wait(() => expect(stub!.pings).toBeGreaterThanOrEqual(3));
    expect(stub.handshakes).toHaveLength(1);
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
  });

  it("--disconnect-after drops the socket once and the publisher resumes", async () => {
    stub = await startRelayStub({ publisherGraceMs: 5000 });
    const run = start(["--disconnect-after", "50"]);
    await wait(() => expect(stub!.handshakes).toHaveLength(2));
    expect(stub.handshakes[1]).toMatchObject({ type: "session.resume" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stub.handshakes).toHaveLength(2); // once
    run.abort();
    expect(await run.running).toBe(EXIT.ok);
    expect(run.err.join("")).toContain("--disconnect-after");
  });

  it("does not reconnect after a fatal close and exits 2", async () => {
    for (const closeCode of [4001, 4003, 4011]) {
      stub = await startRelayStub({ publisherGraceMs: 5000 });
      const run = start([]);
      await wait(() => expect(types()).toContain("scene.snapshot.end"));
      stub.closePublisher(closeCode);
      expect(await run.running).toBe(EXIT.relayError);
      expect(run.err.join("")).toContain(`code ${closeCode}); not reconnecting`);
      expect(stub.handshakes).toHaveLength(1);
      await stub.close();
    }
    stub = undefined;
  });

  it("--late-join-test waits for the viewers, sends one update, exits 0", async () => {
    stub = await startRelayStub();
    const run = start(["--late-join-test", "--late-join-viewers", "2", "--json"]);
    await wait(() => expect(types()).toContain("scene.snapshot.end")); // the snapshot is long gone: a late join
    const code = stub.code!;
    viewers.push(await TestViewer.join(stub.url, code));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(types()).not.toContain("scene.update"); // one viewer is not enough
    viewers.push(await TestViewer.join(stub.url, code));
    expect(await run.running).toBe(EXIT.ok);
    const update = stub.publisherFrames
      .filter((f) => !f.binary)
      .map((f) => JSON.parse(f.data.toString()) as Record<string, unknown>)
      .find((m) => m["type"] === "scene.update");
    expect(update).toMatchObject({
      sceneVersion: 2,
      baseVersion: 1,
      changes: [{ nodeId: "vtkMRMLSegmentationNode1/Segment_1", visible: false }],
    });
    expect(parseEnvelope(JSON.stringify(update)).ok).toBe(true);
    expect(stub.versionViolations).toEqual([]);
    await wait(() => expect(viewers[1]!.messages("scene.update")).toHaveLength(1));
    for (const frame of viewers[1]!.frames.filter((f) => !f.binary))
      expect(parseEnvelope(frame.data.toString()).ok, frame.data.toString()).toBe(true); // the stub speaks the schema
    expect(run.err.join("")).not.toContain("invalid message");
    // --json: first line {code,url}, then one event per viewer.count
    const lines = run.fd.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ code });
    expect(lines.slice(1)).toEqual([
      { event: "viewer.count", count: 1 },
      { event: "viewer.count", count: 2 },
    ]);
  });
});
