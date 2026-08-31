/**
 * The follow-through you may leave (spec 256).
 *
 * A follow-through has two halves now -- committed, then leavable -- and every
 * Agility source that used to make the phase *shorter* makes the boundary
 * *earlier* instead. Two things have to be true at once for that to be a
 * mechanic rather than a nerf, and this file is both of them:
 *
 *   1. Movement freedom really does improve with investment.
 *   2. **Nothing about it touches the cadence.** Walking out early gives back
 *      the legs and never a faster next blow.
 *
 * The second is the load-bearing one and is asserted three ways -- off the
 * resolved timing, off the stamped cooldown, and off a real fight counted
 * through `step` -- because a comment claiming it is a comment that can rot.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { SCALING } from '../data/scaling.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
  type SpecializationAllocation,
  type TraitStats,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  attackTimingFor,
  backswingCancelPointFor,
  backswingCancelPointOf,
  backswingCancelTickOf,
  cancelCast,
  mayCancelBackswing,
} from './abilities.js';
import { backswingCancelTicksFrom, FULLY_COMMITTED } from './attack-timing.js';
import { applyPoiseDamage } from './poise.js';
import { applyStatus, NO_STATUSES, stacksOf, StatusId } from './statuses.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type CastState,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

function ability(id: string): AbilityDefinition {
  const found = abilityById(id);
  if (!found) throw new Error(`no such ability: ${id}`);
  return found;
}

const SLASH = ability('melee.slash');

const QUICK_RECOVERY = 'agi.quickRecovery';
const FLOW_SPEC = 'agi.flow';
const MOBILE_OFFENSE = 'agi.mobileOffense';

function record(
  agility: number,
  specializations: readonly SpecializationAllocation[] = [],
): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    specializations: [...specializations],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
  };
}

function statsFor(
  agility = 5,
  specializations: readonly SpecializationAllocation[] = [],
): EffectiveStats {
  // Crit off, so a blow is one deterministic number and the Rng draw count
  // cannot make two otherwise identical runs disagree.
  return { ...computeEffectiveStats(record(agility, specializations)), critChance: 0 };
}

/** `stacks` Flow stacks, live from tick 0 for longer than any test runs. */
function flowing(stacks: number) {
  let statuses = NO_STATUSES;
  for (let i = 0; i < stacks; i++) {
    statuses = applyStatus(statuses, StatusId.Flow, 0, 10_000, {
      maxStacks: SCALING.agility.flowMaxStacks,
    });
  }
  return statuses;
}

const traitsWith = (over: Partial<TraitStats>): TraitStats => ({ ...NEUTRAL_TRAITS, ...over });

// ===========================================================================
// The threshold itself: arithmetic, with no sim under it.
// ===========================================================================

