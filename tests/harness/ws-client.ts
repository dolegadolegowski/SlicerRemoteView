// Raw protocol client for the security and load suites: a `ws` socket that records every frame, so a spec can
// await "the next message of type X" or "the close code". Each client can claim its own address through
// `X-Forwarded-For` (the harness relay runs with `TRUST_PROXY=true`, which takes the entry the immediate peer
// added — here the only one), so per-IP limits are tested per simulated client (relay-server/README.md).

import WebSocket from "ws";

export const PROTOCOL_VERSION = "1.0";

export type Message = { type: string; [key: string]: unknown };

export interface ClientOptions {
  /** Address the relay attributes the socket to (`X-Forwarded-For`). */
  ip?: string;
  /** Browser-like `Origin` header (absent by default, like Slicer and Unity). */
  origin?: string;
  headers?: Record<string, string>;
  /** Do not read: pause the socket after open (slow consumer). */
  paused?: boolean;
}

export interface Closed {
  code: number;
  reason: string;
}

export class Client {
  readonly socket: WebSocket;
  readonly messages: Message[] = [];
  readonly binary: Buffer[] = [];
  /** Resolves when the socket closes (relay close code, or 1006 for an abnormal end). */
  readonly closed: Promise<Closed>;
  /** Resolves once open; rejects with the HTTP status of a refused upgrade (`Unexpected server response: 403`). */
  readonly opened: Promise<void>;
  closeInfo: Closed | undefined;
  private readonly waiters = new Set<() => void>();
  private cursor = 0;

  constructor(url: string, options: ClientOptions = {}) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.ip) headers["X-Forwarded-For"] = options.ip;
    this.socket = new WebSocket(url, {
      headers,
      ...(options.origin ? { origin: options.origin } : {}),
      perMessageDeflate: false,
      maxPayload: 128 * 1024 * 1024,
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", () => {
        if (options.paused) this.socket.pause();
        resolve();
      });
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_req, res) =>
        reject(new Error(`Unexpected server response: ${res.statusCode}`)),
      );
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.socket.on("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        resolve(this.closeInfo);
        this.notify();
      });
    });
    this.socket.on("error", () => undefined);
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) this.binary.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      else this.messages.push(JSON.parse(data.toString()) as Message);
      this.notify();
    });
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }

  /** Sends one envelope (`protocolVersion` added unless given). */
  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
  }

  sendRaw(data: string | Buffer, binary = typeof data !== "string"): void {
    this.socket.send(data, { binary });
  }

  /**
   * The next message (after the previous `next` result) that matches `type`; rejects on timeout or when the
   * socket closed without one.
   */
  next(type?: string | ((m: Message) => boolean), timeoutMs = 5_000): Promise<Message> {
    const match = typeof type === "function" ? type : (m: Message) => type === undefined || m.type === type;
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.messages.length; i++) {
          if (match(this.messages[i]!)) {
            this.cursor = i + 1;
            done();
            resolve(this.messages[i]!);
            return;
          }
        }
        if (this.closeInfo) {
          done();
          reject(new Error(`socket closed (${this.closeInfo.code}) before message ${String(type)}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no message ${String(type)} within ${timeoutMs} ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  /** The close, or a rejection after `timeoutMs`. */
  async closedWithin(timeoutMs = 5_000): Promise<Closed> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`socket still open after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(code = 1000): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
      this.socket.close(code);
  }

  terminate(): void {
    this.socket.terminate();
  }
}

/** Opens a client and waits until the upgrade succeeded. */
export async function connect(url: string, options: ClientOptions = {}): Promise<Client> {
  const client = new Client(url, options);
  await client.opened;
  return client;
}

let ipCounter = 0;
/** A distinct documentation-range address per call (RFC 5737 TEST-NET-2), so per-IP limits never collide. */
export function nextIp(): string {
  ipCounter++;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

/** `viewer.join` by code; resolves with `viewer.joined` and the `scene.state` that always follows (§5.2). */
export async function joinViewer(
  url: string,
  code: string,
  options: ClientOptions = {},
): Promise<{ client: Client; joined: Message; state: Message }> {
  const client = await connect(url, options);
  client.send({
    type: "viewer.join",
    id: "v-1",
    code,
    clientInfo: {
      app: "web-viewer",
      version: "0.0.0-qa",
      platform: "web",
      profile: "mobile",
      capabilities: { httpScene: true, maxSnapshotBytes: 67_108_864 },
    },
  });
  const joined = await client.next((m) => m.type === "viewer.joined" || m.type === "error");
  if (joined.type === "error") throw new Error(`viewer.join refused: ${String(joined.code)}`);
  const state = await client.next("scene.state");
  return { client, joined, state };
}

/** `session.create`; resolves with `session.created` (code and token stay in the returned object only). */
export async function createSession(
  url: string,
  options: ClientOptions & { preferredCode?: string | null; profile?: string } = {},
): Promise<{ client: Client; created: Message }> {
  const client = await connect(url, options);
  client.send({
    type: "session.create",
    id: "p-1",
    clientInfo: { app: "SlicerRemoteView", version: "0.0.0-qa", platform: "qa-harness" },
    preferredCode: options.preferredCode ?? null,
    profile: options.profile ?? "mobile",
  });
  const created = await client.next((m) => m.type === "session.created" || m.type === "error");
  if (created.type === "error") throw new Error(`session.create refused: ${String(created.code)}`);
  return { client, created };
}
