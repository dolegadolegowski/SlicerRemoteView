import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, createAjv, loadSchemas, PROTOCOL_DOC } from "./helpers.js";

const ajv = createAjv();
const defs = compile(ajv, "defs.schema.json");
const envelope = compile(ajv, "envelope.schema.json");
const defsSchema = loadSchemas().get("defs.schema.json")!;

/** Validate `value` against one entry of `defs.schema.json#/definitions`. */
function def(name: string) {
  const validate = ajv.getSchema(
    `https://slicerremoteview.dev/schema/defs.schema.json#/definitions/${name}`,
  );
  if (!validate) throw new Error(`no definition ${name}`);
  return validate;
}

describe("defs + envelope schemas (PRO-02)", () => {
  it("compile in Ajv 2020-12 strict mode with every $ref resolved", () => {
    expect(typeof defs).toBe("function");
    expect(typeof envelope).toBe("function");
    for (const name of Object.keys(defsSchema.definitions ?? {}))
      expect(def(name)).toBeTypeOf("function");
  });

  it("stay inside the draft-07-compatible subset agreed in the generator spike", () => {
    const forbidden = new Set(["$defs", "unevaluatedProperties", "$dynamicRef", "$dynamicAnchor"]);
    const walk = (node: unknown, file: string): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, file));
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        expect(forbidden.has(key), `${file}: keyword ${key}`).toBe(false);
        if (key === "$ref") expect(value, file).not.toContain("/$defs/");
        if (key !== "description" && key !== "$comment") walk(value, file);
      }
    };
    for (const [file, schema] of loadSchemas()) {
      expect(schema.$schema, file).toBe("https://json-schema.org/draft/2020-12/schema");
      walk(schema, file);
    }
  });

  it("code pattern accepts the 31-symbol alphabet only (FR-66, ADR 0008)", () => {
    const code = def("code");
    expect(code("7KQ4X")).toBe(true);
    expect(code("23456")).toBe(true);
    expect(code("ZYXWV")).toBe(true);
    for (const bad of [
      "7KQ40",
      "7KQ4O",
      "7KQ41",
      "7KQ4I",
      "7KQ4L",
      "7kq4x",
      "7KQ4",
      "7KQ4XX",
      " 7KQ4X",
    ]) {
      expect(code(bad), bad).toBe(false);
    }
  });

  it("envelope requires protocolVersion 1.x and type, bounds id/replyTo/ts, keeps unknown fields", () => {
    expect(envelope({ protocolVersion: "1.0", type: "ping" })).toBe(true);
    expect(
      envelope({ protocolVersion: "1.7", type: "scene.snapshot.begin", id: "p-1", ts: 1 }),
    ).toBe(true);
    expect(envelope({ protocolVersion: "1.0", type: "ping", futureField: { nested: true } })).toBe(
      true,
    );
    expect(envelope({ protocolVersion: "2.0", type: "ping" })).toBe(false);
    expect(envelope({ protocolVersion: "1", type: "ping" })).toBe(false);
    expect(envelope({ type: "ping" })).toBe(false);
    expect(envelope({ protocolVersion: "1.0" })).toBe(false);
    expect(envelope({ protocolVersion: "1.0", type: "ping", id: "x".repeat(33) })).toBe(false);
    expect(envelope({ protocolVersion: "1.0", type: "ping", replyTo: "" })).toBe(false);
    expect(envelope({ protocolVersion: "1.0", type: "ping", ts: 1.5 })).toBe(false);
    expect(envelope({ protocolVersion: "1.0", type: "ping", ts: "1792238400000" })).toBe(false);
  });

  it("errorCode enum equals the §9.2 table of docs/protocol.md", () => {
    const doc = readFileSync(PROTOCOL_DOC, "utf8");
    const section = doc.slice(doc.indexOf("### 9.2 `error` message"), doc.indexOf("### 9.3"));
    const codesInDoc = [...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    const enumeration = (defsSchema.definitions?.errorCode as { enum: string[] }).enum;
    expect(codesInDoc).toHaveLength(15);
    expect(enumeration).toEqual(codesInDoc);
  });

  it("nodeId, token, sha256, color, matrix follow §3.3 / §4.2 / §6", () => {
    expect(def("nodeId")("vtkMRMLModelNode4")).toBe(true);
    expect(def("nodeId")("a".repeat(129))).toBe(false);
    expect(def("nodeId")("bad id")).toBe(false);
    expect(def("token")("pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA")).toBe(true);
    expect(def("token")("short")).toBe(false);
    expect(def("token")("x".repeat(43) + "=")).toBe(false);
    expect(def("sha256")("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe(
      true,
    );
    expect(def("sha256")("9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08")).toBe(
      false,
    );
    expect(def("color")([0, 0.5, 1])).toBe(true);
    expect(def("color")([0, 0.5, 1.5])).toBe(false);
    expect(def("color")([0, 0.5])).toBe(false);
    expect(def("matrix")(Array<number>(16).fill(0))).toBe(true);
    expect(def("matrix")(Array<number>(12).fill(0))).toBe(false);
  });

  it("every property used in a oneOf/anyOf/if/then branch is declared in the enclosing properties (generator rule)", () => {
    // shared/README.md: branches only repeat required/forbidden sets; shapes live in `properties`.
    const check = (schema: Record<string, unknown>, file: string, path: string): void => {
      const props = Object.keys((schema.properties as object | undefined) ?? {});
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        for (const [i, branch] of (
          (schema[key] as Record<string, unknown>[] | undefined) ?? []
        ).entries()) {
          if ("$ref" in branch) continue;
          for (const name of (branch.required as string[] | undefined) ?? [])
            expect(props, `${file} ${path}/${key}/${i}: ${name}`).toContain(name);
        }
      }
      for (const key of ["then", "else"]) {
        const branch = schema[key] as Record<string, unknown> | undefined;
        for (const name of (branch?.required as string[] | undefined) ?? [])
          expect(props, `${file} ${path}/${key}: ${name}`).toContain(name);
      }
      for (const [name, sub] of Object.entries(
        (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {},
      ))
        check(sub, file, `${path}/properties/${name}`);
      if (schema.items && typeof schema.items === "object")
        check(schema.items as Record<string, unknown>, file, `${path}/items`);
      for (const [name, sub] of Object.entries(
        (schema.definitions as Record<string, Record<string, unknown>> | undefined) ?? {},
      ))
        check(sub, file, `${path}/definitions/${name}`);
    };
    for (const [file, schema] of loadSchemas()) check(schema, file, "#");
  });
});
