/**
 * The cow (spec 049).
 *
 * Taller and squarer than the pig, with a long muzzle, horns, ears that stick
 * out sideways rather than up, and -- the thing that actually does the work at
 * 64 px -- big dark patches. The patches are flattened balls set proud of the
 * body surface, so they read as markings from every angle without a texture, and
 * they are contrast-corrected against whatever coat the player picked, so a cow
 * in Plum is as legible as a cow in Cream.
 *
 * Same skeleton, same walk cycle, same builders as the pig. The whole difference
 * between the two animals lives in this file.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { barrelTorso, bipedArms, bipedLegs, earPair, eyes, muzzle, neck } from './body.js';
import type { CritterSpecies, PartSpec, SocketSpec } from './types.js';

/** Cow proportions: longer in the leg and the face than the pig, ~90 to the horns. */
const COW_FIGURE: FigureMetrics = {
  hipY: 30,
  hipHalf: 9,
  waistY: 37,
  chestY: 47,
  shoulderY: 54,
  shoulderHalf: 15.5,
  neckY: 58,
  headY: 69,
  upperArmLen: 12,
  forearmLen: 11,
  thighLen: 14.5,
  shinLen: 12.5,
  ankleY: 3,

  headRadius: 11.5,
  torsoRadius: 16,
  hipRadius: 12,
  thighRadius: 5.5,
  shinRadius: 4.6,
  upperArmRadius: 3,
  forearmRadius: 2.6,

  drapeClearance: 2.6,
};

const SOCKETS: readonly SocketSpec[] = [
  {
    // Cow ears sit low and stick straight out to the sides, below the horns.
    socket: 'ear',
    parentBone: BONE.head,
    pos: [-2.5, 10.5, -9],
    // Nearly horizontal: rx of -1.35 lays the left ear out along -z, which is
    // the single cue that separates a cow's head from the pig's at a glance.
    rot: [-1.35, 0, 0.06],
    mirror: true,
    wobble: {
      axis: 'x',
      strideAmp: 0.13,
      idleAmp: 0.07,
      idleHz: 0.36,
      leanAmp: 0.26,
      follow: 8,
    },
  },
  {
    // A long tail with a weighted tuft, so it trails and swings hard on a turn.
    socket: 'tail',
    parentBone: BONE.pelvis,
    pos: [-8, 6, 0],
    // The tail hangs along the socket's -y, so a negative z rotation is what
    // swings it backward rather than forward under the rump.
    rot: [0, 0, -0.42],
    wobble: {
      axis: 'y',
      strideAmp: 0.5,
      phase: 0.25,
      idleAmp: 0.2,
      idleHz: 0.4,
      leanAmp: 1.1,
      follow: 5,
    },
  },
];

