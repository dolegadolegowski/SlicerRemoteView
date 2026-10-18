/**
 * Protocol constants of `docs/protocol.md` v1.0: error codes (§9.2), WebSocket close codes
 * (§9.3) and limits (§3.3). Pure data, safe in Node and browsers.
 */

/** The 15 `error.code` values of §9.2 (same order as the table and as `defs.schema.json#/definitions/errorCode`). */
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

/** Generated from `defs.schema.json#/definitions/errorCode`; `test/generated.test.ts` checks it equals `ERROR_CODES`. */
export type { ErrorCode } from "./generated/messages.js";

/**
 * WebSocket close codes of §9.3. Standard codes (1000–1011) carry their RFC 6455 names; the
 * application range `4000–4012` is named after the §9.3 meaning.
 */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  UNSUPPORTED_VERSION: 4000,
  SESSION_CLOSED: 4001,
  SESSION_EXPIRED: 4002,
  UNAUTHORIZED: 4003,
  INVALID_CODE: 4004,
  SESSION_FULL: 4005,
  RATE_LIMITED: 4006,
  PROTOCOL_VIOLATION: 4007,
  RELAY_RESTARTING: 4008,
  HEARTBEAT_TIMEOUT: 4009,
  SLOW_CONSUMER: 4010,
  REPLACED: 4011,
  HANDSHAKE_TIMEOUT: 4012,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/**
 * Protocol limits of §3.3 — the maximums; a relay MAY run with lower configured values and
 * announces the effective ones in `session.created.limits` (§14). Byte values are exact,
 * durations are seconds (`_S`).
 */
export const LIMITS = {
  /** Max text message from a publisher: 256 KiB (`1009` if exceeded). */
  MAX_TEXT_BYTES_PUBLISHER: 262_144,
  /** Max text message from a viewer: 16 KiB. */
  MAX_TEXT_BYTES_VIEWER: 16_384,
  /** Max binary chunk payload (the recommended `chunkSize`): 1 MiB, plus the 12-byte header. */
  MAX_CHUNK_BYTES: 1_048_576,
  /** Smallest `chunkSize` a publisher may announce: 64 KiB (§6.2). */
  MIN_CHUNK_BYTES: 65_536,
  /** `ws` `maxPayload`, server-wide: 1 MiB + 64 KiB. */
  WS_MAX_PAYLOAD_BYTES: 1_114_112,
  /** Hard cap on one snapshot: 64 MiB. */
  MAX_SNAPSHOT_BYTES: 67_108_864,
  /** Recommended snapshot size for the `mobile` profile: 32 MiB. */
  RECOMMENDED_SNAPSHOT_BYTES_MOBILE: 33_554_432,
  /** Max chunks per snapshot. */
  MAX_CHUNK_COUNT: 1_024,
  /** Chunk inter-arrival timeout before the relay aborts the snapshot. */
  CHUNK_TIMEOUT_S: 120,
  /** Default global snapshot budget (cached + in-flight, all sessions): 512 MiB. */
  MAX_TOTAL_SNAPSHOT_BYTES_DEFAULT: 536_870_912,
  /** Default max live sessions. */
  MAX_SESSIONS_DEFAULT: 100,
  /** Max viewers per session. */
  MAX_VIEWERS: 20,
  /** Max `changes` per `scene.update`. */
  MAX_CHANGES: 1_000,
  /** Max `nodeId` length (chars). */
  MAX_NODE_ID_LENGTH: 128,
  /** Max node `name` length in GLB extras after sanitisation (chars). */
  MAX_NODE_NAME_LENGTH: 64,
  /** Client application `ping` interval (§9.1). */
  HEARTBEAT_INTERVAL_S: 15,
  /** `pong` expected within this many seconds of a `ping` (§9.1). */
  HEARTBEAT_TIMEOUT_S: 10,
  /** Relay WebSocket-level ping interval; a socket is terminated if no pong by the next tick. */
  RELAY_PING_INTERVAL_S: 30,
  /** Publisher grace after a disconnect (`PUBLISHER_GRACE_S`). */
  PUBLISHER_GRACE_S: 120,
  /** Idle TTL without viewers (`SESSION_TTL_S`). */
  SESSION_TTL_S: 1_800,
  /** Max session lifetime (`SESSION_MAX_LIFETIME_S`): 12 h. */
  SESSION_MAX_LIFETIME_S: 43_200,
  /** First message must arrive within this many seconds of the upgrade (`4012`). */
  HANDSHAKE_TIMEOUT_S: 10,
  /** Viewer slow-consumer soft watermark: stop forwarding live chunks (4 MiB). */
  SLOW_CONSUMER_SOFT_BYTES: 4_194_304,
  /** Viewer slow-consumer hard watermark: close `4010` (8 MiB). */
  SLOW_CONSUMER_HARD_BYTES: 8_388_608,
  /** A viewer stuck above the soft watermark for this long is closed `4010`. */
  SLOW_CONSUMER_STUCK_S: 60,
  /** Max `id` / `replyTo` length (§3.2). */
  MAX_MESSAGE_ID_LENGTH: 32,
} as const;
