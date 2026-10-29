// Decides when to download the cached snapshot and what each answer means (WEB-06; docs/protocol.md §5.2, §6.5,
// §8.3, §10). No DOM, no three.js. The loader fetches on `viewer.joined{snapshotAvailable:true}` and
// `scene.snapshot.ready`, keeps the viewer token, and turns the §10 statuses into the next step: 401 → re-enter
// the code, 404 → `scene.request`, 410 → session ended, 429 → back off. `bindStreamToLoader()` connects the
// WebSocket stream (WEB-05) to the same resync path.
//
// Privacy (CLAUDE.md rule 6): the token lives in memory only, is never logged, and is dropped on 401, 410 and
// whenever the connection says the session or the credentials are gone.

import type { MessageOfType } from "@slicerremoteview/shared";
import type { Lang } from "../i18n/strings";
import { detectLang } from "../i18n/strings";
import { describe } from "../state/errors";
import type { Description } from "../state/errors";
import { endsSession } from "./connection";
import type { Connection, ConnectionState, LogFn } from "./connection";
import { fetchScene } from "./scene-http";
import type { FailureReason, FetchSceneOptions, SceneTarget } from "./scene-http";
import type { SnapshotStream } from "./snapshot-stream";

export type ResyncReason = "GAP" | "RECONNECT" | "CHECKSUM_MISMATCH" | "USER";

export interface SceneLoaderOptions extends Omit<
  FetchSceneOptions,
  "signal" | "onProgress" | "now"
> {
  /** Attempts per snapshot for retryable outcomes (429, network/stall, 5xx, length/ETag mismatch). Default 3. */
  readonly maxAttempts?: number;
  /** Last scene version the viewer applied (`scene.request.haveSceneVersion`); WEB-12 supplies it. */
  readonly haveSceneVersion?: () => number;
  /** When the session is over for this viewer; default `endsSession`. WEB-14 keeps states it will retry. */
  readonly ends?: (state: ConnectionState) => boolean;
  readonly lang?: Lang;
  readonly log?: LogFn;
}

export interface SceneLoaderEvents {
  /** Download progress of the snapshot being fetched. */
  progress: { readonly sceneVersion: number; readonly fraction: number };
  /** Hash-verified GLB; the loader keeps no reference to `bytes`. */
  ready: { readonly sceneVersion: number; readonly bytes: Uint8Array };
  /** 401 on a live connection: the token was dropped; the user enters the code again (§10, §9.3 `4003`). */
  enterCode: { readonly description: Description };
  /** 410 on a live connection: the session is gone (§10). */
  sessionEnded: { readonly description: Description };
  /** The announced snapshot exceeds this device's limit; nothing was downloaded. */
  tooLarge: { readonly sceneVersion: number; readonly byteLength: number };
  /** Gave up on this snapshot (attempts exhausted, a repeated 404/mismatch, or a non-retryable answer). */
  failed: {
    readonly sceneVersion: number;
    readonly reason: FailureReason | "rateLimited" | "checksumMismatch" | "notFound";
  };
}

export interface SceneLoader {
  /** Fetches `target` unless it (or something newer) is loaded or being fetched. */
  load(target: SceneTarget): void;
  /** Sends `scene.request` with what the viewer holds (§8.3). */
  requestResync(reason: ResyncReason): boolean;
  /** Tells the loader a snapshot arrived another way (WebSocket stream); older fetches are cancelled. */
  noteLoaded(sceneVersion: number): void;
  /** Cancels the fetch in flight and any pending retry. */
  cancel(): void;
  /** Version of the last snapshot loaded (HTTP or `noteLoaded`), or `null`. */
  readonly loadedVersion: number | null;
  /** Version currently being fetched (or waiting for a retry), or `null`. */
  readonly pendingVersion: number | null;
  /** The viewer token from `viewer.joined`, kept in memory only; `null` when not joined. */
  readonly viewerToken: string | null;
  on<K extends keyof SceneLoaderEvents>(
    event: K,
    handler: (payload: SceneLoaderEvents[K]) => void,
  ): () => void;
  /** Unsubscribes from the connection and cancels everything. */
  dispose(): void;
}

