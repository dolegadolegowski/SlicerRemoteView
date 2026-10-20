// Reconnect and rejoin (WEB-14; FR-43, US-11, US-12, NFR-19, NFR-20; docs/protocol.md §5, §9.3, §13 steps 8–9). The
// relay is played in the page's WebSocket route, socket by socket, so each test decides when the relay drops, what a
// rejoin is answered and when — no timing races with a script.

import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { fixture, sendJson, streamSnapshot } from "./fake-relay";

const CODE = "7KQ4X";
const SESSION = "sess_E2E0000000000000";
const TOKEN = `vt_${"A".repeat(43)}`;
const GLB = fixture("asymmetric-2nodes.glb");

/** One socket the page opened: its frames, and the relay's side of it. */
interface Socket {
  readonly ws: WebSocketRoute;
  readonly frames: Record<string, unknown>[];
  /** The page's `viewer.join` on this socket. */
  readonly join: Record<string, unknown>;
}

/** Routes `/ws`; `next()` resolves with each socket once the page has sent its `viewer.join` there. */
async function relay(page: Page): Promise<{ next(): Promise<Socket>; readonly count: number }> {
  const ready: Socket[] = [];
  const waiting: ((s: Socket) => void)[] = [];
  let count = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    count++;
    const frames: Record<string, unknown>[] = [];
    ws.onMessage((frame) => {
      const message = JSON.parse(String(frame)) as Record<string, unknown>;
      frames.push(message);
      if (message["type"] === "ping") sendJson(ws, { type: "pong", replyTo: message["id"] });
      if (message["type"] !== "viewer.join") return;
      const socket = { ws, frames, join: message };
      const waiter = waiting.shift();
      if (waiter) waiter(socket);
      else ready.push(socket);
    });
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const socket = ready.shift();
        if (socket) resolve(socket);
        else waiting.push(resolve);
      }),
    get count() {
      return count;
    },
  };
}

const joined = (socket: Socket, overrides: Record<string, unknown> = {}) =>
  sendJson(socket.ws, {
    type: "viewer.joined",
    replyTo: socket.join["id"],
    sessionId: SESSION,
    viewerId: "vw_e2e",
    viewerToken: TOKEN,
    sceneVersion: 0,
    snapshotVersion: null,
    snapshotAvailable: false,
    publisherOnline: true,
    viewerCount: 1,
    viewerLimit: 20,
    profile: "mobile",
    ...overrides,
  });

const state = (socket: Socket, sceneVersion: number, snapshotVersion: number | null) =>
  sendJson(socket.ws, {
    type: "scene.state",
    sceneVersion,
    snapshotVersion,
    nodes: [],
    removed: [],
  });

/** Opens the app, joins by code and shows the scene (snapshot version 1, streamed). */
async function joinAndShow(
  page: Page,
): Promise<{ next(): Promise<Socket>; first: Socket; opened(): number }> {
  const r = await relay(page);
  await page.goto("/");
  await page.locator(".code-entry__cell").first().click();
  await page.keyboard.type(CODE);
  await page.locator(".code-entry__join").click();
  const first = await r.next();
  expect(first.join).toMatchObject({ code: CODE });
  joined(first);
  state(first, 0, null);
  streamSnapshot(first.ws, GLB);
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  return { next: r.next, first, opened: () => r.count };
}

const status = (page: Page) => page.locator(".viewer__status");

test("a dropped connection is rejoined with the token: the scene stays, no new download (US-12)", async ({
  page,
}) => {
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/scene")) downloads.push(request.url());
  });
  const { next, first } = await joinAndShow(page);
  await first.ws.close(); // the network drops
  await expect(status(page)).toHaveText("Reconnecting…");
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect(page.locator(".code-entry")).toBeHidden();
  const second = await next();
  expect(second.join).toMatchObject({ sessionId: SESSION, viewerToken: TOKEN });
  expect(second.join).not.toHaveProperty("code");
  const sha256 = createHash("sha256").update(GLB).digest("hex");
  joined(second, {
    sceneVersion: 1,
    snapshotVersion: 1,
    snapshotAvailable: true,
    snapshot: { sceneVersion: 1, byteLength: GLB.length, sha256, format: "glb" },
  });
  state(second, 1, 1);
  await expect(status(page)).toBeHidden();
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  expect(downloads).toEqual([]); // the version it shows is the one the relay caches
});

