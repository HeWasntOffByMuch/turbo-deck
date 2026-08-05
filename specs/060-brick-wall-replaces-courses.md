# 060 — A brick wall, and the coursed wall retired

## Problem

Four fence styles shipped in 058/059: picket, boards, courses (a battered
drystone wall of three straight courses) and rubble. Two of them are stone, and
the coursed one is the weaker of the pair — it is what rubble is a better
version of, so it occupies a button without offering a look the rubble wall does
not already cover more convincingly.

What is missing is the *built* end of the range. Every style so far is either
timber or field stone; there is nothing man-made and regular, which is what a
courtyard, a town edge or a garden wall wants.

## Shape

One style out, one in, no new concepts:

```ts
export const FENCE_STYLES = ['wood', 'boards', 'brick', 'rubble'] as const;
export type PropKind = 'tree' | 'bush'
  | 'fence-wood' | 'fence-boards' | 'fence-brick' | 'fence-rubble';
```

Ordered timber, timber, masonry, masonry, so the 2-column strip groups them by
material: PICKET / BOARDS on one row, BRICK / RUBBLE on the next.

### The brick tile

The deliberate opposite of rubble. Where that one is sized so irregular stones
still overlap, brick is laid: a mortar core spanning the tile, with brick faces
standing proud of it on both sides, in six courses of pitch 8.

**Nothing but brick is visible from outside.** The top course is laid *across*
the wall -- full-depth bricks, wider than the core -- so what caps the wall is
more brick rather than the core's grey top, and the bottom course runs down past
the ground rather than stopping at a joint, so the wall meets the earth as brick
too. Mortar shows only where mortar belongs: in the joints, and in the
cross-section at the cut end of a run.

**Running bond, carried across tile boundaries.** Even courses hold three whole
bricks; odd courses hold two whole bricks and a *half* brick at each end, so the
half at one tile's edge and the half at its neighbour's meet to form one whole
brick with no joint between them. Bricks at the tile edge would otherwise
overlap their neighbour's exactly and z-fight.

**Merged geometry, not a part per brick.** Forty-odd bricks as forty-odd
`PropPart`s would be forty-odd instanced meshes per region. The bricks are
instead hashed into three colour bands and each band merged into one geometry,
so a tile is four parts — three bands plus the core — and a wall still comes out
mottled the way brick is. This needs a box appended into a shared buffer, which
is `boardGeometry`'s quad-winding trick applied repeatedly:

```ts
function brickGeometry(boxes: readonly Box[]): THREE.BufferGeometry
```

No per-instance positional jitter: a brick wall is regular, and wobbling it
reads as a mistake rather than as character. Variation is the three tone bands
plus the tile's own tint.

### Retiring `fence-stone`

Removed outright — the kind, its geometry and its button. A map already saved
with a coursed wall in it keeps those props (nothing rewrites them) and the
renderer will report them through the `undrawn` count added in the last change,
naming `fence-stone` in the console and showing "N not drawn" in the editor's
readout. That is the whole reason that count exists: the alternative is props
that quietly render as nothing.

No migration to another style. Silently rewriting someone's saved map to a
different look is worse than telling them what it could not draw.

## Invariants tested

- The palette offers exactly picket, boards, brick and rubble; `fence-stone` is
  gone from `PropKind`, from `FENCE_KINDS` and from the document's known kinds.
- A brick tile's parts stay within half a tile of its centre, and its drawn
  extent covers the tile end to end with no gap — the same two properties every
  other style is held to.
- The running bond survives a junction: the bricks of two consecutive tiles
  never overlap, which is the failure that would z-fight down every wall.
- A brick tile has more than one colour, and no per-instance position jitter —
  two tiles of a run put the same part in the same place relative to each tile.
- `brickGeometry` produces closed, finite boxes with outward winding.

## Out of scope

- Migrating existing `fence-stone` props to another style.
- A separate coping/cap style, gates, or arches.
- Per-brick colour variation across tiles (bricks vary by band within a tile;
  across tiles the whole tile shifts with its tint).
