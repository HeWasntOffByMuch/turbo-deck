/**
 * `npm run validate:items` -- the CI gate on weapon documents (spec 140).
 *
 * Same shape and the same two rules as `validate-units.ts`: everything that
 * decides anything is pure and lives in `src/items/`, this is only the part that
 * cannot be; it reports per file rather than stopping at the first failure, and
 * warnings print without going red.
 *
 * What it adds over the document check is the part only a file on disk can
 * answer: **does the mesh agree with what the document says about it.** A grip
 * point outside the mesh's own bounds, a `.glb` that arrived with a skeleton in
 * it, a mesh whose point axis has no extent -- none of those are visible to a
 * schema, and all three draw a weapon that is silently in the wrong place.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { error, errorsOf, formatIssue, pointer, warning, warningsOf, type Issue } from '../src/units/issues.js';
import { readGlbJson } from '../src/units/glb.js';
import { checkWeaponSockets, validateWeaponDef } from '../src/items/validate.js';
import { axisVector, measuredLength, type MeshBounds } from '../src/items/grip.js';
import { validateSkeleton } from '../src/units/validate.js';
import type { Skeleton } from '../src/units/types.js';
import type { WeaponDef } from '../src/items/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where held objects live. A directory, so adding a weapon is adding a folder. */
const ITEMS_DIR = join(repoRoot, 'assets', 'items');
/** Every skeleton a weapon's sockets are checked against. */
const UNITS_DIR = join(repoRoot, 'assets', 'units');

interface FileReport {
  readonly path: string;
  readonly issues: readonly Issue[];
}

function walk(dir: string, suffix: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full, suffix));
    else if (name.endsWith(suffix)) found.push(full);
  }
  return found;
}

/**
 * The mesh's extent, and whether it is the rigid body a weapon has to be.
 *
 * Read out of the glTF JSON rather than by decoding vertices: an accessor
 * carries `min` and `max` on POSITION by specification, so the bounds are free
 * and exact. The same reason `bake-units.ts` counts triangles off the accessors.
 */
function inspectMesh(bytes: Uint8Array): { bounds: MeshBounds; issues: readonly Issue[] } {
  const json = readGlbJson(bytes) as {
    accessors?: { min?: number[]; max?: number[] }[];
    meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
    skins?: unknown[];
    animations?: unknown[];
  };
  const issues: Issue[] = [];
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.attributes?.['POSITION'];
      const accessor = index === undefined ? undefined : json.accessors?.[index];
      if (!accessor?.min || !accessor.max) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        lo[axis] = Math.min(lo[axis] ?? Infinity, accessor.min[axis] ?? 0);
        hi[axis] = Math.max(hi[axis] ?? -Infinity, accessor.max[axis] ?? 0);
      }
    }
  }

  if (!Number.isFinite(lo[0])) {
    issues.push(error('weapon.mesh.empty', pointer('meshRef'), 'the .glb has no positioned geometry in it'));
    return { bounds: { min: [0, 0, 0], max: [0, 0, 0] }, issues };
  }
  if ((json.skins?.length ?? 0) > 0) {
    // Not merely unnecessary: a skinned mesh is drawn from its skeleton, so
    // parenting it to a socket moves the node and leaves the geometry behind.
    issues.push(
      error(
        'weapon.mesh.skinned',
        pointer('meshRef'),
        'this .glb carries a skin. A weapon is rigid and is drawn by being parented to a socket -- a skinned mesh ' +
          'follows its own skeleton instead, so it would stay where it was while the hand moved.',
      ),
    );
  }
  if ((json.animations?.length ?? 0) > 0) {
    issues.push(
      warning(
        'weapon.mesh.animated',
        pointer('meshRef'),
        'this .glb carries animation, which nothing here plays. Harmless weight, and usually a sign the mesh was ' +
          'exported from a scene rather than on its own.',
      ),
    );
  }
  return { bounds: { min: lo, max: hi }, issues };
}

