# 033 — Organic procedural spider locomotion for the mech

## Problem

Spec 032 gave the mech ground-locked feet and a two-bone IK leg, which killed
the foot-sliding, but the result still reads as a *robot*: legs are two-bone,
every leg re-plants on the same trigger radius with identical timing, the body
is a rigid brick that never bobs, sways, pitches, or banks, and the gait is a
bare "step the two most-overstretched legs" rule with no left/right or
diagonal structure. There is no sense of weight, no anticipation before a step,
no micro-motion while standing, and nothing that changes between ambling,
sprinting, and pivoting.

This spec reworks the mech's locomotion into a believable alien-spider walker:
a multi-joint limb, a diagonal (alternating-tetrapod) gait, spring-smoothed
body stabilisation driven by a center-of-mass estimate, anticipated stepping
with curved trajectories, per-leg noise so nothing is symmetric, and
speed-derived locomotion states (idle / walking / running / turning /
stopping). It stays entirely **cosmetic**: everything is derived from the rig's
observed world position and heading; nothing reads or writes sim state, and the
sim/cards/game layers are untouched. The `MechRig.update(dt, worldPos, ry)`
signature and constructor are unchanged, so the combat scene's enemy mechs pick
up the new locomotion for free; the movement sandbox (spec 032, tab 2) remains
the place to watch it in isolation and now surfaces the live locomotion state.

## Shape

`rigs.ts` — rework `MechLeg` and `MechRig` (PlayerRig/Poofs untouched):

- **Multi-joint leg.** Each `MechLeg` gains a **coxa** (hip) joint: a short
  horizontal segment that yaws from the body corner toward the foot's azimuth,
  ending at a "shoulder" from which a two-bone **femur/tibia** IK solve (with an
  up-pointing pole, so the knee always bows upward) reaches the planted foot.
  That is four independently posed parts — coxa rotation, femur lift, tibia
  extension, foot placement — instead of a bare two-bone chain. The hip anchor
  is read fresh each frame from the (moving) chassis, so the legs stay attached
  as the body bobs and sways.

- **Diagonal gait.** Legs are grouped into two diagonal pairs
  (front-left+back-right, front-right+back-left). A leg may only begin a step
  when no leg of the *other* diagonal pair is airborne, and at most two legs
  step at once, so at least two feet — a supporting diagonal — are always
  planted. A leg's diagonal partner is nudged to step with it, producing an
  alternating-tetrapod trot rather than four independent twitches.

- **Anticipated, curved steps.** A step lifts before it translates (a small
  anticipation hop), arcs the foot up and forward along a skewed curve, and
  decelerates into the plant instead of linearly interpolating. Step timing,
  lead distance, and lateral foot placement each carry a per-leg noise offset so
  no two legs step identically.

- **Spring-damped body stabilisation.** A `Spring` (critically damped, closed
  form, unconditionally stable for any `dt`) smooths every body offset. The
  chassis (body cube + head + eye + plate) is an inner group offset from the rig
  origin by: **height** (a low center of gravity that dips as legs lift and
  compresses at speed), **bob** (vertical oscillation at gait frequency),
  **sway** (lateral shift toward the planted-feet centroid — the center-of-mass
  estimate — plus a gait sway), **pitch** (nose-down under acceleration,
  nose-up when stopping), and **roll** (bank into a turn). Because the feet are
  world-locked and the hips ride the chassis, the leg IK compresses and extends
  as weight shifts — no explicit joint-compression pass is needed.

- **Locomotion states.** Observed speed, acceleration, and yaw-rate (all
  derived from the position/heading stream, never from sim state) select a
  state — **idle / walking / running / turning / stopping** — exposed via a
  `locomotionState` getter. A continuous walk→run blend drives contact time
  (shorter when running), step height and lead (larger when running), and
  stabilisation stiffness (stiffer when running). Turning shortens inside-leg
  steps and lengthens outside-leg steps and banks the body. Idle adds a slow
  breathing pulse and continuous micro-corrections so a standing mech is never
  perfectly still.

`movement.ts` — the sandbox reads `mech.locomotionState` and shows it in the tab
caption, so the idle → walk → run → turn → stop transitions are visible while
driving the mech.

`scene.ts`, `main.ts`, `input.ts`, sim/cards/game — unchanged (the rig
signature is preserved).

## Invariants tested

- The sim suite is unchanged and green: no sim/cards/game behavior is touched,
  and `computeMoveSpeed` and the existing movement tests still hold.
- The `Spring` closed-form step is deterministic and stable (a pure numeric
  helper): from any state it eases toward its target and, once there with zero
  velocity, stays — covered by a small unit test in `rigs-spring.test.ts`.
- Everything else is renderer-only three.js with no headless surface, matching
  the rest of `iso3d/`; correctness is covered by typecheck + lint.

## Out of scope

- Terrain height / foot raycasts against scenery: the ground stays flat at
  `y = 0` and feet plant on it (unchanged from spec 032). The stepping,
  center-of-mass, and IK code is structured so a future ground-height probe
  could feed foot `y`, but this spec does not add one.
- Any change to movement rules, turn-rate, or speed (all still sim-owned), and
  any new sim/cards/game determinism surface.
- Reworking `PlayerRig` (the bird) or the 2D `spells` renderer.
