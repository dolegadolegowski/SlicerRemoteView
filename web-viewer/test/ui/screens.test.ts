import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D } from "three";
import { createConnection } from "../../src/protocol/connection";
import type { Connection } from "../../src/protocol/connection";
import type { SceneModel, SceneModelStore, SceneNode } from "../../src/render/scene-model";
import type { CreateViewerResult, Viewer } from "../../src/render/viewer";
import { describe as describeCode, describeState } from "../../src/state/errors";
import { createCodeEntry } from "../../src/ui/code-entry";
import type { CodeEntry } from "../../src/ui/code-entry";
import { bindScreens } from "../../src/ui/screens";
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
    resize: vi.fn<Viewer["resize"]>(),
    setNotice: vi.fn<Viewer["setNotice"]>(),
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
