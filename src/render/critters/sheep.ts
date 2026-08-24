/**
 * The sheep (spec 055): the first animal in the cast that stands on four legs.
 *
 * The pig and the cow are the shapes a *player* is drawn as, so they are built
 * upright -- two legs, two arms, a head stacked on the shoulders. A sheep in the
 * field is not a character, it is livestock, and the single thing that says so
 * before any detail is legible is that its back is horizontal.
 *
 * It is built as a **box on four posts**, deliberately: a fat rounded cuboid of
 * fleece, a big blunt head hung off the front of it, and four short straight
 * legs that swing without bending. That is the Minecraft read, and it is the
 * right one here for a reason beyond the reference -- at 64 px against a
 * humanoid player, an animal that reads instantly as *four legs and a lump* is
 * worth more than one with correct anatomy nobody can see.
 *
 * ## Cute is a proportion, not a detail
 *
 * Everything charming about this animal is one decision made four times: the
 * head is enormous (16 units on a 27-unit body), the legs are stumpy (18 units
 * under a body that is 24 deep), the eyes are twice the size an eye should be,
 * and the ears are as long as the head is wide. None of that is anatomy. It is
 * the standard trick -- juvenile proportions on an adult animal -- and it
 * survives being drawn at 64 px, which the anatomy would not.
 *
 * ## What it costs the rig: nothing
 *
 * The skeleton is the same eleven bones the player uses. `chestForward` and
 * `headForward` (see `cloth/figure.ts`) put the chest ahead of the pelvis and
 * the head ahead of the chest, and that is the entire quadruped change: the
 * forelegs hang off the chest and so land at the front, the hind legs hang off
 * the pelvis and land at the back, and the walk cycle -- which swings arms and
 * legs in opposition -- comes out as the diagonal gait a sheep actually walks
 * with, for free.
 *
 * The legs are one rigid box each, hung off the upper bone with nothing on the
 * lower one, so the knee bend the gait produces moves nothing. That is not a
 * shortcut: a jointed leg 18 units long, drawn 12 px tall, spends its whole
 * budget hiding a seam nobody can see, and a stiff swinging post is both
 * cheaper and funnier.
 */

import { BONE, type FigureMetrics } from '../cloth/figure.js';
import { earPair, hull } from './body.js';
import type { CritterSpecies, HullRing, PaintBlob, PartSpec, SocketSpec } from './types.js';

/**
 * Sheep proportions, and the two numbers that make it a quadruped.
 *
 * `chestForward: 22` puts the shoulders 22 units ahead of the hips, which is
 * the length of the barrel; `headForward: 13` hangs the head off the front of
 * that. Everything else is read the way it always is -- as heights -- so the
 * back line is `shoulderY == hipY == 22` and the animal stands level.
 *
 * Both leg pairs are cut to the same length for the same reason: `upperArmLen +
 * forearmLen + ankleY` and `thighLen + shinLen + ankleY` both come to 22, and
 * both sets of bones hang at 22, so all four feet reach the same floor.
 * `species.test.ts` asserts both pairs now -- until there was an animal with a
 * front pair, nothing in the shared invariants had any reason to look at the
 * arm chain.
 */
const SHEEP_FIGURE: FigureMetrics = {
  hipY: 22,
  hipHalf: 8,
  waistY: 22,
  chestY: 22,
  shoulderY: 22,
  shoulderHalf: 8,
  neckY: 34,
  headY: 37,

  chestForward: 22,
  headForward: 13,

  upperArmLen: 11,
  forearmLen: 8,
  thighLen: 11,
  shinLen: 8,
  ankleY: 3,

  headRadius: 9,
  torsoRadius: 12,
  hipRadius: 11,
  thighRadius: 3.6,
  shinRadius: 3.2,
  upperArmRadius: 3.4,
  forearmRadius: 3,

  drapeClearance: 2.6,
};

/**
 * Facet shape on the fleece, and the one place this animal is not boxy.
 *
 * Nine sides rather than the cow's twelve: fewer, larger facets are what make a
 * lofted body read as *carved* rather than as revolved, and on a shape this
 * round they are most of what stops it looking like an egg. The jitter is the
 * fleece itself -- see the note below -- and it needs facets big enough to be
 * seen moving, which is the same argument from the other side.
 */
