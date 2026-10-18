import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvelope } from "@slicerremoteview/shared";
import {
  EXIT,
  FIXTURE_DIR,
  SCRIPT_DIR,
  loadScript,
  main,
  scriptDuration,
  startRelayStub,
} from "../src/index.js";
import type { Io, RelayStub } from "../src/index.js";
import { TestViewer } from "./viewer.js";

let stub: RelayStub | undefined;
let viewer: TestViewer | undefined;
afterEach(async () => {
  viewer?.close();
  viewer = undefined;
  await stub?.close();
  stub = undefined;
});

const SEGMENT = "vtkMRMLSegmentationNode1/Segment_1";
const MODEL = "vtkMRMLModelNode2";
const dir = mkdtempSync(join(tmpdir(), "fake-slicer-script-"));
let counter = 0;
const writeScript = (entries: unknown): string => {
  const file = join(dir, `s${++counter}.json`);
  writeFileSync(file, JSON.stringify(entries));
  return file;
};

function fakeIo() {
  const controller = new AbortController();
  const err: string[] = [];
  const io: Io = {
    stdout: () => undefined,
    stderr: (text) => void err.push(text),
    writeFd: () => undefined,
    signal: controller.signal,
  };
  return { io, err, controller };
}

/** Text frames the publisher sent, parsed (binary chunks skipped). */
const sent = (): Record<string, unknown>[] =>
  stub!.publisherFrames
    .filter((f) => !f.binary)
    .map((f) => JSON.parse(f.data.toString()) as Record<string, unknown>);
const sentTypes = (): string[] => sent().map((m) => String(m["type"]));

async function start(argv: string[]) {
  stub = await startRelayStub();
  const fake = fakeIo();
  const running = main(["--relay", stub.url, ...argv], fake.io);
  return { ...fake, running };
}

describe("script loading (PRO-15)", () => {
  it("accepts every bundled script and resolves it by name", async () => {
    for (const name of ["toggle-visibility", "colour-cycle", "move-node", "reload-scene"]) {
      const entries = await loadScript(name);
      expect(entries.length).toBeGreaterThan(0);
      expect(scriptDuration(entries)).toBeGreaterThan(0);
      expect(await loadScript(`${name}.json`)).toEqual(entries);
    }
  });

  it("bundled scripts only touch nodeIds of the fixtures they run against", () => {
    const manifest = (
      JSON.parse(readFileSync(`${FIXTURE_DIR}manifest.json`, "utf8")) as {
        files: Record<string, { nodeIds: string[] }>;
      }
    ).files;
    const ids = (name: string): string[] =>
      (
        JSON.parse(readFileSync(`${SCRIPT_DIR}${name}.json`, "utf8")) as Record<string, unknown>[]
      ).flatMap((e) => [
        ...((e["changes"] as { nodeId: string }[] | undefined) ?? []).map((c) => c.nodeId),
        ...((e["nodes"] as { nodeId: string }[] | undefined) ?? []).map((c) => c.nodeId),
      ]);
    for (const name of ["toggle-visibility", "colour-cycle", "move-node"])
      for (const id of ids(name)) expect(manifest["asymmetric-2nodes.glb"]!.nodeIds).toContain(id);
    for (const id of ids("reload-scene"))
      expect(manifest["quantized-1node.glb"]!.nodeIds).toContain(id);
  });

  it("rejects malformed scripts with the entry that is wrong", async () => {
    const bad = async (entries: unknown): Promise<string> =>
      loadScript(writeScript(entries)).then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(await bad([])).toMatch(/non-empty JSON array/);
    expect(await bad({})).toMatch(/non-empty JSON array/);
    expect(await bad([{ type: "scene.update", changes: [] }])).toMatch(/\[0\]: "afterMs"/);
    expect(await bad([{ afterMs: -1, type: "scene.update" }])).toMatch(/"afterMs"/);
    expect(await bad([{ afterMs: 1, type: "scene.camera" }])).toMatch(/"type" must be one of/);
    expect(await bad([{ afterMs: 1, type: "scene.update", sceneVersion: 9, changes: [] }])).toMatch(
      /"sceneVersion" is filled in/,
    );
    expect(
      await bad([
        { afterMs: 1, type: "scene.update", changes: [{ nodeId: MODEL, visible: "yes" }] },
      ]),
    ).toMatch(/\[0\]: message does not match the scene.update schema/);
    expect(
      await bad([{ afterMs: 1, type: "scene.update", fixture: "a.glb", changes: [] }]),
    ).toMatch(/"fixture" only applies/);
    expect(await bad([{ afterMs: 1, type: "scene.snapshot", fixture: "nope.glb" }])).toMatch(
      /fixture not found: nope\.glb/,
    );
    expect(await bad([{ afterMs: 1, type: "scene.nodeRemoved", nodeIds: [MODEL] }, "x"])).toMatch(
      /\[1\]: expected an object/,
    );
    await expect(loadScript("missing-script")).rejects.toThrow(/script not found/);
  });
});

