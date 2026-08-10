/**
 * The parts that decide whether to spend (spec 108): the cache key, the price
 * projection, the ledger, the ceilings, the one-shot confirmation and the pacer.
 *
 * All pure, all driven from an injected clock. These are the tests that have to
 * be right, because the failure mode of the code they cover is a bill.
 */

import { describe, expect, it } from 'vitest';
import { cacheKey, canonicalClipIntents, PIPELINE_REVISION } from './cache.js';
import { ConfirmationStore, DEFAULT_CONFIRMATION_TTL_MS } from './confirm.js';
import { checkCeilings, dayKeyOf, dayTotal, runTotal, summarize, type Ceilings, type LedgerEntry } from './ledger.js';
import { DEFAULT_MIN_INTERVAL_MS, Pacer } from './pacing.js';
import { createJob, beginStep, completeStep, failJob, recordArtifacts } from './jobs.js';
import { DEFAULT_PRICES, projectCost, projectRemaining, retargetCalls, RETARGET_BATCH_SIZE } from './pricing.js';
import {
  BIPED_ANIMATION_PRESETS,
  CREATURE_RIG_MODEL,
  HUMANOID_RIG_MODEL,
  knownPresetsFor,
  presetFor,
  unknownPresets,
} from './tripo.js';
import type { GenerationParams } from './types.js';

function params(patch: Partial<GenerationParams> = {}): GenerationParams {
  return {
    modelVersion: 'P1-20260311',
    faceLimit: 8000,
    texture: true,
    pbr: false,
    orientation: 'default',
    rigSpec: 'mixamo',
    rigModelVersion: 'rig-v-test',
    clipIntents: ['idle', 'run', 'swing'],
    outFormat: 'glb',
    ...patch,
  };
}

const HASH = 'a'.repeat(64);

function entry(patch: Partial<LedgerEntry> = {}): LedgerEntry {
  return { jobId: 'job-1', stage: 'imageToModel', taskId: 't1', credits: 10, reported: true, atMs: 0, ...patch };
}

// --- cache key ---------------------------------------------------------------

describe('cacheKey', () => {
  it('is stable for the same request', () => {
    expect(cacheKey(HASH, params())).toBe(cacheKey(HASH, params()));
  });

  it('ignores the order clips were asked for', () => {
    // The same clips in a different order produce the same output, and must not
    // produce two bills.
    expect(cacheKey(HASH, params({ clipIntents: ['run', 'idle', 'swing'] }))).toBe(cacheKey(HASH, params()));
  });

  it('ignores a repeated clip', () => {
    expect(cacheKey(HASH, params({ clipIntents: ['idle', 'idle', 'run', 'swing'] }))).toBe(cacheKey(HASH, params()));
  });

  it('changes when anything that changes the output changes', () => {
    const base = cacheKey(HASH, params());
    expect(cacheKey('b'.repeat(64), params())).not.toBe(base);
    expect(cacheKey(HASH, params({ faceLimit: 4000 }))).not.toBe(base);
    expect(cacheKey(HASH, params({ modelVersion: 'P1-other' }))).not.toBe(base);
    expect(cacheKey(HASH, params({ texture: false }))).not.toBe(base);
    expect(cacheKey(HASH, params({ pbr: true }))).not.toBe(base);
    expect(cacheKey(HASH, params({ clipIntents: ['idle'] }))).not.toBe(base);
    // Orientation changes which way the mesh faces, so it changes the bytes --
    // and a cache that ignored it would hand back a model made the other way.
    expect(cacheKey(HASH, params({ orientation: 'align_image' }))).not.toBe(base);
    // The rig spec decides what the skeleton is *called* and how many bones it
    // has, so it changes every artifact after the mesh. Left out, changing
    // `TRIPO_RIG_SPEC` and regenerating served the old job back as a free cache
    // hit -- answering the one experiment the setting exists for with the
    // artifacts it was meant to replace.
    expect(cacheKey(HASH, params({ rigSpec: 'tripo' }))).not.toBe(base);
    expect(cacheKey(HASH, params({ rigModelVersion: 'rig-v-other' }))).not.toBe(base);
  });

  it('carries the pipeline revision, so a fix on our side is not answered from the cache', () => {
    // The one thing the parameters cannot describe: a change to what the client
    // sends. Adding `rig_type` changed every rig that comes back without
    // changing any request a caller makes, so the key has to move too or the
    // first regeneration after the fix is served the artifacts it was meant to
    // replace -- free, and looking exactly like the fix not working.
    expect(cacheKey(HASH, params())).toContain(`pipeline=${PIPELINE_REVISION}`);
  });

  it('is readable, so a cache miss can be diagnosed by eye', () => {
    // The whole reason it is not a hash of a hash.
    expect(cacheKey(HASH, params())).toContain('faces=8000');
    expect(cacheKey(HASH, params())).toContain('clips=idle,run,swing');
  });

  it('sorts and de-duplicates intents', () => {
    expect(canonicalClipIntents(['run', 'idle', 'run'])).toEqual(['idle', 'run']);
  });
});

