// GLB → three.js scene model with a `nodeId` map (WEB-07; docs/protocol.md §7). Three steps:
//  1. `validateGlb()` (glb-validate.ts) checks the container and the JSON chunk against §7.1 *before* three.js sees
//     the bytes (T10);
//  2. `GLTFLoader.parseAsync()` without Draco/meshopt decoders (v1 allows only `KHR_mesh_quantization`, ADR 0001);
//  3. the two-node structure of §7.2 becomes `Map<nodeId, {T, M, material, manifest}>`: visibility and matrices
//     address `T`, material properties `M`'s own material.
// `createSceneModelStore()` keeps the current model and disposes the previous one (geometries, materials) when a
// new snapshot is loaded; no reference to the raw GLB bytes is kept after parsing (FR-45).

import { Group, Material, Mesh, Object3D } from "three";
import type { BufferGeometry } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { LogFn } from "../protocol/connection";
import { validateGlb } from "./glb-validate";
import type { InvalidReason } from "./glb-validate";

export type { GlbCheck, InvalidReason } from "./glb-validate";
export { MAX_MANIFEST_NODES, validateGlb } from "./glb-validate";

/** §7.3 manifest entry as found in `T.extras`, normalised. */
export interface ManifestEntry {
  readonly nodeId: string;
  readonly kind: string;
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly visible: boolean;
  readonly triangleCount?: number;
  readonly baked?: boolean;
}

export interface SceneNode {
  readonly nodeId: string;
  /** Position in the manifest (GLB order, §7.3); drives the translucent draw order. */
  readonly order: number;
  /** Transform node: visibility and `scene.update.matrix` (§7.2). */
  readonly T: Object3D;
  /** Mesh node: carries the dequantisation matrix, never touched by updates (§7.2). */
  readonly M: Mesh;
  /** `M`'s material, never shared with another node (cloned if the GLB shares one). */
  readonly material: Material;
  readonly manifest: ManifestEntry;
}

export interface RootInfo {
  readonly sceneVersion: number | null;
  readonly profile: string | null;
  readonly anonymizedNames: boolean;
}

export interface SceneModel {
  /** Add this to the three.js scene: the glTF scene rotated 180° about Y for presentation (§7.1). */
  readonly root: Group;
  /** The untouched glTF scene (metres, +Y up, patient facing −Z). */
  readonly content: Object3D;
  /** Manifest order = GLB order (§7.3); iteration order of the map. */
  readonly nodes: ReadonlyMap<string, SceneNode>;
  readonly info: RootInfo;
  /** `sceneVersion` of the snapshot this model was parsed from (`scene.snapshot.*`, §6), `null` when unknown. */
  readonly snapshotVersion: number | null;
  /**
   * Takes a node out of the scene and disposes its geometry and material (`scene.nodeRemoved`, §8.2). Returns
   * `false` for an unknown `nodeId`.
   */
  removeNode(nodeId: string): boolean;
  /** Disposes every geometry and material once and detaches the model; idempotent. */
  dispose(): void;
}

export type SceneModelResult =
  | { readonly ok: true; readonly model: SceneModel }
  | { readonly ok: false; readonly reason: InvalidReason };

/** Parser seam for tests; the default is three.js `GLTFLoader` with no extra decoders. */
export type ParseGlb = (buffer: ArrayBuffer) => Promise<{ readonly scene: Object3D }>;

const NODE_ID = /^[A-Za-z0-9_./:-]{1,128}$/; // §3.3
/**
 * Translucent meshes get `TRANSLUCENT_RENDER_ORDER + manifest position`: three.js draws its transparent list after
 * the opaque one and sorts it by `renderOrder` before depth, so nested translucent segments keep one stable blend
 * order while orbiting instead of popping as their centres swap depth (architecture §7, R-08, web.md §1.6).
 */
export const TRANSLUCENT_RENDER_ORDER = 1;

const defaultParse: ParseGlb = (buffer) => new GLTFLoader().parseAsync(buffer, "");

/**
 * Sets a node's opacity with the blending state it needs: translucent meshes do not write depth and draw in
 * manifest order. Takes the node (not a mesh) so a caller cannot forget the order (WEB-12/13 reuse it).
 */
export function applyOpacity(
  node: Pick<SceneNode, "M" | "material" | "order">,
  opacity: number,
): void {
  const { M, material, order } = node;
  const translucent = opacity < 1;
  if (material.transparent !== translucent || material.depthWrite === translucent)
    material.needsUpdate = true;
  material.opacity = opacity;
  material.transparent = translucent;
  material.depthWrite = !translucent;
  M.renderOrder = translucent ? TRANSLUCENT_RENDER_ORDER + order : 0;
}

