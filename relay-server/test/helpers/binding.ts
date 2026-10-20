import type { Connection } from "../../src/ws/connection.js";
import type { HandlerTable } from "../../src/ws/dispatch.js";

/** Stands in for a create/resume/join handler: binds the socket and answers with a `pong`. */
function bind(connection: Connection, id: string | undefined): void {
  connection.completeHandshake();
  connection.send({ type: "pong", ...(id !== undefined && { replyTo: id }), serverTs: 0 });
}

/**
 * Test handlers that bind every handshake without a session, so dispatcher and endpoint rules for
 * bound sockets can be tested independently of the real create/resume/join handlers.
 */
export const BIND_ON_HANDSHAKE: HandlerTable = {
  "session.create": (connection, message) => bind(connection, message.id),
  "session.resume": (connection, message) => bind(connection, message.id),
  "viewer.join": (connection, message) => bind(connection, message.id),
};
