import { describe, expect, it } from "vitest";
import { DEFAULT_EYE_HEIGHT_M, XR_DISTANCE_M, xrStagePosition } from "../../src/xr/placement";

describe("XR placement (WEB-19, US-14/15: in front at 1.3 m)", () => {
  it("moves the model centre to 1.3 m ahead (−Z) at the eye height", () => {
    const centre = { x: 0.1, y: -0.05, z: 0.2 };
    const at = xrStagePosition(centre, 1.6);
    expect({ x: at.x + centre.x, y: at.y + centre.y, z: at.z + centre.z }).toEqual({
      x: 0,
      y: 1.6,
      z: -XR_DISTANCE_M,
    });
    expect(XR_DISTANCE_M).toBe(1.3);
  });

  it("uses a default eye height before tracking reports a plausible one", () => {
    for (const eye of [Number.NaN, 0, -1, 0.2, 3])
      expect(xrStagePosition({ x: 0, y: 0, z: 0 }, eye).y).toBe(DEFAULT_EYE_HEIGHT_M);
    expect(xrStagePosition({ x: 0, y: 0, z: 0 }, 1.2).y).toBe(1.2); // seated
  });
});
