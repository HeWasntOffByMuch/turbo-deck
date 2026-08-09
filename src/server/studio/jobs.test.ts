import { describe, expect, it } from 'vitest';
import {
  beginStep,
  blockJob,
  cacheHit,
  cancelJob,
  clearInFlight,
  completeStep,
  createJob,
  failJob,
  inFlightTask,
  isTerminal,
  markInFlight,
  nextStage,
  recordArtifacts,
  recordCredits,
  recordTaskId,
  resumable,
  retryFailed,
  skipStep,
  stepOf,
} from './jobs.js';
import { STAGES, type GenerationParams, type Job } from './types.js';

const HASH = 'a'.repeat(64);

function params(patch: Partial<GenerationParams> = {}): GenerationParams {
  return {
    modelVersion: 'P1-20260311',
    faceLimit: 8000,
    texture: true,
    pbr: false,
    clipIntents: ['idle', 'run'],
    outFormat: 'glb',
    ...patch,
  };
}

function job(patch: { establishesRigFamily?: boolean } = {}): Job {
  return createJob(
    {
      id: 'job-1',
      unitId: 'grunt',
      skeletonId: 'biped',
      establishesRigFamily: patch.establishesRigFamily ?? true,
      referenceImageSha256: HASH,
      params: params(),
    },
    1000,
  );
}

/** Walks a job to completion, so a test can assert about the sequence it took. */
function runThrough(start: Job): { readonly job: Job; readonly visited: string[] } {
  let current = start;
  const visited: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const stage = nextStage(current);
    if (stage === null) break;
    visited.push(stage);
    current = completeStep(beginStep(current, stage, 0), stage, {}, 0);
  }
  return { job: current, visited };
}

describe('createJob', () => {
  it('starts queued with every stage pending', () => {
    const created = job();
    expect(created.status).toBe('queued');
    expect(created.stage).toBeNull();
    expect(created.steps.map((step) => step.stage)).toEqual([...STAGES]);
    expect(created.steps.every((step) => step.status === 'pending')).toBe(true);
  });

  it('lists the skipped stages too, so the progress UI does not reflow', () => {
    expect(job({ establishesRigFamily: false }).steps).toHaveLength(STAGES.length);
  });

  it('derives its own cache key', () => {
    expect(job().cacheKey).toContain(HASH);
  });
});

describe('nextStage', () => {
  it('walks the documented four calls, then the download', () => {
    expect(runThrough(job()).visited).toEqual(['imageToModel', 'rigCheck', 'rig', 'retarget', 'download']);
  });

  it('never reaches retarget for a unit reusing an established rig family', () => {
    // The central architectural constraint: one clip set serves N units, and a
    // pipeline that retargets per unit is wasted money and inconsistent timing.
    expect(runThrough(job({ establishesRigFamily: false })).visited).not.toContain('retarget');
  });

  it('always visits rig-check, which is free and stops an expensive call', () => {
    expect(runThrough(job()).visited).toContain('rigCheck');
    expect(runThrough(job({ establishesRigFamily: false })).visited).toContain('rigCheck');
  });

  it('is null once a job is terminal, whatever its steps say', () => {
    const failed = failJob(job(), 'rig', 'boom', 0);
    expect(nextStage(failed)).toBeNull();
    expect(nextStage(cancelJob(job(), 0))).toBeNull();
    expect(nextStage(blockJob(job(), 'rigCheck', 'not riggable', 0))).toBeNull();
  });

  it('reads the steps, so a resumed job picks up where it left off', () => {
    // A pure function of the record, not a cursor that could drift out of step
    // with what has actually been done.
    const partway = completeStep(beginStep(job(), 'imageToModel', 0), 'imageToModel', {}, 0);
    const reloaded = JSON.parse(JSON.stringify(partway)) as Job;
    expect(nextStage(reloaded)).toBe('rigCheck');
  });

  it('treats a skipped stage as done', () => {
    const skipped = skipStep(job(), 'retarget', 0);
    const walked = runThrough(skipped);
    expect(walked.visited).not.toContain('retarget');
  });
});

