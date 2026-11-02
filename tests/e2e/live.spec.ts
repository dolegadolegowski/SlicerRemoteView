// QA-04 system E2E, live scene: the built relay, the built viewer on the phone projects (iphone15 WebKit, pixel7
// Chromium) and a publisher — fake-slicer, or the spec itself as a raw `ws` publisher where it must know exactly when
// each `scene.update` left (latency). Covers:
// - `scene.update` visibility / colour / opacity / matrix each reflected by the viewer; update-to-render latency over
//   50 updates, p95 ≤ 500 ms (NFR-02, US-02; §8.1, §8.4);
// - a late joiner's node states (rows, and the matrix on the canvas) equal the first viewer's after `scene.state`
//   (FR-42, US-11; §5.2, §8.3);
// - fake-slicer's bundled `reload-scene` → a new snapshot: the panel lists only the new nodes, the old geometry is
//   disposed (US-18; §6, §8.2);
// - the viewer's socket dropped → token rejoin, scene kept (no download, no streamed copy), live updates continue
//   (US-12, NFR-19; §5.1, §6.5, §9.3);
// - `--close-after` → `session.closed{PUBLISHER_CLOSED}` + close `4001`, "Presentation ended", no retry (§4.5, §9.3);
// - relay restart (SIGTERM → `4008` drain, new relay on the same port) → fake-slicer re-creates the session with its
//   `preferredCode`; the viewer's token rejoin gets `SESSION_NOT_FOUND`, it joins by the same code, and the scene is
//   back (US-05, US-12, NFR-19, NFR-20, T9; §4.1, §4.3, §5.1, §9.3, §13 step 9).
// The viewer exposes state in the DOM only (web-viewer/src/ui/node-panel.ts: `.node-panel__row[data-node-id]` with
// `aria-checked`, `.node-panel__swatch` background colour, `.node-panel__opacity` `aria-valuetext`; status bar
// `Scene v<n>`). The rows are read back from the scene graph itself (`T.visible`, the node material's colour and
// opacity), so they are the material probe; matrix changes are checked on the canvas. Codes and tokens stay in
// memory: assertions about them are booleans (NFR-12).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page, TestInfo, WebSocketRoute } from "@playwright/test";
import { Color, LinearSRGBColorSpace } from "three";
import { FAKE_SLICER_BIN } from "../harness/paths.ts";
import { expect, test } from "../harness/fixtures.ts";
import {
  footprint,
  hasWebGl2,
  joinByCode,
  expectModelLoaded,
  nodeRow,
  openNodePanel,
  settled,
} from "./support/viewer.ts";
import {
  closeCodes,
  installProbe,
  percentile,
  primitiveCount,
  recordCloseCodes,
  recordFrames,
  seen,
  startTestPublisher,
} from "./support/qa04-publisher.ts";
import type { Change, Seen, TestPublisher } from "./support/qa04-publisher.ts";

const SEGMENT = "vtkMRMLSegmentationNode1/Segment_1";
const MODEL = "vtkMRMLModelNode2";
const NEW_NODE = "vtkMRMLModelNode3"; // the only node of quantized-1node.glb (reload-scene)
const FIXTURE = "asymmetric-2nodes.glb";

/** The swatch colour the viewer shows for a linear glTF colour (§7.4), spaces removed (browser serialisation). */
const css = ([r, g, b]: readonly number[]) =>
  new Color().setRGB(r!, g!, b!, LinearSRGBColorSpace).getStyle().replace(/\s/g, "");
const translation = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** A second browser context with this project's device emulation (viewport, UA, touch), for a second phone. */
async function secondPhone(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
  return browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
}

/** Opens the node panel unless it is open (the toggle closes an open one; a new model keeps the state). */
async function ensurePanelOpen(page: Page): Promise<void> {
  if ((await page.locator(".node-panel__toggle").getAttribute("aria-expanded")) !== "true")
    await openNodePanel(page);
  await expect(page.locator(".node-panel__toggle")).toHaveAttribute("aria-expanded", "true");
}