// --- pricing -----------------------------------------------------------------

describe('projectCost', () => {
  it('is one retarget call per clip', () => {
    // Was five-per-call, from the brief's v2-era batching. The live API rejects
    // a multi-preset batch, and pricing a clip set at a fifth of its cost is the
    // direction of error that makes a ceiling decorative.
    expect(RETARGET_BATCH_SIZE).toBe(1);
    expect(retargetCalls(0)).toBe(0);
    expect(retargetCalls(1)).toBe(1);
    expect(retargetCalls(5)).toBe(5);
    expect(retargetCalls(9)).toBe(9);
  });

  it('prices the whole plan for a unit establishing a rig family', () => {
    // Three clips is three retarget calls.
    const projection = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    expect(projection.totalCredits).toBe(
      DEFAULT_PRICES.imageToModel + DEFAULT_PRICES.rigCheck + DEFAULT_PRICES.rig + 3 * DEFAULT_PRICES.retargetPerCall,
    );
  });

  it('scales the retarget cost with the clip count', () => {
    const one = projectCost({ params: params({ clipIntents: ['idle'] }), establishesRigFamily: true, prices: DEFAULT_PRICES });
    const five = projectCost({
      params: params({ clipIntents: ['idle', 'walk', 'run', 'attack', 'hit'] }),
      establishesRigFamily: true,
      prices: DEFAULT_PRICES,
    });
    expect(five.totalCredits - one.totalCredits).toBe(4 * DEFAULT_PRICES.retargetPerCall);
  });

  it('charges nothing for retargeting a unit that reuses a rig family', () => {
    // The shared-skeleton rule, in the price: one clip set serves N units.
    const reusing = projectCost({ params: params(), establishesRigFamily: false, prices: DEFAULT_PRICES });
    const establishing = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    expect(reusing.steps.find((step) => step.stage === 'retarget')?.credits).toBe(0);
    expect(reusing.totalCredits).toBeLessThan(establishing.totalCredits);
  });

  it('prices rig-check at zero, because it is free', () => {
    const projection = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    expect(projection.steps.find((step) => step.stage === 'rigCheck')?.credits).toBe(0);
  });

  it('lists every stage the pipeline has, so the UI rows match', () => {
    const projection = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    expect(projection.steps.map((step) => step.stage)).toEqual([
      'imageToModel',
      'rigCheck',
      'rig',
      'retarget',
      'download',
    ]);
  });

  it('never projects zero for a real generation', () => {
    // A free-looking estimate would sail through every ceiling and tell the user
    // a paid thing costs nothing -- the one wrong answer this must not give.
    const projection = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    expect(projection.totalCredits).toBeGreaterThan(0);
  });
});

