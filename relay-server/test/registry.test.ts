import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken, tokenMatches } from "../src/codes.js";
import { EXPIRING_LEAD_MS, Registry, RegistryError, SWEEP_INTERVAL_MS } from "../src/registry.js";
import type { ExpiryReason, RegistryOptions, Session } from "../src/registry.js";
import { ManualClock } from "./helpers/manual-clock.js";

const S = 1_000;
const DEFAULTS = {
  maxSessions: 100,
  maxViewers: 20,
  sessionTtlS: 1_800,
  publisherGraceS: 120,
  sessionMaxLifetimeS: 43_200,
  codeQuarantineS: 600,
};

function setup(options: Partial<RegistryOptions> = {}) {
  const clock = new ManualClock();
  const registry = new Registry({ ...DEFAULTS, clock, ...options });
  const expired: [string, ExpiryReason][] = [];
  const expiring: [string, number][] = [];
  registry.on("expired", (session, reason) => expired.push([session.id, reason]));
  registry.on("expiring", (session, closesAt) => expiring.push([session.id, closesAt]));
  return { clock, registry, expired, expiring };
}

type Step = (registry: Registry, session: Session) => void;

interface Scenario {
  name: string;
  /** Applied right after `createSession` at t0. */
  setup?: Step;
  /** `[seconds after t0, action?]`; the sweep runs after each action. */
  timeline: [number, Step?][];
  /** Seconds after t0 when the session must be expired (checked by sweeping 1 ms before and at it). */
  expiresAtS: number;
  reason: ExpiryReason;
}

const stubPeer = { send: () => {}, close: () => {} };
const withViewer: Step = (r, s) => void r.addViewer(s, stubPeer, "web");
const viewersLeave: Step = (r, s) => {
  for (const viewer of s.viewers.values()) r.viewerDisconnected(s, viewer);
};

const SCENARIOS: Scenario[] = [
  {
    name: "grace → expired PUBLISHER_GONE at 120 s (FR-20, §9.1)",
    setup: withViewer,
    timeline: [[0, (r, s) => r.publisherLost(s)]],
    expiresAtS: 120,
    reason: "PUBLISHER_GONE",
  },
  {
    name: "grace from allocated (publisher dropped before its first snapshot) → PUBLISHER_GONE",
    timeline: [[30, (r, s) => r.publisherLost(s)]],
    expiresAtS: 150,
    reason: "PUBLISHER_GONE",
  },
  {
    name: "idle without viewers → expired IDLE at 1,800 s (NFR-11, §4.4)",
    timeline: [],
    expiresAtS: 1_800,
    reason: "IDLE",
  },
  {
    name: "idle counts from the last viewer leaving",
    setup: withViewer,
    timeline: [[5_000, viewersLeave]],
    expiresAtS: 6_800,
    reason: "IDLE",
  },
  {
    name: "session.renew restarts the idle period",
    timeline: [[1_700, (r, s) => r.renew(s)]],
    expiresAtS: 3_500,
    reason: "IDLE",
  },
  {
    name: "publisher activity does not refresh the idle timer (§4.4)",
    timeline: [
      [600, (r, s) => r.touchPublisher(s)],
      [1_200, (r, s) => r.touchPublisher(s)],
    ],
    expiresAtS: 1_800,
    reason: "IDLE",
  },
  {
    name: "lifetime → expired MAX_LIFETIME at 43,200 s even with viewers",
    setup: withViewer,
    timeline: [],
    expiresAtS: 43_200,
    reason: "MAX_LIFETIME",
  },
  {
    name: "lifetime wins over a still-running grace period",
    setup: withViewer,
    timeline: [[43_150, (r, s) => r.publisherLost(s)]],
    expiresAtS: 43_200,
    reason: "MAX_LIFETIME",
  },
  {
    name: "resume within grace cancels PUBLISHER_GONE; idle then applies",
    timeline: [
      [10, withViewer],
      [100, (r, s) => r.publisherLost(s)],
      [
        219,
        (r, s) => {
          r.publisherResumed(s);
          expect(s.phase).toBe("allocated"); // no snapshot yet: back to allocated, not active
        },
      ],
      [300, viewersLeave],
    ],
    expiresAtS: 2_100,
    reason: "IDLE",
  },
];