describe('the cancel threshold (spec 256)', () => {
  it('is the base for a body that has bought nothing', () => {
    expect(backswingCancelPointOf(NEUTRAL_TRAITS, 0)).toBe(SCALING.agility.backswingCancelBase);
    expect(backswingCancelPointFor({ stats: statsFor() }, 0)).toBe(
      SCALING.agility.backswingCancelBase,
    );
  });

  it('comes forward with Quick Recovery, and every tier moves it again', () => {
    let previous = backswingCancelPointFor({ stats: statsFor(10) }, 0);
    for (const tier of [1, 2, 3]) {
      const now = backswingCancelPointFor(
        { stats: statsFor(10, [{ specializationId: QUICK_RECOVERY, tier }]) },
        0,
      );
      expect(now, `tier ${String(tier)}`).toBeLessThan(previous);
      previous = now;
    }
  });

  it('comes forward with Flow, per stack', () => {
    const stats = statsFor(20, [{ specializationId: FLOW_SPEC, tier: 3 }]);
    let previous = backswingCancelPointFor({ stats, statuses: NO_STATUSES }, 0);
    for (const stacks of [1, 2, 3]) {
      const now = backswingCancelPointFor({ stats, statuses: flowing(stacks) }, 0);
      expect(now, `${String(stacks)} stacks`).toBeLessThan(previous);
      previous = now;
    }
  });

  it('stacks Quick Recovery and Flow by subtraction, exactly', () => {
    // The rule the spec states, checked as arithmetic rather than as an
    // inequality: a multiplicative reading would make two tenths 0.19, and the
    // difference is invisible until somebody wears both.
    const traits = traitsWith({ backswingCancelPct: 0.6, flowBackswingCancelPct: 0.05 });
    expect(backswingCancelPointOf(traits, 0)).toBeCloseTo(0.6, 10);
    expect(backswingCancelPointOf(traits, 1)).toBeCloseTo(0.55, 10);
    expect(backswingCancelPointOf(traits, 3)).toBeCloseTo(0.45, 10);
  });

  it('clamps at the floor however much is stacked on it', () => {
    // Poked in directly, because nothing in the shipped tree reaches the floor
    // -- which is the state a guard should be in, and exactly why the clamp
    // needs a test of its own rather than a build that happens to hit it.
    const traits = traitsWith({ backswingCancelPct: 0.3, flowBackswingCancelPct: 0.09 });
    expect(backswingCancelPointOf(traits, 3)).toBe(SCALING.agility.backswingCancelFloor);
    expect(backswingCancelPointOf(traits, 99)).toBe(SCALING.agility.backswingCancelFloor);
  });

  it('is never raised above the base by a broken modifier', () => {
    expect(backswingCancelPointOf(traitsWith({ backswingCancelPct: 5 }), 0)).toBe(
      SCALING.agility.backswingCancelBase,
    );
    expect(
      backswingCancelPointOf(traitsWith({ flowBackswingCancelPct: Number.NaN }), 2),
    ).toBe(SCALING.agility.backswingCancelBase);
  });

  it('nothing in the shipped tree reaches the floor', () => {
    // The budget claim in `SCALING.agility`, asserted rather than believed: a
    // retune that starts saturating makes a purchase somebody paid for do
    // nothing, which is the failure `progression-audit` exists to catch one
    // level up and cannot see here, because Flow is a status.
    const stats = statsFor(SCALING.attributeHardCap, [
      { specializationId: QUICK_RECOVERY, tier: 3 },
      { specializationId: FLOW_SPEC, tier: 3 },
      { specializationId: MOBILE_OFFENSE, tier: 3 },
    ]);
    const most = backswingCancelPointFor(
      { stats, statuses: flowing(SCALING.agility.flowMaxStacks) },
      0,
    );
    expect(most).toBeGreaterThan(SCALING.agility.backswingCancelFloor);
  });

  it('never lets a cancel land on the attack point, or past the phase', () => {
    // Both bounds of `backswingCancelTicksFrom`, which is what makes "cancelling
    // before the attack point" impossible by construction rather than by the
    // order the passes happen to run in.
    expect(backswingCancelTicksFrom(24, 0)).toBe(1);
    expect(backswingCancelTicksFrom(24, -5)).toBe(1);
    expect(backswingCancelTicksFrom(24, 1)).toBe(24);
    expect(backswingCancelTicksFrom(24, 9)).toBe(24);
    // No follow-through, no cancel point: a channel and every ability that ends
    // at its release behave exactly as they did before this existed.
    expect(backswingCancelTicksFrom(0, 0.7)).toBe(0);
    expect(backswingCancelTicksFrom(24, FULLY_COMMITTED)).toBe(24);
  });
});

// ===========================================================================
// The length of the phase, and the cadence. Neither may move.
// ===========================================================================

