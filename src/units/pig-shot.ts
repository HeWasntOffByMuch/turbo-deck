/**
 * The pig's bow shot, as a table of poses (spec 164).
 *
 * `pig-strike.ts` is the same file for the sword and everything structural here
 * is borrowed from it: keys in the body's own axes, sampled at 60Hz by
 * `clip-author.ts`, written by `glb.ts`, reviewed as a diff of this table rather
 * than as a blob of bytes. What is different is the shape of the action, and the
 * differences are the interesting part.
 *
 * ## Three beats, and the middle one is a boundary
 *
 * `ranged.shot` has `windupTicks: seconds(0.8)` and `backswingTicks:
 * seconds(0.35)`, so the clip is 1150ms with the arrow leaving at 800. The
 * user-facing division -- wind-up, shot, recovery -- is `attack-timing.ts`'s
 * division exactly: the draw is the interval a withdrawal still refunds, the
 * loose is the attack point, and the recovery is the backswing a body may walk
 * out of for free.
 *
 * ## Where it inverts the sword
 *
 * **A draw is one movement, and then it is let go.** The first half obeys
 * `pig-strike.ts`'s rule about a raise -- `in` into the nock, `linear` through
 * the sweep, `out` into full draw, so the string hand accelerates, cruises and
 * settles without ever stopping. Authored with an eased key in the middle it
 * stalled at the nock for two frames, which is the pig taking hold of the
 * string twice.
 *
 * **The release is a velocity discontinuity, and that is the whole point.**
 * `pig-strike.ts`'s hardest-won rule is that a raise is one movement -- its
 * wind-up used to stall in the middle and read as two raises. A draw is the
 * opposite: the string is pulled, *held still while it is aimed*, and then let
 * go instantly. So `anchor` is arrived at eased `out` and left eased `out`, with
 * zero velocity into it and full velocity off it. In a swing that would be a
 * dead beat and a whip; in a shot it is the aim and the loose, and it is the
 * only way a bow can read as a bow.
 *
 * **The body does not unwind.** A chop passes through square -- every rotation
 * that was negative at the coil has gone positive by contact, which is what
 * makes it a body throwing a blade rather than an arm travelling on its own. An
 * archer's chest keeps turning the *same* way through the loose, a few degrees
 * further into it, because what makes an arrow go is back tension rather than
 * rotation. Only the string hand travels.
 *
 * **The stance is set before the shot and never moves.** Every key here holds
 * the same `hips` value and the same six leg angles, taken from the sword's own
 * guard so both clips cross-fade out of the idle with the same legs. That is not
 * thrift: `scripts/plant-foot.ts` exists because the swing yaws its pelvis 54
 * degrees and drags a planted foot a fifth of a body across the floor. A clip
 * whose hips and legs are *identical* in every key cannot slide a foot, so this
 * one needs no solver and gets the property for free. An archer sets their feet
 * and shoots with everything above the waist, which is the same fact from the
 * other end.
 *
 * ## Which hand does what
 *
 * The bow is in the **left** hand -- `weapon.off` -- and the string is drawn
 * with the right. So the left arm goes out and stays out, and the right arm does
 * all the travelling. Both arms are solved rather than authored, by
 * `scripts/aim-bow.ts`: the table below states where each hand should *be*, in
 * the body's own axes, and the solver answers with the shoulder, elbow and wrist
 * that put it there.
 *
 * The rig's arms are why the anchor is behind the ear rather than at the jaw.
 * The right upper arm is 0.178 and the forearm 0.114 against a rig standing
 * 0.998, so a hand brought to the corner of the mouth -- 0.10 from the shoulder
 * on this body -- needs the elbow folded past 160 degrees, which does not read
 * as a draw, it reads as a broken arm. A hand cannot be closer than about 0.156
 * to the shoulder without going past 120 degrees of fold, so the anchor is where
 * the linkage allows and the draw is deep. At forty pixels a big draw reads and
 * an anatomically sited one does not.
 *
 * Pure, and part of the deterministic core.
 */

import { STRIKE_GUARD_LEGS } from './pig-strike.js';
import type { AuthoredClip, PoseKey, PoseTable } from './clip-author.js';
import type { ClipEvent } from './types.js';

/** The clip id, which is the retarget's own preset vocabulary (`scaffold.ts`). */
export const SHOT_CLIP_ID = 'shoot';

export const SHOT_DURATION_MS = 1150;

