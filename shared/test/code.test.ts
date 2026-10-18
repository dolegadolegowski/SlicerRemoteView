import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALPHABET,
  CODE_HINTS,
  CODE_LENGTH,
  CODE_PATTERN,
  isCode,
  normalizeCode,
} from "../ts/index.js";
import { loadSchemas, readJson } from "./helpers.js";

interface Cases {
  cases: ({ input: string } & (
    | { code: string }
    | { error: "INVALID_CODE"; hint: keyof typeof CODE_HINTS; offendingChar?: string }
  ))[];
}
const { cases } = readJson<Cases>(
  resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/codes/normalize-cases.json"),
);

describe("session-code alphabet and normalizeCode (PRO-07, ADR 0008 §7)", () => {
  it("alphabet has 31 symbols without 0 O 1 I L and matches the `code` definition", () => {
    expect(ALPHABET).toHaveLength(31);
    for (const ch of "0O1IL") expect(ALPHABET.includes(ch), ch).toBe(false);
    expect(new Set(ALPHABET).size).toBe(31);
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { pattern: string }
    >;
    expect(defs.code!.pattern).toBe(CODE_PATTERN.source);
    expect(CODE_PATTERN.source).toBe(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
  });

  it("reproduces every committed case: trims, strips separators, upper-cases, hints on 0/O and 1/I/L", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const result = normalizeCode(c.input);
      if ("code" in c) {
        expect(result, c.input).toEqual({ code: c.code });
        expect(isCode(c.code)).toBe(true);
      } else {
        expect(result, c.input).toMatchObject({ error: "INVALID_CODE", hint: CODE_HINTS[c.hint] });
        if (c.offendingChar) expect(result).toMatchObject({ offendingChar: c.offendingChar });
      }
    }
  });

  it("gives the plan's three answers: 7KQ4X, a 0/O hint and a 1/I/L hint", () => {
    expect(normalizeCode(" 7kq4x ")).toEqual({ code: "7KQ4X" });
    const zero = normalizeCode("7KQ0X");
    expect("hint" in zero && zero.hint).toMatch(/0 or O/);
    const one = normalizeCode("7KQ1X");
    expect("hint" in one && one.hint).toMatch(/1, I or L/);
    // Confusables are rejected, never mapped (ADR 0008 §7).
    expect("code" in normalizeCode("7KQOX")).toBe(false);
    expect(normalizeCode("7KQ\u20124X"), "en dash").toEqual({ code: "7KQ4X" });
    expect(normalizeCode("7KQ\u22124X"), "minus sign").toEqual({ code: "7KQ4X" });
  });

  it("isCode accepts only canonical codes", () => {
    expect(isCode("7KQ4X")).toBe(true);
    expect(isCode("7kq4x")).toBe(false);
    expect(isCode("7KQ4")).toBe(false);
    expect(isCode("7KQ0X")).toBe(false);
  });
});
