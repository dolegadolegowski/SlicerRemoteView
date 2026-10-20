import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, BoxGeometry, Group, Mesh, TOUCH, Vector3 } from "three";
import type { Object3D } from "three";
import { parseSceneModel } from "../../src/render/scene-model";
import type { SceneModel } from "../../src/render/scene-model";
import {
  createViewer,
  DAMPING_FACTOR,
  MAX_PIXEL_RATIO,
  PRESENTATION_SCALE,
} from "../../src/render/viewer";
import type {
  RendererLike,
  Viewer,
  ViewerOptions,
  VisualViewportLike,
} from "../../src/render/viewer";
import { describe as describeCode } from "../../src/state/errors";
import { glb } from "./glb-fixtures";

/** Gives an element a layout size (jsdom has no layout). */
function size(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
}

function renderer() {
  return {
    setPixelRatio: vi.fn<RendererLike["setPixelRatio"]>(),
    setSize: vi.fn<RendererLike["setSize"]>(),
    setClearColor: vi.fn<RendererLike["setClearColor"]>(),
    render: vi.fn<RendererLike["render"]>(),
    dispose: vi.fn<RendererLike["dispose"]>(),
  };
}

let viewers: Viewer[] = [];
afterEach(() => {
  viewers.forEach((v) => v.dispose());
  viewers = [];
  vi.useRealTimers();
});

/** A viewer with a manual frame queue: `flush()` runs frames until none is pending (or `max`). */
function harness(options: Partial<ViewerOptions> = {}, dpr = 3) {
  const frames = new Map<number, () => void>();
  let nextId = 1;
  let onResize: (() => void) | null = null;
  const r = renderer();
  const result = createViewer({
    lang: "en",
    isWebGL2Available: () => true,
    createRenderer: () => r,
    requestFrame: (cb) => {
      frames.set(nextId, cb);
      return nextId++;
    },
    cancelFrame: (id) => void frames.delete(id),
    devicePixelRatio: () => dpr,
    observeResize: (_element, cb) => {
      onResize = cb;
      return () => (onResize = null);
    },
    visualViewport: null,
    ...options,
  });
  if (!result.ok) throw new Error(result.reason);
  const viewer = result.viewer;
  viewers.push(viewer);
  // OrbitControls captures pointers; jsdom does not implement pointer capture.
  Object.assign(viewer.canvas, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  });
  size(viewer.element, 400, 800);
  size(viewer.canvas, 400, 800);
  document.body.append(viewer.element);
  const flush = (max = 1000): number => {
    let ran = 0;
    while (frames.size > 0 && ran < max) {
      const [id, cb] = frames.entries().next().value as [number, () => void];
      frames.delete(id);
      cb();
      ran++;
    }
    return ran;
  };
  return { viewer, r, frames, flush, resize: () => onResize?.() };
}

async function model(name = "asymmetric-2nodes.glb"): Promise<SceneModel> {
  const result = await parseSceneModel(glb(name));
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

/** Bounding box of the visible meshes, in world (stage) space. */
function visibleBox(m: SceneModel): Box3 {
  const box = new Box3();
  m.root.updateWorldMatrix(true, true);
  m.root.traverseVisible((o) => {
    if ((o as { isMesh?: boolean }).isMesh) box.expandByObject(o);
  });
  return box;
}

/** Every corner of `box` projects inside the camera's view (NDC within [-1, 1]). */
function inView(viewer: Viewer, box: Box3): boolean {
  viewer.camera.updateMatrixWorld(true);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) =>
      new Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ),
  );
  return corners.every((c) => {
    const p = c.clone().project(viewer.camera);
    return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1;
  });
}

const distance = (viewer: Viewer) => viewer.camera.position.distanceTo(viewer.controls.target);
const direction = (viewer: Viewer) =>
  viewer.camera.position.clone().sub(viewer.controls.target).normalize();

const pointer = (type: string, init: PointerEventInit & { timeStamp?: number }) => {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.timeStamp !== undefined)
    Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
  return event;
};
const touch = (viewer: Viewer, type: string, id: number, t: number, x = 200, y = 400) =>
  viewer.canvas.dispatchEvent(
    pointer(type, { pointerType: "touch", pointerId: id, clientX: x, clientY: y, timeStamp: t }),
  );
