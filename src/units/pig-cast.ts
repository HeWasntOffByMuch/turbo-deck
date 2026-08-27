/**
 * The pig's spell cast, as a table of poses (spec 231).
 *
 * `pig-strike.ts` and `pig-shot.ts` are the same file for the sword and the
 * bow, and everything structural here is theirs: keys in the body's own axes,
 * sampled at 60Hz by `clip-author.ts`, written by `glb.ts`, reviewed as a diff
 * of this table rather than as a blob of bytes. What is new is the shape of the
 * action and one property neither of them needed.
 *
 * ## What it is
 *
 * Hands swept in to the chest, a coil that creeps rather than freezing, and
 * both arms thrown forward on the release frame. It is that shape rather than
 * a one-handed point for the reason the swing is a chop rather than a
 * horizontal sweep: the camera is isometric and a body is a few dozen pixels
 * tall, so silhouette is the whole budget. Two hands drawn in to a single spot
 * and then thrown out together is a shape that reads at forty pixels; one arm
 * lifting is a limb moving inside an outline.
 *
 * ## The one thing neither of the other two had to do
 *
 * **This clip is shared, and they were not.** `slash` was authored for
 * `melee.slash` and `shoot` for `ranged.shot`, so each one's own beat *is* that
 * ability's wind-up and playing it at the authored speed is already right. Every
 * spell in the table casts through this one, and their wind-ups run from
 * `channel.drain`'s 0.5s to `ground.quake`'s 1.4s -- so what makes the picture
 * land on the beat is not this file, it is `unit-driver.ts`'s `clipStretch`,
 * which rebases the playback rate so that {@link CAST_RELEASE_MS} arrives on the
 * tick the sim resolves whichever spell is being cast.
 *
 * That is also what fixes {@link CAST_RELEASE_MS} rather than leaving it to
 * taste; see the comment on it.
 *
 * ## Where it inverts the shot
 *
 * **The body unwinds, and the unwind is the point.** `pig-shot.ts` keeps its
 * chest turning the *same* way through the loose, because what sends an arrow
 * is back tension rather than rotation. A cast is the opposite: the torso curls
 * down over the gathered hands and then opens, and that opening is what throws
 * the arms. So every spine and chest angle that is positive through the coil has
 * gone negative by the release.
 *
 * **The gaze goes down and then up.** The pig looks at its own hands while it
 * is gathering and at what it is casting at when it lets go. It is the cheapest
 * legible beat in the clip and it costs two numbers a key.
 *
 * **The extension is a strike.** The release is eased `in`, so the fastest
 * instant of the whole clip is the frame the spell lands -- `pig-strike.ts`'s
 * rule about contact, and for its reason: the frame the picture lands and the
 * frame the damage lands are the same frame or the animation is lying about
 * when it was safe to stand there.
 *
 * ## What it borrows whole
 *
 * The stance. Every key holds the same hips and the same six leg angles as the
 * swing's guard, shared as an object rather than copied, so a foot cannot slide
 * by construction and none of `scripts/plant-foot.ts` is needed. A caster plants
 * their feet and does everything above the waist, which is the same fact from
 * the other end -- and it means all three of this rig's authored clips leave the
 * idle on the same legs.
 *
 * ## The angles are in the body's axes
 *
 * `lateral` swings a limb through the sagittal plane -- positive takes a hanging
 * arm *backwards* and tips an upright spine *forwards*, which is the same
 * rotation seen from two ends. `forward` lifts a limb sideways. `up` sweeps
 * horizontally, and positive is toward the pig's left. `flex` is the bone's own
 * hinge and positive folds it. See `pose.ts`.
 *
 * Both arms are solved rather than authored, by `scripts/aim-cast.ts`: the table
 * there states where each hand should *be* in the body's own axes and answers
 * with the shoulder and elbow that put it there.
 *
 * Pure, and part of the deterministic core.
 */

