// Reconnect and rejoin (WEB-14; docs/protocol.md §5.1, §9.1, §9.3, §12, §13 steps 8–9; FR-43, NFR-19, NFR-20). The
// connection (`connection.ts`) is one socket's lifetime; this module owns the session's credentials and decides,
// after every closed socket, whether to connect again and with what:
//
// - Only a session that was joined retries without the user: a first join that fails is reported on the code entry,
//   where Join tries again (the user is looking at it).
// - Rejoin with `sessionId` + `viewerToken` (no rate-limit cost, §12), with backoff 0.5 s → 30 s and jitter; `4008`
//   (relay restart) after 0–3 s; the relay's `retryAfterS` is honoured. The closed states that end a session
//   (`enterCode`, `sessionEnded`, `stopped`, `idle`) stop retrying.
// - `SESSION_NOT_FOUND` (the relay restarted and lost the session, §13 step 9): join by the code again, on a new
//   socket — valid whatever the relay does with the old one (§9.2 keeps it open 10 s; `[TODO verify]` against SRV-15).
//   The presenter re-creates the session with the same code 0–3 s after the restart, so the code joins run on a
//   fixed schedule (`CODE_FALLBACK_AT_MS`, ≈ 4 s to NFR-20's 60 s) rather than at once and on every backoff step:
//   every `INVALID_CODE` counts against the room's IP, and 20 within 10 min ban it (§12 — a lecture room shares one
//   NAT address). After the last one the code entry says the presentation ended.
// - `visibilitychange → visible` checks the link at once (a backgrounded phone often comes back with a dead socket,
//   §13 step 8) or skips a backoff wait; `pagehide` sends `viewer.leave` + `1000` (§5.4) and a page restored from the
//   back/forward cache joins by the code again.
//
// Privacy (CLAUDE.md rule 6, NFR-15): the code and the token live in this closure only — never in storage, the URL
// or a log line (log lines carry fixed text).

import { describe } from "../state/errors";
import type { Description } from "../state/errors";
import type { Connection, ConnectionState, JoinCredentials, LogFn } from "./connection";

/** First backoff step and cap (§9.1, FR-43). */
export const BACKOFF_FIRST_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
/** `4008`: reconnect at once, spread over 0–3 s so a lecture room does not arrive in one burst (§9.3). */
export const RESTART_JITTER_MS = 3_000;
/** When the code joins after `SESSION_NOT_FOUND` run, from that moment; each is delayed by up to the jitter. */
export const CODE_FALLBACK_AT_MS: readonly number[] = [4_000, 15_000, 35_000, 60_000];
export const CODE_FALLBACK_JITTER_MS = 2_000;
/** Upper bound for a `retryAfterS` wait (a relay ban is 600 s, §12); also keeps the timer in range. */
export const MAX_RETRY_AFTER_MS = 3_600_000;
/**
 * The backoff starts over only after a rejoin held this long: a relay that accepts and drops again at once is not
 * retried every half second (§12: a lecture room shares one IP's upgrade limit).
 */
export const STABLE_MS = 10_000;

/**
 * The wait before retry number `attempt` (0-based): `d = 0.5 s · 2^attempt`, capped at 30 s, drawn from `[d/2, d]`
 * ("equal jitter", so a whole room that dropped together spreads out; `random` 0 gives exactly `d`).
 */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt);
  return base - (base / 2) * random;
}

type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface ReconnectOptions {
  /** Jitter source, `0 ≤ x < 1`. */
  readonly random?: () => number;
  /** Clock for the code fallback schedule. */
  readonly now?: () => number;
  /** `visibilitychange` source; default `document`. */
  readonly document?: EventSource & { readonly visibilityState: DocumentVisibilityState };
  /** `pagehide` / `pageshow` source; default `window`. */
  readonly window?: EventSource;
  readonly lang?: Parameters<typeof describe>[1];
  readonly log?: LogFn;
}

export interface Reconnect {
  /** Starts a session by `code` (typed or deep-linked); a session already running is given up first. */
  join(code: string): void;
  /** Ends the session for this viewer: no more retries, `viewer.leave` + `1000` when a socket is open (§5.4). */
  leave(): void;
  /**
   * Whether `state`, a state of the connection, is followed by a retry without the user. The answer for one state
   * object never changes, so the screens may ask in their own state handler whatever the subscription order.
   */
  willRetry(state: ConnectionState): boolean;
  /**
   * A better message than `state.description` for a session that ended here, or `null`: the code fallback gave up
   * (the presenter did not re-create the session, or it had ended while this device was away), so "presentation
   * ended" (US-12) rather than "code not recognised" for a code the user did not mistype.
   */
  explain(state: ConnectionState): Description | null;
  dispose(): void;
}

const defaultLog: LogFn = (message, fields) => console.warn(`[viewer] ${message}`, fields ?? "");

interface Decision {
  readonly state: ConnectionState;
  readonly retry: boolean;
  /** The fallback's last code join found no session either: it was lost in the restart. */
  readonly lost: boolean;
}

interface Fallback {
  /** When `SESSION_NOT_FOUND` arrived. */
  readonly since: number;
  /** Index into `CODE_FALLBACK_AT_MS` of the code join that runs next or ran last. */
  step: number;
}

