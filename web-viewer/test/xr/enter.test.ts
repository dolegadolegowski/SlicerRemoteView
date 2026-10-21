import { describe, expect, it, vi } from "vitest";
import type { XrHost } from "../../src/render/viewer";
import { enterXr } from "../../src/xr/enter";
import { XR_SESSION_INIT } from "../../src/xr/support";
import type { XrSystemLike } from "../../src/xr/support";

const run = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("../../src/xr/session", () => ({ runXrSession: run }));

const host = {} as XrHost;
const session = () => ({ end: vi.fn(async () => {}) });
const system = (request: () => Promise<unknown>): XrSystemLike => ({
  isSessionSupported: vi.fn(),
  requestSession: vi.fn(request) as unknown as XrSystemLike["requestSession"],
});

describe("entering XR (WEB-19)", () => {
  it("asks for the session first (the user's tap), then runs it", async () => {
    run.mockReset().mockResolvedValue(undefined);
    const granted = session();
    const xr = system(async () => granted);
    expect(await enterXr(host, xr, "immersive-ar")).toBe(true);
    expect(xr.requestSession).toHaveBeenCalledWith("immersive-ar", XR_SESSION_INIT);
    expect(run).toHaveBeenCalledWith(host, granted, "immersive-ar", {});
    const onEnd = vi.fn();
    await enterXr(host, xr, "immersive-ar", onEnd);
    expect(run).toHaveBeenLastCalledWith(host, granted, "immersive-ar", { onEnd });
  });

  it("a refused request changes nothing", async () => {
    run.mockReset();
    expect(
      await enterXr(
        host,
        system(() => Promise.reject(new Error("denied"))),
        "immersive-vr",
      ),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a session that cannot run is ended, not left hanging", async () => {
    run.mockReset().mockRejectedValue(new Error("setSession failed"));
    const granted = session();
    expect(
      await enterXr(
        host,
        system(async () => granted),
        "immersive-vr",
      ),
    ).toBe(false);
    expect(granted.end).toHaveBeenCalled();
  });
});
