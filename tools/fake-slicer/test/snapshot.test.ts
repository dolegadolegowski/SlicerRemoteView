import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkCountFor, CHUNK_HEADER_BYTES, parseEnvelope } from "@slicerremoteview/shared";
import { EXIT, FIXTURE_DIR, loadGlb, main, resolveFixture, startRelayStub } from "../src/index.js";
import type { Io, RelayStub } from "../src/index.js";
import { TestViewer } from "./viewer.js";

interface ManifestFile {
  valid: boolean;
  byteLength: number;
  sha256: string;
  nodeCount: number;
  triangleCount: number;
  extensionsRequired: string[];
}
const manifest = (
  JSON.parse(readFileSync(`${FIXTURE_DIR}manifest.json`, "utf8")) as {
    files: Record<string, ManifestFile>;
  }
).files;

let stub: RelayStub | undefined;
let viewer: TestViewer | undefined;
afterEach(async () => {
  viewer?.close();
  viewer = undefined;
  await stub?.close();
  stub = undefined;
});

/** Everything the CLI would write, plus the `--code-fd` pipe; the code resolves `code` as soon as it arrives. */
function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  let codeLine = "";
  const io: Io = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    writeFd: (_fd, text) => void (codeLine += text),
  };
  return { io, out, err, codeLine: () => codeLine };
}

/** Runs the CLI with a viewer that joined before the first frame left the stub. */
async function publishToViewer(argv: string[], stubOptions = {}) {
  stub = await startRelayStub({ holdFramesUntilViewers: 1, ...stubOptions });
  const { io, out, err, codeLine } = fakeIo();
  const running = main(["--relay", stub.url, "--code-fd", "3", ...argv], io);
  await vi.waitFor(() => expect(codeLine()).not.toBe(""), { timeout: 5000 });
  viewer = await TestViewer.join(stub.url, codeLine().split(" ")[0]!);
  return { running, out, err };
}