/**
 * The instant the arrow leaves.
 *
 * `ranged.shot`'s wind-up, in milliseconds, and asserted against the ability
 * table rather than restated there -- re-tuning the shot has to fail a test
 * rather than quietly leave the picture behind. The same rule the strike's
 * contact is under, for the same reason: the frame the picture lands and the
 * frame the arrow exists are the same frame or the animation is lying about
 * when it was safe to stand there.
 */
export const SHOT_RELEASE_MS = 800;

/** Where the file's own beats are, so the preview and the tests can name them. */
export const SHOT_KEY_MS = {
  stance: 0,
  raise: 180,
  sweep: 480,
  pull: 680,
  anchor: SHOT_RELEASE_MS,
  loose: 880,
  settle: SHOT_DURATION_MS,
} as const;

/**
 * The waist down, identical in every key.
 *
 * The sword's guard legs, not a second set of numbers: both clips are entered
 * from the idle across a 60ms cross-fade, so a stance authored at the bind pose
 * would snap the pig's 35-degree knees straight and back again inside a tenth
 * of a second. Sharing the object rather than copying it means the two cannot
 * drift apart.
 *
 * `hips` rides along for the same reason it must not move: the hips carry both
 * legs, so a yaw here is a yaw at both feet.
 */
const PLANTED = {
  hips: { up: -8 },
  ...STRIKE_GUARD_LEGS,
} as const satisfies PoseTable;

/**
 * The pose the shot starts and ends in.
 *
 * A low ready: the bow hand out in front at chest height, the string hand near
 * it. Deliberately not the idle's own arms -- a body that is holding a bow is
 * holding it before the shot starts, and the transition into this clip is 60ms.
 * It is also the last key, exactly, so a shot thrown at the end of a shot has
 * nothing to jump over.
 */
const STANCE = {
  ...PLANTED,
  spine: { lateral: 2, up: -2 },
  chest: { up: -4 },
  neck: { up: 4, lateral: 2 },
  head: { lateral: 2 },
  leftShoulder: { forward: 4 },
  leftArm: { lateral: -1.2, forward: -17.8, up: -4.4 },
  leftForeArm: { flex: 90.1 },
  leftHand: { lateral: 4 },
  rightShoulder: { forward: -2 },
  rightArm: { lateral: -4.5, forward: 38.7, up: 55.9 },
  rightForeArm: { flex: 72.8 },
  rightHand: { lateral: 4 },
} as const satisfies PoseTable;

