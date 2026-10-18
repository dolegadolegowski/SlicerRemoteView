/**
 * In-memory session registry (architecture §3, docs/protocol.md §4, ADR 0008).
 *
 * Owns every live session, the code → session index and the code quarantine. Transport-agnostic:
 * WebSocket handlers (SRV-05 onwards) call the transition methods and react to the events, the
 * registry itself never sends or logs anything. Expiry is checked by `sweep()` (every 10 s when
 * started) against an injectable clock:
 *
 * - `grace` longer than `PUBLISHER_GRACE_S` → expired `PUBLISHER_GONE`;
 * - older than `SESSION_MAX_LIFETIME_S` → expired `MAX_LIFETIME`;
 * - no connected viewer for `SESSION_TTL_S` (since creation, the last viewer leaving, or the last
 *   `session.renew`) → expired `IDLE`, announced by one `expiring` event 60 s before (§4.4).
 *
 * Phases follow the state diagram of architecture §3 with one addition: a publisher that drops
 * before its first snapshot is accepted also enters `grace` (from `allocated`), so it can resume
 * like any other (protocol §4.3 allows resume whenever the session is in grace).
 *
 * Releasing a session (close or expiry) removes it from both indexes, quarantines its code, drops
 * the snapshot buffers and the merged node state, so V8 frees them once the sockets are gone;
 * nothing is pooled and nothing is ever written to disk (NFR-10).
 */
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { MessageOfType } from "@slicerremoteview/shared";
import type { Clock, TimerHandle } from "./clock.js";
import { systemClock } from "./clock.js";
import {
  CodeQuarantine,
  CodeSpaceExhaustedError,
  generateCode,
  hashToken,
  isWellFormed,
  MAX_CODE_ATTEMPTS,
  newToken,
} from "./codes.js";
import type { RandomInt } from "./codes.js";

export type Phase = "allocated" | "active" | "grace" | "closed" | "expired";
export type Profile = MessageOfType<"session.create">["profile"];
/** `reason` of `session.closed` / `session.expired` (§4.5). */
export type EndReason = MessageOfType<"session.expired">["reason"];
export type ExpiryReason = Exclude<EndReason, "PUBLISHER_CLOSED">;

export interface NodeState {
  visible?: boolean;
  color?: [number, number, number];
  opacity?: number;
  matrix?: number[];
}

/** The latest complete snapshot (SRV-24 fills it). */
export interface CachedSnapshot {
  buffer: Buffer;
  sha256: string;
  byteLength: number;
  sceneVersion: number;
}

/** A snapshot being received (SRV-09 fills it). */
export interface AssemblingSnapshot {
  buffer: Buffer;
  sceneVersion: number;
}

export interface Session {
  /** `sess_` + 16 Crockford base32 symbols; internal and safe to log. */
  readonly id: string;
  /** 5-symbol code; never logged. */
  readonly code: string;
  phase: Phase;
  readonly profile: Profile;
  /** SHA-256 of the publisher token; the token itself is never stored (NFR-17). */
  readonly publisherTokenHash: Buffer;
  readonly createdAt: number;
  /** `createdAt + SESSION_MAX_LIFETIME_S`: `ttl.expiresAt` of §4.2. */
  readonly expiresAt: number;
  lastPublisherSeen: number;
  /** End of the publisher grace period while `phase === "grace"`. */
  graceEndsAt: number | undefined;
  /** Viewers with an open socket; the idle timer runs only while this is 0 (§4.4). */
  connectedViewers: number;
  /** Start of the current idle period: creation, last viewer leaving, or last renew. */
  idleSince: number;
  /** Whether `expiring` was already emitted for the current idle period. */
  idleWarned: boolean;
  /** Last accepted `sceneVersion` (snapshot or update); `0` = nothing published (§4.2). */
  sceneVersion: number;
  snapshot: CachedSnapshot | undefined;
  assembling: AssemblingSnapshot | undefined;
  /** Merged `scene.update` / `scene.nodeRemoved` since the snapshot (SRV-12); never names. */
  readonly nodeState: Map<string, NodeState | "removed">;
}

export interface RegistryLimits {
  maxSessions: number;
  sessionTtlS: number;
  publisherGraceS: number;
  sessionMaxLifetimeS: number;
  codeQuarantineS: number;
}

export interface RegistryOptions extends RegistryLimits {
  clock?: Clock;
  /** RNG for codes and session ids (tests); default `crypto.randomInt`. */
  rng?: RandomInt;
  /**
   * Called when an `expired`/`expiring` listener throws; the other listeners and the sweep go on.
   * Default: ignore (the app logs an error code).
   */
  onListenerError?: (error: unknown) => void;
}

export type RegistryEvents = {
  /** 60 s before an idle expiry (or at once when less remains); once per idle period (§4.4). */
  expiring: [session: Session, closesAt: number];
  /** After the session was released by the relay (sweep or `expireSession`). */
  expired: [session: Session, reason: ExpiryReason];
};

