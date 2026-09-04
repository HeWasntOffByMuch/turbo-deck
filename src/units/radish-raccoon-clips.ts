/**
 * The radish raccoon's clips: `run`, `idle` and `attack` (spec 277).
 *
 * **Two of the three are generated keys rather than authored ones.** Every other
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
 * `attack` is the other kind and is authored the other way, as six poses
 * somebody chose. It is a *shape* -- a coil, a snap and a recovery, with a
 * single frame that has to be the frame the blow lands -- and the frames
 * between its keys are of no interest, which is exactly the argument
 * `pig-strike.ts` makes for the swing it authors. A cycle generated from a
 * phase and a strike authored as poses are not two styles; they are two
 * different things being described.
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

import type { AuthoredClip, BoneTurns, Easing, PoseKey } from './clip-author.js';

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
 *
 * The blades and the tail take **separate amplitudes**, and that is the fix
 * rather than a convenience. They shared one pair, so calming the tail -- which
 * is 0.49 long against a 0.55 body and is therefore most of the silhouette --
 * took the leaves down with it and left the greens looking pinned. What was too
 * much was one long appendage, not everything soft on the animal.
 */
interface Trail {
  readonly leafSway: number;
  readonly leafLift: number;
  readonly tailSway: number;
  readonly tailLift: number;
  readonly lag: number;
}

