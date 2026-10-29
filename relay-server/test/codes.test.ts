import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ALPHABET, validateMessage } from "@slicerremoteview/shared";
import {
  CodeQuarantine,
  CodeSpaceExhaustedError,
  constantTimeEqual,
  generateCode,
  hashToken,
  isWellFormed,
  MAX_CODE_ATTEMPTS,
  newToken,
  tokenMatches,
} from "../src/codes.js";
import type { RandomInt } from "../src/codes.js";

const free = (): boolean => false;

/** An RNG that spells the given codes symbol by symbol, then fails. */
function spelling(...codes: string[]): RandomInt {
  const indices = codes.flatMap((code) => [...code].map((ch) => ALPHABET.indexOf(ch)));
  return vi.fn((min: number, max: number) => {
    expect([min, max]).toEqual([0, 31]);
    const next = indices.shift();
    if (next === undefined) throw new Error("RNG exhausted");
    return next;
  });
}

describe("generateCode (SRV-03, FR-19, ADR 0008)", () => {
  it("draws 5 symbols of the 31-symbol alphabet, 100,000 times", () => {
    expect(ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    const shape = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/;
    for (let i = 0; i < 100_000; i++) {
      const code = generateCode(free);
      if (!shape.test(code)) expect.fail(`malformed code at draw ${i}`);
    }
  });

  it("redraws when the first code is taken", () => {
    const rng = spelling("7KQ4X", "ABCDE");
    const isTaken = vi.fn((code: string) => code === "7KQ4X");
    expect(generateCode(isTaken, rng)).toBe("ABCDE");
    expect(isTaken).toHaveBeenCalledTimes(2);
    expect(rng).toHaveBeenCalledTimes(10);
  });

  it("redraws a quarantined code until the quarantine expires", () => {
    let now = 0;
    const quarantine = new CodeQuarantine(600_000, () => now);
    quarantine.add("7KQ4X");
    expect(generateCode((c) => quarantine.has(c), spelling("7KQ4X", "ABCDE"))).toBe("ABCDE");
    now = 599_999;
    expect(generateCode((c) => quarantine.has(c), spelling("7KQ4X", "ABCDE"))).toBe("ABCDE");
    now = 600_000;
    expect(generateCode((c) => quarantine.has(c), spelling("7KQ4X"))).toBe("7KQ4X");
  });

  it(`gives up after ${MAX_CODE_ATTEMPTS} collisions`, () => {
    const isTaken = vi.fn(() => true);
    expect(() => generateCode(isTaken)).toThrow(CodeSpaceExhaustedError);
    expect(isTaken).toHaveBeenCalledTimes(MAX_CODE_ATTEMPTS);
  });

  it("is uniform: each symbol is 1/31 ± 10 % of 310,000 draws", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 62_000; i++)
      for (const ch of generateCode(free)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect([...counts.keys()].sort().join("")).toBe(ALPHABET);
    for (const [, count] of counts) {
      expect(count).toBeGreaterThanOrEqual(9_000);
      expect(count).toBeLessThanOrEqual(11_000);
    }
    // ±10 % alone misses byte-modulo bias (`randomBytes(1)[0] % 31` stays inside it); a chi-square
    // bound does not: 30 degrees of freedom, P(χ² > 83) ≈ 1e-6 for a uniform generator.
    const chiSquare = [...counts.values()].reduce((sum, n) => sum + (n - 10_000) ** 2 / 10_000, 0);
    expect(chiSquare).toBeLessThan(83);
  });

  it("rejects an RNG that returns an index outside the alphabet", () => {
    expect(() => generateCode(free, () => 31)).toThrow(RangeError);
    expect(() => generateCode(free, () => 1.5)).toThrow(RangeError);
  });
});

describe("isWellFormed", () => {
  it.each(["7KQ4X", "ABCDE", "22222", "ZZZZZ"])("accepts %s", (code) => {
    expect(isWellFormed(code)).toBe(true);
  });

  it.each([
    "7kq4x",
    "7KQ4",
    "7KQ4XX",
    "7KQ0X",
    "7KQOX",
    "7KQ1X",
    "7KQIX",
    "7KQLX",
    " 7KQ4X",
    "7KQ-4X",
    "",
    null,
    42,
    undefined,
  ])("rejects %j", (code) => {
    expect(isWellFormed(code)).toBe(false);
  });
});

