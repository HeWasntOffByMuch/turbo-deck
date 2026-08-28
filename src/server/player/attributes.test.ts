/**
 * Attribute allocation, respec, and the migration (spec 147).
 *
 * The posture the whole file is written against: **the client is assumed to
 * have sent something illegal.** Every test that asserts a rejection also
 * asserts the record came back byte-identical, because "refused" and "refused
 * without side effects" are two different properties and only one of them is
 * safe.
 */

import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS } from '../data/attributes.js';
import { MemoryDataStore } from '../state/memory-store.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../state/types.js';
import { ZoneManager } from '../world/zone-manager.js';
import { PlayerManager } from './player-manager.js';
import {
  allocateAttributePoint,
  ATTRIBUTE_HARD_CAP,
  PROGRESSION_POINTS_PER_LEVEL,
  normalizeBaseStats,
  pointsEarned,
  pointsSpent,
  reconcileProgressionPoints,
  respecProgression,
  RESPEC_COST,
  startingBaseStats,
  STARTING_ATTRIBUTE,
  STARTING_PROGRESSION_POINTS,
  validateAttributeSpend,
} from './attributes.js';

function player(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: startingBaseStats(),
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 5,
    health: 100,
    resource: 20,
    coins: 100,
    ...overrides,
  };
}

describe('allocating a point', () => {
  it('raises exactly one attribute by exactly one, and spends exactly one', () => {
    const before = player();
    const after = allocateAttributePoint(before, 'perception');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.player.baseStats.perception).toBe(STARTING_ATTRIBUTE + 1);
    expect(after.player.unspentProgressionPoints).toBe(before.unspentProgressionPoints - 1);
    // And nothing else moved.
    for (const key of ATTRIBUTE_KEYS) {
      if (key === 'perception') continue;
      expect(after.player.baseStats[key]).toBe(before.baseStats[key]);
    }
  });

  it('refuses an unknown key without touching the record', () => {
    const before = player();
    const snapshot = JSON.stringify(before);
    const result = allocateAttributePoint(before, 'charisma');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknownAttribute');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('refuses when the budget is empty', () => {
    const result = allocateAttributePoint(player({ unspentProgressionPoints: 0 }), 'strength');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('noPointsAvailable');
  });

  it('refuses at the hard cap, and allows the point that reaches it', () => {
    const atCap = player({
      baseStats: { ...startingBaseStats(), strength: ATTRIBUTE_HARD_CAP },
    });
    expect(allocateAttributePoint(atCap, 'strength').ok).toBe(false);
    const oneBelow = player({
      baseStats: { ...startingBaseStats(), strength: ATTRIBUTE_HARD_CAP - 1 },
    });
    const reached = allocateAttributePoint(oneBelow, 'strength');
    expect(reached.ok).toBe(true);
    if (reached.ok) expect(reached.player.baseStats.strength).toBe(ATTRIBUTE_HARD_CAP);
  });

  it('answers the same question the spend does, without spending', () => {
    // The property `character-model.ts` leans on: the greyed-out button and the
    // refusal come from one function, so they cannot disagree.
    for (const key of ATTRIBUTE_KEYS) {
      for (const budget of [0, 1, 3]) {
        for (const value of [STARTING_ATTRIBUTE, ATTRIBUTE_HARD_CAP - 1, ATTRIBUTE_HARD_CAP]) {
          const record = player({
            unspentProgressionPoints: budget,
            baseStats: { ...startingBaseStats(), [key]: value },
          });
          expect(validateAttributeSpend(record, key).ok).toBe(
            allocateAttributePoint(record, key).ok,
          );
        }
      }
    }
  });
});

