import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D } from "three";
import { createConnection } from "../../src/protocol/connection";
import type { Connection } from "../../src/protocol/connection";
import type { SceneModel, SceneModelStore, SceneNode } from "../../src/render/scene-model";
import type { CreateViewerResult, Viewer } from "../../src/render/viewer";
import { describe as describeCode, describeState } from "../../src/state/errors";
import { createCodeEntry } from "../../src/ui/code-entry";
import type { CodeEntry } from "../../src/ui/code-entry";
import { bindScreens, PRESENTER_NOTICE_MS, UPDATING_HINT_MS } from "../../src/ui/screens";
import type { Screens } from "../../src/ui/screens";
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

function setup(options: { webgl?: boolean; viewerFails?: boolean } = {}): void {
  MockSocket.reset();
  app = document.createElement("div");
  document.body.replaceChildren(app);
  conn = createConnection({
    location: { protocol: "https:", host: "x.example", hostname: "x.example" },
    createSocket: (url) => new MockSocket(url),
    log: vi.fn(),
    lang: "en",
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
    models,
    entry,
    createViewer: create,
    webGL2Available: () => options.webgl ?? true,
  });
  app.append(entry.element);
}

function join(sessionId?: string): MockSocket {
  screens.join("7KQ4X");
  const socket = MockSocket.last;
  socket.open();
  socket.receive(joined(sessionId));
  return socket;
}

const message = () => entry.element.querySelector(".code-entry__message")!.textContent ?? "";
const cellsEnabled = () =>
  [...entry.element.querySelectorAll("input")].every((input) => !input.disabled);
const entryVisible = () => !entry.element.hidden;
const viewerVisible = () => viewer.element.isConnected && !viewer.element.hidden;

beforeEach(() => setup());
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

  it("a model finishing after a drop does not cover the 'connection lost' message; the rejoin shows it", () => {
    const socket = join();
    socket.serverClose(1006);
    expect(entryVisible()).toBe(true);
    const lost = message();
    expect(lost).toContain(describeCode(1001, "en").title);
    models.emit(modelA); // the HTTP download kept running and finished now
    expect(entryVisible()).toBe(true);
    expect(message()).toBe(lost);
    expect(viewer.setModel).not.toHaveBeenCalled();
    join(); // same session, the model is kept: shown without a new download
    expect(viewerVisible()).toBe(true);
    expect(viewer.setModel).toHaveBeenCalledWith(modelA);
  });

  it("rejoining the same session after a drop shows the same model again without refitting the camera", () => {
    const socket = join();
    models.emit(modelA);
    socket.serverClose(1006);
    expect(viewerVisible()).toBe(false);
    join();
    expect(viewerVisible()).toBe(true);
    expect(viewer.setModel).toHaveBeenCalledTimes(1); // not again: the user's camera stays
    expect(viewer.resize).toHaveBeenCalled();
    expect(viewer.invalidate).toHaveBeenCalled();
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
