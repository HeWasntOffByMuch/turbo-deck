import { describe, expect, it } from 'vitest';
import {
  beginStep,
  blockJob,
  cacheHit,
  cancelJob,
  completeStep,
  createJob,
  failJob,
  isTerminal,
  nextStage,
  recordTaskId,
  resumable,
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
    current = completeStep(beginStep(current, stage, 0), stage, { creditsConsumed: 1 }, 0);
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
    const partway = completeStep(beginStep(job(), 'imageToModel', 0), 'imageToModel', { creditsConsumed: 20 }, 0);
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

  it('accumulates credits across steps', () => {
    let current = job();
    for (const stage of ['imageToModel', 'rigCheck', 'rig'] as const) {
      current = completeStep(beginStep(current, stage, 0), stage, { creditsConsumed: 7 }, 0);
    }
    expect(current.creditsSpent).toBe(21);
  });

  it('merges artifacts rather than replacing them', () => {
    let current = completeStep(job(), 'imageToModel', { creditsConsumed: 0, artifacts: { meshGlb: '/m.glb' } }, 0);
    current = completeStep(current, 'rig', { creditsConsumed: 0, artifacts: { riggedGlb: '/r.glb' } }, 0);
    current = completeStep(current, 'retarget', { creditsConsumed: 0, artifacts: { clipGlbs: { idle: '/c.glb' } } }, 0);
    expect(current.artifacts).toEqual({ meshGlb: '/m.glb', riggedGlb: '/r.glb', clipGlbs: { idle: '/c.glb' } });
  });

  it('succeeds only when there is no stage left', () => {
    const partway = completeStep(job(), 'imageToModel', { creditsConsumed: 1 }, 0);
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
