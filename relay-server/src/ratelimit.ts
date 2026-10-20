/**
 * Per-IP rate limits and the join lockout (docs/protocol.md §12, architecture §8 T1–T3, ADR 0008 §6
 * and errata).
 *
 * Every limit is keyed by `clientKey(ip)`: an HMAC-SHA256 of the client address under a key drawn
 * at start-up, so neither the limiter state nor a log line ever holds a raw IP (NFR-12) and the
 * keys cannot be reversed or compared across restarts. An IPv6 address counts as its /64 (one
 * subscriber's prefix, the default of `@fastify/rate-limit`), an IPv4-mapped one as the IPv4
 * address. Windows are sliding (a timestamp list per key, at most `limit` entries), driven by the
 * injectable clock.
 *
 * - WebSocket upgrades: 30/min/IP → HTTP 429 before the upgrade.
 * - `viewer.join{code}`: 10 attempts/min/IP; a join with the right code gives its attempt back, so
 *   a classroom behind one NAT can join (ADR 0008 consequences). 20 failed joins within 10 min ban
 *   the IP for 10 min. Rejoins by token are not counted (SRV-15).
 * - `session.create`: 5/min/IP.
 * - Global alarm: more than 1,000 failed joins within an hour → one `warn` (counts only) and the
 *   per-IP join limit drops to 3/min until an hour after the alarm.
 * The state is in memory only and resets on redeploy (ADR 0008 consequences). Keys idle for longer
 * than every window are swept; at most `maxKeys` keys are tracked (least recently used dropped
 * first). Bans are kept apart, so evicting a key never lifts its ban.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "./clock.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const RATE_LIMITS = {
  upgradesPerMinute: 30,
  joinsPerMinute: 10,
  joinsPerMinuteAlarm: 3,
  createsPerMinute: 5,
  failuresBeforeBan: 20,
  failureWindowMs: 10 * MINUTE_MS,
  banMs: 10 * MINUTE_MS,
  alarmFailuresPerHour: 1_000,
  alarmMs: HOUR_MS,
} as const;

/**
 * Tracked client keys before the least recently used are dropped: bounds memory under address
 * rotation (measured on Node 22: ≈ 1.4 KiB per key with every window full, ≈ 27 MiB at the cap;
 * ≈ 0.5 KiB for a key with one entry, ≈ 9 MiB at the cap). Bans are bounded by the same number.
 */
export const MAX_TRACKED_KEYS = 20_000;
/** How often `start()` runs the sweep. */
export const LIMITER_SWEEP_INTERVAL_MS = MINUTE_MS;
/** Bucket for a request whose address is unknown (its socket was already gone). */
const UNKNOWN_ADDRESS = "unknown";

/** Outcome of a check: allowed, or refused with the seconds until a retry can succeed. */
export type Verdict = { ok: true } | { ok: false; retryAfterS: number };

interface ClientState {
  upgrades: number[];
  joins: number[];
  creates: number[];
  failures: number[];
}

/**
 * What a client address is counted as: IPv4 as is; IPv4-mapped (`::ffff:a.b.c.d`, also in hex),
 * IPv4-translated and IPv4-compatible IPv6 as the IPv4 address; any other IPv6 address as its /64 prefix
 * (`2001:db8:1:2::/64`), so a host cannot rotate through its own prefix for fresh budgets. A zone id
 * and a `:port` / `[v6]:port` suffix are dropped. `undefined` (no address) and anything that is no IP
 * literal map to the text as given — see `RateLimiter.clientKey`, which reports the latter once.
 */
