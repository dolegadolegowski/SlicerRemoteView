/**
 * Deterministic GLB fixtures for the protocol conformance suite (PRO-08, docs/protocol.md §7).
 *
 *   npm run fixtures -w shared          # rewrites shared/fixtures/glb/* and manifest.json
 *   node shared/scripts/make-glb-fixtures.ts <out-dir>
 *
 * Runs through Node's type stripping (unflagged since 22.18; the npm script passes
 * `--experimental-strip-types` so 22.12–22.17 work too — no build step). The geometry uses only additions and
 * square roots (no trigonometry), so the bytes are identical on every platform and
 * `git diff --exit-code shared/fixtures/glb` is a valid drift check.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixture-set version (independent of the package version): bump only when the geometry or layout changes. */
const VERSION = "0.1.0-fixtures";
/** §7.1 shape "SlicerRemoteView <version>". */
const GENERATOR = `SlicerRemoteView ${VERSION}`;
const OUT_DIR = resolve(
  process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/glb"),
);
const QUANTIZATION = "KHR_mesh_quantization";

// ---------------------------------------------------------------- geometry (metres, +Y up)

interface Mesh {
  positions: number[]; // flat xyz
  indices: number[]; // flat triangles, CCW seen from outside
}

/** Four vertices that are asymmetric in every axis: handedness errors move (+0.1,0,0) and (0,0,-0.1). */
function asymmetricTetrahedron(): Mesh {
  return orientOutward({
    positions: [0, 0, 0, 0.1, 0, 0, 0, 0.05, 0, 0, 0, -0.1],
    indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
  });
}

/** Unit octahedron subdivided `levels` times with vertices pushed onto the sphere of `radius`. */
function sphere(levels: number, radius: number): Mesh {
  let positions = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  let indices = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  for (let level = 0; level < levels; level++) {
    const cache = new Map<string, number>();
    const next: number[] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const x = (positions[a * 3]! + positions[b * 3]!) / 2;
      const y = (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2;
      const z = (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2;
      const len = Math.sqrt(x * x + y * y + z * z);
      positions.push(x / len, y / len, z / len);
      const index = positions.length / 3 - 1;
      cache.set(key, index);
      return index;
    };
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }
  positions = positions.map((v) => v * radius);
  return { positions, indices };
}

/** Flip every face whose normal points towards the centroid (convex shapes only). */
function orientOutward(mesh: Mesh): Mesh {
  const n = mesh.positions.length / 3;
  const c = [0, 1, 2].map((k) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += mesh.positions[i * 3 + k]!;
    return sum / n;
  });
  const indices = [...mesh.indices];
  for (let t = 0; t < indices.length; t += 3) {
    const p = (i: number) => mesh.positions.slice(indices[t + i]! * 3, indices[t + i]! * 3 + 3);
    const [a, b, d] = [p(0), p(1), p(2)];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    const normal = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const toCentroid = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const dot =
      normal[0]! * toCentroid[0]! + normal[1]! * toCentroid[1]! + normal[2]! * toCentroid[2]!;
    if (dot > 0) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!];
  }
  return { positions: mesh.positions, indices };
}

/** Area-weighted smooth vertex normals (vtkPolyDataNormals with SplittingOff, §7.4). */
function smoothNormals({ positions, indices }: Mesh): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const [ia, ib, ic] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const u = [0, 1, 2].map((k) => positions[ib + k]! - positions[ia + k]!);
    const v = [0, 1, 2].map((k) => positions[ic + k]! - positions[ia + k]!);
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    for (const i of [ia, ib, ic]) for (let k = 0; k < 3; k++) normals[i + k]! += n[k]!;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(normals[i]! ** 2 + normals[i + 1]! ** 2 + normals[i + 2]! ** 2) || 1;
    for (let k = 0; k < 3; k++) normals[i + k] = normals[i + k]! / len;
  }
  return normals;
}

// ---------------------------------------------------------------- glTF document

