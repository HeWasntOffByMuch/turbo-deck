/**
 * The fixed-timestep driver (spec 056).
 *
 * This is the *only* part of the server that reads a clock. It converts real
 * elapsed time into a whole number of ticks and calls the sim that many times;
 * the sim itself never asks what time it is, which is what lets a recorded
 * input sequence be replayed at any speed and produce the same world. Exactly
 * the arrangement `src/render/loop.ts` has with the single-player sim, at a
 * different rate.
 *
 * Two protections against a stalled process:
 *
 *  - **catch-up cap.** After a long pause (a debugger, a GC hitch, a suspended
 *    laptop) the accumulator holds seconds of backlog. Running all of it would
 *    take longer than the backlog itself and fall further behind on every
 *    round -- the spiral of death -- so the backlog past the cap is discarded
 *    and reported instead.
 *  - **re-entrancy guard.** A tick that overruns its budget must not have a
 *    second tick start inside it.
 */

import { SERVER_TICK_MS } from './config.js';

export type TickHandler = (tick: number) => void;
export type Clock = () => number;

/** Ticks of backlog run in one catch-up burst before the rest is dropped. */
export const MAX_CATCHUP_TICKS = 5;

export interface TickLoopOptions {
  readonly tickMs?: number;
  readonly now?: Clock;
  /** Called when backlog had to be discarded, with how many ticks were lost. */
  readonly onLag?: (droppedTicks: number) => void;
}

export class TickLoop {
  private readonly tickMs: number;
  private readonly now: Clock;
  private readonly onLag: ((droppedTicks: number) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private accumulator = 0;
  private lastAt = 0;
  private running = false;
  private inTick = false;
  private tickCount = 0;

  constructor(
    private readonly onTick: TickHandler,
    options: TickLoopOptions = {},
  ) {
    this.tickMs = options.tickMs ?? SERVER_TICK_MS;
    this.now = options.now ?? (() => Date.now());
    this.onLag = options.onLag ?? null;
  }

  get ticks(): number {
    return this.tickCount;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastAt = this.now();
    this.accumulator = 0;
    // Polled at half the tick interval so the accumulator rarely has to wait a
    // full extra tick for its turn; the accumulator, not the timer, decides how
    // many ticks actually run.
    this.timer = setInterval(() => this.pump(), Math.max(1, Math.floor(this.tickMs / 2)));
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Advances by however much real time has passed. Public so a test can drive
   * the loop from a fake clock instead of waiting for wall time.
   */
  pump(): void {
    if (!this.running || this.inTick) return;
    const at = this.now();
    const elapsed = Math.max(0, at - this.lastAt);
    this.lastAt = at;
    this.accumulator += elapsed;

    let ran = 0;
    this.inTick = true;
    try {
      while (this.accumulator >= this.tickMs && ran < MAX_CATCHUP_TICKS) {
        this.accumulator -= this.tickMs;
        this.tickCount += 1;
        ran += 1;
        this.onTick(this.tickCount);
      }
    } finally {
      this.inTick = false;
    }

    if (this.accumulator >= this.tickMs) {
      const dropped = Math.floor(this.accumulator / this.tickMs);
      this.accumulator = 0;
      this.onLag?.(dropped);
    }
  }
}
