/**
 * Test-only preload of the load smoke (SRV-21; never in the image): on `SIGUSR2` the relay runs a
 * full GC (`--expose-gc`) and prints its memory figures as one JSON line, so the smoke compares
 * memory after the buffers it released were really collected — RSS alone moves by tens of MiB with
 * V8's GC timing. The relay's stdin is a pipe from the smoke: when it ends, the smoke is gone and so
 * is this relay, whatever killed the smoke.
 */
const gc = (globalThis as { gc?: () => void }).gc;

process.on("SIGUSR2", () => {
  gc?.();
  // Backing stores of collected ArrayBuffers are swept after the GC itself.
  setImmediate(() => {
    gc?.();
    const { rss, arrayBuffers, heapUsed } = process.memoryUsage();
    process.stdout.write(
      `${JSON.stringify({ message: "load-smoke memory", rss, arrayBuffers, heapUsed })}\n`,
    );
  });
});

// SIGKILL, not process.exit(): the exit hook of the relay's logger flushes stdout with sonic-boom's
// flushSync, which retries EPIPE forever once the smoke stopped reading — the relay would hang there.
// SIGKILL runs no exit hooks, and the relay keeps nothing on disk.
const die = (): void => void process.kill(process.pid, "SIGKILL");
process.stdin.on("end", die);
process.stdin.resume();
// The smoke may die while this probe writes (EPIPE): the same way out, not an uncaught exception.
process.stdout.on("error", die);
