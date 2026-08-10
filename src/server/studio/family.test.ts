/**
 * Getting a family's skeleton document (spec 115).
 *
 * The three cases are the whole design: no document, a provisional one, and a
 * measured one. Only the last is a contract, and only the last is never
 * rewritten. The rig used throughout is the real committed mannequin, because a
 * fabricated `.glb` would be measured by the same code that wrote it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import provisional from '../../../assets/units/biped.skeleton.json' with { type: 'json' };
import { DEFAULT_CANONICAL_HEIGHT } from '../../units/canonical-height.js';
import type { Skeleton } from '../../units/types.js';
import { resolveFamilySkeleton } from './family.js';
import { createJob } from './jobs.js';
import type { Job } from './types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANNEQUIN = join(repoRoot, 'assets', 'units', 'dev', 'mannequin.glb');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'family-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function job(patch: Partial<Job> = {}): Job {
  const base = createJob(
    {
      id: 'job-1',
      unitId: 'grunt',
      skeletonId: 'biped2',
      establishesRigFamily: true,
      referenceImageSha256: 'a'.repeat(64),
      params: {
        modelVersion: 'P1',
        faceLimit: 8000,
        texture: true,
        pbr: false,
        orientation: 'default',
        rigSpec: 'mixamo',
        rigModelVersion: 'rig-v-test',
        clipIntents: ['idle'],
        outFormat: 'glb',
      },
    },
    0,
  );
  return {
    ...base,
    status: 'succeeded',
    artifacts: { meshGlb: null, riggedGlb: MANNEQUIN, clipGlbs: {} },
    ...patch,
  };
}

function resolve(skeletonRef: string, over: Partial<Job> = {}) {
  return resolveFamilySkeleton({
    job: job(over),
    unitsDir: dir,
    skeletonRef,
    canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
  });
}

function read(name: string): Skeleton {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Skeleton;
}

describe('a family with no document (spec 115)', () => {
  it('measures one off the rig and writes it', () => {
    // This is what made a brand-new family impossible to export: the route
    // looked for a file, did not find one, and refused -- with no way anywhere
    // to produce the file it wanted.
    const result = resolve('biped2.skeleton.json');
    expect(result.problem).toBeNull();
    expect(result.wrote).toBe('biped2.skeleton.json');
    expect(read('biped2.skeleton.json').bindPose).not.toBeNull();
    expect(result.doc?.id).toBe('biped2');
  });

  it('records the canonical height it was given, not the rig own height', () => {
    expect(read2(resolve('biped2.skeleton.json')).canonicalHeight).toBe(DEFAULT_CANONICAL_HEIGHT);
  });

  it('measures the import scale off the same rig, so the unit is not the size of a coin', () => {
    // A generated rig arrives around 1.7 units tall and a body in this world is
    // 55.65, so the factor is around thirty. The export used to write 1.
    const scale = resolve('biped2.skeleton.json').importScale ?? 0;
    expect(scale).toBeGreaterThan(25);
    expect(scale).toBeLessThan(40);
    // Against the mannequin's own committed scale, within the tolerance
    // `scripts/preview-library.ts` holds the browser's `fitToHeight` to. The two
    // measure the same thing off the same mesh and must not disagree by enough
    // to see: the export writes this number and the preview shows that one.
    expect(Math.abs(scale - 32.35)).toBeLessThan(0.5);
  });

  it('refuses when there is no rig to measure, and says what to do', () => {
    const result = resolve('biped2.skeleton.json', {
      artifacts: { meshGlb: null, riggedGlb: null, clipGlbs: {} },
    });
    expect(result.doc).toBeNull();
    expect(result.problem).toContain('no rigged .glb');
  });
});

describe('a provisional document (spec 115)', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'biped.skeleton.json'), JSON.stringify(provisional, null, 2));
  });

  it('is filled in from the measured rig', () => {
    const result = resolveFamilySkeleton({
      job: job({ skeletonId: 'biped' }),
      unitsDir: dir,
      skeletonRef: 'biped.skeleton.json',
      canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
    });
    expect(result.wrote).toBe('biped.skeleton.json');
    expect(read('biped.skeleton.json').bindPose?.bones.length).toBe(25);
  });

  it('keeps every decision already written down', () => {
    // A provisional document is a decision missing a measurement. Replacing its
    // sockets or its comment with derived ones would throw away the part a
    // person actually authored.
    resolveFamilySkeleton({
      job: job({ skeletonId: 'biped' }),
      unitsDir: dir,
      skeletonRef: 'biped.skeleton.json',
      canonicalHeight: 999,
    });
    const filled = read('biped.skeleton.json');
    expect(filled.sockets).toEqual(provisional.sockets);
    expect(filled.boneBudget).toEqual(provisional.boneBudget);
    expect(filled.canonicalHeight).toBe(provisional.canonicalHeight);
    expect(filled.$comment).toBe(provisional.$comment);
  });
});

describe('a measured document (spec 115)', () => {
  function establish(): Skeleton {
    resolve('biped2.skeleton.json');
    return read('biped2.skeleton.json');
  }

  it('is never rewritten', () => {
    const first = establish();
    const again = resolve('biped2.skeleton.json');
    expect(again.wrote).toBeNull();
    expect(again.doc?.bones).toEqual(first.bones);
  });

  it('refuses a rig that is not the family, because the clips are shared', () => {
    // The point of a family is one clip library over many units. A second unit
    // with a different bone list is not a variation -- it is a clip set about to
    // drive bones that are not there.
    // A leaf bone renamed on the *family* side, so the family stays a valid
    // document and the rig is the thing that no longer matches it.
    const established = establish();
    const rename = (name: string): string => (name === 'mixamorig:HeadTop_End' ? 'mixamorig:HeadCrest' : name);
    writeFileSync(
      join(dir, 'biped2.skeleton.json'),
      JSON.stringify(
        {
          ...established,
          bones: established.bones.map((bone) => ({ ...bone, name: rename(bone.name) })),
          bindPose: established.bindPose && {
            ...established.bindPose,
            bones: established.bindPose.bones.map((bone) => ({ ...bone, name: rename(bone.name) })),
          },
        },
        null,
        2,
      ),
    );
    const result = resolve('biped2.skeleton.json');
    expect(result.doc).toBeNull();
    expect(result.problem).toContain('does not match');
  });

  it('refuses a document that does not validate rather than exporting past it', () => {
    writeFileSync(join(dir, 'broken.skeleton.json'), JSON.stringify({ formatVersion: 1 }));
    const result = resolve('broken.skeleton.json');
    expect(result.doc).toBeNull();
    expect(result.problem).toContain('does not validate');
  });
});

/** The document a resolve wrote, read back. */
function read2(result: { wrote: string | null }): Skeleton {
  if (result.wrote === null) throw new Error('nothing was written');
  return read(result.wrote);
}
