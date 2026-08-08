# 098 — A palette is data

## Problem

Step 6 of the hike arc asks for quantization to "a configurable palette / step
count", with an ordered 4x4 Bayer dither applied before it.

Most of that already exists. Spec 038's retro filter quantizes to a configurable
number of even steps per channel, dithers with a Bayer matrix of a configurable
size and strength, and has had sliders for all of it since it landed. What it
cannot do is snap to a **palette** — a named set of colours that were chosen
together, rather than a lattice of evenly spaced ones.

That is the whole of what is missing, and the constraint attached to it is the
interesting part: *palette and step counts are data-driven, not hardcoded in
shader source*.

## Shape

`retro.ts` grows the pure half, beside the Bayer maths it already holds:

```ts
export function nearestPaletteColor(r, g, b, palette: ArrayLike<number>): readonly [number, number, number];
export function paletteSpacing(palette: ArrayLike<number>): number;
export function paletteChannels(palette: readonly number[]): Float32Array;
export function paletteTextureData(palette: readonly number[]): Uint8Array;
```

`retro-pass.ts` gains `setPalette(colors | null)`, which uploads the colours as a
**one-row RGBA texture**. That is what "data-driven" has to mean in practice: the
shader loops over texels, so changing palette is a dropdown rather than a
recompile, and no colour appears anywhere in the GLSL.

`hike.ts` carries the palettes themselves as `HIKE_PALETTES`, and `HikeSettings`
gains a single `palette` field.

### One knob per thing

`HikeSettings` does **not** get `posterize`, `levels`, `dither` or
`ditherStrength`. Those were declared when the config was first sketched, and
spec 038's filter already owns all four with sliders in the same panel. A second
set would have been two controls for one behaviour, and the only genuinely new
question — steps or palette? — is answered by whether `palette` is null. So the
four were removed rather than duplicated.

### The dither is measured in palette spacing

With even levels a band is `1 / (levels - 1)` wide and the dither nudges by up to
half of one. A palette has no bands, so the equivalent nudge is half the typical
gap between neighbouring colours — `paletteSpacing`, the mean distance from each
entry to its nearest neighbour, computed on the CPU and passed as a uniform.

Without it one strength setting is a snowstorm on a tight palette and invisible
on a wide one, and the slider means something different for every palette.

### The shader loops to a constant

GLSL ES 1.00 will not take a loop whose count is a uniform, so the loop runs to a
fixed 16 and breaks at the real size. Sixteen is already more colours than the
look wants, and a longer palette would be silently truncated — which the tests
guard.

### A palette needs values, not just hues

The first version of `HIKE_PALETTES` was the world's albedo colours taken
straight from `palette.ts` — the foliage greens, trunk brown, stone, water, sky.
It destroyed the picture, and it is worth recording *why*, because the frame
still looked stylized and the numbers all passed:

Those are the colours a surface is **painted**. The frame being quantized is the
colours a surface is **lit**. Lighting spends most of its range below the albedo,
so nearly every pixel fell beneath the darkest entry and snapped to the same
green — trees and ground came out as one flat shape.

So each palette is now a few hue families across a few values: the world's own
colours scaled toward black for shadow and mixed toward white for highlight. The
hues are still the game's; what was added is the range the lighting actually
occupies.

## Invariants tested

**Pure** (`retro.test.ts`)

- `nearestPaletteColor` **snaps to an entry and never to an average of two** —
  the property that distinguishes a palette from a blend.
- It is **idempotent**: an entry snaps to itself.
- It **leaves a colour alone rather than blackening it** when there is no
  palette.
- `paletteSpacing` **measures the gap between neighbouring colours**, is
  **smaller for a tighter palette**, and is **zero when there is nothing to mix
  between** — which correctly switches the dither off for a one-colour palette.
- The texture bytes and the matching channels **agree with each other**; if the
  two representations drift, the shader quantizes onto colours no test ever
  checked.

**The palettes as data** (`hike.test.ts`)

- Every palette **stays inside the shader's loop bound**, so none is silently
  truncated.
- Every colour is **a real 24-bit hex**, ids are **unique**, and no palette
  **repeats a colour** — a duplicate is a wasted entry out of sixteen.
- An unknown id **falls back to even steps** rather than throwing.

**On a GPU** (`scripts/probe-shading.ts`)

- **100% of pixels are exactly a palette colour.** This is the claim a palette
  makes, and the only way to state it: not "the frame looks limited" but "every
  pixel is one of these sixteen values". A quantizer that is subtly wrong, or a
  palette texture that never uploaded, still produces a stylized-looking frame.
- The frame uses **no more distinct colours than the palette has**.
- Choosing a palette **changes the frame**, so it demonstrably reached the
  shader.

**In the real game** (`scripts/preview-hike.ts`)

The offscreen check proves correctness but cannot answer whether sixteen colours
are *enough*, because the probe's four-tree scene has only a handful of tones in
it under any palette — it reported three colours used out of sixteen, which says
everything about the test scene and nothing about the palette. So the real page
is driven through the real dropdown and photographed to
`.claude/screenshots/world-palette.png`.

## Out of scope

- **Tuning the palettes.** They are data and the point of this step is that
  trying another is a dropdown. Which colours are *right* is an art question.
- **Reordering posterization relative to the outlines.** They are already in the
  right order: the retro pass settles the fills and step 5's lines composite over
  them, which is what step 7 asks for.
- **Per-channel palettes, or a palette texture larger than one row.** Sixteen
  colours is past what the look wants.
- **The distance treatment**, which is step 7 and is where the fills stop being
  quantized in isolation.
