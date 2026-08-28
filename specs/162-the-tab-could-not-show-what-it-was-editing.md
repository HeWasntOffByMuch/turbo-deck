# 162 — The tab could not show what it was editing

## Problem

Switching `Ends by` in the VFX tab appeared to do nothing. The field was added in
spec 161, offered in the panel, and the report was that the two values looked
identical.

The plumbing was all correct — the select writes, `writeField` clones,
`compileEmitter` reads it, `VfxLayer.sync` passes it, the batch uploads it. Every
existing check was green, and every one of them was checking the wrong end. Three
separate things were wrong and none of them was the wiring.

**1. The preview never zooms in.** `resize()` framed the camera with
`Math.max(cameraSpan, fit.span)`. `previewFrame` measures how big a box the
effect actually needs; `cameraSpan` is the cog's world zoom, 640 units across by
default because that is the *Play tab's* zoom. So every effect smaller than the
game's zoom was drawn at the game's zoom: a blood hit came out about a tenth of
the viewport wide. Measured, the whole effect covered **1% of the canvas** — so a
field that changes the last third of a mark's life moved a few dozen pixels, and
of course it looked like nothing.

**2. The ending was partly applied at birth.** Both decay paths tested
`smoothstep(0, band, x - leaving)`. At `leaving = 0` that is `smoothstep(0, band,
x)`, which is already below 1 wherever `x` is below the band — so retract pinched
the first 9% of every mark from its first frame, and **fizzle was permanently
full of holes rather than coming apart into them.** Most of the difference
between the two was therefore baked in at birth instead of happening over the
life, leaving very little to watch.

**3. The fizzle had no room.** Both endings ran over `smoothstep(0.58, 1.0,
age)`. A retract is a *finish* and wants that: fast, at the very end. A fizzle is
a *decomposition* and needs to be most of the way through while the mark is still
opaque — over the same window it completed at the same moment the alpha fade
reached zero, so the whole coming-apart happened inside the last two barely
visible frames.

## Shape

**The cog becomes a zoom rather than a floor** (`studio/vfx-view.ts`):

```ts
const zoom = cameraSpan / (DEFAULT_VIEW_HALF_WIDTH * 2);
const span = Math.max(20, fit.span * zoom);
```

The measured frame is honoured, an effect fills the viewport at the default zoom,
and the cog still works in both directions. The case the old line was protecting
— a hundred-unit aura cropped when the camera is raised — is unaffected, because
`previewFrame` measures a **bounding sphere**, which is the same size from every
angle by construction.

**Both endings sweep their threshold from below** (`vfx/batches.ts`):

```ts
float cut = leaving * (1.0 + band) - band;   // from -band to 1.0
alive = smoothstep(0.0, band, x - cut);      // exactly 1 at leaving = 0
```

**And they get separate windows**: `retract` keeps `smoothstep(0.58, 1.0)`,
`fizzle` takes `smoothstep(0.42, 0.92)`. The mist's `fadeFrom` moves from 0.74 to
0.86 for the same reason — alpha was racing the break-up.

## Invariants tested

A new probe, `scripts/probe-vfx-studio.ts`, because **the tab has never had a
browser check on its editing path at all**. `preview-studio` asserts it mounts
and has three columns; `vfx-panels.test.ts` asserts the field table partitions
and that JSON round-trips. Between them a row can be missing, or present and
wired to nothing, and everything stays green — which is exactly what happened.

It installs a virtual clock before any module runs (the trick
`probe-health-flash.ts` established) so the preview draws a pure function of how
many frames were pumped, and then:

- every row the panel should offer is on screen, by label;
- `Ends by` reads what the definition says;
- changing it reaches the definition the tab exports;
- changing it reaches the **pixels**, measured two ways;
- a control edit (swapping the solid) moves the frame, so a silent harness
  failure cannot pass as a silent product failure.

The pixel measure that matters is **piece count**, not pixel churn. A broken
stroke and an intact one overlap everywhere except the gap, so "how many pixels
changed" is small even when the read is completely different — the first version
gated on that and would have had the shader retuned to satisfy a number rather
than the picture. A stroke that breaks in two is exactly one more connected
region, and the probe turns the other layers down to one mark each first so it is
measuring the claim rather than nine dabs.

Three things in the probe were each got wrong first and are worth the note:

- its row-label read returned `"Radius8"`, because a number row is
  `label > div > span(name) + span(value)` — it reported three rows missing that
  were on screen the whole time. **A probe that lies toward "broken" is worse
  than no probe**, because the bug it invents gets fixed.
- it sampled tick 26, which is *before* either ending begins.
- it counted ink by colour, and the tab's default dirt ground passed the test, so
  every frame came back as one enormous piece.

## Out of scope

- The Studio's inability to *add* an absent optional field. Number rows are only
  rendered when the value already exists, so `gravity` on an emitter that has
  none cannot be set from the panel. Real, pre-existing, and a different change.
- Anything about how `retract` looks. Its window and its behaviour are unchanged
  apart from the pinch fix, which only ever removed something unintended.
