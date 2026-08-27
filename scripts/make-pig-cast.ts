/**
 * Writes the pig's authored spell cast into its clip library (spec 230).
 *
 *   npx tsx scripts/make-pig-cast.ts
 *
 * The same shape as `make-pig-strike.ts` and `make-pig-shot.ts`, and for the
 * same reasons: the work is pure and lives in `src/units/`, this file is only
 * the part that cannot be, and the `.glb` it writes is committed so the
 * animation reviews as a diff of `src/units/pig-cast.ts` rather than as a blob
 * of bytes.
 *
 * The rig is read from **the mesh** rather than from `biped.skeleton.json`: the
 * document would do for the bone names, and the difference is the bind
 * rotations, which are what every authored offset is composed onto and what
 * three will actually load.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { animatedBones, authorClipDocument, frameCount } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { writeGlb } from '../src/units/glb.js';
import { CAST_CLIP_ID, PIG_CAST } from '../src/units/pig-cast.js';
import { boneNode, namingOf } from '../src/units/pose.js';
import type { BoneRole } from '../src/units/naming.js';
import type { PoseKey } from '../src/units/clip-author.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
const CLIP_DIR = join(repoRoot, 'assets', 'units', 'clips');
const MESH = join(UNIT_DIR, 'pig_a_pose_full.glb');
const OUT = join(CLIP_DIR, `${CAST_CLIP_ID}.glb`);

const GENERATOR = 'turbo-deck authored clip (spec 230)';

function fail(message: string): never {
  console.error(`  ${message}`);
  process.exit(1);
}

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(MESH)));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') {
    fail(`${relative(repoRoot, MESH)} has bones in no vocabulary this project reads; see src/units/naming.ts`);
  }
  const rig = { nodes, naming };

  // Every role the table names has to resolve, or the pose it was part of is
  // silently a different pose. A missing bone is the failure mode that looks
  // exactly like a working clip.
  const named = new Set<BoneRole>();
  for (const key of PIG_CAST.keys as readonly PoseKey[]) {
    for (const role of Object.keys(key.turns) as BoneRole[]) named.add(role);
  }
  const missing = [...named].filter((role) => boneNode(nodes, naming, role) === undefined);
  if (missing.length > 0) {
    fail(`the pig rig has no bone for ${missing.join(', ')} under the "${naming}" vocabulary`);
  }

  const document = authorClipDocument(PIG_CAST, rig, GENERATOR);
  const animation = document.animations[0];
  if (!animation || animation.channels.length === 0) fail('the authored clip has no channels in it');

  const bytes = writeGlb(document);
  writeFileSync(OUT, bytes);

  const bones = animatedBones(PIG_CAST, rig);
  console.log(`  wrote ${relative(repoRoot, OUT)} (${bytes.byteLength} bytes)`);
  console.log(
    `  ${PIG_CAST.durationMs}ms at ${PIG_CAST.fps}fps -- ${frameCount(PIG_CAST)} frames over ` +
      `${bones.length} bones, ${PIG_CAST.keys.length} key poses`,
  );
  console.log(`  ${bones.join(' ')}`);
  console.log('\n  next: npm run bake:units, then npx tsx scripts/preview-cast.ts');
}

main();
