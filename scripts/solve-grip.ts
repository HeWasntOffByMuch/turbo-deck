/**
 * Solve the pig's socket calibrations, rather than sweep for them (spec 140).
 *
 *   npx tsx scripts/solve-grip.ts
 *
 * The first pass at these numbers was found by rendering candidate euler triples
 * side by side and picking one. That is the right way to answer "which of these
 * looks better" and the wrong way to answer "hold it edge-up, pointing forward"
 * -- the second has an exact answer, and a sweep finds an approximation of it.
 *
 * So this states the orientation in the *body's* own axes, which is the only
 * frame the requirement is expressible in, and prints the euler degrees that
 * produce it. Paste them into `pig.skeleton.json`; `preview-weapon.ts` is what
 * confirms the result looks like what the words meant.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseAt } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, namingOf, type Vec3 } from '../src/units/pose.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { socketEulerFor } from '../src/items/grip.js';
import { validateSkeleton } from '../src/units/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

function scaled(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}
function add(...vs: Vec3[]): Vec3 {
  return vs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as Vec3, [0, 0, 0] as Vec3);
}

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const skeleton = validateSkeleton(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'units', 'pig.skeleton.json'), 'utf8')),
  ).value;
  if (!skeleton) throw new Error('pig.skeleton.json does not validate');

  const forward = frame.forward;
  const up = frame.up;
  // `lateral` points to the pig's LEFT, so its negation is the right.
  const right = scaled(frame.lateral, -1);

  // The hand is solved at the swing's guard pose rather than at the bind pose:
  // the grip is fixed to the hand, so it can only be exactly right at one pose,
  // and the one worth being right at is the one the swing starts and ends in.
  const world = poseWorldMatrices(nodes, poseAt(PIG_STRIKE, { nodes, naming }, STRIKE_KEY_MS.guard));
  const round = (value: number): number => Math.round(value * 10) / 10;

  const targets: { socket: string; blade: Vec3; flat: Vec3; why: string }[] = [
    {
      socket: 'weapon.main',
      // Forward and 20 degrees up: an on-guard stance, and the pose the swing
      // leaves from and returns to.
      blade: add(scaled(forward, Math.cos((20 * Math.PI) / 180)), scaled(up, Math.sin((20 * Math.PI) / 180))),
      // The flat's normal points sideways, so the flats face left and right and
      // the edges are up and down.
      flat: right,
      why: 'blade forward and 20 degrees up, edges up and down',
    },
    {
      socket: 'weapon.stow',
      // 30 degrees off vertical, leaning back: hilt above the right shoulder,
      // tip down and behind. The blade axis runs hilt -> tip, so it points down.
      blade: add(scaled(up, -Math.cos((30 * Math.PI) / 180)), scaled(forward, -Math.sin((30 * Math.PI) / 180))),
      flat: right,
      why: '30 degrees off vertical leaning back, edges fore-and-aft, flats to the sides',
    },
  ];

  console.log(`  body frame: forward ${forward.map((v) => v.toFixed(2)).join(',')}  up ${up.join(',')}  right ${right.map((v) => v.toFixed(2)).join(',')}`);
  for (const target of targets) {
    const socket = skeleton.sockets.find((entry) => entry.id === target.socket);
    const bone = nodes.find((node) => node.name === socket?.bone);
    if (!socket || !bone) {
      console.error(`  no socket ${target.socket}`);
      continue;
    }
    const euler = socketEulerFor(world[bone.index] ?? [], target.blade, target.flat);
    console.log(`\n  ${target.socket} on ${socket.bone} -- ${target.why}`);
    console.log(`    "rotationDeg": [${euler.map(round).join(', ')}]`);
  }
}

main();
