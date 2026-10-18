/**
 * Permissions matrix of `docs/protocol.md` §11: which role may send which message type, and
 * in which direction. A message outside the sender's column → `error` `UNAUTHORIZED` (and
 * close `1008` for binary frames or a second offence).
 */

export type Role = "publisher" | "viewer" | "relay";

/** The four columns of the §11 table for one message type. */
export interface Permission {
  publisherToRelay: boolean;
  viewerToRelay: boolean;
  relayToPublisher: boolean;
  relayToViewer: boolean;
}

const P = (
  publisherToRelay: boolean,
  viewerToRelay: boolean,
  relayToPublisher: boolean,
  relayToViewer: boolean,
): Permission => ({ publisherToRelay, viewerToRelay, relayToPublisher, relayToViewer });

/** Every v1.0 message type (one `shared/schema/<type>.schema.json` each) with its §11 row. */
export const PERMISSIONS = {
  // Session lifecycle (§4)
  "session.create": P(true, false, false, false),
  "session.resume": P(true, false, false, false),
  "session.renew": P(true, false, false, false),
  "session.close": P(true, false, false, false),
  "session.created": P(false, false, true, false),
  "session.resumed": P(false, false, true, false),
  "session.renewed": P(false, false, true, false),
  "session.expiring": P(false, false, true, false),
  "session.closed": P(false, false, false, true),
  "session.expired": P(false, false, true, true),
  "session.publisherState": P(false, false, false, true),
  // Viewer join (§5)
  "viewer.join": P(false, true, false, false),
  "viewer.leave": P(false, true, false, false),
  "viewer.joined": P(false, false, false, true),
  "viewer.count": P(false, false, true, true),
  // Snapshot (§6)
  "scene.snapshot.begin": P(true, false, false, true),
  "scene.snapshot.end": P(true, false, false, true),
  "scene.snapshot.abort": P(true, false, false, true),
  "scene.snapshot.ready": P(false, false, false, true),
  "scene.snapshot.ack": P(false, false, true, false),
  // Incremental updates (§8)
  "scene.update": P(true, false, false, true),
  "scene.nodeRemoved": P(true, false, false, true),
  "scene.nodeAdded": P(true, false, false, true),
  "scene.state": P(false, false, false, true),
  "scene.request": P(false, true, false, false),
  // Heartbeat and errors (§9)
  ping: P(true, true, false, false),
  pong: P(false, false, true, true),
  error: P(false, false, true, true),
} as const satisfies Record<string, Permission>;

export type MessageType = keyof typeof PERMISSIONS;

/** All v1.0 message types, sorted. */
export const MESSAGE_TYPES: readonly MessageType[] = (
  Object.keys(PERMISSIONS) as MessageType[]
).sort();

/** Binary frames (GLB chunks, §6.3) travel publisher → relay → viewers only (§3.2, §11). */
export const BINARY_FRAME_PERMISSION: Permission = P(true, false, false, true);

/** Types reserved for v1.1 (§8.5, §11): unknown in 1.0, so `UNSUPPORTED_TYPE`, never allowed. */
export const RESERVED_TYPES = ["scene.camera", "viewer.command"] as const;

export function isMessageType(type: string): type is MessageType {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, type);
}

function column(sender: Role, recipient: Role): keyof Permission | null {
  if (sender === "publisher" && recipient === "relay") return "publisherToRelay";
  if (sender === "viewer" && recipient === "relay") return "viewerToRelay";
  if (sender === "relay" && recipient === "publisher") return "relayToPublisher";
  if (sender === "relay" && recipient === "viewer") return "relayToViewer";
  return null;
}

/**
 * True when `sender` may send a text message of `type` to `recipient` (§11). Clients talk to
 * the relay, so `recipient` defaults to `"relay"`; use `isAllowed("relay", type, "viewer")` for
 * what a viewer should accept. Unknown or reserved types are never allowed.
 */
export function isAllowed(sender: Role, type: string, recipient: Role = "relay"): boolean {
  const col = column(sender, recipient);
  if (col === null || !isMessageType(type)) return false;
  return PERMISSIONS[type][col];
}

/** True when `sender` may send a binary frame to `recipient` (§3.2 "only from the publisher"). */
export function isBinaryAllowed(sender: Role, recipient: Role = "relay"): boolean {
  const col = column(sender, recipient);
  return col !== null && BINARY_FRAME_PERMISSION[col];
}
