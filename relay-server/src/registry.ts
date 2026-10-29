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
import { randomInt, type Hash } from "node:crypto";
import { EventEmitter } from "node:events";
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

/** The latest complete, verified snapshot (`ws/snapshot.ts` swaps it in at `end`). */
export interface CachedSnapshot {
  buffer: Buffer;
  sha256: string;
  byteLength: number;
  sceneVersion: number;
  /** From `begin`, for `scene.snapshot.ready` (§6.4). */
  extensionsRequired: string[];
}

/** A snapshot being received (`ws/snapshot.ts`; SRV-24 verifies and swaps it in at `end`). */
export interface AssemblingSnapshot {
  /** `byteLength` bytes, zero-filled at `begin`; never pooled or reused (T11). */
  buffer: Buffer;
  sceneVersion: number;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  /** Index of the next expected chunk (§6.3). */
  nextIndex: number;
  /** SHA-256 announced in `begin`, checked against the bytes at `end` (§6.4). */
  sha256: string;
  /** SHA-256 of the payloads so far, fed chunk by chunk (no 64 MiB hash at `end`). */
  hash: Hash;
  /** Copied into `scene.snapshot.ready` (§6.4); the relay never parses the GLB. */
  extensionsRequired: string[];
  /** Arrival of the last chunk (or `begin`), for the 120 s chunk timeout (§3.3). */
  lastChunkAt: number;
}

/**
 * A connected socket as the registry sees it: something that takes a protocol message and can be
 * closed. The WebSocket `Connection` implements it; tests use in-memory peers.
 */
export interface Peer {
  /** Sends one JSON message; the transport adds `protocolVersion` and `ts`. */
  send(message: { type: string } & Record<string, unknown>): void;
  /**
   * Sends a frame byte for byte: a publisher frame as received (§11), text as is, a `Buffer` as
   * binary, or — `asText` — a `Buffer` holding a text frame's UTF-8 bytes (an update encoded once
   * for many sockets, or a relay message the fan-out measured, `ws/fanout.ts`).
   */
  forward(frame: string | Buffer, asText?: boolean): void;
  /** Bytes queued for this socket and not yet handed to the network (`ws` `bufferedAmount`). */
  readonly bufferedAmount: number;
  /** Stops / restarts reading from this socket (TCP backpressure on its sender). */
  pauseReading?(): void;
  resumeReading?(): void;
  close(closeCode: number): void;
  /** Drops the socket at once, without waiting for the peer's close (`ws` `terminate()`). */
  terminate?(): void;
}

/** `clientInfo.platform` of a viewer, mapped onto the documented set (§5.1; unknown → `other`, §14). */
export type ViewerPlatform = "web" | "quest-browser" | "quest2" | "quest3" | "other";

/** A joined viewer (architecture §3). */
export interface Viewer {
  /** `vw_` + 8 random symbols; safe to log. */
  readonly id: string;
  /** SHA-256 of the viewer token; the token itself is never stored (NFR-17). */
  readonly tokenHash: Buffer;
  readonly platform: ViewerPlatform;
  readonly joinedAt: number;
  /** `undefined` while the viewer is disconnected (entry kept for rejoin, architecture §3). */
  peer: Peer | undefined;
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
  /** Viewers with an open socket (`peer` set); the idle timer runs only while this is 0 (§4.4). */
  connectedViewers: number;
  /** Start of the current idle period: creation, last viewer leaving, or last renew. */
  idleSince: number;
  /** Whether `expiring` was already emitted for the current idle period. */
  idleWarned: boolean;
  /** Last accepted `sceneVersion` (snapshot or update); `0` = nothing published (§4.2). */
  sceneVersion: number;
  snapshot: CachedSnapshot | undefined;
  assembling: AssemblingSnapshot | undefined;
  /** Highest `sceneVersion` announced in a `scene.snapshot.begin`, refused or not (§6.2, §8.4). */
  lastSnapshotVersion: number;
  /** A refused or discarded snapshot version whose remaining chunks are ignored (§6.2, §6.3). */
  ignoredSnapshotVersion: number | undefined;
  /** Merged `scene.update` / `scene.nodeRemoved` since the snapshot (SRV-12); never names. */
  readonly nodeState: Map<string, NodeState | "removed">;
  /** The publisher's socket; `undefined` while in grace and after the session ended. */
  publisher: Peer | undefined;
  /**
   * Joined viewers by `viewerId`, connected or not (kept for rejoin, architecture §3), oldest first.
   * Kept on release so the ending can be announced.
   */
  readonly viewers: Map<string, Viewer>;
}

export interface RegistryLimits {
  maxSessions: number;
  /** Viewers with an open socket per session (`MAX_VIEWERS`, §3.3). */
  maxViewers: number;
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
   * Called when an `expiring`/`expired`/`released` listener throws; the other listeners and the
   * sweep go on.
   * Default: ignore (the app logs an error code).
   */
  onListenerError?: (error: unknown) => void;
}

