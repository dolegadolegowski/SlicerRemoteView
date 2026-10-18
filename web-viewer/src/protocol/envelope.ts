// Inbound text-frame guard for the viewer (docs/protocol.md §2, §3.2, §14). No DOM, no three.js.
//
// Why not `parseEnvelope` from `@slicerremoteview/shared`: it compiles the JSON Schemas with Ajv at runtime
// (`new Function`), which the relay's CSP forbids (`script-src` without `unsafe-eval`, SRV-16, NFR-16) and which
// would add Ajv to the initial bundle. This module is the CSP-friendly default: it checks the envelope and
// the *shape* of each relay → viewer message (required fields and their primitive types). Deep content —
// `changes[]`, `nodes[]`, the GLB — is validated by the code that consumes it. `Connection` takes any other
// `ParseInbound`, so tests (and a future Ajv-standalone build, see docs/plan/web.md follow-ups) can plug in the
// full schema validator; test/protocol/envelope.test.ts runs the shared fixtures through both.

import { PERMISSIONS } from "@slicerremoteview/shared";
import type { Message, MessageType } from "@slicerremoteview/shared";

export type ParseOutcome =
  | { readonly ok: true; readonly message: Message }
  | {
      readonly ok: false;
      /**
       * `unknownType`: a type this build does not know (a newer 1.x relay, or a type that never goes relay → viewer)
       * — ignore and log (§14); `invalid`: malformed JSON/envelope/shape; `unsupportedVersion`: major ≠ 1.
       */
      readonly reason: "invalid" | "unknownType" | "unsupportedVersion";
      /** Printable, length-capped `type` for log lines; never any other part of the payload. */
      readonly type?: string;
    };

export type ParseInbound = (text: string) => ParseOutcome;

const MAJOR = 1;
const VERSION_PATTERN = /^(\d+)\.\d+$/;

type FieldKind = "string" | "int" | "intOrNull" | "bool" | "array" | "object";

/** Required fields of the relay → viewer messages (shared/schema/*.schema.json, `required`). */
const SHAPES: Readonly<Partial<Record<MessageType, Readonly<Record<string, FieldKind>>>>> = {
  "viewer.joined": {
    sessionId: "string",
    viewerId: "string",
    viewerToken: "string",
    sceneVersion: "int",
    snapshotVersion: "intOrNull",
    snapshotAvailable: "bool",
    publisherOnline: "bool",
    viewerCount: "int",
    viewerLimit: "int",
    profile: "string",
  },
  "viewer.count": { viewerCount: "int", viewerLimit: "int", platforms: "object" },
  "session.closed": { sessionId: "string", reason: "string" },
  "session.expired": { sessionId: "string", reason: "string" },
  "session.publisherState": { online: "bool" },
  "scene.snapshot.begin": {
    sceneVersion: "int",
    byteLength: "int",
    sha256: "string",
    chunkCount: "int",
    chunkSize: "int",
    format: "string",
    extensionsUsed: "array",
  },
  "scene.snapshot.end": { sceneVersion: "int", sha256: "string" },
  "scene.snapshot.abort": { sceneVersion: "int", reason: "string" },
  "scene.snapshot.ready": {
    sceneVersion: "int",
    byteLength: "int",
    sha256: "string",
    format: "string",
    extensionsRequired: "array",
  },
  "scene.update": { sceneVersion: "int", baseVersion: "int", changes: "array" },
  "scene.nodeRemoved": { sceneVersion: "int", baseVersion: "int", nodeIds: "array" },
  "scene.nodeAdded": {
    sceneVersion: "int",
    baseVersion: "int",
    nodes: "array",
    snapshotFollows: "bool",
  },
  "scene.state": {
    sceneVersion: "int",
    snapshotVersion: "intOrNull",
    nodes: "array",
    removed: "array",
  },
  error: { code: "string", message: "string" },
  pong: {},
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function matches(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "int":
      return isUint(v);
    case "intOrNull":
      return v === null || isUint(v);
    case "bool":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
  }
}

/** A `type` safe to put into a log line: printable ASCII only, at most 64 characters. */
export function printableType(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  return type.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
}

const isKnownType = (type: string): type is MessageType =>
  Object.prototype.hasOwnProperty.call(PERMISSIONS, type);

/**
 * Parses one text frame received from the relay. Unknown fields are tolerated and kept (§14); a type that is
 * unknown in 1.x, or that the permissions matrix (§11) does not allow relay → viewer, is `unknownType`.
 */
export const parseInbound: ParseInbound = (text) => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isObject(data)) return { ok: false, reason: "invalid" };
  const type = printableType(data["type"]);
  const version = typeof data["protocolVersion"] === "string" ? data["protocolVersion"] : "";
  const major = VERSION_PATTERN.exec(version);
  if (!major) return { ok: false, reason: "invalid", ...(type ? { type } : {}) };
  if (Number(major[1]) !== MAJOR)
    return { ok: false, reason: "unsupportedVersion", ...(type ? { type } : {}) };
  if (typeof data["type"] !== "string") return { ok: false, reason: "invalid" };
  for (const field of ["id", "replyTo"] as const) {
    const value = data[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 32))
      return { ok: false, reason: "invalid", ...(type ? { type } : {}) };
  }
  const messageType = data["type"];
  if (!isKnownType(messageType) || !PERMISSIONS[messageType].relayToViewer)
    return { ok: false, reason: "unknownType", ...(type ? { type } : {}) };
  const shape = SHAPES[messageType] ?? {};
  for (const [field, kind] of Object.entries(shape))
    if (!matches(kind, data[field])) return { ok: false, reason: "invalid", type: messageType };
  return { ok: true, message: data as unknown as Message };
};
