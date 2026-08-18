# 164 — A bow that is not a sword

## Problem

The Hunting Bow is a level-1 weapon with `basicAttackId: 'ranged.shot'`, so a
player can equip one in the first minute and shoot arrows 420 units. The pig
answered every one of those shots with the sword chop.

Two halves were missing and only one of them is an animation.

**There is no draw.** The retarget sold `idle`, `walk`, `run`, `hurt` and
`defeat_02`, and spec 139 authored `slash` because the bought swing was written
for a reach and a commitment this game does not have. Nothing was ever authored
for the bow.

**One trigger cannot pick two animations.** `driveUnit` has raised a single
`attack` trigger on the first tick of every cast since spec 111, and the pig's
machine has one attack state. Even with a draw clip in the library there was no
path by which a shot could reach it, because nothing on `UnitFacts` said which
ability was being cast — a sword coming over the shoulder and a bow being pulled
are the same `Casting` activity on the wire.

## Shape

**`src/units/pig-shot.ts`** — seven key poses over 1150ms, the same table shape
as `pig-strike.ts`, in the body's own measured axes. `ranged.shot` has
`windupTicks: seconds(0.8)` and `backswingTicks: seconds(0.35)`, so the arrow
leaves at **800ms** and the recovery is the 350 after it. The user-facing
division — wind-up, shot, recovery — is `attack-timing.ts`'s division exactly:
the draw is the span a withdrawal still refunds, the loose is the attack point,
the recovery is the backswing that can be walked out of for free.

Three places it deliberately inverts the swing:

- **The release is a velocity discontinuity.** `pig-strike.ts`'s hardest-won
  rule is that a raise is one movement; its wind-up used to stall in the middle
  and read as two raises. A draw is pulled, *held still while it is aimed*, and
  then let go instantly. `anchor` is arrived at and left at opposite speeds. In
  a swing that is a dead beat and a whip; in a shot it is the aim and the loose.
- **The body does not unwind.** A chop passes through square. An archer's chest
  keeps turning the same way through the loose, because what sends an arrow is
  back tension rather than rotation. Only the string hand travels.
- **The stance never moves.** Every key holds the same `hips` and the same six
  leg angles — the sword's own guard legs, shared as an object rather than
  copied, so both clips cross-fade out of the idle with the same knees. The
  swing needs `scripts/plant-foot.ts` because it yaws its pelvis 54 degrees; a
  clip whose legs are *identical* in every key cannot slide a foot, and gets the
  property by construction instead of by a solver.

**`scripts/aim-bow.ts`** — both arms, solved. `aim-blade.ts` aims one arm at a
direction a blade must point; a bow has no direction to state (no bow mesh, and
the aim is the body's facing, which the server owns) and two arms that are not
independent. So this states **where each hand is** and answers with the
shoulder and the elbow.

The improvement over `aim-blade.ts` is that **the elbow is derived rather than
wished for**. That file learned that a hand target and an elbow target are a
linkage, not two wishes — asked for a pair 0.071 apart on an arm whose segments
are 0.178 and 0.114, its solver split the difference and put the elbow in the
ribs. Here the author states the hand and a **roll** — how far round the
shoulder-to-hand axis the elbow sits, zero hanging straight down — and
`elbowFor` computes the only elbow consistent with it. A pose that does not
close is impossible to write rather than merely visible later.

**`scripts/make-pig-shot.ts`** writes the committed `assets/units/clips/shoot.glb`;
**`scripts/preview-shot.ts`** photographs it. The preview draws a **string** — a
bar between the two hands — rather than a bow, because there is no bow mesh and
a proxy invented in a preview script is a prop the game does not have. The bar
is a measurement: a draw *is* the distance the hands get apart, and a column
where it is short is a column where the pig is not drawing.

**The wiring.** `UnitFacts` gains `abilityId`, `scene.ts` fills it from
`view.casts`, and `attackTriggerFor` decides which trigger to raise:

```ts
abilityById(id)?.projectile?.look === 'arrow' ? 'shoot' : 'attack'
```

**Read off what the ability sends, not off a list of ids.** A thrown star and an
arcane bolt keep the swing, because nobody has authored a clip for them and a
wrong animation is worse than a generic one. A unit with no `shoot` parameter —
the fox, the dev mannequin — also falls back to the swing, because a silently
dropped trigger is a body standing perfectly still through its own attack, which
is worse than a generic animation and much harder to notice.

The pig's unitdef gains a `shoot` trigger, a `draw` state on the new clip, a
`* -> draw` transition and a `ranged.shot` action timing. `draw` is `oneshot`
rather than `locking` for the reason the unitdef already gives about `swing`.

## Invariants tested

`src/units/pig-shot.test.ts`, against the real rig and the real committed bytes:

- the loose is at `ranged.shot`'s wind-up **to the millisecond**, and the tail
  fits inside its backswing;
- the committed `.glb` has the frame count and the length this table implies, so
  a table edited without re-running the writer fails rather than ships;
- the gap between the hands **more than doubles** across the draw and keeps
  opening through the loose;
- the string hand never stalls while it is being pulled, and *does* settle into
  full draw — two separate claims, because the second one looks like the first
  one failing;
- the aim creeps rather than freezing, bounded as a **fraction of the whole
  draw** so it is a claim about the shape rather than about this rig's arm;
- the loose is at least three times faster than the draw;
- the bow arm moves less than 0.03 through the entire draw and loose;
- **no foot, toe or hip moves on any frame** — asserted as equality, not as a
  tolerance;
- the chest's turn is monotone into the loose, and the head keeps pointing down
  the shot while it happens.

`src/render/iso3d/world/pig-shoot.test.ts`, for the half that only exists once
the driver and the document are in the same room:

- a shot enters `draw` and a slash still enters `swing`;
- a star and a bolt still swing, and an unknown id still swings;
- the `swing.impact` event lands on the tick the sim resolves the shot, and
  still does at double attack speed — the clip is rescaled to the timing, never
  the other way round;
- a machine with the `shoot` parameter stripped falls back to `swing`;
- the Hunting Bow really does grant `ranged.shot` at level 1, so the bug this
  fixes is reachable rather than theoretical.

Three things were got wrong first and are worth the note:

- **the draw stalled at the nock.** An eased arrival meeting an eased departure
  is zero velocity on both sides of a beat nobody meant to put there — the exact
  fault `pig-strike.ts` documents, reproduced by not reading it carefully
  enough. The draw is `in`, `linear`, `out` now: accelerate, cruise, settle.
- **the string hand cannot go straight to the anchor.** The direct route passes
  within 0.04 of its own shoulder, which is a 160-degree fold on this arm — not
  a draw, a broken elbow. It goes outboard round the ribs instead, which needed
  a seventh key, and is what a draw seen from above actually does. The measured
  limit is that a hand closer than ~0.156 to the shoulder is past 120 degrees of
  fold; `aim-bow.ts` prints it rather than anybody remembering it.
- **the chest's turn was measured on the clavicles**, which sit 0.037 apart on
  this rig against the shoulder joints' 0.232. A 28-degree turn read as a
  hundredth of a body, and the threshold would have been tuned down to meet it.

## Out of scope

- **A bow mesh.** There is none, `weapon.off` carries no calibration to hang one
  from, and this spec does not invent one. The shot reads from the body.
- **The throwing star and the arcane bolt.** Both still swing. Each wants its
  own clip and neither is this brief.
- **The fox.** It has no attack state at all, which is unchanged.
- **Anything in the sim.** No timing, damage, range or cadence moves; this is
  the picture catching up with numbers that were already there.
