/**
 * Put a rigged `.glb` into an existing rig family (spec 139).
 *
 *   npx tsx scripts/add-unit.ts <rigged.glb> --id <unitId> [--family biped]
 *   npx tsx scripts/add-unit.ts <rigged.glb> --id <unitId> --dry-run
 *
 * The whole point of a rig family is that one clip library animates every body
 * in it, and until this existed the only way to use that was to hand-edit a
 * generated document: repoint two refs at another folder, copy a state machine
 * out of a sibling, work out an import scale, re-bake. The fox went through
 * exactly that and shipped pointing at a clip library that did not exist,
 * because nothing checked and the failure is silent -- a unit with no clips
 * loads, draws, and poses nothing.
 *
 * So this is that sequence with the checks attached. It spends nothing and
 * talks to no API: joining a family is *not* a generation, it is the case where
 * the clips already exist and are already right for this rig.
 *
 * Everything that decides anything lives in `src/units/` and is pure and
 * tested -- `skeletonFromRig` derives the contract, `compareToFamily` holds the
 * new rig against it, `meshHeight` measures. This file is only the part that
 * cannot be: finding files, copying bytes, and turning a report into an exit
 * code.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorsOf, formatIssue, warningsOf, type Issue } from '../src/units/issues.js';
import { meshHeight, splitGlb } from '../src/units/glb-read.js';
import { compareToFamily, skeletonFromRig } from '../src/units/skeleton-from-rig.js';
import { validateSkeleton, validateUnitDef } from '../src/units/validate.js';
import type { Skeleton, UnitDef } from '../src/units/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNITS_DIR = join(repoRoot, 'assets', 'units');
const DEFAULT_FAMILY = 'biped';

interface Args {
  readonly glb: string;
  readonly id: string;
  readonly family: string;
  readonly dryRun: boolean;
}

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('  npx tsx scripts/add-unit.ts <rigged.glb> --id <unitId> [--family biped] [--dry-run]');
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  let glb: string | null = null;
  let id: string | null = null;
  let family = DEFAULT_FAMILY;
  let dryRun = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--id') id = argv[++at] ?? null;
    else if (arg === '--family') family = argv[++at] ?? family;
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else if (glb === null) glb = arg;
    else usage(`unexpected argument ${arg}`);
  }
  if (glb === null) usage('no .glb given');
  if (id === null) usage('no --id given: a unit needs an id, and it is also its directory name');
  if (!/^[a-z0-9_]+$/.test(id)) usage(`--id "${id}" should be lowercase letters, digits and underscores`);
  return { glb, id, family, dryRun };
}

/** The family's skeleton document, which is the contract the rig is held to. */
function readFamily(family: string): Skeleton {
  const path = join(UNITS_DIR, `${family}.skeleton.json`);
  if (!existsSync(path)) {
    const known = readdirSync(UNITS_DIR)
      .filter((name) => name.endsWith('.skeleton.json'))
      .map((name) => name.replace('.skeleton.json', ''));
    usage(`no family "${family}" (looked for ${relative(repoRoot, path)}). This repo has: ${known.join(', ') || 'none'}`);
  }
  const result = validateSkeleton(JSON.parse(readFileSync(path, 'utf8')));
  if (!result.value) {
    console.error(`the "${family}" family's own skeleton does not validate:`);
    for (const issue of errorsOf(result.issues)) console.error(`  ${formatIssue(issue)}`);
    process.exit(1);
  }
  return result.value;
}

interface Template {
  readonly id: string;
  readonly doc: UnitDef;
}

/**
 * An existing member of the family, whose state machine the new unit copies.
 *
 * Not scaffolded from the clip set, deliberately. A scaffold builds a machine
 * from clip *names* and it guesses well, but it guesses -- handed this family's
 * five clips it reaches for `defeat_02` as the death state where every body
 * already in the family uses `hurt`. Two members of one family differing in
 * which clip plays when they die is precisely the incoherence a family is for
 * preventing, so the machine is copied from a body that already works rather
 * than derived a second time from weaker evidence.
 */
