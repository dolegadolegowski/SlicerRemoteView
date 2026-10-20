import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/protocol/connection";
import {
  bindSceneVersions,
  createSceneVersions,
  parseChange,
  parseNodeIds,
} from "../../src/protocol/scene-versions";
import type { LiveMessage, SceneVersions, StateMessage } from "../../src/protocol/scene-versions";
import { MockSocket } from "./mock-socket";

const LIVER = "vtkMRMLSegmentationNode1/Segment_1";
const update = (sceneVersion: number, baseVersion: number): LiveMessage => ({
  protocolVersion: "1.0",
  type: "scene.update",
  sceneVersion,
  baseVersion,
  changes: [{ nodeId: LIVER, visible: sceneVersion % 2 === 0 }],
});
const state = (sceneVersion: number, snapshotVersion: number | null): StateMessage => ({
  protocolVersion: "1.0",
  type: "scene.state",
  sceneVersion,
  snapshotVersion,
  nodes: [],
  removed: [],
});

let applied: number[];
let states: number[];
let requests: string[];
let versions: SceneVersions;

beforeEach(() => {
  applied = [];
  states = [];
  requests = [];
  versions = createSceneVersions({
    apply: (m) => applied.push(m.sceneVersion),
    applyState: (s) => states.push(s.sceneVersion),
    requestResync: (reason) => requests.push(reason),
    maxQueued: 4,
  });
});

describe("parseChange (defs.schema.json nodeChange)", () => {
  it.each([
    [{ nodeId: LIVER, visible: false }],
    [{ nodeId: "vtkMRMLModelNode3", color: [0.95, 0.85, 0.7], opacity: 0.35 }],
    [
      {
        nodeId: "vtkMRMLModelNode5",
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.012, -0.004, 0, 1],
      },
    ],
  ])("accepts %j", (item) => {
    expect(parseChange(item)).toEqual(item);
  });

  it.each([
    ["no property", { nodeId: LIVER }],
    ["no nodeId", { visible: true }],
    ["a bad nodeId", { nodeId: "a b", visible: true }],
    ["a too long nodeId", { nodeId: "a".repeat(129), visible: true }],
    ["a non-boolean visible", { nodeId: LIVER, visible: "no" }],
    ["a colour out of range", { nodeId: LIVER, color: [1.2, 0, 0] }],
    ["a colour of two", { nodeId: LIVER, color: [1, 0] }],
    ["an opacity out of range", { nodeId: LIVER, opacity: -0.1 }],
    ["a matrix of 15", { nodeId: LIVER, matrix: new Array(15).fill(0) }],
    ["a matrix with a string", { nodeId: LIVER, matrix: [...new Array(15).fill(0), "1"] }],
    ["a matrix with Infinity", { nodeId: LIVER, matrix: [...new Array(15).fill(0), Infinity] }],
    ["not an object", [LIVER]],
    ["null", null],
  ])("refuses %s", (_label, item) => {
    expect(parseChange(item)).toBeNull();
  });

  it("drops fields it does not know (a name never travels in updates, §8.3)", () => {
    expect(parseChange({ nodeId: LIVER, visible: true, name: "Patient X" })).toEqual({
      nodeId: LIVER,
      visible: true,
    });
  });

  it("parseNodeIds keeps the valid ids only", () => {
    expect(parseNodeIds([LIVER, 7, "", "x y", "vtkMRMLModelNode2"])).toEqual([
      LIVER,
      "vtkMRMLModelNode2",
    ]);
  });
});

