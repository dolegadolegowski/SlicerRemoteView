/**
 * Command-line options of `fake-slicer` (PRO-13). Parsing is pure: `parseCliArgs` returns the options or a
 * usage error, never exits and never touches the network, so the tests call it directly.
 */
import { parseArgs } from "node:util";
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, normalizeCode } from "@slicerremoteview/shared";

export const DEFAULT_RELAY = "ws://localhost:8787/ws";
export const PROFILES = ["mobile", "quest2", "quest3"] as const;
export type Profile = (typeof PROFILES)[number];

export interface Options {
  /** WebSocket endpoint of the relay (§3.1); `ws://` only on localhost. */
  relay: string;
  /** GLB to publish (PRO-14): a path or a bare name from `shared/fixtures/glb`; `undefined` = `asymmetric-2nodes.glb`. */
  fixture: string | undefined;
  /** Payload bytes per snapshot chunk, 64 KiB … 1 MiB (§6.2). */
  chunkSize: number;
  /** End the run with exit code 0 as soon as the snapshot is acknowledged (default: stay connected). */
  exitAfterAck: boolean;
  profile: Profile;
  /** Canonical code requested in `session.create.preferredCode` (§4.1), `null` = let the relay choose. */
  preferredCode: string | null;
  /** File descriptor (≥ 3) that receives the session code and join URL; the only place they are written. */
  codeFd: number | undefined;
  /** `--code-fd` output as one JSON object instead of a plain line. */
  json: boolean;
}

export type ParseResult =
  { kind: "run"; options: Options } | { kind: "help" } | { kind: "error"; message: string };

export const HELP = `fake-slicer — simulates 3D Slicer as a publisher of a SlicerRemoteView relay

Usage: fake-slicer [options]

Options:
  --relay <url>           relay WebSocket endpoint (default ${DEFAULT_RELAY}); ws:// only for localhost
  --fixture <glb>         GLB to publish: a path, or a file name from shared/fixtures/glb
                          (default: asymmetric-2nodes.glb)
  --chunk-size <bytes>    snapshot chunk payload, ${MIN_CHUNK_SIZE} … ${MAX_CHUNK_SIZE} (default ${MAX_CHUNK_SIZE}, §6.2)
  --exit-after-ack        exit 0 once the relay acknowledged the snapshot; by default the publisher stays
                          connected (so viewers can join) until Ctrl-C
  --profile <name>        ${PROFILES.join(" | ")} (default mobile); informational for viewers (§4.1)
  --preferred-code <c>    ask the relay for this 5-character code (§4.1); typed input is normalised
  --code-fd <n>           write the session code and join URL to file descriptor n (n >= 3). The code is
                          never printed to stdout/stderr, so CI logs stay free of it. Example:
                          fake-slicer --code-fd 3 3>code.txt
  --json                  with --code-fd: write {"code","url"} as JSON instead of "<code> <url>"
  -h, --help              show this help
`;

const isLocalhost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/** Validates `--relay`: a ws(s) URL without credentials, query or fragment; plain `ws://` only on localhost (§3.1). */
function checkRelay(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `--relay: "${value}" is not a URL`;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return "--relay: use ws:// or wss://";
  if (url.protocol === "ws:" && !isLocalhost(url.hostname))
    return "--relay: plain ws:// is allowed on localhost only (§3.1); use wss://";
  if (url.username || url.password || url.search || url.hash)
    return "--relay: no credentials, query or fragment — nothing secret travels in the URL (§3.1)";
  return null;
}

export function parseCliArgs(argv: readonly string[]): ParseResult {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        relay: { type: "string" },
        fixture: { type: "string" },
        "chunk-size": { type: "string" },
        "exit-after-ack": { type: "boolean", default: false },
        profile: { type: "string" },
        "preferred-code": { type: "string" },
        "code-fd": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
  if (values.help) return { kind: "help" };

  const relay = values.relay ?? DEFAULT_RELAY;
  const relayError = checkRelay(relay);
  if (relayError) return { kind: "error", message: relayError };

  const profile = values.profile ?? "mobile";
  if (!(PROFILES as readonly string[]).includes(profile))
    return { kind: "error", message: `--profile: expected ${PROFILES.join(" | ")}` };

  let preferredCode: string | null = null;
  if (values["preferred-code"] !== undefined) {
    const normalized = normalizeCode(values["preferred-code"]);
    if ("error" in normalized)
      return { kind: "error", message: `--preferred-code: ${normalized.hint}` };
    preferredCode = normalized.code;
  }

  let chunkSize: number = MAX_CHUNK_SIZE;
  if (values["chunk-size"] !== undefined) {
    chunkSize = Number(values["chunk-size"]);
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE)
      return {
        kind: "error",
        message: `--chunk-size: expected an integer ${MIN_CHUNK_SIZE} … ${MAX_CHUNK_SIZE} (§6.2)`,
      };
  }

  let codeFd: number | undefined;
  if (values["code-fd"] !== undefined) {
    const fd = Number(values["code-fd"]);
    if (!Number.isInteger(fd) || fd < 3)
      return {
        kind: "error",
        message: "--code-fd: expected an integer >= 3 (0-2 are the terminal)",
      };
    codeFd = fd;
  }
  if (values.json && codeFd === undefined)
    return { kind: "error", message: "--json only applies to --code-fd output" };

  return {
    kind: "run",
    options: {
      relay,
      fixture: values.fixture,
      chunkSize,
      exitAfterAck: values["exit-after-ack"],
      profile: profile as Profile,
      preferredCode,
      codeFd,
      json: values.json,
    },
  };
}
