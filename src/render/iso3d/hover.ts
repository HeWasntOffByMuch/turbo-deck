import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';

/**
 * Which unit the cursor is over (spec 041, widened by spec 071).
 *
 * The question is not "which pixel is under the cursor" but "which unit did the
 * player mean", and those stop being the same thing the moment the view is
 * zoomed out: a body twenty world units across is forty pixels at the default
 * framing and nine at the far end of the wheel, which is smaller than the mouse
 * moves while the button goes down. A pick that answers only the first question
 * is a pick that makes a fight about aiming at legs.
 *
 * So a unit is picked by four tests, in order of how sure they are. Each one is
 * a weaker claim than the one above it, and an answer from any of them stops
 * the search -- a body the cursor is genuinely on always beats one it is merely
 * near, however close the near one is:
 *
 *  1. **its model** -- the cursor is on the unit itself, found by raycasting the
 *     rigs' meshes. Exact, and it settles overlap for free: whichever model is
 *     in front wins.
 *  2. **inside its silhouette** -- the cursor is within the unit's drawn
 *     bounding box on screen, but the ray slipped through a gap in it. Between
 *     two legs, under an arm, through the hole in a spider's outline. Visually
 *     indistinguishable from (1) to the player, who is pointing straight at the
 *     thing.
 *  3. **the ground it stands on** -- its footprint, widened by
 *     {@link FOOTPRINT_PAD} into an apron of ground around the body. This is
 *     the one that makes a unit clickable by the patch of earth it occupies
 *     rather than by its silhouette.
 *  4. **near its silhouette** -- within {@link SNAP_PIXELS} of the drawn box.
 *     The forgiveness that survives zooming out, because it is measured where
 *     the aiming error is: on the screen, in pixels, not in world units.
 *
 * Cosmetic in the strict sense -- nothing here reads or changes sim state. The
 * scene uses the result to toggle a white outline, and the view uses the same
 * answer to decide what a right-click attacks, which is *why* the outline has
 * to come from this function and not from a second, tighter one.
 */

/** The player's id in a hover pick (enemy ids are non-negative). */
export const HOVER_PLAYER_ID = -1;

/**
 * How far past its body a unit's ground footprint picks it up, in world units.
 *
 * A little under a body radius. Enough that the earth immediately around a
 * unit belongs to it, and not so much that two monsters standing a stride apart
 * have overlapping aprons that make which one you get a coin flip.
 */
export const FOOTPRINT_PAD = 12;

/**
 * How far from a unit's drawn silhouette the cursor may be and still pick it,
 * in CSS pixels.
 *
 * A pixel budget rather than a world one, deliberately. Aiming error lives on
 * the screen -- it is a property of the hand and the mouse, not of the world --
 * so a fixed number of pixels is the same amount of help at every zoom, which
 * in world units means more help exactly when the target is smaller. A world
 * radius does the opposite of that.
 */
export const SNAP_PIXELS = 22;

/** A unit's drawn extent on screen, in CSS pixels within the canvas box. */
export interface ScreenBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface HoverTarget {
  /** Stable identity: the enemy's id, or HOVER_PLAYER_ID for the player. */
  readonly id: number;
  /** The unit's rig group; its whole subtree is tested. */
  readonly object: THREE.Object3D;
  /** Where the unit stands, for the footprint fallback. */
  readonly position: Vec2;
  /** The unit's footprint radius, in world units. */
  readonly radius: number;
  /**
   * Where the unit is drawn, for the two screen-space tests. Null or absent
   * when the caller has not projected it -- in which case those two tests
   * simply do not fire, and the pick is the model-and-footprint one spec 041
   * shipped.
   */
  readonly screen?: ScreenBox | null;
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
 * The id of the unit the cursor is asking for, or null when it is asking for
 * bare ground.
 *
 * `raycaster` is set from the cursor and camera by the caller; `groundCursor`
 * is the same cursor projected onto the ground (which the scene already
 * computes for move orders); `cursorPixels` is the cursor itself, in CSS pixels
 * within the canvas, and may be omitted to skip the screen-space tests.
 */
export function pickHoveredUnit(
  raycaster: THREE.Raycaster,
  targets: readonly HoverTarget[],
  groundCursor: Vec2 | null,
  cursorPixels: Vec2 | null = null,
): number | null {
  return (
    pickModel(raycaster, targets) ??
    pickSilhouette(cursorPixels, targets, 0) ??
    pickFootprint(groundCursor, targets) ??
    pickSilhouette(cursorPixels, targets, SNAP_PIXELS)
  );
}

/** The nearest unit whose model the ray actually strikes. */
function pickModel(raycaster: THREE.Raycaster, targets: readonly HoverTarget[]): number | null {
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
  return bestId;
}

/** Nearest unit whose ground footprint, plus its apron, holds the cursor. */
function pickFootprint(cursor: Vec2 | null, targets: readonly HoverTarget[]): number | null {
  if (!cursor) return null;
  let bestId: number | null = null;
  let bestDistSq = Infinity;
  for (const target of targets) {
    const dx = target.position.x - cursor.x;
    const dy = target.position.y - cursor.y;
    const distSq = dx * dx + dy * dy;
    const reach = target.radius + FOOTPRINT_PAD;
    if (distSq > reach * reach || distSq >= bestDistSq) continue;
    bestId = target.id;
    bestDistSq = distSq;
  }
  return bestId;
}

/**
 * Nearest unit whose drawn box is within `slack` pixels of the cursor.
 *
 * Called twice with different slack, which is the whole trick: at zero it means
 * "the cursor is inside the silhouette", which is as good as pointing at the
 * model and outranks the footprint; at {@link SNAP_PIXELS} it means "the cursor
 * is beside the unit", which is the last thing tried.
 */
function pickSilhouette(
  cursor: Vec2 | null,
  targets: readonly HoverTarget[],
  slack: number,
): number | null {
  if (!cursor) return null;
  let bestId: number | null = null;
  let bestDistance = Infinity;
  let bestCentre = Infinity;
  for (const target of targets) {
    const box = target.screen;
    if (!box) continue;
    const distance = distanceToBox(cursor, box);
    if (distance > slack) continue;
    // Distance to the box first, then to its middle. The second is what does
    // the work at slack 0, where every candidate is inside a box and all the
    // first can say is "yes, several": of two silhouettes the cursor is inside,
    // the one it is nearest the middle of is the one being pointed at.
    const centre = Math.hypot(
      cursor.x - (box.minX + box.maxX) / 2,
      cursor.y - (box.minY + box.maxY) / 2,
    );
    if (distance > bestDistance || (distance === bestDistance && centre >= bestCentre)) continue;
    bestId = target.id;
    bestDistance = distance;
    bestCentre = centre;
  }
  return bestId;
}

/** Pixel distance from a point to a rectangle; zero when it is inside. */
export function distanceToBox(point: Vec2, box: ScreenBox): number {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX);
  const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY);
  return Math.hypot(dx, dy);
}
