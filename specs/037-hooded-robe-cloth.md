# 037 — Hooded robe character with physics-driven cloth

## Problem

The isometric 3D views (specs 031–036) only have mechs: a spider and a grey
walker, both rigid boxes on IK legs. There is no humanoid player character, and
nothing in the renderer simulates soft materials. This spec adds the first
playable-looking character — a faceless humanoid almost entirely covered by a
hooded robe — whose hood, cape, lower robe and sleeves are driven by an actual
cloth solver rather than baked animation, so the fabric lags, swings, billows
and settles in response to how the character moves.

The goal is *believable fabric*, not character art. Appearance is deliberately
minimal (flat-shaded, no face, no customisation); the effort goes into the
simulation, its tuning surface, and the tooling to iterate on it.

## Shape

Three layers, split so the physics is testable in Node with no browser:

### `src/render/cloth/` — pure simulation (no three.js, no DOM)

```ts
// figure.ts — the figure's proportions, bone layout and collision capsules.
// Shared by the skeleton, the patterns and the clearance test, so there is one
// description of where the body is.
export const BONE: Record<string, number>;
export interface FigureMetrics { /* joint heights, collider radii, drapeClearance */ }
export const FIGURE: FigureMetrics;
export function boneRestLayout(f): readonly BoneRest[];
export function buildCapsuleDefs(f): readonly CapsuleDef[];

// params.ts — every tunable in one documented, flat, numeric record.
export interface RobeTuning {
  // fabric
  fabricWeight; stiffness; bendStiffness; damping; maxStretch;
  springStrength; recoverySpeed;
  // forces
  gravityMultiplier; airResistance; windInfluence; inertiaMultiplier;
  movementInfluence; jumpImpulse; landImpulse; idleSway;
  // collision + solver
  collisionRadius; iterations; substeps;
  // wind
  windEnabled; windDirection; windStrength; gustStrength; gustFrequency;
  windTurbulence; windTransition;
  // figure / locomotion (cosmetic)
  bodyScale; strideScale; armSwing; jumpHeight;
}
export function defaultRobeTuning(): RobeTuning;
export function sanitizeRobeTuning(t: RobeTuning): void;   // clamps NaN/±∞ in place

// wind.ts — procedural wind, smooth transitions, gusts, disable.
export class WindField {
  readonly vx, vy, vz, turbulence: number;
  update(dt: number, t: RobeTuning): void;
  gust(strength: number): void;  // one-shot burst, for the sandbox button
}

// geometry.ts — parametric cloth pieces as particle grids.
export interface ClothGeometry {
  count; bind; bone; pinned; refWeight; link; linkRest; linkKind; linkCount;
  anchor; anchorRest; index; seed; colliderMask;
}
export function buildRobePieces(f): readonly ClothGeometry[];  // robe, cape, hood, 2 sleeves

// colliders.ts — capsule set the rig refreshes from bone world matrices.
export const MASK: { head; torso; armL; armR; legs };
export class CapsuleSet { count; a; b; radius; mask; set(...): void; }

// solver.ts — position-based dynamics over the geometry above.
export class ClothSolver {
  readonly pos, vel, normal, invMass: Float64Array;
  reset(ref: Float64Array): void;
  addImpulse(x, y, z): void;
  step(dt, t: RobeTuning, ctx: ClothStepContext): void;
  maxStretchRatio(): number;
  kineticEnergy(): number;
}
```

Two pure helpers are lifted out of `iso3d/rigs.ts` so the robe does not have to
depend on the mech rig for them: `src/render/noise.ts` (hashed value noise) and
`src/render/spring.ts` (the critically damped spring). `rigs.ts` re-exports
`Spring` so nothing downstream changes.

### Cloth model

- **World-space PBD.** Particles simulate in world space; only the attachment
  rings are driven by the skeleton. Lag, inertia, sway and overshoot on
  acceleration, deceleration, turning and jumping therefore emerge from the
  solver rather than being scripted per-motion.
