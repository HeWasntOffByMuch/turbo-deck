/**
 * Wisdom is sustain (spec 275).
 *
 * The tests that decide whether the redesigned track did what it said. The
 * review this spec follows found the whole branch *wired* -- every tier
 * purchasable, every trait read by the sim, `audit:progression` clean -- and
 * about a quarter of it load-bearing, so "the number moved" is exactly the
 * assertion that was already true and told nobody anything.
 *
 * So every block here asserts a **derived gameplay result**: a resolved
 * cooldown in ticks, a resolved cost in resource, the number of hits Adaptation
 * takes to reach its ceiling and where that ceiling is. Where a tier is claimed
 * to deepen something, the test walks the tiers and requires the player-facing
 * quantity to move -- not the trait behind it.
 */

import { describe, expect, it } from 'vitest';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
import { ALL_MILESTONES } from '../data/milestones.js';
import { SCALING } from '../data/scaling.js';
import { specializationById } from '../data/specializations.js';
import { RESTORATION } from '../data/restoration.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import {
  advanceCast,
  attackTimingFor,
  cancelCast,
  cooldownScaleFor,
  masteryReliefFor,
  resourceCostFor,
  startCast,
} from './abilities.js';
import { applyHealing } from './healing.js';
import { adaptationAgainst } from './statuses.js';
import {
  applyStatus,
  masteryKey,
  NO_STATUSES,
  stacksOf,
  StatusId,
  type Statuses,
} from './statuses.js';
import { ActivityValue, AggroValue, CastEndReason, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';
import { Rng } from '../../shared/prng.js';

// --------------------------------------------------------------------------

function record(
  baseStats: Partial<BaseStats> = {},
  specializations: readonly SpecializationAllocation[] = [],
): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [...specializations],
    // The three sigils the Mastery tests cast. `startCast` refuses a
    // `skill: true` ability the caster is not carrying (spec 188), so a bar is
    // part of the fixture rather than something to work around.
    equipment: {
      ...EMPTY_EQUIPMENT,
      skill1: 'sigil.whirlwind',
      skill2: 'sigil.rimeTouch',
      skill3: 'sigil.witchlight',
    },
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 1000,
    coins: 0,
  };
}

function statsFor(
  baseStats: Partial<BaseStats> = {},
  specializations: readonly SpecializationAllocation[] = [],
): EffectiveStats {
  return computeEffectiveStats(record(baseStats, specializations));
}

