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

import type { AuthoredClip, PoseKey, PoseTable } from './clip-author.js';
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
 * The stance, and why it is solved rather than authored.
 *
 * The pig throws this swing off its left leg: that foot is flat on the ground
 * with the body's weight on it, so it does not move -- everything above it moves
 * *over* it. Authored by eye it did the opposite. The pelvis yaws 54 degrees
 * between the load and the follow-through, the whole leg chain was carried round
 * with it, and the left ankle skated 0.19 rig units across the floor -- half the
 * pig's own hips-to-head height -- with the foot still planted flat on it.
 *
 * Two separate things move that foot, and only one of them is a rotation. The
 * pelvis turning can be answered by turning the hip back. The pelvis carrying
 * the hip *joint* cannot: the left hip sits 0.115 off the pelvis's own axis, so
 * the joint rides an arc of its own -- 0.068 at the follow-through -- and no
 * rotation of the leg below it puts the leg back. Holding the foot through that
 * is the leg reaching for the ground: two angles at the hip and one at the knee,
 * and no closed form.
 *
 * So both legs come from `npx tsx scripts/plant-foot.ts`, which states where each
 * foot should be in world terms and solves the six angles that put it there. It
 * pins the ankle *and* the toe, because pinning the ankle alone leaves the foot
 * free to spin about it and a foot that pivots on the spot is the same lie as
 * one that slides; and it pays a price per degree of bend, because a leg is a
 * linkage and an unpenalised solve holds the foot perfectly still by snapping the
 * knee straight.
 *
 * The right leg is the same solve with the opposite brief -- it is the wielding
 * side, so it steps back to brace and drives through as the blow lands. Its
 * travel used to be *measured* against a left foot that was itself sliding,
 * which flattered it by roughly two thirds; the honest step is smaller than the
 * old numbers said, and it is also the whole step rather than half of one.
 *
 * Left foot: 0.19 of drift down to 0.013. `pig-strike.test.ts` bounds what is
 * left rather than trusting it.
 */
const STANCE = {
  guard: {
    leftUpLeg: { lateral: 6, forward: 4, up: 0 },
    leftLeg: { lateral: 30 },
    leftFoot: { lateral: -22, up: 0 },
    rightUpLeg: { lateral: 12, forward: -4, up: 0 },
    rightLeg: { lateral: 30 },
    rightFoot: { lateral: -18, up: 0 },
  },
  dip: {
    leftUpLeg: { lateral: 4.1, forward: 5, up: -0.4 },
    leftLeg: { lateral: 30.5 },
    leftFoot: { lateral: -22.2, up: -0.1 },
    rightUpLeg: { lateral: 22.1, forward: -2.3, up: -0.9 },
    rightLeg: { lateral: 19.8 },
    rightFoot: { lateral: -12.8, up: -0.2 },
  },
  coil: {
    leftUpLeg: { lateral: 12.7, forward: -0.9, up: 1.4 },
    leftLeg: { lateral: 27.4 },
    leftFoot: { lateral: -20.8, up: 0.3 },
    rightUpLeg: { lateral: 24.8, forward: -15.2, up: 1.9 },
    rightLeg: { lateral: 14.1 },
    rightFoot: { lateral: -6.8, up: 0.3 },
  },
  load: {
    leftUpLeg: { lateral: 14.1, forward: -2.3, up: 1.8 },
    leftLeg: { lateral: 26.6 },
    leftFoot: { lateral: -20.4, up: 0.3 },
    rightUpLeg: { lateral: 23.9, forward: -17.9, up: 2.5 },
    rightLeg: { lateral: 13.6 },
    rightFoot: { lateral: -6.1, up: 0.4 },
  },
  contact: {
    leftUpLeg: { lateral: -6.6, forward: 8, up: -2 },
    leftLeg: { lateral: 30.8 },
    leftFoot: { lateral: -23, up: -0.5 },
    rightUpLeg: { lateral: -15.5, forward: 0.7, up: -2.6 },
    rightLeg: { lateral: 54.2 },
    rightFoot: { lateral: -22, up: -1 },
  },
  follow: {
    leftUpLeg: { lateral: -10.4, forward: 8, up: -2.4 },
    leftLeg: { lateral: 29.9 },
    leftFoot: { lateral: -23, up: -0.6 },
    rightUpLeg: { lateral: -23.3, forward: -2.1, up: -0.4 },
    rightLeg: { lateral: 55.9 },
    rightFoot: { lateral: -21.9, up: -1.3 },
  },
} as const satisfies Record<string, PoseTable>;

/**
 * The pose the swing starts and ends in, legs included.
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
  // Fitted to the *idle* clip's right arm rather than authored by eye, so the
  // blade points where `weapon.main` was calibrated to point and the cross-fade
  // out of idle has almost nothing to move. See `scripts/solve-grip.ts`.
  rightArm: { lateral: 14.8, forward: 38, up: 21.8 },
  rightForeArm: { flex: 48 },
  rightHand: { lateral: 6, up: -26, twist: -24 },
  leftShoulder: { forward: 6 },
  leftArm: { lateral: -26, forward: 12 },
  leftForeArm: { flex: 62 },
  leftHand: { lateral: 6 },
  ...STANCE.guard,
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
      ...STANCE.dip,
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
      ...STANCE.coil,
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
      ...STANCE.load,
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
      ...STANCE.contact,
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
      ...STANCE.follow,
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
