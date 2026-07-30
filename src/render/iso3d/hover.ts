import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';

/**
 * Which unit the cursor is over (spec 039).
 *
 * A unit is hovered by pointing at either half of what you see of it:
 *
 * - its **model**, found by raycasting the rigs' meshes. A unit is drawn *above*
 *   the ground point it stands on, so a ground test alone would never light up
 *   when you pointed at the body -- the thing you are actually pointing at. The
 *   raycast also settles overlap for free: whichever model is in front wins.
 * - the **ground it stands on**, its footprint. The models are small at the
 *   game's zoom (a foot is well under a pixel), so the base makes the target
 *   forgiving instead of pixel-exact, the way a MOBA's selection volume does.
 *
 * Cosmetic only. Nothing here reads or changes sim state; the scene uses the
 * result to toggle a white outline.
 */

/** The player's id in a hover pick (enemy ids are non-negative). */
export const HOVER_PLAYER_ID = -1;

export interface HoverTarget {
  /** Stable identity: the enemy's id, or HOVER_PLAYER_ID for the player. */
  readonly id: number;
  /** The unit's rig group; its whole subtree is tested. */
  readonly object: THREE.Object3D;
  /** Where the unit stands, for the footprint fallback. */
  readonly position: Vec2;
  /** The unit's footprint radius, in world units. */
  readonly radius: number;
}

/**
 * True for a mesh the cursor can pick up. Only the lit (flat-shaded Lambert)
 * body meshes count -- the same rule the outline builder uses -- so the unlit
 * ground decals a rig carries (its heading arrow) and the outline shells
 * themselves are not part of the unit's hover shape.
 */
function isHoverable(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh) || object.userData.isOutline === true) return false;
  const material = object.material;
  return !Array.isArray(material) && material instanceof THREE.MeshLambertMaterial;
}

/**
 * The id of the unit under the cursor, or null when it is over none of them.
 * `raycaster` is set from the cursor and camera by the caller; `groundCursor` is
 * the same cursor projected onto the ground (which the scene already computes
 * for move orders), and null when the cursor is off the game window.
 *
 * A model hit always wins over a footprint hit -- pointing at a unit standing
 * behind another one's base picks the one you can see.
 */
export function pickHoveredUnit(
  raycaster: THREE.Raycaster,
  targets: readonly HoverTarget[],
  groundCursor: Vec2 | null,
): number | null {
  let bestId: number | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    // Hits come back sorted by distance, so the first hoverable one settles this
    // unit; whichever unit's nearest hit is closest to the camera wins overall.
    for (const hit of raycaster.intersectObject(target.object, true)) {
      if (!isHoverable(hit.object)) continue;
      if (hit.distance < bestDistance) {
        bestId = target.id;
        bestDistance = hit.distance;
      }
      break;
    }
  }
  return bestId ?? pickFootprint(groundCursor, targets);
}

/** Nearest unit whose ground footprint holds the cursor; null for empty ground. */
function pickFootprint(cursor: Vec2 | null, targets: readonly HoverTarget[]): number | null {
  if (!cursor) return null;
  let bestId: number | null = null;
  let bestDistSq = Infinity;
  for (const target of targets) {
    const dx = target.position.x - cursor.x;
    const dy = target.position.y - cursor.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > target.radius * target.radius || distSq >= bestDistSq) continue;
    bestId = target.id;
    bestDistSq = distSq;
  }
  return bestId;
}
