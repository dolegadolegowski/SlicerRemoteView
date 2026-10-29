// Runs the in-process relay stub of tools/fake-slicer (its own tests' relay) for the tests and manual §2 and §7: prints
// the stub's ws:// URL on one line, then answers commands read from stdin, one line each (below). When stdin closes it
// prints "<session.close messages> <heartbeat pings>" it received from publishers (e.g. "1 4"), followed by
// " v<sceneVersion>:<sha256>" for each snapshot whose binary chunks it received (the SHA-256 of the chunk payloads
// joined in order — a version that a re-created session uses again is merged), on a second line, and exits.
// With --report-updates a line follows: the JSON {"violations": [...], "updates": [[type, sceneVersion, baseVersion],
// ...]} of the stub's version checks (§6.2, §8.1, §8.4) and of every scene.update / scene.nodeRemoved /
// scene.nodeAdded it received, in order. With --report-sessions a last line follows: the JSON {"sessions": [...],
// "violations": [...]} with one entry per publisher handshake (SLC-46): {"first": "session.create" |
// "session.resume", "preferredCode": "none" | "previous" | "other" | null (a resume), "lastSceneVersion": n | null,
// "frames": [...]}, its frames as ["scene.snapshot.begin", v], ["chunk", v, i], ["scene.snapshot.end", v],
// [type, v, base] for updates, ["session.close"] or ["other"] — pings left out. "previous" means the code of the
// session before (also with --ignore-preferred-code). A snapshot cut by a drop shows as chunks without an end.
// Nothing printed holds a session code, token, session ID, node ID or payload.
// Commands: "restart" (forget the session, close everyone with 4008, §9.3), "close-publisher <code>" (close the
// publisher's socket with that WebSocket close code: 1000-1003, 1007-1014 or 3000-4999), "pongs on|off|
// off-until-handshake" (answer the publisher's pings, or not, or not until its next handshake: a dead link, §9.1),
// "status" ("ok <handshakes> <begins> <chunks> <ends> <updates>", counts only); each answers "ok…" or "error <why>".
// "restart" and "close-publisher" answer "ok" also when there is no session or publisher (the stub does not say).
// Usage: node relay_stub.mjs [--port <n>] [--report-updates] [--report-sessions] [--grace-ms <n>]
//   [--ignore-preferred-code] [<file URL of relay-stub.js>]
// --grace-ms keeps a session that long after its publisher's socket closed (the relay's PUBLISHER_GRACE_S, default 0:
// the session ends with the socket); --ignore-preferred-code never grants preferredCode (§4.1). Without a URL it loads
// tools/fake-slicer/dist/relay-stub.js of this checkout (any shell, any OS); --port keeps the address the same across
// runs (default: a random free port).
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const options = { port: 0 };
let reportUpdates = false;
let reportSessions = false;
let stubUrl = new URL("../../tools/fake-slicer/dist/relay-stub.js", import.meta.url).href;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") {
    i += 1;
    options.port = Number(args[i]);
  } else if (args[i] === "--report-updates") {
    reportUpdates = true;
  } else if (args[i] === "--report-sessions") {
    reportSessions = true;
  } else if (args[i] === "--grace-ms") {
    i += 1;
    options.publisherGraceMs = Number(args[i]);
  } else if (args[i] === "--ignore-preferred-code") {
    options.ignorePreferredCode = true;
  } else {
    stubUrl = args[i];
  }
}
const { startRelayStub } = await import(stubUrl);
// the stub reads options.answerPings for every ping, so "pongs" changes this same object
const stub = await startRelayStub(options);

// one entry per handshake; the stub pushes the first message of a connection before it handles it
const sessions = [];
let pongsUntilHandshake = false;
const pushHandshake = stub.handshakes.push.bind(stub.handshakes);
stub.handshakes.push = (message) => {
  const create = message.type === "session.create";
  const preferred = message.preferredCode;
  sessions.push({
    first: message.type,
    preferredCode: !create
      ? null
      : typeof preferred !== "string"
        ? "none"
        : preferred === stub.code
          ? "previous"
          : "other",
    lastSceneVersion: create ? null : (message.lastSceneVersion ?? null),
    start: stub.publisherFrames.length,
  });
  if (pongsUntilHandshake) {
    options.answerPings = true;
    pongsUntilHandshake = false;
  }
  return pushHandshake(message);
};

