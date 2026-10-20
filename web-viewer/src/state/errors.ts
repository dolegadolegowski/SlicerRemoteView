// Catalogue of everything the viewer tells the user when something is not normal (FR-44, NFR-31).
// `describe()` maps a protocol `error.code` (docs/protocol.md §9.2) or a WebSocket close code (§9.3) to a
// localised title/body plus ONE next action; `describeState()` does the same for UI-only states.
// No protocol code ever reaches the user text.

import { detectLang, t } from "../i18n/strings";
import type { Lang, StringKey } from "../i18n/strings";

export type Action = "retry" | "enterCode" | "askPresenter" | "none";

export interface Description {
  readonly title: string;
  readonly body: string;
  /** The single next step offered to the user. */
  readonly action: Action;
  /** Localised label of `action`, `""` for `none`. */
  readonly actionLabel: string;
  /** True when the client must stop reconnecting automatically (architecture §7 "stop on"). */
  readonly fatal: boolean;
}

/** `error.code` values of §9.2. */
export const ERROR_CODES = [
  "INVALID_CODE",
  "SESSION_NOT_FOUND",
  "SESSION_FULL",
  "SESSION_CLOSED",
  "RATE_LIMITED",
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_TYPE",
  "INVALID_MESSAGE",
  "PAYLOAD_TOO_LARGE",
  "BAD_SEQUENCE",
  "CHECKSUM_MISMATCH",
  "UNAUTHORIZED",
  "SLOW_CONSUMER",
  "CAPACITY",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** WebSocket close codes of §9.3. */
export const CLOSE_CODES = [
  1000, 1001, 1008, 1009, 1011, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010,
  4011, 4012,
] as const;
export type CloseCode = (typeof CLOSE_CODES)[number];

interface Entry {
  /** Prefix of the `message.<id>.title|body` string keys. */
  readonly id: string;
  readonly action: Action;
  readonly fatal: boolean;
}

const entry = (id: string, action: Action, fatal = false): Entry => ({ id, action, fatal });

const INVALID_CODE = entry("invalidCode", "enterCode", true);
const SESSION_ENDED = entry("sessionEnded", "enterCode", true);
const UPDATE_REQUIRED = entry("updateRequired", "none", true);
const UNAUTHORIZED = entry("unauthorized", "enterCode", true);
const SESSION_FULL = entry("sessionFull", "retry");
const RATE_LIMITED = entry("rateLimited", "retry");
const INVALID_MESSAGE = entry("invalidMessage", "retry");
const INTERNAL = entry("internal", "retry");
const UNKNOWN = entry("unknown", "retry");

const BY_ERROR_CODE: Readonly<Record<ErrorCode, Entry>> = {
  INVALID_CODE,
  // The socket stays open 10 s so the client can fall back to joining by code (§9.2); not fatal.
  SESSION_NOT_FOUND: entry("sessionNotFound", "enterCode"),
  SESSION_FULL,
  SESSION_CLOSED: SESSION_ENDED,
  RATE_LIMITED,
  UNSUPPORTED_VERSION: UPDATE_REQUIRED,
  UNSUPPORTED_TYPE: entry("unexpected", "none"),
  INVALID_MESSAGE,
  PAYLOAD_TOO_LARGE: entry("payloadTooLarge", "askPresenter"),
  BAD_SEQUENCE: entry("badSequence", "none"),
  CHECKSUM_MISMATCH: entry("checksumMismatch", "retry"),
  UNAUTHORIZED,
  SLOW_CONSUMER: entry("slowConsumer", "retry"),
  CAPACITY: entry("capacity", "retry"),
  INTERNAL,
};

// `fatal` is true for exactly 4000, 4001, 4002, 4003, 4004 and 4011 (architecture §7).
const BY_CLOSE_CODE: Readonly<Record<CloseCode, Entry>> = {
  1000: entry("normalClose", "retry"),
  1001: entry("connectionLost", "retry"),
  1008: entry("refused", "none"),
  1009: entry("payloadTooLarge", "askPresenter"),
  1011: INTERNAL,
  4000: UPDATE_REQUIRED,
  4001: SESSION_ENDED,
  4002: SESSION_ENDED,
  4003: UNAUTHORIZED,
  4004: INVALID_CODE,
  4005: SESSION_FULL,
  4006: RATE_LIMITED,
  4007: INVALID_MESSAGE,
  4008: entry("relayRestarting", "none"),
  4009: entry("heartbeatTimeout", "retry"),
  4010: entry("slowConsumer", "retry"),
  4011: entry("replaced", "enterCode", true),
  4012: entry("handshakeTimeout", "retry"),
};

function render(
  e: Entry,
  prefix: "message" | "state",
  lang: Lang,
  params?: Record<string, number>,
): Description {
  const key = (part: "title" | "body") => `${prefix}.${e.id}.${part}` as StringKey;
  return {
    title: t(lang, key("title")),
    body: t(lang, key("body"), params),
    action: e.action,
    actionLabel: e.action === "none" ? "" : t(lang, `action.${e.action}`),
    fatal: e.fatal,
  };
}

const isKnownCloseCode = (code: number): code is CloseCode =>
  Object.prototype.hasOwnProperty.call(BY_CLOSE_CODE, code);
const isKnownErrorCode = (code: string): code is ErrorCode =>
  Object.prototype.hasOwnProperty.call(BY_ERROR_CODE, code);

/**
 * User-facing description of an `error.code` (string) or a close code (number). Unknown values — a newer relay
 * may add codes (§14) — get a generic, retryable message instead of throwing.
 */
export function describe(
  code: ErrorCode | CloseCode | string | number,
  lang: Lang = detectLang(),
): Description {
  const known =
    typeof code === "number"
      ? isKnownCloseCode(code) && BY_CLOSE_CODE[code]
      : isKnownErrorCode(code) && BY_ERROR_CODE[code];
  return render(known || UNKNOWN, "message", lang);
}

/** UI-only application states that are not protocol errors. */
export type AppState =
  | { readonly kind: "connecting" }
  | { readonly kind: "waitingForScene" }
  | { readonly kind: "downloading"; readonly progress: number }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "presenterOffline" }
  | { readonly kind: "sessionEnded" }
  | { readonly kind: "webgl2Unavailable" }
  | { readonly kind: "snapshotTooLarge" }
  | { readonly kind: "snapshotInvalid" }
  | { readonly kind: "snapshotFailed" }
  | { readonly kind: "snapshotUpdateFailed" }
  | { readonly kind: "linkInvalid" };

const STATE_ENTRIES: Readonly<Record<AppState["kind"], Entry>> = {
  connecting: entry("connecting", "none"),
  waitingForScene: entry("waitingForScene", "none"),
  downloading: entry("downloading", "none"),
  reconnecting: entry("reconnecting", "none"),
  presenterOffline: entry("presenterOffline", "none"),
  sessionEnded: entry("sessionEnded", "enterCode", true),
  webgl2Unavailable: entry("webgl2Unavailable", "none", true),
  snapshotTooLarge: entry("snapshotTooLarge", "askPresenter"),
  snapshotInvalid: entry("snapshotInvalid", "askPresenter"),
  snapshotFailed: entry("snapshotFailed", "retry"),
  snapshotUpdateFailed: entry("snapshotUpdateFailed", "askPresenter"),
  linkInvalid: entry("linkInvalid", "enterCode"),
};

export function describeState(state: AppState, lang: Lang = detectLang()): Description {
  const percent =
    state.kind === "downloading" ? Math.round(Math.min(1, Math.max(0, state.progress)) * 100) : 0;
  return render(STATE_ENTRIES[state.kind], "state", lang, { percent });
}
