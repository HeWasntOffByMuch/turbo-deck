/**
 * Driving a job through the four calls (spec 108).
 *
 * The ordering here is the whole safety argument, so it is worth stating plainly
 * rather than leaving it to be inferred from the code:
 *
 *  1. **Check the ceilings.** Against what has already been spent plus what this
 *     stage will cost, before anything is sent. Over either ceiling the job is
 *     `blocked` and nothing was attempted.
 *  2. **Persist, then submit.** The record with the stage marked running is
 *     `fsync`-ordered onto disk before the request goes out, never after. A
 *     process killed between the two still knows a task may exist; a process
 *     killed the other way round would have paid for a task nobody can find.
 *  3. **Record the task id the moment it comes back**, for the same reason.
 *  4. **Poll through the shared pacer**, so two jobs cannot together exceed the
 *     one-per-second the API asks for.
 *  5. **Download inside the success handler.** A model URL expires about five
 *     minutes after the task succeeds. It is never stored, never returned to the
 *     browser, and never waited on -- the artifact is the file on disk.
 *  6. **On failure, stop.** Nothing here retries a paid call. Re-running is a
 *     new job, priced and confirmed again by a person.
 */

import { checkCeilings, type LedgerEntry } from './ledger.js';
import {
  beginStep,
  blockJob,
  cancelJob,
  completeStep,
  failJob,
  isTerminal,
  nextStage,
  recordTaskId,
  resumable,
  resumeBlocked,
  stepOf,
} from './jobs.js';
import { Pacer } from './pacing.js';
import { projectCost, type PlannedStep } from './pricing.js';
import type { StudioConfig } from './config.js';
import type { StudioStore } from './store.js';
import { batchClips, presetFor, TripoError, type TaskResult, type TripoClient } from './tripo.js';
import type { Job, Stage } from './types.js';

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;
export type Log = (message: string) => void;

export interface PipelineDeps {
  readonly client: TripoClient;
  readonly store: StudioStore;
  readonly config: StudioConfig;
  readonly now: Clock;
  readonly sleep: Sleep;
  readonly log?: Log;
  /** Writes a downloaded artifact and returns where it went. */
  readonly writeArtifact: (jobId: string, filename: string, bytes: Uint8Array) => string;
}

/** How long a single task may take before the pipeline gives up polling it. */
export const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;

export class StudioPipeline {
  private readonly pacer: Pacer;
  /**
   * Jobs currently being driven, and the promise for each.
   *
   * A map rather than a set of ids so a second caller *awaits the run in
   * flight* instead of being handed the record as it is right now. Returning
   * early looks like a no-op and is one, but it means anything that starts a job
   * and then awaits it -- resuming a blocked one, a test -- gets an answer from
   * before the work happened.
   */
  private readonly running = new Map<string, Promise<Job | null>>();
  private stopped = false;

  constructor(private readonly deps: PipelineDeps) {
    this.pacer = new Pacer(deps.config.minRequestIntervalMs);
  }

  private say(message: string): void {
    this.deps.log?.(`[studio] ${message}`);
  }

  /** Waits for the shared rate gate. Every outbound call goes through this. */
  private async gate(): Promise<void> {
    const delay = this.pacer.reserve(this.deps.now());
    if (delay > 0) await this.deps.sleep(delay);
  }

  private save(job: Job): Job {
    this.deps.store.saveJob(job);
    return job;
  }

  private record(job: Job, stage: Stage, taskId: string | null, result: TaskResult): void {
    const entry: LedgerEntry = {
      jobId: job.id,
      stage,
      taskId,
      credits: result.creditsConsumed ?? 0,
      reported: result.creditsConsumed !== null,
      atMs: this.deps.now(),
    };
    this.deps.store.appendLedger(entry);
    if (!entry.reported) {
      this.say(`${job.id}/${stage}: the API reported no credits_consumed; the total is now a lower bound`);
    }
  }

  private plannedStep(job: Job, stage: Stage): PlannedStep | null {
    const projection = projectCost({
      params: job.params,
      establishesRigFamily: job.establishesRigFamily,
      prices: this.deps.config.prices,
    });
    return projection.steps.find((step) => step.stage === stage) ?? null;
  }

