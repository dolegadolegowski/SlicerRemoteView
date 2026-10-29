// Device platform and informational profile for `viewer.join.clientInfo` (WEB-15; docs/protocol.md §5.1, §7.5;
// FR-49). The rule and its sources are in docs/research/web-quest-user-agent.md §4:
//
// - `quest-browser` only for Meta Quest Browser (`OculusBrowser/<digit>`), not for look-alikes that spoof it
//   (Pico Browser sends `like Quest` and `OculusBrowser/7.0`); every other browser is `web`.
// - The model is the `Quest…` item of the first parenthesised platform part: `Quest 3` (also sent by Quest 3S)
//   → `quest3`; anything else on Quest Browser — Quest 2, Quest Pro, Quest 1, no token, a model not listed by
//   Meta yet — → `quest2`, the lower budget (the profile is informational; the publisher picks the budget).
// - `navigator.xr` is not an input: it exists in desktop and Android Chrome and is missing on Quest over `http://`.
//
// Privacy (§5.1 "no device identifiers"): only the two enum values leave this module; the user agent is neither
// sent nor logged.

import { LIMITS } from "@slicerremoteview/shared";

/** `clientInfo.platform` values the web viewer sends (`quest2`/`quest3` belong to the native app, §5.1). */
export type Platform = "web" | "quest-browser";
/** `clientInfo.profile` (§5.1, informational). */
export type Profile = "mobile" | "quest2" | "quest3";

export interface Device {
  readonly platform: Platform;
  readonly profile: Profile;
}

const QUEST_BROWSER = /\bOculusBrowser\/\d/;
const LOOKALIKE = /\bPicoBrowser\/|\blike Quest\b/;
/** Device tokens Meta documents for the Quest 3 budget class (research §1.1); `Quest 3S` defensively. */
const QUEST3_TOKENS = new Set(["Quest 3", "Quest 3S"]);

export function detectDevice(userAgent: string): Device {
  if (!QUEST_BROWSER.test(userAgent) || LOOKALIKE.test(userAgent))
    return { platform: "web", profile: "mobile" };
  const part = /\(([^)]*)\)/.exec(userAgent)?.[1] ?? "";
  const token = part
    .split(";")
    .map((item) => item.trim())
    .find((item) => /^Quest\b/.test(item));
  return {
    platform: "quest-browser",
    profile: token !== undefined && QUEST3_TOKENS.has(token) ? "quest3" : "quest2",
  };
}

/**
 * Largest snapshot this device accepts (`capabilities.maxSnapshotBytes`, §3.3, §7.5, NFR-03): the 64 MiB hard cap for
 * the `quest3` class, the 32 MiB recommendation otherwise (iOS WebContent memory, web.md §2). Quest Browser's tab
 * memory for 64 MiB is `[TODO verify]` on a device (docs/testing/web.md §Device profile).
 */
export function snapshotLimit(profile: Profile): number {
  return profile === "quest3"
    ? LIMITS.MAX_SNAPSHOT_BYTES
    : LIMITS.RECOMMENDED_SNAPSHOT_BYTES_MOBILE;
}

/** The device this page runs on (`navigator.userAgent`, read synchronously before the join). */
export function currentDevice(
  nav: Pick<Navigator, "userAgent"> | undefined = globalThis.navigator,
): Device {
  return detectDevice(nav?.userAgent ?? "");
}
