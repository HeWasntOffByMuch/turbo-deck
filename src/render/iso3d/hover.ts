import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';

/**
 * Which unit the cursor is over (spec 041, widened by spec 071, narrowed back
 * to the unit itself by spec 095).
 *
 * A unit's target area is the unit: its body, and the patch of ground it is
 * standing on. Nothing else. That sounds obvious and it is a reversal -- spec
 * 071 padded the footprint by twelve world units and snapped to anything within
 * twenty-two pixels of a body's drawn box, on the theory that the question is
 * "which unit did the player mean" rather than "which pixel is under the
 * cursor". The theory was right and the price was wrong: the view asks for a
 * pick *before* it falls back to a move order, so every unit of forgiveness is
 * ground the player can no longer walk to. Two monsters a stride apart had
 * touching aprons, and the gap between them -- which the sim will happily walk
 * through, since nothing there collides one entity against another -- could not
 * be ordered.
 *
 * So two tests, and neither is measured in pixels:
 *
 *  1. **its body** -- the nearer of two world-space hits: the rig's meshes, and
 *     the vertical cylinder of {@link HoverTarget.radius} by
 *     {@link HoverTarget.height} standing on its feet. The meshes are exact and
 *     catch whatever sticks out; the cylinder fills them in, which is what
 *     answers spec 071's real complaint -- a ray aimed squarely at a spider
 *     slips between its legs, and the space between a unit's legs is inside the
 *     unit. Both are depth-ordered, so two overlapping bodies settle by which
 *     one is in front, which a screen-space box never could.
 *  2. **the ground it stands on** -- its footprint, at exactly its radius. The
 *     patch of earth a unit occupies belongs to it; the patch beside that one
 *     does not.
 *
 * Cosmetic in the strict sense -- nothing here reads or changes sim state. The
 * scene uses the result to brighten a rig, and the view uses the same answer to
 * decide what a right-click attacks, which is *why* the highlight has to come
 * from this function and not from a second, looser one: what lights up must be
 * what a click would hit.
 */

/** The player's id in a hover pick (enemy ids are non-negative). */
export const HOVER_PLAYER_ID = -1;

export interface HoverTarget {
  /** Stable identity: the enemy's id, or HOVER_PLAYER_ID for the player. */
  readonly id: number;
  /** The unit's rig group; its whole subtree is tested. */
  readonly object: THREE.Object3D;
  /** Where the unit stands, world XZ. */
  readonly position: Vec2;
  /** The unit's footprint radius, in world units. */
  readonly radius: number;
  /** The ground height under its feet, world Y. */
  readonly base: number;
  /** How tall its body stands above {@link base}, in world units. */
  readonly height: number;
}

/**
 * True for a mesh the cursor can pick up. Only the lit (flat-shaded Lambert)
 * body meshes count, so the unlit ground decals a rig carries -- its heading
 * arrow -- are not part of the unit's hover shape. A block wearing more than one
 * coat role arrives as an array of materials and is body just the same.
 */
function isHoverable(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh)) return false;
  const material = object.material;
  return Array.isArray(material)
    ? material.some((entry) => entry instanceof THREE.MeshLambertMaterial)
    : material instanceof THREE.MeshLambertMaterial;
}

/**
 * The id of the unit the cursor is asking for, or null when it is asking for
 * bare ground.
 *
 * `raycaster` is set from the cursor and camera by the caller; `groundCursor` is
 * the same cursor projected onto the ground, which the scene already computes
 * for move orders, and may be null when nothing was hit.
 */
export function pickHoveredUnit(
  raycaster: THREE.Raycaster,
  targets: readonly HoverTarget[],
  groundCursor: Vec2 | null,
): number | null {
  return pickBody(raycaster, targets) ?? pickFootprint(groundCursor, targets);
}

/** The nearest unit whose body -- meshes or volume -- the ray enters. */
function pickBody(raycaster: THREE.Raycaster, targets: readonly HoverTarget[]): number | null {
  let bestId: number | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = bodyDistance(raycaster, target);
    if (distance === null || distance >= bestDistance) continue;
    bestId = target.id;
    bestDistance = distance;
  }
  return bestId;
}

/** How far along the ray this unit's body begins, or null when it is missed. */
function bodyDistance(raycaster: THREE.Raycaster, target: HoverTarget): number | null {
  const volume = rayBodyDistance(raycaster.ray, target);
  // Hits come back sorted by distance, so the first hoverable one settles the
  // meshes; a part sticking out past the cylinder is picked up here.
  let mesh: number | null = null;
  for (const hit of raycaster.intersectObject(target.object, true)) {
    if (!isHoverable(hit.object)) continue;
    mesh = hit.distance;
    break;
  }
  if (volume === null) return mesh;
  return mesh === null ? volume : Math.min(volume, mesh);
}

/**
 * Where `ray` enters a unit's body volume, or null when it misses.
 *
 * The volume is the upright cylinder the unit stands in: its footprint swept up
 * to the top of its head. A ray that starts inside it enters at zero; one whose
 * only crossing is behind the origin misses.
 */
export function rayBodyDistance(ray: THREE.Ray, target: HoverTarget): number | null {
  const { origin, direction } = ray;
  const top = target.base + target.height;
  if (target.height <= 0 || target.radius <= 0) return null;

  // The side wall: a circle in XZ, so the quadratic ignores Y entirely.
  const ox = origin.x - target.position.x;
  const oz = origin.z - target.position.y;
  const a = direction.x * direction.x + direction.z * direction.z;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox * ox + oz * oz - target.radius * target.radius;

  let enter = -Infinity;
  let exit = Infinity;
  if (a <= 1e-12) {
    // Straight up or down: either the ray is inside the circle for its whole
    // length or it never is.
    if (c > 0) return null;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    enter = (-b - root) / (2 * a);
    exit = (-b + root) / (2 * a);
  }

  // The caps, as a slab in Y.
  if (Math.abs(direction.y) <= 1e-12) {
    if (origin.y < target.base || origin.y > top) return null;
  } else {
    const first = (target.base - origin.y) / direction.y;
    const second = (top - origin.y) / direction.y;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }

  if (enter > exit || exit < 0) return null;
  return Math.max(enter, 0);
}

/** The nearest unit whose ground footprint holds the cursor. */
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
