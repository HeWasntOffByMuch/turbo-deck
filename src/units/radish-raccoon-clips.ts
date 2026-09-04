/**
 * The radish raccoon's two clips: `run` and `idle` (spec 277).
 *
 * **Generated keys rather than authored ones, and only here.** Every other
 * hand-made clip in this tree is a short list of poses somebody chose --
 * `pig-strike.ts` is seven over 800ms -- because a strike is a *shape*, and the
 * frames between its keys are of no interest. These two are cycles, and a cycle
 * has one property no list of keys guarantees: it has to close. A hand-authored
 * loop whose last key is a re-typed copy of its first is one edit away from a
 * hitch every time it wraps, and the hitch is at the moment of the wrap, which
 * is the one frame nobody scrubs to. Here every channel is a function of the
 * cycle phase, so `at(0)` and `at(1)` are the same call and closing is a
 * property rather than a habit.
 *
 * Keys land on the sampling grid the clip is written at, so `poseAt`'s
 * interpolation is exact at every frame `authorClip` asks for and the curves
 * below are what reaches the file rather than a linear chord across them --
 * which matters, because glTF LINEAR is the only interpolation `glb.ts` writes
 * and shaping has to be baked into the samples.
 *
 * **What the animal is.** Legs a third the length of the foot they end in, arms
 * that are mittens on the front of a sphere, a tail longer than the body, three
 * leaves and two ears. So neither clip is a scaled-down biped cycle: the run is
 * carried by the *body* -- a roll and a yaw at the hip, which is what a round
 * animal on short legs actually does -- with the legs providing the beat rather
 * than the travel, and everything soft on the animal trailing a phase behind
 * it. Amplitudes are small in absolute terms because the limbs are: a 30-degree
 * thigh swing on a 0.11-long leg moves the foot 0.06, which is a stride for
 * something this shape.
 *
 * Pure, and part of the deterministic core.
 */

import type { AuthoredClip, BoneTurns, PoseKey } from './clip-author.js';

/** Turns per key, built up by the curves below before the key is frozen. */
interface Draft {
  turns: Record<string, BoneTurns>;
  bones: Record<string, BoneTurns>;
}

const TAU = Math.PI * 2;
/** A sine of the cycle phase, in turns, with an optional phase offset. */
const wave = (phase: number, offset = 0): number => Math.sin(TAU * (phase + offset));
/** A cosine of the same, for the quantity that peaks where the sine crosses. */
const bounce = (phase: number, offset = 0): number => Math.cos(TAU * (phase + offset));

/**
 * A short one-way flick that is over long before the cycle is.
 *
 * `at` is where in the cycle it starts and `span` how long it lasts, both in
 * turns. The shape is a fast rise and a slower settle -- `sin(pi t) ^ 0.6` --
 * because an ear that eases *in* is an ear being moved rather than an ear
 * twitching, and the twitch is the whole point of the gesture.
 */
function flick(phase: number, at: number, span: number): number {
  const t = (phase - at + 1) % 1;
  if (t > span) return 0;
  return Math.sin(Math.PI * (t / span)) ** 0.6;
}

/**
 * The same window, eased at both ends: a foot leaving the ground and coming
 * back to it.
 *
 * The exponent is the whole difference from {@link flick}. A twitch has to
 * arrive faster than it leaves or it reads as the ear being *moved*; a step has
 * to leave and land softly or the foot arrives like a dropped weight.
 */
function bump(phase: number, at: number, span: number): number {
  const t = (phase - at + 1) % 1;
  if (t > span) return 0;
  return Math.sin(Math.PI * (t / span)) ** 1.6;
}

function add(draft: Draft, into: 'turns' | 'bones', bone: string, turns: BoneTurns): void {
  const table = draft[into];
  const already = table[bone] ?? {};
  const merged: Record<string, number> = { ...already };
  for (const [axis, degrees] of Object.entries(turns)) merged[axis] = (merged[axis] ?? 0) + degrees;
  table[bone] = merged as BoneTurns;
}