interface Entity {
  nodeId: string;
  kind: "model" | "segment";
  mrmlId: string;
  segmentId?: string;
  name: string;
  color: [number, number, number];
  opacity: number;
  visible: boolean;
  /** T.matrix in glTF space; omitted from the file when identity (the validator flags default matrices). */
  matrix?: number[];
  mesh: Mesh;
  /** POSITION as SHORT with the dequantisation transform in M.matrix (§7.2, KHR_mesh_quantization). */
  quantize?: boolean;
  /** Write `{"role":"mesh"}` on M (allowed by §7.2) instead of no extras. */
  meshRoleExtras?: boolean;
}

interface Json {
  [key: string]: unknown;
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: Record<string, number>[];
  accessors: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  meshes: Record<string, unknown>[];
  nodes: Record<string, unknown>[];
  scenes: { nodes: number[]; name?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

class Bin {
  private parts: Uint8Array[] = [];
  length = 0;
  /** Appends `bytes` at a 4-byte aligned offset (zero padding, glTF §4) and returns that offset. */
  push(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return offset;
  }
  bytes(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m: number[] | undefined): boolean =>
  m === undefined || m.every((v, i) => v === IDENTITY[i]);

const minMax = (values: ArrayLike<number>, stride: number): { min: number[]; max: number[] } => {
  const min = Array<number>(stride).fill(Infinity);
  const max = Array<number>(stride).fill(-Infinity);
  for (let i = 0; i < values.length; i++) {
    const k = i % stride;
    min[k] = Math.min(min[k]!, values[i]!);
    max[k] = Math.max(max[k]!, values[i]!);
  }
  return { min, max };
};

function buildDocument(
  entities: Entity[],
  sceneVersion = 1,
  anonymizedNames = false,
): { json: Json; bin: Uint8Array } {
  const bin = new Bin();
  const json: Json = {
    asset: { version: "2.0", generator: GENERATOR },
    scene: 0,
    scenes: [{ name: "SlicerRemoteView", nodes: [0] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const quantized = entities.some((e) => e.quantize);
  if (quantized) {
    json.extensionsUsed = [QUANTIZATION];
    json.extensionsRequired = [QUANTIZATION];
  }
  json.nodes.push({
    name: "SlicerRemoteView",
    children: entities.map((_, i) => 1 + i * 2),
    extras: {
      nodeId: "root",
      kind: "root",
      sceneVersion,
      profile: "mobile",
      source: { app: "SlicerRemoteView fixtures", version: VERSION },
      units: "m",
      upAxis: "+Y",
      rasToGltf: "x=R*0.001, y=S*0.001, z=-A*0.001",
      anonymizedNames,
    },
  });
  const addView = (bytes: Uint8Array, extra: Record<string, number>): number => {
    const byteOffset = bin.push(bytes);
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...extra });
    return json.bufferViews.length - 1;
  };
  const addAccessor = (accessor: Record<string, unknown>): number => {
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  };

  for (const e of entities) {
    const vertexCount = e.mesh.positions.length / 3;
    const triangleCount = e.mesh.indices.length / 3;
    let positionAccessor: number;
    let dequantise: number[] | undefined;
    if (e.quantize) {
      const { min, max } = minMax(e.mesh.positions, 3);
      const extent = Math.max(...[0, 1, 2].map((k) => max[k]! - min[k]!));
      const scale = extent / 32767;
      const q = new Int16Array(vertexCount * 4); // xyz + 2 padding bytes → 8-byte stride (4-byte aligned)
      for (let i = 0; i < vertexCount; i++)
        for (let k = 0; k < 3; k++)
          q[i * 4 + k] = Math.round((e.mesh.positions[i * 3 + k]! - min[k]!) / scale);
      const qxyz: number[] = [];
      for (let i = 0; i < vertexCount; i++) qxyz.push(q[i * 4]!, q[i * 4 + 1]!, q[i * 4 + 2]!);
      const mm = minMax(qxyz, 3);
      positionAccessor = addAccessor({
        bufferView: addView(new Uint8Array(q.buffer), { byteStride: 8, target: 34962 }),
        componentType: 5122,
        count: vertexCount,
        type: "VEC3",
        min: mm.min,
        max: mm.max,
      });
      dequantise = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, min[0]!, min[1]!, min[2]!, 1];
    } else {
      const f = new Float32Array(e.mesh.positions);
      const { min, max } = minMax(f, 3);
      positionAccessor = addAccessor({
        bufferView: addView(new Uint8Array(f.buffer), { target: 34962 }),
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min,
        max,
      });
    }
    const normals = new Float32Array(smoothNormals(e.mesh));
    const normalAccessor = addAccessor({
      bufferView: addView(new Uint8Array(normals.buffer), { target: 34962 }),
      componentType: 5126,
      count: vertexCount,
      type: "VEC3",
    });
    const wide = vertexCount > 65535;
    const idx = wide ? new Uint32Array(e.mesh.indices) : new Uint16Array(e.mesh.indices);
    const indexAccessor = addAccessor({
      bufferView: addView(new Uint8Array(idx.buffer), { target: 34963 }),
      componentType: wide ? 5125 : 5123,
      count: e.mesh.indices.length,
      type: "SCALAR",
    });
    json.materials.push({
      name: e.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...e.color, e.opacity],
        metallicFactor: 0,
        roughnessFactor: 0.6,
      },
      alphaMode: e.opacity < 1 ? "BLEND" : "OPAQUE",
      doubleSided: false,
    });
    json.meshes.push({
      name: e.name,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
          indices: indexAccessor,
          material: json.materials.length - 1,
          mode: 4,
        },
      ],
    });
    const tIndex = json.nodes.length;
    json.nodes.push({
      name: e.name,
      children: [tIndex + 1],
      ...(isIdentity(e.matrix) ? {} : { matrix: e.matrix }),
      extras: {
        nodeId: e.nodeId,
        kind: e.kind,
        mrmlId: e.mrmlId,
        ...(e.segmentId ? { segmentId: e.segmentId } : {}),
        name: e.name,
        color: e.color,
        opacity: e.opacity,
        visible: e.visible,
        triangleCount,
        baked: false,
      },
    });
    json.nodes.push({
      name: `${e.name} mesh`,
      mesh: json.meshes.length - 1,
      ...(dequantise ? { matrix: dequantise } : {}),
      ...(e.meshRoleExtras ? { extras: { role: "mesh" } } : {}),
    });
  }
  const bytes = bin.bytes();
  json.buffers.push({ byteLength: bytes.byteLength });
  return { json, bin: bytes };
}

