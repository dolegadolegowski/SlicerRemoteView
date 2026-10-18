/**
 * Minimal in-process relay for tests (PRO-13; `[stub allowed]` target for WEB-10 until `relay-server` lands).
 *
 * Accepts one publisher (`session.create`), answers `session.created` with a code from the protocol
 * alphabet, lets viewers `viewer.join` by code and forwards every publisher frame to the joined viewers
 * byte-for-byte, text and binary (§11). Validation stops at the envelope: this is not the relay — no limits,
 * no TTL, no rate limiting, no snapshot cache, no heartbeat. Full behaviour is `relay-server` (SRV-*) and its
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
  /** Frames the publisher sent after `session.create`, in order (assertions in tests). */
  publisherFrames: RecordedFrame[];
  /** The session code once a publisher created one (tests only). */
  readonly code: string | undefined;
  close(): Promise<void>;
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
    let message: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = isBinary ? undefined : JSON.parse(data.toString());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        message = parsed as Record<string, unknown>;
    } catch {
      /* falls through to INVALID_MESSAGE */
    }
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
      socket.on("message", (frame, binary) => {
        publisherFrames.push({ binary, data: Buffer.from(frame as Buffer) });
        for (const viewer of created.viewers)
          if (viewer.readyState === WebSocket.OPEN) viewer.send(frame, { binary }); // byte-for-byte (§11)
      });
      socket.on("close", () => {
        for (const viewer of created.viewers) viewer.close(4001);
        session = undefined;
      });
    } else if (message["type"] === "viewer.join") {
      const code = typeof message["code"] === "string" ? normalizeCode(message["code"]) : null;
      if (!session || !code || !("code" in code) || code.code !== session.code)
        return fail(socket, "INVALID_CODE", replyTo, 4004);
      const joined = session;
      joined.viewers.add(socket);
      socket.on("close", () => joined.viewers.delete(socket));
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
    get code() {
      return session?.code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
