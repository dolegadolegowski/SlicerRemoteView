// Entering XR from the button (WEB-19): the session is requested in the click itself — WebXR wants the user's gesture
// (transient activation) — and only then is the XR module loaded, so the 2D viewer never downloads it unasked.

import type { XrHost } from "../render/viewer";
import type { XrSessionOptions } from "./session";
import { XR_SESSION_INIT } from "./support";
import type { XrMode, XrSystemLike } from "./support";

/**
 * Fetches the XR module ahead of the first tap (only where XR is offered): a page left open across a redeploy would
 * otherwise ask the relay for a chunk the new build no longer has.
 */
export function preloadXr(): void {
  void import("./session").catch(() => undefined);
}

/**
 * `true` once the session runs (`options.onEnd` follows when it is over); `false` when the browser refused or it
 * could not start (`onEnd` is not called).
 */
export async function enterXr(
  host: XrHost,
  xr: XrSystemLike,
  mode: XrMode,
  options: Pick<XrSessionOptions, "onEnd" | "warning" | "status"> = {},
): Promise<boolean> {
  let session: XRSession;
  try {
    session = await xr.requestSession(mode, XR_SESSION_INIT);
  } catch {
    return false; // refused (another session, a denied permission): nothing changed
  }
  try {
    const { runXrSession } = await import("./session");
    await runXrSession(host, session, mode, options);
    return true;
  } catch {
    await session.end().catch(() => undefined); // e.g. the module did not load: the granted session must not hang
    return false;
  }
}
