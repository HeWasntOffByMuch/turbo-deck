/**
 * Mobile Offense: what leaving a follow-through pays (spec 252).
 *
 * Driven through the real `step` for the reason `attack-cancel.test.ts` gives:
 * the trigger lives entirely in the interaction between the movement pass and
 * the cast pass, so calling `cancelBackswing` directly would prove almost
 * nothing about when it fires.
 *
 * Two invariants govern the file, and every test is one of them asked about a
 * particular case:
 *
 *   1. The reward is paid on a **deliberate** exit from a committed cast, and
 *      on nothing else -- not a wind-up withdrawal, not an interrupt, not
 *      walking about with no cast running.
 *   2. It reaches **active abilities that are cooling** and nothing else. Not
 *      the basic attack's own entry, which is the cadence; not the flask, which
 *      is paced by charges; not a status; not an ability already ready.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { SCALING } from '../data/scaling.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { attackTimingFor, cancelCast } from './abilities.js';
import { stagger } from './poise.js';
import { applyStatus, StatusId, statusOf } from './statuses.js';
import {
  CastEndReason,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

/** 0.4s, in ticks. The tuning row, read rather than retyped. */
const PER_TIER = SCALING.agility.mobileOffenseCooldownTicks;

/**
 * Agility 10 exactly, which is `SPECIALIZATION_THRESHOLDS[0]`.
 *
 * The threshold and not a point over it: the milestones sit at 20/35/50, and
 * the Agility 35 one *also* grants `mobileOffenseCooldownTicks`. A fixture that
 * reached it would measure the tier and the milestone together and read tier 1
 * as two tiers.
 */
function recordWithTiers(tiers: number): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 10, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    specializations: tiers > 0 ? [{ specializationId: 'agi.mobileOffense', tier: tiers }] : [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
  };
}

function statsWithTiers(tiers: number): EffectiveStats {
  return { ...computeEffectiveStats(recordWithTiers(tiers)), spellPower: 1, critChance: 0 };
}

const CHUNK = 100;

function context(): StepContext {
  const keys = new Set<string>();
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(600 + dx * CHUNK, 450 + dy * CHUNK, CHUNK));
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

function withPlayer(
  state: ServerWorldState,
  stats: EffectiveStats,
  x = 600,
): { state: ServerWorldState; id: number } {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y: 450, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

/** A training dummy: scenery with a health bar, so nothing hits back. */
function withDummy(state: ServerWorldState, x = 650): { state: ServerWorldState; id: number } {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y: 450, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
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

function entityOf(state: ServerWorldState, id: number): ServerEntity {
  const entity = state.entities.get(id);
  if (!entity) throw new Error(`no entity ${String(id)}`);
  return entity;
}

const refunds = (events: readonly ServerSimEvent[]): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'cooldownRefunded');

/** Walking north, which is how every withdrawal in this file is expressed. */
const WALK = { moveX: 0, moveY: 1 };

/**
 * Swing, reach the follow-through, and walk out of it.
 *
 * Returns the world after the cancel, the events of the whole run, and the tick
 * the walk was delivered on -- which is what the clamp is measured against, and
 * the one number a caller cannot work out for itself.
 */
function swingAndCancel(
  state: ServerWorldState,
  playerId: number,
  dummyId: number,
  seed: Readonly<Record<string, number>> = {},
): { state: ServerWorldState; events: ServerSimEvent[]; cancelTick: number; before: ServerEntity } {
  const slash = abilityById('melee.slash');
  if (!slash) throw new Error('no melee.slash');
  const timing = attackTimingFor(slash, { stats: entityOf(state, playerId).stats });
  // One tick past the attack point: the blow has landed, the interval is
  // running, and the body is in the backswing with something to walk out of.
  const cancelFrame = timing.attackPointTicks + 1;

  const events: ServerSimEvent[] = [];
  let current = state;
  let before = entityOf(state, playerId);
  const ctx = context();
  for (let frame = 0; frame <= cancelFrame; frame++) {
    const frameInputs: ServerInput[] = [];
    if (frame === 0) {
      frameInputs.push(
        input(playerId, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
          castTargetEntityId: dummyId,
        }),
      );
    }
    if (frame === cancelFrame) frameInputs.push(input(playerId, WALK));
    // Seeded one tick before the cancel, so nothing the swing itself does can
    // overwrite it -- the cooldown for `melee.slash` is stamped at the attack
    // point, which is inside this loop.
    if (frame === cancelFrame && Object.keys(seed).length > 0) {
      current = replaceEntity(current, {
        ...entityOf(current, playerId),
        cooldowns: { ...entityOf(current, playerId).cooldowns, ...seed },
      });
    }
    if (frame === cancelFrame) before = entityOf(current, playerId);
    const result = step(current, frameInputs, ctx);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events, cancelTick: current.tick, before };
}

