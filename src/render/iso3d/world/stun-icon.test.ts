/**
 * The swirl over a stunned body (spec 173).
 *
 * Pure, and stateless, so every case here is one question asked of three
 * numbers. The property that matters most is the last one: two readers handed
 * the same facts agree, because there is no reader -- only a function.
 */

import { describe, expect, it } from 'vitest';

import { EntityActivity } from '../../../server/net/protocol.js';
import { FADE_TICKS, stunMark, UNMARKED } from './stun-icon.js';

const STUNNED = EntityActivity.Stunned;

describe('the swirl marks a stunned body (spec 173)', () => {
  it('is drawn for a body inside its window', () => {
    expect(stunMark(STUNNED, 30, 0).visible).toBe(true);
  });

  it('is drawn for a body that was already stunned when it came into view', () => {
    // The difference from the flinch, stated as a test. A flinch is a contact
    // and must not be invented for a blow nobody watched; the swirl is a state,
    // and a body that is stunned is stunned whoever was looking.
    expect(stunMark(STUNNED, 30, 29).visible).toBe(true);
  });

  it('is drawn for nothing else', () => {
    for (const activity of [
      EntityActivity.Idle,
      EntityActivity.Moving,
      EntityActivity.Casting,
      EntityActivity.Dead,
    ]) {
      expect(stunMark(activity, 30, 0)).toEqual(UNMARKED);
    }
  });

  it('ignores a window that has already passed', () => {
    // The same comparison the sim's `staggered` makes, so a stale delta cannot
    // leave a swirl hanging over a body that is free again.
    expect(stunMark(STUNNED, 30, 30)).toEqual(UNMARKED);
    expect(stunMark(STUNNED, 30, 90)).toEqual(UNMARKED);
  });

  it('turns one way for the whole window', () => {
    // A glyph that reversed halfway would read as two events.
    let last = stunMark(STUNNED, 40, 0).spin;
    for (let tick = 1; tick < 40; tick++) {
      const spin = stunMark(STUNNED, 40, tick).spin;
      expect(spin).toBeGreaterThan(last);
      last = spin;
    }
  });

  it('turns at least once inside the shortest stagger there is', () => {
    // The floor is 30 ticks (0.5s). A swirl that showed less than a full
    // rotation over it would read as a tilted glyph rather than a spinning one,
    // which is the whole reason the rate is what it is.
    const start = stunMark(STUNNED, 30, 0).spin;
    const end = stunMark(STUNNED, 30, 29).spin;
    expect(Math.abs(end - start)).toBeGreaterThan(360);
  });

  it('is at full strength the moment it appears', () => {
    // No fade in: a stagger begins with a blow, and a mark that ramps up reads
    // as unrelated to the hit.
    expect(stunMark(STUNNED, 48, 0).opacity).toBe(1);
  });

  it('thins out into the end of the window', () => {
    const full = stunMark(STUNNED, 40, 40 - FADE_TICKS).opacity;
    const half = stunMark(STUNNED, 40, 40 - Math.round(FADE_TICKS / 2)).opacity;
    const last = stunMark(STUNNED, 40, 39).opacity;
    expect(full).toBe(1);
    expect(half).toBeLessThan(full);
    expect(last).toBeLessThan(half);
    expect(last).toBeGreaterThan(0);
  });

  it('fades over the same number of ticks whatever the window', () => {
    // A count, not a fraction: a long stagger and a short one have the same
    // tail, because a fraction of a window this module cannot measure is not a
    // thing it could express.
    const short = stunMark(STUNNED, 30, 30 - FADE_TICKS + 2).opacity;
    const long = stunMark(STUNNED, 48, 48 - FADE_TICKS + 2).opacity;
    expect(short).toBeCloseTo(long, 10);
  });

  it('never leaves its own bounds', () => {
    for (let tick = 0; tick < 48; tick++) {
      const mark = stunMark(STUNNED, 48, tick);
      expect(mark.opacity).toBeGreaterThanOrEqual(0);
      expect(mark.opacity).toBeLessThanOrEqual(1);
      expect(Number.isFinite(mark.spin)).toBe(true);
    }
  });

  it('is a pure function of what it is handed', () => {
    // Two clients, no shared state, same answer -- which is what lets every
    // observer of one fight draw the same swirl at the same angle without
    // anything being replicated for it.
    for (const tick of [0, 5, 17, 29]) {
      expect(stunMark(STUNNED, 31, tick)).toEqual(stunMark(STUNNED, 31, tick));
    }
  });

  it('does not throw on numbers off a hostile wire', () => {
    expect(stunMark(STUNNED, Number.NaN, 0)).toEqual(UNMARKED);
    expect(stunMark(STUNNED, 30, Number.NaN).visible).toBe(true);
    expect(Number.isFinite(stunMark(STUNNED, 30, Number.NaN).spin)).toBe(true);
  });
});
