# 047 — Day/night cycle, player lights, and a colour filter

## Problem

Since spec 045 the isometric view has exactly one lighting state: a fixed sun at
40° of elevation, a fixed cool ambient fill, and a fixed `PALETTE.sky`
background. It is permanently mid-afternoon. Four things follow from that, and
all four are cosmetic — nothing here is a game rule:

1. **There is no time of day.** The sun's direction is a slider a human drags,
   not a clock. Nothing ties its *colour* or the sky's to where it sits, so
   dragging `Elevation` down to 10° gives a noon-white sun grazing the ground
   rather than a sunset.

2. **A low sun casts an unbounded shadow.** Shadow length on flat ground is
   `casterHeight / tan(elevation)`, which diverges as the sun reaches the
   horizon. At the 10° the `Elevation` slider already allows, a 300-unit tree
   throws a 1700-unit streak; at 2° it is 8600 units, far outside the shadow
   camera's `1.8 × halfWidth` reach, so the streak is also *clipped* — it
   crosses the frame and stops in mid-air. A day/night cycle drives the sun
   through the horizon twice per day, so this stops being a slider extreme
   nobody visits and becomes something the view does every dusk.

3. **The player carries no light.** Once there is a night, a dark scene with a
   uniformly-lit player in it reads as a bug. There is nothing in the renderer
   that lights *from* a unit — every light in the scene is global.

4. **There is no way to grade the image.** The retro pass (spec 038) quantizes
   and dithers, but always in full colour. A moonlit scene, a black-and-white
   scene, and a sepia evening are all reachable by grading the finished frame,
   and none of them are reachable today.

Everything in this spec lives in `src/render/iso3d/`. No sim, cards, terrain or
game module is touched, and no game outcome changes.

## Shape

### The sky clock (`daynight.ts`, new)

Pure, three.js-free and DOM-free, so the whole cycle is asserted headlessly:

```ts
export function skyAt(hours: number): SkyState;
export function advanceTimeOfDay(hours: number, dt: number, dayLengthMinutes: number): number;
```

`hours` is a wall clock in `[0, 24)`. `SkyState` carries the key light's
direction, colour and intensity, the ambient fill's colour and intensity, the
sky/background colour, and the horizon shadow decision below.

**The sun's arc** is an explicit half-turn, not an ephemeris:

```
elevation = MAX_SUN_ELEVATION * cos((hours - 12) / 12 * π)
azimuth   = SUNRISE_AZIMUTH + (hours - 6) / 12 * π
```

so noon is the peak, 06:00 and 18:00 are the horizon, and midnight is the
sun's mirror below it. `SUNRISE_AZIMUTH` is -175°, which looks arbitrary and
is not: it is chosen so that **15:00 reproduces spec 045's tuned sun** to
within a degree. That tuning was a deliberate look pass — a lit flank, a
shaded flank, and shadows falling across open ground rather than behind the
caster — and the cycle should pass back through it rather than replace it.
`DEFAULT_TIME_OF_DAY` is therefore 15:00 and the view opens looking exactly as
it does today.

**One directional light, not two.** Below the horizon the same light becomes
the moon: direction flips to the anti-sun (elevation `-sunElevation`, azimuth
`+π`), colour goes pale blue, intensity drops to a tenth of noon. A second
`DirectionalLight` would cost a second shadow map for a light that is not
allowed to cast anyway (see below), and the scene never wants both at once.

**Colours come from a keyframe ramp** over the clock — night, pre-dawn,
sunrise, morning, noon, golden hour, sunset, dusk, night — interpolated per
channel and wrapping at midnight. The noon keyframe is `PALETTE.sky` and the
existing sun/ambient values exactly, so the ramp is a superset of what ships.

### The horizon effect (`shadow.ts`)

This is problem 2, and it is the one part of this spec with a load-bearing
decision in it. Three separate things happen as the sun approaches the horizon:

```ts
export function horizonShadow(sunElevation: number): HorizonShadow;
// { castElevation, strength, casting }
```

