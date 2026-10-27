/**
 * Publisher lifecycle (docs/protocol.md §4, §9.1; architecture §2.1, §2.8–§2.9, §3).
 *
 * - `session.create` → registry session + `session.created` (code, `publisherToken` once, viewer
 *   limit, TTLs, effective limits); `CAPACITY` at `MAX_SESSIONS` → `error` + `4006`; more than 5 per
 *   minute from one client address → `RATE_LIMITED{retryAfterS}` + `4006` (§12). A well-formed
 *   `preferredCode` counts as a failed join of that address, granted or not, and is ignored while
 *   the address is banned (otherwise it would probe which codes are live, T1).
 * - `session.close` → every viewer gets `session.closed{PUBLISHER_CLOSED}` + `4001`, the session is
 *   released (code quarantined, snapshot dropped), the publisher socket closes `1000`.
 * - Publisher socket lost → phase `grace`, viewers get `session.publisherState{online:false,
 *   graceEndsAt}`.
 * - `session.resume{sessionId, publisherToken}` (§4.3; one per socket): while the session is live —
 *   in grace, or with the old socket still open (half-open; it is closed `4011` and its snapshot in
 *   flight aborted `PUBLISHER_GONE`) — → `session.resumed{code, sceneVersion, snapshotVersion,
 *   viewerCount, ttl}`, and viewers that were told `online:false` get `online:true` (§4.6).
 *   `sceneVersion` is the highest version used, a refused or aborted `begin`'s too (§8.4, report
 *   `2026-10-26-server-1`). Unknown session → `error SESSION_NOT_FOUND`, the socket kept open for a
 *   fresh 10 s window in which `session.create{preferredCode}` may follow; wrong token → `error
 *   UNAUTHORIZED` + `4003` at once. Neither counts towards a rate limit: the 256-bit token is the
 *   only secret (session ids reach every viewer; the two answers, which §4.3 requires, tell only
 *   whether a session is still live). A resume that replaces an open socket is logged at `warn`. An
 *   outstanding idle warning (`session.expiring`; no viewer since, not renewed) is repeated after
 *   `session.resumed` with the same `closesAt` — also when the old socket got it.
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
import { isWellFormed, tokenMatches } from "../codes.js";
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
  /** A resume replaced a publisher socket that was still open: abort its snapshot in flight. */
  publisherReplaced?: (session: Session) => void;
}

export function publisherHandlers({
  registry,
  config,
  limiter,
  logger,
  publisherReplaced,
}: PublisherDeps) {
  /** Sockets that sent their one `session.resume` (§4.3: only the fallback create may follow). */
  const resumeTried = new WeakSet<Connection>();

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

    "session.resume": (connection, message) => {
      const replyTo = message.id;
      if (resumeTried.has(connection)) {
        connection.fail(
          "UNAUTHORIZED",
          "one session.resume per socket; only session.create may follow (§4.3)",
          CLOSE_CODES.POLICY_VIOLATION,
          { replyTo, retryable: false },
        );
        return;
      }
      resumeTried.add(connection);
      const session = registry.get(message.sessionId);
      if (session === undefined) {
        // After a redeploy (§13 step 9): the client falls back to session.create on this socket.
        connection.sendError("SESSION_NOT_FOUND", "no live session has this id", {
          replyTo,
          retryable: false,
        });
        connection.restartHandshakeTimer();
        logger.info({ errorCode: "SESSION_NOT_FOUND" }, "session resume refused");
        return;
      }
      if (!tokenMatches(message.publisherToken, session.publisherTokenHash)) {
        connection.fail(
          "UNAUTHORIZED",
          "the publisher token does not match this session (§4.3)",
          CLOSE_CODES.UNAUTHORIZED,
          { replyTo, retryable: false },
        );
        logger.info({ sessionId: session.id, errorCode: "UNAUTHORIZED" }, "session resume refused");
        return;
      }
      const old = session.publisher;
      const wasOffline = session.phase === "grace";
      if (old !== undefined) {
        // Half-open (§4.3): the old socket is still open. It acts on the session no more.
        session.publisher = undefined;
        publisherReplaced?.(session);
        old.close(CLOSE_CODES.REPLACED);
      }
      registry.publisherResumed(session);
      registry.touchPublisher(session);
      session.publisher = connection;
      connection.session = session;
      connection.completeHandshake();
      const { snapshot } = session;
      connection.send({
        type: "session.resumed",
        ...(replyTo !== undefined && { replyTo }),
        sessionId: session.id,
        code: session.code,
        sceneVersion: Math.max(session.sceneVersion, session.lastSnapshotVersion),
        snapshotVersion: snapshot?.sceneVersion ?? null,
        viewerCount: session.connectedViewers,
        ttl: registry.ttl(session),
      });
      if (wasOffline)
        for (const viewer of session.viewers.values())
          viewer.peer?.send({ type: "session.publisherState", online: true });
      // An outstanding idle warning (§4.4): the old socket may never have got it.
      const closesAt = session.idleWarned ? registry.idleDeadline(session) : undefined;
      if (closesAt !== undefined)
        connection.send({ type: "session.expiring", reason: "IDLE", closesAt });
      // A replaced open socket is the only trace of a takeover with a stolen token (T4).
      logger[old === undefined ? "info" : "warn"](
        { sessionId: session.id, replaced: old !== undefined },
        "session resumed",
      );
    },

    "session.close": (connection, message) => {
      const session = connection.session;
      // Only the session's own publisher socket, not one a resume replaced.
      if (session === undefined || session.publisher !== connection) return;
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
