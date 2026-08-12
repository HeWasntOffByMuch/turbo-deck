/**
 * The drawn turn's beginning and end (spec 142).
 *
 * The properties worth asserting are all relationships to the sim rather than
 * chosen numbers: the drawn body arrives where the server put it, never turns
 * faster than the server would have, and is never further behind than the
 * server's own alignment tolerance. Those three are what make the ease a
 * presentation detail rather than a second turn rule.
 */

import { describe, expect, it } from 'vitest';
import {
  JUMP_TICKS,
  MAX_STEP_SECONDS,
  TurnEase,
  easeTurn,
  lagBound,
  restingAt,
  shortestTurn,
  turnAcceleration,
  type TurnLimits,
} from './turn-ease.js';
import { COMMIT_ALIGN_TICKS, commitAlignEps } from '../../server/sim/abilities.js';
import { turnToward } from '../../server/sim/movement.js';

const TICK = 60;
const FRAME = 1 / 60;
const DEG = Math.PI / 180;

/** The pig's rate after spec 139, and a fresh player's. */
const PIG: TurnLimits = { degreesPerSecond: 540, tickRate: TICK };
const SLOW: TurnLimits = { degreesPerSecond: 120, tickRate: TICK };

/** Step the follower to rest against a fixed target, reporting what it did. */
function settle(
  from: number,
  target: number,
  limits: TurnLimits,
  dt = FRAME,
  maxSteps = 2000,
): { facing: number; steps: number; peak: number; maxAccel: number } {
  // Held at the target from the first step, so `settle` measures the profile and
  // never the jump rule: the body starts turned away from a heading that is not
  // moving, which is the shape of every turn the sim actually produces.
  let state = { facing: from, rate: 0, target };
  let peak = 0;
  let maxAccel = 0;
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const before = state.rate;
    const eased = easeTurn(state, target, limits, dt);
    if (!eased.snapped) {
      maxAccel = Math.max(maxAccel, Math.abs(eased.rate - before) / dt);
    }
    state = { facing: eased.facing, rate: eased.rate, target: eased.target };
    peak = Math.max(peak, Math.abs(state.rate));
    if (Math.abs(shortestTurn(state.facing, target)) < 1e-12 && Math.abs(state.rate) < 1e-9) break;
  }
  return { facing: state.facing, steps, peak, maxAccel };
}

describe('the ease is derived from the sim, not tuned', () => {
  it('bounds the lag by the same tolerance the sim calls aligned', () => {
    // Not "a similar number": the sim's own function, so the two cannot drift.
    for (const rate of [120, 240, 390, 540, 690]) {
      const limits = { degreesPerSecond: rate, tickRate: TICK };
      expect(lagBound(limits)).toBeCloseTo(commitAlignEps(rate, TICK), 12);
    }
  });

  it('ramps in the same interval for every body, however fast it turns', () => {
    // R/a cancels to 2 * COMMIT_ALIGN_TICKS / tickRate. Nobody typed 100ms.
    const expected = (2 * COMMIT_ALIGN_TICKS) / TICK;
    expect(expected).toBeCloseTo(0.1, 12);
    for (const rate of [60, 120, 540, 1800]) {
      const limits = { degreesPerSecond: rate, tickRate: TICK };
      expect((rate * DEG) / turnAcceleration(limits)).toBeCloseTo(expected, 12);
    }
  });
});

