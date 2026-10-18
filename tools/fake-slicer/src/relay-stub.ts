/**
 * Minimal in-process relay for tests (PRO-13; `[stub allowed]` target for WEB-10 until `relay-server` lands).
 *
 * Accepts one publisher (`session.create`, or `session.resume` while the session is in grace), answers
 * `session.created`/`session.resumed` with a code from the protocol alphabet, lets viewers `viewer.join` by code,
 * forwards every publisher frame to the joined viewers byte-for-byte, text and binary (§11), answers
 * `scene.snapshot.end` with `scene.snapshot.ack` (§6.4) and `ping` with `pong` (§9.1), and tells publisher and
 * viewers the `viewer.count`. Validation stops at the envelope and the version bookkeeping: this is not the
 * relay — no limits, no TTL, no rate limiting, no snapshot cache. Tests steer it through `RelayStubOptions`,
 * `sendToPublisher`, `closePublisher` and `restart`. Full behaviour is `relay-server` (SRV-*) and its E2E tests
 * (QA-*). The stub logs nothing: codes and tokens never reach a log (NFR-12).
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
   * Hold publisher frames back while fewer than this many viewers are joined, then forward them in order. Makes
   * "a viewer receives the whole snapshot" deterministic although the code is only known after
   * `session.created`. Default `0` = forward at once, like the relay.
   */
  holdFramesUntilViewers?: number;
  /**
   * How long a session survives its publisher's socket (the relay's `PUBLISHER_GRACE_S`, §9.1) so that
   * `session.resume` can succeed. Default `0` = the session ends with the socket and viewers get close `4001`.
   */
  publisherGraceMs?: number;
  /**
   * Close the first publisher connection with `4008` after this many binary chunk frames, i.e. in the middle of
   * a snapshot upload (the relay never saw `scene.snapshot.end`, so `session.resumed.snapshotVersion` is `null`).
   */
  dropPublisherAfterChunks?: number;
  /** Never grant `preferredCode` (§4.1: "otherwise a fresh code is generated silently"). */
  ignorePreferredCode?: boolean;
  /** Answer the publisher's `ping` with `pong` (default `true`); `false` simulates a dead link (§9.1). */
  answerPings?: boolean;
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
   * followed by a snapshot (stricter than the relay needs to be: §8.2 only obliges the publisher). The stub also
   * answers each with `error BAD_SEQUENCE` and does not forward it.
   */
  versionViolations: string[];
  /** Frames the publisher sent after its first message, over all its connections, in order (assertions in tests). */
  publisherFrames: RecordedFrame[];
  /** First message of every publisher connection (`session.create` / `session.resume`), parsed (tests only: it holds the token). */
  handshakes: Record<string, unknown>[];
  /** Number of application `ping`s received from publishers. */
  readonly pings: number;
  /** The code of the last session a publisher created, also after it ended (tests only). */
  readonly code: string | undefined;
  /** Sends an envelope to the connected publisher (`protocolVersion` and `ts` are filled in). */
  sendToPublisher(message: Record<string, unknown>): void;
  /** Closes the publisher socket with a WebSocket close code (e.g. `4008`). */
  closePublisher(closeCode: number): void;
  /** Forgets the session and closes publisher and viewers with `4008`, like a relay redeploy (§9.3, §13 step 9). */
  restart(): void;
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
  token: string;
  profile: string;
  /** The attached publisher socket; `undefined` while the session is in grace. */
  publisher: WebSocket | undefined;
  viewers: Set<WebSocket>;
  /** Publisher frames waiting for `holdFramesUntilViewers`. */
  held: RecordedFrame[];
  /** §6.2 / §8.1 / §8.4 bookkeeping; survives a publisher reconnect. */
  versions: { last: number; snapshotInFlight: boolean; snapshotExpected: boolean };
  /** Version of the last completed snapshot (`session.resumed.snapshotVersion`). */
  snapshotVersion: number | null;
  graceTimer: NodeJS.Timeout | undefined;
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
  let lastCode: string | undefined;
  let pings = 0;
  let chunkFrames = 0;
  const versionViolations: string[] = [];
  const publisherFrames: RecordedFrame[] = [];
  const handshakes: Record<string, unknown>[] = [];
  const ttl = () => ({
    graceS: 120,
    idleS: 1800,
    maxLifetimeS: 43200,
    expiresAt: Date.now() + 43200_000,
  });

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
  const reply = (replyTo: unknown): Record<string, unknown> =>
    typeof replyTo === "string" ? { replyTo } : {};

  function endSession(ended: Session, closeCode: number): void {
    clearTimeout(ended.graceTimer);
    for (const viewer of ended.viewers) viewer.close(closeCode);
    if (session === ended) session = undefined;
  }

  const broadcastCount = (target: Session): void => {
    const count = {
      type: "viewer.count",
      viewerCount: target.viewers.size,
      viewerLimit: LIMITS.MAX_VIEWERS,
      platforms: { web: target.viewers.size },
    };
    if (target.publisher?.readyState === WebSocket.OPEN) send(target.publisher, count);
    for (const viewer of target.viewers)
      if (viewer.readyState === WebSocket.OPEN) send(viewer, count);
  };

  /** Forwards to the joined viewers; `scene.snapshot.end` is acknowledged once it has been forwarded. */
  function forward(target: Session, socket: WebSocket, frame: RecordedFrame): void {
    for (const viewer of target.viewers)
      if (viewer.readyState === WebSocket.OPEN) viewer.send(frame.data, { binary: frame.binary }); // byte-for-byte (§11)
    const text = frame.binary ? undefined : parseObject(frame.data);
    if (options.autoAck !== false && text?.["type"] === "scene.snapshot.end")
      send(socket, {
        type: "scene.snapshot.ack",
        sceneVersion: text["sceneVersion"],
        viewersStreamed: target.viewers.size,
        viewersDeferred: 0,
      });
  }

  const releaseHeld = (target: Session): void => {
    const socket = target.publisher;
    if (!socket || target.viewers.size < (options.holdFramesUntilViewers ?? 0)) return;
    for (const frame of target.held.splice(0)) forward(target, socket, frame);
  };

  /** §6.2 / §8.1 / §8.4 checks; returns the violation or `undefined` and advances the counters. */
  function checkVersions(target: Session, text: Record<string, unknown>): string | undefined {
    const { versions } = target;
    const type = text["type"];
    const version = text["sceneVersion"];
    if (type === "scene.snapshot.end") {
      versions.snapshotInFlight = false;
      if (typeof version === "number") target.snapshotVersion = version;
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
    if (version <= versions.last) return `sceneVersion ${version} is not above ${versions.last}`;
    versions.last = version;
    versions.snapshotExpected = type === "scene.nodeAdded";
    return undefined;
  }

  /** Wires a publisher socket to its session after `session.created` / `session.resumed`. */
  function attachPublisher(socket: WebSocket, target: Session): void {
    clearTimeout(target.graceTimer);
    target.publisher = socket;
    socket.on("message", (data, binary) => {
      const frame = { binary, data: Buffer.from(data as Buffer) };
      publisherFrames.push(frame);
      const text = binary ? undefined : parseObject(frame.data);
      if (text?.["type"] === "ping") {
        pings++;
        if (options.answerPings !== false)
          send(socket, { type: "pong", ...reply(text["id"]), serverTs: Date.now() });
        return; // the relay answers heartbeats itself, viewers never see them
      }
      if (
        binary &&
        options.dropPublisherAfterChunks !== undefined &&
        ++chunkFrames === options.dropPublisherAfterChunks
      ) {
        socket.close(4008);
        return;
      }
      const violation = text && checkVersions(target, text);
      if (violation) {
        versionViolations.push(violation);
        return fail(socket, "BAD_SEQUENCE", text["id"]);
      }
      if (target.held.length > 0 || target.viewers.size < (options.holdFramesUntilViewers ?? 0))
        target.held.push(frame);
      else forward(target, socket, frame);
    });
    socket.on("close", () => {
      if (target.publisher !== socket) return; // replaced by a resumed connection (4011)
      target.publisher = undefined;
      if ((options.publisherGraceMs ?? 0) > 0) {
        target.graceTimer = setTimeout(() => endSession(target, 4002), options.publisherGraceMs);
        target.graceTimer.unref();
      } else endSession(target, 4001);
    });
  }

  function onFirstMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const message = isBinary ? undefined : parseObject(Buffer.from(data as Buffer));
    if (typeof message?.["protocolVersion"] !== "string" || typeof message["type"] !== "string")
      return fail(socket, "INVALID_MESSAGE", undefined, 4007);
    const replyTo = message["id"];
    if (message["type"] === "session.create" || message["type"] === "session.resume")
      handshakes.push(message);
    if (message["type"] === "session.create") {
      if (session?.publisher) return fail(socket, "CAPACITY", replyTo, 4006); // the stub hosts one session
      if (session) endSession(session, 4002); // an offline session makes room for a fresh create
      const preferred =
        typeof message["preferredCode"] === "string" && !options.ignorePreferredCode
          ? normalizeCode(message["preferredCode"])
          : null;
      const created: Session = {
        id: `sess_${base64url(12)}`,
        code: preferred && "code" in preferred ? preferred.code : randomCode(),
        token: `pt_${base64url(32)}`,
        profile: typeof message["profile"] === "string" ? message["profile"] : "mobile",
        publisher: undefined,
        viewers: new Set(),
        held: [],
        versions: { last: 0, snapshotInFlight: false, snapshotExpected: false },
        snapshotVersion: null,
        graceTimer: undefined,
      };
      session = created;
      lastCode = created.code;
      send(socket, {
        type: "session.created",
        ...reply(replyTo),
        sessionId: created.id,
        code: created.code,
        publisherToken: created.token,
        viewerLimit: LIMITS.MAX_VIEWERS,
        ttl: ttl(),
        limits: {
          maxSnapshotBytes: LIMITS.MAX_SNAPSHOT_BYTES,
          maxChunkBytes: LIMITS.MAX_CHUNK_BYTES,
          maxTextBytes: LIMITS.MAX_TEXT_BYTES_PUBLISHER,
          maxChanges: LIMITS.MAX_CHANGES,
        },
      });
      attachPublisher(socket, created);
    } else if (message["type"] === "session.resume") {
      if (!session || session.id !== message["sessionId"]) {
        // §4.3: the socket stays open so the publisher can fall back to session.create{preferredCode}
        fail(socket, "SESSION_NOT_FOUND", replyTo);
        socket.once("message", (next, binary) => onFirstMessage(socket, next, binary));
        return;
      }
      if (session.token !== message["publisherToken"])
        return fail(socket, "UNAUTHORIZED", replyTo, 4003);
      const resumed = session;
      if (resumed.publisher?.readyState === WebSocket.OPEN) resumed.publisher.close(4011); // half-open old socket
      attachPublisher(socket, resumed);
      send(socket, {
        type: "session.resumed",
        ...reply(replyTo),
        sessionId: resumed.id,
        code: resumed.code,
        sceneVersion: resumed.versions.last,
        snapshotVersion: resumed.snapshotVersion,
        viewerCount: resumed.viewers.size,
        ttl: ttl(),
      });
    } else if (message["type"] === "viewer.join") {
      const code = typeof message["code"] === "string" ? normalizeCode(message["code"]) : null;
      if (!session || !code || !("code" in code) || code.code !== session.code)
        return fail(socket, "INVALID_CODE", replyTo, 4004);
      const joined = session;
      joined.viewers.add(socket);
      socket.on("close", () => {
        if (joined.viewers.delete(socket)) broadcastCount(joined);
      });
      queueMicrotask(() => releaseHeld(joined));
      send(socket, {
        type: "viewer.joined",
        ...reply(replyTo),
        sessionId: joined.id,
        viewerId: `vw_${base64url(3)}`,
        viewerToken: `vt_${base64url(32)}`,
        sceneVersion: 0,
        snapshotVersion: null,
        snapshotAvailable: false,
        publisherOnline: joined.publisher !== undefined,
        viewerCount: joined.viewers.size,
        viewerLimit: LIMITS.MAX_VIEWERS,
        profile: joined.profile,
      });
      broadcastCount(joined);
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
    handshakes,
    get pings() {
      return pings;
    },
    get code() {
      return lastCode;
    },
    sendToPublisher(message) {
      if (session?.publisher) send(session.publisher, message);
    },
    closePublisher(closeCode) {
      session?.publisher?.close(closeCode);
    },
    restart() {
      const ended = session;
      if (!ended) return;
      const attached = ended.publisher;
      ended.publisher = undefined; // its close handler must not start a grace period for a forgotten session
      attached?.close(4008);
      endSession(ended, 4008);
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(session?.graceTimer);
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