/** A world with a player at `tiers` and a dummy to swing at. */
function fight(tiers: number): { state: ServerWorldState; playerId: number; dummyId: number } {
  let state = createWorldState(1);
  const player = withPlayer(state, statsWithTiers(tiers));
  state = player.state;
  const dummy = withDummy(state);
  state = dummy.state;
  return { state, playerId: player.id, dummyId: dummy.id };
}

// ---------------------------------------------------------------------------

describe('what a tier is worth', () => {
  it('is 0.4s of cooldown per tier, and nothing else about Flow', () => {
    expect(PER_TIER).toBe(Math.round(0.4 * SERVER_TICK_RATE));
    for (const tiers of [0, 1, 2, 3]) {
      expect(statsWithTiers(tiers).traits.mobileOffenseCooldownTicks).toBe(tiers * PER_TIER);
    }
    // The old reward is gone: the specialization no longer grants Flow, nor a
    // slice of Flow's own backswing reduction.
    expect(statsWithTiers(3).traits.flowTicks).toBe(0);
    expect(statsWithTiers(3).traits.flowBackswingPct).toBe(0);
  });
});

describe('a valid backswing cancel', () => {
  it('triggers Mobile Offense and reduces a cooling active ability', () => {
    const { state, playerId, dummyId } = fight(1);
    const seeded = 900;
    const run = swingAndCancel(state, playerId, dummyId, { 'skill.guardBreak': seeded });

    const ended = run.events.filter(
      (event) => event.kind === 'castEnded' && event.reason === CastEndReason.BackswingCancelled,
    );
    expect(ended).toHaveLength(1);

    const refunded = refunds(run.events);
    expect(refunded).toHaveLength(1);
    const event = refunded[0];
    if (event?.kind !== 'cooldownRefunded') throw new Error('no refund');
    expect(event.entityId).toBe(playerId);
    expect(event.source).toBe('mobileOffense');
    expect(event.ticks).toBe(PER_TIER);
    expect(event.abilities).toEqual([{ abilityId: 'skill.guardBreak', ticks: PER_TIER }]);

    expect(entityOf(run.state, playerId).cooldowns['skill.guardBreak']).toBe(seeded - PER_TIER);
  });

  it.each([
    [1, PER_TIER],
    [2, 2 * PER_TIER],
    [3, 3 * PER_TIER],
  ])('at tier %i removes %i ticks', (tiers, expected) => {
    const { state, playerId, dummyId } = fight(tiers);
    const run = swingAndCancel(state, playerId, dummyId, { 'skill.guardBreak': 900 });
    expect(entityOf(run.state, playerId).cooldowns['skill.guardBreak']).toBe(900 - expected);
    // Stated in seconds as well as in ticks, because the seconds are the number
    // the specialization is authored in and the ticks are an implementation of it.
    expect(expected / SERVER_TICK_RATE).toBeCloseTo(tiers * 0.4, 10);
  });

  it('reduces every cooling active ability, by the same amount', () => {
    const { state, playerId, dummyId } = fight(2);
    const run = swingAndCancel(state, playerId, dummyId, {
      'skill.guardBreak': 900,
      'skill.cripplingStrike': 700,
      'skill.scorchedEarth': 2000,
    });
    const after = entityOf(run.state, playerId).cooldowns;
    expect(after['skill.guardBreak']).toBe(900 - 2 * PER_TIER);
    expect(after['skill.cripplingStrike']).toBe(700 - 2 * PER_TIER);
    expect(after['skill.scorchedEarth']).toBe(2000 - 2 * PER_TIER);

    const event = refunds(run.events)[0];
    if (event?.kind !== 'cooldownRefunded') throw new Error('no refund');
    expect(event.ticks).toBe(3 * 2 * PER_TIER);
    expect(event.abilities).toHaveLength(3);
  });

  it('leaves an ability that is already ready exactly as it was', () => {
    const { state, playerId, dummyId } = fight(3);
    // Ready long ago, and ready one tick ago: neither has anything to give back,
    // and dragging either *forward* to the current tick would be a cooldown
    // being invented rather than removed.
    const run = swingAndCancel(state, playerId, dummyId, {
      'skill.guardBreak': 1,
      'skill.cripplingStrike': 900,
    });
    const after = entityOf(run.state, playerId).cooldowns;
    expect(after['skill.guardBreak']).toBe(1);
    expect(after['skill.cripplingStrike']).toBe(900 - 3 * PER_TIER);

    const event = refunds(run.events)[0];
    if (event?.kind !== 'cooldownRefunded') throw new Error('no refund');
    expect(event.abilities.map((refund) => refund.abilityId)).toEqual(['skill.cripplingStrike']);
  });

  it('never takes a cooldown below zero remaining', () => {
    const { state, playerId, dummyId } = fight(3);
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    // `swingAndCancel` walks on the tick after the attack point, and the world
    // starts at tick 0 -- so the tick the cancel lands on is knowable up front,
    // which is what lets the seed be *just* short of it.
    const willCancelAt = attackTimingFor(slash, { stats: statsWithTiers(3) }).attackPointTicks + 2;
    // Three ticks of cooldown against 72 ticks of reduction.
    const run = swingAndCancel(state, playerId, dummyId, { 'skill.guardBreak': willCancelAt + 3 });
    expect(run.cancelTick).toBe(willCancelAt);
    const after = entityOf(run.state, playerId).cooldowns['skill.guardBreak'] ?? -1;

    // Remaining zero, which is the current tick and never earlier: a cooldown in
    // the past is not more ready than one that has just expired, and it would
    // read as a negative remaining everywhere it is displayed.
    expect(after).toBe(run.cancelTick);
    expect(after - run.cancelTick).toBe(0);
    expect(after).toBeGreaterThan(0);

    // And the ability is castable now rather than at some point in the past.
    const event = refunds(run.events)[0];
    if (event?.kind !== 'cooldownRefunded') throw new Error('no refund');
    expect(event.abilities[0]?.ticks).toBe(3);
  });
});

