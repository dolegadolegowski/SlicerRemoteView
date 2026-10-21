import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultSchemas, parseEnvelope } from "@slicerremoteview/shared";
import { checkEnvelope, readFrame } from "../src/ws/frame.js";

const MESSAGES = new URL("../../shared/fixtures/messages/", import.meta.url);

/** Every message of `shared/fixtures/messages/<type>/*.json`, valid and invalid, as frame text. */
function fixtureTexts(): [string, string][] {
  const texts: [string, string][] = [];
  for (const type of readdirSync(MESSAGES)) {
    if (!statSync(new URL(type, MESSAGES)).isDirectory()) continue; // e.g. expected.json
    const dir = new URL(`${type}/`, MESSAGES);
    for (const file of readdirSync(dir)) {
      const data = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, unknown>;
      const message = "expect" in data && "message" in data ? data.message : data;
      texts.push([`${type}/${file}`, JSON.stringify(message)]);
    }
  }
  return texts;
}

const CRAFTED: [string, string][] = [
  ["not JSON", "{"],
  ["empty", ""],
  ["a number", "17"],
  ["null", "null"],
  ["an array", '[{"protocolVersion":"1.0","type":"ping"}]'],
  ["major 2", '{"protocolVersion":"2.0","type":"ping"}'],
  ["major 2, unknown type", '{"protocolVersion":"2.3","type":"session.open"}'],
  ["major 0", '{"protocolVersion":"0.9","type":"ping"}'],
  ["malformed version", '{"protocolVersion":"1","type":"ping"}'],
  ["version not a string", '{"protocolVersion":2,"type":"ping"}'],
  ["minor 7", '{"protocolVersion":"1.7","type":"ping"}'],
  ["no type", '{"protocolVersion":"1.0"}'],
  ["unknown type", '{"protocolVersion":"1.0","type":"scene.teleport","id":"x-1"}'],
  ["id too long", `{"protocolVersion":"1.0","type":"ping","id":"${"i".repeat(33)}"}`],
  ["id of 32 code points", `{"protocolVersion":"1.0","type":"ping","id":"${"😀".repeat(32)}"}`],
  ["unknown field", '{"protocolVersion":"1.0","type":"ping","extra":{"a":[1,2]}}'],
];

describe("checkEnvelope (parse once)", () => {
  const validators = defaultSchemas();

  it.each([...fixtureTexts(), ...CRAFTED])(
    "%s: same result as parseEnvelope of the text",
    (_name, text) => {
      expect(checkEnvelope(readFrame(text), validators)).toEqual(parseEnvelope(text, validators));
    },
  );
});

describe("readFrame", () => {
  it("peeks type and id of an object frame, valid or not", () => {
    expect(readFrame('{"type":"session.create","id":"p-1","nonsense":true}')).toMatchObject({
      json: true,
      type: "session.create",
      id: "p-1",
    });
  });

  it.each([
    ["not JSON", "{", false],
    ["an array", '["ping"]', true],
    ["null", "null", true],
    ["a string", '"ping"', true],
  ])("%s: no type, no id", (_name, text, json) => {
    const frame = readFrame(text);
    expect(frame.json).toBe(json);
    expect(frame.type).toBeUndefined();
    expect(frame.id).toBeUndefined();
    expect(frame.text).toBe(text);
  });

  it.each([
    ["", undefined],
    ["a".repeat(32), "a".repeat(32)],
    ["a".repeat(33), undefined],
    ["😀".repeat(32), "😀".repeat(32)],
    ["😀".repeat(33), undefined],
    [17, undefined],
  ])("echoes only an id the envelope schema accepts: %j", (id, expected) => {
    expect(readFrame(JSON.stringify({ type: "ping", id })).id).toBe(expected);
  });

  it("calls JSON.parse once per frame", () => {
    const text = JSON.stringify({ protocolVersion: "1.0", type: "session.create", x: [[[1]]] });
    const parse = JSON.parse;
    let calls = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === text) calls += 1;
      return parse(...args);
    }) as typeof JSON.parse;
    try {
      checkEnvelope(readFrame(text), defaultSchemas());
    } finally {
      JSON.parse = parse;
    }
    expect(calls).toBe(1);
  });
});