function appendages(draft: Draft, phase: number, trail: Trail): void {
  const blades: readonly (readonly [string, string, number, number])[] = [
    ['Leaf_A_01', 'Leaf_A_02', 0.08, 1.0],
    ['Leaf_B_01', 'Leaf_B_02', 0.13, 0.85],
    ['Leaf_C_01', 'Leaf_C_02', 0.05, 1.15],
  ];
  for (const [root, tip, offset, scale] of blades) {
    const behind = trail.lag + offset;
    const s = wave(phase, -behind) * trail.leafSway * scale;
    const b = bounce(phase, -behind * 2) * trail.leafLift * scale;
    // The tip carries the same motion again at two thirds, one further beat
    // behind: a two-bone chain bending the same way twice is a curve, and
    // bending it once is a stick on a hinge.
    add(draft, 'bones', root, { forward: s, lateral: -b });
    add(draft, 'bones', tip, {
      forward: wave(phase, -(behind + 0.06)) * trail.leafSway * scale * 0.66,
      lateral: -bounce(phase, -(behind + 0.06) * 2) * trail.leafLift * scale * 0.66,
    });
  }
  // The tail is four bones and takes the wave down its own length, a twelfth of
  // a cycle per segment, which is what makes it whip rather than wag.
  const tail: readonly string[] = ['Tail01', 'Tail02', 'Tail03', 'Tail04'];
  tail.forEach((bone, index) => {
    const behind = trail.lag + index * 0.085;
    add(draft, 'bones', bone, {
      up: wave(phase, -behind) * trail.tailSway * (0.6 + index * 0.22),
      lateral: bounce(phase, -behind * 2) * trail.tailLift * (0.4 + index * 0.2),
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
  // A stride on a leg 0.11 long from hip to toe. 40 degrees at the thigh swings
  // the foot about 0.07, which against a body 0.55 tall is the difference
  // between an animal running and an animal being carried along by its own
  // waddle -- which is what the first cut was, because the body was doing all
  // of the moving and the legs almost none.
  const legSwing = 40;
  const kneeFold = 54;

  for (const [side, offset] of [['left', 0], ['right', 0.5]] as const) {
    const s = wave(phase, offset);
    const forwardStroke = Math.max(0, s);
    const recovery = Math.max(0, -s);
    add(draft, 'turns', `${side}UpLeg`, { lateral: -s * legSwing });
    // The knee folds on the way *back* -- the recovery -- and is straight
    // through the reach, which is the half of a stride an eye actually reads.
    add(draft, 'turns', `${side}Leg`, { flex: recovery * kneeFold });
    // The toe rolls under at the back of the stroke and levels for the plant.
    add(draft, 'turns', `${side}Toe`, { flex: -recovery * 20 });
    // The ankle straightens into the reach and cocks up over the recovery, so
    // the foot is flat at the moment it would touch and clear of the ground on
    // its way past.
    add(draft, 'turns', `${side}Foot`, { lateral: s * 16 - recovery * 8 });

    // Contralateral: the arm opposite this leg reaches while it does.
    const other = side === 'left' ? 'right' : 'left';
    add(draft, 'turns', `${other}Arm`, { lateral: -s * 26, up: -s * 7 });
    add(draft, 'turns', `${other}ForeArm`, { flex: forwardStroke * 16 });
  }

  // The body, and this is the half that had to come *down*.
  //
  // `forward` is the roll onto whichever foot is down and it happens once a
  // cycle, which is right -- a cycle is two steps, and a body rolls left then
  // right over the pair. What was wrong was how far: 6 degrees at the hip
  // against 3 of counter-roll at the spine and another 4 at the head is 7
  // degrees of lean at the ears, on a sphere, twice a second. `lateral` was
  // worse: a *once-per-cycle* pitch is a lurch, because it nods the body
  // forward on one footfall and not the other. There are two footfalls in a
  // cycle, so the bob belongs on `phase * 2` and always did -- the comment
  // this replaces claimed it was already there, and it was not.
  add(draft, 'turns', 'hips', { up: wave(phase) * 5, forward: bounce(phase, 0.25) * 2.2, lateral: 1.5 - bounce(phase * 2) * 1.6 });
  add(draft, 'turns', 'spine', { up: -wave(phase) * 3, forward: -bounce(phase, 0.25) * 1.0, lateral: -0.5 });
  // Head: level against what roll is left, and nodding on the footfalls.
  add(draft, 'turns', 'head', { forward: bounce(phase, 0.25) * 1.5, lateral: 2 + bounce(phase * 2) * 2.5, up: wave(phase) * 2 });

  // Ears flap on the footfalls, a beat behind the head that throws them.
  for (const [ear, offset] of [['L_Ear', 0.06], ['R_Ear', 0.10]] as const) {
    add(draft, 'bones', ear, { lateral: -6 - bounce(phase * 2, -offset) * 11, forward: wave(phase, -offset) * 5 });
  }
  add(draft, 'bones', 'Crown', { lateral: -4, forward: bounce(phase, 0.25) * 1.5 });
  // The tail came down with the body. It is the longest thing on the animal --
  // 0.49 against a 0.55 body -- so its sway is most of the silhouette, and at
  // the old 5 degrees a segment it swung about 25 at the tip once a cycle,
  // which reads as the whole creature swaying rather than as a tail.
  appendages(draft, phase, { leafSway: 5, leafLift: 6.5, tailSway: 2.6, tailLift: 4, lag: 0.1 });
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

/**
 * How long a footfall takes, and how far the knee folds to make one.
 *
 * 30 degrees rather than the 21 this shipped with. The knee is the only thing
 * that can lift this foot -- the thigh is 0.06 long, so five degrees at the hip
 * is 0.005 of clearance and invisible -- so a shift that reads as a *step*
 * rather than as a lean has to spend the angle there.
 */
const STEP_SPAN = 0.055;
const STEP_KNEE = 30;

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
    add(draft, 'turns', `${side}UpLeg`, { forward: shift * 2.5, lateral: -free * 4 - step * 11 });
    add(draft, 'turns', `${side}Leg`, { flex: free * 5 + step * STEP_KNEE });
    add(draft, 'turns', `${side}Foot`, { lateral: free * 4 - load * 2 + step * 13 });
    add(draft, 'turns', `${side}Toe`, { flex: -step * 17 });
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
  appendages(draft, phase, { leafSway: 4.5, leafLift: 2.6, tailSway: 3.4, tailLift: 2, lag: 0.16 });
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


/**
 * `attack`: 900ms, and the blow lands at 500.
 *
 * A coil and a snap, authored as six poses rather than generated: the frames
 * between an attack's keys are of no interest, and the one frame that matters
 * is a *stated* instant rather than something a curve happens to pass through.
 * That instant is 500ms because that is `melee.slash`'s wind-up, and the rule
 * `pig-strike.ts` set holds here -- **the frame the picture lands and the frame
 * the damage lands are the same frame** -- so the clip's own length is the
 * ability's whole 900ms of wind-up plus follow-through and its time scale is 1.
 *
 * What the animal does with it is decided by what the animal has: two mittens
 * on the front of a sphere, no reach and no weapon. So it is a *pounce* rather
 * than a swing -- the body gathers back over its heels, both paws draw up to
 * the chest, and the whole creature is thrown forward behind them. The arms
 * carry the read and the body carries the force, which is the opposite of the
 * pig's chop and is the only version of this that a limb 0.16 long can sell.
 *
 * **The body's share of that is small, and it has to be.** The first cut leaned
 * 14 degrees back and 17 forward, which on a limbed animal is a pounce and on a
 * sphere is a topple: there is no torso to bend, so `lean` rotates the whole
 * creature, and past about ten degrees it stops reading as effort and starts
 * reading as falling over -- with the face, which is on the front of the ball,
 * disappearing into the ground on the way. So the lean is 9 either side and
 * what it gave up went to the arms.
 *
 * **And the arms cannot punch.** This was measured rather than reasoned, and it
 * inverted the gesture. The shoulder sits at x 0.100 and the paw at 0.239 on an
 * arm 0.16 long: at rest the arm is already 24 degrees below horizontal and
 * within a centimetre of full forward extension, so the furthest forward any
 * shoulder angle can put that paw is 0.260. There is no thrust available. Worse,
 * a *positive* swing rotates the arm from forward toward down, so the first cut's
 * +46 at contact swung both paws under the belly and finished at x 0.122 --
 * behind where they started, on the frame the blow lands.
 *
 * So the blow is a **downward swipe**, which is what a small animal with short
 * arms actually does: rear up, both paws high and tucked, then slam them down
 * and out. The read is the *drop* -- the paws fall 0.24 between the coil and
 * contact, which is nearly half the animal's own height -- and not a reach the
 * limb does not have.
 *
 * The recovery is longer than the extension -- 280ms against 120 -- which is
 * `pig-cast.ts`'s finding and holds for the same reason: the strike starts from
 * a coil that is already half way, and coming home from full extension is
 * further than going out.
 */
export const ATTACK_MS = 900;
/** The tick the blow lands on, and `melee.slash`'s wind-up. */
export const ATTACK_CONTACT_MS = 500;
const ATTACK_FPS = 40;

/**
 * One pose of the attack, as the things that move rather than as bones.
 *
 * Ten numbers instead of the fourteen bones they drive, because what an author
 * is choosing is a posture: how far the body is gathered, how high the paws
 * are, whether the ears are flat. Spelling it per bone would make the six keys
 * a wall of angles in which the shape is invisible.
 */
interface AttackPose {
  /** Body pitch. Positive is nose down, into the strike. */
  readonly lean: number;
  /** Knee bend on both legs -- the gather, and the push out of it. */
  readonly crouch: number;
  /** Positive throws both paws down and forward. */
  readonly armSwing: number;
  /** Positive carries them outward, away from the chest. */
  readonly armSpread: number;
  readonly elbow: number;
  readonly paw: number;
  readonly headPitch: number;
  /** Positive lays the ears back along the skull. */
  readonly earBack: number;
  /** Positive carries the blades forward; negative streams them behind. */
  readonly greens: number;
  readonly tailLift: number;
}

function attackKey(pose: AttackPose): Draft {
  const draft: Draft = { turns: {}, bones: {} };
  add(draft, 'turns', 'hips', { lateral: pose.lean * 0.45 });
  add(draft, 'turns', 'spine', { lateral: pose.lean * 0.55 });
  add(draft, 'turns', 'head', { lateral: pose.headPitch });

  for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
    // `up` is mirrored and the rest is not: a spread is outward on both sides,
    // which is opposite signs, while a swing is forward on both, which is the
    // same sign. Getting that backwards is two paws doing a breaststroke.
    add(draft, 'turns', `${side}Arm`, { lateral: pose.armSwing, up: pose.armSpread * sign });
    add(draft, 'turns', `${side}ForeArm`, { flex: pose.elbow });
    add(draft, 'turns', `${side}Hand`, { lateral: pose.paw });
    add(draft, 'turns', `${side}UpLeg`, { lateral: -pose.crouch * 0.35 });
    add(draft, 'turns', `${side}Leg`, { flex: pose.crouch });
    add(draft, 'turns', `${side}Foot`, { lateral: pose.crouch * 0.5 });
  }

  for (const ear of ['L_Ear', 'R_Ear'] as const) {
    add(draft, 'bones', ear, { lateral: -pose.earBack });
  }
  add(draft, 'bones', 'Crown', { lateral: pose.greens * 0.35 });
  for (const [root, tip, scale] of [
    ['Leaf_A_01', 'Leaf_A_02', 1.0],
    ['Leaf_B_01', 'Leaf_B_02', 0.85],
    ['Leaf_C_01', 'Leaf_C_02', 1.15],
  ] as const) {
    add(draft, 'bones', root, { lateral: pose.greens * scale });
    add(draft, 'bones', tip, { lateral: pose.greens * scale * 0.7 });
  }
  (['Tail01', 'Tail02', 'Tail03', 'Tail04'] as const).forEach((bone, index) => {
    add(draft, 'bones', bone, { lateral: pose.tailLift * (0.5 + index * 0.2) });
  });
  return draft;
}

const ATTACK_KEYS: readonly (readonly [string, number, Easing, AttackPose])[] = [
  ['ready', 0, 'linear', { lean: 0, crouch: 0, armSwing: 0, armSpread: 0, elbow: 0, paw: 0, headPitch: 0, earBack: 0, greens: 0, tailLift: 0 }],
  // Sink onto the haunches and start drawing the paws in.
  ['gather', 180, 'inOut', { lean: -5, crouch: 12, armSwing: -26, armSpread: -9, elbow: 26, paw: -14, headPitch: -7, earBack: 14, greens: 6, tailLift: 8 }],
  // The deepest point, and the whole of what makes the blow readable from the
  // other side: 200ms of creep with the body furthest back and the paws highest.
  ['coil', 380, 'inOut', { lean: -9, crouch: 21, armSwing: -48, armSpread: -15, elbow: 44, paw: -22, headPitch: -13, earBack: 26, greens: 11, tailLift: 15 }],
  // Contact. `in` is the cubic that arrives fast, which is the snap.
  ['strike', ATTACK_CONTACT_MS, 'in', { lean: 9, crouch: -7, armSwing: 16, armSpread: 13, elbow: -10, paw: 16, headPitch: 9, earBack: -34, greens: -13, tailLift: -11 }],
  // Overshoot: the paws carry past and outward before anything comes back.
  ['follow', 620, 'out', { lean: 6, crouch: 4, armSwing: 9, armSpread: 22, elbow: 8, paw: 6, headPitch: 6, earBack: -20, greens: -9, tailLift: -4 }],
  ['settle', ATTACK_MS, 'inOut', { lean: 0, crouch: 0, armSwing: 0, armSpread: 0, elbow: 0, paw: 0, headPitch: 0, earBack: 0, greens: 0, tailLift: 0 }],
];

function attackClip(): AuthoredClip {
  return {
    id: 'attack',
    durationMs: ATTACK_MS,
    fps: ATTACK_FPS,
    keys: ATTACK_KEYS.map(([label, atMs, ease, pose]) => {
      const drafted = attackKey(pose);
      return { label, atMs, ease, turns: drafted.turns, bones: drafted.bones };
    }),
  };
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
export const RADISH_RACCOON_ATTACK: AuthoredClip = attackClip();

/**
 * A clip and what the library has to say about it.
 *
 * One list rather than a clip list beside a metadata list, because the two
 * would have to agree about which clips exist, whether each loops and where its
 * events sit -- and a `durationMs` in a document that has to equal the clip's
 * is the exact thing `make-radish-raccoon-clips.ts` writes the library to avoid
 * anybody editing by hand.
 */
export interface LibraryClip {
  readonly clip: AuthoredClip;
  readonly loop: boolean;
  readonly events: readonly { readonly name: string; readonly normalizedTime: number }[];
}

export const RADISH_RACCOON_LIBRARY: readonly LibraryClip[] = [
  { clip: RADISH_RACCOON_RUN, loop: true, events: [] },
  { clip: RADISH_RACCOON_IDLE, loop: true, events: [] },
  {
    clip: RADISH_RACCOON_ATTACK,
    loop: false,
    // Normalized, because that is what a clip library speaks and what
    // `timing.ts` checks the phase windows against. Derived from the two
    // constants rather than typed, so moving the contact moves the event.
    events: [
      { name: 'swing.start', normalizedTime: 0 },
      { name: 'swing.impact', normalizedTime: ATTACK_CONTACT_MS / ATTACK_MS },
    ],
  },
];

export const RADISH_RACCOON_CLIPS: readonly AuthoredClip[] = RADISH_RACCOON_LIBRARY.map((row) => row.clip);