describe('projectRemaining', () => {
  /** A job with `done` stages up to and including `through`; null for a fresh one. */
  function partway(
    through: 'imageToModel' | 'rigCheck' | 'rig' | null,
    clips: readonly string[] = ['idle', 'run', 'swing'],
  ) {
    const stages = ['imageToModel', 'rigCheck', 'rig'] as const;
    let current = createJob(
      {
        id: 'job-1',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: clips }),
      },
      0,
    );
    if (through === null) return current;
    for (const stage of stages) {
      current = completeStep(beginStep(current, stage, 0), stage, {}, 0);
      if (stage === through) break;
    }
    return current;
  }

  it('prices only what is left, not the whole job', () => {
    // The failure this exists for: a retarget that died after the rig. Quoting
    // the full price would ask somebody to approve three times what carrying on
    // costs, and an overstated dialog gets dismissed unread just as fast as an
    // understated one.
    const job = failJob(partway('rig'), 'retarget', 'preset unavailable', 0);
    expect(projectRemaining(job, DEFAULT_PRICES).totalCredits).toBe(3 * DEFAULT_PRICES.retargetPerCall);
  });

  it('charges nothing for a stage already done', () => {
    const steps = projectRemaining(failJob(partway('rig'), 'retarget', 'boom', 0), DEFAULT_PRICES).steps;
    for (const stage of ['imageToModel', 'rigCheck', 'rig'] as const) {
      expect(steps.find((step) => step.stage === stage)?.credits, stage).toBe(0);
    }
  });

  it('lists the paid-for stages rather than dropping them', () => {
    // "The rig costs nothing this time" is the fact that makes the smaller total
    // believable; a quote that simply omits it looks like a different job.
    const steps = projectRemaining(failJob(partway('rig'), 'retarget', 'boom', 0), DEFAULT_PRICES).steps;
    expect(steps.map((step) => step.stage)).toEqual(projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES }).steps.map((step) => step.stage));
  });

  it('does not re-buy a clip that is already on disk', () => {
    // The same arithmetic `runRetarget` does when it decides what to skip, so
    // the quote and the spend cannot disagree.
    const withClips = recordArtifacts(partway('rig'), { clipGlbs: { idle: '/i.glb', run: '/r.glb' } }, 0);
    const job = failJob(withClips, 'retarget', 'boom', 0);
    expect(projectRemaining(job, DEFAULT_PRICES).totalCredits).toBe(DEFAULT_PRICES.retargetPerCall);
  });

  it('prices a stage that failed in full, because it will be attempted again', () => {
    const job = failJob(partway('rigCheck'), 'rig', 'internal error', 0);
    const remaining = projectRemaining(job, DEFAULT_PRICES);
    expect(remaining.steps.find((step) => step.stage === 'rig')?.credits).toBe(DEFAULT_PRICES.rig);
    expect(remaining.totalCredits).toBe(DEFAULT_PRICES.rig + 3 * DEFAULT_PRICES.retargetPerCall);
  });

  it('is the whole price for a job that failed on its first call', () => {
    const job = failJob(beginStep(partway(null), 'imageToModel', 0), 'imageToModel', 'boom', 0);
    const fresh = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
    // Nothing reached `done`, so nothing is free -- a retry here costs the lot.
    expect(projectRemaining(job, DEFAULT_PRICES).totalCredits).toBe(fresh.totalCredits);
  });
});

// --- the ledger and the ceilings ---------------------------------------------

describe('dayKeyOf', () => {
  it('agrees with the platform date for a spread of instants', () => {
    // The arithmetic version exists to keep the `Date` global out of a module in
    // the deterministic core; this is what proves it did not change the answer.
    for (const iso of [
      '1970-01-01T00:00:00Z',
      '1999-12-31T23:59:59Z',
      '2000-01-01T00:00:00Z',
      '2000-02-29T12:00:00Z',
      '2024-02-29T23:59:59Z',
      '2026-08-09T09:00:00Z',
      '2100-03-01T00:00:00Z',
      '2400-02-29T06:00:00Z',
    ]) {
      const ms = Date.parse(iso);
      expect(dayKeyOf(ms), iso).toBe(new Date(ms).toISOString().slice(0, 10));
    }
  });

  it('handles instants before the epoch', () => {
    const ms = Date.parse('1969-07-20T20:17:00Z');
    expect(dayKeyOf(ms)).toBe('1969-07-20');
  });

  it('puts one millisecond before midnight on the earlier day', () => {
    const midnight = Date.parse('2026-08-09T00:00:00Z');
    expect(dayKeyOf(midnight - 1)).toBe('2026-08-08');
    expect(dayKeyOf(midnight)).toBe('2026-08-09');
  });
});

