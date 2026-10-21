import { describe, expect, it } from "vitest";
import { Matrix4, Quaternion, Vector3 } from "three";
import { MAX_SCALE, MIN_SCALE, createGrab, oneHandPose, twoHandPose } from "../../src/xr/grab";

const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
const parts = (m: Matrix4) => {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  m.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
};
/** Where the stage matrix `m` puts a point that sits at `local` in the stage. */
const place = (m: Matrix4, local: Vector3) => local.clone().applyMatrix4(m);

describe("one hand (WEB-20, FR-48)", () => {
  it("the scene follows the hand rigidly: moves and turns with it", () => {
    const stage0 = at(0, 1.4, -1.3);
    const hand0 = at(0.2, 1.2, -0.4);
    const turn = new Matrix4().makeRotationY(Math.PI / 2);
    const hand = at(0.3, 1.3, -0.5).multiply(turn);
    const stage = oneHandPose(stage0, hand0, hand);
    // The point of the scene under the hand stays under it, wherever the hand goes.
    const grabbed = new Vector3(0.2, 1.2, -0.4).applyMatrix4(stage0.clone().invert());
    expect(place(stage, grabbed).distanceTo(new Vector3(0.3, 1.3, -0.5))).toBeLessThan(1e-9);
    expect(
      parts(stage).quaternion.angleTo(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
      ),
    ).toBeLessThan(1e-9);
    expect(parts(stage).scale.x).toBeCloseTo(1, 9);
  });
});

describe("two hands (WEB-20, FR-48: scale from the hands' distance, clamped, turn about the vertical through the midpoint)", () => {
  const stage0 = at(0, 1.4, -1.3);
  const a0 = new Vector3(-0.2, 1.3, -0.8);
  const b0 = new Vector3(0.2, 1.3, -0.8);

  it("hands twice as far apart: the scene twice as large, about their midpoint", () => {
    const stage = twoHandPose(
      stage0,
      a0,
      b0,
      new Vector3(-0.4, 1.3, -0.8),
      new Vector3(0.4, 1.3, -0.8),
    );
    expect(parts(stage).scale.x).toBeCloseTo(2, 9);
    // The midpoint is the fixed point of the scaling.
    const mid = new Vector3(0, 1.3, -0.8);
    const local = mid.clone().applyMatrix4(stage0.clone().invert());
    expect(place(stage, local).distanceTo(mid)).toBeLessThan(1e-9);
  });

  it("the scale stays within 0.1× and 5× of real size", () => {
    const far = twoHandPose(
      stage0,
      a0,
      b0,
      new Vector3(-10, 1.3, -0.8),
      new Vector3(10, 1.3, -0.8),
    );
    expect(parts(far).scale.x).toBeCloseTo(MAX_SCALE, 9);
    const near = twoHandPose(
      stage0,
      a0,
      b0,
      new Vector3(-0.001, 1.3, -0.8),
      new Vector3(0.001, 1.3, -0.8),
    );
    expect(parts(near).scale.x).toBeCloseTo(MIN_SCALE, 9);
    expect([MIN_SCALE, MAX_SCALE]).toEqual([0.1, 5]);
    // A stage already at 4×: doubling the distance stops at 5×, not 8×.
    const big = at(0, 1.4, -1.3).multiply(new Matrix4().makeScale(4, 4, 4));
    const capped = twoHandPose(
      big,
      a0,
      b0,
      new Vector3(-0.4, 1.3, -0.8),
      new Vector3(0.4, 1.3, -0.8),
    );
    expect(parts(capped).scale.x).toBeCloseTo(5, 9);
  });

  it("the line between the hands turns: the scene turns the same way about the midpoint", () => {
    // From left–right to front–back: a quarter turn about the vertical through the midpoint.
    const stage = twoHandPose(stage0, a0, b0, new Vector3(0, 1.3, -0.6), new Vector3(0, 1.3, -1.0));
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(parts(stage).quaternion.angleTo(expected)).toBeLessThan(1e-9);
    expect(parts(stage).scale.x).toBeCloseTo(1, 9);
    const mid = new Vector3(0, 1.3, -0.8);
    expect(
      place(stage, mid.clone().applyMatrix4(stage0.clone().invert())).distanceTo(mid),
    ).toBeLessThan(1e-9);
  });

  it("the midpoint moving carries the scene with it", () => {
    const shift = new Vector3(0.1, 0.05, 0.2);
    const stage = twoHandPose(stage0, a0, b0, a0.clone().add(shift), b0.clone().add(shift));
    expect(parts(stage).position.distanceTo(parts(stage0).position.add(shift))).toBeLessThan(1e-9);
  });

  it("tilting the line between the hands does not tilt the scene (it stays upright)", () => {
    const stage = twoHandPose(
      stage0,
      a0,
      b0,
      new Vector3(-0.2, 1.1, -0.8),
      new Vector3(0.2, 1.5, -0.8),
    );
    expect(parts(stage).quaternion.angleTo(new Quaternion())).toBeLessThan(1e-9);
  });

  it("hands on top of each other: nothing to follow, the scene stays", () => {
    expect(twoHandPose(stage0, a0, a0.clone(), a0, b0).equals(stage0)).toBe(true);
  });
});

