/**
 * The pig (spec 049).
 *
 * A teardrop body on short legs -- narrow at the shoulders, widest low and
 * forward where the belly hangs, tucking back in above the knees -- a big round
 * head sitting straight on the shoulders with no neck to speak of, a blunt
 * forward snout, and two broad ears that flop with the walk.
 *
 * At 64 px what survives is exactly three things: the round mass, the ears, and
 * the pale disc of the snout. Those three carry the whole read; everything else
 * exists to support them.
 *
 * This file is *only* numbers. There is no pig-specific rendering code anywhere:
 * the shapes come from `body.ts`, the walk comes from the shared skeleton, and
 * the colours come from whichever coat the player picked.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { bipedArms, bipedLegs, earPair, eyes, head, muzzle, torso } from './body.js';
import type { CritterSpecies, HullRing, PartSpec, SocketSpec } from './types.js';

/**
 * Pig proportions. Stands ~82 units to the ear tips, a little shorter and a lot
 * rounder than the robed figure, against the scene's 86-unit trees.
 *
 * `hipY` is the sum of `ankleY + shinLen + thighLen`: the skeleton hangs the legs
 * off the pelvis, so if those disagree the feet float or sink.
 *
 * `shoulderHalf` is deliberately narrow -- narrower than the belly. The arms have
 * to hang *against* the body the way they do on the reference; set out at the
 * widest point they stand off the barrel like a scarecrow's.
 */
const PIG_FIGURE: FigureMetrics = {
  hipY: 28,
  hipHalf: 6.6,
  waistY: 38,
  chestY: 46,
  shoulderY: 53,
  shoulderHalf: 10.5,
  neckY: 56,
  headY: 66,
  upperArmLen: 11.5,
  forearmLen: 10.5,
  thighLen: 13,
  shinLen: 12,
  ankleY: 3,

  headRadius: 11,
  torsoRadius: 13,
  hipRadius: 10,
  thighRadius: 5.5,
  shinRadius: 4.2,
  upperArmRadius: 3.2,
  forearmRadius: 2.8,

  drapeClearance: 2.6,
};

/**
 * The body profile, in world height at rest, read straight off the reference:
 * the silhouette swells from the crotch to its widest point low and forward,
 * holds that through the belly, then narrows steadily into the shoulders. `dx`
 * leans each ring forward, so the back stays near-vertical while the belly
 * bulges -- which is what makes it read as a full stomach and not a barrel.
 */
/**
 * Radial segments around the body and head. Fourteen rather than the default
 * ten: a painted marking's edge can only follow the facets it is cut from, and
 * at ten sides a round patch comes out as a chevron.
 */
const BODY_SIDES = 14;
/** Lofted sections between each declared ring. See `PartSpec.smooth`. */
const BODY_SMOOTH = 3;

const TORSO_RINGS: readonly HullRing[] = [
  { along: 21, rx: 6.5, rz: 6.5, dx: 2 },
  { along: 25, rx: 10.5, rz: 11, dx: 3 },
  { along: 30, rx: 12.6, rz: 13.2, dx: 3.2 },
  { along: 36, rx: 12.8, rz: 13.2, dx: 2.6 },
  { along: 42, rx: 11.6, rz: 12.2, dx: 1.6 },
  { along: 47, rx: 10, rz: 10.6, dx: 0.8 },
  { along: 52, rx: 8.4, rz: 9, dx: 0.2 },
  { along: 56, rx: 6.4, rz: 7, dx: 0 },
];

/** The skull, again in world height: a broad ball flattening toward the crown. */
const HEAD_RINGS: readonly HullRing[] = [
  { along: 56, rx: 5.4, rz: 6, dx: 1 },
  { along: 60, rx: 9, rz: 9.6, dx: 1.4 },
  { along: 64, rx: 10.4, rz: 11, dx: 1.4 },
  { along: 68, rx: 10.2, rz: 10.6, dx: 1 },
  { along: 72, rx: 8, rz: 8.4, dx: 0.4 },
  { along: 75.5, rx: 4.2, rz: 4.6, dx: 0 },
];

/**
 * The snout, lofted forward out of the skull. `along` is how far forward, `rx`
 * the half-height, `rz` the half-width, `dx` the droop. It barely tapers and
 * then flares a touch at the tip, which is the whole shape of a pig's nose.
 */
const MUZZLE_RINGS: readonly HullRing[] = [
  { along: 2, rx: 5.6, rz: 6.2, dx: 0 },
  { along: 7, rx: 5, rz: 5.6, dx: -0.6 },
  { along: 12, rx: 4.6, rz: 5.2, dx: -1.2 },
  { along: 15.5, rx: 4.9, rz: 5.6, dx: -1.5 },
];

const SOCKETS: readonly SocketSpec[] = [
  {
    // High and well back on the skull, splayed hard out to the sides.
    socket: 'ear',
    parentBone: BONE.head,
    pos: [-1, 14.5, -7],
    // rx splays the ear outward (mirrored on the right); rz tips it forward
    // (shared, so both ears lean the same way).
    rot: [-1.0, 0, -0.5],
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
    pos: [-8, 6, 0],
    rot: [0, 0, 0.9],
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
  torso(PIG_FIGURE, TORSO_RINGS, { sides: BODY_SIDES, smooth: BODY_SMOOTH }),
  head(PIG_FIGURE, HEAD_RINGS, { sides: BODY_SIDES, smooth: BODY_SMOOTH }),
  ...bipedArms(PIG_FIGURE, { taper: [3.4, 2.9, 2.5], hand: [4.2, 4.4, 4.2], handRole: 'hoof' }),
  ...bipedLegs(PIG_FIGURE, { taper: [5.8, 4.2, 3.4], hoof: [6.4, 4, 5.6] }),
  ...muzzle({
    f: PIG_FIGURE,
    atY: 64.5,
    rings: MUZZLE_RINGS,
    padDepth: 2.4,
    // Small and set well apart: at 2.6 units apart they merge into one black
    // blot that reads as the whole nose, which is worse than having none.
    nostril: [2.2, 3, 2.2],
    nostrilSpread: 3.2,
  }),
  // Pushed out to where the skull's surface actually is: an eye sunk inside the
  // head is an eye nobody sees.
  // Out on the cheeks rather than close over the snout: two dark squares set
  // close together stop reading as a pair of eyes and start reading as one
  // bandit mask, which is the shape the whole face then loses to.
  eyes({ f: PIG_FIGURE, at: [8.7, 67.5, -7], size: [2.8, 3.6, 2.8] }),
  ...earPair('ear', { length: 9.5, width: 13, thickness: 4 }),

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
    size: [4, 6.5, 4],
    pos: [0, 3.2, 0],
  },
  {
    name: 'tailCurl',
    attach: 'tail',
    shape: 'cone',
    role: 'coat',
    taper: 0.3,
    facets: 5,
    size: [3.2, 6, 3.2],
    pos: [-2.4, 7.8, 0],
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
    hoof: 0x8a6156,
    eye: 0x14121a,
  },
};
