/**
 * The Intelligence track's own mechanics (spec 270).
 *
 * Prepared's lifecycle is asserted next door in `progression-combat.test.ts`,
 * beside the rest of the trait derivation it belongs to. What is here is the
 * three things that are only true once a *fight* is running: the weave chain,
 * the overdraw, and whether the magazine actually empties.
 *
 * Every one of the three was chosen because a table test cannot see it. Weaving
 * is a property of the order casts arrive in; overdraw is a property of the
 * moment a pool runs out mid-cast; and "does a caster run dry" is a question
 * about a rotation over time rather than about any one number.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { SCALING } from '../data/scaling.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { overflowCostFor, resourceCostFor } from './abilities.js';
import { statusOf, StatusId } from './statuses.js';
import { EntityKindValue, type ServerEntity, type ServerInput } from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';
import type { ServerWorldState } from './types.js';

// --- the rig ---------------------------------------------------------------

/** The four Intelligence sigils a caster needs to have anything to weave. */
const CASTER_SIGILS: Equipment = {
  ...EMPTY_EQUIPMENT,
  skill1: 'sigil.emberToss',
  skill2: 'sigil.acidSpray',
  skill3: 'sigil.arcLash',
  skill4: 'sigil.blight',
};

function record(
  baseStats: Partial<BaseStats>,
  specializations: readonly SpecializationAllocation[] = [],
  equipment: Equipment = CASTER_SIGILS,
): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'p1',
    baseStats: { ...startingBaseStats(), ...baseStats } as BaseStats,
    specializations,
    equipment,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 1000,
    coins: 0,
  };
}

function statsFor(
  baseStats: Partial<BaseStats>,
  specializations: readonly SpecializationAllocation[] = [],
): EffectiveStats {
  return computeEffectiveStats(record(baseStats, specializations));
}

const CHUNK = 100;

function context(): StepContext {
  const keys = new Set<string>();
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) keys.add(chunkKeyOf(600 + dx * CHUNK, 450 + dy * CHUNK, CHUNK));
  }
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: keys,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

function input(entityId: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq: 1,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: 0,
    predictedY: 0,
    hasPrediction: false,
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
    cancelCast: false,
    ...overrides,
  };
}

interface Rig {
  state: ServerWorldState;
  casterId: number;
  targetId: number;
}

function duel(stats: EffectiveStats): Rig {
  let state = createWorldState(7);
  const caster = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: 600, y: 450, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = caster.state;
  // The roster's own training dummy, not a copy of the caster's stats with the
  // damage zeroed. The first cut did the latter and the dummy hit back with the
  // *player's* weapon range -- `attackDamage` is the midpoint a stagger is sized
  // off since spec 217, and what a blow actually rolls is
  // `weaponDamageMin/Max`, which came along in the spread. It cost 312 health in
  // a test measuring a 4-health overdraw.
  const row = monsterById('dummy');
  if (!row) throw new Error('no training dummy in the roster');
  const dummy = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: row.id,
    position: { x: 660, y: 450, z: 0 },
    // A wall to cast at: enough health that nothing under test is cut short by
    // the target dying.
    stats: { ...row.stats, maxHealth: 100000 },
    radius: row.radius,
    zoneId: 'greenmarch',
  });
  state = replaceEntity(dummy.state, { ...dummy.entity, health: 100000 });
  return { state, casterId: caster.entity.id, targetId: dummy.entity.id };
}

/**
 * The lowest health the caster was seen at during the last {@link castOnce}.
 *
 * Needed because the caster is standing in a rest zone: `advanceRest` puts the
 * health an overdraw took straight back over the hundred-odd ticks a cast runs
 * for, so a delta measured *after* one is a delta measured after the game has
 * already healed it. The floor is what the spell actually cost.
 */
const SAMPLE = { lowest: Number.POSITIVE_INFINITY };

