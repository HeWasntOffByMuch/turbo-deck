/**
 * The one currency skills and items are both denominated in (spec 056).
 *
 * A modifier is a flat bundle of additions plus a few percentages. Everything a
 * definition table can say about a character says it here, which is what keeps
 * {@link import('../player/stats.js').computeEffectiveStats} a single pass over
 * a list rather than a special case per content type.
 */

export interface StatModifier {
  // --- grants of the base stats themselves ---
  readonly strength?: number;
  readonly dexterity?: number;
  readonly intelligence?: number;
  readonly vitality?: number;
  // --- flat additions to derived stats ---
  readonly maxHealth?: number;
  readonly moveSpeed?: number;
  readonly turnRate?: number;
  readonly attackDamage?: number;
  readonly attackRange?: number;
  /** Negative shortens the swing; the result is floored at 1 tick. */
  readonly attackCooldownTicks?: number;
  readonly armor?: number;
  readonly spellPower?: number;
  readonly critChance?: number;
  readonly maxResource?: number;
  readonly resourceRegen?: number;
  // --- percentages, applied after every flat addition ---
  readonly maxHealthPct?: number;
  readonly moveSpeedPct?: number;
  readonly attackDamagePct?: number;
}

export const EMPTY_MODIFIER: StatModifier = {};

/** Every modifier field, resolved to a number -- the shape a sum comes out as. */
export type ModifierTotals = { -readonly [K in keyof Required<StatModifier>]: number };

/** Sums a list of modifiers field-wise. Scaling by skill level happens upstream. */
export function sumModifiers(modifiers: readonly StatModifier[]): Readonly<ModifierTotals> {
  const total: ModifierTotals = {
    strength: 0,
    dexterity: 0,
    intelligence: 0,
    vitality: 0,
    maxHealth: 0,
    moveSpeed: 0,
    turnRate: 0,
    attackDamage: 0,
    attackRange: 0,
    attackCooldownTicks: 0,
    armor: 0,
    spellPower: 0,
    critChance: 0,
    maxResource: 0,
    resourceRegen: 0,
    maxHealthPct: 0,
    moveSpeedPct: 0,
    attackDamagePct: 0,
  };
  for (const modifier of modifiers) {
    for (const key of Object.keys(total) as (keyof ModifierTotals)[]) {
      total[key] += modifier[key] ?? 0;
    }
  }
  return total;
}

/** A modifier with every field multiplied by `factor` -- one skill level's worth times its level. */
export function scaleModifier(modifier: StatModifier, factor: number): StatModifier {
  const scaled: Record<string, number> = {};
  for (const [key, value] of Object.entries(modifier)) {
    if (typeof value === 'number') scaled[key] = value * factor;
  }
  return scaled as StatModifier;
}