function findTemplate(family: string): Template | null {
  for (const dir of readdirSync(UNITS_DIR).sort()) {
    const full = join(UNITS_DIR, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.unitdef.json')) continue;
      const doc = validateUnitDef(JSON.parse(readFileSync(join(full, name), 'utf8'))).value;
      if (!doc) continue;
      if (basename(doc.skeletonRef) !== `${family}.skeleton.json`) continue;
      return { id: doc.id, doc };
    }
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.glb)) usage(`no such file: ${args.glb}`);

  const established = readFamily(args.family);
  const glb = splitGlb(new Uint8Array(readFileSync(args.glb)));

  // Derived only to be compared: nothing here writes a skeleton document. The
  // family already has one and it is never rewritten once it has a bind pose --
  // from then on it is the contract, and this is the check against it.
  const derived = skeletonFromRig(glb, {
    id: args.family,
    source: `${args.id}.glb`,
    canonicalHeight: established.canonicalHeight,
  });
  if (!derived.skeleton) {
    console.error(`could not read a rig out of ${args.glb}:`);
    for (const issue of errorsOf(derived.issues)) console.error(`  ${formatIssue(issue)}`);
    process.exit(1);
  }

  const issues: Issue[] = [...derived.issues, ...compareToFamily(established, derived.skeleton)];
  const errors = errorsOf(issues);
  const warnings = warningsOf(issues);
  for (const issue of warnings) console.log(`  ${formatIssue(issue)}`);
  if (errors.length > 0) {
    console.error(`\n${args.id} cannot join the "${args.family}" family:`);
    for (const issue of errors) console.error(`  ${formatIssue(issue)}`);
    console.error(
      "\nThe family's clips drive bones by name. A rig short of one is a clip set applied to nothing, which\n" +
        'loads and draws and never moves -- so this is refused here rather than found in the game.',
    );
    process.exit(1);
  }

  const template = findTemplate(args.family);
  if (!template) {
    console.error(
      `the "${args.family}" family has no member to copy a state machine from, so there is nothing to join.\n` +
        'Export a first body through the Studio; this script adds the second and later ones.',
    );
    process.exit(1);
  }

  // The scale is measured, never picked: the rig is drawn at the family's
  // canonical height whatever it was authored at.
  const height = meshHeight(glb);
  if (height <= 0) {
    console.error(`${args.glb} has no skinned mesh to measure, so there is no import scale to work out`);
    process.exit(1);
  }
  const scale = established.canonicalHeight / height;

  const unit: UnitDef = {
    ...template.doc,
    $comment:
      `Joined the ${args.family} family with scripts/add-unit.ts (spec 139) from ${basename(args.glb)}. Its rig was ` +
      `held against the family's skeleton and matched; the state machine is ${template.id}'s, because one family means ` +
      'one set of behaviours as much as one set of clips. Provenance is zeroed rather than faked -- nothing was ' +
      'generated or charged here, this body was added to clips that already existed.',
    id: args.id,
    meshRef: `${args.id}.glb`,
    skeletonRef: `../${args.family}.skeleton.json`,
    clipLibRef: `../${args.family}.core.cliplib.json`,
    provenance: {
      tripoTaskIds: { imageToModel: 'added-by-script', rigCheck: 'added-by-script', rig: null, retarget: [] },
      modelVersion: 'added-by-script',
      faceLimit: template.doc.provenance.faceLimit,
      referenceImageSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      creditsSpent: 0,
      generatedAt: '2026-01-01T00:00:00Z',
    },
    import: { ...template.doc.import, scale },
  } as UnitDef;

  const check = validateUnitDef(unit);
  if (errorsOf(check.issues).length > 0) {
    console.error('the document this would write does not validate, which is a bug in this script:');
    for (const issue of errorsOf(check.issues)) console.error(`  ${formatIssue(issue)}`);
    process.exit(1);
  }

  const outDir = join(UNITS_DIR, args.id);
  const meshOut = join(outDir, `${args.id}.glb`);
  const docOut = join(outDir, `${args.id}.unitdef.json`);

  console.log(`\n  ${args.id} joins "${args.family}"`);
  console.log(`  ${derived.skeleton.bones.length} bones, matching the family exactly`);
  console.log(`  clips: ${template.doc.clipLibRef} (the family's, shared -- nothing was generated)`);
  console.log(`  machine: ${template.id}'s, ${template.doc.stateMachine.states.length} state(s)`);
  console.log(`  import scale ${scale.toFixed(6)}, drawing it ${established.canonicalHeight} units tall`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(args.glb, meshOut);
  writeFileSync(docOut, `${JSON.stringify(unit, null, 2)}\n`);
  console.log(`\n  wrote ${relative(repoRoot, meshOut)}`);
  console.log(`  wrote ${relative(repoRoot, docOut)}`);
  console.log('\nNow re-bake the manifest, which is what makes the game able to load it:');
  console.log('  npm run bake:units');
  console.log(`\nThen see it: npm run dev, and open  ?units=player:${args.id}`);
}

main();
