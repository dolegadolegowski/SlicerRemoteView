// A real publisher for the component smoke test (WEB-10): the fake-slicer CLI (PRO-13) publishes a fixture to the
// in-process relay stub of tools/fake-slicer (`[stub: SRV-22]` until relay-server is on main). The CLI hands the
// session code out only through file descriptor 3 (NFR-12), so the spec reads it from that pipe — never from stdout,
// stderr or a log — and the page's `/ws` is bridged to the stub, keeping the page's own same-origin URL (ADR 0006).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { startRelayStub } from "@slicerremoteview/fake-slicer/relay-stub";
import type { RelayStub } from "@slicerremoteview/fake-slicer/relay-stub";

// The CLI runs tools/fake-slicer/dist: the Playwright web server builds shared/ and tools/fake-slicer first.
const BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../tools/fake-slicer/bin/fake-slicer.js",
);

export interface Publisher {
  /** The session code, as read from fd 3. */
  readonly code: string;
  readonly stub: RelayStub;
  /** Everything the CLI wrote to stdout and stderr (must never contain the code). */
  output(): string;
  close(): Promise<void>;
}

/** The first line of fd 3 is `<CODE> <JOIN-URL>` (tools/fake-slicer README, `--code-fd`). */
function readCode(child: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let buffer = "";
    const timer = setTimeout(() => fail(new Error("no code within 20 s")), 20_000);
    (child.stdio[3] as Readable).on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      done(buffer.split("\n")[0]!.split(" ")[0]!);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      fail(new Error(`fake-slicer exited with ${status}`));
    });
  });
}

export async function startPublisher(fixture = "asymmetric-2nodes.glb"): Promise<Publisher> {
  // The stub keeps no snapshot cache (the relay will): hold the publisher's frames until a viewer has joined.
  const stub = await startRelayStub({ holdFramesUntilViewers: 1 });
  const child = spawn(
    process.execPath,
    [BIN, "--relay", stub.url, "--fixture", fixture, "--code-fd", "3"],
    { stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  let output = "";
  for (const pipe of [child.stdout, child.stderr]) pipe!.on("data", (d: Buffer) => (output += d));
  const close = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill();
      await exited;
    }
    await stub.close();
  };
  try {
    return { code: await readCode(child), stub, output: () => output, close };
  } catch (error) {
    await close();
    throw new Error(`${(error as Error).message}; fake-slicer said: ${output}`, { cause: error });
  }
}

/** What the page did on its WebSockets, for assertions. */
export interface Traffic {
  /** URLs the page opened its WebSockets to. */
  readonly urls: string[];
  /** Frames the page sent, as text (binary as `<binary>`). */
  readonly sent: string[];
}

/**
 * Bridges the page's `/ws` to the stub with Node's WebSocket: every frame is forwarded both ways unchanged and
 * closes are passed on. Call it before `page.goto`: routes apply to documents loaded afterwards.
 */
export async function bridge(page: Page, stub: RelayStub): Promise<Traffic> {
  const traffic: Traffic = { urls: [], sent: [] };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    traffic.urls.push(ws.url());
    const upstream = new WebSocket(stub.url);
    upstream.binaryType = "arraybuffer";
    const queued: (string | Buffer)[] = [];
    upstream.addEventListener("open", () => queued.splice(0).forEach((m) => upstream.send(m)));
    ws.onMessage((message) => {
      traffic.sent.push(typeof message === "string" ? message : "<binary>");
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else queued.push(message);
    });
    upstream.addEventListener("message", (event) =>
      ws.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer)),
    );
    // 1005/1006 are reported, never sent (RFC 6455 §7.4.1).
    upstream.addEventListener("close", ({ code, reason }) =>
      code === 1005 || code === 1006 ? ws.close() : ws.close({ code, reason }),
    );
    ws.onClose(() => upstream.close());
  });
  return traffic;
}
