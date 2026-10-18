/**
 * Minimal in-process relay for tests (PRO-13; `[stub allowed]` target for WEB-10 until `relay-server` lands).
 *
 * Accepts one publisher (`session.create`), answers `session.created` with a code from the protocol
 * alphabet, lets viewers `viewer.join` by code and forwards every publisher frame to the joined viewers
 * byte-for-byte, text and binary (§11), and answers `scene.snapshot.end` with `scene.snapshot.ack` (§6.4).
 * Validation stops at the envelope: this is not the relay — no limits, no TTL, no rate limiting, no snapshot
 * cache, no heartbeat. Tests steer it through `RelayStubOptions` and `sendToPublisher`/`closePublisher`. Full behaviour is `relay-server` (SRV-*) and its
 * E2E tests (QA-*). The stub logs nothing: codes and tokens never reach a log (NFR-12).
 */
import { randomBytes, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  ALPHABET,
  CODE_LENGTH,
  LIMITS,
  normalizeCode,
  PROTOCOL_VERSION,
} from "@slicerremoteview/shared";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

export interface RelayStubOptions {
  /** TCP port, `0` (default) = a random free port. */
  port?: number;
  /** Interface to bind (default loopback only). */
  host?: string;
  /** Answer `scene.snapshot.end` with `scene.snapshot.ack` (default `true`); `false` lets a test reply itself. */
  autoAck?: boolean;
  /**
   * Hold publisher frames back until this many viewers have joined, then forward them in order. Makes
   * "a viewer receives the whole snapshot" deterministic although the code is only known after
   * `session.created`. Default `0` = forward at once, like the relay.
   */
  holdFramesUntilViewers?: number;
}

/** One frame as the publisher sent it. */
export interface RecordedFrame {
  binary: boolean;
  data: Buffer;
}

export interface RelayStub {
  /** `ws://127.0.0.1:<port>/ws` */
  url: string;
  port: number;
  /**
   * Version bookkeeping violations of the publisher, one text per offending message (§6.2, §8.1, §8.4): a
   * `scene.snapshot.begin` not above every version used so far, an update whose `baseVersion` is not the last
   * version or whose `sceneVersion` does not exceed it, an update inside a snapshot, `scene.nodeAdded` not
   * followed by a snapshot (stricter than the relay needs to be: §8.2 only obliges the publisher). The stub also answers each with `error BAD_SEQUENCE` and does not forward it.
   */
  versionViolations: string[];
  /** Frames the publisher sent after `session.create`, in order (assertions in tests). */
  publisherFrames: RecordedFrame[];
  /** The code of the last session a publisher created, also after it ended (tests only). */
  readonly code: string | undefined;
  /** Sends an envelope to the connected publisher (`protocolVersion` and `ts` are filled in). */
  sendToPublisher(message: Record<string, unknown>): void;
  /** Closes the publisher socket with a WebSocket close code (e.g. `4008`). */
  closePublisher(closeCode: number): void;
  close(): Promise<void>;
}

