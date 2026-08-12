/**
 * What a generation job is (spec 108).
 *
 * Shaped like the rest of this codebase's state: readonly records advanced by
 * pure transition functions, so the whole lifecycle of a job that spends money
 * can be driven and asserted in Node with no network and no clock. Every field
 * that would otherwise be read from the environment -- the time, the task id the
 * API returned -- arrives as an argument instead.
 */

/** The four documented calls, plus the download that has to happen immediately. */
export const STAGES = ['imageToModel', 'rigCheck', 'rig', 'retarget', 'download'] as const;
export type Stage = (typeof STAGES)[number];

export type JobStatus =
  | 'queued'
  /** A stage is in flight or being polled. */
  | 'running'
  | 'succeeded'
  /** A call failed. Never retried automatically -- re-running is a new job. */
  | 'failed'
  /**
   * Stopped deliberately *before* spending: a ceiling, or a rig-check that came
   * back not riggable. Distinct from `failed` because nothing was attempted and
   * nothing was charged, and the two want different words in the UI.
   */
  | 'blocked'
  | 'cancelled';

export interface StepRecord {
  readonly stage: Stage;
  /** The Tripo task id, or null before the submit returned one. */
  readonly taskId: string | null;
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** Read off the task result. 0 for a free call and for one never made. */
  readonly creditsConsumed: number;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly error: string | null;
}

/** Everything about a request that changes what comes back, and so the cache key. */
export interface GenerationParams {
  /** Tripo's model version, e.g. `P1-20260311`. */
  readonly modelVersion: string;
  readonly faceLimit: number;
  readonly texture: boolean;
  readonly pbr: boolean;
  /**
   * How the generated mesh is oriented in its own space.
   *
   * `default` lets Tripo normalise the model to a canonical front, which is what
   * this pipeline got implicitly before the field existed. `align_image` instead
   * rotates the model to match the *camera* of the reference image.
   *
   * Which is right depends entirely on the photograph, and the two fail in
   * opposite directions. On an unusual or stylised subject Tripo's guess at
   * "the front" can be off by an arbitrary yaw, and every clip then plays in a
   * frame rotated by it. On a shot that is not square on, `align_image` bakes
   * the camera's yaw into the rig just as surely.
   *
   * Part of the cache key because it changes the bytes that come back.
   */
  readonly orientation: 'default' | 'align_image';
  /**
   * The skeleton the auto-rig is asked for -- `mixamo` for this project's roster.
   *
   * Server-side configuration like {@link orientation}, and recorded here for
   * the same reason: it changes the bytes that come back, so it belongs in the
   * cache key. Leaving it out meant that changing `TRIPO_RIG_SPEC` and
   * regenerating served the *old* job straight back as a cache hit -- the one
   * experiment the setting exists for, silently answered with the artifacts it
   * was meant to replace.
   *
   * It is also the field that decides whether a unit can exist at all. The
   * sockets, the skeleton document, the family check and the export all address
   * bones by mixamo name, and a rig that comes back in a generator's own
   * vocabulary answers to none of them.
   */
  readonly rigSpec: string;
  /** The auto-rig's model version, which is not the generation one. */
  readonly rigModelVersion: string;
  /**
   * Which clips to retarget, by intent name. Ordered on write so the cache key
   * of the same set requested in a different order is the same key.
   */
  readonly clipIntents: readonly string[];
  /** `glb` throughout; the field exists so a future format is not a schema change. */
  readonly outFormat: 'glb';
}

/**
 * Where a job's downloaded files ended up. Paths on disk, never URLs -- a Tripo
 * model URL expires about five minutes after the task succeeds, so a URL stored
 * here would be a dead link by the time anybody looked at it.
 */
export interface JobArtifacts {
  readonly meshGlb: string | null;
  readonly riggedGlb: string | null;
  /** Clip intent -> path of the animation-only .glb. */
  readonly clipGlbs: Readonly<Record<string, string>>;
}

export interface Job {
  readonly id: string;
  /** The unit this is being generated for. */
  readonly unitId: string;
  /** The rig family this unit belongs to, e.g. `biped`. */
  readonly skeletonId: string;
  /**
   * Whether this job establishes the rig family's clip library or reuses one.
   *
   * The central architectural constraint (spec 108): the clip library is
   * retargeted onto the canonical skeleton **once**, and every later unit of the
   * family reuses it. A job with this false never reaches the retarget stage.
   */
  readonly establishesRigFamily: boolean;
  readonly cacheKey: string;
  /**
   * What the (free) rig check recommended: `biped`, `quadruped`, `avian`...
   *
   * Null until the check has run. Carried rather than assumed because animation
   * presets are namespaced by it, and guessing would fail one paid call per clip
   * on the first non-humanoid.
   */
  readonly rigType: string | null;
  /**
   * Calls that were **submitted and not yet finished**, keyed by what they are:
   * `imageToModel`, `rig`, `retarget:walk`.
   *
   * The difference between resuming and re-paying. A task id is worth money the
   * instant the submit returns -- the work is queued and will be billed whether
   * or not this process lives to see it -- so it goes on disk immediately and a
   * restart polls it rather than buying another one. An entry is cleared only
   * once its result has been recorded and its file written.
   */
  readonly inFlight: Readonly<Record<string, string>>;
  readonly referenceImageSha256: string;
  readonly params: GenerationParams;
  readonly status: JobStatus;
  /** The stage in flight, or the one that stopped things. Null when queued. */
  readonly stage: Stage | null;
  readonly steps: readonly StepRecord[];
  readonly creditsSpent: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Why it failed or was blocked, in words a person can act on. */
  readonly message: string | null;
  readonly artifacts: JobArtifacts;
}

export function isTerminal(job: Job): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'blocked' || job.status === 'cancelled';
}
