import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture(): { lines: () => Record<string, unknown>[]; write: (s: string) => void } {
  const raw: string[] = [];
  return {
    write: (s) => raw.push(s),
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("writes one JSON object per line with level label, time and message", () => {
    const out = capture();
    createLogger({ level: "info", destination: out }).info({ sessionId: "sess_1" }, "hello");
    const [line] = out.lines();
    expect(line).toEqual({
      level: "info",
      time: expect.any(Number),
      message: "hello",
      sessionId: "sess_1",
    });
  });

  it("censors codes and tokens at the top level and one level deep", () => {
    const out = capture();
    createLogger({ level: "trace", destination: out }).warn(
      {
        code: "7KQ4X",
        preferredCode: "ABCDE",
        publisherToken: "pt_SECRET",
        viewerToken: "vt_SECRET",
        token: "SECRET",
        msg: { code: "7KQ4X", viewerToken: "vt_SECRET", rawPacket: { data: [1, 2, 3] } },
        req: { headers: { authorization: "Bearer vt_SECRET" } },
        errorCode: "INVALID_CODE",
      },
      "attempt",
    );
    const text = JSON.stringify(out.lines());
    expect(text).not.toMatch(/7KQ4X|ABCDE|SECRET|\[1,2,3\]/);
    expect(out.lines()[0]).toMatchObject({ errorCode: "INVALID_CODE", code: "[redacted]" });
  });

  it("respects the level", () => {
    const out = capture();
    const logger = createLogger({ level: "warn", destination: out });
    logger.info("dropped");
    logger.error("kept");
    expect(out.lines().map((l) => l.message)).toEqual(["kept"]);
  });
});