export class RegistryError extends Error {
  constructor(
    readonly code: "CAPACITY",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/** How often `start()` runs the sweep (architecture §5). */
export const SWEEP_INTERVAL_MS = 10_000;
/** Lead time of the idle warning (§4.4). */
export const EXPIRING_LEAD_MS = 60_000;

const SESSION_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const SESSION_ID_LENGTH = 16;

export class Registry extends EventEmitter<RegistryEvents> {
  readonly #byId = new Map<string, Session>();
  readonly #byCode = new Map<string, Session>();
  readonly #quarantine: CodeQuarantine;
  readonly #clock: Clock;
  readonly #rng: RandomInt;
  readonly #limits: RegistryLimits;
  readonly #onListenerError: (error: unknown) => void;
  #sweepTimer: TimerHandle | undefined;

  constructor(options: RegistryOptions) {
    super();
    this.#clock = options.clock ?? systemClock;
    this.#rng = options.rng ?? randomInt;
    this.#onListenerError = options.onListenerError ?? (() => {});
    this.#limits = {
      maxSessions: options.maxSessions,
      sessionTtlS: options.sessionTtlS,
      publisherGraceS: options.publisherGraceS,
      sessionMaxLifetimeS: options.sessionMaxLifetimeS,
      codeQuarantineS: options.codeQuarantineS,
    };
    this.#quarantine = new CodeQuarantine(options.codeQuarantineS * 1000, () => this.#clock.now());
  }

  get limits(): Readonly<RegistryLimits> {
    return this.#limits;
  }

  /** Live sessions (every phase except `closed`/`expired`). */
  get size(): number {
    return this.#byId.size;
  }

  /** Bytes held in cached and assembling snapshot buffers across all sessions. */
  get snapshotBytes(): number {
    let total = 0;
    for (const session of this.#byId.values())
      total +=
        (session.snapshot?.buffer.byteLength ?? 0) + (session.assembling?.buffer.byteLength ?? 0);
    return total;
  }

  get(sessionId: string): Session | undefined {
    return this.#byId.get(sessionId);
  }

  /** Exact lookup of a canonical code; normalisation is the caller's job (SRV-07). */
  getByCode(code: string): Session | undefined {
    return this.#byCode.get(code);
  }

  isCodeQuarantined(code: string): boolean {
    return this.#quarantine.has(code);
  }

  sessions(): IterableIterator<Session> {
    return this.#byId.values();
  }

  /**
   * Opens a session in phase `allocated` and returns it with the publisher token, which the
   * caller sends once in `session.created` and then forgets (§4.2). `preferredCode` is honoured
   * only when well-formed, not live and not quarantined; otherwise a fresh code is drawn silently
   * (§4.1, ADR 0008 errata). Throws `RegistryError("CAPACITY")` at `MAX_SESSIONS` (§3.3).
   */
  createSession(
    profile: Profile,
    preferredCode?: string | null,
  ): { session: Session; publisherToken: string } {
    if (this.#byId.size >= this.#limits.maxSessions)
      throw new RegistryError("CAPACITY", "MAX_SESSIONS reached");
    const taken = (code: string): boolean => this.#byCode.has(code) || this.#quarantine.has(code);
    let code: string;
    if (isWellFormed(preferredCode) && !taken(preferredCode)) code = preferredCode;
    else {
      try {
        code = generateCode(taken, this.#rng);
      } catch (error) {
        if (error instanceof CodeSpaceExhaustedError)
          throw new RegistryError("CAPACITY", "no free session code");
        throw error;
      }
    }
    const now = this.#clock.now();
    const publisherToken = newToken("pt_");
    const session: Session = {
      id: this.#newSessionId(),
      code,
      phase: "allocated",
      profile,
      publisherTokenHash: hashToken(publisherToken),
      createdAt: now,
      expiresAt: now + this.#limits.sessionMaxLifetimeS * 1000,
      lastPublisherSeen: now,
      graceEndsAt: undefined,
      connectedViewers: 0,
      idleSince: now,
      idleWarned: false,
      sceneVersion: 0,
      snapshot: undefined,
      assembling: undefined,
      nodeState: new Map(),
    };
    this.#byId.set(session.id, session);
    this.#byCode.set(code, session);
    return { session, publisherToken };
  }

  /** `allocated → active` when the first snapshot is accepted (SRV-24). */
  markActive(session: Session): void {
    if (session.phase === "allocated") session.phase = "active";
  }

  /** Publisher activity (any message or `ping`) — SRV-14. Does not touch the idle timer (§4.4). */
  touchPublisher(session: Session): void {
    session.lastPublisherSeen = this.#clock.now();
  }

  /**
   * Publisher socket lost: `allocated`/`active → grace`. Returns `graceEndsAt` for
   * `session.publisherState` (§4.6), or `undefined` when the session is not live or already in grace.
   */
  publisherLost(session: Session): number | undefined {
    if (session.phase !== "allocated" && session.phase !== "active") return undefined;
    session.phase = "grace";
    session.graceEndsAt = this.#clock.now() + this.#limits.publisherGraceS * 1000;
    return session.graceEndsAt;
  }

  /** `grace → active` (or back to `allocated` without a snapshot) on a valid resume — SRV-15. */
  publisherResumed(session: Session): void {
    if (session.phase !== "grace") return;
    session.phase = session.snapshot ? "active" : "allocated";
    session.graceEndsAt = undefined;
    session.lastPublisherSeen = this.#clock.now();
  }

  /**
   * Number of viewers with an open socket (SRV-07). Dropping to 0 starts a new idle period;
   * while it is above 0 the idle timer does not run (§4.4).
   */
  setConnectedViewers(session: Session, count: number): void {
    if (count === 0 && session.connectedViewers > 0) {
      session.idleSince = this.#clock.now();
      session.idleWarned = false;
    }
    session.connectedViewers = count;
  }

  /** `session.renew`: restarts the idle period (§4.4, SRV-14). */
  renew(session: Session): void {
    session.idleSince = this.#clock.now();
    session.idleWarned = false;
  }

  /** Deadline of the idle expiry while no viewer is connected, else `undefined`. */
  idleDeadline(session: Session): number | undefined {
    return session.connectedViewers === 0
      ? session.idleSince + this.#limits.sessionTtlS * 1000
      : undefined;
  }

  /** `session.close` from the publisher: phase `closed`, released at once (§4.5). No event. */
  closeSession(session: Session): void {
    if (!this.#release(session)) return;
    session.phase = "closed";
  }

  /** Relay-initiated end: phase `expired`, released, then the `expired` event. */
  expireSession(session: Session, reason: ExpiryReason): void {
    if (!this.#release(session)) return;
    session.phase = "expired";
    this.#notify("expired", session, reason);
  }

  /** One expiry pass over all sessions; also drops expired quarantine entries. */
  sweep(): void {
    const now = this.#clock.now();
    for (const session of [...this.#byId.values()]) {
      // A listener may have ended another session earlier in this pass.
      if (this.#byId.get(session.id) !== session) continue;
      try {
        this.#check(session, now);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
    this.#quarantine.sweep();
  }

  /**
   * Runs `sweep()` every 10 s on the injected clock until `stop()` (so a manual clock drives it in
   * tests); a real timer does not keep the process alive.
   */
  start(intervalMs: number = SWEEP_INTERVAL_MS): void {
    this.stop();
    const arm = (): void => {
      this.#sweepTimer = this.#clock.setTimeout(() => {
        this.sweep();
        arm();
      }, intervalMs);
      (this.#sweepTimer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  stop(): void {
    if (this.#sweepTimer !== undefined) this.#clock.clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  #check(session: Session, now: number): void {
    if (
      session.phase === "grace" &&
      session.graceEndsAt !== undefined &&
      now >= session.graceEndsAt
    )
      this.expireSession(session, "PUBLISHER_GONE");
    else if (now >= session.expiresAt) this.expireSession(session, "MAX_LIFETIME");
    else {
      const idleAt = this.idleDeadline(session);
      if (idleAt === undefined) return;
      if (now >= idleAt) this.expireSession(session, "IDLE");
      else if (!session.idleWarned && now >= idleAt - EXPIRING_LEAD_MS) {
        session.idleWarned = true;
        this.#notify("expiring", session, idleAt);
      }
    }
  }

  /**
   * Calls every listener even if one throws (plain `emit` stops at the first): a faulty listener,
   * e.g. a metric, must never keep viewers of a released session connected.
   */
  #notify<E extends keyof RegistryEvents>(event: E, ...args: RegistryEvents[E]): void {
    for (const listener of this.listeners(event) as ((...a: RegistryEvents[E]) => void)[]) {
      try {
        listener(...args);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }

  /** Removes a live session from the indexes and drops its scene data; false if already gone. */
  #release(session: Session): boolean {
    if (this.#byId.get(session.id) !== session) return false;
    this.#byId.delete(session.id);
    this.#byCode.delete(session.code);
    this.#quarantine.add(session.code);
    session.snapshot = undefined;
    session.assembling = undefined;
    session.nodeState.clear();
    session.graceEndsAt = undefined;
    return true;
  }

  /** 80 random bits; a repeat means a broken RNG, so give up like `generateCode` does. */
  #newSessionId(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      let id = "sess_";
      for (let i = 0; i < SESSION_ID_LENGTH; i++)
        id += SESSION_ID_ALPHABET[this.#rng(0, SESSION_ID_ALPHABET.length)];
      if (!this.#byId.has(id)) return id;
    }
    throw new RegistryError("CAPACITY", "no free session id");
  }
}
