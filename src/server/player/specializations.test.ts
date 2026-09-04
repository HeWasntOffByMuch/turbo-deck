/**
 * The one point economy (spec 244).
 *
 * Two things a point can buy out of one pool, and the rules that keep the choice
 * a real one. The property every case here circles is the same: **a tier never
 * raises the attribute**, so the two purchases are not interchangeable and
 * reaching a milestone always costs points spent on the track.
 *
 * Server-side and pure: no store, no clock, no socket.
 */

import { describe, expect, it } from 'vitest';
import { ALL_SPECIALIZATIONS, specializationById } from '../data/specializations.js';
import { SCALING } from '../data/scaling.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import {
  allocateAttributePoint,
  pointsEarned,
  pointsSpent,
  respecProgression,
  startingBaseStats,
  validateAttributeSpend,
  RESPEC_COST,
} from './attributes.js';
import { resolveProgression } from './progression.js';
import {
  buySpecializationTier,
  costOfNextTier,
  sanitizeSpecializations,
  tierOf,
  totalSpecializationTiers,
} from './specializations.js';

function player(
  baseStats: Partial<BaseStats> = {},
  overrides: Partial<PersistedPlayer> = {},
): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 10,
    health: 100,
    resource: 10,
    coins: 100,
    ...overrides,
  };
}

/** The attribute totals a spend is checked against, from the server's own path. */
function totals(record: PersistedPlayer): Readonly<Record<string, number>> {
  return resolveProgression(record).attributes;
}

function buy(record: PersistedPlayer, id: string): ReturnType<typeof buySpecializationTier> {
  return buySpecializationTier(record, totals(record) as never, id);
}

describe('one pool, two things to spend it on', () => {
  it('takes a point off the same pool whichever is bought', () => {
    const start = player({ strength: 12 });
    const advanced = allocateAttributePoint(start, 'strength');
    const deepened = buy(start, 'str.crushingBlows');
    expect(advanced.ok && advanced.player.unspentProgressionPoints).toBe(9);
    expect(deepened.ok && deepened.player.unspentProgressionPoints).toBe(9);
  });

  it('raises the attribute on a track spend and nothing else', () => {
    const result = allocateAttributePoint(player({ strength: 12 }), 'strength');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.player.baseStats.strength).toBe(13);
    expect(result.player.specializations).toEqual([]);
  });

  /** The rule the whole model rests on. */
  it('leaves the attribute exactly where it was on a specialization spend', () => {
    const before = player({ strength: 12 });
    const result = buy(before, 'str.crushingBlows');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.player.baseStats).toEqual(before.baseStats);
    expect(tierOf(result.player.specializations, 'str.crushingBlows')).toBe(1);
  });

  it('never lets tiers carry a character toward the next milestone', () => {
    // Twelve points into Strength specializations, and Strength has not moved --
    // so the Strength 20 milestone is exactly as far away as it was.
    let record = player({ strength: 12 }, { unspentProgressionPoints: 30 });
    for (const id of ['str.crushingBlows', 'str.committedSwing']) {
      for (let i = 0; i < 3; i++) {
        const result = buy(record, id);
        expect(result.ok, `${id} tier ${i + 1}`).toBe(true);
        if (result.ok) record = result.player;
      }
    }
    expect(totalSpecializationTiers(record.specializations)).toBe(6);
    expect(resolveProgression(record).attributes.strength).toBe(12);
    expect(resolveProgression(record).milestones).toEqual([]);
  });

  it('stacks a tier onto the existing allocation rather than adding a row', () => {
    let record = player({ strength: 12 });
    for (let i = 0; i < 3; i++) {
      const result = buy(record, 'str.crushingBlows');
      expect(result.ok).toBe(true);
      if (result.ok) record = result.player;
    }
    expect(record.specializations).toEqual([{ specializationId: 'str.crushingBlows', tier: 3 }]);
  });
});

