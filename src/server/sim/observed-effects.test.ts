/**
 * The audit's second question, and whether it can answer it (spec 272).
 *
 * `audit:progression` proves a purchase moves a trait. Steady Aim moved one and
 * could not fire, so this pass asks the other half -- does a real fight ever
 * satisfy the gate -- and the test that matters is the one that puts Steady Aim
 * back and requires it to be caught.
 */

import { describe, expect, it } from 'vitest';

import { CONDITIONAL_PROBES, observeAll, observeProbe, type ConditionalProbe } from './observed-effects.js';
import { StatusId, hasStatus } from './statuses.js';

describe('the observation pass', () => {
  it('sees every conditional in the table fire under its own scenario', () => {
    for (const observation of observeAll()) {
      expect(observation.observed, `${observation.id}: ${observation.gate}`).toBe(true);
    }
  });

  it('makes each scenario actually do something', () => {
    // A probe that never attacked proves nothing about its gate, and would
    // report OBSERVED or NOT OBSERVED equally meaninglessly. `int.prepared` is
    // the deliberate exception: what it is gated on is *not* attacking.
    for (const observation of observeAll()) {
      if (observation.id === 'int.prepared') continue;
      expect(observation.blows, `${observation.id} never attacked`).toBeGreaterThan(0);
    }
  });

  /**
   * The regression test for the pass itself.
   *
   * Steady Aim's gate, reconstructed exactly: "was the attacker still for half a
   * second at the instant the blow landed". `startCast` stamps `stillSinceTick`
   * and `advanceProgression` re-stamps it every tick a cast is live, in a pass
   * that runs *before* casts resolve -- so the answer is 0 on every blow, at
   * every weapon, range and attribute value.
   *
   * If this ever starts reporting OBSERVED, the pass has stopped being able to
   * see the class of bug it was built for.
   */
  it('catches a gate the simulation can never satisfy', () => {
    const steadyAim: ConditionalProbe = {
      id: 'per.steadyAim (reconstructed)',
      gate: 'the attacker was still for 30 ticks at the moment the blow landed',
      attributes: { perception: 60 },
      specializations: [{ specializationId: 'per.weakPointStudy', tier: 3 }],
      equipment: { mainHand: 'sword.worn' },
      plan: { ticks: 1200, attackWith: 'melee.slash' },
      observe: (frame, selfId) =>
        frame.events.some((e) => e.kind === 'hit' && e.attackerId === selfId) &&
        frame.tick - frame.self.stillSinceTick >= 30,
    };
    const observed = observeProbe(steadyAim);
    expect(observed.blows, 'the scenario never swung').toBeGreaterThan(0);
    expect(observed.observed, 'an unsatisfiable gate was reported as live').toBe(false);
    expect(observed.count).toBe(0);
  });

  /**
   * The other half of the same claim: a gate that *is* satisfiable must not be
   * reported. Without this, a pass that reported everything as dead would score
   * a perfect result on the test above.
   */
  it('does not report a live conditional', () => {
    const live: ConditionalProbe = {
      id: 'control',
      gate: 'the attacker landed a blow at all',
      attributes: { perception: 60 },
      specializations: [],
      equipment: { mainHand: 'sword.worn' },
      plan: { ticks: 600, attackWith: 'melee.slash' },
      observe: (frame, selfId) =>
        frame.events.some((e) => e.kind === 'hit' && e.attackerId === selfId),
    };
    expect(observeProbe(live).observed).toBe(true);
  });

  it('is stable across seeds, so a red row is a bug rather than a roll', () => {
    for (const seed of [1, 2, 7]) {
      for (const observation of observeAll(seed)) {
        expect(observation.observed, `${observation.id} at seed ${String(seed)}`).toBe(true);
      }
    }
  });

  it('covers every Perception specialization whose payoff is conditional', () => {
    // The table is small on purpose, but it has to stay honest about what it
    // claims to watch: each of these has a runtime gate, and a row dropped from
    // the table is a mechanic nobody is checking any more.
    const ids = new Set(CONDITIONAL_PROBES.map((p) => p.id));
    for (const required of [
      'per.patientRead',
      'per.patientRead/ability',
      'per.exploit',
      'per.resourceSense',
      'per.openingRead',
    ]) {
      expect(ids.has(required), `${required} is not watched`).toBe(true);
    }
  });

  it('keeps Patient Read out of a fight that never stops attacking', () => {
    // The mechanic's own cost, asserted from the other side: the same character
    // swinging freely never banks a read, so the payoff really is bought with
    // attacks given up rather than arriving on its own.
    const impatient: ConditionalProbe = {
      ...(CONDITIONAL_PROBES.find((p) => p.id === 'per.patientRead') as ConditionalProbe),
      id: 'per.patientRead (impatient)',
      plan: { ticks: 1400, attackWith: 'melee.slash' },
      observe: (frame) => hasStatus(frame.self.statuses, StatusId.PatientRead, frame.tick),
    };
    const observed = observeProbe(impatient);
    expect(observed.blows).toBeGreaterThan(5);
    expect(observed.observed, 'a read banked while attacking freely').toBe(false);
  });
});
