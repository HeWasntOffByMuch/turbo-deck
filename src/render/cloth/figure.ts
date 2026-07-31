/**
 * The robed figure's proportions and bone table (spec 037), kept pure and
 * three.js-free because two very different consumers need the same numbers: the
 * skeleton in `iso3d/humanoid.ts` builds its bone hierarchy from them, and the
 * cloth patterns in `geometry.ts` cut the hood/cape/robe/sleeves to fit them.
 * Keeping one source of truth is what stops the robe drifting off the body when
 * a proportion is retuned.
 *
 * Coordinate frame: **character-local, standing at the origin, facing +x, up
 * +y**, matching every other rig in the isometric scene. With a right-handed
 * basis that puts the figure's left at -z and its right at +z. All distances are
 * world units at `bodyScale == 1`; the whole figure is uniformly scaled at
 * runtime, so no other module needs to know about the scale factor.
 */

/**
 * Bone indices. The order is the array order the rig stores world matrices in,
 * so it doubles as the skinning index each cloth particle carries.
 */
export const BONE = {
  pelvis: 0,
  chest: 1,
  head: 2,
  upperArmL: 3,
  forearmL: 4,
  upperArmR: 5,
  forearmR: 6,
  thighL: 7,
  shinL: 8,
  thighR: 9,
  shinR: 10,
} as const;

export const BONE_COUNT = 11;

/** Skeleton dimensions, all in world units at `bodyScale == 1`. */
export interface FigureMetrics {
  /** Hip joint height: the pelvis bone's origin. */
  readonly hipY: number;
  /** Lateral half-spread of the hip joints. */
  readonly hipHalf: number;
  /** Waist height, where the lower robe is gathered. */
  readonly waistY: number;
  /** Chest bone origin height (the pelvis->chest bone's tip). */
  readonly chestY: number;
  /** Shoulder joint height. */
  readonly shoulderY: number;
  /** Lateral half-spread of the shoulder joints. */
  readonly shoulderHalf: number;
  /** Neck pivot height: the head bone's origin. */
  readonly neckY: number;
  /** Head centre height and radius (the skull the hood drapes over). */
  readonly headY: number;
  readonly headRadius: number;
  readonly upperArmLen: number;
  readonly forearmLen: number;
  readonly thighLen: number;
  readonly shinLen: number;
  /** Ankle height (the foot bone's origin). */
  readonly ankleY: number;
  /** Torso half-thickness front-to-back and half-width side-to-side at the chest. */
  readonly chestDepth: number;
  readonly chestWidth: number;
}

/**
 * The one figure the game currently has: a ~84-unit-tall humanoid, which reads
 * as a 1.8 m adult next to the scene's 86-unit trees.
 */
export const FIGURE: FigureMetrics = {
  hipY: 40,
  hipHalf: 6.5,
  waistY: 46,
  chestY: 57,
  shoulderY: 63,
  shoulderHalf: 11,
  neckY: 67,
  headY: 75,
  headRadius: 8.5,
  upperArmLen: 17,
  forearmLen: 16,
  thighLen: 19,
  shinLen: 17.5,
  ankleY: 3.5,
  chestDepth: 6.5,
  chestWidth: 9.5,
};
