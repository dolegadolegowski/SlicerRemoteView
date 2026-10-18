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
const SCENE_TYPES = [
  "scene.update",
  "scene.nodeRemoved",
  "scene.nodeAdded",
  "scene.state",
  "scene.request",
];
const examples = protocolExamples(
  "## 8. Incremental updates",
  "## 9. Heartbeat, timeouts, errors, close codes",
);
// `scene.snapshot.*` fixtures belong to test/snapshot.test.ts (PRO-05).
const sets = loadFixtures("scene.").filter((s) => !s.type.startsWith("scene.snapshot."));
const fixtureSet = (type: string) => sets.find((s) => s.type === type)!;
const base = (type: string) =>
  fixtureSet(type).valid.find((v) => v.file === "valid-example.json")!.message;
const nodeIds = (n: number) => Array.from({ length: n }, (_, i) => `vtkMRMLModelNode${i}`);

describe("incremental-update schemas + fixtures (PRO-19)", () => {
  it("has one schema file and one fixture directory per type, named as in §8/§11, with `type` as a const", () => {
    expect(sets.map((s) => s.type).sort()).toEqual([...SCENE_TYPES].sort());
    for (const type of SCENE_TYPES) {
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

      it("valid-example.json equals the §8 example value for value", () => {
        const fixture = set.valid.find((v) => v.file === "valid-example.json");
        expect(fixture, "valid-example.json present").toBeDefined();
        expect(examples.get(set.type)?.[0], `§8 shows an example of ${set.type}`).toBeDefined();
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

  it("scene.update.changes holds 1..1000 items, each with nodeId and ≥ 1 visual property, never a name (§8.1, §3.3)", () => {
    const validate = compile(ajv, "scene.update.schema.json");
    const ok = (patch: Record<string, unknown>) => validate({ ...base("scene.update"), ...patch });
    const change = (nodeId: string) => ({ nodeId, visible: true });
    expect(ok({ changes: nodeIds(1000).map(change) })).toBe(true);
    expect(ok({ changes: nodeIds(1001).map(change) })).toBe(false);
    expect(instancePaths(validate.errors)).toContain("/changes");
    expect(ok({ changes: [] })).toBe(false);
    for (const prop of [
      { visible: false },
      { color: [0, 0, 0] },
      { opacity: 1 },
      { matrix: Array<number>(16).fill(0) },
    ])
      expect(ok({ changes: [{ nodeId: "n", ...prop }] }), JSON.stringify(prop)).toBe(true);
    expect(ok({ changes: [{ nodeId: "n" }] })).toBe(false);
    expect(validate.errors!.map((e) => e.keyword)).toContain("anyOf");
    expect(ok({ changes: [{ nodeId: "n", visible: true, name: "Liver" }] })).toBe(false);
    expect(ok({ changes: [{ visible: true }] })).toBe(false);
    expect(ok({ sceneVersion: 44, baseVersion: 0 }), "baseVersion 0 is a relay concern").toBe(true);
    expect(ok({ sceneVersion: 1.5 })).toBe(false);
    // Shapes come from the shared definitions so generators and Python reuse them.
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { properties?: Record<string, { $ref?: string }>; required?: string[] }
    >;
    const change$ = defs.nodeChange!;
    expect(change$.required).toEqual(["nodeId"]);
    expect(change$.properties?.color?.$ref).toBe("#/definitions/color");
    expect(change$.properties?.matrix?.$ref).toBe("#/definitions/matrix");
    expect(Object.keys(change$.properties ?? {}).sort()).toEqual(
      ["color", "matrix", "nodeId", "opacity", "visible"].sort(),
    );
    const update = loadSchemas().get("scene.update.schema.json")!.properties as Record<
      string,
      { items?: { $ref?: string } }
    >;
    expect(update.changes?.items?.$ref).toBe("defs.schema.json#/definitions/nodeChange");
  });

  it("scene.nodeRemoved.nodeIds holds 1..1000 ids; scene.nodeAdded requires snapshotFollows: true and node kinds (§8.2)", () => {
    const removed = compile(ajv, "scene.nodeRemoved.schema.json");
    const r = (patch: Record<string, unknown>) =>
      removed({ ...base("scene.nodeRemoved"), ...patch });
    expect(r({ nodeIds: nodeIds(1000) })).toBe(true);
    expect(r({ nodeIds: nodeIds(1001) })).toBe(false);
    expect(instancePaths(removed.errors)).toContain("/nodeIds");
    expect(r({ nodeIds: [] })).toBe(false);
    expect(r({ nodeIds: ["x".repeat(129)] })).toBe(false);

    const added = compile(ajv, "scene.nodeAdded.schema.json");
    const a = (patch: Record<string, unknown>) => added({ ...base("scene.nodeAdded"), ...patch });
    expect(a({ snapshotFollows: false })).toBe(false);
    expect(instancePaths(added.errors)).toContain("/snapshotFollows");
    expect(a({ snapshotFollows: "true" })).toBe(false);
    const nodes = (n: number, kind = "model") => nodeIds(n).map((nodeId) => ({ nodeId, kind }));
    expect(a({ nodes: nodes(1000) })).toBe(true);
    expect(a({ nodes: nodes(1001) })).toBe(false);
    expect(a({ nodes: nodes(1, "segment") })).toBe(true);
    expect(a({ nodes: nodes(1, "volume") })).toBe(false);
    expect(instancePaths(added.errors)).toContain("/nodes/0/kind");
    expect(a({ nodes: [{ nodeId: "n", kind: "model", name: "Liver" }] }), "T7: no names").toBe(
      false,
    );
    expect(instancePaths(added.errors)).toContain("/nodes/0");
    expect(
      a({ nodes: [{ nodeId: "n", kind: "model", triangleCount: 1 }] }),
      "§14: unknown fields pass",
    ).toBe(true);
  });

  it("scene.state accepts the always-sent empty form and never carries names (§8.3, T7)", () => {
    const validate = compile(ajv, "scene.state.schema.json");
    const ok = (patch: Record<string, unknown>) => validate({ ...base("scene.state"), ...patch });
    const empty = {
      protocolVersion: "1.0",
      type: "scene.state",
      sceneVersion: 0,
      snapshotVersion: null,
      nodes: [],
      removed: [],
    };
    expect(validate(empty), ajv.errorsText(validate.errors)).toBe(true);
    expect(
      fixtureSet("scene.state").valid.map((v) => v.message),
      "the empty form is a committed fixture",
    ).toContainEqual(empty);
    expect(ok({ snapshotVersion: 43 })).toBe(true);
    expect(ok({ snapshotVersion: 0 })).toBe(false);
    expect(ok({ nodes: [{ nodeId: "n", visible: true, name: "Liver" }] })).toBe(false);
    expect(instancePaths(validate.errors)).toContain("/nodes/0");
    expect(ok({ nodes: [{ nodeId: "n" }] })).toBe(false);
    expect(ok({ removed: nodeIds(5000) }), "no per-message cap on the merged state").toBe(true);
    const props = loadSchemas().get("scene.state.schema.json")!.properties as Record<
      string,
      { items?: { $ref?: string } }
    >;
    expect(props.nodes?.items?.$ref).toBe("defs.schema.json#/definitions/nodeChange");
    expect(props.removed?.items?.$ref).toBe("defs.schema.json#/definitions/nodeId");
  });

  it("scene.request.reason enum equals the §8.3 list; haveSnapshotVersion is null or ≥ 1 (§8.3)", () => {
    const doc = readFileSync(PROTOCOL_DOC, "utf8");
    const section = doc.slice(doc.indexOf("### 8.3"), doc.indexOf("### 8.4"));
    const match = /`reason` ∈ `([^`]+)`/.exec(section);
    if (!match) throw new Error("§8.3 `reason` ∈ … list not found in docs/protocol.md");
    const listed = match[1]!.split("|").map((s) => s.trim());
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { enum: string[] }
    >;
    expect(defs.sceneRequestReason!.enum).toEqual(listed);
    const props = loadSchemas().get("scene.request.schema.json")!.properties as Record<
      string,
      { $ref?: string }
    >;
    expect(props.reason?.$ref).toBe("defs.schema.json#/definitions/sceneRequestReason");
    const validate = compile(ajv, "scene.request.schema.json");
    const ok = (patch: Record<string, unknown>) => validate({ ...base("scene.request"), ...patch });
    for (const reason of listed) expect(ok({ reason }), reason).toBe(true);
    expect(ok({ reason: "TIMEOUT" })).toBe(false);
    expect(ok({ haveSnapshotVersion: null, haveSceneVersion: 0 })).toBe(true);
    expect(ok({ haveSnapshotVersion: 0 })).toBe(false);
    expect(ok({ haveSceneVersion: -1 })).toBe(false);
  });
});
