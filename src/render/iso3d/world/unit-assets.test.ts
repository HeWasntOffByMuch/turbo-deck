/**
 * Every authored unit can actually reach every clip it declares (spec 139).
 *
 * `unit-assets.ts` itself is built on `import.meta.glob`, which is a Vite
 * transform and not something a Node test can stand up honestly. But the bug it
 * had was never about the glob: it was about *which directory a reference is
 * relative to*, and that is a property of the committed documents plus one rule,
 * both of which are readable here.
 *
 * The rule: a `meshRef` and a `skeletonRef` are relative to the unitdef, and a
 * clip's `source` is relative to the **clip library** -- not to the unit. Those
 * are the same folder for exactly as long as every unit owns its clips, which is
 * the arrangement a rig family exists to end. The fox was the first body to join
 * a family, resolved five clips against its own folder, found none of them, and
 * was drawn standing still with the state machine ticking happily above it. No
 * error anywhere: the loader skips a clip it cannot fetch, on purpose, so that a
 * unit missing its run cycle walks everywhere instead of vanishing.
 *
 * So this walks the real manifest and asserts the thing that was silently false.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifestDoc from '../../../../assets/units/manifest.json' with { type: 'json' };
import { loadUnitBundle } from '../../../units/bundle.js';
import type { UnitManifest } from '../../../units/manifest.js';

const UNITS_DIR = resolve(process.cwd(), 'assets', 'units');
const MANIFEST = manifestDoc as unknown as UnitManifest;

const read = (path: string): unknown => JSON.parse(readFileSync(join(UNITS_DIR, path), 'utf8'));

describe('every authored unit in the manifest', () => {
  it('has at least one unit, or this whole file is vacuously green', () => {
    expect(MANIFEST.units.length).toBeGreaterThan(0);
  });

  for (const entry of MANIFEST.units) {
    describe(entry.id, () => {
      const unitPath = entry.entries.find((file) => file.path.endsWith('.unitdef.json'))?.path;
      const clipLibPath = entry.entries.find((file) => file.path.endsWith('.cliplib.json'))?.path;

      it('is listed with both of its documents', () => {
        expect(unitPath).toBeDefined();
        expect(clipLibPath).toBeDefined();
      });

      it('validates as a bundle', () => {
        const bundle = loadUnitBundle(read(unitPath ?? ''), read(clipLibPath ?? ''));
        expect(bundle.value).not.toBeNull();
      });

      it('resolves every clip its library lists, from the library it lists them in', () => {
        const libDir = dirname(clipLibPath ?? '');
        const bundle = loadUnitBundle(read(unitPath ?? ''), read(clipLibPath ?? ''));
        const clips = bundle.value?.clipLib.clips ?? [];
        expect(clips.length).toBeGreaterThan(0);

        const missing = clips
          .map((clip) => join(libDir, clip.source))
          .filter((path) => !existsSync(join(UNITS_DIR, path)));
        expect(missing).toEqual([]);
      });

      it('resolves its mesh and its skeleton, from the unitdef', () => {
        const dir = dirname(unitPath ?? '');
        const bundle = loadUnitBundle(read(unitPath ?? ''), read(clipLibPath ?? ''));
        const unit = bundle.value?.unit;
        expect(unit).toBeDefined();
        expect(existsSync(join(UNITS_DIR, dir, unit?.meshRef ?? ''))).toBe(true);
        // The one that carries a `..` on every member of a family, and so the
        // one that needs a path flattened rather than string-matched.
        expect(existsSync(join(UNITS_DIR, dir, unit?.skeletonRef ?? ''))).toBe(true);
      });

      it('lists every one of those files in the manifest, so the bundle emits them', () => {
        // A clip that resolves on disk but is absent from the manifest is one
        // the build never sees: the roster is the manifest, and a unit whose
        // clips are only in the working tree animates locally and not shipped.
        const libDir = dirname(clipLibPath ?? '');
        const bundle = loadUnitBundle(read(unitPath ?? ''), read(clipLibPath ?? ''));
        const listed = new Set(entry.entries.map((file) => file.path));
        for (const clip of bundle.value?.clipLib.clips ?? []) {
          expect(listed).toContain(join(libDir, clip.source));
        }
      });
    });
  }
});

describe('a unit that borrows another folder’s clip library', () => {
  it('exists, or the case that broke is no longer covered', () => {
    // The regression guard needs a subject. If every unit in the tree keeps its
    // clips beside it again, the tests above pass for the same reason they
    // passed before the fox: nothing is reaching across a directory.
    const borrowing = MANIFEST.units.filter((entry) => {
      const unitPath = entry.entries.find((file) => file.path.endsWith('.unitdef.json'))?.path ?? '';
      const clipLibPath = entry.entries.find((file) => file.path.endsWith('.cliplib.json'))?.path ?? '';
      return dirname(unitPath) !== dirname(clipLibPath);
    });
    expect(borrowing.length).toBeGreaterThan(0);
  });
});