describe('what the server refuses', () => {
  it('refuses a specialization whose milestone is not reached', () => {
    const record = player({ strength: 9 });
    const result = buy(record, 'str.crushingBlows');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('attributeTooLow');
    expect(result.detail).toContain('10 Strength');
  });

  it('unlocks it at exactly the threshold and not one point below', () => {
    expect(buy(player({ strength: 9 }), 'str.crushingBlows').ok).toBe(false);
    expect(buy(player({ strength: 10 }), 'str.crushingBlows').ok).toBe(true);
  });

  it('refuses a tier past the maximum', () => {
    const record = player(
      { strength: 12 },
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 3 }] },
    );
    const result = buy(record, 'str.crushingBlows');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('alreadyMaxTier');
  });

  it('refuses an overspend, on either kind of purchase', () => {
    const broke = player({ strength: 12 }, { unspentProgressionPoints: 0 });
    const tier = buy(broke, 'str.crushingBlows');
    expect(tier.ok).toBe(false);
    if (!tier.ok) expect(tier.reason).toBe('noPointsAvailable');
    const track = allocateAttributePoint(broke, 'strength');
    expect(track.ok).toBe(false);
    if (!track.ok) expect(track.reason).toBe('noPointsAvailable');
  });

  it('refuses an unknown specialization id', () => {
    const result = buy(player({ strength: 40 }), 'nope.notReal');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknownSpecialization');
  });

  it('refuses an unknown attribute key', () => {
    const result = validateAttributeSpend(
      { baseStats: startingBaseStats(), unspentProgressionPoints: 5 },
      'charisma',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknownAttribute');
  });

  it('refuses a track spend at the hard cap', () => {
    const capped = player({ strength: SCALING.attributeHardCap });
    const result = allocateAttributePoint(capped, 'strength');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('atHardCap');
  });

  /**
   * The anti-cheat property. Neither spend function takes a *result* -- there is
   * no attribute value and no tier number in either signature -- so a client
   * that wanted to forge one has nowhere to put it. What it can send is a name,
   * and a name is checked against the tables.
   */
  it('leaves the record byte-identical on every refusal', () => {
    const cases: readonly PersistedPlayer[] = [
      player({ strength: 9 }),
      player({ strength: 12 }, { unspentProgressionPoints: 0 }),
      player(
        { strength: 12 },
        { specializations: [{ specializationId: 'str.crushingBlows', tier: 3 }] },
      ),
    ];
    for (const record of cases) {
      const before = JSON.stringify(record);
      const tier = buy(record, 'str.crushingBlows');
      const bogus = buy(record, 'nope.notReal');
      expect(tier.ok && bogus.ok).toBe(false);
      expect(JSON.stringify(record)).toBe(before);
    }
  });

  it('cannot be talked into a tier by a claimed allocation', () => {
    // A record whose stored tier is nonsense: the validator reads the *table's*
    // maximum, so a claimed 99 is still refused for being at the ceiling rather
    // than accepted as room to grow.
    const forged = player(
      { strength: 12 },
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 99 }] },
    );
    expect(buy(forged, 'str.crushingBlows').ok).toBe(false);
  });
});

/** Constitution's mastery rows (spec 273), named once. */
const MASTERY_IDS = new Set(['con.unbroken', 'con.deathsDoor', 'con.deepWell']);

describe('what a tier costs', () => {
  it('is one point for every core row, and more for a mastery row', () => {
    // Every row on the three shared thresholds costs a point, so a tier and an
    // attribute point are the same decision (spec 244). Constitution's mastery
    // rows are the exception spec 273 introduced and are priced above it
    // deliberately: a late purchase has to compete with two or four attribute
    // points, or it is strictly better than the point beside it.
    for (const specialization of ALL_SPECIALIZATIONS) {
      const cost = costOfNextTier(specialization);
      if (MASTERY_IDS.has(specialization.id)) {
        expect(cost, specialization.id).toBeGreaterThan(1);
      } else {
        expect(cost, specialization.id).toBe(1);
      }
    }
  });

  it('prices every mastery row against the attribute points it displaces', () => {
    for (const id of MASTERY_IDS) {
      const specialization = specializationById(id);
      expect(specialization, id).toBeDefined();
      if (!specialization) continue;
      expect(specialization.attribute, id).toBe('constitution');
      // On the last milestone threshold, which is where the track continues
      // rather than a fourth number of its own.
      expect(specialization.requires, id).toBe(50);
      expect(costOfNextTier(specialization) * specialization.maxTier, id).toBeGreaterThanOrEqual(4);
    }
  });

  it('counts a held allocation at its own cost', () => {
    const held: SpecializationAllocation[] = [
      { specializationId: 'str.crushingBlows', tier: 3 },
      { specializationId: 'agi.quickRecovery', tier: 1 },
    ];
    expect(totalSpecializationTiers(held)).toBe(4);
  });

  it('counts a tier past the maximum at the maximum, never at what it claims', () => {
    expect(totalSpecializationTiers([{ specializationId: 'str.crushingBlows', tier: 99 }])).toBe(
      specializationById('str.crushingBlows')?.maxTier ?? 0,
    );
  });

  it('ignores an id the table has dropped rather than throwing', () => {
    expect(totalSpecializationTiers([{ specializationId: 'might.toughness', tier: 2 }])).toBe(0);
  });
});