/** glTF 2.0 binary container: 12-byte header, JSON chunk padded with spaces, BIN chunk padded with zeros. */
function packGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const binLength = Math.ceil(bin.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // BIN\0
  out.set(bin, binStart + 8);
  return out;
}

// ---------------------------------------------------------------- fixtures

const liver: Entity = {
  nodeId: "vtkMRMLSegmentationNode1/Segment_1",
  kind: "segment",
  mrmlId: "vtkMRMLSegmentationNode1",
  segmentId: "Segment_1",
  name: "Liver",
  color: [0.8, 0.33, 0.27],
  opacity: 1,
  visible: true,
  mesh: asymmetricTetrahedron(),
};
const tumor: Entity = {
  nodeId: "vtkMRMLModelNode2",
  kind: "model",
  mrmlId: "vtkMRMLModelNode2",
  name: "Tumor",
  color: [0.95, 0.85, 0.7],
  opacity: 0.35,
  visible: true,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.02, 0.01, -0.03, 1],
  mesh: sphere(1, 0.01),
};
const quantizedVessel: Entity = {
  nodeId: "vtkMRMLModelNode3",
  kind: "model",
  mrmlId: "vtkMRMLModelNode3",
  name: "Vessel",
  color: [0.9, 0.2, 0.2],
  opacity: 1,
  visible: true,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.05, -0.02, 0.01, 1],
  mesh: sphere(2, 0.03),
  quantize: true,
  meshRoleExtras: true,
};
const synthetic = (i: number, levels: number, radius: number): Entity => ({
  nodeId: `vtkMRMLModelNode${10 + i}`,
  kind: "model",
  mrmlId: `vtkMRMLModelNode${10 + i}`,
  name: `Synthetic ${i + 1}`,
  color: [0.2 + 0.2 * i, 0.5, 0.9 - 0.2 * i],
  opacity: i === 1 ? 0.5 : 1,
  visible: i !== 2,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1 * i, 0, 0, 1],
  mesh: sphere(levels, radius),
});

