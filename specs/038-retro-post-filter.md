# 038 — Retro post-processing filter (ordered dither + palette quantization)

## Problem

The isometric view (spec 031) already fakes a retro look structurally: a low
internal resolution upscaled with `image-rendering: pixelated`, no antialiasing,
flat-shaded single-colour materials. What it still lacks is the *surface* texture
of the era it is imitating — with true-colour lighting, every lit face is a
smooth gradient of thousands of shades, which reads as "low-poly modern", not as
"1996".

The reference we are matching is a pixel-art screenshot where every object —
most visibly a heap of identical coins — carries the same fine repeating weave
inside its flat colour. That weave is not per-object art: it is what a limited
colour palette looks like when the renderer *dithers* to fake the shades it does
not have.

So the technique is **ordered (Bayer) dithering plus palette quantization, in a
single screen-space post-processing pass**:

- Quantization alone gives hard banding and kills the sense of a lit 3D surface.
- Dithering alone changes nothing (there is nothing to fake — the colour is
  already exact).
- Together, the continuous shading is snapped to `N` steps per channel, and the
  ordered threshold matrix chooses per pixel which side of a band edge to land
  on. Regions between two palette steps become a checker/weave of both — exactly
  the pattern on the reference coins — and it appears on *every* surface for
  free, regardless of geometry, because the pass runs on the final image.

Ordered dithering (rather than error-diffusion, e.g. Floyd–Steinberg) is the
right choice here specifically because it is a fixed, position-indexed
threshold: it is stable frame to frame, so a moving camera does not make the
texture crawl, and it is one texture lookup per pixel with no sequential
dependency, so it runs as a fragment shader.

## Shape

Two new modules under `src/render/iso3d/`, split so the maths is testable
headlessly and only the GPU plumbing needs a browser.

`retro.ts` — pure, no three.js, no DOM. The reference model of what the shader
does, one channel at a time:

```ts
export type BayerSize = 2 | 4 | 8;

export interface RetroSettings {
  readonly enabled: boolean;
  readonly levels: number;        // colour steps per channel, 2..16
  readonly ditherStrength: number;// 0..1.5; 1 = one full band edge
  readonly matrixSize: BayerSize; // Bayer matrix edge
  readonly ditherScale: number;   // dither cell size, in low-res pixels
  readonly pixelSize: number;     // internal-resolution divisor, 1..4
}

export const RETRO_DEFAULTS: RetroSettings;

export function bayerMatrix(size: BayerSize): number[][];      // 0..size²-1, each once
export function bayerThresholds(size: BayerSize): number[][];  // (m + 0.5) / size²
export function bayerTextureData(size: BayerSize): Uint8Array; // thresholds as bytes, for the GPU
export function quantizeChannel(v: number, levels: number): number;
export function ditherChannel(v: number, threshold: number, levels: number, strength: number): number;
```

`ditherChannel` is `quantizeChannel(v + (threshold - 0.5) * strength / (levels - 1), levels)`,
and `quantizeChannel` is `round(clamp01(v) * (levels - 1)) / (levels - 1)`. The
fragment shader computes this same expression per channel; `retro.ts` is the
spec of it and what the tests pin down.

`retro-pass.ts` — the three.js side:

```ts
export class RetroPass {
  constructor(width: number, height: number, settings?: RetroSettings);
  set(settings: RetroSettings): void;
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}
```

`render` draws the scene into a `NearestFilter` `WebGLRenderTarget` sized
`ceil(width / pixelSize) × ceil(height / pixelSize)`, then draws a fullscreen
quad to the canvas that samples it and applies encode → dither → quantize. The
Bayer thresholds ride along as an 8-bit `DataTexture` with `RepeatWrapping`, so
changing the matrix size re-uploads a texture instead of recompiling a shader.
When `enabled` is false it renders straight to the canvas, unchanged.

Colour space is handled explicitly: the scene renders into a linear-space target,
and the pass applies the linear→sRGB transfer itself before quantizing — so the
palette steps are evenly spaced in *display* space (which is what a retro palette
is), and the on-screen result with the filter disabled is unchanged.

`scene.ts` (spec 031) renders through the pass instead of calling
`renderer.render` directly, and `view-controls.ts` grows a **Retro** section
(on/off, colour steps, dither amount, weave size, pixel size) exposed as
`ViewControls.retro(): RetroSettings`, so the look can be dialled in live. The
control panel gains a `<select>` widget for the matrix size, which is an
enumeration rather than a range.

No sim, cards, or game code changes; this is entirely a renderer concern and
decides no game outcome.

## Invariants tested

- `bayerMatrix(size)` is a permutation: it contains every integer `0..size²-1`
  exactly once, for each of 2, 4, 8; and the 2×2 base case is the canonical
  `[[0,2],[3,1]]`.
- `bayerThresholds(size)` values all lie strictly inside `(0, 1)` and average to
  exactly `0.5`, so dithering does not shift overall brightness.
- `bayerTextureData(size)` has `size²` bytes matching the thresholds, row-major.
- `quantizeChannel` only ever returns one of the `levels` palette values, is
  monotonic, maps `0 → 0` and `1 → 1`, and clamps out-of-range input.
- `ditherChannel` output is likewise always a palette value; it is idempotent on
  exact palette values for `strength <= 1` (flat palette colours stay flat, no
  sparkle); and averaged over a whole threshold matrix it reconstructs the input
  to within one quantization step — the property that makes the weave read as an
  intermediate shade rather than as noise.
- Both are pure: same arguments → same result.

## Out of scope

- Applying the pass to the movement sandbox (spec 032) and rig debug (spec 035)
  viewports — those are dev tools, and the filter is about how the game looks.
- Depth/normal-based outlines around objects, palette *mapping* onto a fixed
  colour ramp (as opposed to per-channel quantization), CRT curvature,
  scanlines, and bloom.
- Error-diffusion dithering, and any dither that is indexed by world position
  rather than screen position.
- Any change to the sim, cards, or game layers.
