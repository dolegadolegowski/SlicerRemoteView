import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BINARY_FRAME_PERMISSION,
  CLOSE_CODES,
  compileSchemas,
  ERROR_CODES,
  isAllowed,
  isBinaryAllowed,
  LENIENT_ENUM_DEFINITIONS,
  LIMITS,
  MAX_CHUNK_COUNT,
  MAX_CHUNK_SIZE,
  MAX_SNAPSHOT_BYTES,
  MESSAGE_TYPES,
  MIN_CHUNK_SIZE,
  parseEnvelope,
  PERMISSIONS,
  PROTOCOL_VERSION,
  RESERVED_TYPES,
  validateMessage,
} from "../ts/index.js";
import type { MessageType, Role } from "../ts/index.js";
import { FIXTURES_DIR, loadFixtures, loadSchemas, PROTOCOL_DOC, readJson } from "./helpers.js";

const doc = readFileSync(PROTOCOL_DOC, "utf8");
const section = (from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to));
const strict = compileSchemas({ allErrors: true });
const sets = loadFixtures();
const example = (type: string) =>
  sets.find((s) => s.type === type)!.valid.find((v) => v.file === "valid-example.json")!.message;

describe("TS validation library (PRO-06)", () => {
  it("knows exactly the message types that have a schema and a fixture directory", () => {
    const schemaTypes = [...loadSchemas().keys()]
      .filter((f) => !["envelope.schema.json", "defs.schema.json"].includes(f))
      .map((f) => f.replace(/\.schema\.json$/, ""))
      .sort();
    expect([...MESSAGE_TYPES]).toEqual(schemaTypes);
    expect(sets.map((s) => s.type).sort()).toEqual(schemaTypes);
    expect([...strict.byType.keys()].sort()).toEqual(schemaTypes);
  });

  it("accepts every valid fixture and rejects every invalid one with INVALID_MESSAGE at the expected path", () => {
    for (const set of sets) {
      for (const { file, message } of set.valid) {
        const result = validateMessage(message, set.type, strict);
        expect(result.ok, `${set.type}/${file}: ${JSON.stringify(result)}`).toBe(true);
        const parsed = parseEnvelope(JSON.stringify(message), strict);
        expect(parsed.ok, `${set.type}/${file} via parseEnvelope`).toBe(true);
        if (parsed.ok) expect(parsed.value.type).toBe(set.type);
      }
      for (const { file, fixture } of set.invalid) {
        const result = validateMessage(fixture.message, set.type, strict);
        expect(result.ok, `${set.type}/${file} should be invalid`).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("INVALID_MESSAGE");
        expect(
          result.error.issues.map((i) => i.instancePath),
          `${set.type}/${file}: expected ${fixture.expect.instancePath}`,
        ).toContain(fixture.expect.instancePath);
        const parsed = parseEnvelope(JSON.stringify(fixture.message), strict);
        expect(parsed.ok, `${set.type}/${file} via parseEnvelope`).toBe(false);
        if (parsed.ok) continue;
        // A wrong `type` const is an unknown type and a foreign major is an unsupported
        // version from the receiver's point of view (§2); everything else is INVALID_MESSAGE.
        const major = /^(\d+)\./.exec(
          String((fixture.message as { protocolVersion?: unknown }).protocolVersion),
        );
        expect(parsed.error.code, `${set.type}/${file}`).toBe(
          file === "invalid-type-const.json"
            ? "UNSUPPORTED_TYPE"
            : major && major[1] !== "1"
              ? "UNSUPPORTED_VERSION"
              : "INVALID_MESSAGE",
        );
      }
    }
  });

  it("maps envelope failures to the §9.2 codes: INVALID_MESSAGE, UNSUPPORTED_VERSION, UNSUPPORTED_TYPE", () => {
    const ping = example("ping");
    const fail = (text: string) => {
      const r = parseEnvelope(text, strict);
      expect(r.ok).toBe(false);
      return r.ok ? null! : r.error;
    };
    expect(fail("not json").code).toBe("INVALID_MESSAGE");
    // Default (lazily compiled, strict) validators when none are passed.
    expect(parseEnvelope(JSON.stringify(ping)).ok).toBe(true);
    expect(validateMessage(ping).ok).toBe(true);
    const huge = parseEnvelope(
      JSON.stringify({ ...ping, protocolVersion: `${"9".repeat(200)}.0` }),
    );
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.error.code).toBe("UNSUPPORTED_VERSION");
      expect(huge.error.message).not.toContain("99");
    }
    expect(fail("[1]")).toMatchObject({ code: "INVALID_MESSAGE", instancePath: "" });
    expect(fail("null").code).toBe("INVALID_MESSAGE");
    expect(fail(JSON.stringify({ ...ping, protocolVersion: "2.0" }))).toMatchObject({
      code: "UNSUPPORTED_VERSION",
      instancePath: "/protocolVersion",
    });
    expect(fail(JSON.stringify({ ...ping, protocolVersion: "0.9" })).code).toBe(
      "UNSUPPORTED_VERSION",
    );
    expect(fail(JSON.stringify({ ...ping, protocolVersion: "1" }))).toMatchObject({
      code: "INVALID_MESSAGE",
      instancePath: "/protocolVersion",
    });
    expect(fail(JSON.stringify({ ...ping, protocolVersion: 1 })).code).toBe("INVALID_MESSAGE");
    const noVersion = Object.fromEntries(
      Object.entries(ping).filter(([k]) => k !== "protocolVersion"),
    );
    expect(fail(JSON.stringify(noVersion))).toMatchObject({
      code: "INVALID_MESSAGE",
      instancePath: "",
    });
    expect(fail(JSON.stringify({ ...ping, type: "scene.camera" }))).toMatchObject({
      code: "UNSUPPORTED_TYPE",
      instancePath: "/type",
    });
    expect(fail(JSON.stringify({ ...ping, type: "Ping" })).code).toBe("INVALID_MESSAGE");
    expect(fail(JSON.stringify({ ...ping, id: "x".repeat(33) }))).toMatchObject({
      code: "INVALID_MESSAGE",
      instancePath: "/id",
    });
    // Minor versions are additive (§2): a 1.7 message is accepted by a 1.0 receiver.
    expect(parseEnvelope(JSON.stringify({ ...ping, protocolVersion: "1.7" }), strict).ok).toBe(
      true,
    );
    // Unknown fields are accepted (§14).
    expect(parseEnvelope(JSON.stringify({ ...ping, futureField: 1 }), strict).ok).toBe(true);
    expect(PROTOCOL_VERSION).toBe("1.0");
  });

  it("errors carry JSON Pointers and data-free messages, never the offending value", () => {
    const joined = { ...example("viewer.joined"), viewerToken: "SECRET-not-base64url!" };
    const r = parseEnvelope(JSON.stringify(joined), strict);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.instancePath).toBe("/viewerToken");
    expect(JSON.stringify(r.error)).not.toContain("SECRET");
  });

  it("tolerateUnknownEnums opens errorCode and every *Reason for inbound relay messages (§14)", () => {
    const lenient = compileSchemas({ tolerateUnknownEnums: true, allErrors: true });
    const defs = loadSchemas().get("defs.schema.json")!.definitions!;
    const reasons = Object.keys(defs).filter((n) => n.endsWith("Reason"));
    expect(reasons.length).toBeGreaterThanOrEqual(5);
    expect([...LENIENT_ENUM_DEFINITIONS].sort()).toEqual(["errorCode", ...reasons].sort());
    // One real message per lenient definition: strict rejects, lenient accepts the future value.
    const carriers: Record<string, [string, string]> = {
      errorCode: ["error", "code"],
      sessionEndReason: ["session.closed", "reason"],
      sessionCloseReason: ["session.close", "reason"],
      sessionExpiringReason: ["session.expiring", "reason"],
      snapshotAbortReason: ["scene.snapshot.abort", "reason"],
      sceneRequestReason: ["scene.request", "reason"],
    };
    expect(Object.keys(carriers).sort()).toEqual([...LENIENT_ENUM_DEFINITIONS].sort());
    for (const [def, [type, field]] of Object.entries(carriers)) {
      const future = { ...example(type), [field]: "FUTURE_VALUE_1_1" };
      expect(validateMessage(future, type, strict).ok, `${def} strict`).toBe(false);
      expect(validateMessage(future, type, lenient).ok, `${def} lenient`).toBe(true);
    }
    // clientInfo.platform is a plain string in the schema already (§14, no leniency needed).
    const join = {
      ...example("viewer.join"),
      clientInfo: { ...(example("viewer.join").clientInfo as object), platform: "visionos" },
    };
    expect(validateMessage(join, "viewer.join", strict).ok).toBe(true);
    const futureError = { ...example("error"), code: "FUTURE_CODE_1_1" };
    expect(validateMessage(futureError, "error", strict).ok).toBe(false);
    expect(validateMessage(futureError, "error", lenient).ok).toBe(true);
    const futureReason = { ...example("session.expired"), reason: "RELAY_MAINTENANCE" };
    expect(validateMessage(futureReason, undefined, strict).ok).toBe(false);
    expect(validateMessage(futureReason, undefined, lenient).ok).toBe(true);
    // Still a string, still bounded.
    expect(validateMessage({ ...futureError, code: "" }, "error", lenient).ok).toBe(false);
    expect(validateMessage({ ...futureError, code: 7 }, "error", lenient).ok).toBe(false);
    // Enums that are not forward-extensible stay closed (`profile`, `snapshotFormat`).
    const begin = { ...example("scene.snapshot.begin"), format: "gltf" };
    expect(validateMessage(begin, undefined, lenient).ok).toBe(false);
    expect(lenient.options).toEqual({ allErrors: true, tolerateUnknownEnums: true });
    expect(strict.options).toEqual({ allErrors: true, tolerateUnknownEnums: false });
  });

  it("generated schema bundle and fixtures/messages/expected.json are up to date", () => {
    execFileSync(
      process.execPath,
      [resolve(__dirname, "../scripts/generate.mjs"), "--check", "--skip-python"],
      {
        stdio: "pipe",
      },
    );
    const expected = readJson<{
      fixtures: { file: string; type: string; valid: boolean; instancePath?: string }[];
    }>(resolve(FIXTURES_DIR, "expected.json"));
    const fromFixtures = sets.flatMap((s) => [
      ...s.valid.map((v) => ({ file: `${s.type}/${v.file}`, type: s.type, valid: true })),
      ...s.invalid.map((i) => ({
        file: `${s.type}/${i.file}`,
        type: s.type,
        valid: false,
        instancePath: i.fixture.expect.instancePath,
      })),
    ]);
    expect(expected.fixtures).toEqual(
      [...fromFixtures].sort((a, b) => a.file.localeCompare(b.file, "en")),
    );
    expect(expected.fixtures.length).toBeGreaterThan(300);
  });

  it("snapshotVersion of viewer.joined and session.resumed is integer ≥ 1 or null (PRO-19 follow-up)", () => {
    const noSnapshot = (type: string) => {
      const rest = Object.fromEntries(
        Object.entries(example(type)).filter(([k]) => k !== "snapshot"),
      );
      return { ...rest, snapshotAvailable: false };
    };
    for (const type of ["viewer.joined", "session.resumed"]) {
      const ok = validateMessage({ ...noSnapshot(type), snapshotVersion: null }, type, strict);
      expect(ok.ok, `${type} null: ${JSON.stringify(ok)}`).toBe(true);
      const zero = validateMessage({ ...noSnapshot(type), snapshotVersion: 0 }, type, strict);
      expect(zero.ok, `${type} 0`).toBe(false);
      if (!zero.ok) expect(zero.error.instancePath).toBe("/snapshotVersion");
    }
  });
});

