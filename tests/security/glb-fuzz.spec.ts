// QA-13 GLB fuzzing: 200 mutated snapshots (tests/harness/qa13-glb-mutator.ts — bit flips, truncations, huge accessor
// counts, injected buffer/image `uri`s, two scenes, missing root extras, broken JSON chunk length, wrong chunk types,
// forbidden collections/extensions, sparse accessors, node cycles, deep JSON, random JSON edits, …) of
// `asymmetric-2nodes.glb` and `quantized-1node.glb` reach the built web viewer's real parse path through the real
// relay: snapshot stream (WEB-05) or HTTP download (WEB-06) → hash check → §7.1 pre-validator + GLTFLoader (WEB-07)
// → model or `snapshotInvalid` ("Scene could not be opened"). Every mutant must end in one of those two states,
// with zero `pageerror`/`crash` events, no request for an injected URI or to another origin, and no injected markup
// executed; mutants that §7.1 forbids must end in `snapshotInvalid`, unbroken ones must render.
//
// Requirements / threats: architecture §8 T10 (malicious or malformed GLB), R-11 (the asymmetric fixture renders:
// every reset snapshot). Protocol §6.1–§6.5 (snapshot stream, HTTP path), §7.1–§7.4 (the GLB rules the `refuse`
// mutants break), §10 (`GET /api/scene/:sceneVersion`). Plan: docs/plan/qa.md QA-13 criteria 1–3.
//
// How: the test is the publisher (raw `session.create` + fake-slicer's `sendSnapshot` with a `LoadedGlb` whose
// bytes/sha256 are the mutant's — the relay checks only the SHA-256, never the GLB, relay-server/src/ws/snapshot.ts).
// Stream batches: one Desktop Chrome page (SwiftShader WebGL 2) joins once per batch and then receives, for every
// mutant, first the unmodified base as a "reset" snapshot (version v, waited until shown with no notice — so every
// mutant meets the same viewer state and an invalid one cannot leave a stale notice), then the mutant (v + 1). The
// end state is read from the DOM: `.viewer[data-model='loaded']` with the status bar at "Scene v<v+1>", or the
// `.viewer__notice` titled "Scene could not be opened" (en-US locale). Each snapshot is paced by its
// `scene.snapshot.ack` (4 text frames per mutant: far inside the publisher budget, relay-server/src/ws/budget.ts).
// Four batches of 50 run in parallel, each with its own relay. A `benign` mutant's hostile-looking node name must
// show in the node panel as literal text (so the "no markup ran" check is not vacuous). The HTTP test replays the
// first 12 mutants to a viewer that joins after the snapshot (`viewer.joined.snapshotAvailable` → `/api/scene`),
// one join per mutant (correct joins give their attempt back, relay-server/src/ratelimit.ts; 12 upgrades < 30/min);
// the previous page is left and the publisher sees `viewer.count` 0 before each publish, so no joined viewer gets
// the mutant over the stream and the HTTP download is its only parse. Tracing is off for this file: a retained
// trace would hold the typed code and the `/api/scene` bearer token (NFR-12); the seed and index reproduce instead.
//
// Reproduce one mutant (its bytes depend only on seed and index; only the tests holding it run):
//   GLB_FUZZ_SEED=<n> GLB_FUZZ_ONLY=<index> npm --prefix tests run security -- glb-fuzz
// Options: GLB_FUZZ_SEED (decimal or 0x…, default 0x5eed13 = 6221075), GLB_FUZZ_COUNT (default 200),
// GLB_FUZZ_ONLY (one index). Failures name seed, index, kind and base only — never the file, the code or a token.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { loadGlb, sendSnapshot } from "@slicerremoteview/fake-slicer";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { LIMITS, sha256Hex } from "@slicerremoteview/shared";
import { expect, test } from "../harness/fixtures.ts";
import { FIXTURES_DIR } from "../harness/paths.ts";
import {
  BASES,
  DEFAULT_SEED,
  KINDS,
  URI_MARKER,
  XSS_FLAG,
  baseBytes,
  generateMutant,
} from "../harness/qa13-glb-mutator.ts";
import type { Mutant } from "../harness/qa13-glb-mutator.ts";
import { createSession, nextIp } from "../harness/ws-client.ts";
import type { Client } from "../harness/ws-client.ts";
import { hasWebGl2, joinByCode } from "../e2e/support/viewer.ts";

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`not a non-negative integer: ${value}`);
  return parsed;
};