export function createReconnect(
  connection: Pick<Connection, "state" | "connect" | "leave" | "checkAlive" | "on" | "onMessage">,
  options: ReconnectOptions = {},
): Reconnect {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  const win = options.window ?? (typeof window === "undefined" ? undefined : window);
  const log = options.log ?? defaultLog;

  let code: string | null = null; // the session's code, for the fallback after a relay restart
  let token: Extract<JoinCredentials, { sessionId: string }> | null = null;
  let joined = false; // the session got its `viewer.joined`: from now on drops are retried
  let attempt = 0; // backoff retries since the last `viewer.joined`
  let fallback: Fallback | null = null; // joining by code after SESSION_NOT_FOUND
  let lastError: string | undefined; // `error.code` received on the current socket
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let firm = false; // the pending wait is the relay's `retryAfterS` or the fallback schedule: kept when back in view
  let decided: Decision | null = null;
  let resumeCode: string | null = null; // left on `pagehide`: a page restored from the bfcache joins again

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
    firm = false;
  }

  function end(): void {
    clearTimer();
    clearTimeout(stableTimer);
    code = token = fallback = null;
    joined = false;
    attempt = 0;
  }

  function connectNow(): void {
    clearTimer();
    lastError = undefined;
    if (token) connection.connect(token);
    else if (code !== null) connection.connect({ code });
  }

  function wait(delay: number, isFirm: boolean): void {
    clearTimer();
    timer = setTimeout(connectNow, Math.max(0, delay));
    firm = isFirm;
  }

  /** Delay until the fallback's code join number `step`. */
  const fallbackDelay = (f: Fallback, step: number) =>
    f.since + CODE_FALLBACK_AT_MS[step]! + random() * CODE_FALLBACK_JITTER_MS - now();

  /** `INVALID_CODE` for a code join of the fallback: the presenter has not re-created the session (yet). */
  const unknownCode = (state: ConnectionState) =>
    fallback !== null &&
    state.kind === "enterCode" &&
    (state.closeCode === 4004 || lastError === "INVALID_CODE");

  function decide(state: ConnectionState): Decision {
    if (!joined || code === null) return { state, retry: false, lost: false };
    if (state.kind === "disconnected") return { state, retry: true, lost: false };
    if (!unknownCode(state)) return { state, retry: false, lost: false };
    const more = fallback!.step + 1 < CODE_FALLBACK_AT_MS.length;
    return { state, retry: more, lost: !more };
  }

  function decision(state: ConnectionState): Decision {
    if (decided?.state !== state) decided = decide(state);
    return decided;
  }

  const willRetry = (state: ConnectionState) => decision(state).retry;

  function schedule(state: Extract<ConnectionState, { closeCode: number }>): void {
    // The relay closed the socket of the failed token join itself: the presenter's head start still stands.
    if (fallback && lastError === "SESSION_NOT_FOUND" && timer !== undefined) return;
    if (fallback && unknownCode(state)) {
      fallback.step++;
      return wait(fallbackDelay(fallback, fallback.step), true);
    }
    let delay: number;
    if (state.kind === "disconnected" && state.immediate) {
      delay = random() * RESTART_JITTER_MS;
    } else {
      delay = backoffDelay(attempt, random());
      attempt++;
    }
    const asked = state.retryAfterS;
    // The relay's wait is kept even when the backoff is longer: a visibility change must not cut below it.
    if (asked !== undefined && Number.isFinite(asked))
      return wait(Math.max(delay, Math.min(asked * 1000, MAX_RETRY_AFTER_MS)), true);
    wait(delay, false);
  }

  const offs = [
    connection.on("state", (state) => {
      switch (state.kind) {
        case "connecting":
        case "connected":
          return;
        case "idle":
          return end(); // left: by `leave()` or by a caller of `connection.leave()`
        default:
          clearTimeout(stableTimer);
          if (willRetry(state)) return schedule(state);
          end();
      }
    }),
    connection.onMessage("viewer.joined", (m) => {
      if (code === null) return;
      token = { sessionId: m.sessionId, viewerToken: m.viewerToken };
      joined = true;
      fallback = null;
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => (attempt = 0), STABLE_MS);
    }),
    connection.onMessage("error", (m) => {
      lastError = m.code;
      if (m.code !== "SESSION_NOT_FOUND" || token === null) return;
      if (connection.state.kind !== "connecting") return;
      // The relay no longer knows the session (restart, §13 step 9): the token died with it; the code did not. The
      // old socket stays as it is until the code join replaces it (the relay keeps it open 10 s, §9.2).
      log("session not found, joining by code");
      token = null;
      fallback = { since: now(), step: 0 };
      wait(fallbackDelay(fallback, 0), true);
    }),
  ];

  const onVisibility = () => {
    if (doc?.visibilityState !== "visible") return;
    if (connection.state.kind === "connected") return connection.checkAlive();
    if (timer !== undefined && !firm) connectNow(); // back in view: do not sit out the backoff
  };
  const onPageHide = () => {
    if (!joined || code === null) return;
    const keep = code;
    leave();
    resumeCode = keep;
  };
  const onPageShow = (event: Event) => {
    const keep = resumeCode;
    resumeCode = null;
    // Restored from the back/forward cache: the token may not outlive `viewer.leave`; the code joins again.
    if (keep !== null && (event as PageTransitionEvent).persisted) join(keep);
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onPageHide);
  win?.addEventListener("pageshow", onPageShow);

  function join(next: string): void {
    end();
    resumeCode = null;
    code = next;
    connectNow();
  }

  function leave(): void {
    end();
    resumeCode = null;
    connection.leave();
  }

  return {
    join,
    leave,
    willRetry,
    explain(state) {
      return decision(state).lost ? describe("SESSION_CLOSED", options.lang) : null;
    },
    dispose() {
      offs.forEach((off) => off());
      clearTimer();
      clearTimeout(stableTimer);
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("pageshow", onPageShow);
    },
  };
}
