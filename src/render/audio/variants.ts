/**
 * Which take, at what pitch, and whether at all (spec 229).
 *
 * The three decisions between "something happened" and "a buffer starts", all
 * three of them arithmetic and none of them touching Web Audio -- so they are
 * asserted in `npm test` rather than judged by ear, which for "does it ever
 * repeat a footstep twice in a row" is the difference between a property and a
 * hope.
 *
 * Pure. No DOM, no clock, no `Math.random`.
 *
 * **Randomness is passed in.** The same rule the sim lives by, for a weaker but
 * real reason: nothing here can change a game outcome, but a variant picker that
 * reached for `Math.random` would be one no test could pin, and "never repeats
 * immediately" is exactly the kind of claim that is true in the three cases
 * somebody tried by hand and false in the fourth. `Random` is `() => number` in
 * `[0, 1)`; `audio/engine.ts` hands it `Math.random` and the tests hand it a
 * sequence.
 *
 * **Time is an argument**, for the same reason it is one in `src/ui/`.
 */

/** A source of numbers in `[0, 1)`. `Math.random`, or a test's sequence. */
export type Random = () => number;

/**
 * Which take to play, given which one played last.
 *
 * The rule is *no immediate repeat*, and it is worth being precise about what
 * that costs and does not. With two takes it is strict alternation, which is the
 * right answer -- a coin flip on two takes plays the same one twice about half
 * the time, and a pair of footsteps that are audibly one recording is the single
 * loudest tell that a game's audio is cheap. With three or more it draws
 * uniformly from the others, which keeps every take equally likely over a run
 * while making a stutter impossible.
 *
 * What it deliberately is **not** is a shuffled bag. A bag guarantees an even
 * spread over each cycle and costs a per-event array that has to be reset when
 * the catalog changes; the audible difference over six footsteps is nothing, and
 * the failure it prevents -- the same take twice running -- is the one this
 * already prevents.
 */
export class VariantPicker {
  private readonly last = new Map<string, number>();

  /**
   * An index into a variant list of `count`, or -1 if there is nothing to play.
   *
   * `count` is passed rather than the list, because the caller has the list and
   * this has no business holding a reference to something the SFX tab is editing.
   */
  pick(id: string, count: number, random: Random): number {
    if (count <= 0) return -1;
    if (count === 1) {
      this.last.set(id, 0);
      return 0;
    }
    const previous = this.last.get(id);
    let index: number;
    if (previous === undefined || previous >= count) {
      index = Math.min(count - 1, Math.floor(random() * count));
    } else {
      // Draw from the `count - 1` takes that are not the last one, then step
      // over the gap. One draw, no rejection loop -- a rejection loop is
      // unbounded in principle and the bound here is one line of arithmetic.
      const drawn = Math.min(count - 2, Math.floor(random() * (count - 1)));
      index = drawn >= previous ? drawn + 1 : drawn;
    }
    this.last.set(id, index);
    return index;
  }

  /**
   * Forget what played last.
   *
   * Called when the catalog is replaced, because an index remembered against a
   * list that has been re-ordered is a memory of the wrong take -- harmless, but
   * it means the first press after an edit in the SFX tab can repeat, which is
   * exactly the moment somebody is listening for repeats.
   */
  reset(): void {
    this.last.clear();
  }
}

/**
 * A playback rate drawn from a range.
 *
 * A rate rather than a pitch shift: `AudioBufferSourceNode.playbackRate`
 * resamples, so it moves the pitch and the length together, which is what a
 * physical variation actually does -- a lighter footfall is higher *and*
 * shorter. A real pitch shift that preserved length would need a phase vocoder,
 * and would sound less like a footstep, not more.
 */
export function drawRate(range: { readonly min: number; readonly max: number }, random: Random): number {
  if (range.max <= range.min) return range.min;
  return range.min + random() * (range.max - range.min);
}

/**
 * Whether an event may start again yet.
 *
 * The problem it exists for is real and is not rate-limiting in the usual sense:
 * `skill.whirlwind` resolves against every body in its arc **on one tick**, and
 * an affliction pulse lands on every body carrying it on one tick too. So the
 * same event genuinely fires six or eight times inside one frame, and six copies
 * of one recording starting within a millisecond of each other do not sound like
 * six things -- they sound like one thing about 2.5x as loud with a comb filter
 * across it, because that is what summing near-identical waveforms is.
 *
 * Keyed on the **event**, not on the position, and that is the point: the six
 * hits happened in six different places and are still one sound. Positional
 * de-duplication would let them all through, which is the bug.
 *
 * The window is short enough (tens of milliseconds) that nothing a player could
 * distinguish is suppressed -- two transients under about 50ms apart are heard
 * as one event whatever we do about it.
 */
export class PlayThrottle {
  private readonly lastAt = new Map<string, number>();

  /** True if `id` may start at `nowMs`, and records it if so. */
  admit(id: string, nowMs: number, windowMs: number): boolean {
    if (windowMs <= 0) {
      this.lastAt.set(id, nowMs);
      return true;
    }
    const previous = this.lastAt.get(id);
    // `previous > nowMs` cannot happen from a monotonic clock and can from a
    // test or a tab that was asleep. Treated as "long ago" rather than as a
    // reason to refuse, or one bad timestamp silences an event forever.
    if (previous !== undefined && nowMs >= previous && nowMs - previous < windowMs) return false;
    this.lastAt.set(id, nowMs);
    return true;
  }

  reset(): void {
    this.lastAt.clear();
  }
}
