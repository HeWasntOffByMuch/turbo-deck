/**
 * The three decisions between "something happened" and "a buffer starts"
 * (spec 229).
 *
 * All three are the kind of claim that is true in the three cases somebody
 * tried by hand and false in the fourth, which is exactly why `variants.ts`
 * takes its randomness and its clock as arguments: "a footstep never repeats
 * immediately" is a **property over every draw**, and this file is where it is
 * one rather than a hope.
 *
 * What each of the three prevents, and what this file is guarding:
 *
 * - `VariantPicker`. Two footsteps that are audibly one recording is the single
 *   loudest tell that a game's audio is cheap, and the arithmetic that avoids it
 *   -- `drawn >= previous ? drawn + 1 : drawn` -- has an off-by-one on either
 *   side of it. One of them is an immediate repeat; the other is a take drawn
 *   twice as often as its neighbours, which no bounds check can see and which is
 *   audible as the one footstep you keep hearing. Both are pinned here, and so
 *   is the draw stuck at 0, which is the source a naive "draw until it differs"
 *   never terminates on.
 * - `drawRate`. A resampler pinned at one rate is a variation setting that does
 *   nothing, and looks perfectly correct to a bounds check.
 * - `PlayThrottle`. The failure is an event silenced for the **session**: a
 *   window pushed out by every refusal, or a single timestamp from the future
 *   that the throttle then never gets past. The guard for the second is one
 *   comparison in the module, and it is the sort of line that gets tidied away
 *   by somebody who has never seen a tab wake up.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { drawRate, PlayThrottle, VariantPicker, type Random } from './variants.js';

/**
 * A uniform sequence in `[0, 1)`, from the sim's own generator rather than one
 * written here -- so "uniform" is a property of a tested PRNG instead of a claim
 * about arithmetic in this file.
 */
function uniform(seed: number): Random {
  let rng = Rng.fromSeed(seed);
  return () => {
    const [value, next] = rng.nextInt(0, 0xffffff);
    rng = next;
    return value / 0x1000000;
  };
}

/** A source with no variety in it at all. */
const always =
  (value: number): Random =>
  () =>
    value;

/** A scripted draw. Cycles, so a test cannot run off the end of its own list. */
function sequence(values: readonly number[]): Random {
  let at = 0;
  return () => values[at++ % values.length] ?? 0;
}

/**
 * The three draws every rule here has to survive: a real spread, and both
 * corners of `[0, 1)`.
 *
 * A factory per source rather than a source, because a sequence is stateful and
 * a test that inherited the previous test's position would be measuring
 * something nobody chose.
 */
const SOURCES: readonly (readonly [string, () => Random])[] = [
  ['a uniform sequence', () => uniform(9)],
  ['a draw stuck at 0', () => always(0)],
  ['a draw stuck just under 1', () => always(0.999999)],
];

