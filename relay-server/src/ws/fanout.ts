/**
 * Snapshot and update fan-out to viewers, and the send buffers of viewers and publishers
 * (docs/protocol.md §3.3 watermarks, §6.1–§6.5, §8, §9.3, §11; architecture §2.3, §4, §5).
 * Implements `SnapshotEvents` of `snapshot.ts`, `broadcast` for `state.ts` and `deliver` for
 * `viewer.ts`.
 *
 * - At an accepted `begin`, every connected viewer whose `bufferedAmount` is below the 4 MiB soft
 *   watermark is streamed: it gets the publisher's `begin`, each chunk and `end` as received, byte for
 *   byte (§11), and every chunk is the same `Buffer` for all of them (no copy per viewer, NFR-05).
 *   Viewers at or above it, and viewers that join mid-stream, are deferred.
 * - A streamed viewer at or above 4 MiB before a chunk gets no further chunks and is deferred.
 * - At an accepted `end`, the streamed viewers get `end`; every other connected viewer gets
 *   `scene.snapshot.ready` (it fetches over HTTP, §6.4 a/b, §6.5) and then `scene.state` (§8.3 b),
 *   which is empty there (`snapshot.ts` clears the state right before `completed`), both held to
 *   the limits below like a reply (`deliver`). The publisher's ack counts the streamed viewers and
 *   the deferred ones told.
 * - An abort reaches every viewer that got the `begin`: the publisher's own abort as received, the
 *   relay's as `scene.snapshot.abort{sceneVersion, reason}`.
 * - Slow consumers get `error SLOW_CONSUMER` and close `4010` (§9.3): above the 8 MiB hard watermark,
 *   or at or above the soft one for more than 60 s (`LIMITS.SLOW_CONSUMER_STUCK_S`). A publisher's
 *   socket is closed the same way above `PUBLISHER_BUFFER_LIMIT_BYTES` (1 MiB): it only gets replies,
 *   a few KiB at a time, and is not part of the sum below. The sum of all
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
 * - An accepted update frame (`ws/state.ts`, §8) goes to every connected viewer as received
 *   (`broadcast`), encoded once into one `Buffer` sent as a text frame (no copy per viewer, and
 *   `bufferedAmount` counts its bytes: `ws` counts a string in UTF-16 units). It is held to the same
 *   limits before it is sent, but cannot be deferred: a viewer it would take above the hard
 *   watermark is closed `4010` instead (it re-syncs on reconnect with the snapshot and
 *   `scene.state`), and for the budget the largest buffers are closed, whatever their size, until
 *   the sum plus the frame for every recipient fits.
 * - The relay's own messages to one viewer (`deliver`: `scene.state` after `viewer.joined`, the reply
 *   to `scene.request`, up to ≈ 0.65 MiB, `ws/viewer.ts`) are encoded once and held to the same
 *   limits, their bytes together.
 * - After `dispose()` (shutdown) nobody is closed any more (no timer may be armed): updates are not
 *   sent, and relay messages only to a viewer they leave within the hard watermark.
 * - A socket closed for another reason (`viewer.leave`, the session ending) leaves the registry at
 *   once and is not counted while its close completes: its chunk and update frames are shared
 *   `Buffer`s, and `Connection.close` drops it after 5 s unless its peer keeps reading.
 * Checked before every forwarded chunk, update, `scene.state` and `ready`, and every second
 * (`start`); the small messages left (`viewer.count`, aborts, `pong`s, a stream's `begin`/`end`) only
 * by the watch. Logs carry ids, byte counts and error codes only.
 */
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "../clock.js";
import type { Config } from "../config.js";
import type { CachedSnapshot, Peer, Registry, Session, Viewer } from "../registry.js";
import { encode } from "./connection.js";
import type { Outgoing } from "./connection.js";
import type { AbortReason, SnapshotEvents } from "./snapshot.js";
import { sceneState } from "./state.js";

export const SOFT_WATERMARK_BYTES = LIMITS.SLOW_CONSUMER_SOFT_BYTES;
export const HARD_WATERMARK_BYTES = LIMITS.SLOW_CONSUMER_HARD_BYTES;
export const STUCK_MS = LIMITS.SLOW_CONSUMER_STUCK_S * 1000;
export const WATCH_INTERVAL_MS = 1_000;
/** A slow consumer that has not completed its close by then is terminated. */
export const SLOW_CONSUMER_TERMINATE_MS = 5_000;
/**
 * A publisher's socket gets replies only (pongs, acks, `viewer.count`, renewals, errors): one holding
 * more than this has stopped reading. It caps what all publishers hold outside the viewers' budget
 * at `MAX_SESSIONS` × 1 MiB (T3).
 */
