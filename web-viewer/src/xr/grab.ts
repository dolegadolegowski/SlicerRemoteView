// Grabbing the scene in XR (WEB-20; FR-48, US-14/US-15): with one hand the scene follows it rigidly (moves and turns
// with it, freely in 3D); with two it turns about the vertical with the line between the hands and scales with their
// distance, about their midpoint, between 0.1× and 5× of real size. Two-hand turning stays upright: a shortest-arc
// rotation between the hand lines tips the scene over near a half turn, and accumulated per frame it drifts into a
// tilt whenever the line is not level (WEB-20 review). Pure math on three.js matrices, unit-tested without a headset.

import { Matrix4, Quaternion, Vector3 } from "three";

/** Scale limits of the scene relative to real size (FR-48). */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5;

const UP = new Vector3(0, 1, 0);

/**
 * Signed angle (radians) about the vertical from the horizontal part of `from` to that of `to`; 0 when either is
 * (nearly) vertical, which has no horizontal direction to follow.
 */
export function yawBetween(from: Vector3, to: Vector3): number {
  if (Math.hypot(from.x, from.z) < 1e-6 || Math.hypot(to.x, to.z) < 1e-6) return 0;
  return Math.atan2(from.z * to.x - from.x * to.z, from.x * to.x + from.z * to.z);
}

/** Uniform scale of a TRS matrix (the stage is only ever scaled uniformly). */
const scaleOf = (m: Matrix4) => new Vector3().setFromMatrixScale(m).x;

/** The stage while one hand holds it: `hand · hand₀⁻¹ · stage₀`. */
export function oneHandPose(stage0: Matrix4, hand0: Matrix4, hand: Matrix4): Matrix4 {
  return new Matrix4().copy(hand).multiply(new Matrix4().copy(hand0).invert()).multiply(stage0);
}

/**
 * The stage while two hands hold it: the turn about the vertical from the start hand-to-hand line to the current one
 * (any angle: the same orientation modulo a full turn) and the distance ratio (clamped so the total scale stays within
 * `MIN_SCALE`..`MAX_SCALE`), applied about the start midpoint, which then follows the current midpoint.
 */
export function twoHandPose(
  stage0: Matrix4,
  a0: Vector3,
  b0: Vector3,
  a: Vector3,
  b: Vector3,
): Matrix4 {
  const from = new Vector3().subVectors(b0, a0);
  const to = new Vector3().subVectors(b, a);
  const d0 = from.length();
  const d = to.length();
  if (d0 < 1e-6 || d < 1e-6) return stage0.clone(); // hands on top of each other: no direction to follow
  const s0 = scaleOf(stage0);
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (s0 * d) / d0)) / s0;
  const q = new Quaternion().setFromAxisAngle(UP, yawBetween(from, to));
  const mid0 = new Vector3().addVectors(a0, b0).multiplyScalar(0.5);
  const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  return new Matrix4()
    .makeTranslation(mid.x, mid.y, mid.z)
    .multiply(new Matrix4().makeRotationFromQuaternion(q))
    .multiply(new Matrix4().makeScale(k, k, k))
    .multiply(new Matrix4().makeTranslation(-mid0.x, -mid0.y, -mid0.z))
    .multiply(stage0);
}

/**
 * Which hands hold the scene and where they were when the grip last changed. A press or release arrives before the
 * frame updates the poses (WebXR sends input events first), so the hands are anchored at the next `update`, from the
 * poses of that frame: a pose one frame old would make the scene jump by the hand's last movement.
 */
export interface Grab {
  readonly held: boolean;
  /** Hand `id` starts holding; `stage` is the stage's matrix now. */
  press(id: number, stage: Matrix4): void;
  /** Hand `id` lets go; the other hand (if any) carries on from where the scene is now. */
  release(id: number, stage: Matrix4): void;
  /**
   * The stage matrix for the hands' current poses; `null` while nothing holds the scene or no holding hand is tracked
   * (the scene stays). A holding hand that loses tracking (no pose) keeps holding: the other carries on from where the
   * scene is, and the lost one rejoins from where it comes back — no jump either way.
   */
  update(poses: ReadonlyMap<number, Matrix4>): Matrix4 | null;
}

export function createGrab(): Grab {
  const holding = new Set<number>(); // the hands that hold, tracked or not
  let anchors = new Map<number, Matrix4>(); // tracked holding hand → its pose at the last rebase
  let stage0 = new Matrix4();
  let last: Matrix4 | null = null; // the stage as last placed by this grab
  let pending = false; // a press or release since the last update: anchor anew
  const position = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);

  /** Starts over from the scene as it is (`stage`), each tracked holding hand from its current pose. */
  function rebase(poses: ReadonlyMap<number, Matrix4>, stage: Matrix4): void {
    anchors = new Map(
      [...holding].flatMap((id) => (poses.has(id) ? [[id, poses.get(id)!.clone()]] : [])),
    );
    stage0 = stage.clone();
    last = stage.clone();
  }

  return {
    get held() {
      return holding.size > 0;
    },
    press(id, stage) {
      if (holding.size >= 2 && !holding.has(id)) return; // two hands are enough
      holding.add(id);
      last = stage.clone();
      pending = true;
    },
    release(id, stage) {
      if (!holding.delete(id)) return;
      last = stage.clone();
      pending = true;
    },
    update(poses) {
      if (holding.size === 0) return null;
      const tracked = [...holding].filter((id) => poses.has(id));
      // A press or release, or a holding hand lost or found again: carry on from where the scene is now.
      if (pending || tracked.length !== anchors.size || tracked.some((id) => !anchors.has(id)))
        rebase(poses, last ?? stage0);
      pending = false;
      if (tracked.length === 1) {
        const id = tracked[0]!;
        last = oneHandPose(stage0, anchors.get(id)!, poses.get(id)!);
      } else if (tracked.length === 2) {
        const [a, b] = tracked as [number, number];
        last = twoHandPose(
          stage0,
          position(anchors.get(a)!),
          position(anchors.get(b)!),
          position(poses.get(a)!),
          position(poses.get(b)!),
        );
      } else return null; // no holding hand tracked: the scene stays where it is
      return last;
    },
  };
}
