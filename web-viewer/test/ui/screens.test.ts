import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D } from "three";
import { createConnection } from "../../src/protocol/connection";
import type { Connection } from "../../src/protocol/connection";
import { createReconnect } from "../../src/protocol/reconnect";
import type { SceneModel, SceneModelStore, SceneNode } from "../../src/render/scene-model";
import type { CreateViewerResult, Viewer } from "../../src/render/viewer";
import { describe as describeCode, describeState } from "../../src/state/errors";
import { createCodeEntry } from "../../src/ui/code-entry";
import type { CodeEntry } from "../../src/ui/code-entry";
import { bindScreens, PRESENTER_NOTICE_MS, UPDATING_HINT_MS } from "../../src/ui/screens";
import type { Screens } from "../../src/ui/screens";
import { FakeDocument } from "../protocol/fake-document";
import { MockSocket } from "../protocol/mock-socket";

function fakeViewer() {
  const element = document.createElement("div");
  element.className = "viewer";
  return {
    element,
    canvas: document.createElement("canvas"),
    scene: undefined as never,
    camera: undefined as never,
    controls: undefined as never,
    setModel: vi.fn<Viewer["setModel"]>(),
    fit: vi.fn<Viewer["fit"]>(),
    invalidate: vi.fn<Viewer["invalidate"]>(),
    contentChanged: vi.fn<Viewer["contentChanged"]>(),
    resize: vi.fn<Viewer["resize"]>(),
    setNotice: vi.fn<Viewer["setNotice"]>(),
    setStatus: vi.fn<Viewer["setStatus"]>(),
    focus: vi.fn<Viewer["focus"]>(),
    dispose: vi.fn<Viewer["dispose"]>(),
  } satisfies Viewer;
}

function fakeStore() {
  const handlers = new Set<(m: SceneModel | null) => void>();
  const store = {
    current: null as SceneModel | null,
    load: vi.fn<SceneModelStore["load"]>(),
    clear: vi.fn(() => store.emit(null)),
    onChange: (handler: (m: SceneModel | null) => void) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    emit(model: SceneModel | null) {
      store.current = model;
      handlers.forEach((h) => h(model));
    },
  };
  return store;
}

const joined = (sessionId = "sess_01K7Q4XMB2TJ9RD6") => ({
  type: "viewer.joined",
  sessionId,
  viewerId: "vw_1",
  viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
  sceneVersion: 1,
  snapshotVersion: 1,
  snapshotAvailable: false,
  publisherOnline: true,
  viewerCount: 1,
  viewerLimit: 20,
  profile: "mobile",
});
/** A model with one node per name (only what the screens and the node panel read). */
function fakeModel(...names: string[]): SceneModel {
  const nodes = new Map<string, SceneNode>();
  names.forEach((name, order) => {
    const nodeId = `vtkMRMLModelNode${order + 1}`;
    nodes.set(nodeId, {
      nodeId,
      order,
      T: new Object3D(),
      material: {},
      manifest: { nodeId, kind: "model", name, color: [1, 0, 0], opacity: 1, visible: true },
    } as unknown as SceneNode);
  });
  return { root: {}, nodes } as unknown as SceneModel;
}
const modelA = fakeModel("Liver", "Tumor");
const modelB = fakeModel("Kidney");

let app: HTMLElement;
let conn: Connection;
let entry: CodeEntry;
let models: ReturnType<typeof fakeStore>;
let viewer: ReturnType<typeof fakeViewer>;
let create: ReturnType<typeof vi.fn<() => CreateViewerResult>>;
let screens: Screens;
/** What `downloading()` answers: a stream or an HTTP download is running. */
let receiving = false;

