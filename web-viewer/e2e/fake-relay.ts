// A relay stand-in for component E2E (WEB-08 onwards): answers `viewer.join` like the relay (§5.2, §8.3) and streams
// a fixture GLB in SRVC-framed chunks (§6.2–6.4) through Playwright's WebSocket route, so the whole viewer pipeline
// runs without a relay process. WEB-10 adds the real fake-slicer relay (PRO-13) for the system-level smoke.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../shared/fixtures/glb");
export const fixture = (name: string): Buffer => readFileSync(`${FIXTURES}/${name}`);
const CHUNK = 65_536;

export async function fakeRelay(
  page: Page,
  glb: Buffer = fixture("asymmetric-2nodes.glb"),
): Promise<void> {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const send = (message: Record<string, unknown>) =>
      ws.send(JSON.stringify({ protocolVersion: "1.0", ...message }));
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
      const sha256 = createHash("sha256").update(glb).digest("hex");
      const chunkCount = Math.ceil(glb.length / CHUNK);
      send({
        type: "scene.snapshot.begin",
        sceneVersion: 1,
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
        header.writeUInt32LE(1, 4);
        header.writeUInt32LE(index, 8);
        ws.send(Buffer.concat([header, glb.subarray(index * CHUNK, (index + 1) * CHUNK)]));
      }
      send({ type: "scene.snapshot.end", sceneVersion: 1, sha256 });
    });
  });
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
export async function joinAndView(page: Page, glb?: Buffer): Promise<void> {
  await fakeRelay(page, glb);
  await page.goto("/");
  await join(page);
}
