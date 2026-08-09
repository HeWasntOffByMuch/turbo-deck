/**
 * The parts that decide whether to spend (spec 108): the cache key, the price
 * projection, the ledger, the ceilings, the one-shot confirmation and the pacer.
 *
 * All pure, all driven from an injected clock. These are the tests that have to
 * be right, because the failure mode of the code they cover is a bill.
 */

import { describe, expect, it } from 'vitest';
import { cacheKey, canonicalClipIntents } from './cache.js';
import { ConfirmationStore, DEFAULT_CONFIRMATION_TTL_MS } from './confirm.js';
import { checkCeilings, dayKeyOf, dayTotal, runTotal, summarize, type Ceilings, type LedgerEntry } from './ledger.js';
import { DEFAULT_MIN_INTERVAL_MS, Pacer } from './pacing.js';
import { DEFAULT_PRICES, projectCost, retargetCalls, RETARGET_BATCH_SIZE } from './pricing.js';
import type { GenerationParams } from './types.js';

function params(patch: Partial<GenerationParams> = {}): GenerationParams {
  return {
    modelVersion: 'P1-20260311',
    faceLimit: 8000,
    texture: true,
    pbr: false,
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