type Json = Record<string, unknown>;
const unit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;
const isColor = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(unit);

/** The material's colour when it is a valid 0..1 triple (GLTFLoader copies factors unchecked), else white. */
function materialColor(material: Material): [number, number, number] {
  const color = (material as Material & { color?: { r: unknown; g: unknown; b: unknown } }).color;
  const rgb = color ? [color.r, color.g, color.b] : undefined;
  return isColor(rgb) ? rgb : [1, 1, 1];
}

/** `T.extras` → manifest entry; values that are missing or malformed fall back to the material (§7.3, §7.4). */
function manifestOf(extras: Json, nodeId: string, material: Material): ManifestEntry {
  const color = extras["color"];
  return {
    nodeId,
    kind: typeof extras["kind"] === "string" ? extras["kind"] : "model",
    name: typeof extras["name"] === "string" ? extras["name"] : nodeId,
    color: isColor(color) ? [color[0], color[1], color[2]] : materialColor(material),
    opacity: unit(extras["opacity"])
      ? extras["opacity"]
      : unit(material.opacity)
        ? material.opacity
        : 1,
    visible: typeof extras["visible"] === "boolean" ? extras["visible"] : true,
    ...(typeof extras["triangleCount"] === "number"
      ? { triangleCount: extras["triangleCount"] }
      : {}),
    ...(typeof extras["baked"] === "boolean" ? { baked: extras["baked"] } : {}),
  };
}

/** Every unique geometry and material below `object` (materials may be shared between meshes). */
function resourcesOf(object: Object3D): { geometries: BufferGeometry[]; materials: Material[] } {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  object.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    geometries.add(o.geometry as BufferGeometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      if (m instanceof Material) materials.add(m);
  });
  return { geometries: [...geometries], materials: [...materials] };
}

function disposeObject(object: Object3D): void {
  const { geometries, materials } = resourcesOf(object);
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}

/** Builds the node map of §7.2 from the parsed scene, or `null` when the structure is not T → one mesh M. */
function buildNodes(content: Object3D): {
  nodes: Map<string, SceneNode>;
  info: RootInfo;
} | null {
  const root = content.children.length === 1 ? content.children[0] : undefined;
  const rootExtras = root?.userData;
  if (!root || rootExtras?.["nodeId"] !== "root") return null;
  // Pass 1: structure, and one material per node — GLTFLoader reuses one Material for every primitive with the
  // same index; clone before any node changes it, so neither opacity nor blending state leaks between nodes.
  const pairs: { T: Object3D; M: Mesh; nodeId: string; material: Material }[] = [];
  const ids = new Set<string>();
  const seen = new Set<Material>();
  for (const T of root.children) {
    const nodeId = (T.userData as Json)["nodeId"];
    const M = T.children.length === 1 ? T.children[0] : undefined;
    if (typeof nodeId !== "string" || !NODE_ID.test(nodeId) || ids.has(nodeId)) return null;
    const kind = T as Object3D & { isLight?: boolean; isCamera?: boolean };
    if (kind.isLight || kind.isCamera) return null;
    if (!(M instanceof Mesh) || M.children.length > 0 || !(M.material instanceof Material))
      return null;
    if (seen.has(M.material)) {
      // Only GLTFLoader's default material (primitives without `material`) can be shared here — the validator
      // refuses shared ones. Never deep-copy material extras per node: the viewer does not read them.
      const shared = M.material;
      const { userData } = shared;
      shared.userData = {};
      M.material = shared.clone();
      shared.userData = userData;
    }
    const material: Material = M.material;
    seen.add(material);
    ids.add(nodeId);
    pairs.push({ T, M, nodeId, material });
  }
  // Pass 2: manifest values and the visual state they describe.
  const nodes = new Map<string, SceneNode>();
  for (const [order, { T, M, nodeId, material }] of pairs.entries()) {
    const manifest = manifestOf(T.userData as Json, nodeId, material);
    const node: SceneNode = { nodeId, order, T, M, material, manifest };
    T.visible = manifest.visible;
    applyOpacity(node, manifest.opacity);
    nodes.set(nodeId, node);
  }
  return {
    nodes,
    info: {
      sceneVersion:
        typeof rootExtras["sceneVersion"] === "number" ? rootExtras["sceneVersion"] : null,
      profile: typeof rootExtras["profile"] === "string" ? rootExtras["profile"] : null,
      anonymizedNames: rootExtras["anonymizedNames"] === true,
    },
  };
}

