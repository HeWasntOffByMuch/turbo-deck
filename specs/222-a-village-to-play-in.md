# 222 — A village to play in

## Problem

Everything the world can be built out of grows or is a boundary: two tree
species and a bush, four kinds of fence, rock tiers, and the ground itself.
There is nothing anybody **lives in**. A playtest that wants a village -- a
cluster of buildings, a square, somewhere to meet -- has no prop that says
"somebody is here", and the only way to suggest one today is a ring of fence
around empty grass.

Two props close that, and they are the smallest pair that reads as a
settlement: a timber hut under a straw roof, and a well to put in the middle of
them.

They are also the first props that are **placed** rather than painted. Trees are
scattered by density and fences are laid along a path, and neither gesture is
what a building wants: a house goes in one spot, turned to face a square, and
the well goes in the middle. A density brush cannot say that -- at 6 props a
second a click plants nothing, and where the props land is drawn from an `Rng`.
So the tool is the third gesture the editor already has and has only ever used
for markers: **one press, one thing, where the cursor is**.

## Shape

Two new kinds, and no new prop concept. A structure is a `Prop` like every
other: it is written into the map document, streamed to clients, collided
against, drawn in a region batch, and removed by the eraser -- all of that for
free, because none of it asks what kind a prop is.

`src/terrain/vegetation.ts`:

```ts
export type PropKind = 'tree' | 'bush' | ...FenceKind | 'house' | 'well';

/** The kinds that are a building rather than a plant or a boundary. */
export const STRUCTURE_KINDS = ['house', 'well'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];
export function isStructureKind(kind: PropKind): kind is StructureKind;

/** The hut's plan at scale 1, in world units. Both the geometry and the
 *  collider are derived from it, so they cannot disagree. */
export const HOUSE_PLAN = { width: 148, depth: 124 } as const;
export const WELL_RADIUS = 38;
```

`FOOTPRINT_BASE` gains a row for each: the house's is the **circumradius** of
its plan, and the well's is its kerb.

`src/terrain/map.ts`: `KNOWN_PROP_KINDS` gains both, so a saved map carrying one
parses.

`src/render/iso3d/props.ts`: `houseParts()` and `wellParts()` beside
`treeParts`/`bushParts`/`fenceParts`, memoized the same way; two entries on
`PROP_GROUPS` and two on `DRAWN_KINDS`. Nothing about the batch, the region
grid, the instancing or the worker changes -- a structure is parts and a matrix,
like everything else in that file. No part sets `sway`: a house does not move in
the wind.

`src/render/iso3d/editor/structure.ts` (new, pure, no three.js and no DOM):

```ts
export interface StructureSettings {
  readonly structure: StructureKind;
  readonly structureScale: number;
  /** Where the front faces, in degrees. Whole degrees, not radians: this is a
   *  number somebody types into a panel. */
  readonly structureYaw: number;
}
export interface StructureResult {
  readonly placed: Prop | null;
  readonly dirty: readonly ChunkCoord[];
  /** Why nothing was placed, for the editor's status line. */
  readonly refused: string | null;
}
export function placeStructure(
  store: MapChunkStore, layerId: string, settings: StructureSettings,
  at: { x: number; z: number }, onTouchChunk?: (cx: number, cz: number) => void,
): StructureResult;
```

`src/render/iso3d/editor/tools.ts`: `EditorMode` gains `'structure'`, between
`fence` and `marker` -- the three tools that put a *thing* down, in order of how
much of one they put. Its settings, its cursor colour, its `ToolVisibility`
group and its `STRUCTURE_CHOICES` follow the existing rows. `cursorRadius`
returns the structure's own footprint, so the ring is the ground the building
will take rather than a brush size that means nothing here.

`view.ts` places on the press, in the branch that already places a marker, and
says what it placed or why it did not.

## Invariants tested

- A structure prop round-trips a map document: exported, parsed, and back with
  its kind, position, scale and rotation intact. `isKnownPropKind` accepts both.
- `footprintRadius` of a house covers its own plan -- every corner of the
  `HOUSE_PLAN` rectangle is inside the collider circle, at every scale -- so a
  body can never stand in a corner of a building. Erring wide is stated: the
  circle reaches past the flat faces, exactly as a fence tile's does.
- `vegetationColliders` gives a house and a well a circle, so the sim, the nav
  grid and the unwalkable overlay all block them with no new plumbing.
- `placeStructure` places exactly **one** prop per call, at the cursor, at the
  panel's scale and yaw -- and yaw reaches the prop in radians.
- It refuses a point with no ground under it and says so, rather than dropping
  the click, and refuses nothing else: a house may be put next to a well, and
  crowding is the author's business.
- It draws nothing from an `Rng`: placing a structure twice from the same
  editor state gives the same prop. (The scatter is seeded; this is not
  random at all, which is a stronger claim.)
- Every part of a house and a well is built: the roof stands on the walls with
  no gap, the walls are sunk into the ground so a hillside shows no daylight
  under them, and the well's kerb encloses its own collider.
- No structure part sways: `buildRegionInstances` produces no sway buffers for
  a region holding only structures.
- `visibleGroups('structure')` shows the structure group and nothing else, and
  the mode's cursor radius is the footprint rather than the brush radius.

## Out of scope

- **A door you can walk through.** A house is solid. The collider is one circle
  because that is what `vegetationColliders` produces and what the nav lattice
  grades; interiors need a rect or a hollow collider and neither exists for
  props.
- **Clearing what is underneath.** Placing a house over a stand of trees leaves
  the trees. The eraser is one mode button away, and a place tool that silently
  deleted the well you set down a moment ago is a worse surprise than a tree
  through a roof.
- **Sitting a building level on a slope.** A structure stands on the height
  under its centre, like every other prop, and the wall sink is what hides the
  gap on gentle ground. A foundation that follows the terrain is the same
  problem `ground-decal.ts` solves for indicators and is much larger than this.
- **Interiors, chimneys, smoke, lit windows, a village generator.** This is two
  props and a way to put them down.