describe('step transitions', () => {
  it('records a task id, so a crash after the submit can still resume', () => {
    const started = recordTaskId(beginStep(job(), 'imageToModel', 10), 'imageToModel', 'task-9', 20);
    expect(stepOf(started, 'imageToModel')?.taskId).toBe('task-9');
  });

  it('accumulates credits as each call reports them, not at completion', () => {
    // Recorded before the download rather than after: the charge is a fact the
    // moment the task succeeds, and a total that under-reads is the one that
    // lets a ceiling be passed.
    let current = job();
    for (const stage of ['imageToModel', 'rigCheck', 'rig'] as const) {
      current = recordCredits(beginStep(current, stage, 0), stage, 7, 0);
      current = completeStep(current, stage, {}, 0);
    }
    expect(current.creditsSpent).toBe(21);
    expect(stepOf(current, 'rig')?.creditsConsumed).toBe(7);
  });

  it('sums several calls within one stage', () => {
    // The retarget is one call per clip; the step has to end up with the total.
    let current = beginStep(job(), 'retarget', 0);
    current = recordCredits(current, 'retarget', 25, 0);
    current = recordCredits(current, 'retarget', 25, 0);
    expect(stepOf(current, 'retarget')?.creditsConsumed).toBe(50);
    expect(current.creditsSpent).toBe(50);
  });

  it('merges artifacts rather than replacing them', () => {
    let current = recordArtifacts(job(), { meshGlb: '/m.glb' }, 0);
    current = recordArtifacts(current, { riggedGlb: '/r.glb' }, 0);
    current = recordArtifacts(current, { clipGlbs: { idle: '/c.glb' } }, 0);
    current = recordArtifacts(current, { clipGlbs: { walk: '/w.glb' } }, 0);
    expect(current.artifacts).toEqual({
      meshGlb: '/m.glb',
      riggedGlb: '/r.glb',
      clipGlbs: { idle: '/c.glb', walk: '/w.glb' },
    });
  });

  it('remembers a submitted task until its result is recorded', () => {
    // A task id is worth money the instant the submit returns, so it goes on
    // disk before anything waits on it and is forgotten only once the charge is
    // recorded and the file is written.
    let current = markInFlight(job(), 'retarget:walk', 'task-9', 0);
    expect(inFlightTask(current, 'retarget:walk')).toBe('task-9');
    expect(inFlightTask(current, 'retarget:idle')).toBeNull();
    current = clearInFlight(current, 'retarget:walk', 0);
    expect(inFlightTask(current, 'retarget:walk')).toBeNull();
  });

  it('survives a round trip through JSON with its in-flight calls intact', () => {
    const current = markInFlight(job(), 'rig', 'task-3', 0);
    const reloaded = JSON.parse(JSON.stringify(current)) as Job;
    expect(inFlightTask(reloaded, 'rig')).toBe('task-3');
  });

  it('reads a job written before the in-flight field existed', () => {
    // Somebody has a jobs.json from an earlier build, and the job in it that
    // they will come back to is the blocked one -- already paid for. Throwing on
    // the way in would strand exactly the case this mechanism exists to save.
    const old = JSON.parse(JSON.stringify(job())) as Record<string, unknown>;
    delete old['inFlight'];
    const legacy = old as unknown as Job;
    expect(inFlightTask(legacy, 'rig')).toBeNull();
    expect(() => clearInFlight(legacy, 'rig', 0)).not.toThrow();
    expect(inFlightTask(markInFlight(legacy, 'rig', 'task-1', 0), 'rig')).toBe('task-1');
  });

  it('succeeds only when there is no stage left', () => {
    const partway = completeStep(job(), 'imageToModel', {}, 0);
    expect(partway.status).toBe('running');
    expect(runThrough(job()).job.status).toBe('succeeded');
  });
});

describe('terminal states', () => {
  it('treats failure as terminal, so nothing can schedule another attempt', () => {
    // The retry-never rule lives here: a failed paid call has no next stage, so
    // no loop anywhere can pick it back up on a timer.
    const failed = failJob(job(), 'rig', 'HTTP 500', 0);
    expect(isTerminal(failed)).toBe(true);
    expect(nextStage(failed)).toBeNull();
    expect(failed.message).toBe('HTTP 500');
  });

  it('keeps blocked separate from failed', () => {
    // Nothing was attempted and nothing was charged; the two want different
    // words in the UI and different next actions from the operator.
    const blocked = blockJob(job(), 'rigCheck', 'not riggable', 0);
    expect(blocked.status).toBe('blocked');
    expect(blocked.status).not.toBe('failed');
    expect(isTerminal(blocked)).toBe(true);
  });

  it('will not cancel a job that has already finished', () => {
    const succeeded = runThrough(job()).job;
    expect(cancelJob(succeeded, 99).status).toBe('succeeded');
  });
});

