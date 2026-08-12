# 139 — A pig does not pivot like a cow

## Problem

Turning the player whips it around. Turning it *around* — a reversal — throws
the body through an arc that reads as a glitch rather than as a manoeuvre. Three
things multiply together to produce it, and only the first is being changed here.

**The turn rate was tuned for a different body.** `CHARACTERS[0]` is the
player's base movement (spec 081) and it carries `turnRate: 540`, raised from
the Warden's 180 because the *cow* rig "read as sluggish… like it is deciding
rather than turning". `stats.ts` then adds `TURN_RATE_PER_AGILITY` (30) per
point of dexterity, and a fresh character has 5 of them, so the number the sim
actually turns at has never been 540 — it is **690 degrees per second**, a
180-degree reversal in 261ms. The 540 in the table is a number nobody plays at.

**The run pose is a lever arm.** Since spec 111 the player is drawn as
`pig_a_pose_full`, and its run clip pitches the torso 36 degrees forward against
the idle's 3. Measured off the real unit through the real `UnitRig`, vertex by
vertex on the skinned mesh:

| pose | snout ahead of the pivot | furthest vertex from the pivot | drawn height |
|---|---|---|---|
| bind | 13.6 | 19.2 | 55.7 |
| walk | 14.5 | 19.6 | 54.9 |
| run  | **27.9** | **31.2** | 45.4 |

Running doubles the body's forward reach, so at 690 deg/s the snout's tangential
speed is **336 world units per second — 2.2x the pig's own run speed of 155**.
A reversal displaces it 55.8 units, one whole body height, in 261ms.

**The pivot sits behind the body while running.** The bind pose is centred
exactly: XZ centre (0.0, 0.0), height 55.7 against a `canonicalHeight` of 55.65.
Nothing is wrong with the mesh or the import scale. What is wrong is that
`correctTravel` pins the **hips'** mean along the travel axis to their bind value
(spec 118), which is right for an upright pose and wrong for a leaning one:
pinning the hips throws everything above them forward. The body's visible XZ
centre is (7.9, 0.0) in run against (0.8, -0.9) in walk. The offset exists only
in the pose you turn fastest in.

Two further multipliers, recorded here because they are part of the same
picture: turning neither slows the body nor softens the pose (translation comes
from the input direction and facing is resolved separately, so a reversal slides
the body backwards at full speed while the snout comes round, with the blend
parameter pinned at a speed of 155 against a run threshold of 150 — a moving
player is in pure, fully-committed run with no intermediate); and the authored
unit path has no turn treatment at all, where the procedural critter rig it
replaced measured its own turn rate and banked into corners
(`critter.ts:701`, `motion.ts:123`).

## Shape

One number changes, and a probe is added that would have caught this.

`src/sim/characters.ts` — the base comes down so that the rate the sim turns a
*fresh* character at is the 540 the table has claimed since spec 081:

```ts
{ name: 'Cow', moveSpeed: 155, turnRate: 390 }   // 390 + 30 * 5 dexterity = 540
```

`TURN_RATE_PER_AGILITY` is deliberately untouched at 30. The per-dexterity term
is how an agile character is expressed, and flattening it would trade this
problem for a duller one. What changes is where the ladder starts, not its
slope.

`scripts/probe-turn-swing.ts` — the measurement above, committed and executable:

```
npx tsx scripts/probe-turn-swing.ts [unitDir]
```

It loads a unit through the real `UnitRig`, applies each clip's poses, skins the
mesh on the CPU at each of them, and reports per clip the body's XZ centre, its
furthest vertex from the pivot, and what that lever arm does at the player's
effective turn rate. It fails when a pose's peak tangential speed passes
`MAX_SWEEP_RATIO` times the body's own move speed — a body whose extremities
outrun it is the definition of the fault, and it is a ratio rather than a
constant so it survives a re-tune of either number.

The threshold admits today's tree at 540 and refuses it at 690, which is the
only useful place for a gate to sit: it is the regression test for this change
and it is also what makes the two fixes this spec leaves alone measurable when
somebody comes to do them.

## Invariants tested

- `CHARACTERS[0].turnRate + TURN_RATE_PER_AGILITY * 5` is exactly 540: the
  effective rate a fresh character turns at, asserted as the derived number
  rather than as the base, because the base is not what anything reads.
- Dexterity still buys a faster pivot, and the per-point value is unchanged, so
  an agile character is still expressible.
- The floor in `computeEffectiveStats` still holds: no combination of modifiers
  puts a player's turn rate below 30.
- A 180-degree reversal takes strictly longer than it did, and takes
  `180 / turnRate` seconds at the sim's tick rate — `turnToward` is unchanged,
  so the turn is still one rule in one place.
- `probe-turn-swing` reports the pig's run pose as its widest, and holds every
  pose's peak sweep under `MAX_SWEEP_RATIO` of the body's move speed.
- The probe's arithmetic is exercised headlessly: lever arm, tangential speed
  and the reversal's displacement from a known arm and rate.

## Out of scope

Named, because each is a fix this spec measured and declined:

- **Recentring the leaning pose.** Offsetting the root by the body's own XZ
  centre would put the pivot under the mass instead of under the hips and cut
  the run's lever arm from 28 to about 20, with no gameplay effect whatsoever.
  It is the largest remaining win and it belongs in its own spec, because it
  changes what `correctTravel` means.
- **Bounding angular acceleration.** `turnToward` steps from nothing to the full
  rate on the first tick and stops dead on the last. Easing it would remove the
  whip-crack quality independently of the peak rate, and it lengthens cast
  alignment, so it is a combat change and wants its own argument.
- **A turn rate that falls off with speed**, and **banking into the turn** as an
  additive spine layer, which `UnitRig` has no facility for today.
- **The run clip's 36-degree lean itself.** It is what makes running read as
  running.
- Two adjacent faults this measurement surfaced and did not chase:
  `UnitRig.drawnHeight()` reports 17.9 for a body that is really 55.6 tall,
  because `Box3.setFromObject` on a `SkinnedMesh` reads the bind-space geometry
  box through the node matrix and means nothing — `fitToHeight` uses it. And the
  `hurt` clip puts the body 12 units below the ground.
