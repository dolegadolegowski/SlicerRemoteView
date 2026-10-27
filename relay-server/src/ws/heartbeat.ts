/**
 * WebSocket-level heartbeat (docs/protocol.md §9.1, §9.3; architecture §2.6, §5): every
 * `RELAY_PING_INTERVAL_S` each socket gets a WS ping with a fresh random payload. A socket that has
 * not answered it by the next tick gets close `4009` (it goes out where the socket can still take it)
 * and is terminated at once — at most about 60 s of silence. Only a pong that echoes the ping's
 * payload counts (RFC 6455 §5.5.3): a client that sends unsolicited pongs but reads nothing is still
 * closed. Browsers answer WS pings themselves (web.md §5), so does `ws` (`autoPong`, on by default:
 * https://github.com/websockets/ws/blob/master/doc/ws.md); the publisher's and the Quest app's
 * clients (SLC-08, QST-06) are expected to as well `[TODO verify]`.
 *
 * A missing pong is excused one interval at a time, its ping still outstanding (a late echo counts),
 * while the interval shows another sign of life (report 2026-10-20-slicer-7, SRV-27):
 * - a publisher sent a complete text or binary frame since the last tick: its uplink works, and its
 *   pong may be queued behind its own upload (TCP keeps the order) or behind a fan-out pause of its
 *   reading. Not a viewer: it only sends small text frames, which never hold its pong back for a tick,
 *   and a viewer that pinged on but read nothing would keep its slot and the relay's queues for it,
 *   kernel ones included, which no budget sees (T3);
 * - the socket's send buffer shrank since the last tick: the peer is reading, and the ping may still
 *   be queued behind older data (the fan-out's slow-consumer rules decide about slow sockets).
 * Pongs that echo no ping, WebSocket pings and partial frames are no sign of life. A peer without a
 * frame (a publisher's), an echo or a shrinking send buffer is closed at the second tick: at most
 * about 60 s, also while the fan-out pauses it. A publisher that keeps sending but reads nothing is
 * no longer closed here: it holds up to 1 MiB of send buffer (then the fan-out closes it `4010`)
 * plus what the kernel queues for it, for at most `MAX_SESSIONS` publishers (SRV-25 follow-up).
 *
 * A socket no longer open at a tick whose peer started the close (a close frame, or a TCP half-close,
 * after which `ws` arms no timer at all) is handed to `close()`, which drops it unless the close
 * completes (`Connection.close`, T3): after a half-close it would otherwise keep its viewer slot and
 * send buffer for good. A close the relay started is already bounded there.
 */
import { randomBytes } from "node:crypto";
import { CLOSE_CODES, LIMITS } from "@slicerremoteview/shared";
import type { Logger } from "pino";
import type { Clock, TimerHandle } from "../clock.js";

export const RELAY_PING_INTERVAL_MS = LIMITS.RELAY_PING_INTERVAL_S * 1000;
const PING_PAYLOAD_BYTES = 8;

/** What the heartbeat needs of a socket (`Connection`). */
export interface Pingable {
  readonly id: number;
  readonly isOpen: boolean;
  /** Bytes queued for the peer and not yet handed to the network. */
  readonly bufferedAmount: number;
  /** For the timeout log line: ids only, safe to log (NFR-12). */
  readonly role?: string | undefined;
  readonly session?: { readonly id: string } | undefined;
  readonly viewer?: { readonly id: string } | undefined;
  ping(payload: Buffer): void;
  close(closeCode: number): void;
  terminate(): void;
}

interface Watch {
  /** The payload of the ping still unanswered, if any. */
  payload: Buffer | undefined;
  /** `bufferedAmount` at the last tick (before a ping it sent): the next tick excuses if it shrank. */
  backlog: number;
  /** The publisher sent a text or binary frame since the last tick (`heard`). */
  heard: boolean;
}

export function heartbeat({
  clock,
  logger,
  intervalMs = RELAY_PING_INTERVAL_MS,
}: {
  clock: Clock;
  logger: Logger;
  intervalMs?: number;
}) {
  const watched = new Map<Pingable, Watch>();
  let timer: TimerHandle | undefined;
  let disposed = false;

  /** An unanswered ping that is not (yet) the socket's fault (see the module comment). */
  function excused(socket: Pingable, watch: Watch): boolean {
    return watch.heard || socket.bufferedAmount < watch.backlog;
  }

  function check(socket: Pingable, watch: Watch): void {
    if (!socket.isOpen) {
      watched.delete(socket);
      socket.close(CLOSE_CODES.HEARTBEAT_TIMEOUT); // no frame for a closing socket, only the timer
      return;
    }
    if (watch.payload !== undefined && !excused(socket, watch)) {
      watched.delete(socket);
      logger.info(
        {
          connection: socket.id,
          role: socket.role ?? "none",
          ...(socket.session !== undefined && { sessionId: socket.session.id }),
          ...(socket.viewer !== undefined && { viewerId: socket.viewer.id }),
          errorCode: "HEARTBEAT_TIMEOUT",
        },
        "no pong: closed",
      );
      socket.close(CLOSE_CODES.HEARTBEAT_TIMEOUT);
      // A dead peer never answers the close: `ws` would wait 30 s more (§9.1: at most 60 s).
      socket.terminate();
      return;
    }
    // What the next tick compares against.
    watch.backlog = socket.bufferedAmount;
    watch.heard = false;
    if (watch.payload !== undefined) return;
    watch.payload = randomBytes(PING_PAYLOAD_BYTES);
    socket.ping(watch.payload);
  }

  function tick(): void {
    for (const [socket, watch] of [...watched])
      try {
        check(socket, watch);
      } catch {
        // One socket's failure must not stop the others; never the error itself (it could carry anything).
        logger.error({ connection: socket.id, errorCode: "INTERNAL" }, "heartbeat check failed");
      }
  }

  return {
    /** Starts watching a socket once its upgrade is done. */
    add(socket: Pingable): void {
      watched.set(socket, { payload: undefined, backlog: 0, heard: false });
    },
    /** The socket sent a pong: it counts if it echoes the outstanding ping. */
    pong(socket: Pingable, data: Buffer): void {
      const watch = watched.get(socket);
      if (watch?.payload?.equals(data) === true) watch.payload = undefined;
    },
    /**
     * The socket sent a complete text or binary frame: a sign of life of a publisher (never a pong,
     * a ping or a viewer's frame, see the module comment).
     */
    heard(socket: Pingable): void {
      const watch = watched.get(socket);
      if (watch !== undefined && socket.role === "publisher") watch.heard = true;
    },
    /** The socket is gone. */
    remove(socket: Pingable): void {
      watched.delete(socket);
    },
    /** Ticks every `intervalMs` on the injected clock until `dispose()`. */
    start(): void {
      const arm = (): void => {
        timer = clock.setTimeout(() => {
          tick();
          if (!disposed) arm();
        }, intervalMs);
        (timer as { unref?: () => void }).unref?.();
      };
      if (timer === undefined) arm();
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      watched.clear();
    },
    /** Sockets watched (tests). */
    get size(): number {
      return watched.size;
    },
  };
}
