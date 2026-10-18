// HTTP download of the relay's cached snapshot (WEB-06; docs/protocol.md §6.5, §10). No DOM, no three.js.
// `fetchScene()` is one `GET /api/scene/:sceneVersion`: pre-sized buffer, progress from the body stream,
// `Content-Length`/`ETag` checks, a stall watchdog and SHA-256 verification. `scene-loader.ts` decides when to
// call it and what each outcome means for the session.
//
// Privacy (CLAUDE.md rule 6, FR-31, NFR-15): the viewer token travels only in the `Authorization` header — the
// URL carries nothing but the validated scene version — and it is never logged.

import { MAX_SNAPSHOT_BYTES, sha256Hex } from "@slicerremoteview/shared";
import { DEFAULT_MAX_SNAPSHOT_BYTES } from "./connection";

/** The subset of `fetch` used here; tests pass a mock. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the relay announced (`viewer.joined.snapshot` or `scene.snapshot.ready`). */
export interface SceneTarget {
  readonly sceneVersion: number;
  readonly byteLength: number;
  readonly sha256: string;
}

/** `network` includes a body that stalled for `stallTimeoutMs`. */
export type FailureReason = "network" | "status" | "length" | "etag" | "invalid";

export type SceneFetchResult =
  | { readonly kind: "ready"; readonly sceneVersion: number; readonly bytes: Uint8Array }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "notFound" }
  | { readonly kind: "gone" }
  | { readonly kind: "rateLimited"; readonly retryAfterS: number }
  | { readonly kind: "tooLarge"; readonly byteLength: number }
  | { readonly kind: "checksumMismatch" }
  | { readonly kind: "failed"; readonly reason: FailureReason; readonly status?: number }
  | { readonly kind: "aborted" };

export interface FetchSceneOptions {
  readonly fetch?: FetchLike;
  /** SHA-256 as lowercase hex; default WebCrypto. */
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
  /** Largest snapshot this device accepts (same value as `viewer.join` announced). Default 32 MiB, max 64 MiB. */
  readonly maxSnapshotBytes?: number;
  /** Prefix of `/api/scene/…`; default `""` (same origin, ADR 0006). */
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  /** `received / byteLength`, strictly increasing, `0 < fraction ≤ 1`. */
  readonly onProgress?: (fraction: number) => void;
  /** No headers or no body bytes for this long → `failed{network}`. Default 20 s (dead mobile TCP connections). */
  readonly stallTimeoutMs?: number;
  /** Clock for `Retry-After` dates; default `Date.now`. */
  readonly now?: () => number;
}

/** Back-off used when a 429 carries no usable `Retry-After` (the limit is 30/min per token, §12). */
export const DEFAULT_RETRY_AFTER_S = 5;
export const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_S = 120;
const MAX_SCENE_VERSION = 0xffffffff; // uint32 (§8.4)

const isSha256 = (s: string) => /^[0-9a-f]{64}$/.test(s);

function validTarget(t: SceneTarget): boolean {
  return (
    Number.isSafeInteger(t.sceneVersion) &&
    t.sceneVersion >= 1 &&
    t.sceneVersion <= MAX_SCENE_VERSION &&
    Number.isSafeInteger(t.byteLength) &&
    t.byteLength >= 1 &&
    isSha256(t.sha256)
  );
}

/** Seconds from a `Retry-After` header (delta-seconds or HTTP-date), clamped to 1…120 s. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  let seconds = Number.NaN;
  if (value !== null && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
    else {
      const at = Date.parse(trimmed);
      if (!Number.isNaN(at)) seconds = Math.ceil((at - now) / 1000);
    }
  }
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(1, seconds));
}

/** `ETag` must be the quoted SHA-256 (§10); a weak validator (`W/`) from an intermediary is tolerated. */
function etagMatches(etag: string, sha256: string): boolean {
  const strong = etag.startsWith("W/") ? etag.slice(2) : etag;
  return strong === `"${sha256}"`;
}

/**
 * One `GET /api/scene/:sceneVersion` (§10). Never throws: every outcome is a `SceneFetchResult`. Nothing is
 * allocated before the status and headers passed, and the buffer is exactly `byteLength` bytes — a body that
 * runs longer is cancelled (T10). `Content-Length` (unless the body is content-encoded) and `ETag` are checked
 * when present; the SHA-256 of the body is always checked.
 */
