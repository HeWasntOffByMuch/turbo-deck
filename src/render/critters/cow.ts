/**
 * The cow (spec 049).
 *
 * Taller and longer in the face than the pig, with stubby horns, ears held out
 * sideways rather than up, and -- the thing that actually does the work at 64 px
 * -- big dark patches.
 *
 * The patches are **painted onto the body's own skin**, not modelled: each is an
 * ellipsoid in the torso's local space, and every triangle of the hull whose
 * centre falls inside it draws in the marking colour instead of the coat. So a
 * patch lies flat on the curve of the belly from every angle, costs no geometry,
 * and -- because the marking colour is contrast-corrected against whatever coat
 * the player picked -- is as legible on Cream as it is on Plum.
 *
 * Same skeleton, same walk cycle, same builders as the pig. The whole difference
 * between the two animals lives in this file.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { bipedArms, bipedLegs, earPair, eyes, head, hull, muzzle, splitBodyProfile, torso } from './body.js';
import type { CritterSpecies, HullRing, PaintBlob, PartSpec, SocketSpec } from './types.js';

/** Cow proportions: longer in the leg and the face than the pig, ~86 to the horns. */
const COW_FIGURE: FigureMetrics = {
  hipY: 31,
  hipHalf: 7,
  waistY: 40,
  chestY: 49,
  shoulderY: 56,
  shoulderHalf: 11,
  neckY: 59,
  headY: 69,
  upperArmLen: 12.5,
  forearmLen: 11.5,
  thighLen: 14,
  shinLen: 14,
  ankleY: 3,

  headRadius: 10.5,
  torsoRadius: 13,
  hipRadius: 10,
  thighRadius: 5.6,
  shinRadius: 4.4,
  upperArmRadius: 3.4,
  forearmRadius: 3,

  drapeClearance: 2.6,
};

/**
 * Facet shape around and along the body -- see the pig for why these two are one
 * decision. The cow cares about the segment count for a second reason: a painted
 * marking's edge can only follow the facets it is cut from, and too few sides
 * turns a round patch into a chevron.
 */
const BODY_SIDES = 12;
const BODY_SMOOTH = 1;
/** How irregular the facets are. See `PartSpec.jitter`. */
const BODY_JITTER = 0.14;

/**
 * The whole cow as one silhouette, crotch to crown -- see the pig for why this
 * is written as a single curve and cut in two rather than as two profiles. The
 * cow carries a little more neck than the pig does, but not much: the dip at
 * y = 59 is still three quarters of the skull's width.
 */
const BODY_RINGS: readonly HullRing[] = [
  { along: 24, rx: 6.5, rz: 6.5, dx: 2 },
  { along: 28, rx: 10.5, rz: 11, dx: 3 },
  { along: 33, rx: 12.4, rz: 13, dx: 3 },
  { along: 39, rx: 12.6, rz: 13, dx: 2.4 },
  { along: 45, rx: 11.6, rz: 12.2, dx: 1.4 },
  { along: 50, rx: 10.2, rz: 10.8, dx: 0.6 },
  { along: 54, rx: 8.8, rz: 9.4, dx: 0.2 },
  { along: 59, rx: 6.6, rz: 7.2, dx: 0.6 },
  { along: 63, rx: 8.6, rz: 9.2, dx: 1.2 },
  { along: 67, rx: 9.6, rz: 10.2, dx: 1.2 },
  { along: 71, rx: 9.2, rz: 9.6, dx: 0.8 },
  { along: 74.5, rx: 7, rz: 7.4, dx: 0.2 },
  { along: 77.5, rx: 3.6, rz: 4, dx: 0 },
];

const NECK_CUT = 57;
const NECK_OVERLAP = 4;
const BODY = splitBodyProfile(BODY_RINGS, { cutAt: NECK_CUT, overlap: NECK_OVERLAP });

/**
 * The markings, in world height at rest. Deliberately asymmetric -- a symmetric
 * cow reads as a pattern, an asymmetric one reads as an animal -- and spread
 * across all four quarters, because the camera orbits with the unit's facing and
 * every side has to carry the read on its own.
 */
const TORSO_PATCHES: readonly PaintBlob[] = [
  { role: 'marking', at: [3, 34, -13], r: [7, 8, 6] },
  { role: 'marking', at: [12, 30, 6], r: [6, 7, 7] },
  { role: 'marking', at: [-9, 41, -3], r: [6, 8, 7] },
  { role: 'marking', at: [1, 50, 10], r: [6, 6, 6] },
];

