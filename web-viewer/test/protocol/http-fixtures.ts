// Shared helpers for the HTTP scene tests: fixtures from shared/fixtures/glb and WHATWG `Response` mocks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { FetchLike, SceneTarget } from "../../src/protocol/scene-http";

export const GLB_DIR = fileURLToPath(new URL("../../../shared/fixtures/glb/", import.meta.url));
export const manifest = JSON.parse(readFileSync(`${GLB_DIR}manifest.json`, "utf8")) as {
  files: Record<string, { byteLength: number; sha256: string }>;
};
export const glb = (name: string) => new Uint8Array(readFileSync(`${GLB_DIR}${name}`));
export const target = (name: string, sceneVersion: number): SceneTarget => ({
  sceneVersion,
  byteLength: manifest.files[name]!.byteLength,
  sha256: manifest.files[name]!.sha256,
});

export const TOKEN = "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw";
export const SMALL = "asymmetric-2nodes.glb";
export const LARGE = "large-synthetic.glb";

/** `toEqual` on multi-MiB typed arrays takes seconds; compare the bytes directly. */
export const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

export function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) parts.push(bytes.slice(at, at + size));
  return parts;
}

export interface ServeOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly partSize?: number;
  readonly sha256?: string;
}

/** A 200 response streaming `bytes` in parts, with the §10 headers unless overridden (`""` omits one). */
export function response(bytes: Uint8Array, options: ServeOptions = {}): Response {
  const status = options.status ?? 200;
  const parts = split(bytes, options.partSize ?? 1024);
  const body =
    status === 200
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        })
      : null;
  const headers: Record<string, string> =
    status === 200
      ? {
          "Content-Type": "model/gltf-binary",
          "Content-Length": String(bytes.byteLength),
          ETag: `"${options.sha256 ?? ""}"`,
          ...options.headers,
        }
      : { ...options.headers };
  for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
  return new Response(body, { status, headers });
}

export const serving = (name: string, options: ServeOptions = {}) =>
  vi.fn<FetchLike>(async () =>
    response(glb(name), { sha256: manifest.files[name]!.sha256, ...options }),
  );

/** A fetch that never answers until its signal aborts. */
export const hanging = () =>
  vi.fn<FetchLike>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
  );
