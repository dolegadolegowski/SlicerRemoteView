// QA-04 helpers: the spec itself as the publisher (a raw `ws` client from harness/ws-client.ts), so it knows to the
// millisecond when each `scene.update` left (NFR-02 latency), and the in-page probe that records when the viewer's
// node panel reflected it. Snapshot frames are built with fake-slicer's `loadGlb`/`snapshotBegin`/`envelope` and the
// shared chunk codec (§6.2, §6.3); versions follow §8.4 (snapshot 1, then every update `baseVersion` = last).
//
// Secrets (NFR-12): `session.created` (code, publisherToken) stays inside the returned object; nothing here prints,
// attaches or throws it.

import type { Page } from "@playwright/test";
import { envelope, loadGlb, resolveFixture, snapshotBegin } from "@slicerremoteview/fake-slicer";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { chunkify, encodeChunkFrame, LIMITS } from "@slicerremoteview/shared";
import { createSession, nextIp } from "../../harness/ws-client.ts";
import type { Client, Message } from "../../harness/ws-client.ts";

/** One `changes[]` item of §8.1. */
export interface Change {
  nodeId: string;
  visible?: boolean;
  color?: [number, number, number];
  opacity?: number;
  matrix?: number[];
}

export interface TestPublisher {
  readonly client: Client;
  /** The session code, in memory only. */
  readonly code: string;
  /** The last version the relay accepted from us (§8.4). */
  readonly sceneVersion: number;
  /** Streams `fixture` as the next version and waits for `scene.snapshot.ack`. */
  publish(fixture: string): Promise<void>;
  /** Sends one `scene.update` with the next version; resolves with `Date.now()` taken just before the send. */
  update(changes: Change[]): number;
  /** `error` messages the relay sent us (none expected). */
  errors(): Message[];
  close(): void;
}

let ids = 0;
const nextId = () => `qa04-${++ids}`;

/** `session.create` from a fresh simulated address, then snapshot 1 of `fixture`. */
export async function startTestPublisher(wsUrl: string, fixture: string): Promise<TestPublisher> {
  const { client, created } = await createSession(wsUrl, { ip: nextIp() });
  const code = created["code"] as string;
  let sceneVersion = 0;
  const publisher: TestPublisher = {
    client,
    code,
    get sceneVersion() {
      return sceneVersion;
    },
    async publish(name) {
      const glb: LoadedGlb = await loadGlb(resolveFixture(name));
      const version = sceneVersion + 1;
      const chunkSize = LIMITS.MIN_CHUNK_BYTES; // every fixture but large-synthetic fits one chunk
      client.sendRaw(snapshotBegin({ glb, sceneVersion: version, chunkSize, profile: "mobile" }, nextId()));
      for (const { chunkIndex, payload } of chunkify(glb.bytes, chunkSize))
        client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion: version, chunkIndex }, payload)));
      client.sendRaw(envelope("scene.snapshot.end", nextId(), { sceneVersion: version, sha256: glb.sha256 }));
      const reply = await client.next(
        (m) => (m.type === "scene.snapshot.ack" && m["sceneVersion"] === version) || m.type === "error",
        15_000,
      );
      if (reply.type === "error") throw new Error(`snapshot refused: ${String(reply["code"])}`);
      sceneVersion = version;
    },
    update(changes) {
      const baseVersion = sceneVersion;
      sceneVersion++;
      const message = envelope("scene.update", nextId(), { sceneVersion, baseVersion, changes });
      const sentAt = Date.now();
      client.sendRaw(message);
      return sentAt;
    },
    errors: () => client.messages.filter((m) => m.type === "error"),
    close: () => client.close(),
  };
  await publisher.publish(fixture);
  return publisher;
}

/** One change the page saw: which row, which property, its new value, and when (page clock = test clock). */
export interface Seen {
  node: string;
  prop: "visible" | "color" | "opacity" | "version";
  value: string;
  /** `Date.now()` in the MutationObserver callback (DOM updated). */
  at: number;
  /** `Date.now()` in the next animation frame after it (the frame that draws it). */
  frame: number;
}

/**
 * Installs (before any page script) a MutationObserver that records every change of a node-panel row's
 * `aria-checked` (visibility), swatch colour, opacity slider `aria-valuetext`, and of the status bar's scene version,
 * each only when the value differs from the last one seen. Read it back with `seen(page)`.
 */
