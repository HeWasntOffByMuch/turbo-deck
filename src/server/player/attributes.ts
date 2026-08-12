/**
 * Attribute allocation, enforced server-side (spec 147).
 *
 * The same posture `skills.ts` takes and for the same reason: the client is
 * expected to grey out an illegal allocation, and this module assumes it did
 * not. Every rule is checked here against a message that could have been
 * hand-crafted, and **a rejection leaves the player record byte-identical** --
 * there is deliberately no partial application anywhere in this file.
 *
 * Three rules stack:
 *  - **budget**: you cannot spend what you have not earned.
 *  - **ceiling**: no attribute may pass {@link SCALING.attributeHardCap}.
 *  - **floor**: no attribute may fall below {@link SCALING.startingAttribute},
 *    which is what a respec returns you to and therefore what "spent" is
 *    measured against.
 *
 * Pure. No clock, no randomness, no store.
 */

import { attributeByKey, isAttributeKey, type AttributeKey } from '../data/attributes.js';
import { SCALING } from '../data/scaling.js';
import { BASE_STAT_KEYS, type BaseStats, type PersistedPlayer } from '../state/types.js';

export const STARTING_ATTRIBUTE = SCALING.startingAttribute;
export const ATTRIBUTE_HARD_CAP = SCALING.attributeHardCap;
export const ATTRIBUTE_POINTS_PER_LEVEL = SCALING.pointsPerLevel;
export const STARTING_ATTRIBUTE_POINTS = SCALING.startingPoints;
export const RESPEC_COST = SCALING.respecCost;

/** Six attributes at the starting value. A fresh object every call. */
export function startingBaseStats(): BaseStats {
  return {
    strength: STARTING_ATTRIBUTE,
    agility: STARTING_ATTRIBUTE,
    intelligence: STARTING_ATTRIBUTE,
    constitution: STARTING_ATTRIBUTE,
    perception: STARTING_ATTRIBUTE,
    wisdom: STARTING_ATTRIBUTE,
  };
}

function clampAttribute(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : STARTING_ATTRIBUTE;
  return Math.min(ATTRIBUTE_HARD_CAP, Math.max(STARTING_ATTRIBUTE, number));
}

/**
 * A save's `baseStats`, whatever shape it is in, as six clamped attributes.
 *
 * Handles the spec 147 rename explicitly: `dexterity` becomes `agility` and
 * `vitality` becomes `constitution`, carrying whatever was allocated. A save
 * from before this spec had no Perception or Wisdom at all, so those start where
 * a fresh character starts -- and because `unspentAttributePoints` is
 * reconciled separately against the character's level, that upgrade *hands*
 * every existing character their allocation budget rather than pretending they
 * spent it.
 */
export function normalizeBaseStats(raw: unknown): BaseStats {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    strength: clampAttribute(source.strength),
    agility: clampAttribute(source.agility ?? source.dexterity),
    intelligence: clampAttribute(source.intelligence),
    constitution: clampAttribute(source.constitution ?? source.vitality),
    perception: clampAttribute(source.perception),
    wisdom: clampAttribute(source.wisdom),
  };
}

/** Points sunk into attributes: everything above the starting value. */
export function pointsSpent(baseStats: BaseStats): number {
  let total = 0;
  for (const key of BASE_STAT_KEYS) total += Math.max(0, baseStats[key] - STARTING_ATTRIBUTE);
  return total;
}

/** Points a character of this level has earned in total. */
export function pointsEarned(level: number): number {
  const levels = Math.max(0, Math.floor(level) - 1);
  return STARTING_ATTRIBUTE_POINTS + ATTRIBUTE_POINTS_PER_LEVEL * levels;
}

/**
 * The budget a save should have, given what it has already placed.
 *
 * Run on login. A save that predates this spec has no `unspentAttributePoints`
 * field at all and comes back with its whole budget; a save whose allocation was
 * somehow larger than its earnings keeps the allocation and gets zero left,
 * because taking points off a character to satisfy an invariant is a worse
 * failure than a character being briefly over budget.
 */
