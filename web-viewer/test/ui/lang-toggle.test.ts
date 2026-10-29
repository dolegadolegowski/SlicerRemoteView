import { describe, expect, it } from "vitest";
import { createLangStore } from "../../src/i18n/lang";
import { createLangToggle } from "../../src/ui/lang-toggle";

describe("language switch (WEB-21)", () => {
  it("names the other language in that language, with its lang attribute; the text is the accessible name", () => {
    const store = createLangStore({ languages: "en" });
    const toggle = createLangToggle(store);
    expect(toggle.element.type).toBe("button"); // never submits the code entry's form
    expect(toggle.element.textContent).toBe("Polski");
    expect(toggle.element.lang).toBe("pl");
    expect(toggle.element.hasAttribute("aria-label")).toBe(false);
  });

  it("a click switches the store; it follows a switch made elsewhere too", () => {
    const store = createLangStore({ languages: "en" });
    const toggle = createLangToggle(store, { className: "status-bar__lang" });
    expect(toggle.element.className).toBe("status-bar__lang");
    toggle.element.click();
    expect(store.lang).toBe("pl");
    expect(toggle.element.textContent).toBe("English");
    expect(toggle.element.lang).toBe("en");
    store.set("en"); // e.g. the other switch, on the code entry
    expect(toggle.element.textContent).toBe("Polski");
  });

  it("dispose stops it following the store and removes it", () => {
    const store = createLangStore({ languages: "en" });
    const toggle = createLangToggle(store);
    document.body.append(toggle.element);
    toggle.dispose();
    store.set("pl");
    expect(toggle.element.textContent).toBe("Polski");
    expect(toggle.element.isConnected).toBe(false);
  });
});
