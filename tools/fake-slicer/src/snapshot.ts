/**
 * Snapshot playback (PRO-14, §6.1–6.4): `scene.snapshot.begin`, the `SRVC` chunk frames and
 * `scene.snapshot.end` for one GLB, sent in this order on an open publisher socket.
 */
import {
  PROTOCOL_VERSION,
  chunkCountFor,
  chunkify,
  encodeChunkFrame,
} from "@slicerremoteview/shared";
import type { WebSocket } from "ws";
import type { LoadedGlb } from "./glb.js";
import type { Profile } from "./options.js";

export interface SnapshotPlan {
  glb: LoadedGlb;
  sceneVersion: number;
  chunkSize: number;
  profile: Profile;
}

/** Sends one frame and resolves when `ws` has handed it to the socket (natural back-pressure for big GLBs). */
export function sendFrame(socket: WebSocket, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(data, { binary: typeof data !== "string" }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

export const envelope = (type: string, id: string, fields: Record<string, unknown>): string =>
  JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, id, ts: Date.now(), ...fields });

/** `scene.snapshot.begin` for the plan; `chunkCount = ceil(byteLength / chunkSize)` (§6.2). */
export function snapshotBegin(plan: SnapshotPlan, id: string): string {
  const { glb } = plan;
  return envelope("scene.snapshot.begin", id, {
    sceneVersion: plan.sceneVersion,
    byteLength: glb.bytes.byteLength,
    sha256: glb.sha256,
    chunkCount: chunkCountFor(glb.bytes.byteLength, plan.chunkSize),
    chunkSize: plan.chunkSize,
    format: "glb",
    extensionsUsed: glb.extensionsUsed,
    extensionsRequired: glb.extensionsRequired,
    profile: plan.profile,
    nodeCount: glb.nodeCount,
    triangleCount: glb.triangleCount,
  });
}

/** Streams begin → chunks → end. Returns the number of chunks sent. */
export async function sendSnapshot(
  socket: WebSocket,
  plan: SnapshotPlan,
  nextId: () => string,
): Promise<number> {
  await sendFrame(socket, snapshotBegin(plan, nextId()));
  let chunks = 0;
  for (const { chunkIndex, payload } of chunkify(plan.glb.bytes, plan.chunkSize)) {
    await sendFrame(
      socket,
      encodeChunkFrame({ sceneVersion: plan.sceneVersion, chunkIndex }, payload),
    );
    chunks++;
  }
  await sendFrame(
    socket,
    envelope("scene.snapshot.end", nextId(), {
      sceneVersion: plan.sceneVersion,
      sha256: plan.glb.sha256,
    }),
  );
  return chunks;
}
