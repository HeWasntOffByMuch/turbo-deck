# 163 — The run that looked at the floor

## Problem

The player character runs with its face pointed at the ground. Measured against
the biped rig's own bind pose, `biped.core/run` carries the chest **30 degrees**
forward of standing and throws the neck a further 55 past that, which puts the
gaze **54 degrees below the horizon** for every frame of the loop.

It is an outlier in its own clip library, and that is the clearest way to see
it. Every clip measured the same way:

| clip | gaze | lean |
|---|---|---|
| idle | −18 | +3 |
| walk | −18 | −2 |
| **run** | **−54** | **+30** |
| hurt | −53 | −7 |
| slash | −14 | +1 |

So walking to running snaps the head down 36 degrees and folds the back over,
and at this game's camera the result is the top of a head crossing a field. The
face is the thing a player recognises a character by, and it is only ever
visible while standing still.

The clip was bought — it came out of the retarget, from a source animation
written for a sprint. There is no document behind it to re-author: the pose *is*
the bytes.

## Shape

`src/units/posture.ts`, pure and beside `pose.ts` and `clip-sample.ts`:

```ts
export type PostureTable = Readonly<Partial<Record<BoneRole, number>>>;
export const RUN_POSTURE: PostureTable = { spine: 5, chest: 5, neck: 11, head: 11 };

export function pitchedPose(nodes, naming, frame, pose: PoseRotations, table): PoseRotations;
export function readPosture(nodes, naming, frame, pose): PostureReading | null;   // { gaze, lean }
export function recordedPosture(json): PostureTable;
export function postureDelta(target, applied): PostureTable;
```

**One angle per bone, constant over the clip.** Nothing about the stride, the
timing, the bob or the arm swing is touched — the relative motion between frames
survives by construction, and only the posture the whole loop plays in moves.
Nothing below the spine is named, so no correction here can move a foot.

**Every correction turns about one shared world axis** — the body's pitch axis,
level and fixed for the clip. Rotations about a shared axis commute, so a chain
of them composes by *adding the degrees*, and each bone's correction can be
computed against the **uncorrected** pose and still be exact once its ancestors
have moved too. That is the same argument `plant-foot.ts` uses to cancel the
pelvis's yaw at the hip without a solver.

**The axis comes from the parent's animated world frame, not its bind one.**
This is where `pose.ts`'s `turnQuat` cannot be reused: at bind the two agree, and
30 degrees into a forward lean they do not. A correction taken in the bind frame
arrives as a pitch mixed with a roll — a body straightening up and listing to one
side.

`scripts/straighten-run.ts` is the edit and `scripts/preview-run-posture.ts` is
the picture. The edit records what it applied in `animations[0].extras.posture`,
so a second run computes a delta of zero rather than bending the pig twice; the
preview reads that same record, so it draws the retarget against the correction
whichever state the bytes are in.

The numbers land the run at gaze **−24** and lean **+24**: within 6 degrees of
the family's own resting gaze, and still leaning into itself hard enough to read
as a run. `POSTURE=spine:8,chest:8,neck:14,head:14` was the candidate rejected
next to it — at −14 the snout comes level and the pig reads as trotting rather
than running.

## Invariants tested

`src/units/posture.test.ts`, against the real rig and the real clips off disk:

- an empty table returns the pose it was handed, entry for entry;
- **the degrees add along the chain**: 12 on the spine, 3 on each of four bones,
  or 12 on the head alone all turn the head by exactly 12 — measured on the
  head's *orientation* and not on the rise of its gaze, because a direction
  rotated 12 degrees about a level axis only changes its angle above the horizon
  by 12 when it lies in the sagittal plane, and this pig's head is turned a
  little at every frame of the stride. The first version measured the rise,
  scored a 12-degree correction as 11.4, and would have had the table tuned until
  the test agreed;
- it is a pitch and not a roll: the head's sideways component is unchanged;
- the hips, both feet and both toes are at identical world positions after;
- `postureDelta(t, t)` is empty, and a role dropped from the target is undone
  rather than left where it was;
- the committed `run.glb` records `RUN_POSTURE` in its own extras;
- the clip's mean gaze is above −30 and within 12 degrees of `idle`'s;
- its mean lean is still between 15 and 28 — the assertion that fails if somebody
  keeps turning the numbers up until the pig is standing.

## Out of scope

- **`hurt`, at −53.** It is the same fault and the same fix, but a flinch has a
  reason to duck and this brief is about the clip the character spends its
  moving life in.
- **Re-authoring the run.** The stride is fine; only the posture it is played in
  was wrong.
- **The `Hip` travel warning** `npm run validate:units` prints on `run` and
  `walk`. Pre-existing, handled at import, and about translation — this change
  touches rotation channels only.
- **The fox.** `biped.core` is a *family* library and the fox animates on it too,
  so this changes the fox's run as well. That is the format working as intended
  rather than a side effect to fix.