- **The casting direction stops descending at `SHADOW_FLOOR` (8°).** This is
  what actually bounds the shadow: `1 / tan(8°)` is 7.1, so nothing casts more
  than ~7 times its own height, ever. The sun keeps setting in *colour* and
  *brightness* through the keyframe ramp — which is what the eye reads a sunset
  from — while the geometry quietly stops stretching. Clamping the light
  direction rather than the shadow length is what keeps this a two-line change
  instead of a shader.

- **`strength` ramps 1 → 0 over the last 15° (smoothstepped).** Bounding the
  length is not enough on its own: a 7×-height hard black bar at dusk is still
  wrong, because real shadows lose contrast as the sun reddens and the sky
  becomes the dominant source. `strength` is how much shadow contrast is left.

- **`casting` goes false below the horizon.** The moon does not cast. Moonlight
  casting long soft shadows is lovely and is not what this shadow map does:
  `BasicShadowMap` at 1024² has exactly one hardness, and a hard black moon
  shadow at midnight would fight the torch, which is the light the night is
  built around.

**How `strength` is applied, and why it is not `shadow.intensity`.** three
r165 added `LightShadow.intensity`, which is exactly this dial. The repo is on
0.160.1, where `LightShadow` has no such field — verified in
`node_modules/three/src/lights/LightShadow.js`. So the scene spends it on the
*ambient fill* instead: `ambientIntensity += (1 - strength) * SHADOW_FILL`.
Raising the fill lifts the shaded side toward the lit side, which is what
losing shadow contrast physically *is*. It comes out as dusk going flat and
shadowless, which is correct, and it needs no shader and no upgrade.

`shadowFrame` is otherwise unchanged; the floor keeps its existing assumptions
intact, since 8° still puts the shadow camera 1250 units up — clear of the
480-unit northern range.

### Player lights (`player-lights.ts`, new + `scene.ts`)

Pure math in the module, three.js objects in the scene, the same split
`shadow.ts` already uses.

**The torch** is a `PointLight` parented to the player rig, offset to the hand,
with a small unlit flame mesh beside it. It **casts shadows** — that is the
whole point of it, and the thing that makes a night walk read.

```ts
export function torchFlicker(seconds: number, seed: number): Flicker;
// { intensity, sway: { x, y, z } }
```

Flicker is layered 1D value noise over `hash2i` at ~11 Hz, 5.5 Hz and 2.3 Hz
with falling amplitude, plus a slow gutter term — *not* a sine, which reads as
a pulse rather than a flame. It is a pure function of `(seconds, seed)`, so it
is asserted headlessly for range, mean and continuity. The sway offsets the
light a few units, so the cast shadows swim slightly; a flame that only changes
brightness looks like a dimmer.

**The magic light** is the deliberate opposite, and is the second light source
the request asks for: a `PointLight` with `castShadow = false`, floating above
the player, bobbing and slowly orbiting, in a cool colour. It brightens
everything inside its range without producing a single new shadow — so it
*fills* a scene where the torch *models* it. Both can be on at once.

**Range is a slider; intensity is derived from it.** three 0.160 defaults to
physically-correct falloff (`_useLegacyLights = false`), so a point light's
intensity is candela and illuminance falls as `1/d²`. In a world where the
player is ~40 units tall, the intensity needed for a visible light is in the
tens of thousands, and it changes by 4× every time the range doubles. So the
panel's brightness slider means "how lit is the ground at half range" and the
module converts:

```ts
export function pointIntensity(brightness: number, range: number): number;  // brightness * (range/2)²
```

Without this the range slider silently doubles as a brightness slider, which is
the kind of coupling that makes a panel impossible to tune.

`PointLight.distance` is set to the range, so the light also *ends* there
rather than merely becoming faint — "a range at which it illuminates
surroundings" is a hard edge, and a hard edge is in register with the rest of
the look.

### The colour filter (`grade.ts`, new + `retro-pass.ts`)

A grade applied to the finished frame, in the existing post pass:

```ts
export interface GradeSettings { saturation, tint, tintStrength, gain }
export function gradeColor(rgb, settings): [number, number, number];  // reference model
export const GRADE_PRESETS;  // none | mono | evening | moonlight | fullmoon | bloodmoon
export function resolveGrade(preset, strength): GradeSettings;
```