describe("CodeQuarantine (CODE_QUARANTINE_S, ADR 0008 §2)", () => {
  it("holds a released code for exactly the TTL", () => {
    let now = 1_000;
    const quarantine = new CodeQuarantine(600_000, () => now);
    quarantine.add("7KQ4X");
    expect(quarantine.has("7KQ4X")).toBe(true);
    expect(quarantine.has("ABCDE")).toBe(false);
    now += 599_999;
    expect(quarantine.has("7KQ4X")).toBe(true);
    now += 1;
    expect(quarantine.has("7KQ4X")).toBe(false);
    expect(quarantine.size).toBe(0);
  });

  it("sweep drops only expired entries", () => {
    let now = 0;
    const quarantine = new CodeQuarantine(100, () => now);
    quarantine.add("AAAAA");
    now = 50;
    quarantine.add("BBBBB");
    now = 100;
    expect(quarantine.sweep()).toBe(1);
    expect(quarantine.size).toBe(1);
    expect(quarantine.has("BBBBB")).toBe(true);
    now = 150;
    expect(quarantine.sweep()).toBe(1);
    expect(quarantine.size).toBe(0);
  });

  it("re-adding a code restarts its quarantine", () => {
    let now = 0;
    const quarantine = new CodeQuarantine(100, () => now);
    quarantine.add("AAAAA");
    now = 90;
    quarantine.add("AAAAA");
    now = 150;
    expect(quarantine.has("AAAAA")).toBe(true);
  });

  it("forgets the oldest release beyond its capacity", () => {
    let now = 0;
    const quarantine = new CodeQuarantine(600_000, () => now, 3);
    for (const code of ["AAAAA", "BBBBB", "CCCCC"]) {
      quarantine.add(code);
      now += 1;
    }
    quarantine.add("AAAAA"); // re-release moves AAAAA to the end
    quarantine.add("DDDDD");
    expect(quarantine.size).toBe(3);
    expect(quarantine.evicted).toBe(1);
    expect(["AAAAA", "BBBBB", "CCCCC", "DDDDD"].map((c) => quarantine.has(c))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it("cannot be disabled (SRV-02: CODE_QUARANTINE_S >= 60)", () => {
    expect(() => new CodeQuarantine(0, () => 0)).toThrow(RangeError);
    expect(() => new CodeQuarantine(-1, () => 0)).toThrow(RangeError);
  });
});

describe("tokens (NFR-17, §4.2, §5.2)", () => {
  it("are prefixed base64url with 256 random bits and unique", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const token = newToken(i % 2 ? "pt_" : "vt_");
      expect(token).toMatch(/^(pt|vt)_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token.slice(3), "base64url")).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1_000);
  });

  it("and codes satisfy the protocol schema of session.created (§4.2)", () => {
    const message = {
      protocolVersion: "1.0",
      type: "session.created",
      sessionId: "sess_0123456789ABCDEF",
      code: generateCode(free),
      publisherToken: newToken("pt_"),
      viewerLimit: 20,
      ttl: { graceS: 120, idleS: 1_800, maxLifetimeS: 43_200, expiresAt: 0 },
      limits: { maxSnapshotBytes: 1, maxChunkBytes: 65_536, maxTextBytes: 1, maxChanges: 1 },
    };
    expect(validateMessage(message)).toMatchObject({ ok: true });
  });

  it("are stored as their SHA-256", () => {
    const token = newToken("pt_");
    const hash = hashToken(token);
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(hash.toString("latin1")).not.toContain(token);
  });

  it("match only the exact token", () => {
    const token = newToken("vt_");
    const hash = hashToken(token);
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(token.slice(0, -1), hash)).toBe(false);
    expect(tokenMatches(`${token}x`, hash)).toBe(false);
    expect(tokenMatches(newToken("vt_"), hash)).toBe(false);
    expect(tokenMatches("", hash)).toBe(false);
  });

  it("constantTimeEqual compares bytes and rejects different lengths", () => {
    expect(constantTimeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toBe(false);
  });
});