/** Parses the §11 table: for each type the four direction cells, from the Markdown itself. */
function permissionsFromDoc(): Map<string, string[]> {
  const rows = section("## 11. Permissions matrix", "## 12.")
    .split("\n")
    .filter((l) => l.startsWith("| `"));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    expect(cells).toHaveLength(5);
    const names = [...cells[0]!.matchAll(/`([^`]+)`/g)].flatMap(([, name]) => {
      const slash = /^(.*\.)([^.]+(?:\/[^.]+)+)$/.exec(name!);
      return slash ? slash[2]!.split("/").map((v) => slash[1]! + v) : [name!];
    });
    if (/binary chunks/.test(cells[0]!)) names.push("$binary");
    for (const name of names) out.set(name, cells.slice(1));
  }
  return out;
}

const cellAllows = (cell: string, type: string): boolean => {
  if (!cell.startsWith("yes")) return false;
  const only = /\(`([^`]+)` only\)/.exec(cell);
  return only ? type.endsWith(only[1]!) : true;
};

describe("permissions matrix (§11)", () => {
  const table = permissionsFromDoc();
  const directions: [Role, Role, number][] = [
    ["publisher", "relay", 0],
    ["viewer", "relay", 1],
    ["relay", "publisher", 2],
    ["relay", "viewer", 3],
  ];

  it("the §11 table lists every message type that has a schema, plus the reserved v1.1 types", () => {
    const listed = [...table.keys()].filter((t) => t !== "$binary").sort();
    expect(listed).toEqual([...MESSAGE_TYPES, ...RESERVED_TYPES].sort());
    expect(listed.length).toBeGreaterThan(0);
  });

  for (const [sender, recipient, column] of directions) {
    it(`isAllowed(${sender}, type, ${recipient}) reproduces the ${sender} → ${recipient} column for every type`, () => {
      for (const [type, cells] of table) {
        if (type === "$binary") continue;
        expect(isAllowed(sender, type, recipient), `${type} ${sender}→${recipient}`).toBe(
          cellAllows(cells[column]!, type),
        );
      }
    });
  }

  it("reserved and unknown types are never allowed; publisher/viewer never send to each other", () => {
    for (const type of RESERVED_TYPES) {
      expect(type in PERMISSIONS).toBe(false);
      expect(isAllowed("publisher", type)).toBe(false);
      expect(isAllowed("viewer", type)).toBe(false);
    }
    expect(isAllowed("publisher", "nope")).toBe(false);
    expect(isAllowed("publisher", "ping", "viewer")).toBe(false);
    expect(isAllowed("viewer", "ping", "publisher")).toBe(false);
    expect(isAllowed("relay", "ping")).toBe(false);
  });

  it("binary frames: publisher → relay → viewers only (§3.2, §11)", () => {
    const cells = table.get("$binary")!;
    expect(cells).toBeDefined();
    for (const [sender, recipient, column] of directions)
      expect(isBinaryAllowed(sender, recipient)).toBe(cellAllows(cells[column]!, "$binary"));
    expect(BINARY_FRAME_PERMISSION).toEqual({
      publisherToRelay: true,
      viewerToRelay: false,
      relayToPublisher: false,
      relayToViewer: true,
    });
    expect(isBinaryAllowed("viewer")).toBe(false);
  });

  it("every type is sendable by someone", () => {
    for (const type of MESSAGE_TYPES as readonly MessageType[])
      expect(Object.values(PERMISSIONS[type]).some(Boolean), type).toBe(true);
  });
});

describe("constants (§3.3, §9.2, §9.3)", () => {
  it("ERROR_CODES equals the §9.2 table and the errorCode def", () => {
    const fromDoc = [
      ...section("### 9.2 `error` message", "### 9.3").matchAll(/^\| `([A-Z_]+)` \|/gm),
    ].map((m) => m[1]);
    expect([...ERROR_CODES]).toEqual(fromDoc);
    const def = loadSchemas().get("defs.schema.json")!.definitions!.errorCode as {
      enum: string[];
    };
    expect([...ERROR_CODES]).toEqual(def.enum);
    expect(ERROR_CODES).toHaveLength(15);
  });

  it("CLOSE_CODES covers 4000–4012 and the standard codes of §9.3, each once", () => {
    const fromDoc = [
      ...section("### 9.3 WebSocket close codes", "## 10.").matchAll(/^\| `(\d{4})` \|/gm),
    ]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const values = Object.values(CLOSE_CODES).sort((a, b) => a - b);
    expect(values).toEqual(fromDoc);
    expect(new Set(values).size).toBe(values.length);
    for (let code = 4000; code <= 4012; code++) expect(values).toContain(code);
    expect(CLOSE_CODES.UNSUPPORTED_VERSION).toBe(4000);
    expect(CLOSE_CODES.HANDSHAKE_TIMEOUT).toBe(4012);
  });

  it("LIMITS match the §3.3 table and the chunk helpers / schema maxima", () => {
    const limits = section("### 3.3 Limits", "## 4.");
    const bytes = [
      LIMITS.MAX_TEXT_BYTES_PUBLISHER,
      LIMITS.MAX_TEXT_BYTES_VIEWER,
      LIMITS.MAX_CHUNK_BYTES,
      LIMITS.WS_MAX_PAYLOAD_BYTES,
      LIMITS.MAX_SNAPSHOT_BYTES,
      LIMITS.RECOMMENDED_SNAPSHOT_BYTES_MOBILE,
    ];
    for (const n of bytes) expect(limits, `${n} B`).toContain(`${n.toLocaleString("en-US")} B`);
    for (const n of [
      LIMITS.CHUNK_TIMEOUT_S,
      LIMITS.SESSION_TTL_S,
      LIMITS.SESSION_MAX_LIFETIME_S,
      LIMITS.PUBLISHER_GRACE_S,
      LIMITS.HANDSHAKE_TIMEOUT_S,
      LIMITS.HEARTBEAT_INTERVAL_S,
      LIMITS.HEARTBEAT_TIMEOUT_S,
      LIMITS.RELAY_PING_INTERVAL_S,
    ])
      expect(limits, `${n} s`).toContain(`${n.toLocaleString("en-US")} s`);
    expect(limits).toContain(`| ${LIMITS.MAX_CHUNK_COUNT.toLocaleString("en-US")} |`);
    expect(limits).toContain(`| ${LIMITS.MAX_VIEWERS} |`);
    expect(limits).toContain(`| ${LIMITS.MAX_CHANGES.toLocaleString("en-US")} |`);
    expect(limits).toContain(`| ${LIMITS.MAX_SESSIONS_DEFAULT} default |`);
    expect(limits).toContain(`≤ ${LIMITS.MAX_NODE_ID_LENGTH} chars`);
    expect(limits).toContain(`≤ ${LIMITS.MAX_NODE_NAME_LENGTH} chars`);
    expect(LIMITS.MAX_SNAPSHOT_BYTES).toBe(MAX_SNAPSHOT_BYTES);
    expect(LIMITS.MIN_CHUNK_BYTES).toBe(MIN_CHUNK_SIZE);
    expect(LIMITS.MAX_CHUNK_BYTES).toBe(MAX_CHUNK_SIZE);
    expect(LIMITS.MAX_CHUNK_COUNT).toBe(MAX_CHUNK_COUNT);
    expect(LIMITS.SLOW_CONSUMER_SOFT_BYTES).toBe(4 * 1024 * 1024);
    expect(LIMITS.SLOW_CONSUMER_HARD_BYTES).toBe(8 * 1024 * 1024);
    const def = loadSchemas().get("defs.schema.json")!.definitions!.limits as {
      properties: Record<string, { maximum: number }>;
    };
    expect(def.properties.maxSnapshotBytes!.maximum).toBe(LIMITS.MAX_SNAPSHOT_BYTES);
    expect(def.properties.maxChunkBytes!.maximum).toBe(LIMITS.MAX_CHUNK_BYTES);
    expect(def.properties.maxTextBytes!.maximum).toBe(LIMITS.MAX_TEXT_BYTES_PUBLISHER);
    expect(def.properties.maxChanges!.maximum).toBe(LIMITS.MAX_CHANGES);
  });
});
