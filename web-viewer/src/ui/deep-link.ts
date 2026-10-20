// Deep link `/j#CODE` (WEB-11; docs/protocol.md §10 `GET /j`, ADR 0006, ADR 0008 §5, FR-36, US-07). The QR on the
// projector opens `https://<host>/j#7KQ4X`; the fragment never reaches the server (RFC 3986 §3.5). The viewer reads
// it once and rewrites the URL to `/j` with `history.replaceState` before any network call, so the address bar, the
// tab's Back/Forward entries, a shared tab and a screenshot no longer show the code; then it joins as if the code
// had been typed. Not covered: the browser's own History list and address-bar suggestions record the opened URL
// when the page commits, before any script runs, and no web API can remove that visit — the code's expiry and the
// session's end are the limit there (docs/testing/reports/2026-10-20-web-1.md).

import { normalizeCode } from "@slicerremoteview/shared";
import { describeState } from "../state/errors";
import type { CodeEntry } from "./code-entry";
import type { Screens } from "./screens";

export interface LocationLike {
  readonly pathname: string;
  readonly hash: string;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export type DeepLink =
  | { readonly kind: "none" }
  | { readonly kind: "code"; readonly code: string }
  /** Not a valid code; `text` is what the link carried (decoded, at most `MAX_FRAGMENT` characters). */
  | { readonly kind: "invalid"; readonly text: string };

/** The only path that takes a code (protocol §10: no SPA fallback beyond `/` and `/j`). */
export const DEEP_LINK_PATH = "/j";
/** A code is 5 characters; anything far longer is not worth decoding. */
const MAX_FRAGMENT = 64;

function decode(fragment: string): string {
  try {
    return decodeURIComponent(fragment); // `#7KQ%204X` from a QR app that encoded a space
  } catch {
    return fragment;
  }
}

/** Reads `/j#CODE` and strips the fragment from the URL (no reload, no new history entry). */
export function takeDeepLink(loc: LocationLike = location, hist: HistoryLike = history): DeepLink {
  if (loc.pathname !== DEEP_LINK_PATH) return { kind: "none" };
  const fragment = loc.hash.replace(/^#/, "");
  if (fragment === "") return { kind: "none" };
  hist.replaceState(null, "", DEEP_LINK_PATH); // first: the code leaves the address bar before anything else runs
  const text = decode(fragment.slice(0, MAX_FRAGMENT));
  const result = normalizeCode(text);
  return "code" in result ? { kind: "code", code: result.code } : { kind: "invalid", text };
}

/**
 * Acts on a deep link: a valid code is put into the cells (so a failed join can be retried with Join) and joined at
 * once. An invalid one is reported; when no session is live it is also put into the cells, where the code entry shows
 * its hint (e.g. `0`/`O`). During a session (also while it reconnects, WEB-14) the cells keep the code that was
 * joined: should the session end, Join retries that code. Returns whether it did anything.
 */
export function startFromDeepLink(
  link: DeepLink,
  entry: CodeEntry,
  screens: Pick<Screens, "join" | "report" | "live">,
): boolean {
  if (link.kind === "none") return false;
  if (link.kind === "code") {
    entry.setCode(link.code);
    screens.join(link.code);
    return true;
  }
  const live = screens.live;
  if (!live) entry.setCode(link.text);
  screens.report(describeState({ kind: "linkInvalid" })); // on the code entry, or over a scene being shown
  if (!live) entry.focus();
  return true;
}