const parse = (frame) => {
  try {
    return JSON.parse(frame.data.toString());
  } catch {
    return {};
  }
};

/** A publisher frame as the session report shows it, or undefined for a ping. */
function describe(frame) {
  if (frame.binary) {
    if (frame.data.length < 12) return ["chunk"];
    return ["chunk", frame.data.readUInt32LE(4), frame.data.readUInt32LE(8)]; // §6.3 header: SRVC, version, index
  }
  const message = parse(frame);
  if (message.type === "ping") return undefined;
  if (message.type === "scene.snapshot.begin" || message.type === "scene.snapshot.end")
    return [message.type, message.sceneVersion];
  if (["scene.update", "scene.nodeRemoved", "scene.nodeAdded"].includes(message.type))
    return [message.type, message.sceneVersion, message.baseVersion];
  return message.type === "session.close" ? ["session.close"] : ["other"];
}

// the codes ws lets a server send (its isValidStatusCode)
const isSendableCloseCode = (code) =>
  Number.isInteger(code) &&
  ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));

function command(line) {
  const [name, argument] = line.trim().split(/\s+/);
  if (name === "restart") {
    stub.restart();
    return "ok";
  }
  if (name === "close-publisher") {
    const code = Number(argument);
    if (!isSendableCloseCode(code)) return "error bad code";
    stub.closePublisher(code);
    return "ok";
  }
  if (name === "pongs") {
    if (!["on", "off", "off-until-handshake"].includes(argument)) return "error bad argument";
    options.answerPings = argument === "on";
    pongsUntilHandshake = argument === "off-until-handshake";
    return "ok";
  }
  if (name === "status") {
    const types = stub.publisherFrames.filter((f) => !f.binary).map((f) => parse(f).type);
    const count = (type) => types.filter((t) => t === type).length;
    const chunks = stub.publisherFrames.filter((f) => f.binary).length;
    const begins = count("scene.snapshot.begin");
    const updates = count("scene.update") + count("scene.nodeRemoved") + count("scene.nodeAdded");
    return `ok ${stub.handshakes.length} ${begins} ${chunks} ${count("scene.snapshot.end")} ${updates}`;
  }
  return "error unknown command";
}

process.stdout.write(`${stub.url}\n`);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => process.stdout.write(`${command(line)}\n`));
input.on("close", async () => {
  const frames = stub.publisherFrames;
  const closes = frames.filter((f) => !f.binary && parse(f).type === "session.close").length;
  const snapshots = new Map();
  for (const frame of frames.filter((f) => f.binary && f.data.length >= 12)) {
    const version = frame.data.readUInt32LE(4); // §6.3 header: SRVC, sceneVersion, chunkIndex
    if (!snapshots.has(version)) snapshots.set(version, createHash("sha256"));
    snapshots.get(version).update(frame.data.subarray(12));
  }
  const digests = [...snapshots].map(([version, hash]) => ` v${version}:${hash.digest("hex")}`).join("");
  process.stdout.write(`${closes} ${stub.pings}${digests}\n`);
  if (reportUpdates) {
    const updates = frames
      .filter((frame) => !frame.binary)
      .map(parse)
      .filter((m) => ["scene.update", "scene.nodeRemoved", "scene.nodeAdded"].includes(m.type))
      .map((m) => [m.type, m.sceneVersion, m.baseVersion]);
    process.stdout.write(`${JSON.stringify({ violations: stub.versionViolations, updates })}\n`);
  }
  if (reportSessions) {
    const report = sessions.map((session, index) => {
      const end = index + 1 < sessions.length ? sessions[index + 1].start : frames.length;
      const described = frames.slice(session.start, end).map(describe).filter(Boolean);
      const { start, ...rest } = session;
      return { ...rest, frames: described };
    });
    process.stdout.write(`${JSON.stringify({ sessions: report, violations: stub.versionViolations })}\n`);
  }
  await stub.close();
  process.exit(0);
});
