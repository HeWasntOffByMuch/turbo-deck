/**
 * Point the blade where the swing needs it, at each key (spec 143).
 *
 *   npx tsx scripts/aim-blade.ts
 *
 * A held blade's direction is the hand's orientation composed with the socket's
 * calibration, and the two are tuned in different files by different people at
 * different times. So re-solving the socket -- which spec 143 did, to fix a
 * sword that hung straight down at idle -- silently re-aimed the blade at every
 * *other* pose in the clip, because those poses' wrist angles were authored
 * against the socket rotation it replaced. The arm still went over the shoulder
 * and every assertion about where the hand *is* still passed; what changed is
 * what stuck out of it. At the top of the wind-up the blade pointed at the
 * floor, and it came up through the strike instead of down.
 *
 * The lesson is that a hand pose is not a portable number: it means something
 * only against a particular grip. So this states the requirement in the frame
 * it is actually about -- **where the blade points, in the body's own axes** --
 * and solves the wrist for it. Re-solve the socket again and re-run this, and
 * the swing survives it.
 *
 * It began as a wrist solve, and a wrist alone turned out to be the wrong tool
 * twice over. Asking one joint to aim a blade produced a wrist bent ninety
 * degrees in three axes at once -- the arithmetic satisfied and the pose not a
 * pose -- and it could not express the thing actually wanted from the wind-up,
 * which is that **the elbow raises the sword and the torso stays out of it**.
 * So it solves the shoulder, the elbow and the wrist together, and the weights
 * in `KNOBS` are where that preference is written down as a number.
 *
 * Two things it learned by being wrong first:
 *
 *  - **the hand needs a place to be, not just the blade a direction.** The same
 *    aim is reachable with the hand by the ear or at arm's length; solved on aim
 *    alone it tucked the hand almost inside the pig at the load and left the
 *    strike with no forward reach at all.
 *  - **one starting point is not enough.** An arm reaching a place has genuinely
 *    distinct answers -- elbow out or elbow down, swung inside the shoulder or
 *    outside it -- separated by ridges a descent will not cross, so it seeds
 *    from a grid. That is also how "the hand cannot both reach forward a third
 *    of a body and cross to the far side" became a measurement rather than a
 *    suspicion: every seed agrees.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyRotations, type BoneTurns, type PoseTable } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, type PoseAxis, type Vec3 } from '../src/units/pose.js';
import { quatFromEulerXyz, rotateByQuat } from '../src/items/grip.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { validateSkeleton } from '../src/units/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

type KeyLabel = keyof typeof STRIKE_KEY_MS;
type KnobRole = 'rightArm' | 'rightForeArm' | 'rightHand';

/** How far the elbow may fold before it is bending the wrong way. */
const ELBOW_RANGE = { min: 0, max: 125 } as const;

/**
 * What the solve is allowed to move, and what it is charged for moving.
 *
 * The arm, the elbow and the wrist together, because aiming a blade with the
 * wrist alone is how you get a wrist bent ninety degrees in three axes at once
 * -- the arithmetic is satisfied and the pose is not a pose. The `per` weight is
 * what a degree of deviation costs against a degree of aiming error, so this
 * table is where "raising a sword needs more elbow and less arm" is actually
 * written down:
 *
 *  - the **elbow** is cheap and wants to be bent. Folding it is how a real arm
 *    puts a sword behind its own head, and it costs the silhouette nothing.
 *  - the **wrist** is expensive and wants to stay where it rests. A grip angle
 *    that changes wildly through a swing is a hand that has let go.
 *  - the **shoulder** is in between: free enough to help, not so free that it
 *    swings the whole arm where the elbow should have done the work.
 */
const KNOBS: readonly { role: 'rightArm' | 'rightForeArm' | 'rightHand'; axis: PoseAxis; per: number }[] = [
  { role: 'rightArm', axis: 'lateral', per: 0.18 },
  { role: 'rightArm', axis: 'forward', per: 0.18 },
  { role: 'rightArm', axis: 'up', per: 0.18 },
  { role: 'rightForeArm', axis: 'flex', per: 0.8 },
  { role: 'rightHand', axis: 'lateral', per: 0.5 },
  { role: 'rightHand', axis: 'forward', per: 0.5 },
  { role: 'rightHand', axis: 'up', per: 0.5 },
];

