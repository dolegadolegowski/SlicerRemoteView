// QA-07 log-grep rules as pure functions: `grepLog()` scans a log (or any captured text) for forbidden content and
// returns findings that name only the rule and the 1-based line number — never the matched value — so a failure
// message can be printed in CI without leaking the secret it found (NFR-12, CLAUDE.md rule 6).
//
// Two rule sets:
// - secret rules (need the harness memory): session codes, publisher/viewer tokens, node names and node ids from
//   the GLB JSON chunk, the raw client addresses a spec used, byte forms of the GLB;
// - secret-independent rules (also for a CI artefact passed as `LOG_FILE`, QA-07 acceptance 3): every non-empty
//   line is one JSON object with string `level` and `message` (relay-server/src/logger.ts: pino with
//   `messageKey: "message"` and the level as its label), no IP literal, no glTF magic, no token-shaped string
//   (`pt_`/`vt_` + base64url, relay-server/src/codes.ts `newToken`), no `Bearer` credential, no code-shaped value
//   in a field (a string that is exactly a §4.2 code, or a `code`/`preferredCode` field that was not redacted).

import { isIP } from "node:net";

export type FindingKind =
  | "session-code"
  | "publisher-token"
  | "viewer-token"
  | "node-name"
  | "node-id"
  | "client-ip"
  | "glb-bytes"
  | "not-json"
  | "missing-level"
  | "missing-message"
  | "ip-literal"
  | "glb-magic"
  | "token-shaped"
  | "bearer-credential"
  | "code-shaped";

/** One forbidden occurrence. Deliberately holds no part of the matched text. */
export interface Finding {
  readonly kind: FindingKind;
  /** 1-based line number in the scanned text. */
  readonly line: number;
}

/** Values known from the harness memory; each one is forbidden wherever it appears. */
export interface Secrets {
  codes?: readonly string[];
  publisherTokens?: readonly string[];
  viewerTokens?: readonly string[];
  nodeNames?: readonly string[];
  nodeIds?: readonly string[];
  /** Raw client addresses the spec used (`127.0.0.1`, the `X-Forwarded-For` values, …). */
  clientIps?: readonly string[];
  /** Encodings of the GLB bytes (`glbByteForms()`). */
  glbForms?: readonly string[];
}

export interface GrepOptions {
  secrets?: Secrets;
  /** Require every non-empty line to be a JSON object with `level` and `message` (the relay log). Default true. */
  json?: boolean;
  /** Apply the secret-independent pattern rules (IP literals, glTF magic, token/code shapes). Default true. */
  patterns?: boolean;
}

/** pino's level labels (pino `levels.labels`); the relay formats `level` as the label. */
export const LOG_LEVELS: ReadonlySet<string> = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/** §4.2 code: 5 symbols of `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. */
export const CODE_PATTERN = /^[2-9A-HJKMNP-Z]{5}$/;
/** `pt_`/`vt_` + base64url; the relay issues 43 symbols (256 bits), anything ≥ 16 looks like a credential. */
const TOKEN_SHAPED = /(?<![A-Za-z0-9_-])(?:pt|vt)_[A-Za-z0-9_-]{16,}/;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
/** `glTF` and its aligned base64 / hex forms (the GLB header magic, glTF 2.0 §4.4.3). */
const GLB_MAGIC = /glTF|Z2xURg|676c5446/;
/** The redaction censor (relay-server/src/logger.ts). */
const CENSOR = "[redacted]";
/** Fields that legitimately hold short upper-case identifiers (protocol error codes, close reasons). */
const CODE_SAFE_KEYS: ReadonlySet<string> = new Set(["errorCode", "reason", "level", "event", "signal"]);
/** Bind addresses: not a client address (the relay listens on `0.0.0.0`). */
const UNSPECIFIED = new Set(["0.0.0.0", "::"]);

/** IP literals in a line: dotted quads, and IPv6 candidates that contain `::` or seven colons (not `12:30:45`). */
export function ipLiterals(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g))
    if (isIP(match[0]) === 4 && !UNSPECIFIED.has(match[0])) found.push(match[0]);
  for (const match of text.matchAll(/(?<![0-9A-Fa-f:])[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*/g)) {
    const candidate = match[0].replace(/\.+$/, "");
    const colons = candidate.split(":").length - 1;
    if (!candidate.includes("::") && colons < 7) continue;
    if (isIP(candidate) === 6 && !UNSPECIFIED.has(candidate)) found.push(candidate);
  }
  return found;
}

/** Every string value in a parsed JSON value with the key it sits under (array items inherit the key). */
function stringFields(value: unknown, key = ""): [string, string][] {
  if (typeof value === "string") return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((item) => stringFields(item, key));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([k, v]) => stringFields(v, k));
  return [];
}