  /** The ceiling gate. Returns the blocked job when it refuses, else null. */
  private refuseOnCeiling(job: Job, stage: Stage): Job | null {
    const planned = this.plannedStep(job, stage);
    const projected = planned?.credits ?? 0;
    if (projected <= 0) return null;

    const verdict = checkCeilings({
      entries: this.deps.store.listLedger(),
      jobId: job.id,
      projectedCredits: projected,
      nowMs: this.deps.now(),
      ceilings: this.deps.config.ceilings,
    });
    if (verdict.ok) return null;

    this.say(`${job.id}/${stage}: blocked, ${verdict.reason}`);
    return this.save(blockJob(job, stage, verdict.reason, this.deps.now()));
  }

  /**
   * Polls one task to a terminal state.
   *
   * Times out rather than polling forever: a task stuck in `running` for twenty
   * minutes is not going to finish, and a poll loop with no end is a slow leak
   * of both requests and rate-limit budget.
   */
  private async awaitTask(taskId: string, deadlineMs: number): Promise<TaskResult> {
    for (;;) {
      await this.gate();
      const result = await this.deps.client.task(taskId);
      if (result.state === 'succeeded' || result.state === 'failed') return result;
      if (this.deps.now() >= deadlineMs) {
        return { ...result, state: 'failed', error: 'timed out waiting for the task to finish' };
      }
      if (this.stopped) return { ...result, state: 'failed', error: 'server shutting down' };
      await this.deps.sleep(this.deps.config.pollIntervalMs);
    }
  }

  /** Downloads a successful task's model straight away, before the URL expires. */
  private async pull(job: Job, result: TaskResult, filename: string): Promise<string | null> {
    if (result.modelUrl === null) return null;
    const bytes = await this.deps.client.download(result.modelUrl);
    return this.deps.writeArtifact(job.id, filename, bytes);
  }

  /**
   * Runs one stage: ceiling, persist, submit, persist, poll, download, record.
   *
   * Returns the job in whatever state the stage left it. A thrown
   * {@link TripoError} is caught here and turned into a failed job rather than
   * propagating, because an exception escaping this loop would leave a job
   * marked `running` forever with nothing polling it.
   */
  private async runStage(job: Job, stage: Stage): Promise<Job> {
    const blocked = this.refuseOnCeiling(job, stage);
    if (blocked) return blocked;

    const started = this.save(beginStep(job, stage, this.deps.now()));
    const deadline = this.deps.now() + DEFAULT_TASK_TIMEOUT_MS;

    try {
      switch (stage) {
        case 'imageToModel':
          return await this.runImageToModel(started, deadline);
        case 'rigCheck':
          return await this.runRigCheck(started, deadline);
        case 'rig':
          return await this.runRig(started, deadline);
        case 'retarget':
          return await this.runRetarget(started, deadline);
        case 'download':
          return this.finishDownloads(started);
      }
    } catch (cause) {
      const message = cause instanceof TripoError ? cause.message : String(cause);
      this.say(`${job.id}/${stage}: failed, ${message}`);
      // Deliberately terminal. Nothing schedules another attempt.
      return this.save(failJob(started, stage, message, this.deps.now()));
    }
  }

  /**
   * The generation itself.
   *
   * The reference image is uploaded here rather than in a stage of its own: the
   * upload is free, has no task to poll, and a progress row that completes
   * instantly is noise in a UI whose job is to show where the money went.
   */
  private async runImageToModel(job: Job, deadline: number): Promise<Job> {
    const fileToken = await this.uploadReference(job);

    await this.gate();
    const handle = await this.deps.client.imageToModel({
      fileToken,
      modelVersion: job.params.modelVersion,
      faceLimit: job.params.faceLimit,
      texture: job.params.texture,
      pbr: job.params.pbr,
    });
    const submitted = this.save(recordTaskId(job, 'imageToModel', handle.taskId, this.deps.now()));

    const result = await this.awaitTask(handle.taskId, deadline);
    this.record(submitted, 'imageToModel', handle.taskId, result);
    if (result.state === 'failed') {
      return this.save(failJob(submitted, 'imageToModel', result.error ?? 'generation failed', this.deps.now()));
    }

    const meshGlb = await this.pull(submitted, result, 'mesh.glb');
    return this.save(
      completeStep(
        submitted,
        'imageToModel',
        { creditsConsumed: result.creditsConsumed ?? 0, artifacts: { meshGlb } },
        this.deps.now(),
      ),
    );
  }

