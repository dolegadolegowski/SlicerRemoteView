/**
 * Incremental updates (docs/protocol.md §8.1–§8.4, §6.2, §11; architecture §3): `scene.update`,
 * `scene.nodeRemoved` and `scene.nodeAdded` from the session's own publisher socket.
 *
 * - While a snapshot is in flight (a `begin` without its `end`) each of the three →
 *   `error BAD_SEQUENCE{field:"snapshotInFlight"}` (retryable) and is ignored: the publisher queues it
 *   and sends it after `end` with `baseVersion` = the snapshot version (§6.2). `scene.nodeAdded` too
 *   (§6.2 names the other two), or `end` would move the version back below an accepted one.
 * - Before the first snapshot → `BAD_SEQUENCE{field:"noSnapshot"}`: versions start with a snapshot
 *   (§8.4), and viewers apply updates to a GLB (§8.3), which does not exist yet.
 * - `baseVersion` other than the last accepted `sceneVersion` → `BAD_SEQUENCE{field:"baseVersion"}`;
 *   a `sceneVersion` not above `baseVersion` and every version a `begin` announced (§8.4: strictly
 *   increasing across snapshots and updates) → `BAD_SEQUENCE{field:"sceneVersion"}`; one above the
 *   uint32 of §6.3 → `INVALID_MESSAGE`, as for `begin`. The publisher then re-syncs with a snapshot
 *   (§8.1). A `BAD_SEQUENCE` here closes nothing and is no strike towards `4007` (§9.2).
 * - Accepted: `session.sceneVersion` advances; `scene.update` merges `visible`, `color`, `opacity`
 *   and `matrix` per node into `session.nodeState` (last writer wins, nothing else is copied — no
 *   names, T7), a node marked removed stays removed until the next snapshot; `scene.nodeRemoved`
 *   marks its ids removed; `scene.nodeAdded` is a hint and changes no state (§8.2). The frame goes to
 *   every connected viewer as received, byte for byte (§11), through the fan-out, which holds each
 *   send to the hard watermark and the global budget (`fanout.ts` `broadcast`). An accepted snapshot
 *   empties the state (`snapshot.ts`).
 * - The state holds at most `MAX_STATE_NODES` ids, so `scene.state` stays small (≈ 250 KiB with
 *   matrices for all of them, ≈ 0.65 MiB at worst: 128-character ids, every property at full
 *   precision): a message that would go beyond → `BAD_SEQUENCE{field:"nodeState"}` and is ignored;
 *   the publisher's snapshot empties the state (T3).
 * - `sceneState()` turns the merged state into §8.3's `scene.state` (ids and the four properties,
 *   no names): after `viewer.joined` and in reply to `scene.request` (`viewer.ts`), after a
 *   `scene.snapshot.ready` sent at `end` (`fanout.ts`).
 * Log lines carry the session id, versions and counts — never node ids.
 */
import { LIMITS } from "@slicerremoteview/shared";
import type { MessageOfType } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { NodeState, Session } from "../registry.js";
import type { Connection } from "./connection.js";
import type { HandlerTable } from "./dispatch.js";
import { refusedAboveUint32 } from "./snapshot.js";

/** Distinct node ids the merged state may hold (as many as one maximal `scene.update`, §3.3). */
export const MAX_STATE_NODES = LIMITS.MAX_CHANGES;

type UpdateMessage = MessageOfType<"scene.update" | "scene.nodeRemoved" | "scene.nodeAdded">;

/** What a refused update's `details.field` names, with the error text. */
const REFUSALS = {
  snapshotInFlight: "a snapshot is in flight: send it after end (§6.2)",
  noSnapshot: "no snapshot yet: send one first (§8.4)",
  baseVersion: "baseVersion is not the last accepted sceneVersion (§8.1)",
  sceneVersion: "sceneVersion must exceed every version used so far (§8.4)",
  nodeState: "the merged scene state is full: send a snapshot (§8.3)",
} as const;

