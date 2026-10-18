/**
 * GLB loading for snapshot playback (PRO-14): reads the file, checks the container header and extracts what
 * `scene.snapshot.begin` announces (§6.2) — `extensionsUsed`/`extensionsRequired` and the informational
 * `nodeCount`/`triangleCount`. It is not a validator (`gltf-validator` covers the fixtures in `shared/`);
 * it only refuses files that cannot be published at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SNAPSHOT_BYTES, sha256Hex } from "@slicerremoteview/shared";

/** `shared/fixtures/glb`, reachable from `src/` and from `dist/` alike. */
export const FIXTURE_DIR = fileURLToPath(new URL("../../../shared/fixtures/glb/", import.meta.url));
export const DEFAULT_FIXTURE = "asymmetric-2nodes.glb";

export interface LoadedGlb {
  bytes: Uint8Array;
  sha256: string;
  extensionsUsed: string[];
  extensionsRequired: string[];
  /** glTF nodes carrying `extras.nodeId` (the `T` nodes of §7.2, excluding the root). */
  nodeCount: number;
  triangleCount: number;
}

interface GltfJson {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  nodes?: { extras?: { nodeId?: unknown; kind?: unknown } }[];
  meshes?: { primitives?: { indices?: number; mode?: number }[] }[];
  accessors?: { count?: number }[];
}

/** `--fixture` resolution: an existing path as given, else a bare file name inside `shared/fixtures/glb/`. */
export function resolveFixture(fixture: string | undefined): string {
  const requested = fixture ?? DEFAULT_FIXTURE;
  if (existsSync(requested)) return resolve(requested);
  const bundled = resolve(FIXTURE_DIR, basename(requested));
  if (basename(requested) === requested && existsSync(bundled)) return bundled;
  throw new Error(`fixture not found: ${requested}`);
}

/** Splits the container and parses the JSON chunk (glTF 2.0 §4.4); throws `Error` with a short reason. */
function parseGltfJson(bytes: Uint8Array): GltfJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error("not a GLB (bad magic)");
  if (view.getUint32(4, true) !== 2) throw new Error("not glTF 2.0");
  if (view.getUint32(8, true) !== bytes.byteLength)
    throw new Error("GLB header length does not match the file size (truncated?)");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.byteLength)
    throw new Error("GLB has no JSON chunk");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
}

function countTriangles(gltf: GltfJson): number {
  let triangles = 0;
  for (const mesh of gltf.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.indices === undefined) continue;
      triangles += Math.floor((gltf.accessors?.[primitive.indices]?.count ?? 0) / 3);
    }
  return triangles;
}

export async function loadGlb(path: string): Promise<LoadedGlb> {
  const buffer = readFileSync(path);
  if (buffer.byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error(
      `${basename(path)} is larger than the ${MAX_SNAPSHOT_BYTES}-byte snapshot limit`,
    );
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let gltf: GltfJson;
  try {
    gltf = parseGltfJson(bytes);
  } catch (error) {
    throw new Error(`${basename(path)}: ${(error as Error).message}`, { cause: error });
  }
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    extensionsUsed: gltf.extensionsUsed ?? [],
    extensionsRequired: gltf.extensionsRequired ?? [],
    nodeCount: (gltf.nodes ?? []).filter(
      (node) => typeof node.extras?.nodeId === "string" && node.extras.kind !== "root",
    ).length,
    triangleCount: countTriangles(gltf),
  };
}
