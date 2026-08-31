/**
 * The mechanics, in the sim (spec 147).
 *
 * The tests that decide whether this spec did what it said. Everything above
 * this file checks that the *tables* are coherent; this checks that a blow
 * actually behaves differently because of them.
 *
 * The headline is the first block: **Agility shortens the animation and never
 * the interval.** It is the property the whole design rests on -- if it ever
 * stops holding, the fast attribute has quietly become the damage attribute and
 * the other five are competing with it -- so it is asserted directly against the
 * resolver rather than inferred from a fight.
 */

import { describe, expect, it } from 'vitest';
import { itemById } from '../data/items.js';
import { rollBetween } from './blow.js';
import { monsterById } from '../data/monsters.js';
import { Rng } from '../../shared/prng.js';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
import { ALL_SPECIALIZATIONS } from '../data/specializations.js';
import { describeSpecialization } from '../data/description.js';
import { SCALING } from '../data/scaling.js';
import { startingBaseStats } from '../player/attributes.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import {
  attackTimingFor,
  backswingCancelPointFor,
  castRangeFor,
  cooldownScaleFor,
  overflowCostFor,
  resourceCostFor,
  windupScaleFor,
} from './abilities.js';
import { resolveBlow } from './blow.js';
import { applyEffects } from './skill-effects.js';
import { applyPoiseDamage, isResolute, poiseArmorOf, poiseDamageOf, regenPoise, STAGGER_IMMUNE_TICKS } from './poise.js';
import {
  applyStatus,
  hasStatus,
  NO_STATUSES,
  statusOf,
  StatusId,
  type Statuses,
} from './statuses.js';
import { ActivityValue, AggroValue, CastPhase, EntityKindValue, type CastState, type ServerEntity } from './types.js';
import { advanceProgression, advanceRest, blankProgression } from './world.js';

// --------------------------------------------------------------------------

function record(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 100,
    coins: 0,
    ...overrides,
  };
}

function statsFor(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): EffectiveStats {
  return computeEffectiveStats(record(baseStats, overrides));
}

function body(stats: EffectiveStats, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id: 1,
    kind: EntityKindValue.Player,
    typeId: 'p',
    ownerPlayerId: null,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: stats.maxHealth,
    level: 1,
    zoneId: 'wilds',
    stats,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 16,
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    velocity: { x: 0, y: 0 },
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    leashRadius: 0,
    conversationWith: null,
    fleeGoal: null,
    returnStart: null,
    resource: stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: stats.traits.maxPoise,
    ...overrides,
  };
}

/** A cast state good enough for the phase-dependent rules to read. */
function casting(abilityId: string, phase: number): CastState {
  return {
    abilityId,
    spentResource: 0,
    spentHealth: 0,
    spentCharges: 0,
    spentPoise: 0,
    startedTick: 0,
    windupStartTick: 0,
    releaseTick: 30,
    endTick: 60,
    phase,
    committed: phase === CastPhase.Backswing,
    timing: {
      factor: 1,
      intervalTicks: 72,
      attackPointTicks: 30,
      backswingTicks: 24,
      backswingCancelTicks: 17,
      attacksPerSecond: 1,
    },
    targetX: 100,
    targetY: 0,
    targetEntityId: 0,
    targetInReach: true,
    nextPulseTick: 0,
  };
}

function ability(id: string): AbilityDefinition {
  const found = abilityById(id);
  if (!found) throw new Error(`no such ability: ${id}`);
  return found;
}

const SLASH = ability('melee.slash');
// A ground spell that launches nothing, and a projectile that does: the two
// halves of the handling test below. Repointed off spec 062's demo rows by
// spec 237; what matters about each is its *shape*, not its id.
const SPELL = ability('skill.blight');
const SHOT = ability('ranged.shot');
const DART = ability('skill.poisonDart');

// ==========================================================================

describe('Agility shortens the wind-up and never the interval', () => {
  it('holds at every investment, for the basic attack', () => {
    // The load-bearing assertion of spec 147. `intervalTicks` must be bit
    // identical across the whole range of Agility, while the wind-up shrinks and
    // -- since spec 253 -- the follow-through's cancel point comes forward, so a
    // high-Agility character attacks exactly as often as anyone else and spends
    // far less of each cycle rooted.
    const base = attackTimingFor(SLASH, { stats: statsFor() });
    let previousPoint = base.attackPointTicks;
    let previousCancel = base.backswingCancelTicks;

    for (const agility of [10, 20, 30, 45, SCALING.attributeHardCap]) {
      const timing = attackTimingFor(SLASH, { stats: statsFor({ agility }) });
      expect(timing.intervalTicks, `interval@${agility}`).toBe(base.intervalTicks);
      expect(timing.attacksPerSecond, `rate@${agility}`).toBe(base.attacksPerSecond);
      expect(timing.attackPointTicks, `point@${agility}`).toBeLessThanOrEqual(previousPoint);
      // The phase itself does **not** move (spec 253). Agility buys the exit,
      // not the length, or every point spent would shrink the window the rest of
      // its own tree is played in.
      expect(timing.backswingTicks, `swing@${agility}`).toBe(base.backswingTicks);
      expect(timing.backswingCancelTicks, `cancel@${agility}`).toBeLessThanOrEqual(previousCancel);
      previousPoint = timing.attackPointTicks;
      previousCancel = timing.backswingCancelTicks;
    }

    const capped = attackTimingFor(SLASH, { stats: statsFor({ agility: SCALING.attributeHardCap }) });
    expect(capped.attackPointTicks).toBeLessThan(base.attackPointTicks);
    expect(capped.backswingCancelTicks).toBeLessThan(base.backswingCancelTicks);
    // And the rooted fraction of a cycle really did fall -- counting the
    // follow-through only up to the tick it may be walked out of, which is what
    // a player who walks out of it actually spends.
    const rooted = (t: typeof base): number =>
      (t.attackPointTicks + t.backswingCancelTicks) / t.intervalTicks;
    expect(rooted(capped)).toBeLessThan(rooted(base) * 0.8);
  });

  it('does not let any other attribute touch the interval either', () => {
    const base = attackTimingFor(SLASH, { stats: statsFor() });
    for (const key of ['strength', 'intelligence', 'constitution', 'perception', 'wisdom'] as const) {
      const timing = attackTimingFor(SLASH, { stats: statsFor({ [key]: SCALING.attributeHardCap }) });
      expect(timing.intervalTicks, key).toBe(base.intervalTicks);
    }
  });

  it('shortens a projectile ability by handling, and leaves a melee spell alone', () => {
    // Weapon handling is draw and release: it reaches anything that launches
    // something, and nothing else.
    const agile = { stats: statsFor({ agility: 40 }) };
    expect(windupScaleFor(SHOT, agile, 0)).toBeLessThan(1);
    expect(windupScaleFor(DART, agile, 0)).toBeLessThan(1);
    // Quake launches nothing and is not a basic attack: its wind-up is its own
    // statement about itself.
    expect(windupScaleFor(SPELL, agile, 0)).toBe(1);
  });

  it('lets Flow bring the cancel point forward, and nothing else', () => {
    const stats = statsFor({ agility: 30 }, { specializations: [{ specializationId: 'agi.flow', tier: 3 }] });
    const flowing = applyStatus(NO_STATUSES, StatusId.Flow, 0, 100, { maxStacks: 3 });
    const still = backswingCancelPointFor({ stats, statuses: NO_STATUSES }, 0);
    expect(backswingCancelPointFor({ stats, statuses: flowing }, 0)).toBeLessThan(still);

    // Not the follow-through's length, and not the interval (spec 253). Flow
    // used to divide the phase, which is what made it fight Mobile Offense.
    const dry = attackTimingFor(SLASH, { stats, statuses: NO_STATUSES }, 0);
    const wet = attackTimingFor(SLASH, { stats, statuses: flowing }, 0);
    expect(wet.backswingTicks).toBe(dry.backswingTicks);
    expect(wet.backswingCancelTicks).toBeLessThan(dry.backswingCancelTicks);
    expect(dry.intervalTicks).toBe(attackTimingFor(SLASH, { stats: statsFor() }).intervalTicks);
    expect(wet.intervalTicks).toBe(dry.intervalTicks);
  });
});

