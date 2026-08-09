# 114 — A rig family can be let go

## Problem

Spec 109 derived "does this generation establish the rig family" from the
library rather than from a checkbox, because the shared-skeleton rule is money:
the clip library is retargeted once per family and every later unit reuses it.
`establishesRigFamily(jobs, skeletonId)` is false the moment one succeeded job
of that family has it set.

That is a one-way door with no handle on the far side. The first `biped` job to
succeed owns the family's clips forever — including the case where it succeeded
and the clips are *bad*: a rig that twisted, a reference image shot at an angle,
a retarget nobody would ship. Every later unit of the family then inherits a
clip set the author has already rejected, and the only way out is to invent a
second family name (`biped2`) whose only purpose is to not be the first one.
That leaves a roster whose families are numbered by how many attempts it took.

So: a way to say "that job no longer owns this family", from the UI, for free.

## Shape

Pure, in `src/server/studio/jobs.ts`:

```ts
/** Clears family ownership from every succeeded job of a family. */
export function releaseFamily(
  jobs: readonly Job[],
  skeletonId: string,
  nowMs: number,
): readonly Job[];   // only the jobs that actually changed
```

Route, free and behind the same admin gate as everything else:

```
POST /api/studio/families/:skeletonId/release
  -> 200 { skeletonId, released: JobView[] }
  -> 404 when no succeeded job owns that family
```

Client: `StudioApi.releaseFamily(skeletonId)`, and a button beside the ingest
form's existing "Retarget skipped: the rig family already has its clips" line.
The button states what it will cost *next time* — releasing is free, the
generation after it buys a retarget per clip — and asks for a confirm, because
it changes the price of the next thing the user does.

No confirmation *token*: a token exists to bind a quoted price to a spend, and
this spends nothing. The price it changes is quoted by the next `/estimate`,
which is where it belongs.

## Invariants tested

- `releaseFamily` clears `establishesRigFamily` on succeeded jobs of that
  family and returns exactly those, leaving other families untouched.
- A job that is not succeeded is not touched, in either direction: a failed job
  never owned the family, so releasing cannot silently "un-own" it and make
  `projectRemaining` price its retargets differently.
- Released jobs keep `creditsSpent` and every `taskId`. What was paid for was
  paid for; releasing is a statement about the future, not a refund.
- After a release, `establishesRigFamily(jobs, family)` is true again, so the
  next estimate includes the retarget line and the next job runs the retarget
  stage instead of marking it `skipped`.
- Releasing twice is a no-op with an empty `released`, and the route 404s
  rather than reporting a release that released nothing.
- The exported unitdef of an already-released job still records the retarget
  task ids it really ran (`provenance.tripoTaskIds.retarget`), because
  provenance is what happened.

## Out of scope

- Deleting a job or its artifacts. Release is about ownership, not storage.
- Moving ownership from one job to another directly. Release then generate is
  two visible steps and one of them costs money; a "transfer" hides that.
- Anything about the `.glb` clips already exported into `assets/units/`. A
  released family's clips stay on disk until a new export overwrites them —
  the repo is a git working tree and deleting from it is the author's call.
