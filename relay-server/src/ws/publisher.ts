/**
 * Publisher lifecycle (docs/protocol.md §4.1–§4.2, §4.5–§4.6, §9.1; architecture §2.1, §2.8–§2.9, §3).
 *
 * - `session.create` → registry session + `session.created` (code, `publisherToken` once, viewer
 *   limit, TTLs, effective limits); `CAPACITY` at `MAX_SESSIONS` → `error` + `4006`.
 * - `session.close` → every viewer gets `session.closed{PUBLISHER_CLOSED}` + `4001`, the session is
 *   released (code quarantined, snapshot dropped), the publisher socket closes `1000`.
 * - Publisher socket lost → phase `grace`, viewers get `session.publisherState{online:false,
 *   graceEndsAt}`; resume is SRV-15.
 * - Registry `expired` (grace over, idle, lifetime) → `session.expired{reason}` + `4002` to the
 *   viewers and, if still connected, the publisher.
 * Log lines carry the session id and reasons only — never the code or the token (NFR-12).
 */
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import { publicLimits } from "../config.js";
import type { Config } from "../config.js";
import { RegistryError } from "../registry.js";
import type { ExpiryReason, Peer, Registry, Session } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable } from "./dispatch.js";

export interface PublisherDeps {
  registry: Registry;
  config: Config;
  logger: Logger;
}

export function publisherHandlers({ registry, config, logger }: PublisherDeps) {
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
      let created;
      try {
        created = registry.createSession(message.profile, message.preferredCode);
      } catch (error) {
        if (!(error instanceof RegistryError)) throw error;
        logger.warn({ errorCode: "CAPACITY" }, "session refused");
        connection.fail("CAPACITY", "the relay is at its session limit", CLOSE_CODES.RATE_LIMITED, {
          replyTo: message.id,
          retryable: true,
        });
        return;
      }
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

  registry.on("expired", sessionExpired);
  /** Detaches from the registry (the app calls it on close). */
  const dispose = (): void => void registry.off("expired", sessionExpired);
  return { handlers, publisherClosed, dispose };
}
