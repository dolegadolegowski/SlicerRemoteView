/**
 * Publisher lifecycle (docs/protocol.md §4.1–§4.2, §4.5–§4.6, §9.1; architecture §2.1, §2.8–§2.9, §3).
 *
 * - `session.create` → registry session + `session.created` (code, `publisherToken` once, viewer
 *   limit, TTLs, effective limits); `CAPACITY` at `MAX_SESSIONS` → `error` + `4006`; more than 5 per
 *   minute from one client address → `RATE_LIMITED{retryAfterS}` + `4006` (§12). A well-formed
 *   `preferredCode` counts as a failed join of that address, granted or not, and is ignored while
 *   the address is banned (otherwise it would probe which codes are live, T1).
 * - `session.close` → every viewer gets `session.closed{PUBLISHER_CLOSED}` + `4001`, the session is
 *   released (code quarantined, snapshot dropped), the publisher socket closes `1000`.
 * - Publisher socket lost → phase `grace`, viewers get `session.publisherState{online:false,
 *   graceEndsAt}`; resume is SRV-15.
 * - Registry `expired` (grace over, idle, lifetime) → `session.expired{reason}` + `4002` to the
 *   viewers and, if still connected, the publisher.
 * - Registry `expiring` (60 s before the idle expiry, only while no viewer is connected) →
 *   `session.expiring{reason:"IDLE", closesAt}` to the publisher; `session.renew` restarts the idle
 *   period and answers `session.renewed{ttl}` (§4.4). `ttl.expiresAt` is the lifetime deadline, which
 *   no renew moves (§4.2).
 * Log lines carry the session id and reasons only — never the code or the token (NFR-12).
 */
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import { isWellFormed } from "../codes.js";
import { publicLimits } from "../config.js";
import type { Config } from "../config.js";
import type { RateLimiter } from "../ratelimit.js";
import { RegistryError } from "../registry.js";
import type { ExpiryReason, Peer, Registry, Session } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable } from "./dispatch.js";

export interface PublisherDeps {
  registry: Registry;
  config: Config;
  /** `session.create` 5/min per client address; the `preferredCode` oracle (§12, SRV-08). */
  limiter: RateLimiter;
  logger: Logger;
}

