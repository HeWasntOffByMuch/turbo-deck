/**
 * The effect vocabulary (spec 184).
 *
 * `active-skills.test.ts` drives the four shipped skills through the real tick;
 * this file drives the *verbs* -- including the three no shipped row uses yet --
 * against hand-written definitions, because the point of a vocabulary is that a
 * row nobody has written yet will behave.
 *
 * What every case here is really asserting is that the effect reached the
 * system that owns it: a status in the status map, a heal through the healing
 * economy, a stun in the stagger the game already has. An effect that produced
 * the right number by its own arithmetic would pass a worse version of these
 * tests and be exactly the second combat system the brief forbids.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import type { AbilityDefinition } from '../data/abilities.js';
import type { SkillEffect } from '../data/skill-effects.js';
import { monsterById } from '../data/monsters.js';
import { applyEffects } from './skill-effects.js';
import { applyStatus, statusOf, StatusId } from './statuses.js';
import { ActivityValue, EntityKindValue, type ServerEntity } from './types.js';
import { createWorldState, spawnEntity } from './world.js';

const DUMMY = monsterById('dummy');
if (DUMMY === null) throw new Error('no dummy');
const dummy = DUMMY;

function place(x: number): ServerEntity {
  return spawnEntity(createWorldState(3), {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y: 0, z: 0 },
    stats: dummy.stats,
    radius: dummy.radius,
    zoneId: 'greenmarch',
  }).entity;
}

/** A definition that exists only to carry `effects`. Nothing else reads it. */
function skill(effects: readonly SkillEffect[], damage = 10): AbilityDefinition {
  return {
    id: 'test.skill',
    name: 'Test',
    kind: 'melee',
    targeting: 'unit',
    windupTicks: 10,
    cooldownTicks: 10,
    cost: 0,
    range: 100,
    damage,
    effects,
    description: 'a fixture',
  };
}

const TICK = 100;

function apply(effects: readonly SkillEffect[], caster: ServerEntity, target: ServerEntity, damage = 10) {
  return applyEffects(skill(effects, damage), caster, target, TICK, Rng.fromSeed(1));
}

describe('damage', () => {
  it('goes through the blow pipeline, not through its own arithmetic', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply([{ kind: 'damage' }], caster, target);
    expect(result.target.health).toBeLessThan(target.health);
    // A `hit` event, which is the one thing every damage source in this game
    // emits and the client's only path for a floating number.
    expect(result.events.some((event) => event.kind === 'hit')).toBe(true);
  });

  it('takes the row’s damage when the effect names none', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const small = apply([{ kind: 'damage' }], caster, target, 5);
    const large = apply([{ kind: 'damage' }], caster, target, 50);
    expect(large.target.health).toBeLessThan(small.target.health);
  });

  it('takes the effect’s own amount over the row’s', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const overridden = apply([{ kind: 'damage', amount: 50 }], caster, target, 5);
    const plain = apply([{ kind: 'damage' }], caster, target, 5);
    expect(overridden.target.health).toBeLessThan(plain.target.health);
  });

  it('scales by a multiplier', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const half = apply([{ kind: 'damage', multiplier: 0.5 }], caster, target, 40);
    const whole = apply([{ kind: 'damage' }], caster, target, 40);
    expect(half.target.health).toBeGreaterThan(whole.target.health);
  });
});

describe('statuses', () => {
  it('applies one through the status map', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply(
      [{ kind: 'applyStatus', statusId: StatusId.Slowed, durationTicks: 60, magnitude: 0.3 }],
      caster,
      target,
    );
    const held = statusOf(result.target.statuses, StatusId.Slowed, TICK);
    expect(held?.magnitude).toBeCloseTo(0.3, 6);
    expect(held?.expiresAtTick).toBe(TICK + 60);
  });

  /**
   * The other half of the brief's "apply existing status effects / remove
   * existing status effects". No shipped row uses it yet; the verb is here so
   * that a dispel is a row rather than a new pipeline.
   */
  it('removes one through the same map', () => {
    const caster = { ...place(0), id: 1 };
    const held = {
      ...place(50),
      id: 2,
      statuses: applyStatus({}, StatusId.Flow, TICK, 120, { magnitude: 1 }),
    };
    expect(statusOf(held.statuses, StatusId.Flow, TICK)).toBeTruthy();
    const result = apply([{ kind: 'removeStatus', statusId: StatusId.Flow }], caster, held);
    expect(statusOf(result.target.statuses, StatusId.Flow, TICK)).toBeNull();
  });

  it('leaves a status the target never had alone', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply([{ kind: 'removeStatus', statusId: StatusId.Flow }], caster, target);
    expect(result.target.statuses).toEqual(target.statuses);
  });
});

