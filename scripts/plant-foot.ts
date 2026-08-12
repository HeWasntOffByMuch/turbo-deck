/**
 * Solve the pig swing's stance, rather than author it (spec 143).
 *
 *   npx tsx scripts/plant-foot.ts
 *
 * The pig throws this swing off its left leg. That foot is flat on the ground
 * with the body's weight on it, so it does not move -- everything above it moves
 * *over* it. Authored by eye it did the opposite: the pelvis yaws 54 degrees
 * between the load and the follow-through, the whole leg chain was carried round
 * with it, and the left ankle skated 0.19 rig units across the floor, half the
 * pig's own hips-to-head height, with the foot still planted flat.
 *
 * Cancelling the pelvis's yaw at the hip joint gets most of it, and needs no
 * solver -- see `STANCE` in `pig-strike.ts`. What it cannot reach is that
 * the hip *joint* sits 0.115 off the pelvis's own axis, so the joint itself
 * rides an arc and takes the rigid leg with it. Holding the foot through that is
 * the leg reaching back for the ground: two angles at the hip, one at the knee,
 * and no closed form.
 *
 * The right leg is the same solve with a different target. It is the wielding
 * side, so it steps back to brace and drives through as the blow lands -- and
 * that motion had been *measured* against a left foot that was itself sliding,
 * which flattered it by two thirds. Once the left foot stops moving, the right
 * one has to make the whole step itself, so its targets are stated here in world
 * terms and solved for rather than dialled in as joint angles.
 *
 * Same shape as `scripts/solve-grip.ts`: state the requirement, solve it
 * numerically, print the numbers to paste in, and let a test assert the property
 * rather than the numbers. The requirement is two points per leg, not one -- the
 * **ankle** and the **toe** -- because pinning the ankle alone leaves the foot
 * free to pivot about it, and a foot that spins on the spot is the same lie as a
 * foot that slides.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyRotations, type BoneTurns, type PoseTable } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb, type GlbReadNode } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, boneNode, namingOf, type PoseAxis, type Vec3 } from '../src/units/pose.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import type { BoneRole } from '../src/units/naming.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

type KeyLabel = keyof typeof STRIKE_KEY_MS;

/** The knobs one leg is allowed to use, in the order they are printed. */
function knobsFor(side: 'left' | 'right'): readonly { role: BoneRole; axis: PoseAxis }[] {
  const upLeg = `${side}UpLeg` as BoneRole;
  const leg = `${side}Leg` as BoneRole;
  const foot = `${side}Foot` as BoneRole;
  return [
    { role: upLeg, axis: 'lateral' },
    { role: upLeg, axis: 'forward' },
    { role: upLeg, axis: 'up' },
    { role: leg, axis: 'lateral' },
    { role: foot, axis: 'lateral' },
    { role: foot, axis: 'up' },
  ];
}

/**
 * Where each foot is asked to be, in rig units along the body's forward axis,
 * measured from where that same foot stands at the guard.
 *
 * The left is zero everywhere, which is the whole point of it. The right is a
 * step: back through the wind-up, through and past the left as the blow lands.
 * A fifth of a hips-to-head height back and a fifth forward again -- big enough
 * to read at forty pixels, small enough to still be a step rather than a lunge.
 */
const STEP: Record<KeyLabel, { left: number; right: number }> = {
  guard: { left: 0, right: 0 },
  rise: { left: 0, right: -0.06 },
  coil: { left: 0, right: -0.13 },
  load: { left: 0, right: -0.14 },
  contact: { left: 0, right: 0.16 },
  follow: { left: 0, right: 0.22 },
  settle: { left: 0, right: 0 },
};

/**
 * What a degree of bend is worth, in rig units of travel.
 *
 * Without this the solve is exact and the answer is nonsense: it pins the foot
 * to a thousandth of a unit by rotating the hip 73 degrees and snapping the knee
 * straight, because the leg is a linkage and a linkage has many ways to put a
 * point somewhere. A real leg reaches the shortest way it can.
 *
 * The left number is not arbitrary. Its joint travels 0.068 at worst and the
 * leg's reach is about 0.33, so the honest correction is roughly 12 degrees;
 * this weight makes 12 degrees cost what 0.012 of travel costs, which buys that
 * correction and refuses the 73-degree one. Halving it again buys 0.004 more and
 * starts pumping the knee through 16 degrees -- a foot that stays put under a
 * leg that visibly does not.
 *
 * The right leg is asked to move a third of a body, so the same weight would be
 * the solver arguing with the brief. It gets a third of it: enough to keep the
 * knee out of the linkage's stranger corners, not enough to resist the step.
 */
