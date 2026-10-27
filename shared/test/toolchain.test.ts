import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../ts/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("shared toolchain (PRO-01)", () => {
  it("announces a protocol version that docs/protocol.md defines: same major, not a newer minor", () => {
    // Revision 1.1 of the document changes no wire format (§2), so the libraries keep announcing "1.0" until PRO-22
    // switches them together with relay and publisher; both values are valid for every receiver.
    const protocolDoc = readFileSync(resolve(here, "../../docs/protocol.md"), "utf8");
    const match = /Protocol version `(\d+)\.(\d+)`/.exec(protocolDoc);
    expect(match).not.toBeNull();
    const [major, minor] = [Number(match![1]), Number(match![2])];
    const [announcedMajor, announcedMinor] = PROTOCOL_VERSION.split(".").map(Number);
    expect(announcedMajor).toBe(major);
    expect(announcedMinor).toBeLessThanOrEqual(minor);
  });

  it("has no runtime dependency other than the schema validator", () => {
    const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["ajv"]);
  });
});
