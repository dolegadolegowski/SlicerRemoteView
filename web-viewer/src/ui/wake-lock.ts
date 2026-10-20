// Screen wake lock while in a session (WEB-16, FR-46): a phone on the lecture desk must not dim and lock during a
// presentation. `navigator.wakeLock.request("screen")` after `viewer.joined`; the browser releases the lock when the
// page is hidden, so it is requested again when the page becomes visible; it is released when the session ends, and
// after `OFFLINE_RELEASE_MS` without a connection (a phone carried out of the Wi-Fi must not burn its battery; the
// next `viewer.joined` takes it again). WebKit grants it only with transient user activation, and the page's wake
// lock object stays authorised afterwards (WebKit main, Source/WebCore/Modules/screen-wake-lock/WakeLock.cpp,
// https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/screen-wake-lock/WakeLock.cpp): a join from a QR
// link has none, so after a refusal the next tap or key press asks again. Without the API: the normal timeout.

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

/** How long the lock outlives a dropped connection. */
export const OFFLINE_RELEASE_MS = 120_000;
/** Events that carry user activation, on which a refused lock is asked for again. */
const ACTIVATION_EVENTS = ["pointerup", "keydown", "click"] as const;

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

  let wanted = false; // in a session
  let paused = false; // offline for longer than OFFLINE_RELEASE_MS
  let sentinel: SentinelLike | null = null;
  let pending = false;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let armed = false; // listening for a user activation after a refusal

  const held = () => sentinel !== null && !sentinel.released;

  function acquire(): void {
    if (!wakeLock || !wanted || paused || pending || held()) return;
    if (doc && doc.visibilityState !== "visible") return; // only a visible page may hold one
    pending = true;
    wakeLock
      .request("screen")
      .then((s) => {
        pending = false;
        if (!wanted || paused) return void s.release().catch(() => undefined); // ended or offline meanwhile
        sentinel = s;
        disarm();
      })
      .catch(() => {
        pending = false;
        log("screen wake lock refused"); // the reason is not logged; it may name the device state
        arm();
      });
  }

  const onActivation = () => acquire(); // inside the event: the activation is still transient
  function arm(): void {
    if (armed || !doc || !wanted) return;
    armed = true;
    for (const type of ACTIVATION_EVENTS) doc.addEventListener(type, onActivation, true);
  }
  function disarm(): void {
    if (!armed || !doc) return;
    armed = false;
    for (const type of ACTIVATION_EVENTS) doc.removeEventListener(type, onActivation, true);
  }

  /** Lets go of the lock; `wanted` decides whether a later `viewer.joined` takes it again. */
  function drop(): void {
    disarm();
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) s.release().catch(() => undefined);
  }

  function release(): void {
    wanted = paused = false;
    clearTimeout(offlineTimer);
    offlineTimer = undefined;
    drop();
  }

  const onVisibility = () => {
    if (doc?.visibilityState === "visible") acquire();
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  const offs = [
    connection.onMessage("viewer.joined", () => {
      wanted = true;
      paused = false;
      clearTimeout(offlineTimer);
      offlineTimer = undefined;
      acquire();
    }),
    connection.on("state", (state) => {
      if (ends(state)) return release();
      if (state.kind !== "disconnected" || offlineTimer !== undefined || !wanted) return;
      offlineTimer = setTimeout(() => {
        offlineTimer = undefined;
        paused = true;
        drop();
      }, OFFLINE_RELEASE_MS);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    doc?.removeEventListener("visibilitychange", onVisibility);
    release();
  };
}
