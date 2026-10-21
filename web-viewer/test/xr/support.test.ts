import { describe, expect, it, vi } from "vitest";
import { XR_SESSION_INIT, xrMode } from "../../src/xr/support";
import type { XrMode, XrSystemLike } from "../../src/xr/support";

/** A `navigator.xr` that supports `modes`. */
const system = (...modes: XrMode[]): XrSystemLike => ({
  isSessionSupported: vi.fn(async (mode: XrMode) => modes.includes(mode)),
  requestSession: vi.fn(),
});

describe("which XR mode the viewer offers (WEB-19, FR-47)", () => {
  it("AR (passthrough) on Quest Browser when supported, else VR", async () => {
    expect(await xrMode(system("immersive-ar", "immersive-vr"), "quest-browser")).toBe(
      "immersive-ar",
    );
    expect(await xrMode(system("immersive-vr"), "quest-browser")).toBe("immersive-vr");
  });

  it("nothing without navigator.xr (iOS Safari), outside Quest Browser, or with no immersive mode", async () => {
    expect(await xrMode(undefined, "quest-browser")).toBeNull();
    const supported = system("immersive-ar", "immersive-vr");
    expect(await xrMode(supported, "web")).toBeNull(); // a phone's handheld AR or a desktop headset
    expect(supported.isSessionSupported).not.toHaveBeenCalled();
    expect(await xrMode(system(), "quest-browser")).toBeNull();
  });

  it("nothing when the check is refused", async () => {
    const refusing: XrSystemLike = {
      isSessionSupported: () => Promise.reject(new Error("SecurityError")),
      requestSession: vi.fn(),
    };
    expect(await xrMode(refusing, "quest-browser")).toBeNull();
  });

  it("asks for floor-level space and hands (three.js adds neither)", () => {
    expect(XR_SESSION_INIT.optionalFeatures).toEqual(["local-floor", "hand-tracking"]);
    expect(XR_SESSION_INIT.requiredFeatures).toBeUndefined(); // a session without hands still starts
  });
});