export function publisherHandlers({ registry, config, limiter, logger }: PublisherDeps) {
  /** Sends `message` to every viewer with an open socket, then closes them with `closeCode`. */
  function endViewers(
    session: Session,
    message: Parameters<Peer["send"]>[0],
    closeCode: number,
  ): void {
    for (const viewer of session.viewers.values()) {
      const peer = viewer.peer;
      if (peer === undefined) continue;
      registry.viewerDisconnected(session, viewer);
      peer.send(message);
      peer.close(closeCode);
    }
  }

  // The same effective limits as GET /api/version (§14), plus the update cap.
  const announced = publicLimits(config);
  const sessionLimits = {
    maxSnapshotBytes: announced.maxSnapshotBytes,
    maxChunkBytes: announced.maxChunkBytes,
    maxTextBytes: announced.maxTextBytes,
    maxChanges: LIMITS.MAX_CHANGES,
  };
  const handlers: HandlerTable = {
    "session.create": (connection, message) => {
      const key = connection.clientKey;
      const allowed = limiter.create(key);
      if (!allowed.ok) {
        connection.fail(
          "RATE_LIMITED",
          "too many sessions created from this address",
          CLOSE_CODES.RATE_LIMITED,
          { replyTo: message.id, retryable: true, details: { retryAfterS: allowed.retryAfterS } },
        );
        logger.debug({ errorCode: "RATE_LIMITED" }, "session refused");
        return;
      }
      // A preferredCode probes a code like a join does (granted = free, not granted = live or
      // quarantined), so it counts as a failed join either way and is ignored while the address is
      // banned: with 5 creates/min it is no faster oracle than viewer.join (§12, T1). It does not
      // need a slot of the per-minute join window, so failed joins of viewers behind the presenter's
      // NAT after a redeploy cannot cost the presenter the code on the screen (§4.3, §13 step 9) —
      // except during the global alarm, when probes too stay within its 3/min join window.
      const probe =
        isWellFormed(message.preferredCode) &&
        limiter.checkBan(key).ok &&
        (!limiter.alarmActive || limiter.join(key).ok);
      const preferred = probe ? message.preferredCode : undefined;
      let created;
      try {
        created = registry.createSession(message.profile, preferred);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        logger.warn({ errorCode: "CAPACITY" }, "session refused");
        connection.fail("CAPACITY", "the relay is at its session limit", CLOSE_CODES.RATE_LIMITED, {
          replyTo: message.id,
          retryable: true,
        });
        return;
      }
      // Counted only once the probe was answered (a CAPACITY refusal tells nothing about the code).
      if (probe) limiter.joinFailed(key);
      const { session, publisherToken } = created;
      session.publisher = connection;
      connection.session = session;
      connection.completeHandshake();
      connection.send({
        type: "session.created",
        ...(message.id !== undefined && { replyTo: message.id }),
        sessionId: session.id,
        code: session.code,
        publisherToken,
        viewerLimit: config.maxViewers,
        ttl: registry.ttl(session),
        limits: sessionLimits,
      });
      logger.info({ sessionId: session.id, profile: session.profile }, "session created");
    },

    "session.close": (connection, message) => {
      const session = connection.session;
      if (session === undefined) return;
      endViewers(
        session,
        { type: "session.closed", sessionId: session.id, reason: "PUBLISHER_CLOSED" },
        CLOSE_CODES.SESSION_CLOSED,
      );
      session.publisher = undefined;
      registry.closeSession(session);
      connection.session = undefined;
      connection.close(CLOSE_CODES.NORMAL);
      logger.info({ sessionId: session.id, reason: message.reason }, "session closed by publisher");
    },

    "session.renew": (connection, message) => {
      const session = connection.session;
      // Only the session's own publisher socket, not one it has replaced (SRV-15).
      if (session === undefined || session.publisher !== connection) return;
      registry.renew(session);
      connection.send({
        type: "session.renewed",
        ...(message.id !== undefined && { replyTo: message.id }),
        ttl: registry.ttl(session),
      });
      logger.debug({ sessionId: session.id }, "session renewed");
    },
  };

  /** The publisher's socket closed without `session.close` (or after it — then nothing is left to do). */
  function publisherClosed(connection: Connection, closeCode: number): void {
    const session = connection.session;
    if (session === undefined || session.publisher !== connection) return;
    session.publisher = undefined;
    const graceEndsAt = registry.publisherLost(session);
    if (graceEndsAt === undefined) return;
    for (const viewer of session.viewers.values())
      viewer.peer?.send({ type: "session.publisherState", online: false, graceEndsAt });
    logger.info({ sessionId: session.id, closeCode }, "publisher lost, grace period started");
  }

  function sessionExpired(session: Session, reason: ExpiryReason): void {
    const message = { type: "session.expired", sessionId: session.id, reason };
    endViewers(session, message, CLOSE_CODES.SESSION_EXPIRED);
    const publisher = session.publisher;
    session.publisher = undefined;
    publisher?.send(message);
    publisher?.close(CLOSE_CODES.SESSION_EXPIRED);
    logger.info({ sessionId: session.id, reason }, "session expired");
  }

  function sessionExpiring(session: Session, closesAt: number): void {
    session.publisher?.send({ type: "session.expiring", reason: "IDLE", closesAt });
  }

  registry.on("expired", sessionExpired);
  registry.on("expiring", sessionExpiring);
  /** Detaches from the registry (the app calls it on close). */
  const dispose = (): void => {
    registry.off("expired", sessionExpired);
    registry.off("expiring", sessionExpiring);
  };
  return { handlers, publisherClosed, dispose };
}
