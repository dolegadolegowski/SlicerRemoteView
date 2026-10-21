// Live-update ordering (WEB-12; docs/protocol.md §8.1–8.4). No DOM, no three.js. The viewer holds one `sceneVersion`;
// a `scene.update` / `scene.nodeRemoved` / `scene.nodeAdded` is applied only when its `baseVersion` is exactly what is
// held. Messages that arrive while the scene they belong to is not shown yet — a snapshot still downloading or
// parsing, a `scene.state` waiting for its GLB — are queued and applied in order once it is. A gap (a missed
// message, a reconnect) sends one `scene.request{reason:"GAP"}` and waits for the answer instead of applying anything
// out of order. `scene.state` (§8.3) is applied to the GLB of its `snapshotVersion` only.
//
// The connection checks message shapes at the top level only (WEB-04): the items of `changes[]`, `nodes[]` and
// `removed[]` are validated here, one by one (`parseChange`, `parseNodeIds`); an invalid item is skipped.

import type { MessageOfType } from "@slicerremoteview/shared";
import { endsSession } from "./connection";
import type { Connection, ConnectionState, LogFn } from "./connection";

export type LiveMessage =
  | MessageOfType<"scene.update">
  | MessageOfType<"scene.nodeRemoved">
  | MessageOfType<"scene.nodeAdded">;
export type StateMessage = MessageOfType<"scene.state">;

/** One validated item of `scene.update.changes` / `scene.state.nodes` (defs.schema.json `nodeChange`). */
export interface NodeChange {
  readonly nodeId: string;
  readonly visible?: boolean;
  readonly color?: readonly [number, number, number];
  readonly opacity?: number;
  /** 16 numbers, column-major, glTF space; replaces `T.matrix` (§7.2). */
  readonly matrix?: readonly number[];
}

const NODE_ID = /^[A-Za-z0-9_./:-]{1,128}$/;
const unit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

/** `item` as a change, or `null` when it is not a valid `nodeChange` (needs `nodeId` and one property). */
export function parseChange(item: unknown): NodeChange | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const v = item as Record<string, unknown>;
  if (typeof v["nodeId"] !== "string" || !NODE_ID.test(v["nodeId"])) return null;
  const change: {
    nodeId: string;
    visible?: boolean;
    color?: [number, number, number];
    opacity?: number;
    matrix?: number[];
  } = { nodeId: v["nodeId"] };
  if ("visible" in v) {
    if (typeof v["visible"] !== "boolean") return null;
    change.visible = v["visible"];
  }
  if ("color" in v) {
    const c: unknown = v["color"];
    if (!Array.isArray(c) || c.length !== 3) return null;
    const [r, g, b] = c as unknown[];
    if (!unit(r) || !unit(g) || !unit(b)) return null;
    change.color = [r, g, b];
  }
  if ("opacity" in v) {
    if (!unit(v["opacity"])) return null;
    change.opacity = v["opacity"];
  }
  if ("matrix" in v) {
    const m = v["matrix"];
    if (!Array.isArray(m) || m.length !== 16 || !m.every((n) => Number.isFinite(n))) return null;
    change.matrix = [...(m as number[])];
  }
  return Object.keys(change).length > 1 ? change : null;
}

/** The valid node ids of `list` (`scene.nodeRemoved.nodeIds`, `scene.state.removed`). */
export function parseNodeIds(list: readonly unknown[]): string[] {
  return list.filter((id): id is string => typeof id === "string" && NODE_ID.test(id));
}

export interface SceneVersionsOptions {
  /** Applies a live message whose versions fit (the item lists are not validated yet). */
  readonly apply: (message: LiveMessage) => void;
  /** Applies a `scene.state` to the shown snapshot, which has its `snapshotVersion`. */
  readonly applyState: (state: StateMessage) => void;
  /** Sends `scene.request` (the loader does: it knows `haveSnapshotVersion`). */
  readonly requestResync: (reason: "GAP") => void;
  /** Live messages kept while the scene they belong to is not shown yet; beyond, they are dropped. Default 256. */
  readonly maxQueued?: number;
  readonly log?: LogFn;
}

export interface SceneVersions {
  /** The version the viewer holds (`scene.request.haveSceneVersion`), `null` before anything was shown. */
  readonly sceneVersion: number | null;
  /**
   * `viewer.joined` (of the same session): wait for the `scene.state` that follows it (§8.3 a). A snapshot that was
   * in flight when the connection dropped no longer counts: the relay announces it again (§6.4 b).
   */
  joined(): void;
  /** A snapshot of this version is on its way (`scene.snapshot.begin` or `.ready`). */
  expect(snapshotVersion: number): void;
  /** That snapshot will not be shown (aborted, refused, too large, gave up). */
  abandon(snapshotVersion: number): void;
  /** The model of this snapshot version is now shown; `null` when the scene was cleared. */
  shown(snapshotVersion: number | null): void;
  state(message: StateMessage): void;
  live(message: LiveMessage): void;
  /** The session is over for this viewer. */
  reset(): void;
}

