/**
 * Is the pig standing on anything? (spec 244)
 *
 *   npx tsx scripts/probe-stance.ts
 *
 * The four things that can be wrong with a stance, measured off the **committed
 * clips** rather than off `pig-strike.ts` -- because what ships is a file, and a
 * stance that is right in the table and never regenerated is exactly the failure
 * this would otherwise hide. `plant-foot.ts` solves and prints; this reads back
 * what got written.
 *
 * It reads `idle.glb` beside them as the **control**, and that is not a
 * formality. Every number below is relative: the floor is where the idle rests
 * its feet, and a combat stance is being asked to stand on the same ground as
 * the pose it cross-fades from. A probe with no control cannot tell a stance
 * that is planted from one measured against itself, which is precisely how the
 * old stance passed every test in the tree while hovering.
 *
 * The four columns:
 *
 *  - **over** -- where the pelvis sits along its own support span, from the rear
 *    ankle (0%) to the leading toe (100%). Outside that is a body already
 *    falling. The idle reads 1-42%; the guard used to read **157%**.
 *  - **float** -- how far each toe is above the floor, in rig units. The clip is
 *    rotation-only and the server owns where a body is, so the root cannot drop
 *    to meet a raised foot: a toe above the idle's is a foot in the air.
 *  - **bend** -- the angle between thigh and shin. Unsigned, so it is only half
 *    the question.
 *  - **lead** -- the other half: how much of the knee's offset from the straight
 *    hip-to-ankle line points *forward*, as a fraction. 1.00 is a knee pointing
 *    exactly where a knee points, 0 is a knee out sideways, and negative is a leg
 *    bending backwards. Bend alone cannot say which of those it is looking at.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipDurationOf, clipPoseAt } from '../src/units/clip-sample.js';
import { readNodeTree, splitGlb, type GlbReadNode } from '../src/units/glb-read.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, worldPosition, type BodyFrame } from '../src/units/pose.js';
import { poseWorldMatrices, type PoseRotations } from '../src/units/skin.js';
import { legOf, stanceOf, type Leg } from '../src/units/stance.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = join(repoRoot, 'assets', 'units', 'pig_a_pose_full', 'pig_a_pose_full.glb');
const CLIP_DIR = join(repoRoot, 'assets', 'units', 'clips');

/** How many frames of each clip to look at. Every key of the swing lands on one. */
const SAMPLES = 32;

/**
 * Rows that read the same as the row above them are counted rather than printed.
 *
 * Two of the three combat clips hold one stance for their whole length -- an
 * archer sets their feet and shoots with everything above the waist -- so
 * without this the interesting clip is thirty-three rows in a hundred and
 * thirty, and the eye slides off it. The count is printed, because "nothing
 * changed for 32 frames" is a measurement and silence is not.
 */
function sameRow(a: string, b: string): boolean {
  return a.slice(a.indexOf('|')) === b.slice(b.indexOf('|'));
}

function main(): void {
  const nodes = readNodeTree(splitGlb(new Uint8Array(readFileSync(UNIT))));
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');

  const need = (role: 'hips' | 'leftFoot' | 'rightFoot'): GlbReadNode => {
    const node = boneNode(nodes, naming, role);
    if (!node) throw new Error(`the pig rig has no ${role}`);
    return node;
  };
  const legs = { left: legOf(nodes, naming, 'left'), right: legOf(nodes, naming, 'right') };
  const pelvis = intoBodyFrame(frame, worldPosition(need('hips'))).forward;

  const posesOf = (clip: string): { at: number; pose: PoseRotations }[] => {
    const glb = splitGlb(new Uint8Array(readFileSync(join(CLIP_DIR, `${clip}.glb`))));
    const duration = clipDurationOf(glb);
    const out: { at: number; pose: PoseRotations }[] = [];
    for (let index = 0; index <= SAMPLES; index += 1) {
      const at = (duration * index) / SAMPLES;
      out.push({ at, pose: clipPoseAt(glb, nodes, at) });
    }
    return out;
  };

  // The floor: where the idle rests each foot, taken as the median across the
  // clip because an idle shifts its weight and what is wanted is where the foot
  // *rests* rather than the lowest it ever reaches.
  const idle = posesOf('idle');
  const floor = { left: 0, right: 0 };
  for (const side of ['left', 'right'] as const) {
    const heights = idle
      .map(({ pose }) => toeUp(nodes, frame, legs[side], pose))
      .sort((a, b) => a - b);
    floor[side] = heights[Math.floor(heights.length / 2)] ?? 0;
  }

  console.log(`\n  the floor, from the idle: left toe ${floor.left.toFixed(4)}, right ${floor.right.toFixed(4)}`);
  console.log(`  the pelvis, which never moves: ${pelvis.toFixed(4)}\n`);
  console.log('  clip     t    | over    float L   float R   bend L  lead L   bend R  lead R');

  for (const clip of ['idle', 'slash', 'shoot', 'cast']) {
    const rows = clip === 'idle' ? idle : posesOf(clip);
    const worst = { low: 1, high: 0, float: -1, bend: 180, lead: 1 };
    let previous = '';
    let held = 0;
    for (const { at, pose } of rows) {
      const world = poseWorldMatrices(nodes, pose);
      const read = stanceOf(nodes, frame, legs, world, pelvis);
      const float = { left: read.left.toe.up - floor.left, right: read.right.toe.up - floor.right };
      worst.low = Math.min(worst.low, read.over);
      worst.high = Math.max(worst.high, read.over);
      worst.float = Math.max(worst.float, float.left, float.right);
      worst.bend = Math.min(worst.bend, read.left.bend, read.right.bend);
      worst.lead = Math.min(worst.lead, read.left.lead, read.right.lead);
      const row =
        `  ${clip.padEnd(6)} ${at.toFixed(2).padStart(5)} |` +
        `${(read.over * 100).toFixed(0).padStart(5)}%  ` +
        `${float.left.toFixed(4).padStart(8)}  ${float.right.toFixed(4).padStart(8)}   ` +
        `${read.left.bend.toFixed(1).padStart(5)}   ${read.left.lead.toFixed(2).padStart(5)}    ` +
        `${read.right.bend.toFixed(1).padStart(5)}   ${read.right.lead.toFixed(2).padStart(5)}`;
      if (previous !== '' && sameRow(previous, row)) {
        held += 1;
        continue;
      }
      if (held > 0) console.log(`         ${`(${held} more the same)`.padStart(9)}`);
      held = 0;
      console.log(row);
      previous = row;
    }
    if (held > 0) console.log(`         ${`(${held} more the same)`.padStart(9)}`);
    console.log(
      `  ${clip.padEnd(6)}  over ${(worst.low * 100).toFixed(0)}%-${(worst.high * 100).toFixed(0)}%, ` +
        `float up to ${worst.float.toFixed(4)}, bend never under ${worst.bend.toFixed(1)}, ` +
        `lead never under ${worst.lead.toFixed(2)}\n`,
    );
  }
}

function toeUp(
  nodes: readonly GlbReadNode[],
  frame: BodyFrame,
  leg: Leg,
  pose: PoseRotations,
): number {
  const m = poseWorldMatrices(nodes, pose)[leg.toe] ?? [];
  return intoBodyFrame(frame, [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0]).up;
}

main();
