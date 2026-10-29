import type { Clock, TimerHandle } from "../../src/clock.js";

/** A `Clock` that moves only when a test calls `advance()`; due timers fire in order. */
export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start = 1_800_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  /** Pending timers (tests assert cleanup). */
  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms`, firing every timer that falls due, earliest first. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers)
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].callback();
    }
    this.#now = target;
  }

  /** Moves time to an absolute point (never backwards). */
  set(at: number): void {
    this.advance(Math.max(0, at - this.#now));
  }
}
