/**
 * What to generate, decided rather than typed (spec 109).
 *
 * The one function here that matters is {@link establishesRigFamily}, and it
 * matters because the shared-skeleton rule is money. Spec 108's constraint is
 * that the clip library is retargeted onto the canonical rig **once** and every
 * later unit of the family reuses it; a checkbox in the ingest form would make
 * that a matter of somebody remembering, on the one screen where forgetting
 * costs a retarget per unit and produces a roster whose timings quietly differ.
 *
 * So it is derived from the library. The first unit of a family establishes it;
 * once one has succeeded, nothing can be told to retarget again.
 *
 * Pure, and tested headlessly.
 */

/** Just enough of a job for the decisions here. Keeps this side free of the wire type. */
export interface JobSummary {
  readonly id: string;
  readonly skeletonId: string;
  readonly status: string;
  readonly establishesRigFamily: boolean;
}

/**
 * The clips a humanoid roster needs, as intents rather than as file names.
 *
 * An intent is what the game asks for; which Tripo preset satisfies it is the
 * service's business. Keeping the two apart means renaming a preset is not a
 * change to every unitdef in the repo.
 *
 * Ordered by how much they are missed: the first five are one retarget batch,
 * which is deliberate -- the default set costs exactly one call.
 */
export const CLIP_INTENTS: readonly { readonly id: string; readonly label: string; readonly byDefault: boolean }[] = [
  { id: 'idle', label: 'Idle', byDefault: true },
  { id: 'walk', label: 'Walk', byDefault: true },
  { id: 'run', label: 'Run', byDefault: true },
  { id: 'attack', label: 'Attack swing', byDefault: true },
  { id: 'hit', label: 'Take a hit', byDefault: true },
  { id: 'death', label: 'Death', byDefault: false },
  { id: 'cast', label: 'Cast', byDefault: false },
  { id: 'jump', label: 'Jump', byDefault: false },
];

export function defaultClipIntents(): readonly string[] {
  return CLIP_INTENTS.filter((intent) => intent.byDefault).map((intent) => intent.id);
}

/**
 * Whether this generation is the one that establishes its rig family.
 *
 * True only when no job has already succeeded for the family. A failed or
 * cancelled job establishes nothing -- its clips may be half-downloaded or
 * absent, and treating it as the family's library would leave every later unit
 * pointing at a clip set that is not there.
 */
export function establishesRigFamily(jobs: readonly JobSummary[], skeletonId: string): boolean {
  return !jobs.some(
    (job) => job.skeletonId === skeletonId && job.status === 'succeeded' && job.establishesRigFamily,
  );
}

/** The rig families a library already has clips for. */
export function establishedFamilies(jobs: readonly JobSummary[]): readonly string[] {
  return [
    ...new Set(
      jobs
        .filter((job) => job.status === 'succeeded' && job.establishesRigFamily)
        .map((job) => job.skeletonId),
    ),
  ].sort();
}

/**
 * A unit id that can be a file name and an identifier.
 *
 * Matched to the `identifier` pattern the spec 107 schemas use, so an id that
 * passes here cannot be rejected later by the validator -- finding out that a
 * name was illegal *after* paying to generate it would be a poor time.
 */
export function isValidUnitId(id: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(id);
}

export function unitIdProblem(id: string, existing: readonly string[]): string | null {
  if (id.trim() === '') return 'a unit needs an id';
  if (!isValidUnitId(id)) return 'letters, digits, dot, dash and underscore only, starting with a letter';
  if (existing.includes(id)) return `there is already a unit called "${id}"`;
  return null;
}
