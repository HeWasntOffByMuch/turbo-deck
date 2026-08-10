/**
 * Game events to effect ids (spec 120).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed plain facts and
 * returns what to play, which is the same discipline `unit-driver.ts` follows so
 * that animation has nothing it *could* call.
 *
 * ## The one rule
 *
 * This module may read game state and may not change it. No `if` in here affects
 * a game outcome; every one of them affects only which effect is drawn. That is
 * the standing rule for `src/render/`, and here it is the whole contract -- the
 * decision the server already made arrives as a `CombatResult`, and this decides
 * what it looks like.
 *
 * ## Why a table and not a switch at the call site
 *
 * The call site says `vfx.play(request.id, request)` and knows nothing else.
 * Adding an effect for a new damage type is an entry in {@link DAMAGE_EFFECTS};
 * adding one for a new ability is a row in the ability table. Neither is a change
 * here, which is the acceptance criterion the whole arc is built around.
 */

/** The damage-type language from `docs/vfx-plan.md` section 6. */
export type DamageType = 'physical' | 'fire' | 'poison' | 'ice' | 'lightning' | 'arcane';

/** What one blow asks to be drawn. */
export interface PlayRequest {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians about Y: the direction the blow travelled. */
  readonly rotation: number;
  readonly scale: number;
  readonly seed: number;
}

/** Everything this needs to know about a blow. Facts, not objects. */
export interface CombatFacts {
  readonly attackerId: number;
  readonly targetId: number;
  readonly damage: number;
  readonly killed: boolean;
  readonly critical: boolean;
  readonly blocked: boolean;
  /**
   * Derived client-side from the ability or weapon, the way `ProjectileLook`
   * already is (`server/data/abilities.ts`). `CombatResultMessage` carries no
   * damage type and does not need to -- the tables are shared code.
   */
  readonly damageType: DamageType;
  /** Where the blow landed. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Where it came from, so the spray is thrown away from the attacker. */
  readonly fromX: number;
  readonly fromZ: number;
  /** Whether this target bleeds. A construct throws sparks instead. */
  readonly bleeds: boolean;
}

/** The impact effect for each damage type. Absent entries fall back to physical. */
export const DAMAGE_EFFECTS: Record<DamageType, string> = {
  physical: 'hit_metal_spark',
  fire: 'hit_metal_spark',
  poison: 'hit_metal_spark',
  ice: 'hit_metal_spark',
  lightning: 'hit_metal_spark',
  arcane: 'hit_metal_spark',
};

/**
 * A seed that is a function of *where and when*, not of the client.
 *
 * Two players watching the same blow see the same spatter, which matters more
 * than it sounds: the stains it leaves persist, so a seed drawn locally would
 * give two people permanently different ground.
 */
export function blowSeed(facts: CombatFacts, tick: number): number {
  const x = Math.round(facts.x) | 0;
  const z = Math.round(facts.z) | 0;
  return (Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(tick, 83492791) ^ facts.targetId) | 0;
}

/**
 * What to play for one blow. Zero, one or two requests.
 *
 * Never more than two: an impact and, on a killing blow, the death. A blow that
 * spawned a handful of effects would be a blow that costs a handful of the
 * budget, and the budget is spent per-blow by the people fighting.
 */
export function effectsForBlow(facts: CombatFacts, tick: number): readonly PlayRequest[] {
  const out: PlayRequest[] = [];
  const seed = blowSeed(facts, tick);

  // Away from the attacker: a hit from the left throws to the right. Falls back
  // to a fixed bearing when the two are stacked, which happens at point-blank.
  const dx = facts.x - facts.fromX;
  const dz = facts.z - facts.fromZ;
  const rotation = dx * dx + dz * dz > 1e-3 ? Math.atan2(dz, dx) : 0;

  // A crit is the same language, louder -- never a different one.
  const scale = (facts.critical ? 1.45 : 1) * (facts.blocked ? 0.7 : 1);

  if (facts.bleeds && !facts.blocked) {
    out.push({
      id: facts.killed ? 'death_blood' : 'hit_blood',
      x: facts.x,
      y: facts.y,
      z: facts.z,
      rotation,
      scale,
      seed,
    });
  }

  // The impact itself: sparks on a block or on something that does not bleed.
  if (facts.blocked || !facts.bleeds) {
    out.push({
      id: DAMAGE_EFFECTS[facts.damageType] ?? DAMAGE_EFFECTS.physical,
      x: facts.x,
      y: facts.y,
      z: facts.z,
      rotation,
      scale,
      // Offset so the two effects of one blow do not draw the same numbers.
      seed: (seed ^ 0x5bd1e995) | 0,
    });
  }

  return out;
}