describe('retryFailed', () => {
  it('rewinds only the stage that failed', () => {
    let current = completeStep(beginStep(job(), 'imageToModel', 0), 'imageToModel', {}, 0);
    current = recordCredits(beginStep(current, 'rig', 0), 'rig', 25, 0);
    const failed = failJob(current, 'rig', 'internal error', 0);

    const retried = retryFailed(failed, 5) as Job;
    expect(retried.status).toBe('queued');
    expect(nextStage(retried)).toBe('rigCheck');
    expect(stepOf(retried, 'imageToModel')?.status).toBe('done');
    expect(stepOf(retried, 'rig')?.status).toBe('pending');
    expect(stepOf(retried, 'rig')?.error).toBeNull();
  });

  it('keeps the credits the failed stage already cost', () => {
    // That money was spent whatever happened next. A total that forgets it is a
    // ceiling that can be walked past by failing over and over.
    const failed = failJob(recordCredits(beginStep(job(), 'rig', 0), 'rig', 25, 0), 'rig', 'boom', 0);
    const retried = retryFailed(failed, 5) as Job;
    expect(retried.creditsSpent).toBe(25);
    expect(stepOf(retried, 'rig')?.creditsConsumed).toBe(25);
  });

  it('drops the failed task id, since it names a task that produced nothing', () => {
    const started = recordTaskId(beginStep(job(), 'rig', 0), 'rig', 'task-9', 0);
    const retried = retryFailed(failJob(started, 'rig', 'boom', 0), 5) as Job;
    expect(stepOf(retried, 'rig')?.taskId).toBeNull();
  });

  it('leaves in-flight calls alone, because re-polling is free and re-buying is not', () => {
    const started = markInFlight(beginStep(job(), 'rig', 0), 'rig', 'task-9', 0);
    const retried = retryFailed(failJob(started, 'rig', 'boom', 0), 5) as Job;
    expect(inFlightTask(retried, 'rig')).toBe('task-9');
  });

  it('is only ever a failed job', () => {
    // Blocked has its own path, and the two mean different things: nothing was
    // charged for a block, so carrying on needs no new confirmation.
    expect(retryFailed(job(), 0)).toBeNull();
    expect(retryFailed(blockJob(job(), 'rigCheck', 'not riggable', 0), 0)).toBeNull();
    expect(retryFailed(runThrough(job()).job, 0)).toBeNull();
    expect(retryFailed(cancelJob(job(), 0), 0)).toBeNull();
  });
});

describe('resumable', () => {
  it('picks up what was mid-flight and leaves what is finished', () => {
    const running = beginStep(job(), 'imageToModel', 0);
    const done = runThrough(job()).job;
    const failed = failJob(job(), 'rig', 'boom', 0);
    const queued = job();
    expect(resumable([running, done, failed, queued]).map((entry) => entry.status)).toEqual(['running', 'queued']);
  });
});

describe('cacheHit', () => {
  it('matches a succeeded job with the same key', () => {
    const done = runThrough(job()).job;
    expect(cacheHit([done], done.cacheKey)?.id).toBe(done.id);
  });

  it('never serves a failed or cancelled job as a hit', () => {
    // Half a job's files may be on disk; handing those back would be worse than
    // spending the credits again.
    const failed = failJob(job(), 'rig', 'boom', 0);
    const cancelled = cancelJob(beginStep(job(), 'rig', 0), 0);
    expect(cacheHit([failed, cancelled], failed.cacheKey)).toBeNull();
  });

  it('misses when any parameter differs', () => {
    const done = runThrough(job()).job;
    const other = createJob(
      {
        id: 'job-2',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ faceLimit: 4000 }),
      },
      0,
    );
    expect(cacheHit([done], other.cacheKey)).toBeNull();
  });
});