describe("version monotonicity (§8.3, FR-41, FR-42)", () => {
  it("snapshot 1 → update(2, base 1) → update(4, base 3): the gap is not applied, one scene.request, then state 4 resumes", () => {
    versions.shown(1);
    versions.live(update(2, 1));
    expect(applied).toEqual([2]);
    versions.live(update(4, 3));
    versions.live(update(5, 4)); // also waits for the state
    expect(applied).toEqual([2]);
    expect(requests).toEqual(["GAP"]);
    versions.state(state(4, 1));
    expect(states).toEqual([4]);
    expect(applied).toEqual([2, 5]); // 4 is in the state; 5 continues it
    expect(versions.sceneVersion).toBe(5);
    versions.live(update(6, 5));
    expect(applied).toEqual([2, 5, 6]);
    expect(requests).toEqual(["GAP"]);
  });

  it("the empty scene.state right after viewer.joined sets the version and applies nothing", () => {
    versions.joined();
    versions.state(state(0, null));
    expect(versions.sceneVersion).toBe(0);
    expect(states).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("an update that is already contained in what is shown is skipped, not a gap", () => {
    versions.shown(3);
    versions.live(update(3, 2));
    versions.live(update(2, 1));
    expect(applied).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("updates while the scene is still loading (architecture §7 'queued')", () => {
  it("a late joiner: the state waits for its GLB, queued updates follow it in order", () => {
    versions.joined();
    versions.state(state(42, 40));
    versions.live(update(43, 42));
    versions.live(update(44, 43));
    expect(applied).toEqual([]);
    versions.shown(40);
    expect(states).toEqual([42]);
    expect(applied).toEqual([43, 44]);
    expect(requests).toEqual([]);
  });

  it("a streamed snapshot: updates after its end wait until it is parsed and shown", () => {
    versions.shown(5);
    versions.expect(6);
    versions.live(update(7, 6));
    expect(applied).toEqual([]);
    versions.shown(6);
    expect(applied).toEqual([7]);
    expect(versions.sceneVersion).toBe(7);
  });

  it("a snapshot that will not be shown: back to the old scene, the first foreign update asks once", () => {
    versions.shown(5);
    versions.expect(6);
    versions.live(update(7, 6));
    versions.live(update(8, 7));
    versions.abandon(6);
    expect(applied).toEqual([]);
    expect(requests).toEqual(["GAP"]);
    versions.live(update(9, 8));
    expect(requests).toEqual(["GAP"]);
  });

  it("too far behind: the backlog is dropped and the scene shown catches up through one request", () => {
    versions.joined();
    versions.state(state(10, 10));
    for (let v = 11; v <= 20; v++) versions.live(update(v, v - 1)); // more than maxQueued (4)
    versions.shown(10);
    expect(states).toEqual([10]);
    expect(applied).toEqual([]); // what is left of the backlog does not continue version 10
    expect(requests).toEqual(["GAP"]);
    versions.live(update(21, 20));
    expect(requests).toEqual(["GAP"]); // one request until the state answers
  });
});

describe("states that do not fit", () => {
  it("a state older than the version shown is not applied (it would undo newer changes)", () => {
    versions.shown(1);
    versions.live(update(2, 1));
    versions.live(update(3, 2));
    versions.state(state(2, 1));
    expect(states).toEqual([]);
    versions.live(update(4, 3));
    expect(applied).toEqual([2, 3, 4]);
  });

  it("a state about an older snapshot than the one shown is ignored; one about a newer one waits for it", () => {
    versions.shown(5);
    versions.state(state(4, 3));
    expect(states).toEqual([]);
    versions.state(state(8, 7));
    versions.live(update(9, 8));
    expect(applied).toEqual([]);
    versions.shown(7);
    expect(states).toEqual([8]);
    expect(applied).toEqual([9]);
  });

  it("a rejoin forgets a snapshot that was in flight when the connection dropped (it is announced again)", () => {
    versions.shown(1);
    versions.expect(3); // scene.snapshot.begin, then the socket drops mid-stream
    versions.joined(); // the same session again; snapshot 3 was aborted meanwhile
    versions.state(state(2, 1));
    versions.live(update(4, 2));
    expect(applied).toEqual([4]);
  });

  it("reset forgets everything (session over)", () => {
    versions.shown(5);
    versions.reset();
    expect(versions.sceneVersion).toBeNull();
    versions.live(update(6, 5));
    expect(applied).toEqual([]);
  });
});

const joinedMessage = (sessionId: string) => ({
  type: "viewer.joined",
  sessionId,
  viewerId: "vw_1",
  viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  sceneVersion: 1,
  snapshotVersion: 1,
  snapshotAvailable: true,
  publisherOnline: true,
  viewerCount: 1,
  viewerLimit: 20,
  profile: "mobile",
});

describe("bindSceneVersions", () => {
  it("another session starts from nothing, even when none of the first one was shown", () => {
    MockSocket.reset();
    const connection = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
      lang: "en",
    });
    bindSceneVersions(connection, versions);
    connection.connect({ code: "7KQ4X" });
    MockSocket.last.open();
    MockSocket.last.receive(joinedMessage("sess_AAAAAAAAAAAAAAAA"));
    MockSocket.last.receive({ ...state(1, 1) });
    MockSocket.last.receive({ ...update(2, 1) }); // A's update waits for A's GLB, which never shows
    connection.connect({ code: "AB2CD" }); // another session (a deep link opened in the same tab)
    MockSocket.last.open();
    MockSocket.last.receive(joinedMessage("sess_BBBBBBBBBBBBBBBB"));
    MockSocket.last.receive({ ...state(1, 1) });
    versions.shown(1); // B's GLB
    expect(applied).toEqual([]); // not A's update
    MockSocket.last.receive({ ...update(2, 1) });
    expect(applied).toEqual([2]); // B's own update 2 is not taken for "already contained"
    expect(requests).toEqual([]);
  });

  it("routes the connection's messages and resets when the session ends", () => {
    MockSocket.reset();
    const connection = createConnection({
      location: { protocol: "https:", host: "x.example", hostname: "x.example" },
      createSocket: (url) => new MockSocket(url),
      log: vi.fn(),
      lang: "en",
    });
    const calls: string[] = [];
    const spy: SceneVersions = {
      sceneVersion: null,
      joined: () => calls.push("joined"),
      expect: (v) => calls.push(`expect ${v}`),
      abandon: (v) => calls.push(`abandon ${v}`),
      shown: () => calls.push("shown"),
      state: (m) => calls.push(`state ${m.sceneVersion}`),
      live: (m) => calls.push(`${m.type} ${m.sceneVersion}`),
      reset: () => calls.push("reset"),
    };
    bindSceneVersions(connection, spy);
    connection.connect({ code: "7KQ4X" });
    const socket = MockSocket.last;
    socket.open();
    socket.receive({
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
    });
    socket.receive({
      type: "scene.state",
      sceneVersion: 0,
      snapshotVersion: null,
      nodes: [],
      removed: [],
    });
    socket.receive({
      type: "scene.snapshot.begin",
      sceneVersion: 1,
      byteLength: 3400,
      sha256: "2a3bb2bcf4ae09c2bebda8e29dbfb9f3ef18324f95790ca8e2accef95829e89c",
      chunkCount: 1,
      chunkSize: 65536,
      format: "glb",
      extensionsUsed: [],
    });
    socket.receive({ type: "scene.snapshot.abort", sceneVersion: 1, reason: "SUPERSEDED" });
    socket.receive({
      type: "scene.update",
      sceneVersion: 2,
      baseVersion: 1,
      changes: [{ nodeId: LIVER, visible: false }],
    });
    socket.receive({
      type: "scene.nodeRemoved",
      sceneVersion: 3,
      baseVersion: 2,
      nodeIds: [LIVER],
    });
    socket.receive({
      type: "scene.nodeAdded",
      sceneVersion: 4,
      baseVersion: 3,
      nodes: [{ nodeId: "vtkMRMLModelNode9", kind: "model" }],
      snapshotFollows: true,
    });
    socket.serverClose(4001);
    expect(calls).toEqual([
      "joined",
      "state 0",
      "expect 1",
      "abandon 1",
      "scene.update 2",
      "scene.nodeRemoved 3",
      "scene.nodeAdded 4",
      "reset",
    ]);
  });
});
