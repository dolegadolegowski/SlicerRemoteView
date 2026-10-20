import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { buildApp } from "../../src/app.js";
import type { AppOptions } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { RateLimiter } from "../../src/ratelimit.js";
import { Registry } from "../../src/registry.js";
import { ManualClock } from "./manual-clock.js";

export interface TestRelay {
  app: FastifyInstance;
  clock: ManualClock;
  registry: Registry;
  limiter: RateLimiter;
  /** `ws://127.0.0.1:<port>/ws` */
  url: string;
  close(): Promise<void>;
}

/** A relay on a random loopback port with a manual clock and test defaults. */
export async function startRelay(
  options: AppOptions & { clock?: ManualClock } = {},
): Promise<TestRelay> {
  const clock = options.clock ?? new ManualClock();
  const config =
    options.config ??
    loadConfig({ TRUST_PROXY: "false", ALLOWED_ORIGINS: "https://relay.example.org" });
  const registry =
    options.registry ??
    new Registry({
      ...config,
      clock,
      // A throwing expiry listener must fail the test, not vanish (the app would log it).
      onListenerError: (error) =>
        queueMicrotask(() => {
          throw error;
        }),
    });
  const limiter =
    options.limiter ??
    new RateLimiter({ clock, logger: options.logger ?? createLogger({ level: "silent" }) });
  const app = await buildApp({ ...options, config, clock, registry, limiter });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    clock,
    registry,
    limiter,
    url: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}

export type Received = Record<string, unknown> & { type: string };

export interface TestClient {
  ws: WebSocket;
  /** Every JSON message received so far, in order. */
  received: Received[];
  /** Resolves with the next JSON message not yet taken by `next()`. */
  next(): Promise<Received>;
  /** Resolves when the socket is closed, with the close code the client saw. */
  closed: Promise<number>;
  send(message: Record<string, unknown>): void;
  sendRaw(data: string | Buffer, binary?: boolean): void;
}

/** Opens a client and waits for the upgrade; rejects with the HTTP status when it is refused. */
export function connectClient(
  url: string,
  headers: Record<string, string> = {},
): Promise<TestClient> {
  const ws = new WebSocket(url, { headers });
  const received: Received[] = [];
  const waiting: ((message: Received) => void)[] = [];
  let taken = 0;
  let opened = false;
  // After `open`, EPIPE/ECONNRESET following a relay close are expected in these tests.
  ws.on("error", () => {});
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString()) as Received;
    received.push(message);
    const waiter = waiting.shift();
    if (waiter) waiter(received[taken++] as Received);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) =>
      reject(
        Object.assign(new Error("upgrade refused"), {
          statusCode: response.statusCode,
          headers: response.headers,
        }),
      ),
    );
    ws.once("error", (error) => {
      if (!opened) reject(error);
    });
    ws.once("close", (code) => {
      if (!opened) reject(Object.assign(new Error("closed before open"), { code }));
    });
    ws.once("open", () => {
      opened = true;
      resolve({
        ws,
        received,
        closed,
        next: () =>
          taken < received.length
            ? Promise.resolve(received[taken++] as Received)
            : new Promise((r) => waiting.push(r)),
        send: (message) => ws.send(JSON.stringify({ protocolVersion: "1.0", ...message })),
        sendRaw: (data, binary = false) => ws.send(data, { binary }),
      });
    });
  });
}
