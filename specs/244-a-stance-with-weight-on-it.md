# 244 — A stance with weight on it

## Problem

The combat stance is not standing on anything. `STRIKE_GUARD_LEGS` is the pose
`slash`, `shoot` and `cast` all hold their legs in, and measured against the rig
it was authored for it is a body falling forwards with its feet in the air.

Three numbers, all measured through `poseWorldMatrices` off the committed
`pig_a_pose_full.glb`, in rig units against a body 0.998 tall:

**The pelvis is in front of the feet.** Taking the support span as rear ankle to
leading toe, the hips sit at **157%** of it at the guard — 0.064 past the
leading toe — and stay outside it through `rise` (141%), `coil` (132%), `load`
(130%) and `contact` (111%). The idle, which is the pose the game actually shows
and the one all three clips cross-fade from, sits at 1–42%: over its own feet,
the way a body stands. A pelvis past the toes is a body that has already started
to fall, and it is the stance every fight in this game is thrown from.

**The feet are off the floor.** The idle rests its left toe at u 0.029 and its
right at 0.021. The guard holds them at 0.050 and 0.059, and through the wind-up
the right foot climbs to **0.098** — 0.077 above the ground the idle stands on,
7.7% of body height, during the beat that is documented as a brace. The clip is
rotation-only and the server owns where the body is, so the root cannot drop to
meet a raised foot: a foot higher than the idle's is a foot in the air.

**The bend is bought by swinging the foot backwards.** `leftLeg: { lateral: 30 }`
turns the shin about the knee, and on this rig positive `lateral` carries a
hanging limb *backwards* — so the knee bend is paid for by taking the ankle back
and up rather than by the knee travelling forward over a planted foot. That one
mechanism is the cause of both numbers above: the left ankle ends 0.079 behind
where the idle plants it and the right 0.178 behind, which is the whole of why
the pelvis is in front of them.

And the legs do not answer the blow. The planted left knee reads 30.4° at the
guard, 28.7° at the load and 31.2° at contact — flat, and *straightening* through
the wind-up, when the wind-up is the beat the weight is meant to be sinking into.
The right knee does the opposite and worse: 29.9° → 15.3° → 10.6° → **10.4°** at
the load, a rear leg locked out nearly straight while it is supposed to be
bracing, then **54.0°** at contact. 44 degrees of knee in 100ms, from a locked
joint.

Nothing was asserting any of it. `pig-strike.test.ts` bounds how far the left
foot *slides* and how far the right foot *steps*, which are claims about
horizontal travel, and there was no claim anywhere about height, about balance,
or about the knee.

## Shape

### The rig decides how much of this is available

Measured off the bind pose: the left leg's thigh is 0.2337 and its shin 0.1329,
a reach of 0.3667, and its hip sits 0.3660 above the bind ankle. The right is
0.1930 + 0.1495 = 0.3426 against a drop of 0.3415. **Both legs are straight in
bind and stand exactly as tall as they are long**, and the root may not translate
— so on this rig knee bend and foot height are the same quantity, and every
degree of bend lifts the foot. There is no pose that is both deeply bent and
flat on the floor, and a spec that asked for one would be asking for a body that
sinks into the ground.

So the brief is stated as the two things that are actually free, and the bend is
read back out as a consequence:

```ts
/** What one foot is asked to do at one key. */
interface FootBrief {
  /** The ankle's fore-aft offset from the pelvis, in rig units. */
  readonly along: number;
  /** How far the heel comes up, in degrees of foot pitch past its bind attitude. */
  readonly heel: number;
}
```

`heel` is in degrees and not in the rig units the ankle actually rises, because
the budget is **anatomical and not geometric** and only one of the two says so.
As a height it looked generous: the foot is 0.0176 long, so the ankle can rise
0.0108 before it is directly over the toe, and that 0.0108 is worth 20 degrees of
knee — exactly the compression this wants. It is also a foot standing at 79
degrees to the floor, reached by turning the ankle 52 degrees. A pointe is not a
heel lift. In degrees the same budget reads as what it is: this foot already
slopes 27 degrees down to the toe, and past about 30 more it is on tiptoe.

The toe is pinned on the **floor the idle stands on** — sampled from `idle.glb`
per foot rather than typed, because that is the pose the eye calibrates the
ground from and the pose these three clips fade out of. The ankle is pinned at
`along` and at the floor plus the foot's own bind rise plus `heel`. Six knobs per
leg as today, and `plant-foot.ts` solves them.

Two changes to the solver past the new targets:

- **A knee floor.** A one-sided term that costs nothing above `MIN_KNEE_BEND` and
  climbs below it. This is the "no leg locks out" rule, and it is one-sided
  because a bend ceiling is already imposed by the ground.