/** What only the document and the mesh together can be wrong about. */
function checkAgainstMesh(weapon: WeaponDef, bounds: MeshBounds): readonly Issue[] {
  const issues: Issue[] = [];
  const length = measuredLength(bounds, weapon.grip.point);
  if (!(length > 0)) {
    issues.push(
      error(
        'weapon.mesh.flat',
        pointer('grip', 'point'),
        `the mesh has no extent along ${weapon.grip.point}, so it is not pointing that way. Check the axis against ` +
          `the bounds: ${bounds.min.map((v) => v.toFixed(3)).join(', ')} .. ${bounds.max.map((v) => v.toFixed(3)).join(', ')}`,
      ),
    );
    return issues;
  }

  // The grip has to be *on* the thing. Outside the bounds means the weapon is
  // held by a point in mid-air beside it, which draws fine and looks like the
  // hand missed.
  const slack = length * 0.05;
  for (let axis = 0; axis < 3; axis += 1) {
    const at = weapon.grip.at[axis] ?? 0;
    const min = (bounds.min[axis] ?? 0) - slack;
    const max = (bounds.max[axis] ?? 0) + slack;
    if (at >= min && at <= max) continue;
    issues.push(
      error(
        'weapon.grip.outside',
        pointer('grip', 'at'),
        `the grip point sits outside the mesh on axis ${'XYZ'[axis]}: ${at} is not within ` +
          `${(bounds.min[axis] ?? 0).toFixed(3)}..${(bounds.max[axis] ?? 0).toFixed(3)}. A weapon gripped beside ` +
          'itself draws perfectly and looks like the hand missed.',
      ),
    );
  }

  // A grip at the very tip is legal and is almost always the point axis pointing
  // the wrong way -- both supplied meshes put the handle at +Z and the tip at -Z,
  // and getting that backwards is the easiest mistake in the format.
  const along = axisVector(weapon.grip.point);
  for (let axis = 0; axis < 3; axis += 1) {
    const sign = along[axis] ?? 0;
    if (sign === 0) continue;
    const at = weapon.grip.at[axis] ?? 0;
    const tipEnd = sign > 0 ? (bounds.max[axis] ?? 0) : (bounds.min[axis] ?? 0);
    const fromTip = Math.abs(tipEnd - at);
    if (fromTip > length * 0.25) continue;
    issues.push(
      warning(
        'weapon.grip.atTip',
        pointer('grip', 'at'),
        `the grip is within a quarter of the weapon's length of the end that \`point\` calls the tip. That is a ` +
          'weapon held by its business end, and the usual cause is `point` naming the wrong direction.',
      ),
    );
  }
  return issues;
}

function main(): void {
  const documents = walk(ITEMS_DIR, '.weapondef.json');
  const reports: FileReport[] = [];

  // Every skeleton in the tree, so a weapon naming a socket nothing has is
  // caught here rather than by a missing sword in a browser.
  const skeletons: Skeleton[] = [];
  for (const path of walk(UNITS_DIR, '.skeleton.json')) {
    const result = validateSkeleton(JSON.parse(readFileSync(path, 'utf8')));
    if (result.value) skeletons.push(result.value);
  }
  const socketIds = [...new Set(skeletons.flatMap((skeleton) => skeleton.sockets.map((socket) => socket.id)))];

  for (const path of documents) {
    const issues: Issue[] = [];
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      reports.push({ path, issues: [error('weapon.unparseable', '', String(cause))] });
      continue;
    }

    const result = validateWeaponDef(parsed);
    issues.push(...result.issues);
    const weapon = result.value;
    if (weapon) {
      issues.push(...checkWeaponSockets(weapon, socketIds));
      const meshPath = join(dirname(path), weapon.meshRef);
      try {
        const inspected = inspectMesh(new Uint8Array(readFileSync(meshPath)));
        issues.push(...inspected.issues);
        issues.push(...checkAgainstMesh(weapon, inspected.bounds));
      } catch (cause) {
        issues.push(
          error('weapon.mesh.missing', pointer('meshRef'), `cannot read ${relative(repoRoot, meshPath)}: ${String(cause)}`),
        );
      }
    }
    reports.push({ path, issues });
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

  if (documents.length === 0) console.log(`no weapon documents under ${relative(repoRoot, ITEMS_DIR)}`);
  console.log(`\n${reports.length} document(s), ${errorCount} error(s), ${warningCount} warning(s)`);
  process.exitCode = errorCount > 0 ? 1 : 0;
}

main();
