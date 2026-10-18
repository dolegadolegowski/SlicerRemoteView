import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../ts/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("shared toolchain (PRO-01)", () => {
  it("exports the protocol version declared in docs/protocol.md", () => {
    const protocolDoc = readFileSync(resolve(here, "../../docs/protocol.md"), "utf8");
    const match = /Protocol version `(\d+\.\d+)`/.exec(protocolDoc);
    expect(match?.[1]).toBe(PROTOCOL_VERSION);
  });

  it("has no runtime dependency other than the schema validator", () => {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["ajv"]);
  });
});
