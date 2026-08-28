# 250 — A ground that is alive

## Problem

The clearing is one flat colour with a grain scrolling over it. `terrain-arrays.ts`
picks one of two authored grass tones per cell from a smooth noise field
(spec 043), and that is the entire variation the ground has: two greens, at cell
scale, static. Spec 074's streak layer moves over it, but it moves over *every*
material equally and its whole job is to say the air is moving — it says nothing
about what the ground is made of.

So a meadow at the game's camera reads as a painted plane. What it is missing is
not resolution: it is the three or four *scales* a real ground surface has at
once — patches of different green tens of metres across, brush-stroke clumps
about a metre across, sparse marks a hand across — and a wind that moves the
*pattern* rather than the plane.

Everything needed to fix that is already in the ground's fragment shader and has
been since spec 106: the world position, the world normal, the shared wind
direction, the shared clock and a value-noise function. Nothing has ever read
them together.

## Shape

A fourth patch on the surface material, in the register of the three that are
already there (`terrain-streak.ts`, `terrain-curvature.ts`, `terrain-detail.ts`):
a wrapped `onBeforeCompile`, a contribution to `customProgramCacheKey`, and a
splice after `#include <color_fragment>` so it rides on the vertex colours and
still takes the sun, the shadows and the lights.

- `living-ground.ts` — pure. `LivingGroundConfig`, the art-directed `LIVING_GROUND`
  defaults, the panel's `LIVING_GROUND_LIMITS`, TypeScript transcriptions of the
  three decisions worth asserting, and `glslLivingGround()`.
- `terrain-living.ts` — the three.js half. `LIVING_GROUND_UNIFORMS` (shared by
  reference, the arrangement `wind-uniforms.ts` established), the setters the
  panel writes through, and `patchTerrainLiving`.
- `weather-controls.ts` — a `Ground` section under the existing `Wind` one.

```ts
export function grassMask(r: number, g: number, b: number): number;
export function macroTone(m1: number, m2: number): number;
export function gustFront(raw: number, contrast: number): number;
export function slopeSteepness(normalY: number, start: number, end: number): number;
export function glslLivingGround(): string;

export const LIVING_GROUND_UNIFORMS: { readonly [name: string]: THREE.IUniform };
export function setLivingGround(patch: Partial<LivingGroundConfig>): void;
export function resetLivingGround(): void;
export function patchTerrainLiving(material: THREE.Material): void;
```

### Which pixels it reaches, and why that needs no new data

There is no material id in the ground's vertex format — a cell's material is
spent at mesh time on choosing one of two colours — and adding one means a new
attribute, a mesher change and a change to what the map worker transfers. It is
not needed: **grass is the only material in `TERRAIN_COLORS` whose green channel
dominates both of the others.** So the mask is a chromaticity test on the albedo
the patch is handed, which is exactly the vertex colour, because this patch runs
first of the four.

### Relative, not absolute

The four authored colours are a *base* and three tones stated against it, and
what the shader adds is `tone - base`. That is what preserves spec 043's
two-tone mottling: both grass tones take the same shift, so the cell pattern
underneath survives instead of being painted over. It is also what makes a map
whose grass was retuned keep working — the base moves with it.

### One wind

Direction and clock are `uWindDir` and `uWindTime`, shared by reference from
`wind-uniforms.ts`. There is no second wind direction and no second clock, which
is spec 074's rule and the reason the trees, the sea and the ground cannot be
handed different weather. What this adds is a ground-local *speed multiplier* and
its own scales.

### The forest-edge seam

`grassShelterAt(vec3)` returns 0.0, and `uGrassShelter` scales what it returns.
There is no prop distance field in this renderer and building one is a system of
its own; the hook exists so that the day there is one, the colour arithmetic
that consumes it is already written and tested.

## Invariants tested

- Every tone in `TERRAIN_COLORS.grass` reads as grass; every tone of `sand`,
  `dirt`, `rock`, `snow` and `water` reads as ~0. Asserted against the palette,
  so retuning a material that crosses the line fails here.
- The same, for both tones of `TERRAIN_CLIFF_COLORS.grass` — a cut bank is earth
  and must not grow strokes.
- The macro swing is worth more than half a retro band on the grass it lands on,
  measured in linear space at the grass's own brightness through `srgbDecode`.
  Spec 074's finding: a modulation smaller than that is rounded away by the pass
  over the whole frame.
- A gust front at the shipped contrast is an *edge* — its transition occupies a
  small fraction of the distance between fronts — for the same reason.
- `slopeSteepness` is 0 on ground flat enough that the jittered lattice's own
  few degrees of wobble cannot reach it, and 1 well before `MAX_WALK_SLOPE`.
- `macroTone` is symmetric: at the middle of its range the shift is zero, so the
  authored colour is what unmodulated ground shows.
- The GLSL names every uniform it declares and declares every uniform it names,
  and samples the noise no more than the stated number of times.
- The patch composes: applied fourth, the compiled fragment shader still carries
  the streak, the cavity and the detail, and the cache key carries all four.
- The uniform objects are shared by reference between two patched materials.

## Out of scope

- Any geometry change. The ground stays the same triangles; nothing waves.
- Grass blades, billboards, instanced tufts, tessellation, parallax.
- The cliff walls, which keep `TERRAIN_CLIFF_COLORS` and their existing patches.
- The rock-by-slope blend (spec 106), which is a different question — that one
  replaces the material, this one varies it.
- A prop distance field for the forest-edge term; only the hook lands.
- The map editor's panel. The editor draws the same shared material and gets the
  look; the sliders are the Play tab's Weather popover.