function codeShaped(record: Record<string, unknown>): boolean {
  for (const [key, value] of stringFields(record)) {
    if ((key === "code" || key === "preferredCode") && value !== CENSOR) return true;
    if (!CODE_SAFE_KEYS.has(key) && CODE_PATTERN.test(value)) return true;
    // A join URL or path that carries a code (`/j#7KQ4X`, `/j/7KQ4X`, `?code=7KQ4X`).
    if (/\/j[#/][2-9A-HJKMNP-Za-hjkmnp-z]{5}\b|[?&]code=[^&\s"]/.test(value)) return true;
  }
  return false;
}

const includesAny = (line: string, values: readonly string[] | undefined): boolean =>
  !!values?.some((value) => value.length > 0 && line.includes(value));

/** Scans `text` line by line; returns one finding per rule and line (ordered by line, then rule). */
export function grepLog(text: string, options: GrepOptions = {}): Finding[] {
  const { secrets = {}, json = true, patterns = true } = options;
  const codes = (secrets.codes ?? []).flatMap((code) => [code, code.toLowerCase()]);
  const findings: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const at = index + 1;
    const flag = (kind: FindingKind) => findings.push({ kind, line: at });
    if (line.trim() === "") return;

    if (includesAny(line, codes)) flag("session-code");
    if (includesAny(line, secrets.publisherTokens)) flag("publisher-token");
    if (includesAny(line, secrets.viewerTokens)) flag("viewer-token");
    if (includesAny(line, secrets.nodeNames)) flag("node-name");
    if (includesAny(line, secrets.nodeIds)) flag("node-id");
    if (includesAny(line, secrets.clientIps)) flag("client-ip");
    if (includesAny(line, secrets.glbForms)) flag("glb-bytes");

    let record: Record<string, unknown> | undefined;
    if (json) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          record = parsed as Record<string, unknown>;
      } catch {
        // not JSON
      }
      if (!record) flag("not-json");
      else {
        if (typeof record["level"] !== "string" || !LOG_LEVELS.has(record["level"])) flag("missing-level");
        if (typeof record["message"] !== "string" || record["message"] === "") flag("missing-message");
      }
    }

    if (patterns) {
      if (ipLiterals(line).length > 0) flag("ip-literal");
      if (GLB_MAGIC.test(line)) flag("glb-magic");
      if (TOKEN_SHAPED.test(line)) flag("token-shaped");
      if (BEARER.test(line)) flag("bearer-credential");
      if (record && codeShaped(record)) flag("code-shaped");
    }
  });
  return findings;
}

/** A failure message for `expect(findings, describeFindings(findings)).toEqual([])`: kinds and line numbers only. */
export function describeFindings(findings: readonly Finding[], source: string): string {
  if (findings.length === 0) return `${source}: clean`;
  const byKind = new Map<FindingKind, number[]>();
  for (const { kind, line } of findings) byKind.set(kind, [...(byKind.get(kind) ?? []), line]);
  const parts = [...byKind].map(([kind, lines]) => {
    const shown = lines.slice(0, 10).join(", ") + (lines.length > 10 ? `, … (${lines.length} lines)` : "");
    return `${kind} at line ${shown}`;
  });
  return `${source}: forbidden content (values withheld): ${parts.join("; ")}`;
}

export interface GlbSecrets {
  /** `name` strings of nodes, meshes, materials and manifest extras (the root node excluded). */
  nodeNames: string[];
  /** `extras.nodeId`, `extras.mrmlId`, `extras.segmentId` of the scene nodes (root `"root"` excluded). */
  nodeIds: string[];
}

interface GltfJson {
  nodes?: { name?: unknown; extras?: Record<string, unknown> }[];
  meshes?: { name?: unknown }[];
  materials?: { name?: unknown }[];
}

/** The scene-content strings of a GLB, read from its JSON chunk (glTF 2.0 §4.4: 12-byte header, chunk 0 = JSON). */
export function glbSecrets(glb: Uint8Array): GlbSecrets {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GltfJson;
  const names = new Set<string>();
  const ids = new Set<string>();
  const addName = (value: unknown) => typeof value === "string" && value.length > 0 && names.add(value);
  for (const node of gltf.nodes ?? []) {
    // The root node (§7.1) is named after the app and has nodeId "root": not scene content.
    if (node.extras?.["kind"] === "root") continue;
    addName(node.name);
    addName(node.extras?.["name"]);
    for (const key of ["nodeId", "mrmlId", "segmentId"]) {
      const id = node.extras?.[key];
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  for (const mesh of gltf.meshes ?? []) addName(mesh.name);
  for (const material of gltf.materials ?? []) addName(material.name);
  return { nodeNames: [...names], nodeIds: [...ids] };
}

/**
 * How bytes of the GLB would look in a log line: the magic, and from every offset 16 bytes as hex, 18 bytes as
 * base64 (every alignment of an encoded buffer) and 12 bytes as a comma list (a serialised Buffer/typed array).
 * `from`/`to` limit the range (default: the whole file).
 */
export function glbByteForms(glb: Uint8Array, from = 0, to = glb.byteLength): string[] {
  const bytes = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  const forms = new Set<string>([bytes.subarray(0, 4).toString("latin1")]);
  for (let offset = from; offset + 12 <= to; offset++) {
    // A run of one repeated byte (zero padding, spaces) is not recognisably scene data: skip it.
    if (bytes.subarray(offset, offset + 12).every((b) => b === bytes[offset])) continue;
    forms.add(Array.from(bytes.subarray(offset, offset + 12)).join(","));
    if (offset + 16 <= to) forms.add(bytes.subarray(offset, offset + 16).toString("hex"));
    if (offset + 18 <= to) forms.add(bytes.subarray(offset, offset + 18).toString("base64"));
  }
  return [...forms];
}

/** Offset of the BIN chunk's data (after the JSON chunk and the BIN chunk header). */
export function glbBinOffset(glb: Uint8Array): number {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return 20 + view.getUint32(12, true) + 8;
}