const tap = (viewer: Viewer, t: number, x = 200, y = 400, id = 1) => {
  touch(viewer, "pointerdown", id, t, x, y);
  touch(viewer, "pointerup", id, t + 50, x, y);
};

describe("WebGL 2 gate (research web.md §1.1)", () => {
  it("refuses without WebGL 2 and when the renderer cannot be created", () => {
    expect(createViewer({ isWebGL2Available: () => false })).toEqual({
      ok: false,
      reason: "webgl2Unavailable",
    });
    expect(
      createViewer({
        isWebGL2Available: () => true,
        visualViewport: null,
        createRenderer: () => {
          throw new Error("Error creating WebGL context.");
        },
      }),
    ).toEqual({ ok: false, reason: "webgl2Unavailable" });
  });
});

describe("render on demand (FR-39, NFR-08)", () => {
  it("2 s without interaction → zero frames (real requestAnimationFrame, fake clock)", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"] });
    const r = renderer();
    const result = createViewer({
      lang: "en",
      isWebGL2Available: () => true,
      createRenderer: () => r,
      devicePixelRatio: () => 2,
      observeResize: () => () => undefined,
      visualViewport: null,
    });
    if (!result.ok) throw new Error(result.reason);
    viewers.push(result.viewer);
    size(result.viewer.element, 400, 800);
    result.viewer.setModel(await model());
    vi.advanceTimersByTime(2000); // the load renders and settles
    const settled = r.render.mock.calls.length;
    expect(settled).toBeGreaterThan(0);
    vi.advanceTimersByTime(2000);
    expect(r.render.mock.calls.length).toBe(settled);
  });

  it("a `change` without motion renders exactly one frame", async () => {
    const { viewer, r, flush } = harness();
    viewer.setModel(await model());
    flush();
    r.render.mockClear();
    viewer.controls.dispatchEvent({ type: "change" });
    viewer.controls.dispatchEvent({ type: "change" }); // coalesced into the same frame
    expect(flush()).toBe(1);
    expect(r.render).toHaveBeenCalledTimes(1);
  });

  it("a flick renders while damping settles, then stops", async () => {
    const { viewer, r, flush, frames } = harness();
    viewer.setModel(await model());
    flush();
    r.render.mockClear();
    viewer.controls.rotateLeft(0.5);
    const ran = flush();
    expect(ran).toBeGreaterThan(5); // damped frames …
    expect(ran).toBeLessThan(400); // … that settle
    expect(frames.size).toBe(0);
    expect(r.render).toHaveBeenCalledTimes(ran);
    expect(DAMPING_FACTOR).toBeGreaterThan(0);
  });

  it("a damped pan glides until it has really stopped (millimetre stage, OrbitControls' absolute threshold)", async () => {
    const { viewer, flush } = harness();
    viewer.setModel(await model());
    flush();
    viewer.controls.pan(5, 0);
    expect(flush()).toBeGreaterThan(10);
    // nothing meaningful is left in the controls once the frames stop
    const settled = viewer.camera.position.clone();
    for (let i = 0; i < 100; i++) viewer.controls.update();
    expect(viewer.camera.position.distanceTo(settled) / distance(viewer)).toBeLessThan(1e-4);
    expect(PRESENTATION_SCALE).toBe(1000);
  });

  it("renders when the size changes and when a model replaces another with the same bounds", async () => {
    const { viewer, r, flush, resize } = harness();
    viewer.setModel(await model());
    flush();
    r.render.mockClear();
    size(viewer.element, 800, 400);
    resize();
    expect(r.render).toHaveBeenCalledTimes(1); // synchronously: a resized buffer is blank until drawn
    r.render.mockClear();
    viewer.setModel(await model()); // same file, same bounds: the camera does not move
    expect(flush()).toBeGreaterThanOrEqual(1);
    expect(r.render).toHaveBeenCalled();
  });

  it("stops while the page is hidden and renders once when it is visible again", async () => {
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    try {
      const { viewer, r, flush, frames } = harness();
      viewer.setModel(await model());
      flush();
      viewer.controls.dispatchEvent({ type: "change" });
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(frames.size).toBe(0); // the pending frame was cancelled
      viewer.controls.rotateLeft(0.5);
      viewer.invalidate();
      expect(frames.size).toBe(0);
      r.render.mockClear();
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(flush()).toBeGreaterThan(0);
      expect(r.render).toHaveBeenCalled();
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

describe("size, pixel ratio and visual viewport (NFR-32)", () => {
  it.each([
    [3, MAX_PIXEL_RATIO],
    [2.625, 2],
    [1.5, 1.5],
  ])("device pixel ratio %f renders at %f", (dpr, expected) => {
    const { viewer, r } = harness({}, dpr);
    viewer.resize();
    expect(r.setPixelRatio).toHaveBeenLastCalledWith(expected);
    expect(r.setSize).toHaveBeenLastCalledWith(400, 800, false); // CSS keeps the layout size
  });

  it("follows the element size; an unchanged size does not reallocate the buffer", () => {
    const { viewer, r, resize } = harness();
    viewer.resize();
    expect(viewer.camera.aspect).toBe(0.5);
    resize();
    expect(r.setSize).toHaveBeenCalledTimes(1);
    size(viewer.element, 800, 400); // rotated to landscape
    resize();
    expect(r.setSize).toHaveBeenLastCalledWith(800, 400, false);
    expect(r.setPixelRatio).toHaveBeenCalledTimes(1); // the ratio did not change
    expect(viewer.camera.aspect).toBe(2);
  });

  it("ignores a zero size (element hidden or not laid out yet)", () => {
    const { viewer, r } = harness();
    size(viewer.element, 0, 0);
    viewer.resize();
    expect(r.setSize).not.toHaveBeenCalled();
  });

  it("covers the visual viewport while the page is pinch-zoomed, and the CSS viewport again at scale 1", () => {
    const vv = Object.assign(new EventTarget(), {
      scale: 2,
      width: 200,
      height: 400,
      offsetLeft: 30,
      offsetTop: 50,
    });
    const { viewer, r } = harness({ visualViewport: vv as VisualViewportLike }, 2.625);
    size(viewer.element, 200, 400);
    viewer.resize();
    expect(viewer.element.style.left).toBe("30px");
    expect(viewer.element.style.top).toBe("50px");
    expect(viewer.element.style.width).toBe("200px");
    expect(viewer.element.style.height).toBe("400px");
    // min(2.625, 2) × 2: the half-size (CSS px) viewer fills the screen, so it keeps the unzoomed buffer of 800 px
    expect(r.setPixelRatio).toHaveBeenLastCalledWith(4);
    vv.scale = 1;
    size(viewer.element, 400, 800);
    vv.dispatchEvent(new Event("resize"));
    expect(viewer.element.style.width).toBe("");
    expect(viewer.element.style.left).toBe("");
    expect(r.setSize).toHaveBeenLastCalledWith(400, 800, false);
  });
});

describe("camera and clipping", () => {
  it("one finger rotates, two fingers dolly and pan; damping is on", () => {
    const { viewer } = harness();
    expect(viewer.controls.touches).toEqual({ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN });
    expect(viewer.controls.enableDamping).toBe(true);
    expect(viewer.controls.screenSpacePanning).toBe(true);
  });

  it("clip planes follow the camera distance (depth precision when zoomed out)", async () => {
    const { viewer, flush } = harness();
    viewer.setModel(await model());
    flush();
    const near = viewer.camera.near;
    viewer.controls.dollyIn(4); // OrbitControls: dollyIn moves the camera away
    flush();
    expect(viewer.camera.near).toBeGreaterThan(near * 2);
    expect(viewer.camera.near).toBeCloseTo(distance(viewer) / 200, 6);
    expect(viewer.camera.far).toBeGreaterThan(distance(viewer));
  });

  it("a node shown again after a fit on a smaller visible part stays inside the far plane", async () => {
    const { viewer, flush } = harness();
    const m = await model("large-synthetic.glb"); // spheres of 160, 100, 80, 60 mm in a row, 100 mm apart
    viewer.setModel(m);
    const [smallest, ...others] = [...m.nodes.values()].reverse();
    const centre = (o: Object3D) => new Box3().setFromObject(o).getCenter(new Vector3());
    // Look through the smallest sphere towards the others, so they lie behind it in depth.
    const others3 = others.reduce((sum, n) => sum.add(centre(n.T)), new Vector3());
    const look = centre(smallest!.T).sub(others3.divideScalar(others.length)).normalize();
    viewer.camera.position.copy(viewer.controls.target).add(look);
    for (const node of others) node.T.visible = false;
    viewer.fit(); // frames the smallest sphere only, keeping that direction
    for (const node of others) node.T.visible = true; // shown again from the node panel
    viewer.invalidate();
    flush();
    viewer.camera.updateMatrixWorld(true);
    const all = visibleBox(m);
    const farthest = Math.max(
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const corner = new Vector3(
          i & 1 ? all.max.x : all.min.x,
          i & 2 ? all.max.y : all.min.y,
          i & 4 ? all.max.z : all.min.z,
        );
        return -corner.applyMatrix4(viewer.camera.matrixWorldInverse).z; // depth in front of the camera
      }),
    );
    expect(farthest).toBeLessThan(viewer.camera.far);
  });

  it("a node moved far away by a live update stays inside the far plane after contentChanged (WEB-12)", () => {
    const { viewer, flush, r } = harness();
    const part = new Mesh(new BoxGeometry(0.05, 0.05, 0.05));
    const root = new Group();
    root.add(part);
    viewer.setModel({ root } as unknown as SceneModel);
    flush();
    part.position.set(0, 0, -2); // 2 m behind, like a new T.matrix
    r.render.mockClear();
    viewer.contentChanged();
    flush();
    expect(r.render).toHaveBeenCalled();
    viewer.camera.updateMatrixWorld(true);
    root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(part);
    const depth = -box.min.clone().applyMatrix4(viewer.camera.matrixWorldInverse).z;
    expect(depth).toBeLessThan(viewer.camera.far);
    expect(viewer.controls.target.length()).toBeLessThan(1e-6); // the camera was not refitted
  });

  it("zooming out after a fit on a tiny visible part still takes in the whole model", () => {
    const { viewer, flush } = harness();
    // A 2 mm part and a 200 mm part (metres, like §7.1 data): the large one hidden, then shown again.
    const tiny = new Mesh(new BoxGeometry(0.002, 0.002, 0.002));
    const large = new Mesh(new BoxGeometry(0.2, 0.2, 0.2));
    large.position.set(0.3, 0, 0);
    const root = new Group();
    root.add(tiny, large);
    viewer.setModel({ root } as unknown as SceneModel);
    large.visible = false;
    viewer.fit();
    large.visible = true;
    viewer.controls.dollyIn(1e6); // as far out as the controls allow
    viewer.invalidate();
    flush();
    root.updateWorldMatrix(true, true);
    expect(inView(viewer, new Box3().setFromObject(root))).toBe(true);
  });

  it("the headlight's target rides with the camera (lit from the view direction anywhere in RAS space)", () => {
    const { viewer } = harness();
    const light = viewer.camera.children.find(
      (o) => (o as { isDirectionalLight?: boolean }).isDirectionalLight,
    ) as { target: { parent: unknown } } | undefined;
    expect(light?.target.parent).toBe(viewer.camera);
  });
});

describe("fit to view", () => {
  it("on load frames the whole model from the front (patient faces the camera)", async () => {
    const { viewer } = harness();
    const m = await model("large-synthetic.glb");
    viewer.setModel(m);
    const box = visibleBox(m);
    expect(inView(viewer, box)).toBe(true);
    expect(viewer.controls.target.distanceTo(box.getCenter(new Vector3()))).toBeLessThan(1e-6);
    expect(direction(viewer).z).toBeCloseTo(1, 9);
    expect(viewer.element.dataset["model"]).toBe("loaded");
  });

  it("a new model is shown from the front even after the user turned the previous one", async () => {
    const { viewer, flush } = harness();
    viewer.setModel(await model());
    viewer.controls.rotateLeft(1);
    flush();
    expect(direction(viewer).z).toBeLessThan(0.9);
    viewer.setModel(await model("quantized-1node.glb"));
    expect(direction(viewer).z).toBeCloseTo(1, 9);
  });

  it("uses the current aspect even when the caller did not resize first (portrait phone)", async () => {
    const { viewer } = harness();
    const m = await model("large-synthetic.glb");
    viewer.setModel(m); // no viewer.resize() before
    expect(viewer.camera.aspect).toBe(0.5);
    expect(inView(viewer, visibleBox(m))).toBe(true);
  });

  it("the Fit button, a double tap and a double click re-frame, keeping the current direction", async () => {
    const { viewer, flush } = harness();
    viewer.setModel(await model());
    flush();
    const fitted = distance(viewer);
    for (const refit of [
      () => viewer.element.querySelector<HTMLButtonElement>(".viewer__fit")!.click(),
      () => {
        tap(viewer, 1000);
        tap(viewer, 1200);
      },
      () => viewer.canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    ]) {
      viewer.controls.rotateLeft(0.8);
      viewer.controls.dollyOut(3);
      flush();
      const turned = direction(viewer);
      expect(distance(viewer)).not.toBeCloseTo(fitted, 3);
      refit();
      flush();
      expect(distance(viewer)).toBeCloseTo(fitted, 6);
      // the current direction is kept (up to the residual of the settled damping), not reset to the front
      expect(direction(viewer).distanceTo(turned)).toBeLessThan(0.02);
      expect(direction(viewer).z).toBeLessThan(0.9);
    }
  });

  it("a fit in the middle of a flick is stable: the remaining damped motion does not drift it", async () => {
    const { viewer, flush, frames } = harness();
    viewer.setModel(await model());
    flush();
    viewer.controls.rotateLeft(1.5);
    flush(3); // still moving
    viewer.fit();
    const framed = viewer.camera.position.clone();
    flush();
    expect(viewer.camera.position.distanceTo(framed)).toBeLessThan(1e-9);
    expect(frames.size).toBe(0);
  });

  it("slow, distant, dragged, long-pressed or multi-finger taps are not a double tap", async () => {
    const { viewer, flush } = harness();
    viewer.setModel(await model());
    flush();
    viewer.controls.dollyOut(3);
    flush();
    const zoomed = distance(viewer);
    tap(viewer, 1000);
    tap(viewer, 1400); // too slow
    tap(viewer, 2000, 50, 50);
    tap(viewer, 2100, 300, 700); // too far apart
    // a drag (moves), then a quick tap
    touch(viewer, "pointerdown", 1, 3000, 100, 100);
    touch(viewer, "pointerup", 1, 3100, 180, 100);
    tap(viewer, 3150, 180, 100);
    // a long press at one spot, then a quick tap
    touch(viewer, "pointerdown", 1, 4000);
    touch(viewer, "pointerup", 1, 4400);
    tap(viewer, 4450);
    // two two-finger taps 150 ms apart, the second finger lifting first
    for (const t of [5000, 5150]) {
      touch(viewer, "pointerdown", 1, t, 100, 100);
      touch(viewer, "pointerdown", 2, t + 10, 150, 100);
      touch(viewer, "pointerup", 2, t + 40, 150, 100);
      touch(viewer, "pointerup", 1, t + 50, 100, 100);
    }
    // a tap right after a pinch must not pair with a tap from before it
    tap(viewer, 6000);
    touch(viewer, "pointerdown", 1, 6100);
    touch(viewer, "pointerdown", 2, 6110, 260, 400);
    touch(viewer, "pointerup", 2, 6150, 260, 400);
    touch(viewer, "pointerup", 1, 6160);
    tap(viewer, 6200);
    flush();
    expect(distance(viewer)).toBeCloseTo(zoomed, 6);
  });

  it("an empty scene or only hidden nodes still give a usable camera", async () => {
    const { viewer, flush } = harness();
    const m = await model();
    for (const node of m.nodes.values()) node.T.visible = false;
    viewer.setModel(m);
    flush();
    expect(Number.isFinite(viewer.camera.position.length())).toBe(true);
    expect(viewer.camera.near).toBeGreaterThan(0);
    expect(viewer.camera.far).toBeGreaterThan(viewer.camera.near);
    viewer.setModel(null);
    flush();
    expect(Number.isFinite(viewer.camera.position.length())).toBe(true);
    expect(viewer.element.dataset["model"]).toBe("none");
  });
});

describe("scene graph, notices and page behaviour", () => {
  it("setModel replaces the previous root and null removes it; models sit on the millimetre stage", async () => {
    const { viewer } = harness();
    const a = await model();
    const b = await model("quantized-1node.glb");
    const inScene = (m: SceneModel) => viewer.scene.getObjectById(m.root.id) !== undefined;
    viewer.setModel(a);
    expect(inScene(a)).toBe(true);
    expect(a.root.parent?.scale.x).toBe(PRESENTATION_SCALE);
    viewer.setModel(b);
    expect(inScene(a)).toBe(false);
    expect(a.root.parent).toBeNull();
    expect(inScene(b)).toBe(true);
    viewer.setModel(null);
    expect(b.root.parent).toBeNull();
  });

  it("shows and dismisses a notice over the scene", () => {
    const { viewer } = harness();
    const notice = viewer.element.querySelector<HTMLElement>(".viewer__notice")!;
    expect(notice.hidden).toBe(true);
    viewer.setNotice(describeCode("PAYLOAD_TOO_LARGE", "en"));
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain(describeCode("PAYLOAD_TOO_LARGE", "en").title);
    notice.querySelector<HTMLButtonElement>(".viewer__notice-close")!.click();
    expect(notice.hidden).toBe(true);
  });

  it("shows and empties a polite status line that stays in the accessibility tree (WEB-12, WEB-14)", () => {
    const { viewer } = harness();
    const status = viewer.element.querySelector<HTMLElement>(".viewer__status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.hidden).toBe(false); // a live region that appears with its text is often not announced
    expect(status.textContent).toBe("");
    viewer.setStatus("Updating the scene…");
    expect(status.textContent).toBe("Updating the scene…");
    const text = status.firstChild;
    viewer.setStatus("Updating the scene…"); // the same text again: not announced twice
    expect(status.firstChild).toBe(text);
    viewer.setStatus(null);
    expect(status.textContent).toBe("");
    expect(status.hidden).toBe(false);
  });

  it("focus() moves focus to the labelled canvas (not a tab stop)", () => {
    const { viewer } = harness();
    viewer.focus();
    expect(document.activeElement).toBe(viewer.canvas);
    expect(viewer.canvas.tabIndex).toBe(-1);
  });

  it("blocks browser gestures on the canvas only (Safari gesture events, touch-action)", () => {
    const { viewer } = harness();
    for (const type of ["gesturestart", "gesturechange"]) {
      const gesture = new Event(type, { cancelable: true });
      viewer.canvas.dispatchEvent(gesture);
      expect(gesture.defaultPrevented).toBe(true);
    }
    expect(viewer.canvas.style.touchAction).toBe("none");
    expect(document.body.style.touchAction).toBe("");
  });

  it("labels the canvas and the Fit button (44 px target is CSS)", () => {
    const { viewer } = harness();
    expect(viewer.canvas.getAttribute("role")).toBe("img");
    expect(viewer.canvas.getAttribute("aria-label")).toMatch(/3D scene/);
    expect(viewer.element.querySelector(".viewer__fit")!.textContent).toBe("Fit view");
  });

  it("dispose stops rendering, releases the renderer and detaches", async () => {
    const vv = Object.assign(new EventTarget(), {
      scale: 1,
      width: 400,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
    });
    const { viewer, r, frames } = harness({ visualViewport: vv as VisualViewportLike });
    viewer.setModel(await model());
    viewer.dispose();
    expect(frames.size).toBe(0);
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(viewer.element.isConnected).toBe(false);
    viewer.controls.dispatchEvent({ type: "change" });
    viewer.invalidate();
    vv.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
    expect(r.setSize).toHaveBeenCalledTimes(1);
    viewer.dispose(); // idempotent
    expect(r.dispose).toHaveBeenCalledTimes(1);
  });
});
