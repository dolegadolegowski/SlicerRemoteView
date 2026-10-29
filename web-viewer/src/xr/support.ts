// WebXR support (WEB-19; FR-47, ADR 0003, research web-xr.md §1): which immersive mode the viewer offers. Only Meta
// Quest Browser gets the button (FR-47): iOS has no `navigator.xr` at all, and a phone's handheld AR or a desktop
// headset has no interaction design yet (WEB-20 is controllers and hands). AR (passthrough) wins when supported.

import type { Platform } from "../platform";

export type XrMode = "immersive-ar" | "immersive-vr";

/** The part of `navigator.xr` the viewer uses. */
export interface XrSystemLike {
  isSessionSupported(mode: XrMode): Promise<boolean>;
  requestSession(mode: XrMode, init: XRSessionInit): Promise<XRSession>;
}

/** Floor-level space (the scene stands at a height above it) and hands; three.js adds neither by itself. */
export const XR_SESSION_INIT: XRSessionInit = {
  optionalFeatures: ["local-floor", "hand-tracking"],
};

/** The mode to offer, or `null`: no WebXR, not Quest Browser, nothing supported, or the check refused. */
export async function xrMode(
  xr: XrSystemLike | undefined,
  platform: Platform,
): Promise<XrMode | null> {
  if (!xr || platform !== "quest-browser") return null;
  try {
    if (await xr.isSessionSupported("immersive-ar")) return "immersive-ar";
    if (await xr.isSessionSupported("immersive-vr")) return "immersive-vr";
  } catch {
    // a check the browser refuses (permissions policy, insecure context) offers nothing
  }
  return null;
}

/** `navigator.xr`, if the browser has one. */
export const browserXr = (): XrSystemLike | undefined =>
  (globalThis.navigator as { xr?: XrSystemLike } | undefined)?.xr;