/** Joins `code` on `page`, waits for the model and opens the node panel. */
async function joinAndOpen(page: Page, baseUrl: string, code: string): Promise<void> {
  await joinByCode(page, baseUrl, code);
  await expectModelLoaded(page, 30_000);
  await ensurePanelOpen(page);
  await expect(page.locator(".node-panel__row").first()).toBeVisible();
}

/** What each row shows: visibility, swatch colour, opacity — per node id. */
async function rowStates(page: Page): Promise<Record<string, [string, string, string]>> {
  return page.locator(".node-panel__item").evaluateAll((items) =>
    Object.fromEntries(
      items.map((item) => {
        const row = item.querySelector<HTMLElement>(".node-panel__row")!;
        const swatch = item.querySelector<HTMLElement>(".node-panel__swatch")!;
        const slider = item.querySelector<HTMLElement>(".node-panel__opacity")!;
        return [
          row.dataset["nodeId"] ?? "",
          [
            row.getAttribute("aria-checked") ?? "",
            swatch.style.backgroundColor.replace(/\s/g, ""),
            slider.getAttribute("aria-valuetext") ?? "",
          ],
        ];
      }),
    ),
  );
}

/**
 * Records every value of the viewer's `data-model` (`loaded` / `none`, web-viewer/src/render/viewer.ts), so a spec
 * can tell "the scene stayed" from "the scene was dropped and loaded again". Read with `modelHistory(page)`.
 */
async function recordModelState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const history: string[] = [];
    (window as unknown as { __qa04model: string[] }).__qa04model = history;
    new MutationObserver(() => {
      const value = document.querySelector<HTMLElement>(".viewer")?.dataset["model"] ?? "absent";
      if (history.at(-1) !== value) history.push(value);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-model"] });
  });
}
const modelHistory = (page: Page) =>
  page.evaluate(() => (window as unknown as { __qa04model: string[] }).__qa04model.slice());

/** Whether the code entry cells hold `code` (boolean only: the code is never printed). */
async function cellsHold(page: Page, code: string): Promise<boolean> {
  const values = await page.locator(".code-entry__cell").evaluateAll((cells) =>
    cells.map((c) => (c as HTMLInputElement).value).join(""),
  );
  return values === code;
}

