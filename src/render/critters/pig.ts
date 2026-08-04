/**
 * The pig (spec 049).
 *
 * A pear-shaped body on short legs, a big round head that is nearly a third of
 * the silhouette, a blunt forward snout and two triangular ears that flop with
 * the walk. At 64 px what survives is exactly three things -- the round mass,
 * the ears, and the pale disc of the snout -- so those three carry the whole
 * read and everything else is there to support them.
 *
 * This file is *only* numbers. There is no pig-specific rendering code anywhere:
 * the blocks come from `body.ts`, the walk comes from the shared skeleton, and
 * the colours come from whichever coat the player picked.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { barrelTorso, bipedArms, bipedLegs, earPair, eyes, muzzle, neck } from './body.js';
import type { CritterSpecies, PartSpec, SocketSpec } from './types.js';

/**
 * Pig proportions. Stands ~86 units to the ear tips, matching the scene's trees
 * and standing a little shorter and a lot rounder than the 82-unit robed figure.
 *
 * `hipY` is the sum of `ankleY + shinLen + thighLen`: the skeleton hangs the legs
 * off the pelvis, so if those disagree the feet float or sink.
 */
const PIG_FIGURE: FigureMetrics = {
  hipY: 26,
  hipHalf: 9,
  waistY: 33,
  chestY: 43,
  shoulderY: 49,
  // Wide, so the arms hang *outside* the barrel rather than sinking into it.
  shoulderHalf: 15,
  neckY: 53,
  headY: 64,
  upperArmLen: 11,
  forearmLen: 10,
  thighLen: 12.5,
  shinLen: 10.5,
  ankleY: 3,

  headRadius: 12,
  torsoRadius: 16,
  hipRadius: 12,
  thighRadius: 5.5,
  shinRadius: 4.6,
  upperArmRadius: 2.8,
  forearmRadius: 2.5,

  drapeClearance: 2.6,
};

const SOCKETS: readonly SocketSpec[] = [
  {
    // Set high and well back on the skull, tipped out and slightly forward.
    socket: 'ear',
    parentBone: BONE.head,
    pos: [-2, 13.5, -8.5],
    // rx splays the ear outward (mirrored on the right); rz tips it forward
    // (shared, so both ears lean the same way -- a negative z tips them forward
    // over the eyes). Splayed hard: a pig's ears are broad flaps held out to the
    // sides, and anything closer to vertical reads as a horn at 64 px.
    rot: [-1.05, 0, -0.25],
    mirror: true,
    wobble: {
      axis: 'x',
      strideAmp: 0.16,
      idleAmp: 0.06,
      idleHz: 0.42,
      leanAmp: 0.3,
      follow: 9,
    },
  },
  {
    // The curly tail, held high off the rump.
    socket: 'tail',
    parentBone: BONE.pelvis,
    pos: [-9, 5, 0],
    rot: [0, 0, 0.85],
    wobble: {
      axis: 'y',
      strideAmp: 0.42,
      phase: 0.25,
      idleAmp: 0.16,
      idleHz: 0.55,
      leanAmp: 0.9,
      follow: 7,
    },
  },
];

const PARTS: readonly PartSpec[] = [
  ...barrelTorso(PIG_FIGURE, {
    belly: [34, 30, 29],
    chest: [23, 20, 22],
    bellyDrop: 7,
    chestRise: 5,
  }),
  neck(PIG_FIGURE, 17, 16),
  ...bipedArms(PIG_FIGURE, { thickness: 5.6, hand: [4.6, 4.6, 4.6], handRole: 'coatShade' }),
  ...bipedLegs(PIG_FIGURE, { thigh: 11, shin: 9, foot: [7.5, 4, 6] }),

  // --- Head ---------------------------------------------------------------
  {
    name: 'skull',
    attach: BONE.head,
    shape: 'ball',
    role: 'coat',
    size: [23, 24, 25],
    pos: [0, 11, 0],
  },
  // The cheeks: what makes it read as a pig's head rather than a sphere.
  {
    name: 'cheek',
    attach: BONE.head,
    shape: 'ball',
    role: 'coatLight',
    size: [15, 12, 10],
    pos: [4, 8, -7],
    mirror: true,
  },
  // Short and broad, blending into the cheeks rather than jutting: a long
  // snout on a head this round reads as a snout held in front of the face.
  ...muzzle({
    at: [5, 7, 0],
    length: 8,
    width: 11,
    height: 9,
    padDepth: 3.6,
    padFlare: 1.28,
    nostril: [3, 3.6, 3],
    nostrilSpread: 3,
    taper: 0.9,
  }),
  eyes({ at: [8.5, 14.5, -6], size: [3.2, 4.4, 3.2] }),
  ...earPair('ear', { length: 9, width: 16, thickness: 5 }),

  // --- Tail ---------------------------------------------------------------
  // Two stubby segments angled against each other read as a curl from any
  // direction, which a real spiral does not at this size.
  {
    name: 'tailBase',
    attach: 'tail',
    shape: 'cone',
    role: 'coat',
    taper: 0.55,
    facets: 5,
    size: [4.5, 7, 4.5],
    pos: [0, 3.5, 0],
  },
  {
    name: 'tailCurl',
    attach: 'tail',
    shape: 'cone',
    role: 'coatShade',
    taper: 0.3,
    facets: 5,
    size: [3.6, 6.5, 3.6],
    pos: [-2.6, 8.4, 0],
    rot: [0, 0, -1.15],
  },
];

export const PIG: CritterSpecies = {
  id: 'pig',
  name: 'Pig',
  blurb: 'A round, short-legged pig. Big snout, floppy ears, curly tail.',
  metrics: PIG_FIGURE,
  sockets: SOCKETS,
  parts: PARTS,
  defaultCoat: 0xd98f91,
  accents: {
    // A deeper, pinker version of the coat reads as bare skin on any colour.
    skin: 0xe8a9a0,
    skinDeep: 0x7a4a4c,
    marking: 0x6b4a52,
    hoof: 0x6b4a44,
    eye: 0x14121a,
  },
};
