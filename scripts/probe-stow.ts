/**
 * Where a sheathed weapon sits against the body it is strapped to (spec 143).
 *
 *   npx tsx scripts/probe-stow.ts
 *
 * `scripts/solve-grip.ts` answers which way the sword *points*, which is a
 * rotation. This answers where it hangs, which is the offset beside it -- the
 * half of a socket calibration a rotation cannot express, and the half that is
 * easy to leave at zero without noticing, because a correctly-angled sword on
 * the body's midline looks like it is growing out of the spine.
 *
 * It is a probe rather than a solver because the requirement is a clearance and
 * not a point: the scabbard has to sit outside the body it is strapped to. So
 * what this prints is the pig's actual *surface* at the socket's height and
 * fore-aft place, skinned at idle rather than taken from a bounding box -- a
 * pig standing bipedally is far wider at the belly than its shoulder joints are
 * apart, and the skeleton cannot say so. The socket's own place is printed
 * beside it, in the same body axes, so "is it clear of the body" is a
 * subtraction rather than a screenshot.
 *
 * Read at idle, because that is the pose `weapon.stow` is calibrated at and the
 * pose a pig wearing a sword is in essentially all of the time.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipPoseAt } from '../src/units/clip-sample.js';
import {
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
} from '../src/units/glb-read.js';
import { bodyFrame, boneNode, namingOf, type Vec3 } from '../src/units/pose.js';
import { poseWorldMatrices, skinPositions } from '../src/units/skin.js';
import { validateSkeleton } from '../src/units/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
/** The family's clips, which moved out of the unit folder when the fox joined. */
const CLIP_DIR = join(repoRoot, 'assets', 'units', 'clips');

/** How wide a slab of the body counts as "beside the socket", in rig units. */
const BAND = 0.1;

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
  if (!skeleton) throw new Error('biped.skeleton.json does not validate');

  const right: Vec3 = [-frame.lateral[0], -frame.lateral[1], -frame.lateral[2]];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const idle = splitGlb(new Uint8Array(readFileSync(join(CLIP_DIR, 'idle.glb'))));
  const world = poseWorldMatrices(nodes, clipPoseAt(idle, nodes, 0));
  const mesh = readSkinnedMesh(glb);
  if (!mesh) throw new Error('the pig mesh has no skin to measure a surface from');
  const skinned = skinPositions({ ...mesh, inverseBind: readInverseBindMatrices(glb) }, world);

  const hips = boneNode(nodes, naming, 'hips');
  if (!hips) throw new Error('the pig rig has no hips');
  const origin = world[hips.index] ?? [];
  const relative = (point: Vec3): Vec3 => [
    point[0] - (origin[12] ?? 0),
    point[1] - (origin[13] ?? 0),
    point[2] - (origin[14] ?? 0),
  ];

  for (const socket of skeleton.sockets) {
    if (!socket.id.startsWith('weapon.')) continue;
    const bone = nodes.find((node) => node.name === socket.bone);
    if (!bone) continue;
    const m = world[bone.index] ?? [];
    const offset = socket.offset ?? [0, 0, 0];
    // The bone's origin plus its offset through the bone's basis, which is what
    // `socketPivot` builds in the scene graph.
    const along = (axis: number): number =>
      (m[12 + axis] ?? 0) +
      (m[axis] ?? 0) * (offset[0] ?? 0) +
      (m[4 + axis] ?? 0) * (offset[1] ?? 0) +
      (m[8 + axis] ?? 0) * (offset[2] ?? 0);
    const place = relative([along(0), along(1), along(2)]);

    const at = { right: dot(place, right), up: dot(place, frame.up), forward: dot(place, frame.forward) };
    let left = Infinity;
    let outward = -Infinity;
    let counted = 0;
    for (let index = 0; index < skinned.length; index += 3) {
      const point = relative([skinned[index] ?? 0, skinned[index + 1] ?? 0, skinned[index + 2] ?? 0]);
      if (Math.abs(dot(point, frame.up) - at.up) > BAND) continue;
      if (Math.abs(dot(point, frame.forward) - at.forward) > BAND) continue;
      const sideways = dot(point, right);
      left = Math.min(left, sideways);
      outward = Math.max(outward, sideways);
      counted += 1;
    }

    console.log(`\n  ${socket.id} on ${socket.bone}`);
    console.log(`    socket at  right ${at.right.toFixed(3)}  up ${at.up.toFixed(3)}  fwd ${at.forward.toFixed(3)}`);
    if (counted === 0) {
      console.log('    no body within the band -- the socket is off the mesh entirely');
      continue;
    }
    console.log(`    body there right ${left.toFixed(3)} .. ${outward.toFixed(3)}  (${counted} vertices)`);
    // Positive means the socket is outboard of the body's own surface. The sign
    // flips with the side: on the pig's left, "further out" is more negative.
    const clearance = at.right < 0 ? left - at.right : at.right - outward;
    console.log(
      `    clearance ${clearance.toFixed(3)} ${clearance >= 0 ? '(outside the body)' : '(INSIDE the body -- it will be drawn buried)'}`,
    );
  }
}

main();
