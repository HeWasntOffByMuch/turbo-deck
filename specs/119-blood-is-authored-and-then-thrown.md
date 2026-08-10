# 119 — Blood is authored, and then thrown

## Problem

Blood needs to look different every time and to look *drawn* every time. Those
pull opposite ways, and both usual answers fail here.

A handful of authored sprites repeats visibly within one fight — the eye finds a
repeated blot faster than almost anything. Fully procedural noise (fBm, worley,
metaballs over a random field) never repeats and never looks authored either: at
240×150 with the frame quantized to a handful of palette steps, noise arrives as
grey mush with no silhouette, and silhouette is the entire read at this
resolution.

So: **authored masses, thrown procedurally.** A small set of hand-authored blot
outlines supplies the shape language; a seed supplies scale, rotation, mirroring,
satellite droplets, drip strokes and the directional stretch. The result is
generated at runtime from `(seed, params)` and is never fetched.

This spec covers the *generator* and the evidence that it works. Wiring blood
into hits, and the per-chunk decal buckets, are the spec after it — the plan
(`docs/vfx-plan.md` §5) puts a contact sheet before the wiring on purpose,
because a splat generator that produces thirty variations of the same grey smudge
passes every test anyone would think to write.

## Shape

Pure, in `src/render/iso3d/vfx/splat.ts`, tested in Node, no three.js:

```ts
/** A hand-authored blot, as a radial profile. Not noise: a drawn outline. */
interface BlotProfile { readonly radii: readonly number[] }

interface SplatParams {
  readonly size: number;          // texture edge in pixels
  readonly mass: number;          // 0..1, how much of the tile the main blot fills
  readonly droplets: number;      // satellites thrown off it
  readonly spread: number;        // how far they carry, in tile fractions
  readonly dirX: number;          // impact direction in tile space, normalized
  readonly dirY: number;
  readonly throwStrength: number; // 0 radial, 1 strongly directional
  readonly viscosity: number;     // 0 watery: long thin drips; 1 thick: round, few
  readonly threshold: number;     // coverage cut, so the edge is hard
}

/** An 8-bit coverage mask, `size * size`, deterministic in `seed`. */
function generateSplat(seed: number, params: SplatParams): Uint8Array;

/** The presets the fluids are: blood, sap, ichor, oil, slime. */
const FLUIDS: Record<FluidKind, Pick<SplatParams, 'viscosity' | 'droplets' | 'spread'>>;
```

`scripts/preview-splats.ts` writes a contact sheet of ~30 to
`.claude/screenshots/splats.png` — the picture a person decides from.

## Invariants tested

- **Deterministic.** The same seed and params produce a byte-identical mask,
  every time.
- **Distinct.** Thirty consecutive seeds produce thirty masks that differ from
  each other by a real fraction of their pixels — the check that catches a
  generator that has quietly collapsed onto one shape.
- **Hard-edged.** Every byte is 0 or 255. A splat is a silhouette; anything in
  between is what the quantizer will turn into a band anyway.
- **Bounded.** Coverage stays inside the tile; nothing wraps to the far edge.
- **Non-empty and non-full.** Coverage sits inside a sane band for the default
  params — a generator that produces an empty tile or a filled square passes
  "deterministic" and "hard-edged" perfectly.
- **Directional.** With `throwStrength` high, the mask's centre of mass is
  displaced along `(dirX, dirY)` and against it when the direction is flipped.
  This is the property the whole feature exists for: a hit from the left throws
  blood to the right.
- **Viscosity means something.** Watery produces more, longer, thinner outliers
  than thick at the same seed.
- **Mirroring and rotation are used**, so the authored blots are not all landing
  in the same orientation — the failure mode where "procedural" means "the same
  five sprites".

## Out of scope

- Decals of any kind: the per-chunk buckets, the terrain fitting, the box
  projector for props, and the unit-staining decision are the next spec.
- Wiring to combat events.
- The gore setting's off switch (it belongs with the decal work it disables).
- Colour. The generator emits coverage only; tint comes from the gradient, which
  is what lets one generator serve blood, sap, ichor, oil and slime.