/** Cast `abilityId` and run until it has committed, returning the caster. */
function castOnce(rig: Rig, abilityId: string, ticks = 120): Rig {
  const ability = abilityById(abilityId);
  if (!ability) throw new Error(`no such ability: ${abilityId}`);
  const target = rig.state.entities.get(rig.targetId);
  let state = rig.state;
  SAMPLE.lowest = state.entities.get(rig.casterId)?.health ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < ticks; i++) {
    const frame =
      i === 0
        ? [
            input(rig.casterId, {
              castAbilityId: abilityId,
              castTargetX: target?.position.x ?? 0,
              castTargetY: target?.position.y ?? 0,
              castTargetEntityId: rig.targetId,
            }),
          ]
        : [];
    state = step(state, frame, context()).state;
    const self = state.entities.get(rig.casterId);
    if (self) SAMPLE.lowest = Math.min(SAMPLE.lowest, self.health);
    if (i > 0 && self?.cast === null) break;
  }
  return { ...rig, state };
}

const casterIn = (rig: Rig): ServerEntity => {
  const self = rig.state.entities.get(rig.casterId);
  if (!self) throw new Error('the caster is gone');
  return self;
};

const weaveStacks = (rig: Rig): number =>
  statusOf(casterIn(rig).statuses, StatusId.Weave, rig.state.tick)?.stacks ?? 0;

/** A caster who has bought the whole Weaving row. */
const WEAVER: readonly SpecializationAllocation[] = [{ specializationId: 'int.weaving', tier: 3 }];

// ==========================================================================

describe('Arcane Weaving (spec 270)', () => {
  it('builds on a different ability and not on a repeat', () => {
    const stats = statsFor({ intelligence: 25 }, WEAVER);
    expect(stats.traits.weaveMaxStacks).toBeGreaterThan(0);

    let rig = duel(stats);
    rig = castOnce(rig, 'skill.emberToss');
    expect(weaveStacks(rig)).toBe(1);

    // A different ability chains.
    rig = castOnce(rig, 'skill.acidSpray');
    expect(weaveStacks(rig)).toBe(2);

    // The same one again does not. Deliberately *not* a reset: the mechanic
    // asks a player to vary what they throw, and wiping the chain for one
    // mistimed press would make it a punishment rather than a reason.
    rig = castOnce(rig, 'skill.acidSpray');
    expect(weaveStacks(rig)).toBe(2);

    // And a third distinct ability picks the chain back up.
    rig = castOnce(rig, 'skill.arcLash');
    expect(weaveStacks(rig)).toBe(3);
  });

  it('is capped, and lapses when the caster stops varying', () => {
    const stats = statsFor({ intelligence: 25 }, WEAVER);
    let rig = duel(stats);
    for (const id of ['skill.emberToss', 'skill.acidSpray', 'skill.arcLash', 'skill.blight']) {
      rig = castOnce(rig, id);
    }
    expect(weaveStacks(rig)).toBe(stats.traits.weaveMaxStacks);

    // Held by a clock rather than by a counter, so leaning on one button lets it
    // go on its own -- which is the same sentence the no-reset rule says, told
    // by the window instead of by a penalty.
    const held = statusOf(casterIn(rig).statuses, StatusId.Weave, rig.state.tick);
    expect(held?.expiresAtTick).toBeGreaterThan(rig.state.tick);
    expect(held?.expiresAtTick).toBeLessThanOrEqual(rig.state.tick + stats.traits.weaveTicks);
  });

  it('does nothing at all for a caster who has not bought it', () => {
    const stats = statsFor({ intelligence: 25 });
    expect(stats.traits.weaveMaxStacks).toBe(0);
    let rig = duel(stats);
    rig = castOnce(rig, 'skill.emberToss');
    rig = castOnce(rig, 'skill.acidSpray');
    expect(weaveStacks(rig)).toBe(0);
  });

  it('strengthens the afflictions it applies, and every tier is worth a step', () => {
    // The payoff is **manipulation**, not damage: what a stack moves is the
    // magnitude snapshotted onto the affliction, which is why this is not the
    // generic spell power the specialization it replaced was selling.
    const magnitudes: number[] = [];
    for (const tier of [0, 1, 2, 3]) {
      const stats = statsFor(
        { intelligence: 25 },
        tier > 0 ? [{ specializationId: 'int.weaving', tier }] : [],
      );
      let rig = duel(stats);
      // Two different casts, so a weaver is holding one stack when the second
      // affliction lands. The measured row is the *second* one.
      rig = castOnce(rig, 'skill.emberToss');
      rig = castOnce(rig, 'skill.acidSpray');
      const target = rig.state.entities.get(rig.targetId);
      const corrosion = statusOf(target?.statuses ?? {}, StatusId.Corrosion, rig.state.tick);
      magnitudes.push(corrosion?.magnitude ?? 0);
    }
    for (let tier = 1; tier < magnitudes.length; tier++) {
      expect(magnitudes[tier], `tier ${String(tier)}`).toBeGreaterThan(magnitudes[tier - 1] ?? 0);
    }
  });

  it('is decided by the server and never by what a client claims', () => {
    // The chain lives in `ServerEntity.lastWovenAbilityId` and is advanced at
    // the commit inside `advanceCast`. Nothing on the wire carries it and no
    // input field can move it, so a client cannot assert a chain it has not
    // cast -- which is the same rule every other status here already follows.
    const stats = statsFor({ intelligence: 25 }, WEAVER);
    let rig = duel(stats);
    rig = castOnce(rig, 'skill.emberToss');
    expect(casterIn(rig).lastWovenAbilityId).toBe('skill.emberToss');

    // Thirty ticks of ordinary input, naming a different ability in a field the
    // caster is not casting from, moves nothing.
    for (let i = 0; i < 30; i++) {
      rig = { ...rig, state: step(rig.state, [input(rig.casterId)], context()).state };
    }
    expect(casterIn(rig).lastWovenAbilityId).toBe('skill.emberToss');
    expect(weaveStacks(rig)).toBe(1);
  });
});