const FLEECE_SIDES = 9;
const FLEECE_SMOOTH = 2;
/**
 * The wool, and it is a knob rather than geometry.
 *
 * The obvious build for a fleece is a coat of little balls, and it is wrong
 * twice: at unit size each one is sub-pixel noise that costs triangles and
 * returns nothing, and at any size a surface of tangent spheres reads as bubble
 * wrap. Turning up the existing vertex nudge instead -- 0.26 against the cow's
 * 0.14 -- makes every facet disagree with its neighbours, which at this scale
 * is what a fleece looks like. It costs nothing, and because the nudge is
 * hashed from the vertex index the animal is lumpy in the same places forever.
 */
const FLEECE_JITTER = 0.26;

/**
 * The barrel, lofted **along +x** -- nose-ward -- rather than up.
 *
 * This is the shape of the whole animal and it is written as one curve from the
 * rump to the base of the neck. `along` is how far forward of the chest bone,
 * so the negative numbers are behind it: the body runs from 30 units back
 * (which is 8 behind the hips) to 6 in front of the shoulders. `rx` is the
 * half-height and `rz` the half-width, so a ring is the cross-section of the
 * animal you would see walking straight at it.
 *
 * Two things are load-bearing. It **holds its width across the middle four
 * rings** rather than peaking at one -- a body that tapers from a single widest
 * point is an egg, and a fleece is a cylinder with the corners knocked off. And
 * it is **fractionally taller than it is wide** at the shoulder and the reverse
 * at the belly, which is what stops a cross-section reading as a circle from
 * any angle.
 */
const BODY_RINGS: readonly HullRing[] = [
  { along: -30, rx: 6.5, rz: 6 },
  { along: -26, rx: 11, rz: 10.5 },
  { along: -21, rx: 12.6, rz: 12.4 },
  { along: -15, rx: 13, rz: 13 },
  { along: -8, rx: 13, rz: 13.2 },
  { along: -2, rx: 12.6, rz: 12.8 },
  { along: 3, rx: 11.4, rz: 11.4 },
  { along: 8, rx: 9.4, rz: 9.4 },
];

/**
 * The skull: a blunt wedge, wider than it is tall, hung off the front of the
 * barrel and running forward into the muzzle without a join.
 *
 * Enormous on purpose -- see the note about proportion at the top. It is lofted
 * along +x like the body, so the two share a silhouette language, and its back
 * ring sits *inside* the neck end of the barrel so no end cap ever lands on the
 * outline (the rigid-join rule from `body.ts`).
 */
const HEAD_RINGS: readonly HullRing[] = [
  { along: -10, rx: 6.4, rz: 7 },
  { along: -6, rx: 7.8, rz: 8.4 },
  { along: -1, rx: 8, rz: 8.6 },
  { along: 3, rx: 7.4, rz: 7.6 },
  { along: 6, rx: 6.4, rz: 6.2 },
];

/**
 * The nose, painted rather than modelled.
 *
 * One blob over the front of the skull, which lands the boundary as a clean
 * edge just behind the nostrils and costs no geometry -- the same argument the
 * cow's patches are built on. It is `skin` rather than `marking` because the
 * face around it is already the dark one, and a dark nose on a dark face is a
 * nose nobody can find.
 */
const HEAD_PATCHES: readonly PaintBlob[] = [
  // The face. One blob over the front of the skull, sized to overrun it in
  // every direction so the edge that lands on the silhouette is the *back* of
  // the blob -- a clean line round the head just behind the eyes, with wool
  // above and behind it and a solidly dark face in front.
  { role: 'marking', at: [6, -0.5, 0], r: [7.5, 9, 9] },
  // And the nose pad on the very end of it, which is the one warm spot on that
  // face and the reason it reads as a muzzle rather than as a hole.
  { role: 'skin', at: [7.5, -2.4, 0], r: [2.4, 3, 3.6] },
];

