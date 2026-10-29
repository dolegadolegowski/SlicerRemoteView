/**
 * One text frame, parsed exactly once (docs/protocol.md §2, §3.2).
 *
 * The endpoint needs a first frame's `type` before the role is known (its size limit, §3.3); the
 * dispatcher needs the validated message and, when validation fails, the `type` and `id` the frame
 * carried (role gate, `replyTo`). `JSON.parse` is most of what an adversarial frame costs (about
 * 10–20 ms for 256 KiB of dense or deeply nested JSON on Node 22, against ≈ 2 ms for a real
 * `scene.update`), so `readFrame` parses once and both use its result.
 *
 * `parseEnvelope` of `@slicerremoteview/shared` only takes text; `checkEnvelope` runs its checks
 * 2–5 on the parsed value with the same results (a test compares both over every shared fixture).
 */
import {
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  toIssues,
  validateMessage,
} from "@slicerremoteview/shared";
import type {
  Message,
  ParseError,
  Result,
  ValidationIssue,
  Validators,
} from "@slicerremoteview/shared";

/** Longest `id` the envelope schema accepts (§3.2); only such an id is echoed in `replyTo`. */
const MAX_ID_LENGTH = 32;
const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

/** Whether `id` is 1–32 code points long, counted like JSON Schema's `maxLength` (Ajv). */
function isWellFormedId(id: string): boolean {
  // A code point is one or two UTF-16 units, so only short strings need counting.
  return id.length > 0 && id.length <= 2 * MAX_ID_LENGTH && [...id].length <= MAX_ID_LENGTH;
}

export interface TextFrame {
  /** The frame as received, e.g. for forwarding without re-serialising it. */
  readonly text: string;
  /** Whether `text` is one JSON document. */
  readonly json: boolean;
  /** The parsed document (`undefined` unless `json`). */
  readonly value: unknown;
  /** `type` of an object frame, whether or not the frame is valid. */
  readonly type?: string;
  /** A well-formed `id` (string, 1–32 characters) of an object frame, for `replyTo`. */
  readonly id?: string;
}

/** Parses a text frame once and peeks its `type` and `id`. Never throws. */
export function readFrame(text: string): TextFrame {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text, json: false, value: undefined };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { text, json: true, value };
  const { type, id } = value as { type?: unknown; id?: unknown };
  return {
    text,
    json: true,
    value,
    ...(typeof type === "string" && { type }),
    ...(typeof id === "string" && isWellFormedId(id) && { id }),
  };
}

const invalid = (message: string, issues: ValidationIssue[]): ParseError => ({
  code: "INVALID_MESSAGE",
  instancePath: issues[0]?.instancePath ?? "",
  message,
  issues,
});

/** `parseEnvelope(frame.text, validators)` without parsing the text again. */
export function checkEnvelope(
  frame: TextFrame,
  validators: Validators,
): Result<Message, ParseError> {
  const { value } = frame;
  if (!frame.json)
    return {
      ok: false,
      error: invalid("text frame is not valid JSON (§3.2)", [
        { instancePath: "", keyword: "json", message: "must be a JSON document" },
      ]),
    };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      ok: false,
      error: invalid("a message is one JSON object (§3.2)", [
        { instancePath: "", keyword: "type", message: "must be object" },
      ]),
    };
  const { protocolVersion } = value as { protocolVersion?: unknown };
  if (typeof protocolVersion === "string") {
    const match = VERSION_PATTERN.exec(protocolVersion);
    if (match && Number(match[1]) !== PROTOCOL_MAJOR)
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_VERSION",
          instancePath: "/protocolVersion",
          message: `protocol major is not ${PROTOCOL_MAJOR}; this receiver speaks ${PROTOCOL_VERSION} (§2)`,
          issues: [],
        },
      };
  }
  if (!validators.envelope(value))
    return {
      ok: false,
      error: invalid("message envelope is invalid (§3.2)", toIssues(validators.envelope.errors)),
    };
  return validateMessage(value, undefined, validators);
}
