/**
 * The pig's sword swing, as a table of poses (spec 139).
 *
 * This file is the animation. Everything around it -- `pose.ts`'s measured axes,
 * `clip-author.ts`'s sampling, `glb.ts`'s writer -- exists so that this can be
 * seven rows somebody can read, argue with, and change one number in.
 *
 * ## What it is
 *
 * A diagonal overhead chop, thrown right-handed, over 800ms. It is that shape
 * rather than a horizontal sweep for one reason: the camera. This game is drawn
 * isometric, looking down, and a body is a few dozen pixels tall. A horizontal
 * swing at that angle is a limb moving *within* the silhouette and reads as
 * nothing; a chop takes the blade out of the outline at the top, holds it there
 * where it can be seen, and brings it down across the body. Silhouette is the
 * whole budget, so both extremes spend it.
 *
 * ## Why the beats fall where they do
 *
 * `melee.slash` has `windupTicks: seconds(0.5)` and resolves its damage on the
 * tick the wind-up ends. So `contact` is at 500ms, and that is not a taste --
 * the frame the picture lands and the frame the damage lands are the same frame
 * or the animation is lying about when it was safe to stand there. Everything
 * else is arranged around that:
 *
 *  - the blade is over the shoulder by 300ms and *stays* there to 400ms, because
 *    a wind-up that is still moving cannot be read as a decision, and a wind-up
 *    that is perfectly still reads as a dropped frame. It creeps a few degrees.
 *  - the strike is 100ms, eased `in`, so the fastest instant of the whole clip is
 *    the instant of contact. Six frames at 60Hz: enough that two of them are
 *    readable mid-swing and the last two are the blur that sells it. An
 *    even-speed swing passes every assertion about where the hand went and reads
 *    as a body pushing a blade through treacle.
 *  - the follow-through overshoots past contact and settles back, because a limb
 *    that stops where it hit has no weight in it.
 *
 * ## The angles are in the body's axes
 *
 * `lateral` swings a limb through the sagittal plane -- positive takes a hanging
 * arm *backwards* and tips an upright spine *forwards*, which is the same
 * rotation seen from two ends. `forward` lifts a limb sideways: negative
 * abducts the right arm out and over the head. `up` sweeps horizontally, and
 * positive is toward the pig's left, so the coil is negative and the strike is
 * positive. `flex` is the bone's own hinge and positive folds it. See `pose.ts`.
 *
 * Pure, and part of the deterministic core.
 */

import type { AuthoredClip, PoseKey } from './clip-author.js';
import type { ClipEvent } from './types.js';

/** The clip id, which is the retarget's own preset vocabulary (`scaffold.ts`). */
export const STRIKE_CLIP_ID = 'slash';

export const STRIKE_DURATION_MS = 800;

/**
 * The instant the blade is in something.
 *
 * `melee.slash`'s wind-up, in milliseconds. Asserted against the ability table
 * rather than restated here, so re-tuning the fight fails a test instead of
 * quietly leaving the picture behind.
 */
export const STRIKE_CONTACT_MS = 500;

/** Where the file's own beats are, so the preview and the tests can name them. */
export const STRIKE_KEY_MS = {
  guard: 0,
  dip: 130,
  coil: 300,
  load: 400,
  contact: STRIKE_CONTACT_MS,
  follow: 600,
  settle: STRIKE_DURATION_MS,
} as const;

/**
 * The stance the swing starts and ends in.
 *
 * Deliberately close to the pig's own idle rather than to its bind pose. The
 * transition into the swing is a 60ms cross-fade with the idle on the other side
 * of it, and the pig's idle stands with its knees bent about 35 degrees -- so a
 * guard authored at the bind pose snaps the legs straight and back again inside
 * a tenth of a second, twice per swing.
 *
 * It is also the last key, exactly, so a swing thrown at the end of a swing has
 * nothing to jump over.
 */
