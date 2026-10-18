/**
 * `fake-slicer` entry logic: parse options, connect as publisher, `session.create` → `session.created`,
 * hand the code to `--code-fd` (PRO-13), then stream the fixture GLB as snapshot version 1 and wait for
 * `scene.snapshot.ack` (PRO-14). `--script` then plays update entries (PRO-15; `--loop`, `--close-after`);
 * reconnects arrive with PRO-16. Without `--exit-after-ack` the process stays connected until SIGINT,
 * `--close-after` or relay close.
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
import { loadScript, scriptDuration, updateMessage } from "./script.js";
import type { ScriptEntry } from "./script.js";
import { envelope, sendFrame, sendSnapshot } from "./snapshot.js";

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

/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts (the timer is cleared either way). */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function run(options: Options, io: Io): Promise<number> {
  let glb: LoadedGlb;
  let script: ScriptEntry[] = [];
  try {
    glb = await loadGlb(resolveFixture(options.fixture));
    if (options.script !== undefined) script = await loadScript(options.script);
    if (options.loop && scriptDuration(script) === 0)
      throw new Error("--loop needs a script with at least one non-zero afterMs");
  } catch (error) {
    io.stderr(`fake-slicer: ${(error as Error).message}\n`);
    return EXIT.usage;
  }
  if (io.signal?.aborted) return EXIT.ok;
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(options.relay, { perMessageDeflate: false });
    const stop = new AbortController(); // ends the script player and the --close-after timer
    let exit: number = EXIT.ok;
    let finished = false;
    let acked = false;
    let counter = 0;
    /** Last `sceneVersion` this publisher used; the counter is strictly increasing (§8.4). */
    let sceneVersion = 0;
    let pendingAck: { version: number; resolve: () => void } | undefined;
    const nextId = (): string => `p-${++counter}`;
    const finish = (code: number): void => {
      finished = true;
      exit = code;
      stop.abort();
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    };
    io.signal?.addEventListener("abort", () => finish(EXIT.ok), { once: true });

    /** Sends a snapshot as the next version and resolves when the relay acknowledged it. */
    const publishSnapshot = async (source: LoadedGlb): Promise<void> => {
      const version = ++sceneVersion;
      const acknowledged = new Promise<void>((done) => (pendingAck = { version, resolve: done }));
      const chunks = await sendSnapshot(
        socket,
        {
          glb: source,
          sceneVersion: version,
          chunkSize: options.chunkSize,
          profile: options.profile,
        },
        nextId,
      );
      io.stderr(`snapshot ${version}: ${source.bytes.byteLength} bytes in ${chunks} chunks sent\n`);
      await acknowledged;
    };

    /** Plays the script once per pass; entry `afterMs` is the pause since the previous entry (or the ack). */
    const playScript = async (): Promise<void> => {
      do {
        for (const entry of script) {
          if (!(await pause(entry.afterMs, stop.signal))) return;
          if (entry.type === "scene.snapshot") await publishSnapshot(entry.glb ?? glb);
          else {
            const base = sceneVersion;
            sceneVersion = base + 1;
            await sendFrame(
              socket,
              JSON.stringify(updateMessage(entry.type, entry.fields, base, nextId())),
            );
            io.stderr(`${entry.type} ${sceneVersion} sent\n`);
          }
          if (stop.signal.aborted) return;
        }
      } while (options.loop);
    };

    /** After the first snapshot ack: arm `--close-after`, start the script. */
    const afterFirstSnapshot = (): void => {
      if (options.closeAfterMs !== undefined)
        void pause(options.closeAfterMs, stop.signal).then(async (elapsed) => {
          if (!elapsed) return;
          await sendFrame(
            socket,
            envelope("session.close", nextId(), { reason: "USER_STOPPED" }),
          ).catch(() => undefined);
          finish(EXIT.ok);
        });
      if (script.length > 0)
        playScript().catch((error: unknown) => {
          if (finished) return;
          io.stderr(`script failed: ${(error as Error).message}\n`);
          finish(EXIT.usage);
        });
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
        publishSnapshot(glb).then(
          () => {
            acked = true;
            if (options.exitAfterAck) finish(EXIT.ok);
            else afterFirstSnapshot();
          },
          (error: unknown) => {
            if (finished) return;
            io.stderr(`snapshot failed: ${(error as Error).message}\n`);
            finish(EXIT.usage);
          },
        );
      } else if (message.type === "scene.snapshot.ack") {
        io.stderr(`snapshot ${message.sceneVersion} acknowledged\n`);
        if (pendingAck?.version === message.sceneVersion) pendingAck.resolve();
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
      stop.abort();
      if (!finished && options.exitAfterAck && !acked) {
        // --exit-after-ack promises "0 = acknowledged": a close before the ack is a failure
        io.stderr(`relay closed the connection (code ${closeCode}) before the snapshot ack\n`);
        exit = EXIT.usage;
      }
      finished = true; // later send failures are consequences of this close, not new errors
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
