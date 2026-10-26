// Runs the in-process relay stub of tools/fake-slicer (its own tests' relay) for the tests and manual §2: prints the
// stub's ws:// URL on one line; when stdin closes, prints "<session.close messages> <heartbeat pings>" it received from
// publishers (e.g. "1 4"), followed by " v<sceneVersion>:<sha256>" for each snapshot whose binary chunks it received
// (the SHA-256 of the chunk payloads joined in order — one publisher session assumed: a version reused by a later
// session would be merged), on a second line, and exits. With --report-updates a third line follows: the JSON
// {"violations": [...], "updates": [[type, sceneVersion, baseVersion], ...]} of the stub's version checks (§6.2, §8.1,
// §8.4) and of every scene.update / scene.nodeRemoved / scene.nodeAdded it received, in order.
// Usage: node relay_stub.mjs [--port <n>] [--report-updates] [<file URL of relay-stub.js>]
// Without a URL it loads tools/fake-slicer/dist/relay-stub.js of this checkout (any shell, any OS); --port keeps the
// address the same across runs (default: a random free port).
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
let port = 0;
let reportUpdates = false;
let stubUrl = new URL("../../tools/fake-slicer/dist/relay-stub.js", import.meta.url).href;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") {
    i += 1;
    port = Number(args[i]);
  } else if (args[i] === "--report-updates") {
    reportUpdates = true;
  } else {
    stubUrl = args[i];
  }
}
const { startRelayStub } = await import(stubUrl);
const stub = await startRelayStub({ port });
process.stdout.write(`${stub.url}\n`);
process.stdin.resume();
process.stdin.on("end", async () => {
  const closes = stub.publisherFrames.filter(
    (frame) => !frame.binary && JSON.parse(frame.data.toString()).type === "session.close",
  ).length;
  const snapshots = new Map();
  for (const frame of stub.publisherFrames.filter((f) => f.binary && f.data.length >= 12)) {
    const version = frame.data.readUInt32LE(4); // §6.3 header: SRVC, sceneVersion, chunkIndex
    if (!snapshots.has(version)) snapshots.set(version, createHash("sha256"));
    snapshots.get(version).update(frame.data.subarray(12));
  }
  const digests = [...snapshots].map(([version, hash]) => ` v${version}:${hash.digest("hex")}`).join("");
  process.stdout.write(`${closes} ${stub.pings}${digests}\n`);
  if (reportUpdates) {
    const updates = stub.publisherFrames
      .filter((frame) => !frame.binary)
      .map((frame) => JSON.parse(frame.data.toString()))
      .filter((m) => ["scene.update", "scene.nodeRemoved", "scene.nodeAdded"].includes(m.type))
      .map((m) => [m.type, m.sceneVersion, m.baseVersion]);
    process.stdout.write(`${JSON.stringify({ violations: stub.versionViolations, updates })}\n`);
  }
  await stub.close();
  process.exit(0);
});
