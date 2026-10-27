import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBytes } from "gltf-validator";
import { afterAll, describe, expect, it } from "vitest";
import { chunkCountFor, sha256Hex } from "../ts/index.js";
import { loadFixtures, readJson } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const GLB_DIR = resolve(here, "../fixtures/glb");
const SCRIPT = resolve(here, "../scripts/make-glb-fixtures.ts");
const ALLOWED_EXTENSIONS = ["KHR_mesh_quantization"];

interface ManifestEntry {
  valid: boolean;
  anonymizedNames?: boolean;
  byteLength: number;
  sha256: string;
  nodeIds: string[];
  nodeCount: number;
  triangleCount: number;
  extensionsRequired: string[];
}
interface Manifest {
  generator: string;
  files: Record<string, ManifestEntry>;
}
interface Gltf {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    children?: number[];
    mesh?: number;
    matrix?: number[];
    extras?: Record<string, unknown>;
  }[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }[];
  }[];
  materials?: {
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      metallicFactor?: number;
      roughnessFactor?: number;
    };
    alphaMode?: string;
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

const manifest = readJson<Manifest>(resolve(GLB_DIR, "manifest.json"));
const bytes = (file: string) => new Uint8Array(readFileSync(resolve(GLB_DIR, file)));
const validFiles = Object.entries(manifest.files).filter(([, e]) => e.valid);
const brokenFiles = Object.entries(manifest.files).filter(([, e]) => !e.valid);

/** glTF 2.0 binary container reader (header + JSON chunk + optional BIN chunk). Throws on a malformed container. */
function parseGlb(glb: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20) throw new Error("shorter than the GLB header");
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("bad magic");
  if (view.getUint32(4, true) !== 2) throw new Error("not glTF 2.0");
  if (view.getUint32(8, true) !== glb.byteLength) throw new Error("length mismatch");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("first chunk is not JSON");
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf;
  const binStart = 20 + jsonLength;
  let bin: Uint8Array = new Uint8Array(0);
  if (binStart < glb.byteLength) {
    const binLength = view.getUint32(binStart, true);
    if (view.getUint32(binStart + 4, true) !== 0x004e4942)
      throw new Error("second chunk is not BIN");
    bin = glb.subarray(binStart + 8, binStart + 8 + binLength);
  }
  return { json, bin };
}

/** The §7.1 pre-validation every viewer runs before handing the GLB to its loader; returns the broken rules. */
function snapshotRuleViolations(glb: Uint8Array): string[] {
  let doc: { json: Gltf; bin: Uint8Array };
  try {
    doc = parseGlb(glb);
  } catch (e) {
    return [`container: ${(e as Error).message}`];
  }
  const { json } = doc;
  const out: string[] = [];
  if ((json.scenes ?? []).length !== 1) out.push("exactly one scene");
  if ((json.buffers ?? []).length !== 1) out.push("exactly one buffer");
  if (json.buffers?.some((b) => b.uri !== undefined)) out.push("no uri");
  for (const key of ["images", "textures", "samplers", "animations", "skins", "cameras"])
    if (Array.isArray(json[key]) && (json[key] as unknown[]).length) out.push(`no ${key}`);
  if ((json.extensionsRequired ?? []).some((x) => !ALLOWED_EXTENSIONS.includes(x)))
    out.push("extensionsRequired ⊆ {KHR_mesh_quantization}");
  const roots = json.scenes?.[0]?.nodes ?? [];
  const root = roots.length === 1 ? json.nodes?.[roots[0]!] : undefined;
  if (!root || root.name !== "SlicerRemoteView" || root.extras?.nodeId !== "root")
    out.push("single root node SlicerRemoteView with extras.nodeId root");
  return out;
}

/** Float32 or dequantised SHORT POSITION values of accessor `index`, as [x, y, z] triples. */
function positions(
  doc: { json: Gltf; bin: Uint8Array },
  index: number,
  matrix?: number[],
): number[][] {
  const acc = doc.json.accessors![index]!;
  const bv = doc.json.bufferViews![acc.bufferView!]!;
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const view = new DataView(doc.bin.buffer, doc.bin.byteOffset + start);
  const out: number[][] = [];
  for (let i = 0; i < acc.count; i++) {
    let p: number[];
    if (acc.componentType === 5126) {
      const stride = bv.byteStride ?? 12;
      p = [0, 1, 2].map((k) => view.getFloat32(i * stride + k * 4, true));
    } else if (acc.componentType === 5122) {
      const stride = bv.byteStride ?? 6;
      p = [0, 1, 2].map((k) => view.getInt16(i * stride + k * 2, true));
    } else throw new Error(`unexpected componentType ${acc.componentType}`);
    if (matrix)
      p = [0, 1, 2].map(
        (k) =>
          p[0]! * matrix[k]! + p[1]! * matrix[4 + k]! + p[2]! * matrix[8 + k]! + matrix[12 + k]!,
      );
    out.push(p);
  }
  return out;
}
const near = (a: number[], b: number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= eps);

