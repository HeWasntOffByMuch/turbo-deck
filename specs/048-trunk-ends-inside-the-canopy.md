# 048 — The trunk ends inside the canopy

## Problem

Spec 045 gave both conifers a trunk that rises *through* the foliage instead of
being hidden by the lowest tier, which is most of what makes them read as trees.
It authored the trunk's height as a free number, and it is not one: a trunk is a
solid box that stops in mid-air, so wherever it ends, its cap and its four
corners are either buried inside a frond or hanging out through the frond's
sloped side.

Both species end theirs in open air:

| | trunk top | cover at the trunk's corner, upright | at full lean/drift |
|---|---|---|---|
| fir | 86 | **-5.4** | **-9.0** |
| pine | 92 | **-0.8** | **-7.7** |

The fir is the plain case. Its trunk stands to 86 inside a tier that spans
59-89, where the cone has narrowed to a radius of 3.4 against a trunk half
-diagonal of 8.5 — so the top ~4 units of column, plus the flat cap, poke out
through the side of the frond on *every fir in the world*. The pine's trunk is
nominally covered when it stands upright and stops being so as soon as the tier
drifts or leans, which is per-instance and so covers most of them.

Three things the arithmetic has to account for that the authored numbers did
not:

- A tier's cone is 7-sided, so its `radius` is a **circumradius**: over a flat
  face the foliage only reaches `radius * cos(pi/7)`, ~90% of it.
- The trunk box spins with the prop and so does the cone, so their relative
  bearing is arbitrary: it is the box's **corner** (`width/2 * sqrt(2)`) against
  the cone's **flat face** that has to clear.
- A tier drifts off the trunk's axis and leans about its own centre per
  instance. Both slide the foliage off the trunk, by up to `driftMax` and by
  `dy * tan(lean)` respectively.

## Shape

`props.ts` stops authoring the trunk's height and derives it (`SpeciesShape`
keeps `trunkWidth` only):

```ts
/** How tall a species' trunk box stands, in prop-local units (before scale). */
export function trunkHeight(species: TreeSpecies): number;

/**
 * How deep inside the canopy this tree's trunk top sits. Positive means the
 * foliage hides it, negative means it clips out through a frond.
 */
export function trunkTopCover(variant: TreeVariant): number;

/** The tier counts an instance of a species may grow. */
export function speciesTierCounts(species: TreeSpecies): readonly number[];
```

The trunk grows to the highest point its own species still covers: the last
height at which a tier's cone clears the trunk's corner by `TRUNK_BURIAL`, at
the worst lean and drift an instance can take (`|asymmetry| = 1` — both terms
only grow with it). Only the tiers *every* instance grows are allowed to do the
covering, since a two-tier sapling has no crown to hide in. Cover falls off
monotonically from a tier's base to its tip — a cone narrows with height much
faster than leaning slides it sideways — so one bisection per tier finds it.

That lands the fir at 75.8 (from 86) and the pine at 82.4 (from 92). Nothing
visible moves: `bareTrunkHeight` is the lowest tier's `baseY` and is untouched
at 22 and 44, the trunk still spans the gap between the fir's first two tiers,
and the pine still carries the longer trunk of the two. The only part that
moves is the part that was never meant to be seen.

Scale-free by construction: trunk, tiers and drift all scale with the prop
together, so one number answers for every size the scatter can grow.

## Invariants tested

- `trunkTopCover` is positive for **every** shape a tree can take: both species,
  every tier count in `speciesTierCounts`, swept across the whole asymmetry band
  — not just the upright case, since lean and drift are what uncover it.
- `trunkTopCover` is positive for every tree the authored world actually grows.
- The trunk still runs up into the crown rather than stopping under it: taller
  than `bareTrunkHeight`, past half the species' height, and the pine's still
  longer than the fir's.

## Out of scope

- The tier gaps. A trunk showing between two fronds is the point of spec 045,
  not a clipping bug: this spec is only about where the column *ends*.
- Foliage against foliage, and foliage against the terrain it stands on.
- Any change to the scatter, the collider footprints, or the silhouette the
  player sees — the tier geometry is untouched.