/** An `ArrayBuffer` holding exactly `bytes` — the same buffer when it already does (no copy). */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength)
    return buffer;
  return bytes.slice().buffer;
}

export interface ParseSceneOptions {
  readonly parse?: ParseGlb;
  /** The version the snapshot was announced with; becomes `SceneModel.snapshotVersion`. */
  readonly snapshotVersion?: number;
}

/** Validates (§7.1), parses and maps (§7.2) one GLB. Never throws; a refused snapshot keeps no scene. */
export async function parseSceneModel(
  bytes: Uint8Array,
  options: ParseSceneOptions = {},
): Promise<SceneModelResult> {
  const check = validateGlb(bytes);
  if (!check.ok) return check;
  let content: Object3D;
  try {
    const gltf = await (options.parse ?? defaultParse)(exactBuffer(bytes));
    if (!(gltf?.scene instanceof Object3D)) return { ok: false, reason: "parse" };
    content = gltf.scene;
  } catch {
    return { ok: false, reason: "parse" };
  }
  let built: ReturnType<typeof buildNodes>;
  try {
    built = buildNodes(content);
  } catch {
    built = null;
  }
  if (!built) {
    disposeObject(content);
    return { ok: false, reason: "structure" };
  }
  const root = new Group();
  root.name = "SlicerRemoteView presentation";
  // §7.1: the patient faces −Z; turn the model towards the default camera. Data stays unchanged (no mirroring).
  root.rotation.y = Math.PI;
  root.add(content);
  let disposed = false;
  const nodes = built.nodes;
  return {
    ok: true,
    model: {
      root,
      content,
      nodes,
      info: built.info,
      snapshotVersion: options.snapshotVersion ?? null,
      removeNode(nodeId) {
        const node = nodes.get(nodeId);
        if (!node) return false;
        nodes.delete(nodeId);
        node.T.removeFromParent();
        disposeObject(node.T);
        return true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        root.removeFromParent();
        disposeObject(content);
      },
    },
  };
}

/** `superseded`: a newer `load()` or `clear()` happened meanwhile; the result was disposed and should be ignored. */
export type StoreLoadResult =
  SceneModelResult | { readonly ok: false; readonly reason: "superseded" };

export interface SceneModelStore {
  /**
   * Parses `bytes` of snapshot `snapshotVersion`; on success the new model becomes `current` and the previous one
   * is disposed. On failure the previous model stays (a broken snapshot does not blank the screen). Only the
   * latest call can win.
   */
  load(bytes: Uint8Array, snapshotVersion?: number): Promise<StoreLoadResult>;
  readonly current: SceneModel | null;
  /** Disposes the current model and cancels loads in flight (session ended, WEB-16). */
  clear(): void;
  /** Called with the new current model after a successful load, and with `null` after `clear()`. */
  onChange(handler: (model: SceneModel | null) => void): () => void;
}

export interface SceneModelStoreOptions extends ParseSceneOptions {
  readonly log?: LogFn;
}

const defaultLog: LogFn = (message, fields) => console.warn(`[viewer] ${message}`, fields ?? "");

export function createSceneModelStore(options: SceneModelStoreOptions = {}): SceneModelStore {
  const log = options.log ?? defaultLog;
  let current: SceneModel | null = null;
  let generation = 0;
  const handlers = new Set<(model: SceneModel | null) => void>();
  const changed = () => {
    for (const handler of [...handlers]) {
      try {
        handler(current);
      } catch {
        log("scene model handler failed");
      }
    }
  };
  return {
    async load(bytes, snapshotVersion) {
      const mine = ++generation;
      const result = await parseSceneModel(bytes, {
        ...options,
        ...(snapshotVersion !== undefined ? { snapshotVersion } : {}),
      });
      if (mine !== generation) {
        if (result.ok) result.model.dispose();
        return { ok: false, reason: "superseded" };
      }
      if (!result.ok) {
        log("snapshot refused", { reason: result.reason }); // reason only: names may contain PHI (§7.3)
        return result;
      }
      current?.dispose();
      current = result.model;
      changed();
      return result;
    },
    get current() {
      return current;
    },
    clear() {
      generation++;
      const had = current !== null;
      current?.dispose();
      current = null;
      if (had) changed();
    },
    onChange(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
  };
}
