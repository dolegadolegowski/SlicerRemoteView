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
const SNAPSHOT_TYPES = [
  "scene.snapshot.begin",
  "scene.snapshot.end",
  "scene.snapshot.abort",
  "scene.snapshot.ready",
  "scene.snapshot.ack",
];
const examples = protocolExamples(
  "## 6. Scene snapshot (GLB)",
  "## 7. Scene manifest inside the GLB",
);
const sets = loadFixtures("scene.snapshot.");
const fixtureSet = (type: string) => sets.find((s) => s.type === type)!;

describe("snapshot schemas + fixtures (PRO-05)", () => {
  it("has one schema file and one fixture directory per type, named as in §6/§11, with `type` as a const", () => {
    expect(sets.map((s) => s.type).sort()).toEqual([...SNAPSHOT_TYPES].sort());
    for (const type of SNAPSHOT_TYPES) {
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

      it("valid-example.json equals the §6 example value for value", () => {
        const fixture = set.valid.find((v) => v.file === "valid-example.json");
        expect(fixture, "valid-example.json present").toBeDefined();
        expect(examples.get(set.type)?.[0], `§6 shows an example of ${set.type}`).toBeDefined();
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

  it("scene.snapshot.begin bounds chunkSize, byteLength, chunkCount and extensionsUsed (§3.3, §6.2)", () => {
    const validate = compile(ajv, "scene.snapshot.begin.schema.json");
    const base = fixtureSet("scene.snapshot.begin").valid[0]!.message;
    const ok = (patch: Record<string, unknown>) => validate({ ...base, ...patch });
    expect(ok({ chunkSize: 65536, chunkCount: 288 })).toBe(true);
    expect(ok({ chunkSize: 65535, chunkCount: 288 })).toBe(false);
    expect(ok({ chunkSize: 1048576 })).toBe(true);
    expect(ok({ chunkSize: 1048577 })).toBe(false);
    expect(ok({ byteLength: 67108864, chunkCount: 64 })).toBe(true);
    // PRO-21: `begin.byteLength` has no maximum — the relay answers PAYLOAD_TOO_LARGE (§6.2, report 2026-10-20-server-2);
    // the sizes the relay reports (`ready`, `viewer.joined.snapshot`) keep the 64 MiB maximum (see the next test).
    expect(ok({ byteLength: 67108865, chunkCount: 65 })).toBe(true);
    expect(ok({ byteLength: 1e12, chunkCount: 1024 })).toBe(true);
    expect(ok({ byteLength: Number.MAX_SAFE_INTEGER, chunkCount: 1024 })).toBe(true);
    expect(ok({ byteLength: Number.MAX_SAFE_INTEGER + 1, chunkCount: 1024 })).toBe(false);
    expect(ok({ byteLength: 0, chunkCount: 1 })).toBe(false);
    expect(ok({ sceneVersion: 4294967295 })).toBe(true);
    expect(ok({ sceneVersion: 4294967296 })).toBe(false);
    expect(ok({ chunkCount: 1024 })).toBe(true);
    expect(ok({ chunkCount: 1025 })).toBe(false);
    expect(ok({ chunkCount: 0 })).toBe(false);
    expect(ok({ extensionsUsed: [] })).toBe(true);
    expect(ok({ extensionsUsed: ["KHR_mesh_quantization"] })).toBe(true);
    expect(ok({ extensionsUsed: ["KHR_draco_mesh_compression"] })).toBe(false);
    expect(ok({ extensionsUsed: ["EXT_meshopt_compression"] })).toBe(false);
    expect(ok({ sha256: "0".repeat(63) })).toBe(false);
    const props = loadSchemas().get("scene.snapshot.begin.schema.json")!.properties as Record<
      string,
      { $ref?: string }
    >;
    expect(props.sha256?.$ref).toBe("defs.schema.json#/definitions/sha256");
    // The relay, not the schema, checks chunkCount == ceil(byteLength / chunkSize) (§6.2):
    expect(ok({ chunkCount: 17 })).toBe(true);
  });

  it("only a publisher's announcement lacks the 64 MiB maximum: ready and viewer.joined.snapshot keep it (PRO-21)", () => {
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { maximum?: number }
    >;
    expect(defs.announcedByteLength).toBeDefined();
    expect(defs.announcedByteLength!.maximum).toBe(Number.MAX_SAFE_INTEGER); // exact integers only, no 64 MiB cap
    expect(defs.byteLength!.maximum).toBe(67108864);
    const ready = compile(ajv, "scene.snapshot.ready.schema.json");
    const base = fixtureSet("scene.snapshot.ready").valid[0]!.message;
    expect(ready({ ...base, byteLength: 67108864 })).toBe(true);
    expect(ready({ ...base, byteLength: 67108865 })).toBe(false);
  });

  it("every scene version in every schema is a uint32 (§3.3, §6.3)", () => {
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { maximum?: number }
    >;
    for (const name of ["sceneVersion", "snapshotVersion", "updateVersion"])
      expect(defs[name]!.maximum, name).toBe(4294967295);
    // Walk every schema: any property whose name says it is a version (…Version) and whose type is integer
    // (or integer|null) must carry the uint32 maximum, whether it is inline or reached through a $ref.
    let versionProperties = 0;
    const walk = (node: unknown, file: string): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, file));
      if (node === null || typeof node !== "object") return;
      const object = node as Record<string, unknown>;
      const properties = object["properties"] as
        Record<string, Record<string, unknown>> | undefined;
      for (const [name, prop] of Object.entries(properties ?? {})) {
        const type = ([] as unknown[]).concat(prop["type"] ?? []);
        if (!/Version$/.test(name) || prop["$ref"] !== undefined || !type.includes("integer"))
          continue;
        versionProperties += 1;
        expect(prop["maximum"], `${file}: ${name}`).toBe(4294967295);
      }
      for (const value of Object.values(object)) walk(value, file);
    };
    for (const [file, schema] of loadSchemas()) walk(schema, file);
    // inline version fields today: scene.request.haveSnapshotVersion, scene.state.snapshotVersion,
    // session.resumed.snapshotVersion, viewer.joined.snapshotVersion (+ its `then` branch)
    expect(versionProperties).toBeGreaterThanOrEqual(5);
  });

  it("every valid begin fixture is self-consistent: chunkCount = ceil(byteLength / chunkSize), one at 64 KiB", () => {
    const begins = fixtureSet("scene.snapshot.begin").valid.map((v) => v.message) as {
      byteLength: number;
      chunkSize: number;
      chunkCount: number;
    }[];
    for (const b of begins) expect(b.chunkCount).toBe(Math.ceil(b.byteLength / b.chunkSize));
    const small = begins.find((b) => b.chunkSize === 65536 && b.chunkCount > 1);
    expect(small, "a multi-chunk 64 KiB fixture for SRV-09 / WEB-05 / QST-05").toBeDefined();
  });

  it("scene.snapshot.abort.reason enum equals the §6.4 list", () => {
    const doc = readFileSync(PROTOCOL_DOC, "utf8");
    const section = doc.slice(doc.indexOf("### 6.4"), doc.indexOf("### 6.5"));
    const match = /`reason` ∈ `([^`]+)`/.exec(section);
    if (!match) throw new Error("§6.4 `reason` ∈ … list not found in docs/protocol.md");
    const listed = match[1]!.split("|").map((s) => s.trim());
    const defs = loadSchemas().get("defs.schema.json")!.definitions as Record<
      string,
      { enum: string[] }
    >;
    expect(defs.snapshotAbortReason!.enum).toEqual(listed);
    const props = loadSchemas().get("scene.snapshot.abort.schema.json")!.properties as Record<
      string,
      { $ref?: string }
    >;
    expect(props.reason?.$ref).toBe("defs.schema.json#/definitions/snapshotAbortReason");
    const validate = compile(ajv, "scene.snapshot.abort.schema.json");
    const base = fixtureSet("scene.snapshot.abort").valid[0]!.message;
    for (const reason of listed) expect(validate({ ...base, reason }), reason).toBe(true);
  });

  it("scene.snapshot.ack counts are non-negative integers; ready carries the §6.4 fields", () => {
    const ack = compile(ajv, "scene.snapshot.ack.schema.json");
    const ackBase = fixtureSet("scene.snapshot.ack").valid[0]!.message;
    expect(ack({ ...ackBase, viewersStreamed: 0, viewersDeferred: 0 })).toBe(true);
    expect(ack({ ...ackBase, viewersStreamed: -1 })).toBe(false);
    expect(instancePaths(ack.errors)).toContain("/viewersStreamed");
    expect(ack({ ...ackBase, viewersDeferred: 0.5 })).toBe(false);
    const ready = loadSchemas().get("scene.snapshot.ready.schema.json")!;
    expect([...(ready.required as string[])].sort()).toEqual(
      ["type", "sceneVersion", "byteLength", "sha256", "format", "extensionsRequired"].sort(),
    );
  });
});
