/**
 * Which way does this unit face, and which way does its walk go? (spec 116)
 *
 *   npx tsx scripts/probe-facing.ts assets/units/dev/mannequin.glb assets/units/dev/clips/walk.glb
 *   npx tsx scripts/probe-facing.ts --unit assets/units/dev/mannequin.unitdef.json
 *   npx tsx scripts/probe-facing.ts --job <job-id>       # straight off .studio/
 *
 * The terminal end of the same report the Studio tab's **Check facing** button
 * shows and the `/api/studio/jobs/:id/facing` route returns. All the measuring
 * is in `src/units/facing.ts`; this decides what a person staring at a
 * scrollback needs to see, and nothing else.
 *
 * The reference unit in `assets/units/dev/` is the control: it is authored
 * here, it faces +X on purpose, and running the probe over it is how you tell a
 * broken unit from a broken probe.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  facingIsClean,
  facingReport,
  nearestAxis,
  type ClipReport,
  type FacingReport,
  type FacingSource,
  type Vec3,
} from '../src/units/facing.js';
import type { Job } from '../src/server/studio/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(path: string): FacingSource {
  return { name: path, bytes: new Uint8Array(readFileSync(path)) };
}

function show(v: Vec3 | null): string {
  if (v === null) return 'not measurable';
  const axis = nearestAxis(v);
  return `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})${axis === null ? '' : ` ≈ ${axis}`}`;
}

function printClip(clip: ClipReport): void {
  console.log(`\n  ${clip.source}`);
  if (clip.error !== null) {
    console.log(`    ${clip.error}`);
    return;
  }
  console.log(`    animation "${clip.animation}", stride ${clip.strideLength.toFixed(3)}, ${clip.matchedBones} bones shared with the mesh`);
  console.log(`    root travel          ${show(clip.rootTravel)}`);
  console.log(`    stride forward       ${show(clip.strideForward)}`);
  if (!clip.measurable) {
    console.log('    (no foot bones to watch -- nothing is claimed about which way this goes)');
    return;
  }
  if (!clip.moving) {
    console.log('    (no meaningful foot travel -- an idle or a pose, so it is not asked which way it goes)');
    return;
  }
  console.log(`    stride vs rig toes   ${clip.degreesFromRig === null ? 'n/a' : `${clip.degreesFromRig.toFixed(0)}°`}`);
}

function printReport(report: FacingReport): void {
  if (report.error !== null) {
    console.error(report.error);
    return;
  }
  console.log(`  mesh forward (feet)  ${show(report.mesh.fromFeet)}  lean ${(report.mesh.lean.feet * 100).toFixed(1)}%`);
  console.log(`  mesh forward (head)  ${show(report.mesh.fromHead)}  lean ${(report.mesh.lean.head * 100).toFixed(1)}%`);
  console.log(`  rig forward (toes)   ${show(report.rig.forward)}`);
  console.log(`  rig left (hips)      ${show(report.rig.left)}`);
  console.log(`  vertices ${report.mesh.vertexCount}, bones ${report.rig.boneNames.length}`);
  // Printed in full when the rig could not be read, because then the bone names
  // *are* the finding and a truncated list is a second round trip.
  if (report.rig.forward === null) {
    console.log(`  bones: ${report.rig.boneNames.join(', ')}`);
  }

  for (const clip of report.clips) printClip(clip);

  console.log('');
  for (const finding of report.findings) {
    const mark = finding.severity === 'ok' ? '✓' : '✗';
    const angle = finding.degrees === null ? '' : ` (${finding.degrees.toFixed(0)}°)`;
    console.log(`  ${mark} ${finding.title}${angle}: ${finding.message}`);
  }
  if (facingIsClean(report)) console.log('\n  Nothing disagrees.');
}

/**
 * An artifact path as recorded, or the same file where the store would put it.
 *
 * The job record holds whatever path the process that downloaded it wrote,
 * which is absolute when `STUDIO_DATA_DIR` was. A clone with the assets copied
 * in, or a data dir that moved, would otherwise fail on a path that is right
 * about the file and wrong about the machine.
 */
function locate(jobId: string, recorded: string): string {
  if (existsSync(recorded)) return recorded;
  const beside = join(repoRoot, '.studio', 'assets', jobId, recorded.split(/[\\/]/).pop() ?? '');
  return existsSync(beside) ? beside : recorded;
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
    // The listing rather than "no such job": the ids are uuids, and the reason
    // to be here at all is usually not knowing which one to look at.
    console.error(`no job "${jobId}" in ${path}. Jobs on disk:`);
    for (const entry of list) {
      const clips = Object.keys(entry.artifacts.clipGlbs).join(', ') || 'no clips';
      console.error(`  ${entry.id}  ${entry.unitId} · ${entry.status} · ${clips}`);
    }
    return null;
  }
  // The rigged model, never the raw generation: the unrigged mesh has no
  // skeleton to compare anything against.
  const mesh = job.artifacts.riggedGlb;
  if (mesh === null) {
    console.error(`job ${jobId} has no rigged model on disk yet.`);
    return null;
  }
  return {
    mesh: locate(job.id, mesh),
    clips: Object.values(job.artifacts.clipGlbs).map((clip) => locate(job.id, clip)),
  };
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

  console.log(`\n${meshPath}`);
  const report = facingReport(source(meshPath), clipPaths.map(source));
  printReport(report);
  if (!facingIsClean(report)) process.exitCode = 1;
}

main();
