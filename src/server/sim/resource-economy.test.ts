/**
 * The global active-resource economy (spec 276).
 *
 * The rules here are all about the *shape of a curve against the content
 * table*, which is why almost nothing in this file asserts a literal. The
 * economy's whole failure mode is a supply that quietly passes a demand nobody
 * measured -- so the demand is measured, here, from `data/abilities.ts` through
 * the real `resourceCostFor` and `attackTimingFor`, and the assertions are
 * comparisons against it. A cheaper ability, a shorter cooldown or a new sigil
 * therefore moves what these tests require, which is the point: the claim is
 * "regeneration never reaches the most the game can spend", and a claim about
 * the game has to be re-derived from the game.
 *
 * `scripts/probe-resource.ts` is the instrument the numbers came from and is
 * where the fights live. This file is the fence around them.
 */

import { describe, expect, it } from 'vitest';

import { SERVER_TICK_RATE } from '../config.js';
import { ALL_ABILITIES, abilityById, type AbilityDefinition } from '../data/abilities.js';
import { ITEMS } from '../data/items.js';
import { ALL_MILESTONES } from '../data/milestones.js';
import { SCALING } from '../data/scaling.js';
import { SPECIALIZATIONS } from '../data/specializations.js';
import {
  BASE_RESOURCE,
  RESOURCE_PER_INTELLIGENCE,
  RESOURCE_REGEN_PER_SECOND,
  computeEffectiveStats,
} from '../player/stats.js';
import { startingBaseStats } from '../player/attributes.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { attackTimingFor, overflowCostFor, resourceCostFor } from './abilities.js';
import { regenerated } from './resource.js';
import { EntityKindValue, type ServerEntity } from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';
import { NO_STATUSES, StatusId, applyStatus, type Statuses } from './statuses.js';

const START = SCALING.startingAttribute;
const CAP = SCALING.attributeHardCap;

function record(
  attributes: Partial<BaseStats>,
  specializations: readonly SpecializationAllocation[] = [],
): PersistedPlayer {
  return {
    id: 'econ',
    displayName: 'econ',
    baseStats: { ...startingBaseStats(), ...attributes },
    specializations: [...specializations],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
    coins: 0,
  };
}

const statsOf = (
  attributes: Partial<BaseStats>,
  specializations: readonly SpecializationAllocation[] = [],
): EffectiveStats => computeEffectiveStats(record(attributes, specializations));

const body = (stats: EffectiveStats, statuses: Statuses = NO_STATUSES) => ({ stats, statuses });
const perSecond = (stats: EffectiveStats): number => stats.resourceRegen * SERVER_TICK_RATE;

/**
 * How long one cast of `ability` occupies, in seconds.
 *
 * Wind-up **plus** cooldown, because `advanceCast` stamps `nextReadyTick` at the
 * release: the clock does not start until the blow lands. Reading the interval
 * alone overstates every row by its own wind-up, which is headroom this file
 * must not hand out.
 */
function cycleSeconds(ability: AbilityDefinition, stats: EffectiveStats, statuses: Statuses): number {
  const timing = attackTimingFor(ability, body(stats, statuses), 0);
  return (timing.attackPointTicks + timing.intervalTicks) / SERVER_TICK_RATE;
}

/** Every ability a player could actually put in one of the four skill slots. */
const EQUIPPABLE: readonly AbilityDefinition[] = ALL_ABILITIES.filter(
  (ability) =>
    ability.cost > 0 &&
    ability.skill === true &&
    [...ITEMS.values()].some((item) => item.slot === 'skill' && item.activeSkillId === ability.id),
);

/**
 * The most this body could spend per second, over the four greediest rows it can
 * legally carry.
 *
 * **Derived from the content table, never typed in.** It is the ceiling because
 * a bar holds four skills and a body is rooted through its own casts, so no
 * loadout can demand more than the four highest cost-per-cycle rows on cooldown.
 */