test("after a relay restart the viewer joins by its code again, waits for the presenter and shows the new scene (§13 step 9)", async ({
  page,
}) => {
  test.setTimeout(60_000); // the second code join runs ≈ 15 s after the session was lost
  const { next, first } = await joinAndShow(page);
  await first.ws.close({ code: 4008, reason: "restarting" });
  const second = await next(); // within 0–3 s
  expect(second.join).toMatchObject({ viewerToken: TOKEN });
  sendJson(second.ws, {
    type: "error",
    replyTo: second.join["id"],
    code: "SESSION_NOT_FOUND",
    message: "no such session",
    retryable: false,
  });
  await expect(status(page)).toHaveText("Reconnecting…");
  const third = await next(); // the presenter's head start: ≈ 4–6 s
  expect(third.join).toMatchObject({ code: CODE });
  expect(third.join).not.toHaveProperty("viewerToken");
  // The presenter has not re-created the session yet: the old scene stays while the viewer keeps trying.
  sendJson(third.ws, {
    type: "error",
    replyTo: third.join["id"],
    code: "INVALID_CODE",
    message: "invalid code",
    retryable: false,
  });
  await third.ws.close({ code: 4004, reason: "invalid code" });
  await expect(status(page)).toHaveText("Reconnecting…");
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect(page.locator(".code-entry")).toBeHidden();
  const fourth = await next(); // ≈ 15 s after SESSION_NOT_FOUND
  expect(fourth.join).toMatchObject({ code: CODE });
  joined(fourth, { sessionId: "sess_E2E1111111111111", viewerToken: `vt_${"B".repeat(43)}` });
  state(fourth, 0, null);
  await expect(page.locator(".code-entry")).toBeVisible(); // a new session: the old scene went with the old one
  await expect(page.locator(".code-entry__status")).toHaveText("Waiting for the presenter");
  streamSnapshot(fourth.ws, GLB); // the presenter shares the scene again as version 1
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  await expect(page.locator(".code-entry")).toBeHidden();
});

test("an open notice over the scene does not cover 'Reconnecting…'", async ({ page }) => {
  const { first } = await joinAndShow(page);
  // A snapshot above this device's 32 MiB: refused, the old scene stays with a notice over it.
  sendJson(first.ws, {
    type: "scene.snapshot.begin",
    sceneVersion: 2,
    byteLength: 40 * 1024 * 1024,
    sha256: "a".repeat(64),
    chunkCount: 640,
    chunkSize: 65_536,
    format: "glb",
    extensionsUsed: [],
  });
  const notice = page.locator(".viewer__notice");
  await expect(notice).toBeVisible();
  await first.ws.close();
  await expect(status(page)).toHaveText("Reconnecting…");
  const a = (await notice.boundingBox())!;
  const b = (await status(page).boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height); // below the notice, not under it
});

test("the presenter going offline and back is shown over the scene (§4.6)", async ({ page }) => {
  const { first } = await joinAndShow(page);
  sendJson(first.ws, {
    type: "session.publisherState",
    online: false,
    graceEndsAt: Date.now() + 120_000,
  });
  await expect(status(page)).toHaveText("Presenter is offline");
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
  sendJson(first.ws, { type: "session.publisherState", online: true });
  await expect(status(page)).toBeHidden();
});

test("the end of the presentation goes to the code entry and is not retried (4001)", async ({
  page,
}) => {
  const { first, opened } = await joinAndShow(page);
  sendJson(first.ws, { type: "session.closed", sessionId: SESSION, reason: "PUBLISHER_CLOSED" });
  await first.ws.close({ code: 4001, reason: "closed" });
  await expect(page.locator(".code-entry")).toBeVisible();
  await expect(page.locator(".code-entry__message")).toContainText("Presentation ended");
  await expect(page.locator(".code-entry__join")).toBeEnabled();
  await page.waitForTimeout(2_000); // a retry would come within 0.5 s
  expect(opened()).toBe(1);
});

test("leaving the page sends viewer.leave (§5.4)", async ({ page }) => {
  const { first } = await joinAndShow(page);
  await page.goto("about:blank");
  await expect.poll(() => first.frames.map((f) => f["type"])).toContain("viewer.leave");
});
