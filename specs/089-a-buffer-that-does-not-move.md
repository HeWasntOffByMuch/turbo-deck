# 089 — A buffer that does not move

## Problem

The play view already renders small and lets CSS stretch the result, which is
why the frame is *chunky* today. It is not pixel art, for two reasons that are
both about arithmetic rather than about taste.

**The buffer changes size with the window.** `internalRenderSize` fixes the
height at 300 and takes the width from the window's aspect (capped at 760, above
which the height shrinks instead). So a pixel is a different size in a different
window, and reshaping the window reshapes the art.

**The upscale is fractional, and blind to the display.** The canvas is
`width: 100%` with `image-rendering: pixelated`, and `setPixelRatio(1)`. A 300px
buffer shown across a 900px-tall box is 3x; across a 1000px-tall box it is 3.33x,
which means one row in three is drawn twice and the grid visibly beats against
itself. And on a retina display none of it is measured in real pixels at all: a
960x540 CSS box is 1920x1080 device pixels and could show a 480x270 buffer at
exactly 4x, while the current code reasons entirely in CSS pixels.

Nothing snaps the camera either, so the world slides continuously behind whatever
grid it is being sampled onto, and every edge in the frame shimmers between two
rows as the view follows the player.

## Shape

Added to `view-frame.ts`, which already owns this view's framing arithmetic, and
which joins `PURE_RENDER` in the same change.

```ts
export interface PixelFrame {
  readonly scale: number;      // DEVICE pixels per virtual pixel, a whole number
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}
export function pixelFrame(cssW, cssH, devicePixelRatio, virtualW, virtualH): PixelFrame;
export function snapToPixelGrid(position, right, up, worldPerPixel): Vec3Like;
export function worldPerPixel(spanWidth, virtualWidth): number;
```

`hike.ts` grows `VIRTUAL_SIZES` (four 16:9 buffers, data not sliders) and
`virtualSizeById`. The panel gets `lowRes`, `virtualSize` and `snapCamera`.

### Letterboxing as the canvas's own box

The letterbox is expressed by making the **canvas element** smaller and offset,
not by insetting a viewport inside a full-bleed canvas. That is the whole reason
this change does not have to touch a single line of picking code.

Every cursor-to-world conversion in the renderer already derives NDC from
`canvas.getBoundingClientRect()`. Once that rect *is* the letterboxed image, the
offsets cancel without any caller knowing they exist — and mouse listeners live
on the canvas, so a click in the letterbox is not an out-of-range coordinate to
be clamped, it is an event that never fires. The alternative, a full-bleed canvas
with a viewport inside it, would have required a letterbox term in all nine
conversion sites and in both world-to-screen projections, each of which is a place
to get it wrong once and never notice.

The consequence is that the DOM overlay has to be moved to match the image rather
than the window: the anchors it hangs health bars from are in canvas space.

### No blit shader

Sizing the backing store to exactly the virtual buffer and giving the canvas a CSS
size of `scale` device pixels per virtual pixel makes the browser's own upscale
the integer one. `image-rendering: pixelated` is *defined* as nearest-neighbour;
a fullscreen quad of our own would do the same thing with more code and one more
pass. It is already set.

### Snapping, and the one place it must not reach

`snapToPixelGrid` moves the camera onto the virtual lattice along its own right
and up axes, leaving the view-direction component exactly alone so the clip planes
do not move.

It is applied for the draw and **undone immediately afterwards**, because picking
must not see it. A snapped matrix answers "which cell is under the cursor" with up
to a pixel of error and flips that error from one side to the other as the camera
crosses a snap boundary — so a cell under a stationary cursor would change
identity while the player walks past. Move orders and attack targets come through
those conversions, which makes this the one rounding choice in the renderer that
could change a game outcome.

Which puts the two directions on opposite sides of the snap, and that is
deliberate:

| | camera | why |
|---|---|---|
| `screenToWorld`, `pickUnitAt`, hover | unsnapped | it is a pick; stability wins |
| screen anchors for the DOM overlay | snapped | must agree with the drawn body |

An anchor computed off the unsnapped camera would jitter against the body it
labels by up to half a virtual pixel, which at 4x is two CSS pixels of health-bar
wobble — the exact shimmer the snap exists to remove, reintroduced in the
overlay.

### Offsets are snapped to the device grid too

Centring leaves a remainder and half of an odd remainder is half a device pixel,
which is enough for the browser to resample the entire image while every size
involved is still perfectly integral. Each offset is floored onto the device grid,
putting any odd pixel on the right and bottom.

## Invariants tested

**Pure** (`view-frame.test.ts`)

- **The factor comes from device pixels**: 1920x1080 at dpr 1 and 960x540 at
  dpr 2 both give 4x. Choosing from the CSS box would give the second one 2x,
  throw away half the display and still resample.
- **Sized in whole device pixels at dpr 1, 2 and 3**, across a spread of window
  sizes.
- **Positioned on whole device pixels**, for odd remainders at every ratio.
- **The remainder becomes letterbox** rather than stretch, and is never negative.
- **Never below 1x**: a window too small clips instead of shrinking the buffer.
  The virtual resolution is an input, never an output — asserted as a property
  across a sweep of window widths.
- **Degenerate boxes and nonsense ratios** produce something usable.
- `snapToPixelGrid` **lands on the lattice**, **is idempotent**, **never moves
  more than half a pixel**, **leaves the view-direction component untouched**,
  **snaps along the camera's axes rather than the world's** (an isometric right
  vector is diagonal in world space), and **does nothing for a nonsense step**.

**In a real browser at real ratios** (`scripts/probe-lowres.ts`)

Seven window sizes across dpr 1, 2 and 3, driven through the panel the player
uses rather than by reaching into the scene:

- the backing store **is** the virtual buffer, whatever the window does;
- the canvas is **sized and positioned** in whole device pixels;
- `image-rendering` computes to `pixelated`;
- the overlay's box **matches the image's box**;
- and the claim no number can make: **every `scale` x `scale` block of device
  pixels in the finished frame is one flat colour.** Every size can be perfectly
  integral and the image still be filtered — that is precisely what a factor
  chosen from CSS pixels produces on a retina display, with every number still
  looking correct.

## Out of scope

- **Pixelation in the map editor.** It bypasses this path entirely (its own
  renderer, `antialias: true`, `dpr` up to 2, straight to the canvas), so it is
  unaffected and keeps working. Giving it an independent switch means its own
  pass instance and getting the gizmo, cursor and marker overlays drawn after it;
  that is its own change.
- **Retiring `internalRenderSize`.** With `lowRes` off the view is drawn exactly
  as before, which is what makes "every switch off is the build that shipped"
  checkable.
- **Context loss.** Still unhandled, as it has been since spec 038 put a render
  target on screen. It belongs with step 4, where the buffers that actually need
  recreating arrive.
- **The far plane and the sky**, which step 5 has to define before it can decide
  what does and does not get an outline.
