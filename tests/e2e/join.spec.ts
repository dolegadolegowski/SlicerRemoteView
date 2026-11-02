// QA-03 system E2E happy paths (docs/plan/qa.md), on the `iphone15` and `pixel7` projects: the built relay serving
// the built viewer, fake-slicer publishing `asymmetric-2nodes.glb`, a real browser joining.
//   (a) typing the code shows the model: canvas pixels and node-panel rows equal to `manifest.json` (US-06, FR-35);
//       records the Join-click → first-frame time as a metric (NFR-01 Wi-Fi bound < 4 s, not gating yet);
//   (b) the deep link `/j#CODE` joins; the URL ends as `/j` without a fragment and the join adds no history entry
//       (US-07, FR-36; web-viewer README "Deep link (WEB-11)");
//   (c) a second viewer joins and fake-slicer's `--json` events reach `viewer.count` 2 (US-16, FR-37; §5.3);
//   (d) a join after the snapshot was acknowledged loads it with `GET /api/scene/:v` and `Authorization: Bearer`
//       (US-11; §5.2, §6.5, §10).
// Every scenario asserts that no request or WebSocket URL, and no request header, carries the code (NFR-15, T6;
// §10); (d) also that the viewer token travels only as `Authorization`. Secrets stay in memory (NFR-12):
// assertions about the code and tokens are booleans, never `toContain(secret)`, URL assertions that could print a
// secret run after the leak checks, and browser calls that take the code are wrapped in `redacted()` so a failure
// (e.g. Playwright's `navigating to "…/j#CODE"` call log) prints no code.
// Rate limits (§12): a browser counts as 127.0.0.1 and every test has its own relay; no test joins more than
// twice by code (limit 10/min).

import type { Page, Request } from "@playwright/test";
import { expect, test } from "../harness/fixtures.ts";
import {
  expectModelLoaded,
  footprint,
  hasWebGl2,
  joinByCode,
  openNodePanel,
  settled,
} from "./support/viewer.ts";
import {
  codeInAnyHeader,
  codeInAnyUrl,
  fixtureNodes,
  installJoinProbe,
  joinedMessages,
  joinTimes,
  manifestNodeIds,
  recordNetwork,
  redacted,
  sceneRequests,
} from "./support/qa03-join.ts";
import type { NetworkRecord } from "./support/qa03-join.ts";
import type { Stack } from "../harness/stack.ts";

const FIXTURE = "asymmetric-2nodes.glb";
const NO_WEBGL2 = "no WebGL 2 in this browser: the viewer refuses to join up front";
/** Sanity bound of the join-to-first-frame metric: the 4 s target (NFR-01) is recorded, not gated, on a shared host. */
const SANITY_BOUND_MS = 15_000;

test.use({ stackOptions: { publisher: { fixture: FIXTURE } } });

/**
 * No request/WebSocket URL of the run carried the code (NFR-15, T6), nor any request header (a `Referer` would
 * repeat a URL); the messages name no secret. Call while the record's pages are open (`allHeaders()`).
 */
async function expectNoCodeInNetwork(record: NetworkRecord, stack: Stack): Promise<void> {
  expect(record.requests.length, "requests recorded").toBeGreaterThan(0);
  expect(record.sockets.length, "WebSockets recorded").toBeGreaterThan(0);
  const { code, baseUrl } = stack;
  expect(codeInAnyUrl(record, code, baseUrl), "the session code appeared in a request URL").toBe(false);
  expect(await codeInAnyHeader(record, code, baseUrl), "the session code appeared in a request header").toBe(false);
}

/** The panel rows equal the manifest's `nodeIds` in order (§7.3) and show each node's display name. */
async function expectPanelMatchesManifest(page: Page): Promise<void> {
  const ids = manifestNodeIds(FIXTURE);
  const names = new Map(fixtureNodes(FIXTURE).map((n) => [n.nodeId, n.name]));
  await openNodePanel(page);
  const rows = page.locator(".node-panel__row");
  await expect(rows).toHaveCount(ids.length);
  expect(await rows.evaluateAll((all) => all.map((r) => (r as HTMLElement).dataset["nodeId"]))).toEqual(ids);
  await expect(page.locator(".node-panel__row .node-panel__name")).toHaveText(ids.map((id) => names.get(id)!));
}

