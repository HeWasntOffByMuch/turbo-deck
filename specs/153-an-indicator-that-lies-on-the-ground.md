# 153 — An indicator that lies on the ground

## Problem

Every ground indicator the aim draws (spec 080) is one flat horizontal quad or
disc, placed at `ground(origin) + lift` and left there. On flat ground that is
exactly right and it is why nobody noticed. On a slope it is wrong everywhere
except the single point it was sampled at: the far half of the disc is buried
inside the hillside and the near half floats over the valley, so a range ring
aimed near a hill comes out of the slope as a bright arc partway up it and
vanishes entirely where the hill rises past the sample height. The picture the
player reads a cast off — *how far can I reach, and what will it cover* — is the
one that fails first, because the range ring is the biggest of them: at `700`
units it spans thirty terrain cells, and the odds that all thirty are at the
caster's own height are nil.

The lift is not the fault and raising it does not fix it. A horizontal plane
cannot follow a heightfield; only vertices can. So the indicators stop being
flat meshes that get *moved* and become meshes whose vertices are *placed*, each
one on the ground under it.

## Shape

A new pure module, `src/render/iso3d/world/ground-decal.ts`. It knows about
shapes and heights and nothing about three.js, so it is checked in Node like the
rest of this directory's arithmetic.

```ts
/** The ground, memoized on a lattice and read back bilinearly. */
export class SampledGround {
  constructor(heightAt: HeightAt, lattice?: number, limit?: number);
  readonly at: HeightAt;
  invalidate(): void;
  get size(): number;
}

/** A flat shape in its own frame: +X is the heading, +Z is to its left. */
export interface DecalTemplate {
  /** Local XZ pairs, x0,z0,x1,z1,... */
  readonly local: Float32Array;
  readonly index: Uint16Array;
  /** The widest gap between neighbouring samples, in world units. */
  readonly step: number;
}

/** Where a template is laid, and how far above the ground it floats. */
export interface DecalPlacement {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly lift: number;
}

export type HeightAt = (x: number, z: number) => number;

export function discTemplate(radius: number, from?: number, to?: number): DecalTemplate;
export function ringTemplate(inner: number, outer: number): DecalTemplate;
export function laneTemplate(length: number, width: number): DecalTemplate;
export function aimTemplate(shape: AimShape): DecalTemplate;

/** World-space XYZ for every vertex, written into `out` (3 floats each). */
export function projectDecal(
  template: DecalTemplate,
  placement: DecalPlacement,
  heightAt: HeightAt,
  out: Float32Array,
): Float32Array;
```

`scene.ts` gets a small `GroundDecal` wrapper over it: one `THREE.Mesh` whose
transform is *never* touched — position, rotation and scale stay identity and
the vertices are world-space — with the template rebuilt only when the shape it
draws changes, and the position attribute rewritten in place every frame. The
three indicators that are about a cast's reach move onto it: the aim shape
(circle, cone, lane), the aim range ring, and the ground telegraph a committed
cast draws, which is the same picture and would otherwise snap flat at the
moment of commitment.

Tessellation is derived from the size, not authored: the sample spacing targets
one half of a terrain cell, so the residual error between samples is bounded by
what the ground does over eleven units rather than by what it does over the
whole indicator. Segment and ring counts are capped, so a 700-unit ring costs a
bounded number of vertices rather than a proportional one.

Two things were learned by building it and are part of the design rather than
notes on it.

**What gets buried is an edge, not a vertex.** A vertex placed exactly on the
heightfield is fine by construction; the straight line to the next one cuts
under whatever the ground did in between. So a vertex takes the highest of five
samples half a step around it, and — since what has to be cleared on a hillside
is a slope rather than a constant — a further `SLOPE_LIFT` of the local spread
is added, which is zero on level ground and leaves a flat-ground indicator
exactly where the old one was. What no finite sampling can catch is a *crease*:
a fold in the ground is a line, and five points can straddle a line. What that
costs is bounded by the sampling step and the sharpness of the fold, and by
nothing about the indicator — which is the whole improvement, since the flat
mesh's error was proportional to the indicator's own size.

