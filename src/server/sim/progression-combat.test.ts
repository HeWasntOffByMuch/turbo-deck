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
import { Rng } from '../../shared/prng.js';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
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
  backswingScaleFor,
  castRangeFor,
  cooldownScaleFor,
  overflowCostFor,
  resourceCostFor,
  windupScaleFor,
} from './abilities.js';
import { resolveBlow, SUNDER_TICKS } from './blow.js';
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
import { advanceProgression, blankProgression } from './world.js';

// --------------------------------------------------------------------------

function record(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
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
    attackSlot: -1,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
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
    timing: { factor: 1, intervalTicks: 72, attackPointTicks: 30, backswingTicks: 24, attacksPerSecond: 1 },
    targetX: 100,
    targetY: 0,
    targetEntityId: 0,
    nextPulseTick: 0,
  };
}

function ability(id: string): AbilityDefinition {
  const found = abilityById(id);
  if (!found) throw new Error(`no such ability: ${id}`);
  return found;
}

const SLASH = ability('melee.slash');
const QUAKE = ability('ground.quake');
const SHOT = ability('ranged.shot');
const BOLT = ability('bolt.arcane');

// ==========================================================================

describe('Agility shortens the animation and never the interval', () => {
  it('holds at every investment, for the basic attack', () => {
    // The load-bearing assertion of spec 147. `intervalTicks` must be bit
    // identical across the whole range of Agility, while both animation spans
    // shrink -- so a high-Agility character attacks exactly as often as anyone
    // else and spends far less of each cycle rooted.
    const base = attackTimingFor(SLASH, { stats: statsFor() });
    let previousPoint = base.attackPointTicks;
    let previousSwing = base.backswingTicks;

    for (const agility of [10, 20, 30, 45, SCALING.attributeHardCap]) {
      const timing = attackTimingFor(SLASH, { stats: statsFor({ agility }) });
      expect(timing.intervalTicks, `interval@${agility}`).toBe(base.intervalTicks);
      expect(timing.attacksPerSecond, `rate@${agility}`).toBe(base.attacksPerSecond);
      expect(timing.attackPointTicks, `point@${agility}`).toBeLessThanOrEqual(previousPoint);
      expect(timing.backswingTicks, `swing@${agility}`).toBeLessThanOrEqual(previousSwing);
      previousPoint = timing.attackPointTicks;
      previousSwing = timing.backswingTicks;
    }

    const capped = attackTimingFor(SLASH, { stats: statsFor({ agility: SCALING.attributeHardCap }) });
    expect(capped.attackPointTicks).toBeLessThan(base.attackPointTicks);
    expect(capped.backswingTicks).toBeLessThan(base.backswingTicks);
    // And the rooted fraction of a cycle really did fall.
    const rooted = (t: typeof base): number => (t.attackPointTicks + t.backswingTicks) / t.intervalTicks;
    expect(rooted(capped)).toBeLessThan(rooted(base) * 0.75);
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
    expect(windupScaleFor(BOLT, agile, 0)).toBeLessThan(1);
    // Quake launches nothing and is not a basic attack: its wind-up is its own
    // statement about itself.
    expect(windupScaleFor(QUAKE, agile, 0)).toBe(1);
  });

  it('lets Flow shorten the follow-through further, and nothing else', () => {
    const stats = statsFor({ agility: 30 }, { skills: [{ skillId: 'agi.flow', level: 3 }] });
    const still = backswingScaleFor({ stats, statuses: NO_STATUSES }, 0);
    const flowing = backswingScaleFor(
      { stats, statuses: applyStatus(NO_STATUSES, StatusId.Flow, 0, 100, { maxStacks: 3 }) },
      0,
    );
    expect(flowing).toBeLessThan(still);
    // Still not the interval.
    const timing = attackTimingFor(SLASH, { stats, statuses: NO_STATUSES }, 0);
    expect(timing.intervalTicks).toBe(attackTimingFor(SLASH, { stats: statsFor() }).intervalTicks);
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

  it('drops whatever the broken body was casting, and reports it', () => {
    const victim = { ...target(), poise: 1, cast: casting('ground.quake', CastPhase.Windup) };
    const result = applyPoiseDamage(victim, 9999, 0, true);
    expect(result.broke).toBe(true);
    expect(result.interrupted?.abilityId).toBe('ground.quake');
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

  it('protects a basic attack but not a spell, until the Juggernaut pair', () => {
    const strong = body(statsFor({ strength: 40 }), { cast: casting('ground.quake', CastPhase.Windup) });
    expect(poiseArmorOf(strong, false)).toBe(0);

    // STR/CON at the pair threshold, and *below half health*, which is the
    // condition the pair is about.
    const juggernaut = statsFor({ strength: 40, constitution: 25 });
    const healthy = body(juggernaut, { cast: casting('ground.quake', CastPhase.Windup) });
    expect(poiseArmorOf(healthy, false)).toBe(0);
    const hurt = { ...healthy, health: juggernaut.maxHealth * 0.4 };
    expect(poiseArmorOf(hurt, false)).toBeGreaterThan(0);
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
      skills: [
        { skillId: 'per.weakPointStudy', level: 3 },
        { skillId: 'per.exploit', level: 3 },
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
      const result = resolveBlow(BOLT, body(statsFor()), victim, i, currentRng);
      currentRng = result.rng;
      const hit = result.events.find((e) => e.kind === 'hit') as { damage: number } | undefined;
      if (hit) damages.push(hit.damage);
      victim = { ...result.target, health: enduring.maxHealth };
    }
    // The sixth arrow hurts less than the first. Crit rolls make individual
    // blows noisy, so the claim is about the trend across the run.
    expect(Math.min(...damages)).toBeLessThan(damages[0] ?? 0);
  });

  it('rolls crit before the weak point, always, so a replay is reproducible', () => {
    // Not a style rule. The Rng is threaded through the whole sim, and a body
    // that draws a different number of values changes every fight after it.
    const noWeakPoint = body({ ...statsFor(), traits: { ...NEUTRAL_TRAITS, weakPointChance: 0 } });
    const before = Rng.fromSeed(99);
    const [, expected] = before.nextInt(0, 9999);
    const result = resolveBlow(SLASH, noWeakPoint, body(statsFor(), { id: 2 }), 0, Rng.fromSeed(99));
    // One draw when the weak-point roll is skipped, and the state is exactly the
    // one a single crit roll leaves behind.
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

  it('sunders on a basic attack for a body with the pair, and not otherwise', () => {
    const impact = statsFor({ strength: 25, intelligence: 25 });
    expect(impact.traits.appliesSundered).toBe(1);
    const marked = resolveBlow(SLASH, body(impact), body(statsFor(), { id: 2 }), 0, rng);
    expect(statusOf(marked.target.statuses, StatusId.Sundered, 0)?.expiresAtTick).toBe(SUNDER_TICKS);

    const plain = resolveBlow(SLASH, body(statsFor()), body(statsFor(), { id: 2 }), 0, rng);
    expect(statusOf(plain.target.statuses, StatusId.Sundered, 0)).toBeNull();
  });
});

// ==========================================================================

describe('the resource economy', () => {
  it('is exactly the table for a fresh character', () => {
    expect(resourceCostFor(QUAKE, { stats: statsFor() }, 0)).toBe(QUAKE.cost);
  });

  it('falls with Wisdom, and never to zero', () => {
    const wise = resourceCostFor(QUAKE, { stats: statsFor({ wisdom: SCALING.attributeHardCap }) }, 0);
    expect(wise).toBeLessThan(QUAKE.cost);
    expect(wise).toBeGreaterThan(0);
  });

  it('leaves a free ability free, whatever the discounts', () => {
    // Every factor multiplies, so an ability with `cost: 0` can never refund.
    expect(resourceCostFor(SLASH, { stats: statsFor({ wisdom: SCALING.attributeHardCap }) }, 0)).toBe(0);
  });

  it('charges the shaping premium, and lets Efficient Construction pay it off', () => {
    const shaper = statsFor({ intelligence: 25 }, { skills: [{ skillId: 'int.shaping', level: 3 }] });
    const efficient = statsFor({ intelligence: 25 }, {
      skills: [
        { skillId: 'int.shaping', level: 3 },
        { skillId: 'int.efficientConstruction', level: 3 },
      ],
    });
    // Below the shaping milestone, so this one is paying no premium at all.
    const plain = statsFor({ intelligence: 19 });

    const shaped = resourceCostFor(QUAKE, { stats: shaper }, 0);
    const paidOff = resourceCostFor(QUAKE, { stats: efficient }, 0);
    const unshaped = resourceCostFor(QUAKE, { stats: plain }, 0);

    expect(unshaped).toBe(QUAKE.cost);
    expect(shaped).toBeGreaterThan(unshaped);
    expect(paidOff).toBeLessThan(shaped);
    // The relief can only ever cancel the premium -- it can never make an
    // unshaped cast cheaper, which is Wisdom's job and not Intelligence's. So
    // full relief lands *on* the list price, and never under it, while keeping
    // the geometry the premium was paying for.
    expect(paidOff).toBeCloseTo(QUAKE.cost, 9);
    expect(efficient.traits.spellRadiusPct).toBeGreaterThan(0);
  });

  it('lets Attuned and Flow stack a discount, bounded', () => {
    const stats = statsFor({ wisdom: 25, agility: 25 });
    const bare = resourceCostFor(QUAKE, { stats, statuses: NO_STATUSES }, 0);
    let held: Statuses = NO_STATUSES;
    for (let i = 0; i < 3; i++) held = applyStatus(held, StatusId.Attuned, 0, 100, { maxStacks: 3 });
    for (let i = 0; i < 3; i++) held = applyStatus(held, StatusId.Flow, 0, 100, { maxStacks: 3 });
    const discounted = resourceCostFor(QUAKE, { stats, statuses: held }, 0);
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

  it('is halved by the Battlemage pair', () => {
    const alone = statsFor({ intelligence: SCALING.attributeHardCap });
    const paired = statsFor({ intelligence: SCALING.attributeHardCap, constitution: 25 });
    expect(paired.traits.overflowHealthPerResource).toBeLessThan(
      alone.traits.overflowHealthPerResource,
    );
  });
});

describe('Second Wind', () => {
  // The one thing in this system that restores health without a heal. It is
  // driven from the timers pass rather than from a blow, so it is tested there.
  const conStats = (): EffectiveStats =>
    statsFor({ constitution: 25 }, { skills: [{ skillId: 'con.secondWind', level: 3 }] });

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

  it('re-arms only once the body has climbed back out', () => {
    // The guard that stops somebody parked at 29% health getting a heartbeat.
    const stats = conStats();
    const hurt = { ...body(stats), health: stats.maxHealth * 0.2 };
    const spent = advanceProgression(hurt, 1, false);
    expect(hasStatus(spent.statuses, StatusId.SecondWindSpent, 1)).toBe(true);

    const recovered = advanceProgression({ ...spent, health: stats.maxHealth }, 2, false);
    expect(hasStatus(recovered.statuses, StatusId.SecondWindSpent, 2)).toBe(false);
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
    expect(windupScaleFor(QUAKE, { stats, statuses: primed }, 0)).toBeLessThan(
      windupScaleFor(QUAKE, { stats, statuses: NO_STATUSES }, 0),
    );
    expect(windupScaleFor(SLASH, { stats, statuses: primed }, 0)).toBe(
      windupScaleFor(SLASH, { stats, statuses: NO_STATUSES }, 0),
    );
  });

  it('refunds part of the cooldown for the Archmage pair, and nobody else', () => {
    const primed = applyStatus(NO_STATUSES, StatusId.Prepared, 0, 9999);
    const mage = statsFor({ intelligence: 35 });
    expect(cooldownScaleFor(QUAKE, { stats: mage, statuses: primed }, 0)).toBe(
      cooldownScaleFor(QUAKE, { stats: mage, statuses: NO_STATUSES }, 0),
    );

    const archmage = statsFor({ intelligence: 35, wisdom: 25 });
    expect(archmage.traits.preparedMastery).toBe(1);
    expect(cooldownScaleFor(QUAKE, { stats: archmage, statuses: primed }, 0)).toBeLessThan(
      cooldownScaleFor(QUAKE, { stats: archmage, statuses: NO_STATUSES }, 0),
    );
  });
});

describe('spell geometry', () => {
  it('does nothing without the shaping milestone', () => {
    expect(statsFor({ intelligence: 19 }).traits.spellRadiusPct).toBe(0);
    expect(castRangeFor(QUAKE, { stats: statsFor({ intelligence: 19 }) })).toBe(QUAKE.range);
  });

  it('reaches further and lands wider once it is held', () => {
    const shaper = statsFor({ intelligence: SCALING.attributeHardCap });
    expect(shaper.traits.spellRadiusPct).toBeGreaterThan(0);
    expect(castRangeFor(QUAKE, { stats: shaper })).toBeGreaterThan(QUAKE.range);
  });

  it('never lengthens a basic attack, whatever the Intelligence', () => {
    // A weapon's reach is the weapon's. Shaping is for constructed things.
    const shaper = statsFor({ intelligence: SCALING.attributeHardCap });
    expect(castRangeFor(SLASH, { stats: shaper })).toBe(SLASH.range);
  });
});