describe("expiry follows the state diagram of architecture §3 (SRV-04 criterion 1)", () => {
  it.each(SCENARIOS)("$name", ({ setup: before, timeline, expiresAtS, reason }) => {
    const { clock, registry, expired } = setup();
    const t0 = clock.now();
    const { session } = registry.createSession("mobile");
    before?.(registry, session);
    for (const [atS, action] of timeline) {
      clock.set(t0 + atS * S);
      action?.(registry, session);
      registry.sweep();
      expect(expired).toEqual([]);
    }
    clock.set(t0 + expiresAtS * S - 1);
    registry.sweep();
    expect(expired).toEqual([]);
    expect(registry.get(session.id)).toBe(session);
    clock.set(t0 + expiresAtS * S);
    registry.sweep();
    expect(expired).toEqual([[session.id, reason]]);
    expect(session.phase).toBe("expired");
    expect(registry.get(session.id)).toBeUndefined();
    expect(registry.getByCode(session.code)).toBeUndefined();
    registry.sweep();
    expect(expired).toHaveLength(1);
  });

  it("emits expiring once, 60 s before the idle expiry, with closesAt", () => {
    const { clock, registry, expiring } = setup();
    const t0 = clock.now();
    const { session } = registry.createSession("mobile");
    clock.set(t0 + 1_800 * S - EXPIRING_LEAD_MS - 1);
    registry.sweep();
    expect(expiring).toEqual([]);
    clock.advance(1);
    registry.sweep();
    registry.sweep();
    expect(expiring).toEqual([[session.id, t0 + 1_800 * S]]);
    registry.renew(session);
    clock.advance(1_800 * S - EXPIRING_LEAD_MS);
    registry.sweep();
    expect(expiring).toHaveLength(2);
  });

  it("does not warn or expire while viewers are connected", () => {
    const { clock, registry, expired, expiring } = setup();
    const { session } = registry.createSession("quest3");
    for (let i = 0; i < 3; i++) registry.addViewer(session, stubPeer, "quest3");
    clock.advance(10_000 * S);
    registry.sweep();
    expect(registry.idleDeadline(session)).toBeUndefined();
    expect([expired, expiring]).toEqual([[], []]);
  });

  it("phases: allocated → active → grace → active (resume) → closed", () => {
    const { registry } = setup();
    const { session } = registry.createSession("mobile");
    expect(session.phase).toBe("allocated");
    registry.markActive(session);
    expect(session.phase).toBe("active");
    expect(registry.publisherLost(session)).toBe(session.graceEndsAt);
    expect(session.phase).toBe("grace");
    expect(registry.publisherLost(session)).toBeUndefined();
    session.snapshot = {
      buffer: Buffer.alloc(1),
      sha256: "x",
      byteLength: 1,
      sceneVersion: 1,
      extensionsRequired: [],
    };
    registry.publisherResumed(session);
    expect([session.phase, session.graceEndsAt]).toEqual(["active", undefined]);
    registry.closeSession(session);
    expect(session.phase).toBe("closed");
    registry.markActive(session);
    registry.publisherResumed(session);
    expect(session.phase).toBe("closed");
  });

  it("a throwing listener stops neither the other listeners nor the sweep", () => {
    const errors: unknown[] = [];
    const { clock, registry, expired } = setup({ onListenerError: (e) => errors.push(e) });
    const first = registry.createSession("mobile").session;
    const second = registry.createSession("mobile").session;
    registry.prependListener("expired", (session) => {
      if (session === first) throw new Error("listener bug");
    });
    clock.advance(1_800 * S);
    registry.sweep();
    expect(errors).toHaveLength(1);
    expect([first.phase, second.phase]).toEqual(["expired", "expired"]);
    expect(expired.map(([id]) => id)).toEqual([first.id, second.id]);
  });

  it("start() sweeps every 10 s on the injected clock until stop()", () => {
    const { clock, registry } = setup();
    const sweep = vi.spyOn(registry, "sweep");
    registry.start();
    clock.advance(SWEEP_INTERVAL_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(3);
    registry.stop();
    clock.advance(SWEEP_INTERVAL_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(clock.pending).toBe(0);
  });

  it("skips a session another listener ended earlier in the same sweep", () => {
    const { clock, registry, expiring } = setup();
    const first = registry.createSession("mobile").session; // idle expiry at 1,800 s
    clock.advance(30 * S);
    const second = registry.createSession("mobile").session; // warning due from 1,770 s
    registry.on("expired", () => registry.closeSession(second));
    clock.advance(1_770 * S); // t0 + 1,800 s
    registry.sweep();
    expect([first.phase, second.phase]).toEqual(["expired", "closed"]);
    expect(expiring).toEqual([]);
  });
});

// Exposed by `execArgv: ["--expose-gc"]` in vitest.config.ts.
declare const gc: () => void;

/** Gives the session a 1 MiB cached and a 512 KiB assembling buffer; keeps only weak references. */
function attachBuffers(session: Session): WeakRef<Buffer>[] {
  const snapshot = Buffer.alloc(1 << 20, 1);
  const assembling = Buffer.alloc(1 << 19, 2);
  session.snapshot = {
    buffer: snapshot,
    sha256: "x",
    byteLength: snapshot.length,
    sceneVersion: 3,
    extensionsRequired: [],
  };
  session.assembling = {
    buffer: assembling,
    sceneVersion: 4,
    byteLength: assembling.byteLength,
    chunkSize: 1 << 16,
    chunkCount: 8,
    nextIndex: 0,
    sha256: "0".repeat(64),
    hash: createHash("sha256"),
    extensionsRequired: [],
    lastChunkAt: 0,
  };
  return [new WeakRef(snapshot), new WeakRef(assembling)];
}

describe("releasing a session (SRV-04 criterion 2, NFR-10)", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["closeSession", (r: Registry, s: Session) => r.closeSession(s), "closed"],
    ["expireSession", (r: Registry, s: Session) => r.expireSession(s, "CAPACITY"), "expired"],
  ] as const)("%s drops buffers, state and the code", async (_name, release, phase) => {
    const { registry, expired } = setup();
    const { session } = registry.createSession("mobile");
    const refs = attachBuffers(session);
    session.nodeState.set("vtkMRMLModelNode1", { visible: false });
    expect(registry.snapshotBytes).toBe(1.5 * (1 << 20));

    release(registry, session);

    expect(session.phase).toBe(phase);
    expect(session.snapshot).toBeUndefined();
    expect(session.assembling).toBeUndefined();
    expect(session.nodeState.size).toBe(0);
    expect(registry.snapshotBytes).toBe(0);
    expect(registry.size).toBe(0);
    expect(registry.getByCode(session.code)).toBeUndefined();
    expect(registry.isCodeQuarantined(session.code)).toBe(true);
    expect(expired).toEqual(phase === "expired" ? [[session.id, "CAPACITY"]] : []);
    // The session object may outlive the release (sockets still reference it); the bytes must not.
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    // Booleans, so a failure does not print 1.5 MiB of retained bytes.
    expect(refs.map((ref) => ref.deref() === undefined)).toEqual([true, true]);
  });

  it("is idempotent; `released` follows `expired` once per session, also for a close", () => {
    const { registry, expired } = setup();
    const events: string[] = [];
    registry.on("expired", () => events.push("expired"));
    registry.on("released", (s) => events.push(`released ${s.phase}`));
    const { session } = registry.createSession("mobile");
    registry.expireSession(session, "IDLE");
    registry.expireSession(session, "IDLE");
    registry.closeSession(session);
    expect(session.phase).toBe("expired");
    expect(expired).toHaveLength(1);
    const other = registry.createSession("mobile").session;
    registry.closeSession(other);
    registry.closeSession(other);
    expect(events).toEqual(["expired", "released expired", "released closed"]);
  });

  it("the relay sources never touch the file system", () => {
    // `version.ts` reads package.json through `createRequire` (read-only, at start-up) and is the
    // only module allowed to use `require`.
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(src + file, "utf8");
      expect(text, file).not.toMatch(
        /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:)?fs(\/promises)?["']/,
      );
      expect(text, file).not.toMatch(
        /createWriteStream|appendFile|writeFile|pino\.destination\(\s*["'/]/,
      );
      if (file !== "version.ts") expect(text, file).not.toMatch(/\brequire\s*\(/);
    }
  });
});

describe("createSession (SRV-04 criterion 3, §4.1, §4.2)", () => {
  it("returns the token once and keeps only its SHA-256", () => {
    const { clock, registry } = setup();
    const { session, publisherToken } = registry.createSession("quest2");
    expect(publisherToken).toMatch(/^pt_[A-Za-z0-9_-]{43}$/);
    expect(session.publisherTokenHash.equals(hashToken(publisherToken))).toBe(true);
    expect(tokenMatches(publisherToken, session.publisherTokenHash)).toBe(true);
    expect(JSON.stringify(session)).not.toContain(publisherToken.slice(3));
    expect(session).toMatchObject({
      phase: "allocated",
      profile: "quest2",
      sceneVersion: 0,
      connectedViewers: 0,
      createdAt: clock.now(),
      expiresAt: clock.now() + 43_200 * S,
    });
    expect(session.id).toMatch(/^sess_[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(registry.getByCode(session.code)).toBe(session);
  });

  it(`throws CAPACITY beyond MAX_SESSIONS and accepts again after a release`, () => {
    const { registry } = setup({ maxSessions: 3 });
    const sessions = [1, 2, 3].map(() => registry.createSession("mobile").session);
    expect(new Set(sessions.map((s) => s.code)).size).toBe(3);
    expect(() => registry.createSession("mobile")).toThrow(RegistryError);
    try {
      registry.createSession("mobile");
    } catch (error) {
      expect((error as RegistryError).code).toBe("CAPACITY");
    }
    registry.closeSession(sessions[0]!);
    expect(registry.createSession("mobile").session.phase).toBe("allocated");
  });

  it("grants a free, well-formed preferredCode", () => {
    const { registry } = setup();
    expect(registry.createSession("mobile", "7KQ4X").session.code).toBe("7KQ4X");
  });

  it("silently draws a fresh code when preferredCode is live", () => {
    const { registry } = setup();
    const first = registry.createSession("mobile", "7KQ4X").session;
    const second = registry.createSession("mobile", "7KQ4X").session;
    expect(second.code).not.toBe("7KQ4X");
    expect(registry.getByCode("7KQ4X")).toBe(first);
  });

  it("silently draws a fresh code when preferredCode is quarantined, and grants it after 600 s", () => {
    const { clock, registry } = setup();
    registry.closeSession(registry.createSession("mobile", "7KQ4X").session);
    expect(registry.createSession("mobile", "7KQ4X").session.code).not.toBe("7KQ4X");
    clock.advance(600 * S);
    expect(registry.createSession("mobile", "7KQ4X").session.code).toBe("7KQ4X");
  });

  it.each(["7kq4x", "7KQ0X", "7KQ4", "7KQ-4X", "", null, undefined])(
    "ignores a malformed preferredCode %j",
    (preferred) => {
      const { registry } = setup();
      expect(registry.createSession("mobile", preferred).session.code).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/,
      );
    },
  );

  it("throws CAPACITY instead of looping when the RNG repeats a session id", () => {
    let draw = 0;
    // Codes (31 symbols) vary, session ids (32 symbols) are always "sess_000…".
    const { registry } = setup({ rng: (min, max) => (max === 31 ? draw++ % 31 : min) });
    registry.createSession("mobile");
    expect(() => registry.createSession("mobile")).toThrow("no free session id");
  });

  it("never hands out a live or quarantined code (mocked RNG)", () => {
    const { registry } = setup({
      rng: (() => {
        // session ids draw from a 32-symbol alphabet, codes from 31; spell "AAAAA" twice, then "BBBBB"
        const codes = [..."AAAAA", ..."AAAAA", ..."BBBBB"].map((c) =>
          "23456789ABCDEFGHJKMNPQRSTUVWXYZ".indexOf(c),
        );
        let id = 0;
        return (min: number, max: number) => (max === 31 ? codes.shift()! : min + (id++ % max));
      })(),
    });
    expect(registry.createSession("mobile", "AAAAA").session.code).toBe("AAAAA");
    expect(registry.createSession("mobile").session.code).toBe("BBBBB");
  });
});

describe("viewers (SRV-07, architecture §3)", () => {
  const peer = () => ({ ...stubPeer });

  it("adds viewers up to maxViewers connected, then throws SESSION_FULL", () => {
    const { registry } = setup({ maxViewers: 2 });
    const { session } = registry.createSession("mobile");
    const a = registry.addViewer(session, peer(), "web");
    registry.addViewer(session, peer(), "quest3");
    expect(session.connectedViewers).toBe(2);
    expect(() => registry.addViewer(session, peer(), "web")).toThrow(
      expect.objectContaining({ code: "SESSION_FULL" }),
    );
    expect(registry.viewerDisconnected(session, a.viewer)).toBe(true);
    expect(registry.viewerDisconnected(session, a.viewer)).toBe(false);
    expect(session.connectedViewers).toBe(1);
    registry.addViewer(session, peer(), "web");
    expect(session.viewers.size).toBe(3);
  });

  it("stores only the token hash and finds the viewer by token until the session ends", () => {
    const { registry } = setup();
    const { session } = registry.createSession("mobile");
    const { viewer, viewerToken } = registry.addViewer(session, peer(), "web");
    expect(viewer.id).toMatch(/^vw_[0-9A-Z]{8}$/);
    expect(viewerToken).toMatch(/^vt_[A-Za-z0-9_-]{43}$/);
    expect(viewer.tokenHash.equals(hashToken(viewerToken))).toBe(true);
    expect(registry.viewerByToken(viewerToken)).toEqual({ session, viewer });
    registry.viewerDisconnected(session, viewer);
    expect(registry.viewerByToken(viewerToken)?.viewer).toBe(viewer); // kept for rejoin
    expect(registry.viewerByToken(`${viewerToken}x`)).toBeUndefined();
    registry.closeSession(session);
    expect(registry.viewerByToken(viewerToken)).toBeUndefined();
  });

  it("keeps at most 3 × maxViewers entries, dropping the oldest disconnected ones and their tokens", () => {
    const { registry } = setup({ maxViewers: 2 });
    const { session } = registry.createSession("mobile");
    const added = Array.from({ length: 6 }, () => {
      const entry = registry.addViewer(session, peer(), "web");
      registry.viewerDisconnected(session, entry.viewer);
      return entry;
    });
    expect(session.viewers.size).toBe(6);
    const connected = registry.addViewer(session, peer(), "web");
    expect(session.viewers.size).toBe(6);
    expect(session.viewers.has(added[0]!.viewer.id)).toBe(false);
    expect(registry.viewerByToken(added[0]!.viewerToken)).toBeUndefined();
    expect(registry.viewerByToken(added[1]!.viewerToken)?.viewer).toBe(added[1]!.viewer);
    expect(session.viewers.get(connected.viewer.id)).toBe(connected.viewer);
  });

  it("never prunes a connected viewer, however many join/leave cycles follow", () => {
    const { registry } = setup({ maxViewers: 2 });
    const { session } = registry.createSession("mobile");
    const kept = registry.addViewer(session, peer(), "web");
    for (let i = 0; i < 10; i++) {
      const cycle = registry.addViewer(session, peer(), "web");
      registry.viewerDisconnected(session, cycle.viewer);
    }
    expect(session.viewers.size).toBe(6);
    expect(session.viewers.get(kept.viewer.id)).toBe(kept.viewer);
    expect(registry.viewerByToken(kept.viewerToken)?.viewer).toBe(kept.viewer);
    expect(session.connectedViewers).toBe(1);
    registry.addViewer(session, peer(), "web");
    expect(() => registry.addViewer(session, peer(), "web")).toThrow(
      expect.objectContaining({ code: "SESSION_FULL" }),
    );
  });

  it("drives the idle timer from connected viewers (§4.4)", () => {
    const { clock, registry } = setup();
    const { session } = registry.createSession("mobile");
    const { viewer } = registry.addViewer(session, peer(), "web");
    expect(registry.idleDeadline(session)).toBeUndefined();
    clock.advance(10 * S);
    registry.viewerDisconnected(session, viewer);
    expect(registry.idleDeadline(session)).toBe(clock.now() + 1_800 * S);
  });
});
