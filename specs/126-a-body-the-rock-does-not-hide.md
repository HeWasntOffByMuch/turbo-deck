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

A fragment is cut when it is **nearer the camera than the body**, **within a
radius of it measured across the view**, and **standing above the body's feet**.
The first two are in view space, so the radius is world units rather than pixels
and the cut is the same size at any resolution or window shape.

The third is in world Y and is not a refinement — without it the cut goes
through the floor as readily as through a wall, and the hole opens onto the sky.
The ground is never what is hiding anybody. A shin's margin comes with it,
because the body's ground height is sampled off the lattice while the surface
under it is drawn from jittered corners, and an exact test cuts a ring out of the
floor the body is standing on.

The radius is the other half of the answer, and the first attempt got it wrong.
At 58/96 the opening was 190 units across, nearly four bodies wide: it answered
"where is my unit" and then asked a worse question, because the wall it removed
is still solid to walk into and there was no longer enough of it on screen to
say where. A porthole of about one body across shows the unit and leaves the
wall either side standing to be read.

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

### Discarded, not blended — and the pattern is a choice

Coverage becomes a `discard`, never an alpha blend, because a blended cutout
needs the terrain drawn in sorted order against itself and a chunked mesh does
not do that and should not start. `discard` also costs nothing when coverage is
1, which it is for all but a few hundred fragments a frame.

*How* it discards is a setting, `Cutaway`, in the View menu's Terrain section:

- **Clean** (the default) takes the whole soft band, so the opening has a plain
  rim and nothing moving inside it.
- **Banded** keeps dark strata on the *vertical* faces, on world height, so a
  cut wall still reads as a wall. Level surfaces are cut plainly: one height
  across the whole of a tier top makes a band either swallow it or miss it, and
  a gentle slope turns the stripes into bars metres wide.
- **Stipple** dithers against a 4x4 Bayer threshold — the closest match to the
  retro pass's own weave (spec 038), and the noisiest.
- **Off** leaves the rock solid.

Four rather than one because none of them is obviously right, and two rounds of
picking a default proved it. Banded was the default for one of those rounds and
is worth the warning: cutting a tier's *top* exposes the inside of a hollow
shell, and strata on the far faces of one read as a birdcage. With the porthole
sized as it is, the wall is legible without any of this — which is why Clean is
the default.

### One uniform set, written once a frame

`cutout-uniforms.ts` owns the `IUniform` objects, exactly as `wind-uniforms.ts`
does, and the terrain surface and the terrain walls are both handed *those
objects*. A radius of zero means no cut, which is the default and
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
- A clean cut discards the whole soft band whatever the pixel, so no dither
  pattern survives in it; a stippled one keeps half of it; `off` keeps all.
- No style ever discards a fragment at full coverage.
- The default style is not the stipple.
- Nothing at or below the body's feet is ever cut, however squarely it is in the
  way — plus a shin of margin, since the sampled ground and the drawn one differ.
- What stands above the feet past that margin is still cut.
- The banded style keeps its strata regardless of the pixel, so it is a section
  and not a dither, and abandons them on a surface too level to carry one.
- The opening is around one body across, not four.
- Each style's numeric code lands on the right side of every branch the GLSL
  tests, so a renumbering cannot silently draw a different style.

## Out of scope

- **A seventh corner button.** `Cutaway` is a row in the View menu that is
  already there (spec 107), not a menu of its own. The radii stay constants.
- **The prop field.** `applySway` replaces `#include <project_vertex>` with its
  own expanded source, so the anchor the cutout needs is gone by the time a tree
  is patched, and a `String.replace` that matches nothing returns the string
  unchanged -- it would compile perfectly and cut nothing. `patchCutout` throws
  rather than allowing that, and trees are a pre-existing annoyance that
  formations did not introduce. Rock is what this is for.
- **Cutting monsters.** They do not occlude — they are
  body-sized and moving, and a stipple around each one reads as a bug.
- **An x-ray silhouette.** Drawing the body's outline over what hides it is the
  other common answer and a bigger change: another pass, another render target,
  and a depth-test trick per body. Worth considering if the stipple proves not
  to be enough.
- **The camera.** It does not move, and nothing here asks it to.
