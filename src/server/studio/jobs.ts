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
    inFlight: {},
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
  // `startedAtMs` is kept if the stage already has one: a resumed stage began
  // when it began, and restamping it would make the elapsed time in the UI
  // measure the resume rather than the work.
  const existing = stepOf(job, stage)?.startedAtMs ?? null;
  return {
    ...job,
    status: 'running',
    stage,
    steps: patchStep(job, stage, { status: 'running', startedAtMs: existing ?? nowMs }),
    updatedAtMs: nowMs,
  };
}

/** Records the task id the submit returned, so a crash after this can resume it. */
export function recordTaskId(job: Job, stage: Stage, taskId: string, nowMs: number): Job {
  return { ...job, steps: patchStep(job, stage, { taskId }), updatedAtMs: nowMs };
}

/**
 * The in-flight map, tolerating a record written before the field existed.
 *
 * `jobs.json` is on somebody's disk from an earlier build, and a job that was
 * *blocked* there is exactly the one they will come back and resume. Reading a
 * missing field would throw on the way in and strand a job that has already
 * been paid for -- which is the opposite of what this whole mechanism is for.
 */
function inFlightOf(job: Job): Readonly<Record<string, string>> {
  return job.inFlight ?? {};
}

/** Notes a submitted task, so a restart polls it instead of buying another. */
export function markInFlight(job: Job, key: string, taskId: string, nowMs: number): Job {
  return { ...job, inFlight: { ...inFlightOf(job), [key]: taskId }, updatedAtMs: nowMs };
}

/** Forgets a call once its charge is recorded and its file is written. */
export function clearInFlight(job: Job, key: string, nowMs: number): Job {
  const current = inFlightOf(job);
  if (!(key in current)) return job.inFlight === undefined ? { ...job, inFlight: {} } : job;
  const remaining = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key));
  return { ...job, inFlight: remaining, updatedAtMs: nowMs };
}

export function inFlightTask(job: Job, key: string): string | null {
  return inFlightOf(job)[key] ?? null;
}

/**
 * Records what a call charged, the moment it is known.
 *
 * Separate from {@link completeStep}, and called before the download rather
 * than after, because the charge is a fact as soon as the task succeeds. Folding
 * it into completion would mean a process that died between the success and the
 * file on disk had spent money the record does not show -- and a total that
 * under-reads is the one that lets a ceiling be passed.
 *
 * Accumulates on the step rather than replacing, so a stage made of several
 * calls -- the retarget, one per clip -- ends up with the sum of them.
 */
export function recordCredits(job: Job, stage: Stage, credits: number, nowMs: number): Job {
  const previous = stepOf(job, stage)?.creditsConsumed ?? 0;
  return {
    ...job,
    steps: patchStep(job, stage, { creditsConsumed: previous + credits }),
    creditsSpent: job.creditsSpent + credits,
    updatedAtMs: nowMs,
  };
}

/** Records a downloaded file, immediately, so a restart never re-fetches it. */
export function recordArtifacts(job: Job, patch: Partial<Job['artifacts']>, nowMs: number): Job {
  return {
    ...job,
    artifacts: {
      ...job.artifacts,
      ...patch,
      clipGlbs: { ...job.artifacts.clipGlbs, ...(patch.clipGlbs ?? {}) },
    },
    updatedAtMs: nowMs,
  };
}

export interface StepOutcome {
  /** Set by the rig check; every later call needs it. */
  readonly rigType?: string | null;
}

/**
 * Marks a stage finished.
 *
 * Carries no money and no files any more -- {@link recordCredits} and
 * {@link recordArtifacts} have already written those as they happened. All this
 * does is close the stage, which is what makes the whole sequence resumable from
 * wherever it stopped.
 */
