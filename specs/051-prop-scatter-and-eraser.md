# 051 — Prop scatter and eraser

## Problem

The editor can shape ground and cannot put anything on it. The world's 1149 trees
and bushes came out of `worldVegetation`'s one-shot scatter at bake time; there
is no way to add a grove, thin a stand, or clear a clearing.

Steps 5 and 6 of the brief are one spec because they are one tool wearing two
hats: the same radius, the same cursor, the same stroke and the same undo entry.
An eraser that did not share them would be a second brush to keep in step.

Three things this needs that the terrain brush did not:

- **Randomness, without `Math.random`.** A scatter picks positions, yaws and
  scales. The repo's rule is that randomness comes from a seeded PRNG passed in
  explicitly, and that rule earns its keep here: a seeded stroke is a stroke a
  test can assert on.
- **Props in the undo snapshot.** `ChunkSnapshot` carries heights, solidity,
  materials and tones. A scatter that could not be taken back would be the one
  destructive tool without a way out.
- **A prop that can lie down.** `Prop` has a yaw and nothing else, so every
  instance stands bolt upright. Align-to-normal needs the prop field to be able
  to tilt one.

## Shape

### Settings

The panel grows a **mode**, and `radius` becomes shared — one cursor, one
footprint, whichever tool is armed.

```ts
type EditorMode = 'terrain' | 'scatter' | 'erase';

interface ScatterSettings {
  readonly species: PropKind;      // 'tree' | 'bush'
  readonly density: number;        // props per second at full weight
  readonly maxSlope: number;       // gradient above which nothing is planted
  readonly scaleMin: number;
  readonly scaleMax: number;
  /** Clear ground left between two props' footprints. */
  readonly spacing: number;
  /** Lie the prop along the ground (rocks) instead of standing it up (trees). */
  readonly alignToNormal: boolean;
}
```

### The stroke

Pure, seeded, in `editor/scatter.ts`:

```ts
function scatterStroke(
  store: MapChunkStore,
  layerId: string,
  settings: ScatterSettings,
  step: { x: number; z: number; radius: number; dtSeconds: number },
  rng: Rng,
  onTouchChunk?: (cx: number, cz: number) => void,
): { added: number; rng: Rng; dirty: ChunkCoord[] };

function eraseStroke(
  store: MapChunkStore,
  layerId: string,
  at: { x: number; z: number; radius: number },
  onTouchChunk?: (cx: number, cz: number) => void,
): { removed: number; dirty: ChunkCoord[] };
```

`density` is **per second**, not per frame, for the same reason the terrain
brush's strength is: a machine running at 144Hz must not paint twice as thickly
as one at 72. Fractional props per frame are carried in an accumulator rather
than rounded away, so a low density still plants at a steady rate instead of
never reaching one.

A candidate is rejected if it is outside the radius, on ground steeper than
`maxSlope`, on ground the layer says is not solid, or too close to a prop that is
already standing — `distance < footprint(a) + footprint(b) + spacing`, the rule
`vegetation.ts` already uses, so a hand-painted grove packs the same way a
generated one does.

The eraser removes every prop whose *centre* is inside the radius. Centre rather
than footprint overlap: a footprint test makes a big tree vanish when the cursor
is nowhere near its trunk, which reads as the eraser having a mind of its own.

### Props that lie down

`Prop` gains `alignToNormal?: boolean` and `MapProp` gains `align?: boolean` —
optional, so the existing forest's JSON is unchanged.

The **intent** is stored, not the resulting tilt. A stored normal would go stale
the moment the ground under it is sculpted; the boolean is re-resolved against
the terrain every time the field is built, exactly as a prop's height already is.
`buildPropField` therefore takes an optional `normalAt(x, z)`, and composes the
tilt that takes +Y onto that normal before applying the prop's yaw.

### Feedback during a drag

A scatter you cannot see until you let go is unusable, and the prop field is
rebuilt whole (it is one pass over every prop in the world). So the rebuild is
**throttled** during a stroke — a few times a second — and always run once when
the stroke ends. Incremental instance editing would be better and is a rework of
a file the game also renders through; that trade can be revisited if the throttle
ever feels slow.

### Store

```ts
addProp(layerId, prop): void;              // filed into the chunk that contains it
removePropsWithin(layerId, x, z, r): Prop[];
propsWithin(layerId, x, z, r): Prop[];
```

`ChunkSnapshot` gains `props`, so undo restores a stroke's plantings and
clearings along with any ground it moved.

## Invariants tested

**Scatter**

- Plants inside the radius and never outside it.
- Nothing lands on ground steeper than `maxSlope`, or on a cell that is not solid.
- No two props end up closer than their footprints plus `spacing`.
- Scale stays within `[scaleMin, scaleMax]`; yaw stays within `[0, 2π)`.
- Rate is per second: doubling `dtSeconds` doubles the count planted, and a
  density below one per frame still plants over time rather than never.
- Seeded: the same `(rng, settings, step)` plants the identical props, and two
  different seeds do not.
- Every planted prop is filed in the chunk that contains it, and comes back in
  world space.
- `alignToNormal` is carried onto the prop and survives an export/load round trip.
- A saturated area stops accepting props rather than looping.

**Eraser**

- Removes every prop whose centre is inside the radius and no prop outside it.
- Erasing empty ground removes nothing and dirties nothing.
- Uses the same radius as the scatter.

**Undo**

- One scatter stroke is one entry; undo restores the exact prop list.
- One erase stroke is one entry; undo brings the erased props back.
- A stroke mixing ground and props restores both.

**Prop field**

- An aligned prop's instance matrix tilts with the ground; an unaligned one stays
  vertical whatever the slope.
- Props with no `normalAt` supplied stand upright regardless of the flag.

## Out of scope

- A rock species. The brief names rocks as the align-to-normal case, and the prop
  vocabulary has only trees and bushes; adding a species means new geometry, a
  new footprint, and a new sim collider, which is a modelling change rather than
  an editor one. The toggle works on what exists.
- Editing an individual prop — moving, re-scaling or re-rotating one that is
  already down. This paints and erases in bulk.
- Save, load, autosave. Still in memory.
- Painting props onto anything but the topmost layer.