test("(a) typing the code shows the model: canvas pixels and node-panel rows match the manifest", async ({
  stack,
  page,
  context,
}, testInfo) => {
  const network = recordNetwork(context, [page]);
  await installJoinProbe(page);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), NO_WEBGL2);

  await page.locator(".code-entry__cell").first().click();
  await redacted([stack.code], () => page.keyboard.type(stack.code));
  await page.locator(".code-entry__join").click();
  await expectModelLoaded(page);
  await expect.poll(async () => (await joinTimes(page)).frame, { timeout: 10_000 }).toBeGreaterThan(0);

  // Pixels: the model covers part of the canvas once the camera has settled.
  const area = (await footprint(page, await settled(page))).area;
  expect(area, "share of the canvas covered by the model").toBeGreaterThan(0);

  // Metric (NFR-01): Join click → model loaded and drawn (two animation frames after `data-model="loaded"`).
  const times = await joinTimes(page);
  expect(times.click).toBeGreaterThanOrEqual(0);
  const joinToFrameMs = Math.round(times.frame - times.click);
  testInfo.annotations.push({ type: "metric", description: `join-to-first-frame-ms=${joinToFrameMs}` });
  expect(joinToFrameMs).toBeGreaterThan(0);
  expect(joinToFrameMs, "join-to-first-frame sanity bound").toBeLessThan(SANITY_BOUND_MS);

  await expectPanelMatchesManifest(page);
  await expectNoCodeInNetwork(network, stack);
});

test("(b) the deep link /j#CODE joins, leaves /j without a fragment and adds no history entry", async ({
  stack,
  page,
  context,
}) => {
  const network = recordNetwork(context, [page]);
  await installJoinProbe(page);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), NO_WEBGL2);
  const before = await page.evaluate(() => history.length);

  // Another path: a new document, as when the camera app opens the QR link.
  await redacted([stack.code], () => page.goto(`${stack.baseUrl}/j#${stack.code}`));
  await expectModelLoaded(page);
  await expectPanelMatchesManifest(page);

  const after = await page.evaluate(() => ({
    pathname: location.pathname,
    hashEmpty: location.hash === "",
    search: location.search,
    length: history.length,
  }));
  // Booleans: a failing `toBe("/j")` would print a pathname such as `/j/CODE`.
  expect(after.pathname === "/j", "the address bar shows /j").toBe(true);
  expect(after.hashEmpty, "the fragment is gone from the address bar").toBe(true);
  expect(after.search === "", "no query string").toBe(true);
  expect(page.url().includes(stack.code), "page.url() still shows the code").toBe(false);
  // `history.replaceState` (WEB-11): the navigation added one entry; taking the code and joining added none.
  const { historyAtStart } = await joinTimes(page);
  expect(historyAtStart).toBe(before + 1);
  expect(after.length).toBe(historyAtStart);

  // Includes the navigation to `/j#CODE` itself: its request URL has no fragment (never sent, RFC 3986 §3.5).
  await expectNoCodeInNetwork(network, stack);
});

test("(c) a second viewer joins and fake-slicer reports viewer.count 2", async ({ stack, page, context, browser }) => {
  const network = recordNetwork(context, [page]);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), NO_WEBGL2);
  await redacted([stack.code], () => joinByCode(page, stack.baseUrl, stack.code));
  await expectModelLoaded(page);
  await stack.publisher!.waitForEvent((e) => "event" in e && e.event === "viewer.count" && e.count === 1, 20_000);

  // In Playwright Test `browser.newContext()` gets the project's context options (device, viewport, user agent):
  // node_modules/playwright/lib/index.js `runBeforeCreateBrowserContext` merges `_combinedContextOptions`.
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    expect(second.viewportSize(), "the second viewer emulates the same device").toEqual(page.viewportSize());
    const secondNetwork = recordNetwork(secondContext, [second]);
    await redacted([stack.code], () => joinByCode(second, stack.baseUrl, stack.code));
    await expectModelLoaded(second);
    const event = await stack.publisher!.waitForEvent(
      (e) => "event" in e && e.event === "viewer.count" && e.count === 2,
      20_000,
    );
    expect(event).toEqual({ event: "viewer.count", count: 2 });
    // Both viewers keep the scene; each got its own `viewer.joined` with a viewer count of at least its own join.
    await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
    const counts = [...joinedMessages(network), ...joinedMessages(secondNetwork)].map((m) => m["viewerCount"]);
    expect(counts).toEqual([1, 2]);
    await expectNoCodeInNetwork(secondNetwork, stack);
  } finally {
    await secondContext.close();
  }
  await expectNoCodeInNetwork(network, stack);
});