export async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Entry = { node: string; prop: string; value: string; at: number; frame: number };
    const log: Entry[] = [];
    const last = new Map<string, string>();
    (window as unknown as { __qa04: Entry[] }).__qa04 = log;
    const note = (node: string, prop: string, value: string, at: number, fresh: Entry[]) => {
      const key = `${node}\u0000${prop}`;
      if (last.get(key) === value) return;
      last.set(key, value);
      const entry = { node, prop, value, at, frame: 0 };
      log.push(entry);
      fresh.push(entry);
    };
    const scan = () => {
      const at = Date.now();
      const fresh: Entry[] = [];
      for (const row of Array.from(document.querySelectorAll<HTMLElement>(".node-panel__row[data-node-id]"))) {
        const node = row.dataset["nodeId"] ?? "";
        note(node, "visible", row.getAttribute("aria-checked") ?? "", at, fresh);
        const swatch = row.querySelector<HTMLElement>(".node-panel__swatch");
        if (swatch) note(node, "color", swatch.style.backgroundColor.replace(/\s/g, ""), at, fresh);
      }
      for (const slider of Array.from(document.querySelectorAll<HTMLElement>(".node-panel__opacity[data-node-id]")))
        note(slider.dataset["nodeId"] ?? "", "opacity", slider.getAttribute("aria-valuetext") ?? "", at, fresh);
      const version = document.querySelector(".status-bar__version")?.textContent ?? "";
      note("", "version", version, at, fresh);
      if (fresh.length) requestAnimationFrame(() => fresh.forEach((e) => (e.frame = Date.now())));
    };
    const start = () =>
      new MutationObserver(scan).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-checked", "style", "aria-valuetext"],
      });
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}

export async function seen(page: Page): Promise<Seen[]> {
  return page.evaluate(() => (window as unknown as { __qa04: Seen[] }).__qa04.slice());
}

/** Rendered primitives of a fixture (a GLB JSON chunk read in Node): what `renderer.info.memory.geometries` counts. */
export async function primitiveCount(fixture: string): Promise<number> {
  const { bytes } = await loadGlb(resolveFixture(fixture));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))) as {
    meshes?: { primitives?: unknown[] }[];
  };
  return (json.meshes ?? []).reduce((n, mesh) => n + (mesh.primitives?.length ?? 0), 0);
}

/** p-th percentile (nearest rank) of `values`. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

/** One JSON frame of the page's sockets, in order: `socket` counts the page's sockets from 0. */
export interface Frame {
  socket: number;
  dir: "sent" | "received";
  message: Record<string, unknown>;
}

/**
 * Records every JSON frame of every page socket, passively (`page.on("websocket")` with the `framesent` /
 * `framereceived` events, tests/node_modules/playwright-core/types/types.d.ts `interface WebSocket`). The frames
 * carry the code and the viewer token: they stay in this array, specs compare against them with booleans only.
 */
export function recordFrames(page: Page): Frame[] {
  const frames: Frame[] = [];
  let sockets = 0;
  page.on("websocket", (ws) => {
    const socket = sockets++;
    const add = (dir: Frame["dir"]) => (data: { payload: string | Buffer }) => {
      if (typeof data.payload !== "string") return; // snapshot chunks
      try {
        frames.push({ socket, dir, message: JSON.parse(data.payload) as Record<string, unknown> });
      } catch {
        // not JSON: not a protocol message
      }
    };
    ws.on("framesent", add("sent"));
    ws.on("framereceived", add("received"));
  });
  return frames;
}

/**
 * Records the close code of every page socket (`CloseEvent.code`), which Playwright's WebSocket events do not
 * expose: before any page script, `WebSocket` is replaced by a subclass that only adds a `close` listener. Read it
 * with `closeCodes(page)`. Not for pages that also use `page.routeWebSocket` (that replaces the socket itself).
 */
export async function recordCloseCodes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const codes: number[] = [];
    (window as unknown as { __qa04closes: number[] }).__qa04closes = codes;
    const Native = window.WebSocket;
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("close", (event) => codes.push(event.code));
      }
    }
    window.WebSocket = Recorded;
  });
}

export async function closeCodes(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __qa04closes: number[] }).__qa04closes.slice());
}