function setup(options: { webgl?: boolean; viewerFails?: boolean } = {}): void {
  MockSocket.reset();
  app = document.createElement("div");
  document.body.replaceChildren(app);
  conn = createConnection({
    location: { protocol: "https:", host: "x.example", hostname: "x.example" },
    createSocket: (url) => new MockSocket(url),
    log: vi.fn(),
    lang: "en",
    heartbeatIntervalMs: 3_600_000, // these tests advance fake time a lot; the heartbeat has its own tests
  });
  models = fakeStore();
  viewer = fakeViewer();
  create = vi.fn<() => CreateViewerResult>(() =>
    options.viewerFails ? { ok: false, reason: "webgl2Unavailable" } : { ok: true, viewer },
  );
  entry = createCodeEntry({ lang: "en", onJoin: (code) => screens.join(code) });
  screens = bindScreens({
    app,
    connection: conn,
    session: createReconnect(conn, {
      random: () => 0,
      document: new FakeDocument(),
      window: new EventTarget(),
      log: vi.fn(),
      lang: "en",
    }),
    models,
    entry,
    createViewer: create,
    webGL2Available: () => options.webgl ?? true,
    downloading: () => receiving,
  });
  app.append(entry.element);
}

function join(sessionId?: string, overrides: Record<string, unknown> = {}): MockSocket {
  screens.join("7KQ4X");
  return rejoin(sessionId, overrides);
}

/** The relay accepts the newest socket's join (after `join`, or a retry of the reconnect logic). */
function rejoin(sessionId?: string, overrides: Record<string, unknown> = {}): MockSocket {
  const socket = MockSocket.last;
  socket.open();
  socket.receive({ ...joined(sessionId), ...overrides });
  return socket;
}

const TOKEN = joined().viewerToken;

const message = () => entry.element.querySelector(".code-entry__message")!.textContent ?? "";
const entryStatus = () => entry.element.querySelector(".code-entry__status")!.textContent ?? "";
const cellsEnabled = () =>
  [...entry.element.querySelectorAll("input")].every((input) => !input.disabled);
const entryVisible = () => !entry.element.hidden;
const viewerVisible = () => viewer.element.isConnected && !viewer.element.hidden;

beforeEach(() => {
  receiving = false;
  setup();
});
afterEach(() => {
  document.body.replaceChildren();
  for (const model of [modelA, modelB])
    for (const node of model.nodes.values()) node.T.visible = true;
});

describe("Join", () => {
  it("is refused at once without WebGL 2: message, no socket, no join spent", () => {
    setup({ webgl: false });
    screens.join("7KQ4X");
    expect(MockSocket.instances).toHaveLength(0);
    expect(message()).toContain(describeState({ kind: "webgl2Unavailable" }, "en").title);
  });

  it("connects with the code in the join message only", () => {
    const socket = join();
    expect(socket.frames[0]).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
  });
});

