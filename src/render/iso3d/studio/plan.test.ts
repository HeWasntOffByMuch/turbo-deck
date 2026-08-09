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
  it('has a default set that costs exactly one retarget call', () => {
    // Five per call is what the API batches at, and the default set is chosen to
    // land on one call rather than one-and-a-bit.
    expect(defaultClipIntents().length).toBeLessThanOrEqual(RETARGET_BATCH_SIZE);
    expect(defaultClipIntents().length).toBeGreaterThan(0);
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
