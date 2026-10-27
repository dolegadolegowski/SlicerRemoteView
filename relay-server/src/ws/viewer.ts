/**
 * Viewer join, leave and count (docs/protocol.md §5, §8.3, §12; architecture §3; ADR 0008).
 *
 * - `viewer.join{code}`: before validation the code is normalised (whitespace removed, upper case,
 *   §12); one that is still malformed never reaches a lookup. Malformed, unknown and released
 *   (quarantined) codes get the same `error INVALID_CODE` + `4004` after a random 50–150 ms, and the
 *   socket reads nothing more in between (§12: no retries on one socket). A live code joins: the
 *   viewer gets `viewer.joined` (its `viewerToken` once), then `scene.state` (§5.2, §8.3), held to
 *   the send-buffer limits (`deliver`, the fan-out's).
 * - `scene.request` (§8.3), from the viewer entry's current socket only: `scene.snapshot.ready` when
 *   `haveSnapshotVersion` differs from the cached snapshot (none without one; while a snapshot is in
 *   flight the cached one answers), then `scene.state`, both with `replyTo`, through `deliver`. One
 *   request per viewer entry is answered per `SCENE_REQUEST_INTERVAL_MS`, counted from the last
 *   answered one; the others get nothing — no reply, no error, no strike, no log line (plan SRV-13).
 * - Per client address (`RateLimiter`, §12): 10 code attempts per minute, a join with a right code
 *   gives its attempt back, 20 wrong codes within 10 min ban the address for 10 min →
 *   `RATE_LIMITED{retryAfterS}` + `4006`, decided before the code is looked up.
 * - `SESSION_FULL{viewerLimit, retryAfterS}` + `4005` at `MAX_VIEWERS` connected viewers;
 *   `CAPACITY` + `4006` while a global budget refuses new viewers, decided before the code is looked
 *   up (the app passes the fan-out's: the viewers' send buffers hold `MAX_TOTAL_BUFFERED_BYTES`,
 *   `ws/fanout.ts`).
 * - `viewer.join{sessionId, viewerToken}` rejoins the token's entry (§5.1, SRV-15): the same
 *   `viewerId`, `viewer.joined` (echoing the token) and `scene.state` as above; no rate limit and no
 *   ban apply (§12 "rejoins do not count"), `CAPACITY` and `SESSION_FULL` do. An entry still
 *   connected keeps its slot and its older socket is closed `4011` (T8). A token that names no live
 *   entry of that session (unknown, pruned, ended) → `error SESSION_NOT_FOUND`, the socket kept open
 *   for a fresh 10 s window in which a code join may follow (§9.2); one rejoin per socket (a second
 *   → `UNAUTHORIZED` + `1008`).
 * - `viewer.count` goes to the publisher and every connected viewer after each join and leave (§5.3);
 *   `platforms` only ever holds the documented platform names (unknown → `other`).
 * - `viewer.leave` (then close `1000`) and a dropped socket disconnect the viewer; its entry and
 *   token stay for rejoin until the session ends or, while disconnected, until 3 × `MAX_VIEWERS`
 *   newer entries exist (architecture §3).
 * Log lines carry session and viewer ids, platforms and error codes — never the code or a token.
 */
import { randomInt } from "node:crypto";
import { CLOSE_CODES } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "../clock.js";
import { isWellFormed } from "../codes.js";
import type { RandomInt } from "../codes.js";
import type { RateLimiter } from "../ratelimit.js";
import { RegistryError } from "../registry.js";
import type { Registry, Session, Viewer, ViewerPlatform } from "../registry.js";
import type { Connection, Outgoing } from "./connection.js";
import type { HandlerTable, NormalizerTable } from "./dispatch.js";
import { readyMessage } from "./fanout.js";
import { sceneState } from "./state.js";

/** Bounds of the random delay before `INVALID_CODE`, in ms (§12 "same timing ± jitter"). */
export const INVALID_CODE_JITTER_MS = { min: 50, max: 150 } as const;

/**
 * Stands in for a malformed code so the rest of the message is still validated. The handler never
 * looks up `message.code`: only the code the normaliser recorded for that very object.
 */
const PLACEHOLDER_CODE = "22222";

/**
 * At most one `scene.request` per viewer is answered in this time (plan SRV-13, architecture §3);
 * the protocol states no such limit yet (report 2026-10-27-server-1).
 */