const SEED = parseInteger(process.env["GLB_FUZZ_SEED"]) ?? DEFAULT_SEED;
const COUNT = parseInteger(process.env["GLB_FUZZ_COUNT"]) ?? 200;
const ONLY = parseInteger(process.env["GLB_FUZZ_ONLY"]);
const BATCHES = 4;
const PER_BATCH = Math.ceil(COUNT / BATCHES);
/** Mutants 0…11 (one of each of the first 12 kinds) also go through the HTTP path. */
const HTTP_MUTANTS = 12;
/** web-viewer/src/i18n/strings.ts `state.snapshotInvalid.title` (en). */
const INVALID_TITLE = "Scene could not be opened";
/** One snapshot's end state; generous for ~10 concurrent agents on one machine. */
const OUTCOME_TIMEOUT_MS = 20_000;

const reproduce = (index: number) =>
  `GLB_FUZZ_SEED=${SEED} GLB_FUZZ_ONLY=${index} npm --prefix tests run security -- glb-fuzz`;
const only = (indices: number[]) => indices.filter((i) => ONLY === undefined || i === ONLY);
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

type Outcome = "loaded" | "invalid";

/** The announcement data of each base (extensions and counts; the relay's schema checks `extensionsUsed`). */
const announcements = new Map<string, Promise<LoadedGlb>>(
  BASES.map((name) => [name, loadGlb(path.join(FIXTURES_DIR, name))]),
);

/** A raw publisher session; the code stays in the returned object (never printed, NFR-12). */
async function startPublisher(wsUrl: string): Promise<{ publisher: Client; code: string; nextId: () => string }> {
  const { client, created } = await createSession(wsUrl, { ip: nextIp() });
  let id = 0;
  return { publisher: client, code: String(created["code"]), nextId: () => `p-${++id}` };
}

/** Publishes `bytes` as snapshot `sceneVersion` and waits for the relay's ack (paces the publisher, budget.ts). */
async function publish(
  publisher: Client,
  nextId: () => string,
  baseName: string,
  bytes: Uint8Array,
  sceneVersion: number,
): Promise<void> {
  const glb: LoadedGlb = { ...(await announcements.get(baseName)!), bytes, sha256: await sha256Hex(bytes) };
  // fake-slicer's `sendSnapshot` takes a `ws` WebSocket: the harness client's socket is one (both ws 8).
  await sendSnapshot(publisher.socket, { glb, sceneVersion, chunkSize: LIMITS.MIN_CHUNK_BYTES, profile: "mobile" }, nextId);
  const reply = await publisher.next(
    (m) => (m.type === "scene.snapshot.ack" && m["sceneVersion"] === sceneVersion) || m.type === "error",
    15_000,
  );
  if (reply.type === "error") throw new Error(`the relay refused snapshot v${sceneVersion}: ${String(reply["code"])}`);
}

/**
 * The viewer's end state for `sceneVersion`: "loaded" once the model of that version is on screen (status bar
 * "Scene v<n>", web-viewer/src/ui/status-bar.ts), "invalid" once the snapshotInvalid message shows — over the scene
 * (`.viewer__notice`) or, before any scene was shown, on the code entry (`.code-entry__message`, "<title>. <body>").
 * `requireLoaded` (the reset) waits for "loaded" with no notice at all. API: `page.waitForFunction(fn, arg,
 * { polling, timeout })`, playwright-core/types/types.d.ts (Page.waitForFunction).
 */
