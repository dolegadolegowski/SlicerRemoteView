/**
 * Command-line options of `fake-slicer` (PRO-13). Parsing is pure: `parseCliArgs` returns the options or a
 * usage error, never exits and never touches the network, so the tests call it directly.
 */
import { parseArgs } from "node:util";
import { normalizeCode } from "@slicerremoteview/shared";

export const DEFAULT_RELAY = "ws://localhost:8787/ws";
export const PROFILES = ["mobile", "quest2", "quest3"] as const;
export type Profile = (typeof PROFILES)[number];

export interface Options {
  /** WebSocket endpoint of the relay (§3.1); `ws://` only on localhost. */
  relay: string;
  /** GLB to publish (PRO-14); `undefined` = the bundled `asymmetric-2nodes.glb`. */
  fixture: string | undefined;
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
  --fixture <glb>         GLB to publish (default: the bundled asymmetric-2nodes.glb)
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
      profile: profile as Profile,
      preferredCode,
      codeFd,
      json: values.json,
    },
  };
}