  private async uploadReference(job: Job): Promise<string> {
    const reference = this.deps.store.readReferenceImage(job.id);
    if (reference === null) {
      throw new TripoError(`no reference image on disk for job ${job.id}`, null, null);
    }
    await this.gate();
    return this.deps.client.uploadImage(reference.bytes, reference.filename, reference.contentType);
  }

  /**
   * The free call that stops an expensive one.
   *
   * Always made, never skipped. `riggable: false` blocks the job rather than
   * failing it -- nothing went wrong and nothing was charged, the model simply
   * cannot carry a skeleton, and the next thing to do is pick a different
   * reference image rather than debug an error.
   */
  private async runRigCheck(job: Job, deadline: number): Promise<Job> {
    const source = stepOf(job, 'imageToModel')?.taskId;
    if (!source) throw new TripoError('rig-check has no generated model to check', null, null);

    await this.gate();
    const handle = await this.deps.client.rigCheck(source);
    const submitted = this.save(recordTaskId(job, 'rigCheck', handle.taskId, this.deps.now()));

    const result = await this.awaitTask(handle.taskId, deadline);
    this.record(submitted, 'rigCheck', handle.taskId, result);
    if (result.state === 'failed') {
      return this.save(failJob(submitted, 'rigCheck', result.error ?? 'rig-check failed', this.deps.now()));
    }
    if (result.riggable === false) {
      return this.save(
        blockJob(
          submitted,
          'rigCheck',
          'the generated model is not riggable; nothing was charged for a rig. Try a clearer reference image: a single figure, an A- or T-pose, limbs clear of the body.',
          this.deps.now(),
        ),
      );
    }

    // The rig type the check *recommends*, kept rather than assumed: it
    // namespaces every animation preset the retarget will ask for.
    if (result.rigType === null) {
      this.say(`${job.id}/rigCheck: riggable, but the API named no rig_type; presets will fall back to biped`);
    }
    return this.save(
      completeStep(
        submitted,
        'rigCheck',
        { creditsConsumed: result.creditsConsumed ?? 0, rigType: result.rigType },
        this.deps.now(),
      ),
    );
  }

  private async runRig(job: Job, deadline: number): Promise<Job> {
    const source = stepOf(job, 'imageToModel')?.taskId;
    if (!source) throw new TripoError('rig has no generated model to rig', null, null);

    await this.gate();
    const handle = await this.deps.client.rig({
      sourceTaskId: source,
      modelVersion: this.deps.config.rigModelVersion,
      spec: this.deps.config.rigSpec,
      outFormat: job.params.outFormat,
    });
    const submitted = this.save(recordTaskId(job, 'rig', handle.taskId, this.deps.now()));

    const result = await this.awaitTask(handle.taskId, deadline);
    this.record(submitted, 'rig', handle.taskId, result);
    if (result.state === 'failed') {
      return this.save(failJob(submitted, 'rig', result.error ?? 'rig failed', this.deps.now()));
    }

    const riggedGlb = await this.pull(submitted, result, 'rigged.glb');
    return this.save(
      completeStep(
        submitted,
        'rig',
        { creditsConsumed: result.creditsConsumed ?? 0, artifacts: { riggedGlb } },
        this.deps.now(),
      ),
    );
  }

