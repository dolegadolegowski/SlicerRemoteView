// A TCP proxy that limits the bytes per second from the client to the target (the "uplink"), for the slow-uplink test
// of test_transport.py and the throttled step of docs/testing/slicer.md §2. Bytes from the target pass unchanged.
// Usage: node throttle_proxy.mjs --target <host:port> [--listen <port>] [--rate <bytes per second>]
// Prints "127.0.0.1:<listen port>" on one line; when stdin closes it prints the bytes forwarded to the target and
// exits. Defaults: a random free port, 125000 bytes/s (1 Mbit/s). Test tool: it listens on the loopback interface and
// forwards to a loopback target only (it would carry the session in plain text). When a client closes, the bytes still
// queued for the target are dropped.
import net from "node:net";

const args = process.argv.slice(2);
let target = "";
let listenPort = 0;
let rate = 125_000;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--target") target = args[i + 1];
  else if (args[i] === "--listen") listenPort = Number(args[i + 1]);
  else if (args[i] === "--rate") rate = Number(args[i + 1]);
  else throw new Error(`unknown option ${args[i]}`);
}
const separator = target.lastIndexOf(":");
if (separator < 1 || !(rate > 0)) throw new Error("usage: --target <host:port> [--listen <port>] [--rate <bytes/s>]");
const targetHost = target.slice(0, separator);
const targetPort = Number(target.slice(separator + 1));
if (!["127.0.0.1", "localhost", "::1"].includes(targetHost) || !(targetPort > 0)) {
  throw new Error("the target must be a loopback address and port");
}

const HIGH_WATER = 65_536;
let forwarded = 0;
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  sockets.add(client).add(upstream);
  upstream.pipe(client); // the downlink is not limited
  // one chain of 10 ms ticks, each writing at most rate/100 bytes (a second chain would double the rate)
  const slice = Math.max(1, Math.floor(rate / 100));
  let queue = Buffer.alloc(0);
  let timer;
  let ticking = false;
  // like a router's buffer: the client is paused above 64 KiB queued, so TCP pushes back on the sender
  const pump = () => {
    ticking = false;
    if (queue.length === 0) return;
    const part = queue.subarray(0, slice);
    queue = queue.subarray(part.length);
    forwarded += part.length;
    upstream.write(part);
    if (client.isPaused() && queue.length <= HIGH_WATER / 4) client.resume();
    ticking = true;
    timer = setTimeout(pump, 10);
  };
  client.on("data", (data) => {
    queue = Buffer.concat([queue, data]);
    if (queue.length > HIGH_WATER) client.pause();
    if (!ticking) pump();
  });
  const close = () => {
    clearTimeout(timer);
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
  };
  client.on("close", close).on("error", close);
  upstream.on("close", close).on("error", close);
});
server.listen(listenPort, "127.0.0.1", () => {
  process.stdout.write(`127.0.0.1:${server.address().port}\n`);
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${forwarded}\n`);
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