test("(d) a join after the snapshot ack loads it over GET /api/scene/:v with a Bearer token", async ({
  stack,
  page,
  context,
}) => {
  // The harness resolves the stack only after fake-slicer's snapshot was acknowledged: every join here is late.
  await stack.publisher!.waitForOutput("snapshot 1 acknowledged");
  const network = recordNetwork(context, [page]);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), NO_WEBGL2);
  await redacted([stack.code], () => joinByCode(page, stack.baseUrl, stack.code));
  await expectModelLoaded(page);
  // Secrets first: the URL assertions below print URLs on failure, so they run only once no secret is in one.
  await expectNoCodeInNetwork(network, stack);

  // `viewer.joined` announced the cached snapshot (§5.2), and the viewer took the HTTP path (§6.5).
  const joined = joinedMessages(network);
  expect(joined).toHaveLength(1);
  const announced = joined[0]!;
  expect(announced["snapshotAvailable"]).toBe(true);
  const snapshot = announced["snapshot"] as { sceneVersion: number; byteLength: number; sha256: string };
  const token = announced["viewerToken"];
  expect(typeof token === "string" && token.length >= 22, "viewer.joined carries a viewer token").toBe(true);
  const bearer = `Bearer ${String(token)}`;

  // The token travels only as the `Authorization` of `/api/scene` requests: in no URL, in no other header (§10).
  const urls = [...network.requests.map((r) => r.url()), ...network.sockets.map((s) => s.url)];
  expect(urls.some((u) => u.includes(String(token))), "the viewer token appeared in a URL").toBe(false);
  const scenes = sceneRequests(network);
  const elsewhere = await Promise.all(
    network.requests.map(async (r) =>
      Object.entries(await r.allHeaders()).some(
        ([name, value]) => value.includes(String(token)) && !(scenes.includes(r) && name === "authorization"),
      ),
    ),
  );
  expect(elsewhere.some(Boolean), "the viewer token appeared in a header other than Authorization").toBe(false);

  expect(scenes.length).toBeGreaterThanOrEqual(1);
  const scene: Request = scenes[0]!;
  expect(scene.method()).toBe("GET");
  expect(new URL(scene.url()).pathname).toBe(`/api/scene/${snapshot.sceneVersion}`);
  expect(new URL(scene.url()).search).toBe("");
  // `allHeaders()` includes security-related headers such as Authorization (playwright-core types.d.ts, Request).
  const authorization = (await scene.allHeaders())["authorization"] ?? "";
  expect(/^Bearer [A-Za-z0-9_-]{22,}$/.test(authorization), "Authorization: Bearer <viewerToken>").toBe(true);
  expect(authorization === bearer, "the Bearer is the token from viewer.joined").toBe(true);
  // §10: `200` with `Content-Type: model/gltf-binary`, `Content-Length`, `ETag: "<sha256>"`, `X-Scene-Version`.
  const response = await scene.response();
  expect(response?.status()).toBe(200);
  const headers = (await response?.allHeaders()) ?? {};
  expect(headers["content-type"]).toBe("model/gltf-binary");
  expect(headers["x-scene-version"]).toBe(String(snapshot.sceneVersion));
  expect(headers["etag"]).toBe(`"${snapshot.sha256}"`);
  expect(Number(headers["content-length"])).toBe(snapshot.byteLength);
  // Not streamed: a late joiner gets no snapshot chunks on the WebSocket (§6.5).
  expect(network.sockets.reduce((n, s) => n + s.binaryFrames, 0)).toBe(0);
  // The WebSocket is the relay's `/ws` without a query (§3.1, §10).
  expect(network.sockets.map((s) => new URL(s.url).pathname)).toEqual(["/ws"]);
  expect(network.sockets.every((s) => new URL(s.url).search === ""), "no query on the WebSocket URL").toBe(true);
});