// ==========================================================================

describe('overdraw (spec 270)', () => {
  /** A caster deep enough into Intelligence to hold Arcane Overflow. */
  const overdrawer = (): EffectiveStats =>
    statsFor({ intelligence: SCALING.attributeHardCap }, [
      { specializationId: 'int.overflow', tier: 1 },
    ]);

  it('is offered only when the pool cannot cover the cast', () => {
    const stats = overdrawer();
    expect(stats.traits.overflowHealthPerResource).toBeGreaterThan(0);
    // No shortfall, no overdraw: this is a mechanic for the moment you run out,
    // not a discount that fires whenever it can.
    expect(overflowCostFor({ stats, health: 100 }, 0)).toBe(0);
    expect(overflowCostFor({ stats, health: 100 }, -3)).toBe(0);
    expect(overflowCostFor({ stats, health: 100 }, 4)).toBeGreaterThan(0);
  });

  it('is refused entirely to a caster without it', () => {
    const stats = statsFor({ intelligence: SCALING.attributeHardCap - 25 });
    expect(stats.traits.overflowHealthPerResource).toBe(0);
    expect(overflowCostFor({ stats, health: 100 }, 6)).toBe(0);
  });

  it('spends the resource it has first, then health for the rest', () => {
    const stats = overdrawer();
    const ability = abilityById('skill.acidSpray');
    if (!ability) throw new Error('no acid spray');
    const cost = resourceCostFor(ability, { stats }, 0);
    expect(cost).toBeGreaterThan(2);

    let rig = duel(stats);
    const before = casterIn(rig);
    // Two resource in the tank against a cost of six or so, and full health --
    // read off the body rather than typed, since an Intelligence caster's pool
    // is around a hundred and a number above the maximum is silently clamped.
    const health = before.stats.maxHealth;
    rig = { ...rig, state: replaceEntity(rig.state, { ...before, resource: 2, health }) };
    rig = castOnce(rig, 'skill.acidSpray');
    const after = casterIn(rig);
    const lowest = SAMPLE.lowest;

    // Every point that *was* there is spent, and the pool never goes negative.
    //
    // Compared against a trickle rather than against zero: the pool regenerates
    // on every tick a body is alive, so by the time the cast has run its course
    // a fraction of a point has come back. What is being asserted is that the
    // two resource the caster had were taken -- not that regeneration stopped.
    expect(after.resource).toBeGreaterThanOrEqual(0);
    expect(after.resource).toBeLessThan(2);
    // And the shortfall came out of health, at the rate the trait states.
    const shortfall = cost - 2;
    // To a tick of resting, not to the bit: the floor is sampled after `step`
    // has run, and resting is one of the passes inside it -- so the reading is
    // the overdraw less whatever the zone handed back on that same tick. What is
    // being asserted is the rate, and a hundredth of a point is not a rate.
    expect(health - lowest).toBeCloseTo(shortfall * stats.traits.overflowHealthPerResource, 1);
  });

  it('marks the caster, so it cannot be mistaken for being attacked', () => {
    // The whole reason this status exists: the write bypasses `resolveBlow`, so
    // no `hit` event fires and no number floats, while the health bar's chunk
    // and kick are the ones a blow leaves.
    const stats = overdrawer();
    let rig = duel(stats);
    rig = {
      ...rig,
      state: replaceEntity(rig.state, {
        ...casterIn(rig),
        resource: 1,
        health: casterIn(rig).stats.maxHealth,
      }),
    };
    rig = castOnce(rig, 'skill.acidSpray');
    expect(statusOf(casterIn(rig).statuses, StatusId.Overdrawn, rig.state.tick)).not.toBeNull();
  });

  it('never takes the last point of health, and refuses a bill it cannot cover', () => {
    const stats = overdrawer();
    const fraction = SCALING.intelligence.overflowHealthFraction;
    // The cap is a fraction of what is *left*, not of the maximum, which is the
    // whole safety property: a caster at 5% health paying 40% of their pool
    // would die to their own spell, and a caster paying 40% of what remains
    // never can.
    expect(overflowCostFor({ stats, health: 100 }, 1000)).toBe(0);
    const affordable = Math.floor((100 * fraction) / stats.traits.overflowHealthPerResource);
    expect(overflowCostFor({ stats, health: 100 }, affordable)).toBeGreaterThan(0);

    // And a body on its last point of health survives whatever it casts.
    let rig = duel(stats);
    rig = { ...rig, state: replaceEntity(rig.state, { ...casterIn(rig), resource: 0, health: 1 }) };
    rig = castOnce(rig, 'skill.acidSpray');
    expect(casterIn(rig).health).toBeGreaterThan(0);
  });

  it('costs less health once the discount is bought, and never more', () => {
    // Progression may only ever lower this price. Both layers that grant
    // Overflow contribute a *reduction*, so reaching the milestone can never
    // double the rate -- which is what it did before spec 239.
    const one = statsFor({ intelligence: SCALING.attributeHardCap }, [
      { specializationId: 'int.overflow', tier: 1 },
    ]);
    const bare = statsFor({ intelligence: 40 }, [{ specializationId: 'int.overflow', tier: 1 }]);
    expect(one.traits.overflowHealthPerResource).toBeLessThanOrEqual(
      bare.traits.overflowHealthPerResource,
    );
    expect(one.traits.overflowHealthPerResource).toBeGreaterThan(0);
  });
});