/**
 * How far every limb bone sits above the floor.
 *
 * One number because it is one number: `shoulderY` and `hipY` are both 22, which
 * is what makes the back level, and it means the fore and hind legs are cut to
 * the same length and reach the same ground.
 */
const LEG_DROP = 22;
const LEG_THICK = 6.2;
/** How much of the hoof is hoof. The rest of the drop is leg. */
const HOOF_HEIGHT = 3.6;

/**
 * One leg, as a single box on the upper bone.
 *
 * `pos` hangs it below the joint rather than centring it there, and runs its top
 * an inch *into* the body so no gap opens at the shoulder as the leg swings.
 */
function leg(name: string, bone: number): PartSpec {
  return {
    name,
    attach: bone,
    shape: 'box',
    role: 'marking',
    size: [LEG_THICK, LEG_DROP, LEG_THICK],
    pos: [0, -LEG_DROP * 0.5 + 1.5, 0],
  };
}

/**
 * The hoof: a fatter, darker cap, sat so its underside lands exactly on y = 0.
 *
 * Exactly, rather than nearly. Two or three units of daylight under an animal
 * 42 units tall is not subtle at the size it is drawn -- it reads as hovering,
 * and it is invisible in a still render because nothing in the frame says where
 * the floor is.
 */
function hoof(name: string, bone: number): PartSpec {
  return {
    name,
    attach: bone,
    shape: 'box',
    role: 'hoof',
    size: [LEG_THICK * 1.15, HOOF_HEIGHT, LEG_THICK * 1.15],
    pos: [0, -LEG_DROP + HOOF_HEIGHT * 0.5, 0],
  };
}

const SOCKETS: readonly SocketSpec[] = [
  {
    // Straight out of the sides of the head, level and long. A sheep's ear is
    // held out rather than up, and at this size a pair sticking sideways is the
    // single fastest way to tell the head from the body it is hung off.
    socket: 'ear',
    parentBone: BONE.head,
    // Outside the skull, not inside it. At `rz` 8.6 the head is nearly nine
    // units of half-width, so an ear socketed at 6.5 was buried in it and only
    // its tip ever showed -- which is what turned a pair of ears into one
    // pointed lump at the back of the head.
    pos: [-2, 2.5, -8],
    // Nearly horizontal (`rx`), tipped a little forward, so the flaps present
    // their broad face to a camera looking down at the animal instead of being
    // seen edge-on as fins.
    rot: [-1.45, 0.15, -0.15],
    mirror: true,
    wobble: {
      // Floppy and slow to answer: light ears on a heavy walk. Twice the cow's
      // stride amplitude, because a sheep's ears are the comedy.
      axis: 'x',
      strideAmp: 0.3,
      idleAmp: 0.12,
      idleHz: 0.3,
      leanAmp: 0.4,
      follow: 6,
    },
  },
  {
    // A stub, on the back of the rump rather than under it.
    socket: 'tail',
    parentBone: BONE.pelvis,
    pos: [-9, 6, 0],
    rot: [0, 0, -0.5],
    wobble: {
      axis: 'y',
      strideAmp: 0.45,
      phase: 0.25,
      idleAmp: 0.2,
      idleHz: 0.5,
      leanAmp: 0.8,
      follow: 7,
    },
  },
];

