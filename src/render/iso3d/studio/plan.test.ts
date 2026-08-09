import { describe, expect, it } from 'vitest';
import {
  CLIP_INTENTS,
  defaultClipIntents,
  establishedFamilies,
  establishesRigFamily,
  isValidUnitId,
  unitIdProblem,
  type JobSummary,
} from './plan.js';
import { RETARGET_BATCH_SIZE } from '../../../server/studio/pricing.js';
import { BIPED_ANIMATION_PRESETS } from '../../../server/studio/tripo.js';

function job(patch: Partial<JobSummary> = {}): JobSummary {
  return { id: 'j', skeletonId: 'biped', status: 'succeeded', establishesRigFamily: true, ...patch };
}

describe('establishesRigFamily', () => {
  it('is true for the first unit of a family', () => {
    expect(establishesRigFamily([], 'biped')).toBe(true);
  });

  it('is false once a job has established the family', () => {
    // The shared-skeleton rule: one clip set serves N units, and this is what
    // makes the second unit unable to buy a second one even if asked to.
    expect(establishesRigFamily([job()], 'biped')).toBe(false);
  });

  it('is per family, so a new rig family still establishes', () => {
    expect(establishesRigFamily([job({ skeletonId: 'biped' })], 'quadruped')).toBe(true);
  });

  it('is not established by a job that did not succeed', () => {
    // A failed job's clips may be half-downloaded or absent; treating it as the
    // family's library would point every later unit at nothing.
    for (const status of ['failed', 'cancelled', 'blocked', 'running', 'queued']) {
      expect(establishesRigFamily([job({ status })], 'biped'), status).toBe(true);
    }
  });

  it('is not established by a succeeded job that reused a family', () => {
    expect(establishesRigFamily([job({ establishesRigFamily: false })], 'biped')).toBe(true);
  });
});

describe('establishedFamilies', () => {
  it('lists the families that have clips, once each and sorted', () => {
    const jobs = [
      job({ skeletonId: 'biped' }),
      job({ skeletonId: 'biped' }),
      job({ skeletonId: 'avian' }),
      job({ skeletonId: 'quadruped', status: 'failed' }),
    ];
    expect(establishedFamilies(jobs)).toEqual(['avian', 'biped']);
  });
});

describe('clip intents', () => {
  it('keeps the default set small, because every clip is a paid call', () => {
    // The API takes one preset per call, so the tick boxes are the bill. Three
    // is the smallest set a unit needs to read as alive and to fight; anything
    // more is opted into deliberately.
    expect(RETARGET_BATCH_SIZE).toBe(1);
    expect(defaultClipIntents().length).toBeGreaterThan(0);
    expect(defaultClipIntents().length).toBeLessThanOrEqual(3);
  });

  it('defaults to the clips a unit cannot do without', () => {
    // Catalogue order, not sorted -- the cache key is what canonicalises.
    expect(defaultClipIntents()).toEqual(['idle', 'walk', 'slash']);
  });

  it('offers exactly the presets a biped has, and no invented ones', () => {
    // The list is duplicated rather than imported, because this file is bundled
    // into the browser and the server's copy sits next to the API key's client.
    // This is what stops the copy drifting: a preset added on the server that
    // never reaches the tick boxes cannot be asked for, and a tick box with no
    // preset behind it is a paid call that buys nothing.
    expect(CLIP_INTENTS.map((intent) => intent.id)).toEqual([...BIPED_ANIMATION_PRESETS]);
  });

  it('has no attack and no death, whatever a game programmer would reach for', () => {
    // The two names most likely to be re-added by hand. `slash` is the swing and
    // `fall` is a fall -- aliasing `fall` to a death would put a stumble on a
    // corpse, so neither alias exists.
    const ids = CLIP_INTENTS.map((intent) => intent.id);
    expect(ids).not.toContain('attack');
    expect(ids).not.toContain('death');
    expect(ids).toContain('slash');
  });

  it('has unique ids', () => {
    const ids = CLIP_INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every default in the catalogue', () => {
    for (const id of defaultClipIntents()) {
      expect(CLIP_INTENTS.some((intent) => intent.id === id)).toBe(true);
    }
  });
});

describe('unit ids', () => {
  it('accepts what the spec 107 schemas accept', () => {
    // Matched to the schema's identifier pattern, so a name that passes here
    // cannot be rejected by the validator after it has been paid for.
    for (const id of ['grunt', 'archer2', 'boss.phase-1', 'a_b']) expect(isValidUnitId(id), id).toBe(true);
  });

  it('rejects what the schemas reject', () => {
    for (const id of ['', '2fast', 'has space', 'slash/es', 'emoji😀']) expect(isValidUnitId(id), id).toBe(false);
  });

  it('explains the problem rather than just refusing', () => {
    expect(unitIdProblem('', [])).toContain('needs an id');
    expect(unitIdProblem('2fast', [])).toContain('starting with a letter');
    expect(unitIdProblem('grunt', ['grunt'])).toContain('already');
    expect(unitIdProblem('grunt', ['archer'])).toBeNull();
  });
});