describe('respec', () => {
  it('returns every allocated point and charges the fee', () => {
    const built = player({
      coins: 100,
      unspentProgressionPoints: 0,
      baseStats: { ...startingBaseStats(), strength: 30, perception: 20 },
    });
    const spent = pointsSpent(built.baseStats);
    expect(spent).toBe(25 + 15);

    const result = respecProgression(built);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refunded).toBe(spent);
    expect(result.player.baseStats).toEqual(startingBaseStats());
    expect(result.player.unspentProgressionPoints).toBe(spent);
    expect(result.player.coins).toBe(100 - RESPEC_COST);
  });

  it('is refused when the purse is short, and changes nothing', () => {
    const poor = player({
      coins: RESPEC_COST - 1,
      baseStats: { ...startingBaseStats(), strength: 30 },
    });
    const snapshot = JSON.stringify(poor);
    const result = respecProgression(poor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cannotAfford');
    expect(JSON.stringify(poor)).toBe(snapshot);
  });

  it('is refused when there is nothing to hand back', () => {
    const result = respecProgression(player({ coins: 1000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothingToRespec');
  });

  it('conserves points: spend, respec, and the budget is what it was', () => {
    // The property that matters more than any of the above. A respec that
    // returned one point too many is a slow-motion duplication bug.
    let record = player({ unspentProgressionPoints: 12, coins: 500 });
    const budget = record.unspentProgressionPoints;
    for (const key of ['strength', 'agility', 'wisdom', 'wisdom'] as const) {
      const step = allocateAttributePoint(record, key);
      expect(step.ok).toBe(true);
      if (step.ok) record = step.player;
    }
    expect(record.unspentProgressionPoints + pointsSpent(record.baseStats)).toBe(budget);

    const back = respecProgression(record);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.player.unspentProgressionPoints).toBe(budget);
  });
});

describe('the budget', () => {
  it('grows by a fixed amount per level', () => {
    expect(pointsEarned(1)).toBe(STARTING_PROGRESSION_POINTS);
    expect(pointsEarned(2)).toBe(STARTING_PROGRESSION_POINTS + PROGRESSION_POINTS_PER_LEVEL);
    expect(pointsEarned(11)).toBe(STARTING_PROGRESSION_POINTS + PROGRESSION_POINTS_PER_LEVEL * 10);
  });

  it('never grants more than the level has earned, however the save reads', () => {
    const fresh = startingBaseStats();
    // A save claiming a thousand spare points gets what its level says.
    expect(reconcileProgressionPoints(fresh, [], 1, 1000)).toBe(STARTING_PROGRESSION_POINTS);
    expect(reconcileProgressionPoints(fresh, [], 1, Number.NaN)).toBe(STARTING_PROGRESSION_POINTS);
    expect(reconcileProgressionPoints(fresh, [], 1, -5)).toBe(0);
  });

  it('subtracts what is already placed', () => {
    const built = { ...startingBaseStats(), strength: STARTING_ATTRIBUTE + 4 };
    expect(reconcileProgressionPoints(built, [], 1, undefined)).toBe(STARTING_PROGRESSION_POINTS - 4);
  });

  it('leaves an over-allocated save with its allocation and no budget', () => {
    // Taking points off a character to satisfy an invariant is a worse failure
    // than a character being briefly over budget.
    const overspent = { ...startingBaseStats(), strength: 40 };
    expect(reconcileProgressionPoints(overspent, [], 1, 3)).toBe(0);
    expect(pointsSpent(overspent)).toBe(40 - STARTING_ATTRIBUTE);
  });
});

describe('a save from before the six attributes', () => {
  it('carries dexterity onto agility and vitality onto constitution', () => {
    const old = { strength: 12, dexterity: 19, intelligence: 7, vitality: 23 };
    const migrated = normalizeBaseStats(old);
    expect(migrated.strength).toBe(12);
    expect(migrated.agility).toBe(19);
    expect(migrated.intelligence).toBe(7);
    expect(migrated.constitution).toBe(23);
    // The two that did not exist start where a fresh character starts.
    expect(migrated.perception).toBe(STARTING_ATTRIBUTE);
    expect(migrated.wisdom).toBe(STARTING_ATTRIBUTE);
  });

  it('holds every attribute inside its bounds, whatever the file said', () => {
    const junk = normalizeBaseStats({
      strength: -40,
      dexterity: 9e9,
      intelligence: Number.NaN,
      vitality: 12.7,
      perception: null,
      wisdom: 'lots',
    });
    expect(junk.strength).toBe(STARTING_ATTRIBUTE);
    expect(junk.agility).toBe(ATTRIBUTE_HARD_CAP);
    expect(junk.intelligence).toBe(STARTING_ATTRIBUTE);
    expect(junk.constitution).toBe(12);
    expect(junk.perception).toBe(STARTING_ATTRIBUTE);
    expect(junk.wisdom).toBe(STARTING_ATTRIBUTE);
  });

  it('prefers the new name when a save somehow carries both', () => {
    expect(normalizeBaseStats({ agility: 11, dexterity: 40 }).agility).toBe(11);
  });

  it('hands an existing character the budget their level earned', async () => {
    // The upgrade rule: nobody is robbed. A level-12 save that predates this
    // spec logs in holding every attribute point their level is worth, rather
    // than having notionally spent them on stats that did not exist.
    const store = new MemoryDataStore();
    const zones = new ZoneManager();
    const legacy = {
      ...player({ level: 12, unspentProgressionPoints: 3 }),
      baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
      // What a pre-147 save actually holds: rows from the branch-locked tree
      // that no longer exists.
      specializations: [
        { specializationId: 'might.toughness', tier: 3 },
        { specializationId: 'arcane.focus', tier: 1 },
      ],
    } as unknown as PersistedPlayer;
    delete (legacy as unknown as Record<string, unknown>).unspentProgressionPoints;
    await store.savePlayer(legacy);

    const session = await new PlayerManager(store, zones).login('p1', 'P1');
    expect(session.record.unspentProgressionPoints).toBe(pointsEarned(12));
    expect(session.record.baseStats).toEqual(startingBaseStats());
    // The branch skills are gone, because the table no longer has them. Nobody
    // is left holding a skill that reaches nothing.
    expect(session.record.specializations).toEqual([]);
  });
});

describe('levelling', () => {
  it('grants the one pool, at the one schedule', async () => {
    // Two budgets until spec 244, and this asserted they moved separately. One
    // pool means one number, and the number is the two summed -- so a level is
    // worth exactly what it always was.
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    const before = await manager.login('p1', 'P1');
    const pool = before.record.unspentProgressionPoints;
    expect(pool).toBe(STARTING_PROGRESSION_POINTS);

    // Enough for exactly one level.
    const after = await manager.grantExperience('p1', 50);
    expect(after?.record.level).toBe(2);
    expect(after?.record.unspentProgressionPoints).toBe(pool + PROGRESSION_POINTS_PER_LEVEL);
  });
});

describe('the manager', () => {
  it('allocates through the same rules, and persists the result', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    await manager.login('p1', 'P1');

    const ok = await manager.allocateAttribute('p1', 'constitution');
    expect(ok.ok).toBe(true);
    // An allocation marks the player dirty rather than writing inline
    // (spec 226): it neither creates nor destroys anything, so it rides the
    // autosave. That it *reaches* storage is still the point of this test.
    expect(manager.isDirty('p1')).toBe(true);
    await manager.persistNow(['p1']);
    const saved = await store.loadPlayer('p1');
    expect(saved?.baseStats.constitution).toBe(STARTING_ATTRIBUTE + 1);

    // Health follows, because `recalculate` is the one funnel every stat change
    // goes through -- there is no path that changes an attribute and not a stat.
    const session = manager.get('p1');
    expect(session?.stats.maxHealth).toBeGreaterThan(0);

    const bad = await manager.allocateAttribute('p1', 'luck');
    expect(bad.ok).toBe(false);
    await manager.persistNow(['p1']);
    expect((await store.loadPlayer('p1'))?.baseStats.constitution).toBe(STARTING_ATTRIBUTE + 1);
  });

  it('drops a stat skill a respec left unaffordable', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    await manager.login('p1', 'P1');
    const session = manager.get('p1');
    if (!session) throw new Error('no session');

    // Enough Strength for a tier-1 specialization, then buy a tier, then respec.
    for (let i = 0; i < 6; i++) await manager.allocateAttribute('p1', 'strength');
    await manager.grantExperience('p1', 400);
    const took = await manager.buySpecializationTier('p1', 'str.crushingBlows');
    expect(took.ok).toBe(true);
    expect(manager.get('p1')?.record.specializations).toHaveLength(1);

    const before = manager.get('p1')?.record.unspentProgressionPoints ?? 0;
    const back = await manager.respec('p1');
    expect(back.ok).toBe(true);
    // Both halves come back, in one operation (spec 244). Before it the tier was
    // *dropped* by `sanitizeSpecializations` on the next recalculation and the
    // point it cost was refunded to nobody -- which under one pool is the pool
    // leaking, not a rough edge.
    expect(manager.get('p1')?.record.specializations).toHaveLength(0);
    expect(manager.get('p1')?.record.unspentProgressionPoints).toBe(before + 6 + 1);
  });
});
