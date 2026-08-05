/**
 * Combat geometry and feedback primitives (specs 056, 062).
 *
 * What survived the card economy's deletion: the shapes a blow occupies. The
 * decision of *when* a blow lands moved to `abilities.ts`, which is where
 * wind-ups, cancellation and cooldowns live; spec 065 took the numbers that
 * described how a blow *felt* -- hitstop and knockback -- out entirely.
 *
 * Everything here is pure and squared-comparison wherever it can be -- no square
 * roots and no trigonometry in the hot path.
 */

import { ATTACK_ARC_COS_SQ } from '../../sim/constants.js';
import type { Vec3 } from '../state/types.js';

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