/** §7.3 segment aliases (protocol 1.1, PRO-23): Slicer keeps caller-supplied segment IDs, the nodeId must stay in §3.3. */
const aliasedLeftLung: Entity = {
  nodeId: "vtkMRMLSegmentationNode1/s_1",
  kind: "segment",
  mrmlId: "vtkMRMLSegmentationNode1",
  segmentId: "left lung", // outside [A-Za-z0-9_./:-]: carried in extras only, the nodeId is the alias
  name: "Left lung",
  color: [0.4, 0.6, 0.9],
  opacity: 1,
  visible: true,
  mesh: asymmetricTetrahedron(),
};
const plainSpleen: Entity = {
  nodeId: "vtkMRMLSegmentationNode1/Segment_2", // a conforming ID keeps the verbatim nodeId
  kind: "segment",
  mrmlId: "vtkMRMLSegmentationNode1",
  segmentId: "Segment_2",
  name: "Spleen",
  color: [0.7, 0.3, 0.3],
  opacity: 0.6,
  visible: true,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.03, 0, 0, 1],
  mesh: sphere(1, 0.012),
};
/** `anonymizedNames: true`: no name-derived string anywhere, so every segment is aliased and has no `segmentId`. */
const anonymousSegment = (n: number, mesh: Mesh): Entity => ({
  nodeId: `vtkMRMLSegmentationNode1/s_${n}`,
  kind: "segment",
  mrmlId: "vtkMRMLSegmentationNode1",
  name: `Segment ${n}`,
  color: [0.3 + 0.1 * n, 0.5, 0.7],
  opacity: 1,
  visible: true,
  mesh,
});
const anonymousModel: Entity = {
  nodeId: "vtkMRMLModelNode4",
  kind: "model",
  mrmlId: "vtkMRMLModelNode4",
  name: "Model 3",
  color: [0.9, 0.8, 0.2],
  opacity: 1,
  visible: true,
  mesh: sphere(1, 0.008),
};

interface ManifestEntry {
  valid: boolean;
  /** Present (true) only for files whose root says `anonymizedNames: true`. */
  anonymizedNames?: boolean;
  byteLength: number;
  sha256: string;
  nodeIds: string[];
  nodeCount: number;
  triangleCount: number;
  extensionsRequired: string[];
  $comment: string;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: Record<string, ManifestEntry> = {};
  const describe = (
    entities: Entity[],
    valid: boolean,
    comment: string,
  ): Omit<ManifestEntry, "byteLength" | "sha256"> => ({
    valid,
    nodeIds: entities.map((e) => e.nodeId),
    nodeCount: entities.length,
    triangleCount: entities.reduce((n, e) => n + e.mesh.indices.length / 3, 0),
    extensionsRequired: entities.some((e) => e.quantize) ? [QUANTIZATION] : [],
    $comment: comment,
  });
  const emit = (
    file: string,
    bytes: Uint8Array,
    entry: Omit<ManifestEntry, "byteLength" | "sha256">,
  ): void => {
    writeFileSync(resolve(OUT_DIR, file), bytes);
    const { valid, ...rest } = entry;
    manifest[file] = {
      valid,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...rest,
    };
  };

