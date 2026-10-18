import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY, HELP, parseCliArgs } from "../src/index.js";

const run = (...argv: string[]) => {
  const result = parseCliArgs(argv);
  if (result.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(result)}`);
  return result.options;
};
const error = (...argv: string[]) => {
  const result = parseCliArgs(argv);
  if (result.kind !== "error") throw new Error(`expected error, got ${result.kind}`);
  return result.message;
};

describe("CLI options (PRO-13)", () => {
  it("defaults to the local relay, the mobile profile and no code sink", () => {
    expect(run()).toEqual({
      relay: DEFAULT_RELAY,
      fixture: undefined,
      chunkSize: 1_048_576,
      script: undefined,
      loop: false,
      closeAfterMs: undefined,
      exitAfterAck: false,
      profile: "mobile",
      preferredCode: null,
      codeFd: undefined,
      json: false,
    });
  });

  it("parses every option", () => {
    expect(
      run(
        ...["--relay", "wss://relay.example/ws", "--fixture", "a.glb", "--profile", "quest3"],
        ...["--preferred-code", " 7kq-4x ", "--code-fd", "3", "--json"],
        ...["--chunk-size", "65536", "--script", "move-node", "--loop", "--close-after", "5000"],
      ),
    ).toEqual({
      relay: "wss://relay.example/ws",
      fixture: "a.glb",
      chunkSize: 65536,
      script: "move-node",
      loop: true,
      closeAfterMs: 5000,
      exitAfterAck: false,
      profile: "quest3",
      preferredCode: "7KQ4X",
      codeFd: 3,
      json: true,
    });
  });

  it("--help lists every option", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    for (const flag of [
      "--relay",
      "--fixture",
      "--chunk-size",
      "--exit-after-ack",
      "--script",
      "--loop",
      "--close-after",
      "--profile",
      "--preferred-code",
      "--code-fd",
      "--json",
    ])
      expect(HELP).toContain(flag);
  });

  it("rejects ambiguous session codes with the ADR 0008 hint", () => {
    expect(error("--preferred-code", "7KQ0X")).toMatch(/0 or O/);
    expect(error("--preferred-code", "7KQ1X")).toMatch(/1, I or L/);
    expect(error("--preferred-code", "ABC")).toMatch(/5 characters/);
  });

  it("keeps secrets out of terminals and URLs", () => {
    for (const fd of ["0", "1", "2", "-1", "x", "3.5"])
      expect(error("--code-fd", fd)).toMatch(/--code-fd/);
    expect(error("--json")).toMatch(/--code-fd/);
    expect(error("--relay", "ws://relay.example/ws")).toMatch(/localhost only/);
    expect(error("--relay", "wss://relay.example/ws?code=7KQ4X")).toMatch(/no credentials, query/);
    expect(error("--relay", "https://relay.example/ws")).toMatch(/ws:\/\/ or wss:\/\//);
    expect(error("--relay", "nope")).toMatch(/not a URL/);
    expect(run("--relay", "ws://[::1]:8787/ws").relay).toBe("ws://[::1]:8787/ws");
    expect(run("--relay", "ws://dev.localhost/ws").relay).toBe("ws://dev.localhost/ws");
  });

  it("validates the script options", () => {
    expect(error("--loop")).toMatch(/--loop needs --script/);
    expect(error("--close-after", "-5")).toMatch(/--close-after/);
    expect(error("--close-after", "1.5")).toMatch(/--close-after/);
    expect(error("--exit-after-ack", "--script", "move-node")).toMatch(/cannot be combined/);
    expect(error("--exit-after-ack", "--close-after", "10")).toMatch(/cannot be combined/);
    expect(run("--exit-after-ack").exitAfterAck).toBe(true);
    expect(run("--close-after", "0").closeAfterMs).toBe(0);
  });

  it("accepts chunk sizes 64 KiB … 1 MiB only", () => {
    expect(run("--chunk-size", "1048576").chunkSize).toBe(1_048_576);
    for (const size of ["65535", "1048577", "0", "x", "70000.5"])
      expect(error("--chunk-size", size)).toMatch(/--chunk-size/);
  });

  it("rejects unknown profiles, unknown options and positionals", () => {
    expect(error("--profile", "ps5")).toMatch(/mobile \| quest2 \| quest3/);
    expect(error("--nope")).toMatch(/nope/);
    expect(error("stray")).toMatch(/stray/);
  });
});