describe('guard', () => {
  it('takes the pool down without breaking it, however much is asked for', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply([{ kind: 'poise', amount: -100000 }], caster, target);
    expect(result.target.poise).toBe(0);
    // Emptied, and *not* staggered: stripping guard and knocking somebody down
    // are different asks, and one effect that sometimes did the other would
    // make a skill's behaviour depend on how full its target happened to be.
    expect(result.target.activity).not.toBe(ActivityValue.Stunned);
    expect(result.events.some((event) => event.kind === 'poiseBroken')).toBe(false);
  });

  it('restores it, never above the pool’s own ceiling', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2, poise: 1 };
    const result = apply([{ kind: 'poise', amount: 100000 }], caster, target);
    expect(result.target.poise).toBe(target.stats.traits.maxPoise);
  });

  it('breaks the pool through the break machinery when it is damage', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply(
      [{ kind: 'poiseDamage', amount: target.stats.traits.maxPoise * 2 }],
      caster,
      target,
    );
    expect(result.target.activity).toBe(ActivityValue.Stunned);
    expect(result.events.some((event) => event.kind === 'poiseBroken')).toBe(true);
  });
});

describe('stuns', () => {
  it('roots the body for what the row says', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply([{ kind: 'stun', ticks: 45 }], caster, target);
    expect(result.target.activity).toBe(ActivityValue.Stunned);
    expect(result.target.activityUntilTick).toBe(TICK + 45);
  });

  it('respects the immunity window that stops a chain', () => {
    const caster = { ...place(0), id: 1 };
    const immune = { ...place(50), id: 2, staggerImmuneUntilTick: TICK + 60 };
    const result = apply([{ kind: 'stun', ticks: 45 }], caster, immune);
    expect(result.target.activity).not.toBe(ActivityValue.Stunned);
  });

  it('never stuns a corpse', () => {
    const caster = { ...place(0), id: 1 };
    const dead = { ...place(50), id: 2, health: 0 };
    const result = apply([{ kind: 'stun', ticks: 45 }], caster, dead);
    expect(result.target.activity).not.toBe(ActivityValue.Stunned);
  });
});

describe('which body an effect lands on', () => {
  it('points at the target by default', () => {
    const caster = { ...place(0), id: 1, health: 1 };
    const target = { ...place(50), id: 2, health: 1 };
    const result = apply([{ kind: 'heal', amount: 20 }], caster, target);
    expect(result.target.health).toBeGreaterThan(1);
    expect(result.caster.health).toBe(1);
  });

  /** How one row says "and it does this to *me*" -- a strike that heals. */
  it('points at the caster when the row says so', () => {
    const caster = { ...place(0), id: 1, health: 1 };
    const target = { ...place(50), id: 2, health: 1 };
    const result = apply([{ kind: 'heal', amount: 20, on: 'caster' }], caster, target);
    expect(result.caster.health).toBeGreaterThan(1);
    expect(result.target.health).toBe(1);
  });

  it('drains a target’s pool when the row points there', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2, resource: 10, stats: { ...dummy.stats, maxResource: 20 } };
    const result = apply([{ kind: 'resource', amount: -4 }], caster, target);
    expect(result.target.resource).toBe(6);
  });

  it('never drains a pool below empty or fills one past its ceiling', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2, resource: 2, stats: { ...dummy.stats, maxResource: 20 } };
    expect(apply([{ kind: 'resource', amount: -100 }], caster, target).target.resource).toBe(0);
    expect(apply([{ kind: 'resource', amount: 100 }], caster, target).target.resource).toBe(20);
  });
});

describe('a list', () => {
  /**
   * Order is the skill. Guard Break strips before it damages so the damage
   * lands on a body whose pool is already down, and reordering the rows is a
   * balance change rather than a refactor.
   */
  it('runs in the order the row wrote it', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const max = target.stats.traits.maxPoise;
    // Strip to nothing, then put half back: the second effect sees the first.
    const result = apply(
      [
        { kind: 'poise', amount: -max },
        { kind: 'poise', amount: max / 2 },
      ],
      caster,
      target,
    );
    expect(result.target.poise).toBeCloseTo(max / 2, 5);
  });

  it('threads the rng, so a replay draws the same values in the same order', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const first = apply([{ kind: 'damage' }, { kind: 'damage' }], caster, target);
    const again = apply([{ kind: 'damage' }, { kind: 'damage' }], caster, target);
    expect(first.target.health).toBe(again.target.health);
    // Two damage effects draw twice, so the stream has moved on.
    const once = apply([{ kind: 'damage' }], caster, target);
    expect(once.rng.getState()).not.toEqual(first.rng.getState());
  });

  it('does nothing at all for a row with an empty list', () => {
    const caster = { ...place(0), id: 1 };
    const target = { ...place(50), id: 2 };
    const result = apply([], caster, target);
    expect(result.target).toEqual(target);
    expect(result.events).toHaveLength(0);
  });
});
