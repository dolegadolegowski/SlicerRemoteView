import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_INTERVAL_MS,
  ACTIVITY_TIMEOUT_MS,
  createActivity,
  parseCounts,
} from "../../src/ui/activity";
import type { Activity, ActivityOptions } from "../../src/ui/activity";
import { createCodeEntry } from "../../src/ui/code-entry";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HEALTH = { status: "ok", uptimeS: 60, sessions: 3, viewers: 12, version: "0.1.0" };

/** Lets the pending read and its JSON settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A read the test answers later. */
function pending() {
  let answer: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => (answer = resolve));
  return { read: () => promise, answer };
}

const created: Activity[] = [];
function setup(answers: (() => Promise<Response>)[], options: Partial<ActivityOptions> = {}) {
  const fetch = vi.fn((_input: string, _init: RequestInit) => {
    const next = answers.shift();
    return next ? next() : Promise.resolve(json(HEALTH));
  });
  const activity = createActivity({ lang: "en", fetch, ...options });
  created.push(activity);
  return { activity, fetch };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const activity of created.splice(0)) activity.stop(); // no listener left on `document`
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseCounts (WEB-24, §10)", () => {
  it("takes whole counts ≥ 0 of both, nothing else", () => {
    expect(parseCounts(HEALTH)).toEqual({ sessions: 3, viewers: 12 });
    expect(parseCounts({ sessions: 0, viewers: 0 })).toEqual({ sessions: 0, viewers: 0 });
    for (const bad of [
      null,
      "3",
      [],
      { sessions: 3 }, // an older relay: no `viewers`
      { sessions: 3, viewers: -1 },
      { sessions: 1.5, viewers: 2 },
      { sessions: "3", viewers: 2 },
      { sessions: 3, viewers: Number.NaN },
      { sessions: Number.MAX_SAFE_INTEGER + 1, viewers: 1 },
    ])
      expect(parseCounts(bad)).toBeNull();
  });
});

describe("activity line (WEB-24)", () => {
  it("shows the relay-wide counts once read, from /healthz of this origin without credentials", async () => {
    const { activity, fetch } = setup([]);
    expect(activity.element.hidden).toBe(true);
    expect(activity.element.className).toBe("code-entry__activity");
    expect(activity.element.getAttribute("role")).toBeNull(); // not a live region
    activity.start();
    await settle();
    expect(activity.element.hidden).toBe(false);
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 12");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/healthz");
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit", redirect: "error" });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("speaks the chosen language, and switches with it (WEB-21)", async () => {
    const { activity } = setup([], { lang: "pl" });
    activity.start();
    await settle();
    expect(activity.element.textContent).toBe("Aktywne sesje: 3 · Widzowie: 12");
    activity.setLang("en");
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 12");
  });

  it("is hidden while the relay gives no counts, and comes back with them", async () => {
    const { activity } = setup([
      () => Promise.resolve(json({ ...HEALTH, status: "draining" }, 503)),
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(new Response("<!doctype html>", { status: 200 })), // not JSON
      () => Promise.resolve(json({ status: "ok", sessions: 3 })), // an older relay
      () => Promise.resolve(json({ ...HEALTH, sessions: 1, viewers: 0 })),
    ]);
    activity.start();
    for (let i = 0; i < 4; i++) {
      await settle();
      expect(activity.element.hidden).toBe(true);
      expect(activity.element.textContent).toBe("");
      await vi.advanceTimersByTimeAsync(ACTIVITY_INTERVAL_MS);
    }
    expect(activity.element.hidden).toBe(false);
    expect(activity.element.textContent).toBe("Active sessions: 1 · Viewers: 0");
  });

  it("reads again every 30 s, never two at once", async () => {
    const slow = pending();
    const { activity, fetch } = setup([() => Promise.resolve(json(HEALTH)), slow.read]);
    activity.start();
    activity.start(); // once is enough
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_INTERVAL_MS); // a slow answer…
    expect(fetch).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange")); // …is not read twice
    await vi.advanceTimersByTimeAsync(ACTIVITY_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    slow.answer(json({ ...HEALTH, viewers: 13 }));
    await settle();
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 13");
    await vi.advanceTimersByTimeAsync(ACTIVITY_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives a read up after 10 s and hides the line", async () => {
    const { activity, fetch } = setup([
      () => Promise.resolve(json(HEALTH)),
      () =>
        new Promise((_resolve, reject) => {
          const init = fetch.mock.calls[1]![1];
          init.signal!.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    ]);
    activity.start();
    await settle();
    expect(activity.element.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(ACTIVITY_INTERVAL_MS + ACTIVITY_TIMEOUT_MS);
    expect(activity.element.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(ACTIVITY_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(3); // not stuck behind the one it gave up
    expect(activity.element.hidden).toBe(false);
  });

  it("does not read while the page is hidden; reads at once when it is visible again", async () => {
    let state: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const { activity, fetch } = setup([]);
    activity.start();
    await vi.advanceTimersByTimeAsync(2 * ACTIVITY_INTERVAL_MS);
    expect(fetch).not.toHaveBeenCalled();
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(activity.element.hidden).toBe(false);
  });

  it("stop() hides the line and ends the reads; an answer on its way is dropped, also by a language switch", async () => {
    const late = pending();
    const { activity, fetch } = setup([late.read]);
    activity.start();
    activity.stop();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    late.answer(json(HEALTH));
    await settle();
    expect(activity.element.hidden).toBe(true);
    activity.setLang("pl");
    expect(activity.element.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * ACTIVITY_INTERVAL_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("started again (back from a session), it reads at once and never shows the counts from before", async () => {
    const fresh = pending();
    const { activity, fetch } = setup([() => Promise.resolve(json(HEALTH)), fresh.read]);
    activity.start();
    await settle();
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 12");
    activity.stop(); // a session starts
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    activity.start(); // the session is over
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(activity.element.hidden).toBe(true); // nothing an hour old while the new read is on its way
    fresh.answer(json({ ...HEALTH, sessions: 1, viewers: 7 }));
    await settle();
    expect(activity.element.textContent).toBe("Active sessions: 1 · Viewers: 7");
  });

  it("a read stopped and started again at once: the new read is not held up by the dropped one", async () => {
    const dropped = pending();
    const { activity, fetch } = setup([dropped.read]);
    activity.start();
    activity.stop();
    activity.start();
    expect(fetch).toHaveBeenCalledTimes(2);
    await settle();
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 12");
    dropped.answer(json({ ...HEALTH, viewers: 99 }));
    await settle();
    expect(activity.element.textContent).toBe("Active sessions: 3 · Viewers: 12");
  });

  it("sits last in the code entry form, after Leave (the footer slot)", () => {
    const { activity } = setup([]);
    const entry = createCodeEntry({
      onJoin: () => {},
      onLeave: () => {},
      lang: "en",
      footer: activity.element,
    });
    expect(entry.element.lastElementChild).toBe(activity.element);
    expect(activity.element.previousElementSibling?.className).toBe("code-entry__leave");
    const plain = createCodeEntry({ onJoin: () => {}, lang: "en" });
    expect(plain.element.querySelector(".code-entry__activity")).toBeNull();
  });
});