describe("script playback (PRO-15)", () => {
  const script = [
    { afterMs: 20, type: "scene.update", changes: [{ nodeId: SEGMENT, visible: false }] },
    {
      afterMs: 20,
      type: "scene.update",
      changes: [{ nodeId: MODEL, color: [1, 0, 0], opacity: 0.5 }],
    },
    { afterMs: 20, type: "scene.nodeRemoved", nodeIds: [MODEL] },
    {
      afterMs: 20,
      type: "scene.nodeAdded",
      nodes: [{ nodeId: "vtkMRMLModelNode3", kind: "model" }],
      snapshotFollows: true,
    },
    { afterMs: 20, type: "scene.snapshot", fixture: "quantized-1node.glb" },
    {
      afterMs: 20,
      type: "scene.update",
      changes: [{ nodeId: "vtkMRMLModelNode3", visible: true }],
    },
  ];

  it("keeps versions strictly increasing and baseVersion = previous version (§8.1, §8.4)", async () => {
    stub = await startRelayStub({ holdFramesUntilViewers: 1 });
    const fake = fakeIo();
    const lines: string[] = [];
    fake.io.writeFd = (_fd, text) => void lines.push(text);
    const running = main(
      ["--relay", stub.url, "--code-fd", "3", "--script", writeScript(script)],
      fake.io,
    );
    await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 5000 });
    viewer = await TestViewer.join(stub.url, lines[0]!.split(" ")[0]!);
    await vi.waitFor(
      () => expect(sentTypes().filter((t) => t === "scene.update")).toHaveLength(3),
      {
        timeout: 5000,
      },
    );
    fake.controller.abort();
    expect(await running).toBe(EXIT.ok);

    expect(stub.versionViolations).toEqual([]);
    const messages = sent().filter((m) => typeof m["sceneVersion"] === "number");
    expect(messages.map((m) => [m["type"], m["sceneVersion"], m["baseVersion"] ?? null])).toEqual([
      ["scene.snapshot.begin", 1, null],
      ["scene.snapshot.end", 1, null],
      ["scene.update", 2, 1],
      ["scene.update", 3, 2],
      ["scene.nodeRemoved", 4, 3],
      ["scene.nodeAdded", 5, 4],
      ["scene.snapshot.begin", 6, null],
      ["scene.snapshot.end", 6, null],
      ["scene.update", 7, 6],
    ]);
    for (const text of stub.publisherFrames.filter((f) => !f.binary))
      expect(parseEnvelope(text.data.toString()).ok).toBe(true);
    // the viewer got the second snapshot (another GLB) after the nodeAdded hint
    const second = await viewer.snapshot(6);
    expect(second.bytes.byteLength).toBeGreaterThan(0);
    expect(viewer.messages("scene.nodeAdded")[0]).toMatchObject({ snapshotFollows: true });
  });

  it("reload-scene.json sends nodeAdded, then a snapshot with a higher version (§8.2)", async () => {
    const { running, controller } = await start(["--script", "reload-scene"]);
    await vi.waitFor(() => expect(sentTypes().at(-1)).toBe("scene.update"), { timeout: 5000 });
    controller.abort();
    expect(await running).toBe(EXIT.ok);
    expect(sentTypes().filter((t) => t !== "scene.snapshot.end")).toEqual([
      "scene.snapshot.begin",
      "scene.nodeAdded",
      "scene.snapshot.begin",
      "scene.update",
    ]);
    expect(stub!.versionViolations).toEqual([]);
    const begins = sent().filter((m) => m["type"] === "scene.snapshot.begin");
    expect(begins.map((m) => m["sceneVersion"])).toEqual([1, 3]);
    expect(begins[1]).toMatchObject({ extensionsUsed: ["KHR_mesh_quantization"] });
  });

  it("--loop replays from the first entry and keeps versions monotonic (§8.4)", async () => {
    const loop = [
      { afterMs: 10, type: "scene.update", changes: [{ nodeId: MODEL, visible: false }] },
      { afterMs: 10, type: "scene.snapshot" },
      { afterMs: 10, type: "scene.update", changes: [{ nodeId: MODEL, visible: true }] },
    ];
    const { running, controller } = await start(["--script", writeScript(loop), "--loop"]);
    await vi.waitFor(
      () =>
        expect(
          sentTypes().filter((t) => t === "scene.snapshot.begin").length,
        ).toBeGreaterThanOrEqual(4),
      { timeout: 5000 },
    );
    controller.abort();
    expect(await running).toBe(EXIT.ok);
    expect(stub!.versionViolations).toEqual([]);
    const versions = sent()
      .filter((m) => typeof m["sceneVersion"] === "number" && m["type"] !== "scene.snapshot.end")
      .map((m) => m["sceneVersion"] as number);
    expect(versions.length).toBeGreaterThanOrEqual(8);
    expect(versions).toEqual(versions.map((_, i) => i + 1)); // 1, 2, 3, … without gaps or repeats
    const types = sentTypes().filter((t) => t !== "scene.snapshot.end");
    expect(types.slice(0, 4)).toEqual([
      "scene.snapshot.begin",
      "scene.update",
      "scene.snapshot.begin",
      "scene.update",
    ]);
    expect(types.slice(4, 6)).toEqual(["scene.update", "scene.snapshot.begin"]);
  });

  it("without --loop the script ends and the publisher stays connected", async () => {
    const { running, controller, err } = await start([...["--script", writeScript([script[0]])]]);
    await vi.waitFor(() => expect(err.join("")).toContain("scene.update 2 sent"), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sentTypes().filter((t) => t === "scene.update")).toHaveLength(1);
    controller.abort();
    expect(await running).toBe(EXIT.ok);
  });

  it("--close-after sends session.close USER_STOPPED and exits 0", async () => {
    const { running } = await start(["--close-after", "60"]);
    expect(await running).toBe(EXIT.ok);
    const close = sent().at(-1);
    expect(close).toMatchObject({ type: "session.close", reason: "USER_STOPPED" });
    expect(parseEnvelope(JSON.stringify(close)).ok).toBe(true);
  });

  it("exits 2 when the relay rejects an update (stub-side version checker)", async () => {
    stub = await startRelayStub();
    const fake = fakeIo();
    // a script cannot break versions itself, so break the stub's expectation: nodeAdded without a snapshot
    const running = main(
      [
        "--relay",
        stub.url,
        "--script",
        writeScript([
          {
            afterMs: 5,
            type: "scene.nodeAdded",
            nodes: [{ nodeId: MODEL, kind: "model" }],
            snapshotFollows: true,
          },
          { afterMs: 5, type: "scene.update", changes: [{ nodeId: MODEL, visible: false }] },
        ]),
      ],
      fake.io,
    );
    expect(await running).toBe(EXIT.relayError);
    expect(stub.versionViolations).toEqual([
      "scene.update while a snapshot is due after scene.nodeAdded",
    ]);
    expect(fake.err.join("")).toContain("relay error: BAD_SEQUENCE");
  });
});
