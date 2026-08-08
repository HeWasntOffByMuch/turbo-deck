# 099 — What distance does to a fill

Step 7 of the hike arc (spec 093). Behind `HikeSettings.ink`, off by default.

## Problem

Distant geometry in this world is a smaller version of near geometry: the same
gradients, the same colours, the same amount of detail, just less of it. In the
look being imitated the far distance stops being *shaded* at all. A far hillside
is one flat tone with a line around it, and the eye reads the frame as depth
because the near things are lit and the far things are drawn.

The instinct is to fog the frame. That gives haze, which is a different picture:
everything goes soft together and the far shapes lose their edges along with
their shading.

## The order is the effect

The treatment runs on **fills only**, inside the retro pass, before the grade and
before quantization. The outline pass runs afterwards and lays its line down at a
constant dark value, unaffected by depth.

So as geometry recedes:

- its fill loses the shading gradient (`inkFlatten`),
- drains toward grey (`inkDesaturate`),
- drifts toward the live sky (`inkFog`),
- and its **outline stays exactly as dark as an outline in the foreground**.

That last line is the whole step. Everything else here is bookkeeping.

## Where the distance is measured from

**Past the camera's focus point, not away from the camera.**

The camera is orthographic and parked a fixed 6,000 units back regardless of
what it is looking at. At the default zoom the visible frame spans about 700
units of depth — all of it within ±350 of 6,000. So "distance from the camera"
is a constant plus a small variation, and a ramp written in it either misses the
whole frame or swallows it.

The first version of this shipped with `inkStart: 1200`, `inkEnd: 5200` — the
distances that sound right for a map thousands of units across — and put every
visible pixel past the far end of the ramp. It read as a filter over the picture,
not as distance, and the real-page check caught it: the near third of the frame
moved as much as the far third.

Measured from the focus, 0 is the ground under the player, the settings mean what
they are named, and the ramp survives the Distance slider and the zoom moving the
absolute depth of everything without changing what is near or far *in the frame*.

## Flattening, without an albedo buffer

The brief asks for a lerp toward flat albedo. There is no albedo buffer, and
adding one means reproducing every material's diffuse — vertex colours, instance
colours, the terrain's per-cell tones — inside a stand-in shader.

What the flattening is *for* is losing the gradient. That is reachable from the
lit colour alone: hold hue and chroma, push luminance toward a constant. A
surface whose pixels share a luminance has no gradient left. Lambert shading is
albedo times a scalar, so a lit pixel and a shaded pixel of one surface differ
only in luminance — which is exactly the quantity being normalized, and why the
two collapse onto each other *exactly* rather than approximately.

An approximation of the stated method; an exact implementation of the stated goal.

## Two things the brief asked for that this world does not have

**"Fade outline alpha below an on-screen-size threshold."** Under an orthographic
camera screen size does not change with distance, so a pebble is the same few
pixels at the back of the map as at the player's feet. "Small because distant" is
not a category that exists here.

The flicker the request names is real, though, and it is about *isolation*: a line
one or two pixels long has nothing holding it steady and blinks as geometry
crosses a sample boundary. So the test is `outlineMinNeighbours` — coherence,
counted over the eight surrounding pixels — which targets the same artefact by the
property that actually predicts it here.

**"Scale normal-edge sensitivity up with distance."** Taken as written:
`inkEdgeGain` divides the normal threshold as the ramp comes on. A far shape has
lost its shading, so its line is the only thing left describing it.

## Two colour-space defects this step surfaced

Both are the same mistake and neither was visible as a wrong-looking frame.

A `ShaderMaterial` gets no `colorspace_fragment` appended by three.js, so
whatever it writes lands in the framebuffer verbatim. The retro pass knows this
and encodes the lit frame itself. Two constants did not:

- **The outline colour.** Held linear like every colour here, written raw over a
  display-space frame: `0x1a1a22` drew as `0x030304`. Still "a constant dark
  value", which is precisely why nothing gave it away.
- **The fog colour.** The live sky, also linear, mixed into a display-space fill —
  dragging distant geometry toward a sky about twice as dark as the one behind it,
  so the horizon would have read as a band rather than as a vanishing.

`glslSrgbEncodeChunk()` in `hike.ts` is now the single definition of the transfer,
interpolated from the same constants `srgbEncode` uses, and both passes call it.
`hike.test.ts` pulls the numbers back out of the shader source and evaluates the
expression against the reference, so the check is that the GLSL *computes* the
transfer rather than that it looks like it.

## Data and API

Nothing crosses the wire and nothing reaches the sim. `src/render/iso3d/ink.ts` is
pure and holds the composition; `RetroPass.setInk(depth, near, far, origin, fog,
settings)` switches it on; `HikeEdges.render(..., inkOrigin)` ramps the edge gain
on the same origin.

New in `HikeSettings`: `ink`, `inkStart`, `inkEnd`, `inkFlatten`, `inkDesaturate`,
`inkFog`, `inkEdgeGain`, `outlineMinNeighbours`. Defaults `80` and `380` for the
ramp, sized to the frame at the default zoom.

## Invariants, and where each is checked

Headlessly, in `ink.test.ts`:

- the ramp is zero at `inkStart`, one at `inkEnd`, monotonic, and smoothstepped
  rather than linear — a linear ramp leaves a visible line across the ground
  because the eye finds the break in the *slope*;
- at full flatten, every colour comes out at the same luminance, with chroma
  ratios preserved;
- a near-black pixel is left alone rather than divided by nearly zero;
- the three terms compose in the order flatten → desaturate → fog, and the GLSL
  transcription applies them in the same order.

On a real GPU, in `scripts/probe-shading.ts`:

- **near fills do not move at all** (0.0% of pixels changed) and far fills all do
  (100%);
- far fills close on the sky (mean gap 52.4% → 19.3%);
- the far band's shading spread — the gradient, as a standard deviation of
  luminance — collapses 0.015 → 0.002;
- **a full-strength outline pixel has the same value near and far** (28.7 and
  28.7, out of one composited frame);
- and it is the colour the setting names: `rgb(26, 26, 34)` for `0x1a1a22`.

Both of the last two were checked for discrimination by reintroducing the defects
they exist to catch: fading the line with distance moved them to 3.3 near and 82.3
far, and dropping the encode moved the colour to `rgb(45, 61, 53)`.

On the real page, in `scripts/preview-hike.ts`: with the checkbox thrown by a real
click, mean chroma in the far third of the frame falls 16.5% → 11.5% while the
near third holds at 17.9%. Measured as a statistic *per frame* rather than as a
difference between two, because the world is live — differencing two screenshots
a second apart reported ~19% change everywhere with the feature off, which says
nothing about the feature.

## Out of scope

- The outline colour and strength stay spec 097's; this step only fixed what
  space they were written in.
- No albedo buffer, for the reason above.
- Nothing here touches the server, the protocol, the sim, or picking.