describe('which take plays', () => {
  it('never plays the same take twice running, at any count, from any draw', () => {
    // The whole reason the class exists, asserted as a property rather than as
    // the handful of sequences somebody would write out. The stuck-at-0 source
    // is the one that matters: a picker that draws uniformly and retries on a
    // collision never terminates on it, and one that draws from `count - 1` and
    // forgets to step over the gap returns the previous take every single time.
    for (const [label, make] of SOURCES) {
      for (let count = 2; count <= 9; count++) {
        const picker = new VariantPicker();
        const random = make();
        let previous = -1;
        for (let draw = 0; draw < 500; draw++) {
          const index = picker.pick('step', count, random);
          const where = `${label}, count ${count}, draw ${draw}`;
          expect(index, where).toBeGreaterThanOrEqual(0);
          expect(index, where).toBeLessThan(count);
          expect(index, `${where}: take ${index} twice running`).not.toBe(previous);
          previous = index;
        }
      }
    }
  });

  it('strictly alternates when there are only two takes', () => {
    // With two, "not the last one" leaves exactly one answer, so the draw is
    // irrelevant and all three sources have to agree. A coin flip here would
    // play the same take twice about half the time.
    for (const [label, make] of SOURCES) {
      const picker = new VariantPicker();
      const random = make();
      const first = picker.pick('step', 2, random);
      for (let n = 1; n < 40; n++) {
        expect(picker.pick('step', 2, random), `${label}, draw ${n}`).toBe((first + n) % 2);
      }
    }
  });

  it('reaches every take, so nothing is authored and never heard', () => {
    for (let count = 2; count <= 9; count++) {
      const picker = new VariantPicker();
      const random = uniform(count * 31 + 5);
      const seen = new Set<number>();
      for (let draw = 0; draw < 400; draw++) seen.add(picker.pick('step', count, random));
      expect([...seen].sort((a, b) => a - b), `count ${count}`).toEqual(
        Array.from({ length: count }, (_, index) => index),
      );
    }
  });

  it('spreads evenly over the takes that are not the last one', () => {
    // The step-over arithmetic, pinned by the failure a bounds check cannot
    // see. Drawing over `count` instead of `count - 1` and clamping, for
    // instance, still never repeats and still reaches everything -- it just
    // plays the second-to-last take twice as often as the rest.
    const count = 4;
    const draws = 60_000;
    const picker = new VariantPicker();
    const random = uniform(4242);
    const followed = new Map<string, number>();
    const overall = new Map<number, number>();

    let previous = picker.pick('step', count, random);
    for (let draw = 0; draw < draws; draw++) {
      const index = picker.pick('step', count, random);
      const key = `${previous}->${index}`;
      followed.set(key, (followed.get(key) ?? 0) + 1);
      overall.set(index, (overall.get(index) ?? 0) + 1);
      previous = index;
    }

    for (let from = 0; from < count; from++) {
      let total = 0;
      for (let to = 0; to < count; to++) total += followed.get(`${from}->${to}`) ?? 0;
      expect(total, `nothing ever followed take ${from}`).toBeGreaterThan(1000);
      for (let to = 0; to < count; to++) {
        const share = (followed.get(`${from}->${to}`) ?? 0) / total;
        if (to === from) {
          expect(share, `${from}->${to}`).toBe(0);
          continue;
        }
        // A third each, loosely: the bound is here to catch a doubled share,
        // not to re-test the PRNG.
        expect(share, `${from}->${to}`).toBeGreaterThan(0.29);
        expect(share, `${from}->${to}`).toBeLessThan(0.38);
      }
    }

    // ...and no take is a rarity over the run as a whole, which is what the
    // no-repeat rule is supposed to cost nothing.
    for (let index = 0; index < count; index++) {
      const share = (overall.get(index) ?? 0) / draws;
      expect(share, `take ${index}`).toBeGreaterThan(0.22);
      expect(share, `take ${index}`).toBeLessThan(0.28);
    }
  });

  it('says there is nothing to play rather than naming a take that is not there', () => {
    const picker = new VariantPicker();
    const random = uniform(1);
    for (const count of [0, -1, -7]) {
      expect(picker.pick('step', count, random), `count ${count}`).toBe(-1);
    }
  });

  it('plays the only take there is, every time, when there is one', () => {
    // The one place an immediate repeat is correct: there is nothing else to
    // play, and refusing would be silence.
    for (const [label, make] of SOURCES) {
      const picker = new VariantPicker();
      const random = make();
      for (let draw = 0; draw < 20; draw++) expect(picker.pick('step', 1, random), label).toBe(0);
    }
  });

  it('draws afresh over the whole list when the remembered take is off its end', () => {
    // What an edit in the SFX tab does: eight takes become three, and the index
    // in hand names a take that no longer exists. Clamping the ghost to the end
    // would answer 2 here and quietly bias every shrink toward the last take.
    const picker = new VariantPicker();
    const scripted = sequence([0.99, 0]);
    expect(picker.pick('step', 8, scripted)).toBe(7);
    expect(picker.pick('step', 3, scripted)).toBe(0);

    // The half a single answer cannot show, and the whole reason the ghost is
    // tested for rather than left to fall through to the not-the-last-one
    // branch: there, `drawn` is clamped to `count - 2` and a previous off the
    // end is above every value it can take, so nothing is ever stepped over and
    // the **top** take of the shrunken list is unreachable. Take 3 of 3 would
    // simply never play until the memory happened to roll back into range.
    const random = uniform(808);
    const reached = new Set<number>();
    for (let trial = 0; trial < 200; trial++) {
      const shrinking = new VariantPicker();
      shrinking.pick('step', 8, always(0.999999));
      reached.add(shrinking.pick('step', 3, random));
    }
    expect([...reached].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('answers a shrunken list with a valid take, and goes on refusing repeats', () => {
    for (const [label, make] of SOURCES) {
      for (let shrunk = 1; shrunk <= 7; shrunk++) {
        const picker = new VariantPicker();
        const random = make();
        picker.pick('step', 8, random);
        picker.pick('step', 8, random);

        const where = `${label}, shrunk to ${shrunk}`;
        const index = picker.pick('step', shrunk, random);
        expect(index, where).toBeGreaterThanOrEqual(0);
        expect(index, where).toBeLessThan(shrunk);
        // The rule resumes from the take that just played rather than from the
        // ghost, which is the half a range check alone would not notice.
        if (shrunk >= 2) expect(picker.pick('step', shrunk, random), where).not.toBe(index);
      }
    }
  });

  it('remembers each event separately, so one sound cannot steer another', () => {
    // Not "the last take played anywhere", which would make two frequent sounds
    // alternate in lockstep with each other.
    const picker = new VariantPicker();
    const random = always(0);
    expect(picker.pick('step', 2, random)).toBe(0);
    expect(picker.pick('swing', 2, random)).toBe(0);
    expect(picker.pick('step', 2, random)).toBe(1);
    expect(picker.pick('swing', 2, random)).toBe(1);
  });

  it('forgets what played last, which is what lets the next take repeat', () => {
    // The only observable consequence of `reset`, and the reason it is called
    // when the catalog is replaced: an index remembered against a re-ordered
    // list is a memory of the wrong take.
    const picker = new VariantPicker();
    const random = always(0);
    expect(picker.pick('step', 3, random)).toBe(0);
    expect(picker.pick('step', 3, random)).toBe(1);
    expect(picker.pick('step', 3, random)).toBe(0);
    picker.reset();
    // Without the reset this draw would be 1, forever.
    expect(picker.pick('step', 3, random)).toBe(0);
  });

  it('forgets every event on a reset, not only the one last asked about', () => {
    const picker = new VariantPicker();
    const random = always(0);
    picker.pick('step', 2, random);
    picker.pick('swing', 2, random);
    picker.reset();
    expect(picker.pick('step', 2, random)).toBe(0);
    expect(picker.pick('swing', 2, random)).toBe(0);
  });
});

describe('at what rate', () => {
  it('returns the floor when there is no range to draw from', () => {
    const random = always(0.5);
    expect(drawRate({ min: 1, max: 1 }, random)).toBe(1);
    // A range authored backwards is a floor, not a negative spread -- and not a
    // rate below the one the sound was recorded at.
    expect(drawRate({ min: 1.2, max: 0.8 }, random)).toBe(1.2);
  });

  it('stays inside the range for every draw the contract allows', () => {
    const range = { min: 0.92, max: 1.08 };
    const random = uniform(77);
    for (let draw = 0; draw < 5000; draw++) {
      const rate = drawRate(range, random);
      expect(rate).toBeGreaterThanOrEqual(range.min);
      expect(rate).toBeLessThan(range.max);
    }
    // The ends exactly: `Random` is `[0, 1)`, so the floor is reachable and the
    // ceiling is approached and never reached.
    expect(drawRate(range, always(0))).toBe(range.min);
    expect(drawRate(range, always(0.999999))).toBeLessThan(range.max);
    expect(drawRate(range, always(0.999999))).toBeGreaterThan(1.079);
  });

  it('actually uses the range rather than settling near one rate', () => {
    // The failure a bounds check cannot see: a rate pinned at the midpoint
    // passes every assertion above and is a pitch-variation setting that does
    // nothing at all.
    const random = uniform(1234);
    let low = 0;
    let high = 0;
    for (let draw = 0; draw < 2000; draw++) {
      const rate = drawRate({ min: 0.9, max: 1.1 }, random);
      if (rate < 0.95) low += 1;
      if (rate > 1.05) high += 1;
    }
    expect(low).toBeGreaterThan(300);
    expect(high).toBeGreaterThan(300);
  });
});

describe('whether it may start again yet', () => {
  it('admits the first, refuses the rest of the window, and admits at its far edge', () => {
    const throttle = new PlayThrottle();
    expect(throttle.admit('hit', 1000, 50)).toBe(true);
    // The case the class is actually for: `skill.whirlwind` resolves against
    // every body in its arc on one tick, at the same millisecond.
    expect(throttle.admit('hit', 1000, 50)).toBe(false);
    expect(throttle.admit('hit', 1049, 50)).toBe(false);
    // Exactly a window later is outside it -- the window is how long two
    // transients are heard as one, and at its end they are two.
    expect(throttle.admit('hit', 1050, 50)).toBe(true);
    expect(throttle.admit('hit', 1200, 50)).toBe(true);
  });

  it('measures the window from the last sound, never from the last attempt', () => {
    // The difference between a throttle and a mute. An affliction pulse asks
    // every frame for as long as it lasts, so a window that were pushed out by
    // each refusal would be a sound that never comes back while the fight does.
    const throttle = new PlayThrottle();
    expect(throttle.admit('hit', 0, 50)).toBe(true);
    for (let at = 10; at < 50; at += 10) expect(throttle.admit('hit', at, 50), `at ${at}`).toBe(false);
    expect(throttle.admit('hit', 50, 50)).toBe(true);
  });

  it('admits everything when there is no window', () => {
    // What a sound with no `cooldownMs` authored asks for, and the answer has
    // to be "every one of them" rather than "the first of them".
    const throttle = new PlayThrottle();
    for (const window of [0, -1]) {
      for (let n = 0; n < 8; n++) {
        expect(throttle.admit('hit', 1000, window), `window ${window}, call ${n}`).toBe(true);
      }
    }
  });

  it('admits a clock that went backwards rather than locking the event out', () => {
    // A test clock, or a tab that slept and came back. `previous > nowMs` cannot
    // happen from a monotonic clock, and treating it as a reason to refuse would
    // let one stray timestamp from the future silence this event for the rest of
    // the session.
    const throttle = new PlayThrottle();
    expect(throttle.admit('hit', 9_000_000, 50)).toBe(true);
    expect(throttle.admit('hit', 1000, 50)).toBe(true);
    // ...and it re-anchors on the time it was handed rather than staying
    // permanently open, which would be the same bug facing the other way.
    expect(throttle.admit('hit', 1010, 50)).toBe(false);
    expect(throttle.admit('hit', 1060, 50)).toBe(true);
  });

  it('keeps a window per event, so one sound cannot silence another', () => {
    // Keyed on the event, not the position: six hits in six places are one
    // sound, and a hit and a footstep are two however close together they land.
    const throttle = new PlayThrottle();
    expect(throttle.admit('hit', 0, 50)).toBe(true);
    expect(throttle.admit('step', 0, 50)).toBe(true);
    expect(throttle.admit('hit', 10, 50)).toBe(false);
    expect(throttle.admit('step', 10, 50)).toBe(false);
  });

  it('never lets two admissions of one event fall inside one window', () => {
    // The invariant, over a stream that arrives in bursts the way a tick's worth
    // of events does -- several at the same millisecond, then a gap.
    const throttle = new PlayThrottle();
    const random = uniform(31);
    const window = 40;
    let now = 0;
    let admitted = 0;
    let lastAdmitted: number | null = null;
    for (let n = 0; n < 5000; n++) {
      now += Math.floor(random() * 30);
      if (!throttle.admit('hit', now, window)) continue;
      if (lastAdmitted !== null) expect(now - lastAdmitted, `at ${now}`).toBeGreaterThanOrEqual(window);
      lastAdmitted = now;
      admitted += 1;
    }
    // And it admitted rather than shutting the event down, which is what an
    // interval assertion alone would happily pass on.
    expect(admitted).toBeGreaterThan(100);
  });

  it('forgets on a reset', () => {
    const throttle = new PlayThrottle();
    expect(throttle.admit('hit', 0, 50)).toBe(true);
    expect(throttle.admit('hit', 10, 50)).toBe(false);
    throttle.reset();
    expect(throttle.admit('hit', 10, 50)).toBe(true);
  });
});