  /**
   * The clip library, retargeted **once** for the rig family.
   *
   * Only reached by a job that establishes a family -- `nextStage` skips it for
   * everything else, which is the shared-skeleton rule in code. Batched at five
   * clips per call, matching what the cost projection priced.
   */
  private async runRetarget(job: Job, deadline: number): Promise<Job> {
    const source = stepOf(job, 'rig')?.taskId;
    if (!source) throw new TripoError('retarget has no rigged model to animate', null, null);

    // One clip per call: the API rejects a multi-preset batch, so a five-clip
    // library is five paid calls. `batchClips` is what the cost projection used
    // too, so the number here and the number the ceiling was checked against
    // cannot drift apart.
    const batches = batchClips(job.params.clipIntents);
    const rigType = job.rigType ?? 'biped';
    let current = job;
    let credits = 0;
    const clipGlbs: Record<string, string> = {};

    for (const [index, animations] of batches.entries()) {
      await this.gate();
      const handle = await this.deps.client.retarget({
        sourceTaskId: source,
        animations: animations.map((intent) => presetFor(rigType, intent)),
        outFormat: job.params.outFormat,
      });
      current = this.save(recordTaskId(current, 'retarget', handle.taskId, this.deps.now()));

      const result = await this.awaitTask(handle.taskId, deadline);
      this.record(current, 'retarget', handle.taskId, result);
      if (result.state === 'failed') {
        return this.save(failJob(current, 'retarget', result.error ?? 'retarget failed', this.deps.now()));
      }
      credits += result.creditsConsumed ?? 0;

      // One call, one clip, one file -- named for the intent rather than for the
      // call index, now that the two are the same thing.
      const intent = animations[0] ?? `clip-${index}`;
      const path = await this.pull(current, result, `${intent}.glb`);
      if (path !== null) clipGlbs[intent] = path;
    }

    return this.save(
      completeStep(current, 'retarget', { creditsConsumed: credits, artifacts: { clipGlbs } }, this.deps.now()),
    );
  }

  /**
   * The last stage: everything was downloaded as it succeeded, so this only
   * confirms the files are where the record says they are.
   *
   * Worth being a stage rather than an implicit end, because "the task succeeded
   * but the download did not" is a real outcome and it should not read as a
   * successful generation.
   */
  private finishDownloads(job: Job): Job {
    const missing: string[] = [];
    if (job.artifacts.meshGlb === null) missing.push('mesh');
    if (job.artifacts.riggedGlb === null) missing.push('rigged model');
    if (job.establishesRigFamily && Object.keys(job.artifacts.clipGlbs).length === 0) missing.push('clips');

    if (missing.length > 0) {
      return this.save(
        failJob(
          job,
          'download',
          `the tasks succeeded but nothing was saved for: ${missing.join(', ')}. A model URL expires about five minutes after success, so this is usually a download that was too late.`,
          this.deps.now(),
        ),
      );
    }
    return this.save(completeStep(job, 'download', { creditsConsumed: 0 }, this.deps.now()));
  }

  /** Drives a job to a terminal state. Safe to call twice; the second is a no-op. */
  run(jobId: string): Promise<Job | null> {
    const inFlight = this.running.get(jobId);
    if (inFlight) return inFlight;
    const started = this.drive(jobId).finally(() => this.running.delete(jobId));
    this.running.set(jobId, started);
    return started;
  }

  private async drive(jobId: string): Promise<Job | null> {
    let job = this.deps.store.getJob(jobId);
    while (job && !isTerminal(job) && !this.stopped) {
      const stage = nextStage(job);
      if (stage === null) break;
      job = await this.runStage(job, stage);
    }
    return job;
  }

  /**
   * Picks up everything that was mid-flight when the process stopped.
   *
   * The reason the record is written before the submit: without it a job could
   * have a paid task in flight and no row here to resume, and the credits would
   * be gone with nothing to show for them.
   */
  resume(): readonly Job[] {
    const pending = resumable(this.deps.store.listJobs());
    for (const job of pending) {
      this.say(`resuming ${job.id} at ${job.stage ?? 'the start'}`);
      void this.run(job.id);
    }
    return pending;
  }

  /**
   * Lifts a block and carries on. Returns null when the job is not blocked.
   *
   * The ceiling is re-checked on the way through like any other stage, so
   * resuming without having raised it simply blocks again -- rather than
   * spending on the strength of a button press.
   */
  unblock(jobId: string): Job | null {
    const job = this.deps.store.getJob(jobId);
    if (!job) return null;
    const resumed = resumeBlocked(job, this.deps.now());
    if (resumed === null) return null;
    this.save(resumed);
    void this.run(jobId);
    return resumed;
  }

  cancel(jobId: string): Job | null {
    const job = this.deps.store.getJob(jobId);
    if (!job) return null;
    return this.save(cancelJob(job, this.deps.now()));
  }

  /** Stops the polling loops so the process can exit. */
  stop(): void {
    this.stopped = true;
  }
}
