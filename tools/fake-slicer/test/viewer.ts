/** Test viewer: joins the stub by code and records every frame (text parsed, binary raw). */
import { WebSocket } from "ws";
import { expect, vi } from "vitest";
import {
  checkChunk,
  decodeChunkHeader,
  PROTOCOL_VERSION,
  sha256Hex,
} from "@slicerremoteview/shared";

export interface ViewerFrame {
  binary: boolean;
  data: Buffer;
  /** Parsed text frame (`undefined` for binary frames). */
  json: Record<string, unknown> | undefined;
}

export class TestViewer {
  readonly frames: ViewerFrame[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      const buffer = Buffer.from(data as Buffer);
      this.frames.push({
        binary,
        data: buffer,
        json: binary ? undefined : (JSON.parse(buffer.toString()) as Record<string, unknown>),
      });
    });
  }

  static async join(url: string, code: string): Promise<TestViewer> {
    const socket = new WebSocket(url);
    const viewer = new TestViewer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "viewer.join", code }));
    await vi.waitFor(() => expect(viewer.types()).toContain("viewer.joined"), { timeout: 2000 });
    return viewer;
  }

  /** Types of the text frames received so far. */
  types(): string[] {
    return this.frames.flatMap((f) => (f.json ? [String(f.json["type"])] : []));
  }

  messages(type: string): Record<string, unknown>[] {
    return this.frames.flatMap((f) => (f.json?.["type"] === type ? [f.json] : []));
  }

  /**
   * Reassembles the snapshot `sceneVersion` the way §6.3 tells a viewer to: one pre-allocated buffer,
   * every chunk checked with `checkChunk`, hash compared with `begin` and `end`.
   */
  async snapshot(
    sceneVersion: number,
  ): Promise<{ bytes: Uint8Array; sha256: string; chunks: number }> {
    await vi.waitFor(
      () =>
        expect(
          this.messages("scene.snapshot.end").some((m) => m["sceneVersion"] === sceneVersion),
        ).toBe(true),
      { timeout: 5000 },
    );
    const begin = this.messages("scene.snapshot.begin").find(
      (m) => m["sceneVersion"] === sceneVersion,
    )!;
    const byteLength = begin["byteLength"] as number;
    const chunkSize = begin["chunkSize"] as number;
    const chunkCount = begin["chunkCount"] as number;
    const bytes = new Uint8Array(byteLength);
    let next = 0;
    for (const frame of this.frames.filter((f) => f.binary)) {
      const decoded = decodeChunkHeader(frame.data);
      if (!decoded.ok) throw new Error(decoded.error.message);
      if (decoded.value.sceneVersion !== sceneVersion) continue;
      const checked = checkChunk(decoded.value, {
        sceneVersion,
        byteLength,
        chunkSize,
        chunkCount,
        nextIndex: next,
      });
      if (!checked.ok) throw new Error(checked.error.message);
      bytes.set(decoded.value.payload, checked.value.offset);
      next++;
    }
    expect(next).toBe(chunkCount);
    const sha256 = await sha256Hex(bytes);
    expect(sha256).toBe(begin["sha256"]);
    return { bytes, sha256, chunks: next };
  }

  close(): void {
    this.socket.terminate();
  }
}
