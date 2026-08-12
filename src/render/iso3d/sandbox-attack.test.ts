/**
 * The cast rehearsal (spec 140).
 *
 * The property that matters is the one the whole sandbox exists to demonstrate:
 * **the blow lands when the timing says, at every timing the sliders can
 * reach.** Not at one timing -- at all of them, because a rehearsal that is
 * right at 500ms and out by a tick at 900ms is a tool that lies exactly when
 * somebody is using it to decide something.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TICK_MS } from '../../units/machine.js';
import {
  ATTACK_READY,
  attackRate,
  attackTiming,
  defaultAttackTuning,
  dummyLean,
  phaseAt,
  stepAttack,
  type AttackState,
  type AttackTuning,
} from './sandbox-attack.js';
import { STRIKE_DURATION_MS } from '../../units/pig-strike.js';
import { actionTotalMs, timeScaleFor } from '../../units/timing.js';

const TICK = DEFAULT_TICK_MS;

/** Runs a whole swing and reports the ticks the interesting things happened on. */
function rehearse(tuning: AttackTuning, ticks = 400): { started: number[]; hits: number[]; free: number } {
  let state: AttackState = ATTACK_READY;
  const started: number[] = [];
  const hits: number[] = [];
  let free = -1;
  for (let tick = 0; tick < ticks; tick += 1) {
    // Swing on the first tick only: everything after is the rehearsal's own.
    const step = stepAttack(state, tuning, tick === 0, TICK);
    state = step.state;
    if (step.started) started.push(tick);
    if (step.hit) hits.push(tick);
    if (free < 0 && tick > 0 && state.phase === 'ready') free = tick;
  }
  return { started, hits, free };
}

describe('a swing lands when the timing says', () => {
  it('hits on the tick the wind-up ends, at every wind-up a slider can reach', () => {
    const base = defaultAttackTuning();
    for (let windupMs = 100; windupMs <= 1600; windupMs += 10) {
      const { hits } = rehearse({ ...base, windupMs, cooldownMs: 3000 });
      expect(hits.length).toBe(1);
      // The rehearsal starts on tick 0 and counts from the tick after, so the
      // blow lands on the tick that *reaches* the wind-up's length in ticks.
      const expected = Math.max(1, Math.round(windupMs / TICK));
      expect(hits[0]).toBe(expected);
    }
  });

  it('hits exactly once, however long it is left running', () => {
    const { started, hits } = rehearse(defaultAttackTuning(), 2000);
    expect(started).toEqual([0]);
    expect(hits.length).toBe(1);
  });

  it('refuses a second swing until it is free again', () => {
    const tuning = defaultAttackTuning();
    let state: AttackState = ATTACK_READY;
    let starts = 0;
    // Ask on every single tick. A queue would fire them later at a moment
    // nobody chose, which in a tuning tool means the number you just dragged is
    // not the number you are watching.
    for (let tick = 0; tick < 36; tick += 1) {
      const step = stepAttack(state, tuning, true, TICK);
      state = step.state;
      if (step.started) starts += 1;
    }
    expect(starts).toBe(1);
  });

  it('comes back to ready, so the sandbox never wedges', () => {
    for (const windupMs of [100, 500, 900, 1600]) {
      for (const cooldownMs of [100, 600, 3000]) {
        const { free } = rehearse({ ...defaultAttackTuning(), windupMs, cooldownMs }, 500);
        expect(free).toBeGreaterThan(0);
      }
    }
  });

  it('counts the cooldown from the start of the swing, not the end', () => {
    // Which is how `melee.slash` stamps it: a long wind-up eats into the
    // cooldown rather than adding to it.
    const tuning: AttackTuning = { windupMs: 500, activeMs: 100, recoveryMs: 200, cooldownMs: 1200 };
    const { free } = rehearse(tuning, 400);
    expect(free).toBe(Math.round(1200 / TICK));
  });

  it('walks windup -> active -> recovery in that order and no other', () => {
    const tuning = defaultAttackTuning();
    const seen: string[] = [];
    for (let tick = 0; tick <= 60; tick += 1) {
      const phase = phaseAt(tick, tuning, TICK);
      if (seen[seen.length - 1] !== phase) seen.push(phase);
    }
    expect(seen).toEqual(['windup', 'active', 'recovery', 'ready']);
  });

  it('is pure: the same inputs give the same ticks', () => {
    const tuning = { ...defaultAttackTuning(), windupMs: 733 };
    expect(rehearse(tuning)).toEqual(rehearse(tuning));
  });
});

describe('the clip is rescaled to the timing', () => {
  it('plays at exactly `timeScaleFor` of what the sliders say', () => {
    // The one rule spec 107 is about, and the reason this tab is worth opening.
    for (const windupMs of [200, 500, 900, 1400]) {
      const tuning = { ...defaultAttackTuning(), windupMs };
      const timing = attackTiming(tuning, 'slash');
      expect(attackRate(tuning, STRIKE_DURATION_MS)).toBe(timeScaleFor(timing, STRIKE_DURATION_MS));
    }
  });

  it('plays the shipped swing at its authored speed', () => {
    // The defaults are the pig's own action timing, so opening the tab shows
    // the swing that ships rather than one somebody invented for a slider.
    const tuning = defaultAttackTuning();
    expect(actionTotalMs(attackTiming(tuning, 'slash'))).toBe(STRIKE_DURATION_MS);
    expect(attackRate(tuning, STRIKE_DURATION_MS)).toBeCloseTo(1, 9);
  });

  it('slows down for a longer wind-up rather than pausing before a fast one', () => {
    const slow = attackRate({ ...defaultAttackTuning(), windupMs: 1400 }, STRIKE_DURATION_MS);
    const quick = attackRate({ ...defaultAttackTuning(), windupMs: 200 }, STRIKE_DURATION_MS);
    expect(slow).toBeLessThan(1);
    expect(quick).toBeGreaterThan(1);
  });

  it('names the clip and the events the pig\'s own document does', () => {
    const timing = attackTiming(defaultAttackTuning(), 'slash');
    expect(timing.actionId).toBe('basic.attack');
    expect(timing.eventMap).toEqual({ windup: 'swing.start', active: 'swing.impact' });
  });
});

describe('the dummy flinches', () => {
  it('starts at its hardest and settles to nothing', () => {
    expect(Math.abs(dummyLean(0))).toBeGreaterThan(0.4);
    expect(Math.abs(dummyLean(60))).toBeLessThan(0.01);
    expect(dummyLean(-1)).toBe(0);
  });

  it('swings back, so it reads as an impact rather than a push', () => {
    // A monotone return is a shove. Somewhere in the first second it has to
    // cross zero and come back the other way.
    const samples = Array.from({ length: 40 }, (_, tick) => dummyLean(tick));
    expect(samples.some((value) => value < -0.02)).toBe(true);
    expect(samples.some((value) => value > 0.02)).toBe(true);
  });

  it('is a function of a tick count, so a screenshot is reproducible', () => {
    expect(dummyLean(7)).toBe(dummyLean(7));
  });
});
