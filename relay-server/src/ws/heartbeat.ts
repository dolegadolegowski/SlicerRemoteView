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
 * while each interval shows a sign of life that explains it:
 * - the relay paused the socket's reading (the fan-out pauses publishers, at most 5 s at a time) and
 *   the peer kept sending text or binary frames, which its pong may be queued behind;
 * - the socket's send buffer shrank since the last tick: the peer is reading, and the ping may still
 *   be queued behind older data (the fan-out's slow-consumer rules decide about slow sockets).
 * A dead peer shows neither for long — the buffers in between fill once — so it is closed within
 * about two ticks even while the fan-out pauses it.
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
  /** How many times reading was paused (`Connection.pauseCount`). */
  readonly pauseCount: number;
  /** Reading is paused right now. */
  readonly readingPaused: boolean;
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
  /** `pauseCount` at the last tick. */
  pauses: number;
  /** `bufferedAmount` at the last tick (before a ping it sent): the next tick excuses if it shrank. */
  backlog: number;
  /** The peer sent a text or binary frame since the last tick. */
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
    const paused = socket.readingPaused || socket.pauseCount !== watch.pauses;
    return (paused && watch.heard) || socket.bufferedAmount < watch.backlog;
  }

  function check(socket: Pingable, watch: Watch): void {
    if (!socket.isOpen) return;
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
    watch.pauses = socket.pauseCount;
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
      watched.set(socket, {
        payload: undefined,
        pauses: socket.pauseCount,
        backlog: 0,
        heard: false,
      });
    },
    /** The socket sent a pong: it counts if it echoes the outstanding ping. */
    pong(socket: Pingable, data: Buffer): void {
      const watch = watched.get(socket);
      if (watch?.payload?.equals(data) === true) watch.payload = undefined;
    },
    /** The socket sent a text or binary frame (a sign of life while its reading is paused). */
    heard(socket: Pingable): void {
      const watch = watched.get(socket);
      if (watch !== undefined) watch.heard = true;
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
