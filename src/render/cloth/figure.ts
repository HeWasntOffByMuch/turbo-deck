/**
 * The robed figure's proportions, bone layout and collision capsules (spec 046),
 * kept pure and three.js-free because three very different consumers need the
 * same numbers: the skeleton in `iso3d/humanoid.ts` builds its bone hierarchy
 * and colliders from them, the cloth patterns in `geometry.ts` cut the garments
 * to fit them, and `figure.test.ts` checks the two agree.
 *
 * ## The one invariant that matters here
 *
 * **Every garment must be cut outside every body capsule it can collide with.**
 * A garment born inside a capsule is pushed out on every frame of its life,
 * against its own distance constraints, which shows up as fabric that is
 * permanently inflated and permanently strained -- and it is invisible in the
 * shaded render, because inflated cloth still looks like cloth. That is the
 * whole reason the capsules live here next to the patterns rather than in the
 * three.js rig, and why {@link FigureMetrics.drapeClearance} is a named field
 * instead of a scattering of magic numbers: the garments are cut at
 * `<body radius> + drapeClearance`, and `drapeClearance` is required to exceed
 * the default `collisionRadius`.
 *
 * Coordinate frame: **character-local, standing at the origin, facing +x, up
 * +y**, matching every other rig in the isometric scene. With a right-handed
 * basis that puts the figure's left at -z and its right at +z. All distances are
 * world units at `bodyScale == 1`; the whole figure is uniformly scaled at
 * runtime, so no other module needs to know about the scale factor.
 */

/** Collider mask bits, re-exported from the solver's side of the fence. */
import { MASK } from './colliders.js';

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

/** Skeleton dimensions and collider radii, in world units at `bodyScale == 1`. */
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
  /** Head centre height (the skull the hood drapes over). */
  readonly headY: number;
  readonly upperArmLen: number;
  readonly forearmLen: number;
  readonly thighLen: number;
  readonly shinLen: number;
  /** Ankle height (the foot bone's origin). */
  readonly ankleY: number;

  // --- Collider radii -----------------------------------------------------
  // A capsule is round, so each of these is the *smallest* half-extent of the
  // body part it stands for. A torso is wider than it is deep, and using its
  // width here would hold the cape a hand's breadth off the spine.
  readonly headRadius: number;
  readonly torsoRadius: number;
  readonly hipRadius: number;
  readonly thighRadius: number;
  readonly shinRadius: number;
  readonly upperArmRadius: number;
  readonly forearmRadius: number;

  /**
   * How far outside the body capsules the garments are cut. **Must exceed the
   * default `collisionRadius`**, or the cloth starts inside the body and is
   * shoved out against its own constraints forever (see the note above).
   */
  readonly drapeClearance: number;
}

/**
 * The one figure the game currently has: a ~82-unit-tall humanoid, which reads
 * as a 1.9 m adult next to the scene's 86-unit trees. Deliberately a little
 * broad-shouldered -- it is wearing a mantled hood, and the silhouette is most
 * of the character.
 */
export const FIGURE: FigureMetrics = {
  hipY: 40,
  hipHalf: 5.5,
  waistY: 46,
  chestY: 57,
  shoulderY: 63,
  shoulderHalf: 13,
  neckY: 67,
  headY: 74,
  upperArmLen: 17,
  forearmLen: 16,
  thighLen: 19,
  shinLen: 17.5,
  ankleY: 3.5,

  headRadius: 7,
  torsoRadius: 6.4,
  hipRadius: 6.8,
  thighRadius: 4,
  shinRadius: 3.6,
  upperArmRadius: 3.4,
  forearmRadius: 3,

  drapeClearance: 2.6,
};