describe("grab state (WEB-20)", () => {
  const stage = at(0, 1.4, -1.3);
  const poses = (entries: [number, Matrix4][]) => new Map(entries);
  const pose = (x: number, y = 1.3, z = -0.8) => at(x, y, z);
  const scaleOf = (m: Matrix4) => new Vector3().setFromMatrixScale(m).x;

  it("one hand, then a second, then one lets go: each change carries on from where the scene is", () => {
    const grab = createGrab();
    expect(grab.update(poses([]))).toBeNull();
    grab.press(0, stage);
    expect(grab.held).toBe(true);
    // The frame after the press anchors the hand where it is then: no jump.
    expect(grab.update(poses([[0, at(0, 1, -0.5)]]))!.equals(stage)).toBe(true);
    const moved = grab.update(poses([[0, at(0.1, 1, -0.5)]]))!;
    expect(parts(moved).position.x).toBeCloseTo(0.1, 9);
    // The second hand joins: two-hand mode from the scene as it is now, no jump.
    grab.press(1, moved);
    const both = poses([
      [0, at(0.1, 1, -0.5)],
      [1, at(0.5, 1, -0.5)],
    ]);
    expect(grab.update(both)!.equals(moved)).toBe(true);
    // The first lets go: the second carries on alone, again without a jump.
    grab.release(0, moved);
    expect(grab.update(poses([[1, at(0.5, 1, -0.5)]]))!.equals(moved)).toBe(true);
    grab.release(1, moved);
    expect(grab.held).toBe(false);
    expect(grab.update(poses([[1, at(1, 1, 1)]]))).toBeNull();
  });

  it("a hand that moved between its press and the next frame does not drag the scene by that movement", () => {
    const grab = createGrab();
    grab.press(0, stage); // the event comes before the frame's poses …
    expect(grab.update(poses([[0, pose(0.09)]]))!.equals(stage)).toBe(true); // … which anchor the hand
  });

  it("letting go of one of two hands after spreading them keeps the size reached", () => {
    const grab = createGrab();
    grab.press(0, stage);
    grab.press(1, stage);
    grab.update(
      poses([
        [0, pose(-0.2)],
        [1, pose(0.2)],
      ]),
    );
    const spread = grab.update(
      poses([
        [0, pose(-0.4)],
        [1, pose(0.4)],
      ]),
    )!;
    expect(scaleOf(spread)).toBeCloseTo(2, 9);
    grab.release(0, spread);
    expect(grab.update(poses([[1, pose(0.4)]]))!.equals(spread)).toBe(true);
  });

  it("a holding hand that loses tracking: no jump when it goes, none when it comes back", () => {
    const grab = createGrab();
    grab.press(0, stage);
    grab.press(1, stage);
    grab.update(
      poses([
        [0, pose(-0.1)],
        [1, pose(0.1)],
      ]),
    );
    const big = grab.update(
      poses([
        [0, pose(-0.3)],
        [1, pose(0.3)],
      ]),
    )!;
    expect(scaleOf(big)).toBeCloseTo(3, 9);
    const alone = grab.update(poses([[0, pose(-0.3)]]))!; // hand 1 out of view
    expect(alone.equals(big)).toBe(true);
    const back = grab.update(
      poses([
        [0, pose(-0.3)],
        [1, pose(0.5)],
      ]),
    )!; // back, somewhere else
    expect(back.equals(big)).toBe(true);
    expect(grab.update(poses([]))).toBeNull(); // nothing tracked: the scene stays
    expect(grab.held).toBe(true);
  });

  it("turning the line between the hands through a half turn keeps the scene upright", () => {
    const grab = createGrab();
    grab.press(0, stage);
    grab.press(1, stage);
    let m = stage;
    for (let deg = 0; deg <= 180; deg += 5) {
      const r = (deg * Math.PI) / 180;
      const [cx, cz] = [0.2 * Math.cos(r), -0.2 * Math.sin(r)];
      m = grab.update(
        poses([
          [0, pose(-cx, 1.27, -0.8 - cz)], // 6 cm height difference between the hands
          [1, pose(cx, 1.33, -0.8 + cz)],
        ]),
      )!;
    }
    const up = new Vector3(0, 1, 0).applyQuaternion(parts(m).quaternion);
    expect(up.y).toBeGreaterThan(0.999);
  });

  it("pressing a holding hand again, or releasing one that does not hold, changes nothing", () => {
    const grab = createGrab();
    grab.press(0, stage);
    grab.update(poses([[0, pose(0)]]));
    const moved = grab.update(poses([[0, pose(0.1)]]))!;
    grab.release(1, moved);
    expect(grab.update(poses([[0, pose(0.1)]]))!.equals(moved)).toBe(true);
  });
});