/** A text frame as a JSON object, `undefined` when it is not one. */
function parseObject(data: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const base64url = (bytes: number): string => randomBytes(bytes).toString("base64url");
const randomCode = (): string =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

interface Session {
  id: string;
  code: string;
  profile: string;
  publisher: WebSocket;
  viewers: Set<WebSocket>;
}

export async function startRelayStub(options: RelayStubOptions = {}): Promise<RelayStub> {
  const server = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
    path: "/ws",
    perMessageDeflate: false, // §3.1
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  let session: Session | undefined;
  let publisher: WebSocket | undefined;
  let lastCode: string | undefined;
  const versionViolations: string[] = [];
  let releaseHeld = (): void => {};
  const publisherFrames: RecordedFrame[] = [];

  const send = (socket: WebSocket, message: Record<string, unknown>): void =>
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ts: Date.now(), ...message }));
  const fail = (socket: WebSocket, code: string, replyTo: unknown, closeCode?: number): void => {
    send(socket, {
      type: "error",
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      code,
      message: code,
      retryable: code === "CAPACITY",
    });
    if (closeCode !== undefined) socket.close(closeCode);
  };

  function onFirstMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const message = isBinary ? undefined : parseObject(Buffer.from(data as Buffer));
    if (typeof message?.["protocolVersion"] !== "string" || typeof message["type"] !== "string")
      return fail(socket, "INVALID_MESSAGE", undefined, 4007);
    const replyTo = message["id"];
    if (message["type"] === "session.create") {
      if (session) return fail(socket, "CAPACITY", replyTo, 4006); // the stub hosts one session
      const preferred =
        typeof message["preferredCode"] === "string"
          ? normalizeCode(message["preferredCode"])
          : null;
      session = {
        id: `sess_${base64url(12)}`,
        code: preferred && "code" in preferred ? preferred.code : randomCode(),
        profile: typeof message["profile"] === "string" ? message["profile"] : "mobile",
        publisher: socket,
        viewers: new Set(),
      };
      const created = session;
      lastCode = created.code;
      send(socket, {
        type: "session.created",
        ...(typeof replyTo === "string" ? { replyTo } : {}),
        sessionId: created.id,
        code: created.code,
        publisherToken: `pt_${base64url(32)}`,
        viewerLimit: LIMITS.MAX_VIEWERS,
        ttl: { graceS: 120, idleS: 1800, maxLifetimeS: 43200, expiresAt: Date.now() + 43200_000 },
        limits: {
          maxSnapshotBytes: LIMITS.MAX_SNAPSHOT_BYTES,
          maxChunkBytes: LIMITS.MAX_CHUNK_BYTES,
          maxTextBytes: LIMITS.MAX_TEXT_BYTES_PUBLISHER,
          maxChanges: LIMITS.MAX_CHANGES,
        },
      });
      publisher = socket;
      const held: RecordedFrame[] = [];
      /** Forwards to the joined viewers; `scene.snapshot.end` is acknowledged once it has been forwarded. */
      const forward = (frame: RecordedFrame): void => {
        for (const viewer of created.viewers)
          if (viewer.readyState === WebSocket.OPEN)
            viewer.send(frame.data, { binary: frame.binary }); // byte-for-byte (§11)
        const text = frame.binary ? undefined : parseObject(frame.data);
        if (options.autoAck !== false && text?.["type"] === "scene.snapshot.end")
          send(socket, {
            type: "scene.snapshot.ack",
            sceneVersion: text["sceneVersion"],
            viewersStreamed: created.viewers.size,
            viewersDeferred: 0,
          });
      };
      releaseHeld = (): void => {
        if (created.viewers.size < (options.holdFramesUntilViewers ?? 0)) return;
        for (const frame of held.splice(0)) forward(frame);
      };
      const versions = { last: 0, snapshotInFlight: false, snapshotExpected: false };
      /** §6.2 / §8.1 / §8.4 checks; returns the violation or `undefined` and advances the counters. */
      const checkVersions = (text: Record<string, unknown>): string | undefined => {
        const type = text["type"];
        const version = text["sceneVersion"];
        if (type === "scene.snapshot.end") {
          versions.snapshotInFlight = false;
          return undefined;
        }
        if (typeof version !== "number") return undefined;
        if (type === "scene.snapshot.begin") {
          if (version <= versions.last)
            return `snapshot version ${version} is not above ${versions.last}`;
          versions.last = version;
          versions.snapshotInFlight = true;
          versions.snapshotExpected = false;
          return undefined;
        }
        if (type !== "scene.update" && type !== "scene.nodeRemoved" && type !== "scene.nodeAdded")
          return undefined;
        const base = text["baseVersion"];
        if (versions.snapshotInFlight) return `${String(type)} inside a snapshot`;
        if (versions.snapshotExpected)
          return `${String(type)} while a snapshot is due after scene.nodeAdded`;
        if (base !== versions.last) return `baseVersion ${String(base)} is not ${versions.last}`;
        if (version <= versions.last)
          return `sceneVersion ${version} is not above ${versions.last}`;
        versions.last = version;
        versions.snapshotExpected = type === "scene.nodeAdded";
        return undefined;
      };
      socket.on("message", (data, binary) => {
        const frame = { binary, data: Buffer.from(data as Buffer) };
        publisherFrames.push(frame);
        const text = binary ? undefined : parseObject(frame.data);
        const violation = text && checkVersions(text);
        if (violation) {
          versionViolations.push(violation);
          return fail(socket, "BAD_SEQUENCE", text["id"]);
        }
        if (held.length > 0 || created.viewers.size < (options.holdFramesUntilViewers ?? 0))
          held.push(frame);
        else forward(frame);
      });
      socket.on("close", () => {
        for (const viewer of created.viewers) viewer.close(4001);
        session = undefined;
        publisher = undefined;
      });
    } else if (message["type"] === "viewer.join") {
      const code = typeof message["code"] === "string" ? normalizeCode(message["code"]) : null;
      if (!session || !code || !("code" in code) || code.code !== session.code)
        return fail(socket, "INVALID_CODE", replyTo, 4004);
      const joined = session;
      joined.viewers.add(socket);
      socket.on("close", () => joined.viewers.delete(socket));
      queueMicrotask(() => releaseHeld());
      send(socket, {
        type: "viewer.joined",
        ...(typeof replyTo === "string" ? { replyTo } : {}),
        sessionId: joined.id,
        viewerId: `vw_${base64url(3)}`,
        viewerToken: `vt_${base64url(32)}`,
        sceneVersion: 0,
        snapshotVersion: null,
        snapshotAvailable: false,
        publisherOnline: true,
        viewerCount: joined.viewers.size,
        viewerLimit: LIMITS.MAX_VIEWERS,
        profile: joined.profile,
      });
    } else {
      fail(socket, "UNSUPPORTED_TYPE", replyTo);
    }
  }

  server.on("connection", (socket) => {
    socket.once("message", (data, isBinary) => onFirstMessage(socket, data, isBinary));
  });

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    publisherFrames,
    versionViolations,
    get code() {
      return lastCode;
    },
    sendToPublisher(message) {
      if (publisher) send(publisher, message);
    },
    closePublisher(closeCode) {
      publisher?.close(closeCode);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