describe("snapshot playback (PRO-14)", () => {
  it("a viewer reassembles the fixture to the manifest hash (§6.1–6.4)", async () => {
    const { running } = await publishToViewer([
      "--fixture",
      "asymmetric-2nodes.glb",
      "--exit-after-ack",
    ]);
    expect(await running).toBe(EXIT.ok);
    const file = manifest["asymmetric-2nodes.glb"]!;
    const snapshot = await viewer!.snapshot(1);
    expect(snapshot.sha256).toBe(file.sha256);
    expect(snapshot.bytes.byteLength).toBe(file.byteLength);
    expect(
      Buffer.from(snapshot.bytes).equals(readFileSync(`${FIXTURE_DIR}asymmetric-2nodes.glb`)),
    ).toBe(true);
    const [begin] = viewer!.messages("scene.snapshot.begin");
    expect(begin).toMatchObject({
      sceneVersion: 1,
      chunkSize: 1_048_576,
      chunkCount: 1,
      format: "glb",
      extensionsUsed: [],
      nodeCount: file.nodeCount,
      triangleCount: file.triangleCount,
      profile: "mobile",
    });
    expect(viewer!.types().filter((t) => t.startsWith("scene.snapshot."))).toEqual([
      "scene.snapshot.begin",
      "scene.snapshot.end",
    ]);
  });

  it("every publisher text frame is schema-valid and ids are unique", async () => {
    const { running } = await publishToViewer(["--exit-after-ack"]);
    await running;
    const ids = new Set<string>();
    for (const frame of stub!.publisherFrames.filter((f) => !f.binary)) {
      const parsed = parseEnvelope(frame.data.toString());
      expect(parsed.ok, frame.data.toString()).toBe(true);
      const id = (JSON.parse(frame.data.toString()) as { id: string }).id;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it("--chunk-size 65536 sends ceil(byteLength / 65536) chunks, the last one shorter (§6.2)", async () => {
    const file = manifest["large-synthetic.glb"]!;
    const { running } = await publishToViewer([
      ...["--fixture", "large-synthetic.glb", "--chunk-size", "65536", "--exit-after-ack"],
    ]);
    expect(await running).toBe(EXIT.ok);
    const expectedChunks = Math.ceil(file.byteLength / 65536);
    expect(expectedChunks).toBe(76);
    const binary = stub!.publisherFrames.filter((f) => f.binary);
    expect(binary).toHaveLength(expectedChunks);
    const payloads = binary.map((f) => f.data.byteLength - CHUNK_HEADER_BYTES);
    expect(payloads.slice(0, -1).every((n) => n === 65536)).toBe(true);
    expect(payloads.at(-1)).toBe(file.byteLength - 75 * 65536);
    expect(payloads.at(-1)).toBeLessThan(65536);
    const snapshot = await viewer!.snapshot(1);
    expect(snapshot.chunks).toBe(chunkCountFor(file.byteLength, 65536));
    expect(snapshot.sha256).toBe(file.sha256);
  });

  it("announces extensionsUsed and extensionsRequired read from the GLB", async () => {
    const { running } = await publishToViewer([
      "--fixture",
      "quantized-1node.glb",
      "--exit-after-ack",
    ]);
    await running;
    const [begin] = viewer!.messages("scene.snapshot.begin");
    expect(begin).toMatchObject({
      extensionsUsed: ["KHR_mesh_quantization"],
      extensionsRequired: manifest["quantized-1node.glb"]!.extensionsRequired,
    });
  });

  it("stays connected after the ack unless --exit-after-ack is given", async () => {
    stub = await startRelayStub();
    const controller = new AbortController();
    const { io, err } = fakeIo();
    let done = false;
    const running = main(["--relay", stub.url], { ...io, signal: controller.signal }).then((c) => {
      done = true;
      return c;
    });
    await vi.waitFor(() => expect(err.join("")).toContain("snapshot 1 acknowledged"), {
      timeout: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    controller.abort();
    expect(await running).toBe(EXIT.ok);
  });

  it("exits 2 on a relay error and prints the error code, never the session code", async () => {
    stub = await startRelayStub({ autoAck: false });
    const { io, out, err, codeLine } = fakeIo();
    const running = main(["--relay", stub.url, "--code-fd", "3"], io);
    await vi.waitFor(() => expect(stub!.publisherFrames.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
    });
    stub.sendToPublisher({
      type: "error",
      code: "CHECKSUM_MISMATCH",
      message: "bad hash",
      retryable: true,
    });
    expect(await running).toBe(EXIT.relayError);
    expect(err.join("")).toContain("relay error: CHECKSUM_MISMATCH\n");
    const code = codeLine().split(" ")[0]!;
    expect(out.join("") + err.join("")).not.toContain(code);
  });

  it("without --code-fd neither stdout nor stderr contains a 5-symbol session code", async () => {
    stub = await startRelayStub();
    const { io, out, err } = fakeIo();
    expect(await main(["--relay", stub.url, "--exit-after-ack"], io)).toBe(EXIT.ok);
    const code = stub.code!;
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    const output = (out.join("") + err.join("")).replace(/\d+ bytes/g, "N bytes"); // byte counts are not codes
    expect(output).toContain("acknowledged");
    expect(output).not.toContain(code);
    expect(output).not.toMatch(/(?<![A-Z0-9])[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}(?![A-Z0-9])/);
  });

  it("--exit-after-ack fails when the relay closes before the ack", async () => {
    stub = await startRelayStub({ autoAck: false });
    const { io, err } = fakeIo();
    const running = main(["--relay", stub.url, "--exit-after-ack"], io);
    await vi.waitFor(() => expect(stub!.publisherFrames.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
    });
    stub.closePublisher(4008);
    expect(await running).toBe(EXIT.usage);
    expect(err.join("")).toContain(
      "relay closed the connection (code 4008) before the snapshot ack",
    );
  });

  it("prints only well-formed relay error codes", async () => {
    stub = await startRelayStub({ autoAck: false });
    const { io, err } = fakeIo();
    const running = main(["--relay", stub.url], io);
    await vi.waitFor(() => expect(stub!.publisherFrames.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
    });
    stub.sendToPublisher({ type: "error", code: "\u001b[31mevil", message: "x", retryable: false });
    expect(await running).toBe(EXIT.relayError);
    expect(err.join("")).toContain("relay error: UNKNOWN\n");
  });

  it("reports an unusable fixture as a usage error", async () => {
    const { io, err } = fakeIo();
    expect(await main(["--fixture", "nope.glb"], io)).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/fixture not found: nope\.glb/);
    expect(await main(["--fixture", `${FIXTURE_DIR}bad-magic.glb`], io)).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/bad-magic\.glb: not a GLB/);
    expect(await main(["--fixture", `${FIXTURE_DIR}truncated.glb`], io)).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/truncated\.glb: GLB header length/);
  });
});

describe("GLB loading", () => {
  it("resolves bare names inside shared/fixtures/glb and matches the manifest", async () => {
    for (const [name, file] of Object.entries(manifest).filter(([, f]) => f.valid)) {
      const glb = await loadGlb(resolveFixture(name));
      expect(glb.sha256).toBe(file.sha256);
      expect(glb.bytes.byteLength).toBe(file.byteLength);
      expect(glb.nodeCount).toBe(file.nodeCount);
      expect(glb.triangleCount).toBe(file.triangleCount);
    }
  });
});