export type RegistryEvents = {
  /** 60 s before an idle expiry (or at once when less remains); once per idle period (§4.4). */
  expiring: [session: Session, closesAt: number];
  /** After the session was released by the relay (sweep or `expireSession`). */
  expired: [session: Session, reason: ExpiryReason];
  /** After any release (close or expiry), once per session: drop what is keyed by it. */
  released: [session: Session];
};

export class RegistryError extends Error {
  constructor(
    readonly code: "CAPACITY" | "SESSION_FULL",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/** How often `start()` runs the sweep (architecture §5). */
export const SWEEP_INTERVAL_MS = 10_000;
/** The sweep under the test-only `RELAY_TEST_FAST_TIMERS` (SRV-29). */
export const FAST_SWEEP_INTERVAL_MS = 1_000;
/** Lead time of the idle warning (§4.4). */
export const EXPIRING_LEAD_MS = 60_000;

const SESSION_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const SESSION_ID_LENGTH = 16;
const VIEWER_ID_LENGTH = 8;
/**
 * Viewer entries per session, connected or not, as a multiple of `maxViewers`. Disconnected
 * entries stay for rejoin; beyond this the oldest disconnected one (and its token) is dropped, so
 * join/leave cycles cannot grow a session without bound.
 */
export const VIEWER_ENTRIES_PER_SLOT = 3;

export class Registry extends EventEmitter<RegistryEvents> {
  readonly #byId = new Map<string, Session>();
  readonly #byCode = new Map<string, Session>();
  /** Hex SHA-256 of a viewer token → its session and viewer (rejoin SRV-15, scene download SRV-11). */
  readonly #viewerTokens = new Map<string, { session: Session; viewer: Viewer }>();
  /**
   * Hex SHA-256 of the viewer tokens of ended sessions → when to forget them, so `GET /api/scene`
   * can answer `410` rather than `401` (§10). Kept `codeQuarantineS`, oldest first out above
   * `maxSessions × VIEWER_ENTRIES_PER_SLOT × maxViewers` entries.
   */
  readonly #endedTokens = new Map<string, number>();
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
      maxViewers: options.maxViewers,
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

  /** Exact lookup of a canonical code; normalisation is the caller's job (`ws/viewer.ts`). */
  getByCode(code: string): Session | undefined {
    return this.#byCode.get(code);
  }

  /** Codes released early because the quarantine was full (`/metrics`, SRV-19; T1 residual). */
  get codesEvicted(): number {
    return this.#quarantine.evicted;
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
      lastSnapshotVersion: 0,
      ignoredSnapshotVersion: undefined,
      nodeState: new Map(),
      publisher: undefined,
      viewers: new Map(),
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
   * Adds a viewer with an open socket and returns it with its token, which the caller sends once in
   * `viewer.joined` and then forgets (§5.2). Throws `RegistryError("SESSION_FULL")` when
   * `maxViewers` viewers are connected (§3.3). The caller checked that the session is live.
   */
  addViewer(
    session: Session,
    peer: Peer,
    platform: ViewerPlatform,
  ): { viewer: Viewer; viewerToken: string } {
    if (session.connectedViewers >= this.#limits.maxViewers)
      throw new RegistryError("SESSION_FULL", "MAX_VIEWERS reached");
    const viewerToken = newToken("vt_");
    const viewer: Viewer = {
      id: this.#newViewerId(session),
      tokenHash: hashToken(viewerToken),
      platform,
      joinedAt: this.#clock.now(),
      peer,
    };
    session.viewers.set(viewer.id, viewer);
    this.#viewerTokens.set(viewer.tokenHash.toString("hex"), { session, viewer });
    this.#pruneViewers(session);
    this.#countViewers(session);
    return { viewer, viewerToken };
  }

  /**
   * A rejoin with the viewer's token (§5.1): `peer` becomes the entry's socket. An entry that was
   * disconnected takes a slot again — `RegistryError("SESSION_FULL")` when `maxViewers` viewers are
   * connected; one still connected (its old socket, which the caller closes `4011`, T8) keeps its
   * slot. The caller checked that the session is live.
   */
  viewerReconnected(session: Session, viewer: Viewer, peer: Peer): void {
    if (viewer.peer === undefined && session.connectedViewers >= this.#limits.maxViewers)
      throw new RegistryError("SESSION_FULL", "MAX_VIEWERS reached");
    viewer.peer = peer;
    this.#countViewers(session);
  }

  /**
   * The viewer's socket is gone (`viewer.leave`, a drop, or the session ending): the entry stays for
   * rejoin until the session ends or, while disconnected, until `VIEWER_ENTRIES_PER_SLOT ×
   * maxViewers` newer entries exist (architecture §3). The only place `peer` is cleared, so
   * `connectedViewers` stays in step. Returns false when it was not connected.
   */
  viewerDisconnected(session: Session, viewer: Viewer): boolean {
    if (viewer.peer === undefined || session.viewers.get(viewer.id) !== viewer) return false;
    viewer.peer = undefined;
    this.#countViewers(session);
    return true;
  }

  /** The live session and viewer a viewer token belongs to (rejoin SRV-15, `GET /api/scene` SRV-11). */
  viewerByToken(token: string): { session: Session; viewer: Viewer } | undefined {
    return this.#viewerTokens.get(hashToken(token).toString("hex"));
  }

  /** Remembered token hashes of ended sessions (tests, metrics). */
  get endedTokenCount(): number {
    return this.#endedTokens.size;
  }

  /**
   * True for the token of a viewer entry whose session ended less than `codeQuarantineS` ago
   * (`410`, §10); false for any other, including entries pruned before the end.
   */
  tokenEnded(token: string): boolean {
    const until = this.#endedTokens.get(hashToken(token).toString("hex"));
    return until !== undefined && until > this.#clock.now();
  }

  /**
   * Number of viewers with an open socket, kept in step by `addViewer`/`viewerDisconnected`.
   * Dropping to 0 starts a new idle period; while it is above 0 the idle timer does not run (§4.4).
   */
  #setConnectedViewers(session: Session, count: number): void {
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

  /** The `ttl` object of `session.created` / `session.resumed` / `session.renewed` (§4.2). */
  ttl(session: Session): {
    graceS: number;
    idleS: number;
    maxLifetimeS: number;
    expiresAt: number;
  } {
    return {
      graceS: this.#limits.publisherGraceS,
      idleS: this.#limits.sessionTtlS,
      maxLifetimeS: this.#limits.sessionMaxLifetimeS,
      expiresAt: session.expiresAt,
    };
  }

  /** Deadline of the idle expiry while no viewer is connected, else `undefined`. */
  idleDeadline(session: Session): number | undefined {
    return session.connectedViewers === 0
      ? session.idleSince + this.#limits.sessionTtlS * 1000
      : undefined;
  }

  /** `session.close` from the publisher: phase `closed`, released at once (§4.5); `released` only. */
  closeSession(session: Session): void {
    if (!this.#release(session)) return;
    session.phase = "closed";
    this.#notify("released", session);
  }

  /** Relay-initiated end: phase `expired`, released, then the `expired` event. */
  expireSession(session: Session, reason: ExpiryReason): void {
    if (!this.#release(session)) return;
    session.phase = "expired";
    this.#notify("expired", session, reason);
    this.#notify("released", session);
  }

  /** One expiry pass over all sessions; also drops expired quarantine entries and ended tokens. */
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
    // Insertion order is expiry order: every entry is kept for the same time.
    for (const [key, until] of this.#endedTokens) {
      if (until > now) break;
      this.#endedTokens.delete(key);
    }
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
    const forgetAt = this.#clock.now() + this.#limits.codeQuarantineS * 1000;
    const maxEnded = this.#limits.maxSessions * VIEWER_ENTRIES_PER_SLOT * this.#limits.maxViewers;
    for (const viewer of session.viewers.values()) {
      const key = viewer.tokenHash.toString("hex");
      this.#viewerTokens.delete(key);
      this.#endedTokens.set(key, forgetAt);
      if (this.#endedTokens.size > maxEnded)
        this.#endedTokens.delete(this.#endedTokens.keys().next().value as string);
    }
    this.#quarantine.add(session.code);
    session.snapshot = undefined;
    session.assembling = undefined;
    session.nodeState.clear();
    session.graceEndsAt = undefined;
    return true;
  }

  #countViewers(session: Session): void {
    let connected = 0;
    for (const viewer of session.viewers.values()) if (viewer.peer !== undefined) connected += 1;
    this.#setConnectedViewers(session, connected);
  }

  /** Drops the oldest disconnected entries beyond `VIEWER_ENTRIES_PER_SLOT × maxViewers`. */
  #pruneViewers(session: Session): void {
    let excess = session.viewers.size - VIEWER_ENTRIES_PER_SLOT * this.#limits.maxViewers;
    for (const viewer of session.viewers.values()) {
      if (excess <= 0) return;
      if (viewer.peer !== undefined) continue;
      session.viewers.delete(viewer.id);
      this.#viewerTokens.delete(viewer.tokenHash.toString("hex"));
      excess -= 1;
    }
  }

  /** 80 random bits; a repeat means a broken RNG, so give up like `generateCode` does. */
  #newSessionId(): string {
    return this.#randomId("sess_", SESSION_ID_LENGTH, (id) => this.#byId.has(id), "session id");
  }

  /** 40 random bits, unique within the session. */
  #newViewerId(session: Session): string {
    return this.#randomId("vw_", VIEWER_ID_LENGTH, (id) => session.viewers.has(id), "viewer id");
  }

  #randomId(prefix: string, length: number, taken: (id: string) => boolean, what: string): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      let id = prefix;
      for (let i = 0; i < length; i++)
        id += SESSION_ID_ALPHABET[this.#rng(0, SESSION_ID_ALPHABET.length)];
      if (!taken(id)) return id;
    }
    throw new RegistryError("CAPACITY", `no free ${what}`);
  }
}