describe('what the cancel point must never touch (spec 256)', () => {
  const BUILDS: readonly { readonly name: string; readonly stats: EffectiveStats; readonly flow: number }[] = [
    { name: 'nothing', stats: statsFor(20), flow: 0 },
    { name: 'quick recovery 3', stats: statsFor(20, [{ specializationId: QUICK_RECOVERY, tier: 3 }]), flow: 0 },
    { name: 'flow', stats: statsFor(20, [{ specializationId: FLOW_SPEC, tier: 3 }]), flow: 3 },
    {
      name: 'quick recovery 3 + flow',
      stats: statsFor(20, [
        { specializationId: QUICK_RECOVERY, tier: 3 },
        { specializationId: FLOW_SPEC, tier: 3 },
      ]),
      flow: 3,
    },
  ];

  it('leaves the natural follow-through exactly as long', () => {
    const base = attackTimingFor(SLASH, { stats: statsFor(20), statuses: NO_STATUSES }, 0);
    expect(base.backswingTicks).toBeGreaterThan(0);
    for (const build of BUILDS) {
      const timing = attackTimingFor(
        SLASH,
        { stats: build.stats, statuses: flowing(build.flow) },
        0,
      );
      expect(timing.backswingTicks, build.name).toBe(base.backswingTicks);
    }
  });

  it('leaves it exactly as long at every value of Agility', () => {
    const base = attackTimingFor(SLASH, { stats: statsFor() }, 0);
    for (const agility of [10, 20, 35, 50, SCALING.attributeHardCap]) {
      expect(attackTimingFor(SLASH, { stats: statsFor(agility) }, 0).backswingTicks, `agi ${String(agility)}`)
        .toBe(base.backswingTicks);
    }
  });

  it('leaves attacks per second exactly where they were', () => {
    const base = attackTimingFor(SLASH, { stats: statsFor(20), statuses: NO_STATUSES }, 0);
    for (const build of BUILDS) {
      const timing = attackTimingFor(
        SLASH,
        { stats: build.stats, statuses: flowing(build.flow) },
        0,
      );
      expect(timing.intervalTicks, build.name).toBe(base.intervalTicks);
      expect(timing.attacksPerSecond, build.name).toBe(base.attacksPerSecond);
      expect(timing.factor, build.name).toBe(base.factor);
    }
  });

  it('does move the cancel point, so the four builds are not all one build', () => {
    // The control. Every assertion above is an equality, and a change that
    // quietly stopped the mechanic from doing anything would satisfy all of
    // them.
    const points = BUILDS.map((build) =>
      attackTimingFor(SLASH, { stats: build.stats, statuses: flowing(build.flow) }, 0)
        .backswingCancelTicks,
    );
    expect(new Set(points).size).toBeGreaterThan(1);
    expect(Math.min(...points)).toBeLessThan(points[0] ?? 0);
  });
});

// ===========================================================================
// Through the real tick.
// ===========================================================================

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

const WALK = { moveX: 0, moveY: 1 };

interface Fight {
  state: ServerWorldState;
  playerId: number;
  dummyId: number;
  events: ServerSimEvent[];
}

/** A player and a training dummy in reach of each other, on flat ground. */
function fight(stats: EffectiveStats, seed = 7): Fight {
  let state = createWorldState(seed);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: 600, y: 450, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = player.state;
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  const dummy = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x: 650, y: 450, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  return { state: dummy.state, playerId: player.entity.id, dummyId: dummy.entity.id, events: [] };
}

function tick(current: Fight, inputs: readonly ServerInput[] = [], ctx = context()): Fight {
  const result = step(current.state, inputs, ctx);
  return { ...current, state: result.state, events: [...result.events] };
}

const selfOf = (run: Fight): ServerEntity => {
  const found = run.state.entities.get(run.playerId);
  if (!found) throw new Error('no player');
  return found;
};

/** The follow-through this body is in. Throws rather than asserting non-null. */
const castOf = (body: ServerEntity): CastState => {
  if (!body.cast) throw new Error('no cast');
  return body.cast;
};

/** Swings, and runs on until the blow has landed and the follow-through is live. */
function swingInto(run: Fight): Fight {
  let current = tick(run, [
    input(run.playerId, {
      castAbilityId: SLASH.id,
      castTargetX: 650,
      castTargetY: 450,
      castTargetEntityId: run.dummyId,
    }),
  ]);
  const releaseTick = selfOf(current).cast?.releaseTick ?? 0;
  while (current.state.tick < releaseTick) current = tick(current);
  const cast = selfOf(current).cast;
  expect(cast?.phase).toBe(CastPhase.Backswing);
  expect(cast?.committed).toBe(true);
  return current;
}

