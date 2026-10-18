/**
 * WebSocket endpoint `/ws`, part 2: envelope validation, role gate, permissions and dispatch
 * (docs/protocol.md §2, §3.1, §9.2–§9.3, §11, §14).
 *
 * Every text frame goes through `parseEnvelope` of `@slicerremoteview/shared` (PRO-06), then:
 * 1. protocol major ≠ 1 → `error UNSUPPORTED_VERSION` + `4000` — checked first, so it also applies to
 *    a first message whose type a 2.x client may have renamed (§2);
 * 2. first message: its `type` fixes the role (`session.create`/`session.resume` → publisher,
 *    `viewer.join` → viewer); anything else → `error UNAUTHORIZED` + `1008` (§3.1);
 * 3. unknown type of major 1 → `error UNSUPPORTED_TYPE`, the socket stays open (§2) — before a
 *    session is bound it counts as an `UNAUTHORIZED` offence instead (see 5);
 * 4. schema violation → `error INVALID_MESSAGE{details.instancePath}` (≤ 128 chars); the third on a
 *    socket → `4007`. A known type outside the role's column is judged by 5 before its schema;
 * 5. a type outside the role's column of §11 — or a handshake type once the socket is bound to a
 *    session, or anything but `ping` before it is — → `error UNAUTHORIZED`; the second → `1008`;
 * 6. the handler of the type (`HandlerTable`; SRV-06 onwards add theirs). An allowed type without a
 *    handler yet answers `UNSUPPORTED_TYPE` (not implemented by this relay build).
 * Unknown top-level fields are tolerated: the schemas do not forbid them (§14). Error messages carry
 * fixed text and validated type names; `details.instancePath` is a JSON Pointer into the sender's
 * own message (client→relay schemas have no maps with sender-chosen keys).
 */
import {
  CLOSE_CODES,
  isAllowed,
  isMessageType,
  parseEnvelope,
  PROTOCOL_VERSION,
} from "@slicerremoteview/shared";
import type { MessageOfType, MessageType, Validators } from "@slicerremoteview/shared";
import type { Clock } from "../clock.js";
import { HANDSHAKE_ROLES } from "./connection.js";
import type { Connection } from "./connection.js";

/** `INVALID_MESSAGE` answers per socket before close `4007` (§9.2: "3 strikes"). */
export const INVALID_MESSAGE_STRIKES = 3;
/** `UNAUTHORIZED` answers per socket before close `1008` (§11: "a second offence"). */
export const UNAUTHORIZED_STRIKES = 2;
/** Cap on the echoed `details.instancePath` (JSON Pointers of client messages are short). */
export const MAX_INSTANCE_PATH_LENGTH = 128;

/** May be async; the endpoint guards both throws and rejections (`INTERNAL` + `1011`). */
export type Handler<T extends MessageType> = (
  connection: Connection,
  message: MessageOfType<T>,
) => void | Promise<void>;
export type HandlerTable = { [T in MessageType]?: Handler<T> };

/** `type` and a well-formed `id` of a frame that failed validation (for the role gate and `replyTo`). */
function peek(text: string): { type?: string; id?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const { type, id } = value as { type?: unknown; id?: unknown };
    return {
      ...(typeof type === "string" && { type }),
      // Only an id the envelope schema would accept is echoed (§3.2: string, 1–32 chars).
      ...(typeof id === "string" && id.length > 0 && id.length <= 32 && { id }),
    };
  } catch {
    return {};
  }
}

export interface DispatcherOptions {
  clock: Clock;
  handlers?: HandlerTable;
  /** Shared validators; default: the lazily compiled strict set of `@slicerremoteview/shared`. */
  validators?: Validators;
}