export const SCENE_REQUEST_INTERVAL_MS = 5_000;

/** Retry hint of `SESSION_FULL` (§9.2, §9.3: "retry later (`retryAfterS`)"). */
export const SESSION_FULL_RETRY_AFTER_S = 30;

const PLATFORMS: ReadonlySet<string> = new Set(["web", "quest-browser", "quest2", "quest3"]);

export interface ViewerDeps {
  registry: Registry;
  /** Per-IP join limit and lockout (§12, SRV-08). */
  limiter: RateLimiter;
  logger: Logger;
  clock: Clock;
  /** Integer in `[min, max)` for the jitter; default `crypto.randomInt`. */
  rng?: RandomInt;
  /** True while a global budget refuses new viewers (`CAPACITY`); the app passes the fan-out's. */
  overCapacity?: () => boolean;
  /**
   * Sends relay messages to one viewer within the send-buffer limits; false when nothing was sent.
   * The app passes the fan-out's (`ws/fanout.ts`); the default sends unchecked (unit tests).
   */
  deliver?: (session: Session, viewer: Viewer, messages: readonly Outgoing[]) => boolean;
}

/**
 * ASCII letters upper-cased, whitespace removed (§12); nothing else is mapped (ADR 0008 §7), so
 * e.g. `ß` or `ﬀ` stay malformed. The result may still be malformed.
 */
