/**
 * What the frame rate actually is (spec 165).
 *
 * The number worth showing is not `1000 / lastFrame`. That is what most in-game
 * counters show and it is the least useful reading available: it swings by tens
 * of frames a second between two consecutive paints, so it is unreadable exactly
 * when something is wrong, and it says nothing at all about the thing a player
 * reports -- one frame in sixty taking 200ms. A run at a solid 60 with a hitch
 * every second and a run at a solid 60 look identical on it.
 *
 * So this keeps a window of frame *times* and reports four things from it:
 * the rate over the window, the mean, the worst single frame, and the 1% low.
 * The last two are where a stutter lives, and they are why the graph draws frame
 * time rather than frame rate -- a spike upward is a stall, and the eye finds it
 * far faster than a dip in a rate curve.
 *
 * Time is an argument, as everywhere else in this tree: `push` is handed the
 * frame's timestamp. It reads no clock, so a test drives a whole session --
 * including a hitch -- by handing it numbers, and the graph in a golden image is
 * the same graph every run.
 *
 * Pure: no DOM. The HUD draws `samples`; this knows nothing about pixels.
 */

/**
 * Frames kept.
 *
 * Two seconds at 144Hz, which is the rate that has to fit rather than 60 -- a
 * window sized in frames is a shorter *time* the faster the machine is, and the
 * reading that matters least is the one from the machine that is coping. Also
 * the graph's width in samples, so the graph is the window rather than a
 * separate decision.
 */
export const FRAME_WINDOW = 288;

/** Frame times above this are a stall rather than a slow frame, for the readout. */
export const STALL_MS = 50;

export interface FrameStats {
  /** Frames per second across the window. Zero until there are two frames. */
  readonly fps: number;
  readonly avgMs: number;
  /** The worst single frame in the window -- the hitch, if there was one. */
  readonly worstMs: number;
  /** The 1% low, in milliseconds. What "it stutters" means, as a number. */
  readonly p99Ms: number;
  /** Frames in the window that took longer than {@link STALL_MS}. */
  readonly stalls: number;
  /** Frame times, oldest first, for the graph. */
  readonly samples: readonly number[];
}

const EMPTY: FrameStats = {
  fps: 0,
  avgMs: 0,
  worstMs: 0,
  p99Ms: 0,
  stalls: 0,
  samples: [],
};

export class FrameMeter {
  private readonly window: number;
  private readonly times: number[] = [];
  private previous: number | null = null;

  constructor(window = FRAME_WINDOW) {
    this.window = Math.max(2, window);
  }

  /**
   * Record a painted frame.
   *
   * The first call establishes the origin and contributes no sample: there is no
   * previous frame to have taken any time. A non-monotonic or absent timestamp
   * is dropped rather than recorded as a negative frame -- a tab returning from
   * the background is not a 30-second frame anybody wants averaged in.
   */
  push(nowMs: number): void {
    const previous = this.previous;
    this.previous = nowMs;
    if (previous === null) return;
    const dt = nowMs - previous;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.times.push(dt);
    if (this.times.length > this.window) this.times.splice(0, this.times.length - this.window);
  }

  /** Forget the window. For a tab that was hidden, where every gap is a lie. */
  reset(): void {
    this.times.length = 0;
    this.previous = null;
  }

  stats(): FrameStats {
    const times = this.times;
    if (times.length === 0) return EMPTY;

    let total = 0;
    let worst = 0;
    let stalls = 0;
    for (const ms of times) {
      total += ms;
      if (ms > worst) worst = ms;
      if (ms > STALL_MS) stalls++;
    }

    // The rate over the window, not the reciprocal of the last frame: this is
    // the whole point of the module and the one line that must not be
    // "simplified" back to 1000 / times.at(-1).
    const fps = total > 0 ? (times.length * 1000) / total : 0;

    // The 1% low, by rank. `ceil` and a floor of one sample, so a short window
    // still answers -- with the worst frame in it, which is the honest answer
    // when there are only twenty frames to choose from.
    const sorted = [...times].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(sorted.length * 0.99));
    const p99 = sorted[rank - 1] ?? worst;

    return {
      fps,
      avgMs: total / times.length,
      worstMs: worst,
      p99Ms: p99,
      stalls,
      samples: [...times],
    };
  }
}

/**
 * What one *part* of the frame costs, over the same window (spec 189).
 *
 * {@link FrameMeter} answers "how long was the frame"; this answers "how much of
 * it was X". Separate because the two are measured differently and one of them
 * is optional: a frame time is the gap between two paints and always exists,
 * where a cost is something a caller chose to time and may be zero.
 *
 * Two numbers come back and both are needed. The **mean** is the share of the
 * frame -- what you compare against the frame time to decide whether a cost is
 * worth chasing. The **worst** is the spike, and a mean hides it completely:
 * work that is paced by something other than the frame (a tick accumulator, a
 * correction replaying its input buffer) lands unevenly by construction, and the
 * uneven frame is the one a player feels.
 *
 * Time is an argument here too -- `push` is handed a duration somebody else
 * measured, so nothing in this file reads a clock.
 */
export class CostMeter {
  private readonly window: number;
  private readonly costs: number[] = [];

  constructor(window = FRAME_WINDOW) {
    this.window = Math.max(1, window);
  }

  /** Record one frame's cost. Negative and non-finite values are dropped. */
  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.costs.push(ms);
    if (this.costs.length > this.window) this.costs.splice(0, this.costs.length - this.window);
  }

  reset(): void {
    this.costs.length = 0;
  }

  read(): { readonly meanMs: number; readonly worstMs: number } {
    if (this.costs.length === 0) return { meanMs: 0, worstMs: 0 };
    let total = 0;
    let worst = 0;
    for (const ms of this.costs) {
      total += ms;
      if (ms > worst) worst = ms;
    }
    return { meanMs: total / this.costs.length, worstMs: worst };
  }
}
