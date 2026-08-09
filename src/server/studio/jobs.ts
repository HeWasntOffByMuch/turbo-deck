/**
 * A job's lifecycle, as pure transitions (spec 108).
 *
 * Every function here takes a job and returns a new one. Nothing reads a clock,
 * a socket or a file -- the time arrives as `nowMs` and the task id arrives from
 * whoever made the call. That is what lets the sequence that spends money be
 * driven end to end in a test, including the paths that only happen when
 * something goes wrong, which are the ones nobody can afford to exercise for
 * real.
 *
 * The sequence itself lives in {@link nextStage}, and it encodes the one
 * architectural rule this whole pipeline exists to protect: **the clip library
 * is retargeted onto the canonical skeleton once, and every later unit of the
 * family reuses it.** A job that is not establishing a rig family skips
 * retargeting entirely. If that stops being true the cost per unit roughly
 * doubles and the roster's timing quietly stops agreeing with itself.
 */

import { cacheKey } from './cache.js';
import { isTerminal, STAGES, type GenerationParams, type Job, type Stage, type StepRecord } from './types.js';

export interface CreateJobInput {
  readonly id: string;
  readonly unitId: string;
  readonly skeletonId: string;
  readonly establishesRigFamily: boolean;
  readonly referenceImageSha256: string;
  readonly params: GenerationParams;
}

function pendingStep(stage: Stage): StepRecord {
  return {
    stage,
    taskId: null,
    status: 'pending',
    creditsConsumed: 0,
    startedAtMs: null,
    finishedAtMs: null,
    error: null,
  };
}

export function createJob(input: CreateJobInput, nowMs: number): Job {
  return {
    id: input.id,
    unitId: input.unitId,
    skeletonId: input.skeletonId,
    establishesRigFamily: input.establishesRigFamily,
    cacheKey: cacheKey(input.referenceImageSha256, input.params),
    rigType: null,
    referenceImageSha256: input.referenceImageSha256,
    params: input.params,
    status: 'queued',
    stage: null,
    // Every stage is listed from the start, including the ones that will be
    // skipped, so the progress UI has a fixed set of rows to fill in rather than
    // a list that grows and reflows as the job runs.
    //
    // A unit reusing an established rig family is marked `skipped` here rather
    // than left `pending`, because whether it retargets is known the moment the
    // job is created. Left pending it would sit at "waiting" forever in the UI,
    // which reads as a stall rather than as the shared-skeleton rule working.
    steps: STAGES.map((stage) =>
      stage === 'retarget' && !input.establishesRigFamily
        ? { ...pendingStep(stage), status: 'skipped' as const }
        : pendingStep(stage),
    ),
    creditsSpent: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    message: null,
    artifacts: { meshGlb: null, riggedGlb: null, clipGlbs: {} },
  };
}

function patchStep(job: Job, stage: Stage, patch: Partial<StepRecord>): readonly StepRecord[] {
  return job.steps.map((step) => (step.stage === stage ? { ...step, ...patch } : step));
}

export function stepOf(job: Job, stage: Stage): StepRecord | null {
  return job.steps.find((step) => step.stage === stage) ?? null;
}

/**
 * Which stage runs next, or null when the job is finished.
 *
 * Reads the step records rather than a cursor, so it is a pure function of the
 * job and cannot drift out of step with what has actually been done -- a
 * resumed job on boot gets the same answer as one that never stopped.
 */
export function nextStage(job: Job): Stage | null {
  if (isTerminal(job)) return null;
  for (const stage of STAGES) {
    // Retargeting is the shared-skeleton rule (spec 108). A unit that reuses an
    // established rig family must never reach it: doing so would buy a second
    // copy of the same clips and produce a roster whose timings differ by unit.
    if (stage === 'retarget' && !job.establishesRigFamily) continue;
    const step = stepOf(job, stage);
    if (!step) continue;
    if (step.status === 'done' || step.status === 'skipped') continue;
    return stage;
  }
  return null;
}

