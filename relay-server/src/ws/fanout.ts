/**
 * Snapshot fan-out to viewers and their send buffers (docs/protocol.md §3.3 watermarks, §6.1–§6.5,
 * §9.3, §11; architecture §2.3, §4, §5). Implements `SnapshotEvents` of `snapshot.ts`.
 *
 * - At an accepted `begin`, every connected viewer whose `bufferedAmount` is below the 4 MiB soft
 *   watermark is streamed: it gets the publisher's `begin`, each chunk and `end` as received, byte for
 *   byte (§11), and every chunk is the same `Buffer` for all of them (no copy per viewer, NFR-05).
 *   Viewers at or above it, and viewers that join mid-stream, are deferred.
 * - A streamed viewer at or above 4 MiB before a chunk gets no further chunks and is deferred.
 * - At an accepted `end`, the streamed viewers get `end`; every other connected viewer gets
 *   `scene.snapshot.ready` (it fetches over HTTP, §6.4 a/b, §6.5); the publisher's ack counts both.
 * - An abort reaches every viewer that got the `begin`: the publisher's own abort as received, the
 *   relay's as `scene.snapshot.abort{sceneVersion, reason}`.
 * - Slow consumers get `error SLOW_CONSUMER` and close `4010` (§9.3): above the 8 MiB hard watermark,
 *   or at or above the soft one for more than 60 s (`LIMITS.SLOW_CONSUMER_STUCK_S`). The sum of all
 *   viewers' `bufferedAmount` (plus what a chunk is about to add) must stay within
 *   `MAX_TOTAL_BUFFERED_BYTES`; above it the largest send buffers are closed `4010` until it fits
 *   (architecture §4). A socket that holds less than the chunk is not worth closing: a streamed one
 *   is deferred instead (that frees the chunk), any other is left alone. A viewer closed here no
 *   longer counts for that; its socket still holds the bytes until it is gone, and one whose client
 *   does not complete the close within 5 s is terminated (otherwise `ws` would wait its 30 s
 *   `closeTimeout`).
 * - While the sum over the connected viewer sockets, those closed here included, is at or above the
 *   budget, a publisher is not read (`pauseReading`, architecture §5) only if its snapshot is in
 *   flight and its own streamed viewers hold at least one of its chunks: those are the frames filling
 *   the buffers. Every other publisher keeps being read. A pause ends below the budget, when that
 *   publisher no longer qualifies, or after 5 s at the next watch; it is then read for at least a
 *   second, so its `ping`s are answered within the clients' 10 s (§9.1).
 * - New viewers are refused `CAPACITY` (`overCapacity`, §5.2) while the live sockets' buffers (not
 *   those closed here, which are on their way out) are at or above the budget.
 * - A socket closed for another reason (`viewer.leave`, the session ending) leaves the registry at
 *   once and is not counted while its close completes (its chunks are the shared `Buffer`s).
 * Checked before every forwarded chunk and every second (`start`). Logs carry ids, byte counts and
 * error codes only.
 */
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "../clock.js";
import type { Config } from "../config.js";
import type { CachedSnapshot, Peer, Registry, Session, Viewer } from "../registry.js";
import type { AbortReason, SnapshotEvents } from "./snapshot.js";

export const SOFT_WATERMARK_BYTES = LIMITS.SLOW_CONSUMER_SOFT_BYTES;
export const HARD_WATERMARK_BYTES = LIMITS.SLOW_CONSUMER_HARD_BYTES;
export const STUCK_MS = LIMITS.SLOW_CONSUMER_STUCK_S * 1000;
export const WATCH_INTERVAL_MS = 1_000;
/** A slow consumer that has not completed its close by then is terminated. */
export const SLOW_CONSUMER_TERMINATE_MS = 5_000;
/** The longest continuous pause of a publisher; it is then read for at least a watch interval. */
export const MAX_PAUSE_MS = 5_000;
/** At most one warning per minute about paused publishers. */
const PAUSE_WARN_INTERVAL_MS = 60_000;

type SlowReason = "HARD_WATERMARK" | "STUCK" | "BUDGET";