// ==========================================================================

describe('poise', () => {
  const attacker = (): ServerEntity => body(statsFor({ strength: 40 }));
  const target = (): ServerEntity => body(statsFor({ constitution: 20 }), { id: 2 });

  it('drains, and staggers when it empties', () => {
    let victim = target();
    const power = poiseDamageOf(attacker().stats, true, 1);
    expect(power).toBeGreaterThan(0);

    let broke = false;
    for (let i = 0; i < 200 && !broke; i++) {
      const result = applyPoiseDamage(victim, power, 0, true);
      victim = result.entity;
      broke = result.broke;
    }
    expect(broke).toBe(true);
    // Refilled whole rather than left at zero -- a pool that stayed empty would
    // make the immunity window the only thing between a body and a permanent
    // stagger.
    expect(victim.poise).toBe(victim.stats.traits.maxPoise);
    expect(victim.staggerImmuneUntilTick).toBe(STAGGER_IMMUNE_TICKS);
  });

  it('cannot be broken twice inside the immunity window', () => {
    // The single most important anti-abuse number in the spec: without it two
    // attackers hold a third permanently, which is a removal rather than a build.
    const victim = { ...target(), poise: 0.0001, staggerImmuneUntilTick: 100 };
    const inside = applyPoiseDamage(victim, 9999, 50, true);
    expect(inside.broke).toBe(false);
    // But the pool still drains, so the moment the window lifts the next blow
    // lands on a guard that has been worn down.
    expect(inside.entity.poise).toBe(0);

    const outside = applyPoiseDamage(inside.entity, 9999, 100, true);
    expect(outside.broke).toBe(true);
  });

  // ------------------------------------------------------------------
  // Who owns the duration of a break (spec 243).
  //
  // `staggerTicks` grows 0.2 a point under Strength -- 31 ticks at 5 and 42 at
  // 60 -- and `resolveBlow` read it off the **defender**, so investing in the
  // overpower attribute bought a longer spell on the floor for yourself and
  // bought whoever broke you nothing. It is the attacker's, like the
  // `staggerPower` that emptied the pool.
  //
  // Driven through `resolveBlow` rather than through `stagger` directly,
  // because the argument is the thing being tested and a test that passed it
  // in would be asserting its own fixture.
  const brokenFor = (breaker: ServerEntity, broken: ServerEntity): number => {
    // A guard already at nothing, so one blow breaks it whatever it carries --
    // the durations are what is being compared, not how long each took to reach.
    const glass = { ...broken, poise: 0.0001 };
    const struck = resolveBlow(SLASH, breaker, glass, 0, Rng.fromSeed(7)).target;
    expect(struck.activity).toBe(ActivityValue.Stunned);
    return struck.activityUntilTick;
  };

  it('lasts as long as the breaker’s Strength says (spec 243)', () => {
    const weak = body(statsFor({ strength: 5 }));
    const strong = body(statsFor({ strength: 60 }));
    expect(strong.stats.traits.staggerTicks).toBeGreaterThan(weak.stats.traits.staggerTicks);

    const victim = target();
    expect(brokenFor(strong, victim)).toBeGreaterThan(brokenFor(weak, victim));
  });

  it('does not depend on the broken body’s own Strength (spec 243)', () => {
    // The fault, stated as its own assertion: the same attacker breaking two
    // bodies that differ *only* in Strength must root them for the same time.
    // Before the fix the high-Strength body was held eleven ticks longer.
    const breaker = body(statsFor({ strength: 30 }));
    const soft = body(statsFor({ strength: 5 }), { id: 2 });
    const burly = body(statsFor({ strength: 60 }), { id: 3 });
    expect(burly.stats.traits.staggerTicks).toBeGreaterThan(soft.stats.traits.staggerTicks);

    expect(brokenFor(breaker, burly)).toBe(brokenFor(breaker, soft));
  });

  it('never lets Strength lengthen its own holder’s stagger (spec 243)', () => {
    // The progression rule the audit enforces, at the one place it is spent:
    // raising Strength must not make anything about being broken worse. A fixed
    // ordinary attacker, and a victim whose Strength climbs the whole range.
    const breaker = body(statsFor({ strength: 20 }));
    const durations = [5, 20, 35, 50, 60].map((strength) =>
      brokenFor(breaker, body(statsFor({ strength }), { id: 2 })),
    );
    expect(new Set(durations).size).toBe(1);
  });

  it('is the caster’s through a skill’s guard break too (spec 243)', () => {
    // The second consumer. `skill-effects.ts`'s `poiseDamage` case had its own
    // copy of the same mistake, reading the duration off `poised.entity` -- so
    // fixing only `resolveBlow` would have left a skill breaking a guard for
    // however long the *broken* body's Strength said.
    const guardBreak = ability('skill.guardBreak');
    const broken = (breaker: ServerEntity): number => {
      const glass = { ...target(), poise: 0.0001, id: 2 };
      const after = applyEffects(guardBreak, breaker, glass, 0, Rng.fromSeed(7)).target;
      expect(after.activity).toBe(ActivityValue.Stunned);
      return after.activityUntilTick;
    };
    expect(broken(body(statsFor({ strength: 60 })))).toBeGreaterThan(
      broken(body(statsFor({ strength: 5 }))),
    );
  });

  it('drops whatever the broken body was casting, and reports it', () => {
    const victim = { ...target(), poise: 1, cast: casting('skill.blight', CastPhase.Windup) };
    const result = applyPoiseDamage(victim, 9999, 0, true);
    expect(result.broke).toBe(true);
    expect(result.interrupted?.abilityId).toBe('skill.blight');
    expect(result.entity.cast).toBeNull();
  });

  it('protects a wind-up and nothing else', () => {
    // The rule that separates hyper-armour from crowd-control immunity.
    const stats = statsFor({ strength: 40 });
    expect(stats.traits.windupPoiseArmor).toBeGreaterThan(0);

    const idle = body(stats);
    expect(poiseArmorOf(idle, true)).toBe(0);

    const windup = body(stats, { cast: casting('melee.slash', CastPhase.Windup) });
    expect(poiseArmorOf(windup, true)).toBeCloseTo(stats.traits.windupPoiseArmor, 9);

    // Turning counts -- the body has committed and is coming round to it.
    const turning = body(stats, { cast: casting('melee.slash', CastPhase.Turning) });
    expect(poiseArmorOf(turning, true)).toBeGreaterThan(0);

    // The follow-through does not, until Unstoppable says so.
    const backswing = body(stats, { cast: casting('melee.slash', CastPhase.Backswing) });
    expect(poiseArmorOf(backswing, true)).toBe(0);
    const unstoppable = body(
      statsFor({ strength: SCALING.attributeHardCap }),
      { cast: casting('melee.slash', CastPhase.Backswing) },
    );
    expect(poiseArmorOf(unstoppable, true)).toBeGreaterThan(0);
  });

  it('protects a basic attack but not a spell, until Unstoppable', () => {
    // This used to reach the mechanic through the STR/CON Juggernaut pair, which
    // spec 244 removed. `poiseArmorAllCasts` and `juggernautBelow` have another
    // source and always did -- the Strength 40 specialization -- so the mechanic
    // survives the removal and this is the same claim through what is left.
    const strong = body(statsFor({ strength: 40 }), { cast: casting('skill.blight', CastPhase.Windup) });
    expect(strong.stats.traits.poiseArmorAllCasts).toBe(0);
    expect(poiseArmorOf(strong, false)).toBe(0);

    const unstoppable = statsFor(
      { strength: 40 },
      { specializations: [{ specializationId: 'str.unstoppable', tier: 1 }] },
    );
    expect(unstoppable.traits.poiseArmorAllCasts).toBe(1);
    const covered = body(unstoppable, { cast: casting('skill.blight', CastPhase.Windup) });
    expect(poiseArmorOf(covered, false)).toBeGreaterThan(0);
  });

  it('regenerates faster when the body is not committed', () => {
    const stats = statsFor({ constitution: 25 });
    const drained = body(stats, { poise: 0 });
    const calm = regenPoise(drained, 0, false, false);
    const committed = regenPoise({ ...drained, cast: casting('melee.slash', CastPhase.Windup) }, 0, false, false);
    expect(calm).toBeGreaterThan(committed);
    // And a staggered body gets nothing back without Sustained Effort.
    expect(regenPoise(drained, 0, false, true)).toBe(0);
  });

  it('turns resolute below the threshold, and cannot be broken there', () => {
    const stats = statsFor({ constitution: 35 });
    expect(stats.traits.resoluteBelow).toBeGreaterThan(0);
    const healthy = body(stats);
    expect(isResolute(healthy)).toBe(false);
    const dying = { ...healthy, health: stats.maxHealth * 0.2, poise: 1 };
    expect(isResolute(dying)).toBe(true);
    expect(applyPoiseDamage(dying, 9999, 0, true).broke).toBe(false);
  });
});