/** Marks a stage as in flight. The task id is null until the submit returns one. */
export function beginStep(job: Job, stage: Stage, nowMs: number): Job {
  return {
    ...job,
    status: 'running',
    stage,
    steps: patchStep(job, stage, { status: 'running', startedAtMs: nowMs }),
    updatedAtMs: nowMs,
  };
}

/** Records the task id the submit returned, so a crash after this can resume it. */
export function recordTaskId(job: Job, stage: Stage, taskId: string, nowMs: number): Job {
  return { ...job, steps: patchStep(job, stage, { taskId }), updatedAtMs: nowMs };
}

export interface StepOutcome {
  /** What the API reported it charged. Never a projection. */
  readonly creditsConsumed: number;
  readonly artifacts?: Partial<Job['artifacts']>;
  /** Set by the rig check; every later call needs it. */
  readonly rigType?: string | null;
}

export function completeStep(job: Job, stage: Stage, outcome: StepOutcome, nowMs: number): Job {
  const artifacts = outcome.artifacts
    ? {
        ...job.artifacts,
        ...outcome.artifacts,
        clipGlbs: { ...job.artifacts.clipGlbs, ...(outcome.artifacts.clipGlbs ?? {}) },
      }
    : job.artifacts;

  const advanced: Job = {
    ...job,
    steps: patchStep(job, stage, {
      status: 'done',
      creditsConsumed: outcome.creditsConsumed,
      finishedAtMs: nowMs,
    }),
    creditsSpent: job.creditsSpent + outcome.creditsConsumed,
    artifacts,
    rigType: outcome.rigType ?? job.rigType,
    updatedAtMs: nowMs,
  };

  const remaining = nextStage(advanced);
  return remaining === null
    ? { ...advanced, status: 'succeeded', stage: null }
    : { ...advanced, status: 'running' };
}

/** Marks a stage as deliberately not run -- the retarget a reusing unit skips. */
export function skipStep(job: Job, stage: Stage, nowMs: number): Job {
  return { ...job, steps: patchStep(job, stage, { status: 'skipped', finishedAtMs: nowMs }), updatedAtMs: nowMs };
}

/**
 * A call failed.
 *
 * Terminal, always. Nothing here schedules another attempt and nothing else in
 * the pipeline may: a paid call that failed for a reason we do not understand
 * must not be made again on a timer. Re-running is a new job, priced and
 * confirmed again by a person.
 */
export function failJob(job: Job, stage: Stage, message: string, nowMs: number): Job {
  return {
    ...job,
    status: 'failed',
    stage,
    steps: patchStep(job, stage, { status: 'failed', error: message, finishedAtMs: nowMs }),
    message,
    updatedAtMs: nowMs,
  };
}

/**
 * Stopped before spending: a ceiling, or a rig-check that said no.
 *
 * Separate from {@link failJob} because nothing was attempted and nothing was
 * charged. Collapsing the two would put "you are out of budget" and "the API
 * returned a 500 after taking your credits" under one word.
 */
export function blockJob(job: Job, stage: Stage, message: string, nowMs: number): Job {
  return { ...job, status: 'blocked', stage, message, updatedAtMs: nowMs };
}

export function cancelJob(job: Job, nowMs: number): Job {
  if (isTerminal(job)) return job;
  return { ...job, status: 'cancelled', message: 'cancelled', updatedAtMs: nowMs };
}

/** Jobs to pick back up on boot: everything that was mid-flight when we stopped. */
export function resumable(jobs: readonly Job[]): readonly Job[] {
  return jobs.filter((job) => !isTerminal(job));
}

/**
 * A completed job whose artifacts can be handed back instead of buying them
 * again.
 *
 * Only `succeeded`: a cancelled or failed job may have half its files on disk,
 * and serving those as a cache hit would be worse than spending the credits.
 */
export function cacheHit(jobs: readonly Job[], key: string): Job | null {
  return jobs.find((job) => job.status === 'succeeded' && job.cacheKey === key) ?? null;
}

export { isTerminal };
