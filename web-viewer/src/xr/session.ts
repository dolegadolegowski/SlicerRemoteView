// A WebXR session of the viewer (WEB-19; FR-47, ADR 0003, research web-xr.md). Loaded on demand when the user enters
// XR, so the 2D viewer does not carry it. WebXR draws every frame (`setAnimationLoop`) — the only continuous loop of
// the viewer — while live updates keep changing the same scene objects. Controller and hand models come from the
// self-hosted `/assets/xr-profiles-<version>/` (never the jsDelivr default), and their GLBs' textures load as images,
// which the relay's CSP allows (`img-src blob:`), not with `fetch(blob:)`, which it does not (`connect-src 'self' wss:`).
// The user grabs the scene with a controller's trigger or a pinch (WEB-20, grab.ts) and puts it back in front of them
// with a controller's grip button (squeeze) or two quick presses. Below the scene a status line says what the 2D
// status bar and notice line would (WEB-23), since the page cannot be seen in XR.

import { Group, TextureLoader } from "three";
import type { Matrix4, Mesh, Object3D, PlaneGeometry } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { version as profilesVersion } from "@webxr-input-profiles/assets/package.json";
import type { XrHost } from "../render/viewer";
import { createGrab } from "./grab";
import { createTextPanel, disposeTextPanel } from "./panel";
import { XR_PANEL_DISTANCE_M, XR_PANEL_DROP_M, xrEyeHeight } from "./placement";
import type { XrMode } from "./support";

/**
 * Two presses (trigger or pinch) of the same hand within this many ms put the scene back in front of the user
 * (WEB-20). Both hands pressing together is a two-hand grab, not a reset.
 */
export const DOUBLE_PRESS_MS = 400;
/** How long the Quest 2 budget warning stays (WEB-20). */
export const WARNING_MS = 10_000;
/** Space between two text panels of the column below the scene, in metres. */
const PANEL_GAP_M = 0.02;

/** Where `scripts/copy-xr-profiles.mjs` puts the input profiles (`dist/assets/`, served by the relay as is). */
export const XR_PROFILES_PATH = `/assets/xr-profiles-${profilesVersion}`;

/** A GLTFLoader whose embedded textures load through `<img>` (`TextureLoader`) instead of `fetch` (web-xr.md §1). */
export function imageTextureGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register((parser) => {
    parser.textureLoader = new TextureLoader(parser.options.manager);
    return { name: "slicerremoteview_image_textures" };
  });
  return loader;
}

const prepared = new WeakMap<XrHost["renderer"], Object3D[]>();

/**
 * The two controllers' grips and hands with their models, made once per renderer: three.js keeps one group per input
 * index across sessions, and each model listens to its group's `connected` events for good.
 */
function inputs(host: XrHost, path: string): Object3D[] {
  const known = prepared.get(host.renderer);
  if (known) return known;
  const controllerModels = new XRControllerModelFactory(imageTextureGltfLoader()).setPath(path);
  // three's hand mesh model sets the path only on a loader of its own: a given loader must carry it already.
  const handPath = `${path}/generic-hand/`;
  const handModels = new XRHandModelFactory(imageTextureGltfLoader().setPath(handPath)).setPath(
    handPath,
  );
  const made: Object3D[] = [];
  for (const index of [0, 1]) {
    const grip = host.renderer.xr.getControllerGrip(index);
    grip.add(controllerModels.createControllerModel(grip));
    const hand = host.renderer.xr.getHand(index);
    hand.add(handModels.createHandModel(hand, "mesh"));
    made.push(grip, hand);
  }
  prepared.set(host.renderer, made);
  return made;
}

export interface XrSessionOptions {
  /** Where the input profiles are (default `XR_PROFILES_PATH`). */
  readonly path?: string;
  /** Called once when the session is over and the 2D view is back, however the session ended. */
  readonly onEnd?: () => void;
  /** A warning shown in front of the user for `WARNING_MS` when the session starts (the Quest 2 budget, WEB-20). */
  readonly warning?: string | null;
  /**
   * What the status line says now (WEB-23), read every frame; `null` (or no function) when there is nothing to say.
   * A change draws the panel anew, so the text should change only when the status does.
   */
  readonly status?: () => string | null;
  /** Draws a text panel (default `createTextPanel`); `null` when it cannot. */
  readonly panel?: (text: string) => Mesh | null;
}

/**
 * Hands `session` (already granted) to the viewer: `local-floor` space, controller and hand models, the scene placed
 * in front of the user on the first frame with a pose, and the 2D view back when the session ends — however it ends
 * (the headset's menu, a lost tracking, `session.end()`). Rejects, with the 2D view restored, if WebXR refuses it.
 */