/** The snapshot in flight of one session, as the viewers see it. */
interface Stream {
  sceneVersion: number;
  /** Sockets that got the `begin` (an abort reaches them). */
  begun: Set<Peer>;
  /** Sockets still getting every chunk, with their viewer (a rejoin gives a viewer a new socket). */
  streaming: Map<Peer, Viewer>;
  /** Size of the last chunk frame forwarded (0 before the first). */
  chunkBytes: number;
  /** The publisher whose frames these are (the session may have dropped it by the time it ends). */
  publisher: Peer | undefined;
}

interface Consumer {
  session: Session;
  viewer: Viewer;
  peer: Peer;
  amount: number;
}

export interface FanoutDeps {
  registry: Registry;
  config: Config;
  logger: Logger;
  clock: Clock;
}

export function fanout({ registry, config, logger, clock }: FanoutDeps) {
  const budget = config.maxTotalBufferedBytes;
  const streams = new Map<Session, Stream>();
  /** Sockets closed here as slow consumers: no more sends, no longer counted for evictions. */
  const closing = new WeakSet<Peer>();
  /** Since when a socket has been at or above the soft watermark. */
  const aboveSoftSince = new WeakMap<Peer, number>();
  /** Slow consumers closed here, terminated unless their close completes first. */
  const terminations = new Map<TimerHandle, Peer>();
  /** Publishers whose reading is paused here, with the time the pause began. */
  const pausedPublishers = new Map<Peer, number>();
  /** Publishers resumed after the longest pause: not paused again before this time. */
  const pauseHoldoff = new WeakMap<Peer, number>();
  let disposed = false;
  let lastPauseWarn = -Infinity;
  let watchTimer: TimerHandle | undefined;

  /** Every connected viewer socket not closed here, with its `bufferedAmount`. */
  function consumers(): Consumer[] {
    const list: Consumer[] = [];
    for (const session of registry.sessions())
      for (const viewer of session.viewers.values()) {
        const peer = viewer.peer;
        if (peer !== undefined && !closing.has(peer))
          list.push({ session, viewer, peer, amount: peer.bufferedAmount });
      }
    return list;
  }

  /** Σ `bufferedAmount` over the connected viewer sockets; `live`: without those closed here. */
  function totalBuffered(live: boolean): number {
    let total = 0;
    for (const session of registry.sessions())
      for (const viewer of session.viewers.values()) {
        const peer = viewer.peer;
        if (peer !== undefined && !(live && closing.has(peer))) total += peer.bufferedAmount;
      }
    return total;
  }

  function slowConsumer(consumer: Consumer, reason: SlowReason): void {
    const { session, viewer, peer } = consumer;
    closing.add(peer);
    streams.get(session)?.streaming.delete(peer);
    peer.send({
      type: "error",
      code: "SLOW_CONSUMER",
      message: "the viewer does not read fast enough; reconnect (§3.3)",
      retryable: true,
    });
    peer.close(CLOSE_CODES.SLOW_CONSUMER);
    // A client that reads nothing never answers the close: `ws` would keep its bytes for 30 s.
    const timer = clock.setTimeout(() => {
      terminations.delete(timer);
      peer.terminate?.();
    }, SLOW_CONSUMER_TERMINATE_MS);
    (timer as { unref?: () => void }).unref?.();
    terminations.set(timer, peer);
    logger.info(
      {
        sessionId: session.id,
        viewerId: viewer.id,
        bufferedBytes: consumer.amount,
        reason,
        errorCode: "SLOW_CONSUMER",
      },
      "slow consumer closed",
    );
  }

  /**
   * Closes the largest send buffers, of any session, until Σ `bufferedAmount` plus `chunkBytes` for
   * each socket of `stream.streaming` is within the budget (architecture §4). A socket holding less
   * than the chunk is not closed: a streamed one is deferred (`ready` after `end`), which frees the
   * chunk; any other would free next to nothing.
   */
  function enforceBudget(stream?: Stream, chunkBytes = 0): void {
    const adding = stream === undefined ? 0 : chunkBytes * stream.streaming.size;
    let total = totalBuffered(true) + adding;
    if (total <= budget) return;
    // Largest first; on a tie the one above the soft watermark for longest.
    const since = (peer: Peer): number => aboveSoftSince.get(peer) ?? Number.MAX_SAFE_INTEGER;
    const list = consumers().sort((a, b) => b.amount - a.amount || since(a.peer) - since(b.peer));
    for (const consumer of list) {
      if (total <= budget) break;
      const streamed = stream?.streaming.has(consumer.peer) === true;
      if (consumer.amount > 0 && consumer.amount >= chunkBytes) {
        total -= consumer.amount + (streamed ? chunkBytes : 0);
        slowConsumer(consumer, "BUDGET");
      } else if (streamed) {
        total -= chunkBytes;
        stream?.streaming.delete(consumer.peer);
      }
    }
  }

  /** Σ `bufferedAmount` over the sockets a stream still feeds. */
  function streamHolding(stream: Stream): number {
    let total = 0;
    for (const peer of stream.streaming.keys()) total += peer.bufferedAmount;
    return total;
  }

  /**
   * While the viewers' send buffers hold the whole budget, pauses the publishers whose streams fill
   * them (§5): a snapshot in flight whose streamed viewers hold at least one of its chunks. Resumes
   * the others, and any pause that has lasted `MAX_PAUSE_MS`. Every resumed publisher is then read
   * for at least a watch interval before it can be paused again, so the `ping`s queued in its socket
   * are answered (§9.1). Runs at every chunk and every watch.
   */
  function updatePause(): void {
    if (disposed) return;
    const now = clock.now();
    const wanted = new Set<Peer>();
    if (totalBuffered(false) >= budget)
      for (const stream of streams.values()) {
        const publisher = stream.publisher;
        if (publisher === undefined || (pauseHoldoff.get(publisher) ?? 0) > now) continue;
        if (streamHolding(stream) >= Math.max(1, stream.chunkBytes)) wanted.add(publisher);
      }
    for (const [publisher, since] of pausedPublishers) {
      if (wanted.delete(publisher) && now - since < MAX_PAUSE_MS) continue;
      pausedPublishers.delete(publisher);
      publisher.resumeReading?.();
      pauseHoldoff.set(publisher, now + WATCH_INTERVAL_MS);
    }
    for (const publisher of wanted) {
      publisher.pauseReading?.();
      pausedPublishers.set(publisher, now);
    }
    if (wanted.size > 0 && now - lastPauseWarn >= PAUSE_WARN_INTERVAL_MS) {
      lastPauseWarn = now;
      logger.warn(
        { errorCode: "CAPACITY", budgetBytes: budget },
        "publishers paused: MAX_TOTAL_BUFFERED_BYTES reached",
      );
    }
  }

  /** A stream that ended no longer holds its publisher back. */
  function unpause(publisher: Peer | undefined): void {
    if (publisher !== undefined && pausedPublishers.delete(publisher)) publisher.resumeReading?.();
  }

  function resumePublishers(): void {
    for (const publisher of pausedPublishers.keys()) publisher.resumeReading?.();
    pausedPublishers.clear();
  }

  /** Hard watermark and stuck viewers, the global budget, then the publishers' pause. */
  function watch(): void {
    const now = clock.now();
    for (const consumer of consumers()) {
      const { peer, amount } = consumer;
      if (amount > HARD_WATERMARK_BYTES) {
        slowConsumer(consumer, "HARD_WATERMARK");
        continue;
      }
      if (amount < SOFT_WATERMARK_BYTES) {
        aboveSoftSince.delete(peer);
        continue;
      }
      const since = aboveSoftSince.get(peer);
      if (since === undefined) aboveSoftSince.set(peer, now);
      else if (now - since > STUCK_MS) slowConsumer(consumer, "STUCK");
    }
    enforceBudget();
    updatePause();
  }

  const events: Required<SnapshotEvents> = {
    begun(session, sceneVersion, text) {
      if (disposed) return;
      const stream: Stream = {
        sceneVersion,
        begun: new Set(),
        streaming: new Map(),
        chunkBytes: 0,
        publisher: session.publisher,
      };
      for (const viewer of session.viewers.values()) {
        const peer = viewer.peer;
        if (peer === undefined || closing.has(peer)) continue;
        if (peer.bufferedAmount >= SOFT_WATERMARK_BYTES) continue; // deferred
        peer.forward(text);
        stream.begun.add(peer);
        stream.streaming.set(peer, viewer);
      }
      streams.set(session, stream);
    },

    chunk(session, frame) {
      const stream = streams.get(session);
      if (stream === undefined) return; // none after `dispose()`: `begun` makes none
      for (const [peer, viewer] of stream.streaming) {
        const amount = peer.bufferedAmount;
        if (viewer.peer !== peer || closing.has(peer)) stream.streaming.delete(peer);
        else if (amount > HARD_WATERMARK_BYTES)
          slowConsumer({ session, viewer, peer, amount }, "HARD_WATERMARK");
        else if (amount >= SOFT_WATERMARK_BYTES) stream.streaming.delete(peer); // deferred
      }
      enforceBudget(stream, frame.byteLength);
      // The same Buffer for every socket: `ws` only prepends its frame header (NFR-05).
      for (const peer of stream.streaming.keys()) peer.forward(frame);
      stream.chunkBytes = frame.byteLength;
      updatePause();
    },

    completed(session, snapshot, text) {
      const stream = streams.get(session);
      streams.delete(session);
      unpause(stream?.publisher);
      const ready = readyMessage(snapshot);
      let viewersStreamed = 0;
      let viewersDeferred = 0;
      for (const viewer of session.viewers.values()) {
        const peer = viewer.peer;
        if (peer === undefined || closing.has(peer)) continue;
        if (
          stream?.sceneVersion === snapshot.sceneVersion &&
          stream.streaming.get(peer) === viewer
        ) {
          peer.forward(text);
          viewersStreamed += 1;
        } else {
          peer.send(ready);
          viewersDeferred += 1;
        }
      }
      return { viewersStreamed, viewersDeferred };
    },

    aborted(session, sceneVersion, reason, text) {
      const stream = streams.get(session);
      if (stream?.sceneVersion !== sceneVersion) return;
      streams.delete(session);
      unpause(stream.publisher);
      for (const peer of stream.begun) {
        if (closing.has(peer)) continue;
        if (text !== undefined) peer.forward(text);
        else peer.send(abortMessage(sceneVersion, reason));
      }
    },
  };

  // A released session told its viewers itself (`session.closed`/`session.expired`).
  const released = (session: Session): void => {
    unpause(streams.get(session)?.publisher);
    streams.delete(session);
  };
  registry.on("released", released);

  /** Runs `watch()` every second on the injected clock until `dispose()`. */
  function start(intervalMs: number = WATCH_INTERVAL_MS): void {
    stopWatch();
    const arm = (): void => {
      watchTimer = clock.setTimeout(() => {
        try {
          watch();
        } catch {
          // Never the error itself: its text could carry anything.
          logger.error({ errorCode: "INTERNAL" }, "fan-out watch failed");
        } finally {
          if (!disposed) arm();
        }
      }, intervalMs);
      (watchTimer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  function stopWatch(): void {
    if (watchTimer !== undefined) clock.clearTimeout(watchTimer);
    watchTimer = undefined;
  }

  /**
   * Stops the watch, resumes paused publishers (their sockets must read the close handshake of a
   * shutdown), terminates the slow consumers still closing and detaches from the registry. The app
   * calls it before the server closes.
   */
  function dispose(): void {
    disposed = true;
    stopWatch();
    resumePublishers();
    for (const [timer, peer] of terminations) {
      clock.clearTimeout(timer);
      peer.terminate?.();
    }
    terminations.clear();
    streams.clear();
    registry.off("released", released);
  }

  /**
   * True while the live viewers' send buffers hold the whole budget: joins answer `CAPACITY` (§5.2).
   * Sockets closed here are left out: they are gone within `SLOW_CONSUMER_TERMINATE_MS`, and counting
   * them would let a chain of evictions refuse every join on the relay.
   */
  const overCapacity = (): boolean => totalBuffered(true) >= budget;

  return { events, overCapacity, start, dispose };
}

function readyMessage(snapshot: CachedSnapshot) {
  return {
    type: "scene.snapshot.ready",
    sceneVersion: snapshot.sceneVersion,
    byteLength: snapshot.byteLength,
    sha256: snapshot.sha256,
    format: "glb",
    extensionsRequired: snapshot.extensionsRequired,
  };
}

function abortMessage(sceneVersion: number, reason: AbortReason) {
  return { type: "scene.snapshot.abort", sceneVersion, reason };
}