function maximumDrain(stats: EffectiveStats, statuses: Statuses = NO_STATUSES): number {
  return EQUIPPABLE.map((ability) => resourceCostFor(ability, body(stats, statuses), 0) / cycleSeconds(ability, stats, statuses))
    .sort((a, b) => b - a)
    .slice(0, 4)
    .reduce((sum, rate) => sum + rate, 0);
}

const attunedTo = (stats: EffectiveStats, stacks: number): Statuses => {
  let statuses: Statuses = NO_STATUSES;
  for (let i = 0; i < stacks; i++) {
    statuses = applyStatus(statuses, StatusId.Attuned, 0, 10_000, {
      maxStacks: stats.traits.attunedMaxStacks,
    });
  }
  return statuses;
};

describe('the baseline economy', () => {
  it('gives a character who has spent nothing exactly the base regeneration', () => {
    expect(perSecond(statsOf({}))).toBeCloseTo(RESOURCE_REGEN_PER_SECOND, 6);
  });

  it('starts every character with a full pool', () => {
    const stats = statsOf({});
    expect(stats.maxResource).toBe(BASE_RESOURCE + RESOURCE_PER_INTELLIGENCE * START);
    expect(stats.maxResource).toBeGreaterThan(0);
  });

  it('never regenerates past the ceiling', () => {
    const stats = statsOf({ intelligence: 40 });
    expect(regenerated(stats.maxResource - 0.001, stats.resourceRegen, stats.maxResource, 1)).toBe(
      stats.maxResource,
    );
    expect(regenerated(0, stats.resourceRegen, stats.maxResource, 100_000)).toBe(stats.maxResource);
  });

  it('leaves a basic attack free at exactly zero resource', () => {
    const stats = statsOf({});
    const basic = abilityById(stats.basicAttackId);
    expect(basic).not.toBeNull();
    expect(resourceCostFor(basic as AbilityDefinition, body(stats), 0)).toBe(0);
  });

  // The floor is deliberately not zero: a body that had spent its pool would
  // otherwise be unable to cast until it died, which is a wall rather than a
  // pressure, and would make the flask the only answer.
  it('recovers the cheapest equippable skill from empty in a handful of seconds', () => {
    const stats = statsOf({});
    const cheapest = Math.min(
      ...EQUIPPABLE.map((ability) => resourceCostFor(ability, body(stats), 0)),
    );
    expect(cheapest / perSecond(stats)).toBeLessThan(5);
  });
});

describe('Intelligence owns the magazine', () => {
  it('raises the pool and nothing else about the economy', () => {
    const low = statsOf({ intelligence: START });
    const high = statsOf({ intelligence: CAP });
    expect(high.maxResource).toBeGreaterThan(low.maxResource * 2);
    // The reload is not Intelligence's to buy. This is the ownership rule as a
    // test rather than as a sentence in a docstring.
    expect(high.resourceRegen).toBe(low.resourceRegen);
    expect(high.traits.resourceCostScale).toBe(low.traits.resourceCostScale);
  });

  it('buys strictly more casts before the pool is empty', () => {
    const dart = abilityById('skill.poisonDart');
    expect(dart).not.toBeNull();
    const castsIn = (intelligence: number): number => {
      const stats = statsOf({ intelligence });
      return Math.floor(stats.maxResource / resourceCostFor(dart as AbilityDefinition, body(stats), 0));
    };
    expect(castsIn(CAP)).toBeGreaterThan(castsIn(25));
    expect(castsIn(25)).toBeGreaterThan(castsIn(START));
  });

  it('takes strictly longer to refill from empty, and no longer to afford one cast', () => {
    // **Unshaped on purpose.** A shaped row (`radius`/`projectile`/`area`)
    // carries Intelligence's own shaping premium, so measuring the first cast
    // with a projectile would report a cost the attribute deliberately buys as
    // if it were a penalty for having a large pool.
    const plain = abilityById('skill.guardBreak') as AbilityDefinition;
    expect(plain.radius).toBeUndefined();
    expect(plain.projectile).toBeUndefined();
    expect(plain.area).toBeUndefined();
    const low = statsOf({ intelligence: START });
    const high = statsOf({ intelligence: CAP });
    expect(high.maxResource / perSecond(high)).toBeGreaterThan(low.maxResource / perSecond(low));
    // A deeper magazine must never be slower to the *first* cast: that would be
    // a punishment for capacity rather than a different reload shape.
    expect(resourceCostFor(plain, body(high), 0) / perSecond(high)).toBeCloseTo(
      resourceCostFor(plain, body(low), 0) / perSecond(low),
      6,
    );
  });

  it('makes a shaped ability cost more, and that premium is the attribute\'s own', () => {
    const shaped = abilityById('skill.emberToss') as AbilityDefinition;
    const low = statsOf({ intelligence: START });
    const high = statsOf({ intelligence: CAP });
    expect(resourceCostFor(shaped, body(high), 0)).toBeGreaterThan(
      resourceCostFor(shaped, body(low), 0),
    );
  });

  it('does not move the pool with Wisdom at any value', () => {
    const base = statsOf({}).maxResource;
    for (let wisdom = START; wisdom <= CAP; wisdom += 5) {
      expect(statsOf({ wisdom }).maxResource).toBe(base);
    }
  });
});