// ==========================================================================

describe('a blow', () => {
  const rng = Rng.fromSeed(7);

  it('leaves an opening on a weak point, and pays for the second hit not the first', () => {
    // Perception's payoff is a two-step play: the hit that finds the seam is the
    // one that marks it, and the mark is what the *next* hit cashes in.
    const sniper = statsFor({ perception: SCALING.attributeHardCap }, {
      specializations: [
        { specializationId: 'per.weakPointStudy', tier: 3 },
        { specializationId: 'per.exploit', tier: 3 },
      ],
    });
    expect(sniper.traits.weakPointChance).toBeGreaterThan(0.4);
    expect(sniper.traits.exposeTicks).toBeGreaterThan(0);

    const attacker = body(sniper);
    const victim = body(statsFor(), { id: 2 });
    // Enough blows that a weak point is certain at this chance.
    let current = victim;
    let currentRng = rng;
    let exposed: Statuses | null = null;
    for (let i = 0; i < 40 && !exposed; i++) {
      const result = resolveBlow(SLASH, attacker, current, i, currentRng);
      currentRng = result.rng;
      current = { ...result.target, health: result.target.stats.maxHealth };
      if (statusOf(current.statuses, StatusId.Exposed, i)) exposed = current.statuses;
    }
    expect(exposed).not.toBeNull();
    expect(statusOf(exposed ?? NO_STATUSES, StatusId.Exposed, 0)?.magnitude).toBeCloseTo(
      sniper.traits.exposedDamagePct,
      6,
    );
  });

  it('is worth more against an exposed body, to everyone', () => {
    // `exposed` is on the *target*, so an ally benefits from a mark they did not
    // set. That is what makes Perception a team stat rather than a self-buff.
    const ally = body(statsFor(), { id: 3 });
    const clean = body(statsFor(), { id: 2 });
    const marked = { ...clean, statuses: applyStatus(NO_STATUSES, StatusId.Exposed, 0, 100, { magnitude: 0.5 }) };

    const a = resolveBlow(SLASH, ally, clean, 0, Rng.fromSeed(1));
    const b = resolveBlow(SLASH, ally, marked, 0, Rng.fromSeed(1));
    const damageOf = (events: readonly { kind: string }[]): number =>
      (events.find((e) => e.kind === 'hit') as { damage: number } | undefined)?.damage ?? 0;
    expect(damageOf(b.events)).toBeGreaterThan(damageOf(a.events));
  });

  it('shields before health, and never past the ceiling', () => {
    const stats = statsFor({ constitution: SCALING.attributeHardCap });
    expect(stats.traits.maxShield).toBeGreaterThan(0);
    const shielded = body(stats, { id: 2, shield: 30, shieldUntilTick: 999 });
    const result = resolveBlow(SLASH, body(statsFor()), shielded, 0, rng);
    expect(result.target.health).toBe(stats.maxHealth);
    expect(result.target.shield).toBeLessThan(30);
  });

  it('lets an expired shield absorb nothing', () => {
    const shielded = body(statsFor(), { id: 2, shield: 9999, shieldUntilTick: 5 });
    const result = resolveBlow(SLASH, body(statsFor()), shielded, 10, rng);
    expect(result.target.health).toBeLessThan(shielded.health);
    expect(result.target.shield).toBe(0);
  });

  it('builds adaptation against the ability that keeps landing', () => {
    const enduring = statsFor({ wisdom: 40 });
    expect(enduring.traits.adaptationPerStack).toBeGreaterThan(0);

    let victim = body(enduring, { id: 2 });
    let currentRng = rng;
    const damages: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = resolveBlow(DART, body(statsFor()), victim, i, currentRng);
      currentRng = result.rng;
      const hit = result.events.find((e) => e.kind === 'hit') as { damage: number } | undefined;
      if (hit) damages.push(hit.damage);
      victim = { ...result.target, health: enduring.maxHealth };
    }
    // The sixth arrow hurts less than the first. Crit rolls make individual
    // blows noisy, so the claim is about the trend across the run.
    expect(Math.min(...damages)).toBeLessThan(damages[0] ?? 0);
  });

  it('rolls the weapon then the crit, always, so a replay is reproducible', () => {
    // Not a style rule. The Rng is threaded through the whole sim, and a body
    // that draws a different number of values changes every fight after it.
    //
    // Two draws for a basic attack since spec 217 -- the weapon's own range and
    // then the crit -- where it used to be the crit alone. Built through
    // `rollBetween` rather than by spelling the first draw out here, so the
    // order is asserted against the function the sim actually calls.
    const stats = statsFor();
    const noWeakPoint = body({ ...stats, traits: { ...NEUTRAL_TRAITS, weakPointChance: 0 } });
    const [, afterWeapon] = rollBetween(Rng.fromSeed(99), stats.weaponDamageMin, stats.weaponDamageMax);
    const [, expected] = afterWeapon.nextInt(0, 9999);
    const result = resolveBlow(SLASH, noWeakPoint, body(statsFor(), { id: 2 }), 0, Rng.fromSeed(99));
    expect(result.rng.getState()).toEqual(expected.getState());
  });

  it('rolls the crit alone for an ability, which has no weapon range to roll', () => {
    const noWeakPoint = body({ ...statsFor(), traits: { ...NEUTRAL_TRAITS, weakPointChance: 0 } });
    const [, expected] = Rng.fromSeed(99).nextInt(0, 9999);
    const result = resolveBlow(DART, noWeakPoint, body(statsFor(), { id: 2 }), 0, Rng.fromSeed(99));
    expect(result.rng.getState()).toEqual(expected.getState());
  });

  it('is deterministic: the same seed and the same bodies, twice', () => {
    const attacker = body(statsFor({ perception: 40, strength: 30 }));
    const victim = body(statsFor({ constitution: 30 }), { id: 2 });
    const a = resolveBlow(SLASH, attacker, victim, 12, Rng.fromSeed(4242));
    const b = resolveBlow(SLASH, attacker, victim, 12, Rng.fromSeed(4242));
    expect(JSON.stringify(a.target)).toBe(JSON.stringify(b.target));
    expect(JSON.stringify(a.attacker)).toBe(JSON.stringify(b.attacker));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('sunders on a basic attack only for a body granted it, and nothing grants it', () => {
    // The positive half of this case reached `appliesSundered` through the
    // STR/INT Impact Casting pair, and spec 244 removed the pair. Nothing else
    // in any table grants the flag, so the mechanic is live in `blow.ts` and
    // unreachable from content -- one of twenty-two trait fields the synergy
    // removal orphaned, recorded in `docs/progression-model.md` rather than
    // deleted, because taking a field out of `TraitStats` is a protocol change.
    //
    // What is still worth asserting is the gate: a blow does *not* sunder
    // unless something granted it, which is what would break if the flag ever
    // acquired a default.
    for (const attribute of [{}, { strength: 25, intelligence: 25 }, { strength: 60 }]) {
      const stats = statsFor(attribute);
      expect(stats.traits.appliesSundered, JSON.stringify(attribute)).toBe(0);
      const plain = resolveBlow(SLASH, body(stats), body(statsFor(), { id: 2 }), 0, rng);
      expect(statusOf(plain.target.statuses, StatusId.Sundered, 0)).toBeNull();
    }
  });
});

// ==========================================================================

describe('the resource economy', () => {
  it('is exactly the table for a fresh character', () => {
    expect(resourceCostFor(SPELL, { stats: statsFor() }, 0)).toBe(SPELL.cost);
  });

  it('falls with Wisdom, and never to zero', () => {
    const wise = resourceCostFor(SPELL, { stats: statsFor({ wisdom: SCALING.attributeHardCap }) }, 0);
    expect(wise).toBeLessThan(SPELL.cost);
    expect(wise).toBeGreaterThan(0);
  });

  it('leaves a free ability free, whatever the discounts', () => {
    // Every factor multiplies, so an ability with `cost: 0` can never refund.
    expect(resourceCostFor(SLASH, { stats: statsFor({ wisdom: SCALING.attributeHardCap }) }, 0)).toBe(0);
  });

  it('charges the shaping premium, and lets Efficient Construction pay it off', () => {
    const shaper = statsFor({ intelligence: 25 }, { specializations: [{ specializationId: 'int.shaping', tier: 3 }] });
    const efficient = statsFor({ intelligence: 25 }, {
      specializations: [
        { specializationId: 'int.shaping', tier: 3 },
        { specializationId: 'int.efficientConstruction', tier: 3 },
      ],
    });
    // Below the shaping milestone, so this one is paying no premium at all.
    const plain = statsFor({ intelligence: 19 });

    const shaped = resourceCostFor(SPELL, { stats: shaper }, 0);
    const paidOff = resourceCostFor(SPELL, { stats: efficient }, 0);
    const unshaped = resourceCostFor(SPELL, { stats: plain }, 0);

    expect(unshaped).toBe(SPELL.cost);
    expect(shaped).toBeGreaterThan(unshaped);
    expect(paidOff).toBeLessThan(shaped);
    // The relief can only ever cancel the premium -- it can never make an
    // unshaped cast cheaper, which is Wisdom's job and not Intelligence's. So
    // full relief lands *on* the list price, and never under it, while keeping
    // the geometry the premium was paying for.
    expect(paidOff).toBeCloseTo(SPELL.cost, 9);
    expect(efficient.traits.spellRadiusPct).toBeGreaterThan(0);
  });

  it('lets Attuned and Flow stack a discount, bounded', () => {
    const stats = statsFor({ wisdom: 25, agility: 25 });
    const bare = resourceCostFor(SPELL, { stats, statuses: NO_STATUSES }, 0);
    let held: Statuses = NO_STATUSES;
    for (let i = 0; i < 3; i++) held = applyStatus(held, StatusId.Attuned, 0, 100, { maxStacks: 3 });
    for (let i = 0; i < 3; i++) held = applyStatus(held, StatusId.Flow, 0, 100, { maxStacks: 3 });
    const discounted = resourceCostFor(SPELL, { stats, statuses: held }, 0);
    expect(discounted).toBeLessThan(bare);
    expect(discounted).toBeGreaterThan(0);
  });
});

describe('arcane overflow', () => {
  const overflowing = (): EffectiveStats => statsFor({ intelligence: SCALING.attributeHardCap });

  it('is refused outright without the milestone', () => {
    expect(overflowCostFor({ stats: statsFor(), health: 1000 }, 5)).toBe(0);
  });

  it('charges health per point short', () => {
    const stats = overflowing();
    expect(stats.traits.overflowHealthPerResource).toBeGreaterThan(0);
    const bill = overflowCostFor({ stats, health: 1000 }, 5);
    expect(bill).toBeCloseTo(5 * stats.traits.overflowHealthPerResource, 6);
  });

  it('refuses a bill past a fraction of *current* health, so it can never kill', () => {
    // Current rather than maximum is the whole safety property: a character at
    // 5% health can never pay 40% of their pool and die to their own spell.
    const stats = overflowing();
    const nearlyDead = { stats, health: 4 };
    expect(overflowCostFor(nearlyDead, 100)).toBe(0);
    // And whatever it does allow leaves something behind.
    const affordable = overflowCostFor({ stats, health: 1000 }, 5);
    expect(affordable).toBeLessThan(1000);
  });

  it('is relieved by Arcane Overflow itself, never made dearer', () => {
    // Reached through the INT/CON Battlemage pair until spec 244 removed it.
    // `overflowCostReduction` has two other sources -- the Intelligence 40
    // specialization and the Intelligence 50 milestone -- and spec 239's rule
    // that a price may only ever be *relieved* is what makes them compose in
    // either order. This is that rule through what is left.
    const enabled = statsFor({ intelligence: 50 });
    const relieved = statsFor(
      { intelligence: 50 },
      { specializations: [{ specializationId: 'int.overflow', tier: 1 }] },
    );
    expect(enabled.traits.overflowHealthPerResource).toBeGreaterThan(0);
    expect(relieved.traits.overflowHealthPerResource).toBeLessThan(
      enabled.traits.overflowHealthPerResource,
    );
  });
});

describe('Second Wind', () => {
  // The one thing in this system that restores health without a heal. It is
  // driven from the timers pass rather than from a blow, so it is tested there.
  const conStats = (): EffectiveStats =>
    statsFor({ constitution: 25 }, { specializations: [{ specializationId: 'con.secondWind', tier: 3 }] });

  it('does nothing while the body is healthy', () => {
    const stats = conStats();
    expect(stats.traits.secondWindHeal).toBeGreaterThan(0);
    const healthy = body(stats);
    expect(advanceProgression(healthy, 1, false).health).toBe(healthy.health);
  });

  it('fires once below the threshold, and not again', () => {
    const stats = conStats();
    const hurt = { ...body(stats), health: stats.maxHealth * 0.2 };
    const revived = advanceProgression(hurt, 1, false);
    expect(revived.health).toBeGreaterThan(hurt.health);
    expect(hasStatus(revived.statuses, StatusId.SecondWindSpent, 1)).toBe(true);

    // Knocked back down inside the window: nothing, because it is spent.
    const again = advanceProgression({ ...revived, health: stats.maxHealth * 0.1 }, 2, false);
    expect(again.health).toBe(stats.maxHealth * 0.1);
  });

  it('stays spent however far the body climbs back out (spec 239)', () => {
    // **The bug this replaced, as the assertion.** The old rule re-armed Second
    // Wind the moment health went back over the threshold -- and the comeback
    // itself does that, on the same tick, because healing 12% of maximum from
    // under 30% lands above 30%. So the cooldown was cleared one tick after it
    // was applied, every single time, and a Constitution character could cycle
    // the threshold for as long as they liked.
    const stats = conStats();
    const hurt = { ...body(stats), health: stats.maxHealth * 0.2 };
    const spent = advanceProgression(hurt, 1, false);
    expect(hasStatus(spent.statuses, StatusId.SecondWindSpent, 1)).toBe(true);

    // Fully healed, and still spent.
    const full = advanceProgression({ ...spent, health: stats.maxHealth }, 2, false);
    expect(hasStatus(full.statuses, StatusId.SecondWindSpent, 2)).toBe(true);

    // And a long way later, so it is a lifecycle rather than a long timer.
    const later = advanceProgression({ ...full, health: stats.maxHealth }, 100_000, false);
    expect(hasStatus(later.statuses, StatusId.SecondWindSpent, 100_000)).toBe(true);
  });

  it('cannot be cycled by crossing the threshold again and again (spec 239)', () => {
    // The property stated directly, over the loop that used to work: drop under
    // the threshold, get the comeback, climb out, drop under again. Only the
    // first one pays.
    const stats = conStats();
    let self = { ...body(stats), health: stats.maxHealth * 0.2 };
    let comebacks = 0;
    for (let round = 0; round < 5; round++) {
      const before = self.health;
      self = advanceProgression(self, round * 10 + 1, false);
      if (self.health > before) comebacks++;
      // Climb back out under their own steam, then take a beating again.
      self = { ...self, health: stats.maxHealth };
      self = advanceProgression(self, round * 10 + 5, false);
      self = { ...self, health: stats.maxHealth * 0.2 };
    }
    expect(comebacks).toBe(1);
  });

  it('re-arms on a rest, which is the flask’s own reset (spec 239)', () => {
    const stats = conStats();
    const hurt = { ...body(stats), health: stats.maxHealth * 0.2 };
    const spent = advanceProgression(hurt, 1, false);
    expect(hasStatus(spent.statuses, StatusId.SecondWindSpent, 1)).toBe(true);

    // Resting is the boundary: `advanceRest` clears it beside the charge it
    // returns. A player *not* resting keeps it, which is the other half.
    const walked = advanceRest({ ...spent, kind: EntityKindValue.Player }, 2, false);
    expect(hasStatus(walked.statuses, StatusId.SecondWindSpent, 2)).toBe(true);

    const rested = advanceRest({ ...spent, kind: EntityKindValue.Player }, 2, true);
    expect(hasStatus(rested.statuses, StatusId.SecondWindSpent, 2)).toBe(false);
  });

  it('says what it does, in the same test that proves it (spec 243)', () => {
    // **The drift this exists to stop.** Spec 239 made the reset a rest or a
    // death; the skill's flavour went on saying it would not fire again *"until
    // you have climbed back out"*, which was the rule it replaced, and it was
    // shown to players for four specs. Every mechanic test above passed the
    // whole time, because none of them read the description.
    //
    // So the claim and the behaviour are asserted together, off the same skill
    // row. A future change to either side that leaves the other alone fails
    // here.
    const skill = ALL_SPECIALIZATIONS.find((row) => row.id === 'con.secondWind');
    expect(skill).toBeDefined();
    if (!skill) return;
    const said = describeSpecialization(skill).lines.map((line) => line.text).join(' ');

    const stats = conStats();
    const hurt = { ...body(stats), health: stats.maxHealth * 0.2 };
    const spent = advanceProgression(hurt, 1, false);
    const held = (entity: ServerEntity, tick: number): boolean =>
      hasStatus(entity.statuses, StatusId.SecondWindSpent, tick);

    // 1. It says resting re-arms it, and resting does.
    expect(said).toContain('Resting in a safe zone re-arms it');
    expect(held(advanceRest({ ...spent, kind: EntityKindValue.Player }, 2, true), 2)).toBe(false);

    // 2. It says recovering health does not, and it does not.
    expect(said).toContain('Recovering health does not');
    expect(held(advanceProgression({ ...spent, health: stats.maxHealth }, 2, false), 2)).toBe(true);

    // 3. And the flavour makes no mechanical claim at all, which is the rule
    //    that was broken rather than the sentence that was wrong: flavour has
    //    nothing keeping it true, so the lifecycle belongs in a derived line.
    const flavor = skill.description.toLowerCase();
    for (const word of ['climb', 'rest', 'again', 'until', 'heal', 'recover']) {
      expect(flavor, `flavour claims a mechanic: "${skill.description}"`).not.toContain(word);
    }
  });

  it('is nothing at all for a body without the skill', () => {
    const stats = statsFor({ constitution: 40 });
    const hurt = { ...body(stats), health: 5 };
    expect(advanceProgression(hurt, 1, false).health).toBe(5);
  });
});

describe('prepared casting', () => {
  it('is primed by stillness and by nothing else', () => {
    const stats = statsFor({ intelligence: 35 });
    expect(stats.traits.prepareTicks).toBeGreaterThan(0);

    let self = body(stats, { stillSinceTick: 0 });
    // Moving keeps stamping the clock forward, so it never primes.
    for (let tick = 1; tick <= stats.traits.prepareTicks + 10; tick++) {
      self = advanceProgression(self, tick, true);
    }
    expect(hasStatus(self.statuses, StatusId.Prepared, 999)).toBe(false);

    let still = body(stats, { stillSinceTick: 0 });
    for (let tick = 1; tick <= stats.traits.prepareTicks + 1; tick++) {
      still = advanceProgression(still, tick, false);
    }
    expect(hasStatus(still.statuses, StatusId.Prepared, 999)).toBe(true);
  });

  it('halves the next non-basic wind-up, and leaves the weapon alone', () => {
    const stats = statsFor({ intelligence: 35 });
    const primed = applyStatus(NO_STATUSES, StatusId.Prepared, 0, 9999);
    expect(windupScaleFor(SPELL, { stats, statuses: primed }, 0)).toBeLessThan(
      windupScaleFor(SPELL, { stats, statuses: NO_STATUSES }, 0),
    );
    expect(windupScaleFor(SLASH, { stats, statuses: primed }, 0)).toBe(
      windupScaleFor(SLASH, { stats, statuses: NO_STATUSES }, 0),
    );
  });

  it('never refunds a cooldown, because nothing grants preparedMastery', () => {
    // The refund reached `preparedMastery` through the INT/WIS Archmage pair,
    // which spec 244 removed; nothing else grants it, so this is the second of
    // the orphaned twenty-two. Kept as the negative case rather than deleted:
    // being Prepared must not start refunding cooldowns by accident, and the
    // flag acquiring a default is exactly how it would.
    const primed = applyStatus(NO_STATUSES, StatusId.Prepared, 0, 9999);
    for (const attribute of [{ intelligence: 35 }, { intelligence: 35, wisdom: 25 }]) {
      const stats = statsFor(attribute);
      expect(stats.traits.preparedMastery, JSON.stringify(attribute)).toBe(0);
      expect(cooldownScaleFor(SPELL, { stats, statuses: primed }, 0)).toBe(
        cooldownScaleFor(SPELL, { stats, statuses: NO_STATUSES }, 0),
      );
    }
  });
});

describe('spell geometry', () => {
  it('does nothing without the shaping milestone', () => {
    expect(statsFor({ intelligence: 19 }).traits.spellRadiusPct).toBe(0);
    expect(castRangeFor(SPELL, { stats: statsFor({ intelligence: 19 }) })).toBe(SPELL.range);
  });

  it('reaches further and lands wider once it is held', () => {
    const shaper = statsFor({ intelligence: SCALING.attributeHardCap });
    expect(shaper.traits.spellRadiusPct).toBeGreaterThan(0);
    expect(castRangeFor(SPELL, { stats: shaper })).toBeGreaterThan(SPELL.range);
  });

  it('never lengthens a basic attack, whatever the Intelligence', () => {
    // A weapon's reach is the weapon's. Shaping is for constructed things.
    const shaper = statsFor({ intelligence: SCALING.attributeHardCap });
    expect(castRangeFor(SLASH, { stats: shaper })).toBe(SLASH.range);
  });
});

/**
 * A weapon's letters reaching a real blow (spec 216).
 *
 * `resolveBlow` was not touched by that spec -- what changed is what
 * `weaponPower` is built from -- so what is asserted here is exactly that: the
 * scaled damage goes through crit, armour and the rest of the pipeline the way
 * the unscaled damage always did, and a basic attack is the only thing it
 * reaches.
 */
describe('weapon scaling through a blow', () => {
  const holding = (mainHand: string, baseStats: Partial<BaseStats> = {}): EffectiveStats =>
    statsFor(baseStats, { equipment: { ...EMPTY_EQUIPMENT, mainHand }, level: 20 });

  /**
   * What one blow took off, measured as health lost.
   *
   * `BlowResult` carries the bodies rather than a number, so the damage is the
   * difference -- which is also the honest measurement, since it is what the
   * whole pipeline (crit, armour, shields) actually left behind.
   */
  const struck = (attacker: EffectiveStats, seed = 7): number => {
    const target = body(statsFor(), { id: 2 });
    const result = resolveBlow(SLASH, body(attacker), target, 0, Rng.fromSeed(seed));
    return target.health - result.target.health;
  };

  it('hits harder with the maul on a Strength build than on an Agility one', () => {
    expect(struck(holding('maul.iron', { strength: 40 }))).toBeGreaterThan(
      struck(holding('maul.iron', { agility: 40 })),
    );
  });

  it('hits harder with the stars on an Agility build -- the other way round', () => {
    expect(struck(holding('stars.weighted', { agility: 40 }))).toBeGreaterThan(
      struck(holding('stars.weighted', { strength: 40 })),
    );
  });

  it('still loses the target\'s armour off the scaled number', () => {
    const attacker = holding('maul.iron', { strength: 40 });
    const soft = body(statsFor(), { id: 2 });
    const armoured = body(statsFor({ constitution: 50 }), { id: 3 });
    const bare = resolveBlow(SLASH, body(attacker), soft, 0, Rng.fromSeed(11));
    const mitigated = resolveBlow(SLASH, body(attacker), armoured, 0, Rng.fromSeed(11));
    expect(armoured.stats.armor).toBeGreaterThan(soft.stats.armor);
    // Compared as fractions of each body's own pool, since Constitution moved
    // the armoured body's maximum health as well as its armour.
    const took = (before: ServerEntity, after: ServerEntity): number =>
      (before.health - after.health) / before.stats.maxHealth;
    expect(took(armoured, mitigated.target)).toBeLessThan(took(soft, bare.target));
  });

  // The split spec 147 drew and neither this spec nor 238 moved: a swing scales
  // with what you are swinging, and an ability with its own declared letters. A
  // weapon's letters must not reach an ability's damage.
  //
  // The pair is `sword.worn` against `bow.hunting` because those are the two
  // weapons in the table that grant **no attributes at all**, which is what
  // isolates the claim. A weapon's attribute grants reach an ability's damage
  // and are *meant* to (spec 238) -- +2 Strength off a maul is +2 Strength, and
  // an ability with a Strength letter reads it exactly as it would off an
  // amulet. Measured with the maul against the stars this test compared a build
  // one Agility richer with a build two Strength richer and read the difference
  // as a leak. Their letters are as far apart as the table goes -- A/D/- against
  // D/A/- -- so a leak would show.
  it('leaves an ability\'s damage alone -- that is still its own letters', () => {
    const target = body(statsFor(), { id: 2 });
    const sword = resolveBlow(DART, body(holding('sword.worn', { strength: 40 })), target, 0, Rng.fromSeed(3));
    const bow = resolveBlow(DART, body(holding('bow.hunting', { strength: 40 })), target, 0, Rng.fromSeed(3));
    expect(sword.target.health).toBeCloseTo(bow.target.health, 9);
  });
});

/**
 * The weapon's own damage, rolled (spec 217).
 *
 * What a basic attack is built on changed: it used to be `ability.damage` times
 * a multiplier, and it is now a roll between the two ends `computeEffectiveStats`
 * resolved. These assert the roll itself and the two bugs the change closed.
 */
describe('a rolled weapon range', () => {
  const holding = (mainHand: string, baseStats: Partial<BaseStats> = {}): EffectiveStats =>
    statsFor(baseStats, { equipment: { ...EMPTY_EQUIPMENT, mainHand }, level: 20 });

  /** One blow's damage against an unarmoured body, as health lost. */
  const hit = (attacker: EffectiveStats, seed: number): number => {
    // Armour explicitly zeroed rather than built low: every attribute grants a
    // little, so even a Constitution-0 body mitigates a couple of percent and
    // the rolled integer comes back fractional.
    const target = body({ ...statsFor(), armor: 0 }, { id: 2, health: 100_000 });
    const result = resolveBlow(SLASH, body(attacker), target, 0, Rng.fromSeed(seed));
    return target.health - result.target.health;
  };

  it('rolls an integer inside its range, and reaches both ends', () => {
    // Asserted on `rollBetween` itself rather than on a blow's damage, because
    // by the time a blow has been through crit, weak points and armour the
    // number is no longer the roll -- and a test that filtered those out would
    // be asserting the filter.
    const stats = holding('maul.iron');
    const lo = Math.round(stats.weaponDamageMin);
    const hi = Math.round(stats.weaponDamageMax);
    expect(hi).toBeGreaterThan(lo);
    const seen = new Set<number>();
    let rng = Rng.fromSeed(1);
    for (let i = 0; i < 400; i++) {
      const [roll, next] = rollBetween(rng, stats.weaponDamageMin, stats.weaponDamageMax);
      rng = next;
      expect(Number.isInteger(roll)).toBe(true);
      expect(roll).toBeGreaterThanOrEqual(lo);
      expect(roll).toBeLessThanOrEqual(hi);
      seen.add(roll);
    }
    expect(seen.has(lo), 'never rolled its minimum').toBe(true);
    expect(seen.has(hi), 'never rolled its maximum').toBe(true);
  });

  it('carries the roll into the blow: an ordinary hit is never below the floor', () => {
    const stats = holding('maul.iron');
    const lo = Math.round(stats.weaponDamageMin);
    for (let seed = 0; seed < 120; seed++) {
      expect(hit(stats, seed), `seed ${seed}`).toBeGreaterThanOrEqual(lo);
    }
  });

  it('is the same damage for the same seed, twice', () => {
    const stats = holding('maul.iron');
    for (let seed = 0; seed < 20; seed++) expect(hit(stats, seed)).toBe(hit(stats, seed));
  });

  // The rule the draw order rests on: a blow's draw count may depend on the
  // ability's own row, never on the attacker's stats.
  it('spends the same number of draws whatever the attacker\'s stats', () => {
    const target = body(statsFor(), { id: 2 });
    const after = (attacker: EffectiveStats): readonly number[] =>
      resolveBlow(SLASH, body(attacker), target, 0, Rng.fromSeed(5)).rng.getState();
    // Perception moves the weak-point chance and Strength the range; neither
    // may move where the next blow's Rng starts.
    expect(after(holding('maul.iron', { perception: 40 }))).toEqual(
      after(holding('maul.iron', { strength: 40 })),
    );
  });

  it('gives a fresh character exactly the Worn Sword\'s authored range', () => {
    const fresh = statsFor({}, { equipment: { ...EMPTY_EQUIPMENT, mainHand: 'sword.worn' } });
    const row = itemById('sword.worn')?.damage;
    expect(row).toEqual({ min: 1, max: 3 });
    expect(Math.round(fresh.weaponDamageMin)).toBe(row?.min);
    expect(Math.round(fresh.weaponDamageMax)).toBe(row?.max);
  });

  // Spec 217's second finding: every melee monster hit for `melee.slash.damage`
  // and the number its row authored reached nothing but its stagger power.
  it('makes a monster hit for what its own row authors', () => {
    const ravager = monsterById('ravager');
    const grazer = monsterById('grazer');
    expect(ravager?.stats.weaponDamageMin).toBe(ravager?.stats.attackDamage);
    expect(grazer?.stats.weaponDamageMin).toBe(grazer?.stats.attackDamage);
    expect(ravager?.stats.weaponDamageMin).not.toBe(grazer?.stats.weaponDamageMin);
  });

  it('leaves a body that authors no damage unable to hurt anything', () => {
    // The training dummy, which authored 0 and hit for 14 before spec 217.
    const dummy = monsterById('dummy');
    expect(dummy?.stats.attackDamage).toBe(0);
    expect(dummy?.stats.weaponDamageMax).toBe(0);
  });

  it('resolves attackDamage as the midpoint of the range', () => {
    const stats = holding('maul.iron', { strength: 30 });
    expect(stats.attackDamage).toBeCloseTo((stats.weaponDamageMin + stats.weaponDamageMax) / 2, 9);
  });

  it('still moves the range with the weapon\'s own scaling, and only that', () => {
    // The maul is `S / - / -`, the stars `- / S / -`.
    expect(holding('maul.iron', { strength: 40 }).weaponDamageMax).toBeGreaterThan(
      holding('maul.iron').weaponDamageMax,
    );
    expect(holding('stars.weighted', { strength: 40 }).weaponDamageMax).toBeCloseTo(
      holding('stars.weighted').weaponDamageMax,
      9,
    );
  });

  // The weapon *roll* specifically: `weaponDamageMin`/`Max` differ by a factor
  // of three across these two and an ability that read them would say so. The
  // pair grants no attributes, for the reason the sibling test above states at
  // length.
  it('leaves an ability\'s damage off the weapon entirely', () => {
    const target = body(statsFor(), { id: 2 });
    const sword = resolveBlow(DART, body(holding('sword.worn')), target, 0, Rng.fromSeed(3));
    const bow = resolveBlow(DART, body(holding('bow.hunting')), target, 0, Rng.fromSeed(3));
    expect(holding('bow.hunting').weaponDamageMax).not.toBeCloseTo(holding('sword.worn').weaponDamageMax, 9);
    expect(sword.target.health).toBeCloseTo(bow.target.health, 9);
    expect(sword.target.health).toBeLessThan(target.health);
  });
});
