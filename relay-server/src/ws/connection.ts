/**
 * One accepted WebSocket (docs/protocol.md §3, §9). Wraps the `ws` socket with the protocol's
 * send conventions: every outgoing JSON message gets `protocolVersion` and `ts`; an `error` is
 * optionally followed by a close; once a close has been started nothing more is sent or handled.
 */
import { CLOSE_CODES, PROTOCOL_VERSION } from "@slicerremoteview/shared";
import type { ErrorCode } from "@slicerremoteview/shared";
import { WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.js";
import type { Metrics } from "../metrics.js";
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

/** The text frame of `message` with the envelope fields of §3.2 (`protocolVersion`, `ts`). */
export function encode(message: Outgoing, now: number): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message, ts: now });
}

export interface ErrorOptions {
  replyTo?: string | undefined;
  retryable?: boolean;
  /** Machine-readable context; never codes, tokens or scene content (§9.2). */
  details?: Record<string, unknown>;
}

/** `INVALID_MESSAGE`/`BAD_SEQUENCE` answers per socket before close `4007` (§9.2: "3 strikes"). */
export const PROTOCOL_VIOLATION_STRIKES = 3;
/**
 * A socket the relay closes is dropped unless its peer completes the close within this time, or
 * keeps reading (its send buffer shrinks), then up to `CLOSE_DRAIN_MAX_MS` in all.
 */
export const CLOSE_COMPLETE_MS = 5_000;
/** `ws`'s own `closeTimeout`: the longest a draining peer gets to read up to its close frame. */
export const CLOSE_DRAIN_MAX_MS = 30_000;

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
  #handshake: { ms: number; onTimeout: () => void } | undefined;

  constructor(
    readonly socket: WebSocket,
    private readonly clock: Clock,
    /** HMAC of the client address (`RateLimiter.clientKey`); never the address itself (NFR-12). */
    readonly clientKey: string,
    /** Counts the `error` messages and the bytes forwarded to a viewer (`/metrics`, SRV-19). */
    private readonly metrics?: Metrics,
  ) {}

  /** False once a close was started by either side. */
  get isOpen(): boolean {
    return !this.#closing && this.socket.readyState === WebSocket.OPEN;
  }

  /** Sends one JSON message with the envelope fields of §3.2. */
  send(message: Outgoing): void {
    if (!this.isOpen) return;
    this.socket.send(encode(message, this.clock.now()));
    // Every `error` passes here: `sendError`, and the fan-out's and the chunk timer's own (SRV-19).
    if (message.type === "error") this.metrics?.error(message.code as ErrorCode);
  }

  /**
   * Sends a frame as it is: a publisher frame as received (§11), text as is, a `Buffer` as binary,
   * or — `asText` — a `Buffer` holding a text frame's UTF-8 bytes (an update encoded once for many
   * sockets, or a relay message the fan-out measured before sending it, `fanout.ts`).
   */
  forward(frame: string | Buffer, asText = false): void {
    if (!this.isOpen) return;
    this.socket.send(frame, { binary: typeof frame !== "string" && !asText });
    if (this.role === "viewer" && this.metrics !== undefined)
      this.metrics.relayed(typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength);
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

  /** A WebSocket-level ping (§9.1); the peer answers with a pong echoing `payload`. */
  ping(payload: Buffer): void {
    if (this.isOpen) this.socket.ping(payload);
  }

  /** Answers the peer's WebSocket ping with its `payload` (`autoPong` is off, `endpoint.ts`). */
  pong(payload: Buffer): void {
    if (this.isOpen) this.socket.pong(payload);
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
    const state = this.socket.readyState;
    if (state === WebSocket.CLOSED) return;
    // The peer may have started the close (a close frame, or a TCP half-close, after which `ws`
    // arms no timer at all): only the timer below then ends the socket.
    if (state !== WebSocket.CLOSING) this.socket.close(closeCode);
    this.#dropUnlessClosed();
  }

  /**
   * Terminates the socket unless its close completes: checked every `CLOSE_COMPLETE_MS`, it gets
   * more time only while its send buffer shrinks (the close frame is queued behind data its peer is
   * still reading, so the close code reaches it), and never past `CLOSE_DRAIN_MAX_MS`. A peer that
   * reads nothing would otherwise keep the socket, and what is queued for it, outside the fan-out's
   * accounting for `ws`'s 30 s `closeTimeout`, or for good after a half-close (T3).
   */
  #dropUnlessClosed(): void {
    const deadline = this.clock.now() + CLOSE_DRAIN_MAX_MS;
    let left = this.socket.bufferedAmount;
    let timer: TimerHandle;
    const arm = (): void => {
      timer = this.clock.setTimeout(() => {
        const amount = this.socket.bufferedAmount;
        if (amount >= left || this.clock.now() >= deadline) this.socket.terminate();
        else {
          left = amount;
          arm();
        }
      }, CLOSE_COMPLETE_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    arm();
    this.socket.once("close", () => this.clock.clearTimeout(timer));
  }

  /**
   * Stops decoding a socket that is closing or waits to be closed while its peer floods: nothing it
   * sends is read any more (also not its close frame), and the close timer ends it. Unlike
   * `terminate()`, what was queued for the peer — the close code — still reaches it.
   */
  stopReading(): void {
    this.socket.pause();
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
    this.#handshake = { ms, onTimeout };
    this.#clearHandshakeTimer();
    this.#handshakeTimer = this.clock.setTimeout(() => {
      this.#handshakeTimer = undefined;
      onTimeout();
    }, ms);
  }

  /**
   * A full handshake window again, from now: after `SESSION_NOT_FOUND` the client may fall back to
   * a create or a code join on this socket (§4.3, §9.2: "socket kept open 10 s for fallback").
   */
  restartHandshakeTimer(): void {
    if (this.#handshake === undefined) return;
    this.armHandshakeTimer(this.#handshake.ms, this.#handshake.onTimeout);
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