test.describe("live scene, the spec as publisher", () => {
  let publisher: TestPublisher | undefined;
  test.afterEach(() => publisher?.close());

  test("scene.update visibility, colour, opacity and matrix reach the viewer; p95 update-to-render ≤ 500 ms over 50 updates (NFR-02)", async ({
    page,
    startStack,
  }, testInfo) => {
    test.setTimeout(120_000);
    const stack = await startStack({ publisher: false });
    publisher = await startTestPublisher(stack.wsUrl, FIXTURE);
    await installProbe(page);
    await page.goto(`${stack.baseUrl}/`);
    test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
    await joinAndOpen(page, stack.baseUrl, publisher.code);
    // `scene.state` after `viewer.joined` is applied once the GLB is shown (§8.3): wait for the version line.
    await expect(page.locator(".status-bar__version")).toHaveText("Scene v1");

    // Matrix: a `T.matrix` replacement moves the segment on screen (§8.1, §7.2: glTF metres).
    const before = await footprint(page, await settled(page));
    publisher.update([{ nodeId: SEGMENT, matrix: translation(0.06) }]);
    await expect(page.locator(".status-bar__version")).toHaveText("Scene v2");
    const after = await footprint(page, await settled(page));
    expect(after.area, "the model is still drawn").toBeGreaterThan(0);
    expect(Math.hypot(after.x - before.x, after.y - before.y), "the model moved").toBeGreaterThan(0.02);

    // 50 updates, one property each, cycling visibility → colour → opacity → matrix over both nodes, 150 ms apart
    // (well inside the publisher budget of relay-server/src/ws/budget.ts: ≈ 128 frames/s, and the 100–250 ms
    // debounce of §8.1). Each expected DOM value differs from the row's current one, so the first matching change
    // after the send is that update's. Matrix has no DOM trace but the status bar's `Scene v<n>`.
    const initial = await rowStates(page);
    const state: Record<string, { visible: boolean; color: string; opacity: string }> = {
      [SEGMENT]: { visible: initial[SEGMENT]![0] === "true", color: initial[SEGMENT]![1], opacity: initial[SEGMENT]![2] },
      [MODEL]: { visible: initial[MODEL]![0] === "true", color: initial[MODEL]![1], opacity: initial[MODEL]![2] },
    };
    const palette: [number, number, number][] = [
      [0.9, 0.2, 0.2],
      [0.2, 0.8, 0.3],
      [0.25, 0.3, 0.95],
      [0.9, 0.8, 0.1],
      [0.7, 0.2, 0.8],
    ];
    const opacities = [0.25, 0.5, 0.75, 0.4, 0.9, 0.6];
    const sent: { sentAt: number; node: string; prop: Seen["prop"]; value: string }[] = [];
    for (let i = 0; i < 50; i++) {
      const kind = (["visible", "color", "opacity", "matrix"] as const)[i % 4]!;
      const nodeId = Math.floor(i / 4) % 2 === 0 ? SEGMENT : MODEL;
      const node = state[nodeId]!;
      let change: Change;
      let expected: { node: string; prop: Seen["prop"]; value: string };
      if (kind === "visible") {
        node.visible = !node.visible;
        change = { nodeId, visible: node.visible };
        expected = { node: nodeId, prop: "visible", value: String(node.visible) };
      } else if (kind === "color") {
        const color = palette.find((c, k) => css(c) !== node.color && k >= i % palette.length) ??
          palette.find((c) => css(c) !== node.color)!;
        node.color = css(color);
        change = { nodeId, color };
        expected = { node: nodeId, prop: "color", value: node.color };
      } else if (kind === "opacity") {
        const opacity = opacities.find((o) => `${Math.round(o * 100)} %` !== node.opacity && o !== opacities[i % 6]) ??
          opacities.find((o) => `${Math.round(o * 100)} %` !== node.opacity)!;
        node.opacity = `${Math.round(opacity * 100)} %`;
        change = { nodeId, opacity };
        expected = { node: nodeId, prop: "opacity", value: node.opacity };
      } else {
        change = { nodeId, matrix: translation(((i % 3) - 1) * 0.02, 0.01 * (i % 2)) };
        expected = { node: "", prop: "version", value: `Scene v${publisher.sceneVersion + 1}` };
      }
      sent.push({ sentAt: publisher.update([change]), ...expected });
      await page.waitForTimeout(150);
    }
    await expect(page.locator(".status-bar__version")).toHaveText(`Scene v${publisher.sceneVersion}`);
    await page.waitForTimeout(200); // the last animation frame stamp
    expect(publisher.errors().map((e) => e["code"]), "the relay refused no update").toEqual([]);

    const log = await seen(page);
    const domMs: number[] = [];
    const frameMs: number[] = [];
    const missing: string[] = [];
    for (const [i, s] of sent.entries()) {
      const hit = log.find((e) => e.node === s.node && e.prop === s.prop && e.value === s.value && e.at >= s.sentAt);
      if (!hit) {
        missing.push(`#${i} ${s.prop}`); // property and index only: node ids are scene content (§9.2)
        continue;
      }
      domMs.push(hit.at - s.sentAt);
      frameMs.push((hit.frame || hit.at) - s.sentAt);
    }
    expect(missing, "every update was reflected in the viewer").toEqual([]);
    const p50 = percentile(frameMs, 50);
    const p95 = percentile(frameMs, 95);
    testInfo.annotations.push(
      { type: "NFR-02 updates", description: String(frameMs.length) },
      { type: "NFR-02 p50 ms (send → next frame)", description: String(p50) },
      { type: "NFR-02 p95 ms (send → next frame)", description: String(p95) },
      { type: "NFR-02 max ms (send → next frame)", description: String(Math.max(...frameMs)) },
      { type: "NFR-02 p95 ms (send → DOM)", description: String(percentile(domMs, 95)) },
    );
    expect(frameMs).toHaveLength(50);
    expect(p95, "p95 update-to-render latency (NFR-02)").toBeLessThanOrEqual(500);

    // The final row states are the last values the presenter sent.
    const final = await rowStates(page);
    for (const nodeId of [SEGMENT, MODEL]) {
      const want = state[nodeId]!;
      expect(final[nodeId], nodeId === SEGMENT ? "segment row" : "model row").toEqual([String(want.visible), want.color, want.opacity]);
    }
  });

  test("a late joiner's node states equal the first viewer's after scene.state (FR-42, US-11)", async ({
    page,
    browser,
    startStack,
  }, testInfo) => {
    const stack = await startStack({ publisher: false });
    publisher = await startTestPublisher(stack.wsUrl, FIXTURE);
    await page.goto(`${stack.baseUrl}/`);
    test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
    await joinAndOpen(page, stack.baseUrl, publisher.code);
    const updates: Change[][] = [
      [{ nodeId: SEGMENT, visible: false }],
      [{ nodeId: MODEL, color: [0.2, 0.8, 0.3] }],
      [{ nodeId: SEGMENT, opacity: 0.35 }],
      [{ nodeId: MODEL, opacity: 0.6, color: [0.9, 0.8, 0.1] }], // last writer wins per property (§8.1)
      [{ nodeId: SEGMENT, color: [0.7, 0.2, 0.8] }],
    ];
    for (const changes of updates) {
      publisher.update(changes);
      await page.waitForTimeout(150);
    }
    await expect(page.locator(".status-bar__version")).toHaveText(`Scene v${publisher.sceneVersion}`);
    // The matrix last, measured on the canvas: only the model is drawn (the segment is hidden), so its footprint
    // moves with the new `T.matrix`; the late joiner must draw it in the same place.
    const unmoved = await footprint(page, await settled(page));
    publisher.update([{ nodeId: MODEL, matrix: translation(0.06) }]);
    await expect(page.locator(".status-bar__version")).toHaveText(`Scene v${publisher.sceneVersion}`);
    const moved = await footprint(page, await settled(page));
    expect(moved.area, "the model is still drawn").toBeGreaterThan(0);
    expect(Math.hypot(moved.x - unmoved.x, moved.y - unmoved.y), "the matrix moved the model").toBeGreaterThan(0.02);
    const presenter = await rowStates(page);
    // The presenter's changes are on the first viewer (so the comparison below is not two untouched scenes).
    expect(presenter[SEGMENT]).toEqual(["false", css([0.7, 0.2, 0.8]), "35 %"]);
    expect(presenter[MODEL]).toEqual(["true", css([0.9, 0.8, 0.1]), "60 %"]);

    const context = await secondPhone(browser, testInfo);
    try {
      const late = await context.newPage();
      await joinAndOpen(late, stack.baseUrl, publisher.code);
      await expect(late.locator(".status-bar__version")).toHaveText(`Scene v${publisher.sceneVersion}`);
      await expect.poll(() => rowStates(late), { timeout: 10_000 }).toEqual(presenter);
      // Same viewport, same snapshot, same fitted camera: the matrix from `scene.state` puts the model where the
      // first viewer draws it (well under the 0.02 it moved).
      const lateFootprint = await footprint(late, await settled(late));
      const shift = Math.hypot(moved.x - unmoved.x, moved.y - unmoved.y);
      const offset = Math.hypot(lateFootprint.x - moved.x, lateFootprint.y - moved.y);
      testInfo.annotations.push(
        { type: "FR-42 matrix move (canvas units)", description: shift.toFixed(4) },
        { type: "FR-42 late joiner offset (canvas units)", description: offset.toFixed(4) },
      );
      expect(offset, "late joiner: same place").toBeLessThan(0.005);
      expect(Math.abs(lateFootprint.area - moved.area) / moved.area, "late joiner: same size").toBeLessThan(0.1);
      expect(publisher.errors()).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a dropped viewer socket is rejoined with the viewer token: the scene stays and live updates continue (US-12, NFR-19)", async ({
    page,
    startStack,
  }) => {
    const stack = await startStack({ publisher: false });
    publisher = await startTestPublisher(stack.wsUrl, FIXTURE);
    // A transparent proxy for every page socket (Playwright WebSocketRoute, tests/node_modules/playwright-core/
    // types/types.d.ts: `connectToServer()` connects to the real relay; once `onMessage` is set on a side, that side's
    // frames are no longer forwarded automatically, so each handler forwards them itself).
    const sockets: {
      page: WebSocketRoute;
      server: WebSocketRoute;
      fromPage: string[];
      fromServer: string[];
      binaryFromServer: number;
    }[] = [];
    await recordModelState(page);
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      const socket = { page: ws, server, fromPage: [] as string[], fromServer: [] as string[], binaryFromServer: 0 };
      sockets.push(socket);
      ws.onMessage((message) => {
        if (typeof message === "string") socket.fromPage.push(message);
        server.send(message);
      });
      server.onMessage((message) => {
        if (typeof message === "string") socket.fromServer.push(message);
        else socket.binaryFromServer++;
        ws.send(message);
      });
    });
    const downloads: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/scene")) downloads.push(r.method());
    });
    await page.goto(`${stack.baseUrl}/`);
    test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
    await joinAndOpen(page, stack.baseUrl, publisher.code);
    await expect(page.locator(".status-bar__connection")).toHaveText("Connected");
    expect(sockets).toHaveLength(1);
    const parse = (frames: string[]) => frames.map((f) => JSON.parse(f) as Record<string, unknown>);
    const firstJoined = parse(sockets[0]!.fromServer).find((m) => m["type"] === "viewer.joined");
    expect(firstJoined, "viewer.joined went through the proxy").toBeDefined();
    const downloadsBefore = downloads.length;
    const historyBefore = (await modelHistory(page)).length;
    expect((await modelHistory(page)).at(-1), "the model recorder works (it saw the load)").toBe("loaded");

    // The network drops: both sides of the page's socket close (the relay sees a client going away).
    const first = sockets[0]!;
    await first.server.close({ code: 1001, reason: "qa drop" });
    await first.page.close({ code: 1001, reason: "qa drop" });

    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => parse(sockets[1]!.fromPage).some((m) => m["type"] === "viewer.join"), { timeout: 15_000 })
      .toBe(true);
    const rejoin = parse(sockets[1]!.fromPage).find((m) => m["type"] === "viewer.join")!;
    // §5.1: exactly one of `code` or `sessionId` + `viewerToken`; the token is the one the relay issued.
    expect("code" in rejoin, "the rejoin carries no code").toBe(false);
    expect(rejoin["sessionId"] === firstJoined!["sessionId"], "rejoin names the same session").toBe(true);
    expect(
      typeof rejoin["viewerToken"] === "string" && rejoin["viewerToken"] === firstJoined!["viewerToken"],
      "rejoin carries the issued viewer token",
    ).toBe(true);
    await expect
      .poll(() => parse(sockets[1]!.fromServer).some((m) => m["type"] === "viewer.joined"), { timeout: 15_000 })
      .toBe(true);
    await expect(page.locator(".status-bar__connection")).toHaveText("Connected", { timeout: 15_000 });
    await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible();
    await expect(page.locator(".code-entry")).toBeHidden();
    expect(downloads.length, "the scene was kept: no new download").toBe(downloadsBefore);
    // Nor a streamed copy (§6.5): the rejoin's reply is `viewer.joined` + `scene.state` for the scene it holds.
    const second = parse(sockets[1]!.fromServer);
    expect(second.some((m) => m["type"] === "scene.snapshot.begin"), "no snapshot streamed on the rejoin").toBe(false);
    expect(sockets[1]!.binaryFromServer, "no chunk frames on the rejoin").toBe(0);
    expect(second.some((m) => m["type"] === "scene.state"), "scene.state follows the rejoin (§5.2)").toBe(true);
    expect((await modelHistory(page)).slice(historyBefore), "the model was never dropped").toEqual([]);
    expect(await cellsHold(page, publisher.code), "the same code is still in the code entry").toBe(true);

    // The live path works on the new socket.
    publisher.update([{ nodeId: SEGMENT, visible: false }]);
    await expect(nodeRow(page, SEGMENT)).toHaveAttribute("aria-checked", "false");
    expect(sockets).toHaveLength(2);
  });
});