export function createSceneVersions(options: SceneVersionsOptions): SceneVersions {
  const maxQueued = options.maxQueued ?? 256;
  const log = options.log ?? (() => undefined);
  let held: number | null = null; // sceneVersion the shown scene is at
  let shown: number | null = null; // snapshotVersion of the shown model
  let expecting: number | null = null; // a newer snapshot on its way
  let pendingState: StateMessage | null = null; // a scene.state waiting for its GLB
  let awaitingState = false; // after viewer.joined or a gap: the next scene.state decides
  let queue: LiveMessage[] = [];

  const inSync = () =>
    held !== null && !awaitingState && pendingState === null && expecting === null;

  function gap(): void {
    awaitingState = true;
    options.requestResync("GAP");
  }

  /** Applies `message` if it continues the held version; returns false on a gap. */
  function step(message: LiveMessage): boolean {
    if (held === null) return false;
    if (message.sceneVersion <= held) return true; // already contained in what is shown (e.g. a scene.state)
    if (message.baseVersion !== held) return false;
    options.apply(message);
    held = message.sceneVersion;
    return true;
  }

  function drain(): void {
    while (inSync() && queue.length > 0) {
      const message = queue[0]!;
      if (!step(message)) {
        log("scene update gap", { type: message.type });
        return gap(); // the rest stays queued; whatever the next scene.state covers is skipped then
      }
      queue.shift();
    }
  }

  function applyState(state: StateMessage): void {
    pendingState = null;
    awaitingState = false;
    options.applyState(state);
    held = state.sceneVersion;
    drain();
  }

  function clear(): void {
    held = null;
    shown = null;
    expecting = null;
    pendingState = null;
    awaitingState = false;
    queue = [];
  }

  return {
    get sceneVersion() {
      return held;
    },
    joined() {
      awaitingState = true;
      pendingState = null;
      expecting = null;
    },
    expect(snapshotVersion) {
      if (shown === null || snapshotVersion > shown) expecting = snapshotVersion;
    },
    abandon(snapshotVersion) {
      if (expecting === snapshotVersion) expecting = null;
      if (pendingState?.snapshotVersion === snapshotVersion) pendingState = null;
      // Back to the scene still shown: queued updates that continue it apply; the first that does not (it belongs
      // to the abandoned snapshot) asks once for the state.
      drain();
    },
    shown(snapshotVersion) {
      if (snapshotVersion === null) return clear();
      shown = snapshotVersion;
      if (expecting !== null && expecting <= snapshotVersion) expecting = null;
      if (pendingState?.snapshotVersion === snapshotVersion) return applyState(pendingState);
      const pendingFor = pendingState?.snapshotVersion ?? null;
      if (pendingFor !== null && pendingFor < snapshotVersion) pendingState = null; // about an older snapshot
      // A new snapshot is at its own version; a streamed one has no scene.state after it (§6.4: state reset).
      held = snapshotVersion;
      awaitingState = false;
      drain();
    },
    state(message) {
      if (message.snapshotVersion === null) {
        // Nothing published yet (§8.3): only the version counts; there is no scene to apply anything to.
        if (shown === null) {
          held = message.sceneVersion;
          awaitingState = false;
          drain();
        }
        return;
      }
      if (shown === message.snapshotVersion) {
        if (held !== null && message.sceneVersion < held) {
          awaitingState = false; // older than what is shown: applying it would undo newer changes
          return drain();
        }
        return applyState(message);
      }
      if (shown !== null && message.snapshotVersion < shown) return; // about an older snapshot than the one shown
      pendingState = message; // applied when its GLB is shown
    },
    live(message) {
      if (inSync() && queue.length === 0) {
        if (step(message)) return;
        log("scene update gap", { type: message.type });
        queue.push(message);
        return gap();
      }
      if (queue.length >= maxQueued) {
        // Far behind (a stalled download): drop the backlog and ask for the state once the scene is there.
        queue = [];
        awaitingState = true;
        log("scene update queue overflow");
      }
      queue.push(message);
    },
    reset: clear,
  };
}

/**
 * Feeds `versions` from the connection; a different session (new code, relay restart) starts from nothing, also
 * when none of the old session's scene was ever shown. `ends` as in `bindModelLifecycle`. Returns the unsubscribe
 * function.
 */
export function bindSceneVersions(
  connection: Pick<Connection, "on" | "onMessage">,
  versions: SceneVersions,
  ends: (state: ConnectionState) => boolean = endsSession,
): () => void {
  let sessionId: string | null = null;
  const offs = [
    connection.onMessage("viewer.joined", (m) => {
      if (sessionId !== null && m.sessionId !== sessionId) versions.reset();
      sessionId = m.sessionId;
      versions.joined();
    }),
    connection.onMessage("scene.state", (m) => versions.state(m)),
    connection.onMessage("scene.update", (m) => versions.live(m)),
    connection.onMessage("scene.nodeRemoved", (m) => versions.live(m)),
    connection.onMessage("scene.nodeAdded", (m) => versions.live(m)),
    connection.onMessage("scene.snapshot.begin", (m) => versions.expect(m.sceneVersion)),
    connection.onMessage("scene.snapshot.ready", (m) => versions.expect(m.sceneVersion)),
    connection.onMessage("scene.snapshot.abort", (m) => versions.abandon(m.sceneVersion)),
    connection.on("state", (s) => {
      if (!ends(s)) return;
      sessionId = null;
      versions.reset();
    }),
  ];
  return () => offs.forEach((off) => off());
}
