# 059 — Fence variants: boards and rubble

## Problem

Spec 058 gave the editor one wooden fence and one stone one, and both are
*regular*: the picket fence repeats a post and two pickets at a fixed pitch, and
the drystone wall is three straight courses. That regularity is what makes them
tile seamlessly, and it is also what makes a long run read as one extruded
ribbon rather than as something a person built out of the material to hand.

Two more styles, each the irregular counterpart of the one beside it:

- **boards** — a palisade of vertical boards only, no rails and no posts, with
  the boards varying in width, not quite rectangular, off-angle here and there,
  and not quite the same colour as each other.
- **rubble** — a wall of stones only, no courses, the stones varying in size and
  packed tightly enough to be a wall, with a top that is not level.

## Shape

Two more entries in the existing sets — no new concepts, because a fence tile is
already an ordinary prop and both variants are tiles:

```ts
export const FENCE_STYLES = ['wood', 'boards', 'stone', 'rubble'] as const;
export type PropKind = 'tree' | 'bush'
  | 'fence-wood' | 'fence-boards' | 'fence-stone' | 'fence-rubble';
```

The existing two keep their ids, so a map already saved with `fence-wood` in it
still loads. The panel labels them PICKET / BOARDS / COURSES / RUBBLE, which is
what they actually are.

### Where the irregularity comes from

Two layers, because one is not enough:

1. **Per part, authored once.** A tile's boards are not one geometry repeated —
   each board is its own `PropPart` with its own width, depth, height, taper,
   top-edge slant and base colour, laid out by a hash at module load so the
   shape is fixed and stable. Same for a rubble tile's stones, each its own
   knocked-about polyhedron at its own size. This is what makes *one* tile look
   hand-made.

2. **Per instance, hashed from position.** `buildPropField` already wobbles a
   part per prop; it grows the channels these need — `jitterX` along the run,
   `jitterScaleX` (width), `jitterRoll` (lean within the fence's plane) and
   `jitterTint` (colour) — and splits the hash into two independent channels, so
   a board that came out wider is not also always the one leaning. This is what
   stops *fifty* tiles looking like one tile stamped fifty times.

Two new geometry builders back that:

```ts
function boardGeometry(spec: BoardSpec): THREE.BufferGeometry  // eight corners, placed
function rockGeometry(seed: number, rx: number, ry: number, rz: number): THREE.BufferGeometry
```

`boardGeometry` places all eight corners itself rather than scaling a box, so a
board can taper, skew and be cut off at a slant. `rockGeometry` perturbs an
icosahedron's vertices by a hash **of the vertex position**, not of its index —
the geometry is non-indexed, so a corner shared by three faces exists three
times over and must move identically in all three or the stone tears open.

### Tiling still holds

The seamlessness argument of 058 is unchanged and is what constrains the layout:
boards are laid edge to edge with a fixed overlap and their widths normalised so
the advances sum to exactly `FENCE_TILE_LENGTH`, and rubble stones sit at
positions inside `[-L/2, +L/2]` while their geometry deliberately overhangs, so
tiles interlock instead of butting. Per-instance jitter along the run is small
enough to stay inside the overlap it is eating into.

## Invariants tested

- Both new styles map to their own `PropKind`, and all four styles are offered
  by the panel with a label each.
- A board tile's advances sum to exactly one tile length, so a run has neither a
  seam nor a double-thickness board at every junction — asserted on the layout,
  not by looking.
- Every fence kind builds a field whose instance positions stay within half a
  tile of the tile's centre, for all four styles (058 asserted this for the
  picket only).
- A board tile's boards differ from each other in width and in colour, and a
  rubble tile's stones differ in size — i.e. the authored layer actually varies.
- The per-instance layer varies too: the same part on two tiles of a run comes
  out at different offsets, and the two jitter channels are independent (a
  part's width and its lean do not move together).
- Both new geometries are closed and finite: no NaN vertices, and a rock's
  shared corners are not torn apart by the perturbation.
- Every variation is a pure function of the tile's position — the same run
  rebuilt mid-stroke is identical, which is what stops a wall reshuffling while
  it is being drawn.

## Out of scope

- Replacing the 058 styles. Regular picket and coursed wall are the right thing
  for a fenced paddock and a built wall; these are the rougher counterparts, not
  successors.
- Per-tile geometry (a tile whose boards are generated for *that* tile). Every
  instance of a style shares its geometries, which is what keeps the field one
  batch per part per region rather than one per tile.
- Gates, ends capped differently from the middle of a run, mitred corners.
