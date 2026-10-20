/**
 * Viewer join, leave and count (docs/protocol.md §5, §8.3, §12; architecture §3; ADR 0008).
 *
 * - `viewer.join{code}`: before validation the code is normalised (whitespace removed, upper case,
 *   §12); one that is still malformed never reaches a lookup. Malformed, unknown and released
 *   (quarantined) codes get the same `error INVALID_CODE` + `4004` after a random 50–150 ms, and the
 *   socket reads nothing more in between (§12: no retries on one socket). A live code joins: the
 *   viewer gets `viewer.joined` (its `viewerToken` once), then `scene.state` (§5.2, §8.3).
 * - Per client address (`RateLimiter`, §12): 10 code attempts per minute, a join with a right code
 *   gives its attempt back, 20 wrong codes within 10 min ban the address for 10 min →
 *   `RATE_LIMITED{retryAfterS}` + `4006`, decided before the code is looked up.
 * - `SESSION_FULL{viewerLimit, retryAfterS}` + `4005` at `MAX_VIEWERS` connected viewers;
 *   `CAPACITY` + `4006` while a global budget refuses new viewers, decided before the code is looked
 *   up (the buffered-bytes budget arrives with SRV-10).
 * - Rejoin by `sessionId` + `viewerToken` is SRV-15; until then it answers `SESSION_NOT_FOUND`
 *   (socket kept open, so the client falls back to a code join, §9.2).
 * - `viewer.count` goes to the publisher and every connected viewer after each join and leave (§5.3);
 *   `platforms` only ever holds the documented platform names (unknown → `other`).
 * - `viewer.leave` (then close `1000`) and a dropped socket disconnect the viewer; its entry and
 *   token stay for rejoin until the session ends or, while disconnected, until 3 × `MAX_VIEWERS`
 *   newer entries exist (architecture §3; rejoin is SRV-15).
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
import type { Registry, Session, ViewerPlatform } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable, NormalizerTable } from "./dispatch.js";

/** Bounds of the random delay before `INVALID_CODE`, in ms (§12 "same timing ± jitter"). */
export const INVALID_CODE_JITTER_MS = { min: 50, max: 150 } as const;

/**
 * Stands in for a malformed code so the rest of the message is still validated. The handler never
 * looks up `message.code`: only the code the normaliser recorded for that very object.
 */
const PLACEHOLDER_CODE = "22222";

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
  /** True while a global budget refuses new viewers (`CAPACITY`); SRV-10 supplies the real one. */
  overCapacity?: () => boolean;
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

/** `scene.state` of the session (§8.3): the merged node state since the cached snapshot. */
export function sceneState(session: Session): { type: string } & Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  const removed: string[] = [];
  for (const [nodeId, state] of session.nodeState)
    if (state === "removed") removed.push(nodeId);
    else nodes.push({ nodeId, ...state });
  return {
    type: "scene.state",
    sceneVersion: session.sceneVersion,
    snapshotVersion: session.snapshot?.sceneVersion ?? null,
    nodes,
    removed,
  };
}

export function viewerHandlers({
  registry,
  limiter,
  logger,
  clock,
  rng = randomInt,
  overCapacity = () => false,
}: ViewerDeps) {
  /**
   * The canonical code of each normalised `viewer.join` object, `null` when it is malformed. The
   * handler looks up only this entry, so a missing one (any object the normaliser did not see)
   * fails closed as `INVALID_CODE`.
   */
  const joinCodes = new WeakMap<object, string | null>();
  const pendingRefusals = new Set<TimerHandle>();

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

  const handlers: HandlerTable = {
    "viewer.join": (connection, message) => {
      const replyTo = message.id;
      if (message.code === undefined) {
        // Rejoin with sessionId + viewerToken is SRV-15. Until then every token is unknown: the
        // documented answer, after which clients fall back to a code join on this socket (§9.2).
        connection.sendError("SESSION_NOT_FOUND", "no live session for this viewer token", {
          replyTo,
          retryable: false,
        });
        return;
      }
      // Before the lookup: the answer must not depend on whether the code is live (§12, T1).
      if (overCapacity()) {
        connection.fail("CAPACITY", "the relay is at its capacity", CLOSE_CODES.RATE_LIMITED, {
          replyTo,
          retryable: true,
        });
        logger.info({ errorCode: "CAPACITY" }, "viewer join refused");
        return;
      }
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
        return;
      }
      const { viewer, viewerToken } = added;
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
      connection.send(sceneState(session));
      broadcastCount(session);
      logger.info({ sessionId: session.id, viewerId: viewer.id, platform }, "viewer joined");
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