export async function fetchScene(
  target: SceneTarget,
  viewerToken: string,
  options: FetchSceneOptions = {},
): Promise<SceneFetchResult> {
  const maxBytes = Math.min(
    options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_BYTES,
  );
  if (!validTarget(target) || viewerToken === "") return { kind: "failed", reason: "invalid" };
  if (target.byteLength > maxBytes) return { kind: "tooLarge", byteLength: target.byteLength };

  // The request runs on an internal controller so the stall watchdog can end it without the caller's signal.
  const { signal } = options;
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  let stall: ReturnType<typeof setTimeout> | undefined;
  const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(forward, stallMs);
  };
  try {
    return await download(target, viewerToken, options, controller.signal, arm, () => {
      clearTimeout(stall);
      stall = undefined;
    });
  } finally {
    clearTimeout(stall);
    signal?.removeEventListener("abort", forward);
  }
}

async function download(
  target: SceneTarget,
  viewerToken: string,
  options: FetchSceneOptions,
  requestSignal: AbortSignal,
  arm: () => void,
  disarm: () => void,
): Promise<SceneFetchResult> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const digest = options.sha256 ?? sha256Hex;
  const { sceneVersion, byteLength, sha256 } = target;
  const callerAborted = () => options.signal?.aborted === true;
  const interrupted = (): SceneFetchResult =>
    callerAborted() ? { kind: "aborted" } : { kind: "failed", reason: "network" };
  const progress = (fraction: number) => {
    try {
      options.onProgress?.(fraction);
    } catch {
      /* a broken progress handler must not fail the download */
    }
  };

  let response: Response;
  try {
    arm();
    response = await doFetch(`${options.baseUrl ?? ""}/api/scene/${sceneVersion}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${viewerToken}` },
      cache: "no-store",
      credentials: "omit",
      // A redirect would only ever point somewhere we did not ask for; do not follow it with the token.
      redirect: "error",
      signal: requestSignal,
    });
  } catch {
    return interrupted();
  }

  const drop = () => void response.body?.cancel().catch(() => undefined);
  switch (response.status) {
    case 200:
      break;
    case 401:
      drop();
      return { kind: "unauthorized" };
    case 404:
      drop();
      return { kind: "notFound" };
    case 410:
      drop();
      return { kind: "gone" };
    case 429:
      drop();
      return {
        kind: "rateLimited",
        retryAfterS: parseRetryAfter(response.headers.get("Retry-After"), options.now?.()),
      };
    default:
      drop();
      return { kind: "failed", reason: "status", status: response.status };
  }

  // With a content coding (gzip by a proxy) `Content-Length` is the encoded size; the body length still decides.
  const encoding = response.headers.get("Content-Encoding");
  const length = response.headers.get("Content-Length");
  if (
    length !== null &&
    (encoding === null || encoding.trim().toLowerCase() === "identity") &&
    Number(length) !== byteLength
  ) {
    drop();
    return { kind: "failed", reason: "length" };
  }
  const etag = response.headers.get("ETag");
  if (etag !== null && !etagMatches(etag, sha256)) {
    drop();
    return { kind: "failed", reason: "etag" };
  }

  const buffer = new Uint8Array(byteLength);
  let received = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      // A reader of a mocked or proxied body may ignore the fetch signal; cancel it explicitly.
      const cancel = () => void reader.cancel().catch(() => undefined);
      requestSignal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          arm();
          const { done, value } = await reader.read();
          if (requestSignal.aborted) return interrupted();
          if (done) break;
          if (value.byteLength === 0) continue;
          if (received + value.byteLength > byteLength) {
            cancel();
            return { kind: "failed", reason: "length" };
          }
          buffer.set(value, received);
          received += value.byteLength;
          progress(received / byteLength);
        }
      } finally {
        requestSignal.removeEventListener("abort", cancel);
      }
    } else {
      // Bodyless responses (some test environments): no streaming progress, same checks.
      const whole = new Uint8Array(await response.arrayBuffer());
      if (whole.byteLength > byteLength) return { kind: "failed", reason: "length" };
      buffer.set(whole);
      received = whole.byteLength;
      if (received > 0) progress(received / byteLength);
    }
  } catch {
    return interrupted();
  }
  disarm();
  if (received !== byteLength) return { kind: "failed", reason: "length" };

  let actual: string | null;
  try {
    actual = await digest(buffer);
  } catch {
    actual = null; // cannot verify (e.g. no WebCrypto): do not trust the bytes
  }
  if (callerAborted()) return { kind: "aborted" };
  if (actual !== sha256) return { kind: "checksumMismatch" };
  return { kind: "ready", sceneVersion, bytes: buffer };
}