export const PUBLISHER_BUFFER_LIMIT_BYTES = 1024 * 1024;
/** The longest continuous pause of a publisher; it is then read for at least a watch interval. */
export const MAX_PAUSE_MS = 5_000;
/** At most one warning per minute about paused publishers. */
const PAUSE_WARN_INTERVAL_MS = 60_000;

type SlowReason = "HARD_WATERMARK" | "STUCK" | "BUDGET" | "PUBLISHER_LIMIT";

/** The `slow consumer closed` log line: ids, byte counts and the rule, nothing else (NFR-12). */
interface SlowLog {
  sessionId: string;
  viewerId?: string;
  role?: "publisher";
  bufferedBytes: number;
  reason: SlowReason;
}

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

  /** `error SLOW_CONSUMER` + `4010`, then terminated unless its close completes within 5 s. */
  function closeSlow(peer: Peer, log: SlowLog): void {
    closing.add(peer);
    peer.send({
      type: "error",
      code: "SLOW_CONSUMER",
      message: "the socket does not read fast enough; reconnect (§3.3)",
      retryable: true,
    });
    peer.close(CLOSE_CODES.SLOW_CONSUMER);
    // A slow consumer gets no longer, even while it reads (`Connection.close` allows a draining
    // peer up to 30 s); and `dispose()` terminates the ones still closing at once.
    const timer = clock.setTimeout(() => {
      terminations.delete(timer);
      peer.terminate?.();
    }, SLOW_CONSUMER_TERMINATE_MS);
    (timer as { unref?: () => void }).unref?.();
    terminations.set(timer, peer);
    logger.info({ ...log, errorCode: "SLOW_CONSUMER" }, "slow consumer closed");
  }

  function slowConsumer(consumer: Consumer, reason: SlowReason): void {
    const { session, viewer, peer } = consumer;
    streams.get(session)?.streaming.delete(peer);
    closeSlow(peer, {
      sessionId: session.id,
      viewerId: viewer.id,
      bufferedBytes: consumer.amount,
      reason,
    });
  }

  /**
   * Closes the largest send buffers, of any session, until Σ `bufferedAmount` plus `bytes` for each
   * socket of `targets` (about to get a frame of that size) is within the budget (architecture §4).
   * With `deferrable` (a chunk), a socket holding less than the frame is not closed: a target is
   * dropped from `targets` instead (deferred: `ready` after `end`), which frees its share; any other
   * would free next to nothing. Without it (an update, which every target must get), such sockets
   * are closed too, largest first, so that the sum stays within the budget after the send.
   */
  function enforceBudget(targets?: Map<Peer, Viewer>, bytes = 0, deferrable = true): void {
    const adding = targets === undefined ? 0 : bytes * targets.size;
    let total = totalBuffered(true) + adding;
    if (total <= budget) return;
    // Largest first; on a tie the one above the soft watermark for longest.
    const since = (peer: Peer): number => aboveSoftSince.get(peer) ?? Number.MAX_SAFE_INTEGER;
    const list = consumers().sort((a, b) => b.amount - a.amount || since(a.peer) - since(b.peer));
    for (const consumer of list) {
      if (total <= budget) break;
      const isTarget = targets?.has(consumer.peer) === true;
      const closes = deferrable
        ? consumer.amount > 0 && consumer.amount >= bytes // a smaller one is deferred instead
        : consumer.amount > 0 || isTarget; // an update cannot be deferred
      if (closes) {
        total -= consumer.amount + (isTarget ? bytes : 0);
        slowConsumer(consumer, "BUDGET");
        targets?.delete(consumer.peer);
      } else if (isTarget) {
        // Deferred (chunks only): `ready` after `end`.
        total -= bytes;
        targets?.delete(consumer.peer);
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

  /** Hard watermark and stuck viewers, publishers over their limit, the global budget, then the pause. */
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
    // A publisher that stops reading must not grow its socket's buffer either (T3).
    for (const session of registry.sessions()) {
      const publisher = session.publisher;
      if (publisher === undefined || closing.has(publisher)) continue;
      const amount = publisher.bufferedAmount;
      if (amount > PUBLISHER_BUFFER_LIMIT_BYTES)
        closeSlow(publisher, {
          sessionId: session.id,
          role: "publisher",
          bufferedBytes: amount,
          reason: "PUBLISHER_LIMIT",
        });
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
      enforceBudget(stream.streaming, frame.byteLength);
      // The same Buffer for every socket: `ws` only prepends its frame header (NFR-05).
      for (const peer of stream.streaming.keys()) peer.forward(frame);
      stream.chunkBytes = frame.byteLength;
      updatePause();
    },

    completed(session, snapshot, text) {
      const stream = streams.get(session);
      streams.delete(session);
      unpause(stream?.publisher);
      let viewersStreamed = 0;
      const deferred: Viewer[] = [];
      for (const viewer of session.viewers.values()) {
        const peer = viewer.peer;
        if (peer === undefined || closing.has(peer)) continue;
        if (
          stream?.sceneVersion === snapshot.sceneVersion &&
          stream.streaming.get(peer) === viewer
        ) {
          peer.forward(text);
          viewersStreamed += 1;
        } else deferred.push(viewer);
      }
      if (deferred.length === 0) return { viewersStreamed, viewersDeferred: 0 };
      // `ready`, then §8.3 (b)'s state: empty, since `snapshot.ts` clears it right before this.
      const now = clock.now();
      const frames = [readyMessage(snapshot), sceneState(session)].map((message) =>
        utf8Frame(encode(message, now)),
      );
      const told = admit(session, deferred, totalBytes(frames));
      for (const peer of told.keys()) for (const frame of frames) peer.forward(frame, true);
      return { viewersStreamed, viewersDeferred: told.size };
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

  /**
   * Sends an accepted update frame (`scene.update`, `scene.nodeRemoved`, `scene.nodeAdded`) to every
   * connected viewer of `session` as received (§11), within the hard watermark and the budget, its
   * WebSocket header included.
   */
  function broadcast(session: Session, text: string): void {
    if (disposed) return;
    const frame = utf8Frame(text);
    const recipients = admit(session, session.viewers.values(), wireBytes(frame));
    for (const peer of recipients.keys()) peer.forward(frame, true);
  }

  /**
   * Sends relay messages to one viewer (`scene.state`, and the `scene.snapshot.ready` before it in
   * a `scene.request` reply), each encoded once, within the limits of `broadcast`: their bytes are
   * admitted together. False when the relay did not send them (the viewer is gone, or closed `4010`
   * instead).
   */
  function deliver(session: Session, viewer: Viewer, messages: readonly Outgoing[]): boolean {
    const peer = viewer.peer;
    if (peer === undefined) return false;
    const now = clock.now();
    const frames = messages.map((message) => utf8Frame(encode(message, now)));
    if (!admit(session, [viewer], totalBytes(frames)).has(peer)) return false;
    for (const frame of frames) peer.forward(frame, true);
    return true;
  }

  /**
   * The sockets of `viewers` that may take `bytes` more now: one it would take above the hard
   * watermark is closed `4010` instead (an update or a reply cannot be deferred), then the budget
   * closes the largest buffers, whatever their size, until `bytes` for every recipient fits. After
   * `dispose()` such a socket is only left out, and the budget is not enforced.
   */
  function admit(session: Session, viewers: Iterable<Viewer>, bytes: number): Map<Peer, Viewer> {
    const recipients = new Map<Peer, Viewer>();
    for (const viewer of viewers) {
      const peer = viewer.peer;
      if (peer === undefined || closing.has(peer)) continue;
      const amount = peer.bufferedAmount;
      if (amount + bytes <= HARD_WATERMARK_BYTES) recipients.set(peer, viewer);
      else if (!disposed) slowConsumer({ session, viewer, peer, amount }, "HARD_WATERMARK");
    }
    if (!disposed) enforceBudget(recipients, bytes, false);
    return recipients;
  }

  /** Σ `bufferedAmount` over the connected viewer sockets (`/metrics`, SRV-19). */
  const bufferedBytes = (): number => totalBuffered(false);

  return { events, broadcast, deliver, overCapacity, bufferedBytes, start, dispose };
}

/**
 * The UTF-8 bytes of a text frame, in memory of its own: not a slice of Node's shared pool, which a
 * small frame would keep alive while it waits in a send buffer.
 */
function utf8Frame(text: string): Buffer {
  const frame = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  frame.write(text);
  return frame;
}

/** What `frame` adds to `bufferedAmount`: its bytes and the header `ws` puts before them. */
function wireBytes(frame: Buffer): number {
  return frame.byteLength + frameHeaderBytes(frame.byteLength);
}

/** What `frames` add to `bufferedAmount` together. */
function totalBytes(frames: readonly Buffer[]): number {
  return frames.reduce((sum, frame) => sum + wireBytes(frame), 0);
}

/**
 * The header `ws` puts before an unmasked frame of `length` bytes (RFC 6455 §5.2); `bufferedAmount`
 * counts it.
 */
function frameHeaderBytes(length: number): number {
  return length < 126 ? 2 : length < 65_536 ? 4 : 10;
}

/** `scene.snapshot.ready` of the cached snapshot (§6.4), at `end` and for `scene.request`. */
export function readyMessage(snapshot: CachedSnapshot) {
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
