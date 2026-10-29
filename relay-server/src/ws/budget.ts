/**
 * Per-socket message budget (T3; architecture §4; SRV-25): byte-weighted token buckets over what a
 * client sends — text frames, binary frames and WebSocket `ping`/`pong` control frames. Each frame
 * costs its bytes plus its bucket's `frameCost` (dispatch, validation, the reply, a publisher's
 * fan-out), so one 256 KiB frame weighs no less than 256 KiB of small ones: `JSON.parse` cost grows
 * with the bytes (≈ 20 ms per MiB of dense JSON, branch audit).
 *
 * - Text and control frames share one bucket, sized by what the socket is: before its handshake
 *   completes a small one (`unbound`, until `4012`), then the viewer's or the publisher's. A
 *   publisher's frames cost 32 KiB more each, so it sends at most ≈ 128 a second, while the
 *   protocol's own ceiling — a 256 KiB update every 100 ms (§3.3, §8.1) — never meets its budget.
 *   Binary frames (snapshot chunks, publishers only) have their own bucket: two maximal snapshots
 *   (64 MiB in 64 KiB chunks each) fit its burst, and a tiny binary frame costs 16 KiB.
 * - What a bucket cannot pay is up to `endpoint.ts`: a viewer's or an unbound socket's frame is
 *   dropped unparsed, and the socket is told `RATE_LIMITED{retryAfterS}` — again if it is still
 *   limited once that time has passed; a publisher is closed at once (a dropped `begin`, `end` or
 *   update would leave a snapshot or the versions half applied). A socket that sends on until it
 *   owes a second burst is closed `4006`. §9.2 defines `RATE_LIMITED` for join and create attempts
 *   only (reported).
 * Buckets refill on the injected clock; nothing is logged per frame.
 */
import type { Clock } from "../clock.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** What a bucket may hold and refill, and what each frame costs on top of its bytes. */
export interface BucketLimits {
  /** Bytes per second the bucket refills. */
  readonly rate: number;
  /** The most it holds: what a socket may send at once. */
  readonly burst: number;
  /** Charged per frame on top of its bytes. */
  readonly frameCost: number;
}

/** The buckets of each kind of socket. */
export interface MessageBudgets {
  /** Before the handshake completes: one 256 KiB `session.create`/`resume` and some retries. */
  readonly unbound: BucketLimits;
  /** Join, `ping` every 15 s, `scene.request`, leave — 16 KiB frames at most (§3.3). */
  readonly viewer: BucketLimits;
  /**
   * Updates (≤ 256 KiB each, debounced 100–250 ms, §8.1), snapshot control, renewals, pings: a
   * maximal update every 100 ms (≈ 2.8 MiB/s with the frame cost), or three every 250 ms (a split
   * change), with room to spare; the ≤ 120 visible nodes of §7.5 make ≈ 30 KiB updates.
   */
  readonly publisher: BucketLimits;
  /**
   * Snapshot chunks (≥ 64 KiB but the last, §6.2): two whole 64 MiB snapshots at once, in 64 KiB
   * chunks with their headers and frame costs; a 16 KiB frame cost, because a tiny binary frame
   * costs the relay about what a chunk does. 32 MiB/s (≈ 270 Mbit/s): closing is the penalty, so it
   * stays above typical presenter uplinks and above re-exporting a 20 MiB scene every second
   * (mesh-level debounce 500–1000 ms, §8.1); streamed viewers pace it further (the fan-out's pause).
   */
  readonly publisherBinary: BucketLimits;
}

export const DEFAULT_MESSAGE_BUDGETS: MessageBudgets = {
  unbound: { rate: 16 * KIB, burst: 512 * KIB, frameCost: 512 },
  viewer: { rate: 8 * KIB, burst: 64 * KIB, frameCost: 512 },
  publisher: { rate: 4 * MIB, burst: 4 * MIB, frameCost: 32 * KIB },
  publisherBinary: { rate: 32 * MIB, burst: 161 * MIB, frameCost: 16 * KIB },
};