/**
 * The greens and the tail, which do the same thing in both clips: trail.
 *
 * Every soft appendage is driven off the *body's* phase with a lag, and the
 * lags differ per blade -- 0.08, 0.13 and 0.05 of a cycle -- so the three never
 * swing as one object. That is the whole trick: three leaves moving in step
 * read as a single fan, and three leaves a beat apart read as leaves.
 *
 * A leaf points up, so a positive `lateral` carries it *forward*: streaming
 * back behind a running animal is the negative sign below.
 */
function appendages(draft: Draft, phase: number, sway: number, lift: number, lag: number): void {
  const blades: readonly (readonly [string, string, number, number])[] = [
    ['Leaf_A_01', 'Leaf_A_02', 0.08, 1.0],
    ['Leaf_B_01', 'Leaf_B_02', 0.13, 0.85],
    ['Leaf_C_01', 'Leaf_C_02', 0.05, 1.15],
  ];
  for (const [root, tip, offset, scale] of blades) {
    const s = wave(phase, -(lag + offset)) * sway * scale;
    const b = bounce(phase, -(lag + offset) * 2) * lift * scale;
    // The tip carries the same motion again at two thirds, one further beat
    // behind: a two-bone chain bending the same way twice is a curve, and
    // bending it once is a stick on a hinge.
    add(draft, 'bones', root, { forward: s, lateral: -b });
    add(draft, 'bones', tip, { forward: wave(phase, -(lag + offset + 0.06)) * sway * scale * 0.66, lateral: -bounce(phase, -(lag + offset + 0.06) * 2) * lift * scale * 0.66 });
  }
  // The tail is four bones and takes the wave down its own length, a twelfth of
  // a cycle per segment, which is what makes it whip rather than wag.
  const tail: readonly string[] = ['Tail01', 'Tail02', 'Tail03', 'Tail04'];
  tail.forEach((bone, index) => {
    const behind = lag + index * 0.085;
    add(draft, 'bones', bone, {
      up: wave(phase, -behind) * sway * (0.6 + index * 0.22),
      lateral: bounce(phase, -behind * 2) * lift * (0.4 + index * 0.2),
    });
  });
}

/**
 * `run`: 600ms, two strides, carried by the body.
 *
 * The stride phase is the cycle; the left leg leads and the right is half a
 * cycle behind it, the arms are opposite their own side's leg, and everything
 * that bobs -- the head, the leaves, the roll of the body -- runs at twice the
 * stride rate, which is what puts a beat on every footfall rather than on every
 * other one.
 */
const RUN_MS = 600;
const RUN_FPS = 40;

function runKey(phase: number): Draft {
  const draft: Draft = { turns: {}, bones: {} };
  const legSwing = 26;
  const kneeFold = 38;

  for (const [side, offset] of [['left', 0], ['right', 0.5]] as const) {
    const s = wave(phase, offset);
    const forwardStroke = Math.max(0, s);
    add(draft, 'turns', `${side}UpLeg`, { lateral: -s * legSwing });
    // The knee folds on the way *back* -- the recovery -- and is straight
    // through the reach, which is the half of a stride an eye actually reads.
    add(draft, 'turns', `${side}Leg`, { flex: Math.max(0, -s) * kneeFold });
    // The toe rolls under at the back of the stroke and levels for the plant.
    add(draft, 'turns', `${side}Toe`, { flex: -Math.max(0, -s) * 14 });
    add(draft, 'turns', `${side}Foot`, { lateral: s * 10 });

    // Contralateral: the arm opposite this leg reaches while it does.
    const other = side === 'left' ? 'right' : 'left';
    add(draft, 'turns', `${other}Arm`, { lateral: -s * 18, up: -s * 6 });
    add(draft, 'turns', `${other}ForeArm`, { flex: forwardStroke * 10 });
  }

  // The body. `up` is the pelvis counter-rotating with the stride, `forward` is
  // the roll onto whichever foot is down -- at twice the rate, because there is
  // a footfall twice a cycle -- and the two together are the waddle.
  add(draft, 'turns', 'hips', { up: wave(phase) * 7, forward: bounce(phase, 0.25) * 6, lateral: -2.5 - bounce(phase, 0) * 2.5 });
  add(draft, 'turns', 'spine', { up: -wave(phase) * 4, forward: -bounce(phase, 0.25) * 3, lateral: -3 });
  // Head: level against the body's roll, and nodding on the footfalls.
  add(draft, 'turns', 'head', { forward: bounce(phase, 0.25) * 4, lateral: 3 + bounce(phase * 2) * 3.5, up: wave(phase) * 3 });

  // Ears flap on the footfalls, a beat behind the head that throws them.
  for (const [ear, offset] of [['L_Ear', 0.06], ['R_Ear', 0.10]] as const) {
    add(draft, 'bones', ear, { lateral: -6 - bounce(phase * 2, -offset) * 11, forward: wave(phase, -offset) * 5 });
  }
  add(draft, 'bones', 'Crown', { lateral: -4, forward: bounce(phase, 0.25) * 3 });
  appendages(draft, phase, 5, 6.5, 0.10);
  return draft;
}

