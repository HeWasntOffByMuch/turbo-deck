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
// noise.ts is shared with rigs.ts (src/render/noise.ts)

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
  readonly vx: number; readonly vy: number; readonly vz: number;
  readonly turbulence: number;   // 0..1, per-particle variation the solver applies
  update(dt: number, t: RobeTuning): void;
  gust(strength: number): void;  // one-shot burst, for the sandbox button
}

// geometry.ts — parametric cloth pieces as particle grids.
export interface ClothGeometry {
  count; bind: Float64Array; bone: Int32Array; pinned: Uint8Array;
  refWeight: Float64Array; link: Int32Array; linkRest: Float64Array;
  linkKind: Uint8Array; anchor: Int32Array; anchorRest: Float64Array;
  index: Uint16Array; seed: Int32Array; colliderMask: number;
}
export function buildHood(f: FigureMetrics): ClothGeometry;
export function buildCape(f: FigureMetrics): ClothGeometry;
export function buildSkirt(f: FigureMetrics): ClothGeometry;
export function buildSleeve(f: FigureMetrics, side: -1 | 1): ClothGeometry;

// colliders.ts — capsule set the rig refreshes from bone world matrices.
export class CapsuleSet { count; a: Float64Array; b: Float64Array;
  radius: Float64Array; mask: Int32Array; set(i, ...): void; }

// solver.ts — position-based dynamics over the geometry above.
export class ClothSolver {
  readonly pos: Float64Array; readonly vel: Float64Array;
  readonly normal: Float64Array;
  reset(ref: Float64Array): void;
  addImpulse(x, y, z): void;
  step(dt, t: RobeTuning, ctx: ClothStepContext): void;
  maxStretchRatio(): number;   // diagnostics for the debug readout
}
```

### `src/render/iso3d/` — three.js binding

- `jump.ts` — `JumpMotion`, a pure ballistic hop (launch / airborne / land /
  recover) plus a `drop(height)` for testing falls. Cosmetic only: it never
  touches sim state, so no game outcome depends on it.
- `humanoid.ts` — `Humanoid`, a bone hierarchy (pelvis, chest, head, upper
  arms, forearms, thighs, shins, feet) with a distance-driven biped walk/run
  cycle, bob, lean, bank, breathing and a landing crouch. Owns the visible
  solid geometry (torso robe, head, hands, boots) and the collider capsules.
- `robe.ts` — `RobeRig`, the composition root: skeleton + wind + five cloth
  pieces, `update(dt, worldPos, ry)` matching the `SandboxUnit` shape the
  sandbox/debug scenes already drive `MechRig` with.
- `robe-debug.ts` — `ClothDebugOverlay`: toggleable particle dots, link lines
  (coloured by strain), pinned attachment points, collider capsule wireframes
  and a wind arrow.
- `tuning-panel.ts` — the generic slider/toggle panel extracted from
  `movement.ts`, so mech tuning and robe tuning share one implementation.

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