describe('what it must not reach', () => {
  it('does not touch the basic attack, so the cadence cannot move', () => {
    const withTiers = fight(3);
    const without = fight(0);
    const a = swingAndCancel(withTiers.state, withTiers.playerId, withTiers.dummyId);
    const b = swingAndCancel(without.state, without.playerId, without.dummyId);

    const slashA = entityOf(a.state, withTiers.playerId).cooldowns['melee.slash'];
    const slashB = entityOf(b.state, without.playerId).cooldowns['melee.slash'];
    expect(slashA).toBeDefined();
    // The same interval, ending on the same tick, with and without three tiers.
    expect(slashA).toBe(slashB);
    expect(refunds(a.events)).toHaveLength(0);
  });

  it('leaves the wind-up, the attack point and the backswing alone', () => {
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const bare = attackTimingFor(slash, { stats: statsWithTiers(0) });
    const bought = attackTimingFor(slash, { stats: statsWithTiers(3) });
    expect(bought).toEqual(bare);
  });

  it('leaves the flask alone -- its pacing is charges as well as a timer', () => {
    const { state, playerId, dummyId } = fight(3);
    const run = swingAndCancel(state, playerId, dummyId, {
      'self.hearthdraught': 900,
      'skill.guardBreak': 900,
    });
    const after = entityOf(run.state, playerId);
    expect(after.cooldowns['self.hearthdraught']).toBe(900);
    expect(after.cooldowns['skill.guardBreak']).toBe(900 - 3 * PER_TIER);
    expect(after.fallbackCharges).toBe(run.before.fallbackCharges);
  });

  it('moves no status expiry and no other server timer', () => {
    const { state, playerId, dummyId } = fight(3);
    const seeded = replaceEntity(state, {
      ...entityOf(state, playerId),
      statuses: applyStatus(entityOf(state, playerId).statuses, StatusId.Slowed, 0, 600),
    });
    const run = swingAndCancel(seeded, playerId, dummyId, { 'skill.guardBreak': 900 });
    const slowed = statusOf(entityOf(run.state, playerId).statuses, StatusId.Slowed, run.cancelTick);
    expect(slowed?.expiresAtTick).toBe(600);
  });
});

