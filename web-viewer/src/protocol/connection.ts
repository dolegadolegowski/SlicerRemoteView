// WebSocket client for one viewer connection (WEB-04; docs/protocol.md §3, §5, §9). No DOM, no three.js:
// the socket, the clock and the validator are injectable so the whole thing runs in vitest with a mock socket
// and fake timers. Reconnect with backoff is WEB-14; this class is exactly one socket's lifetime.
//
// Privacy (CLAUDE.md rule 6, NFR-15): the code and the viewer token are only ever sent as the body of
// `viewer.join`; they are kept out of the URL and out of every log line (only `type` strings are logged).

import { LIMITS } from "@slicerremoteview/shared";
import type { Message, MessageOfType, MessageType } from "@slicerremoteview/shared";
import { version as APP_VERSION } from "../../package.json";
import { detectLang } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import { describe } from "../state/errors";
import type { Description } from "../state/errors";
import { parseInbound, printableType } from "./envelope";
import type { ParseInbound } from "./envelope";

/** What the viewer announces in `clientInfo.capabilities.maxSnapshotBytes` unless told otherwise: 32 MiB (§3.3). */
export const DEFAULT_MAX_SNAPSHOT_BYTES: number = LIMITS.RECOMMENDED_SNAPSHOT_BYTES_MOBILE;

export type JoinCredentials =
  { readonly code: string } | { readonly sessionId: string; readonly viewerToken: string };

export interface ClientInfoOptions {
  /** `web | quest-browser | quest2 | quest3 | other` (§5.1); WEB-15 detects it. */
  readonly platform?: string;
  /** `mobile | quest2 | quest3` — informational (§5.1). */
  readonly profile?: string;
}

/** The part of the browser `WebSocket` this client uses; tests pass a mock. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LogFn = (message: string, fields?: Record<string, string | number>) => void;

export interface ConnectionOptions {
  /** Full `ws(s)://…/ws` URL; default derived from `location` (ADR 0006). */
  readonly url?: string;
  readonly location?: Pick<Location, "protocol" | "host" | "hostname">;
  readonly createSocket?: (url: string) => SocketLike;
  /** Default: the CSP-friendly shape check of `envelope.ts`. */
  readonly parse?: ParseInbound;
  readonly clientInfo?: ClientInfoOptions;
  readonly maxSnapshotBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly lang?: Lang;
  readonly log?: LogFn;
}

interface Closed {
  readonly description: Description;
  /** The WebSocket close code, or the nearest §9.3 code for a client-side decision (`4009` = dead). */
  readonly closeCode: number;
  /** Seconds the relay asked us to wait (`error.details.retryAfterS`), if any. */
  readonly retryAfterS?: number;
}

/**
 * `connecting` covers the socket handshake and the wait for `viewer.joined`. The last five are the outcomes of a
 * closed socket: `disconnected` = retry (WEB-14), `enterCode` = the credentials are no longer valid, `sessionEnded`
 * = presentation over (4001/4002), `stopped` = do not retry automatically (4000, 1008, 1009, insecure transport).
 */
export type ConnectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | (Closed & {
      readonly kind: "disconnected";
      /** True for `4008` (relay restart): reconnect right away with 0–3 s jitter (§9.3). */
      readonly immediate: boolean;
      /** True when the heartbeat, not the relay, ended the connection. */
      readonly dead: boolean;
    })
  | (Closed & { readonly kind: "enterCode" | "sessionEnded" | "stopped" });

type ClosedState = Extract<
  ConnectionState,
  { kind: "disconnected" | "enterCode" | "sessionEnded" | "stopped" }
>;

export interface ConnectionEvents {
  state: ConnectionState;
  /** A binary frame (snapshot chunk, §6.3). */
  binary: Uint8Array;
  /** The relay did not answer a `ping` in time (§9.1); the socket has been closed. */
  dead: undefined;
}

export type OutboundMessage = Record<string, unknown> & { type: string };

export interface Connection {
  readonly state: ConnectionState;
  /** Opens the socket and sends `viewer.join` as the very first frame. */
  connect(credentials: JoinCredentials): void;
  /** Sends a JSON message; `false` when the socket is not open. Adds `protocolVersion`, `id` and `ts`. */
  send(message: OutboundMessage): boolean;
  /** Next message id for callers that build their own messages (`v-<n>`). */
  nextId(): string;
  /** Sends `viewer.leave` and closes with `1000` (page unload, user leaves); the state becomes `idle`. */
  leave(): void;
  on<K extends keyof ConnectionEvents>(
    event: K,
    handler: (payload: ConnectionEvents[K]) => void,
  ): () => void;
  /** Subscribes to one message type; the payload is the generated interface of that type. */
  onMessage<T extends MessageType>(
    type: T,
    handler: (message: MessageOfType<T>) => void,
  ): () => void;
}