const PARTS: readonly PartSpec[] = [
  // --- The fleece -----------------------------------------------------------
  hull({
    name: 'torso',
    attach: BONE.chest,
    role: 'coat',
    axis: 'x',
    rings: BODY_RINGS,
    facets: FLEECE_SIDES,
    smooth: FLEECE_SMOOTH,
    jitter: FLEECE_JITTER,
    pos: [0, 0, 0],
  }),

  // --- The head -------------------------------------------------------------
  // The skull is **wool with a face painted on it**, not a dark block stuck on
  // the front. Built dark, it read as a snout -- a long shape of a different
  // colour hung off a pale body is a boar, and no amount of ear helps. Painted,
  // the wool runs over the crown and down the cheeks and the dark stops where a
  // sheep's face actually stops, which is the whole read.
  hull({
    name: 'head',
    attach: BONE.head,
    role: 'coat',
    axis: 'x',
    rings: HEAD_RINGS,
    facets: 8,
    smooth: 2,
    jitter: FLEECE_JITTER,
    paint: HEAD_PATCHES,
    pos: [0, 0, 0],
  }),
  // Big, forward, and set well apart. Twice the size an eye should be, which is
  // most of the charm and all of the legibility: on a dark face at 64 px, a
  // correctly-sized eye is not there at all.
  {
    name: 'eye',
    attach: BONE.head,
    shape: 'box',
    role: 'eye',
    size: [2.9, 3.3, 2.9],
    pos: [4.6, 1.2, -7],
    mirror: true,
  },
  // The pale ring that turns a dark dot into an eye. One flat block just behind
  // and around it, in the coat, so it reads at any coat colour.
  {
    name: 'eyePatch',
    attach: BONE.head,
    shape: 'box',
    role: 'coatLight',
    size: [4, 4.4, 2.2],
    pos: [4.4, 1.3, -5.9],
    mirror: true,
  },
  {
    name: 'nostril',
    attach: BONE.head,
    shape: 'box',
    role: 'skinDeep',
    size: [2.8, 2.8, 2.8],
    pos: [8.6, -1.6, -2.4],
    mirror: true,
  },
  ...earPair('ear', { length: 9.5, width: 6.5, thickness: 2.8, shellRole: 'marking', liningRole: 'skin' }),

  // --- Four legs ------------------------------------------------------------
  // Fore on the arm bones, hind on the leg bones. The gait swings the two pairs
  // in opposition, which is exactly a quadruped's diagonal walk.
  leg('legLFront', BONE.upperArmL),
  leg('legRFront', BONE.upperArmR),
  leg('legL', BONE.thighL),
  leg('legR', BONE.thighR),
  hoof('hoofLFront', BONE.upperArmL),
  hoof('hoofRFront', BONE.upperArmR),
  hoof('hoofL', BONE.thighL),
  hoof('hoofR', BONE.thighR),

  // --- Tail -----------------------------------------------------------------
  hull({
    name: 'tailStub',
    attach: 'tail',
    role: 'coat',
    facets: 6,
    smooth: 2,
    jitter: FLEECE_JITTER,
    rings: [
      { along: 0, rx: 2.8, rz: 2.8 },
      { along: -4, rx: 3.2, rz: 3.2 },
      { along: -8, rx: 2.2, rz: 2.2 },
    ],
    pos: [0, 0, 0],
  }),
];

export const SHEEP: CritterSpecies = {
  id: 'sheep',
  name: 'Sheep',
  blurb: 'A very round sheep on four short legs. Puts its head down the moment it stops.',
  stance: 'quadruped',
  // Head to the floor, and slowly -- the comedy is in how unbothered it is. The
  // nibble is deliberately small and quick against that: the head sinks over
  // most of a second and then twitches, which reads as chewing rather than as
  // nodding.
  //
  // The dip is a blend rather than a switch, and the sheep's own numbers land it
  // somewhere useful in the middle. It ambles at 0.34 of a 62 move speed, which
  // is 21 units/s -- between the rig's idle threshold (5) and its walk one (34)
  // -- so a grazing sheep crosses its patch with its head about half down and
  // only lifts it properly when something makes it run. Three poses out of one
  // number, and the one nobody authored is the one it spends its day in.
  graze: { dip: -1.3, drop: 19, reach: 5, nibbleAmp: 0.08, nibbleHz: 2.6, follow: 2.4 },
  metrics: SHEEP_FIGURE,
  sockets: SOCKETS,
  parts: PARTS,
  // Warm off-white. Light, because a fleece no lighter than the grass under it
  // is not a fleece -- but well short of white, or `coatLight` has nowhere to go
  // on the lit side of the body.
  defaultCoat: 0xe6ddca,
  accents: {
    // The nose pad and the ear lining.
    skin: 0xd9a8a0,
    skinDeep: 0x5f3f3e,
    // Face, ears and legs. Near-black with a cool cast rather than true black:
    // on a cream body, true black reads as a hole cut in the sprite.
    marking: 0x33303a,
    hoof: 0x24222a,
    eye: 0x14121a,
  },
};
