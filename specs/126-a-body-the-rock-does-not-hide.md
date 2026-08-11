# 126 — A body the rock does not hide

## Problem

Formations (specs 123-125) put 60-to-200 units of solid geometry on a world
drawn by an orthographic camera parked 6000 units back at a fixed isometric
angle. Anything standing on the near side of a tier, in a gully between two, or
in a courtyard walled by them, is simply behind rock.

This is not a subtlety to tune later. `.claude/screenshots/rock-probe-beside.png`
is a player entirely hidden by a tier they were standing beside — the health bar
floats mid-frame with nothing under it. Every game with this camera and this
geometry solves it somehow, and until it is solved a formation is something to
walk around rather than through.

The camera cannot be the answer. It is fixed by spec 033 and everything about
the look — the isometric preset, the fixed pitch, the ortho projection the LOD
and the outline passes assume — is built on it not moving.

## Shape

### The rule

A fragment is cut when it is **nearer the camera than the body** and **within a
radius of it, measured across the view**. Both halves are in view space, so the
radius is world units rather than pixels and the cut is the same size at any
resolution or window shape.

```ts
// src/render/iso3d/cutout.ts — pure, no three.js, no DOM.

export interface CutoutParams {
  /** Fully cut within this, in world units across the view. */
  readonly inner: number;
  /** Untouched beyond this. Between the two it stipples out. */
  readonly outer: number;
  /** How far in front of the body a fragment must be before it counts. */
  readonly depthBias: number;
}

export const CUTOUT_DEFAULTS: CutoutParams;

/** Coverage in [0, 1]: 1 draws, 0 is gone. The TS twin of the GLSL below. */
export function cutoutCoverage(
  fragView: { x: number; y: number; z: number },
  bodyView: { x: number; y: number; z: number },
  params: CutoutParams,
): number;

export const CUTOUT_PROLOGUE: string; // GLSL
export const CUTOUT_APPLY: string;
```

The GLSL lives here as strings with the TypeScript transcription beside it, and
the test asserts the two agree — the same arrangement `wind.ts` uses, for the
same reason: a shader expression nobody can execute is where a typo lives
forever.

### Stippled, not faded

Coverage becomes a **dither discard** against a 4x4 Bayer threshold on
`gl_FragCoord`, not an alpha blend. Three reasons, in order of how much they
matter:

- A blended cutout needs the terrain drawn in sorted order against itself, which
  a chunked mesh does not do and should not start doing.
- The retro pass already posterises and dithers the whole frame (spec 038), so a
  stipple is the grain the picture is already made of.
- `discard` costs nothing when coverage is 1, which it is for all but a few
  hundred fragments a frame.

### One uniform set, written once a frame

`cutout-uniforms.ts` owns the `IUniform` objects, exactly as `wind-uniforms.ts`
does, and the terrain surface, the terrain walls and the prop field are all
handed *those objects*. A radius of zero means no cut, which is the default and
what every view that never writes it gets — the map editor draws exactly what it
drew before.

The Play view writes the body's view-space position each frame and zeroes the
radius when it unmounts. The materials are module-level singletons shared with
the editor, so leaving a stale radius behind would cut a hole in a tab that has
no body in it.

## Invariants tested

- Coverage is 1 for a fragment behind the body, however close across the view —
  the rock a body stands in front of is never cut.
- Coverage is 0 for a fragment directly in front of it and within `inner`.
- Coverage rises monotonically from `inner` to `outer`, and is 1 beyond.
- A radius of zero yields coverage 1 everywhere, so an unwritten uniform draws
  the world untouched.
- The GLSL and the TypeScript agree across a sweep of positions, to a float's
  tolerance.
- The dither threshold covers all sixteen levels over a 4x4 block, so a coverage
  of 0.5 removes half the fragments rather than a diagonal band.

## Out of scope

- **A settings toggle.** The Play tab's corner has six buttons (spec 107) and a
  seventh is a change to that menu, not to this. The constants live in one place
  and are easy to lift into a panel later.
- **Cutting anything but terrain and props.** Monsters do not occlude — they are
  body-sized and moving, and a stipple around each one reads as a bug.
- **An x-ray silhouette.** Drawing the body's outline over what hides it is the
  other common answer and a bigger change: another pass, another render target,
  and a depth-test trick per body. Worth considering if the stipple proves not
  to be enough.
- **The camera.** It does not move, and nothing here asks it to.