describe('Wisdom owns the reload', () => {
  it('is exactly neutral at the starting attribute', () => {
    expect(perSecond(statsOf({ wisdom: START }))).toBeCloseTo(RESOURCE_REGEN_PER_SECOND, 6);
    expect(statsOf({ wisdom: START }).traits.resourceCostScale).toBe(1);
  });

  it('rises monotonically across the whole range', () => {
    let previous = -Infinity;
    for (let wisdom = START; wisdom <= CAP; wisdom++) {
      const rate = perSecond(statsOf({ wisdom }));
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
  });

  it('is soft-capped: a point past the knee is worth the falloff of one before it', () => {
    const knee = SCALING.wisdom.regenKnee;
    const at = (wisdom: number): number => perSecond(statsOf({ wisdom }));
    const below = at(START + knee - 1) - at(START + knee - 2);
    const above = at(START + knee + 2) - at(START + knee + 1);
    expect(above / below).toBeCloseTo(SCALING.wisdom.regenFalloff, 6);
  });

  /**
   * The rule the whole spec turns on.
   *
   * Measured on both sides rather than asserted as a number: the greediest legal
   * bar is re-derived from `data/abilities.ts` at each Wisdom value, so it
   * accounts for Wisdom making its own bar cheaper *and* returning it sooner.
   * A content change that made the game cheaper to cast would fail this test,
   * which is exactly when somebody should look.
   */
  it('never reaches the most the game can spend, at any legal value', () => {
    for (let wisdom = START; wisdom <= CAP; wisdom++) {
      const stats = statsOf({ wisdom });
      expect(perSecond(stats)).toBeLessThan(maximumDrain(stats));
    }
  });

  it('closes the gap the whole way: supply over demand rises with every point', () => {
    const ratio = (wisdom: number): number => {
      const stats = statsOf({ wisdom });
      return perSecond(stats) / maximumDrain(stats);
    };
    let previous = -Infinity;
    for (let wisdom = START; wisdom <= CAP; wisdom++) {
      const next = ratio(wisdom);
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
    // And there is real distance between the ends, or the curve is a formality.
    expect(ratio(CAP)).toBeGreaterThan(ratio(START) * 2.25);
  });

  it('sustains an ordinary rotation at moderate investment where the baseline cannot', () => {
    // The four cheapest equippable rows: the mixed bar a player who is not
    // trying to break the economy would carry.
    const ordinary = (stats: EffectiveStats): number =>
      EQUIPPABLE.map((ability) => resourceCostFor(ability, body(stats), 0) / cycleSeconds(ability, stats, NO_STATUSES))
        .sort((a, b) => a - b)
        .slice(0, 4)
        .reduce((sum, rate) => sum + rate, 0);
    const baseline = statsOf({});
    const moderate = statsOf({ wisdom: 25 });
    expect(perSecond(baseline)).toBeLessThan(ordinary(baseline));
    expect(perSecond(moderate)).toBeGreaterThan(ordinary(moderate));
  });
});

describe('resource costs', () => {
  it('keeps a free ability free under every discount', () => {
    const stats = statsOf({ wisdom: CAP }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    for (const ability of ALL_ABILITIES) {
      if (ability.cost > 0) continue;
      expect(resourceCostFor(ability, body(stats, attunedTo(stats, 3)), 0)).toBe(0);
    }
  });

  it('never resolves a cost below zero', () => {
    const stats = statsOf({ wisdom: CAP }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    for (const ability of EQUIPPABLE) {
      expect(resourceCostFor(ability, body(stats, attunedTo(stats, 3)), 0)).toBeGreaterThan(0);
    }
  });

  it('leaves both cost floors out of reach of legal progression', () => {
    // The state a guard should be in. `resourceCostScale`'s outer clamp is 0.2
    // and the reciprocal's own floor is `costFloor`; neither is a ceiling the
    // tree is priced against, and a purchase that reached one would be a
    // purchase silently discarded.
    const deepest = statsOf({ wisdom: CAP }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    expect(deepest.traits.resourceCostScale).toBeGreaterThan(SCALING.wisdom.costFloor);
    expect(deepest.traits.resourceCostScale).toBeGreaterThan(0.2);
  });
});

describe('Conservation and Attuned', () => {
  const conservation = SPECIALIZATIONS.get('wis.conservation');
  const milestone = ALL_MILESTONES.find((row) => row.id === 'wis.conservation');

  it('sums its tiers and its milestone to the cap exactly', () => {
    expect(conservation).toBeDefined();
    expect(milestone).toBeDefined();
    const perTier = conservation?.perTier.traits?.attunedCostPct ?? 0;
    const fromMilestone = milestone?.grants.traits?.attunedCostPct ?? 0;
    expect(perTier * (conservation?.maxTier ?? 0) + fromMilestone).toBeCloseTo(
      SCALING.wisdom.attunedCostCap,
      6,
    );
  });

  it('moves the resolved cost of a real ability at every tier', () => {
    const dart = abilityById('skill.poisonDart') as AbilityDefinition;
    let previous = Infinity;
    for (let held = 0; held <= (conservation?.maxTier ?? 0); held++) {
      const stats = statsOf(
        { wisdom: 25 },
        held === 0 ? [] : [{ specializationId: 'wis.conservation', tier: held }],
      );
      const cost = resourceCostFor(dart, body(stats, attunedTo(stats, 3)), 0);
      expect(cost).toBeLessThan(previous);
      previous = cost;
    }
  });

  it('caps the stacks it can hold', () => {
    const stats = statsOf({ wisdom: 25 }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    const dart = abilityById('skill.poisonDart') as AbilityDefinition;
    expect(
      resourceCostFor(dart, body(stats, attunedTo(stats, stats.traits.attunedMaxStacks + 5)), 0),
    ).toBe(resourceCostFor(dart, body(stats, attunedTo(stats, stats.traits.attunedMaxStacks)), 0));
  });

  /**
   * The rule the halving exists for: `Attuned` is a *standing* buff refreshed by
   * every non-basic ability that connects, not a charge spent by one, so any
   * sustained rotation holds it permanently. A discount that size has to stay
   * smaller than a discount that a player has to keep earning.
   */
  it('never takes more than half off on its own', () => {
    const stats = statsOf({ wisdom: 25 }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    for (const ability of EQUIPPABLE) {
      const plain = ability.cost * stats.traits.resourceCostScale;
      expect(resourceCostFor(ability, body(stats, attunedTo(stats, 3)), 0)).toBeGreaterThan(plain * 0.5);
    }
  });

  it('leaves the greediest bar expensive even fully bought', () => {
    const stats = statsOf({ wisdom: CAP }, [{ specializationId: 'wis.conservation', tier: 3 }]);
    // Regeneration may pass the *attuned* ceiling -- that is what the
    // specialization is for -- but not by the sort of margin that makes the pool
    // decorative again.
    expect(perSecond(stats)).toBeLessThan(maximumDrain(stats, attunedTo(stats, 3)) * 1.25);
  });
});

describe('cooldown reduction is resource demand', () => {
  const cooldownTree: readonly SpecializationAllocation[] = [
    { specializationId: 'wis.composure', tier: 3 },
  ];

  it('lowers a resolved cooldown and leaves the resolved cost alone', () => {
    const dart = abilityById('skill.poisonDart') as AbilityDefinition;
    const plain = statsOf({ wisdom: 40 });
    const composed = statsOf({ wisdom: 40 }, cooldownTree);
    expect(attackTimingFor(dart, body(composed), 0).intervalTicks).toBeLessThan(
      attackTimingFor(dart, body(plain), 0).intervalTicks,
    );
    // The rule the whole design turns on: cooldown reduction must not secretly
    // be a discount, or the tension it exists to create pays for itself.
    expect(resourceCostFor(dart, body(composed), 0)).toBe(resourceCostFor(dart, body(plain), 0));
  });

  it('raises what the same bar demands per second', () => {
    const plain = statsOf({ wisdom: 40 });
    const composed = statsOf({ wisdom: 40 }, cooldownTree);
    expect(maximumDrain(composed)).toBeGreaterThan(maximumDrain(plain));
    // And it buys no regeneration to pay for it.
    expect(composed.resourceRegen).toBe(plain.resourceRegen);
  });
});

describe('the spend rate the design is measured against', () => {
  it('reports the drain table so a content change is visible here', () => {
    const stats = statsOf({});
    const rates = EQUIPPABLE.map((ability) => ({
      id: ability.id,
      drain: resourceCostFor(ability, body(stats), 0) / cycleSeconds(ability, stats, NO_STATUSES),
    })).sort((a, b) => b.drain - a.drain);
    // Two properties rather than a snapshot of thirteen numbers, because a
    // snapshot would fail on every content edit and say nothing about any of
    // them. What is asserted is that a bar is a real constraint at all.
    expect(rates.length).toBeGreaterThanOrEqual(4);
    expect(maximumDrain(stats)).toBeGreaterThan(RESOURCE_REGEN_PER_SECOND * 2);
    // And no single ability can outspend the baseline reload on its own: one
    // button held down is not supposed to be the whole economy.
    expect(rates[0]?.drain ?? 0).toBeLessThan(RESOURCE_REGEN_PER_SECOND * 2);
  });
});

describe('Overdraw is what an empty magazine is for', () => {
  const overdrawn: readonly SpecializationAllocation[] = [
    { specializationId: 'int.overflow', tier: 1 },
  ];
  const shaped = () => abilityById('skill.emberToss') as AbilityDefinition;

  it('spends the pool first and bills only the shortfall to health', () => {
    const stats = statsOf({ intelligence: 40 }, overdrawn);
    expect(stats.traits.overflowHealthPerResource).toBeGreaterThan(0);
    const cost = resourceCostFor(shaped(), body(stats), 0);
    const held = cost / 3;
    const bill = overflowCostFor({ stats, health: stats.maxHealth }, cost - held);
    // The whole cost billed to health would be `cost * rate`; only the deficit is.
    expect(bill).toBeCloseTo((cost - held) * stats.traits.overflowHealthPerResource, 6);
    expect(bill).toBeLessThan(cost * stats.traits.overflowHealthPerResource);
  });

  it('refuses a bill it cannot afford rather than taking the body below one', () => {
    const stats = statsOf({ intelligence: 40 }, overdrawn);
    const cost = resourceCostFor(shaped(), body(stats), 0);
    const brittle = { stats, health: 1 };
    expect(overflowCostFor(brittle, cost)).toBe(0);
    // And the fraction is of *current* health, so a healthy body may pay.
    expect(overflowCostFor({ stats, health: stats.maxHealth }, cost)).toBeGreaterThan(0);
  });

  it('is naturally needed less often by a body that spends less', () => {
    const thrifty = statsOf({ intelligence: 40, wisdom: 40 }, overdrawn);
    const spendthrift = statsOf({ intelligence: 40 }, overdrawn);
    const held = 1;
    const deficit = (stats: EffectiveStats): number =>
      Math.max(0, resourceCostFor(shaped(), body(stats), 0) - held);
    expect(deficit(thrifty)).toBeLessThan(deficit(spendthrift));
    expect(
      overflowCostFor({ stats: thrifty, health: thrifty.maxHealth }, deficit(thrifty)),
    ).toBeLessThan(
      overflowCostFor({ stats: spendthrift, health: spendthrift.maxHealth }, deficit(spendthrift)),
    );
  });

  it('cannot be turned into a free cast by cost reduction', () => {
    // Efficiency lowers the *cost*, so it lowers the deficit -- it must never
    // lower the rate the deficit is billed at, or deep Wisdom would make forcing
    // a cast cheaper than paying for it.
    const plain = statsOf({ intelligence: 40 }, overdrawn);
    const efficient = statsOf({ intelligence: 40, wisdom: CAP }, [
      ...overdrawn,
      { specializationId: 'wis.conservation', tier: 3 },
    ]);
    expect(efficient.traits.overflowHealthPerResource).toBe(
      plain.traits.overflowHealthPerResource,
    );
    // And one point of shortfall always costs at least one point of health.
    expect(plain.traits.overflowHealthPerResource).toBeGreaterThanOrEqual(1);
  });
});

describe('the shaping premium survives efficiency', () => {
  it('keeps a shaped ability dearer than an unshaped one at every investment', () => {
    const unshaped = abilityById('skill.guardBreak') as AbilityDefinition;
    const shaped = abilityById('skill.emberToss') as AbilityDefinition;
    for (const stats of [
      statsOf({ intelligence: 40 }),
      statsOf({ intelligence: CAP }),
      statsOf({ intelligence: 40, wisdom: 40 }),
      statsOf({ intelligence: CAP, wisdom: CAP }, [
        { specializationId: 'wis.conservation', tier: 3 },
        { specializationId: 'int.efficientConstruction', tier: 3 },
      ]),
    ]) {
      if (stats.traits.shapingCostPct <= 0) continue;
      const attuned = attunedTo(stats, 3);
      // Per point of authored cost, so the comparison is about the premium and
      // not about the two rows happening to be priced differently.
      const perPoint = (ability: AbilityDefinition): number =>
        resourceCostFor(ability, body(stats, attuned), 0) / ability.cost;
      expect(perPoint(shaped)).toBeGreaterThan(perPoint(unshaped));
    }
  });
});

describe('a support rotation is Wisdom\'s to hold', () => {
  it('lets Wisdom sustain a damage-free bar the baseline cannot', () => {
    // Every equippable row that deals no damage of its own: the utility half of
    // the table, which a support build lives on and which nothing else in this
    // file exercises.
    const utility = EQUIPPABLE.filter((ability) => ability.damage <= 0);
    expect(utility.length).toBeGreaterThan(0);
    const drain = (stats: EffectiveStats): number =>
      utility
        .map((ability) => resourceCostFor(ability, body(stats), 0) / cycleSeconds(ability, stats, NO_STATUSES))
        .reduce((sum, rate) => sum + rate, 0);
    const baseline = statsOf({});
    const supportive = statsOf({ wisdom: 40 });
    expect(drain(supportive)).toBeLessThan(drain(baseline));
    expect(perSecond(supportive) / drain(supportive)).toBeGreaterThan(
      perSecond(baseline) / drain(baseline) * 1.5,
    );
  });
});

/**
 * The long run, driven through the real `step`.
 *
 * Everything above is arithmetic over the content table, and arithmetic cannot
 * see the two things that decide whether a magazine is a magazine: that a body
 * is rooted through its own casts, so the theoretical ceiling is not always
 * reachable, and that the pool clamps at its own ceiling, so regeneration past
 * what is being spent is simply thrown away. Both need a fight.
 *
 * Short by the probe's standards -- `scripts/probe-resource.ts` runs 150s and is
 * where the numbers in the spec came from. 45s is enough for the four claims
 * here and cheap enough to sit in `npm test`.
 */
describe('the long run', () => {
  const CHUNK = 100;
  const AT = { x: 600, y: 450 };
  const CONTEXT: StepContext = {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: (() => {
      const keys = new Set<string>();
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          keys.add(chunkKeyOf(AT.x + dx * CHUNK, AT.y + dy * CHUNK, CHUNK));
        }
      }
      return keys;
    })(),
    chunkSize: CHUNK,
    spawnPoints: [],
  };

  /** The four greediest equippable rows, as sigil item ids. */
  const GREEDY = [...EQUIPPABLE]
    .map((ability) => ({
      ability,
      drain:
        resourceCostFor(ability, body(statsOf({})), 0) / cycleSeconds(ability, statsOf({}), NO_STATUSES),
    }))
    .sort((a, b) => b.drain - a.drain || (a.ability.id < b.ability.id ? -1 : 1))
    .slice(0, 4)
    .map(
      (row) =>
        [...ITEMS.values()].find(
          (item) => item.slot === 'skill' && item.activeSkillId === row.ability.id,
        )?.id ?? '',
    );

  interface Shape {
    readonly minResource: number;
    readonly meanFraction: number;
    readonly ticksNearFull: number;
    readonly ticksStarved: number;
    readonly ticks: number;
    readonly spent: number;
  }

  function run(
    attributes: Partial<BaseStats>,
    specializations: readonly SpecializationAllocation[] = [],
    seconds = 45,
  ): Shape {
    const source = record(attributes, specializations);
    const player: PersistedPlayer = {
      ...source,
      equipment: {
        ...source.equipment,
        skill1: GREEDY[0] ?? '',
        skill2: GREEDY[1] ?? '',
        skill3: GREEDY[2] ?? '',
        skill4: GREEDY[3] ?? '',
      },
    };
    const stats = computeEffectiveStats(player);
    const dummy = monsterById('dummy');
    if (!dummy) throw new Error('no dummy');

    let state = createWorldState(1);
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Player,
      typeId: 'player',
      ownerPlayerId: player.id,
      position: { x: AT.x, y: AT.y, z: 0 },
      stats,
      radius: 16,
      zoneId: 'greenmarch',
    });
    state = spawned.state;
    const selfId = spawned.entity.id;
    const foe = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: dummy.id,
      position: { x: AT.x + 40, y: AT.y, z: 0 },
      stats: { ...dummy.stats, maxHealth: 1_000_000_000 },
      radius: dummy.radius,
      zoneId: 'greenmarch',
      targetId: selfId,
    });
    state = foe.state;
    const foeId = foe.entity.id;
    const held = state.entities.get(foeId);
    if (held) state = replaceEntity(state, { ...held, health: 1_000_000_000 });

    const carried = stats.skillAbilityIds
      .map((id) => abilityById(id))
      .filter((a): a is AbilityDefinition => a !== null);
    const cheapest = Math.min(...carried.map((a) => a.cost * stats.traits.resourceCostScale));

    const ticks = seconds * SERVER_TICK_RATE;
    let minResource = stats.maxResource;
    let poolSum = 0;
    let nearFull = 0;
    let starved = 0;
    let spent = 0;

    for (let tick = 1; tick <= ticks; tick++) {
      const self = state.entities.get(selfId);
      if (!self) break;
      // The subject must not die: a body that fell over stops spending, which
      // would read as a sustainable economy.
      if (self.health < stats.maxHealth) {
        state = replaceEntity(state, { ...self, health: stats.maxHealth });
      }
      const live = state.entities.get(selfId) as ServerEntity;
      const target = state.entities.get(foeId);

      // Greedy: the most expensive thing that is ready and payable, else the
      // weapon. Pressing the *dearest* rather than the heaviest is what makes
      // this a measurement of the economy rather than of the damage table.
      let choice = '';
      let best = -1;
      if (live.cast === null) {
        for (const ability of carried) {
          if (state.tick < (live.cooldowns[ability.id] ?? 0)) continue;
          const cost = resourceCostFor(ability, body(live.stats, live.statuses), state.tick);
          if (live.resource + 1e-9 < cost) continue;
          const rate = cost / cycleSeconds(ability, live.stats, live.statuses);
          if (rate > best) {
            best = rate;
            choice = ability.id;
          }
        }
        if (choice === '') choice = stats.basicAttackId;
      }

      const before = live.resource;
      state = step(
        state,
        [
          {
            entityId: selfId,
            seq: tick,
            moveX: 0,
            moveY: 0,
            facing: 0,
            buttons: 0,
            predictedX: live.position.x,
            predictedY: live.position.y,
            hasPrediction: false,
            seqSpan: 1,
            castAbilityId: choice,
            castTargetX: target?.position.x ?? AT.x + 40,
            castTargetY: target?.position.y ?? AT.y,
            castTargetEntityId: target?.id ?? 0,
            cancelCast: false,
          },
        ],
        CONTEXT,
      ).state;
      const after = state.entities.get(selfId);
      if (!after) break;
      if (after.resource < before) spent += before - after.resource;
      if (after.resource < minResource) minResource = after.resource;
      poolSum += after.resource / stats.maxResource;
      if (after.resource >= stats.maxResource * 0.9) nearFull += 1;
      if (after.resource + 1e-9 < cheapest) starved += 1;
    }

    return {
      minResource,
      meanFraction: poolSum / ticks,
      ticksNearFull: nearFull,
      ticksStarved: starved,
      ticks,
      spent,
    };
  }

  it('empties a character who has spent nothing', () => {
    const baseline = run({});
    // The pool is sampled *after* the step, and the step regenerates after the
    // cast is paid for, so a body that spent everything reads one tick of
    // regeneration rather than exactly zero. Asserting `<= 0` would be
    // asserting the sampling order rather than the economy.
    expect(baseline.minResource).toBeLessThan(statsOf({}).resourceRegen * 2);
    expect(baseline.ticksStarved / baseline.ticks).toBeGreaterThan(0.25);
  });

  it('leaves a moderate-Wisdom build materially better off, and still not solved', () => {
    const baseline = run({});
    const moderate = run({ wisdom: 25 });
    expect(moderate.meanFraction).toBeGreaterThan(baseline.meanFraction);
    expect(moderate.ticksStarved).toBeLessThan(baseline.ticksStarved);
    // Still exhaustible: a moderate purchase must not end the conversation.
    expect(moderate.minResource).toBeLessThan(moderate.ticks > 0 ? statsOf({ wisdom: 25 }).maxResource : 0);
    expect(moderate.ticksNearFull / moderate.ticks).toBeLessThan(0.85);
  });

  it('lets a large magazine spend more before it is gone', () => {
    expect(run({ intelligence: 40 }).spent).toBeGreaterThan(run({}).spent * 1.2);
  });

  /**
   * The failure this whole spec exists to remove: a pool that is full for the
   * whole fight while every cooldown is being pressed. Asserted for the
   * attribute alone at every depth, because that is the state the shipped
   * economy was in from about Wisdom 21 upward.
   */
  it('never leaves an unspecialized build sitting at its own ceiling', () => {
    for (const wisdom of [25, 40, CAP]) {
      const shape = run({ wisdom });
      expect(shape.ticksNearFull / shape.ticks).toBeLessThan(0.85);
    }
    for (const intelligence of [25, CAP]) {
      const shape = run({ intelligence });
      expect(shape.ticksNearFull / shape.ticks).toBeLessThan(0.85);
    }
  });
});
