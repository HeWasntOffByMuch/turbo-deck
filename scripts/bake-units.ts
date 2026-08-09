/**
 * `npm run bake:units` -- the offline model build (spec 113).
 *
 * Step 7 of the brief says the bake "feeds the existing offline model build".
 * There was no existing offline model build: `.glb` files went into the bundle
 * byte-for-byte and nothing had ever processed a mesh. This is that build, doing
 * the part of it that can be done honestly today.
 *
 * What it does:
 *
 *  - checks every `.glb` a unitdef references is actually there,
 *  - gates the triangle count against the unitdef's declared `import.targetTris`,
 *  - hashes every file and writes `assets/units/manifest.json`.
 *
 * What it does **not** do, and does not pretend to: decimation, meshopt
 * compression and KTX2 textures. Each needs a real library, and a stage that
 * passed the bytes through unchanged while adding its name to `builtStages`
 * would be worse than an absent stage -- it would make the manifest lie about
 * what the assets are. When a dependency is chosen, each becomes a stage that
 * appends to `builtStages` and nothing else here changes.
 *
 * The manifest is committed, so a change to the roster reviews as a diff rather
 * than as a rebuilt blob.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbJson } from '../src/units/glb.js';
import {
  manifestHash,
  type UnitAssetEntry,
  type UnitManifest,
  type UnitManifestUnit,
} from '../src/units/manifest.js';
import { validateClipLib, validateUnitDef } from '../src/units/validate.js';
import type { ClipLib, UnitDef } from '../src/units/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNITS_DIR = join(repoRoot, 'assets', 'units');
const MANIFEST = join(UNITS_DIR, 'manifest.json');

/** How far a mesh may sit from its declared target. From the brief's checklist. */
const TRI_TOLERANCE = 0.1;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Forward slashes on every platform, so the hash is not OS-dependent. */
function manifestPath(absolute: string): string {
  return relative(UNITS_DIR, absolute).split(sep).join('/');
}

function findUnitDefs(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findUnitDefs(full));
    else if (name.endsWith('.unitdef.json')) found.push(full);
  }
  return found;
}

/**
 * Triangles in a `.glb`, off the accessors.
 *
 * Read out of the glTF JSON rather than by decoding the mesh: the index
 * accessor's `count` is the number of indices and three of those are a triangle.
 * That is the whole of what the tri-count gate needs, and it means this runs
 * without a binary mesh reader -- which this repo does not have.
 *
 * Null when the file has no indexed primitive to count, which is a fact worth
 * distinguishing from zero.
 */
function triangleCount(gltf: Record<string, unknown>): number | null {
  const meshes = gltf['meshes'];
  const accessors = gltf['accessors'];
  if (!Array.isArray(meshes) || !Array.isArray(accessors)) return null;

  let indices = 0;
  let counted = false;
  for (const mesh of meshes as { primitives?: { indices?: unknown }[] }[]) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.indices;
      if (typeof index !== 'number') continue;
      const count = (accessors as { count?: unknown }[])[index]?.count;
      if (typeof count !== 'number') continue;
      indices += count;
      counted = true;
    }
  }
  return counted ? Math.round(indices / 3) : null;
}

interface Problem {
  readonly unit: string;
  readonly message: string;
}

function main(): void {
  const problems: Problem[] = [];
  const units: UnitManifestUnit[] = [];
  const entries: UnitAssetEntry[] = [];

  const add = (absolute: string, unit: string): UnitAssetEntry | null => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(absolute));
    } catch {
      problems.push({ unit, message: `references ${manifestPath(absolute)}, which is not on disk` });
      return null;
    }
    const found: UnitAssetEntry = { path: manifestPath(absolute), sha256: sha256(bytes), bytes: bytes.length };
    entries.push(found);
    return found;
  };

  for (const unitPath of findUnitDefs(UNITS_DIR)) {
    const unitDir = dirname(unitPath);
    const label = manifestPath(unitPath);

    const parsed = validateUnitDef(JSON.parse(readFileSync(unitPath, 'utf8')) as unknown);
    const unit: UnitDef | null = parsed.value;
    if (!unit) {
      problems.push({ unit: label, message: 'does not validate; run `npm run validate:units` for the detail' });
      continue;
    }

    const own: UnitAssetEntry[] = [];
    const push = (found: UnitAssetEntry | null): void => {
      if (found) own.push(found);
    };

    // The documents themselves are part of what a client is built against: a
    // retuned wind-up changes the game as surely as a changed mesh does.
    push(add(unitPath, label));

    const mesh = join(unitDir, unit.meshRef);
    const meshEntry = add(mesh, label);
    push(meshEntry);

    if (meshEntry) {
      const triangles = triangleCount(readGlbJson(new Uint8Array(readFileSync(mesh))));
      const target = unit.import.targetTris;
      if (triangles === null) {
        problems.push({ unit: label, message: `${unit.meshRef} has no indexed geometry to count` });
      } else if (Math.abs(triangles - target) > target * TRI_TOLERANCE) {
        // From the brief's checklist. Decimation is not implemented, so today
        // this is a gate rather than a step: it refuses a mesh that is not the
        // size it says it is, instead of quietly shipping one.
        problems.push({
          unit: label,
          message:
            `${unit.meshRef} has ${triangles} triangles, outside ${Math.round(TRI_TOLERANCE * 100)}% of the declared ` +
            `target of ${target}. Either regenerate at that face limit or correct import.targetTris to what it is.`,
        });
      }
    }

    const clipLibPath = resolve(unitDir, unit.clipLibRef);
    push(add(clipLibPath, label));
    const clipLib: ClipLib | null = (() => {
      try {
        return validateClipLib(JSON.parse(readFileSync(clipLibPath, 'utf8')) as unknown).value;
      } catch {
        return null;
      }
    })();
    if (clipLib) {
      for (const clip of clipLib.clips) push(add(resolve(dirname(clipLibPath), clip.source), label));
    }

    units.push({ id: unit.id, family: unit.skeletonRef.replace(/\.skeleton\.json$/, ''), entries: own });
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem.unit}: ${problem.message}`);
    console.error(`\n${problems.length} problem(s); no manifest written.`);
    process.exitCode = 1;
    return;
  }

  const manifest: UnitManifest = {
    formatVersion: 1,
    hash: manifestHash(entries, hashText),
    // Honest and currently empty. See the header.
    builtStages: [],
    units,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const unit of units) console.log(`ok    ${unit.id} (${unit.family}) · ${unit.entries.length} file(s)`);
  console.log(`\n${units.length} unit(s), ${entries.length} file(s), manifest ${manifest.hash.slice(0, 12)}`);
  if (manifest.builtStages.length === 0) {
    console.log('no mesh stages ran: decimation, meshopt and KTX2 need a dependency that has not been chosen.');
  }
}

main();
