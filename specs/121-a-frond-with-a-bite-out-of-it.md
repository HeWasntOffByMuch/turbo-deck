# 121 — A frond with a bite out of it

## Problem

The two conifers — the fir and the pine, the trees that are not the lobed canopy
(spec 077) — are stacks of `THREE.ConeGeometry(radius, height, 7)`. A cone with
seven sides is a *regular* heptagon at every height, so every frond in the world
has the same outline, the same seven-fold symmetry and the same clean unbroken
hem. At the camera's distance that reads as a stamp: a stand of firs is one
shape repeated, and the eye finds the repeat before it finds the tree.

The reference is the same low-poly language but with the edge **broken**: the
frond's lower edge is uneven, one or two bearings are cut up into the body of
the frond so the trunk and the tier below show through the gap, and no two
layers line up. Slight cutouts, in other words, not a new species.

Three constraints on how it may be bought:

- **No bandwidth.** A tree is a `Prop` in the map document — position, scale,
  rotation, tint — and its species, tier count and lean are *hashed from where
  it stands* (spec 045). A per-tree shape that had to be stored or streamed
  would put bytes on the wire for every tree in the world. Nothing here adds a
  field to the map or to the protocol.
- **No draw calls.** The prop field is one `InstancedMesh` per part per region
  (spec 086). A per-tree mesh variant would multiply that count by however many
  variants there were. Nothing here adds a batch.
- **No cover lost.** `trunkHeight` is derived, not authored (spec 048): the
  trunk grows to the highest point its own fronds still hide, so that a solid
  column's flat cap never hangs out into open air. A notch cut in the wrong
  place is exactly the thing that would silently un-derive that.

## Shape

### The rim, pure, in `frond.ts`

Beside `lobe.ts`, and for the same reason: the silhouette is the art direction,
so it is arithmetic that can be checked in Node rather than by squinting at a
frame. No three.js.

```ts
/** One vertex of a frond's hem. */
interface FrondPoint {
  readonly angle: number;   // bearing, radians, strictly increasing round the rim
  readonly lift: number;    // fraction of the tier's height this vertex sits above its base
  readonly cleft: boolean;  // a cut between two tips, rather than a tip
}

function frondRim(seed: number, segments: number): FrondPoint[];
/** The height, as a fraction of the tier's, below which the frond has gaps in it. */
function frondHem(rim: readonly FrondPoint[]): number;
/** The widest bearing gap between neighbouring vertices, radians. */
function frondGap(rim: readonly FrondPoint[]): number;
```

### Every vertex is a point on the cone, so the cutout is free

The frond is not a new solid. It is the **same cone**, with its hem cut away:
each rim vertex sits *on the cone's surface*, at its own height, and its radius
therefore follows from that height alone —

    radius = R * (1 - lift)

A vertex that is lifted is automatically pulled in, because that is what the
cone does. Three things fall out of this and none of them need a tolerance:

- **Containment.** Every vertex is on the surface of the cone it replaces and
  every triangle is a chord of it, so the frond is inside the old silhouette.
  `crownRadius`, the batches' bounding spheres and the canopy-overlap reasoning
  are all still true, and cannot be made false by tuning the rim.
- **Cover.** A horizontal slice above the hem crosses every edge from the apex
  to a rim vertex, and an apex-to-surface edge lies *on* the cone — so the slice
  is a polygon at the full cone radius, on the rim's own bearings. Keep every
  bearing gap at or under the old heptagon's step and the frond covers the trunk
  exactly as well as the cone did, above the hem. `trunkHeight` does not move.
- **Width.** One tip per frond is held at zero lift, so a crown still reaches
  the radius its species table says it does.

Below the hem there are real gaps, which is the point. `tierCover` therefore
answers `-Infinity` below a tier's hem — no material at some bearing means the
tier does not hide a trunk cap there — and `buriedTrunkHeight` starts its search
at the hem rather than at the tier's base plane. So the cutouts are *in* the
derivation rather than a thing it has to be trusted not to notice.

### Where the variety comes from, at zero cost

One rim per (species, tier): the geometry stays shared, so the vertex count of
the world goes up by the handful of triangles a cleft adds and by nothing else.
Two trees differ because the *instance matrix* differs:

```ts
interface PropPart {
  /** A full-turn spin about the part's own axis, hashed per instance (radians). */
  readonly spinYaw?: number;
}
```

applied **after** the lean in the quaternion chain and so *before* it in the
part's own frame: the frond spins about its own axis, and the direction the tree
leans and drifts is untouched. Each tier's spin is hashed on its own channel
with the part index mixed in, so a tree's fronds do not line up with each other
either.

## Invariants tested

`frond.test.ts`, pure:

- The rim is a pure function of its seed, and two tiers of one species get
  different rims.
- Bearings are strictly increasing over one turn, and no gap exceeds the tip
  step — the claim the cover argument rests on.
- Every lift is within the authored bound, and at least one tip is at zero, so
  the frond reaches its species' full radius somewhere.
- A cleft lies strictly between the two tips it separates, and is lifted higher
  than both — a cut into the frond rather than another tip.
- Every frond has at least one cleft and never a cleft in every sector, and
  never two adjacent — bites, not a saw blade and not a plain cone.

`props.test.ts`, against the geometry actually built:

- Every conifer foliage vertex lies inside the cone it replaces:
  `0 <= y <= height` and `radius <= R * (1 - y/height)`.
- Some vertex of each tier reaches the full authored radius.
- A frond costs at most 24 triangles, and the conifers add no batch to a region
  — the two claims that make "no burden on performance" checkable rather than
  asserted.
- The existing trunk-burial sweep still passes **with the same trunk heights**:
  the cutouts are above nothing the trunk needs.
- The trunk's top ends above the hem of every tier that buries it.

## Out of scope

- The lobed canopy tree (spec 077), the bushes, and the trunks themselves.
- Per-tree *shape* variation beyond the spin: that would mean either bytes on
  the wire or a batch per variant, and the brief rules both out.
- Any change to colour, to the tier tables, to the wind, or to how many tiers a
  tree grows.