function body(stats: EffectiveStats, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id: 1,
    kind: EntityKindValue.Player,
    typeId: 'p',
    ownerPlayerId: null,
    spawnTick: 0,
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

const tiers = (id: string, tier: number): SpecializationAllocation[] => [
  { specializationId: id, tier },
];

/** The resolved cooldown of `ability`, in ticks, for this body right now. */
function cooldownTicks(ability: AbilityDefinition, entity: ServerEntity, tick = 0): number {
  return attackTimingFor(ability, entity, tick).intervalTicks;
}

/**
 * Drives one whole cast to its attack point through the real `advanceCast`.
 *
 * The commit block is where Mastery is earned, and it is reached only by a cast
 * that was not withdrawn from -- so the accrual tests go through the function
 * that owns the rule rather than applying the status by hand.
 */
function castThrough(
  entity: ServerEntity,
  abilityId: string,
  startTick = 0,
): { entity: ServerEntity; tick: number } {
  const started = startCast(entity, { abilityId, targetX: 0, targetY: 0 }, startTick);
  if (!started.ok) throw new Error(`startCast refused: ${started.reason}`);
  let current = started.entity;
  let tick = startTick;
  // Bounded: the longest wind-up in the table is well inside this, and a cast
  // that never commits is a failure worth reporting as one rather than a hang.
  for (let step = 0; step < 600; step += 1) {
    const result = advanceCast(current, [current], tick, Rng.fromSeed(1));
    const updated = result.updated.get(current.id);
    if (updated) current = updated;
    if (current.cast?.committed) return { entity: current, tick };
    if (current.cast === null) return { entity: current, tick };
    tick += 1;
  }
  throw new Error('cast never committed');
}

const WHIRLWIND = 'skill.whirlwind';
const RIME = 'skill.rimeTouch';
/** A self-targeted ability with no damage in it at all: the support case. */
const CONJURE = 'skill.conjureLight';

// --------------------------------------------------------------------------

describe('what the Wisdom attribute grants on its own (spec 275)', () => {
  it('leaves the resource pool to Intelligence', () => {
    // The ownership rule: INT owns the magazine, WIS owns making it last. Six
    // automatic scales all pointed at the resource problem and this is the one
    // another attribute already had the primitive for.
    const base = statsFor().maxResource;
    for (const wisdom of [10, 20, 35, 50, 60]) {
      expect(statsFor({ wisdom }).maxResource).toBe(base);
    }
    expect(statsFor({ intelligence: 60 }).maxResource).toBeGreaterThan(base);
  });

  it('gives a character who has spent nothing on Wisdom nothing from Wisdom', () => {
    // Three of the six scales measured from the raw attribute until this spec,
    // so a fresh character silently carried five points of progression credit.
    // Asserted on the *derived* values rather than on the coefficients.
    const fresh = statsFor().traits;
    expect(fresh.resourceCostScale).toBeCloseTo(1, 6);
    expect(fresh.cooldownScale).toBeCloseTo(1, 6);
    expect(fresh.restoreSalvagePct).toBeCloseTo(0, 6);
    expect(statsFor().resourceRegen).toBeCloseTo(statsFor({ wisdom: 5 }).resourceRegen, 9);

    // Healing is the one that still carries a term at the baseline, and it is
    // Constitution's rather than Wisdom's -- left alone deliberately, since
    // moving another attribute's baseline inside this spec would hide a retune.
    // What must hold is that *Wisdom* contributes nothing at the start.
    const wisdomless = statsFor({ constitution: 5, wisdom: 5 }).traits.healingScale;
    expect(statsFor({ constitution: 5, wisdom: 5 }).traits.healingScale).toBeCloseTo(wisdomless, 6);
    expect(statsFor({ constitution: 5, wisdom: 6 }).traits.healingScale).toBeGreaterThan(wisdomless);
  });

  it('moves every scale in the direction it is meant to, across the range', () => {
    let cost = Number.POSITIVE_INFINITY;
    let cooldown = Number.POSITIVE_INFINITY;
    let healing = 0;
    let regen = 0;
    for (const wisdom of [5, 10, 20, 30, 40, 50, 60]) {
      const stats = statsFor({ wisdom });
      expect(stats.traits.resourceCostScale).toBeLessThanOrEqual(cost);
      expect(stats.traits.cooldownScale).toBeLessThanOrEqual(cooldown);
      expect(stats.traits.healingScale).toBeGreaterThanOrEqual(healing);
      expect(stats.resourceRegen).toBeGreaterThanOrEqual(regen);
      cost = stats.traits.resourceCostScale;
      cooldown = stats.traits.cooldownScale;
      healing = stats.traits.healingScale;
      regen = stats.resourceRegen;
    }
  });

  it('has retired the constants the old design needed', () => {
    expect('resourcePer' in SCALING.wisdom).toBe(false);
    expect('masteryRelief' in SCALING.wisdom).toBe(false);
  });
});

describe('Composure: broad active-ability cooldown efficiency (spec 275)', () => {
  const composure = specializationById('wis.composure');
  if (!composure) throw new Error('no wis.composure');
  const ability = abilityById(WHIRLWIND);
  if (!ability) throw new Error('no whirlwind');

  it('shortens a real ability cooldown at every tier', () => {
    // Measured in resolved ticks, not in the trait: the review's finding was a
    // tier that moved an internal number and changed nothing a player sees.
    let previous = cooldownTicks(ability, body(statsFor({ wisdom: composure.requires })));
    expect(previous).toBeGreaterThan(0);
    for (let tier = 1; tier <= composure.maxTier; tier += 1) {
      const stats = statsFor({ wisdom: composure.requires }, tiers(composure.id, tier));
      const ticks = cooldownTicks(ability, body(stats));
      expect(ticks).toBeLessThan(previous);
      previous = ticks;
    }
  });

  it('never touches a basic attack, at any investment', () => {
    // The fence spec 147 put around Agility, from the other side: the fast stat
    // must not become the damage stat, and the sustain stat must not become
    // attack speed. Structural rather than a guard -- `cooldownScaleFor` is
    // reached from the non-basic branch alone -- so this asserts the structure.
    const basic = abilityById('melee.slash');
    if (!basic) throw new Error('no melee.slash');
    const bare = body(statsFor());
    const invested = body(
      statsFor({ wisdom: 60 }, [
        ...tiers(composure.id, composure.maxTier),
        { specializationId: 'wis.mastery', tier: 3 },
      ]),
    );
    const before = attackTimingFor(basic, bare, 0);
    const after = attackTimingFor(basic, invested, 0);
    expect(after.intervalTicks).toBe(before.intervalTicks);
    expect(after.attackPointTicks).toBe(before.attackPointTicks);
    expect(after.backswingTicks).toBe(before.backswingTicks);
  });

  it('leaves legal maximum investment clear of both cooldown floors', () => {
    // "Purchased tiers do not disappear into the floor" is the shape the spec
    // asks for, so the floors are asserted un-met rather than merely respected.
    const stats = statsFor({ wisdom: 60 }, [
      ...tiers(composure.id, composure.maxTier),
      { specializationId: 'wis.mastery', tier: 3 },
    ]);
    expect(stats.traits.cooldownScale).toBeGreaterThan(0.25);
    const full = body(stats, {
      statuses: applyStatus(NO_STATUSES, masteryKey(WHIRLWIND), 0, 1200, { maxStacks: 5 }),
    });
    // Five stacks, the ceiling, on top of everything else.
    let statuses = full.statuses;
    for (let i = 0; i < 5; i += 1) {
      statuses = applyStatus(statuses, masteryKey(WHIRLWIND), 0, 1200, { maxStacks: 5 });
    }
    expect(cooldownScaleFor(ability, body(stats, { statuses }), 0)).toBeGreaterThan(0.2);
  });
});

describe('Mastery: repeated use of your own ability (spec 275)', () => {
  const mastery = specializationById('wis.mastery');
  if (!mastery) throw new Error('no wis.mastery');
  const invested = () => statsFor({ wisdom: mastery.requires }, tiers(mastery.id, mastery.maxTier));

  it('is earned at the attack point, by the ability that was cast', () => {
    const after = castThrough(body(invested()), WHIRLWIND).entity;
    expect(stacksOf(after.statuses, masteryKey(WHIRLWIND), 0)).toBe(1);
    expect(stacksOf(after.statuses, masteryKey(RIME), 0)).toBe(0);
  });

  it('is earned by a support ability that deals no damage at all', () => {
    // The rule the identity depends on: a Wisdom support build must be able to
    // master its support toolkit. Conjure Light is self-targeted and carries no
    // damage, so an implementation hung off a damage event would score zero.
    const after = castThrough(body(invested()), CONJURE).entity;
    expect(stacksOf(after.statuses, masteryKey(CONJURE), 0)).toBe(1);
  });

  it('teaches nothing to a cast that was withdrawn from', () => {
    // Everything before the attack point is refundable and everything from it is
    // spent, which is exactly where "successful use" has to be measured.
    const started = startCast(
      body(invested()),
      { abilityId: WHIRLWIND, targetX: 0, targetY: 0 },
      0,
    );
    if (!started.ok) throw new Error(started.reason);
    const withdrawn = cancelCast(started.entity, 1, CastEndReason.Cancelled);
    expect(stacksOf(withdrawn.entity.statuses, masteryKey(WHIRLWIND), 1)).toBe(0);
  });

  it('shortens that ability and only that ability', () => {
    const stats = invested();
    const whirlwind = abilityById(WHIRLWIND);
    const rime = abilityById(RIME);
    if (!whirlwind || !rime) throw new Error('missing ability');

    const bare = body(stats);
    const mastered = body(stats, {
      statuses: applyStatus(NO_STATUSES, masteryKey(WHIRLWIND), 0, 1200, { maxStacks: 5 }),
    });
    expect(cooldownTicks(whirlwind, mastered)).toBeLessThan(cooldownTicks(whirlwind, bare));
    expect(cooldownTicks(rime, mastered)).toBe(cooldownTicks(rime, bare));
  });

  it('deepens with every tier, and with every stack', () => {
    const whirlwind = abilityById(WHIRLWIND);
    if (!whirlwind) throw new Error('no whirlwind');
    const withStacks = (stats: EffectiveStats, count: number): ServerEntity => {
      let statuses: Statuses = NO_STATUSES;
      for (let i = 0; i < count; i += 1) {
        statuses = applyStatus(statuses, masteryKey(WHIRLWIND), 0, 1200, { maxStacks: 99 });
      }
      return body(stats, { statuses });
    };

    let perTier = 0;
    for (let tier = 1; tier <= mastery.maxTier; tier += 1) {
      const stats = statsFor({ wisdom: mastery.requires }, tiers(mastery.id, tier));
      const relief = masteryReliefFor(whirlwind, withStacks(stats, 5), 0);
      expect(relief).toBeGreaterThan(perTier);
      perTier = relief;
    }

    const stats = invested();
    let previous = cooldownTicks(whirlwind, withStacks(stats, 0));
    for (let stack = 1; stack <= stats.traits.masteryMaxStacks; stack += 1) {
      const ticks = cooldownTicks(whirlwind, withStacks(stats, stack));
      expect(ticks).toBeLessThan(previous);
      previous = ticks;
    }
  });

  it('stops at its stack ceiling and expires', () => {
    const stats = invested();
    const whirlwind = abilityById(WHIRLWIND);
    if (!whirlwind) throw new Error('no whirlwind');
    let statuses: Statuses = NO_STATUSES;
    for (let i = 0; i < stats.traits.masteryMaxStacks + 5; i += 1) {
      statuses = applyStatus(statuses, masteryKey(WHIRLWIND), 0, stats.traits.masteryTicks, {
        maxStacks: stats.traits.masteryMaxStacks,
      });
    }
    expect(stacksOf(statuses, masteryKey(WHIRLWIND), 0)).toBe(stats.traits.masteryMaxStacks);

    const held = body(stats, { statuses });
    const expired = stats.traits.masteryTicks;
    expect(masteryReliefFor(whirlwind, held, expired - 1)).toBeGreaterThan(0);
    expect(masteryReliefFor(whirlwind, held, expired)).toBe(0);
  });

  it('is not granted, and does nothing, without the specialization', () => {
    const none = body(statsFor({ wisdom: 60 }));
    expect(none.stats.traits.masteryCooldownPct).toBe(0);
    const after = castThrough(none, WHIRLWIND).entity;
    expect(stacksOf(after.statuses, masteryKey(WHIRLWIND), 0)).toBe(0);
  });

  it('is never built by a basic attack', () => {
    const after = castThrough(body(invested()), 'melee.slash').entity;
    expect(stacksOf(after.statuses, masteryKey('melee.slash'), 0)).toBe(0);
  });
});

describe('Adaptation deepens, rather than reaching the same ceiling sooner (spec 275)', () => {
  const adaptation = specializationById('wis.adaptation');
  if (!adaptation) throw new Error('no wis.adaptation');

  const hitsToCap = (stats: EffectiveStats): number =>
    Math.ceil(stats.traits.adaptationCap / stats.traits.adaptationPerStack);

  it('raises the ceiling at every tier', () => {
    // The finding this replaces: every path converged on 0.3, so a tier bought
    // hits-to-cap and nothing else -- and at Wisdom 35 tier 2 did not move even
    // that. The ceiling is the player-facing quantity, so it is what is walked.
    let cap = 0;
    for (let tier = 1; tier <= adaptation.maxTier; tier += 1) {
      const stats = statsFor({ wisdom: adaptation.requires }, tiers(adaptation.id, tier));
      expect(stats.traits.adaptationCap).toBeGreaterThan(cap);
      cap = stats.traits.adaptationCap;
    }
  });

  it('learns faster as well, and reaches 50% fully specialized', () => {
    const one = statsFor({ wisdom: 50 }, tiers(adaptation.id, 1));
    const three = statsFor({ wisdom: 50 }, tiers(adaptation.id, adaptation.maxTier));
    expect(hitsToCap(three)).toBeLessThan(hitsToCap(one));
    expect(three.traits.adaptationCap).toBeCloseTo(0.5, 6);
    // Inside the guard, which stays a guard rather than a target.
    expect(three.traits.adaptationCap).toBeLessThanOrEqual(0.6);
  });

  it('keys on the ability that hit, so a second attack pattern is learned separately', () => {
    const stats = statsFor({ wisdom: 50 }, tiers(adaptation.id, adaptation.maxTier));
    const { adaptationPerStack: per, adaptationCap: cap, adaptationTicks: ticks } = stats.traits;
    let statuses: Statuses = NO_STATUSES;
    for (let i = 0; i < 3; i += 1) {
      statuses = applyStatus(statuses, `adapt:${WHIRLWIND}`, 0, ticks, { maxStacks: 99 });
    }
    expect(adaptationAgainst(statuses, WHIRLWIND, 0, per, cap)).toBeGreaterThan(0);
    expect(adaptationAgainst(statuses, RIME, 0, per, cap)).toBe(0);
  });

  it('never exceeds its cap, however many times the same thing lands', () => {
    const stats = statsFor({ wisdom: 50 }, tiers(adaptation.id, adaptation.maxTier));
    const { adaptationPerStack: per, adaptationCap: cap, adaptationTicks: ticks } = stats.traits;
    let statuses: Statuses = NO_STATUSES;
    for (let i = 0; i < 40; i += 1) {
      statuses = applyStatus(statuses, `adapt:${WHIRLWIND}`, 0, ticks, { maxStacks: 99 });
    }
    expect(adaptationAgainst(statuses, WHIRLWIND, 0, per, cap)).toBeCloseTo(cap, 6);
  });

  it('gives a body with no Adaptation no damage reduction at all', () => {
    // The mechanic must stay attack-pattern-specific: no generic post-hit DR is
    // allowed to appear as a side effect of deepening it.
    // Below the milestone that introduces it: at Wisdom 35 the mechanic is
    // granted automatically, so "no Adaptation" means a body that has not
    // reached it rather than one that merely has not specialized.
    const stats = statsFor({ wisdom: 20 });
    expect(stats.traits.adaptationPerStack).toBe(0);
    expect(stats.traits.adaptationCap).toBe(0);
    let statuses: Statuses = NO_STATUSES;
    statuses = applyStatus(statuses, `adapt:${WHIRLWIND}`, 0, 600, { maxStacks: 99 });
    expect(
      adaptationAgainst(statuses, WHIRLWIND, 0, stats.traits.adaptationPerStack, stats.traits.adaptationCap),
    ).toBe(0);
  });
});

describe('Conservation owns Attuned, and the milestone above it says so (spec 275)', () => {
  const conservation = specializationById('wis.conservation');
  if (!conservation) throw new Error('no wis.conservation');

  it('is live on its own first tier, below the milestone', () => {
    // The reason it moved to the first threshold: the mechanic used to be
    // introduced only by the milestone, so a specialization sitting under one
    // would have been three tiers of a number nothing could read.
    const stats = statsFor({ wisdom: conservation.requires }, tiers(conservation.id, 1));
    expect(stats.traits.attunedCostPct).toBeGreaterThan(0);
    expect(stats.traits.attunedTicks).toBeGreaterThan(0);
    expect(stats.traits.attunedMaxStacks).toBeGreaterThan(0);
  });

  it('discounts the next cast, and every tier discounts it further', () => {
    const ability = abilityById(WHIRLWIND);
    if (!ability) throw new Error('no whirlwind');
    const costWith = (tier: number): number => {
      const stats = statsFor({ wisdom: conservation.requires }, tiers(conservation.id, tier));
      const statuses = applyStatus(NO_STATUSES, StatusId.Attuned, 0, stats.traits.attunedTicks, {
        maxStacks: stats.traits.attunedMaxStacks,
      });
      return resourceCostFor(ability, body(stats, { statuses }), 0);
    };
    let previous = costWith(0);
    for (let tier = 1; tier <= conservation.maxTier; tier += 1) {
      const cost = costWith(tier);
      expect(cost).toBeLessThan(previous);
      previous = cost;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('caps its stacks and never makes an ability free', () => {
    const ability = abilityById(WHIRLWIND);
    if (!ability) throw new Error('no whirlwind');
    const stats = statsFor({ wisdom: 60 }, tiers(conservation.id, conservation.maxTier));
    let statuses: Statuses = NO_STATUSES;
    for (let i = 0; i < 20; i += 1) {
      statuses = applyStatus(statuses, StatusId.Attuned, 0, stats.traits.attunedTicks, {
        maxStacks: stats.traits.attunedMaxStacks,
      });
    }
    expect(stacksOf(statuses, StatusId.Attuned, 0)).toBe(stats.traits.attunedMaxStacks);
    expect(resourceCostFor(ability, body(stats, { statuses }), 0)).toBeGreaterThan(0);
  });

  it('gives every milestone a `deepens` that shares a trait family with it', () => {
    // The WIS 20 milestone granted the Attuned family while naming a
    // specialization that granted `costReduction`.
    //
    // Scoped to Wisdom, and that is a finding rather than caution: run over all
    // eighteen this fails on `agi.recovery`, which deepens `agi.quickRecovery`
    // and shares no trait with it either. That is Agility's to fix -- spec 275
    // is explicitly not a redesign of another track -- so it is reported rather
    // than repaired, and this assertion is held to the attribute this spec owns
    // instead of being loosened until it passes everywhere.
    for (const milestone of ALL_MILESTONES) {
      if (milestone.attribute !== 'wisdom') continue;
      if (!milestone.deepens) continue;
      const skill = specializationById(milestone.deepens);
      expect(skill, `${milestone.id} deepens a specialization that exists`).toBeTruthy();
      if (!skill) continue;
      const granted = Object.keys(milestone.grants.traits ?? {});
      const deepened = Object.keys(skill.perTier.traits ?? {});
      expect(
        granted.some((key) => deepened.includes(key)),
        `${milestone.id} shares a trait with ${skill.id}`,
      ).toBe(true);
      // And it deepens something the track has already unlocked.
      expect(skill.requires).toBeLessThanOrEqual(milestone.threshold);
    }
  });
});

describe('Conversion: waste nothing (spec 275)', () => {
  const conversion = specializationById('wis.conversion');
  if (!conversion) throw new Error('no wis.conversion');

  it('turns healing past full into resource, bounded by the cap', () => {
    const stats = statsFor({ wisdom: conversion.requires }, tiers(conversion.id, 1));
    expect(stats.traits.conversionCap).toBeGreaterThan(0);
    const full = body(stats, { health: stats.maxHealth, resource: 0 });
    const healed = applyHealing(full, 1000, 0);
    expect(healed.entity.resource).toBeGreaterThan(0);
    expect(healed.entity.resource).toBeLessThanOrEqual(stats.traits.conversionCap);
  });

  it('sums the specialization and the milestone rather than replacing one', () => {
    const withSkill = statsFor({ wisdom: conversion.requires }, tiers(conversion.id, 1));
    const withBoth = statsFor({ wisdom: 50 }, tiers(conversion.id, 1));
    const milestoneOnly = statsFor({ wisdom: 50 });
    expect(withBoth.traits.conversionCap).toBeCloseTo(
      withSkill.traits.conversionCap + milestoneOnly.traits.conversionCap,
      6,
    );
  });

  it('deepens salvage past what the attribute alone reaches', () => {
    // The attribute gives the foundation and the specialization is the extreme
    // version: at the old 0.6 automatic ceiling the curve was met at Wisdom 35
    // and the next 25 points bought nothing.
    const attributeOnly = statsFor({ wisdom: 60 }).traits.restoreSalvagePct;
    expect(attributeOnly).toBeCloseTo(RESTORATION.stats.wisdomSalvageCap, 6);
    const specialized = statsFor({ wisdom: 60 }, tiers(conversion.id, 1)).traits.restoreSalvagePct;
    expect(specialized).toBeGreaterThan(attributeOnly);
  });
});

describe('Measured Recovery amplifies what the healing pipeline delivers (spec 275)', () => {
  const recovery = specializationById('wis.measuredRecovery');
  if (!recovery) throw new Error('no wis.measuredRecovery');

  it("reaches Perception's weak-point kill heal, which used to bypass it", () => {
    // One of the two paths for which "every restorative thing works better on
    // you" was false. Asserted as a *ratio* against a Wisdom-less body, so it
    // fails if the multiplication is ever dropped again rather than only if the
    // number changes.
    // The heal comes from Perception's own milestone at 50, not from the raw
    // attribute -- so both bodies have to have reached it for the comparison to
    // be about Wisdom.
    const plain = statsFor({ perception: 50 });
    const wise = statsFor({ perception: 50, wisdom: 60 }, tiers(recovery.id, recovery.maxTier));
    expect(plain.traits.weakPointKillHeal).toBeGreaterThan(0);
    expect(wise.traits.weakPointKillHeal).toBeCloseTo(plain.traits.weakPointKillHeal, 6);
    expect(wise.traits.healingScale).toBeGreaterThan(plain.traits.healingScale);

    const mend = (stats: EffectiveStats): number =>
      stats.maxHealth * stats.traits.weakPointKillHeal * stats.traits.healingScale;
    expect(mend(wise) / wise.maxHealth).toBeGreaterThan(mend(plain) / plain.maxHealth);
  });

  it('heals more, measured through `applyHealing` rather than off the trait', () => {
    let healed = 0;
    for (let tier = 0; tier <= recovery.maxTier; tier += 1) {
      const stats = statsFor(
        { wisdom: recovery.requires },
        tier > 0 ? tiers(recovery.id, tier) : [],
      );
      const hurt = body(stats, { health: 1 });
      const result = applyHealing(hurt, 10, 0);
      expect(result.healed).toBeGreaterThan(healed);
      healed = result.healed;
    }
  });
});
