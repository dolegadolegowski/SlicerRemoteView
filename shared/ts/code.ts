/**
 * Session-code alphabet and input normalisation (`docs/protocol.md` §4.2, ADR 0008 §7).
 *
 * Codes are 5 symbols from a 31-symbol alphabet without `0 O 1 I L`. Typed input is trimmed,
 * stripped of `-`/space separators and upper-cased; anything outside the alphabet is rejected
 * with a targeted hint — never mapped, because both members of each confusable pair are absent.
 */

export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 5;
/** Same expression as `defs.schema.json#/definitions/code`. */
export const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;

/** User-facing hints of ADR 0008 §7 (English source strings; UIs may localise). */
export const CODE_HINTS = {
  zeroOrO: "codes never contain 0 or O — check that character",
  oneIorL: "codes never contain 1, I or L",
  notInAlphabet: "codes use only the letters A–Z (except I, L, O) and the digits 2–9",
  length: `codes have exactly ${CODE_LENGTH} characters`,
  empty: "type the 5-character code shown in 3D Slicer",
} as const;

export type CodeHint = (typeof CODE_HINTS)[keyof typeof CODE_HINTS];

export type NormalizedCode =
  { code: string } | { error: "INVALID_CODE"; hint: CodeHint; offendingChar?: string };

/**
 * Separators users type or paste between symbols: any whitespace, ASCII `-`, the Unicode dashes
 * U+2010 (hyphen) … U+2015 (horizontal bar) and U+2212 (minus sign).
 */
const SEPARATORS = /[\s\u002D\u2010-\u2015\u2212]/gu;

/**
 * `" 7kq4x "` → `{ code: "7KQ4X" }`; `"7KQ0X"` → hint about `0`/`O`; `"7KQ1X"` → hint about
 * `1`/`I`/`L`. The first offending character decides the hint; length is checked last so a
 * misread symbol is reported before a miscount.
 */
export function normalizeCode(input: string): NormalizedCode {
  const stripped = input.replace(SEPARATORS, "").toUpperCase();
  if (stripped.length === 0) return { error: "INVALID_CODE", hint: CODE_HINTS.empty };
  for (const ch of stripped) {
    if (ALPHABET.includes(ch)) continue;
    const hint =
      ch === "0" || ch === "O"
        ? CODE_HINTS.zeroOrO
        : ch === "1" || ch === "I" || ch === "L"
          ? CODE_HINTS.oneIorL
          : CODE_HINTS.notInAlphabet;
    return { error: "INVALID_CODE", hint, offendingChar: ch };
  }
  if (stripped.length !== CODE_LENGTH) return { error: "INVALID_CODE", hint: CODE_HINTS.length };
  return { code: stripped };
}

/** True for a canonical code (already upper-case, no separators). */
export function isCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}
