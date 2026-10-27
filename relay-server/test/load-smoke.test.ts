import { describe, expect, it } from "vitest";
import { DEFAULT_SMOKE, runLoadSmoke, smokeOptions } from "../scripts/load-smoke.js";

/** Whether a process with this pid (a negative one: process group) still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
        fixture: "asymmetric-2nodes.glb", // loads at once, so the spawn comes before the timeout
        runTimeoutMs: 500, // while the relay is still starting
        onRelay: (r) => (pid = r),
      }),
    ).rejects.toThrow(/no result within 500 ms/);
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
