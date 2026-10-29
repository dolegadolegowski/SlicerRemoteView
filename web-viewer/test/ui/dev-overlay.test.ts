import { afterEach, describe, expect, it, vi } from "vitest";
import { startDevOverlay } from "../../src/ui/dev-overlay";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("dev overlay (WEB-16, development builds only)", () => {
  it("shows the GPU counts, refreshes them and goes away when stopped", () => {
    vi.useFakeTimers();
    let info: { geometries: number; textures: number } | null = null;
    const stop = startDevOverlay(() => info);
    const element = document.querySelector<HTMLElement>(".dev-overlay")!;
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.textContent).toBe("no renderer");
    info = { geometries: 7, textures: 0 };
    vi.advanceTimersByTime(500);
    expect(element.textContent).toBe("geometries 7 · textures 0");
    stop();
    expect(document.querySelector(".dev-overlay")).toBeNull();
  });
});
