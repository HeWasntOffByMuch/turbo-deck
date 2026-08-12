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
 * Only the wrist moves. The hand is a leaf bone, so rotating it turns what the
 * hand carries and moves nothing else at all -- which means spec 139's whole
 * silhouette argument (hand above the head at the load, forward of the chest at
 * contact) is untouched by anything printed here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyRotations, type BoneTurns, type PoseTable } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, namingOf, type PoseAxis, type Vec3 } from '../src/units/pose.js';
import { quatFromEulerXyz, rotateByQuat } from '../src/items/grip.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { validateSkeleton } from '../src/units/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

type KeyLabel = keyof typeof STRIKE_KEY_MS;

/** The wrist's three, which is exactly enough to aim a direction and roll it. */
const KNOBS: readonly PoseAxis[] = ['lateral', 'forward', 'up'];

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
const AIM: Partial<Record<KeyLabel, Vec3>> = {
  dip: [0.06, 0.43, 0.9],
  coil: [0.7, 0.56, -0.46],
  load: [0.63, 0.57, -0.52],
  contact: [-0.8, -0.55, 0.26],
  follow: [-0.77, -0.47, -0.44],
};

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
    const hand: Record<string, number> = { ...((turns['rightHand'] ?? {}) as Record<string, number>) };
    KNOBS.forEach((axis, index) => {
      hand[axis] = values[index] ?? 0;
    });
    return { ...turns, rightHand: hand as BoneTurns };
  };

  console.log('\n  the wrist, solved against the socket calibration in pig.skeleton.json\n');
  for (const [label, aim] of Object.entries(AIM) as [KeyLabel, Vec3][]) {
    const turns = key(label);
    const want = worldOf(aim);
    const start = KNOBS.map((axis) => (turns['rightHand'] as BoneTurns | undefined)?.[axis] ?? 0);

    // The angle between where the blade points and where it should, in degrees.
    const missBy = (values: readonly number[]): number => {
      const blade = bladeOf(withKnobs(turns, values));
      const alignment = blade[0] * want[0] + blade[1] * want[1] + blade[2] * want[2];
      return (Math.acos(Math.max(-1, Math.min(1, alignment))) * 180) / Math.PI;
    };

    let values = [...start];
    let best = missBy(values);
    // Coordinate descent from a coarse step, because unlike the foot solve the
    // answer is nowhere near where it starts -- the whole reason this exists is
    // that the wrist is a hundred degrees out.
    for (let step = 45; step > 0.01; step /= 2) {
      let improving = true;
      while (improving) {
        improving = false;
        for (let index = 0; index < values.length; index += 1) {
          for (const direction of [step, -step]) {
            const trial = [...values];
            trial[index] = (trial[index] ?? 0) + direction;
            const score = missBy(trial);
            if (score < best - 1e-9) {
              best = score;
              values = trial;
              improving = true;
            }
          }
        }
      }
    }

    const round = (value: number): number => Math.round(value * 10) / 10 + 0;
    const named = KNOBS.map((axis, index) => `${axis}: ${round(values[index] ?? 0)}`).join(', ');
    console.log(`  ${label.padEnd(8)} off by ${missBy(start).toFixed(0).padStart(3)}deg -> ${best.toFixed(1)}deg   rightHand: { ${named} }`);
  }
}

main();
