/**
 * A wire you can make bad on purpose (spec 147).
 *
 * Latency was already simulated here, five times, by copy: the same
 * `DelayLine` in three test files and two scripts, each holding every frame for
 * a fixed number of ticks. This is that class generalised, plus the three
 * things none of the copies could do -- lose a frame, reorder one, send one
 * twice -- and it is one wire so that fixing it fixes all five.
 *
 * The server has a path for each of those and nothing had ever executed them:
 * an input whose `seq` has already been applied is dropped (`server.ts:414`),
 * and the speed check widens its allowance by the sequence gap when frames go
 * missing (`server.ts:1189`). A reordered input is the only thing that reaches
 * the first, and a lost one the only thing that reaches the second.
 *
 * ## Deterministic, which is the entire point
 *
 * `prediction-harness.ts` refused jitter on the grounds that it "would make the
 * numbers a different story every run". That is an argument against jitter
 * drawn from an unseeded source. Every draw here comes from an `Rng` handed in
 * -- never constructed here, never a singleton -- so a jittered run replays
 * exactly, and a test can assert identical authoritative state across runs of a
 * connection that was losing 10% of its frames.
 *
 * Three rules hold that up:
 *
 *  1. **Every frame draws all three values, in a fixed order, whatever the
 *     conditions say.** Drawing only when a condition is switched on would make
 *     the draw *sequence* depend on the settings -- so turning loss up would
 *     silently change the jitter on every later frame, and two runs that
 *     differed in one number would differ in all of them. Two integers a frame
 *     buys a draw sequence that is a function of the frame count alone.
 *  2. **Release is in due-tick order, ties broken by arrival.** A real wire
 *     reorders and this one does too; delivering in arrival order would make
 *     jitter a delay that happened to vary, which is a different and much
 *     tamer thing.
 *  3. **A duplicate lands on the same tick as its original**, so the receiver
 *     sees the same bytes twice in one pump. The harshest reading and the
 *     cheapest.
 *
 * Pure: no clock, no socket, no DOM. `deliver` is handed the tick.
 */

import type { Rng } from '../../shared/prng.js';
import type { Channel } from './transport.js';

export interface WireConditions {
  /** One-way delay, applied in each direction, in sim ticks. */
  readonly delayTicks: number;
  /** Extra delay drawn uniformly from `0..jitterTicks`, per frame. */
  readonly jitterTicks: number;
  /** Chance in [0, 1] that a frame is never delivered. */
  readonly loss: number;
  /** Chance in [0, 1] that a frame is delivered twice. */
  readonly duplicate: number;
}

/** A wire that does nothing to the frames crossing it. */
export const PERFECT_WIRE: WireConditions = {
  delayTicks: 0,
  jitterTicks: 0,
  loss: 0,
  duplicate: 0,
};

export type WireDirection = 'in' | 'out';

/** Called as each frame is *delivered*, for a harness that wants to watch. */
export type FrameTap = (bytes: Uint8Array, direction: WireDirection) => void;

/**
 * Probabilities are drawn as integers so the comparison is exact and the same
 * on every engine. One in ten thousand is finer than anybody sets a slider.
 */
const PRECISION = 10_000;

interface Queued {
  /** The tick this is due to be delivered on. */
  readonly at: number;
  /** Arrival order, so a tie releases in the order it was sent. */
  readonly seq: number;
  readonly bytes: Uint8Array;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function wholeTicks(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export class UnreliableChannel implements Channel {
  private readonly outbound: Queued[] = [];
  private readonly inbound: Queued[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private tick = 0;
  private arrivals = 0;
  private rng: Rng;

  constructor(
    private readonly inner: Channel,
    private readonly conditions: () => WireConditions,
    rng: Rng,
    private readonly tap?: FrameTap,
  ) {
    this.rng = rng;
    inner.onMessage((bytes) => {
      this.enqueue(this.inbound, bytes);
    });
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(bytes: Uint8Array): void {
    // Copied for the same reason every other channel copies: the writer's arena
    // is reused for the next frame, and this one holds on to it for ticks.
    this.enqueue(this.outbound, new Uint8Array(bytes));
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): void {
    this.inner.close();
  }

  /** The tick this wire was last advanced to. For a harness that logs when. */
  get tickNow(): number {
    return this.tick;
  }

  /** Frames still in flight, both directions. For a harness that wants to drain. */
  get inFlight(): number {
    return this.outbound.length + this.inbound.length;
  }

  /**
   * Advance to `tick` and release everything now due.
   *
   * Called once per sim tick by whatever owns the clock -- a test's loop, the
   * Play tab's frame loop. Nothing in here reads the time itself.
   */
  deliver(tick: number): void {
    this.tick = tick;
    this.release(this.outbound, (bytes) => {
      this.tap?.(bytes, 'out');
      this.inner.send(bytes);
    });
    this.release(this.inbound, (bytes) => {
      this.tap?.(bytes, 'in');
      this.handler?.(bytes);
    });
  }

  /**
   * Roll for one frame and queue what survives.
   *
   * The three draws happen in this order every time, whatever the conditions
   * are -- see rule 1 at the top of the file. `jitter` is drawn even when the
   * frame has just been lost, because the alternative is a draw sequence that
   * depends on which frames were dropped.
   */
  private enqueue(queue: Queued[], bytes: Uint8Array): void {
    const conditions = this.conditions();

    const [lossRoll, afterLoss] = this.rng.nextInt(0, PRECISION - 1);
    const [dupRoll, afterDup] = afterLoss.nextInt(0, PRECISION - 1);
    const [jitter, afterJitter] = afterDup.nextInt(0, wholeTicks(conditions.jitterTicks));
    this.rng = afterJitter;

    if (lossRoll < clamp01(conditions.loss) * PRECISION) return;

    const at = this.tick + wholeTicks(conditions.delayTicks) + jitter;
    queue.push({ at, seq: this.arrivals++, bytes });
    if (dupRoll < clamp01(conditions.duplicate) * PRECISION) {
      queue.push({ at, seq: this.arrivals++, bytes });
    }
  }

  /**
   * Everything due, oldest due-tick first.
   *
   * Sorted rather than assumed in order: jitter means a frame sent later can be
   * due earlier, and that reordering is the only thing in this repo that
   * reaches the server's stale-sequence drop. The tie-break on arrival keeps
   * two frames due on the same tick in the order they were sent, so a wire with
   * no jitter behaves exactly like the `DelayLine` this replaces.
   */
  private release(queue: Queued[], deliver: (bytes: Uint8Array) => void): void {
    if (queue.length === 0) return;
    queue.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at - b.at));
    while ((queue[0]?.at ?? Infinity) <= this.tick) {
      const frame = queue.shift();
      if (!frame) break;
      deliver(frame.bytes);
    }
  }
}