describe("GLB fixtures (PRO-08, §7)", () => {
  it("manifest.json lists every file in fixtures/glb with matching byteLength and sha256", async () => {
    const onDisk = readdirSync(GLB_DIR)
      .filter((f) => f.endsWith(".glb"))
      .sort();
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
    expect(validFiles.map(([f]) => f).sort()).toEqual(
      [
        "asymmetric-2nodes.glb",
        "quantized-1node.glb",
        "large-synthetic.glb",
        "aliased-segments.glb",
        "anonymized-segments.glb",
      ].sort(),
    );
    expect(brokenFiles.map(([f]) => f).sort()).toEqual(
      [
        "bad-magic.glb",
        "truncated.glb",
        "external-uri.glb",
        "two-scenes.glb",
        "no-root-extras.glb",
      ].sort(),
    );
    for (const [file, entry] of Object.entries(manifest.files)) {
      const data = bytes(file);
      expect(data.byteLength, file).toBe(entry.byteLength);
      expect(await sha256Hex(data), file).toBe(entry.sha256);
    }
    const large = manifest.files["large-synthetic.glb"]!;
    expect(large.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(large.byteLength).toBeLessThan(6 * 1024 * 1024);
  });

  it("valid fixtures pass gltf-validator with zero errors (§7, ADR 0005)", async () => {
    for (const [file] of validFiles) {
      const report = await validateBytes(bytes(file), { writeTimestamp: false });
      const text = report.issues.messages
        .map((m) => `${m.code} ${m.pointer ?? ""} ${m.message}`)
        .join("\n");
      expect(report.issues.numErrors, `${file}:\n${text}`).toBe(0);
      expect(report.issues.numWarnings, `${file}:\n${text}`).toBe(0);
    }
  }, 60_000);

  it("valid fixtures obey the §7.1 container rules and the §7.2–7.4 node/material rules; nodeIds match the manifest", () => {
    for (const [file, entry] of validFiles) {
      expect(snapshotRuleViolations(bytes(file)), file).toEqual([]);
      const doc = parseGlb(bytes(file));
      const { json } = doc;
      expect(json.asset.generator, "§7.1: SlicerRemoteView <version>").toMatch(
        /^SlicerRemoteView \S+$/,
      );
      expect(json.extensionsRequired ?? []).toEqual(entry.extensionsRequired);
      expect(json.extensionsUsed ?? []).toEqual(entry.extensionsRequired);
      const root = json.nodes![json.scenes![0]!.nodes![0]!]!;
      expect(root.extras).toMatchObject({
        nodeId: "root",
        kind: "root",
        sceneVersion: expect.any(Number),
        profile: "mobile",
        units: "m",
        upAxis: "+Y",
        rasToGltf: "x=R*0.001, y=S*0.001, z=-A*0.001",
        anonymizedNames: entry.anonymizedNames ?? false,
      });
      const nodeIds: string[] = [];
      let triangles = 0;
      for (const tIndex of root.children ?? []) {
        const t = json.nodes![tIndex]!;
        expect(t.mesh, `${file}: T node ${t.name} has no mesh of its own`).toBeUndefined();
        expect(t.children, `${file}: T has exactly one child`).toHaveLength(1);
        expect(t.extras).toMatchObject({
          nodeId: expect.stringMatching(/^[A-Za-z0-9_./:-]{1,128}$/),
          kind: expect.stringMatching(/^(model|segment)$/),
          mrmlId: expect.any(String),
          name: t.name,
          color: [expect.any(Number), expect.any(Number), expect.any(Number)],
          opacity: expect.any(Number),
          visible: expect.any(Boolean),
          triangleCount: expect.any(Number),
          baked: false,
        });
        if (t.extras!.kind === "segment") {
          // §7.3: the raw segment ID is carried in extras, except under anonymizedNames (it may be name-derived)
          if (entry.anonymizedNames) expect(t.extras!.segmentId, file).toBeUndefined();
          else expect(t.extras!.segmentId).toEqual(expect.any(String));
        }
        nodeIds.push(t.extras!.nodeId as string);
        const m = json.nodes![t.children![0]!]!;
        expect(m.children ?? []).toHaveLength(0);
        expect(m.extras === undefined || JSON.stringify(m.extras) === '{"role":"mesh"}').toBe(true);
        const mesh = json.meshes![m.mesh!]!;
        expect(mesh.primitives).toHaveLength(1);
        const prim = mesh.primitives[0]!;
        expect(prim.mode ?? 4).toBe(4);
        expect(prim.attributes.NORMAL, "NORMAL is required (§7.4)").toBeDefined();
        const indexType = json.accessors![prim.indices!]!.componentType;
        expect([5123, 5125], "UNSIGNED_SHORT or UNSIGNED_INT").toContain(indexType);
        triangles += json.accessors![prim.indices!]!.count / 3;
        expect(json.accessors![prim.indices!]!.count / 3).toBe(t.extras!.triangleCount);
        const mat = json.materials![prim.material!]!;
        const [r, g, b, a] = mat.pbrMetallicRoughness!.baseColorFactor!;
        expect([r, g, b]).toEqual(t.extras!.color);
        expect(a).toBe(t.extras!.opacity);
        expect(mat.pbrMetallicRoughness!.metallicFactor).toBe(0);
        expect(mat.pbrMetallicRoughness!.roughnessFactor).toBeGreaterThanOrEqual(0.4);
        expect(mat.pbrMetallicRoughness!.roughnessFactor).toBeLessThanOrEqual(0.9);
        expect(mat.alphaMode).toBe(a! < 1 ? "BLEND" : "OPAQUE");
        const pos = json.accessors![prim.attributes.POSITION!]!;
        if (pos.componentType === 5122) {
          expect(json.extensionsRequired).toContain("KHR_mesh_quantization");
          expect(pos.normalized ?? false).toBe(false);
          expect(json.bufferViews![pos.bufferView!]!.byteStride! % 4).toBe(0);
          expect(m.matrix, "M.matrix carries the dequantisation").toHaveLength(16);
        } else {
          expect(pos.componentType).toBe(5126);
          expect(m.matrix, "M.matrix identity when not quantized").toBeUndefined();
        }
      }
      expect(nodeIds, file).toEqual(entry.nodeIds);
      expect(root.children, file).toHaveLength(entry.nodeCount);
      expect(triangles, file).toBe(entry.triangleCount);
    }
  });

  it("asymmetric-2nodes.glb has a vertex at glTF (+0.1, 0, 0) and one at (0, 0, -0.1); one node is translucent", () => {
    const doc = parseGlb(bytes("asymmetric-2nodes.glb"));
    const tIndex = doc.json.nodes![0]!.children![0]!;
    const m = doc.json.nodes![doc.json.nodes![tIndex]!.children![0]!]!;
    const pts = positions(doc, doc.json.meshes![m.mesh!]!.primitives[0]!.attributes.POSITION!);
    expect(pts.some((p) => near(p, [0.1, 0, 0]))).toBe(true);
    expect(pts.some((p) => near(p, [0, 0, -0.1]))).toBe(true);
    expect(
      pts.some((p) => near(p, [-0.1, 0, 0])),
      "no mirrored twin",
    ).toBe(false);
    expect(
      pts.some((p) => near(p, [0, 0, 0.1])),
      "no mirrored twin",
    ).toBe(false);
    const opacities = doc.json.materials!.map(
      (mat) => mat.pbrMetallicRoughness!.baseColorFactor![3],
    );
    expect(opacities.filter((o) => o! < 1)).toHaveLength(1);
    const kinds = doc.json
      .nodes!.map((n) => n.extras?.kind)
      .filter((k) => k === "model" || k === "segment");
    expect(kinds.sort()).toEqual(["model", "segment"]);
  });

  it("quantized-1node.glb dequantises through M.matrix to the same shape within one quantum", () => {
    const doc = parseGlb(bytes("quantized-1node.glb"));
    const t = doc.json.nodes![doc.json.nodes![0]!.children![0]!]!;
    const m = doc.json.nodes![t.children![0]!]!;
    const prim = doc.json.meshes![m.mesh!]!.primitives[0]!;
    const pts = positions(doc, prim.attributes.POSITION!, m.matrix);
    // The source is a sphere of radius 0.03 m around the origin (before T.matrix); quantum = 0.06 / 32767.
    const radii = pts.map((p) => Math.hypot(p[0]!, p[1]!, p[2]!));
    for (const r of radii) expect(Math.abs(r - 0.03)).toBeLessThan(0.06 / 32767 + 1e-9);
    const acc = doc.json.accessors![prim.attributes.POSITION!]!;
    expect(acc.componentType).toBe(5122);
  });

  it("broken fixtures each fail the §7.1 pre-validation (and the validator, except the extras rule it cannot know)", async () => {
    for (const [file] of brokenFiles) {
      expect(snapshotRuleViolations(bytes(file)), file).not.toEqual([]);
    }
    expect(snapshotRuleViolations(bytes("external-uri.glb"))).toContain("no uri");
    expect(snapshotRuleViolations(bytes("two-scenes.glb"))).toContain("exactly one scene");
    expect(snapshotRuleViolations(bytes("no-root-extras.glb"))).toEqual([
      "single root node SlicerRemoteView with extras.nodeId root",
    ]);
    for (const [file] of brokenFiles.filter(([f]) => f !== "no-root-extras.glb")) {
      const report = await validateBytes(bytes(file), { writeTimestamp: false, maxIssues: 5 });
      expect(report.issues.numErrors, file).toBeGreaterThan(0);
    }
  }, 30_000);

  it("segment aliases (§7.3, protocol 1.1): non-conforming IDs and anonymised scenes get s_<n>, no raw ID leaks", () => {
    const nodeIdsOf = (file: string) =>
      parseGlb(bytes(file))
        .json.nodes!.map((n) => n.extras?.["nodeId"] as string | undefined)
        .filter((id): id is string => id !== undefined && id !== "root");
    const aliased = parseGlb(bytes("aliased-segments.glb")).json;
    const byId = new Map(
      aliased
        .nodes!.filter((n) => n.extras?.["kind"] === "segment")
        .map((n) => [n.extras!["nodeId"], n.extras!]),
    );
    // the raw ID `left lung` is outside [A-Za-z0-9_./:-]: aliased nodeId, raw ID kept in extras
    expect(byId.get("vtkMRMLSegmentationNode1/s_1")).toMatchObject({ segmentId: "left lung" });
    // a conforming ID keeps the verbatim nodeId
    expect(byId.get("vtkMRMLSegmentationNode1/Segment_2")).toMatchObject({
      segmentId: "Segment_2",
    });
    expect(manifest.files["aliased-segments.glb"]!.anonymizedNames).toBeUndefined();

    // anonymised: every segment is aliased, no segmentId, and no raw ID or real name appears anywhere
    const entry = manifest.files["anonymized-segments.glb"]!;
    expect(entry.anonymizedNames).toBe(true);
    const doc = parseGlb(bytes("anonymized-segments.glb"));
    const text = JSON.stringify(doc.json);
    expect(text).not.toMatch(/segmentId|left lung|Left lung|Spleen|Segment_/);
    const segments = doc.json.nodes!.filter((n) => n.extras?.["kind"] === "segment");
    expect(segments.map((n) => n.extras!["nodeId"])).toEqual([
      "vtkMRMLSegmentationNode1/s_1",
      "vtkMRMLSegmentationNode1/s_2",
    ]);
    expect(segments.map((n) => n.extras!["name"])).toEqual(["Segment 1", "Segment 2"]);
    for (const file of ["aliased-segments.glb", "anonymized-segments.glb"])
      for (const id of nodeIdsOf(file)) expect(id, file).toMatch(/^[A-Za-z0-9_./:-]{1,128}$/);
  });

  it("the scene.snapshot.begin fixtures derived from the manifest carry its byteLength, sha256 and chunkCount", () => {
    const begins = loadFixtures("scene.snapshot.begin")[0]!.valid;
    const derived = begins.filter(
      (v) => manifest.files[`${v.file.slice("valid-".length, -".json".length)}.glb`],
    );
    expect(derived.map((v) => v.file).sort()).toEqual(
      [
        "valid-aliased-segments.json",
        "valid-anonymized-segments.json",
        "valid-asymmetric-2nodes.json",
        "valid-quantized-1node.json",
        "valid-large-synthetic.json",
      ].sort(),
    );
    for (const { file, message } of derived) {
      const entry = manifest.files[`${file.slice("valid-".length, -".json".length)}.glb`]!;
      const m = message as {
        byteLength: number;
        sha256: string;
        chunkCount: number;
        chunkSize: number;
        extensionsUsed: string[];
        extensionsRequired?: string[];
        nodeCount?: number;
        triangleCount?: number;
      };
      expect(m.byteLength, file).toBe(entry.byteLength);
      expect(m.sha256, file).toBe(entry.sha256);
      expect(m.chunkCount, file).toBe(chunkCountFor(entry.byteLength, m.chunkSize));
      expect(m.extensionsUsed, file).toEqual(entry.extensionsRequired);
      expect(m.extensionsRequired ?? [], file).toEqual(entry.extensionsRequired);
      expect(m.nodeCount, file).toBe(entry.nodeCount);
      expect(m.triangleCount, file).toBe(entry.triangleCount);
    }
  });

  describe("regeneration", () => {
    const out = mkdtempSync(resolve(tmpdir(), "srv-glb-"));
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    it("make-glb-fixtures.ts is deterministic: a fresh run reproduces the committed bytes and manifest", () => {
      execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT, out], {
        stdio: "pipe",
      });
      for (const file of [...Object.keys(manifest.files), "manifest.json"]) {
        const fresh = readFileSync(resolve(out, file));
        expect(fresh.equals(readFileSync(resolve(GLB_DIR, file))), file).toBe(true);
      }
    }, 60_000);
  });
});
