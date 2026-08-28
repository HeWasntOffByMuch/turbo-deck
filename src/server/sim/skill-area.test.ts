/**
 * Who an area skill catches (spec 188).
 *
 * Pure geometry, so it is tested as geometry: bodies placed by hand at known
 * distances, and the answer compared to what a ruler says. Everything about
 * *applying* a skill is somewhere else -- this file asks only "who is in the
 * shape", which is the half the brief calls out as needing to be extensible to
 * new shapes without a new pipeline.
 */

import { describe, expect, it } from 'vitest';
import type { SkillArea } from '../data/skill-effects.js';
import { monsterById } from '../data/monsters.js';
import { arcCosSqOf, areaReachOf, scaleArea, selectByArea } from './skill-area.js';
import { EntityKindValue, type ServerEntity } from './types.js';
import { createWorldState, spawnEntity } from './world.js';

const DUMMY = monsterById('dummy');
if (DUMMY === null) throw new Error('no dummy');
const dummy = DUMMY;

/**
 * A body at a place, built through the real `spawnEntity`.
 *
 * Through the real one rather than from a literal, so a field added to
 * `ServerEntity` cannot leave this file testing a shape the sim never produces.
 * The ids are whatever the world hands out, so the tests below compare
 * *positions* by way of a lookup rather than asserting on the numbers.
 */
function place(x: number, y: number, radius = 10, health = dummy.stats.maxHealth): ServerEntity {
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y, z: 0 },
    stats: dummy.stats,
    radius,
    zoneId: 'greenmarch',
    health,
  });
  return spawned.entity;
}

/** Named bodies, so an assertion reads as a place rather than as an id. */
const body = (name: number, x: number, y: number, radius = 10): ServerEntity => ({
  ...place(x, y, radius),
  id: name,
});

/** The caster: at the origin, facing +x. */
const caster = (): ServerEntity => ({ ...place(0, 0, 16), id: 1, facing: 0 });

/** The aim 100 units along +x, which is where a caster facing 0 is pointing. */
const AIM = { x: 100, y: 0 };

const idsOf = (found: readonly ServerEntity[]): number[] => found.map((entity) => entity.id);

describe('a circle', () => {
  const around: SkillArea = { shape: 'circle', origin: 'caster', radius: 50 };

  it('catches what is inside it and nothing that is not', () => {
    const inside = body(2, 40, 0);
    const outside = body(3, 120, 0);
    expect(idsOf(selectByArea(around, caster(), AIM, [inside, outside]))).toEqual([2]);
  });

  /**
   * The same rule every other landing in this game follows: reach is measured
   * to a body's *edge*, so a large body is clipped by the rim rather than
   * having to stand in the middle.
   */
  it('measures to a body’s edge, not its centre', () => {
    const big = body(2, 58, 0, 10);
    expect(idsOf(selectByArea(around, caster(), AIM, [big]))).toEqual([2]);
    // One unit further and even its edge is outside.
    expect(selectByArea(around, caster(), AIM, [body(2, 61, 0, 10)])).toHaveLength(0);
  });

  it('never catches its own caster, however small the circle', () => {
    const self = caster();
    expect(selectByArea(around, self, AIM, [self])).toHaveLength(0);
  });

  it('never catches a corpse', () => {
    const dead = { ...body(2, 10, 0), health: 0 };
    expect(selectByArea(around, caster(), AIM, [dead])).toHaveLength(0);
  });

  it('centres on the aim when the row says so', () => {
    const atAim: SkillArea = { shape: 'circle', origin: 'aim', radius: 30 };
    const nearCaster = body(2, 10, 0);
    const nearAim = body(3, 110, 0);
    expect(idsOf(selectByArea(atAim, caster(), AIM, [nearCaster, nearAim]))).toEqual([3]);
  });

  it('stops at maxTargets, in candidate order', () => {
    const capped: SkillArea = { shape: 'circle', origin: 'caster', radius: 60, maxTargets: 2 };
    const found = selectByArea(capped, caster(), AIM, [body(2, 10, 0), body(3, 20, 0), body(4, 30, 0)]);
    expect(idsOf(found)).toEqual([2, 3]);
  });

  it('catches nobody at a cap of zero, rather than everybody', () => {
    const none: SkillArea = { shape: 'circle', origin: 'caster', radius: 60, maxTargets: 0 };
    expect(selectByArea(none, caster(), AIM, [body(2, 10, 0)])).toHaveLength(0);
  });
});

describe('a cone', () => {
  // 90 degrees: 45 either side of the aim.
  const wedge: SkillArea = { shape: 'cone', angleDeg: 90, range: 100 };

  it('takes the full opening angle, not the half angle', () => {
    // cos(45)^2 = 0.5, which is exactly the `arcCosSq` the melee swing has
    // always used for a 90-degree wedge.
    expect(arcCosSqOf(90)).toBeCloseTo(0.5, 6);
  });

  it('catches what is in front and not what is beside or behind', () => {
    const ahead = body(2, 60, 0, 0);
    const beside = body(3, 0, 60, 0);
    const behind = body(4, -60, 0, 0);
    expect(idsOf(selectByArea(wedge, caster(), AIM, [ahead, beside, behind]))).toEqual([2]);
  });

  it('runs toward the aim rather than toward the body’s heading', () => {
    // Facing +x, aimed at +y. The cone follows the aim, which is the rule spec
    // 062 states for every landing: turning mid-wind-up cannot re-point a blow.
    const up = body(2, 0, 60, 0);
    expect(idsOf(selectByArea(wedge, caster(), { x: 0, y: 100 }, [up]))).toEqual([2]);
  });

  it('reaches only as far as its range', () => {
    expect(selectByArea(wedge, caster(), AIM, [body(2, 140, 0, 0)])).toHaveLength(0);
  });
});

describe('a line', () => {
  const lane: SkillArea = { shape: 'line', width: 40, range: 200 };

  it('catches what is within half its width of the line', () => {
    const on = body(2, 100, 19, 0);
    const off = body(3, 100, 21, 0);
    expect(idsOf(selectByArea(lane, caster(), AIM, [on, off]))).toEqual([2]);
  });

  it('does not reach behind the caster', () => {
    expect(selectByArea(lane, caster(), AIM, [body(2, -80, 0, 0)])).toHaveLength(0);
  });

  it('stops at its range', () => {
    expect(idsOf(selectByArea(lane, caster(), AIM, [body(2, 190, 0, 0)]))).toEqual([2]);
    expect(selectByArea(lane, caster(), AIM, [body(3, 240, 0, 0)])).toHaveLength(0);
  });
});

describe('shaping', () => {
  it('scales a circle’s radius and a cone’s range, and nothing else', () => {
    const circle: SkillArea = { shape: 'circle', origin: 'caster', radius: 100 };
    expect(areaReachOf(scaleArea(circle, 1.5))).toBe(150);

    const cone: SkillArea = { shape: 'cone', angleDeg: 60, range: 100 };
    const wider = scaleArea(cone, 2);
    expect(areaReachOf(wider)).toBe(200);
    // The *angle* is untouched: shaping makes a spell reach further, and a cone
    // that also opened wider would be two effects sold as one.
    expect(wider.shape === 'cone' && wider.angleDeg).toBe(60);
  });

  it('never scales a reach negative', () => {
    const circle: SkillArea = { shape: 'circle', origin: 'caster', radius: 100 };
    expect(areaReachOf(scaleArea(circle, -3))).toBe(0);
  });
});
