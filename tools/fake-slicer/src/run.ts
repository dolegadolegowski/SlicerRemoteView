/**
 * `fake-slicer` entry logic: parse options, connect as publisher, `session.create` → `session.created`,
 * hand the code to `--code-fd` (PRO-13), then stream the fixture GLB as snapshot version 1 and wait for
 * `scene.snapshot.ack` (PRO-14). Update scripts arrive with PRO-15 and reconnects with PRO-16; until then
 * the process stays connected after the ack until SIGINT, relay close or `--exit-after-ack`.
 *
 * Session codes and tokens are never written to stdout/stderr (NFR-12): the only sink is the `--code-fd` file
 * descriptor, which the SRV-22 / WEB-10 / QA-02 harnesses read through a pipe.
 */
import { readFileSync, writeSync } from "node:fs";
import { compileSchemas, parseEnvelope } from "@slicerremoteview/shared";
import type { Message, Validators } from "@slicerremoteview/shared";
import { WebSocket } from "ws";
import { loadGlb, resolveFixture } from "./glb.js";
import type { LoadedGlb } from "./glb.js";
import { HELP, parseCliArgs } from "./options.js";
import type { Options } from "./options.js";
import { envelope, sendSnapshot } from "./snapshot.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Writes to an already-open file descriptor (`--code-fd`); throws when it is not open. */
  writeFd(fd: number, text: string): void;
  /** Aborting ends the run like SIGINT. */
  signal?: AbortSignal;
}

export const nodeIo: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  writeFd: (fd, text) => void writeSync(fd, text),
};

/** Exit codes: 0 ok, 1 usage or local failure, 2 the relay answered with an `error`. */
export const EXIT = { ok: 0, usage: 1, relayError: 2 } as const;

const version = (): string => {
  const url = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
};

/** `ws://host:8787/ws` → `http://host:8787/j#CODE`; the code travels in the fragment only (§10). */
export function joinUrl(relay: string, code: string): string {
  const url = new URL(relay);
  return `${url.protocol === "wss:" ? "https" : "http"}://${url.host}/j#${code}`;
}

function emitCode(options: Options, io: Io, code: string): void {
  if (options.codeFd === undefined) return;
  const url = joinUrl(options.relay, code);
  io.writeFd(
    options.codeFd,
    options.json ? `${JSON.stringify({ code, url })}\n` : `${code} ${url}\n`,
  );
}

let validators: Validators | undefined; // compiled on first use: importing the stub alone stays cheap
const inboundValidators = (): Validators =>
  (validators ??= compileSchemas({ tolerateUnknownEnums: true })); // inbound relay messages (§14)

export async function run(options: Options, io: Io): Promise<number> {
  let glb: LoadedGlb;
  try {
    glb = await loadGlb(resolveFixture(options.fixture));
  } catch (error) {
    io.stderr(`fake-slicer: ${(error as Error).message}\n`);
    return EXIT.usage;
  }
  if (io.signal?.aborted) return EXIT.ok;
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(options.relay, { perMessageDeflate: false });
    let exit: number = EXIT.ok;
    let finished = false;
    let acked = false;
    let counter = 0;
    const nextId = (): string => `p-${++counter}`;
    const finish = (code: number): void => {
      finished = true;
      exit = code;
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    };
    io.signal?.addEventListener("abort", () => finish(EXIT.ok), { once: true });
    const startSnapshot = (): void => {
      const sceneVersion = 1;
      sendSnapshot(
        socket,
        { glb, sceneVersion, chunkSize: options.chunkSize, profile: options.profile },
        nextId,
      ).then(
        (chunks) =>
          io.stderr(
            `snapshot ${sceneVersion}: ${glb.bytes.byteLength} bytes in ${chunks} chunks sent\n`,
          ),
        (error: unknown) => {
          if (finished) return;
          io.stderr(`snapshot failed: ${(error as Error).message}\n`);
          finish(EXIT.usage);
        },
      );
    };
    socket.on("open", () =>
      socket.send(
        envelope("session.create", nextId(), {
          clientInfo: { app: "fake-slicer", version: version(), platform: "fake-slicer / node" },
          preferredCode: options.preferredCode,
          profile: options.profile,
        }),
      ),
    );
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseEnvelope(data.toString(), inboundValidators());
      if (!parsed.ok) return io.stderr(`relay sent an invalid message: ${parsed.error.code}\n`);
      const message: Message = parsed.value;
      if (message.type === "session.created") {
        try {
          emitCode(options, io, message.code);
        } catch (error) {
          io.stderr(`--code-fd ${options.codeFd}: ${(error as Error).message}\n`);
          return finish(EXIT.usage);
        }
        startSnapshot();
      } else if (message.type === "scene.snapshot.ack" && message.sceneVersion === 1) {
        acked = true;
        io.stderr(`snapshot ${message.sceneVersion} acknowledged\n`);
        if (options.exitAfterAck) finish(EXIT.ok);
      } else if (message.type === "error") {
        // the error code only, never session data; a non-conforming relay cannot inject text through it
        io.stderr(
          `relay error: ${/^[A-Z_]{1,32}$/.test(message.code) ? message.code : "UNKNOWN"}\n`,
        );
        finish(EXIT.relayError);
      }
    });
    socket.on("error", (error) => {
      if (finished) return; // aborted while connecting: ws reports the terminated handshake as an error
      io.stderr(`connection failed: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`);
      exit = EXIT.usage;
    });
    socket.on("close", (closeCode) => {
      if (!finished && options.exitAfterAck && !acked) {
        // --exit-after-ack promises "0 = acknowledged": a close before the ack is a failure
        io.stderr(`relay closed the connection (code ${closeCode}) before the snapshot ack\n`);
        exit = EXIT.usage;
      }
      resolve(exit);
    });
  });
}

export async function main(argv: readonly string[], io: Io = nodeIo): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (parsed.kind === "error") {
    io.stderr(`fake-slicer: ${parsed.message}\n\n${HELP}`);
    return EXIT.usage;
  }
  return run(parsed.options, io);
}
