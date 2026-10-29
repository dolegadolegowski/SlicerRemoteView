// Activity line (WEB-24): on the code entry, how many sessions are open on this relay and how many viewers use them
// right now — the relay-wide counts of `GET /healthz` (§10, PRO-26), shown like the in-session viewer count of the
// status bar (WEB-15). Same origin, no code, token, cookie or body — only what the browser adds to any request (IP
// address, User-Agent), which the Railway edge logs (§10) — and the relay answers with totals only. `main.ts` runs
// it only while no session is live, joining or retrying, so a relay-wide "Viewers" never sits under a session's Leave
// button: read at once when started (the code entry is the user's own screen again, never with counts from before a
// session), then every 30 s while the page is visible; hidden when stopped and whenever the relay does not give both
// counts (draining `503`, offline, an older relay).
//
// Not a live region: the counts change with every join and leave and would chatter.

import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";

/** The relay-wide counts of `/healthz` (§10). */
export interface Counts {
  readonly sessions: number;
  readonly viewers: number;
}

export const ACTIVITY_INTERVAL_MS = 30_000;
/** A read that takes longer is given up; the next interval tries again. */
export const ACTIVITY_TIMEOUT_MS = 10_000;

export interface ActivityOptions {
  readonly lang?: Lang;
  readonly document?: Document;
  /** Default the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface Activity {
  readonly element: HTMLElement;
  /** Reads the counts now and then every `ACTIVITY_INTERVAL_MS`; again at once when the page becomes visible. */
  start(): void;
  /** Hides the line and ends the reads; an answer still on its way is dropped. */
  stop(): void;
  /** Re-renders the line in `lang` (WEB-21). */
  setLang(lang: Lang): void;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `{sessions, viewers}` of a `/healthz` body, or `null` unless both are whole numbers ≥ 0. */
export function parseCounts(body: unknown): Counts | null {
  if (typeof body !== "object" || body === null) return null;
  const { sessions, viewers } = body as Record<string, unknown>;
  return isCount(sessions) && isCount(viewers) ? { sessions, viewers } : null;
}

export function createActivity(options: ActivityOptions = {}): Activity {
  const doc = options.document ?? document;
  const read = options.fetch ?? ((input, init) => fetch(input, init));
  let lang = options.lang ?? detectLang();
  let counts: Counts | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The read on its way, if any: one at a time; `stop()` aborts it. */
  let reading: AbortController | undefined;

  const element = doc.createElement("p");
  element.className = "code-entry__activity";
  element.hidden = true;

  function paint(): void {
    element.hidden = counts === null;
    element.textContent = counts === null ? "" : t(lang, "activity.summary", { ...counts });
  }

  async function refresh(): Promise<void> {
    if (reading || doc.visibilityState === "hidden") return;
    const abort = new AbortController();
    reading = abort;
    const giveUp = setTimeout(() => abort.abort(), ACTIVITY_TIMEOUT_MS);
    let answer: Counts | null;
    try {
      // Same origin only (`connect-src 'self'`); never a redirect, a cookie or a cached answer.
      const response = await read("/healthz", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: abort.signal,
      });
      answer = response.ok ? parseCounts(await response.json()) : null;
    } catch {
      answer = null; // offline, timed out, or not JSON
    } finally {
      clearTimeout(giveUp);
    }
    if (reading !== abort) return; // stopped meanwhile: the line stays as `stop()` left it
    reading = undefined;
    counts = answer;
    paint();
  }

  const onVisible = () => {
    if (doc.visibilityState === "visible") void refresh();
  };

  return {
    element,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void refresh(), ACTIVITY_INTERVAL_MS);
      doc.addEventListener("visibilitychange", onVisible);
      void refresh();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      doc.removeEventListener("visibilitychange", onVisible);
      reading?.abort();
      reading = undefined;
      counts = null;
      paint();
    },
    setLang(next) {
      lang = next;
      paint();
    },
  };
}
