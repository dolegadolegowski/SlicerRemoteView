// Runs the in-process relay stub of tools/fake-slicer (its own tests' relay) for test_panel.py and manual §2: prints
// the stub's ws:// URL on one line; when stdin closes, prints "<session.close messages> <heartbeat pings>" it received
// from publishers (e.g. "1 4") on a second line and exits.
// Usage: node relay_stub.mjs [--port <n>] [<file URL of relay-stub.js>]
// Without a URL it loads tools/fake-slicer/dist/relay-stub.js of this checkout (any shell, any OS); --port keeps the
// address the same across runs (default: a random free port).
const args = process.argv.slice(2);
let port = 0;
let stubUrl = new URL("../../tools/fake-slicer/dist/relay-stub.js", import.meta.url).href;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") {
    i += 1;
    port = Number(args[i]);
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
  process.stdout.write(`${closes} ${stub.pings}\n`);
  await stub.close();
  process.exit(0);
});