/** One bone's rest placement: its parent and its offset from that parent. */
export interface BoneRest {
  readonly bone: number;
  /** Parent bone index, or -1 for a root parented straight to the figure. */
  readonly parent: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The skeleton's rest layout, parent-relative. The three.js rig builds its
 * hierarchy from this and the clearance test walks it to recover bind-pose world
 * positions -- so there is exactly one description of where the bones are.
 */
export function boneRestLayout(f: FigureMetrics): readonly BoneRest[] {
  return [
    { bone: BONE.pelvis, parent: -1, x: 0, y: f.hipY, z: 0 },
    { bone: BONE.chest, parent: BONE.pelvis, x: 0, y: f.chestY - f.hipY, z: 0 },
    { bone: BONE.head, parent: BONE.chest, x: 0, y: f.neckY - f.chestY, z: 0 },
    { bone: BONE.upperArmL, parent: BONE.chest, x: 0, y: f.shoulderY - f.chestY, z: -f.shoulderHalf },
    { bone: BONE.forearmL, parent: BONE.upperArmL, x: 0, y: -f.upperArmLen, z: 0 },
    { bone: BONE.upperArmR, parent: BONE.chest, x: 0, y: f.shoulderY - f.chestY, z: f.shoulderHalf },
    { bone: BONE.forearmR, parent: BONE.upperArmR, x: 0, y: -f.upperArmLen, z: 0 },
    { bone: BONE.thighL, parent: BONE.pelvis, x: 0, y: 0, z: -f.hipHalf },
    { bone: BONE.shinL, parent: BONE.thighL, x: 0, y: -f.thighLen, z: 0 },
    { bone: BONE.thighR, parent: BONE.pelvis, x: 0, y: 0, z: f.hipHalf },
    { bone: BONE.shinR, parent: BONE.thighR, x: 0, y: -f.thighLen, z: 0 },
  ];
}

/** One collision capsule: a bone plus two bone-local endpoints and a radius. */
export interface CapsuleDef {
  readonly name: string;
  readonly bone: number;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly radius: number;
  readonly mask: number;
}

/**
 * The body's collision capsules, in bone-local coordinates at scale 1.
 *
 * The masks are what keep this cheap *and* what keep it correct: the lower robe
 * never tests the arms, and -- importantly -- the **sleeves do not test the
 * torso**. Arms hang against the ribs, so a sleeve's inner face is always within
 * a round torso capsule's radius; testing it would shove both sleeves
 * permanently outward. The arms only swing fore and aft and are splayed a little
 * off the ribs, so nothing needs that test.
 */
export function buildCapsuleDefs(f: FigureMetrics): readonly CapsuleDef[] {
  const headLocal = f.headY - f.neckY;
  return [
    // Skull: what the hood drapes over.
    {
      name: 'head',
      bone: BONE.head,
      ax: 0,
      ay: headLocal - 2,
      az: 0,
      // Only just past the skull's centre: a capsule that runs higher than the
      // head mesh pushes the cowl's crown up off the head and leaves daylight
      // under it, which reads instantly as a hood that is not being worn.
      bx: 0,
      by: headLocal + 0.5,
      bz: 0,
      radius: f.headRadius,
      mask: MASK.head,
    },
    // Torso and hips: what the cape, the hood's tail and the lower robe rest on.
    // The pelvis capsule is vertical, not a lateral bar: a bar spanning the hip
    // joints has the capsule radius added at *both* ends, which makes the hips
    // half again as wide as the waist the robe is gathered at.
    {
      name: 'torso',
      bone: BONE.chest,
      ax: 0,
      ay: f.waistY - f.chestY,
      az: 0,
      bx: 0,
      by: f.shoulderY - f.chestY,
      bz: 0,
      radius: f.torsoRadius,
      mask: MASK.torso,
    },
    {
      name: 'pelvis',
      bone: BONE.pelvis,
      ax: 0,
      ay: -4,
      az: 0,
      bx: 0,
      by: 1,
      bz: 0,
      radius: f.hipRadius,
      mask: MASK.torso | MASK.legs,
    },
    // Arms: each sleeve only sees its own side.
    {
      name: 'upperArmL',
      bone: BONE.upperArmL,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.upperArmLen,
      bz: 0,
      radius: f.upperArmRadius,
      mask: MASK.armL,
    },
    {
      name: 'forearmL',
      bone: BONE.forearmL,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.forearmLen,
      bz: 0,
      radius: f.forearmRadius,
      mask: MASK.armL,
    },
    {
      name: 'upperArmR',
      bone: BONE.upperArmR,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.upperArmLen,
      bz: 0,
      radius: f.upperArmRadius,
      mask: MASK.armR,
    },
    {
      name: 'forearmR',
      bone: BONE.forearmR,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.forearmLen,
      bz: 0,
      radius: f.forearmRadius,
      mask: MASK.armR,
    },
    // Legs: what sweeps the lower robe aside as the figure walks.
    {
      name: 'thighL',
      bone: BONE.thighL,
      ax: 0,
      // Starts below the hip joint: up at the joint itself it would fight the
      // waist ring, and the pelvis capsule already covers that region.
      ay: -3,
      az: 0,
      bx: 0,
      by: -f.thighLen,
      bz: 0,
      radius: f.thighRadius,
      mask: MASK.legs,
    },
    {
      name: 'shinL',
      bone: BONE.shinL,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.shinLen,
      bz: 0,
      radius: f.shinRadius,
      mask: MASK.legs,
    },
    {
      name: 'thighR',
      bone: BONE.thighR,
      ax: 0,
      ay: -3,
      az: 0,
      bx: 0,
      by: -f.thighLen,
      bz: 0,
      radius: f.thighRadius,
      mask: MASK.legs,
    },
    {
      name: 'shinR',
      bone: BONE.shinR,
      ax: 0,
      ay: 0,
      az: 0,
      bx: 0,
      by: -f.shinLen,
      bz: 0,
      radius: f.shinRadius,
      mask: MASK.legs,
    },
  ];
}
