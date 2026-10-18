import { describe, expect, it } from "vitest";
import { compile, createAjv, loadFixtures, loadSchemas, protocolExamples } from "./helpers.js";

const ajv = createAjv();
const SESSION_TYPES = ["session.create", "session.created", "session.resume", "session.resumed"];
const examples = protocolExamples("## 4. Session lifecycle", "## 5. Viewer join");
const fixtureSet = (type: string) => loadFixtures("session.").find((s) => s.type === type)!;

describe("session establishment schemas + fixtures (PRO-03)", () => {
  it("has one schema file per type, named as in §4/§11, with `type` as a const", () => {
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
});
