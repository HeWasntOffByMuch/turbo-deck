/**
 * Combat geometry and feedback primitives (specs 056, 062).
 *
 * What survived the card economy's deletion: the shapes a blow occupies and the
 * numbers that describe how it felt. The decision of *when* a blow lands moved
 * to `abilities.ts`, which is where wind-ups, cancellation and cooldowns live.
 *
 * Everything here is pure and squared-comparison wherever it can be -- no square
 * roots and no trigonometry in the hot path.
 */

import { ATTACK_ARC_COS_SQ } from '../../sim/constants.js';
import type { Vec3 } from '../state/types.js';

/** Hitstop is at least this long and grows with the fraction of health removed. */
export const MIN_HITSTOP_TICKS = 1;
export const MAX_HITSTOP_TICKS = 12;
/** Ticks of hitstop per full health bar of damage dealt in one blow. */
export const HITSTOP_TICKS_PER_HEALTH_FRACTION = 24;

/** Knockback impulse in world units per tick, before the target's resistance. */
export const KNOCKBACK_IMPULSE = 3;
export const KNOCKBACK_TICKS = 9;

/** The default cone: 0.5 == cos(45 deg)^2, a 90-degree wedge. */
export const DEFAULT_ARC_COS_SQ = ATTACK_ARC_COS_SQ;

/**
 * Whether `target` sits inside a cone from `origin` along a unit direction.
 * Squared throughout, so it is the same comparison the single-player sim made
 * before it was retired -- a swing means the same thing it always did.
 */
export function isInCone(
  origin: Vec3,
  dirX: number,
  dirY: number,
  reach: number,
  arcCosSq: number,
  target: Vec3,
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq > reach * reach) return false;
  if (distanceSq < 1e-9) return true;

  const dot = dx * dirX + dy * dirY;
  if (dot <= 0) return false;
  return (dot * dot) / distanceSq >= arcCosSq;
}

/** Longer freezes for bigger chunks of a health bar; always at least one tick. */
export function hitstopFor(damage: number, targetMaxHealth: number): number {
  if (targetMaxHealth <= 0) return MIN_HITSTOP_TICKS;
  const fraction = Math.min(1, Math.max(0, damage) / targetMaxHealth);
  const ticks = Math.round(MIN_HITSTOP_TICKS + fraction * HITSTOP_TICKS_PER_HEALTH_FRACTION);
  return Math.max(MIN_HITSTOP_TICKS, Math.min(MAX_HITSTOP_TICKS, ticks));
}
