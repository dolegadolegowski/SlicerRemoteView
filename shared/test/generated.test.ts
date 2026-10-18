import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { bundleSchemas } from "../scripts/lib/bundle.mjs";
import { MESSAGE_TYPES } from "../ts/index.js";
import type {
  AnyMessage,
  ErrorCode,
  ErrorMessage,
  Message,
  MessageOfType,
  MessageType,
  SceneUpdate,
  ViewerJoin,
  ERROR_CODES,
} from "../ts/index.js";
import { SCHEMA_DIR } from "./helpers.js";

const messagesTs = readFileSync(resolve(__dirname, "../ts/generated/messages.ts"), "utf8");
const { bundle, messageNames, typeByName } = bundleSchemas(SCHEMA_DIR);

describe("generated message types (PRO-11)", () => {
  it("the bundle has one PascalCase definition per v1.0 message type, the envelope inlined", () => {
    expect(messageNames).toHaveLength(MESSAGE_TYPES.length);
    expect(Object.values(typeByName).sort()).toEqual([...MESSAGE_TYPES]);
    expect(typeByName["ErrorMessage"]).toBe("error"); // `Error` would shadow the global
    const definitions = bundle.definitions as Record<string, Record<string, unknown>>;
    for (const name of messageNames) {
      const schema = definitions[name]!;
      expect(schema["$id"], name).toBeUndefined();
      expect(JSON.stringify(schema), name).not.toContain("envelope.schema.json");
      expect(Object.keys(schema["properties"] as object), name).toEqual(
        expect.arrayContaining(["protocolVersion", "type"]),
      );
      expect(schema["required"], name).toEqual(expect.arrayContaining(["protocolVersion", "type"]));
    }
    expect(JSON.stringify(bundle)).not.toMatch(/"\$ref":\s*"(?!#\/definitions\/)/);
  });

  it("messages.ts declares every message and lists it in AnyMessage", () => {
    const union = /export type AnyMessage =([^;]+);/.exec(messagesTs)![1]!;
    const members = union
      .split("|")
      .map((m) => m.trim())
      .filter(Boolean);
    expect(members.sort()).toEqual([...messageNames].sort());
    for (const name of messageNames)
      expect(messagesTs, name).toMatch(new RegExp(`export (interface|type) ${name}\\b`));
    expect(messagesTs).not.toMatch(/:\s*(any|unknown)\b/); // payloads are fully typed
  });

  it("is typed per message type (compile-time, checked by `npm run typecheck`)", () => {
    expectTypeOf<Message>().toEqualTypeOf<AnyMessage>();
    expectTypeOf<AnyMessage["type"]>().toEqualTypeOf<MessageType>();
    expectTypeOf<MessageOfType<"scene.update">>().toEqualTypeOf<SceneUpdate>();
    expectTypeOf<MessageOfType<"error">>().toEqualTypeOf<ErrorMessage>();
    expectTypeOf<SceneUpdate["changes"]>().toBeArray();
    expectTypeOf<SceneUpdate["type"]>().toEqualTypeOf<"scene.update">();
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[number]>();
    // viewer.join: exactly one of code | sessionId + viewerToken (§5.1)
    expectTypeOf<ViewerJoin>().toExtend<{ clientInfo: object }>();
    const join: ViewerJoin = {
      protocolVersion: "1.0",
      type: "viewer.join",
      code: "7KQ4X",
      clientInfo: { app: "web-viewer", version: "0.1.0", platform: "web" },
    };
    expect(join.type).toBe("viewer.join");
  });

  it("narrows by the type discriminator", () => {
    const describeMessage = (m: AnyMessage): number => {
      switch (m.type) {
        case "scene.update":
          return m.changes.length;
        case "error":
          return m.message.length;
        default:
          return 0;
      }
    };
    const update: SceneUpdate = {
      protocolVersion: "1.0",
      type: "scene.update",
      sceneVersion: 2,
      baseVersion: 1,
      changes: [{ nodeId: "n1", visible: false }],
    };
    expect(describeMessage(update)).toBe(1);
  });
});
