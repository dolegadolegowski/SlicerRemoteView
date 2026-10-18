/**
 * Message validation against the protocol schemas (`docs/protocol.md` §2, §3.2, §14).
 *
 * `compileSchemas()` builds one Ajv validator per message type from the schemas embedded in
 * `ts/generated/schemas.ts` (no file system: runs in the relay, fake-slicer and browsers).
 * `parseEnvelope()` is the receiver's entry point for a text frame: it maps every failure to the
 * §9.2 error code the receiver must answer with (`INVALID_MESSAGE`, `UNSUPPORTED_TYPE`,
 * `UNSUPPORTED_VERSION`) and never returns the offending values in its error (only JSON Pointers
 * and Ajv's data-free messages), so the result is safe to log or echo in `error.details`.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { AnyMessage } from "./generated/messages.js";
import { SCHEMA_FILES } from "./generated/schemas.js";
import { isMessageType, MESSAGE_TYPES } from "./permissions.js";
import type { MessageType } from "./permissions.js";

/** Protocol version every envelope carries (§2). */
export const PROTOCOL_VERSION = "1.0" as const;
/** The major version this library implements; other majors → `UNSUPPORTED_VERSION` (§2). */
export const PROTOCOL_MAJOR = 1;

export const SCHEMA_BASE = "https://slicerremoteview.dev/schema/";

/**
 * A parsed message: the discriminated union of the generated per-type interfaces
 * (`generated/messages.ts`, PRO-11); narrow it by `type` or with {@link MessageOfType}.
 */
export type Message = AnyMessage;

/** The generated interface of one message type, e.g. `MessageOfType<"scene.update">` = `SceneUpdate`. */
export type MessageOfType<T extends MessageType> = Extract<AnyMessage, { type: T }>;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** One schema violation, in Ajv's vocabulary but without the offending data. */
export interface ValidationIssue {
  /** JSON Pointer of the offending value; `""` for the root (e.g. a missing required property). */
  instancePath: string;
  /** Schema keyword that failed (`required`, `pattern`, `const`, `oneOf`, …). */
  keyword: string;
  /** Ajv's message, e.g. `must have required property 'code'` — never contains the data value. */
  message: string;
}

export interface ParseError {
  code: "INVALID_MESSAGE" | "UNSUPPORTED_TYPE" | "UNSUPPORTED_VERSION";
  /** Points at the field that failed; `/type` or `/protocolVersion` for the two unsupported cases. */
  instancePath: string;
  /** Developer-facing English (§9.2 `message`). */
  message: string;
  /** Every violation Ajv reported (one unless the validators were compiled with `allErrors`). */
  issues: ValidationIssue[];
}

export interface CompileOptions {
  /**
   * Report every violation instead of stopping at the first (slower; the relay keeps the default
   * `false` for untrusted input, tests use `true`).
   */
  allErrors?: boolean;
  /**
   * §14 leniency for *inbound relay messages on clients*: closed enums that minor versions may
   * extend (`errorCode`, every `*Reason`) accept any string, so a `1.1` relay's new
   * error code or reason does not make a `1.0` viewer reject the message. The relay validates
   * client messages with the strict default.
   */
  tolerateUnknownEnums?: boolean;
}

export interface Validators {
  /** Validates the envelope only (`protocolVersion`, `type`, `id`, `replyTo`, `ts`). */
  envelope: ValidateFunction;
  /** One validator per message type. */
  byType: ReadonlyMap<MessageType, ValidateFunction>;
  /** The options the set was compiled with. */
  options: Readonly<Required<CompileOptions>>;
}

/**
 * Definitions in `defs.schema.json` whose `enum` is opened under `tolerateUnknownEnums` (§14):
 * `errorCode` and every `*Reason`. `platform` needs no entry: `clientInfo.platform` is already a
 * plain string in the schema (the `platform` definition is documentation only).
 */
export const LENIENT_ENUM_DEFINITIONS: readonly string[] = [
  "errorCode",
  ...Object.keys((SCHEMA_FILES["defs.schema.json"] as { definitions: object }).definitions).filter(
    (name) => name.endsWith("Reason"),
  ),
];