describe('a follow-through in the real tick (spec 256)', () => {
  it('refuses a walk-out before the cancel point, and honours it at it', () => {
    let run = swingInto(fight(statsFor(20)));
    const cancelTick = backswingCancelTickOf(castOf(selfOf(run)));
    const endTick = selfOf(run).cast?.endTick ?? 0;
    // A phase with two halves is only a phase if both halves have ticks in them.
    expect(cancelTick).toBeGreaterThan(run.state.tick);
    expect(cancelTick).toBeLessThan(endTick);

    // Every tick strictly before it: ask to walk, and be held. The key is held
    // the whole way, which is the case that matters -- a player does not press
    // once and wait, they walk and the game decides when that takes.
    while (run.state.tick < cancelTick - 1) {
      const wasAt = selfOf(run).position.y;
      run = tick(run, [input(run.playerId, WALK)]);
      const self = selfOf(run);
      expect(self.cast, `still committed at ${String(run.state.tick)}`).not.toBeNull();
      expect(self.position.y, `held at ${String(run.state.tick)}`).toBe(wasAt);
    }

    // And on the tick that reaches it, the same held key walks.
    const before = selfOf(run).position.y;
    run = tick(run, [input(run.playerId, WALK)]);
    expect(run.state.tick).toBe(cancelTick);
    expect(selfOf(run).cast).toBeNull();
    expect(selfOf(run).position.y).toBeGreaterThan(before);
    expect(
      run.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.BackswingCancelled,
      ),
    ).toBe(true);
  });

  it('does not bring the next attack forward by one tick', () => {
    // The invariant the whole feature rests on, measured rather than reasoned
    // about: two identical fights, one walked out of at the earliest legal tick
    // and one left to run its course, and the same tick is stamped on the
    // cooldown either way.
    const stats = statsFor(20, [{ specializationId: QUICK_RECOVERY, tier: 3 }]);

    const patient = swingInto(fight(stats));
    const natural = selfOf(patient).cooldowns[SLASH.id] ?? 0;

    let hasty = swingInto(fight(stats));
    const cancelTick = backswingCancelTickOf(castOf(selfOf(hasty)));
    while (hasty.state.tick < cancelTick) hasty = tick(hasty);
    hasty = tick(hasty, [input(hasty.playerId, WALK)]);
    expect(selfOf(hasty).cast).toBeNull();

    expect(selfOf(hasty).cooldowns[SLASH.id]).toBe(natural);
    expect(natural).toBeGreaterThan(cancelTick);
  });

  it('lands the same number of blows whether every follow-through is left early or none is', () => {
    // The cadence claim through a whole fight rather than off one number. Both
    // runs ask to attack on every tick they are allowed to; one also walks out
    // of every follow-through the instant it legally may.
    const stats = statsFor(SCALING.attributeHardCap, [
      { specializationId: QUICK_RECOVERY, tier: 3 },
      { specializationId: FLOW_SPEC, tier: 3 },
      { specializationId: MOBILE_OFFENSE, tier: 3 },
    ]);

    const blowsOver = (ticks: number, leaveEarly: boolean): number => {
      let run = fight(stats, 11);
      let landed = 0;
      for (let i = 0; i < ticks; i++) {
        const self = selfOf(run);
        const walking = leaveEarly && self.cast !== null && mayCancelBackswing(self.cast, run.state.tick);
        run = tick(run, [
          input(run.playerId, {
            ...(walking ? WALK : {}),
            castAbilityId: self.cast === null ? SLASH.id : '',
            castTargetX: 650,
            castTargetY: 450,
            castTargetEntityId: run.dummyId,
          }),
        ]);
        landed += run.events.filter((event) => event.kind === 'hit').length;
      }
      return landed;
    };

    const still = blowsOver(SERVER_TICK_RATE * 6, false);
    expect(still).toBeGreaterThan(2);
    expect(blowsOver(SERVER_TICK_RATE * 6, true)).toBe(still);
  });

  it('grants Flow for a legal walk-out and nothing for a refused one', () => {
    // Mobile Offense's trigger, from both sides. The reward is not moved here
    // (spec 256 is out of scope for what a cancel *pays*); what is asserted is
    // that only a cancel the rules allowed can ever fire it.
    const stats = statsFor(20, [{ specializationId: MOBILE_OFFENSE, tier: 3 }]);
    expect(stats.traits.flowTicks).toBeGreaterThan(0);

    const run = swingInto(fight(stats));
    const self = selfOf(run);
    const cast = self.cast;
    if (!cast) throw new Error('no cast');
    expect(stacksOf(self.statuses, StatusId.Flow, run.state.tick)).toBe(0);

    // Too early: refused outright, so there is nothing for the reward to hang
    // off. Not "cancelled but unpaid" -- the cast is still there.
    const early = cancelCast(self, run.state.tick, CastEndReason.Cancelled);
    expect(early.cancelled).toBe(false);
    expect(early.kind).toBe('none');
    expect(early.entity.cast).not.toBeNull();
    expect(stacksOf(early.entity.statuses, StatusId.Flow, run.state.tick)).toBe(0);

    // On the cancel point: allowed, and paid.
    const at = backswingCancelTickOf(cast);
    const legal = cancelCast(self, at, CastEndReason.Cancelled);
    expect(legal.cancelled).toBe(true);
    expect(legal.kind).toBe('backswing');
    expect(stacksOf(legal.entity.statuses, StatusId.Flow, at)).toBe(1);
  });

  it('still lets a guard break take a body out of a committed follow-through', () => {
    // The gate is about a decision the player is making. Being broken is not
    // one, so it is exempt -- and it has to be, or hyper-armour's whole
    // counterpart would stop working inside the committed window.
    const run = swingInto(fight(statsFor(20)));
    const self = selfOf(run);
    expect(mayCancelBackswing(castOf(self), run.state.tick)).toBe(false);

    const broken = applyPoiseDamage(self, 10_000, run.state.tick, true);
    expect(broken.broke).toBe(true);
    expect(broken.entity.cast).toBeNull();
    expect(broken.interrupted?.abilityId).toBe(SLASH.id);

    // And the same cast, called off as an interrupt directly, goes.
    const killed = cancelCast(self, run.state.tick, CastEndReason.Interrupted);
    expect(killed.cancelled).toBe(true);
    expect(killed.entity.cast).toBeNull();
  });

  it('leaves Perfect Exit alone, because it reads the wind-up', () => {
    // Audited against the new model (spec 256) rather than redesigned: its
    // window is the *wind-up*, which the backswing gate never touches, so it
    // remains the one escape that pays -- and a backswing cancel still pays
    // nothing, which is what keeps the two distinct.
    const stats = statsFor(SCALING.attributeHardCap, [
      { specializationId: 'agi.perfectExit', tier: 1 },
    ]);
    expect(stats.traits.perfectExitResource).toBeGreaterThan(0);

    let run = fight(stats);
    run = tick(run, [
      input(run.playerId, {
        castAbilityId: SLASH.id,
        castTargetX: 650,
        castTargetY: 450,
        castTargetEntityId: run.dummyId,
      }),
    ]);
    const winding = selfOf(run);
    expect(winding.cast?.committed).toBe(false);

    // Struck a moment ago, and stepping out of our own swing.
    const struck: ServerEntity = {
      ...winding,
      resource: 0,
      statuses: applyStatus(winding.statuses, StatusId.RecentlyHit, run.state.tick, 60),
    };
    const exit = cancelCast(struck, run.state.tick, CastEndReason.Cancelled);
    expect(exit.cancelled).toBe(true);
    expect(exit.kind).toBe('windup');
    expect(exit.entity.resource).toBe(stats.traits.perfectExitResource);

    // A *backswing* cancel is a different act and pays nothing back.
    const committed = swingInto(fight(stats));
    const inSwing = selfOf(committed);
    const paid: ServerEntity = {
      ...inSwing,
      resource: 0,
      statuses: applyStatus(inSwing.statuses, StatusId.RecentlyHit, committed.state.tick, 60),
    };
    const walked = cancelCast(paid, backswingCancelTickOf(castOf(inSwing)), CastEndReason.Cancelled);
    expect(walked.kind).toBe('backswing');
    expect(walked.entity.resource).toBe(0);
  });
});