/**
 * Where the blade points at each key, in the body's own axes: `[right, up,
 * forward]`, normalized here so the numbers can be written as a reader thinks
 * of them rather than as a unit vector.
 *
 * This is the swing, stated the way somebody would say it out loud:
 *
 *  - **guard** and **settle** — forward and 20 degrees up. The stance, and the
 *    one the socket itself is calibrated to produce, so it is left alone.
 *  - **dip** — barely moves. The anticipation is in the body, not the blade; a
 *    blade that dives at the floor and comes back up has added a beat nobody
 *    reads as anything but a stumble.
 *  - **coil** and **load** — up and back, over the right shoulder, edge out.
 *    This is the frame that has to read at forty pixels.
 *  - **contact** — down and across, having arrived. The exact inverse of the
 *    load, which is what makes the strike a chop rather than a poke.
 *  - **follow** — still down, wrapped past and behind the left hip.
 */
const AIM: Partial<Record<KeyLabel, { blade: Vec3; elbow: number; hold: number; hand?: Vec3 }>> = {
  rise: { blade: [0.5, 0.58, 0.64], elbow: 78, hold: 1, hand: [0.3, 0.14, 0.12] },
  coil: { blade: [0.66, 0.55, -0.4], elbow: 95, hold: 1, hand: [0.32, 0.24, -0.04] },
  load: { blade: [0.63, 0.57, -0.52], elbow: 100, hold: 1.5, hand: [0.32, 0.26, -0.08] },
  // The strike *extends*, and the shoulder is let off its leash for it. The
  // reach is the frame that has to read at forty pixels; an elbow that stayed
  // folded through the blow is a punch, and a shoulder pinned where the wind-up
  // left it makes the whole chop an elbow snap with no body behind it.
  contact: { blade: [-0.8, -0.55, 0.26], elbow: 10, hold: 0.1, hand: [-0.05, 0.07, 0.26] },
  follow: { blade: [-0.77, -0.47, -0.44], elbow: 14, hold: 0.2, hand: [-0.26, 0.02, 0.12] },
};

/**
 * What a rig unit of hand displacement is worth, against a degree of aim error.
 *
 * The blade's direction alone does not pin an arm: the same aim is reachable
 * with the hand by the ear or the hand out at arm's length, and solved on aim
 * alone the arm picked whichever the strain happened to favour. It tucked the
 * hand almost inside the pig at the load and left the strike with no forward
 * reach at all -- an elbow snap rather than a chop.
 *
 * So the hand gets a place to be, per key, in the body's own axes as fractions
 * of the rig's height, and this is the exchange rate. A tenth of a body out of
 * position costs what eight degrees of aim error costs, which is enough to
 * decide between two arms that aim the blade equally well and not enough to
 * bend the aim to reach a number typed here.
 */
const PER_UNIT = 80;

