// Screen wake lock while in a session (WEB-16, FR-46): a phone on the lecture desk must not dim and lock during a
// presentation. `navigator.wakeLock.request("screen")` after `viewer.joined`; the browser releases the lock when the
// page is hidden, so it is requested again when the page becomes visible; it is released when the session ends.
// Browsers without the API (or that refuse it: no user activation, power saver) just keep their normal timeout.

import { endsSession } from "../protocol/connection";
import type { Connection, ConnectionState, LogFn } from "../protocol/connection";

/** The part of `WakeLockSentinel` used here. */
export interface SentinelLike extends Pick<EventTarget, "addEventListener"> {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockOptions {
  /** Default `navigator.wakeLock` (undefined where unsupported). */
  readonly wakeLock?: { request(type: "screen"): Promise<SentinelLike> } | undefined;
  readonly document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  /** When the session is over; default `endsSession` (main.ts passes the WEB-14 predicate). */
  readonly ends?: (state: ConnectionState) => boolean;
  readonly log?: LogFn;
}

const defaultLog: LogFn = (message, fields) => console.warn(`[viewer] ${message}`, fields ?? "");

/** Returns the unsubscribe function (releases the lock too). */
export function bindWakeLock(
  connection: Pick<Connection, "on" | "onMessage">,
  options: WakeLockOptions = {},
): () => void {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const wakeLock =
    "wakeLock" in options
      ? options.wakeLock
      : (nav as { wakeLock?: WakeLockOptions["wakeLock"] })?.wakeLock;
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  const ends = options.ends ?? endsSession;
  const log = options.log ?? defaultLog;

  let wanted = false;
  let sentinel: SentinelLike | null = null;
  let pending = false;

  function acquire(): void {
    if (!wakeLock || !wanted || pending || (sentinel && !sentinel.released)) return;
    if (doc && doc.visibilityState !== "visible") return; // only a visible page may hold one
    pending = true;
    wakeLock
      .request("screen")
      .then((s) => {
        pending = false;
        if (!wanted) return void s.release().catch(() => undefined); // the session ended meanwhile
        sentinel = s;
      })
      .catch(() => {
        pending = false;
        log("screen wake lock refused"); // the reason is not logged; it may name the device state
      });
  }

  function release(): void {
    wanted = false;
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) s.release().catch(() => undefined);
  }

  const onVisibility = () => {
    if (doc?.visibilityState === "visible") acquire();
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  const offs = [
    connection.onMessage("viewer.joined", () => {
      wanted = true;
      acquire();
    }),
    connection.on("state", (state) => {
      if (ends(state)) release();
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    doc?.removeEventListener("visibilitychange", onVisibility);
    release();
  };
}