import { STRIKE_GUARD_LEGS } from './pig-strike.js';
import type { AuthoredClip, PoseKey, PoseTable } from './clip-author.js';
import type { ClipEvent } from './types.js';

/**
 * The clip id.
 *
 * Not one of `scaffold.ts`'s retarget preset names, because there is no retarget
 * preset for this -- nothing was bought that looks like a body casting a spell,
 * which is why the file exists. It is the id the cliplib, the unitdef's `focus`
 * state and `make-pig-cast.ts` all name.
 */
export const CAST_CLIP_ID = 'cast';

export const CAST_DURATION_MS = 1250;

/**
 * The instant the spell is real.
 *
 * **Derived rather than chosen**, and it is the one number in this file that
 * had to be worked out rather than looked at. Every spell in the table casts
 * through this clip, so the clip is rescaled per ability by
 * `unit-driver.ts`'s `clipStretch` -- and the pig's `maxTimeScale` is 2, so the
 * authored release has to sit where *every* cast wind-up is within a 2x stretch
 * of it. The wind-ups run 0.5s (`channel.drain`) to 1.4s (`ground.quake`), which
 * puts it in `[0.5 * 1400, 2 * 500]` = `[700, 1000]`ms.
 *
 * The point in that window minimising the worst stretch is the geometric mean,
 * `sqrt(500 * 1400) = 837ms`. 850 is the nearest value on the 50ms grid the
 * other two authored clips are already on, and -- which matters more -- it is
 * a whole 60Hz sample of a 1250ms clip, so the pose on the release frame is
 * the authored pose rather than an interpolation a frame either side of it.
 *
 * Worst stretch at 850 is 1.70x. `pig-cast.test.ts` asserts that over the
 * ability table rather than trusting this paragraph, so a spell authored
 * outside the window fails a test instead of shipping as a twitch.
 */
export const CAST_RELEASE_MS = 850;

/** Where the file's own beats are, so the preview and the tests can name them. */
export const CAST_KEY_MS = {
  ready: 0,
  gather: 260,
  focus: 720,
  release: CAST_RELEASE_MS,
  follow: 950,
  settle: CAST_DURATION_MS,
} as const;

/**
 * The waist down, identical in every key.
 *
 * The swing's guard legs, not a second set of numbers, for the reason
 * `pig-shot.ts` gives about the same object: all three clips are entered from
 * the idle across a 60ms cross-fade, so a stance authored at the bind pose would
 * snap the pig's 35-degree knees straight and back again inside a tenth of a
 * second. `hips` rides along and must not move either, because the hips carry
 * both legs -- a yaw here is a yaw at both feet.
 *
 * The 8 degrees is the shot's, and `pig-cast.test.ts` asserts the two agree
 * rather than leaving it as a number that happens to be typed twice.
 */
const PLANTED = {
  hips: { up: -8 },
  ...STRIKE_GUARD_LEGS,
} as const satisfies PoseTable;

/**
 * The pose the cast starts and ends in.
 *
 * Hands up and open in front of the waist: a body about to do something rather
 * than a body at rest. It is also the last key, exactly the same object, so a
 * cast thrown at the end of a cast has nothing to jump over.
 *
 * It is deliberately **not** where the idle leaves the arms, and that is the one
 * compromise in this file. The idle's own hands hang at `up: 0.058`, and a
 * `ready` authored there fades into this clip perfectly -- and puts the whole
 * recovery on a much longer journey than the push, because the push starts from
 * the chest and is already half way. Measured that way round the settle came
 * back **four times faster than the extension**, which reads as the body being
 * yanked rather than as a follow-through. Half way up costs a little of the
 * 60ms entry blend, which is what `pig-shot.ts`'s bow-ready stance already
 * spends, and buys a release that is the fastest movement in its own clip.
 */
