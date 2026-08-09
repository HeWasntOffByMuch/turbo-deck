/**
 * Which way does this unit face, and which way does its walk go?
 *
 *   npx tsx scripts/probe-facing.ts assets/units/dev/mannequin.glb assets/units/dev/clips/*.glb
 *   npx tsx scripts/probe-facing.ts --unit assets/units/dev/mannequin.unitdef.json
 *   npx tsx scripts/probe-facing.ts --job <job-id>       # straight off .studio/
 *
 * Written for one symptom: a generated unit that faces the camera and walks
 * backwards. Four things can cause that and they have four different fixes --
 * the mesh was generated facing the other way, the auto-rig fitted a skeleton
 * into it backwards, the clip was retargeted against a different rest pose, or
 * the legs are swapped. Telling them apart by eye means generating another unit
 * and looking at it, which costs real credits and answers nothing on its own.
 *
 * So this measures all four off the `.glb` bytes, offline and free:
 *
 *  - **mesh vs rig** -- 180° apart means the skeleton was fitted into the mesh
 *    backwards. Every clip will then play backwards, and no clip is at fault.
 *  - **rig vs clip** -- 180° apart with the mesh and rig agreeing means the
 *    animation itself strides the wrong way.
 *  - **rest pose drift** -- the clip file's skeleton against the mesh file's.
 *    The renderer binds clips by bone name onto the mesh's rig, so any
 *    difference here is applied to every frame as an error nobody logged.
 *  - **handedness** -- whether the bones named `Left*` are on the left, given
 *    where the toes point.
 *
 * The reference unit in `assets/units/dev/` is the control: it is authored
 * here, it faces +X on purpose, and running the probe over it is how you tell a
 * broken unit from a broken probe.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  angleBetween,
  clipFacing,
  meshFacing,
  meshPoints,
  openGlb,
  restPoseDeltas,
  restSkeleton,
  rigFacing,
  type Model,
  type Vec3,
} from '../src/units/facing.js';
import type { Job } from '../src/server/studio/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The project's declared front, from the skeleton documents. */
const DECLARED_FORWARD: Vec3 = [1, 0, 0];

function load(path: string): Model {
  return openGlb(new Uint8Array(readFileSync(path)));
}

function show(v: Vec3 | null): string {
  if (v === null) return 'not measurable';
  const axis = describeAxis(v);
  return `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})${axis === null ? '' : ` ≈ ${axis}`}`;
}

/** The nearest named axis, when the direction is within 30° of one. */
function describeAxis(v: Vec3): string | null {
  const axes: readonly (readonly [string, Vec3])[] = [
    ['+X', [1, 0, 0]],
    ['-X', [-1, 0, 0]],
    ['+Z', [0, 0, 1]],
    ['-Z', [0, 0, -1]],
  ];
  for (const [name, axis] of axes) {
    const angle = angleBetween(v, axis);
    if (angle !== null && angle <= 30) return name;
  }
  return null;
}

function degrees(a: Vec3 | null, b: Vec3 | null): string {
  const angle = angleBetween(a, b);
  return angle === null ? 'n/a' : `${angle.toFixed(0)}°`;
}

/** A pairwise verdict in the only three bands that mean anything different. */
function verdict(label: string, a: Vec3 | null, b: Vec3 | null, backwards: string, sideways: string): string | null {
  const angle = angleBetween(a, b);
  if (angle === null) return null;
  if (angle > 135) return `  ✗ ${label}: ${angle.toFixed(0)}° apart -- ${backwards}`;
  if (angle > 45) return `  ✗ ${label}: ${angle.toFixed(0)}° apart -- ${sideways}`;
  return `  ✓ ${label}: ${angle.toFixed(0)}° apart`;
}

