import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_AFTER_S, fetchScene, parseRetryAfter } from "../../src/protocol/scene-http";
import type { FetchLike } from "../../src/protocol/scene-http";
import {
  glb,
  hanging,
  LARGE,
  manifest,
  response,
  same,
  serving,
  SMALL,
  target,
  TOKEN,
} from "./http-fixtures";

describe("fetchScene (§6.5, §10)", () => {
  it("downloads asymmetric-2nodes.glb, verifies sha256 and reports monotonic progress", async () => {
    const fetch = serving(SMALL, { partSize: 1000 });
    const progress: number[] = [];
    const result = await fetchScene(target(SMALL, 7), TOKEN, {
      fetch,
      onProgress: (f) => progress.push(f),
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.sceneVersion).toBe(7);
    expect(same(result.bytes, glb(SMALL))).toBe(true);
    expect(progress).toHaveLength(4); // 3400 B in 1000 B parts
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]!);
    expect(progress.at(-1)).toBe(1);
  });

  it("downloads large-synthetic.glb in 64 KiB parts", async () => {
    const progress: number[] = [];
    const result = await fetchScene(target(LARGE, 3), TOKEN, {
      fetch: serving(LARGE, { partSize: 65_536 }),
      onProgress: (f) => progress.push(f),
    });
    expect(result.kind).toBe("ready");
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((f, i) => i === 0 || f > progress[i - 1]!)).toBe(true);
  });

  it("sends the token only in the Authorization header, never in the URL (FR-31, NFR-15)", async () => {
    const fetch = serving(SMALL);
    await fetchScene(target(SMALL, 42), TOKEN, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/scene/42");
    expect(url).not.toContain(TOKEN);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it.each([
    [401, { kind: "unauthorized" }],
    [404, { kind: "notFound" }],
    [410, { kind: "gone" }],
    [500, { kind: "failed", reason: "status", status: 500 }],
  ])("maps HTTP %i", async (status, expected) => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, { fetch: serving(SMALL, { status }) });
    expect(result).toEqual(expected);
  });

  it("maps 429 with Retry-After to rateLimited", async () => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL, { status: 429, headers: { "Retry-After": "7" } }),
    });
    expect(result).toEqual({ kind: "rateLimited", retryAfterS: 7 });
  });

  it("rejects a Content-Length that differs from byteLength", async () => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL, { headers: { "Content-Length": "3399" } }),
    });
    expect(result).toEqual({ kind: "failed", reason: "length" });
  });

  it("rejects an ETag that is not the quoted sha256; tolerates a weak validator", async () => {
    const bad = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL, { headers: { ETag: `"${"0".repeat(64)}"` } }),
    });
    expect(bad).toEqual({ kind: "failed", reason: "etag" });
    const weak = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL, { headers: { ETag: `W/"${manifest.files[SMALL]!.sha256}"` } }),
    });
    expect(weak.kind).toBe("ready");
  });

  it("a body longer or shorter than byteLength is a length failure", async () => {
    const bytes = glb(SMALL);
    const longer = new Uint8Array(bytes.byteLength + 10);
    longer.set(bytes);
    const tooLong = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: vi.fn<FetchLike>(async () =>
        response(longer, { headers: { "Content-Length": String(bytes.byteLength), ETag: "" } }),
      ),
    });
    expect(tooLong).toEqual({ kind: "failed", reason: "length" });
    const tooShort = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: vi.fn<FetchLike>(async () =>
        response(bytes.subarray(0, 3000), {
          headers: { "Content-Length": String(bytes.byteLength) },
          sha256: manifest.files[SMALL]!.sha256,
        }),
      ),
    });
    expect(tooShort).toEqual({ kind: "failed", reason: "length" });
  });

  it("accepts a response without Content-Length and ETag (the hash still decides)", async () => {
    const bytes = glb(SMALL);
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes.slice());
              c.close();
            },
          }),
        ),
    );
    expect((await fetchScene(target(SMALL, 1), TOKEN, { fetch })).kind).toBe("ready");
  });

  it("a tampered last byte → checksumMismatch (T10)", async () => {
    const tampered = glb(SMALL);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: vi.fn<FetchLike>(async () =>
        response(tampered, { sha256: manifest.files[SMALL]!.sha256 }),
      ),
    });
    expect(result).toEqual({ kind: "checksumMismatch" });
  });

  it("a failing digest is treated as a mismatch", async () => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL),
      sha256: () => Promise.reject(new Error("no subtle")),
    });
    expect(result).toEqual({ kind: "checksumMismatch" });
  });

  it("refuses a snapshot above maxSnapshotBytes without requesting it", async () => {
    const fetch = serving(SMALL);
    const result = await fetchScene(target(SMALL, 1), TOKEN, { fetch, maxSnapshotBytes: 1000 });
    expect(result).toEqual({ kind: "tooLarge", byteLength: 3400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["fractional version", { sceneVersion: 1.5 }],
    ["version 0", { sceneVersion: 0 }],
    ["version above uint32", { sceneVersion: 2 ** 32 }],
    ["path in the version", { sceneVersion: "1/../../x" as unknown as number }],
    ["zero byteLength", { byteLength: 0 }],
    ["bad sha256", { sha256: "ABC" }],
  ])("refuses an invalid target without requesting it: %s", async (_label, patch) => {
    const fetch = serving(SMALL);
    const result = await fetchScene({ ...target(SMALL, 1), ...patch }, TOKEN, { fetch });
    expect(result).toEqual({ kind: "failed", reason: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a rejected fetch is a network failure; an aborted one is aborted", async () => {
    const network = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: vi.fn<FetchLike>(() => Promise.reject(new TypeError("Failed to fetch"))),
    });
    expect(network).toEqual({ kind: "failed", reason: "network" });
    const controller = new AbortController();
    const pending = fetchScene(target(SMALL, 1), TOKEN, {
      fetch: hanging(),
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
  });

  it("a body that stalls is ended by the watchdog as a network failure", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<FetchLike>(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(glb(SMALL).slice(0, 1000)); // then silence
            init.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(body, { headers: { "Content-Length": "3400" } });
      });
      const pending = fetchScene(target(SMALL, 1), TOKEN, { fetch, stallTimeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_900);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toEqual({ kind: "failed", reason: "network" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("every received part re-arms the watchdog: a slow but steady body completes", async () => {
    vi.useFakeTimers();
    try {
      const parts = [0, 850, 1700, 2550].map((at) => glb(SMALL).slice(at, at + 850));
      const fetch = vi.fn<FetchLike>(async () => {
        let next = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                if (next < parts.length) controller.enqueue(parts[next++]!);
                else controller.close();
                resolve();
              }, 4_000),
            ),
        });
        return new Response(body, { headers: { "Content-Length": "3400" } });
      });
      const pending = fetchScene(target(SMALL, 1), TOKEN, { fetch, stallTimeoutMs: 5_000 });
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(4_000);
      vi.useRealTimers(); // the SHA-256 runs on real time
      expect((await pending).kind).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abort while hashing returns aborted, not ready", async () => {
    const controller = new AbortController();
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL),
      signal: controller.signal,
      sha256: async () => {
        controller.abort();
        return manifest.files[SMALL]!.sha256;
      },
    });
    expect(result).toEqual({ kind: "aborted" });
  });

  it("skips the Content-Length check for a content-encoded body (the hash still decides)", async () => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL, { headers: { "Content-Length": "1234", "Content-Encoding": "gzip" } }),
    });
    expect(result.kind).toBe("ready");
  });

  it("caps maxSnapshotBytes at the 64 MiB hard limit (§3.3)", async () => {
    const fetch = serving(SMALL);
    const result = await fetchScene(
      { ...target(SMALL, 1), byteLength: 64 * 1024 * 1024 + 1 },
      TOKEN,
      { fetch, maxSnapshotBytes: 2 ** 30 },
    );
    expect(result).toEqual({ kind: "tooLarge", byteLength: 64 * 1024 * 1024 + 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a throwing progress callback does not fail the download", async () => {
    const result = await fetchScene(target(SMALL, 1), TOKEN, {
      fetch: serving(SMALL),
      onProgress: () => {
        throw new Error("ui bug");
      },
    });
    expect(result.kind).toBe("ready");
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, clamps to 1…120 s and falls back to the default", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBe(1);
    expect(parseRetryAfter("9999")).toBe(120);
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseRetryAfter("Sun, 18 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter(null)).toBe(DEFAULT_RETRY_AFTER_S);
    expect(parseRetryAfter("soon")).toBe(DEFAULT_RETRY_AFTER_S);
  });
});
