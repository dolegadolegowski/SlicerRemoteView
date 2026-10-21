// A WebXR session of the viewer (WEB-19; FR-47, ADR 0003, research web-xr.md). Loaded on demand when the user enters
// XR, so the 2D viewer does not carry it. WebXR draws every frame (`setAnimationLoop`) — the only continuous loop of
// the viewer — while live updates keep changing the same scene objects. Controller and hand models come from the
// self-hosted `/assets/xr-profiles-<version>/` (never the jsDelivr default), and their GLBs' textures load as images,
// which the relay's CSP allows (`img-src blob:`), not with `fetch(blob:)`, which it does not (`connect-src 'self' wss:`).

import { TextureLoader } from "three";
import type { Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { version as profilesVersion } from "@webxr-input-profiles/assets/package.json";
import type { XrHost } from "../render/viewer";
import type { XrMode } from "./support";

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
  scene.add(...added);

  let placed = false;
  renderer.setAnimationLoop((_time, frame) => {
    if (!placed) {
      const space = renderer.xr.getReferenceSpace();
      const pose = space ? frame?.getViewerPose(space) : undefined;
      // Until the headset reports a pose the default eye height holds; the first pose places the scene for good.
      host.place(pose ? pose.transform.position.y : Number.NaN);
      placed = Boolean(pose); // `getViewerPose` gives null while tracking is not ready
    }
    renderer.render(scene, camera);
  });

  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    renderer.xr.removeEventListener("sessionend", onEnd);
    renderer.setAnimationLoop(null); // after the renderer's own handler, which restarts its window loop
    scene.remove(...added); // kept with their models for the next session
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
