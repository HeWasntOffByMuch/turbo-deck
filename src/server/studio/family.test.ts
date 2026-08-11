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
import type { Skeleton as SkeletonDoc } from '../../units/types.js';
import { DEFAULT_CANONICAL_HEIGHT } from '../../units/canonical-height.js';
import { writeGlb } from '../../units/glb.js';
import { buildReferenceUnit } from '../../units/reference-unit.js';
import type { Skeleton } from '../../units/types.js';
import { resolveFamilySkeleton } from './family.js';
import { createJob } from './jobs.js';
import type { Job } from './types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANNEQUIN = join(repoRoot, 'assets', 'units', 'dev', 'mannequin.glb');

/**
 * A provisional family document, owned by this file.
 *
 * It used to import `assets/units/biped.skeleton.json`, which was provisional
 * at the time -- and whose entire purpose is to *stop* being provisional the
 * first time a real rig is measured into it. The day that happened these tests
 * started exercising a filled-in document while still calling it provisional,
 * and failed for a reason that had nothing to do with the code under test.
 *
 * A fixture that changes when the thing it describes succeeds is not a fixture.
 * Built from the reference unit instead: mixamo bones, no bind pose.
 */
const provisional: SkeletonDoc = {
  ...buildReferenceUnit(DEFAULT_CANONICAL_HEIGHT).skeleton,
  id: 'biped',
  boneBudget: { min: 15, max: 30 },
  sockets: [
    { id: 'weapon.main', bone: 'mixamorig:RightHand' },
    { id: 'weapon.off', bone: 'mixamorig:LeftHand' },
    { id: 'fx.body', bone: 'mixamorig:Spine2' },
  ],
  bindPose: null,
};

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

  it('widens a provisional bone budget to the rig it measured', () => {
    // The real shape: a generated humanoid rig carries twist bones and arrives
    // with 43, against a provisional budget of 15..30 written around the
    // 25-bone mixamo contract. Keeping the guess made the filled-in document
    // fail its own validator, and export refused the unit for being the shape
    // it actually is -- which reads as "export does nothing".
    const built = buildReferenceUnit(DEFAULT_CANONICAL_HEIGHT);
    // Paired, because a real rig's twists come in twos and the symmetry check
    // reads `L_`/`R_` since spec 120. An unpaired left side here would be
    // testing the budget against a rig that would be refused for asymmetry.
    const extra = Array.from({ length: 18 }, (_, index) => ({
      name: `${index % 2 === 0 ? 'L' : 'R'}_Twist${Math.floor(index / 2)}`,
      parent: 0,
      translation: [0, 0.01 * index, 0] as const,
    }));
    const nodes = [...built.meshGlb.nodes, ...extra];
    const twisty = join(dir, 'twisty.glb');
    writeFileSync(twisty, writeGlb({ ...built.meshGlb, nodes, joints: nodes.map((_, index) => index) }));

    const result = resolveFamilySkeleton({
      job: job({ skeletonId: 'biped', artifacts: { meshGlb: null, riggedGlb: twisty, clipGlbs: {} } }),
      unitsDir: dir,
      skeletonRef: 'biped.skeleton.json',
      canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
    });

    expect(result.problem).toBeNull();
    const written = read('biped.skeleton.json');
    expect(written.bones.length).toBe(nodes.length);
    // Widened to what is there, rather than the guess it contradicts.
    expect(written.boneBudget.max).toBeGreaterThanOrEqual(nodes.length);
    expect(written.boneBudget.min).toBeLessThanOrEqual(nodes.length);
  });

  it('drops the sockets a rig on another naming contract cannot satisfy', () => {
    // The state the pipeline is actually in. `spec: tripo` is what the retarget
    // requires, so every rig now comes back named `tripo::*` -- and the sockets
    // this provisional document inherited name `mixamorig:` bones that are not
    // in the measured list. Carried through, the document failed its own
    // validator and export refused with five socket errors and no way forward.
    const tripoRig = join(dir, 'tripo-rigged.glb');
    const built = buildReferenceUnit(DEFAULT_CANONICAL_HEIGHT);
    writeFileSync(
      tripoRig,
      writeGlb({
        ...built.meshGlb,
        nodes: built.meshGlb.nodes.map((node, index) => ({ ...node, name: `tripo::J_${index}` })),
      }),
    );

    const result = resolveFamilySkeleton({
      job: job({ skeletonId: 'biped', artifacts: { meshGlb: null, riggedGlb: tripoRig, clipGlbs: {} } }),
      unitsDir: dir,
      skeletonRef: 'biped.skeleton.json',
      canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
    });

    // Exported, not refused.
    expect(result.problem).toBeNull();
    expect(result.wrote).toBe('biped.skeleton.json');
    expect(read('biped.skeleton.json').sockets).toEqual([]);
    // And named, because a unit that cannot hold a weapon is a real loss.
    expect(result.droppedSockets).toHaveLength(provisional.sockets.length);
    expect(result.droppedSockets.join(' ')).toContain('weapon.main');
    expect(result.droppedSockets.join(' ')).toContain('mixamorig:RightHand');
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
