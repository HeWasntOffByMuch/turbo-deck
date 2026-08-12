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
vertex on the skinned mesh, over the whole cycle — which is what
`scripts/probe-turn-swing.ts` below prints:

| pose | furthest vertex from the pivot | body centre off the pivot | drawn height |
|---|---|---|---|
| bind | 21.0 | 0.0 | 55.7 |
| walk | 17.5 | 1.1 | 54.6 |
| run  | **28.3** | **6.3** | 45.9 |

Running reaches 60% further than walking, so at 690 deg/s the furthest point
travels at **341 world units per second — 2.20x the pig's own run speed of 155**.
A reversal displaces it 57 units, more than the running body's own height, in
261ms. At 540 the same pose sweeps 266 units/s, or 1.72x.

**The pivot sits behind the body while running.** The bind pose is centred
exactly: XZ centre (0.0, 0.0), height 55.7 against a `canonicalHeight` of 55.65.
Nothing is wrong with the mesh or the import scale. What is wrong is that
`correctTravel` pins the **hips'** mean along the travel axis to their bind value
(spec 118), which is right for an upright pose and wrong for a leaning one:
pinning the hips throws everything above them forward. The body's own centre
sits 6.3 units off the pivot in run against 1.1 in walk. The offset exists only
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
effective turn rate. It exits non-zero when a pose's peak tangential speed passes
`MAX_SWEEP_RATIO` times the body's own move speed — a body whose extremities
outrun it is the definition of the fault, and it is a ratio rather than a
constant so it survives a re-tune of either number.

`MAX_SWEEP_RATIO` is 2, which admits the tree at 540 (the run pose reaches 1.72)
and refuses it at 690 (2.20). That is the only useful place for a gate to sit: it
is the regression test for this change, and it is what makes the two fixes this
spec leaves alone measurable when somebody comes to do them.

The arithmetic on top of the measurement is separated out into
`src/render/iso3d/turn-swing.ts` — lever arm to tangential speed, the chord a
reversal displaces a point by, and the ratio against the body's own speed — so
that relationship is asserted by `npm test` in CI even though the measurement
itself is not. It is not, and this spec does not pretend otherwise: reaching a
pose needs a loader and a skinned mesh, so this sits exactly where
`probe-travel.ts` sits, a script somebody runs. Making it a CI gate would mean a
pure glTF animation sampler beside `skin.ts`, which does not exist yet.

`scripts/preview-turnaround.ts` — and the picture, because a number cannot say
whether a turn reads as a manoeuvre:

```
npx tsx scripts/preview-turnaround.ts [unitDir]
```

It steps `turnToward` through a reversal at the effective rate, poses the real
skinned pig on each sampled tick, yaws it the way `scene.ts` does, and rasterises
the frames in software — the same z-buffered renderer approach
`preview-critters.ts` uses, so it needs no browser and no GL context. Out come a
labelled strip (one cell per sampled tick, captioned in milliseconds with the
HUD's own glyph table) and an envelope: every heading of the turn in one cell, so
what the body sweeps is a single shape.

Rendered rather than photographed, and that is a measurement rather than a
preference. This environment's software renderer paints the real page at about a
frame a second, so a screencast of a 333ms turn returns *one* frame — the first
version of this script drove the real Play tab, held W, reversed, captured the
whole turn between two paints, and captioned every frame "the turn is over".
Stepping the turn also makes the strip exact rather than lucky: each cell is a
known tick rather than whatever the compositor happened to deliver.

Two rules the pictures depend on. **The window is fixed in world space** rather
than framed to the subject, because auto-framing each cell would hide the one
thing being shown — that the body moves while turning. And **the collider is
drawn**, a 16-unit ring on the ground with the pivot at its centre: "the snout
is 28 units out" is a sentence, and a snout well outside its own footprint is a
picture.

## Invariants tested

- `CHARACTERS[0].turnRate + TURN_RATE_PER_AGILITY * 5` is exactly 540: the
  effective rate a fresh character turns at, asserted as the derived number
  rather than as the base, because the base is not what anything reads.
- Dexterity still buys a faster pivot, and the per-point value is unchanged, so
  an agile character is still expressible.
- A 180-degree reversal takes 20 ticks and not 19, measured through `turnToward`
  itself at the effective rate rather than through the stat that parameterises
  it — and the old 690 is asserted alongside it, because "arrives in the ticks
  the rate implies" is true of any rate and would not notice the base going back.
- `probe-turn-swing` reports the pig's run pose as its widest, and holds every
  pose's peak sweep under `MAX_SWEEP_RATIO` of the body's move speed.
- The arithmetic is exercised headlessly against the pig's measured reach: the
  run pose is inside the budget at the rate this spec sets and outside it at the
  rate it replaced, so the gate is asserted at both ends rather than only at the
  one that passes.
- A reversal is the worst turn there is: the chord peaks at 180 degrees and
  shortens on either side, which is why that is the number reported.
- Tangential speed is linear in both the arm and the rate, and a body that
  cannot move is never a finding however far it reaches.

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
