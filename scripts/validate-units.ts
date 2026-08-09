/**
 * `npm run validate:units` -- the CI gate on authored unit documents (spec 107).
 *
 * Everything that decides anything lives in `src/units/`, which is pure and
 * tested. This file is only the part that cannot be: finding the documents,
 * reading them, resolving one document's reference to another into a path on
 * disk, and turning the report into an exit code.
 *
 * Two rules about how it reports:
 *
 *  - **Per file, never first-failure.** A run that stops at the first broken
 *    document turns fixing a batch into one round trip per problem.
 *  - **Warnings print and do not fail.** A provisional skeleton and a rig with
 *    finger joints are both worth saying out loud and neither is a reason to go
 *    red; collapsing the two severities means either CI fails over a style note
 *    or a dangling reference ships as a warning nobody read.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorsOf, formatIssue, warningsOf, type Issue } from '../src/units/issues.js';
import { readGlbJson } from '../src/units/glb.js';
import { rootMotionChannels, rootMotionMessage } from '../src/units/root-motion.js';
import { validateClipLib, validateSkeleton, validateUnitBundle, validateUnitDef } from '../src/units/validate.js';
import type { ClipLib, Skeleton } from '../src/units/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where authored units live. A directory rather than a manifest, so adding a unit is adding a file. */
const UNITS_DIR = join(repoRoot, 'assets', 'units');

interface FileReport {
  readonly path: string;
  readonly issues: readonly Issue[];
}