export async function runXrSession(
  host: XrHost,
  session: XRSession,
  mode: XrMode,
  options: XrSessionOptions = {},
): Promise<void> {
  const path = options.path ?? XR_PROFILES_PATH;
  const { renderer, scene, camera } = host;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  host.begin({ ar: mode === "immersive-ar" });

  const added = inputs(host, path);
  // The text panels (WEB-20, WEB-23) stand in a column below the scene, facing where the user stood, and stay there
  // while the scene is grabbed; a reset puts them back with it.
  const column = new Group();
  scene.add(...added, column);
  let eyeHeight = Number.NaN;

  // Once the scene is placed: the Quest 2 budget warning on top for `WARNING_MS`, and the status line whenever there is
  // something to say.
  const makePanel = options.panel ?? createTextPanel;
  let warning: Mesh | null = null;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let status: Mesh | null = null;
  let said: string | null = null; // the status line's text
  // Status panels taken down, freed a frame later: the new one has been drawn by then, so three keeps their shader
  // program instead of compiling it again inside an XR frame.
  const retired: Mesh[] = [];
  const freeRetired = () => retired.splice(0).forEach(disposeTextPanel);
  /** Stacks the panels from the column's top down. */
  const layout = () => {
    let top = 0;
    for (const panel of [warning, status]) {
      if (!panel) continue;
      const height = (panel.geometry as Partial<PlaneGeometry>).parameters?.height ?? 0;
      panel.position.set(0, top - height / 2, 0);
      top -= height + PANEL_GAP_M;
    }
  };
  const placeColumn = () => {
    const eye = xrEyeHeight(eyeHeight);
    column.position.set(0, eye - XR_PANEL_DROP_M, -XR_PANEL_DISTANCE_M);
    column.lookAt(0, eye, 0); // tilted up to the eyes, like a lectern
  };
  const showWarning = () => {
    warning = options.warning ? makePanel(options.warning) : null;
    if (!warning) return;
    column.add(warning);
    layout();
    warningTimer = setTimeout(hideWarning, WARNING_MS);
  };
  const hideWarning = () => {
    clearTimeout(warningTimer);
    if (warning) disposeTextPanel(warning);
    warning = null;
    layout();
  };
  /** The status line shows `text`, drawn anew only when it changes; `null` takes it away. */
  const say = (text: string | null) => {
    freeRetired();
    if (text === said) return;
    said = text;
    if (status) retired.push(status.removeFromParent() as Mesh);
    status = text ? makePanel(text) : null;
    if (status) column.add(status);
    layout();
  };

  // Grabbing (WEB-20). A press is `selectstart` on an input's target-ray space: a controller's trigger or a hand's
  // pinch. The pose that drags the scene must be rigid to the hand: a controller's target ray is (Touch controllers),
  // a hand's is the runtime's aim ray, which may follow the forearm rather than the wrist (OpenXR
  // XR_EXT_hand_interaction §Aim pose; research web-xr.md §1), so hands use their wrist joint. [TODO verify] on Quest 3.
  const grab = createGrab();
  const rays = [0, 1].map((index) => renderer.xr.getController(index));
  const hands = [0, 1].map((index) => renderer.xr.getHand(index));
  const isHand = [false, false];
  const pose = (i: number): Matrix4 | null => {
    if (isHand[i]) {
      const wrist = hands[i]!.joints["wrist"];
      return wrist?.visible ? wrist.matrix : null;
    }
    return rays[i]!.visible ? rays[i]!.matrix : null;
  };
  const poses = () =>
    new Map<number, Matrix4>(
      [0, 1].flatMap((i) => {
        const m = pose(i);
        return m ? [[i, m]] : [];
      }),
    );
  const lastPress = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const reset = () => {
    grab.release(0, host.stageMatrix());
    grab.release(1, host.stageMatrix());
    host.place(eyeHeight);
    placeColumn();
  };
  const listeners = rays.flatMap((ray, i) => {
    const onConnected = (event: { data?: XRInputSource }) =>
      (isHand[i] = Boolean(event.data?.hand));
    // A source that goes away lets go (Chromium sends `selectend` first; this is the fallback).
    const onDisconnected = () => grab.release(i, host.stageMatrix());
    const onSelectStart = () => {
      const now = performance.now();
      const double = now - lastPress[i]! < DOUBLE_PRESS_MS;
      lastPress[i] = double ? Number.NEGATIVE_INFINITY : now;
      if (double) return reset(); // a reset, not a grab of the scene just put back
      grab.press(i, host.stageMatrix());
    };
    const onSelectEnd = () => grab.release(i, host.stageMatrix());
    const all = [
      ["connected", onConnected],
      ["disconnected", onDisconnected],
      ["selectstart", onSelectStart],
      ["selectend", onSelectEnd],
      ["squeezestart", reset],
    ] as const;
    for (const [type, listener] of all) ray.addEventListener(type, listener as () => void);
    return all.map(
      ([type, listener]) =>
        () =>
          ray.removeEventListener(type, listener as () => void),
    );
  });

  let placed = false;
  renderer.setAnimationLoop((_time, frame) => {
    const space = renderer.xr.getReferenceSpace();
    const pose = space ? frame?.getViewerPose(space) : undefined;
    if (pose) eyeHeight = pose.transform.position.y; // `getViewerPose` gives null while tracking is not ready
    if (!placed) {
      // Until the headset reports a pose the default eye height holds; the first pose places the scene for good.
      host.place(eyeHeight);
      placed = Boolean(pose);
      if (placed) {
        placeColumn();
        showWarning();
      }
    }
    if (placed) say(options.status?.() ?? null);
    const held = grab.update(poses());
    if (held) host.setStageMatrix(held);
    renderer.render(scene, camera);
  });

  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    renderer.xr.removeEventListener("sessionend", onEnd);
    renderer.setAnimationLoop(null); // after the renderer's own handler, which restarts its window loop
    for (const off of listeners) off();
    hideWarning();
    say(null);
    freeRetired();
    scene.remove(...added, column); // the inputs are kept with their models for the next session
    renderer.xr.enabled = false;
    host.end();
    options.onEnd?.();
  };
  // three's `sessionend`, not the session's `end`: three sends it after putting back the render target, pixel ratio,
  // size, fov and zoom, so the 2D view is restored on top of that (an `end` listener added before `setSession` ran
  // first, with the XR field of view still on the camera).
  renderer.xr.addEventListener("sessionend", onEnd);
  try {
    await renderer.xr.setSession(session);
  } catch (error) {
    onEnd();
    await session.end().catch(() => undefined);
    throw error;
  }
}