**`heightAt` is expensive: 5.6µs a call on the baked arena.** It jitters four
corners, evaluates two triangle planes and searches the neighbouring ring when
a point falls outside its nominal cell. Projecting one 140-unit disc is ~1100
vertices, so asking the heightfield directly costs 35ms a frame. `SampledGround`
memoizes it on a lattice at the sampling step and interpolates: a cursor moving
a few units a frame lands in the cells it was already in, so the cost settles at
a few dozen fresh samples a frame. It is invalidated whenever terrain streams in,
because a height sampled over ground that had not arrived is a height that has
to be thrown away.

## Invariants tested

- A decal's *surface* — sampled between its vertices, not at them — never sinks
  into the ground, on a slope and on broken ground; and on a crease, what it
  sinks by is bounded by the fold and the step and not by the indicator's size.
  This is the whole feature.
- A decal never floats further above the ground than what the ground itself does
  over half a step, so "clears the ground" cannot be met by flying.
- On flat ground, a projected decal is flat and at the same height the old one
  was — conforming changes nothing where there was nothing to conform to.
- No edge of any template's triangles is longer in the XZ plane than a grid
  diagonal of its `step`, so the conform error is bounded by what the terrain
  does over one step rather than over the whole indicator.
- `SampledGround` is exact on its own lattice, blends between lattice points
  rather than snapping (a staircase would terrace a decal on a hillside), asks
  the heightfield once per lattice point however often it is read, stays warm
  for a *moving* aim, forgets everything on `invalidate`, and starts over rather
  than growing without bound. And a decal placed through it lands within a
  couple of units of where the heightfield itself would have put it.
- The outline still is the shape: a disc's furthest vertex is at `radius`, a
  sector's vertices all lie within its half-angle of forward, a lane spans
  `0..length` by `±width/2`, and a ring's radii all lie in `[inner, outer]` with
  both extremes present.
- `heading` rotates local +X onto the world direction: a lane at heading `h`
  puts its far end at `origin + length * (cos h, sin h)`.
- Vertex counts stay under the cap for a 700-unit ring and a 140-unit disc, and
  a template's index buffer only ever names vertices it has.
- `aimTemplate` derives the same numbers off an `AbilityDefinition`'s `AimShape`
  that `buildAimGeometry` did — the radius, the half-angle and the lane's length
  and width are unchanged.

## Out of scope

- The rings under a *body* — the attack target ring and the aim's unit ring.
  They are 27 units across and sit under something standing on one point, so
  their error is a fraction of what a range ring's is, and they are sized by
  scaling one shared geometry rather than built per radius.
- Occlusion. An indicator behind a hill is still hidden by that hill, which is
  correct: the fix is that it now follows the ground rather than that it is
  always visible.
- The blast rings `addEffect` leaves behind, and the VFX layer's own decals.
  Same fault, different owner, and neither is what a player aims with.
- Making `heightAt` itself faster. It is 5.6µs because of work it genuinely
  does, it lives in the deterministic core, and the server calls it every tick
  for every entity — so speeding it up is a change with the sim on the other end
  of it, and not something to do on the way past while fixing an indicator.

## Measured

`npx tsx scripts/preview-aim.ts`, at the steepest ground in `maps/arena.json`
(it falls 430 units within 260 of the caster), against the terrain triangles the
renderer really draws:

| indicator | buried, pinned to one height | buried, on the ground |
|---|---|---|
| range ring, 420 | 217.3 | none (clears by 0.33) |
| quake, radius 140 | 178.2 | 0.74 |
| bolt lane, 700x16 | 276.7 | none (clears by 0.73) |

A moving 420-unit range ring: 482 vertices, 48 heightfield samples a frame,
0.42ms a frame — against 35ms for the same projection asking `heightAt` directly.