const PARTS: readonly PartSpec[] = [
  // The rump is a marking rather than a shade: from behind, the dark rear *is*
  // the cow's pattern, and reusing the torso's own block for it costs nothing.
  ...barrelTorso(COW_FIGURE, {
    belly: [33, 31, 28],
    chest: [27, 22, 25],
    bellyDrop: 7.5,
    chestRise: 5.5,
    rumpRole: 'marking',
  }),
  neck(COW_FIGURE, 17, 16),
  ...bipedArms(COW_FIGURE, { thickness: 6, hand: [5, 5, 5] }),
  ...bipedLegs(COW_FIGURE, { thigh: 11.5, shin: 9.4, foot: [8, 4.6, 6.6] }),

  // --- Markings -----------------------------------------------------------
  // Balls pushed *through* the body surface, so only the cap shows: a flat spot
  // of colour that follows the curve, from any angle, with no texture and no
  // extra draw state. Two rules govern where they can go, and both were learned
  // the hard way from a render:
  //
  //  1. A patch centred inside the belly is a patch nobody ever sees. It has to
  //     protrude past the surface it sits on.
  //  2. The arms hang at `shoulderHalf` (±15.5) and the torso is only 28 deep,
  //     so there is almost no room on the flanks -- a lateral patch ends up
  //     painted across the upper arm and reads as shoulder armour. So the
  //     markings live front and back, where the arms are not.
  //
  // Deliberately asymmetric: a symmetric cow reads as a pattern, an asymmetric
  // one reads as an animal.
  {
    name: 'patchChest',
    attach: BONE.chest,
    shape: 'ball',
    role: 'marking',
    size: [9, 16, 13],
    pos: [12, -2, -5],
  },
  {
    name: 'patchHip',
    attach: BONE.pelvis,
    shape: 'ball',
    role: 'marking',
    size: [9, 13, 10],
    pos: [6, 3, -9],
  },

  // --- Head ---------------------------------------------------------------
  {
    name: 'skull',
    attach: BONE.head,
    shape: 'ball',
    role: 'coat',
    size: [21, 21, 22],
    pos: [0, 11, 0],
  },
  // The eye patch: one dark blot over one eye. The single most recognisable
  // thing on the model at 64 px, and it costs one part.
  {
    name: 'patchEye',
    attach: BONE.head,
    shape: 'ball',
    role: 'marking',
    size: [12, 13, 7],
    pos: [3, 12.5, -9],
  },
  // A pale blaze down the front of the face, opposite the patch.
  {
    name: 'blaze',
    attach: BONE.head,
    shape: 'ball',
    role: 'coatLight',
    size: [9, 13, 7],
    pos: [6, 11, 4],
  },
  // Longer and squarer than the pig's: the muzzle is most of what says "cow"
  // once the patches have done their work.
  ...muzzle({
    at: [5, 6, 0],
    length: 11,
    width: 11,
    height: 9,
    padDepth: 4,
    padFlare: 1.22,
    nostril: [3, 3.8, 3.2],
    nostrilSpread: 3,
    taper: 0.94,
  }),
  eyes({ at: [7.5, 13.5, -5.6], size: [3.2, 4.2, 3.2] }),
  // Horns: short, forward-curving nubs on the crown. Kept stubby -- long horns
  // read as antlers at this size, and they widen the silhouette past the point
  // where a unit fits its selection ring.
  {
    name: 'horn',
    attach: BONE.head,
    shape: 'cone',
    role: 'horn',
    taper: 0.2,
    facets: 5,
    size: [5.5, 11, 5.5],
    pos: [0, 18, -6],
    rot: [-0.5, 0, -0.15],
    mirror: true,
  },
  ...earPair('ear', { length: 11, width: 9, thickness: 4, shellRole: 'coatShade' }),

  // --- Udder --------------------------------------------------------------
  {
    name: 'udder',
    attach: BONE.pelvis,
    shape: 'ball',
    role: 'skin',
    size: [12, 9, 12],
    pos: [4, -2.5, 0],
  },
  {
    name: 'teat',
    attach: BONE.pelvis,
    shape: 'cone',
    role: 'skin',
    taper: 0.5,
    facets: 4,
    size: [3, 4.6, 3],
    pos: [5, -7.5, -2.8],
    rot: [0, 0, Math.PI],
    mirror: true,
  },

  // --- Tail ---------------------------------------------------------------
  {
    name: 'tailBase',
    attach: 'tail',
    shape: 'cone',
    role: 'coatShade',
    taper: 0.6,
    facets: 5,
    size: [3.8, 13, 3.8],
    pos: [0, -6.5, 0],
    rot: [0, 0, Math.PI],
  },
  {
    name: 'tailTuft',
    attach: 'tail',
    shape: 'ball',
    role: 'marking',
    size: [4.6, 7, 4.6],
    pos: [0, -14.5, 0],
  },
];

export const COW: CritterSpecies = {
  id: 'cow',
  name: 'Cow',
  blurb: 'A patched dairy cow. Long muzzle, stubby horns, ears out sideways.',
  metrics: COW_FIGURE,
  sockets: SOCKETS,
  parts: PARTS,
  defaultCoat: 0xd8b69a,
  accents: {
    skin: 0xe0a09a,
    skinDeep: 0x7a4a4c,
    // Near-black with a blue cast, matching the reference's charcoal patches.
    marking: 0x3c3a42,
    horn: 0xd6c39a,
    hoof: 0x3c3a42,
    eye: 0x14121a,
  },
};