async function endState(page: Page, sceneVersion: number, requireLoaded = false): Promise<Outcome> {
  const handle = await page.waitForFunction(
    ({ version, title, requireLoaded }) => {
      const viewer = document.querySelector<HTMLElement>(".viewer");
      if (viewer && !viewer.hidden) {
        const notice = viewer.querySelector<HTMLElement>(".viewer__notice");
        const noticeShown = !!notice && !notice.hidden;
        const shownVersion = viewer.querySelector(".status-bar__version")?.textContent;
        if (viewer.dataset["model"] === "loaded" && shownVersion === `Scene v${version}`)
          if (!requireLoaded || !noticeShown) return "loaded";
        if (!requireLoaded && noticeShown && viewer.querySelector(".viewer__notice-title")?.textContent === title)
          return "invalid";
        return null;
      }
      const message = document.querySelector<HTMLElement>(".code-entry__message");
      if (!requireLoaded && message && !message.hidden && message.textContent?.startsWith(`${title}.`))
        return "invalid";
      return null;
    },
    { version: sceneVersion, title: INVALID_TITLE, requireLoaded },
    { polling: 50, timeout: OUTCOME_TIMEOUT_MS },
  );
  return (await handle.jsonValue()) as Outcome;
}

interface Watch {
  /** Mutant index in flight (-1: a reset), for attributing events. */
  current: number;
  readonly pageErrors: { index: number; message: string }[];
  readonly foreignRequests: { index: number; url: string }[];
  readonly markerRequests: { index: number; url: string }[];
  readonly sceneDownloads: number[];
  readonly reasons: Map<string, number>;
  /** Reads of the logged reasons still in flight; `summary` waits for them. */
  readonly pending: Promise<void>[];
  crashed: boolean;
}

/**
 * T10 observers: uncaught exceptions and rejections, renderer crash, any request leaving the relay's origin (aborted,
 * so nothing reaches another host), any request naming an injected URI, the `/api/scene` downloads, and the refusal
 * reasons the viewer logs (`[viewer] snapshot refused {reason}`, web-viewer/src/render/scene-model.ts; counts only).
 * API: Page.on('pageerror' | 'crash' | 'request' | 'console'), Page.route(predicate, handler),
 * ConsoleMessage.args() / JSHandle.jsonValue() — playwright-core/types/types.d.ts.
 */
async function watch(page: Page, baseUrl: string): Promise<Watch> {
  const w: Watch = {
    current: -1,
    pageErrors: [],
    foreignRequests: [],
    markerRequests: [],
    sceneDownloads: [],
    reasons: new Map(),
    pending: [],
    crashed: false,
  };
  page.on("pageerror", (error) => w.pageErrors.push({ index: w.current, message: error.message.slice(0, 200) }));
  page.on("crash", () => (w.crashed = true));
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(URI_MARKER)) w.markerRequests.push({ index: w.current, url: url.slice(0, 120) });
    if (new URL(url).pathname.startsWith("/api/scene/")) w.sceneDownloads.push(w.current);
  });
  const origin = new URL(baseUrl).origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => {
      w.foreignRequests.push({ index: w.current, url: route.request().url().slice(0, 120) });
      return route.abort();
    },
  );
  page.on("console", (message) => {
    if (!message.text().startsWith("[viewer] snapshot refused")) return;
    const count = (reason: string) => void w.reasons.set(reason, (w.reasons.get(reason) ?? 0) + 1);
    const fields = message.args()[1];
    w.pending.push(
      (fields ? fields.jsonValue() : Promise.resolve(null))
        .then((value: unknown) => count(String((value as { reason?: unknown } | null)?.reason ?? "?")))
        .catch(() => count("unreadable")),
    );
  });
  return w;
}

/** Checks one mutant's end state against what it may and must do; returns the failures (no bytes, no secrets). */
function judge(mutant: Mutant, outcome: Outcome | null, newErrors: number): string[] {
  const label = `seed ${SEED} mutant ${mutant.index} (${mutant.kind} of ${mutant.base}, expected ${mutant.expect})`;
  const failures: string[] = [];
  const again = reproduce(mutant.index);
  if (outcome === null)
    failures.push(`${label}: no end state (neither a rendered model nor snapshotInvalid) in ${OUTCOME_TIMEOUT_MS} ms — ${again}`);
  else if (mutant.expect === "refuse" && outcome === "loaded")
    failures.push(`${label}: a snapshot §7.1 forbids was rendered — ${again}`);
  else if (mutant.expect === "load" && outcome === "invalid")
    failures.push(`${label}: a valid §7 snapshot was refused — ${again}`);
  if (newErrors > 0) failures.push(`${label}: ${newErrors} pageerror event(s) — ${again}`);
  return failures;
}