/**
 * `idle`: 4800ms, and long on purpose.
 *
 * The brief is "step from one leg to another, occasionally jerk an ear, let the
 * leaves move around a little", and *occasionally* is a claim about a duration:
 * a twitch on a one-second loop is a tic. So the weight shifts twice over the
 * clip -- 2400ms a side, slow enough to read as settling rather than as
 * dancing -- and the two ear flicks sit at 0.31 and 0.78 of the cycle, on
 * different ears, which is far enough apart in a 4.8-second loop that they
 * never read as a rhythm.
 *
 * The breath is deliberately not a multiple of the shift: 1.6s against 2.4s, so
 * the two only line up at the ends of the clip and the body never looks like it
 * is counting.
 */
/**
 * When the left ear twitches, and for how long, both in turns of the cycle.
 *
 * Exported because it is the one moment in either clip a preview cannot find by
 * sampling evenly: 0.045 of 4800ms is 216ms, so a strip of eight frames over
 * the clip lands on it about a third of the time, and the two outcomes -- a
 * flick photographed and a flick missed -- look identical on the sheet.
 */
export const EAR_FLICK_AT = 0.31;
export const EAR_FLICK_SPAN = 0.045;

/** How long a footfall takes, and how far the knee folds to make one. */
const STEP_SPAN = 0.055;
const STEP_KNEE = 21;

const IDLE_MS = 4800;
const IDLE_FPS = 30;

