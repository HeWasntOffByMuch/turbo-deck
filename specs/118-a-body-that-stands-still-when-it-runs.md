# 118 — A body that stands still when it runs

## Problem

The first generated unit — the pig, which is also the player — flickers between
its idle pose and its run pose while moving, and slides forward out of its own
collision capsule once a cycle. Two independent faults, both invisible to every
check the repo has.

**The blend parameter is measured on the wrong clock.** `speed` is computed in
`scene.ts` from two *drawn* positions divided by the *frame* delta. The drawn
position of a body only changes on a frame that drained a 60Hz sim tick, so
every frame that drained none reports a speed of exactly zero — and `poses()`
is read on those frames too. Above 60fps most frames drain no tick, so the
blend tree returns the idle clip on most frames:

| refresh | frames the blend spends on `idle` while sprinting |
|---|---|
| 60Hz, no jitter | 0 |
| 60Hz, ±3ms | 21 of 300 |
| 75Hz | 118 of 300 |
| 120Hz | 145 of 300 (every other frame) |
| 144Hz | 120 of 300 |

It is not the state machine: `stateId` stays `locomotion` throughout. What
flips is the blend tree underneath it, and with it `normalizedTime` — the
playhead jumps from mid-run to 0.02 of a 15.4-second idle clip and back, every
other frame.

**The travel is on a bone the root-motion rule does not look at.** Spec 111
strips translation from the root bone *and every node above it*, on the stated
grounds that nothing at or above the root poses the body. The pig's rig puts
`Root` above `Hip` and animates `Root` in rotation only — the travel is baked
onto `Hip`, one node *below* the root, where the rule cannot see it. Measured
off the committed clips:

| clip | `Hip` net displacement | span | as world units/sec |
|---|---|---|---|
| `run` | 2.860 | 2.860 | 123.5 |
| `walk` | 1.465 | 1.465 | 34.4 |
| `idle` | 0.000 | 0.163 | 0 |
| `hurt` | 0.017 | 0.016 | — |

A player moves at 155 units/sec, so the run clip adds ~80% of the body's own
speed as drift and takes it back at the loop point. `npm run validate:units`
reports the library clean, because `Root` carries no translation channel at all.

## Shape

**The speed clock** (`unit-driver.ts`, pure):

```ts
export interface SpeedClock {
  /** Drawn distance since the last tick-bearing frame. */
  readonly pending: number;
  /** World units per second, measured over whole ticks. */
  readonly speed: number;
}
export const STOPPED: SpeedClock;
export function advanceSpeed(
  clock: SpeedClock, travelled: number, ticks: number, tickSeconds: number,
): SpeedClock;
```

Distance accumulates every frame; the quotient is only taken when `ticks > 0`,
against `ticks * tickSeconds` rather than against the frame delta. A frame that
drained no tick holds the previous answer instead of reporting zero.

**The travel rule** (`root-motion.ts`, pure, beside the rule it generalises):

```ts
export interface Travel {
  readonly distance: number;
  /** Unit vector along the net displacement; zero when there is none. */
  readonly axis: readonly [number, number, number];
}
export function trackTravel(values: ArrayLike<number>): Travel;
export function withoutTravel(
  values: ArrayLike<number>, rest: readonly [number, number, number], times?: ArrayLike<number>,
): number[];
export function travelMessage(unitId, clipId, node, distance): string;
```

A cycle ends where it began, so a translation track whose last key is not its
first is carrying travel — *wherever in the rig it sits*. The correction removes
the linear ramp between them and slides the along-axis component so its mean
sits at the bone's rest value. What is perpendicular to the travel is left
alone, which is what keeps the run's crouch and the idle's sway.

`unit-rig.ts` applies it at import, after the existing root-chain strip, to any
`.position` track whose travel exceeds a tenth of the rig's own *reach* — the
longest bone offset in its bind pose, which is a stand-in for "how big is this
thing" that costs nothing and does not care what units the rig was exported in.
It reports through the same channel the strip already reports through.
`validate-units.ts` measures reach off the same numbers in the file and applies
the same fraction, because a gate and an importer that disagree about what
counts is the failure this module is arranged to prevent.

## Invariants tested

- `advanceSpeed` reports the same speed at 30, 60, 75, 120 and 144fps for a
  body moving at a fixed rate per tick, and never reports zero for a body that
  is moving, at any refresh rate.
- Driving the real pig unitdef through a simulated frame loop holds one blend
  clip for the whole run at every refresh rate above 60fps — the regression this
  spec exists for.
- `trackTravel` is zero for a clip that returns to its first key, whatever it
  does in between, and is the first-to-last distance when it does not.
- `withoutTravel` leaves a track with no net displacement byte-identical, makes
  the last key equal the first for one that has it, preserves the components
  perpendicular to the travel key-for-key, and puts the along-axis mean at the
  rest value.
- The correction is idempotent: running it twice changes nothing the second
  time.
- Measured against the committed pig clips: `run` and `walk` are corrected,
  `idle` and `hurt` are left alone.

Everything above is checked in Node against clip *documents*, and all of it can
be green while the game still slides — the half left over is three's
`GLTFLoader` deciding what a track is called and an `AnimationMixer` writing the
result onto a skeleton, which is exactly where spec 111's root-motion bug lived.
So `npx tsx scripts/probe-travel.ts` loads the real unit through the real
`UnitRig` and measures where the hips actually go, in world units, over each
clip. A looping clip that ends anywhere but where it started fails; so does one
whose hips never move at all, because a correction that ate the pose along with
the travel is the opposite mistake and looks perfect in a drift number. It needs
no GL context: nothing here rasterises.

## Out of scope

- **Re-baking the committed `.glb`s.** The travel is corrected at import, which
  fixes every unit already in the tree and every one generated before the export
  path is taught the same rule. The validator warns rather than errors for
  exactly as long as that is true.
- **The export path.** `bakeClip` still only removes root-chain translation
  channels. Baking the travel out at export means rewriting accessor floats in
  the binary chunk, which is a larger promise than this bug needs.
- **The blend thresholds.** `scaffold.ts` writes 34 and 150, which happen to sit
  either side of the pig's real gait speeds. Nothing here re-tunes them.
- **Hysteresis on `speed > 5` / `speed < 5`.** The state machine never flapped;
  once the clock is right it has no reason to start.