/** The checks every test ends with: nothing uncaught, nothing fetched from outside, no markup run. */
async function expectClean(page: Page, w: Watch): Promise<void> {
  const xss = await page
    .evaluate((flag) => (window as unknown as Record<string, unknown>)[flag] !== undefined, XSS_FLAG)
    .catch(() => false);
  expect(w.pageErrors, `pageerror events: ${JSON.stringify(w.pageErrors)}`).toEqual([]);
  expect(w.crashed, "the page crashed").toBe(false);
  expect(w.markerRequests, `requests for injected URIs: ${JSON.stringify(w.markerRequests)}`).toEqual([]);
  expect(w.foreignRequests, `requests to another origin: ${JSON.stringify(w.foreignRequests)}`).toEqual([]);
  expect(xss, "an injected node name ran as markup").toBe(false);
}

async function summary(w: Watch, count: number, tally: Record<Outcome, number>): Promise<string> {
  await Promise.allSettled(w.pending);
  const reasons = [...w.reasons].map(([reason, n]) => `${reason}=${n}`).join(", ") || "none";
  return (
    `seed ${SEED}, mutants ${count} (${KINDS.length} kinds): loaded ${tally.loaded}, ` +
    `snapshotInvalid ${tally.invalid}; refusal reasons: ${reasons}`
  );
}

// `trace: "off"`: TestOptions.trace (playwright/types/test.d.ts) — see the header (no code/token in an artefact).
test.use({ stackOptions: { publisher: false }, locale: "en-US", trace: "off" });

/** Whether some node-panel row shows exactly `name` as text (rows stay in the DOM while the panel is closed). */
const nameShownAsText = (page: Page, name: string) =>
  page.evaluate(
    (expected) => Array.from(document.querySelectorAll(".node-panel__name")).some((e) => e.textContent === expected),
    name,
  );

/** The last `viewer.count` the publisher received (0 before any viewer joined), §5.3. */
const viewerCount = (publisher: Client): number => {
  const counts = publisher.messages.filter((m) => m.type === "viewer.count");
  return counts.length === 0 ? 0 : Number(counts[counts.length - 1]!["viewerCount"]);
};

for (let batch = 0; batch < BATCHES; batch++) {
  const from = batch * PER_BATCH;
  const to = Math.min(COUNT, from + PER_BATCH);
  const indices = only(range(from, to));

  test(`glb-fuzz stream batch ${batch + 1}/${BATCHES} (mutants ${from}–${to - 1}): snapshotInvalid or a rendered model, no pageerror (T10)`, async ({
    stack,
    page,
  }, testInfo) => {
    test.skip(indices.length === 0, `GLB_FUZZ_ONLY=${String(ONLY)} is in another batch`);
    test.setTimeout(240_000);
    const w = await watch(page, stack.baseUrl);
    const { publisher, code, nextId } = await startPublisher(stack.wsUrl);
    await page.goto(`${stack.baseUrl}/`);
    expect(await hasWebGl2(page), "the security project's Chromium must have WebGL 2 (SwiftShader)").toBe(true);
    await joinByCode(page, stack.baseUrl, code);

    const failures: string[] = [];
    const tally: Record<Outcome, number> = { loaded: 0, invalid: 0 };
    let namesChecked = 0;
    let version = 0;
    for (const index of indices) {
      const mutant = generateMutant(SEED, index);
      // Reset: the unmodified base, shown with no notice. If even that fails the viewer is gone: stop the batch.
      w.current = -1;
      version++;
      await publish(publisher, nextId, mutant.base, baseBytes(mutant.base), version);
      if ((await endState(page, version, true).catch(() => null)) !== "loaded") {
        failures.push(`seed ${SEED} mutant ${index}: the valid reset snapshot before it was not shown — ${reproduce(index)}`);
        break;
      }
      w.current = index;
      version++;
      const errorsBefore = w.pageErrors.length;
      await publish(publisher, nextId, mutant.base, mutant.bytes, version);
      const outcome = await endState(page, version).catch(() => null);
      if (outcome) tally[outcome]++;
      failures.push(...judge(mutant, outcome, w.pageErrors.length - errorsBefore));
      if (outcome === "loaded" && mutant.injectedName !== undefined) {
        namesChecked++;
        if (!(await nameShownAsText(page, mutant.injectedName)))
          failures.push(`seed ${SEED} mutant ${index}: its node name is not shown as literal text — ${reproduce(index)}`);
      }
      if (w.crashed) break;
    }
    w.current = -1;
    testInfo.annotations.push({
      type: "glb-fuzz",
      description: `${await summary(w, indices.length, tally)}; injected names shown as text ${namesChecked}`,
    });
    expect(failures, failures.join("\n")).toEqual([]);
    await expectClean(page, w);
    expect(tally.loaded + tally.invalid, "every mutant reached an end state").toBe(indices.length);
    publisher.close();
  });
}

