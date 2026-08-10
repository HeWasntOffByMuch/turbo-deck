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

import { checkCeilings, hasEntry, type LedgerEntry } from './ledger.js';
import {
  beginStep,
  blockJob,
  cancelJob,
  clearInFlight,
  completeStep,
  failJob,
  inFlightTask,
  isTerminal,
  markInFlight,
  nextStage,
  recordArtifacts,
  recordCredits,
  recordTaskId,
  resumable,
  resumeBlocked,
  retryFailed,
  stepOf,
} from './jobs.js';
import { Pacer } from './pacing.js';
import { projectCost, type PlannedStep } from './pricing.js';
import type { StudioConfig } from './config.js';
import type { StudioStore } from './store.js';
import {
  batchClips,
  knownPresetsFor,
  presetFor,
  TripoError,
  unknownPresets,
  type TaskHandle,
  type TaskResult,
  type TripoClient,
} from './tripo.js';
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

  /**
   * Everything the API said about a failure, in one line.
   *
   * The raw record is appended rather than logged and dropped. A failure whose
   * cause is not in any field the client thought to read is precisely the one
   * worth keeping the record for, and "task failed" with nothing after it is how
   * an afternoon goes. Logged too, because the record on disk is behind a token
   * and the console is right there.
   */
  private failureText(job: Job, stage: Stage, result: TaskResult, fallback: string): string {
    const head = result.error ?? fallback;
    const text = result.detail === null ? head : `${head} · raw: ${result.detail}`;
    this.say(`${job.id}/${stage}: ${text}`);
    return text;
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

  /**
   * Writes a call's charge to the ledger and onto the job, once.
   *
   * Idempotent on the task id, because a resumed job re-polls a task it already
   * has one for. The ledger is append-only and is the only record of what was
   * actually spent -- a duplicate would inflate every total and every ceiling
   * check built on them, silently and permanently.
   */
  private record(job: Job, stage: Stage, taskId: string | null, result: TaskResult): Job {
    if (hasEntry(this.deps.store.listLedger(), job.id, stage, taskId)) return job;

    const credits = result.creditsConsumed ?? 0;
    const entry: LedgerEntry = {
      jobId: job.id,
      stage,
      taskId,
      credits,
      reported: result.creditsConsumed !== null,
      atMs: this.deps.now(),
    };
    this.deps.store.appendLedger(entry);
    if (!entry.reported) {
      this.say(`${job.id}/${stage}: the API reported no credits_consumed; the total is now a lower bound`);
    }
    return this.save(recordCredits(job, stage, credits, this.deps.now()));
  }

  /**
   * One paid call, made resumable.
   *
   * The whole point of this function is the first branch. A task id is worth
   * money the moment the submit returns -- the work is queued and will be billed
   * whether or not this process survives -- so a job that already has one for
   * this key is *polled*, never re-submitted. Without it, a restart during the
   * poll loop buys the same task again.
   *
   * The id goes on disk before the await, and the charge is written before the
   * download, so every point this can be interrupted at leaves a record that is
   * ahead of the spending rather than behind it.
   */
  private async paidCall(
    job: Job,
    stage: Stage,
    key: string,
    submit: () => Promise<TaskHandle>,
    deadline: number,
  ): Promise<{ readonly job: Job; readonly taskId: string; readonly result: TaskResult }> {
    let current = job;
    let taskId = inFlightTask(current, key);

    if (taskId === null) {
      await this.gate();
      taskId = (await submit()).taskId;
      // Persisted before anything waits on it. This save is the difference
      // between resuming a paid task and paying for it twice.
      current = this.save(markInFlight(recordTaskId(current, stage, taskId, this.deps.now()), key, taskId, this.deps.now()));
    } else {
      this.say(`${job.id}/${key}: task ${taskId} was already submitted; polling it rather than paying again`);
    }

    const { result, resolved } = await this.awaitTask(taskId, deadline);
    current = this.record(current, stage, taskId, result);

    // A task the API itself called failed is finished, so stop remembering it.
    // Otherwise a retry would resume it, poll a corpse, and fail again forever
    // -- the job would have a button that cannot possibly work.
    //
    // Only when the API said so. Our own timeout and our own shutdown also
    // arrive here as `failed`, and in both of those the task may well still be
    // running: forgetting one of those would turn a re-poll, which is free, into
    // a re-submit, which is not.
    if (result.state === 'failed' && resolved) {
      current = this.save(clearInFlight(current, key, this.deps.now()));
    }
    return { job: current, taskId, result };
  }

  private plannedStep(job: Job, stage: Stage): PlannedStep | null {
    const projection = projectCost({
      params: job.params,
      establishesRigFamily: job.establishesRigFamily,
      prices: this.deps.config.prices,
    });
    return projection.steps.find((step) => step.stage === stage) ?? null;
  }

  /**
   * The ceiling gate. Returns the blocked job when it refuses, else null.
   *
   * `projectedOverride` exists for the retarget, which is several calls in one
   * stage. Charging the whole stage's cost against the ceiling before *each* of
   * its calls would count the same clips over and over and refuse a set it had
   * already half paid for -- so the loop checks the remaining work once and then
   * one call at a time.
   */
  private refuseOnCeiling(job: Job, stage: Stage, projectedOverride?: number): Job | null {
    const planned = this.plannedStep(job, stage);
    const projected = projectedOverride ?? planned?.credits ?? 0;
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
   *
   * `resolved` says which kind of answer this is: true when the API reported a
   * terminal state, false when we gave up on a task that was still going. Both
   * come back as a failure to the caller, and they are worlds apart in what may
   * be done next -- one names a dead task, the other names a task that is very
   * possibly still being billed for.
   */
  private async awaitTask(
    taskId: string,
    deadlineMs: number,
  ): Promise<{ readonly result: TaskResult; readonly resolved: boolean }> {
    for (;;) {
      await this.gate();
      const result = await this.deps.client.task(taskId);
      if (result.state === 'succeeded' || result.state === 'failed') return { result, resolved: true };
      if (this.deps.now() >= deadlineMs) {
        return {
          result: { ...result, state: 'failed', error: 'timed out waiting for the task to finish' },
          resolved: false,
        };
      }
      if (this.stopped) {
        return { result: { ...result, state: 'failed', error: 'server shutting down' }, resolved: false };
      }
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
    // The retarget does its own, per clip and against what is left to buy, so it
    // is skipped here rather than charged for the whole set twice.
    const blocked = stage === 'retarget' ? null : this.refuseOnCeiling(job, stage);
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
    // The upload is only needed for a submit; a resumed job already has its
    // task and must not re-upload (free, but pointless) or re-submit (not).
    const submit = async (): Promise<TaskHandle> => {
      const fileToken = await this.uploadReference(job);
      await this.gate();
      return this.deps.client.imageToModel({
        fileToken,
        modelVersion: job.params.modelVersion,
        faceLimit: job.params.faceLimit,
        texture: job.params.texture,
        pbr: job.params.pbr,
        orientation: job.params.orientation,
      });
    };

    const { job: polled, result } = await this.paidCall(job, 'imageToModel', 'imageToModel', submit, deadline);
    if (result.state === 'failed') {
      return this.save(failJob(polled, 'imageToModel', this.failureText(polled, 'imageToModel', result, 'generation failed'), this.deps.now()));
    }

    const meshGlb = await this.pull(polled, result, 'mesh.glb');
    const saved = this.save(recordArtifacts(polled, { meshGlb }, this.deps.now()));
    return this.save(
      completeStep(clearInFlight(saved, 'imageToModel', this.deps.now()), 'imageToModel', {}, this.deps.now()),
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

    const { job: polled, result } = await this.paidCall(
      job,
      'rigCheck',
      'rigCheck',
      () => this.deps.client.rigCheck(source),
      deadline,
    );
    if (result.state === 'failed') {
      return this.save(failJob(polled, 'rigCheck', this.failureText(polled, 'rigCheck', result, 'rig-check failed'), this.deps.now()));
    }
    if (result.riggable === false) {
      return this.save(
        blockJob(
          polled,
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
        clearInFlight(polled, 'rigCheck', this.deps.now()),
        'rigCheck',
        { rigType: result.rigType },
        this.deps.now(),
      ),
    );
  }

  private async runRig(job: Job, deadline: number): Promise<Job> {
    const source = stepOf(job, 'imageToModel')?.taskId;
    if (!source) throw new TripoError('rig has no generated model to rig', null, null);

    const { job: polled, result } = await this.paidCall(
      job,
      'rig',
      'rig',
      () =>
        this.deps.client.rig({
          sourceTaskId: source,
          // The job's, not the server's. A job carries what it was priced and
          // cached under, so a config change between submitting and resuming
          // cannot rig half a roster one way and half the other -- and a record
          // of what a unit was rigged with is the first thing anybody wants
          // when its bones turn out to be named something unexpected.
          modelVersion: job.params.rigModelVersion,
          // What the free rig-check already told us this creature is. It was
          // read, stored and used only to vet preset names, while the call that
          // actually builds the skeleton was never told -- so every rig came
          // back generic, and `spec: mixamo` had no named biped to name.
          rigType: job.rigType,
          spec: job.params.rigSpec,
          outFormat: job.params.outFormat,
        }),
      deadline,
    );
    if (result.state === 'failed') {
      // Two very different things look identical from here, and they have
      // opposite fixes: the source mesh aged out server-side (start again from
      // the image -- a retry will fail the same way forever, at 25 credits a
      // go), or the mesh is simply one auto-rig cannot handle (rig-check is a
      // predictor, not a guarantee, and a second generation from the same photo
      // is a different mesh). One free call tells them apart, and it is worth
      // making at exactly the moment somebody is about to ask why.
      const why = await this.sourceHint(source);
      return this.save(
        failJob(polled, 'rig', `${this.failureText(polled, 'rig', result, 'rig failed')}${why}`, this.deps.now()),
      );
    }

    const riggedGlb = await this.pull(polled, result, 'rigged.glb');
    const saved = this.save(recordArtifacts(polled, { riggedGlb }, this.deps.now()));
    return this.save(completeStep(clearInFlight(saved, 'rig', this.deps.now()), 'rig', {}, this.deps.now()));
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

    // A name the API does not know is not a validation error, it is a paid call
    // that buys nothing -- the task is submitted, charged and fails. So the
    // vocabulary is checked against the rig type the check reported, before any
    // of it is sent. Blocked rather than failed, because nothing was attempted;
    // and the fix is a new job with real names rather than a resume, which is
    // what the message has to say.
    const unknown = unknownPresets(job.rigType, job.params.clipIntents);
    if (unknown.length > 0) {
      const known = knownPresetsFor(job.rigType) ?? [];
      return this.save(
        blockJob(
          job,
          'retarget',
          `no ${job.rigType ?? 'biped'} animation preset is called ${unknown.map((name) => `"${name}"`).join(', ')}. ` +
            `The ones there are: ${known.join(', ')}. Nothing was sent, so nothing was charged -- ` +
            `start a new generation with names from that list.`,
          this.deps.now(),
        ),
      );
    }

    // One clip per call: the API rejects a multi-preset batch, so a five-clip
    // library is five paid calls. `batchClips` is what the cost projection used
    // too, so the number here and the number the ceiling was checked against
    // cannot drift apart.
    const batches = batchClips(job.params.clipIntents);
    let current = job;

    // What is left to buy, checked once before any of it is: better to refuse a
    // set up front than to stop three clips into it. Clips already on disk are
    // not counted -- a resumed job is only paying for what it has not got.
    const remaining = batches.filter(([intent]) => current.artifacts.clipGlbs[intent ?? ''] === undefined).length;
    const upFront = this.refuseOnCeiling(current, 'retarget', remaining * this.deps.config.prices.retargetPerCall);
    if (upFront) return upFront;

    for (const [index, animations] of batches.entries()) {
      const intent = animations[0] ?? `clip-${index}`;

      // Already bought and already on disk. This is the check that makes a
      // five-clip retarget resumable: an interrupted run picks up at the clip it
      // was on rather than paying for the ones before it again.
      if (current.artifacts.clipGlbs[intent] !== undefined) {
        this.say(`${job.id}/retarget: ${intent} is already on disk; skipping`);
        continue;
      }

      // And once more per clip, for this call alone. The up-front check was
      // against projected prices; these are the real charges as they land, so a
      // set that turns out dearer than quoted still stops at a clip boundary
      // rather than running past the ceiling.
      const blocked = this.refuseOnCeiling(current, 'retarget', this.deps.config.prices.retargetPerCall);
      if (blocked) return blocked;

      const key = `retarget:${intent}`;
      const { job: polled, result } = await this.paidCall(
        current,
        'retarget',
        key,
        () =>
          this.deps.client.retarget({
            sourceTaskId: source,
            animations: [presetFor(intent)],
            outFormat: job.params.outFormat,
          }),
        deadline,
      );
      current = polled;
      if (result.state === 'failed') {
        // Terminal, but everything bought before this clip is recorded and on
        // disk -- so a wrong preset name costs one call, not the whole set.
        return this.save(
          failJob(
            current,
            'retarget',
            `${intent}: ${this.failureText(current, 'retarget', result, 'retarget failed')}`,
            this.deps.now(),
          ),
        );
      }

      const path = await this.pull(current, result, `${intent}.glb`);
      if (path !== null) {
        current = this.save(recordArtifacts(current, { clipGlbs: { [intent]: path } }, this.deps.now()));
      }
      current = this.save(clearInFlight(current, key, this.deps.now()));
    }

    return this.save(completeStep(current, 'retarget', {}, this.deps.now()));
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
    return this.save(completeStep(job, 'download', {}, this.deps.now()));
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

  /**
   * Picks a failed job back up at the stage that failed. Null when it is not
   * failed.
   *
   * Never called by anything on a timer -- the route behind it wants a one-shot
   * confirmation token issued against {@link projectRemaining}, so the button
   * that reaches here has already shown somebody what carrying on costs. That is
   * the whole difference between this and the auto-retry the brief rules out:
   * the machine still never decides to spend twice, and now the operator can.
   */
  retry(jobId: string): Job | null {
    const job = this.deps.store.getJob(jobId);
    if (!job) return null;
    const retried = retryFailed(job, this.deps.now());
    if (retried === null) return null;
    this.say(`${jobId}: retrying from ${job.stage ?? 'the start'}`);
    this.save(retried);
    void this.run(jobId);
    return retried;
  }

  /**
   * Whether the input task is still alive, as a clause to append to a failure.
   *
   * Free, and best-effort: if this call itself fails, the rig's own failure is
   * still the thing being reported and this must not replace it with a second,
   * less relevant error.
   */
  private async sourceHint(sourceTaskId: string): Promise<string> {
    try {
      await this.gate();
      const source = await this.deps.client.task(sourceTaskId);
      if (source.state === 'failed') {
        return ` · the source mesh (task ${sourceTaskId}) is no longer usable server-side: ${source.error ?? 'gone'}. Start a new generation from the image rather than retrying this one -- a retry will fail the same way.`;
      }
      return ` · the source mesh (task ${sourceTaskId}) is still fine, so this is the rig refusing this particular mesh rather than a stale input. Rig-check is a predictor, not a guarantee; a fresh generation from the same image is a different mesh and may well rig.`;
    } catch {
      return '';
    }
  }

  /** The API's own record for a task, unmapped. See the route that calls it. */
  rawTask(taskId: string): Promise<unknown> {
    return this.deps.client.rawTask(taskId);
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