export function addressBucket(ip: string | undefined): string {
  if (ip === undefined) return UNKNOWN_ADDRESS;
  let address = ip.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) address = address.replace(/:\d+$/, "");
  address = address.split("%")[0]!; // zone id
  if (isIPv4(address)) return address;
  if (isIP(address) !== 6) return address;
  const hextets = expandIPv6(address);
  const zeros = (from: number, to: number): boolean =>
    hextets.slice(from, to).every((hextet) => hextet === "0");
  const mapped = zeros(0, 5) && hextets[5] === "ffff";
  const translated = zeros(0, 4) && hextets[4] === "ffff" && hextets[5] === "0"; // ::ffff:0:a.b.c.d
  const compatible = zeros(0, 6) && !zeros(6, 7); // ::a.b.c.d (deprecated), not ::1 or ::
  if (mapped || translated || compatible) {
    const high = parseInt(hextets[6]!, 16);
    const low = parseInt(hextets[7]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/** The eight hextets of a valid IPv6 address, lower case, without leading zeros. */
function expandIPv6(address: string): string[] {
  let text = address.toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, -v4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((hextet) => parseInt(hextet, 16).toString(16));
}

export interface RateLimiterOptions {
  clock: Clock;
  logger: Logger;
  /** HMAC key for client addresses; default 32 random bytes per process. */
  secret?: Buffer;
  maxKeys?: number;
}

export class RateLimiter {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #secret: Buffer;
  readonly #maxKeys: number;
  /** Windows per key; `Map` order is the LRU order. */
  readonly #clients = new Map<string, ClientState>();
  /** Banned keys → end of the ban; never evicted by the LRU (each ban costs 20 failures). */
  readonly #bans = new Map<string, number>();
  /** Failed joins of all clients per minute (minute number → count), last hour only (alarm, §12). */
  readonly #failuresPerMinute = new Map<number, number>();
  #alarmUntil = 0;
  #reportedNonIp = false;
  #sweepTimer: TimerHandle | undefined;

  constructor(options: RateLimiterOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#secret = options.secret ?? randomBytes(32);
    this.#maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  }

  /**
   * The limiter key of a client address (`addressBucket`): HMAC-SHA256 under the per-boot secret,
   * hex. An address that is no IP literal (e.g. an unexpected `X-Forwarded-For` format, DEP-06) is
   * reported once at `warn`, without the value.
   */
  clientKey(ip: string | undefined): string {
    const bucket = addressBucket(ip);
    const notIp = isIP(bucket) === 0 && !bucket.endsWith("::/64");
    if (ip !== undefined && notIp && !this.#reportedNonIp) {
      this.#reportedNonIp = true;
      this.#logger.warn(
        { event: "client_address_not_ip" },
        "client address is not an IP literal; rate limits key on it as given",
      );
    }
    return createHmac("sha256", this.#secret).update(bucket).digest("hex");
  }

  /** Keys currently tracked (tests check that no raw address is among them). */
  keys(): IterableIterator<string> {
    return this.#clients.keys();
  }

  get alarmActive(): boolean {
    return this.#clock.now() < this.#alarmUntil;
  }

  /** One WebSocket upgrade attempt (30/min). */
  upgrade(key: string): Verdict {
    return this.#take(this.#state(key).upgrades, RATE_LIMITS.upgradesPerMinute, MINUTE_MS);
  }

  /** One `session.create` (5/min). */
  create(key: string): Verdict {
    return this.#take(this.#state(key).creates, RATE_LIMITS.createsPerMinute, MINUTE_MS);
  }

  /**
   * `ok` unless the client is banned for failed joins; `retryAfterS` is the rest of the ban (600 s
   * right after it starts).
   */
  checkBan(key: string): Verdict {
    const until = this.#bans.get(key);
    const now = this.#clock.now();
    if (until === undefined || now >= until) return { ok: true };
    return { ok: false, retryAfterS: Math.ceil((until - now) / 1000) };
  }

  /**
   * One `viewer.join{code}` attempt: refused while banned or above the per-minute limit (3/min
   * while the global alarm is on). Call `joinSucceeded` or `joinFailed` with its outcome.
   */
  join(key: string): Verdict {
    const ban = this.checkBan(key);
    if (!ban.ok) return ban;
    const limit = this.alarmActive ? RATE_LIMITS.joinsPerMinuteAlarm : RATE_LIMITS.joinsPerMinute;
    return this.#take(this.#state(key).joins, limit, MINUTE_MS);
  }

  /**
   * The code was right (joined, or refused `SESSION_FULL`): one attempt is given back, so a
   * classroom behind one NAT can join (ADR 0008 consequences). Attempts are interchangeable, so the
   * most recent one is removed.
   */
  joinSucceeded(key: string): void {
    this.#state(key).joins.pop();
  }

  /**
   * A failed join, or a probe that tells as much (a `preferredCode`): 20 within 10 min ban the
   * client for 10 min; more than 1,000 of all clients within an hour raise the alarm.
   */
  joinFailed(key: string): void {
    const now = this.#clock.now();
    const state = this.#state(key);
    prune(state.failures, now - RATE_LIMITS.failureWindowMs);
    state.failures.push(now);
    if (state.failures.length >= RATE_LIMITS.failuresBeforeBan && this.checkBan(key).ok) {
      this.#ban(key, now + RATE_LIMITS.banMs);
      state.failures.length = 0;
      this.#logger.warn({ event: "client_banned", banS: RATE_LIMITS.banMs / 1000 }, "join lockout");
    }
    const minute = Math.floor(now / MINUTE_MS);
    this.#failuresPerMinute.set(minute, (this.#failuresPerMinute.get(minute) ?? 0) + 1);
    const lastHour = this.#failuresLastHour(now);
    if (lastHour > RATE_LIMITS.alarmFailuresPerHour && !this.alarmActive) {
      this.#alarmUntil = now + RATE_LIMITS.alarmMs;
      this.#logger.warn(
        { event: "join_failure_alarm", failuresLastHour: lastHour },
        "failed joins above the hourly alarm level; per-IP join limit tightened",
      );
    }
  }

  /** Drops clients with nothing left in any window, ended bans and old alarm buckets (every minute). */
  sweep(): void {
    const now = this.#clock.now();
    for (const [key, state] of this.#clients) {
      prune(state.upgrades, now - MINUTE_MS);
      prune(state.joins, now - MINUTE_MS);
      prune(state.creates, now - MINUTE_MS);
      prune(state.failures, now - RATE_LIMITS.failureWindowMs);
      if (
        state.upgrades.length +
          state.joins.length +
          state.creates.length +
          state.failures.length ===
        0
      )
        this.#clients.delete(key);
    }
    for (const [key, until] of this.#bans) if (now >= until) this.#bans.delete(key);
    this.#failuresLastHour(now);
  }

  /** Runs `sweep()` every minute on the injected clock until `stop()`. */
  start(): void {
    this.stop();
    const arm = (): void => {
      this.#sweepTimer = this.#clock.setTimeout(() => {
        this.sweep();
        arm();
      }, LIMITER_SWEEP_INTERVAL_MS);
      (this.#sweepTimer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  stop(): void {
    if (this.#sweepTimer !== undefined) this.#clock.clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  /** The state of `key`, now the most recently used; evicts the least recently used at the cap. */
  #state(key: string): ClientState {
    let state = this.#clients.get(key);
    if (state !== undefined) this.#clients.delete(key);
    else {
      if (this.#clients.size >= this.#maxKeys) {
        const oldest = this.#clients.keys().next();
        if (!oldest.done) this.#clients.delete(oldest.value);
      }
      state = { upgrades: [], joins: [], creates: [], failures: [] };
    }
    this.#clients.set(key, state);
    return state;
  }

  #ban(key: string, until: number): void {
    // At the cap, the ban that ends first makes room (`Map` order is the order bans started).
    if (!this.#bans.has(key) && this.#bans.size >= this.#maxKeys) {
      const first = this.#bans.keys().next();
      if (!first.done) this.#bans.delete(first.value);
    }
    this.#bans.delete(key);
    this.#bans.set(key, until);
  }

  /** Failed joins within the last 60 minutes (minute buckets); drops older buckets. */
  #failuresLastHour(now: number): number {
    const current = Math.floor(now / MINUTE_MS);
    let total = 0;
    for (const [minute, count] of this.#failuresPerMinute)
      if (minute <= current - HOUR_MS / MINUTE_MS) this.#failuresPerMinute.delete(minute);
      else total += count;
    return total;
  }

  /**
   * Sliding window: refuse when `limit` entries lie within `windowMs`, else record now. A slot frees
   * when the entry `limit` places from the end expires (the window may hold more entries than the
   * limit after the alarm lowered it).
   */
  #take(entries: number[], limit: number, windowMs: number): Verdict {
    const now = this.#clock.now();
    prune(entries, now - windowMs);
    if (entries.length >= limit)
      return {
        ok: false,
        retryAfterS: Math.max(
          1,
          Math.ceil((entries[entries.length - limit]! + windowMs - now) / 1000),
        ),
      };
    entries.push(now);
    return { ok: true };
  }
}

/** Removes leading timestamps at or before `cutoff` (entries are in ascending order). */
function prune(entries: number[], cutoff: number): void {
  let drop = 0;
  while (drop < entries.length && entries[drop]! <= cutoff) drop += 1;
  if (drop > 0) entries.splice(0, drop);
}