const PER_DEGREE: Record<'left' | 'right', number> = { left: 0.001, right: 0.0006 };

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const rig = { nodes, naming } as const;

  const need = (role: BoneRole): GlbReadNode => {
    const node = boneNode(nodes, naming, role);
    if (!node) throw new Error(`the pig rig has no ${role}`);
    return node;
  };
  /** The end of the foot chain: the ankle's own yaw is invisible without it. */
  const toeOf = (from: number): number => {
    const kids = nodes.filter((node) => node.parent === from);
    const last = kids[kids.length - 1];
    return last ? toeOf(last.index) : from;
  };

  const at = (world: readonly (readonly number[])[], index: number): Vec3 => {
    const m = world[index] ?? [];
    return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
  };
  const shift = (point: Vec3, along: number): Vec3 => [
    point[0] + frame.forward[0] * along,
    point[1] + frame.forward[1] * along,
    point[2] + frame.forward[2] * along,
  ];

  const key = (label: KeyLabel): PoseTable => {
    const found = PIG_STRIKE.keys.find((entry) => entry.label === label);
    if (!found) throw new Error(`the strike has no ${label} key`);
    return found.turns;
  };

  for (const side of ['left', 'right'] as const) {
    const knobs = knobsFor(side);
    const ankle = need(`${side}Foot` as BoneRole);
    const toe = toeOf(ankle.index);
    const placeOf = (turns: PoseTable): { ankle: Vec3; toe: Vec3 } => {
      const world = poseWorldMatrices(nodes, keyRotations(rig, turns));
      return { ankle: at(world, ankle.index), toe: at(world, toe) };
    };

    // Where the foot stands at the guard, which every target is measured from.
    // Off the guard key rather than the bind pose: the guard is fitted to the
    // pig's idle, so this is the floor contact the swing actually starts from.
    const rest = placeOf(key('guard'));

    /**
     * The guard's own angles, which the solve both starts from and is pulled
     * back toward.
     *
     * The stance at rest, rather than whatever the key currently holds, and that
     * matters twice. It is the physical claim -- a leg keeps its shape and bends
     * only as much as the ground makes it -- and it makes the script
     * *idempotent*: anchored to the key's own values, each run measures its own
     * previous output, the knee ratchets a few degrees further every time, and
     * running the solver twice is a change.
     */
    const anchor = knobsFor(side).map(
      (knob) => (key('guard')[knob.role] as BoneTurns | undefined)?.[knob.axis] ?? 0,
    );

    const withKnobs = (turns: PoseTable, values: readonly number[]): PoseTable => {
      const out: Record<string, BoneTurns> = { ...(turns as Record<string, BoneTurns>) };
      knobs.forEach((knob, index) => {
        out[knob.role] = { ...(out[knob.role] ?? {}), [knob.axis]: values[index] ?? 0 };
      });
      return out as PoseTable;
    };

    const missBy = (turns: PoseTable, values: readonly number[], along: number): number => {
      const place = placeOf(withKnobs(turns, values));
      const gap = (a: Vec3, b: Vec3): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      return Math.sqrt(
        (gap(place.ankle, shift(rest.ankle, along)) + gap(place.toe, shift(rest.toe, along))) / 2,
      );
    };

    const cost = (turns: PoseTable, values: readonly number[], along: number): number => {
      let bend = 0;
      for (let index = 0; index < values.length; index += 1) {
        bend += ((values[index] ?? 0) - (anchor[index] ?? 0)) ** 2;
      }
      return missBy(turns, values, along) ** 2 + PER_DEGREE[side] ** 2 * bend;
    };

    console.log(`\n  the ${side} leg\n`);
    for (const label of Object.keys(STRIKE_KEY_MS) as KeyLabel[]) {
      const turns = key(label);
      const along = STEP[label][side];
      let values = [...anchor];
      let best = cost(turns, values, along);

      // Coordinate descent with a shrinking step, from the authored pose. Six
      // angles and a smooth objective: a gradient would be faster and this runs
      // in under a second. It starts small, because the answer is near where it
      // starts and a wide first step is how it found the 73-degree hip.
      for (let step = 2; step > 0.01; step /= 2) {
        let improving = true;
        while (improving) {
          improving = false;
          for (let index = 0; index < values.length; index += 1) {
            for (const direction of [step, -step]) {
              const trial = [...values];
              trial[index] = (trial[index] ?? 0) + direction;
              const score = cost(turns, trial, along);
              if (score < best - 1e-12) {
                best = score;
                values = trial;
                improving = true;
              }
            }
          }
        }
      }

      const round = (value: number): number => Math.round(value * 10) / 10 + 0;
      const named = (index: number): string => `${knobs[index]?.axis ?? '?'}: ${round(values[index] ?? 0)}`;
      console.log(
        `  ${label.padEnd(8)} want ${along.toFixed(2).padStart(5)}  miss ${missBy(turns, anchor, along).toFixed(4)} -> ${missBy(turns, values, along).toFixed(4)}   ` +
          `${side}UpLeg: { ${named(0)}, ${named(1)}, ${named(2)} }, ` +
          `${side}Leg: { ${named(3)} }, ` +
          `${side}Foot: { ${named(4)}, ${named(5)} }`,
      );
    }
  }
}

main();