interface Pending {
  readonly target: SceneTarget;
  readonly controller: AbortController;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const defaultLog: LogFn = (message, fields) => console.warn(`[viewer] ${message}`, fields ?? "");

export function createSceneLoader(
  connection: Connection,
  options: SceneLoaderOptions = {},
): SceneLoader {
  const lang = options.lang ?? detectLang();
  const log = options.log ?? defaultLog;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const ends = options.ends ?? endsSession;
  const handlers = new Map<keyof SceneLoaderEvents, Set<(payload: never) => void>>();
  let token: string | null = null;
  let sessionId: string | null = null;
  let loaded: number | null = null;
  let pending: Pending | null = null;
  // Versions that already got one `scene.request` after a 404 or a bad hash: a second failure gives up instead
  // of downloading the same (up to 32 MiB) snapshot in a loop.
  const resynced = new Set<number>();

  function emit<K extends keyof SceneLoaderEvents>(event: K, payload: SceneLoaderEvents[K]): void {
    for (const handler of [...(handlers.get(event) ?? [])]) {
      try {
        (handler as (p: typeof payload) => void)(payload);
      } catch {
        log("scene loader handler failed", { event });
      }
    }
  }

  function cancel(): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    pending = null;
  }

  /**
   * The session is over for this viewer (left, ended, credentials refused, stopped). The scene model is dropped at
   * the same moment (WEB-07 `bindModelLifecycle`), so the loaded version must go too: joining the same session
   * again has to download its snapshot again instead of skipping it as "already loaded".
   */
  function forget(): void {
    token = null;
    sessionId = null;
    loaded = null;
    resynced.clear();
    cancel();
  }

  function requestResync(reason: ResyncReason): boolean {
    return connection.send({
      type: "scene.request",
      haveSnapshotVersion: loaded,
      haveSceneVersion: options.haveSceneVersion?.() ?? loaded ?? 0,
      reason,
    });
  }

  /** One `scene.request` per version; afterwards the loader gives up on it. */
  function resyncOnce(
    sceneVersion: number,
    reason: ResyncReason,
    failure: SceneLoaderEvents["failed"]["reason"],
  ): void {
    if (resynced.has(sceneVersion)) {
      log("scene download given up", { reason: failure, sceneVersion });
      return emit("failed", { sceneVersion, reason: failure });
    }
    resynced.add(sceneVersion);
    requestResync(reason);
  }

  function retryOrFail(
    p: Pending,
    delayS: number,
    reason: SceneLoaderEvents["failed"]["reason"],
  ): void {
    if (p.attempt >= maxAttempts) {
      pending = null;
      log("scene download failed", { reason, attempts: p.attempt });
      return emit("failed", { sceneVersion: p.target.sceneVersion, reason });
    }
    p.timer = setTimeout(() => {
      if (pending === p) run(p);
    }, delayS * 1000);
  }

  const run = (p: Pending) =>
    void attempt(p).catch(() =>
      log("scene download crashed", { sceneVersion: p.target.sceneVersion }),
    );

  async function attempt(p: Pending): Promise<void> {
    const currentToken = token;
    if (currentToken === null) {
      pending = null;
      return;
    }
    p.attempt++;
    const { sceneVersion } = p.target;
    const result = await fetchScene(p.target, currentToken, {
      ...options,
      signal: p.controller.signal,
      onProgress: (fraction) => {
        if (pending === p) emit("progress", { sceneVersion, fraction });
      },
    });
    if (pending !== p) return; // cancelled or replaced meanwhile
    switch (result.kind) {
      case "ready":
        pending = null;
        loaded = sceneVersion;
        resynced.clear();
        return emit("ready", { sceneVersion, bytes: result.bytes });
      case "unauthorized":
      case "gone":
        if (result.kind === "unauthorized" && token !== null && token !== currentToken) {
          // A rejoin issued a new token while this request still used the old one (§5.2): retry with it.
          if (p.attempt < maxAttempts) return run(p);
        }
        pending = null;
        token = null;
        if (connection.state.kind !== "connected") {
          // The socket dropped meanwhile (e.g. relay restart, §13 step 9): the rejoin decides, not a stale token.
          log("scene download refused while disconnected, waiting for rejoin");
          return;
        }
        log(`scene download ${result.kind}, token dropped`);
        return result.kind === "unauthorized"
          ? emit("enterCode", { description: describe(4003, lang) })
          : emit("sessionEnded", { description: describe(4001, lang) });
      case "notFound":
        // The relay caches another version now; it answers with scene.snapshot.ready (§8.3).
        pending = null;
        return resyncOnce(sceneVersion, "GAP", "notFound");
      case "tooLarge":
        pending = null;
        return emit("tooLarge", { sceneVersion, byteLength: result.byteLength });
      case "checksumMismatch":
        pending = null;
        log("scene download checksum mismatch", { sceneVersion });
        return resyncOnce(sceneVersion, "CHECKSUM_MISMATCH", "checksumMismatch");
      case "rateLimited":
        return retryOrFail(p, result.retryAfterS, "rateLimited");
      case "failed":
        if (result.reason === "invalid") {
          pending = null;
          return emit("failed", { sceneVersion, reason: "invalid" });
        }
        log("scene download attempt failed", {
          reason: result.reason,
          ...(result.status !== undefined ? { status: result.status } : {}),
        });
        return retryOrFail(p, 2 ** (p.attempt - 1), result.reason);
      case "aborted":
        return;
    }
  }