function listJson(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listJson(full));
    } else if (entry.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Files under `assets/units/` that are deliberately not unit documents.
 *
 * `manifest.json` is written by `npm run bake:units` and is a record of what the
 * assets hash to (spec 113). Warning about it on every run would train people to
 * ignore this runner's warnings, which are otherwise all worth reading.
 */
const NOT_A_DOCUMENT: ReadonlySet<string> = new Set(['manifest.json']);

/** Which document a file is, by its name. The suffix is the declaration. */
function kindOf(path: string): 'skeleton' | 'cliplib' | 'unitdef' | null {
  if (path.endsWith('.skeleton.json')) return 'skeleton';
  if (path.endsWith('.cliplib.json')) return 'cliplib';
  if (path.endsWith('.unitdef.json')) return 'unitdef';
  return null;
}

function readJson(path: string): { doc: unknown } | { parseError: string } {
  try {
    return { doc: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (cause) {
    return { parseError: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Root motion in the clip files a library points at (spec 111).
 *
 * The loud half of "root motion is stripped at import". The importer strips it
 * and says so in a console nobody is reading; this fails the build, which is the
 * only volume setting that reliably works. A clip authored with a two-metre
 * stride and shipped as one that moon-walks in place is otherwise something you
 * find out by watching it.
 *
 * A clip whose `.glb` is missing or unreadable is a warning rather than an
 * error: the documents are the thing under test here, an author may legitimately
 * be validating a library before the bakes land, and a runner that went red over
 * an absent binary would make the JSON gate unusable during authoring.
 */
function checkClipBinaries(clipLibPath: string, clipLib: ClipLib, rootBone: string): readonly Issue[] {
  const issues: Issue[] = [];
  const base = dirname(clipLibPath);

  for (const [index, clip] of clipLib.clips.entries()) {
    const path = resolve(base, clip.source);
    let gltf: unknown;
    try {
      gltf = readGlbJson(new Uint8Array(readFileSync(path)));
    } catch (cause) {
      issues.push({
        severity: 'warning',
        code: 'runner.clip.unreadable',
        path: `/clips/${index}/source`,
        message: `could not read ${relative(repoRoot, path)} (${cause instanceof Error ? cause.message : String(cause)}); root motion not checked`,
      });
      continue;
    }

    const offending = rootMotionChannels(gltf, rootBone);
    if (offending.length === 0) continue;
    issues.push({
      severity: 'error',
      code: 'runner.clip.rootMotion',
      path: `/clips/${index}/source`,
      message: rootMotionMessage(clipLib.id, clip.id, [...new Set(offending.map((channel) => channel.bone))]),
    });
  }
  return issues;
}

function main(): void {
  const files = listJson(UNITS_DIR);
  const reports: FileReport[] = [];
  const skeletons = new Map<string, Skeleton>();
  const clipLibs = new Map<string, ClipLib>();
  /** Deferred so every skeleton and library is loaded before any bundle resolves. */
  const pendingBundles: { path: string; doc: ReturnType<typeof validateUnitDef> }[] = [];

  for (const path of files) {
    if (NOT_A_DOCUMENT.has(path.split('/').pop() ?? '')) continue;
    const kind = kindOf(path);
    if (kind === null) {
      reports.push({
        path,
        issues: [
          {
            severity: 'warning',
            code: 'runner.unknown',
            path: '',
            message: 'not a .skeleton.json, .cliplib.json or .unitdef.json -- skipped',
          },
        ],
      });
      continue;
    }

    const read = readJson(path);
    if ('parseError' in read) {
      reports.push({
        path,
        issues: [{ severity: 'error', code: 'runner.parse', path: '', message: read.parseError }],
      });
      continue;
    }

    if (kind === 'skeleton') {
      const result = validateSkeleton(read.doc);
      reports.push({ path, issues: result.issues });
      if (result.value) skeletons.set(path, result.value);
    } else if (kind === 'cliplib') {
      const result = validateClipLib(read.doc);
      reports.push({ path, issues: result.issues });
      if (result.value) clipLibs.set(path, result.value);
    } else {
      const result = validateUnitDef(read.doc);
      reports.push({ path, issues: result.issues });
      if (result.value) pendingBundles.push({ path, doc: result });
    }
  }

  // The cross-document pass, once everything that could load has loaded. A ref
  // is relative to the file that names it, which is the only thing here that
  // knows what a path means -- `validateUnitBundle` takes documents precisely so
  // it never has to.
  for (const { path, doc } of pendingBundles) {
    const unit = doc.value;
    if (!unit) continue;
    const base = dirname(path);
    const skeletonPath = resolve(base, unit.skeletonRef);
    const clipLibPath = resolve(base, unit.clipLibRef);
    const skeleton = skeletons.get(skeletonPath);
    const clipLib = clipLibs.get(clipLibPath);

    const issues: Issue[] = [];
    if (!skeleton) {
      issues.push({
        severity: 'error',
        code: 'runner.skeletonRef',
        path: '/skeletonRef',
        message: `"${unit.skeletonRef}" did not resolve to a skeleton that validated (looked for ${relative(repoRoot, skeletonPath)})`,
      });
    }
    if (!clipLib) {
      issues.push({
        severity: 'error',
        code: 'runner.clipLibRef',
        path: '/clipLibRef',
        message: `"${unit.clipLibRef}" did not resolve to a clip library that validated (looked for ${relative(repoRoot, clipLibPath)})`,
      });
    }
    if (skeleton && clipLib) {
      issues.push(...validateUnitBundle({ unit, skeleton, clipLib }));
      // Needs both documents: the library says where the clips are and the
      // skeleton says which bone is the root, and the check is meaningless
      // without either. Read rather than assumed -- pointing it at a guessed
      // root would either miss translation that is there or condemn a track
      // the rig needed.
      const root = skeleton.bones.find((bone) => bone.parent === null)?.name;
      if (root !== undefined) issues.push(...checkClipBinaries(clipLibPath, clipLib, root));
      if (clipLib.skeletonRef !== '' && resolve(dirname(clipLibPath), clipLib.skeletonRef) !== skeletonPath) {
        issues.push({
          severity: 'error',
          code: 'runner.skeleton.mismatch',
          path: '/clipLibRef',
          message: `unit is rigged to ${relative(repoRoot, skeletonPath)} but clip library "${clipLib.id}" is bound to ${clipLib.skeletonRef}; clips bind by bone name and these are different rigs`,
        });
      }
    }
    // Merged into the unitdef's own report so one file is one block of output.
    const existing = reports.find((report) => report.path === path);
    if (existing) {
      reports.splice(reports.indexOf(existing), 1, { path, issues: [...existing.issues, ...issues] });
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const report of reports) {
    const errors = errorsOf(report.issues);
    const warnings = warningsOf(report.issues);
    errorCount += errors.length;
    warningCount += warnings.length;
    const label = relative(repoRoot, report.path);
    if (report.issues.length === 0) {
      console.log(`ok    ${label}`);
      continue;
    }
    console.log(`${errors.length > 0 ? 'FAIL ' : 'warn '} ${label}`);
    for (const issue of report.issues) console.log(`        ${formatIssue(issue)}`);
  }

  if (files.length === 0) {
    console.log(`no unit documents under ${relative(repoRoot, UNITS_DIR)}`);
  }
  console.log(
    `\n${reports.length} document(s), ${errorCount} error(s), ${warningCount} warning(s)`,
  );
  process.exitCode = errorCount > 0 ? 1 : 0;
}

main();
