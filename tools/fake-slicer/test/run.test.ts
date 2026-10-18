import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_PATTERN } from "@slicerremoteview/shared";
import { EXIT, joinUrl, main, startRelayStub } from "../src/index.js";
import type { Io, RelayStub } from "../src/index.js";

let stub: RelayStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

/** An `Io` that records everything; `fds` plays the role of the pipe behind `--code-fd`. */
function fakeIo() {
  const controller = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const fds = new Map<number, string>();
  const io: Io = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    writeFd: (fd, text) => {
      fds.set(fd, (fds.get(fd) ?? "") + text);
      controller.abort(); // the code arrived: end the run like SIGINT
    },
    signal: controller.signal,
  };
  return { io, out, err, fds, controller };
}

describe("fake-slicer main (PRO-13)", () => {
  it("--help prints the options and exits 0 without connecting", async () => {
    const { io, out } = fakeIo();
    expect(await main(["--help"], io)).toBe(EXIT.ok);
    expect(out.join("")).toMatch(/--relay <url>[\s\S]*--code-fd <n>/);
  });

  it("a usage error prints help to stderr and exits 1", async () => {
    const { io, err } = fakeIo();
    expect(await main(["--code-fd", "1"], io)).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/--code-fd: expected an integer >= 3/);
  });

  it("connects to the stub, creates a session and writes the code only to --code-fd", async () => {
    stub = await startRelayStub();
    const { io, out, err, fds } = fakeIo();
    expect(
      await main(["--relay", stub.url, "--code-fd", "3", "--preferred-code", "7kq4x"], io),
    ).toBe(EXIT.ok);
    expect(fds.get(3)).toBe(`7KQ4X http://127.0.0.1:${stub.port}/j#7KQ4X\n`);
    expect(out.join("") + err.join("")).not.toMatch(/7KQ4X/);
  });

  it("--json writes one JSON object to the fd", async () => {
    stub = await startRelayStub();
    const { io, fds } = fakeIo();
    await main(["--relay", stub.url, "--code-fd", "4", "--json"], io);
    const line = JSON.parse(fds.get(4)!) as { code: string; url: string };
    expect(line.code).toMatch(CODE_PATTERN);
    expect(line.url).toBe(`http://127.0.0.1:${stub.port}/j#${line.code}`);
  });

  it("reports a relay error by code and exits 2, without session data", async () => {
    stub = await startRelayStub();
    const first = fakeIo();
    first.io.writeFd = () => {}; // keep the first publisher connected
    const running = main(["--relay", stub.url, "--code-fd", "3"], first.io);
    await vi.waitFor(() => expect(stub?.code).toBeDefined(), { timeout: 2000 });
    const second = fakeIo();
    expect(await main(["--relay", stub.url], second.io)).toBe(EXIT.relayError);
    expect(second.err.join("")).toBe("relay error: CAPACITY\n");
    first.controller.abort();
    await running;
  });

  it("an abort before the socket opens ends quietly with exit 0", async () => {
    stub = await startRelayStub();
    const { io, err, controller } = fakeIo();
    const running = main(["--relay", stub.url], io);
    controller.abort();
    expect(await running).toBe(EXIT.ok);
    expect(err).toEqual([]);
  });

  it("reports an unreachable relay without crashing", async () => {
    const { io, err } = fakeIo();
    expect(await main(["--relay", "ws://127.0.0.1:1/ws"], io)).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/connection failed: ECONNREFUSED/);
  });

  it("builds the join URL with the code in the fragment", () => {
    expect(joinUrl("ws://localhost:8787/ws", "7KQ4X")).toBe("http://localhost:8787/j#7KQ4X");
    expect(joinUrl("wss://relay.example/ws", "7KQ4X")).toBe("https://relay.example/j#7KQ4X");
  });
});
