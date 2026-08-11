/**
 * The VFX layer's random numbers (spec 118).
 *
 * This is deliberately **not** `src/shared/prng.ts`. That one is immutable --
 * every draw returns a new `Rng` -- which is exactly right for the sim, where a
 * pure snapshot of state is the whole point, and impossible here: a particle
 * loop that allocates an object per random number allocates thousands of them
 * per frame, which is the one thing the update loop may not do.
 *
 * The tradeoff is stated rather than hidden. Nothing in the deterministic core
 * may import this, and this may not be used for anything a game outcome depends
 * on. What it *is* used for is the promise that the same seed draws the same
 * effect, which is what makes a visual regression something a test can catch.
 *
 * mulberry32: one 32-bit word of state, a handful of integer ops per draw, and a
 * period long enough that no effect will ever see it wrap. Chosen over a bigger
 * generator because the quality bar here is "two sparks do not look correlated",
 * not "survives a statistical test suite".
 */
export class VfxRng {
  private state = 0;

  constructor(seed: number) {
    this.reset(seed);
  }

  /**
   * Restart the sequence.
   *
   * The seed is mixed rather than taken raw: callers seed instances from small
   * counters (an entity id, an effect index), and mulberry32 started at 1, 2 and
   * 3 produces first draws that are visibly close together -- three sparks that
   * all fly the same way.
   */
  reset(seed: number): void {
    let s = seed >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    this.state = (s ^ (s >>> 16)) >>> 0;
  }

  /** The raw state, so a test can assert two systems are in step. */
  peek(): number {
    return this.state;
  }

  /**
   * Resume from a previously-peeked state, unmixed.
   *
   * This is how a continuous emitter keeps one stream across ticks. Re-seeding
   * it from its own seed every tick instead would make every particle it ever
   * emits identical -- a fountain that fires the same drop forever, which looks
   * exactly like an emitter that is working until you watch it.
   */
  restore(state: number): void {
    this.state = state >>> 0;
  }

  /** A float in [0, 1). */
  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A float in [min, max). Returns `min` exactly when the range is empty. */
  range(min: number, max: number): number {
    return max > min ? min + (max - min) * this.float() : min;
  }

  /** An integer in [min, maxInclusive]. */
  int(min: number, maxInclusive: number): number {
    if (maxInclusive <= min) return min;
    return min + Math.floor(this.float() * (maxInclusive - min + 1));
  }

  /** A float in [-spread, spread). */
  signed(spread: number): number {
    return (this.float() * 2 - 1) * spread;
  }
}
