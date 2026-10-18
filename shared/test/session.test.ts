import { describe, expect, it } from "vitest";
import {
  compile,
  createAjv,
  instancePaths,
  loadFixtures,
  loadSchemas,
  protocolExamples,
} from "./helpers.js";

const ajv = createAjv();
const SESSION_TYPES = [
  // PRO-03 (§4.1–4.3)
  "session.create",
  "session.created",
  "session.resume",
  "session.resumed",
  // PRO-18 (§4.4–4.6)
  "session.renew",
  "session.expiring",
  "session.renewed",
  "session.close",
  "session.closed",
  "session.expired",
  "session.publisherState",
];
const examples = protocolExamples("## 4. Session lifecycle", "## 5. Viewer join");
const fixtureSet = (type: string) => loadFixtures("session.").find((s) => s.type === type)!;

describe("session schemas + fixtures (PRO-03 establishment, PRO-18 maintenance and end)", () => {
  it("has one schema file per type, named as in §4/§11, with `type` as a const, and a fixture directory each", () => {
    const fixtureTypes = loadFixtures("session.").map((s) => s.type);
    expect(fixtureTypes).toEqual([...SESSION_TYPES].sort());
    for (const type of SESSION_TYPES) {
      const schema = loadSchemas().get(`${type}.schema.json`);
      expect(schema, type).toBeDefined();
      const typeProp = (schema!.properties as Record<string, { const?: string; type?: string }>)
        .type;
      expect(typeProp).toEqual({ type: "string", const: type });
      expect((schema!.required as string[]).includes("type"), `${type} requires type`).toBe(true);
    }
  });

  for (const set of loadFixtures("session.")) {
    describe(set.type, () => {
      const validate = compile(ajv, `${set.type}.schema.json`);

      it("accepts every valid fixture", () => {
        expect(set.valid.length).toBeGreaterThan(0);
        for (const { file, message } of set.valid) {
          expect(validate(message), `${file}: ${ajv.errorsText(validate.errors)}`).toBe(true);
        }
      });

      it("valid-example.json equals the §4 example value for value", () => {
        const fixture = set.valid.find((v) => v.file === "valid-example.json");
        expect(fixture, "valid-example.json present").toBeDefined();
        expect(examples.get(set.type)?.[0], `§4 shows an example of ${set.type}`).toBeDefined();
        expect(fixture!.message).toEqual(examples.get(set.type)![0]);
      });

      it("rejects every invalid fixture at the expected instancePath", () => {
        expect(set.invalid.length).toBeGreaterThan(0);
        for (const { file, fixture } of set.invalid) {
          expect(validate(fixture.message), `${file} should be invalid`).toBe(false);
          const hits = (validate.errors ?? []).filter(
            (e) =>
              e.instancePath === fixture.expect.instancePath &&
              (fixture.expect.keyword === undefined || e.keyword === fixture.expect.keyword),
          );
          expect(
            hits.length,
            `${file}: expected ${JSON.stringify(fixture.expect)}, got ${ajv.errorsText(validate.errors)}`,
          ).toBeGreaterThan(0);
        }
      });
    });
  }

  it("session.create has no token field and preferredCode is string|null (§4.1, ADR 0008 errata)", () => {
    const schema = loadSchemas().get("session.create.schema.json")!;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).not.toContain("publisherToken");
    expect(Object.keys(props)).not.toContain("token");
    expect((props.preferredCode as { type: string[] }).type).toEqual(["string", "null"]);
    const validate = compile(ajv, "session.create.schema.json");
    const base = fixtureSet("session.create").valid[0]!.message;
    expect(validate({ ...base, preferredCode: "7KQ4X" })).toBe(true);
    expect(validate({ ...base, preferredCode: null })).toBe(true);
    expect(
      validate({ ...base, viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw" }),
    ).toBe(false);
  });

  it("session.created.code uses the code def and publisherToken is ≥ 43 base64url chars (NFR-17)", () => {
    const schema = loadSchemas().get("session.created.schema.json")!;
    const props = schema.properties as Record<string, { $ref?: string }>;
    expect(props.code?.$ref).toBe("defs.schema.json#/definitions/code");
    expect(props.publisherToken?.$ref).toBe("defs.schema.json#/definitions/token");
    const validate = compile(ajv, "session.created.schema.json");
    const base = fixtureSet("session.created").valid[0]!.message;
    expect(validate({ ...base, publisherToken: "A".repeat(43) })).toBe(true);
    expect(validate({ ...base, publisherToken: "A".repeat(42) })).toBe(false);
    expect(validate({ ...base, publisherToken: "A".repeat(42) + "=" })).toBe(false);
  });

  it("reason enums of session.expiring/close/closed/expired match §4.4–4.6 via the defs (PRO-18)", () => {
    const schemas = loadSchemas();
    const reasonRef = (type: string) =>
      (schemas.get(`${type}.schema.json`)!.properties as Record<string, { $ref?: string }>).reason
        ?.$ref;
    expect(reasonRef("session.expiring")).toBe(
      "defs.schema.json#/definitions/sessionExpiringReason",
    );
    expect(reasonRef("session.close")).toBe("defs.schema.json#/definitions/sessionCloseReason");
    expect(reasonRef("session.closed")).toBe("defs.schema.json#/definitions/sessionEndReason");
    expect(reasonRef("session.expired")).toBe("defs.schema.json#/definitions/sessionEndReason");
    const defs = schemas.get("defs.schema.json")!.definitions as Record<string, { enum: string[] }>;
    expect(defs.sessionEndReason!.enum).toEqual([
      "PUBLISHER_CLOSED",
      "PUBLISHER_GONE",
      "IDLE",
      "MAX_LIFETIME",
      "CAPACITY",
    ]);
    expect(defs.sessionCloseReason!.enum).toEqual(["USER_STOPPED"]);
    expect(defs.sessionExpiringReason!.enum).toEqual(["IDLE"]);
    const closed = compile(ajv, "session.closed.schema.json");
    const base = fixtureSet("session.closed").valid[0]!.message;
    for (const reason of defs.sessionEndReason!.enum)
      expect(closed({ ...base, reason })).toBe(true);
  });

  it("session.publisherState requires online and, when online:false, graceEndsAt (§4.6)", () => {
    const validate = compile(ajv, "session.publisherState.schema.json");
    const base = { protocolVersion: "1.0", type: "session.publisherState" };
    expect(validate({ ...base, online: true })).toBe(true);
    expect(validate({ ...base, online: true, graceEndsAt: 1792238520000 })).toBe(true);
    expect(validate({ ...base, online: false, graceEndsAt: 1792238520000 })).toBe(true);
    expect(validate({ ...base, online: false })).toBe(false);
    expect(instancePaths(validate.errors)).toContain("");
    expect(validate(base)).toBe(false);
  });

  it("session.renewed.ttl reuses the ttl def (PRO-18)", () => {
    const schema = loadSchemas().get("session.renewed.schema.json")!;
    const props = schema.properties as Record<string, { $ref?: string }>;
    expect(props.ttl?.$ref).toBe("defs.schema.json#/definitions/ttl");
    const validate = compile(ajv, "session.renewed.schema.json");
    const created = fixtureSet("session.created").valid[0]!.message;
    expect(validate({ protocolVersion: "1.0", type: "session.renewed", ttl: created.ttl })).toBe(
      true,
    );
  });
});
