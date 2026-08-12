# 138 — The one body the palette does not get

Behind `RetroSettings.excludePlayer`, on by default, and inert unless a caller
names something to exempt.

## Problem

The retro filter (spec 038) is a full-frame post-process: `RetroPass` draws the
whole scene into a low-resolution buffer and then quantizes every channel of
every pixel to a handful of steps, dithering across the band edges. Because it
runs on the finished image it has no idea what it is looking at, which is
exactly why it needs no per-material work and why every particle and every
prop is inside the pixel buffer by construction.

That is the right trade for the world and the wrong one for the player. Twelve
steps per channel is a lot of shading for a hillside and very little for the
one body somebody looks at for hours: a coat colour, a trim and a skin tone
that were picked to be told apart land on the same three steps, and the
character reads as a smear of the terrain behind it. Cranking `levels` up to
fix the body flattens nothing and un-retros the world.

What is wanted is narrow: the player's own pixels keep their colours, and
everything else about them stays the same. Same pixel grid, same grade, same
distance treatment, same outline. Only the quantize and the dither let go.

## The distinction being drawn

**Pixelation and grade are where a body *is*. Quantization is what a body *is
made of*.**

So the exemption is drawn exactly there:

| Stage | Exempt pixels |
|---|---|
| Low-resolution buffer (`pixelSize`) | **applied** — the mask is rendered at the same resolution, so an exempt pixel is on the same grid as its neighbours |
| Distance treatment / ink (spec 103) | **applied** — a body at the back of the frame recedes with the ground it stands on |
| Colour grade (spec 047) | **applied** — an evening grade that skipped the player would light one body from a different sky |
| Bayer dither | **skipped** |
| Level quantization | **skipped** |
| Palette snap (spec 102) | **skipped** |
| Outline pass (spec 101) | **applied** — it runs after this pass and never knew about it |

Keeping the grade is the line most likely to be argued with, and it is the one
that makes the effect read as a character rather than as a compositing bug. The
grade is identity by default, so out of the box this changes nothing but the
banding.

## Shape

A mask, rendered at the scene buffer's resolution, sampled by the shader that
was already running.

```ts
// retro.ts — the setting, and the reference model of the mix
interface RetroSettings {
  /** Leave exempt pixels out of the dither and the quantize (spec 138). */
  readonly excludePlayer: boolean;
}

/**
 * Whether the exemption is worth rendering a mask for: something to exempt,
 * and something to exempt it from.
 */
function exemptionIsLive(
  settings: RetroSettings,
  hasPalette: boolean,
  exemptCount: number,
): boolean;

/** What the shader does per channel: an exempt pixel is returned untouched. */
function exemptChannel(
  v: number,
  threshold: number,
  levels: number,
  strength: number,
  mask: number,
): number;
```

```ts
// retro-pass.ts — who is exempt is the caller's business
class RetroPass {
  /**
   * Roots whose pixels skip the quantize. Must be direct children of the scene
   * passed to `render`; anything else is silently not exempt.
   */
  setExempt(roots: readonly THREE.Object3D[]): void;
}
```

```ts
// world/scene.ts — the caller, which is the only thing that knows what a player is
this.retro.setExempt(playerGroups); // every body with kind === 'player'
```

## How the mask gets its occlusion

The mask is a second render of the same scene through the same camera, with
every direct child of the scene hidden except the exempt roots, and a flat
white unlit `overrideMaterial`. It draws into a second render target **that
shares the scene target's `DepthTexture`**, with `depthWrite` off.

That sharing is the whole trick, and it is why this costs one small draw rather
than a second full scene render. The depth of the finished world is already
sitting in that attachment from the pass that just ran, so a player standing
behind a tree fails the depth test and leaves no mask — the tree in front of
them quantizes like the rest of the world, because as far as the mask is
concerned the player is not there.

Two consequences worth writing down:

- The scene target grows a `DepthTexture` where it had a depth renderbuffer.
  It is written and depth-tested against, never sampled.
- The two targets share one texture object, so only one of them may dispose it.

The mask pass clears colour only. Clearing depth would throw away the very
thing it is testing against.

## Cost

One extra draw of one rig at the low resolution, and only while the exemption
is live. `exemptionIsLive` is false when the retro filter is off with no
palette set (there is nothing to be exempt from), when the setting is off, and
when nobody has been named exempt — which is every caller except the Play tab.
The probes, the Studio preview and the wind rig construct a `RetroPass` and
never call `setExempt`, so they render exactly as they do today.

## Invariants tested

- `exemptChannel` with `mask = 1` returns its input unchanged, for every
  level count and dither strength — the exemption is not "less quantized", it
  is "not quantized".
- `exemptChannel` with `mask = 0` equals `ditherChannel` term for term, so the
  unexempt path is provably the path that shipped.
- `exemptionIsLive` is false with an empty exempt list, false with the setting
  off, false with the filter off and no palette, and true with the filter off
  when a palette is set.
- `RETRO_DEFAULTS.excludePlayer` is on, and a `RetroPass` that is never handed
  an exempt root draws exactly twice — the scene and the quad, the sequence
  that shipped before this spec.
- The mask draw happens after the scene and before the quad, into a third
  target that is neither the scene buffer nor the canvas, with only the exempt
  roots visible.
- The mask buffer is cleared to black, **colour only**, and nothing else is
  cleared. Clearing depth would discard the world depth the mask tests against.
- The pass gives back everything it borrows: the scene's background, its
  override material, the visibility of every top-level child (including one
  that was *already* hidden, which must stay hidden), and the renderer's
  `autoClear` and clear colour.
- A root that is not a direct child of the scene is not exempt, and does not
  drag its siblings into the mask.
- The mask buffer is the scene buffer's size across resizes and pixel sizes,
  and the two share one `DepthTexture` that only the scene buffer disposes.

`WorldScene`'s half — that the exempt list is every body with `kind ===
'player'` and nothing else — is **not** covered. It is three lines inside the
three.js half of the renderer, which has no headless test anywhere in the tree;
`scripts/preview-world.ts` is what looks at it.

## Out of scope

- **A full-resolution player over a retro'd world.** The mask is rendered at
  the scene buffer's resolution and the player stays on the world's pixel grid.
  Escaping `pixelSize` means compositing after the quad, which means restoring
  a full-resolution depth buffer to the default framebuffer, which means the
  spec 099 buffers stop being optional. Different change, much bigger.
- **Per-body exemption in the fiction** — no "boss units are exempt too" list.
  `setExempt` takes objects, so that is a caller-side change if it is ever
  wanted.
- **A strength slider.** The mask is 0 or 1 and the shader mixes on it, so a
  partial exemption is a uniform away, but nothing has asked for one.
- **The other five settings popovers.** This adds one checkbox to the retro
  panel and touches nothing else in `view-controls.ts`.
