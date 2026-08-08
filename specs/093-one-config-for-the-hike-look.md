# 093 — One config for the hike look, and the colour under it

## Problem

The look being aimed at is *A Short Hike*: a low-resolution pixelated frame,
flat shading over a limited palette, outlines found from depth and normals, and
distant geometry falling away to flat ink-bounded shapes. That is roughly ten
pieces, landing over roughly ten commits, and every one of them changes what
every pixel on the screen is. Two things have to exist before the first of them
lands.

**One place holding every toggle.** Ten pieces that can only be judged together
cannot be judged at all: a frame that looks wrong after the seventh is a frame
with seven suspects. Each piece needs its own switch, defaulting off, so it can
be turned on alone and turned off again — and so that "everything off" is a
single defined state that can be asserted to match what shipped before any of
this started.

**Certainty about colour.** Posterization picks palette steps, edge detection
compares depths against thresholds, and the distance treatment lerps toward
albedo. All three are arithmetic on colour values, and all three are silently
wrong if the transfer function underneath them is. Getting this wrong does not
look like a bug; it looks like every threshold needing a slightly different
number than it should, forever.

The audit of the second one found the pipeline **already correct**. three r160
enables `ColorManagement` by default, defaults `outputColorSpace` to sRGB, and
this repo does not fight either: lighting runs in linear working space, the
encode happens once at output, `new THREE.Color(hex)` decodes the palette
constants from sRGB, the day/night cycle passes `SRGBColorSpace` explicitly, and
`RetroPass` renders to a linear target and applies the exact transfer itself.

So the deliverable here is not a fix. It is the **reasons written down as
tests**, because every one of those is a *default* — a three upgrade, or one
stray `outputColorSpace =` line, flips any of them with no visible symptom until
the edge thresholds quietly stop meaning what they meant.

One genuine defect did fall out: the editor's marker discs are drawn into a
canvas with sRGB colours and sampled with no colour space set, so they are the
one place in the codebase where `MARKER_COLORS` does not come out as
`MARKER_COLORS`.

## Shape

`src/render/iso3d/hike.ts` — pure, no three, no DOM, headlessly tested, and
added to `PURE_RENDER` in `eslint.config.js` so it stays that way. It is to the
hike passes what `retro.ts` is to `RetroPass`: the settings shape the control
panel edits, plus the reference maths the shaders transcribe.

```ts
export interface HikeSettings { /* one field per numbered step, below */ }

/** Every switch off. This state must render identically to the build before
 *  any of spec 093's work landed. */
export const HIKE_OFF: HikeSettings;

/** The sRGB transfer function, both directions, as the reference the GLSL
 *  mirrors term for term. */
export function srgbEncode(linear: number): number;
export function srgbDecode(encoded: number): number;
```

The settings object declares **all ten steps' fields now**, at their off/neutral
values, rather than growing a field per commit. The point of it is to be the one
place a reader can see what this arc is doing and what state the frame is in; a
config that only describes the steps already landed cannot do that. Each field
carries the step that wires it, and until that step lands the field is inert.

Thresholds, palette steps and distances live here as data — never as constants
compiled into shader source — so they can be tuned without a rebuild.

### Why colour correctness gets no toggle

Every *other* step gets one. This one does not, because there is no A/B to run:
the alternative to a correct transfer function is a wrong one. The marker disc
fix is the same — a toggle for "sample this texture as the wrong colour space"
is not a setting, it is a bug with a switch on it.

## Invariants tested

**The config**

- **Every boolean in `HIKE_OFF` is false**, checked by walking the object rather
  than by listing fields, so a switch added later without an off default fails
  the test instead of shipping on.
- **The debug view defaults to off**, and every named debug view is distinct.

**The colour transfer** (`hike.test.ts`, pure)

- `srgbEncode` and `srgbDecode` **round-trip** across the range.
- Both **pin the ends exactly**: 0 maps to 0 and 1 maps to 1, so a fully lit
  surface cannot drift by a quantum.
- **The known midpoint**: sRGB 0.5 is linear 0.2140, i.e. the curve is the real
  piecewise transfer and not a `pow(2.2)` approximation of it.
- The **linear segment below the knee** is used, not the power curve.

**three's colour management** (`color-space.test.ts`, imports three)

These are the regression guards. Each asserts a default this repo depends on and
does not set.

- **`ColorManagement.enabled` is on**, and the working space is linear-sRGB.
- **`new THREE.Color(hex)` decodes** — for every constant in `PALETTE`, the
  three channels match `srgbDecode` of the hex's bytes. This is what makes
  `terrain-mesh.ts`'s `linearColor()` and every `flatMaterial(color)` correct.
- **`setRGB(r, g, b, SRGBColorSpace)` decodes the same way**, which is the form
  `daynight` drives the sun, the ambient and the sky through.
- **A hex read as linear differs from a hex read as sRGB**, so the test above is
  proving the decode happened rather than passing on a no-op.

**Not tested, and why**: the marker disc's colour space. `marker-view.ts` builds
its texture with `document.createElement('canvas')`, and vitest runs in a `node`
environment with no DOM. It is a one-line change verified by reading it.

## Out of scope

- Any of the nine steps that follow. This commit wires no field it declares; it
  establishes the object they will be switched from.
- `RetroSettings` and `GradeSettings`. The existing retro pass keeps its own
  shape and its own defaults; step 6 folds posterization into the hike config,
  and until then the two are independent.
- Persisting settings. `view-controls.ts` deliberately holds no state of its own
  and opens at defaults every session; that is not changed here.
- Tone mapping. `NoToneMapping` clips overbright in linear before the encode,
  which — the transfer being monotonic with `f(1) = 1` — is the same clip the
  renderer performs writing to an 8-bit target. It is a look decision, not a
  correctness one, and there is nothing to fix.