/** What a bucket says about a frame. */
export type Verdict = "ok" | "limited" | "exceeded";

/** A token bucket in bytes that may run into debt down to one burst. */
export class TokenBucket {
  #tokens: number;
  #at: number;

  constructor(
    readonly limits: BucketLimits,
    now: number,
  ) {
    this.#tokens = limits.burst;
    this.#at = now;
  }

  /**
   * Charges a frame of `bytes` (plus `frameCost`) at `now`: `ok` while the bucket can pay,
   * `limited` while the debt is within one burst, `exceeded` beyond it.
   */
  take(bytes: number, now: number): Verdict {
    const elapsed = Math.max(0, now - this.#at) / 1000;
    this.#at = now;
    this.#tokens = Math.min(this.limits.burst, this.#tokens + elapsed * this.limits.rate);
    const cost = bytes + this.limits.frameCost;
    this.#tokens -= cost;
    if (this.#tokens >= 0) return "ok";
    return this.#tokens >= -this.limits.burst ? "limited" : "exceeded";
  }

  /** Whole seconds until the debt is paid and a small frame (1 KiB) can be paid too (at least 1). */
  get retryAfterS(): number {
    const owed = KIB + this.limits.frameCost - this.#tokens;
    return Math.max(1, Math.ceil(owed / this.limits.rate));
  }
}

/** One bucket, and until when its socket was told to wait (it is told again after that). */
interface Account {
  bucket: TokenBucket;
  quietUntil: number;
}

/** The text and binary accounts of one socket. */
interface SocketBudget {
  stage: keyof MessageBudgets;
  text: Account;
  binary: Account | undefined;
}

export interface BudgetSubject {
  readonly role: "publisher" | "viewer" | undefined;
  readonly bound: boolean;
}

export interface Charge {
  verdict: Verdict;
  /** For a `limited` frame: tell the socket (the first one, and the first after `retryAfterS`). */
  warn: boolean;
  retryAfterS: number;
}

/** The budgets of all sockets, keyed by the socket (nothing outlives it). */
export function messageBudgets(clock: Clock, budgets: MessageBudgets = DEFAULT_MESSAGE_BUDGETS) {
  const sockets = new WeakMap<BudgetSubject, SocketBudget>();

  function stageOf(subject: BudgetSubject): keyof MessageBudgets {
    if (!subject.bound || subject.role === undefined) return "unbound";
    return subject.role;
  }

  const account = (limits: BucketLimits, now: number): Account => ({
    bucket: new TokenBucket(limits, now),
    quietUntil: -Infinity,
  });

  /** The socket's budget; a new, full one once it is bound (its role's limits apply from then). */
  function budgetOf(subject: BudgetSubject): SocketBudget {
    const stage = stageOf(subject);
    const now = clock.now();
    let budget = sockets.get(subject);
    if (budget === undefined || budget.stage !== stage) {
      budget = {
        stage,
        text: account(budgets[stage], now),
        binary: stage === "publisher" ? account(budgets.publisherBinary, now) : undefined,
      };
      sockets.set(subject, budget);
    }
    return budget;
  }

  /** Charges a frame of `bytes`: a text or control frame to `text`, a snapshot chunk to `binary`. */
  function charge(subject: BudgetSubject, kind: "text" | "binary", bytes: number): Charge {
    const budget = budgetOf(subject);
    // A socket without a chunk bucket (anyone but a bound publisher, e.g. a closing socket's frame
    // charged by `endpoint.ts` `unread`) pays from its text bucket.
    const charged = (kind === "binary" ? budget.binary : undefined) ?? budget.text;
    const now = clock.now();
    const verdict = charged.bucket.take(bytes, now);
    const retryAfterS = charged.bucket.retryAfterS;
    const warn = verdict === "limited" && now >= charged.quietUntil;
    if (warn) charged.quietUntil = now + retryAfterS * 1000;
    return { verdict, warn, retryAfterS };
  }

  return { charge };
}