test("reload-scene: a new snapshot replaces the scene; the panel lists only the new nodes and the old geometry is disposed (US-18)", async ({
  page,
  startStack,
}, testInfo) => {
  test.setTimeout(90_000);
  // The bundled script, its first pause stretched so the viewer is joined (and has the old scene) before it runs.
  const bundled = path.join(path.dirname(FAKE_SLICER_BIN), "..", "scripts", "reload-scene.json");
  const script = JSON.parse(readFileSync(bundled, "utf8")) as { afterMs: number }[];
  script[0]!.afterMs = 12_000;
  const scriptPath = testInfo.outputPath("reload-scene-delayed.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const stack = await startStack({ publisher: { script: scriptPath } });
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
  await joinAndOpen(page, stack.baseUrl, stack.code);
  const rows = page.locator(".node-panel__row");
  await expect(rows).toHaveCount(2);
  const rendered = () =>
    page.evaluate(() => (window as unknown as { __rv: { rendererInfo(): { geometries: number } | null } }).__rv.rendererInfo());
  await settled(page);
  // The probe counts what the GPU holds; check it against the old scene first so the later check means something.
  expect((await rendered())?.geometries).toBe(await primitiveCount(FIXTURE));

  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(nodeRow(page, NEW_NODE)).toBeVisible();
  await expect(nodeRow(page, SEGMENT)).toHaveCount(0);
  await expect(nodeRow(page, MODEL)).toHaveCount(0);
  // The script's last entry, an update of the new node, applies to the new scene.
  await expect(nodeRow(page, NEW_NODE).locator(".node-panel__swatch")).toHaveCSS(
    "background-color",
    new Color().setRGB(0.9, 0.5, 0.2, LinearSRGBColorSpace).getStyle().replace(/,/g, ", "),
    { timeout: 10_000 },
  );
  await settled(page);
  await expect.poll(async () => (await rendered())?.geometries).toBe(await primitiveCount("quantized-1node.glb"));
});

test("session end: fake-slicer --close-after → session.closed + close 4001, the viewer shows 'Presentation ended' (§4.5, §9.3)", async ({
  page,
  startStack,
}) => {
  test.setTimeout(90_000);
  const stack = await startStack({ publisher: { args: ["--close-after", "12000"] } });
  await recordCloseCodes(page);
  const frames = recordFrames(page);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
  await joinByCode(page, stack.baseUrl, stack.code);
  await expectModelLoaded(page, 30_000);
  // String key `message.sessionEnded.title` (web-viewer/src/i18n/strings.ts), English by the default locale.
  await expect(page.locator(".code-entry__message")).toContainText("Presentation ended", { timeout: 30_000 });
  await expect(page.locator(".code-entry")).toBeVisible();
  await expect(page.locator(".viewer[data-model='loaded']")).toHaveCount(0);
  expect(await stack.publisher!.exited).toBe(0);
  // §4.5: `session.closed{reason: PUBLISHER_CLOSED}` to the viewer, then close `4001` — the end the UI showed.
  const closed = frames.filter((f) => f.dir === "received" && f.message["type"] === "session.closed");
  expect(closed.map((f) => f.message["reason"]), "session.closed reached the viewer once").toEqual([
    "PUBLISHER_CLOSED",
  ]);
  await expect.poll(() => closeCodes(page)).toEqual([4001]);
  // Not retried (4001 is final, §9.3): no other socket, and the relay holds no session or viewer a little later.
  await page.waitForTimeout(2_000);
  expect(await closeCodes(page), "no reconnect after 4001").toEqual([4001]);
  expect(new Set(frames.map((f) => f.socket)).size, "one socket only").toBe(1);
  const health = (await (await fetch(`${stack.baseUrl}/healthz`)).json()) as { sessions: number; viewers: number };
  expect(health).toMatchObject({ sessions: 0, viewers: 0 });
});

test("relay restart: fake-slicer re-creates the session with the same code, the viewer joins by it again and the scene is back (US-05, NFR-20, T9)", async ({
  page,
  stack,
}) => {
  test.setTimeout(120_000);
  await recordModelState(page);
  await recordCloseCodes(page);
  const frames = recordFrames(page);
  await page.goto(`${stack.baseUrl}/`);
  test.skip(!(await hasWebGl2(page)), "no WebGL 2 in this headless browser, so the viewer cannot open");
  const code = stack.code;
  await joinAndOpen(page, stack.baseUrl, code);
  await expect(nodeRow(page, MODEL)).toBeVisible();
  const eventsBefore = stack.publisher!.events.length;
  const historyBefore = (await modelHistory(page)).length;
  const framesBefore = frames.length;
  const firstJoined = frames.find((f) => f.dir === "received" && f.message["type"] === "viewer.joined");
  expect(firstJoined, "the first viewer.joined was seen").toBeDefined();

  await stack.restartRelay(); // SIGTERM → `4008` to every socket, then a new relay on the same port
  const recreated = await stack.publisher!.waitForEvent(
    (e) => "event" in e && e.event === "session.recreated",
    40_000,
  );
  expect(recreated, "the relay granted the preferredCode (§4.1)").toMatchObject({ codeChanged: false });
  expect(stack.code === code, "the publisher holds the same code").toBe(true);
  // The viewer joined the new session: fake-slicer hears `viewer.count` 1 after the re-creation (§5.3).
  const recreatedAt = stack.publisher!.events.indexOf(recreated);
  await stack.publisher!.waitForEvent(
    (e) => {
      const at = stack.publisher!.events.indexOf(e);
      return at > eventsBefore && at > recreatedAt && "event" in e && e.event === "viewer.count" && e["count"] === 1;
    },
    45_000,
  );
  await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".code-entry")).toBeHidden();
  await expect(page.locator(".status-bar__connection")).toHaveText("Connected", { timeout: 15_000 });
  await expect(page.locator(".status-bar__version")).toHaveText("Scene v1");

  // §13 step 9 on the wire: the drain closed the viewer's socket with `4008`; the viewer first tried its token
  // (`SESSION_NOT_FOUND`: the new relay never saw that session), then joined by the code it still held, and the
  // relay answered with a different session. Booleans only: the frames carry the code and the token.
  expect((await closeCodes(page))[0], "the drain closed the first socket with 4008").toBe(4008);
  const after = frames.slice(framesBefore);
  const sentJoins = after.filter((f) => f.dir === "sent" && f.message["type"] === "viewer.join");
  const byToken = sentJoins.findIndex((f) => !("code" in f.message));
  const byCode = sentJoins.findIndex((f) => "code" in f.message);
  expect(byToken >= 0 && byCode > byToken, "a token rejoin came before the code join").toBe(true);
  const tokenJoin = sentJoins[byToken]!.message;
  expect(
    tokenJoin["sessionId"] === firstJoined!.message["sessionId"] &&
      tokenJoin["viewerToken"] === firstJoined!.message["viewerToken"],
    "the token rejoin named the old session and its viewer token",
  ).toBe(true);
  const notFound = after.find(
    (f) => f.dir === "received" && f.message["type"] === "error" && f.message["code"] === "SESSION_NOT_FOUND",
  );
  expect(notFound, "the token rejoin was answered SESSION_NOT_FOUND").toBeDefined();
  expect(after.indexOf(notFound!) < after.indexOf(sentJoins[byCode]!), "the code join followed it").toBe(true);
  expect(sentJoins[byCode]!.message["code"] === code, "the viewer joined with the same code").toBe(true);
  const rejoined = after.filter((f) => f.dir === "received" && f.message["type"] === "viewer.joined");
  expect(rejoined, "one viewer.joined after the restart").toHaveLength(1);
  expect(rejoined[0]!.message["sessionId"] !== firstJoined!.message["sessionId"], "a new session").toBe(true);

  // A new session: the old scene went with the old one and the re-created session's snapshot is shown (§8.4).
  await expect.poll(async () => (await modelHistory(page)).slice(historyBefore), { timeout: 15_000 }).toEqual([
    "none",
    "loaded",
  ]);
  await ensurePanelOpen(page);
  await expect(page.locator(".node-panel__row")).toHaveCount(2);
  await expect(nodeRow(page, SEGMENT)).toHaveCount(1);
  await expect(nodeRow(page, MODEL)).toHaveCount(1);
  expect(await cellsHold(page, code), "the same code is in the (hidden) code entry").toBe(true);
  const health = (await (await fetch(`${stack.baseUrl}/healthz`)).json()) as { sessions: number; viewers: number };
  expect(health).toMatchObject({ sessions: 1, viewers: 1 });
});
