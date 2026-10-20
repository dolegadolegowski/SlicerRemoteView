/**
 * WebSocket endpoint `/ws`, part 2: envelope validation, role gate, permissions and dispatch
 * (docs/protocol.md §2, §3.1, §9.2–§9.3, §11, §14).
 *
 * Every text frame arrives parsed once (`frame.ts`); a `Normalizer` of its type may rewrite the parsed
 * object (e.g. the code of `viewer.join`, §12) before it goes through the checks of `parseEnvelope` of
 * `@slicerremoteview/shared` (PRO-06), then:
 * 1. protocol major ≠ 1 → `error UNSUPPORTED_VERSION` + `4000` — checked first, so it also applies to
 *    a first message whose type a 2.x client may have renamed (§2);
 * 2. first message: its `type` fixes the role (`session.create`/`session.resume` → publisher,
 *    `viewer.join` → viewer); anything else → `error UNAUTHORIZED` + `1008` (§3.1);
 * 3. unknown type of major 1 → `error UNSUPPORTED_TYPE`, the socket stays open (§2) — before a
 *    session is bound it counts as an `UNAUTHORIZED` offence instead (see 5);
 * 4. schema violation → `error INVALID_MESSAGE{details.instancePath}` (≤ 128 chars); the third
 *    protocol violation on a socket (`INVALID_MESSAGE` or `BAD_SEQUENCE`, `Connection.violation`) →
 *    `4007`. A known type outside the role's column is judged by 5 before its schema;
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
  defaultSchemas,
  isAllowed,
  isMessageType,
  PROTOCOL_VERSION,
} from "@slicerremoteview/shared";
import type { MessageOfType, MessageType, Validators } from "@slicerremoteview/shared";
import type { Clock } from "../clock.js";
import { HANDSHAKE_ROLES } from "./connection.js";
import type { Connection } from "./connection.js";
import { checkEnvelope } from "./frame.js";
import type { TextFrame } from "./frame.js";

/** `UNAUTHORIZED` answers per socket before close `1008` (§11: "a second offence"). */
export const UNAUTHORIZED_STRIKES = 2;
/** Cap on the echoed `details.instancePath` (JSON Pointers of client messages are short). */
export const MAX_INSTANCE_PATH_LENGTH = 128;

/**
 * May be async; the endpoint guards both throws and rejections (`INTERNAL` + `1011`). `frame` is the
 * message as received, for handlers that forward it byte for byte (§11).
 */
export type Handler<T extends MessageType> = (
  connection: Connection,
  message: MessageOfType<T>,
  frame: TextFrame,
) => void | Promise<void>;
export type HandlerTable = { [T in MessageType]?: Handler<T> };

/**
 * Rewrites a parsed object frame of its type in place before schema validation; it must keep
 * every other field as received (it sees unvalidated input).
 */
export type Normalizer = (value: Record<string, unknown>) => void;
export type NormalizerTable = { [T in MessageType]?: Normalizer };

export interface DispatcherOptions {
  clock: Clock;
  handlers?: HandlerTable;
  /** Shared validators; default: the lazily compiled strict set of `@slicerremoteview/shared`. */
  validators?: Validators;
  normalizers?: NormalizerTable;
}

/** Returns the `text` frame handler for the endpoint. */
export function createDispatcher(
  options: DispatcherOptions,
): (connection: Connection, frame: TextFrame) => void | Promise<void> {
  const { clock } = options;
  const validators = options.validators ?? defaultSchemas();
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

  const normalizers = new Map(Object.entries(options.normalizers ?? {}));

  return function onText(connection: Connection, frame: TextFrame): void | Promise<void> {
    const normalize = frame.type === undefined ? undefined : normalizers.get(frame.type);
    if (normalize !== undefined && typeof frame.value === "object" && frame.value !== null)
      normalize(frame.value as Record<string, unknown>);
    const parsed = checkEnvelope(frame, validators);
    const { type, id: replyTo } = parsed.ok
      ? { type: parsed.value.type as string, id: parsed.value.id }
      : frame;

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
      connection.violation("INVALID_MESSAGE", parsed.error.message, {
        replyTo,
        details: { instancePath: parsed.error.instancePath.slice(0, MAX_INSTANCE_PATH_LENGTH) },
      });
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
    return handler(connection, message as never, frame);
  };
}
