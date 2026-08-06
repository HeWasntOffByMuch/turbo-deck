# 075 — A panel for the weather

## Problem

Spec 074 gave the world one wind, and no way to touch it. Every number in it is
baked into the shaders at build time, so the only way to see the trees lean
harder — or to hold a gust still long enough to look at it — is to edit a
constant and reload.

This puts three of those numbers behind a control: how hard the wind blows,
which way, and how fast the whole system runs.

## Shape

### A second button, not a second section

The view cog (spec 034) already carries twenty-odd rows and scrolls on a short
window. Weather also answers a different question: the view settings describe
how the world is *looked at*, and these describe what the world is *doing*. So
it is its own button and its own popover, sitting beside the cog in the same
top-right corner.

```ts
// src/render/iso3d/weather-controls.ts
export interface WeatherControls {
  readonly element: HTMLElement;   // the button and its popover
  settings(): WeatherSettings;     // for tests; the render loop never calls it
  reset(): void;
}
export interface WeatherSettings {
  readonly strength: number;    // multiple of the art-directed lean
  readonly bearingDeg: number;  // compass bearing the wind blows towards
  readonly speed: number;       // multiple of real time
}
```

### It writes; it is not polled

Every other panel here is polled — the scene asks it for a value each frame and
moves something to match. This one writes straight into the shared wind uniforms
on `input`, because those uniforms *are* the state. Polling would mean copying a
number into the same object sixty times a second in order to change it once an
hour, and the whole design of spec 074 is that nothing about the weather is
per-frame work except the clock.

`wind-uniforms.ts` therefore grows from one uniform to three, plus the setters:

```ts
export const WIND_UNIFORMS = { uWindTime, uWindDir, uWindStrength };
export function setWindStrength(multiplier: number): void;  // clamped
export function setWindBearing(degrees: number): void;
export function setWindSpeed(multiplier: number): void;     // scales advanceWind
export function resetWind(): void;
```

`uWindDir` and `uWindStrength` stop being GLSL constants and become uniforms —
the only two of spec 074's numbers that do. Everything else (the harmonics, the
gust envelope, the wave's spatial period, the water's palette and bands) stays
inlined, because it is art direction rather than a knob, and because changing
the wavelength while trees are mid-lean would teleport every crown.

### Three knobs

- **Wind strength**, 0–250% of the art-directed lean. 0 stands the forest up
  straight — note that this is a lean of zero, not a stopped clock, so the trees
  are *upright* rather than frozen mid-gust.
- **Wind direction**, a compass bearing. Its readout carries the compass point
  *and* how much of the motion lands across the screen, because the camera is
  fixed: a wind blowing along the view axis is working perfectly and looks like
  nothing at all, and a player who dials that in should be told rather than left
  concluding the feature is broken.
- **Weather speed**, 0–300% of real time. 0 holds the whole system mid-gust —
  the trees, the water and the streaks share one clock, so they stop together.

`WIND.dirX/dirZ` are now derived from a single `WIND_BEARING_DEG = -45` instead
of being two typed-out decimals, so the default direction is exactly unit-length
and exactly the diagonal the camera can see best, and the slider's default
position and the shader's default wind are one number rather than two that have
to be kept agreeing.

## Invariants tested

- The three uniforms every shader receives are the *same objects* the setters
  write to — identity, not equality — and survive being spread into a material's
  uniform map. A panel writing to a copy would look right in every screenshot of
  the trees and leave the water becalmed.
- `GLSL_WIND` declares exactly `uWindTime`, `uWindDir`, `uWindStrength` and no
  others; the wave's spatial period is still inlined.
- `setWindStrength` scales `WIND.strength`, clamps to `WIND_LIMITS` at both
  ends, and reaches 0 without touching the clock.
- `setWindBearing` produces a unit vector for any bearing, mutates the vector
  **in place** (so no material loses its reference), and round-trips
  `WIND_BEARING_DEG` back to exactly `WIND.dirX/dirZ`.
- `setWindSpeed` scales what `advanceWind` adds; 0 holds the clock and resumes
  from where it paused.
- `resetWind` restores the clock, the speed, the strength and the direction.
- `screenVisibility` is 1 along the default bearing, ~0 along the view axis,
  symmetric under a half-turn, and never leaves `[0, 1]`.
- `compassPoint` names the eight points, wraps negatives, and rounds to nearest.
- Instance bounding spheres are inflated against `WIND_LIMITS.maxStrength`
  rather than against the default. Bounds are written once at build time and the
  slider moves afterwards; sizing them for 100% and then allowing 250% is the
  same bug as not inflating them at all, only rarer.

## Out of scope

- The panel itself is DOM and the suite runs in Node, so the widgets are not
  unit-tested — the same position `view-controls.ts` and `hud.ts` are already
  in. What decides anything (clamping, conversion, uniform sharing) is pure and
  is tested.
- Persisting the settings across a reload. Nothing else in this shell persists
  its panel either.
- The map editor and the two tuning sandboxes. They draw the weather but have
  their own control surfaces (lil-gui, and a shared `buildPanel`); adding a
  fourth surface for three sliders is not worth it until someone asks.
- Rain, cloud, fog, lightning, and anything else the word "weather" suggests.
  There is one wind vector and this is a panel for it.