const httpIndices = only(range(0, Math.min(HTTP_MUTANTS, COUNT)));

test(`glb-fuzz HTTP path (mutants 0–${HTTP_MUTANTS - 1} via /api/scene): snapshotInvalid or a rendered model, no pageerror (T10)`, async ({
  stack,
  page,
}, testInfo) => {
  test.skip(httpIndices.length === 0, `GLB_FUZZ_ONLY=${String(ONLY)} is not one of the HTTP mutants`);
  test.setTimeout(180_000);
  const w = await watch(page, stack.baseUrl);
  const { publisher, code, nextId } = await startPublisher(stack.wsUrl);
  const failures: string[] = [];
  const tally: Record<Outcome, number> = { loaded: 0, invalid: 0 };
  let version = 0;
  for (const index of httpIndices) {
    const mutant = generateMutant(SEED, index);
    // Leave the previous mutant's page first (pagehide → `viewer.leave`) and wait until the relay counts no viewer:
    // a viewer still joined would get this mutant over the stream (§6.5) and parse it a second time.
    await page.goto("about:blank");
    await expect
      .poll(() => viewerCount(publisher), { message: "the previous viewer left", timeout: 10_000 })
      .toBe(0);
    w.current = index;
    version++;
    // Cached before the viewer joins: `viewer.joined.snapshotAvailable` makes it download over HTTP (§6.5).
    await publish(publisher, nextId, mutant.base, mutant.bytes, version);
    const errorsBefore = w.pageErrors.length;
    const downloadsBefore = w.sceneDownloads.length;
    // A fresh page load per mutant: no scene shown yet, so a refusal shows on the code entry.
    await joinByCode(page, stack.baseUrl, code);
    const outcome = await endState(page, version).catch(() => null);
    if (outcome) tally[outcome]++;
    failures.push(...judge(mutant, outcome, w.pageErrors.length - errorsBefore));
    if (w.sceneDownloads.length === downloadsBefore)
      failures.push(`seed ${SEED} mutant ${index}: the viewer never requested /api/scene — ${reproduce(index)}`);
    if (w.crashed) break;
  }
  w.current = -1;
  testInfo.annotations.push({
    type: "glb-fuzz-http",
    description: `${await summary(w, httpIndices.length, tally)}; /api/scene downloads ${w.sceneDownloads.length}`,
  });
  expect(failures, failures.join("\n")).toEqual([]);
  await expectClean(page, w);
  publisher.close();
});

// The reset snapshot is the unmodified fixture (its SHA-256 is the manifest's) and mutants are reproducible.
test("glb-fuzz: the mutator is deterministic and its reset snapshots are the fixtures", async () => {
  const manifest = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
    files: Record<string, { sha256: string }>;
  };
  for (const name of BASES) expect(await sha256Hex(baseBytes(name))).toBe(manifest.files[name]!.sha256);
  for (const index of [0, 1, 2, 77, COUNT - 1]) {
    const a = generateMutant(SEED, index);
    const b = generateMutant(SEED, index);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), `mutant ${index} is not deterministic`).toBe(true);
  }
  expect(generateMutant(SEED, 0).kind).toBe("identity");
});
