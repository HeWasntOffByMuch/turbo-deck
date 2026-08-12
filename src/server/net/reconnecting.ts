/**
 * A channel that comes back (spec 150).
 *
 * `transport.ts` says why this is not a change to `Channel` itself: the
 * interface is "the smallest thing both implementations can honestly provide",
 * and a loopback channel would have to lie about reconnection. So this sits
 * *above* it -- one stable `Channel` upward, a fresh inner one per attempt
 * downward -- and `LoopbackChannel` goes on telling the truth.
 *
 * The contract worth stating, because it is the whole difference: **`onClose`
 * fires when this wrapper gives up, not when a socket drops.** From above, this
 * is one channel that survives outages. A caller that wants to know about the
 * outages themselves reads `onPhase`.
 *
 * Backoff is driven off the sim tick rather than a timer, for the same reason
 * `UnreliableChannel` is: it makes the whole thing pure and lets a test drive
 * it with a loop instead of a fake clock.
 */

import type { Channel } from './transport.js';
import type { ConnectionPhase } from './transport-browser.js';

/**
 * Half a second, one, two, four, eight -- about fifteen seconds in total.
 *
 * Sized against the server's `RESUME_GRACE_TICKS` (1800, thirty seconds): a
 * client that is going to come back has come back well inside the window its
 * body is being held open for. Longer would be waiting for a session that has
 * already been reaped.
 */
export const DEFAULT_BACKOFF_TICKS: readonly number[] = [30, 60, 120, 240, 480];

export interface ReconnectOptions {
  /** Opens a fresh inner channel. Called once per attempt. */
  readonly open: () => Channel;
  /**
   * A fresh inner channel is live. The caller says hello again here -- this
   * wrapper deliberately knows nothing about the protocol crossing it.
   */
  readonly onReopen?: () => void;
  readonly onPhase?: (phase: ConnectionPhase) => void;
  readonly backoffTicks?: readonly number[];
}

export class ReconnectingChannel implements Channel {
  private inner: Channel;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private attempt = 0;
  private retryAtTick = -1;
  private tick = 0;
  private givenUp = false;
  private readonly backoff: readonly number[];

  constructor(private readonly options: ReconnectOptions) {
    this.backoff = options.backoffTicks ?? DEFAULT_BACKOFF_TICKS;
    this.inner = this.openInner();
  }

  private openInner(): Channel {
    const channel = this.options.open();
    channel.onMessage((bytes) => this.messageHandler?.(bytes));
    channel.onClose(() => this.innerClosed());
    return channel;
  }

  private innerClosed(): void {
    if (this.givenUp) return;
    const wait = this.backoff[this.attempt];
    if (wait === undefined) {
      // Out of attempts. This is the one moment the caller above hears a close.
      this.givenUp = true;
      this.retryAtTick = -1;
      this.options.onPhase?.('closed');
      this.closeHandler?.();
      return;
    }
    this.attempt += 1;
    this.retryAtTick = this.tick + wait;
    this.options.onPhase?.('connecting');
  }

  get isOpen(): boolean {
    return !this.givenUp && this.inner.isOpen;
  }

  /** Dropped while the socket is down. See the note in `deliver`. */
  send(bytes: Uint8Array): void {
    // Dropped only while we are *waiting to retry* -- a known outage. Not
    // simply whenever the inner channel is closed: `BrowserSocketChannel` is
    // legitimately not open between construction and its `open` event, and it
    // queues across that gap on purpose, because `GameClient` sends its
    // `Hello` from the constructor. Second-guessing it there silently ate the
    // handshake and the world never arrived.
    if (this.givenUp || this.retryAtTick >= 0) return;
    this.inner.send(bytes);
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    // An explicit close is not something to reconnect from.
    this.givenUp = true;
    this.retryAtTick = -1;
    this.inner.close();
  }

  /** Attempts so far in the current outage. Zero once a connection is live. */
  get attempts(): number {
    return this.attempt;
  }

  /**
   * Advance the backoff, and open the next attempt when it comes due.
   *
   * Frames written while the socket is down are dropped rather than queued.
   * That is deliberate: an input from four seconds ago is not worth applying
   * when the connection returns, and the server re-sends the whole world to a
   * resumed session anyway. `transport-browser.ts` queues because its gap is
   * one handshake long; this gap is an outage.
   */
  deliver(tick: number): void {
    this.tick = tick;
    if (this.givenUp || this.retryAtTick < 0 || tick < this.retryAtTick) return;
    this.retryAtTick = -1;
    this.inner = this.openInner();
    // The attempt counter resets on a *successful* reopen rather than here, so
    // a socket that opens and immediately dies still walks up the ladder.
    if (this.inner.isOpen) {
      this.attempt = 0;
      this.options.onPhase?.('connected');
    }
    this.options.onReopen?.();
  }
}
