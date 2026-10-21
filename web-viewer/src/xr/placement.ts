// Where the scene stands in XR (WEB-19; FR-47, US-14/US-15: "in front of me at 1.3 m, scaled 1:1"). The stage is in
// metres in XR (§7.1 data is metric; the 2D view scales it to millimetres). In `local-floor` space the origin is on
// the floor under the user at the session start and −Z is where they faced, so the centre of the whole model goes
// 1.3 m ahead at the height of the eyes.

/** Distance from the user to the centre of the scene. */
export const XR_DISTANCE_M = 1.3;
/** Eye height used before the headset reports one (a seated or standing adult lies around it). */
export const DEFAULT_EYE_HEIGHT_M = 1.4;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Stage position that puts the model centre (`centre`, in metres in stage coordinates) `XR_DISTANCE_M` in front of the
 * origin at `eyeHeight`. A missing or implausible height (no tracking yet: 0, or a negative value) uses the default.
 */
export function xrStagePosition(centre: Vec3, eyeHeight: number): Vec3 {
  const height = eyeHeight > 0.3 && eyeHeight < 2.5 ? eyeHeight : DEFAULT_EYE_HEIGHT_M;
  return { x: -centre.x, y: height - centre.y, z: -XR_DISTANCE_M - centre.z };
}
