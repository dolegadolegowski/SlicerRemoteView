// Mock WebSocket for the protocol-layer tests: records what the client sends, lets a test play the relay.
import type { SocketLike } from "../../src/protocol/connection";

export class MockSocket implements SocketLike {
  static instances: MockSocket[] = [];
  static reset(): void {
    MockSocket.instances = [];
  }
  static get last(): MockSocket {
    const s = MockSocket.instances.at(-1);
    if (!s) throw new Error("no socket was created");
    return s;
  }

  binaryType = "blob";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) };
    this.readyState = 3;
  }

  /** Relay side: the handshake completes. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Relay side: sends a JSON message (the envelope fields are added). */
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ protocolVersion: "1.0", ...message }) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Relay side: closes the socket with a close code. */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Parsed JSON frames the client sent. */
  get frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