const GUARD = {
  hips: { up: -8 },
  spine: { lateral: 3, up: -4 },
  chest: { up: -10 },
  neck: { up: 10, lateral: 4 },
  head: { lateral: 2 },
  rightShoulder: { forward: -10 },
  rightArm: { lateral: -34, forward: -16 },
  rightForeArm: { flex: 96 },
  rightHand: { lateral: -30, up: -14 },
  leftShoulder: { forward: 6 },
  leftArm: { lateral: -26, forward: 12 },
  leftForeArm: { flex: 62 },
  leftHand: { lateral: 6 },
  rightUpLeg: { lateral: 12, forward: -4 },
  rightLeg: { lateral: 30 },
  rightFoot: { lateral: -18 },
  leftUpLeg: { lateral: 6, forward: 4 },
  leftLeg: { lateral: 30 },
  leftFoot: { lateral: -22 },
} as const;

const KEYS: readonly PoseKey[] = [
  {
    label: 'guard',
    atMs: STRIKE_KEY_MS.guard,
    ease: 'linear',
    turns: GUARD,
  },
  {
    // The counter-move. The blade drops and the shoulders square *before* the
    // lift, which is the oldest trick there is and the reason a swing looks like
    // it was decided on rather than teleported into.
    label: 'dip',
    atMs: STRIKE_KEY_MS.dip,
    ease: 'out',
    turns: {
      hips: { up: -4 },
      spine: { lateral: 7 },
      chest: { up: -4 },
      neck: { up: 4, lateral: 6 },
      head: { lateral: 4 },
      rightShoulder: { forward: 0 },
      rightArm: { lateral: -44, forward: -10 },
      rightForeArm: { flex: 86 },
      rightHand: { lateral: -24, up: -10 },
      leftShoulder: { forward: 8 },
      leftArm: { lateral: -32, forward: 14 },
      leftForeArm: { flex: 58 },
      leftHand: { lateral: 6 },
      rightUpLeg: { lateral: 14, forward: -4 },
      rightLeg: { lateral: 34 },
      rightFoot: { lateral: -20 },
      leftUpLeg: { lateral: 8, forward: 4 },
      leftLeg: { lateral: 34 },
      leftFoot: { lateral: -24 },
    },
  },
  {
    // Over the shoulder. Everything winds right: hips, chest and the blade all
    // rotate the same way and the neck rotates back against them, so the pig
    // keeps looking at what it is about to hit while its body is turned away
    // from it. That opposition is what makes a coil look loaded rather than
    // just turned.
    label: 'coil',
    atMs: STRIKE_KEY_MS.coil,
    ease: 'inOut',
    turns: {
      hips: { up: -24 },
      spine: { lateral: -8, up: -14 },
      chest: { up: -32, lateral: -10 },
      neck: { up: 30, lateral: 10 },
      head: { up: 12, lateral: 4 },
      rightShoulder: { forward: -26, up: -14 },
      rightArm: { forward: -108, lateral: 48 },
      rightForeArm: { flex: 16 },
      rightHand: { lateral: -22 },
      leftShoulder: { forward: 10 },
      leftArm: { lateral: -48, forward: 6 },
      leftForeArm: { flex: 96 },
      leftHand: { lateral: 10 },
      rightUpLeg: { lateral: 18, forward: -6, up: -8 },
      rightLeg: { lateral: 36 },
      rightFoot: { lateral: -22 },
      leftUpLeg: { lateral: 2, forward: 6, up: -6 },
      leftLeg: { lateral: 28 },
      leftFoot: { lateral: -20 },
    },
  },
  {
    // The hold. Nearly `coil`, a few degrees further into it -- a pose held
    // perfectly still for 90ms reads as a stall or a dropped frame, and a pose
    // still creeping reads as something being held back.
    label: 'load',
    atMs: STRIKE_KEY_MS.load,
    ease: 'out',
    turns: {
      hips: { up: -28 },
      spine: { lateral: -10, up: -16 },
      chest: { up: -37, lateral: -12 },
      neck: { up: 34, lateral: 12 },
      head: { up: 14, lateral: 6 },
      rightShoulder: { forward: -30, up: -16 },
      rightArm: { forward: -116, lateral: 56 },
      rightForeArm: { flex: 8 },
      rightHand: { lateral: -26 },
      leftShoulder: { forward: 12 },
      leftArm: { lateral: -52, forward: 4 },
      leftForeArm: { flex: 100 },
      leftHand: { lateral: 12 },
      rightUpLeg: { lateral: 20, forward: -6, up: -10 },
      rightLeg: { lateral: 38 },
      rightFoot: { lateral: -24 },
      leftUpLeg: { lateral: 0, forward: 6, up: -8 },
      leftLeg: { lateral: 26 },
      leftFoot: { lateral: -18 },
    },
  },
  {
    // The blow. 70ms from the hold, eased `in`, so the blade is moving fastest
    // exactly here. The elbow is nearly straight -- the reach is the frame that
    // has to read at forty pixels -- and every rotation that was negative at the
    // coil has gone positive, so the whole body has passed through square rather
    // than the arm having travelled on its own.
    label: 'contact',
    atMs: STRIKE_KEY_MS.contact,
    ease: 'in',
    turns: {
      hips: { up: 18 },
      spine: { lateral: 8, up: 12 },
      chest: { up: 30, lateral: 9 },
      neck: { up: -16, lateral: 12 },
      head: { lateral: 8 },
      rightShoulder: { forward: 10, up: 20 },
      rightArm: { forward: 22, lateral: -84 },
      rightForeArm: { flex: 8 },
      rightHand: { lateral: 14 },
      leftShoulder: { forward: -10, up: -16 },
      leftArm: { lateral: 26, forward: -20 },
      leftForeArm: { flex: 48 },
      leftHand: { lateral: 4 },
      rightUpLeg: { lateral: -6, forward: -6, up: 10 },
      rightLeg: { lateral: 28 },
      rightFoot: { lateral: -20 },
      leftUpLeg: { lateral: 14, forward: 6, up: 8 },
      leftLeg: { lateral: 34 },
      leftFoot: { lateral: -26 },
    },
  },
  {
    // The overshoot. The blade wraps past the left hip and the left shoulder is
    // driven back -- a limb that stopped where it hit would have no weight in
    // it, and this is the 100ms the `active` window is made of.
    label: 'follow',
    atMs: STRIKE_KEY_MS.follow,
    ease: 'out',
    turns: {
      hips: { up: 26 },
      spine: { lateral: 12, up: 16 },
      chest: { up: 40, lateral: 12 },
      neck: { up: -26, lateral: 16 },
      head: { lateral: 10 },
      rightShoulder: { forward: 18, up: 28 },
      rightArm: { forward: 32, lateral: -78 },
      rightForeArm: { flex: 10 },
      rightHand: { lateral: 20 },
      leftShoulder: { forward: -14, up: -22 },
      leftArm: { lateral: 36, forward: -28 },
      leftForeArm: { flex: 56 },
      leftHand: { lateral: 2 },
      rightUpLeg: { lateral: -10, forward: -6, up: 14 },
      rightLeg: { lateral: 26 },
      rightFoot: { lateral: -18 },
      leftUpLeg: { lateral: 18, forward: 6, up: 12 },
      leftLeg: { lateral: 36 },
      leftFoot: { lateral: -28 },
    },
  },
  {
    // Back to `GUARD`, the same object rather than a copy of its numbers, so the
    // two cannot drift apart and a chained swing has nothing to jump over. 200ms
    // eased `out`, which is longer than it needs to be to get there and is the
    // part a player spends most of their time looking at.
    label: 'settle',
    atMs: STRIKE_KEY_MS.settle,
    ease: 'out',
    turns: GUARD,
  },
];

export const PIG_STRIKE: AuthoredClip = {
  id: STRIKE_CLIP_ID,
  durationMs: STRIKE_DURATION_MS,
  // 60, because the acceleration is in the samples. See `clip-author.ts`.
  fps: 60,
  keys: KEYS,
};

/**
 * The two markers the action timing maps.
 *
 * The names are `scaffold.ts`'s, because a clip authored here and a clip
 * scaffolded from a retarget should hand the same vocabulary to the same
 * `eventMap` -- a document that validates only because its author remembered
 * which of two spellings this unit used is a document waiting to break.
 */
export const STRIKE_EVENTS: readonly ClipEvent[] = [
  { name: 'swing.start', normalizedTime: 0 },
  { name: 'swing.impact', normalizedTime: STRIKE_CONTACT_MS / STRIKE_DURATION_MS },
];
