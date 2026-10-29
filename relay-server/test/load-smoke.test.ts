import { decodeChunkHeader } from "@slicerremoteview/shared";
import { describe, expect, it } from "vitest";
import { loadGlb, resolveFixture } from "../../tools/fake-slicer/src/index.js";
import {
  BudgetSpend,
  DEFAULT_SMOKE,
  runLoadSmoke,
  sendPaced,
  smokeOptions,
} from "../scripts/load-smoke.js";
import type { PacingViewer } from "../scripts/load-smoke.js";
import { DEFAULT_MESSAGE_BUDGETS, TokenBucket } from "../src/ws/budget.js";

/** Whether a process with this pid (a negative one: process group) still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A viewer for `sendPaced` that holds as many chunks as the test gives it. */
class FakeViewer implements PacingViewer {
  held = 0;
  waits = 0;
  #recheck = (): void => {};
  chunksOf(): number {
    return this.held;
  }
  until(probe: () => boolean, withinMs = Infinity): Promise<boolean> {
    this.waits += 1;
    return new Promise((resolve) => {
      const timer = withinMs < Infinity ? setTimeout(() => resolve(false), withinMs) : undefined;
      const check = (): void => {
        if (!probe()) return void (this.#recheck = check);
        clearTimeout(timer);
        resolve(true);
      };
      check();
    });
  }
  give(chunks: number): void {
    this.held = chunks;
    this.#recheck();
  }
}

describe("sendPaced (SRV-30, report 2026-10-27-release-1)", () => {
  const plan = async () => ({
    glb: await loadGlb(resolveFixture("large-synthetic.glb")), // 4.7 MiB: chunks 0–4
    sceneVersion: 7,
    chunkSize: 1_048_576,
    profile: "mobile" as const,
  });
  /** What went out, in order: message types and chunk indexes. */
  const recorder = () => {
    const sent: (string | number)[] = [];
    const send = async (frame: string | Uint8Array): Promise<void> => {
      if (typeof frame === "string") sent.push((JSON.parse(frame) as { type: string }).type);
      else {
        const header = decodeChunkHeader(frame);
        if (!header.ok || header.value.sceneVersion !== 7) throw new Error("bad chunk");
        sent.push(header.value.chunkIndex);
      }
    };
    return { sent, send };
  };
  let ids = 0;
  const nextId = (): string => `p-${++ids}`;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("sends chunk i only once each paced viewer holds chunks 0 … i−2, then end", async () => {
    const { sent, send } = recorder();
    const reading = new FakeViewer();
    const slow = new FakeViewer();
    const done = sendPaced(send, await plan(), nextId, [reading, slow], 60_000);
    reading.give(5); // every chunk as soon as it is sent
    await settle();
    expect(sent).toEqual(["scene.snapshot.begin", 0, 1]); // chunk 2 waits for chunk 0 at `slow`
    for (const held of [1, 2]) {
      slow.give(held);
      await settle();
      expect(sent.at(-1)).toBe(held + 1);
    }
    slow.give(3); // chunk 4, the last, then end
    expect(await done).toBe(0); // nobody dropped from the pace
    expect(sent).toEqual(["scene.snapshot.begin", 0, 1, 2, 3, 4, "scene.snapshot.end"]);
  });

  it("a viewer behind for `waitMs`, or whose stream is over before `end`, is not paced and counted", async () => {
    const { sent, send } = recorder();
    const reading = new FakeViewer();
    const stuck = new FakeViewer();
    const over = new FakeViewer(); // an abort, or a `chunksOf` stuck at `Infinity`
    reading.give(5);
    over.give(Infinity);
    expect(await sendPaced(send, await plan(), nextId, [reading, stuck, over], 50)).toBe(2);
    expect(sent).toEqual(["scene.snapshot.begin", 0, 1, 2, 3, 4, "scene.snapshot.end"]);
    expect(stuck.waits).toBe(3); // chunks 0 and 1 at once, chunk 2 timed out: not asked again
    expect(reading.waits).toBe(5);
    expect(over.waits).toBe(0);

    const alone = recorder();
    expect(await sendPaced(alone.send, await plan(), nextId, [])).toBe(0);
    expect(alone.sent).toHaveLength(7);
  });
});

describe("BudgetSpend (SRV-32)", () => {
  let ids = 0;
  const nextId = (): string => `p-${++ids}`;
  /**
   * The verdicts of the relay's own publisher buckets (`ws/budget.ts`) on `cycles` snapshots of
   * `fixture`, each cycle's frames charged at once — the fastest a machine can go — and each cycle
   * `gap(spent)` ms after the one before.
   */
  const verdicts = async (fixture: string, cycles: number, gap: (spent: BudgetSpend) => number) => {
    const glb = await loadGlb(resolveFixture(fixture));
    const text = new TokenBucket(DEFAULT_MESSAGE_BUDGETS.publisher, 0);
    const chunks = new TokenBucket(DEFAULT_MESSAGE_BUDGETS.publisherBinary, 0);
    const seen = new Set<string>();
    let now = 0;
    for (let sceneVersion = 1; sceneVersion <= cycles; sceneVersion++) {
      const spent = new BudgetSpend();
      const send = async (frame: string | Uint8Array): Promise<void> => {
        spent.add(frame);
        if (typeof frame === "string") seen.add(text.take(Buffer.byteLength(frame), now));
        else seen.add(chunks.take(frame.byteLength, now));
      };
      const plan = { glb, sceneVersion, chunkSize: 1_048_576, profile: "mobile" as const };
      await sendPaced(send, plan, nextId, []);
      now += gap(spent);
    }
    return [...seen];
  };

  it("cycles begun `refillMs` apart keep within the relay's publisher budget, back to back not", async () => {
    // 3.4 KB: the two text frames (32 KiB each on top of their bytes) bind; 4.7 MiB: the chunks.
    for (const [fixture, cycles] of [
      ["asymmetric-2nodes.glb", 500],
      ["large-synthetic.glb", 100],
    ] as const) {
      expect(await verdicts(fixture, cycles, (spent) => spent.refillMs)).toEqual(["ok"]);
      expect(await verdicts(fixture, cycles, () => 0)).toContain("limited"); // closed `4006`
    }
  });
});

describe("scripts/load-smoke.ts (SRV-21)", () => {
  it("parses its options onto the defaults and refuses values it cannot use", () => {
    expect(smokeOptions([])).toEqual(DEFAULT_SMOKE);
    expect(
      smokeOptions(["--viewers", "5", "--cycles", "4", "--max-fanout-ms", "800"]),
    ).toMatchObject({ viewers: 5, cycles: 4, maxFanoutMs: 800 });
    for (const bad of [
      ["--viewers", "21"],
      ["--viewers", "1"], // phase 2 needs a viewer besides the stopped one
      ["--cycles", "2"], // the leak check needs three
      ["--cycles", "3.5"],
      ["--max-fanout-ms", "x"],
      ["--max-growth-factor", "Infinity"],
    ])
      expect(() => smokeOptions(bad)).toThrow();
  });

  // The verify command is `npm run load:smoke` (20 viewers); this keeps the script working in CI.
  it("a small run passes every check: fan-out in time, no leak, only the stopped viewer deferred", async () => {
    let pid = 0;
    let ownGroup = false;
    const result = await runLoadSmoke({
      ...DEFAULT_SMOKE,
      viewers: 3,
      maxFanoutMs: 20_000,
      runTimeoutMs: 60_000,
      onRelay: (relay) => {
        pid = relay;
        ownGroup = alive(-relay); // a terminal's Ctrl-C does not reach it (`detached`)
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.phase1.map((c) => [c.viewersStreamed, c.viewersDeferred])).toEqual([
      [3, 0],
      [3, 0],
      [3, 0],
    ]);
    expect(result.phase2.at(-1)).toMatchObject({ viewersStreamed: 2, viewersDeferred: 1 });
    // Every viewer waited for kept the pace (the real `Viewer` takes part: chunk count and wake).
    const cycles = [...result.phase1, ...result.phase2];
    expect(cycles.filter((c) => c.viewersUnpaced !== 0)).toEqual([]);
    // Each cycle started once the relay's publisher budget had earned back the one before (SRV-32),
    // its chunks alone taking `snapshotBytes` ÷ 32 MiB/s.
    const chunksMs = (1000 * result.snapshotBytes) / DEFAULT_MESSAGE_BUDGETS.publisherBinary.rate;
    for (const [i, c] of cycles.entries()) {
      expect(c.refillMs).toBeGreaterThan(chunksMs);
      const previous = cycles[i - 1];
      if (previous)
        expect(c.startedAt).toBeGreaterThanOrEqual(previous.startedAt + previous.refillMs);
    }
    expect(result.stoppedViewerRecovered).toBe(true);
    expect(ownGroup).toBe(true);
    expect(alive(pid)).toBe(false); // the relay is gone with the run
  }, 90_000);

  it("a run that times out still takes the relay down (no orphan to hold CI)", async () => {
    let pid = 0;
    await expect(
      runLoadSmoke({
        ...DEFAULT_SMOKE,
        viewers: 3,
        // 3.4 KB: it loads at once, so the spawn comes before the timeout, and it never reaches the
        // soft watermark, so phase 2 runs until the timeout — starting, joining or cycling, however
        // fast the machine (report `2026-10-27-release-1`), its cycles within the publisher's
        // budget (`BudgetSpend`; back to back, the relay closed it `RATE_LIMITED` first, SRV-32).
        fixture: "asymmetric-2nodes.glb",
        maxDeferCycles: Infinity,
        runTimeoutMs: 2_000,
        onRelay: (r) => (pid = r),
      }),
    ).rejects.toThrow(/no result within 2000 ms/);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("a run that times out before the spawn starts no relay later", async () => {
    let pid = 0;
    await expect(
      runLoadSmoke({ ...DEFAULT_SMOKE, runTimeoutMs: 1, onRelay: (r) => (pid = r) }),
    ).rejects.toThrow(/no result within 1 ms/); // still loading the 4.7 MiB fixture
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(pid).toBe(0);
  }, 30_000);
});