const KEYS: readonly PoseKey[] = [
  {
    label: 'stance',
    atMs: SHOT_KEY_MS.stance,
    ease: 'linear',
    turns: STANCE,
  },
  {
    // The bow comes up and the string is taken. One movement, eased `in` --
    // `pig-strike.ts`'s rule about a raise holds here, because this half of the
    // clip really is a raise: what inverts it is the release, not the approach.
    label: 'raise',
    atMs: SHOT_KEY_MS.raise,
    ease: 'in',
    turns: {
      ...PLANTED,
      spine: { lateral: 1, up: -5 },
      chest: { up: -8 },
      neck: { up: 7, lateral: 2 },
      head: { lateral: 2 },
      leftShoulder: { forward: 8 },
      leftArm: { lateral: -29.8, forward: -17.2, up: -4.5 },
      leftForeArm: { flex: 81.6 },
      leftHand: { lateral: 4 },
      rightShoulder: { forward: -6 },
      rightArm: { lateral: -30.2, forward: 42.4, up: 50.1 },
      rightForeArm: { flex: 62.5 },
      rightHand: { lateral: 4 },
    },
  },
  {
    // Halfway, and the reason there is a key here at all is the pig's own arm.
    // The string hand's route from the nock to the anchor passes within 0.04 of
    // its own shoulder if it goes straight, and that is a fold of 160 degrees
    // on a 0.178-and-0.114 arm -- not a draw, a broken elbow. So the hand goes
    // *outboard*, round the ribs with the elbow flaring, which is what a draw
    // seen from above actually does. Without this key the ease drew the
    // straight line and the solver could not reach any of it.
    label: 'sweep',
    atMs: SHOT_KEY_MS.sweep,
    ease: 'linear',
    turns: {
      ...PLANTED,
      spine: { lateral: -1, up: -7 },
      chest: { up: -13, lateral: -2 },
      neck: { up: 12, lateral: 3 },
      head: { lateral: 2 },
      leftShoulder: { forward: 11 },
      leftArm: { lateral: -52.3, forward: -21, up: -5.7 },
      leftForeArm: { flex: 39.2 },
      leftHand: { lateral: 4 },
      rightShoulder: { forward: -10, up: -6 },
      rightArm: { lateral: -39.3, forward: -14.9, up: 23.6 },
      rightForeArm: { flex: 95.2 },
      rightHand: { lateral: 4 },
    },
  },
  {
    // Full draw. The bow arm reached its extension at the sweep and stops
    // there; from here to the loose only the string hand moves.
    label: 'pull',
    atMs: SHOT_KEY_MS.pull,
    ease: 'out',
    turns: {
      ...PLANTED,
      spine: { lateral: -2, up: -8 },
      chest: { up: -17, lateral: -3 },
      neck: { up: 16, lateral: 4 },
      head: { lateral: 2 },
      leftShoulder: { forward: 12 },
      leftArm: { lateral: -56.4, forward: -18.4, up: -3.4 },
      leftForeArm: { flex: 25.3 },
      leftHand: { lateral: 4 },
      rightShoulder: { forward: -15, up: -9 },
      rightArm: { lateral: 51.1, forward: -55.5, up: -81 },
      rightForeArm: { flex: 123.4 },
      rightHand: { lateral: 4 },
    },
  },
  {
    // Full draw, and the frame the arrow leaves on. Nearly `pull`, a few
    // degrees further into it: 240ms is the readable commitment this whole game
    // is built on, and a pose held perfectly still through it reads as a
    // dropped frame rather than as a body holding something back.
    label: 'anchor',
    atMs: SHOT_KEY_MS.anchor,
    ease: 'linear',
    turns: {
      ...PLANTED,
      spine: { lateral: -3, up: -9 },
      chest: { up: -19, lateral: -4 },
      neck: { up: 18, lateral: 5 },
      head: { lateral: 2 },
      leftShoulder: { forward: 13 },
      leftArm: { lateral: -58.9, forward: -16.9, up: -2.7 },
      leftForeArm: { flex: 13.7 },
      leftHand: { lateral: 4 },
      rightShoulder: { forward: -16, up: -10 },
      rightArm: { lateral: 49.8, forward: -59.4, up: -77.3 },
      rightForeArm: { flex: 120.1 },
      rightHand: { lateral: 4 },
    },
  },
  {
    // The loose. 80ms, and the only thing that really moves is the string hand,
    // which is thrown back off the anchor as the fingers open. The bow arm
    // holds -- a bow arm that dropped on release would be an archer flinching,
    // and it is the *stillness* of that arm against the speed of the other that
    // says an arrow just left.
    label: 'loose',
    atMs: SHOT_KEY_MS.loose,
    ease: 'out',
    turns: {
      ...PLANTED,
      spine: { lateral: -3, up: -11 },
      chest: { up: -23, lateral: -4 },
      neck: { up: 21, lateral: 5 },
      head: { lateral: 2 },
      leftShoulder: { forward: 12 },
      leftArm: { lateral: -48, forward: -11.5, up: 7.8 },
      leftForeArm: { flex: 40.6 },
      leftHand: { lateral: 4 },
      rightShoulder: { forward: -22, up: -14 },
      rightArm: { lateral: 7.5, forward: -54.3, up: -28.3 },
      rightForeArm: { flex: 66.8 },
      rightHand: { lateral: 4 },
    },
  },
  {
    // Back to `STANCE`, the same object rather than a copy of its numbers, so
    // the two cannot drift apart. 270ms eased `out`, which is the backswing --
    // longer than it needs to be to get there, and the part a player watching a
    // ranged fight spends most of their time looking at.
    label: 'settle',
    atMs: SHOT_KEY_MS.settle,
    ease: 'inOut',
    turns: STANCE,
  },
];

export const PIG_SHOT: AuthoredClip = {
  id: SHOT_CLIP_ID,
  durationMs: SHOT_DURATION_MS,
  // 60, because the loose is four frames long and the acceleration is in the
  // samples. See `clip-author.ts`.
  fps: 60,
  keys: KEYS,
};

/**
 * The two markers the action timing maps.
 *
 * `swing.start` and `swing.impact`, which read oddly for a bow and are correct:
 * they are `scaffold.ts`'s names for *the attack point*, and a clip authored
 * here and a clip scaffolded from a retarget have to hand the same vocabulary
 * to the same `eventMap`. The alternative is a second spelling that validates
 * only because its author remembered which of two words this unit used.
 */
export const SHOT_EVENTS: readonly ClipEvent[] = [
  { name: 'swing.start', normalizedTime: 0 },
  { name: 'swing.impact', normalizedTime: SHOT_RELEASE_MS / SHOT_DURATION_MS },
];