export function reconcileAttributePoints(baseStats: BaseStats, level: number, stored: unknown): number {
  const earned = pointsEarned(level);
  const spent = pointsSpent(baseStats);
  const remaining = Math.max(0, earned - spent);
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return remaining;
  // Never *grant* points a re-derivation says are not there, and never take away
  // fewer than the arithmetic allows either: the record is the authority on what
  // has been placed, and this is the authority on what is left.
  return Math.min(Math.max(0, Math.floor(stored)), remaining);
}

export type AttributeRejection =
  | 'unknownAttribute'
  | 'noPointsAvailable'
  | 'atHardCap'
  | 'nothingToRespec'
  | 'cannotAfford';

export type AttributeValidation =
  | { readonly ok: true; readonly key: AttributeKey }
  | { readonly ok: false; readonly reason: AttributeRejection; readonly detail: string };

/**
 * Whether one more point may go into `key`, and why not if it may not.
 *
 * Split out from {@link allocateAttributePoint} so the client's read model can
 * ask the same question without pretending to spend anything -- the trick
 * `character-model.ts` already plays with `validateSkillSpend`, which is what
 * makes a greyed-out button and a server refusal incapable of disagreeing.
 *
 * Takes the fields it reads rather than a whole `PersistedPlayer`, so the client
 * can ask it about the fragment of a record it actually has.
 */
export function validateAttributeSpend(
  player: Pick<PersistedPlayer, 'baseStats' | 'unspentAttributePoints'>,
  key: string,
): AttributeValidation {
  if (!isAttributeKey(key)) {
    return { ok: false, reason: 'unknownAttribute', detail: `no such attribute: ${key}` };
  }
  if (player.unspentAttributePoints <= 0) {
    return { ok: false, reason: 'noPointsAvailable', detail: 'no unspent attribute points' };
  }
  if (player.baseStats[key] >= ATTRIBUTE_HARD_CAP) {
    const name = attributeByKey(key)?.name ?? key;
    return {
      ok: false,
      reason: 'atHardCap',
      detail: `${name} is already at its maximum of ${ATTRIBUTE_HARD_CAP}`,
    };
  }
  return { ok: true, key };
}

export type AttributeSpendResult =
  | { readonly ok: true; readonly player: PersistedPlayer; readonly key: AttributeKey }
  | { readonly ok: false; readonly reason: AttributeRejection; readonly detail: string };

/** Spends one point, returning a *new* record. On rejection nothing changes. */
export function allocateAttributePoint(player: PersistedPlayer, key: string): AttributeSpendResult {
  const validation = validateAttributeSpend(player, key);
  if (!validation.ok) return validation;
  return {
    ok: true,
    key: validation.key,
    player: {
      ...player,
      baseStats: { ...player.baseStats, [validation.key]: player.baseStats[validation.key] + 1 },
      unspentAttributePoints: player.unspentAttributePoints - 1,
    },
  };
}

export type RespecResult =
  | { readonly ok: true; readonly player: PersistedPlayer; readonly refunded: number }
  | { readonly ok: false; readonly reason: AttributeRejection; readonly detail: string };

/**
 * Hands every allocated point back, for coins.
 *
 * Not free, and cheap. The brief wants unusual builds discovered rather than
 * theorised, which argues for a low price; a price of zero would make the
 * allocation meaningless, since every fight could be entered with the perfect
 * spread. Forty coins against a starting purse of sixty is "you can do this, and
 * not before every pull".
 *
 * Only `baseStats` is touched. Stat skills are *not* refunded here: their gate
 * is an attribute threshold, so a respec can leave a character holding a skill
 * they could no longer take. That is deliberate -- `sanitizeStatSkills` drops
 * exactly those on the next recalculation, and doing it in one place means a
 * table edit and a respec cannot disagree about what happens.
 */
export function respecAttributes(player: PersistedPlayer): RespecResult {
  const refunded = pointsSpent(player.baseStats);
  if (refunded <= 0) {
    return { ok: false, reason: 'nothingToRespec', detail: 'nothing has been allocated' };
  }
  if (player.coins < RESPEC_COST) {
    return {
      ok: false,
      reason: 'cannotAfford',
      detail: `a respec costs ${RESPEC_COST} coins, you have ${player.coins}`,
    };
  }
  return {
    ok: true,
    refunded,
    player: {
      ...player,
      baseStats: startingBaseStats(),
      unspentAttributePoints: player.unspentAttributePoints + refunded,
      coins: player.coins - RESPEC_COST,
    },
  };
}
