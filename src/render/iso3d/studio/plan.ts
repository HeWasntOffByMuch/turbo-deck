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
 * The clips a biped can be given, as the API's own preset names.
 *
 * An earlier draft of this list was a wish list -- `attack`, `hit`, `death`,
 * `cast` -- on the theory that an intent is what the game asks for and the
 * service maps it onto whatever preset satisfies it. That indirection is only
 * worth having if there is something to map *onto*, and there is not: the
 * retarget takes a fixed vocabulary and every clip is one paid call, so a name
 * outside it is not a mapping problem, it is a charge for a task that fails.
 * The tick boxes are therefore the real names, and the game's own naming happens
 * later, in the unitdef, where it is free.
 *
 * There is no `attack` and no `death`. `slash` is the swing; `fall` is a fall,
 * which is *near* a death without being one, so nothing here quietly aliases the
 * two.
 *
 * The **recommended** set, not the available one. The rig model decides what is
 * available -- the creature model has eleven presets and the humanoid model has
 * a hundred and one -- so the full vocabulary is asked for at runtime and comes
 * back on `/config`. Baking it in here would mean this tab quietly describes
 * whichever model was configured on the day it was written, which is what
 * happened: the tick boxes went on offering eleven clips for weeks after the
 * pipeline moved to a model with a hundred.
 *
 * What stays here is the shortlist worth a label and a default, because a
 * hundred and one tick boxes is not a choice, it is a search problem. Every id
 * below exists in both models' vocabularies, which is what `plan.test.ts`
 * checks -- a tick box with no preset behind it is a paid call that buys
 * nothing.
 *
 * The defaults are the smallest set a unit needs to stand, move and fight.
 */
export const CLIP_INTENTS: readonly { readonly id: string; readonly label: string; readonly byDefault: boolean }[] = [
  { id: 'idle', label: 'Idle', byDefault: true },
  { id: 'walk', label: 'Walk', byDefault: true },
  { id: 'run', label: 'Run', byDefault: false },
  { id: 'dive', label: 'Dive', byDefault: false },
  { id: 'climb', label: 'Climb', byDefault: false },
  { id: 'jump', label: 'Jump', byDefault: false },
  { id: 'slash', label: 'Slash (the attack swing)', byDefault: true },
  { id: 'shoot', label: 'Shoot', byDefault: false },
  { id: 'hurt', label: 'Hurt (taking a hit)', byDefault: false },
  { id: 'fall', label: 'Fall', byDefault: false },
  { id: 'turn', label: 'Turn', byDefault: false },
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
 * Enough of a job to say what releasing its family would cost next time.
 *
 * Structurally satisfied by `JobView`, so the caller passes its jobs straight
 * in. Kept separate from {@link JobSummary} because only this decision needs the
 * clip list, and widening the summary would make every caller carry it.
 */
export interface FamilyJob extends JobSummary {
  readonly unitId: string;
  readonly params: { readonly clipIntents: readonly string[] };
}

/**
 * The jobs whose success is why a family is closed (spec 114).
 *
 * Normally one. More than one is possible and is not an error: two generations
 * of a brand-new family can be confirmed before either finishes, and both will
 * have been priced with a retarget. Releasing has to clear all of them or the
 * family stays closed by the one that was missed.
 */
export function familyOwners(jobs: readonly FamilyJob[], skeletonId: string): readonly FamilyJob[] {
  return jobs.filter(
    (job) => job.skeletonId === skeletonId && job.status === 'succeeded' && job.establishesRigFamily,
  );
}

/**
 * What a release will actually do, in the words the button needs.
 *
 * The number that matters is the retarget count, because that is the bill: the
 * next unit of this family stops reusing clips and buys one call per intent.
 * Saying "this is free" and stopping there would be true and useless -- the cost
 * is real, it is just deferred by one action, and a warning that hides that is
 * how somebody releases a family to try one thing and pays for eleven clips.
 */
export function releaseWarning(owners: readonly FamilyJob[]): string | null {
  if (owners.length === 0) return null;
  const clips = Math.max(...owners.map((job) => job.params.clipIntents.length));
  const who = owners.map((job) => `"${job.unitId}"`).join(', ');
  return (
    `Releasing costs nothing now. It un-owns the clip library from ${who}, and the next unit of ` +
    `this family will retarget again -- ${clips} paid call${clips === 1 ? '' : 's'} at the price ` +
    `the estimate quotes. Units already exported keep the clips they were exported with.`
  );
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