describe('what must not trigger it', () => {
  it('does not fire on ordinary movement with no cast running', () => {
    const { state, playerId } = fight(3);
    const seeded = replaceEntity(state, {
      ...entityOf(state, playerId),
      cooldowns: { 'skill.guardBreak': 900 },
    });
    const ctx = context();
    let current = seeded;
    const events: ServerSimEvent[] = [];
    for (let frame = 0; frame < 30; frame++) {
      const result = step(current, [input(playerId, WALK)], ctx);
      current = result.state;
      events.push(...result.events);
    }
    expect(refunds(events)).toHaveLength(0);
    expect(entityOf(current, playerId).cooldowns['skill.guardBreak']).toBe(900);
    // Nothing moved, so the map itself is the one the entity started with --
    // which is what keeps the cooldown message off the wire (`server.ts`
    // compares it by reference).
    expect(entityOf(current, playerId).cooldowns).toBe(entityOf(seeded, playerId).cooldowns);
  });

  it('does not fire on a wind-up withdrawal -- the attack did not happen', () => {
    const { state, playerId, dummyId } = fight(3);
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const timing = attackTimingFor(slash, { stats: statsWithTiers(3) });
    const half = Math.max(1, Math.floor(timing.attackPointTicks / 2));

    const ctx = context();
    let current = replaceEntity(state, {
      ...entityOf(state, playerId),
      cooldowns: { 'skill.guardBreak': 900 },
    });
    const events: ServerSimEvent[] = [];
    for (let frame = 0; frame <= half; frame++) {
      const frameInputs =
        frame === 0
          ? [
              input(playerId, {
                castAbilityId: 'melee.slash',
                castTargetX: 650,
                castTargetY: 450,
                castTargetEntityId: dummyId,
              }),
            ]
          : frame === half
            ? [input(playerId, WALK)]
            : [];
      const result = step(current, frameInputs, ctx);
      current = result.state;
      events.push(...result.events);
    }

    const ended = events.filter(
      (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
    );
    expect(ended).toHaveLength(1);
    expect(refunds(events)).toHaveLength(0);
    expect(entityOf(current, playerId).cooldowns['skill.guardBreak']).toBe(900);
  });

  /**
   * A guard break is the interrupt this game actually produces, and it does not
   * go through `cancelBackswing` at all: `poise.ts` clears the cast itself and
   * announces its own `Interrupted`. So the guarantee is structural rather than
   * conditional -- there is no path from a break to the refund -- and this
   * asserts the outcome a player would notice, which is that being knocked out
   * of a follow-through pays nothing.
   */
  it('pays nothing when a guard break knocks the body out of its follow-through', () => {
    const { state, playerId, dummyId } = fight(3);
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const timing = attackTimingFor(slash, { stats: statsWithTiers(3) });

    const ctx = context();
    let current = replaceEntity(state, {
      ...entityOf(state, playerId),
      cooldowns: { 'skill.guardBreak': 900 },
    });
    const events: ServerSimEvent[] = [];
    for (let frame = 0; frame <= timing.attackPointTicks + 1; frame++) {
      const frameInputs =
        frame === 0
          ? [
              input(playerId, {
                castAbilityId: 'melee.slash',
                castTargetX: 650,
                castTargetY: 450,
                castTargetEntityId: dummyId,
              }),
            ]
          : [];
      if (frame === timing.attackPointTicks + 1) {
        const caster = entityOf(current, playerId);
        expect(caster.cast?.committed).toBe(true);
        const broken = stagger(caster, dummyId, 30, current.tick);
        current = replaceEntity(current, broken.entity);
        events.push(...broken.events);
      }
      const result = step(current, frameInputs, ctx);
      current = result.state;
      events.push(...result.events);
    }

    const ended = events.filter(
      (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Interrupted,
    );
    expect(ended).toHaveLength(1);
    expect(refunds(events)).toHaveLength(0);
    expect(entityOf(current, playerId).cooldowns['skill.guardBreak']).toBe(900);
  });

  /**
   * And the gate inside `cancelBackswing`, asked directly.
   *
   * No production caller reaches it with `Interrupted` today -- death and a
   * break both clear the cast themselves -- so this is the one instrument that
   * can pin it, and it is worth pinning because the reason is a parameter: a
   * future caller passing `Interrupted` must not be paid, and the same flag
   * gates the Flow grant beside it.
   */
  it('refuses an interrupted cancel, which is not the same action as leaving one', () => {
    const { state, playerId, dummyId } = fight(3);
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const timing = attackTimingFor(slash, { stats: statsWithTiers(3) });

    const ctx = context();
    let current = replaceEntity(state, {
      ...entityOf(state, playerId),
      cooldowns: { 'skill.guardBreak': 900 },
    });
    for (let frame = 0; frame <= timing.attackPointTicks; frame++) {
      const frameInputs =
        frame === 0
          ? [
              input(playerId, {
                castAbilityId: 'melee.slash',
                castTargetX: 650,
                castTargetY: 450,
                castTargetEntityId: dummyId,
              }),
            ]
          : [];
      current = step(current, frameInputs, ctx).state;
    }

    const caster = entityOf(current, playerId);
    expect(caster.cast?.committed).toBe(true);
    const interrupted = cancelCast(caster, current.tick, CastEndReason.Interrupted);
    expect(interrupted.cancelled).toBe(true);
    expect(interrupted.kind).toBe('backswing');
    expect(refunds(interrupted.events)).toHaveLength(0);
    expect(interrupted.entity.cooldowns).toBe(caster.cooldowns);

    // The same call, deliberately, is paid -- so the refusal above is the reason
    // and not the fixture.
    const deliberate = cancelCast(caster, current.tick, CastEndReason.Cancelled);
    expect(refunds(deliberate.events)).toHaveLength(1);
    expect(deliberate.entity.cooldowns['skill.guardBreak']).toBe(900 - 3 * PER_TIER);
  });

  it('pays nothing to a body with no tiers', () => {
    const { state, playerId, dummyId } = fight(0);
    const run = swingAndCancel(state, playerId, dummyId, { 'skill.guardBreak': 900 });
    expect(refunds(run.events)).toHaveLength(0);
    expect(entityOf(run.state, playerId).cooldowns['skill.guardBreak']).toBe(900);
  });
});

describe('the server decides', () => {
  /**
   * Nothing a client sends can produce a refund.
   *
   * The tiers are on `EffectiveStats`, which is computed from the persisted
   * record, and the trigger is read from `entity.cast` -- the server's own
   * record of what this body committed to. A client asking to cancel when there
   * is nothing committed gets exactly what a client with no tiers gets.
   */
  it('refuses a claimed cancel with no committed cast behind it', () => {
    const { state, playerId } = fight(3);
    const seeded = replaceEntity(state, {
      ...entityOf(state, playerId),
      cooldowns: { 'skill.guardBreak': 900 },
    });
    const result = step(seeded, [input(playerId, { ...WALK, cancelCast: true })], context());
    expect(refunds(result.events)).toHaveLength(0);
    expect(entityOf(result.state, playerId).cooldowns['skill.guardBreak']).toBe(900);
  });

  it('pays the body that cancelled and nobody else', () => {
    let state = createWorldState(1);
    const mover = withPlayer(state, statsWithTiers(3), 600);
    state = mover.state;
    const bystander = withPlayer(state, statsWithTiers(3), 400);
    state = bystander.state;
    const dummy = withDummy(state);
    state = dummy.state;
    state = replaceEntity(state, {
      ...entityOf(state, bystander.id),
      cooldowns: { 'skill.guardBreak': 900 },
    });

    const run = swingAndCancel(state, mover.id, dummy.id, { 'skill.guardBreak': 900 });
    const event = refunds(run.events)[0];
    if (event?.kind !== 'cooldownRefunded') throw new Error('no refund');
    expect(event.entityId).toBe(mover.id);
    expect(entityOf(run.state, mover.id).cooldowns['skill.guardBreak']).toBe(900 - 3 * PER_TIER);
    expect(entityOf(run.state, bystander.id).cooldowns['skill.guardBreak']).toBe(900);
  });
});
