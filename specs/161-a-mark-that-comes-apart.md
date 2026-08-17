# 161 — A mark that comes apart

## Problem

`blood_hit_brush_mist` (spec 160) does not dissipate. It **rewinds**.

Every brush mark has one ending, added in spec 159 and stated there as a virtue:
past 58% of its life the shader retracts it from its own root, so the mark gets
shorter from the butt toward the tip and the flecks past the end are the last
thing left. For a hit that is right, and the reason it is right is that a hit is
over in a third of a second — at that speed the retraction is a flick finishing.

Slowed down and held for a second, the same motion is the brush retracing its
own path backwards. The mark was drawn out from its root and it is taken back in
at its root, which is the animation played in reverse. A spatter that dissipates
by un-painting itself is a spatter running backwards, and no amount of shrinking
or fading on top hides it — those make it *fainter* while it rewinds.

The same fault is latent on the explosion's smoke, and worse there. A cloud lobe
is a lens with no root the eye can point at, so retract does not read as
"finishing" at all; it reads as the mass being eaten from one side. The smoke is
also the longest-lived mark in the library — 74 to 116 ticks in the smoulder —
so it is the one with the most time to be noticed doing it.

## Shape

A second ending, chosen per emitter.

```ts
/** In `types.ts`, beside `render` and `blend`. */
export type StrokeDecay = 'retract' | 'fizzle';
readonly strokeDecay?: StrokeDecay;   // on Emitter. Default 'retract'.
```

**`retract`** is what exists: an eroding threshold walks along the mark from the
root, collapsing the width behind it and pulling the spine after it.

**`fizzle`** touches the mark's extent not at all. The spine stays exactly where
it is, and the whole ending happens in the *width*: a field that varies **along**
the mark, and per instance, decides which parts go first, so gaps open through
the middle and the mark comes apart into islands that shrink where they stand.

```glsl
float field = 0.5 + 0.5 * strokeWave(along, iSeed, 9.7, 11.0);
alive = smoothstep(0.0, 0.18, field - leaving);
lift  = position.y;            // untouched: nothing gets shorter
```

The frequency is low on purpose — about one and a half cycles over the length,
so two or three islands. A high one takes the mark apart into a dotted line,
which is the stipple spec 159 exists without.

`iDecay` is a per-**instance** attribute rather than a per-batch uniform, because
a batch is keyed by the mark and two effects using the same mark end it
differently. It travels from the compiled emitter through `VfxLayer.sync`, the
way `modeCode` and `stretch` already do for the quad batches: a property of what
was authored, not of how far through its life a particle is.

### What uses which

- `blood_hit_brush_mist` — `fizzle`, via a new `decay` parameter on `bloodHit`.
- every explosion's `smoke` — `fizzle`, for the lens-has-no-root reason above.
- everything else — `retract`, unchanged.

### The two knobs that stop fighting it

`shrinkTo` moves from 0.28 to 0.42 and `fadeFrom` from 0.60 to 0.74 on the mist.
Stacked on top of a break-up they took the whole mark faint at once, which reads
as the effect being turned down rather than as paint coming apart. The break-up
is the mechanism now; those two are seasoning.

## Invariants tested

- The mist's three layers all declare `fizzle`; the standard hit's all declare
  `retract` (asserted as the explicit value *or* the default, so removing the
  field is not a silent change of ending).
- The mist still shrinks and still fades earlier than the standard hit, asserted
  **relative to it** rather than against absolute thresholds — the numbers are
  seasoning now and a fixed bound would pin the wrong thing.
- `strokeDecay` survives the Studio tab's JSON round trip. It is checked against
  its enum on the way in rather than passed through, for the same reason the mesh
  shape is: an unknown value would compile to `retract` through the fallback and
  change how an effect ends with nothing anywhere saying so. (The existing
  round-trip test over the whole registry caught this within a minute of the
  field being added.)
- The picture: `scripts/preview-brush-vfx.ts` samples the mist across its ending
  rather than its beginning — six frames from tick 6 to 46, where the break-up
  happens — and the smoulder out to tick 106. The measurement that shows it is
  the **piece count**: the smoke goes from 2 connected regions at tick 52 to 7 at
  84, which is a mass separating rather than one shrinking.

## Out of scope

- Changing how the standard hit ends. `retract` is right for it and was reviewed
  as such; the threshold it starts at is unchanged to the tick.
- A third ending. Two is what the material has: something that finishes, and
  something that comes apart.