describe('totals', () => {
  it('sum per job and per UTC day', () => {
    const day = Date.parse('2026-08-09T12:00:00Z');
    const entries = [
      entry({ jobId: 'a', credits: 10, atMs: day }),
      entry({ jobId: 'a', credits: 5, atMs: day }),
      entry({ jobId: 'b', credits: 7, atMs: day }),
      entry({ jobId: 'a', credits: 100, atMs: day - 86_400_000 }),
    ];
    expect(runTotal(entries, 'a')).toBe(115);
    expect(runTotal(entries, 'b')).toBe(7);
    expect(dayTotal(entries, '2026-08-09')).toBe(22);
    expect(dayTotal(entries, '2026-08-08')).toBe(100);
  });

  it('count calls the API never priced, so a total can say it is a lower bound', () => {
    const summary = summarize([entry(), entry({ credits: 0, reported: false })], 0, {
      perRun: null,
      perDay: null,
    });
    expect(summary.unreportedCalls).toBe(1);
    expect(summary.total).toBe(10);
  });
});

describe('checkCeilings', () => {
  const ceilings: Ceilings = { perRun: 50, perDay: 100 };
  const now = Date.parse('2026-08-09T12:00:00Z');

  it('passes when there is room', () => {
    expect(checkCeilings({ entries: [], jobId: 'a', projectedCredits: 20, nowMs: now, ceilings }).ok).toBe(true);
  });

  it('counts what the run has already spent, not just the next call', () => {
    // Otherwise a job creeps past its own ceiling one cheap call at a time.
    const entries = [entry({ jobId: 'a', credits: 40, atMs: now })];
    const verdict = checkCeilings({ entries, jobId: 'a', projectedCredits: 20, nowMs: now, ceilings });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.ceiling).toBe('perRun');
  });

  it('blocks on the day ceiling even when the run alone would fit', () => {
    const entries = [
      entry({ jobId: 'old-1', credits: 45, atMs: now }),
      entry({ jobId: 'old-2', credits: 45, atMs: now }),
    ];
    const verdict = checkCeilings({ entries, jobId: 'new', projectedCredits: 20, nowMs: now, ceilings });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.ceiling).toBe('perDay');
  });

  it('ignores yesterday when checking the day ceiling', () => {
    const entries = [entry({ jobId: 'old', credits: 95, atMs: now - 86_400_000 })];
    expect(checkCeilings({ entries, jobId: 'new', projectedCredits: 20, nowMs: now, ceilings }).ok).toBe(true);
  });

  it('lets a ceiling set to exactly the price buy the thing once', () => {
    const exact: Ceilings = { perRun: 20, perDay: 20 };
    expect(checkCeilings({ entries: [], jobId: 'a', projectedCredits: 20, nowMs: now, ceilings: exact }).ok).toBe(
      true,
    );
    expect(checkCeilings({ entries: [], jobId: 'a', projectedCredits: 21, nowMs: now, ceilings: exact }).ok).toBe(
      false,
    );
  });

  it('treats a null ceiling as no ceiling', () => {
    const entries = [entry({ jobId: 'a', credits: 1e6, atMs: now })];
    expect(
      checkCeilings({ entries, jobId: 'a', projectedCredits: 1e6, nowMs: now, ceilings: { perRun: null, perDay: null } })
        .ok,
    ).toBe(true);
  });

  it('says which ceiling and by how much, because the operator has to decide', () => {
    const verdict = checkCeilings({ entries: [], jobId: 'a', projectedCredits: 500, nowMs: now, ceilings });
    expect(verdict.ok === false && verdict.reason).toContain('50');
  });
});

// --- confirmation ------------------------------------------------------------

