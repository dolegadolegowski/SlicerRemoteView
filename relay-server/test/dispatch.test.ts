import { describe, expect, it } from "vitest";
import { defaultSchemas } from "@slicerremoteview/shared";
import type { Validators } from "@slicerremoteview/shared";
import type { Connection } from "../src/ws/connection.js";
import { createDispatcher, MAX_INSTANCE_PATH_LENGTH } from "../src/ws/dispatch.js";
import { readFrame } from "../src/ws/frame.js";
import { ManualClock } from "./helpers/manual-clock.js";

/** Records what the dispatcher sends; just enough of `Connection` for these unit tests. */
function fakeConnection(role: "publisher" | "viewer") {
  const sent: Record<string, unknown>[] = [];
  const connection = {
    role,
    bound: true,
    violations: 0,
    offences: 0,
    sendError: (code: string, message: string, options: Record<string, unknown> = {}) =>
      sent.push({ code, message, ...options }),
    violation: (code: string, message: string, options: Record<string, unknown> = {}) =>
      sent.push({ code, message, ...options }),
    fail: (
      code: string,
      message: string,
      closeCode: number,
      options: Record<string, unknown> = {},
    ) => sent.push({ code, message, closeCode, ...options }),
    send: (message: Record<string, unknown>) => sent.push(message),
  };
  return { connection: connection as unknown as Connection, sent };
}

describe("createDispatcher (unit)", () => {
  it(`caps an echoed details.instancePath at ${MAX_INSTANCE_PATH_LENGTH} characters`, () => {
    const real = defaultSchemas();
    const longPath = `/${"k".repeat(300)}`;
    // A validator for `ping` that fails with a very long JSON Pointer (no 1.0 schema produces one
    // for client messages today; this is the defence in depth).
    const failing = Object.assign(() => false, {
      errors: [{ instancePath: longPath, keyword: "type", message: "must be string" }],
    });
    const validators = {
      ...real,
      byType: new Map<string, unknown>([...real.byType, ["ping", failing]]),
    } as unknown as Validators;
    const dispatch = createDispatcher({ clock: new ManualClock(), validators });
    const { connection, sent } = fakeConnection("viewer");
    void dispatch(
      connection,
      readFrame(JSON.stringify({ protocolVersion: "1.0", type: "ping", id: "p-1" })),
    );
    expect(sent).toHaveLength(1);
    const { details } = sent[0] as { details: { instancePath: string } };
    expect(sent[0]).toMatchObject({ code: "INVALID_MESSAGE", replyTo: "p-1" });
    expect(details.instancePath).toBe(longPath.slice(0, MAX_INSTANCE_PATH_LENGTH));
  });
});