/**
 * One dark blot over one eye: the single most recognisable thing on the model at
 * 64 px, and painted on it costs nothing at all.
 */
const HEAD_PATCHES: readonly PaintBlob[] = [{ role: 'marking', at: [3, 68, -7.5], r: [8, 7.5, 6] }];

/** Longer and squarer than the pig's -- most of what says "cow" up close. */
const MUZZLE_RINGS: readonly HullRing[] = [
  { along: 2, rx: 5.2, rz: 5.8, dx: 0 },
  { along: 8, rx: 4.8, rz: 5.2, dx: -0.8 },
  { along: 14, rx: 4.6, rz: 5, dx: -1.6 },
  { along: 18, rx: 5, rz: 5.6, dx: -2 },
];

const SOCKETS: readonly SocketSpec[] = [
  {
    // Cow ears sit low and stick straight out to the sides, below the horns.
    socket: 'ear',
    parentBone: BONE.head,
    pos: [-2.5, 9, -8],
    // Nearly horizontal: rx of -1.3 lays the left ear out along -z, which is the
    // single cue that separates a cow's head from the pig's at a glance.
    rot: [-1.3, 0, -0.1],
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
    pos: [-8.5, 7, 0],
    // The tail hangs along the socket's -y, so a negative z rotation is what
    // swings it backward rather than forward under the rump.
    rot: [0, 0, -0.4],
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
  torso(COW_FIGURE, BODY.torso, { paint: TORSO_PATCHES, sides: BODY_SIDES, smooth: BODY_SMOOTH, jitter: BODY_JITTER }),
  head(COW_FIGURE, BODY.head, { paint: HEAD_PATCHES, sides: BODY_SIDES, smooth: BODY_SMOOTH, jitter: BODY_JITTER }),
  ...bipedArms(COW_FIGURE, { taper: [3.6, 3.1, 2.7], hand: [4.4, 4.6, 4.4], handRole: 'hoof' }),
  ...bipedLegs(COW_FIGURE, { taper: [6, 4.4, 3.6], hoof: [6.6, 4.2, 5.8] }),
  ...muzzle({
    f: COW_FIGURE,
    atY: 67,
    rings: MUZZLE_RINGS,
    padDepth: 2.6,
    nostril: [2.4, 3.2, 2.4],
    nostrilSpread: 3.2,
  }),
  eyes({ f: COW_FIGURE, at: [8.4, 69, -6.4], size: [2.8, 3.6, 2.8] }),
  // Coat-shaded rather than marking: the eye patch already carries the dark on
  // this head, and a third black shape up there turns the face into a smudge.
  ...earPair('ear', { length: 10, width: 8.5, thickness: 3.4, shellRole: 'coatShade', liningRole: 'skin' }),

  // Horns: short forward-curving nubs on the crown. Kept stubby -- long horns
  // read as antlers at this size, and they widen the silhouette past the point
  // where a unit fits its selection ring.
  {
    name: 'horn',
    attach: BONE.head,
    shape: 'cone',
    role: 'horn',
    taper: 0.2,
    facets: 5,
    size: [5, 11, 5],
    pos: [0, 15.5, -5],
    rot: [-0.45, 0, -0.22],
    mirror: true,
  },

  // The udder, low and forward under the belly. Small: it is in the reference
  // and it distinguishes the silhouette from behind, but at 64 px anything
  // bigger reads as a third leg.
  hull({
    name: 'udder',
    attach: BONE.pelvis,
    role: 'skin',
    facets: 7,
    rings: [
      { along: -4, rx: 2.6, rz: 3.4 },
      { along: -7.5, rx: 4, rz: 4.8 },
      { along: -11, rx: 3, rz: 3.6 },
    ],
    pos: [8, 0, 0],
  }),

  // --- Tail ---------------------------------------------------------------
  hull({
    name: 'tailRope',
    attach: 'tail',
    role: 'coat',
    facets: 6,
    rings: [
      { along: 0, rx: 2, rz: 2 },
      { along: -8, rx: 1.6, rz: 1.6 },
      { along: -15, rx: 1.4, rz: 1.4 },
    ],
    pos: [0, 0, 0],
  }),
  hull({
    name: 'tailTuft',
    attach: 'tail',
    role: 'marking',
    facets: 6,
    rings: [
      { along: -14, rx: 1.6, rz: 1.6 },
      { along: -17, rx: 2.8, rz: 2.8 },
      { along: -21, rx: 1.2, rz: 1.2 },
    ],
    pos: [0, 0, 0],
  }),
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