function lenientDefs(defs: Record<string, unknown>): Record<string, unknown> {
  const definitions = { ...(defs.definitions as Record<string, Record<string, unknown>>) };
  for (const name of LENIENT_ENUM_DEFINITIONS) {
    const def = definitions[name];
    if (!def || !("enum" in def)) continue;
    const open = Object.fromEntries(Object.entries(def).filter(([k]) => k !== "enum"));
    definitions[name] = { ...open, type: "string", minLength: 1, maxLength: 64 };
  }
  return { ...defs, definitions };
}

/**
 * Compiles every protocol schema once (Ajv 2020-12, `strict`, `allowUnionTypes`) and returns one
 * validator per message type. Call it once per process and share the result.
 */
export function compileSchemas(options: CompileOptions = {}): Validators {
  const resolved = {
    allErrors: options.allErrors ?? false,
    tolerateUnknownEnums: options.tolerateUnknownEnums ?? false,
  };
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: resolved.allErrors });
  for (const [file, schema] of Object.entries(SCHEMA_FILES)) {
    ajv.addSchema(
      file === "defs.schema.json" && resolved.tolerateUnknownEnums ? lenientDefs(schema) : schema,
    );
  }
  const get = (file: string): ValidateFunction => {
    const fn = ajv.getSchema(SCHEMA_BASE + file);
    if (!fn) throw new Error(`schema not registered: ${file}`);
    return fn;
  };
  const byType = new Map<MessageType, ValidateFunction>();
  for (const type of MESSAGE_TYPES) byType.set(type, get(`${type}.schema.json`));
  return { envelope: get("envelope.schema.json"), byType, options: resolved };
}

let defaultValidators: Validators | undefined;

/** Lazily compiled strict validators shared by `parseEnvelope` / `validateMessage` callers that pass none. */
export function defaultSchemas(): Validators {
  return (defaultValidators ??= compileSchemas());
}

export function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    instancePath: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? e.keyword,
  }));
}

const invalid = (message: string, issues: ValidationIssue[], instancePath = ""): ParseError => ({
  code: "INVALID_MESSAGE",
  instancePath: issues[0]?.instancePath ?? instancePath,
  message,
  issues,
});

/**
 * Validates an already-parsed object against the schema of `type` (default: its own `type`
 * field). Used by conformance tests and by the relay for messages it builds itself.
 */
export function validateMessage(
  message: unknown,
  type?: string,
  validators: Validators = defaultSchemas(),
): Result<Message, ParseError> {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return {
      ok: false,
      error: invalid("a message is one JSON object (§3.2)", [
        { instancePath: "", keyword: "type", message: "must be object" },
      ]),
    };
  const target = type ?? (message as { type?: unknown }).type;
  if (typeof target !== "string" || !isMessageType(target))
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_TYPE",
        instancePath: "/type",
        message: "unknown message type for protocol 1.x (§2)",
        issues: [],
      },
    };
  const validate = validators.byType.get(target)!;
  if (!validate(message))
    return {
      ok: false,
      error: invalid(`message does not match the ${target} schema`, toIssues(validate.errors)),
    };
  return { ok: true, value: message as AnyMessage };
}

const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

/**
 * Receiver entry point for one text frame (§3.2). Order of checks, each mapped to the §9.2 code
 * the receiver answers with:
 * 1. not JSON / not an object → `INVALID_MESSAGE`;
 * 2. `protocolVersion` present and `MAJOR.MINOR` but major ≠ 1 → `UNSUPPORTED_VERSION` (§2:
 *    the relay also closes `4000` on a first message);
 * 3. envelope shape (`protocolVersion`, `type`, `id`, `replyTo`, `ts`) → `INVALID_MESSAGE`;
 * 4. `type` unknown in 1.x → `UNSUPPORTED_TYPE` (reply `error`, do not close);
 * 5. the type's schema → `INVALID_MESSAGE` with the JSON Pointer of the first violation.
 */
export function parseEnvelope(
  text: string,
  validators: Validators = defaultSchemas(),
): Result<Message, ParseError> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: invalid("text frame is not valid JSON (§3.2)", [
        { instancePath: "", keyword: "json", message: "must be a JSON document" },
      ]),
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return {
      ok: false,
      error: invalid("a message is one JSON object (§3.2)", [
        { instancePath: "", keyword: "type", message: "must be object" },
      ]),
    };
  const { protocolVersion } = data as { protocolVersion?: unknown };
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
  if (!validators.envelope(data))
    return {
      ok: false,
      error: invalid("message envelope is invalid (§3.2)", toIssues(validators.envelope.errors)),
    };
  return validateMessage(data, undefined, validators);
}