describe('respec hands the whole build back (spec 244)', () => {
  it('refunds attribute points and tiers together, into one pool', () => {
    let record = player({}, { unspentProgressionPoints: pointsEarned(20) });
    for (let i = 0; i < 7; i++) {
      const step = allocateAttributePoint(record, 'strength');
      expect(step.ok).toBe(true);
      if (step.ok) record = step.player;
    }
    for (let i = 0; i < 2; i++) {
      const step = buy(record, 'str.crushingBlows');
      expect(step.ok).toBe(true);
      if (step.ok) record = step.player;
    }
    const before = record.unspentProgressionPoints;

    const result = respecProgression(record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refunded).toBe(9);
    expect(result.player.unspentProgressionPoints).toBe(before + 9);
    expect(result.player.baseStats).toEqual(startingBaseStats());
    expect(result.player.specializations).toEqual([]);
    expect(result.player.coins).toBe(record.coins - RESPEC_COST);
  });

  it('is worth doing for a character who has only bought tiers', () => {
    // The case that used to refund nothing at all: `pointsSpent(baseStats)` is
    // zero, so the old rule answered "nothing has been allocated" and the tiers
    // stayed put with their points unrecoverable.
    const record = player(
      { strength: 12 },
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 3 }] },
    );
    // ...and the attribute half is genuinely untouched, so this is tiers alone.
    expect(pointsSpent(record.baseStats)).toBe(7);
    const onlyTiers = player(
      {},
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 3 }] },
    );
    expect(pointsSpent(onlyTiers.baseStats)).toBe(0);
    const result = respecProgression(onlyTiers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refunded).toBe(3);
    expect(result.player.specializations).toEqual([]);
  });

  it('refuses a character with nothing to hand back', () => {
    const result = respecProgression(player());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('nothingToRespec');
  });

  it('refuses a character who cannot pay, without moving anything', () => {
    const record = player({ strength: 12 }, { coins: RESPEC_COST - 1 });
    const before = JSON.stringify(record);
    const result = respecProgression(record);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('cannotAfford');
    expect(JSON.stringify(record)).toBe(before);
  });

  it('leaves no tier standing above a milestone it no longer meets', () => {
    // The dependency problem, unrepresentable rather than handled: the only path
    // that lowers an attribute clears the tiers in the same operation.
    let record = player({}, { unspentProgressionPoints: pointsEarned(20) });
    for (let i = 0; i < 7; i++) {
      const step = allocateAttributePoint(record, 'strength');
      if (step.ok) record = step.player;
    }
    const bought = buy(record, 'str.crushingBlows');
    if (bought.ok) record = bought.player;

    const result = respecProgression(record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stranded = result.player.specializations.filter((allocation) => {
      const definition = specializationById(allocation.specializationId);
      return definition
        ? (result.player.baseStats[definition.attribute] ?? 0) < definition.requires
        : false;
    });
    expect(stranded).toEqual([]);
    // And `sanitizeSpecializations` has nothing left to do, which is the point:
    // it survives for a table edit, not for a respec.
    expect(
      sanitizeSpecializations(result.player.specializations, result.player.baseStats as never),
    ).toEqual([]);
  });
});
