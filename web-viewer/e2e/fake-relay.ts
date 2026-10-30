// A relay stand-in for component E2E (WEB-08 onwards): answers `viewer.join` like the relay (§5.2, §8.3) and streams
// a fixture GLB in SRVC-framed chunks (§6.2–6.4) through Playwright's WebSocket route, so the whole viewer pipeline
// runs without a relay process. WEB-10 adds the real fake-slicer relay (PRO-13) for the system-level smoke.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../shared/fixtures/glb");
export const fixture = (name: string): Buffer => readFileSync(`${FIXTURES}/${name}`);
const CHUNK = 65_536;

/** Sends `message` with the envelope's `protocolVersion`. */
export const sendJson = (ws: WebSocketRoute, message: Record<string, unknown>): void =>
  ws.send(JSON.stringify({ protocolVersion: "1.0", ...message }));

/** Streams `glb` as snapshot `sceneVersion`: `begin`, SRVC-framed chunks, `end` (§6.2–6.4). */
export function streamSnapshot(ws: WebSocketRoute, glb: Buffer, sceneVersion = 1): void {
  const sha256 = createHash("sha256").update(glb).digest("hex");
  const chunkCount = Math.ceil(glb.length / CHUNK);
  sendJson(ws, {
    type: "scene.snapshot.begin",
    sceneVersion,
    byteLength: glb.length,
    sha256,
    chunkCount,
    chunkSize: CHUNK,
    format: "glb",
    extensionsUsed: [],
  });
  for (let index = 0; index < chunkCount; index++) {
    const header = Buffer.alloc(12);
    header.write("SRVC", 0, "ascii");
    header.writeUInt32LE(sceneVersion, 4);
    header.writeUInt32LE(index, 8);
    ws.send(Buffer.concat([header, glb.subarray(index * CHUNK, (index + 1) * CHUNK)]));
  }
  sendJson(ws, { type: "scene.snapshot.end", sceneVersion, sha256 });
}

/** Plays the relay's side of the newest socket after the join (live updates in WEB-13 tests). */
export interface FakeRelay {
  send(message: Record<string, unknown>): void;
  /** Streams `glb` as snapshot `sceneVersion`: the presenter shares a scene again (WEB-25). */
  snapshot(glb: Buffer, sceneVersion: number): void;
}

export async function fakeRelay(
  page: Page,
  glb: Buffer = fixture("asymmetric-2nodes.glb"),
): Promise<FakeRelay> {
  let latest: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const send = (message: Record<string, unknown>) => sendJson(ws, message);
    latest = ws;
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as { type: string; id?: string };
      if (message.type === "ping") send({ type: "pong", replyTo: message.id });
      if (message.type !== "viewer.join") return;
      send({
        type: "viewer.joined",
        replyTo: message.id,
        sessionId: "sess_E2E0000000000000",
        viewerId: "vw_e2e",
        viewerToken: `vt_${"A".repeat(43)}`,
        sceneVersion: 0,
        snapshotVersion: null,
        snapshotAvailable: false,
        publisherOnline: true,
        viewerCount: 1,
        viewerLimit: 20,
        profile: "mobile",
      });
      send({ type: "scene.state", sceneVersion: 0, snapshotVersion: null, nodes: [], removed: [] });
      streamSnapshot(ws, glb);
    });
  });
  const socket = () => {
    if (!latest) throw new Error("no socket yet");
    return latest;
  };
  return {
    send: (message) => sendJson(socket(), message),
    snapshot: (next, sceneVersion) => streamSnapshot(socket(), next, sceneVersion),
  };
}

/** Types a code on the open page, joins and waits for the viewer to show the model. */
export async function join(page: Page): Promise<void> {
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type("7kq4x");
  await page.locator(".code-entry__join").click();
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect(page.locator(".code-entry")).toBeHidden();
}

/** Installs the fake relay, opens the app and joins. */
export async function joinAndView(page: Page, glb?: Buffer): Promise<FakeRelay> {
  const relay = await fakeRelay(page, glb);
  await page.goto("/");
  await join(page);
  return relay;
}
