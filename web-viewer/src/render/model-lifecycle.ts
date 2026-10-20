// Ties the scene model store (WEB-07) to the session: every verified snapshot — from the WebSocket stream (WEB-05)
// or HTTP (WEB-06) — is parsed; a refused one is reported; the model is dropped when the session is over for this
// viewer or a different session is joined, and kept while reconnecting (WEB-14).

import { endsSession } from "../protocol/connection";
import type { Connection, ConnectionState } from "../protocol/connection";
import type { SceneModelStore } from "./scene-model";

/** Anything that emits hash-verified snapshots: `SnapshotStream` and `SceneLoader`. */
export interface SnapshotSource {
  on(
    event: "ready",
    handler: (payload: { readonly sceneVersion: number; readonly bytes: Uint8Array }) => void,
  ): () => void;
}

/**
 * `onInvalid` is called once per refused (or failing) load with its snapshot version; `superseded` loads are
 * ignored. The bytes are handed to the store and not kept here (FR-45). `ends` says when the session is over for
 * this viewer (default `endsSession`; WEB-14 keeps the states it will retry). Returns the unsubscribe function.
 */
export function bindModelLifecycle(
  connection: Pick<Connection, "on" | "onMessage">,
  sources: readonly SnapshotSource[],
  models: SceneModelStore,
  onInvalid: (sceneVersion: number) => void,
  ends: (state: ConnectionState) => boolean = endsSession,
): () => void {
  let sessionId: string | null = null;
  const parse = ({
    sceneVersion,
    bytes,
  }: {
    readonly sceneVersion: number;
    readonly bytes: Uint8Array;
  }) =>
    void models
      .load(bytes, sceneVersion)
      .then((result) => {
        if (!result.ok && result.reason !== "superseded") onInvalid(sceneVersion);
      })
      .catch(() => onInvalid(sceneVersion));
  const offs = [
    ...sources.map((source) => source.on("ready", parse)),
    connection.onMessage("viewer.joined", (m) => {
      // Another session (a new code, or a relay restart, §13 step 9): its versions start over; the old scene goes.
      if (sessionId !== null && m.sessionId !== sessionId) models.clear();
      sessionId = m.sessionId;
    }),
    // Left, ended, refused or stopped: drop the scene. It stays while reconnecting (WEB-14).
    connection.on("state", (state) => {
      if (ends(state)) models.clear();
    }),
  ];
  return () => offs.forEach((off) => off());
}
