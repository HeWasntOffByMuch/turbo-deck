/**
 * The shared geometry vocabulary (spec 062).
 *
 * What is left of the single-player sim's types after the card economy and its
 * perfect-parry combat were deleted: the shapes a body and a wall occupy, which
 * `src/terrain/` produces and `src/server/` collides against. No game rules, no
 * player state, no combat -- all of that lives on the server now, in exactly one
 * implementation.
 */

import type { ColliderIndex } from './collider-index.js';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle; the arena's hand-authored barricades (spec 037). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Circular footprint; what a tree or a bush blocks on the ground (spec 044). */
export interface Circle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/**
 * Everything static a unit can run into, and how far out the world goes (spec
 * 044). Built once per run and handed to whatever is simulating, never read
 * from a module-level singleton, so a run stays a pure function of its inputs.
 */
export interface WorldColliders {
  /**
   * The outer edge of the walkable world -- the extent of the ground that
   * exists. This is not the play area: units may walk right out of it.
   */
  readonly bounds: Rect;
  /** The arena's static walls. */
  readonly rects: readonly Rect[];
  /** Vegetation footprints (spec 044): trees and bushes block like walls do. */
  readonly circles: readonly Circle[];
  /**
   * Where those circles are (spec 189), so nothing has to walk all of them.
   *
   * Required rather than optional, and filled by `createWorldColliders` rather
   * than by callers: an absent index would mean a silent fall back to the linear
   * walk this exists to delete, which is the regression coming back with nothing
   * to notice it. Plain data, so it survives the `postMessage` that carries a
   * `WorldColliders` off the map worker.
   */
  readonly index: ColliderIndex;
}
