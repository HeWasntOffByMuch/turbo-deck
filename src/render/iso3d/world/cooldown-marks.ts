/**
 * The `-1.2` over a slot, and how long it stays there (spec 253).
 *
 * Mobile Offense had no feedback at all when it shipped, and that was a
 * regression rather than an omission: the reward it replaced was a Flow stack,
 * and Flow has a row in `data/status-visuals.ts`, so a successful cancel used to
 * put a mark over the player's head. Cooldown coming off a *different* button is
 * the least visible reward this game has -- a sweep the player is not looking at
 * moving by a fraction of a second, mid-swing -- so it says so.
 *
 * Pure, and time is an argument. `GameClient.onCooldownRefund` says *what* was
 * refunded, in ticks; this holds it for as long as it is drawn and turns it into
 * the seconds a person reads.
 */

import { SERVER_TICK_RATE } from '../../../server/config.js';
import { MOTION } from '../../../ui/core/motion.js';
import type { CooldownRefund } from '../../../server/client/cooldown-refund.js';

/**
 * How long a mark lives: **the animation's own length**, imported rather than
 * restated.
 *
 * The widget stops drawing the mark when the tween runs out and this stops
 * handing it over; two numbers meaning the same span is two numbers that agree
 * until one is retuned, and the failure is silent either way -- a mark held
 * after it stops being drawn, or one dropped mid-rise. `src/render/` may read
 * `src/ui/`, so the timing lives with the motion table beside the other three.
 */
export const REFUND_MARK_MS = MOTION.refund.durationMs;

/**
 * Refunds smaller than this are not drawn.
 *
 * The label is one decimal place, so anything under a tenth of a second renders
 * as `-0.0`, which is a mark announcing that nothing happened. The clamp at zero
 * remaining makes those real: a cooldown with three ticks left refunded by
 * seventy-two gives back three.
 */
const FLOOR_SECONDS = 0.1;

/** One live mark: what came off, and when it landed. */
export interface RefundMark {
  readonly abilityId: string;
  /** Seconds removed. Positive; the minus sign is the label's. */
  readonly seconds: number;
  readonly startedMs: number;
}

export class CooldownRefundMarks {
  private marks: RefundMark[] = [];

  /**
   * Record what just came off.
   *
   * A second refund on the same ability **replaces** the first rather than
   * summing with it, which is `stagger-flinch.ts`'s rule for the same reason: a
   * refund is a *contact*, and two separate 1.2s cancels are two events, not one
   * 2.4s one. The mark restarts, so the newer one is the one being read.
   */
  add(refunds: readonly CooldownRefund[], nowMs: number): void {
    for (const refund of refunds) {
      const seconds = refund.ticks / SERVER_TICK_RATE;
      if (!(seconds >= FLOOR_SECONDS)) continue;
      const mark = { abilityId: refund.abilityId, seconds, startedMs: nowMs };
      const index = this.marks.findIndex((held) => held.abilityId === refund.abilityId);
      if (index >= 0) this.marks[index] = mark;
      else this.marks.push(mark);
    }
  }

  /**
   * The marks still worth drawing, expired ones dropped.
   *
   * Swept on read rather than on a timer, the rule `sim/statuses.ts` states one
   * layer down: expiry is a comparison, so a mark cannot be drawn after its
   * time whether or not anything remembered to remove it. That is also why
   * there is no `clear()` for a death or a disconnect -- everything here is
   * gone within {@link REFUND_MARK_MS} on its own, and a method with no caller
   * is a seam that rots.
   */
  live(nowMs: number): readonly RefundMark[] {
    if (this.marks.length > 0) {
      this.marks = this.marks.filter((mark) => nowMs - mark.startedMs < REFUND_MARK_MS);
    }
    return this.marks;
  }
}

/**
 * What a mark says.
 *
 * **The slot's own rule for seconds, exactly**: `SkillSlot` draws its cooldown
 * readout as `secondsLeft.toFixed(1)` under ten and a whole number at or above
 * it, with no unit -- so the number that says how much came off and the number
 * that says how much is left are written the same way, on the same square, in
 * the same face. A suffix here would make this the only place on the bar
 * carrying one.
 *
 * That rule also bounds the width, which is what the ordinary case needs: one
 * cancel pays *every* cooling ability, so several marks are up at once, and
 * four characters is the most this can ever produce -- 23 font pixels against
 * the 24 of slot-plus-gap at the bar's smallest size. `-12.5` would be five and
 * would print into the neighbour's airspace.
 *
 * The numeric face is uppercase-only with a fixed symbol set, so a character
 * with no glyph draws as a solid block; there is a test that every label this
 * can produce is drawable.
 */
export function refundLabel(seconds: number): string {
  return `-${seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1)}`;
}
