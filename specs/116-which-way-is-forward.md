# 116 — Which way is forward

## Problem

A generated unit faces the camera and walks backwards. Every file in the chain
loads without an error, the preview shows a body that is clearly the right way
up, and the walk is clearly wrong.

Four different things produce that symptom, and they have four different fixes:

- the **mesh** was generated facing one way and the auto-rig fitted a skeleton
  into it facing the other, so every clip plays backwards and no clip is at
  fault;
- the **clip** was retargeted against a rig whose forward is not this rig's;
- the **clip file's rest pose** differs from the mesh file's, and since the
  renderer binds clips by bone name onto the mesh's skeleton
  (`unit-rig.ts`), that difference is applied to every frame as an error
  nobody logged;
- the **legs are swapped** — which is not independent, because a rig fitted
  180° around implies it.

Nothing in the repo can tell them apart. `forwardAxis` in a skeleton document
is an *assertion*: it is read by one test, which compares it against the
constant `+X`, and by nothing at import. `import.upAxis` is read by nothing at
all. Meanwhile the scene yaws every body by `-facing` on the strength of every
rig facing +X, and the export stamps a generated unit as conforming to
`biped.skeleton.json` — which claims `+X` for a rig nobody measured.

So the only way to choose between the four was to generate another unit and
look at it. That costs credits and does not answer the question.

Spec 115 established that the failures that actually happen are in the vertex
data. This is the same argument one axis over: the failures that actually
happen to a unit's *orientation* are in the geometry and the animation, and
both are measurable offline.

## Shape

Pure, `src/units/facing.ts`, over spec 115's `glb-read.ts` — one binary reader
in the repo, not two:

```ts
export function rigFacing(nodes: readonly GlbReadNode[]): RigFacing;
// ankle-to-toe, both feet; plus where the bones named Left* actually are

export function meshFacing(mesh: SkinnedMeshData): MeshFacing;
// geometry only: a thin slice at the feet and one at the head, against the torso

export function clipFacing(glb: GlbBinary, animation?: number): ClipFacing | null;
// the stance foot, which slides backwards under a body going forwards

export function restPoseDeltas(mesh: GlbBinary, clip: GlbBinary): readonly RestDelta[];
// per bone, how far the two files disagree about rest

export function facingReport(input: FacingInput): FacingReport;
// the four measurements, turned into findings with a cause named in each
```

Three surfaces over the one report, because the three questions are asked at
different times:

- `npx tsx scripts/probe-facing.ts --job <id>` — the terminal, during a debug;
- `GET /api/studio/jobs/:id/facing` — read-only, free, behind the same verifier
  as everything else;
- a **Check facing** button on the library card, beside Preview, which is where
  somebody is standing when they notice the walk is wrong.

The clip's forward comes from the stance foot rather than from root motion:
root translation is stripped at import, so by the time anything is drawn it is
gone, and an estimator that needs it would answer only for files nobody plays.

Every estimator can be wrong, so the report carries all of them and each names
what it is blind to. A slice with no asymmetry reports *no answer* rather than
the direction its rounding went.

## Invariants tested

- The reference unit — authored facing +X — measures +X on all three, and its
  walk and run stride +X. It is the control: it is how a broken unit is told
  from a broken probe.
- Each of the four faults, introduced on purpose against that same unit, is
  caught and named: the mesh turned around inside its rig, the pose mirrored
  front to back, the clip's rest pose yawed, the leg bones' names swapped.
- An idle is not asked which way it goes. The estimator fits a slope through a
  foot that does not move, and an answer from that is noise with a direction.
- The report is a pure function of the bytes: the CLI, the route and the button
  cannot disagree about what a unit is doing.

## Out of scope

- **Fixing** a facing fault. This measures; it does not rotate anything. Making
  the loaded rig honour `forwardAxis` is a change to what the game draws and
  wants its own spec, and it wants this one's numbers first — a correction
  applied on top of an unmeasured assertion is how the second 180° gets added
  to the first.
- Non-biped rigs. The estimators read feet, hips and a head. A quadruped is
  measurable by the same argument but not by the same bone names, and guessing
  at that vocabulary would produce confident answers about the wrong bones.
- Deciding which `orientation` to generate with. The report is the evidence for
  that decision; the decision spends money and stays with a person.
