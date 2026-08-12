# 112 — A button on the thing you paid for

## Problem

Reported as a question: *"once it's available in the library can I preview it? I
don't see a button for it."* There was no button. The pipeline read

```
generate  ->  library  ->  ???  ->  export
```

and the gap in the middle was the same gap twice.

**The library was a receipt.** A finished job rendered as unit id, credits, face
limit, clip names and file paths. Nothing you could look at.

**Export could not finish.** It refuses to invent a clip duration — a made-up
one validates and then silently rescales every action timing, which is the
failure the whole format exists to prevent — and it refuses to invent a state
machine, because a unit with no states is not a unit. Both refusals are correct.
Nothing supplied either, so for a freshly generated unit Export copied the
`.glb`s and reported that it had written no unitdef.

The preview turns out to be the missing middle, because it is the only thing
that holds both of Export's missing inputs: it loads the `.glb`s, so it knows
the real clip lengths and the real size of the rig.

## What it does

1. **A Preview button on each library card**, pointing the preview at that job.
2. **The documents are scaffolded from the clips that exist**, once they have
   been loaded and measured.
3. **Export, for the job being previewed, writes what is on screen** — including
   every retune.

## Data and API shape

```ts
// src/units/scaffold.ts — pure
scaffoldClipLib(input: ScaffoldInput): ClipLib
scaffoldStateMachine(input: ScaffoldInput, maxTimeScale?): StateMachine

// src/render/iso3d/unit-rig.ts — three.js
UnitRig.durationsMs(): Record<string, number>   // measured off the loaded clips
UnitRig.fitToHeight(target: number): number     // measured off the bounding box

// preview-panel.ts
PreviewSource.deriveOnLoad?(durationsMs, importScale): { unit, clipLib }
PreviewSource.fitToHeight?: number
PreviewHandle.documents(): { unit, clipLib }
```

## The rule the scaffold follows

**Emit only what the runtime can drive.** `unit-driver.ts` writes exactly three
things — `speed`, `dead`, and an `attack` trigger — so those are the parameters,
and every state is reachable by one of them. A `climb`, a `jump`, a `turn` would
all validate and look thorough, and nothing in the game would ever enter them. A
starting point full of unreachable states is worse than a small one, because it
reads as finished.

So the machine grows with the clip set: an idle alone gets one state; a walk
adds the locomotion blend; a `slash` adds a locking swing and a `basic.attack`;
a `fall` adds a terminal death. Nothing else.

The action's wind-up, active and recovery are **split out of the clip's own
length**, so the rate is exactly 1.0 and the scaffold stretches nothing before
anybody has looked at it. Retuning that is the entire purpose of the panel, and
the 2× bound is what catches a retune that went too far.

## Two numbers that are measured rather than chosen

- **Clip durations**, off the decoded `.glb`. This is the number Export refuses
  to guess.
- **Import scale**, off the loaded model's bounding box against the skeleton's
  `canonicalHeight`. A generated rig arrives at whatever size its generator
  chose, and inheriting the reference unit's 32.35 would draw every generated
  unit at a size that is simply wrong. With the player silhouette standing
  beside it, wrong by 40% is obvious and wrong by 5% is not.

## Invariants to test

- The scaffold's output validates through the same parser both callers use, for
  every clip subset from one clip to the full set.
- A scaffolded machine actually runs: reaches locomotion from speed, swings on
  the trigger, dies on the flag, and does not get back up from a terminal state.
- The action timing sums to the clip's real length, so the rate is 1.0.
- No state is emitted for a clip no parameter can reach.
- Loop flags follow the preset, not a guess about the name.
- The preview loads a generated unit's files through the authenticated client —
  three's loader sends no headers of its own, and the artifact route is behind
  the admin token like everything else that reads a paid job.
- Export for the previewed job carries the panel's current documents; for any
  other job it carries none and says so rather than half-working.
- Previewing a unit whose correct import scale is known lands on it.

## Out of scope

- Editing which clips a unit has, or re-retargeting from the panel. The clip set
  is what the job bought.
- Previewing a job that failed. Half a job's files are on disk after a failure
  and showing them as a unit would be the same mistake the cache makes when it
  serves one.
- Writing back to a unit that has not been exported. There is no document on
  disk yet for an edit to land in, and the panel says so rather than accepting
  a write that goes nowhere.