function probe(meshPath: string, clipPaths: readonly string[]): boolean {
  const mesh = load(meshPath);
  const skeleton = restSkeleton(mesh);
  const rig = rigFacing(skeleton);
  const geometry = meshFacing(meshPoints(mesh));

  console.log(`\n${meshPath}`);
  console.log(`  mesh forward (feet)  ${show(geometry.fromFeet)}  lean ${(geometry.lean.feet * 100).toFixed(1)}%`);
  console.log(`  mesh forward (head)  ${show(geometry.fromHead)}  lean ${(geometry.lean.head * 100).toFixed(1)}%`);
  console.log(`  rig forward (toes)   ${show(rig.forward)}`);
  console.log(`  rig left (hips)      ${show(rig.left)}`);
  console.log(`  vertices ${geometry.vertexCount}, bones ${skeleton.world.size}`);

  const lines: string[] = [];
  const push = (line: string | null): void => {
    if (line !== null) lines.push(line);
  };

  push(
    verdict(
      'mesh vs rig',
      geometry.fromFeet,
      rig.forward,
      'the skeleton was fitted into the mesh BACKWARDS. Every clip will play backwards and no clip is at fault; regenerate with the other orientation.',
      'the skeleton is yawed inside the mesh.',
    ),
  );
  push(
    verdict(
      'feet vs head',
      geometry.fromFeet,
      geometry.fromHead,
      'the two geometry estimates disagree, so one of them is wrong -- read the rest of this against the rig, not against the mesh.',
      'the two geometry estimates disagree.',
    ),
  );
  push(
    verdict(
      'rig vs the +X the project draws',
      rig.forward,
      DECLARED_FORWARD,
      'the rig faces the way the scene will draw its back. Nothing applies `forwardAxis` at import, so this yaw has to be baked in or applied.',
      'the rig does not face +X, so the scene will draw it walking sideways.',
    ),
  );
  if (rig.handednessOk === false) {
    lines.push('  ✗ handedness: the bones named Left* are on the rig\'s right, given where the toes point.');
  }

  for (const clipPath of clipPaths) {
    const clipModel = load(clipPath);
    const clip = clipFacing(clipModel);
    console.log(`\n  ${clipPath}`);
    if (clip === null) {
      console.log('    no animation in this file');
      continue;
    }
    console.log(`    animation "${clip.animation}", ${clip.frames} samples, stride ${clip.strideLength.toFixed(3)}`);
    console.log(`    root travel          ${show(clip.rootTravel)}`);
    console.log(`    stride forward       ${show(clip.strideForward)}`);
    console.log(`    stride vs rig toes   ${degrees(clip.strideForward, rig.forward)}`);

    // A clip with no travel is an idle, and an idle has no opinion about
    // forward. Reporting one would be noise at best and a wrong diagnosis at
    // worst -- the estimator fits a slope through a foot that never moves.
    if (clip.strideLength < 0.02) {
      console.log('    (no meaningful foot travel -- an idle or a pose, so it is not asked which way it goes)');
      continue;
    }
    push(
      verdict(
        `${clipPath}: stride vs rig`,
        clip.strideForward,
        rig.forward,
        'the clip strides towards the rig\'s BACK. This is the walk-backwards symptom, in the clip rather than in the rig.',
        'the clip strides across the rig.',
      ),
    );

    const drift = restPoseDeltas(mesh, clipModel).filter((delta) => delta.degrees > 5);
    if (drift.length > 0) {
      const worst = drift.slice(0, 5).map((delta) => `${delta.bone} ${delta.degrees.toFixed(0)}°`).join(', ');
      lines.push(
        `  ✗ ${clipPath}: its rest pose differs from the mesh's on ${drift.length} bone(s) -- ${worst}. ` +
          'Clips bind by bone name onto the mesh\'s rig, so that difference is applied to every frame.',
      );
    }
  }

  console.log('');
  for (const line of lines) console.log(line);
  return lines.some((line) => line.startsWith('  ✗'));
}

/** The artifacts of a job on disk, so a real generation can be probed as-is. */
function jobArtifacts(jobId: string): { readonly mesh: string; readonly clips: string[] } | null {
  const path = join(repoRoot, '.studio', 'jobs.json');
  if (!existsSync(path)) {
    console.error(`no ${path} -- run this against .glb paths instead.`);
    return null;
  }
  const jobs = JSON.parse(readFileSync(path, 'utf8')) as Job[] | { jobs?: Job[] };
  const list = Array.isArray(jobs) ? jobs : (jobs.jobs ?? []);
  const job = list.find((entry) => entry.id === jobId);
  if (!job) {
    console.error(`no job ${jobId} in ${path}. Jobs on disk: ${list.map((entry) => entry.id).join(', ')}`);
    return null;
  }
  // The rigged model, never the raw generation: the unrigged mesh has no
  // skeleton to compare anything against.
  const mesh = job.artifacts.riggedGlb;
  if (mesh === null) {
    console.error(`job ${jobId} has no rigged model on disk yet.`);
    return null;
  }
  return { mesh, clips: Object.values(job.artifacts.clipGlbs) };
}

function main(): void {
  const args = process.argv.slice(2);
  const jobFlag = args.indexOf('--job');
  const unitFlag = args.indexOf('--unit');

  let meshPath: string | undefined;
  let clipPaths: string[] = [];

  if (jobFlag >= 0) {
    const found = jobArtifacts(args[jobFlag + 1] ?? '');
    if (found === null) {
      process.exitCode = 1;
      return;
    }
    meshPath = found.mesh;
    clipPaths = found.clips;
  } else if (unitFlag >= 0) {
    const unitPath = resolve(args[unitFlag + 1] ?? '');
    const dir = dirname(unitPath);
    const unit = JSON.parse(readFileSync(unitPath, 'utf8')) as { meshRef: string; clipLibRef: string };
    const clipLib = JSON.parse(readFileSync(join(dir, unit.clipLibRef), 'utf8')) as {
      clips: readonly { source: string }[];
    };
    meshPath = join(dir, unit.meshRef);
    clipPaths = clipLib.clips.map((clip) => join(dir, clip.source));
  } else {
    meshPath = args[0];
    clipPaths = args.slice(1);
  }

  if (meshPath === undefined) {
    console.error('usage: probe-facing.ts <mesh.glb> [clip.glb ...] | --unit <unitdef.json> | --job <job-id>');
    process.exitCode = 1;
    return;
  }

  const problems = probe(meshPath, clipPaths);
  if (!problems) console.log('  ✓ nothing disagrees.');
}

main();
