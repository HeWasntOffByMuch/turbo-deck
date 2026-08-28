# 252 — A ground that is alive

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
  decisions worth asserting, and `glslLivingGround()`.
- `terrain-living.ts` — the three.js half. `LIVING_GROUND_UNIFORMS` (shared by
  reference, the arrangement `wind-uniforms.ts` established), the setters the
  panel writes through, and `patchTerrainLiving`.
- `weather-controls.ts` — a `Ground` section under the existing `Wind` one.

```ts
export function grassMask(r: number, g: number, b: number): number;
export function macroTone(m1: number, m2: number): number;   // signed, -1..1
export function gustFront(raw: number, contrast: number): number;
export function slopeSteepness(normalY: number, start: number, end: number): number;
export function grassNoise(x: number, y: number): number;
export function gustFrontAt(x: number, z: number, dirX: number, dirZ: number, t: number): number;
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

## What was learned building it

Three things came out of the work that the design above did not predict, and all
three are the same shape: **a layer can be correctly wired, switched on, and
invisible.**

- **A mark smaller than half a retro colour band is not a subtle mark, it is an
  absent one.** Spec 074 records learning this once; every one of the four scales
  here got it wrong the first time, and the gust worst of all — it shipped at a
  fifth of a step and `probe-living-ground.ts` could not find it against four
  walking animals. Every amplitude is now measured against a band in *linear*
  space at the grass's own brightness, and the test states the rule for all four
  scales at once so the next one added cannot skip it.
- **`hash21` is degenerate on the integer lattice.** It opens with
  `fract(p * vec2(127.1, 311.7))`, and `fract(0.1n)` on integers is a ten-step
  staircase — so the value noise built on it is far more correlated than it looks
  and its distribution is biased low (p50 0.39 against 0.50). On the gust field
  that was not a subtlety: whole screens saturated at one end of the front, so the
  meadow pulsed as one instead of having a boundary cross it. `grassNoise` gets
  its own trig-free hash; `hash21` is left alone, because it is the water's and
  the streak layer's and their looks were tuned against it.
- **The shared wind clock does not advance in a headless page.** With this layer
  switched off, the weather at maximum speed and the weather stilled change the
  same number of pixels over six seconds — the trees are not swaying either. It
  is why `preview-world.ts` only ever asserts on wind *strength*, and it means
  "the fronts move with the clock" has to be asserted over the transcribed field
  in Node rather than in a browser. A probe there reports a working front as a
  broken one, and very nearly did.

Two departures from the shape above followed. `macroTone` is **signed**, so the
middle of the field displaces the map's colour by exactly nothing rather than by
the midpoint of two tones that have no reason to be symmetric. And the gust is
**two-sided**, so a front lifts its leading half and drops the trailing one and
the meadow's mean brightness does not move — `GLSL_STREAK`'s own rule, arrived at
here independently.

## The art-direction pass after it

The first tuning shipped legible and **busy**: the strokes read as fingerprints
and brushed metal rather than as marks on grass. Four things were wrong, and
three of them are the same mistake in different places -- a number chosen for how
big it is rather than for how it sits against the frame.

- **Density, not amplitude.** Both micro tails at a 0.80 cut marked nearly half
  the meadow, and the stroke threshold passed about the same again. A faint mark
  everywhere is a grain; the fix is fewer marks, not quieter ones, so the cuts
  went up and the clump became a **gate** — outside one, the stroke field cannot
  reach its threshold from any value it takes, so that ground carries nothing.
- **Curl is a wavelength, not an angle.** The stroke direction was driven off the
  macro field, which swings its whole range every couple of hundred units — about
  the length of a few strokes, which is exactly the condition for a whorl. It is
  driven off a new long-wavelength *coarse* field now (~790 units), which lets the
  bend be *larger* and read as arcs.
- **A structure wider than the frame is not a structure.** Scaling the gusts 2.5x
  put a third of all frames wholly inside one lobe, and the front stopped crossing
  the clearing and started tinting it. Surveyed rather than guessed: 4% of frames
  blanketed at the original size, 33% at 320, 42% at 380.
- **A tint toward a tone shifts hue; a multiplier cannot.** With fronts that big,
  mixing toward the light tone — markedly redder than the base — turned the whole
  meadow yellow. The breath is multiplicative now, like `GLSL_STREAK`'s. The same
  trap caught the dry patches when they were briefly moved onto the coarse field:
  measured through the panel, zeroing the macro term took the ground's R/G from
  0.95 back to 0.86 against 0.83 with the layer off, so that one term was nearly
  all of the shift.

And one deliberate inversion of the band rule. The strokes are now worth **half**
a colour step at rest and a whole one at a gust's crest, where every other mark
clears a step standing still. That gap is the look: calm in a screenshot, alive
in motion. `gustReveal` is the other half of it — a front lowers the stroke
threshold as well as brightening it, so what passes is *more grass* rather than
the same grass lit harder.

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
- Every mark the layer draws — the macro tones, a gust front, a trail, a speck —
  is worth at least one whole colour step. The strokes deliberately invert it:
  under a step at rest, over one at a gust's crest, with the gap between them
  worth better than half a step on its own.
- Ground outside a clump carries no strokes at all, at any density the panel can
  ask for and at a gust's full crest — the gate, stated as arithmetic.
- The macro window is symmetric about the noise's own middle, and `macroTone(m, m)`
  at the middle is exactly zero.
- The front moves: over one screen of ground, a fifth to three quarters of it
  crosses a colour band in two seconds at the shipped drift, and a point two
  seconds downwind now reads exactly what its upwind neighbour read then.
- The GLSL names every uniform it declares and declares every uniform it names,
  samples the noise no more than the stated number of times, and declares every
  name it introduces **exactly once in the assembled shader** — the collision
  that stopped the ground compiling.
- The patch composes: applied fourth, the compiled fragment shader still carries
  the streak, the cavity and the detail, and the cache key carries all four.
- The uniform objects are shared by reference between two patched materials.

## Acceptance

`npm run build && npx tsx scripts/probe-living-ground.ts`, on the shipped page
and the map the game boots from. It defines its own footprint — with the clock
stilled, the pixels that change when the panel's Ground detail goes to zero *are*
the pixels this layer reaches — and measures inside it, so nothing depends on a
crop chosen by eye. Measured: 32% of the frame reached, a green-dominant mean
(so the layer stayed on grass and off the dirt path), 2,118 distinct tones in
that ground becoming 5,638, and a gust front that reaches 92% of it at the
ceiling.

`npx tsx scripts/probe-shading.ts` stays the tool for "does it link", and is what
caught the constant collision that stopped the ground compiling while every test
in Node was green.

## Out of scope

- Any geometry change. The ground stays the same triangles; nothing waves.
- Grass blades, billboards, instanced tufts, tessellation, parallax.
- The cliff walls, which keep `TERRAIN_CLIFF_COLORS` and their existing patches.
- The rock-by-slope blend (spec 106), which is a different question — that one
  replaces the material, this one varies it.
- A prop distance field for the forest-edge term; only the hook lands.
- The map editor's panel. The editor draws the same shared material and gets the
  look; the sliders are the Play tab's Weather popover.