describe("screens", () => {
  it("a model on a live session replaces the code entry with the viewer and moves focus to it", () => {
    join();
    models.emit(modelA);
    expect(create).toHaveBeenCalledTimes(1);
    expect(viewerVisible()).toBe(true);
    expect(entryVisible()).toBe(false);
    expect(viewer.setModel).toHaveBeenCalledWith(modelA);
    expect(viewer.focus).toHaveBeenCalledTimes(1);
  });

  it("a first join that drops goes back to a usable code entry with 'connection lost' (Join tries again)", () => {
    screens.join("7KQ4X");
    MockSocket.last.serverClose(1006);
    expect(entryVisible()).toBe(true);
    expect(cellsEnabled()).toBe(true);
    expect(message()).toContain(describeCode(1001, "en").title);
    expect(entryStatus()).toBe("");
    expect(screens.live).toBe(false);
  });

  it("a drop before the scene is shown keeps the code entry busy with 'Reconnecting…'; a model that finishes meanwhile is shown on the rejoin", () => {
    vi.useFakeTimers();
    try {
      const socket = join();
      socket.serverClose(1006);
      expect(entryVisible()).toBe(true);
      expect(cellsEnabled()).toBe(false);
      expect(message()).toBe("");
      expect(entryStatus()).toBe("Reconnecting…");
      expect(screens.live).toBe(true);
      models.emit(modelA); // the HTTP download kept running and finished now
      expect(viewer.setModel).not.toHaveBeenCalled(); // not over a dropped session
      vi.advanceTimersByTime(500);
      rejoin(); // same session, the model is kept: shown without a new download
      expect(viewerVisible()).toBe(true);
      expect(viewer.setModel).toHaveBeenCalledWith(modelA);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a drop while the scene is shown keeps it with 'Reconnecting…'; the rejoin keeps the camera", () => {
    vi.useFakeTimers();
    try {
      const socket = join();
      models.emit(modelA);
      socket.serverClose(1006);
      expect(viewerVisible()).toBe(true);
      expect(entryVisible()).toBe(false);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Reconnecting…");
      vi.advanceTimersByTime(500);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Reconnecting…"); // still, while connecting
      const again = rejoin();
      expect(again.frames[0]).toMatchObject({ type: "viewer.join", viewerToken: TOKEN });
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Connected again"); // a cue that the link is back
      vi.advanceTimersByTime(PRESENTER_NOTICE_MS);
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
      expect(viewerVisible()).toBe(true);
      expect(viewer.setModel).toHaveBeenCalledTimes(1); // not again: the user's camera stays
      expect(viewer.resize).toHaveBeenCalled();
      expect(viewer.invalidate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new model replaces the shown one and clears an old notice", () => {
    join();
    models.emit(modelA);
    viewer.setNotice.mockClear();
    models.emit(modelB);
    expect(viewer.setModel).toHaveBeenLastCalledWith(modelB);
    expect(viewer.setNotice).toHaveBeenCalledWith(null);
  });

  it.each([
    ["the presenter ended the session (4001)", 4001],
    ["the code is no longer valid (4004)", 4004],
    ["a stop (1009)", 1009],
  ])("%s: back to a usable, focused code entry with the message", (_label, code) => {
    const socket = join();
    models.emit(modelA);
    socket.serverClose(code);
    models.emit(null); // the lifecycle drops the model on these states
    expect(entryVisible()).toBe(true);
    expect(viewerVisible()).toBe(false);
    expect(cellsEnabled()).toBe(true);
    expect(entry.element.contains(document.activeElement)).toBe(true);
    expect(message()).toContain(describeCode(code, "en").title);
  });

  it("leaving goes back to the code entry", () => {
    join();
    models.emit(modelA);
    conn.leave();
    expect(entryVisible()).toBe(true);
    expect(viewerVisible()).toBe(false);
    expect(cellsEnabled()).toBe(true);
  });

  it("a viewer that cannot be created leaves the session and says so", () => {
    setup({ viewerFails: true });
    join();
    models.emit(modelA);
    expect(conn.state.kind).toBe("idle");
    expect(entryVisible()).toBe(true);
    expect(message()).toContain(describeState({ kind: "webgl2Unavailable" }, "en").title);
  });
});

describe("node panel (WEB-09)", () => {
  const rows = () => [...viewer.element.querySelectorAll<HTMLButtonElement>(".node-panel__row")];

  it("sits in the viewer and lists the shown model; a tap there asks the viewer for a frame", () => {
    join();
    models.emit(modelA);
    expect(screens.nodePanel!.element.parentElement).toBe(viewer.element);
    expect(rows().map((r) => r.textContent)).toEqual(["Liver", "Tumor"]);
    viewer.invalidate.mockClear();
    rows()[1]!.click();
    expect(modelA.nodes.get("vtkMRMLModelNode2")!.T.visible).toBe(false);
    expect(viewer.invalidate).toHaveBeenCalledTimes(1);
  });

  it("follows a new model and empties when the model is dropped", () => {
    const socket = join();
    models.emit(modelA);
    models.emit(modelB);
    expect(rows().map((r) => r.textContent)).toEqual(["Kidney"]);
    socket.serverClose(4001);
    models.emit(null);
    expect(rows()).toHaveLength(0);
  });

  it("a rejoin with the kept model re-reads the visibility instead of rebuilding the list", () => {
    const socket = join();
    models.emit(modelA);
    const before = rows();
    socket.serverClose(1006);
    modelA.nodes.get("vtkMRMLModelNode1")!.T.visible = false;
    join();
    expect(rows()).toEqual(before); // same elements
    expect(rows()[0]!.getAttribute("aria-checked")).toBe("false");
  });
});

describe("live updates (WEB-12)", () => {
  const rows = () => [...viewer.element.querySelectorAll<HTMLButtonElement>(".node-panel__row")];

  it("a change redraws and refreshes the node rows; nothing new changes nothing", () => {
    join();
    models.emit(modelA);
    modelA.nodes.get("vtkMRMLModelNode1")!.T.visible = false; // what the live scene did
    screens.sceneChanged({ changed: true, removed: false });
    expect(viewer.contentChanged).toHaveBeenCalledTimes(1);
    expect(rows()[0]!.getAttribute("aria-checked")).toBe("false");
    viewer.contentChanged.mockClear();
    screens.sceneChanged({ changed: false, removed: false });
    expect(viewer.contentChanged).not.toHaveBeenCalled();
  });

  it("a removal rebuilds the rows from the model", () => {
    join();
    const model = fakeModel("Liver", "Tumor");
    models.emit(model);
    (model.nodes as Map<string, unknown>).delete("vtkMRMLModelNode2");
    screens.sceneChanged({ changed: true, removed: true });
    expect(rows().map((r) => r.textContent)).toEqual(["Liver"]);
  });

  it("before a scene is shown nothing happens", () => {
    screens.sceneChanged({ changed: true, removed: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("the hint goes after a while when no snapshot is announced, and waits as long as needed when one is", () => {
    vi.useFakeTimers();
    try {
      join();
      models.emit(modelA);
      screens.updating(true);
      vi.advanceTimersByTime(UPDATING_HINT_MS - 1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
      vi.advanceTimersByTime(1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null); // the relay refused it: nothing comes
      screens.updating(true);
      screens.snapshotComing(); // scene.snapshot.begin
      vi.advanceTimersByTime(UPDATING_HINT_MS * 10); // a large snapshot on a slow link
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
      screens.updating(false); // shown or abandoned (the new model is covered below)
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the 'updating' hint shows on scene.nodeAdded and goes with the next model", () => {
    join();
    models.emit(modelA);
    screens.updating(true);
    expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
    models.emit(modelB);
    expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
    screens.updating(true);
    screens.updating(false); // the snapshot will not come
    expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
  });
});

describe("presenter notice (WEB-13)", () => {
  it("names the node for 3 s, over the 'updating' hint, which comes back after it", () => {
    vi.useFakeTimers();
    try {
      join();
      models.emit(modelA);
      screens.updating(true);
      screens.snapshotComing();
      screens.presenterChanged(["vtkMRMLModelNode2"]);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("The presenter changed Tumor");
      vi.advanceTimersByTime(PRESENTER_NOTICE_MS - 1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("The presenter changed Tumor");
      vi.advanceTimersByTime(1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
      screens.presenterChanged(["vtkMRMLModelNode1", "vtkMRMLModelNode2"]);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("The presenter changed 2 structures");
      models.emit(modelB); // a new scene: both messages were about the old one
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
      vi.advanceTimersByTime(PRESENTER_NOTICE_MS);
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing to name or no scene: no notice", () => {
    screens.presenterChanged(["vtkMRMLModelNode1"]);
    join();
    models.emit(modelA);
    viewer.setStatus.mockClear();
    screens.presenterChanged([]);
    expect(viewer.setStatus).not.toHaveBeenCalled();
    screens.presenterChanged(["vtkMRMLModelNode9"]); // removed in the same scene.state
    expect(viewer.setStatus).not.toHaveBeenCalled();
  });

  it("a node no longer in the scene is not counted", () => {
    join();
    models.emit(modelA);
    screens.presenterChanged(["vtkMRMLModelNode9", "vtkMRMLModelNode2"]);
    expect(viewer.setStatus).toHaveBeenLastCalledWith("The presenter changed Tumor");
  });
});

describe("a snapshot that could not be loaded (WEB-10)", () => {
  const failed = describeState({ kind: "snapshotFailed" }, "en");
  const updateFailed = describeState({ kind: "snapshotUpdateFailed" }, "en");

  it("before anything is shown: leaves the session, keeps the code typed, and Join tries again", () => {
    const joinButton = entry.element.querySelector<HTMLButtonElement>(".code-entry__join")!;
    entry.element.querySelector("input")!.focus();
    for (const ch of "7KQ4X") {
      const cell = document.activeElement as HTMLInputElement;
      cell.value = ch;
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    }
    joinButton.click();
    MockSocket.last.open();
    MockSocket.last.receive(joined());
    expect(cellsEnabled()).toBe(false); // "Joining…" while the scene downloads
    screens.failSnapshot();
    expect(conn.state.kind).toBe("idle");
    expect(cellsEnabled()).toBe(true);
    expect(message()).toContain(failed.title);
    expect(entry.element.contains(document.activeElement)).toBe(true);
    const typed = [...entry.element.querySelectorAll("input")].map((input) => input.value).join("");
    expect(typed).toBe("7KQ4X");
    joinButton.click();
    expect(MockSocket.instances).toHaveLength(2);
    MockSocket.last.open();
    expect(MockSocket.last.frames[0]).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
  });

  it("while a scene is shown: a notice over it (no Join there), the session and the scene stay", () => {
    join();
    models.emit(modelA);
    screens.failSnapshot();
    expect(viewer.setNotice).toHaveBeenLastCalledWith(updateFailed);
    expect(updateFailed.body).not.toMatch(/Join/);
    expect(conn.state.kind).toBe("connected");
    expect(viewerVisible()).toBe(true);
  });

  it("a late failure while not connected changes nothing: no new join is cancelled, no message replaced", () => {
    const socket = join();
    socket.serverClose(1006);
    const lost = message();
    screens.failSnapshot(); // the old download gave up after the drop
    expect(message()).toBe(lost);
    screens.join("7KQ4X"); // the user joins again
    screens.failSnapshot();
    expect(conn.state.kind).toBe("connecting");
    expect(MockSocket.last.closedWith).toBeUndefined();
  });
});

describe("messages go where the user is looking", () => {
  it("over the scene while it is shown, on the code entry otherwise", () => {
    const tooLarge = describeState({ kind: "snapshotTooLarge" }, "en");
    screens.report(tooLarge);
    expect(message()).toContain(tooLarge.title);
    join();
    models.emit(modelA);
    const invalid = describeState({ kind: "snapshotInvalid" }, "en");
    screens.report(invalid);
    expect(viewer.setNotice).toHaveBeenLastCalledWith(invalid);
  });
});

describe("reconnecting and the presenter (WEB-14)", () => {
  it("joined without a scene: 'Waiting for the presenter', then 'Loading the scene…' while one comes", () => {
    join();
    expect(entryStatus()).toBe("Waiting for the presenter");
    receiving = true;
    screens.snapshotComing(); // scene.snapshot.begin, the stream took it
    expect(entryStatus()).toBe("Loading the scene…");
    receiving = false;
    screens.updating(false); // abandoned (aborted, damaged)
    expect(entryStatus()).toBe("Waiting for the presenter");
    models.emit(modelA);
    expect(viewerVisible()).toBe(true);
    expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
  });

  it("an announced snapshot refused at once (too large) does not say 'Loading the scene…'", () => {
    join();
    screens.updating(false); // the stream refused it while handling scene.snapshot.begin …
    screens.snapshotComing(); // … before the screens heard of the begin
    expect(entryStatus()).toBe("Waiting for the presenter");
  });

  it("joined: 'Loading the scene…' only when a download really started", () => {
    receiving = true; // the loader fetches the announced snapshot
    join(undefined, { snapshotAvailable: true });
    expect(entryStatus()).toBe("Loading the scene…");
    conn.leave();
    receiving = false; // announced, but the loader has it already (or asks for scene.snapshot.ready)
    join(undefined, { snapshotAvailable: true });
    expect(entryStatus()).toBe("Waiting for the presenter");
  });

  it("an 'updating' hint whose snapshot died with the old socket goes after the usual wait once rejoined", () => {
    vi.useFakeTimers();
    try {
      const socket = join();
      models.emit(modelA);
      screens.updating(true); // scene.nodeAdded
      screens.snapshotComing(); // its begin: the hint waits however long the stream takes
      socket.serverClose(1006); // the stream is cut
      vi.advanceTimersByTime(500);
      rejoin(); // the relay has nothing newer: no download
      vi.advanceTimersByTime(UPDATING_HINT_MS - 1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
      vi.advanceTimersByTime(1);
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejoin that downloads the announced snapshot keeps the hint", () => {
    vi.useFakeTimers();
    try {
      const socket = join();
      models.emit(modelA);
      screens.updating(true);
      screens.snapshotComing();
      socket.serverClose(1006);
      vi.advanceTimersByTime(500);
      receiving = true;
      rejoin();
      vi.advanceTimersByTime(UPDATING_HINT_MS * 5);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Updating the scene…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the presenter offline is said over the scene and on the waiting code entry (§4.6)", () => {
    const socket = join(undefined, { publisherOnline: false });
    expect(entryStatus()).toBe("Presenter is offline");
    models.emit(modelA);
    expect(viewer.setStatus).toHaveBeenLastCalledWith("Presenter is offline");
    screens.presenterChanged(["vtkMRMLModelNode2"]);
    expect(viewer.setStatus).toHaveBeenLastCalledWith("Presenter is offline"); // the more important line
    socket.receive({ type: "session.publisherState", online: true });
    expect(viewer.setStatus).toHaveBeenLastCalledWith("The presenter changed Tumor");
    socket.receive({ type: "session.publisherState", online: false, graceEndsAt: 1 });
    expect(viewer.setStatus).toHaveBeenLastCalledWith("Presenter is offline");
  });

  it("reconnecting wins over 'presenter offline' and goes with the rejoin", () => {
    vi.useFakeTimers();
    try {
      const socket = join(undefined, { publisherOnline: false });
      models.emit(modelA);
      socket.serverClose(1006);
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Reconnecting…");
      vi.advanceTimersByTime(500);
      rejoin(undefined, { publisherOnline: true });
      expect(viewer.setStatus).toHaveBeenLastCalledWith("Connected again");
      vi.advanceTimersByTime(PRESENTER_NOTICE_MS);
      expect(viewer.setStatus).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the end of the session clears every status and says why on the code entry", () => {
    const socket = join(undefined, { publisherOnline: false });
    socket.receive({
      type: "session.closed",
      sessionId: joined().sessionId,
      reason: "PUBLISHER_CLOSED",
    });
    socket.serverClose(4001);
    expect(entryStatus()).toBe("");
    expect(message()).toContain(describeCode(4001, "en").title);
    expect(cellsEnabled()).toBe(true);
  });

  it("a session lost in a relay restart and not re-created ends with 'Presentation ended' (US-12)", () => {
    vi.useFakeTimers();
    try {
      join();
      MockSocket.last.serverClose(4008);
      vi.advanceTimersByTime(3_000);
      const tokenJoin = MockSocket.last;
      tokenJoin.open();
      tokenJoin.receive({
        type: "error",
        code: "SESSION_NOT_FOUND",
        message: "x",
        retryable: false,
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        vi.advanceTimersToNextTimer();
        const s = MockSocket.last;
        s.open();
        expect(s.frames[0]).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
        s.receive({ type: "error", code: "INVALID_CODE", message: "x", retryable: false });
        s.serverClose(4004);
        if (attempt < 3) {
          expect(entryStatus()).toBe("Reconnecting…");
          expect(message()).toBe("");
        }
      }
      expect(message()).toContain(describeCode("SESSION_CLOSED", "en").title);
      expect(entryStatus()).toBe("");
      expect(cellsEnabled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
