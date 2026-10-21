import { describe, expect, it, vi } from "vitest";
import { LANG_STORAGE_KEY, browserStorage, createLangStore, nextLang } from "../../src/i18n/lang";

/** A Storage stand-in that records every write. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
  };
}

describe("language store (WEB-21)", () => {
  it("starts from the browser languages and sets <html lang>, writing nothing until the user chooses", () => {
    const storage = memoryStorage();
    const root = { lang: "en" };
    const store = createLangStore({ storage, languages: ["pl-PL", "en"], root });
    expect(store.lang).toBe("pl");
    expect(root.lang).toBe("pl");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("a stored choice wins over the browser; an unknown stored value is ignored", () => {
    expect(
      createLangStore({ storage: memoryStorage({ [LANG_STORAGE_KEY]: "en" }), languages: "pl" })
        .lang,
    ).toBe("en");
    expect(
      createLangStore({ storage: memoryStorage({ [LANG_STORAGE_KEY]: "xx" }), languages: "pl" })
        .lang,
    ).toBe("pl");
  });

  it("set() switches, updates <html lang>, stores only the language key and tells the listeners", () => {
    const storage = memoryStorage();
    const root = { lang: "" };
    const store = createLangStore({ storage, languages: "en", root });
    const seen: string[] = [];
    store.onChange((lang) => seen.push(lang));
    store.set("pl");
    expect(store.lang).toBe("pl");
    expect(root.lang).toBe("pl");
    expect([...storage.items]).toEqual([[LANG_STORAGE_KEY, "pl"]]); // the language only, never a code (rule 6)
    expect(seen).toEqual(["pl"]);
    store.set("pl"); // the same language: nothing happens
    expect(seen).toEqual(["pl"]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("works without storage, or when storage throws on read or write", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createLangStore({ storage: broken, languages: "pl" });
    expect(store.lang).toBe("pl");
    store.set("en");
    expect(store.lang).toBe("en");
    const none = createLangStore({ storage: null, languages: "en" });
    none.set("pl");
    expect(none.lang).toBe("pl");
  });

  it("a throwing listener does not stop the others; unsubscribe works", () => {
    const store = createLangStore({ languages: "en" });
    const after = vi.fn();
    store.onChange(() => {
      throw new Error("boom");
    });
    const off = store.onChange(after);
    store.set("pl");
    expect(after).toHaveBeenCalledWith("pl");
    off();
    store.set("en");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("browserStorage() is null where reading localStorage throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });

  it("nextLang cycles through the languages", () => {
    expect(nextLang("en")).toBe("pl");
    expect(nextLang("pl")).toBe("en");
  });
});