const READY = {
  ...PLANTED,
  spine: { lateral: 2 },
  chest: { lateral: 2 },
  neck: { lateral: 2 },
  head: { lateral: 1 },
  leftShoulder: { forward: 2 },
  leftArm: { lateral: -0.5, forward: -24.4, up: 13 },
  leftForeArm: { flex: 75.7 },
  leftHand: {},
  rightShoulder: { forward: 2 },
  rightArm: { lateral: -8.8, forward: 18.4, up: 16.4 },
  rightForeArm: { flex: 67.8 },
  rightHand: {},
} as const satisfies PoseTable;

const KEYS: readonly PoseKey[] = [
  {
    label: 'ready',
    atMs: CAST_KEY_MS.ready,
    ease: 'linear',
    turns: READY,
  },
  {
    // The hands come in. ONE movement, eased `inOut` -- `pig-strike.ts`'s rule
    // about a raise, with both ends of it used: the pig accelerates out of
    // whatever it was doing and *settles* at the chest, rather than snapping
    // there and holding, which is a body flinching rather than a body starting
    // something.
    label: 'gather',
    atMs: CAST_KEY_MS.gather,
    ease: 'inOut',
    turns: {
      ...PLANTED,
      spine: { lateral: 9 },
      chest: { lateral: 8, up: -3 },
      neck: { lateral: 6 },
      head: { lateral: 2 },
      leftShoulder: { forward: 6 },
      leftArm: { lateral: 7.3, forward: 7.9, up: -47.9 },
      leftForeArm: { flex: 105.2 },
      leftHand: {},
      rightShoulder: { forward: 6 },
      rightArm: { lateral: -16.1, forward: 0.4, up: 80.4 },
      rightForeArm: { flex: 89.7 },
      rightHand: {},
    },
  },
  {
    // The coil, and it *creeps*. `pig-shot.ts` learned this at its anchor: a
    // pose held perfectly still through a readable commitment reads as a
    // dropped frame rather than as a body holding something back. So the hands
    // press a little closer together, the elbows wing further out, and the
    // torso goes a little further over them -- 460ms of small, continuous
    // movement at a ninetieth of the speed of what follows it.
    //
    // The gaze goes down to the hands and comes back up at the release, which
    // is the cheapest legible beat in the clip -- but the *neck* does much less
    // of the coil than the chest does, and that is spec 163's finding rather
    // than taste: a body whose face disappears into its own chest is the shape
    // that spec exists to have noticed, and the first cut of this pose buried
    // it. The torso carries the coil; the head only leans into it.
    //
    // It sits at 720 rather than half way, and that is what makes the extension
    // the fastest thing in the clip rather than merely a fast thing in it. The
    // hands travel about 0.16 of a body from here to the release; over the
    // 230ms a mid-clip key would leave, that is slower than the recovery, and a
    // cast whose recovery outruns its push reads as the body being yanked. Over
    // 130ms -- eight frames, near enough the swing's own six -- it is half
    // again faster than anything else here. The long readable part of a
    // commitment is the coil; the release is a snap.
    label: 'focus',
    atMs: CAST_KEY_MS.focus,
    ease: 'linear',
    turns: {
      ...PLANTED,
      spine: { lateral: 12 },
      chest: { lateral: 11, up: -4 },
      neck: { lateral: 7 },
      head: { lateral: 2 },
      leftShoulder: { forward: 9, up: 3 },
      leftArm: { lateral: -0.3, forward: 18.9, up: -61.9 },
      leftForeArm: { flex: 113.3 },
      leftHand: {},
      rightShoulder: { forward: 9, up: -3 },
      rightArm: { lateral: -27, forward: -4.9, up: 95.5 },
      rightForeArm: { flex: 99.1 },
      rightHand: {},
    },
  },
  {
    // The release, and the frame the spell exists. Eased `in`, so the fastest
    // instant of the whole clip is this one -- the strike's rule, and the whole
    // of why a cast reads as a cast rather than as an arm being extended.
    //
    // The torso uncoils through it: 12 degrees over the hands at the focus, 0
    // here, and that uncoil is what throws the arms rather than the shoulders
    // doing it alone. It is also where this clip inverts `pig-shot.ts`, whose
    // chest keeps turning the *same* way through the loose because what sends
    // an arrow is back tension. A cast is thrown by the body opening.
    label: 'release',
    atMs: CAST_KEY_MS.release,
    ease: 'in',
    turns: {
      ...PLANTED,
      spine: { lateral: 0 },
      chest: { lateral: -3, up: 2 },
      neck: { lateral: -4 },
      head: { lateral: -3 },
      leftShoulder: { forward: 4, up: -4 },
      leftArm: { lateral: -42.5, forward: -29.7, up: -27.1 },
      leftForeArm: { flex: 19.8 },
      leftHand: {},
      rightShoulder: { forward: 4, up: 4 },
      rightArm: { lateral: -42.9, forward: 33.4, up: 54.4 },
      rightForeArm: { flex: 13.3 },
      rightHand: {},
    },
  },
  {
    // A hundred milliseconds past it: the hands go a little further out and
    // noticeably further *apart*, and the elbows straighten from 20 and 13
    // degrees of fold to 13 and 6. A limb that stops where it arrived has no
    // weight in it, which is the follow-through's reason in the swing too --
    // and the spreading is the half of it that survives at forty pixels, where
    // a couple of hundredths of extra reach does not.
    //
    // The body follows the hands rather than recoiling away from them: the
    // spine comes back *forward* through here. Recoiling reads well in a still
    // and costs the overshoot everything, because a chest that leans back
    // carries both shoulders back with it and the arms are already as long as
    // they get.
    label: 'follow',
    atMs: CAST_KEY_MS.follow,
    ease: 'out',
    turns: {
      ...PLANTED,
      spine: { lateral: 4 },
      chest: { lateral: 0, up: 3 },
      neck: { lateral: -2 },
      head: { lateral: -2 },
      leftShoulder: { forward: 2, up: -5 },
      leftArm: { lateral: -59.9, forward: -26.1, up: -18.5 },
      leftForeArm: { flex: 12.5 },
      leftHand: {},
      rightShoulder: { forward: 2, up: 5 },
      rightArm: { lateral: -59.5, forward: 32.5, up: 43.9 },
      rightForeArm: { flex: 6.1 },
      rightHand: {},
    },
  },
  {
    // Back to `READY`, the same object rather than a copy of its numbers, so
    // the two cannot drift apart. The spell has already landed and the body is
    // already free to move, so this is the part a player is most likely to walk
    // out of the middle of.
    //
    // 300ms, which is longer than either other authored clip's recovery and is
    // measured rather than picked: the hands travel further coming home than
    // going out, because the push starts from the chest and is already half way
    // there. At the swing's 200ms the settle came back four times faster than
    // the extension. `pig-cast.test.ts` bounds it against the extension's own
    // peak rather than against a number.
    label: 'settle',
    atMs: CAST_KEY_MS.settle,
    ease: 'inOut',
    turns: READY,
  },
];

export const PIG_CAST: AuthoredClip = {
  id: CAST_CLIP_ID,
  durationMs: CAST_DURATION_MS,
  // 60, because the extension is eight frames long and the acceleration is in
  // the samples. See `clip-author.ts`.
  fps: 60,
  keys: KEYS,
};

/**
 * The two markers the action timing maps.
 *
 * `swing.start` and `swing.impact`, which read oddly for a spell and are
 * correct: they are `scaffold.ts`'s names for *the attack point*, and a clip
 * authored here and a clip scaffolded from a retarget have to hand the same
 * vocabulary to the same `eventMap`. The alternative is a third spelling that
 * validates only because its author remembered which of three words this unit
 * used -- which is the argument `pig-shot.ts` made for the second one.
 */
export const CAST_EVENTS: readonly ClipEvent[] = [
  { name: 'swing.start', normalizedTime: 0 },
  { name: 'swing.impact', normalizedTime: CAST_RELEASE_MS / CAST_DURATION_MS },
];