function idleKey(phase: number): Draft {
  const draft: Draft = { turns: {}, bones: {} };
  // Two shifts per clip, so the shift itself is a full cycle at 2x.
  const shift = wave(phase * 2);
  const breath = wave(phase * 3);

  // The weight goes onto whichever side the roll is toward: that leg
  // straightens and takes the body, the other unloads and bends a little.
  add(draft, 'turns', 'hips', { forward: shift * 4.5, up: -shift * 3, lateral: -2 + breath * 1.2 });
  add(draft, 'turns', 'spine', { forward: -shift * 2, lateral: -2 - breath * 1.6 });
  for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
    const load = Math.max(0, shift * sign);
    const free = Math.max(0, -shift * sign);
    // The step itself. `shift` is positive when the body has rolled onto its
    // right foot, so the left one is free a quarter of a shift later -- which
    // over two shifts a clip is a footfall every 1.2 seconds, slow enough to
    // read as settling rather than as marking time.
    const step = bump(phase, side === 'left' ? 0.125 : 0.375, STEP_SPAN) + bump(phase, side === 'left' ? 0.625 : 0.875, STEP_SPAN);
    // A leg this short cannot lift a foot by swinging: the thigh is 0.06 long,
    // so 5 degrees at the hip is 0.005 of clearance and invisible. The knee is
    // what picks the foot up. It is a *smaller* fold than the run's and still
    // has to be a real angle -- measured at the toe, the run lifts 0.052 and a
    // footfall here lifts 0.041, which is the order those two belong in and is
    // not the order the first pass had them in.
    add(draft, 'turns', `${side}UpLeg`, { forward: shift * 2.5, lateral: -free * 4 - step * 6 });
    add(draft, 'turns', `${side}Leg`, { flex: free * 5 + step * STEP_KNEE });
    add(draft, 'turns', `${side}Foot`, { lateral: free * 4 - load * 2 + step * 9 });
    add(draft, 'turns', `${side}Toe`, { flex: -step * 12 });
    // The unloaded arm hangs a touch further out as that side rises.
    add(draft, 'turns', `${side}Arm`, { lateral: -free * 6, up: shift * sign * 4 });
  }

  // A slow look around, off the shift so the head leads the body slightly.
  add(draft, 'turns', 'head', { up: wave(phase, 0.12) * 7, forward: -shift * 2.5, lateral: 2 + breath * 2 });

  // The ears. A standing pitch back, a slow drift, and the two flicks -- which
  // are the only thing in either clip that is not a wave.
  const flickL = flick(phase, EAR_FLICK_AT, EAR_FLICK_SPAN);
  const flickR = flick(phase, 0.78, 0.040);
  add(draft, 'bones', 'L_Ear', { lateral: -3 - flickL * 34, forward: wave(phase, 0.2) * 3 + flickL * 12, twist: flickL * 18 });
  add(draft, 'bones', 'R_Ear', { lateral: -3 - flickR * 31, forward: wave(phase, 0.05) * 3 - flickR * 11, twist: -flickR * 16 });

  add(draft, 'bones', 'Crown', { forward: shift * 2, lateral: -1.5 + breath * 1.5 });
  appendages(draft, phase, 4.5, 2.6, 0.16);
  // A second drift on the blades alone, so the greens never settle into a pose.
  // Each blade gets its own pair of rates and its own pair of offsets, and
  // **every rate is a whole number**: a non-integer rate does not complete a
  // whole number of oscillations over the clip, so the blade is somewhere else
  // at phase 1 than it was at phase 0 and the loop hitches every time it wraps.
  // The first cut used 0.7, 1.3 and 1.0 for exactly the reason the comment gave
  // -- periods sharing no factor with the shift -- and that reasoning is right
  // about not locking and wrong about closing. Different integers and different
  // offsets buy the first without costing the second.
  const drifts: readonly (readonly [string, number, number, number, number])[] = [
    ['Leaf_A_02', 1, 0.33, 2, 0.1],
    ['Leaf_B_02', 2, 0.61, 1, 0.44],
    ['Leaf_C_02', 1, 0.87, 3, 0.22],
  ];
  for (const [bone, upRate, upAt, forwardRate, forwardAt] of drifts) {
    add(draft, 'bones', bone, { up: wave(phase * upRate, upAt) * 4, forward: wave(phase * forwardRate, forwardAt) * 3 });
  }
  return draft;
}

/** Keys on the clip's own sampling grid, so nothing is interpolated twice. */
function cycle(id: string, durationMs: number, fps: number, key: (phase: number) => Draft): AuthoredClip {
  const frames = Math.round((durationMs / 1000) * fps);
  const keys: PoseKey[] = [];
  for (let frame = 0; frame <= frames; frame += 1) {
    const drafted = key(frame / frames);
    keys.push({
      label: `${id} ${frame}`,
      atMs: (frame / frames) * durationMs,
      // The curves above are the shaping; an ease between two samples a frame
      // apart would be a second one on top of it.
      ease: 'linear',
      turns: drafted.turns,
      bones: drafted.bones,
    });
  }
  return { id, durationMs, fps, keys };
}

export const RADISH_RACCOON_RUN: AuthoredClip = cycle('run', RUN_MS, RUN_FPS, runKey);
export const RADISH_RACCOON_IDLE: AuthoredClip = cycle('idle', IDLE_MS, IDLE_FPS, idleKey);
export const RADISH_RACCOON_CLIPS: readonly AuthoredClip[] = [RADISH_RACCOON_RUN, RADISH_RACCOON_IDLE];