const OPEN = 1;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for `localhost`, `*.localhost` and loopback addresses — the only hosts where plain `ws://` is allowed (T5). */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

/** `wss://<host>/ws`, or `ws://` on a loopback host in development; `null` when the page is neither (T5). */
export function relayUrl(loc: Pick<Location, "protocol" | "host" | "hostname">): string | null {
  const secure = loc.protocol === "https:";
  if (!secure && !isLocalHost(loc.hostname)) return null;
  return `${secure ? "wss" : "ws"}://${loc.host}/ws`;
}

function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "wss:" || (u.protocol === "ws:" && isLocalHost(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Application-range codes of §9.3 that decide the next step on their own. This table, not `Description.fatal`
 * (WEB-02: only 4000–4004 and 4011), is what the reconnect logic (WEB-14) must key off: 1008 and 1009 are not
 * "fatal" in the catalogue but must not be retried automatically either.
 */
const NEXT_BY_CLOSE_CODE: Readonly<Record<number, ClosedState["kind"]>> = {
  1008: "stopped",
  1009: "stopped",
  4000: "stopped",
  4001: "sessionEnded",
  4002: "sessionEnded",
  4003: "enterCode",
  4004: "enterCode",
  4011: "enterCode",
};
const NEXT_BY_ERROR_CODE: Readonly<Record<string, ClosedState["kind"]>> = {
  INVALID_CODE: "enterCode",
  UNAUTHORIZED: "enterCode",
  SESSION_CLOSED: "sessionEnded",
  UNSUPPORTED_VERSION: "stopped",
};
/** Close codes that say nothing by themselves (no frame, abnormal, normal, internal): the last `error` may. */
const GENERIC_CLOSE_CODES = new Set([1000, 1001, 1005, 1006, 1011]);

interface LastError {
  readonly code: string;
  readonly retryAfterS?: number;
}

const defaultLog: LogFn = (message, fields) => console.warn(`[viewer] ${message}`, fields ?? "");

export function createConnection(options: ConnectionOptions = {}): Connection {
  const lang = options.lang ?? detectLang();
  const log = options.log ?? defaultLog;
  const parse = options.parse ?? parseInbound;
  const heartbeatMs = options.heartbeatIntervalMs ?? LIMITS.HEARTBEAT_INTERVAL_S * 1000;
  const pongTimeoutMs = options.pongTimeoutMs ?? LIMITS.HEARTBEAT_TIMEOUT_S * 1000;
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let state: ConnectionState = { kind: "idle" };
  let socket: SocketLike | null = null;
  let counter = 0;
  let lastError: LastError | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let outstandingPing: string | undefined;

  const stateHandlers = new Set<(s: ConnectionState) => void>();
  const binaryHandlers = new Set<(b: Uint8Array) => void>();
  const deadHandlers = new Set<(u: undefined) => void>();
  const messageHandlers = new Map<MessageType, Set<(m: Message) => void>>();

  const nextId = (): string => `v-${++counter}`;

  function setState(next: ConnectionState): void {
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  }

  function stopHeartbeat(): void {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = pongTimer = undefined;
    outstandingPing = undefined;
  }

  function detach(s: SocketLike): void {
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
  }

  function sendNow(s: SocketLike, message: OutboundMessage): boolean {
    if (s.readyState !== OPEN) return false;
    s.send(
      JSON.stringify({
        protocolVersion: "1.0",
        ...message,
        id: typeof message["id"] === "string" ? message["id"] : nextId(),
        ts: Date.now(),
      }),
    );
    return true;
  }

  function startHeartbeat(s: SocketLike): void {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (s !== socket) return;
      const id = `hb-${++counter}`;
      outstandingPing = id;
      sendNow(s, { type: "ping", id });
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => onDead(s), pongTimeoutMs);
    }, heartbeatMs);
  }

  function onDead(s: SocketLike): void {
    if (s !== socket) return;
    stopHeartbeat();
    detach(s);
    socket = null;
    try {
      // Only 1000 and 3000–4999 are legal client close codes; the relay treats 1000 as a normal close.
      s.close(1000, "heartbeat timeout");
    } catch {
      /* already gone */
    }
    log("heartbeat timeout, closing socket");
    setState({
      kind: "disconnected",
      description: describe(4009, lang),
      closeCode: 4009,
      immediate: false,
      dead: true,
    });
    for (const handler of [...deadHandlers]) handler(undefined);
  }

  /** Any frame after a `ping` proves the link is alive; a pong queued behind a 30 MiB stream must not kill it. */
  function noteTraffic(): void {
    if (outstandingPing !== undefined) {
      clearTimeout(pongTimer);
      pongTimer = undefined;
      outstandingPing = undefined;
    }
  }

  function closedState(code: number): ClosedState {
    const err = lastError;
    let kind: ClosedState["kind"] | undefined = NEXT_BY_CLOSE_CODE[code];
    let description: Description;
    if (kind) {
      description = describe(code, lang);
    } else if (
      GENERIC_CLOSE_CODES.has(code) &&
      err &&
      Object.hasOwn(NEXT_BY_ERROR_CODE, err.code)
    ) {
      // The relay's `error` was the real reason; the socket just dropped without an application close code.
      kind = NEXT_BY_ERROR_CODE[err.code];
      description = describe(err.code, lang);
    } else {
      description = describe(code === 1005 || code === 1006 ? 1001 : code, lang);
    }
    const closed = {
      description,
      closeCode: code,
      ...(err?.retryAfterS !== undefined ? { retryAfterS: err.retryAfterS } : {}),
    };
    return kind && kind !== "disconnected"
      ? { kind, ...closed }
      : { kind: "disconnected", ...closed, immediate: code === 4008, dead: false };
  }

  function handleText(text: string): void {
    const parsed = parse(text);
    if (!parsed.ok) {
      log(
        parsed.reason === "unknownType"
          ? "ignored message of unknown type"
          : `ignored ${parsed.reason} message`,
        parsed.type ? { type: parsed.type } : undefined,
      );
      return;
    }
    const message = parsed.message;
    if (message.type === "error") {
      const retryAfterS = (message.details as Record<string, unknown> | undefined)?.["retryAfterS"];
      lastError = {
        code: message.code,
        ...(typeof retryAfterS === "number" ? { retryAfterS } : {}),
      };
    }
    if (message.type === "viewer.joined") {
      lastError = undefined; // only errors of the join phase may colour a later bare drop
      if (state.kind === "connecting") setState({ kind: "connected" });
    }
    for (const handler of [...(messageHandlers.get(message.type) ?? [])]) handler(message);
  }

  function handleFrame(data: unknown): void {
    noteTraffic();
    if (typeof data === "string") return handleText(data);
    if (data instanceof ArrayBuffer) {
      for (const handler of [...binaryHandlers]) handler(new Uint8Array(data));
      return;
    }
    log("ignored frame of unsupported kind", { kind: printableType(typeof data) ?? "?" });
  }

  function connect(credentials: JoinCredentials): void {
    if (socket) {
      detach(socket);
      socket.close(1000);
      socket = null;
    }
    stopHeartbeat();
    lastError = undefined;
    const loc = options.location ?? (typeof location === "undefined" ? undefined : location);
    const url = options.url ?? (loc ? relayUrl(loc) : null);
    if (!url || !allowedUrl(url)) {
      setState({
        kind: "stopped",
        description: describe(1008, lang),
        closeCode: 1008,
      });
      log("refusing to connect over an insecure transport");
      return;
    }
    setState({ kind: "connecting" });
    let s: SocketLike;
    try {
      s = createSocket(url);
    } catch {
      setState(closedState(1006));
      return;
    }
    socket = s;
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      if (s !== socket) return;
      sendNow(s, {
        type: "viewer.join",
        id: nextId(),
        ...credentials,
        clientInfo: {
          app: "web-viewer",
          version: APP_VERSION,
          platform: options.clientInfo?.platform ?? "web",
          profile: options.clientInfo?.profile ?? "mobile",
          capabilities: {
            httpScene: true,
            maxSnapshotBytes: options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
          },
        },
      });
      startHeartbeat(s);
    };
    s.onmessage = (event) => {
      if (s === socket) handleFrame(event.data);
    };
    s.onerror = () => {
      /* the close event that follows carries the code */
    };
    s.onclose = (event) => {
      if (s !== socket) return;
      stopHeartbeat();
      detach(s);
      socket = null;
      setState(closedState(event.code));
    };
  }

  return {
    get state() {
      return state;
    },
    connect,
    send: (message) => (socket ? sendNow(socket, message) : false),
    nextId,
    leave() {
      const s = socket;
      if (!s) return;
      sendNow(s, { type: "viewer.leave" });
      stopHeartbeat();
      detach(s);
      socket = null;
      s.close(1000);
      setState({ kind: "idle" });
    },
    on(event, handler) {
      const set = (
        event === "state" ? stateHandlers : event === "binary" ? binaryHandlers : deadHandlers
      ) as Set<typeof handler>;
      set.add(handler);
      return () => void set.delete(handler);
    },
    onMessage(type, handler) {
      let set = messageHandlers.get(type);
      if (!set) messageHandlers.set(type, (set = new Set()));
      const h = handler as (m: Message) => void;
      set.add(h);
      return () => void set.delete(h);
    },
  };
}