- Distance constraints in three flavours (structural / shear / bend) with
  iteration-count-independent stiffness.
- **Long-range tethers** cap `|p − anchor|` at `maxStretch × bindDistance`, so
  the robe can never balloon or be left behind on a teleport.
- A **skinned reference pose** (each particle bound to one bone) gives both the
  pose-retention spring (`springStrength`) and the idle settle
  (`recoverySpeed`), and is the recovery state for any non-finite particle.
- Every garment is **cut outside every capsule it can collide with**, at
  `<body radius> + drapeClearance`. A garment born inside a capsule is pushed
  out against its own constraints forever, and the symptom -- permanently
  inflated, permanently strained fabric -- is nearly invisible in a shaded
  render. This is the invariant `figure.test.ts` exists to hold.
- Aerodynamics per particle: isotropic drag plus normal-projected wind pressure
  from the vertex normal, so panels billow when broadside and slice when edge-on.
- Capsule collision against the body, filtered per piece by a collider mask.

## Invariants tested

- **Solver**
  - Pinned particles sit exactly on their pin targets after a step.
  - A hanging sheet under gravity settles: kinetic energy decays monotonically
    once forces are static, and the settled state stays put.
  - No particle ever exceeds `maxStretch × bindDistance` from its anchor,
    including after a large single-frame teleport of the attachment.
  - Every position stays finite for pathological inputs (`dt` of 0, 10 s, NaN
    tuning values, zero fabric weight, a collider exactly on a particle).
  - Particles are pushed outside every capsule they collide with, and never
    fall below the ground plane.
  - Identical `(geometry, tuning, input sequence)` produces identical positions
    across runs — the solver reads no ambient state.
  - `step` allocates no arrays (verified by a scratch-buffer identity check).
- **Figure**
  - Every garment's bind pose clears every capsule it can collide with, by at
    least the default `collisionRadius`.
  - `drapeClearance` exceeds the default `collisionRadius`.
  - The bone layout names every bone once, parents before children.
- **The whole rig** (`iso3d/robe.test.ts`, driving a real `RobeRig` headlessly)
  - It settles into a finite, unstretched hang and stays there -- moving only as
    much as the figure's breathing drives it.
  - Fabric trails behind a run and returns to rest when it stops; peak lag grows
    with `inertiaMultiplier`.
  - No particle sits inside a body capsule during a walk cycle.
  - The tether cap holds through a turn far faster than the sim can produce.
  - A jump lifts and lands; a fall flares the hem and it comes **all the way
    back down** (the regression guard for buckling and hem inversion).
  - Wind blows it downwind and it settles when the wind drops.
  - A teleport re-seats the cloth instead of stretching it.
  - Identical inputs replay identically.
- **Wind**
  - Disabling wind ramps the vector to zero smoothly instead of snapping, and
    stays at zero.
  - Direction/strength changes are approached continuously (bounded per-step
    delta), and the vector magnitude never exceeds strength + gust strength.
  - Deterministic for a given seed and `dt` sequence.
- **Geometry**
  - Every link/index/anchor/bone index is in range; every piece has ≥1 pinned
    particle; every free particle reaches a pin through the link graph.
  - Bind positions are finite and the triangle list is non-degenerate.
- **Jump**
  - A hop returns to `y == 0`, reports exactly one land event, and its landing
    speed is within tolerance of its launch speed.
  - Triggering mid-air is ignored.
- **Params**
  - `sanitizeRobeTuning` replaces NaN/±∞ with the default and clamps to bounds.

## Out of scope

- Cloth **self-collision** and cloth-vs-cloth layering (the cape and lower robe
  interpenetrate at the back; they are offset apart instead).
- Tearing, wrinkle maps, or any texturing — the look stays flat-shaded.
- Putting the character in the combat view or giving it sim-side stats,
  attacks, or a jump the sim knows about. The hop is renderer-cosmetic.
- GPU/compute solving, and multiple fabric materials per character.
- Equipment attachment; the bone/mask structure is designed to allow it later,
  but nothing is wired up.
