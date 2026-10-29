// GLB snapshots built for the viewer specs from the shared fixtures (the fixtures themselves stay as generated).

import { fixture } from "./fake-relay";

type Json = Record<string, unknown>;

/** asymmetric-2nodes.glb plus `extra` copies of its Liver ("Structure 1" …), each with its own mesh, accessors,
 * material and geometry bytes, as §7.2 and the pre-validator require: a scene with a long node list. */
export function withExtraNodes(extra: number): Buffer {
  const glb = fixture("asymmetric-2nodes.glb");
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as Record<
    string,
    Json[]
  >;
  const binStart = 20 + jsonLength + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength));
  const [liverMesh] = json["meshes"]!;
  const primitive = (liverMesh!["primitives"] as Json[])[0]!;
  const attributes = primitive["attributes"] as Record<string, number>;
  const liverAccessors = [
    attributes["POSITION"]!,
    attributes["NORMAL"]!,
    primitive["indices"] as number,
  ];
  const liverViews = liverAccessors.map(
    (a) => json["bufferViews"]![json["accessors"]![a]!["bufferView"] as number]!,
  );
  const root = json["nodes"]![0]!;
  const chunks: Buffer[] = [bin];
  let offset = bin.byteLength; // a multiple of 4, like every view length below
  for (let i = 0; i < extra; i++) {
    const accessors = liverAccessors.map((a, k) => {
      const view = liverViews[k]!;
      const start = view["byteOffset"] as number;
      const length = view["byteLength"] as number;
      chunks.push(bin.subarray(start, start + length));
      json["bufferViews"]!.push({ ...view, byteOffset: offset });
      offset += length;
      json["accessors"]!.push({
        ...json["accessors"]![a],
        bufferView: json["bufferViews"]!.length - 1,
      });
      return json["accessors"]!.length - 1;
    });
    const material = json["materials"]![0]!;
    json["materials"]!.push({
      ...material,
      name: `Structure ${i + 1}`,
      // the manifest colour below duplicates the material colour (§7.3)
      pbrMetallicRoughness: {
        ...(material["pbrMetallicRoughness"] as Json),
        baseColorFactor: [0.4, 0.6, 0.9, 1],
      },
    });
    json["meshes"]!.push({
      name: `Structure ${i + 1}`,
      primitives: [
        {
          ...primitive,
          attributes: { POSITION: accessors[0], NORMAL: accessors[1] },
          indices: accessors[2],
          material: json["materials"]!.length - 1,
        },
      ],
    });
    json["nodes"]!.push({ name: `Structure ${i + 1} mesh`, mesh: json["meshes"]!.length - 1 });
    const nodeId = `vtkMRMLModelNode${100 + i}`;
    json["nodes"]!.push({
      name: `Structure ${i + 1}`,
      children: [json["nodes"]!.length - 1],
      extras: {
        nodeId,
        kind: "model",
        name: `Structure ${i + 1}`,
        color: [0.4, 0.6, 0.9],
        opacity: 1,
        visible: true,
      },
    });
    (root["children"] as number[]).push(json["nodes"]!.length - 1);
  }
  json["buffers"]![0]!["byteLength"] = offset;
  return encode(json, Buffer.concat(chunks));
}

/** `glb` with the glTF node of `nodeId` (its `T`, §7.2) changed by `edit`; the geometry bytes stay as they are. */
export function withNode(glb: Buffer, nodeId: string, edit: (node: Json) => void): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as { nodes: Json[] };
  const node = json.nodes.find((n) => (n["extras"] as Json | undefined)?.["nodeId"] === nodeId);
  if (!node) throw new Error(`no node ${nodeId}`);
  edit(node);
  const binStart = 20 + jsonLength + 8;
  return encode(json, glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength)));
}

/**
 * `glb` with the manifest entry (`T.extras`) of `nodeId` patched: the same scene as Slicer exports it again after a
 * change (WEB-25).
 */
export const withManifest = (glb: Buffer, nodeId: string, patch: Json): Buffer =>
  withNode(glb, nodeId, (node) => (node["extras"] = { ...(node["extras"] as Json), ...patch }));

/** A GLB of `json` (padded with spaces to 4 bytes) and the BIN chunk `bin`. */
function encode(json: object, bin: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.byteLength % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.byteLength + 8 + bin.byteLength, 8);
  const chunkHeader = (length: number, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.byteLength, 0x4e4f534a),
    jsonChunk,
    chunkHeader(bin.byteLength, 0x004e4942),
    bin,
  ]);
}
