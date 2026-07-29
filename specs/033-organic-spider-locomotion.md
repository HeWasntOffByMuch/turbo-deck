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

### Follow-up refinements

- **Anti-twitch.** The first cut chattered and over-reached. The trigger radius
  now carries a *fixed* per-leg offset (not per-frame noise, which flickered
  legs across the threshold); a planted foot takes a short cooldown before it may
  step again; the travel direction is low-passed and only updated on real
  movement, so it never flips as the unit settles at its target; a step's lead is
  never shorter than the ground the body will cover during the swing, so feet
  always land ahead of drift instead of re-stepping in place; the femur/tibia are
  a touch longer for reach headroom; and the drawn foot and the knee-sway follow
  their targets at a *capped rate* (`footSmooth`) so limb motion can never snap —
  the "restrict how fast a joint moves" fix.

- **Live tuning sandbox.** `MechRig` exposes a mutable `MechTuning` object
  (`sizeScale`, `moveSpeed`, `turnRate`, and every gait/body constant) plus a
  `defaultMechTuning()`. The sandbox moves its instructions/controls into a side
  panel of grouped sliders (Unit / Gait / Body) that edit the tuning live;
  `sizeScale` resizes the body meshes and leg bones (feet stay ground-locked),
  and a **C**-loaded archetype preset fills the speed/turn sliders. A reset
  button restores defaults.

- **No cross-body / backward reach.** A world-locked foot left behind by a turn
  could leave its leg reaching across or behind the body. Fixed three ways: steps
  now lead *forward along the body's facing* (not the stale travel vector, which
  flung feet sideways mid-turn) and are clamped into the leg's own quadrant; a
  planted foot that crosses its quadrant lines (behind its hip or over the
  centreline) is forced to re-home; and, as a hard guarantee, the *drawn* foot is
  held at the quadrant boundary so a leg never renders reaching behind or across
  the hip even during a fast pivot.

- **Editable speed/turn rate.** Move speed and turn rate are sim-owned, so the
  sandbox feeds them through two new *optional* `InputFrame` fields
  (`moveSpeedOverride`, `turnRateOverride`) that `step` applies in place of the
  character preset. They are a pure input, default-absent; the game never sets
  them, so behaviour and determinism are unchanged when omitted.

- **Biologically-inspired turning (legs lead, body follows).** The body no longer
  rigidly snaps to its heading. The authoritative heading + path still come from
  the sim's turn-rate movement (unchanged, sim-owned); on top of it the rig now
  turns like a creature, entirely cosmetically:
  - *Body-yaw controller.* The scene still rotates the rig **group** (the leg-
    planning frame + heading arrow) to the authoritative heading, so the legs
    re-home to the new heading first. The **body chassis** yaw is driven
    separately by a physics-style angular controller — `angAccel = k·err −
    c·ω + legTorque`, integrated to a body yaw that *trails* the heading and
    settles after the turn (rotational inertia, not a direct transform). The
    torque term sums each swinging foot's step direction about the body centre,
    so an asymmetric/pivot step pattern nudges the yaw; the spring keeps it
    bounded and the trailing angle is hard-capped. `yawLag` (0..1) tunes it.
  - *Differential stepping.* Inside legs (toward the turn) get a smaller trigger
    radius (shorter, more frequent steps); outside legs lead farther — the
    asymmetry that walks the body around, driven by `turnStepBias`.
  - *Foot-placement prediction.* A step converts its plant through the heading the
    body *will* have when the foot lands (`ry + yawRate·dur·stepPredict`), so feet
    land where the body is going, not where it is.
  - *Lean.* The existing roll banks the body toward the inside of the curve.
  All of this keeps ≥2 feet grounded, never spins on a central axis, and the
  quadrant guarantee above still holds (verified headless + visually).

- **Raised "recovery" leg + pointy legs.** Instead of every leg scrambling to
  touch down during a turn, one leg may lift into a **slightly-raised** recovery
  hold. It stays over its rest spot (no tuck-in), carries no weight, and only
  plants — a deliberate secure step — when its support is genuinely needed: the
  hold times out, a supporting foot gets overstretched, support would drop below
  two feet, or the mech settles. A hold only *starts* from a fully-planted,
  in-motion stance, lifting whichever leg has the most slack; while one is held
  only a single other leg may swing, so ≥2 feet always stay down. The blocky foot
  boxes are gone — each shin tapers to a point (a spider's tarsus tip).
  `tuning.raisedLegs` (0 or 1) caps how many legs may be raised, so 0 disables the
  behaviour entirely.

- **Second unit: the grey mech (same mechanics, non-turning lower body) + a unit
  picker.** The sandbox offers two units from a side-panel picker, and they share
  one `MechTuning`. The grey mech is **the same `MechRig`** — identical ground-lock
  IK, gait, holds and pointy legs — constructed with `lowerBodyTurns: false`. That
  decouples the **leg-planting frame** from the body facing: the leg frame stays
  world-fixed (`legRy = 0`) so the legs plant and step in place while the body
  moves, and steps lead along the travel direction expressed in that fixed frame
  (`leadDir`), so it walks any direction without the base turning. The body split
  into a **carriage** (lower body: bob/sway/pitch/roll + the hips, no facing yaw)
  and a **turret** (upper body) whose yaw is driven by the same spring+inertia
  controller — a small trailing lag for the spider (`legRy = ry`), the full facing
  for the mech (`legRy = 0`). So only the mech's upper body rotates to face; its
  legs never spin with it (verified: feet barely move during an in-place turn).
  `orientsWithGroupYaw` now follows `lowerBodyTurns`, the heading arrow is a
  scene-managed mesh shared by both units, and the earlier animation-only
  `WalkerRig` was removed. The combat scene still constructs a default `MechRig`
  (spider), unchanged.

`scene.ts`, `main.ts`, `input.ts`, cards/game — unchanged (the rig signature is
preserved). The only sim change is the two default-off input overrides above.

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
- Any change to the movement *rules* themselves (turn-rate gating, the HoN speed
  clamp, arrival handling): the two new input overrides only substitute the
  speed/turn *values* the existing rules already read, and are default-off.
- Reworking `PlayerRig` (the bird) or the 2D `spells` renderer.
