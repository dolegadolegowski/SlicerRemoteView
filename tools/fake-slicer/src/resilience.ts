/**
 * Connection resilience of the publisher (PRO-16): application heartbeat (§9.1), reconnect delays (§9.1, §9.3)
 * and the close codes that end a run instead of triggering a reconnect. Pure and timer-driven, so the tests
 * drive it with fake timers.
 */

export interface Timing {
  /** Application `ping` every 15 s (§9.1). */
  pingIntervalMs: number;
  /** `pong` expected within 10 s, else the socket is closed and re-opened (§9.1). */
  pongTimeoutMs: number;
  /** Reconnect backoff 0.5 s → 30 s (§9.1). */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** After close `4008` (relay restarting) reconnect after a random 0–3 s (§9.3). */
  drainJitterMs: number;
  /** `Math.random` unless a test pins it. */
  random: () => number;
}

export const DEFAULT_TIMING: Timing = {
  pingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  backoffMinMs: 500,
  backoffMaxMs: 30_000,
  drainJitterMs: 3_000,
  random: Math.random,
};

/**
 * Close codes after which the publisher must not reconnect (§9.3): policy/size violations (`1008`, `1009`),
 * `4000` unsupported version, `4001`/`4002` session ended, `4003` token rejected, `4011` replaced by a newer
 * connection with the same credentials.
 */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  1008, 1009, 4000, 4001, 4002, 4003, 4011,
]);

/**
 * Delay before reconnect attempt `attempt` (0-based): `4008` → 0…`drainJitterMs`; otherwise exponential
 * backoff `min(max, min·2^attempt)` with equal jitter (between half and all of it).
 */
export function reconnectDelayMs(
  closeCode: number | undefined,
  attempt: number,
  timing: Timing,
): number {
  if (closeCode === 4008) return Math.floor(timing.random() * timing.drainJitterMs);
  const cap = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** attempt);
  return Math.floor(cap / 2 + (timing.random() * cap) / 2);
}

/** `ping` every `pingIntervalMs`; `onTimeout` when its `pong` has not arrived within `pongTimeoutMs`. */
export class Heartbeat {
  private interval: NodeJS.Timeout | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private waitingFor: string | undefined;
  private counter = 0;

  constructor(
    private readonly timing: Pick<Timing, "pingIntervalMs" | "pongTimeoutMs">,
    private readonly sendPing: (id: string) => void,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    this.stop();
    this.interval = setInterval(() => {
      if (this.waitingFor !== undefined) return; // the previous ping is still in flight
      this.waitingFor = `hb-${++this.counter}`;
      this.sendPing(this.waitingFor);
      this.deadline = setTimeout(() => {
        this.stop();
        this.onTimeout();
      }, this.timing.pongTimeoutMs);
    }, this.timing.pingIntervalMs);
  }

  /** A `pong` with `replyTo` arrived; unrelated ids are ignored. */
  onPong(replyTo: string | undefined): void {
    if (replyTo === undefined || replyTo !== this.waitingFor) return;
    clearTimeout(this.deadline);
    this.waitingFor = undefined;
  }

  stop(): void {
    clearInterval(this.interval);
    clearTimeout(this.deadline);
    this.waitingFor = undefined;
  }
}