  function load(target: SceneTarget): void {
    if (loaded !== null && target.sceneVersion <= loaded) return; // already have it (or newer)
    if (pending && target.sceneVersion <= pending.target.sceneVersion) return; // same or older than in flight
    cancel();
    if (token === null) return log("scene download skipped: not joined");
    const p: Pending = { target, controller: new AbortController(), attempt: 0, timer: undefined };
    pending = p;
    run(p);
  }

  const offs = [
    connection.onMessage("viewer.joined", (m: MessageOfType<"viewer.joined">) => {
      token = m.viewerToken;
      if (m.sessionId !== sessionId) {
        // A new session (e.g. joined again by code after a relay restart) restarts versions at 1 (§8.4, §13 step 9).
        sessionId = m.sessionId;
        loaded = null;
        resynced.clear();
        cancel();
      }
      if (!m.snapshotAvailable) return;
      if (m.snapshot) load(m.snapshot);
      else requestResync("GAP"); // announced but not described: ask for scene.snapshot.ready
    }),
    connection.onMessage("scene.snapshot.ready", (m) => load(m)),
    connection.on("state", (s) => {
      if (ends(s)) return forget();
      // 4008: the relay instance restarts and its tokens die with it (§9.3); a retry would only get 401.
      if (s.kind === "disconnected" && s.immediate) cancel();
    }),
  ];

  return {
    load,
    requestResync,
    noteLoaded(sceneVersion) {
      if (loaded === null || sceneVersion > loaded) loaded = sceneVersion;
      if (pending && pending.target.sceneVersion <= sceneVersion) cancel();
    },
    cancel,
    get loadedVersion() {
      return loaded;
    },
    get pendingVersion() {
      return pending?.target.sceneVersion ?? null;
    },
    get viewerToken() {
      return token;
    },
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      const h = handler as (payload: never) => void;
      set.add(h);
      return () => void set.delete(h);
    },
    dispose() {
      offs.forEach((off) => off());
      cancel();
    },
  };
}

/**
 * Routes stream outcomes (WEB-05) into the loader: a streamed snapshot counts as loaded; a bad hash asks for the
 * snapshot again right away (the relay verified and cached it before forwarding `end`, §6.4); a broken sequence
 * asks only once that version's `scene.snapshot.end` has arrived — before it, the relay still caches the old
 * version and would answer with `scene.state` only. Returns the unsubscribe function.
 */
export function bindStreamToLoader(
  connection: Connection,
  stream: SnapshotStream,
  loader: SceneLoader,
): () => void {
  let broken: number | null = null; // stream version that failed before its end arrived
  let lastEnd: number | null = null;
  const offs = [
    stream.on("ready", ({ sceneVersion }) => loader.noteLoaded(sceneVersion)),
    stream.on("checksumMismatch", () => void loader.requestResync("CHECKSUM_MISMATCH")),
    stream.on("badSequence", ({ sceneVersion }) => {
      if (lastEnd === sceneVersion) loader.requestResync("GAP");
      else broken = sceneVersion;
    }),
    connection.onMessage("scene.snapshot.end", (m) => {
      lastEnd = m.sceneVersion;
      if (broken !== m.sceneVersion) return;
      broken = null;
      loader.requestResync("GAP");
    }),
    connection.onMessage("scene.snapshot.abort", (m) => {
      if (broken === m.sceneVersion) broken = null; // the relay dropped it too; nothing new to fetch
    }),
  ];
  return () => offs.forEach((off) => off());
}
