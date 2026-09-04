/**
 * Catalysis, against a body that is actually suffering from something
 * (spec 240).
 *
 * The skill's line is *statuses are fuel; anything already suffering suffers
 * more*, and what it did was ask whether **any** entry on the target was live.
 * Every blow stamps `recentlyHit` and `inCombat` on what it lands on, so from
 * the second hit onward Catalysis was unconditional: not "exploit an affliction"
 * but "deal 8% more damage to anything you have already hit".
 *
 * Driven through the real {@link resolveBlow} rather than through
 * `hasAffliction` alone, because the fault was never in a predicate -- it was in
 * which predicate the blow asked. Every case here is a pair: the same blow, the
 * same seed, the same everything, against a body carrying one status.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { abilityById } from '../data/abilities.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { resolveBlow } from './blow.js';
import { applyStatus, adaptedKey, StatusId, type Statuses } from './statuses.js';
import { assistKey } from './restoration.js';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';

const TICK = 100;

const SLASH = (() => {
  const found = abilityById('melee.slash');
  if (!found) throw new Error('no melee.slash');
  return found;
})();

/** A caster with Catalysis at rank 3 and no other source of variance. */
function catalyst(): EffectiveStats {
  const record: PersistedPlayer = {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), intelligence: 25 },
    specializations: [{ specializationId: 'int.catalysis', tier: 3 }],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 10,
    coins: 0,
  };
  const derived = computeEffectiveStats(record);
  return {
    ...derived,
    critChance: 0,
    traits: { ...derived.traits, weakPointChance: 0 },
  };
}

function plain(): EffectiveStats {
  const derived = catalyst();
  return { ...derived, traits: { ...derived.traits, vsAfflictedPct: 0 } };
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
    health: 100_000,
    level: 1,
    zoneId: 'wilds',
    stats: { ...stats, maxHealth: 100_000, armor: 0 },
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
    resource: 0,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: 100_000,
    ...overrides,
  };
}

/** What one swing takes off a target carrying `ids`. */
function damageAgainst(attacker: EffectiveStats, ...ids: readonly string[]): number {
  let statuses: Statuses = {};
  for (const id of ids) statuses = applyStatus(statuses, id, TICK, 500);
  const target = body(plain(), { id: 2, statuses });
  const blow = resolveBlow(SLASH, body(attacker), target, TICK, Rng.fromSeed(7));
  const hit = blow.events.find((event) => event.kind === 'hit');
  return hit && hit.kind === 'hit' ? hit.damage : 0;
}

describe('Catalysis reads afflictions and not bookkeeping (spec 240)', () => {
  const A = catalyst();

  it('is armed at all, so the negative cases below mean something', () => {
    // A control. Every assertion in this file but this one is "Catalysis did
    // *not* fire", and a caster whose `vsAfflictedPct` was zero would pass all
    // of them while proving nothing.
    expect(A.traits.vsAfflictedPct).toBeGreaterThan(0);
    expect(damageAgainst(A, StatusId.Poison)).toBeGreaterThan(damageAgainst(A));
  });

  it('fires on a meaningful harmful status', () => {
    const bare = damageAgainst(A);
    for (const id of [
      StatusId.Burn,
      StatusId.Bleed,
      StatusId.Poison,
      StatusId.Corrosion,
      StatusId.Shock,
      StatusId.Frostbite,
      StatusId.Decay,
      StatusId.Sundered,
      StatusId.Slowed,
    ]) {
      expect(damageAgainst(A, id), id).toBeGreaterThan(bare);
    }
  });

  it('does not fire on RecentlyHit alone', () => {
    // The headline. Every blow stamps this, so this case *was* every fight.
    expect(damageAgainst(A, StatusId.RecentlyHit)).toBe(damageAgainst(A));
  });

  it('does not fire on InCombat alone', () => {
    expect(damageAgainst(A, StatusId.InCombat)).toBe(damageAgainst(A));
  });

  it('does not fire on both of them together, which is what a real fight looks like', () => {
    expect(damageAgainst(A, StatusId.RecentlyHit, StatusId.InCombat)).toBe(damageAgainst(A));
  });

  it('does not fire on a beneficial status', () => {
    const bare = damageAgainst(A);
    for (const id of [StatusId.Flow, StatusId.Attuned, StatusId.Momentum, StatusId.Prepared]) {
      expect(damageAgainst(A, id), id).toBe(bare);
    }
    expect(damageAgainst(A, adaptedKey('melee.slash'))).toBe(bare);
  });

  it('does not fire on an internal ledger entry', () => {
    const bare = damageAgainst(A);
    expect(damageAgainst(A, assistKey(4))).toBe(bare);
    expect(damageAgainst(A, StatusId.ExposedBounty)).toBe(bare);
    expect(damageAgainst(A, StatusId.SecondWindSpent)).toBe(bare);
  });

  it('does not fire on an opening somebody read', () => {
    // Vulnerable and Exposed are harmful and are not afflictions -- see
    // `data/status-semantics.ts`. Exposed already amplifies damage on its own,
    // so the assertion is against the *Catalysis* share of it: an unarmed caster
    // and an armed one take the same amount off an Exposed body.
    expect(damageAgainst(A, StatusId.Vulnerable)).toBe(damageAgainst(A));
    expect(damageAgainst(A, StatusId.Exposed)).toBe(damageAgainst(plain(), StatusId.Exposed));
  });

  it('still fires when the affliction is buried in bookkeeping', () => {
    // The case that must not regress in the other direction: a body mid-fight
    // carries both timers and an assist mark, and one real poison.
    const bare = damageAgainst(A);
    const busy = damageAgainst(
      A,
      StatusId.RecentlyHit,
      StatusId.InCombat,
      assistKey(9),
      StatusId.Poison,
    );
    expect(busy).toBeGreaterThan(bare);
  });
});