// ==========================================================================

describe('the magazine (spec 270)', () => {
  const perSecond = (stats: EffectiveStats): number => stats.resourceRegen * SERVER_TICK_RATE;

  it('gives Intelligence a bigger pool and not one drop of regeneration', () => {
    // The split the whole economy rests on. Before this spec a flat 2/s covered
    // most of what any build could spend, so the pool size was decorative and
    // three Intelligence specializations were priced against a non-constraint.
    const low = statsFor({ intelligence: 10 });
    const high = statsFor({ intelligence: SCALING.attributeHardCap });
    expect(high.maxResource).toBeGreaterThan(low.maxResource);
    expect(perSecond(high)).toBeCloseTo(perSecond(low), 9);
  });

  it('gives Wisdom the reload', () => {
    const none = statsFor({ wisdom: SCALING.startingAttribute });
    const some = statsFor({ wisdom: 30 });
    const lots = statsFor({ wisdom: SCALING.attributeHardCap });
    expect(perSecond(some)).toBeGreaterThan(perSecond(none));
    expect(perSecond(lots)).toBeGreaterThan(perSecond(some));
    // And the starting five buy nothing, which is `above()`'s rule and the
    // reason the first cut of this change barely moved the numbers.
    expect(perSecond(none)).toBeCloseTo(SCALING.wisdom.regenPer * 0 + perSecond(none), 9);
  });

  it('runs a pure-Intelligence caster dry under a sustained rotation', () => {
    // The acceptance number, measured through the real cost function rather
    // than asserted about a constant: a caster throwing everything as it comes
    // off cooldown must eventually stop, and must not stop in three casts.
    const stats = statsFor({ intelligence: SCALING.attributeHardCap });
    const rotation = ['skill.arcLash', 'skill.acidSpray', 'skill.blight', 'skill.rimeTouch'];
    let drain = 0;
    for (const id of rotation) {
      const ability = abilityById(id);
      if (!ability) throw new Error(`no such ability: ${id}`);
      drain += resourceCostFor(ability, { stats }, 0) / (ability.cooldownTicks / SERVER_TICK_RATE);
    }
    const net = drain - perSecond(stats);
    expect(net).toBeGreaterThan(0);

    const seconds = stats.maxResource / net;
    // Tens of seconds: long enough to be a burst worth having, short enough
    // that the capstone which fires on an empty pool is reachable in a fight.
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThan(90);
  });

  it('lets an Intelligence/Wisdom caster keep going where a pure one cannot', () => {
    // The systemic interaction that replaced the deleted INT/WIS pair bonus: no
    // row says these two go together, and the economy says it anyway.
    //
    // Asserted as **time to empty on the same rotation** rather than as a
    // multiple of the regeneration rate, which is what it was until spec 276
    // soft-capped the reload. That version read `perSecond(hybrid) >
    // perSecond(pure) * 3`, and the 3 was a proxy for this claim that only held
    // because the base rate was 0.4/s -- so any change to the floor moved a
    // number that was never about the floor. The hybrid keeps going because it
    // regenerates faster *and* pays less, and both halves belong in the
    // measurement.
    const half = Math.round(SCALING.attributeHardCap / 2);
    const pure = statsFor({ intelligence: SCALING.attributeHardCap });
    const hybrid = statsFor({ intelligence: half, wisdom: half });
    expect(perSecond(hybrid)).toBeGreaterThan(perSecond(pure));

    const ability = abilityById('skill.arcLash');
    if (!ability) throw new Error('no arc lash');
    expect(resourceCostFor(ability, { stats: hybrid }, 0)).toBeLessThan(
      resourceCostFor(ability, { stats: pure }, 0),
    );

    const rotation = ['skill.arcLash', 'skill.acidSpray', 'skill.blight', 'skill.rimeTouch'];
    const secondsToEmpty = (stats: EffectiveStats): number => {
      let drain = 0;
      for (const id of rotation) {
        const row = abilityById(id);
        if (!row) throw new Error(`no such ability: ${id}`);
        drain += resourceCostFor(row, { stats }, 0) / (row.cooldownTicks / SERVER_TICK_RATE);
      }
      const net = drain - perSecond(stats);
      return net > 0 ? stats.maxResource / net : Infinity;
    };
    // Half the magazine and half the Wisdom outlasts the whole magazine, which
    // is the sentence the test exists for.
    expect(secondsToEmpty(hybrid)).toBeGreaterThan(secondsToEmpty(pure) * 1.5);
  });
});
