// Renderer, camera and touch controls (WEB-08; docs/architecture.md §7 "render on demand", research web.md §1.5,
// §1.7, §2.4). Renders only when something changed — controls, model, size, visibility — and keeps rendering
// while OrbitControls' damping settles, then stops: no frame is drawn while the user just looks (FR-39, NFR-08).
// The renderer, the frame scheduler, the resize observer and the visual viewport are injectable so the loop is
// unit-tested in jsdom, which has no WebGL.

import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Sphere,
  TOUCH,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Camera, Matrix4, Object3D, Quaternion } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import WebGL from "three/addons/capabilities/WebGL.js";
import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import { describeState, localize } from "../state/errors";
import type { Description } from "../state/errors";
import { xrStagePosition } from "../xr/placement";
import type { SceneModel } from "./scene-model";

/** The part of `WebGLRenderer` the viewer uses; tests pass a mock. */
export interface RendererLike {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setClearColor(color: Color | number, alpha?: number): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
  /** `WebGLRenderer.info` (replaced by three.js after a context restore, so read it each time). */
  readonly info?: { readonly memory: { readonly geometries: number; readonly textures: number } };
}

/** The part of `window.visualViewport` the viewer uses. */
export interface VisualViewportLike extends EventTarget {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

export interface ViewerOptions {
  readonly lang?: Lang;
  /** Default: `WebGL.isWebGL2Available()` (research web.md §1.1). */
  readonly isWebGL2Available?: () => boolean;
  /** Default: a `WebGLRenderer` on `canvas` (WebGL 2 only since r163). */
  readonly createRenderer?: (canvas: HTMLCanvasElement) => RendererLike;
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** Default: `window.devicePixelRatio`; the renderer uses at most 2 (NFR-32, memory and fill rate). */
  readonly devicePixelRatio?: () => number;
  /** Default: `ResizeObserver` when present, else the window `resize` event. */
  readonly observeResize?: (element: HTMLElement, onResize: () => void) => () => void;
  /** Default: `window.visualViewport` (`null` when the browser has none). */
  readonly visualViewport?: VisualViewportLike | null;
  readonly document?: Document;
}

export interface Viewer {
  /** `.viewer` element: canvas, notice and "Fit" button; CSS gives it the dynamic viewport. */
  readonly element: HTMLElement;
  /** The stack at the top (notice, status line); the status bar is put first in it (WEB-15). */
  readonly overlay: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Shows `model` (replacing the previous one, which the store disposes) and fits it from the front; `null` clears. */
  setModel(model: SceneModel | null): void;
  /** Frames the visible nodes; `resetDirection` also returns to the front view (on load). */
  fit(resetDirection?: boolean): void;
  /** Requests one frame. */
  invalidate(): void;
  /** Live updates changed the scene (WEB-12): re-measures the model for the clip planes, draws a frame. */
  contentChanged(): void;
  /** Re-reads the size, pixel ratio and visual viewport and renders at once (also on resize events). */
  resize(): void;
  /** A message over the scene (e.g. a refused snapshot while the old one stays visible); `null` hides it. */
  setNotice(notice: Description | null): void;
  /**
   * The message `setNotice` gave, in the UI language, until replaced or dismissed; `null` when there is none (the
   * lost-context notice is the viewer's own and not included). The in-XR status line repeats its title (WEB-23).
   */
  readonly notice: Description | null;
  /** GPU resources three.js holds now (`renderer.info.memory`), for tests and the dev overlay (WEB-16). */
  rendererInfo(): { readonly geometries: number; readonly textures: number } | null;
  /**
   * A short, polite status line (e.g. "Updating the scene…" before a new snapshot, WEB-12; "Reconnecting…", WEB-14);
   * `null` empties it. The element stays in the accessibility tree (an empty one is not drawn), so a change is announced.
   */
  setStatus(text: string | null): void;
  /** Moves keyboard / screen-reader focus to the canvas (its label describes the gestures). */
  focus(): void;
  /** Re-renders the labels and the notice in `lang` (WEB-21); the status line is the caller's. */
  setLang(lang: Lang): void;
  /** The WebXR side (WEB-19); `null` when the renderer cannot present (a test stand-in without `xr`). */
  readonly xr: XrHost | null;
  dispose(): void;
}

/**
 * What a WebXR session needs from the viewer (WEB-19). Between `begin` and `end` WebXR draws (the session's animation
 * loop): no 2D frame, control, resize or fit runs; the camera gets metric clip planes; the stage is in metres, placed
 * by `place`; AR clears to transparent so the room shows through.
 */
export interface XrHost {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  begin(options: { readonly ar: boolean }): void;
  /**
   * Puts the centre of the whole model in front of the user at `eyeHeight` metres (`local-floor`, placement.ts), at
   * real size and unturned: also the reset after grabbing (WEB-20).
   */
  place(eyeHeight: number): void;
  /** The stage's transform in the room (metres), and setting it while the user holds the scene (WEB-20). */
  stageMatrix(): Matrix4;
  setStageMatrix(matrix: Matrix4): void;
  /** The 2D view again, camera as it was (or fitted again when the model changed meanwhile). */
  end(): void;
  /** Ends the running session, if any (the scene went away: the 2D page says why); `end` follows from it. */
  exit(): void;
}

export type CreateViewerResult =
  | { readonly ok: true; readonly viewer: Viewer }
  | { readonly ok: false; readonly reason: "webgl2Unavailable" };

/** Largest device pixel ratio rendered (NFR-32): beyond 2 the fill-rate and memory cost buys little on a phone. */
export const MAX_PIXEL_RATIO = 2;
/**
 * Damping per frame: a flick visibly stops in ≈ 1 s and frames stop in ≈ 1.5 s (≈ 1.8 s / 3 s with three.js' default
 * 0.05), measured at 60 Hz on the mm stage below.
 */
export const DAMPING_FACTOR = 0.1;
/**
 * The 2D view shows the scene in millimetres (§7.1 data is in metres, untouched): OrbitControls stops announcing
 * motion below an absolute 1e-3 (OrbitControls.js `_EPS` on squared distances), which in metres would cut a damped
 * pan off at 1 mm per frame — visibly early on a 10 cm organ. WebXR (WEB-19) shows the model 1:1 in metres.
 */
export const PRESENTATION_SCALE = 1000;
/** Margin around the bounding sphere when fitting. */
const FIT_MARGIN = 1.15;
/** Double tap: two taps within this many ms and px; a tap is shorter than TAP_MS and moves less than TAP_PX. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
const TAP_MS = 250;
const TAP_PX = 10;
/** Patient faces −Z, the model root is turned 180° about Y (§7.1): the default view looks at the face from +Z. */
const FRONT = new Vector3(0, 0, 1);
const BACKGROUND = 0x0b0f14; // --bg in style.css
/** Clip planes in XR, in metres: a hand-held model 2 cm from the eyes, the far wall of a large room. */
const XR_NEAR_M = 0.02;
const XR_FAR_M = 100;

let webgl2: boolean | undefined;
/** `WebGL.isWebGL2Available()`, evaluated once (each probe creates a context). */
export function webGL2Available(): boolean {
  webgl2 ??= WebGL.isWebGL2Available();
  return webgl2;
}

// `powerPreference` stays "default": "high-performance" would keep a laptop's discrete GPU on for the tab's life.
const defaultRenderer = (canvas: HTMLCanvasElement): RendererLike =>
  new WebGLRenderer({ canvas, antialias: true });

function defaultObserveResize(element: HTMLElement, onResize: () => void): () => void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => onResize());
    observer.observe(element);
    return () => observer.disconnect();
  }
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}

