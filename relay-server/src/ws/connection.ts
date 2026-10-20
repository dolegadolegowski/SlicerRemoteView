/**
 * One accepted WebSocket (docs/protocol.md §3, §9). Wraps the `ws` socket with the protocol's
 * send conventions: every outgoing JSON message gets `protocolVersion` and `ts`; an `error` is
 * optionally followed by a close; once a close has been started nothing more is sent or handled.
 */
import { CLOSE_CODES, PROTOCOL_VERSION } from "@slicerremoteview/shared";
import type { ErrorCode } from "@slicerremoteview/shared";
import { WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.js";
import type { Peer, Session, Viewer } from "../registry.js";

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

/** `INVALID_MESSAGE`/`BAD_SEQUENCE` answers per socket before close `4007` (§9.2: "3 strikes"). */
export const PROTOCOL_VIOLATION_STRIKES = 3;

let nextConnectionId = 1;

export class Connection implements Peer {
  /** Process-local number for log lines; carries no client data. */
  readonly id = nextConnectionId++;
  /** Fixed by the type of the first message (§3.1); `undefined` until then. */
  role: Role | undefined;
  /** The session this socket is bound to (publisher or viewer); set by create/resume/join. */
  session: Session | undefined;
  /** The registry entry of a joined viewer (`ws/viewer.ts`). */
  viewer: Viewer | undefined;
  /** `INVALID_MESSAGE` and `BAD_SEQUENCE` answers so far (the third closes `4007`, §9.2, §9.3). */
  violations = 0;
  /** `UNAUTHORIZED` answers so far (2 → close `1008`, §11). */
  offences = 0;
  #bound = false;
  #closing = false;
  #reading = true;
  #paused = false;
  #handshakeTimer: TimerHandle | undefined;

  constructor(
    readonly socket: WebSocket,
    private readonly clock: Clock,
    /** HMAC of the client address (`RateLimiter.clientKey`); never the address itself (NFR-12). */
    readonly clientKey: string,
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

  /** Sends a publisher frame as received (text or binary), unchanged (§11). */
  forward(frame: string | Buffer): void {
    if (!this.isOpen) return;
    this.socket.send(frame, { binary: typeof frame !== "string" });
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  /** `ws` `pause()`/`resume()`: the socket stops / restarts emitting messages. */
  pauseReading(): void {
    if (this.#closing) return;
    this.#paused = true;
    this.socket.pause();
  }

  resumeReading(): void {
    this.#paused = false;
    this.socket.resume();
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

  /**
   * A protocol violation (`INVALID_MESSAGE` or `BAD_SEQUENCE`): `error`, and close `4007` on the
   * third of this socket ("3 strikes", §9.2, §9.3).
   */
  violation(
    code: "INVALID_MESSAGE" | "BAD_SEQUENCE",
    message: string,
    options: ErrorOptions = {},
  ): void {
    this.violations += 1;
    if (this.violations >= PROTOCOL_VIOLATION_STRIKES)
      this.fail(code, message, CLOSE_CODES.PROTOCOL_VIOLATION, options);
    else this.sendError(code, message, options);
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
    // A paused socket would not read the peer's close frame: `ws` would wait 30 s to destroy it.
    if (this.#paused) this.resumeReading();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close(closeCode);
  }

  /** Destroys the socket without a closing handshake (a peer that reads nothing cannot complete one). */
  terminate(): void {
    this.#closing = true;
    this.#clearHandshakeTimer();
    this.socket.terminate();
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

  /**
   * The socket's last answer is pending and the caller closes it afterwards (e.g. a failed join waits
   * for its jitter, §12: no retries on one socket): every further frame is ignored, and the
   * handshake timer no longer fires, so that answer is not pre-empted by `4012`.
   */
  awaitClose(): void {
    this.#reading = false;
    this.#clearHandshakeTimer();
  }

  /** False after `awaitClose()`: the endpoint drops incoming frames. */
  get reading(): boolean {
    return this.#reading;
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