Luminance-preserving duotone: desaturate toward luma, then blend toward
`luma × (tint / luma(tint))`, then gain. Normalising the tint by its own
luminance is what stops a strong blue tint from also being a 60% dimmer.

Two placement decisions:

- **The grade runs *before* quantization**, so a black-and-white image is
  quantized into a proper N-step grey ramp and dithered across it. Grading
  after would dither the colour image and then throw the colour away, wasting
  the palette on shades that no longer exist.
- **The pass runs whenever the grade is active, even with the retro filter
  off.** `RetroPass.render` currently short-circuits to a plain
  `renderer.render` when disabled; that path has nowhere to put a grade. With
  the filter off and a grade on it takes the quad path with `levels = 256` and
  `strength = 0`, which is a no-op quantization, and renders at full internal
  resolution regardless of `pixelSize`.

`GRADE_PRESETS` is data, so "evenings, full moons etc." is a table entry rather
than a code path. A `Filter strength` slider blends each preset back toward
identity.

### Panel (`view-controls.ts`)

A `Sky` section (day/night on/off, a `Time` slider reading `HH:MM`, a running
clock toggle and a day length), a `Player light` section (torch on/off, range,
brightness, flicker, shadow toggle; magic light on/off, range, brightness), and
a `Filter` row in the retro section (preset dropdown + strength).

The existing `Light` section's `Direction`/`Elevation` sliders are **kept**, and
take the sun back over when `Day/night sky` is unticked. Spec 033 exists so a
human can put the sun where they want it for a screenshot; a clock is a second
way to drive the same light, not a replacement for that.

`makeSlider` grows an optional value formatter (for `HH:MM`) and a
string-valued choice widget is added beside the numeric one.

## Invariants tested

- `skyAt` peaks the sun at noon, bottoms it at midnight, and puts it on the
  horizon at 06:00 and 18:00.
- `skyAt` is continuous across midnight — colours and intensities at 23:59 and
  00:01 are close — and total (defined for hours outside `[0, 24)`).
- `skyAt(DEFAULT_TIME_OF_DAY)` reproduces spec 045's `DEFAULT_LIGHT_OFFSET`
  direction to within a degree, and its noon keyframe is `PALETTE.sky` and the
  shipped sun/ambient values.
- Night is dimmer than day at every keyframe; the key light is the anti-sun at
  night and the sun by day.
- `advanceTimeOfDay` wraps at 24, is linear in `dt`, and completes exactly one
  day per `dayLengthMinutes`.
- `horizonShadow` never lets the cast elevation fall below the floor, so the
  shadow reach implied by any sun elevation — including 0 and negative — is
  **finite and bounded** by `1 / tan(floor)`. This is the spec's headline
  assertion.
- `horizonShadow.strength` is 1 well above the horizon, 0 at and below it, and
  monotonic between; `casting` is false at or below the horizon.
- The ambient fill rises as `strength` falls, so shade is never darker at dusk
  than at noon.
- `torchFlicker` is pure in `(seconds, seed)`, stays inside its documented
  band, averages ~1 over a long window (a flicker that averages 0.8 is a dimmer
  with extra steps), is continuous under small time steps, and differs between
  seeds.
- `pointIntensity` scales with the square of the range, so equal brightness at
  half range means equal apparent brightness at any range.
- `gradeColor` with the `none` preset is the identity; `mono` produces `r = g =
  b` equal to the input's luma; every preset preserves luma to within the gain
  it declares; `resolveGrade(p, 0)` is the identity for every preset.
- The reference `gradeColor` matches the fragment shader's expression term for
  term (asserted by construction — the shader is written from it).

## Out of scope

- **Any sim-visible consequence.** Enemies do not see less at night, the torch
  does not aggro, nothing burns. Every light here is renderer state; the sim is
  not told the time. A real day/night *rule* would have to make the clock sim
  state stepped at 60Hz, which is its own spec.
- Fog, god rays, bloom, light shafts, coloured shadow tinting.
- Stars, a moon disc, clouds, weather.
- Lights on anything other than the player — no torches on enemies, no
  campfires, no windows.
- Shadows from the magic light (deliberate — see above) and from the moon.
- The two sandbox views. They keep their single unshadowed light, as they did
  through spec 045.