/** Returns the `text` frame handler for the endpoint. */
export function createDispatcher(
  options: DispatcherOptions,
): (connection: Connection, text: string) => void | Promise<void> {
  const { clock, validators } = options;
  const table: HandlerTable = {
    // §9.1: both roles; the heartbeat bookkeeping (TTL refresh, WS pings) is SRV-14.
    ping: (connection, message) =>
      connection.send({
        type: "pong",
        ...(message.id !== undefined && { replyTo: message.id }),
        serverTs: clock.now(),
      }),
    ...options.handlers,
  };

  function unauthorized(connection: Connection, reason: string, replyTo: string | undefined): void {
    connection.offences += 1;
    const close = connection.offences >= UNAUTHORIZED_STRIKES;
    if (close)
      connection.fail("UNAUTHORIZED", reason, CLOSE_CODES.POLICY_VIOLATION, {
        replyTo,
        retryable: false,
      });
    else connection.sendError("UNAUTHORIZED", reason, { replyTo, retryable: false });
  }

  return function onText(connection: Connection, text: string): void | Promise<void> {
    const parsed = parseEnvelope(text, validators);
    const { type, id: replyTo } = parsed.ok
      ? { type: parsed.value.type as string, id: parsed.value.id }
      : peek(text);

    if (!parsed.ok && parsed.error.code === "UNSUPPORTED_VERSION") {
      connection.fail(
        "UNSUPPORTED_VERSION",
        parsed.error.message,
        CLOSE_CODES.UNSUPPORTED_VERSION,
        {
          replyTo,
          retryable: false,
          details: { protocolVersions: [PROTOCOL_VERSION] },
        },
      );
      return;
    }

    if (connection.role === undefined) {
      const role = type === undefined ? undefined : HANDSHAKE_ROLES.get(type);
      if (role === undefined) {
        connection.fail(
          "UNAUTHORIZED",
          "the first message must be session.create, session.resume or viewer.join (§3.1)",
          CLOSE_CODES.POLICY_VIOLATION,
          { replyTo, retryable: false },
        );
        return;
      }
      connection.role = role;
    }

    if (!parsed.ok) {
      // A known type outside the role's column is a permission offence whatever its content: the
      // relay never validates a relay→client schema for a client and echoes where it failed (such
      // schemas have maps whose keys the sender chooses, e.g. viewer.count.platforms).
      if (type !== undefined && isMessageType(type) && !isAllowed(connection.role, type)) {
        unauthorized(connection, `a ${connection.role} may not send ${type} (§11)`, replyTo);
        return;
      }
      if (parsed.error.code === "UNSUPPORTED_TYPE") {
        // Until a session is bound only the handshake and ping are expected (§3.1).
        if (!connection.bound)
          unauthorized(
            connection,
            "unknown type before the session handshake completed (§3.1)",
            replyTo,
          );
        else connection.sendError("UNSUPPORTED_TYPE", parsed.error.message, { replyTo });
        return;
      }
      connection.invalidMessages += 1;
      const details = {
        instancePath: parsed.error.instancePath.slice(0, MAX_INSTANCE_PATH_LENGTH),
      };
      if (connection.invalidMessages >= INVALID_MESSAGE_STRIKES)
        connection.fail("INVALID_MESSAGE", parsed.error.message, CLOSE_CODES.PROTOCOL_VIOLATION, {
          replyTo,
          details,
        });
      else connection.sendError("INVALID_MESSAGE", parsed.error.message, { replyTo, details });
      return;
    }

    const message = parsed.value;
    if (!isAllowed(connection.role, message.type)) {
      unauthorized(connection, `a ${connection.role} may not send ${message.type} (§11)`, replyTo);
      return;
    }
    const isHandshake = HANDSHAKE_ROLES.has(message.type);
    if (connection.bound && isHandshake) {
      unauthorized(
        connection,
        `${message.type} is only valid as the first message (§3.1)`,
        replyTo,
      );
      return;
    }
    if (!connection.bound && !isHandshake && message.type !== "ping") {
      unauthorized(
        connection,
        `${message.type} before the session handshake completed (§3.1)`,
        replyTo,
      );
      return;
    }
    const handler = table[message.type] as Handler<MessageType> | undefined;
    if (handler === undefined) {
      connection.sendError(
        "UNSUPPORTED_TYPE",
        `${message.type} is not implemented by this relay yet`,
        {
          replyTo,
        },
      );
      return;
    }
    return handler(connection, message as never);
  };
}