export function completeStep(job: Job, stage: Stage, outcome: StepOutcome, nowMs: number): Job {
  const advanced: Job = {
    ...job,
    steps: patchStep(job, stage, { status: 'done', finishedAtMs: nowMs }),
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

/**
 * Lifts a block so the job can carry on where it stopped.
 *
 * **Only a blocked job**, never a failed one, and the distinction is the whole
 * reason the two states are separate. `blocked` means the ceiling check refused
 * *before* anything was sent: nothing was attempted, nothing was charged, and the
 * stages already done are on disk. Continuing is not a retry -- it is the rest of
 * a job that was deliberately paused, and it costs exactly what it would have
 * cost had the ceiling been higher to begin with.
 *
 * `failed` stays terminal. A paid call that failed for a reason nobody
 * understands must not be repeatable by pressing a button.
 */
export function resumeBlocked(job: Job, nowMs: number): Job | null {
  if (job.status !== 'blocked') return null;
  // The stage that was refused never reached `beginStep`, so its record is still
  // pending and `nextStage` will hand it back. Nothing needs rewinding.
  return { ...job, status: 'queued', stage: null, message: null, updatedAtMs: nowMs };
}

/**
 * Picks a failed job back up at the stage that failed.
 *
 * The rule this lives under is "never auto-retry a failed paid call", and it
 * does not break it: nothing here is on a timer and nothing calls this except a
 * person pressing a button, having been shown what the rest of the job will
 * cost. What the rule forbids is a machine deciding to spend again. It does not
 * forbid the operator deciding to, and a pipeline that cannot be told to carry
 * on has a worse failure mode than the one it was avoiding -- a retarget that
 * failed on its third clip strands a mesh and a rig that were paid for and are
 * sitting on disk, and the only way forward is a new job that buys both again.
 *
 * Only the failed stage is rewound. Stages already `done` stay done, the
 * artifacts stay, and `creditsConsumed` stays on every step including the failed
 * one -- that money was spent whatever happened next, and a total that forgets it
 * is a ceiling that can be walked past by failing repeatedly.
 *
 * `taskId` on the failed step *is* cleared, because it names a task that
 * produced nothing and anything downstream reading it as a source would be
 * building on a corpse. Entries in `inFlight` are deliberately left alone: those
 * are calls whose outcome is still unknown, and re-polling one is free where
 * re-submitting it is not.
 */
export function retryFailed(job: Job, nowMs: number): Job | null {
  if (job.status !== 'failed') return null;
  const stage = job.stage;
  return {
    ...job,
    status: 'queued',
    stage: null,
    message: null,
    steps:
      stage === null
        ? job.steps
        : job.steps.map((step) =>
            step.stage === stage
              ? { ...step, status: 'pending' as const, taskId: null, error: null, startedAtMs: null, finishedAtMs: null }
              : step,
          ),
    updatedAtMs: nowMs,
  };
}

/**
 * Takes a rig family's clip library away from whoever owns it (spec 114).
 *
 * Ownership is derived, not stored as a flag on the family: `establishesRigFamily`
 * on the *client* is "no succeeded job of this family claims it". So releasing a
 * family is clearing that claim on the jobs that hold it, and the next estimate
 * then quotes a retarget again because the same derivation now says yes.
 *
 * Returns only the jobs that changed, so a caller can say what it did and a
 * second release can 404 rather than reporting a release that released nothing.
 *
 * Three things are deliberately *not* touched:
 *
 *  - **Anything that is not `succeeded`.** A failed job never owned the family,
 *    and clearing the flag on one would change what `projectRemaining` prices:
 *    its unrun retarget steps would stop being its to buy. Releasing must not
 *    quietly reprice a retry.
 *  - **`creditsSpent` and every `taskId`.** What was paid for was paid for.
 *    Release is a statement about the next generation, not a refund, and a
 *    ledger that forgets a charge is a ceiling that can be walked past.
 *  - **The clip `.glb` files.** They stay on disk under the job and under
 *    `assets/units/`; deleting from a git working tree is the author's call.
 */
export function releaseFamily(jobs: readonly Job[], skeletonId: string, nowMs: number): readonly Job[] {
  return jobs
    .filter((job) => job.skeletonId === skeletonId && job.status === 'succeeded' && job.establishesRigFamily)
    .map((job) => ({
      ...job,
      establishesRigFamily: false,
      // Said in the record rather than only in a log, because a unit exported
      // from this job later still names its real retarget task ids in
      // provenance, and the two together are the whole story: these clips were
      // bought here, and they are no longer what the family reuses.
      message: 'released: this job no longer owns the rig family’s clip library',
      updatedAtMs: nowMs,
    }));
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