describe('ConfirmationStore', () => {
  const projection = projectCost({ params: params(), establishesRigFamily: true, prices: DEFAULT_PRICES });
  const key = cacheKey(HASH, params());

  it('redeems a token exactly once', () => {
    // The double-submitted form: the second attempt finds nothing to redeem.
    const store = new ConfirmationStore();
    store.issue('tok', projection, key, 0);
    expect(store.redeem('tok', key, 0).ok).toBe(true);
    expect(store.redeem('tok', key, 0).ok).toBe(false);
  });

  it('refuses a token it never issued', () => {
    expect(new ConfirmationStore().redeem('invented', key, 0).ok).toBe(false);
  });

  it('refuses an expired token, and consumes it anyway', () => {
    const store = new ConfirmationStore(1000);
    store.issue('tok', projection, key, 0);
    expect(store.redeem('tok', key, 1000).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('refuses a token quoted for a different request', () => {
    // Otherwise an estimate for a cheap job confirms an expensive one.
    const store = new ConfirmationStore();
    store.issue('tok', projection, key, 0);
    const other = cacheKey(HASH, params({ faceLimit: 100_000 }));
    const result = store.redeem('tok', other, 0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('different request');
  });

  it('carries the projection the user was shown', () => {
    const store = new ConfirmationStore();
    store.issue('tok', projection, key, 0);
    const result = store.redeem('tok', key, 0);
    expect(result.ok && result.confirmation.projection.totalCredits).toBe(projection.totalCredits);
  });

  it('sweeps expired tokens and leaves live ones', () => {
    const store = new ConfirmationStore(1000);
    store.issue('old', projection, key, 0);
    store.issue('new', projection, key, 900);
    expect(store.sweep(1500)).toBe(1);
    expect(store.size).toBe(1);
  });

  it('gives a person time to read a dialog', () => {
    expect(DEFAULT_CONFIRMATION_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

// --- pacing ------------------------------------------------------------------

describe('Pacer', () => {
  it('lets the first request go immediately', () => {
    expect(new Pacer(1000).delayFor(0)).toBe(0);
  });

  it('keeps consecutive requests a full interval apart', () => {
    const pacer = new Pacer(1000);
    expect(pacer.reserve(0)).toBe(0);
    expect(pacer.reserve(0)).toBe(1000);
    expect(pacer.reserve(0)).toBe(2000);
  });

  it('queues callers that all check the gate in the same millisecond', () => {
    // Two jobs polling independently is the case this exists for: without the
    // reservation they would both read an open gate and go at once.
    const pacer = new Pacer(1000);
    const delays = [pacer.reserve(0), pacer.reserve(0), pacer.reserve(0), pacer.reserve(0)];
    expect(delays).toEqual([0, 1000, 2000, 3000]);
  });

  it('does not make a caller wait when enough time has already passed', () => {
    const pacer = new Pacer(1000);
    pacer.reserve(0);
    expect(pacer.reserve(5000)).toBe(0);
  });

  it('stays under one request per second by default', () => {
    expect(DEFAULT_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('the animation vocabulary', () => {
  // Not a validation concern but a spending one: retarget is a paid call per
  // clip, so a name the API does not know is charged for and returns nothing.
  it('sends a bare preset name', () => {
    expect(presetFor('walk')).toBe('preset:walk');
  });

  it('knows what a biped has on the creature model, and admits when it does not know', () => {
    expect(knownPresetsFor('biped', CREATURE_RIG_MODEL)).toEqual(BIPED_ANIMATION_PRESETS);
    // Null when the rig check has not run yet: the biped list is the one that
    // has been confirmed for this model.
    expect(knownPresetsFor(null, CREATURE_RIG_MODEL)).toEqual(BIPED_ANIMATION_PRESETS);
    expect(knownPresetsFor('quadruped', CREATURE_RIG_MODEL)).toBeNull();
  });

  it('claims to know nothing about the humanoid model, which has ninety-odd presets', () => {
    // The eleven names are one rig model's biped vocabulary, not "the presets a
    // biped has". Checking an intent against the wrong version's list is the
    // same failure as checking it against a guessed one, and it refuses work
    // that would have succeeded.
    expect(knownPresetsFor('biped', HUMANOID_RIG_MODEL)).toBeNull();
    expect(unknownPresets('biped', HUMANOID_RIG_MODEL, ['cartwheel', 'salute'])).toEqual([]);
  });

  it('names the intents a biped has no preset for', () => {
    // The four a game programmer reaches for first, and none of them exist.
    expect(unknownPresets('biped', CREATURE_RIG_MODEL, ['idle', 'attack', 'death', 'cast', 'hit'])).toEqual([
      'attack',
      'death',
      'cast',
      'hit',
    ]);
    expect(unknownPresets('biped', CREATURE_RIG_MODEL, ['idle', 'walk', 'slash', 'fall', 'hurt'])).toEqual([]);
  });

  it('refuses nothing when the vocabulary is unknown', () => {
    // Refusing against a guessed list would block work that would have
    // succeeded -- the opposite failure, but still a failure.
    expect(unknownPresets('quadruped', CREATURE_RIG_MODEL, ['pounce', 'nonsense'])).toEqual([]);
  });
});