- **The guard is solved too.** Its targets are the brief like every other key's,
  so no leg angle in `pig-strike.ts` is dialled in by hand any more, and the
  strain anchor is the guard's own solution *within the same run* rather than
  whatever is pasted in the file. That makes the script idempotent against its
  own output rather than merely against the guard's.

### `scripts/probe-stance.ts`

The instrument, reading the committed `slash.glb`, `shoot.glb` and `cast.glb`
rather than the table — because what ships is a file, and a stance that is right
in `pig-strike.ts` and never regenerated is the failure this would otherwise
hide. Per clip per sampled frame: support%, each toe's height above the idle's
floor, each knee's bend, and the knee's lead over the hip-to-ankle line. `idle`
is printed beside them as the control.

## Invariants tested

In `pig-strike.test.ts`, and mirrored for the shared guard in `pig-shot.test.ts`
and `pig-cast.test.ts`:

- **The pelvis is over the feet.** At every key of every clip the hips' forward
  coordinate lies between the rear ankle and the leading toe, with a margin, and
  never in front of the leading toe.
- **The feet are on the floor.** Every toe, at every sampled frame, is within a
  stated tolerance of the height the idle rests that same foot at — measured
  against the idle rather than against a constant.
- **No knee locks out.** Knee bend on both legs stays above `MIN_KNEE_BEND` at
  every sampled frame, not merely at the keys, so an interpolated frame between
  two legal keys cannot straighten through it.
- **No knee bends backwards.** The knee stays forward of the hip-to-ankle line at
  every sampled frame — the signed statement of the rule above, which a bend
  angle alone cannot make, since bend is unsigned.
- **The loaded leg compresses.** The planted left knee is more bent at contact
  than at the guard, by a stated amount, and returns to the guard's bend at
  settle.
- **The shin leads.** Each knee stays forward of its own ankle, so the bend reads
  as the knee travelling over the foot.
- What spec 139 and 143 already assert is unchanged: the left foot does not
  slide, the left knee does not pump, and the swing's arc, silhouette and timing
  all still hold.

The one existing assertion that **does** move is the size of the right foot's
step, and both of its numbers were measured with that foot 0.077 above the
ground. On the floor the step is bounded twice over, and neither bound is a
taste. Reaching back, the leg cannot put its ankle more than 0.079 from under its
own hip at all, because the pig stands exactly as tall as its legs are long.
Driving through, it has to stop at the pelvis rather than pass the left foot,
because a body with both feet in front of its own weight is this spec's own fault
arriving from the other side. So `0.08` back becomes `0.075` and `0.22` through
becomes `0.10`, against measurements of 0.086 and 0.116. `src/items/grip.test.ts`
carries a second copy of those two numbers and is reduced to what its own comment
already says it is for — that the leg on the sword's side is the one that moves —
with the magnitudes left to the file that owns them.

## Measured, after

Through the committed clips, against the idle as the control:

| | pelvis over its span | toe float | knee bend | knee lead |
|---|---|---|---|---|
| `idle` (control) | -28%–69% | 0.0097 | 4.1 | 0.94 |
| `slash` before | 111%–227% | 0.077 | 10.4 | — |
| `slash` after | 11%–81% | 0.0063 | 21.5 | 0.83 |
| `shoot`/`cast` after | 58% | 0.0000 | 21.5 | 0.98 |

The support knee goes 21.5° at the guard to 24.7° at contact, where it used to go
30.4° to 31.2° by way of 28.7° at the load — least bent on the frame the weight
arrives. What buys that back is three degrees of **pelvic roll** at `contact` and
four at `follow`: the pelvis yaws 45° between the load and the follow-through and
carries the left hip 0.05 backwards with it, so a support leg that did nothing
would straighten into the blow however the feet were placed. Rolling three
degrees drops that hip 0.010, and it is nearly free elsewhere because at contact
the hand is close to the roll axis — measured, it moves the hand 0.004.

## Out of scope

- **The pelvis does not drop.** A weight shift you can see in the hips would want
  root translation, and `glb.ts` refuses to write one because the server owns
  where a body is. Compression here is knee, ankle and the three degrees of roll
  above — a rotation the format already allows, not a height the format does not.
- **The other clips' legs.** `walk`, `run` and `idle` are retargeted purchases,
  not authored tables; `posture.ts` is the tool for editing one and this spec
  does not use it.
- **Stance width.** Each foot keeps its bind lateral. Fore-aft is where the fault
  is and side-to-side is a separate argument.
- **A second stance.** One combat stance, shared by the three clips, as today.
