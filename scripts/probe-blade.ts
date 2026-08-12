/**
 * Where the blade points, every frame of the swing (spec 143).
 *
 *   npx tsx scripts/probe-blade.ts
 *
 * The keys are a table anybody can read. What happens *between* them is a slerp
 * through whatever pose the previous key left, and that is where a swing grows
 * a beat nobody authored -- an arm on its way from one place to another passes
 * through everything in between, and a blade is a long lever on the end of it.
 *
 * So this samples the held blade's elevation against the body's own up, through
 * the real socket calibration rather than a proxy, and prints it as a profile
 * with the authored keys marked. A dip toward the floor that is in no key shows
 * up here as a trough between two of them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseAt } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_DURATION_MS, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, namingOf, type Vec3 } from '../src/units/pose.js';
import { quatFromEulerXyz, rotateByQuat } from '../src/items/grip.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { validateSkeleton } from '../src/units/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const skeleton = validateSkeleton(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'units', 'biped.skeleton.json'), 'utf8')),
  ).value;
  const socket = skeleton?.sockets.find((entry) => entry.id === 'weapon.main');
  const bone = nodes.find((node) => node.name === socket?.bone);
  if (!socket || !bone) throw new Error('no weapon.main socket');

  const pivot = quatFromEulerXyz((socket.rotationDeg ?? [0, 0, 0]) as Vec3);
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /** The blade's direction in world space, at `ms`. */
  const bladeAt = (ms: number): Vec3 => {
    const m = poseWorldMatrices(nodes, poseAt(PIG_STRIKE, { nodes, naming }, ms))[bone.index] ?? [];
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

  /** How far the blade turns between two instants, in degrees. */
  const sweptBetween = (from: number, to: number): number => {
    const a = bladeAt(from);
    const b = bladeAt(to);
    const alignment = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return (Math.acos(Math.max(-1, Math.min(1, alignment))) * 180) / Math.PI;
  };

  const labels = new Map<number, string>(
    Object.entries(STRIKE_KEY_MS).map(([label, ms]) => [ms as number, label]),
  );
  const STEP = 20;
  const WIDTH = 40;

  // The rate rather than the position, because "two phases of raising" is a
  // claim about *speed*: one move that accelerates and settles is one phase, and
  // a rate that peaks, falls back toward nothing and peaks again is two, however
  // smooth the positions between them look.
  const rates: number[] = [];
  for (let ms = 0; ms + STEP <= STRIKE_DURATION_MS; ms += STEP) {
    rates.push(sweptBetween(ms, ms + STEP));
  }
  const fastest = Math.max(...rates, 1);

  console.log('\n  blade elevation (-1 down, +1 up), and how fast it is turning\n');
  for (let ms = 0; ms <= STRIKE_DURATION_MS; ms += STEP) {
    const up = dot(bladeAt(ms), frame.up);
    const forward = dot(bladeAt(ms), frame.forward);
    const right = -dot(bladeAt(ms), frame.lateral);
    const column = Math.round(((up + 1) / 2) * (WIDTH - 1));
    const bar = `${'.'.repeat(column)}#${'.'.repeat(WIDTH - 1 - column)}`;
    const rate = rates[ms / STEP] ?? 0;
    const speed = '='.repeat(Math.round((rate / fastest) * 24));
    const key = labels.get(ms);
    console.log(
      `  ${String(ms).padStart(4)}  ${bar}  up ${up.toFixed(2).padStart(5)} fwd ${forward.toFixed(2).padStart(5)} rt ${right.toFixed(2).padStart(5)} | ${String(Math.round(rate)).padStart(3)}deg ${speed.padEnd(24)}${key ? ` <- ${key}` : ''}`,
    );
  }
}

main();
