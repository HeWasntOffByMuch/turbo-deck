/**
 * What a refund mark says, and how long it says it for (spec 254).
 */

import { describe, expect, it } from 'vitest';

import { SERVER_TICK_RATE } from '../../../server/config.js';
import { NUMERIC_FONT, isDrawable, measureText } from '../../../ui/text/font.js';
import { THEME } from '../../../ui/theme/theme.js';
import { SLOT_SIDE } from '../../../ui/widgets/skill-slot.js';
import { CooldownRefundMarks, REFUND_MARK_MS, refundLabel } from './cooldown-marks.js';
import { NUMBER_LIFE } from './damage-popup.js';

const seconds = (value: number): number => Math.round(value * SERVER_TICK_RATE);

describe('the label', () => {
  it('is the amount to a tenth, signed, with no unit', () => {
    expect(refundLabel(1.2)).toBe('-1.2');
    expect(refundLabel(0.4)).toBe('-0.4');
  });

  /**
   * The numeric face is uppercase-only and has a fixed symbol set, so a
   * character with no glyph draws as a **solid block** rather than as nothing
   * (`font.ts`'s fallback). `-1.2s` is one such string: the lowercase `s` has no
   * glyph, which is the trap spec 227 records the account window falling into.
   */
  it('is drawable in the face it is drawn in', () => {
    for (const value of [0.1, 0.4, 0.8, 1.2, 2.4, 9.9, 12.5, 600]) {
      expect(isDrawable(NUMERIC_FONT, refundLabel(value)), refundLabel(value)).toBe(true);
    }
    expect(isDrawable(NUMERIC_FONT, '-1.2s')).toBe(false);
  });

  it('drops the decimal at ten, exactly as the slot’s own readout does', () => {
    expect(refundLabel(9.9)).toBe('-9.9');
    expect(refundLabel(12.5)).toBe('-13');
  });

  /**
   * The property the ordinary case needs. One cancel pays every cooling
   * ability, so several marks are up at once, centred on slots one **pitch**
   * apart -- a slot plus the row's gap. A label wider than that pitch prints
   * into its neighbour's airspace, and at the bar's smallest size the margin is
   * a single pixel, so this is asserted rather than eyeballed.
   *
   * It holds for every value because the label is at most four characters: see
   * {@link refundLabel}.
   */
  it('is never wider than one slot and its gap, at the bar’s smallest size', () => {
    const pitch = SLOT_SIDE + THEME.spacing.xs;
    for (const value of [0.1, 0.4, 1.2, 9.9, 12.5, 99, 600]) {
      expect(measureText(NUMERIC_FONT, refundLabel(value)), refundLabel(value)).toBeLessThanOrEqual(
        pitch,
      );
    }
  });
});

/**
 * A number floating off a slot lives exactly as long as one floating off a body
 * (spec 254).
 *
 * Two constants in two layers that mean the same span, so the agreement is a
 * test rather than a coincidence: `src/ui/` cannot import the renderer, so
 * `MOTION.refund` has to state the number, and this is what stops it drifting
 * from the damage popup it was taken from.
 */
describe('how long a mark lives', () => {
  it('is the damage number’s own life', () => {
    expect(REFUND_MARK_MS).toBe((NUMBER_LIFE / SERVER_TICK_RATE) * 1000);
  });
});

describe('the marks', () => {
  it('holds a refund for its window and then drops it', () => {
    const marks = new CooldownRefundMarks();
    marks.add([{ abilityId: 'skill.arcLash', ticks: seconds(1.2) }], 1000);
    expect(marks.live(1000)).toEqual([
      { abilityId: 'skill.arcLash', seconds: 1.2, startedMs: 1000 },
    ]);
    expect(marks.live(1000 + REFUND_MARK_MS - 1)).toHaveLength(1);
    expect(marks.live(1000 + REFUND_MARK_MS)).toHaveLength(0);
  });

  it('marks every ability a single trigger paid', () => {
    const marks = new CooldownRefundMarks();
    marks.add(
      [
        { abilityId: 'skill.arcLash', ticks: seconds(1.2) },
        { abilityId: 'skill.blight', ticks: seconds(1.2) },
        { abilityId: 'skill.emberToss', ticks: seconds(0.3) },
      ],
      0,
    );
    expect(marks.live(0).map((mark) => mark.abilityId)).toEqual([
      'skill.arcLash',
      'skill.blight',
      'skill.emberToss',
    ]);
  });

  /**
   * A refund is a contact, not a quantity: two cancels a second apart are two
   * events. The second replaces the first rather than summing with it, which is
   * `stagger-flinch.ts`'s rule and for its reason -- a mark reading `-2.4` for
   * two separate `-1.2`s would be a number that never happened.
   */
  it('restarts rather than accumulating when a second one lands', () => {
    const marks = new CooldownRefundMarks();
    marks.add([{ abilityId: 'skill.arcLash', ticks: seconds(1.2) }], 0);
    marks.add([{ abilityId: 'skill.arcLash', ticks: seconds(0.4) }], 300);
    const live = marks.live(300);
    expect(live).toHaveLength(1);
    expect(live[0]?.seconds).toBe(0.4);
    expect(live[0]?.startedMs).toBe(300);
    // And the window runs from the newer one.
    expect(marks.live(300 + REFUND_MARK_MS - 1)).toHaveLength(1);
  });

  /**
   * The clamp at zero remaining makes tiny refunds real -- a cooldown with two
   * ticks left refunded by seventy-two gives back two -- and `-0.0` is a mark
   * announcing that nothing happened.
   */
  it('says nothing about a refund that rounds to nothing', () => {
    const marks = new CooldownRefundMarks();
    marks.add([{ abilityId: 'skill.arcLash', ticks: 2 }], 0);
    expect(marks.live(0)).toHaveLength(0);
    // A tenth of a second is the smallest thing worth a label, and it gets one.
    marks.add([{ abilityId: 'skill.blight', ticks: seconds(0.1) }], 0);
    expect(marks.live(0)).toHaveLength(1);
  });

  /**
   * The reason there is nothing to clear on a death or a disconnect: a mark
   * expires on a comparison, so it cannot outlive its window whatever stops
   * happening around it.
   */
  it('needs nothing to remember to remove it', () => {
    const marks = new CooldownRefundMarks();
    marks.add([{ abilityId: 'skill.arcLash', ticks: seconds(1.2) }], 0);
    expect(marks.live(REFUND_MARK_MS)).toHaveLength(0);
    // ...and stays gone, rather than reappearing on a later frame.
    expect(marks.live(REFUND_MARK_MS * 4)).toHaveLength(0);
  });
});
