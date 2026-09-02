/**
 * The metrics fold (spec 147).
 *
 * A counter that is wrong is worse than no counter, because a balance decision
 * gets made on it. The two properties worth holding: an event is counted from
 * *both* sides when it concerns both, and a build's row contains nothing that
 * belongs to somebody else's.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_METRICS,
  foldMetrics,
  foldPosture,
  foldResource,
  summarise,
} from './metrics.js';
import { CastEndReason, CastPhase, type ServerSimEvent } from './types.js';

const REASONS = {
  cancelled: CastEndReason.Cancelled,
  backswingCancelled: CastEndReason.BackswingCancelled,
  backswingPhase: CastPhase.Backswing,
  interrupted: CastEndReason.Interrupted,
};

function hit(attackerId: number, targetId: number, damage: number, extra: Partial<Extract<ServerSimEvent, { kind: 'hit' }>> = {}): ServerSimEvent {
  return {
    kind: 'hit',
    attackerId,
    targetId,
    damage,
    targetHealth: 100,
    killed: false,
    critical: false,
    blocked: false,
    weakPoint: false,
    ...extra,
  };
}

describe('folding one tick', () => {
  it('counts a blow from both sides, and only the side that applies', () => {
    const events = [hit(1, 2, 30)];
    const attacker = foldMetrics(EMPTY_METRICS, 1, 5, events, REASONS);
    const target = foldMetrics(EMPTY_METRICS, 2, 5, events, REASONS);
    const bystander = foldMetrics(EMPTY_METRICS, 3, 5, events, REASONS);

    expect(attacker.damageDealt).toBe(30);
    expect(attacker.damageTaken).toBe(0);
    expect(attacker.hits).toBe(1);
    expect(target.damageTaken).toBe(30);
    expect(target.damageDealt).toBe(0);
    expect(target.hits).toBe(0);
    expect(bystander).toEqual({ ...EMPTY_METRICS, ticks: 5 });
  });

  it('reads a heal off the negative-damage hit rather than needing its own event', () => {
    const healed = foldMetrics(EMPTY_METRICS, 1, 1, [hit(1, 1, -40)], REASONS);
    expect(healed.healingReceived).toBe(40);
    expect(healed.damageDealt).toBe(0);
    expect(healed.damageTaken).toBe(0);
    expect(healed.hits).toBe(0);
  });

  it('separates the weak point from the crit', () => {
    const both = foldMetrics(
      EMPTY_METRICS,
      1,
      1,
      [hit(1, 2, 10, { weakPoint: true }), hit(1, 2, 10, { critical: true })],
      REASONS,
    );
    expect(both.hits).toBe(2);
    expect(both.weakPoints).toBe(1);
    expect(both.criticals).toBe(1);
  });

  it('counts a break for the breaker and the broken, differently', () => {
    const events: ServerSimEvent[] = [{ kind: 'poiseBroken', entityId: 2, breakerId: 1, ticks: 30 }];
    const breaker = foldMetrics(EMPTY_METRICS, 1, 1, events, REASONS);
    const broken = foldMetrics(EMPTY_METRICS, 2, 1, events, REASONS);
    expect(breaker.staggersCaused).toBe(1);
    expect(breaker.ticksStaggered).toBe(0);
    expect(broken.staggersTaken).toBe(1);
    expect(broken.ticksStaggered).toBe(30);
  });

  it('tells a withdrawal from a walked-out follow-through', () => {
    // The distinction Agility's whole loop turns on, so counting them together
    // would hide exactly the behaviour the harness exists to show.
    const events: ServerSimEvent[] = [
      { kind: 'castEnded', entityId: 1, abilityId: 'melee.slash', reason: CastEndReason.Cancelled },
      { kind: 'castEnded', entityId: 1, abilityId: 'melee.slash', reason: CastEndReason.BackswingCancelled },
      { kind: 'castEnded', entityId: 1, abilityId: 'melee.slash', reason: CastEndReason.Released },
    ];
    const folded = foldMetrics(EMPTY_METRICS, 1, 1, events, REASONS);
    expect(folded.castsWithdrawn).toBe(1);
    expect(folded.backswingsCancelled).toBe(1);
  });

  it('counts a commit off the backswing phase, and a use off the others', () => {
    const started = (phase: number): ServerSimEvent => ({
      kind: 'castStarted',
      entityId: 1,
      abilityId: 'skill.blight',
      phase,
      startTick: 0,
      releaseTick: 10,
      endTick: 20,
      targetX: 0,
      targetY: 0,
      targetEntityId: 0,
    });
    const folded = foldMetrics(
      EMPTY_METRICS,
      1,
      1,
      [started(CastPhase.Windup), started(CastPhase.Backswing)],
      REASONS,
    );
    expect(folded.abilityUses['skill.blight']).toBe(1);
    expect(folded.castsCommitted).toBe(1);
  });

  it('never mutates what it was handed', () => {
    const before = JSON.stringify(EMPTY_METRICS);
    foldMetrics(EMPTY_METRICS, 1, 9, [hit(1, 2, 5)], REASONS);
    expect(JSON.stringify(EMPTY_METRICS)).toBe(before);
  });
});

describe('sampled counters', () => {
  it('reads spending and regen as two directions of one delta', () => {
    const spent = foldResource(EMPTY_METRICS, { resource: 40, shield: 0 }, { resource: 33, shield: 0 });
    expect(spent.resourceSpent).toBe(7);
    expect(spent.resourceRestored).toBe(0);
    const back = foldResource(spent, { resource: 33, shield: 0 }, { resource: 35, shield: 0 });
    expect(back.resourceSpent).toBe(7);
    expect(back.resourceRestored).toBe(2);
  });

  it('counts a shrinking shield as absorbed, and a growing one as nothing', () => {
    const absorbed = foldResource(EMPTY_METRICS, { resource: 0, shield: 20 }, { resource: 0, shield: 5 });
    expect(absorbed.damageAbsorbed).toBe(15);
    const granted = foldResource(absorbed, { resource: 0, shield: 5 }, { resource: 0, shield: 40 });
    expect(granted.damageAbsorbed).toBe(15);
  });

  it('counts a rooted tick only when the body is committed', () => {
    let metrics = foldPosture(EMPTY_METRICS, true);
    metrics = foldPosture(metrics, false);
    metrics = foldPosture(metrics, true);
    expect(metrics.ticksRooted).toBe(2);
  });
});

describe('the summary', () => {
  it('is every ratio, so builds of different lengths compare', () => {
    const metrics = {
      ...EMPTY_METRICS,
      ticks: 120,
      damageDealt: 600,
      damageTaken: 100,
      damageAbsorbed: 100,
      hits: 20,
      weakPoints: 5,
      staggersCaused: 4,
      ticksStaggered: 30,
      ticksRooted: 60,
      resourceSpent: 50,
      resourceRestored: 75,
      castsCommitted: 20,
      backswingsCancelled: 15,
      kills: 2,
    };
    const summary = summarise(metrics, 60);
    expect(summary.dps).toBeCloseTo(300, 6);
    expect(summary.healthPerKill).toBe(50);
    expect(summary.absorbFraction).toBeCloseTo(0.5, 9);
    expect(summary.weakPointRate).toBeCloseTo(0.25, 9);
    expect(summary.staggersPerKill).toBe(2);
    expect(summary.controlledFraction).toBeCloseTo(0.25, 9);
    expect(summary.resourceRatio).toBeCloseTo(1.5, 9);
    expect(summary.cancelRate).toBeCloseTo(0.75, 9);
    expect(summary.rootedFraction).toBeCloseTo(0.5, 9);
  });

  it('never divides by zero, on a build that did nothing at all', () => {
    const summary = summarise(EMPTY_METRICS, 60);
    for (const [key, value] of Object.entries(summary)) {
      expect(Number.isFinite(value), key).toBe(true);
    }
    // A build with no kills reports its damage taken whole rather than as
    // infinity -- the row still has to be readable, and "died having killed
    // nothing" is exactly the row somebody needs to see.
    expect(summarise({ ...EMPTY_METRICS, damageTaken: 40 }, 60).healthPerKill).toBe(40);
  });
});
