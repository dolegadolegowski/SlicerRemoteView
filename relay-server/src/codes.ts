/**
 * Session codes and credentials (docs/protocol.md §4.1–§4.2, §12; ADR 0008 §2, §4; architecture §3).
 *
 * Codes: 5 symbols drawn independently with `crypto.randomInt` from the 31-symbol alphabet of
 * `@slicerremoteview/shared` (PRO-07), redrawn while the caller says the code is taken (live in the
 * registry or quarantined). Tokens: 256 random bits, base64url, prefixed `pt_`/`vt_`; the relay
 * keeps only their SHA-256 and compares hashes in constant time. Nothing here logs.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ALPHABET, CODE_LENGTH, isCode } from "@slicerremoteview/shared";

/** `crypto.randomInt(min, max)`: uniform integer in `[min, max)`. Injectable for tests. */
export type RandomInt = (min: number, max: number) => number;

/**
 * Redraws before giving up. Even with `MAX_SESSIONS` at its 10,000 ceiling plus a full quarantine
 * the share of taken codes stays below 1 % of 31^5, so 64 consecutive collisions mean a broken RNG
 * or caller.
 */
export const MAX_CODE_ATTEMPTS = 64;

export class CodeSpaceExhaustedError extends Error {
  constructor() {
    super(`no free session code after ${MAX_CODE_ATTEMPTS} attempts`);
    this.name = "CodeSpaceExhaustedError";
  }
}

/** A uniformly random code for which `isTaken` is false (ADR 0008 §2). */
export function generateCode(
  isTaken: (code: string) => boolean,
  rng: RandomInt = randomInt,
): string {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      const index = rng(0, ALPHABET.length);
      if (!Number.isInteger(index) || index < 0 || index >= ALPHABET.length)
        throw new RangeError("rng returned an index outside the alphabet");
      code += ALPHABET[index];
    }
    if (!isTaken(code)) return code;
  }
  throw new CodeSpaceExhaustedError();
}

/**
 * True for a canonical code: exactly 5 alphabet symbols, already upper-case, no separators.
 * The relay does not normalise `preferredCode` (§4.1: "well-formed" or ignored); `viewer.join`
 * input normalisation is SRV-07.
 */
export function isWellFormed(code: unknown): code is string {
  return typeof code === "string" && isCode(code);
}

/** Bound on quarantine entries (≈ 100 B each); only a create/close flood beyond SRV-08's limits gets near it. */
export const MAX_QUARANTINED_CODES = 100_000;

/**
 * Recently released codes, kept out of circulation for `CODE_QUARANTINE_S` so a viewer typing the
 * code of a session that just ended never lands in a different presenter's scene (ADR 0008 §2,
 * architecture §3). Expired entries are dropped on lookup and by `sweep()`; beyond `maxEntries`
 * the oldest release is forgotten first, so memory stays bounded.
 */
export class CodeQuarantine {
  /** Insertion order = release order (re-adding moves a code to the end). */
  readonly #releasedUntil = new Map<string, number>();
  #evicted = 0;

  /** Throws `RangeError` for a non-positive TTL: the quarantine can be shortened, not disabled (SRV-02). */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = MAX_QUARANTINED_CODES,
  ) {
    if (!(ttlMs > 0)) throw new RangeError("the code quarantine needs a positive TTL");
  }

  add(code: string): void {
    this.#releasedUntil.delete(code);
    this.#releasedUntil.set(code, this.now() + this.ttlMs);
    for (const oldest of this.#releasedUntil.keys()) {
      if (this.#releasedUntil.size <= this.maxEntries) break;
      this.#releasedUntil.delete(oldest);
      this.#evicted++;
    }
  }

  /** Codes released early because the quarantine was full (a metric for SRV-19; T1 residual risk). */
  get evicted(): number {
    return this.#evicted;
  }

  has(code: string): boolean {
    const until = this.#releasedUntil.get(code);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.#releasedUntil.delete(code);
    return false;
  }

  /** Drops expired entries; returns how many were dropped. */
  sweep(): number {
    const now = this.now();
    let dropped = 0;
    for (const [code, until] of this.#releasedUntil)
      if (now >= until) {
        this.#releasedUntil.delete(code);
        dropped++;
      }
    return dropped;
  }

  get size(): number {
    return this.#releasedUntil.size;
  }
}

export type TokenPrefix = "pt_" | "vt_";

/** A fresh credential: prefix + 256 random bits as base64url (43 chars) — §4.2, §5.2, NFR-17. */
export function newToken(prefix: TokenPrefix): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** SHA-256 of a token; the only form in which the relay keeps credentials (NFR-17). */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time equality for equal-length byte strings; `false` when the lengths differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * True when `candidate` hashes to `hash`. Hashing first makes the comparison independent of the
 * candidate's length and content (only fixed-size digests are compared).
 */
export function tokenMatches(candidate: string, hash: Uint8Array): boolean {
  return constantTimeEqual(hashToken(candidate), hash);
}