  const asymmetric = buildDocument([liver, tumor]);
  const asymmetricGlb = packGlb(asymmetric.json, asymmetric.bin);
  emit(
    "asymmetric-2nodes.glb",
    asymmetricGlb,
    describe(
      [liver, tumor],
      true,
      "§7 reference: one segment (opaque tetrahedron with vertices at glTF (+0.1,0,0) and (0,0,-0.1)) and one translucent model with a T.matrix translation",
    ),
  );
  const quantized = buildDocument([quantizedVessel]);
  emit(
    "quantized-1node.glb",
    packGlb(quantized.json, quantized.bin),
    describe(
      [quantizedVessel],
      true,
      "KHR_mesh_quantization: POSITION as SHORT (stride 8), dequantisation scale/offset in M.matrix, M.extras {role: mesh}",
    ),
  );
  const big = [
    synthetic(0, 7, 0.08),
    synthetic(1, 6, 0.05),
    synthetic(2, 6, 0.04),
    synthetic(3, 6, 0.03),
  ];
  const large = buildDocument(big);
  emit(
    "large-synthetic.glb",
    packGlb(large.json, large.bin),
    describe(
      big,
      true,
      "≈ 5 MiB procedural load-test file: four spheres, the first with > 65,535 vertices (UNSIGNED_INT indices), one translucent, one hidden",
    ),
  );

  const aliased = buildDocument([aliasedLeftLung, plainSpleen]);
  emit(
    "aliased-segments.glb",
    packGlb(aliased.json, aliased.bin),
    describe(
      [aliasedLeftLung, plainSpleen],
      true,
      "§7.3 segment alias: raw segment ID `left lung` is outside the nodeId grammar, so nodeId is vtkMRMLSegmentationNode1/s_1 and extras.segmentId keeps the raw ID; a second segment with a conforming ID keeps its verbatim nodeId",
    ),
  );
  const anonymousEntities = [
    anonymousSegment(1, asymmetricTetrahedron()),
    anonymousSegment(2, sphere(1, 0.01)),
    anonymousModel,
  ];
  const anonymous = buildDocument(anonymousEntities, 1, true);
  emit("anonymized-segments.glb", packGlb(anonymous.json, anonymous.bin), {
    ...describe(
      anonymousEntities,
      true,
      "anonymizedNames: true (§7.3): every segment nodeId is an alias s_<n>, no extras.segmentId, names are Segment <n> / Model <n>",
    ),
    anonymizedNames: true,
  });

  const broken = (comment: string) =>
    describe([], false, `${comment} (derived from asymmetric-2nodes.glb)`);
  const badMagic = new Uint8Array(asymmetricGlb);
  badMagic.set([0x67, 0x6c, 0x54, 0x58], 0); // glTX
  emit("bad-magic.glb", badMagic, broken("GLB magic is glTX instead of glTF"));
  emit(
    "truncated.glb",
    asymmetricGlb.subarray(0, Math.floor(asymmetricGlb.byteLength / 2)),
    broken("asymmetric-2nodes.glb cut in half: header length no longer matches the file"),
  );
  const external = structuredClone(asymmetric.json);
  external.buffers[0]!.uri = "asymmetric-2nodes.bin";
  emit(
    "external-uri.glb",
    packGlb(external, asymmetric.bin),
    broken("buffer 0 carries a uri: §7.1 forbids external resources"),
  );
  const twoScenes = structuredClone(asymmetric.json);
  twoScenes.scenes.push({ name: "Second", nodes: [1] });
  emit(
    "two-scenes.glb",
    packGlb(twoScenes, asymmetric.bin),
    broken("two scenes: §7.1 demands exactly one"),
  );
  const noExtras = structuredClone(asymmetric.json);
  delete noExtras.nodes[0]!.extras;
  emit(
    "no-root-extras.glb",
    packGlb(noExtras, asymmetric.bin),
    broken("root node without the §7.1 extras (nodeId root, units, upAxis, …)"),
  );

  writeFileSync(
    resolve(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        $comment:
          "Generated by shared/scripts/make-glb-fixtures.ts (PRO-08); do not edit. byteLength/sha256 feed the scene.snapshot.begin fixtures and fake-slicer; broken files are for §7.1 pre-validators.",
        generator: GENERATOR,
        files: manifest,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${Object.keys(manifest).length} files to ${OUT_DIR}`);
}

main();
