import { describe, expect, it, vi } from "vitest";
import { createXrButton } from "../../src/ui/xr-button";

describe("XR button (WEB-19)", () => {
  it("names the mode, in the UI language, and follows a switch", () => {
    const ar = createXrButton({ mode: "immersive-ar", lang: "en", onClick: () => {} });
    expect(ar.element.textContent).toBe("View in AR");
    expect(ar.element.type).toBe("button");
    ar.setLang("pl");
    expect(ar.element.textContent).toBe("Zobacz w AR");
    expect(
      createXrButton({ mode: "immersive-vr", lang: "en", onClick: () => {} }).element.textContent,
    ).toBe("View in VR");
  });

  it("calls onClick; busy disables it", () => {
    const onClick = vi.fn();
    const button = createXrButton({ mode: "immersive-vr", lang: "en", onClick });
    button.element.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    button.setBusy(true);
    expect(button.element.disabled).toBe(true);
    button.setBusy(false);
    expect(button.element.disabled).toBe(false);
  });
});
