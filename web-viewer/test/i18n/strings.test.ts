import { describe, expect, it } from "vitest";
import { STRINGS, pickLang, t } from "../../src/i18n/strings";

describe("i18n strings", () => {
  it("has exactly the same keys in EN and PL, all non-empty", () => {
    expect(Object.keys(STRINGS.pl).sort()).toEqual(Object.keys(STRINGS.en).sort());
    for (const lang of ["en", "pl"] as const) {
      for (const text of Object.values(STRINGS[lang]))
        expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains no raw protocol code anywhere (NFR-31)", () => {
    for (const lang of ["en", "pl"] as const) {
      for (const text of Object.values(STRINGS[lang])) {
        expect(text).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\b4\d{3}\b/);
      }
    }
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(STRINGS.en)) {
      expect(placeholders(STRINGS.pl[key as keyof typeof STRINGS.en])).toEqual(placeholders(text));
    }
  });

  it("picks the language from navigator values and falls back to EN", () => {
    expect(pickLang("pl-PL")).toBe("pl");
    expect(pickLang(["de-DE", "pl", "en"])).toBe("pl");
    expect(pickLang(["en-GB"])).toBe("en");
    expect(pickLang("de-DE")).toBe("en");
    expect(pickLang([])).toBe("en");
    expect(pickLang(undefined)).toBe("en");
  });

  it("substitutes placeholders and leaves unknown ones untouched", () => {
    expect(t("en", "state.downloading.body", { percent: 5 })).toBe("Downloading the scene: 5%");
    expect(t("en", "state.downloading.body")).toContain("{percent}");
    expect(t("en", "state.downloading.body", { other: 1 })).toContain("{percent}");
  });
});