/** How tall the rig stands in its own units, so the targets are scale-free. */
const RIG_HEIGHT = 0.998;

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const rig = { nodes, naming } as const;

  const skeleton = validateSkeleton(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'units', 'pig.skeleton.json'), 'utf8')),
  ).value;
  const socket = skeleton?.sockets.find((entry) => entry.id === 'weapon.main');
  const bone = nodes.find((node) => node.name === socket?.bone);
  if (!socket || !bone) throw new Error('no weapon.main socket');
  const pivot = quatFromEulerXyz((socket.rotationDeg ?? [0, 0, 0]) as Vec3);
  const hips = boneNode(nodes, naming, 'hips');
  if (!hips) throw new Error('the pig rig has no hips to measure the hand against');

  const key = (label: KeyLabel): PoseTable => {
    const found = PIG_STRIKE.keys.find((entry) => entry.label === label);
    if (!found) throw new Error(`the strike has no ${label} key`);
    return found.turns;
  };

  /** The blade's world direction for a pose. */
  const bladeOf = (turns: PoseTable): Vec3 => {
    const m = poseWorldMatrices(nodes, keyRotations(rig, turns))[bone.index] ?? [];
    const turned = rotateByQuat(pivot, [0, 1, 0]);
    const out: [number, number, number] = [0, 0, 0];
    for (let column = 0; column < 3; column += 1) {
      const raw: Vec3 = [m[column * 4] ?? 0, m[column * 4 + 1] ?? 0, m[column * 4 + 2] ?? 0];
      const length = Math.hypot(...raw) || 1;
      const k = turned[column] ?? 0;
      out[0] += (raw[0] / length) * k;
      out[1] += (raw[1] / length) * k;
      out[2] += (raw[2] / length) * k;
    }
    return out;
  };

  /** Where the right hand sits, in body axes relative to the hips. */
  const handPlaceOf = (turns: PoseTable): Vec3 => {
    const world = poseWorldMatrices(nodes, keyRotations(rig, turns));
    const m = world[bone.index] ?? [];
    const hipsAt = world[hips.index] ?? [];
    const from: Vec3 = [
      (m[12] ?? 0) - (hipsAt[12] ?? 0),
      (m[13] ?? 0) - (hipsAt[13] ?? 0),
      (m[14] ?? 0) - (hipsAt[14] ?? 0),
    ];
    const into = intoBodyFrame(frame, from);
    return [into.right / RIG_HEIGHT, into.up / RIG_HEIGHT, into.forward / RIG_HEIGHT];
  };

  /** A body-axis triple as a world direction. */
  const worldOf = (aim: Vec3): Vec3 => {
    const right: Vec3 = [-frame.lateral[0], -frame.lateral[1], -frame.lateral[2]];
    const raw: Vec3 = [
      right[0] * aim[0] + frame.up[0] * aim[1] + frame.forward[0] * aim[2],
      right[1] * aim[0] + frame.up[1] * aim[1] + frame.forward[1] * aim[2],
      right[2] * aim[0] + frame.up[2] * aim[1] + frame.forward[2] * aim[2],
    ];
    const length = Math.hypot(...raw) || 1;
    return [raw[0] / length, raw[1] / length, raw[2] / length];
  };

  const withKnobs = (turns: PoseTable, values: readonly number[]): PoseTable => {
    const out: Record<string, BoneTurns> = { ...(turns as Record<string, BoneTurns>) };
    KNOBS.forEach((knob, index) => {
      out[knob.role] = { ...(out[knob.role] ?? {}), [knob.axis]: values[index] ?? 0 };
    });
    return out as PoseTable;
  };

  /**
   * Where each knob would rather be.
   *
   * The wrist's rest is the **guard's** wrist, not zero: a hand holds its grip
   * angle through a swing and the arm does the work, so "unchanged from the
   * stance" is the honest neutral and zero is just an axis origin. The elbow
   * wants to be bent, which is the whole point.
   *
   * The shoulder is pulled toward **the key before it**, and that is not a
   * refinement -- it is what keeps the solve from putting motion back in. Each
   * key aims a direction, a direction is two numbers and the arm has three, so
   * every key has a whole family of answers to choose from. Solved
   * independently, the coil and the load picked answers thirty degrees apart at
   * the shoulder and the arm swung between two poses that were supposed to be a
   * creep. Chained, consecutive keys stay in the same part of the family.
   */
  const restFor = (previous: readonly number[], index: number, elbow: number): number => {
    const knob = KNOBS[index];
    if (!knob) return 0;
    if (knob.role === 'rightForeArm') return elbow;
    if (knob.role === 'rightHand') return (key('guard')[knob.role] as BoneTurns | undefined)?.[knob.axis] ?? 0;
    return previous[index] ?? 0;
  };

  console.log('\n  the arm, solved against the socket calibration in pig.skeleton.json\n');
  // The guard is the chain's first link: it is already correct, and every key
  // after it is pulled toward the one before.
  let previous = KNOBS.map((knob) => (key('guard')[knob.role] as BoneTurns | undefined)?.[knob.axis] ?? 0);
  for (const [label, target] of Object.entries(AIM) as [KeyLabel, { blade: Vec3; elbow: number; hold: number; hand?: Vec3 }][]) {
    const turns = key(label);
    const want = worldOf(target.blade);
    const start = KNOBS.map((knob) => (turns[knob.role] as BoneTurns | undefined)?.[knob.axis] ?? 0);
    const rest = KNOBS.map((_, index) => restFor(previous, index, target.elbow));

    // The angle between where the blade points and where it should, in degrees.
    const missBy = (values: readonly number[]): number => {
      const blade = bladeOf(withKnobs(turns, values));
      const alignment = blade[0] * want[0] + blade[1] * want[1] + blade[2] * want[2];
      return (Math.acos(Math.max(-1, Math.min(1, alignment))) * 180) / Math.PI;
    };

    const cost = (values: readonly number[]): number => {
      let strain = 0;
      KNOBS.forEach((knob, index) => {
        const per = knob.role === 'rightArm' ? knob.per * target.hold : knob.per;
        strain += (per * ((values[index] ?? 0) - (rest[index] ?? 0))) ** 2;
      });
      let reach = 0;
      if (target.hand) {
        const at = handPlaceOf(withKnobs(turns, values));
        reach =
          (PER_UNIT * (at[0] - target.hand[0])) ** 2 +
          (PER_UNIT * (at[1] - target.hand[1])) ** 2 +
          (PER_UNIT * (at[2] - target.hand[2])) ** 2;
      }
      return missBy(values) ** 2 + strain + reach;
    };

    /** Coordinate descent with a shrinking step, from one starting point. */
    const descendFrom = (seed: readonly number[]): { values: number[]; cost: number } => {
      let values = [...seed];
      let best = cost(values);
      for (let step = 45; step > 0.01; step /= 2) {
        let improving = true;
        while (improving) {
          improving = false;
          for (let index = 0; index < values.length; index += 1) {
            for (const direction of [step, -step]) {
              const trial = [...values];
              const moved = (trial[index] ?? 0) + direction;
              // A joint limit rather than a price: an elbow does not bend
              // backwards at any cost, and the unclamped solve folded it to -63
              // because the aim was worth more than the penalty.
              if (KNOBS[index]?.role === 'rightForeArm' && (moved < ELBOW_RANGE.min || moved > ELBOW_RANGE.max)) continue;
              trial[index] = moved;
              const score = cost(trial);
              if (score < best - 1e-9) {
                best = score;
                values = trial;
                improving = true;
              }
            }
          }
        }
      }
      return { values, cost: best };
    };

    // A grid of starting points over the shoulder's two big axes, not one.
    //
    // An arm reaching a given place has genuinely distinct answers -- elbow out
    // or elbow down, swung inside the shoulder or outside it -- and they are
    // separated by ridges a descent will not cross. Seeded only from the pose it
    // already had, the strike kept a shoulder rolled the wrong way round and
    // stopped a whole hand's width short of the midline, at a cost the solver
    // was perfectly happy with because every direction from there was worse.
    let solved = descendFrom(start);
    for (const lateral of [-90, -45, 0, 45, 90]) {
      for (const forward of [-90, -45, 0, 45, 90]) {
        const seed = [...start];
        seed[0] = lateral;
        seed[1] = forward;
        const found = descendFrom(seed);
        if (found.cost < solved.cost - 1e-9) solved = found;
      }
    }
    const values = solved.values;

    const round = (value: number): number => Math.round(value * 10) / 10 + 0;
    const show = (role: KnobRole): string => {
      const parts = KNOBS.map((knob, index) => (knob.role === role ? `${knob.axis}: ${round(values[index] ?? 0)}` : null))
        .filter((part): part is string => part !== null);
      return `${role}: { ${parts.join(', ')} }`;
    };
    previous = [...values];
    console.log(
      `  ${label.padEnd(8)} aim ${missBy(values).toFixed(1).padStart(4)}deg  hand ${handPlaceOf(withKnobs(turns, values)).map((v) => v.toFixed(2).padStart(5)).join(',')}   ` +
        `${show('rightArm')}, ${show('rightForeArm')}, ${show('rightHand')}`,
    );
  }
}

main();
