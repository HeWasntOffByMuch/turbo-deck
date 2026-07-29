# 035 — Rig debug viewport (top + side, slow-mo, joint overlays)

## Problem

The spider/mech legs are tuned in the movement sandbox (spec 032/033), but that
tab shows a single iso follow-camera at real speed. When a leg looks wrong —
a hip that won't swing, a knee that bows the wrong way, a foot that reaches
across the body — there is no way to see *why*: the joints, their targets and
their angles are invisible, and full-speed motion is too fast to read a single
step. Iterating on locomotion means squinting at a moving silhouette.

This adds a third tab: a **rig debug viewport** that shows the same controllable
unit from two orthographic angles at once — straight **top-down** and a
heading-locked **side** profile — with **slow-motion / single-step** time
control and toggleable **debug overlays** (skeleton, joint dots, foot targets,
rest spots + step-trigger rings) plus a live **joint-angle readout**. It reuses
the existing sim movement and the full tuning panel, so the exact same rig can
be driven, tuned, slowed down and inspected from two sides. It stays entirely
cosmetic/renderer-only: no sim/cards/game changes, determinism untouched.

## Shape

`rigs.ts` — expose a read-only debug snapshot of the rig's solved state (the rig
already computes all of this internally each frame; this only surfaces it):

```ts
interface LegDebug {
  hip, shoulder, knee, foot: THREE.Vector3; // rig-group-local solved joints
  target: THREE.Vector3;   // logical foot plant (group-local), y = lift height
  rest: THREE.Vector3;     // rest spot (group-local, y=0)
  triggerRadius: number;   // step-trigger radius (world units, size-scaled)
  stepping: boolean;
  held: boolean;
  coxaSwingDeg: number;    // fore/aft protraction angle of the coxa (hip swing)
  femurPitchDeg: number;   // femur elevation above horizontal
  kneeDeg: number;         // interior knee angle
  tibiaPitchDeg: number;   // tibia descent below horizontal
}
interface MechDebug {
  legs: readonly LegDebug[];
  state: LocomotionState;
  bodyYawLagDeg: number;   // how far the chassis trails its heading
}
class MechRig { debugSnapshot(): MechDebug /* mutated-in-place, no per-call alloc */ }
```

- `MechLeg` records its last-solved local joints (hip/shoulder/knee/foot) at the
  end of `pose`; `MechRig.debugSnapshot()` assembles those with each leg's plant
  state into one reused `MechDebug` object (all joints in the rig-group frame, so
  an overlay parented to `rig.group` lines up exactly with the drawn legs).

`debug-view.ts` (new) — `mountDebug(container): ViewHandle`, a `DebugScene` +
`DebugOverlay`:

- **Two views, one scene.** One `WebGLRenderer` renders the shared scene twice
  via scissor: left = top-down ortho (world-aligned map view), right = side ortho
  that orbits so the unit's forward always faces screen-right (best for reading
  fore/aft leg swing and joint angles in profile). Both follow the unit; a zoom
  slider sets the ortho half-width.
- **Slow motion / step.** A time-scale control (Pause · 0.1× · 0.25× · 0.5× ·
  1×) scales how real elapsed time maps to sim ticks; a **Step** button advances
  exactly one 60 Hz tick while paused. The fixed-timestep loop is otherwise the
  sandbox's (whole ticks, inputs one at a time, scene only reads state).
- **`DebugOverlay`.** A `THREE.Group` parented to `rig.group` that reads
  `rig.debugSnapshot()` each frame and positions, per leg: a hip→shoulder→knee→
  foot **skeleton** polyline (coloured by plant state), **joint dots**, a ground
  **target** marker (paints where each foot is planted / heading) distinct from
  the drawn foot, a **rest** marker and a **step-trigger ring**. Each overlay
  layer has a checkbox toggle. All overlays draw depth-test-off over the geometry
  so they are never occluded. A monospace **angle readout** lists the four joint
  angles + state per leg, refreshed each frame.
- **Reuse.** The tab reuses `buildPanel` (unit picker + full tuning sliders +
  reset) and the sim move loop from `movement.ts`, so tuning while watching two
  slowed-down angles is the whole point.

`movement.ts` — export `buildPanel` (and the small shared bits the debug tab
needs) so the debug tab shares one implementation; no behaviour change.

`main.ts` — add a third tab `{ label: 'Rig debug', mount: mountDebug }`.

## Invariants tested

- Sim/cards/game untouched: the existing suite stays green (renderer-only change,
  same as the rest of `iso3d/`). Correctness of the three.js debug layer has no
  headless surface and is covered by typecheck + lint, matching spec 033.
- `debugSnapshot()` allocates nothing per call (mutates one reused object), so it
  is safe to call every frame.

## Out of scope

- No new sim inputs or rules; slow-motion is purely how many ticks the render
  loop feeds per real second (still deterministic per tick).
- No recording/scrubbing timeline, no exporting traces — just live slow-mo +
  single-step. The overlay is structured so a future ring-buffer scrubber could
  read the same snapshot, but this spec does not add one.
- No terrain height; feet still plant on the flat `y = 0` ground (unchanged).
