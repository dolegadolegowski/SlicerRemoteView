import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, compileSchemas, parseEnvelope } from "@slicerremoteview/shared";
import { parseInbound } from "../../src/protocol/envelope";

const FIXTURES = fileURLToPath(new URL("../../../shared/fixtures/messages/", import.meta.url));
const types = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const read = (type: string, file: string) => readFileSync(`${FIXTURES}${type}/${file}`, "utf8");
const validFiles = (type: string) =>
  readdirSync(`${FIXTURES}${type}`).filter((f) => f.startsWith("valid-"));
const lenient = compileSchemas({ tolerateUnknownEnums: true });

describe("parseInbound (CSP-friendly shape guard)", () => {
  const cases = types.flatMap((type) => validFiles(type).map((file) => [type, file] as const));

  it("has fixtures to run", () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  it.each(cases)(
    "%s/%s: accepted iff the type may go relay → viewer; agrees with the schema",
    (type, file) => {
      const text = read(type, file);
      const result = parseInbound(text);
      const allowed = (PERMISSIONS as Record<string, { relayToViewer: boolean }>)[type]!
        .relayToViewer;
      if (allowed) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        // Whatever the light guard lets through must also satisfy the full schema (valid fixtures).
        expect(parseEnvelope(text, lenient).ok).toBe(true);
      } else {
        expect(result).toMatchObject({ ok: false, reason: "unknownType", type });
      }
    },
  );

  it("rejects missing required fields and wrong primitive types of known messages", () => {
    const base = JSON.parse(read("scene.state", "valid-example.json")) as Record<string, unknown>;
    expect(parseInbound(JSON.stringify(base)).ok).toBe(true);
    for (const [patch, label] of [
      [{ sceneVersion: undefined }, "missing sceneVersion"],
      [{ sceneVersion: -1 }, "negative sceneVersion"],
      [{ sceneVersion: 1.5 }, "fractional sceneVersion"],
      [{ snapshotVersion: "3" }, "string snapshotVersion"],
      [{ nodes: {} }, "object nodes"],
    ] as const) {
      const result = parseInbound(JSON.stringify({ ...base, ...patch }));
      expect(result, label).toMatchObject({ ok: false, reason: "invalid", type: "scene.state" });
    }
    expect(parseInbound(JSON.stringify({ ...base, snapshotVersion: null })).ok).toBe(true);
  });

  it("maps JSON, version and type failures to the right reason", () => {
    expect(parseInbound("{")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInbound("[]")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInbound(JSON.stringify({ type: "pong" }))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(parseInbound(JSON.stringify({ protocolVersion: "2.0", type: "pong" }))).toMatchObject({
      ok: false,
      reason: "unsupportedVersion",
    });
    expect(parseInbound(JSON.stringify({ protocolVersion: "1.7", type: "pong" })).ok).toBe(true);
    expect(parseInbound(JSON.stringify({ protocolVersion: "1.0", type: "x.y" }))).toMatchObject({
      ok: false,
      reason: "unknownType",
      type: "x.y",
    });
    expect(
      parseInbound(JSON.stringify({ protocolVersion: "1.0", type: "pong", id: "x".repeat(33) })),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("only returns a printable, capped type for logging", () => {
    const result = parseInbound(
      JSON.stringify({ protocolVersion: "1.0", type: `a\u0000\n${"b".repeat(200)}` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.type).toMatch(/^[\x20-\x7e]{1,64}$/);
    }
  });

  it("does not treat Object.prototype names as message types", () => {
    for (const type of ["constructor", "__proto__", "toString"])
      expect(parseInbound(JSON.stringify({ protocolVersion: "1.0", type }))).toMatchObject({
        ok: false,
        reason: "unknownType",
      });
  });
});