/** `scene.state` of the session (§8.3): the merged node state since the cached snapshot. */
export function sceneState(session: Session) {
  const nodes: ({ nodeId: string } & NodeState)[] = [];
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

export interface StateDeps {
  logger: Logger;
  /** Sends an accepted frame to the session's viewers (`fanout.ts`). */
  broadcast: (session: Session, text: string) => void;
}

export function stateHandlers({ logger, broadcast }: StateDeps) {
  /**
   * `BAD_SEQUENCE` without a strike: §9.2 closes nothing for it. The publisher re-syncs with a
   * snapshot (§8.1), or for `snapshotInFlight` resends the message after `end` (§6.2).
   */
  function refuse(
    connection: Connection,
    message: UpdateMessage,
    field: keyof typeof REFUSALS,
  ): void {
    connection.sendError("BAD_SEQUENCE", REFUSALS[field], {
      replyTo: message.id,
      retryable: true,
      details: { field },
    });
    logger.debug(
      { sessionId: connection.session?.id, type: message.type, field, errorCode: "BAD_SEQUENCE" },
      "update refused",
    );
  }

  /**
   * The session the message may change, or `undefined`: from a publisher socket the session no
   * longer has (SRV-15) it is dropped silently, otherwise it was answered (§6.2, §8.1, §8.4). Other
   * roles never get here (§11, `dispatch.ts`).
   */
  function acceptedSession(connection: Connection, message: UpdateMessage): Session | undefined {
    const session = connection.session;
    // Only the session's own publisher socket, not one a resume replaced (SRV-15).
    if (session === undefined || session.publisher !== connection) return undefined;
    const { sceneVersion, baseVersion } = message;
    if (refusedAboveUint32(connection, sceneVersion, message.id)) return undefined;
    if (session.assembling !== undefined) refuse(connection, message, "snapshotInFlight");
    else if (session.snapshot === undefined) refuse(connection, message, "noSnapshot");
    else if (baseVersion !== session.sceneVersion) refuse(connection, message, "baseVersion");
    else if (sceneVersion <= Math.max(baseVersion, session.lastSnapshotVersion))
      refuse(connection, message, "sceneVersion");
    else return session;
    return undefined;
  }

  /** Refuses the message if its ids would take the state above `MAX_STATE_NODES` (T3). */
  function refusedAsFull(
    connection: Connection,
    session: Session,
    message: UpdateMessage,
    nodeIds: Iterable<string>,
  ): boolean {
    const fresh = new Set<string>();
    for (const nodeId of nodeIds) if (!session.nodeState.has(nodeId)) fresh.add(nodeId);
    if (session.nodeState.size + fresh.size <= MAX_STATE_NODES) return false;
    refuse(connection, message, "nodeState");
    return true;
  }

  /** Advances the version and sends the frame to the viewers as received (§11). */
  function publish(session: Session, message: UpdateMessage, text: string, count: number): void {
    session.sceneVersion = message.sceneVersion;
    broadcast(session, text);
    logger.debug(
      { sessionId: session.id, type: message.type, sceneVersion: message.sceneVersion, count },
      "update forwarded",
    );
  }

  const handlers: HandlerTable = {
    "scene.update": (connection, message, frame) => {
      const session = acceptedSession(connection, message);
      if (session === undefined) return;
      const nodeIds = message.changes.map((change) => change.nodeId);
      if (refusedAsFull(connection, session, message, nodeIds)) return;
      for (const change of message.changes) {
        const current = session.nodeState.get(change.nodeId);
        if (current === "removed") continue; // back only with a snapshot (§8.2)
        // The four visual properties only, copied one by one: never a name or any other key (T7).
        const next: NodeState = { ...current };
        if (change.visible !== undefined) next.visible = change.visible;
        if (change.color !== undefined)
          next.color = [change.color[0], change.color[1], change.color[2]];
        if (change.opacity !== undefined) next.opacity = change.opacity;
        if (change.matrix !== undefined) next.matrix = [...change.matrix];
        session.nodeState.set(change.nodeId, next);
      }
      publish(session, message, frame.text, message.changes.length);
    },
    "scene.nodeRemoved": (connection, message, frame) => {
      const session = acceptedSession(connection, message);
      if (session === undefined) return;
      if (refusedAsFull(connection, session, message, message.nodeIds)) return;
      for (const nodeId of message.nodeIds) session.nodeState.set(nodeId, "removed");
      publish(session, message, frame.text, message.nodeIds.length);
    },
    "scene.nodeAdded": (connection, message, frame) => {
      const session = acceptedSession(connection, message);
      if (session === undefined) return;
      publish(session, message, frame.text, message.nodes.length);
    },
  };

  return { handlers };
}