export function createViewer(options: ViewerOptions = {}): CreateViewerResult {
  const doc = options.document ?? document;
  let lang = options.lang ?? detectLang();
  if (!(options.isWebGL2Available ?? webGL2Available)())
    return { ok: false, reason: "webgl2Unavailable" };

  const element = doc.createElement("div");
  element.className = "viewer";
  element.dataset["model"] = "none";
  const canvas = doc.createElement("canvas");
  canvas.className = "viewer__canvas";
  canvas.tabIndex = -1; // focusable from script (screen-reader announcement), not a tab stop
  canvas.setAttribute("role", "img");
  const notice = doc.createElement("div");
  notice.className = "viewer__notice";
  notice.setAttribute("role", "alert");
  notice.hidden = true;
  const noticeTitle = doc.createElement("p");
  noticeTitle.className = "viewer__notice-title";
  const noticeBody = doc.createElement("p");
  noticeBody.className = "viewer__notice-body";
  const noticeClose = doc.createElement("button");
  noticeClose.type = "button";
  noticeClose.className = "viewer__notice-close";
  notice.append(noticeTitle, noticeBody, noticeClose);
  const fitButton = doc.createElement("button");
  fitButton.type = "button";
  fitButton.className = "viewer__fit";
  const status = doc.createElement("p");
  status.className = "viewer__status";
  status.setAttribute("role", "status"); // polite: announced without interrupting
  const top = doc.createElement("div"); // the notice above the status line (style.css)
  top.className = "viewer__top";
  top.append(notice, status);
  element.append(canvas, top, fitButton);

  let renderer: RendererLike;
  try {
    renderer = (options.createRenderer ?? defaultRenderer)(canvas);
  } catch {
    return { ok: false, reason: "webgl2Unavailable" }; // context creation failed despite the probe
  }
  renderer.setClearColor(BACKGROUND, 1);

  const requestFrame = options.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const devicePixelRatio = options.devicePixelRatio ?? (() => window.devicePixelRatio || 1);
  const visualViewport =
    options.visualViewport !== undefined
      ? options.visualViewport
      : ((window.visualViewport as VisualViewportLike | null) ?? null);

  const scene = new Scene();
  scene.background = new Color(BACKGROUND);
  const stage = new Group();
  stage.name = "SlicerRemoteView stage (mm)";
  stage.scale.setScalar(PRESENTATION_SCALE);
  scene.add(stage);
  const camera = new PerspectiveCamera(45, 1, 1, 10_000);
  camera.position.copy(FRONT).multiplyScalar(500);
  // Hemisphere fill plus a headlight fixed in view space (light and target ride with the camera), so the side the
  // user looks at is lit wherever the model sits in RAS space.
  scene.add(new HemisphereLight(0xffffff, 0x3a4656, 1.2));
  const headlight = new DirectionalLight(0xffffff, 2);
  headlight.position.set(0.5, 1, 1);
  headlight.target.position.set(0, 0, -1);
  camera.add(headlight, headlight.target);
  scene.add(camera);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = DAMPING_FACTOR;
  controls.screenSpacePanning = true;
  // three.js defaults, stated: one finger rotates, two fingers dolly + pan (research web.md §1.5).
  controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

  let model: SceneModel | null = null;
  let radius = 100; // of the framed content, in stage units (mm)
  /** The whole model, hidden nodes included: what a node panel (WEB-09) can show again without a new fit. */
  const bounds = new Sphere(new Vector3(), radius);
  let frame: number | null = null;
  let disposed = false;
  /** The WebGL context is lost (GPU reset, memory pressure): nothing is drawn until it is restored (WEB-16). */
  let lost = false;
  /** The notice set by the caller (in any language: it is shown in the viewer's, WEB-21). */
  let given: Description | null = null;
  let localized: Description | null = null; // `given` in the UI language
  /** A WebXR session draws (WEB-19): the 2D camera as it was before, and what happened meanwhile. */
  let presenting: {
    readonly saved: {
      readonly position: Vector3;
      readonly quaternion: Quaternion;
      readonly near: number;
      readonly far: number;
    };
    eyeHeight: number | null;
    refit: boolean;
    /** Live updates changed the scene: its 2D bounds are measured again at the end, in millimetres. */
    remeasure: boolean;
  } | null = null;
  let hidden = doc.visibilityState === "hidden";
  let size = { width: 0, height: 0, ratio: 0 };

  /** Render-on-demand (three.js manual): at most one pending frame; damping re-requests through `change`. */
  function invalidate(): void {
    if (frame !== null || disposed || hidden || lost || presenting) return;
    frame = requestFrame(renderFrame);
  }
  function renderFrame(): void {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    if (disposed || hidden || lost || presenting) return;
    controls.update(); // dispatches `change` (→ next frame) while the damped motion continues
    updateClipping();
    renderer.render(scene, camera);
  }
  /**
   * Clip planes follow the camera distance, so zooming out does not cost depth precision between nested surfaces.
   * Far also reaches past the whole model: a node shown again after a fit on a smaller visible part is not cut off.
   */
  function updateClipping(): void {
    const distance = camera.position.distanceTo(controls.target);
    const near = Math.max(distance / 200, radius / 1000);
    const far = Math.max(
      distance + radius * 4,
      camera.position.distanceTo(bounds.center) + bounds.radius * 2,
    );
    if (near === camera.near && far === camera.far) return;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
  controls.addEventListener("change", invalidate);

  /**
   * A page pinch-zoomed on the code entry screen (kept zoomable for low vision, WCAG) would magnify the viewer with
   * no way back, since the canvas takes every touch: while zoomed, the viewer covers the visual viewport instead.
   */
  function followVisualViewport(): number {
    const vv = visualViewport;
    if (!vv || Math.abs(vv.scale - 1) < 0.01) {
      element.style.removeProperty("left");
      element.style.removeProperty("top");
      element.style.removeProperty("width");
      element.style.removeProperty("height");
      return 1;
    }
    element.style.left = `${vv.offsetLeft}px`;
    element.style.top = `${vv.offsetTop}px`;
    element.style.width = `${vv.width}px`;
    element.style.height = `${vv.height}px`;
    return vv.scale;
  }

  function resize(): void {
    if (disposed || presenting) return; // WebXR sizes the drawing buffer itself while it presents
    const zoom = followVisualViewport();
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (width === 0 || height === 0) return;
    // Cap the device ratio, then scale by the page zoom: a zoomed viewer is smaller in CSS px but still fills the
    // screen, so it gets the same drawing buffer as unzoomed (not a 1/zoom-resolution image stretched).
    const ratio = Math.min(devicePixelRatio(), MAX_PIXEL_RATIO) * zoom;
    if (width === size.width && height === size.height && ratio === size.ratio) return;
    // setPixelRatio reallocates the drawing buffer at the old size; only do it when the ratio changed.
    if (ratio !== size.ratio) renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false); // CSS decides the size; only the drawing buffer follows
    size = { width, height, ratio };
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderFrame(); // now, not on the next frame: a resized buffer is blank until drawn
  }

  /** Camera distance at which a sphere of radius `r` fills the narrower field of view (with the margin). */
  function fitDistance(r: number): number {
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    return (r / Math.sin(Math.min(vFov, hFov) / 2)) * FIT_MARGIN;
  }

  /** Bounding box of the whole model in stage units, hidden nodes included (empty without a model). */
  function measureAll(): Box3 {
    stage.updateMatrixWorld(true);
    return model ? new Box3().setFromObject(model.root) : new Box3();
  }

  function fit(resetDirection = false): void {
    if (presenting) {
      presenting.refit = true; // the 2D camera is fitted when the session ends
      return;
    }
    // Apply whatever damped motion is still settling now, so it cannot drift the new framing afterwards.
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
    const box = new Box3();
    const all = measureAll();
    // Frame what the user sees; fall back to everything when all nodes are hidden.
    model?.root.traverseVisible((o) => {
      if ((o as { isMesh?: boolean }).isMesh) box.expandByObject(o);
    });
    if (box.isEmpty()) box.copy(all);
    const sphere = box.isEmpty()
      ? new Sphere(new Vector3(), 100)
      : box.getBoundingSphere(new Sphere());
    radius = Math.max(sphere.radius, 1);
    if (all.isEmpty()) bounds.copy(sphere);
    else all.getBoundingSphere(bounds);
    const distance = fitDistance(radius);
    const direction = resetDirection
      ? FRONT.clone()
      : camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() === 0) direction.copy(FRONT);
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    controls.minDistance = radius * 0.05;
    // Zooming out can always take in the whole model, also nodes that are hidden now and shown later (WEB-09).
    controls.maxDistance = Math.max(distance, fitDistance(bounds.radius)) * 10;
    controls.update();
    updateClipping();
    invalidate();
  }

  /**
   * Live updates moved or removed nodes (WEB-12): the whole-model bounds behind the clip planes and the zoom-out
   * limit follow, the camera stays where the user put it, and a frame is drawn.
   */
  function contentChanged(): void {
    if (presenting) {
      presenting.remeasure = true; // measured now, the bounds would be in metres at the XR position
      return;
    }
    const all = measureAll();
    if (!all.isEmpty()) all.getBoundingSphere(bounds);
    controls.maxDistance = Math.max(controls.maxDistance, fitDistance(bounds.radius) * 10);
    updateClipping();
    invalidate();
  }

  function setModel(next: SceneModel | null): void {
    if (model && model !== next) stage.remove(model.root);
    model = next;
    if (model) stage.add(model.root);
    element.dataset["model"] = model ? "loaded" : "none";
    resize(); // fit needs the current aspect (portrait phones need ≈ 2× the distance of a square view)
    fit(true);
    // A new scene in XR stands where the first one was put (in front, real size, unturned), whatever was grabbed.
    if (presenting?.eyeHeight != null) place(presenting.eyeHeight);
  }

  function place(eyeHeight: number): void {
    if (!presenting) return;
    presenting.eyeHeight = eyeHeight;
    // Unturned and at real size first: the box of a turned model is not the turned box of the model.
    stage.quaternion.identity();
    stage.scale.setScalar(1);
    // The centre of the whole model in stage coordinates (metres, the stage's own unit while presenting).
    stage.updateMatrixWorld(true);
    const box = model ? new Box3().setFromObject(model.root) : new Box3();
    const centre = box.isEmpty() ? new Vector3() : stage.worldToLocal(box.getCenter(new Vector3()));
    const at = xrStagePosition(centre, eyeHeight);
    stage.position.set(at.x, at.y, at.z);
  }

  function paintNotice(): void {
    // While the context is lost, no notice of the caller's (or one cleared, e.g. for a new scene) leaves why nothing
    // is drawn.
    localized = given && localize(given, lang);
    const lostShown = given === null && lost;
    const shown = lostShown ? describeState({ kind: "contextLost" }, lang) : localized;
    notice.hidden = shown === null;
    // The lost-context notice cannot be dismissed (it would come straight back), so it has no button.
    noticeClose.hidden = lostShown;
    // Unchanged text is left alone: the alert is not announced again.
    if (noticeTitle.textContent !== (shown?.title ?? ""))
      noticeTitle.textContent = shown?.title ?? "";
    if (noticeBody.textContent !== (shown?.body ?? "")) noticeBody.textContent = shown?.body ?? "";
  }

  function setNotice(next: Description | null): void {
    given = next;
    paintNotice();
  }

  function label(): void {
    canvas.setAttribute("aria-label", t(lang, "viewer.canvasLabel"));
    noticeClose.textContent = t(lang, "viewer.dismiss");
    fitButton.textContent = t(lang, "viewer.fit");
  }

  // Double tap (touch) and double click (mouse) frame the scene again; a drag, a long press or a pinch is not a tap.
  let down: {
    readonly id: number;
    readonly t: number;
    readonly x: number;
    readonly y: number;
  } | null = null;
  let lastTap: { readonly t: number; readonly x: number; readonly y: number } | null = null;
  const touches = new Set<number>();
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.add(e.pointerId);
    down =
      touches.size === 1 ? { id: e.pointerId, t: e.timeStamp, x: e.clientX, y: e.clientY } : null;
    if (touches.size > 1) lastTap = null;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    const start = down;
    down = null;
    if (!start || start.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (e.timeStamp - start.t > TAP_MS || moved > TAP_PX) {
      lastTap = null;
      return;
    }
    const previous = lastTap;
    if (
      previous &&
      e.timeStamp - previous.t <= DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= DOUBLE_TAP_PX
    ) {
      lastTap = null;
      fit();
    } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  };
  const onPointerCancel = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    down = null;
  };
  const onDoubleClick = () => fit();
  // Safari ignores `user-scalable=no`; its proprietary gesture events would zoom the page (research web.md §2.4).
  const preventGesture = (e: Event) => e.preventDefault();
  const onVisibility = () => {
    hidden = doc.visibilityState === "hidden";
    if (hidden && frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (!hidden) invalidate();
  };
  const onFit = () => fit();
  const onDismiss = () => setNotice(null);
  // three.js prevents the default (so the context can come back) and re-uploads the scene on restore; the viewer
  // stops its frames meanwhile and says why (web.md §2.3).
  const onContextLost = () => {
    lost = true;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    element.dataset["context"] = "lost";
    setNotice(null); // replaces any notice: why nothing is drawn matters most
  };
  const onContextRestored = () => {
    lost = false;
    delete element.dataset["context"];
    paintNotice(); // the lost-context notice goes; one set meanwhile stays
    renderFrame();
  };

  label();
  canvas.style.touchAction = "none"; // OrbitControls sets it too; the page itself keeps native zoom (WCAG)
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("gesturestart", preventGesture, { passive: false });
  canvas.addEventListener("gesturechange", preventGesture, { passive: false });
  fitButton.addEventListener("click", onFit);
  noticeClose.addEventListener("click", onDismiss);
  doc.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  visualViewport?.addEventListener("resize", resize);
  visualViewport?.addEventListener("scroll", resize);
  const stopObserving = (options.observeResize ?? defaultObserveResize)(element, resize);

  const xrRenderer =
    "xr" in renderer && "setAnimationLoop" in renderer
      ? (renderer as unknown as WebGLRenderer)
      : null;
  const xr: XrHost | null = xrRenderer && {
    renderer: xrRenderer,
    scene,
    camera,
    begin({ ar }) {
      if (presenting || disposed) return;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      presenting = {
        saved: {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          near: camera.near,
          far: camera.far,
        },
        eyeHeight: null,
        refit: false,
        remeasure: false,
      };
      controls.enabled = false;
      camera.near = XR_NEAR_M; // WebXR takes its depth range from the camera (research web-xr.md §1)
      camera.far = XR_FAR_M;
      camera.updateProjectionMatrix();
      stage.scale.setScalar(1); // §7.1 metres: real size in the room
      if (ar) {
        scene.background = null; // passthrough shows behind the scene
        renderer.setClearColor(BACKGROUND, 0);
      }
      element.dataset["xr"] = ar ? "ar" : "vr";
    },
    place,
    stageMatrix() {
      stage.updateMatrix();
      return stage.matrix.clone();
    },
    setStageMatrix(matrix) {
      if (presenting) matrix.decompose(stage.position, stage.quaternion, stage.scale);
    },
    end() {
      if (!presenting) return;
      const { saved, refit, remeasure } = presenting;
      presenting = null;
      stage.scale.setScalar(PRESENTATION_SCALE);
      stage.position.set(0, 0, 0);
      stage.quaternion.identity(); // grabbing may have turned it (WEB-20)
      scene.background = new Color(BACKGROUND);
      renderer.setClearColor(BACKGROUND, 1);
      // WebXR moved the camera with the head and restores only its fov and zoom.
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      camera.scale.set(1, 1, 1);
      camera.near = saved.near;
      camera.far = saved.far;
      camera.updateProjectionMatrix();
      controls.enabled = true;
      delete element.dataset["xr"];
      if (disposed) return;
      size = { width: 0, height: 0, ratio: 0 }; // WebXR set the buffer back; draw it again at once
      resize();
      if (refit) fit(true);
      else if (remeasure) contentChanged();
      else invalidate();
    },
    exit() {
      void xrRenderer.xr
        .getSession()
        ?.end()
        .catch(() => undefined);
    },
  };

  const viewer: Viewer = {
    element,
    overlay: top,
    canvas,
    scene,
    camera,
    controls,
    setModel,
    fit,
    invalidate,
    contentChanged,
    resize,
    setNotice,
    get notice() {
      return localized;
    },
    rendererInfo() {
      const memory = renderer.info?.memory;
      return memory ? { geometries: memory.geometries, textures: memory.textures } : null;
    },
    setStatus(text) {
      if (status.textContent !== (text ?? "")) status.textContent = text ?? "";
    },
    focus: () => canvas.focus({ preventScroll: true }),
    setLang(next) {
      lang = next;
      label();
      paintNotice();
    },
    xr,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      stopObserving();
      controls.removeEventListener("change", invalidate);
      controls.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("gesturestart", preventGesture);
      canvas.removeEventListener("gesturechange", preventGesture);
      fitButton.removeEventListener("click", onFit);
      noticeClose.removeEventListener("click", onDismiss);
      doc.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      visualViewport?.removeEventListener("resize", resize);
      visualViewport?.removeEventListener("scroll", resize);
      if (model) stage.remove(model.root);
      model = null;
      renderer.dispose();
      element.remove();
    },
  };
  return { ok: true, viewer };
}