export function normalizeCode(input: string): string {
  return input.replace(/\s+/gu, "").replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

/** `clientInfo.platform` onto the documented set; anything else is `other` (§5.1, §14). */
export function viewerPlatform(platform: string | undefined): ViewerPlatform {
  return platform !== undefined && PLATFORMS.has(platform) ? (platform as ViewerPlatform) : "other";
}

export function viewerHandlers({
  registry,
  limiter,
  logger,
  clock,
  rng = randomInt,
  overCapacity = () => false,
  deliver = (_session, viewer, messages) => {
    for (const message of messages) viewer.peer?.send(message);
    return viewer.peer !== undefined;
  },
}: ViewerDeps) {
  /**
   * The canonical code of each normalised `viewer.join` object, `null` when it is malformed. The
   * handler looks up only this entry, so a missing one (any object the normaliser did not see)
   * fails closed as `INVALID_CODE`.
   */
  const joinCodes = new WeakMap<object, string | null>();
  const pendingRefusals = new Set<TimerHandle>();
  /** When each viewer entry's last `scene.request` was answered (the entry outlives a rejoin). */
  const answeredAt = new WeakMap<Viewer, number>();
  /** Sockets that sent their one rejoin (only a code join may follow its `SESSION_NOT_FOUND`). */
  const rejoinTried = new WeakSet<Connection>();

  const normalizers: NormalizerTable = {
    "viewer.join": (value) => {
      if (typeof value.code !== "string") return;
      const code = normalizeCode(value.code);
      const wellFormed = isWellFormed(code);
      joinCodes.set(value, wellFormed ? code : null);
      value.code = wellFormed ? code : PLACEHOLDER_CODE;
    },
  };

  /** The one answer for every code that does not lead to a live session (§5.2, §12, T1). */
  function refuseCode(connection: Connection, replyTo: string | undefined): void {
    connection.awaitClose();
    const delay = rng(INVALID_CODE_JITTER_MS.min, INVALID_CODE_JITTER_MS.max + 1);
    const timer = clock.setTimeout(() => {
      pendingRefusals.delete(timer);
      connection.fail("INVALID_CODE", "no live session has this code", CLOSE_CODES.INVALID_CODE, {
        replyTo,
        retryable: false,
      });
    }, delay);
    pendingRefusals.add(timer);
    logger.info({ errorCode: "INVALID_CODE" }, "viewer join refused");
  }

  function broadcastCount(session: Session): void {
    const platforms: Partial<Record<ViewerPlatform, number>> = {};
    for (const viewer of session.viewers.values())
      if (viewer.peer !== undefined)
        platforms[viewer.platform] = (platforms[viewer.platform] ?? 0) + 1;
    const message = {
      type: "viewer.count",
      viewerCount: session.connectedViewers,
      viewerLimit: registry.limits.maxViewers,
      platforms,
    };
    session.publisher?.send(message);
    for (const viewer of session.viewers.values()) viewer.peer?.send(message);
  }

  /** The viewer's socket is gone or it left: keep the entry, update the counts. */
  function disconnect(connection: Connection): void {
    const { session, viewer } = connection;
    if (session === undefined || viewer === undefined || viewer.peer !== connection) return;
    if (!registry.viewerDisconnected(session, viewer)) return;
    // A released session has already told its viewers; nothing is left to count.
    if (registry.get(session.id) === session) broadcastCount(session);
    logger.info({ sessionId: session.id, viewerId: viewer.id }, "viewer left");
  }

  /** `CAPACITY` + `4006` while a global budget refuses new viewers (§5.2); true when refused. */
  function refusedAtCapacity(
    connection: Connection,
    replyTo: string | undefined,
    logLine: string,
  ): boolean {
    if (!overCapacity()) return false;
    connection.fail("CAPACITY", "the relay is at its capacity", CLOSE_CODES.RATE_LIMITED, {
      replyTo,
      retryable: true,
    });
    logger.info({ errorCode: "CAPACITY" }, logLine);
    return true;
  }

  /** `SESSION_FULL{viewerLimit, retryAfterS}` + `4005` (§5.2, §9.3). */
  function refuseFull(connection: Connection, session: Session, replyTo: string | undefined): void {
    connection.fail(
      "SESSION_FULL",
      "the session has reached its viewer limit",
      CLOSE_CODES.SESSION_FULL,
      {
        replyTo,
        retryable: true,
        details: {
          viewerLimit: registry.limits.maxViewers,
          retryAfterS: SESSION_FULL_RETRY_AFTER_S,
        },
      },
    );
    logger.info({ sessionId: session.id, errorCode: "SESSION_FULL" }, "viewer join refused");
  }

  /** Binds the socket to its entry: `viewer.joined`, then `scene.state` and the new count (§5.2). */
  function welcome(
    connection: Connection,
    session: Session,
    viewer: Viewer,
    viewerToken: string,
    replyTo: string | undefined,
  ): void {
    connection.session = session;
    connection.viewer = viewer;
    connection.completeHandshake();
    const { snapshot } = session;
    connection.send({
      type: "viewer.joined",
      ...(replyTo !== undefined && { replyTo }),
      sessionId: session.id,
      viewerId: viewer.id,
      viewerToken,
      sceneVersion: session.sceneVersion,
      snapshotVersion: snapshot?.sceneVersion ?? null,
      snapshotAvailable: snapshot !== undefined,
      ...(snapshot !== undefined && {
        snapshot: {
          sceneVersion: snapshot.sceneVersion,
          byteLength: snapshot.byteLength,
          sha256: snapshot.sha256,
          format: "glb",
        },
      }),
      publisherOnline: session.publisher !== undefined,
      viewerCount: session.connectedViewers,
      viewerLimit: registry.limits.maxViewers,
      profile: session.profile,
    });
    // Always right after viewer.joined, so clients have one code path (§5.2, §8.3).
    deliver(session, viewer, [sceneState(session)]);
    broadcastCount(session);
  }

  /** `viewer.join{sessionId, viewerToken}` (§5.1): the token's entry, without a rate limit (§12). */
  function rejoin(
    connection: Connection,
    sessionId: string,
    viewerToken: string,
    replyTo: string | undefined,
  ): void {
    if (rejoinTried.has(connection)) {
      connection.fail(
        "UNAUTHORIZED",
        "one rejoin per socket; only a code join may follow (§9.2)",
        CLOSE_CODES.POLICY_VIOLATION,
        { replyTo, retryable: false },
      );
      return;
    }
    rejoinTried.add(connection);
    if (refusedAtCapacity(connection, replyTo, "viewer rejoin refused")) return;
    const found = registry.viewerByToken(viewerToken);
    if (found === undefined || found.session.id !== sessionId) {
      // A token of an ended session, a pruned entry or none at all: the client joins by code.
      connection.sendError("SESSION_NOT_FOUND", "no live session for this viewer token", {
        replyTo,
        retryable: false,
      });
      connection.restartHandshakeTimer();
      logger.info({ errorCode: "SESSION_NOT_FOUND" }, "viewer rejoin refused");
      return;
    }
    const { session, viewer } = found;
    const older = viewer.peer;
    try {
      registry.viewerReconnected(session, viewer, connection);
    } catch (error) {
      if (!(error instanceof RegistryError) || error.code !== "SESSION_FULL") throw error;
      refuseFull(connection, session, replyTo);
      return;
    }
    // A second concurrent use of the token: the older socket goes (T8). `disconnect()` ignores its
    // close: the entry's peer is now the new socket.
    older?.close(CLOSE_CODES.REPLACED);
    welcome(connection, session, viewer, viewerToken, replyTo);
    logger.info(
      { sessionId: session.id, viewerId: viewer.id, replaced: older !== undefined },
      "viewer rejoined",
    );
  }

  const handlers: HandlerTable = {
    "viewer.join": (connection, message) => {
      const replyTo = message.id;
      if (message.code === undefined) {
        // Without a code the schema requires both (§5.1); `""` only satisfies the types.
        rejoin(connection, message.sessionId ?? "", message.viewerToken ?? "", replyTo);
        return;
      }
      // Before the lookup: the answer must not depend on whether the code is live (§12, T1).
      if (refusedAtCapacity(connection, replyTo, "viewer join refused")) return;
      // Per-IP attempts and lockout, also before the lookup (§12, T1).
      const key = connection.clientKey;
      const allowed = limiter.join(key);
      if (!allowed.ok) {
        connection.fail(
          "RATE_LIMITED",
          "too many join attempts from this address",
          CLOSE_CODES.RATE_LIMITED,
          { replyTo, retryable: true, details: { retryAfterS: allowed.retryAfterS } },
        );
        logger.debug({ errorCode: "RATE_LIMITED" }, "viewer join refused");
        return;
      }
      const code = joinCodes.get(message);
      const session = code ? registry.getByCode(code) : undefined;
      if (session === undefined) {
        limiter.joinFailed(key);
        refuseCode(connection, replyTo);
        return;
      }
      // The code was right: the attempt does not count (classroom NAT, ADR 0008).
      limiter.joinSucceeded(key);
      const platform = viewerPlatform(message.clientInfo.platform);
      let added;
      try {
        added = registry.addViewer(session, connection, platform);
      } catch (error) {
        if (!(error instanceof RegistryError) || error.code !== "SESSION_FULL") throw error;
        refuseFull(connection, session, replyTo);
        return;
      }
      const { viewer, viewerToken } = added;
      welcome(connection, session, viewer, viewerToken, replyTo);
      logger.info({ sessionId: session.id, viewerId: viewer.id, platform }, "viewer joined");
    },

    "scene.request": (connection, message) => {
      const { session, viewer } = connection;
      // Only the entry's current socket (a rejoin replaces it, SRV-15), from its own session (T11).
      if (session === undefined || viewer === undefined || viewer.peer !== connection) return;
      const now = clock.now();
      const last = answeredAt.get(viewer);
      // Inside the window: nothing at all. A clock that went back does not hold answers off.
      if (last !== undefined && now >= last && now - last < SCENE_REQUEST_INTERVAL_MS) return;
      answeredAt.set(viewer, now);
      const replyTo = message.id;
      const { snapshot } = session;
      // §8.3: `ready` when the viewer holds another GLB than the cached one (null too).
      const sendReady =
        snapshot !== undefined && message.haveSnapshotVersion !== snapshot.sceneVersion;
      const state = { ...sceneState(session), ...(replyTo !== undefined && { replyTo }) };
      const sent = deliver(
        session,
        viewer,
        sendReady
          ? [{ ...readyMessage(snapshot), ...(replyTo !== undefined && { replyTo }) }, state]
          : [state],
      );
      logger.debug(
        {
          sessionId: session.id,
          viewerId: viewer.id,
          reason: message.reason,
          snapshotVersion: snapshot?.sceneVersion ?? null,
          ready: sendReady,
          nodes: state.nodes.length,
          removed: state.removed.length,
          sent,
        },
        "scene.request answered",
      );
    },

    "viewer.leave": (connection) => {
      disconnect(connection);
      connection.close(CLOSE_CODES.NORMAL);
    },
  };

  /** Cancels pending refusals (the app calls it on close). */
  const dispose = (): void => {
    for (const timer of pendingRefusals) clock.clearTimeout(timer);
    pendingRefusals.clear();
  };
  return { handlers, normalizers, viewerClosed: disconnect, dispose };
}
