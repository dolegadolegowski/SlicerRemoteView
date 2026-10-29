/**
 * Injectable time source and one-shot timers, so TTL, grace and handshake logic is testable
 * with a manual clock (docs/plan/server.md: "timers are injectable").
 */

/** Opaque timer handle; only ever passed back to the clock that created it. */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
