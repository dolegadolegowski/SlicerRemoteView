import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compile,
  createAjv,
  instancePaths,
  loadFixtures,
  loadSchemas,
  PROTOCOL_DOC,
  protocolExamples,
} from "./helpers.js";

const ajv = createAjv();
const VIEWER_TYPES = ["viewer.join", "viewer.joined", "viewer.count", "viewer.leave"];
const HEARTBEAT_TYPES = ["ping", "pong", "error"];
const TYPES = [...VIEWER_TYPES, ...HEARTBEAT_TYPES];
const examples = new Map([
  ...protocolExamples("## 5. Viewer join", "## 6. Scene snapshot"),
  ...protocolExamples("## 9. Heartbeat, timeouts, errors, close codes", "## 10. HTTP endpoints"),
]);
const sets = loadFixtures().filter((s) => TYPES.includes(s.type));
const fixtureSet = (type: string) => sets.find((s) => s.type === type)!;

describe("viewer, heartbeat and error schemas + fixtures (PRO-04)", () => {
  it("has one schema file and one fixture directory per type, named as in §5/§9/§11, with `type` as a const", () => {
    expect(sets.map((s) => s.type).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) {
      const schema = loadSchemas().get(`${type}.schema.json`);
      expect(schema, type).toBeDefined();
      const typeProp = (schema!.properties as Record<string, { const?: string; type?: string }>)
        .type;
      expect(typeProp).toEqual({ type: "string", const: type });
      expect((schema!.required as string[]).includes("type"), `${type} requires type`).toBe(true);
    }
  });

  for (const set of sets) {
    describe(set.type, () => {
      const validate = compile(ajv, `${set.type}.schema.json`);

      it("accepts every valid fixture", () => {
        expect(set.valid.length).toBeGreaterThan(0);
        for (const { file, message } of set.valid) {
          expect(validate(message), `${file}: ${ajv.errorsText(validate.errors)}`).toBe(true);
        }
      });

      it("valid-example.json equals the §5/§9 example value for value", () => {
        const fixture = set.valid.find((v) => v.file === "valid-example.json");
        expect(fixture, "valid-example.json present").toBeDefined();
        expect(
          examples.get(set.type)?.[0],
          `the contract shows an example of ${set.type}`,
        ).toBeDefined();
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

  it("viewer.join carries exactly one of code or sessionId+viewerToken (§5.1), both forms matching §5.1", () => {
    const [byCode, byToken] = examples.get("viewer.join")!;
    expect(
      fixtureSet("viewer.join").valid.find((v) => v.file === "valid-rejoin.json")!.message,
    ).toEqual(byToken);
    const validate = compile(ajv, "viewer.join.schema.json");
    expect(validate(byCode)).toBe(true);
    expect(validate(byToken)).toBe(true);
    const { code, ...noCode } = byCode!;
    expect(validate(noCode)).toBe(false);
    expect(validate({ ...byToken, code })).toBe(false);
    expect(validate.errors!.map((e) => e.keyword)).toContain("oneOf");
    expect(instancePaths(validate.errors)).toContain("");
    const { viewerToken, ...noToken } = byToken!;
    expect(validate(noToken), "sessionId without viewerToken").toBe(false);
    expect(validate({ ...byCode, viewerToken }), "code with viewerToken").toBe(false);
    // Every property is declared at top level so generators type it (shared/README.md spike note).
    const schema = loadSchemas().get("viewer.join.schema.json")!;
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      ["clientInfo", "code", "sessionId", "type", "viewerToken"].sort(),
    );
  });

  it("error.code is limited to the 15 codes of §9.2 and details forbids codes and tokens", () => {
    const doc = readFileSync(PROTOCOL_DOC, "utf8");
    const section = doc.slice(doc.indexOf("### 9.2 `error` message"), doc.indexOf("### 9.3"));
    const codes = [...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!);
    expect(codes).toHaveLength(15);
    const validate = compile(ajv, "error.schema.json");
    const base = fixtureSet("error").valid[0]!.message;
    for (const code of codes) expect(validate({ ...base, code }), code).toBe(true);
    expect(validate({ ...base, code: "NOT_A_CODE" })).toBe(false);
    for (const key of ["code", "token", "publisherToken", "viewerToken"]) {
      expect(validate({ ...base, details: { [key]: "x" } }), `details.${key}`).toBe(false);
      expect(instancePaths(validate.errors)).toContain("/details");
    }
    expect(validate({ ...base, details: { retryAfterS: 30, field: "chunkIndex" } })).toBe(true);
    expect(validate({ ...base, details: {} })).toBe(true);
  });

  it("viewer.joined describes the fetchable snapshot when snapshotAvailable is true (§5.2, §6.5)", () => {
    const validate = compile(ajv, "viewer.joined.schema.json");
    const base = fixtureSet("viewer.joined").valid[0]!.message;
    const { snapshot, ...withoutSnapshot } = base;
    expect(validate({ ...withoutSnapshot, snapshotAvailable: false, snapshotVersion: null })).toBe(
      true,
    );
    expect(validate({ ...withoutSnapshot, snapshotAvailable: true })).toBe(false);
    expect(validate({ ...base, snapshot: { ...(snapshot as object), format: "gltf" } })).toBe(
      false,
    );
    expect(instancePaths(validate.errors)).toContain("/snapshot/format");
  });

  it("viewer.count accepts platform names unknown to v1.0 (§14) with integer counts", () => {
    const validate = compile(ajv, "viewer.count.schema.json");
    const base = fixtureSet("viewer.count").valid[0]!.message;
    expect(validate({ ...base, platforms: { web: 2, future: 1 } })).toBe(true);
    expect(validate({ ...base, platforms: { web: -1 } })).toBe(false);
    expect(validate({ ...base, platforms: [] })).toBe(false);
  });
});
