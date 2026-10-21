import { describe, expect, it, vi } from "vitest";
import { createStatusBar } from "../../src/ui/status-bar";

const part = (bar: { element: HTMLElement }, name: string) =>
  bar.element.querySelector<HTMLElement>(`.status-bar__${name}`)!;

describe("status bar (WEB-15)", () => {
  it("is a labelled group whose connection state alone is a live region", () => {
    const bar = createStatusBar({ lang: "en" });
    expect(bar.element.getAttribute("role")).toBe("group");
    expect(bar.element.getAttribute("aria-label")).toBe("Session status");
    expect(part(bar, "connection").getAttribute("role")).toBe("status");
    expect(part(bar, "viewers").getAttribute("role")).toBeNull();
    expect(part(bar, "connection").textContent).toBe("Connected");
    expect(part(bar, "viewers").hidden).toBe(true);
    expect(part(bar, "version").hidden).toBe(true);
  });

  it("shows the connection, the viewer count and the scene version", () => {
    const bar = createStatusBar({ lang: "en" });
    bar.setConnection("reconnecting");
    expect(part(bar, "connection").textContent).toBe("Reconnecting…");
    expect(bar.element.dataset["connection"]).toBe("reconnecting");
    bar.setConnection("presenterOffline");
    expect(part(bar, "connection").textContent).toBe("Presenter is offline");
    bar.setViewers(4);
    expect(part(bar, "viewers").textContent).toBe("Viewers: 4");
    expect(part(bar, "viewers").hidden).toBe(false);
    bar.setSceneVersion(42);
    expect(part(bar, "version").textContent).toBe("Scene v42");
    bar.setViewers(null);
    bar.setSceneVersion(null);
    expect(part(bar, "viewers").hidden).toBe(true);
    expect(part(bar, "version").hidden).toBe(true);
  });

  it("an unchanged state keeps its text node (not announced again)", () => {
    const bar = createStatusBar({ lang: "en" });
    const text = part(bar, "connection").firstChild;
    bar.setConnection("connected");
    expect(part(bar, "connection").firstChild).toBe(text);
  });

  it("has a Leave button only when it is given onLeave, which a click calls (WEB-22)", () => {
    expect(part(createStatusBar({ lang: "en" }), "leave")).toBeNull();
    const onLeave = vi.fn();
    const bar = createStatusBar({ lang: "en", onLeave });
    const leave = part(bar, "leave") as HTMLButtonElement;
    expect(leave.type).toBe("button");
    expect(leave.textContent).toBe("Leave");
    expect(bar.element.lastElementChild).toBe(leave); // after the parts it does not belong to
    leave.click();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("speaks Polish", () => {
    expect(part(createStatusBar({ lang: "pl", onLeave: () => {} }), "leave").textContent).toBe(
      "Wyjdź",
    );
    const bar = createStatusBar({ lang: "pl" });
    bar.setViewers(3);
    bar.setSceneVersion(7);
    expect(part(bar, "connection").textContent).toBe("Połączono");
    expect(part(bar, "viewers").textContent).toBe("Widzowie: 3");
    expect(part(bar, "version").textContent).toBe("Scena v7");
  });
});
