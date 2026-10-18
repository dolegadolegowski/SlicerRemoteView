/**
 * `fake-slicer` entry logic: parse options, connect as publisher, `session.create` → `session.created`,
 * hand the code to `--code-fd` (PRO-13), then stream the fixture GLB as snapshot version 1 and wait for
 * `scene.snapshot.ack` (PRO-14). `--script` then plays update entries (PRO-15; `--loop`, `--close-after`).
 * PRO-16 keeps the session alive: application heartbeat, reconnect with backoff, `session.resume` and the
 * fallback to `session.create{preferredCode}`. Without `--exit-after-ack` the process stays connected until
 * SIGINT, `--close-after` or a fatal close.
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
import { DEFAULT_TIMING, FATAL_CLOSE_CODES, Heartbeat, reconnectDelayMs } from "./resilience.js";
import type { Timing } from "./resilience.js";
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
  /** Heartbeat and reconnect timing (§9.1); tests shorten it. */
  timing?: Partial<Timing>;
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

/** What the publisher needs to continue a session; kept in memory only, never written anywhere (§4.2). */
interface SessionState {
  sessionId: string;
  publisherToken: string;
  code: string;
}

/** A promise that is settled from outside; `ready` is one per connection. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

export async function run(options: Options, io: Io): Promise<number> {
  const timing: Timing = { ...DEFAULT_TIMING, ...io.timing };
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
    const stop = new AbortController(); // ends the script player, timers and reconnect waits
    let socket: WebSocket | undefined;
    let session: SessionState | undefined;
    let exit: number = EXIT.ok;
    let finished = false;
    let acked = false;
    let started = false; // the first snapshot of the run was acknowledged
    let connectionFailed = false;
    let attempt = 0; // consecutive failed reconnects, resets with every completed handshake
    let counter = 0;
    /** `create` = first session.create, `resume` = waiting for resumed/NOT_FOUND, `recreate` = fallback create. */
    let phase: "create" | "resume" | "recreate" = "create";
    /** Last `sceneVersion` this publisher used; the counter is strictly increasing within a session (§8.4). */
    let sceneVersion = 0;
    /** Version of the last snapshot this publisher began, and the GLB it carried (re-sent after a re-create). */
    let snapshotVersion = 0;
    let currentGlb = glb;
    let viewerCount = 0;
    let lateJoinDone = false;
    let ready = deferred();
    let isReady = false;
    let pendingAck:
      { version: number; resolve: () => void; reject: (e: Error) => void } | undefined;
    const nextId = (): string => `p-${++counter}`;
    const heartbeat = new Heartbeat(
      timing,
      (id) => void socket?.send(envelope("ping", id, {})),
      () => {
        io.stderr("no pong in time; reconnecting\n");
        socket?.terminate(); // the close handler reconnects
      },
    );

    const done = (code: number): void => {
      stop.abort();
      ready.resolve(); // releases a script player waiting in online(); it sees the abort and ends
      heartbeat.stop();
      resolve(code);
    };
    const finish = (code: number): void => {
      finished = true;
      exit = code;
      stop.abort();
      if (!socket || socket.readyState === WebSocket.CLOSED) return done(code);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    };
    io.signal?.addEventListener("abort", () => finish(EXIT.ok), { once: true });

    /** `--json` event line on the code fd, after the first `{"code","url"}` line (QA harnesses read it). */
    const emitEvent = (event: Record<string, unknown>): void => {
      if (options.codeFd === undefined || !options.json) return;
      try {
        io.writeFd(options.codeFd, `${JSON.stringify(event)}\n`);
      } catch {
        /* the harness closed its end of the pipe: events are best effort */
      }
    };

    /** Sends a snapshot as the next version and resolves when the relay acknowledged it. */
    const publishSnapshot = async (source: LoadedGlb): Promise<void> => {
      const ws = socket!;
      const version = ++sceneVersion;
      snapshotVersion = version;
      currentGlb = source;
      const acknowledged = new Promise<void>(
        (ok, fail) => (pendingAck = { version, resolve: ok, reject: fail }),
      );
      acknowledged.catch(() => undefined); // a dropped connection rejects it; the sender sees the send error
      const chunks = await sendSnapshot(
        ws,
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

    const sendUpdate = async (type: string, fields: Record<string, unknown>): Promise<void> => {
      const base = sceneVersion;
      sceneVersion = base + 1;
      await sendFrame(socket!, JSON.stringify(updateMessage(type, fields, base, nextId())));
      io.stderr(`${type} ${sceneVersion} sent\n`);
    };

    /** A close frame already moved the socket to CLOSING while `isReady` still waits for the `close` event. */
    const connectionLost = (): boolean => !isReady || socket?.readyState !== WebSocket.OPEN;

    /** Resolves once the current connection has finished its handshake and snapshot resync. */
    const online = async (): Promise<boolean> => {
      while (!stop.signal.aborted) {
        const current = ready;
        await current.promise;
        if (isReady) return true;
      }
      return false;
    };

    /** Plays the script once per pass; entry `afterMs` is the pause since the previous entry (or the ack). */
    const playScript = async (): Promise<void> => {
      do {
        for (const entry of script) {
          if (!(await pause(entry.afterMs, stop.signal))) return;
          if (!(await online())) return;
          try {
            if (entry.type === "scene.snapshot") await publishSnapshot(entry.glb ?? currentGlb);
            else await sendUpdate(entry.type, entry.fields);
          } catch (error) {
            if (!connectionLost()) throw error;
            // connection lost mid-entry: the reconnect resyncs (resume or re-create), this entry is dropped
          }
          if (stop.signal.aborted) return;
        }
      } while (options.loop);
    };

    /** `--late-join-test`: enough viewers are in → one update, then exit 0. */
    const checkLateJoin = (): void => {
      if (
        !options.lateJoinTest ||
        lateJoinDone ||
        !isReady ||
        viewerCount < options.lateJoinViewers
      )
        return;
      lateJoinDone = true;
      const nodeId = currentGlb.nodeIds[0];
      if (nodeId === undefined) {
        io.stderr("late join: the fixture has no node to update\n");
        return finish(EXIT.usage);
      }
      sendUpdate("scene.update", { changes: [{ nodeId, visible: false }] }).then(
        () => finish(EXIT.ok),
        (error: unknown) => {
          if (connectionLost()) {
            lateJoinDone = false; // dropped on the way: try again once the session is back
            return;
          }
          io.stderr(`late join failed: ${(error as Error).message}\n`);
          finish(EXIT.usage);
        },
      );
    };

    /** The first time the session is ready: arm the timers of the run and start the script. */
    const afterFirstSnapshot = (): void => {
      started = true;
      if (options.closeAfterMs !== undefined)
        void pause(options.closeAfterMs, stop.signal).then(async (elapsed) => {
          if (!elapsed) return;
          await sendFrame(
            socket!,
            envelope("session.close", nextId(), { reason: "USER_STOPPED" }),
          ).catch(() => undefined);
          finish(EXIT.ok);
        });
      if (options.disconnectAfterMs !== undefined)
        void pause(options.disconnectAfterMs, stop.signal).then((elapsed) => {
          if (!elapsed) return;
          io.stderr("dropping the connection (--disconnect-after)\n");
          socket?.terminate();
        });
      checkLateJoin();
      if (script.length > 0)
        playScript().catch((error: unknown) => {
          if (finished) return;
          io.stderr(`script failed: ${(error as Error).message}\n`);
          finish(EXIT.usage);
        });
    };

    const markReady = (): void => {
      attempt = 0;
      isReady = true;
      ready.resolve();
      if (!started) afterFirstSnapshot();
      checkLateJoin();
    };

    /** After a handshake: send the (first, re-created or missing) snapshot, then declare the session ready. */
    const syncSnapshot = (needed: boolean): void => {
      if (!needed) return markReady();
      publishSnapshot(currentGlb).then(
        () => {
          acked = true;
          if (options.exitAfterAck) finish(EXIT.ok);
          else markReady();
        },
        (error: unknown) => {
          // dropped mid-upload: the resume that follows sees snapshotVersion null/older and re-sends
          if (finished || socket?.readyState !== WebSocket.OPEN) return;
          io.stderr(`snapshot failed: ${(error as Error).message}\n`);
          finish(EXIT.usage);
        },
      );
    };

    const handshake = (ws: WebSocket): void => {
      const clientInfo = { app: "fake-slicer", version: version(), platform: "fake-slicer / node" };
      if (phase === "resume" && session)
        ws.send(
          envelope("session.resume", nextId(), {
            sessionId: session.sessionId,
            publisherToken: session.publisherToken,
            clientInfo,
            lastSceneVersion: sceneVersion,
          }),
        );
      else
        ws.send(
          envelope("session.create", nextId(), {
            clientInfo,
            // after a failed resume the old code is requested back (§4.3, §13 step 9)
            preferredCode: phase === "recreate" ? session!.code : options.preferredCode,
            profile: options.profile,
          }),
        );
    };

    const onMessage = (ws: WebSocket, data: string): void => {
      const parsed = parseEnvelope(data, inboundValidators());
      if (!parsed.ok) return io.stderr(`relay sent an invalid message: ${parsed.error.code}\n`);
      const message: Message = parsed.value;
      switch (message.type) {
        case "session.created": {
          heartbeat.start();
          const previousCode = session?.code;
          const recreated = previousCode !== undefined;
          session = {
            sessionId: message.sessionId,
            publisherToken: message.publisherToken,
            code: message.code,
          };
          sceneVersion = 0; // a new session restarts at 1 (§8.4)
          snapshotVersion = 0;
          viewerCount = 0;
          if (recreated)
            emitEvent({ event: "session.recreated", codeChanged: message.code !== previousCode });
          if (!recreated || message.code !== previousCode)
            // a relay that did not grant the old code (§4.1) hands out a fresh one: publish it again
            try {
              emitCode(options, io, message.code);
            } catch (error) {
              io.stderr(`--code-fd ${options.codeFd}: ${(error as Error).message}\n`);
              return finish(EXIT.usage);
            }
          syncSnapshot(true);
          break;
        }
        case "session.resumed":
          heartbeat.start();
          sceneVersion = message.sceneVersion; // continue from the relay's counter (§8.4)
          viewerCount = message.viewerCount;
          emitEvent({ event: "session.resumed", viewerCount });
          // the relay cache must hold the snapshot of the scene we are publishing (§4.3)
          syncSnapshot(
            message.snapshotVersion === null || message.snapshotVersion < snapshotVersion,
          );
          break;
        case "pong":
          heartbeat.onPong(message.replyTo);
          break;
        case "viewer.count":
          viewerCount = message.viewerCount;
          emitEvent({ event: "viewer.count", count: viewerCount });
          checkLateJoin();
          break;
        case "scene.snapshot.ack":
          io.stderr(`snapshot ${message.sceneVersion} acknowledged\n`);
          if (pendingAck?.version === message.sceneVersion) pendingAck.resolve();
          break;
        case "error":
          if (message.code === "SESSION_NOT_FOUND" && phase === "resume" && session) {
            // the relay was redeployed: ask for the old code back on the same socket
            phase = "recreate";
            io.stderr("session not found; creating a new session with the old code\n");
            handshake(ws);
            break;
          }
          // the error code only, never session data; a non-conforming relay cannot inject text through it
          io.stderr(
            `relay error: ${/^[A-Z_]{1,32}$/.test(message.code) ? message.code : "UNKNOWN"}\n`,
          );
          finish(EXIT.relayError);
          break;
        default:
          break;
      }
    };

    const onClose = (closeCode: number): void => {
      heartbeat.stop();
      if (isReady) ready = deferred();
      isReady = false;
      pendingAck?.reject(new Error("connection closed"));
      pendingAck = undefined;
      if (finished) return done(exit);
      if (options.exitAfterAck && !acked) {
        // --exit-after-ack promises "0 = acknowledged": a close before the ack is a failure
        io.stderr(`relay closed the connection (code ${closeCode}) before the snapshot ack\n`);
        return done(EXIT.usage);
      }
      if (!session) {
        if (!connectionFailed)
          io.stderr(
            `relay closed the connection (code ${closeCode}) before the session was created\n`,
          );
        return done(EXIT.usage); // nothing to resume: the first connection must work
      }
      if (FATAL_CLOSE_CODES.has(closeCode)) {
        io.stderr(`relay closed the connection (code ${closeCode}); not reconnecting\n`);
        return done(EXIT.relayError);
      }
      const delay = reconnectDelayMs(closeCode, attempt++, timing);
      io.stderr(`connection lost (code ${closeCode}); reconnecting in ${delay} ms\n`);
      void pause(delay, stop.signal).then((elapsed) => {
        if (!elapsed) return done(exit);
        phase = "resume";
        connect();
      });
    };

    function connect(): void {
      const ws = new WebSocket(options.relay, { perMessageDeflate: false });
      socket = ws;
      ws.on("open", () => {
        if (socket !== ws) return;
        handshake(ws);
      });
      ws.on("message", (data, isBinary) => {
        if (socket === ws && !isBinary) onMessage(ws, data.toString());
      });
      ws.on("error", (error) => {
        if (finished || socket !== ws) return; // aborted while connecting: ws reports the terminated handshake
        connectionFailed = true;
        io.stderr(`connection failed: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`);
      });
      ws.on("close", (closeCode) => {
        if (socket === ws) onClose(closeCode);
      });
    }

    connect();
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
