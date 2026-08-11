# 127 — A family can learn a new clip

## Problem

Spec 108 retargets a family's clip library **once**, and spec 114 gave that
one-way door a handle: release the family and the next generation establishes it
again. Both treat the clip set as a single indivisible thing you either own or
throw away.

That is the wrong shape once there is more than one family. A roster has a
`biped` that needs `cast_a_spell` and five `hit_to_*` reactions, and a `pig`
that needs none of them and does need `defeat_02`; the humanoid rig model offers
a hundred and one presets and no family wants the same ten. Worse, what a family
needs is not known when it is established — the first unit ships, the state
machine gets authored, and only then does it turn out the fight needs a `turn`.
Today the only way to get it is to release the family and re-buy the mesh, the
rig and every clip that was already correct, to add one.

So: buy clips for a family that already has some, paying for the new ones only.

## Shape

A clip job: a job that spends money on retargets and nothing else. It is a
*new* job rather than a reopened one, because a succeeded job's `params` are
half its `cacheKey` and its `creditsSpent` is a ledger fact — editing either to
mean "and also these clips" corrupts both.

`src/server/studio/types.ts` — one new field, defaulted on read so the existing
`jobs.json` loads unchanged:

```ts
readonly kind: 'unit' | 'clips';      // absent in older records; read as 'unit'
/** For a clip job, the establishing job whose rig these clips are retargeted onto. */
readonly clipSourceJobId: string | null;
```

Pure, in `src/server/studio/jobs.ts`:

```ts
/** The establishing job of a family, and the rig task a retarget can name as input. */
export function familyRig(jobs: readonly Job[], skeletonId: string):
  { jobId: string; rigTaskId: string } | null;

/** Every clip intent the family already owns, mapped to the job that bought it. */
export function familyClips(jobs: readonly Job[], skeletonId: string):
  Readonly<Record<string, { jobId: string; path: string }>>;

export function createClipJob(input: CreateClipJobInput, nowMs: number): Job;
```

`createClipJob` marks `imageToModel`, `rigCheck` and `rig` as `skipped` at
creation for the same reason spec 108 marks a reusing job's `retarget` skipped:
whether they run is known now, and a `pending` row that never moves reads as a
stall. `nextStage`'s gate stops asking `establishesRigFamily` directly and asks
one derived predicate — `retargets(job)`, true for an establishing job and for a
clip job — so the shared-skeleton rule stays one line and one meaning.

Pricing, in `pricing.ts`: a clip job's projection is the retarget line alone.
The intents it prices are the requested set **minus what `familyClips` already
holds**, so a set that overlaps is quoted at the difference and a set that is
entirely owned is quoted at zero and refused rather than sold.

Routes, the same two-call money door everything else goes through:

```
POST /api/studio/families/:skeletonId/clips/estimate  { clipIntents }
  -> 200 { projection, confirmationToken }
  -> 404 when no succeeded job establishes that family
  -> 409 when every requested intent is already owned

POST /api/studio/families/:skeletonId/clips  { clipIntents, confirmationToken }
  -> 202 JobView   (a clip job, already running)
```

Client: `StudioApi.estimateFamilyClips` / `addFamilyClips`, and an "Add clips…"
control beside spec 114's release button — the same shortlist-plus-search picker
the ingest form draws, with the family's existing intents ticked and disabled so
the thing you cannot buy twice cannot be asked for twice.

Export unions: a unit's clip set becomes `familyClips(jobs, job.skeletonId)`
rather than `job.artifacts.clipGlbs`, which is also what finally gives a
*reusing* unit a `cliplib.json` — today it exports none, because the clips are
on another job's record. Provenance follows the clips: `tripoTaskIds.retarget`
lists the task ids of every job that bought a clip in the library, because
provenance is what happened.

### The interaction with release

A clip job records `clipSourceJobId`, and `familyClips` counts only clips whose
source job is the family's *current* establishing job. This is the whole reason
the field exists. Release-then-re-establish (spec 114) produces a second rigged
mesh with different bone transforms; clips retargeted onto the first one are not
clips of the new family, and a union keyed on `skeletonId` alone would silently
hand a fresh family a set of poses built for a rig it never had.

### The thing that cannot be known without spending

`retarget` names its input as a Tripo task id (`tripo.ts:632`), and whether the
API still accepts a rig task from weeks ago is not documented and not
discoverable for free. Retarget is already one preset per call, so the exposure
is bounded by construction: a clip job submits its first clip alone and, if the
source is refused, **blocks** rather than failing — nothing further is sent, and
the message says the family's rig is no longer addressable and the way back is a
release. One call's worth of credits is the price of finding out, once per
family, instead of N.

## Invariants tested

- A clip job prices and buys only the intents the family does not already have;
  an overlapping request is quoted at the difference and an entirely-owned one
  is refused with nothing sent.
- `nextStage` reaches `retarget` for a clip job and still never reaches it for a
  reusing unit job — the spec 108 rule survives the new gate.
- A clip job never runs `imageToModel`, `rigCheck` or `rig`, in either
  direction: no stage of it can charge for a mesh.
- `familyClips` returns only clips whose `clipSourceJobId` is the family's
  current establishing job, so a released-and-re-established family starts empty
  even with succeeded clip jobs of the old rig on record.
- Releasing a family does not delete, refund or rewrite a clip job. Same rule as
  spec 114: what was paid for was paid for.
- A unit exported after a clip job carries every clip of the family — including
  a *reusing* unit, which exported no `cliplib.json` at all before this — and
  its `provenance.tripoTaskIds.retarget` names every job that bought one.
- A refused source task blocks the clip job at its first clip with at most one
  retarget charged, and the job's remaining intents stay unbought.
- Preset names are validated against `knownPresetsFor` before anything is sent,
  so an unknown name is a free refusal on this path exactly as it is on the
  ingest path.
- The estimate/confirm pair binds the quoted price to the spend: a token is
  one-shot, keyed to the family and the intent set, and a second POST with the
  same token is a 409.
- An older `jobs.json` with no `kind` field loads with every job as `'unit'` and
  every family's clips unchanged.

## Out of scope

- Removing a clip from a family, or re-buying one that came back bad. That is
  what release is for, and a per-clip redo needs a per-clip identity the
  artifacts do not have yet.
- Editing the state machine to use the new clips. The clips arrive in the
  library; wiring them into states and action timings is the Preview tab's job
  (spec 110) and stays hand-authored.
- Moving clips between families, and any notion of a shared base library one
  family inherits from another.
- Re-exporting affected units automatically. Adding a clip changes what a later
  export writes; when that export happens is still the author's call, and
  `npm run bake:units` still owns the manifest.