describe('easeTurn arrives', () => {
  it('lands exactly on the target from any start, at any frame rate', () => {
    for (const dt of [FRAME, 1 / 144, 1 / 30, 0.05, MAX_STEP_SECONDS * 3]) {
      for (const degrees of [1, 7, 45, 90, 179]) {
        for (const sign of [1, -1]) {
          const target = 0.4 + sign * degrees * DEG;
          const { facing } = settle(0.4, target, PIG, dt);
          expect(Math.abs(shortestTurn(facing, target))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('never overshoots on the way', () => {
    const target = 100 * DEG;
    let state = { facing: 0, rate: 0, target };
    for (let i = 0; i < 200; i++) {
      state = easeTurn(state, target, PIG, FRAME);
      // Approached from below and never crossed: the sign of the remaining error
      // never flips.
      expect(shortestTurn(state.facing, target)).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('holds still once there, rather than jittering around the target', () => {
    let state = restingAt(1.2);
    for (let i = 0; i < 50; i++) state = easeTurn(state, 1.2, PIG, FRAME);
    expect(state.facing).toBe(1.2);
    expect(state.rate).toBe(0);
  });

  it('eases through the +/-PI seam the short way', () => {
    const from = Math.PI - 5 * DEG;
    const target = -Math.PI + 5 * DEG;
    let state = { facing: from, rate: 0, target };
    let travelled = 0;
    for (let i = 0; i < 200; i++) {
      const eased = easeTurn(state, target, PIG, FRAME);
      travelled += Math.abs(shortestTurn(state.facing, eased.facing));
      state = eased;
    }
    expect(Math.abs(shortestTurn(state.facing, target))).toBeLessThan(1e-9);
    // Ten degrees the short way, not 350 the long way.
    expect(travelled).toBeLessThan(11 * DEG);
  });
});

describe('easeTurn stays inside the sim', () => {
  it('never turns faster than the body itself does', () => {
    for (const limits of [PIG, SLOW]) {
      const cap = limits.degreesPerSecond * DEG;
      for (const degrees of [5, 60, 179]) {
        const { peak } = settle(0, degrees * DEG, limits);
        expect(peak).toBeLessThanOrEqual(cap + 1e-9);
      }
    }
  });

  it('bounds the change in rate on every step', () => {
    for (const dt of [FRAME, 1 / 144, 1 / 30]) {
      const { maxAccel } = settle(0, 179 * DEG, PIG, dt);
      expect(maxAccel).toBeLessThanOrEqual(turnAcceleration(PIG) + 1e-6);
    }
  });

  it('never trails the sim by more than the sim calls aligned', () => {
    // The real turn rule driving the target, the follower chasing it, both at
    // 60Hz -- through a reversal, which is the worst case there is.
    for (const limits of [PIG, SLOW]) {
      let authoritative = 0;
      const target = Math.PI;
      const ease = new TurnEase();
      let worst = 0;
      for (let tick = 0; tick < 200; tick++) {
        authoritative = turnToward(authoritative, target, limits.degreesPerSecond, TICK);
        const drawn = ease.step(1, authoritative, limits, FRAME);
        worst = Math.max(worst, Math.abs(shortestTurn(drawn, authoritative)));
      }
      // Inside the bound, and actually reaching most of it -- a follower that
      // trailed by a degree would pass a one-sided assertion while easing
      // nothing at all.
      expect(worst).toBeLessThanOrEqual(lagBound(limits) + 1e-9);
      expect(worst).toBeGreaterThan(lagBound(limits) * 0.8);
    }
  });

  it('catches up once the sim stops, within one ramp', () => {
    const limits = PIG;
    let authoritative = 0;
    const ease = new TurnEase();
    let settledAt = -1;
    for (let tick = 0; tick < 200; tick++) {
      authoritative = turnToward(authoritative, Math.PI, limits.degreesPerSecond, TICK);
      const drawn = ease.step(1, authoritative, limits, FRAME);
      if (authoritative === Math.PI && Math.abs(shortestTurn(drawn, Math.PI)) < 1e-6) {
        settledAt = tick;
        break;
      }
    }
    // The sim takes 20 ticks to reverse at 540 deg/s; the drawn body is done
    // within a ramp of that and not a moment more.
    expect(settledAt).toBeGreaterThan(20);
    expect(settledAt).toBeLessThanOrEqual(20 + (2 * COMMIT_ALIGN_TICKS + 1));
  });
});

describe('the small turns are the ones this fixes', () => {
  it('never reaches the full rate for a turn under twice the lag bound', () => {
    const cap = PIG.degreesPerSecond * DEG;
    const full = 2 * lagBound(PIG);
    expect(full / DEG).toBeCloseTo(54, 6);

    const { peak } = settle(0, full * 0.9, PIG);
    expect(peak).toBeLessThan(cap * 0.999);

    // A 20-degree correction: three ticks at the full rate under `turnToward`,
    // and 61% of it here.
    const small = settle(0, 20 * DEG, PIG);
    expect(small.peak / cap).toBeLessThan(0.7);
    expect(small.peak / cap).toBeGreaterThan(0.5);
  });

  it('does reach it for a turn over that', () => {
    const cap = PIG.degreesPerSecond * DEG;
    const { peak } = settle(0, 4 * lagBound(PIG), PIG);
    expect(peak).toBeCloseTo(cap, 6);
  });
});

describe('what is not a turn', () => {
  it('snaps when the authoritative heading itself jumps', () => {
    // A teleport, a respawn, a tab that was in the background: the target moved
    // further in one step than turning could have taken it.
    const eased = easeTurn(restingAt(0), 3, PIG, FRAME);
    expect(eased.snapped).toBe(true);
    expect(eased.facing).toBe(3);
    expect(eased.rate).toBe(0);
  });

  it('does not mistake a body turning faster than we believe for a jump', () => {
    // The cap is an estimate -- a modifier, or a remote player's unreplicated
    // stats. This is the case the error-based rule got wrong: a body turning at
    // 690 while we believe 390 builds an error no believed turn could produce,
    // and snapped mid-turn every time it turned. The target's own motion stays
    // proportional to the real rate however wrong the estimate is.
    const believed: TurnLimits = { degreesPerSecond: 390, tickRate: TICK };
    let authoritative = 0;
    let state = easeTurn(restingAt(0), 0, believed, FRAME);
    let snaps = 0;
    for (let tick = 0; tick < 120; tick++) {
      authoritative = turnToward(authoritative, Math.PI, 690, TICK);
      state = easeTurn(state, authoritative, believed, FRAME);
      if (state.snapped) snaps++;
    }
    expect(snaps).toBe(0);
    // It trails further than its own bound -- that is the cost of the bad
    // estimate -- and still arrives, late, rather than never.
    expect(Math.abs(shortestTurn(state.facing, Math.PI))).toBeLessThan(1e-6);
  });

  it('judges a jump per tick, not per frame', () => {
    // The authoritative heading moves once per sim tick, so at 240fps two frames
    // in three see it hold still and the third sees a whole tick of turn. A
    // frame-denominated threshold would call that a teleport.
    const perTick = ((PIG.degreesPerSecond * DEG) / TICK) * 0.99;
    for (const dt of [FRAME, 1 / 144, 1 / 240]) {
      expect(easeTurn(restingAt(0), perTick, PIG, dt).snapped).toBe(false);
    }
  });

  it('calls a jump a jump at every frame rate', () => {
    const far = ((PIG.degreesPerSecond * DEG) / TICK) * (JUMP_TICKS + 1);
    for (const dt of [FRAME, 1 / 144, 1 / 240]) {
      expect(easeTurn(restingAt(0), far, PIG, dt).snapped).toBe(true);
    }
  });

  it('clamps a long frame rather than integrating it in one go', () => {
    const eased = easeTurn(restingAt(0), 8 * DEG, PIG, 2);
    expect(eased.snapped).toBe(false);
    expect(Math.abs(eased.rate)).toBeLessThanOrEqual(
      turnAcceleration(PIG) * MAX_STEP_SECONDS + 1e-9,
    );
  });

  it('follows a body that cannot turn instantly, rather than never', () => {
    const dummy: TurnLimits = { degreesPerSecond: 0, tickRate: TICK };
    const eased = easeTurn(restingAt(0), 2, dummy, FRAME);
    expect(eased.facing).toBe(2);
    expect(eased.snapped).toBe(true);
  });

  it('answers with a heading rather than NaN', () => {
    expect(easeTurn({ facing: Number.NaN, rate: 0, target: 0 }, 1.5, PIG, FRAME).facing).toBe(1.5);
    expect(easeTurn({ facing: 0, rate: Number.NaN, target: 0 }, 1.5, PIG, FRAME).facing).toBe(1.5);
    expect(easeTurn(restingAt(0.5), Number.NaN, PIG, FRAME).facing).toBe(0.5);
    expect(easeTurn(restingAt(0.5), Infinity, PIG, FRAME).facing).toBe(0.5);
    expect(restingAt(Number.NaN).facing).toBe(0);
    const zeroTick = easeTurn(restingAt(0), 0.01, { degreesPerSecond: 540, tickRate: 0 }, FRAME);
    expect(Number.isFinite(zeroTick.facing)).toBe(true);
  });

  it('takes a dt of zero or less as no time passing', () => {
    for (const dt of [0, -1, Number.NaN]) {
      const eased = easeTurn({ facing: 0.3, rate: 1, target: 0.3 }, 0.31, PIG, dt);
      expect(eased.facing).toBe(0.3);
    }
  });
});

describe('TurnEase per body', () => {
  it('draws a body it has never seen at its own heading, not from zero', () => {
    const ease = new TurnEase();
    expect(ease.step(7, 2.5, PIG, FRAME)).toBe(2.5);
    expect(ease.facing(7)).toBe(2.5);
  });

  it('keeps bodies apart', () => {
    const ease = new TurnEase();
    ease.step(1, 0, PIG, FRAME);
    ease.step(2, 0, PIG, FRAME);
    for (let i = 0; i < 3; i++) {
      ease.step(1, 30 * DEG, PIG, FRAME);
      ease.step(2, -30 * DEG, PIG, FRAME);
    }
    expect(ease.facing(1)).toBeGreaterThan(0);
    expect(ease.facing(2)).toBeLessThan(0);
  });

  it('forgets a body that left, so its id cannot inherit a heading', () => {
    const ease = new TurnEase();
    ease.step(1, 1.5, PIG, FRAME);
    ease.step(2, 2.5, PIG, FRAME);
    ease.retain(new Set([2]));
    expect(ease.facing(1)).toBeNull();
    expect(ease.facing(2)).toBe(2.5);
    ease.forget(2);
    expect(ease.facing(2)).toBeNull();
  });

  it('never returns a heading a step could not have reached', () => {
    // The property over the class rather than the function: a body followed for
    // a thousand frames of arbitrary targets stays inside its own cap.
    const ease = new TurnEase();
    const cap = PIG.degreesPerSecond * DEG;
    let previous = ease.step(3, 0, PIG, FRAME);
    let target = 0;
    for (let i = 0; i < 1000; i++) {
      // Deterministic wander, no PRNG needed: a slow sweep with reversals.
      const before = target;
      target = Math.sin(i / 37) * Math.PI;
      const drawn = ease.step(3, target, PIG, FRAME);
      const moved = Math.abs(shortestTurn(previous, drawn));
      // Either it turned inside the cap, or the target jumped and it snapped.
      if (moved > cap * FRAME + 1e-9) {
        expect(Math.abs(shortestTurn(before, target))).toBeGreaterThan(
          ((JUMP_TICKS * cap) / TICK) * 0.999,
        );
      }
      previous = drawn;
    }
  });
});
