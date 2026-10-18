/**
 * One accepted WebSocket (docs/protocol.md §3, §9). Wraps the `ws` socket with the protocol's
 * send conventions: every outgoing JSON message gets `protocolVersion` and `ts`; an `error` is
 * optionally followed by a close; once a close has been started nothing more is sent or handled.
 */
import { PROTOCOL_VERSION } from "@slicerremoteview/shared";
import type { ErrorCode } from "@slicerremoteview/shared";
import { WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.js";

export type Role = "publisher" | "viewer";

/** First-message types and the role they fix (§3.1, §11). A `Map`, so `"constructor"` is no key. */
export const HANDSHAKE_ROLES: ReadonlyMap<string, Role> = new Map([
  ["session.create", "publisher"],
  ["session.resume", "publisher"],
  ["viewer.join", "viewer"],
]);

/** An outgoing message before the envelope fields are added. */
export type Outgoing = { type: string } & Record<string, unknown>;

export interface ErrorOptions {
  replyTo?: string | undefined;
  retryable?: boolean;
  /** Machine-readable context; never codes, tokens or scene content (§9.2). */
  details?: Record<string, unknown>;
}

let nextConnectionId = 1;

export class Connection {
  /** Process-local number for log lines; carries no client data. */
  readonly id = nextConnectionId++;
  /** Fixed by the type of the first message (§3.1); `undefined` until then. */
  role: Role | undefined;
  /** `INVALID_MESSAGE` answers so far (3 → close `4007`, §9.2). */
  invalidMessages = 0;
  /** `UNAUTHORIZED` answers so far (2 → close `1008`, §11). */
  offences = 0;
  #bound = false;
  #closing = false;
  #handshakeTimer: TimerHandle | undefined;

  constructor(
    readonly socket: WebSocket,
    private readonly clock: Clock,
  ) {}

  /** False once a close was started by either side. */
  get isOpen(): boolean {
    return !this.#closing && this.socket.readyState === WebSocket.OPEN;
  }

  /** Sends one JSON message with the envelope fields of §3.2. */
  send(message: Outgoing): void {
    if (!this.isOpen) return;
    this.socket.send(
      JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message, ts: this.clock.now() }),
    );
  }

  /** Sends `error` (§9.2); `message` is developer-facing English without client data. */
  sendError(code: ErrorCode, message: string, options: ErrorOptions = {}): void {
    this.send({
      type: "error",
      ...(options.replyTo !== undefined && { replyTo: options.replyTo }),
      code,
      message,
      ...(options.retryable !== undefined && { retryable: options.retryable }),
      ...(options.details !== undefined && { details: options.details }),
    });
  }

  /** `error` then close with `closeCode` (§9.3). */
  fail(code: ErrorCode, message: string, closeCode: number, options: ErrorOptions = {}): void {
    this.sendError(code, message, options);
    this.close(closeCode);
  }

  /** Starts the closing handshake; no reason text (it would only repeat the code). */
  close(closeCode: number): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#clearHandshakeTimer();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close(closeCode);
  }

  /** Marks a close the peer started, so handlers stop sending. */
  markClosed(): void {
    this.#closing = true;
    this.#clearHandshakeTimer();
  }

  /** Runs `onTimeout` unless `completeHandshake()` is called within `ms` (§3.1, close `4012`). */
  armHandshakeTimer(ms: number, onTimeout: () => void): void {
    this.#clearHandshakeTimer();
    this.#handshakeTimer = this.clock.setTimeout(() => {
      this.#handshakeTimer = undefined;
      onTimeout();
    }, ms);
  }

  /** The socket is bound to a session (create, resume or join succeeded). */
  completeHandshake(): void {
    this.#bound = true;
    this.#clearHandshakeTimer();
  }

  /** True once `completeHandshake()` was called. */
  get bound(): boolean {
    return this.#bound;
  }

  get handshakePending(): boolean {
    return this.#handshakeTimer !== undefined;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== undefined) this.clock.clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }
}
