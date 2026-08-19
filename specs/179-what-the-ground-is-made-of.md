# 179 — What the ground is made of

## Problem

The material vocabulary has been complete since spec 043 — water, sand, grass,
dirt, rock, snow — the document stores one index per cell, and `MapChunkStore`
has had a `setCellMaterial` since spec 048. What has never existed is a way for
a person to call it. The only thing that writes a material after the bake is
`refreshMaterials` in `brush.ts`, and that *derives* one from height and slope.

So in the editor a material is a consequence and never a choice. To lay a dirt
path you tilt the ground until `DEFAULT_BANDS.dirtSlope` catches it; to get sand
you drop the ground near the water line; to get snow you raise it past 255. The
one thing you cannot do is say what a patch of ground is made of — which is the
first thing anybody opens a map editor to do, and the reason `arena.json` is
grass everywhere it is not a cliff.

## Shape

### The mode (`editor/tools.ts`)

An eighth `EditorMode`, `paint`, a peer of `terrain` and `rock` rather than a
fifth `TerrainTool`. `applyTerrainBrush` is documented as "what a stroke does to
the height array" and every one of its four tools reads and writes heights;
paint touches no height at all, so it gets its own module the way `scatter`,
`fence`, `rock` and `parts` each did.

```ts
// EditorSettings gains one field.
paintMaterial: PaintMaterial;
```

It shares `radius` and `falloff` with the terrain brush — one footprint, so
switching between shaping a hillside and painting it keeps the brush you were
working at.

### The palette (`editor/paint.ts`, pure, tested in Node)

```ts
export type PaintMaterial = Exclude<TerrainMaterial, 'water'>;
export const PAINT_MATERIALS: readonly PaintMaterial[];   // TERRAIN_MATERIALS minus water
export const DEFAULT_PAINT_MATERIAL: PaintMaterial = 'dirt';

export interface PaintSettings {
  readonly material: PaintMaterial;
  readonly radius: number;
  readonly falloff: number;
}

export interface PaintStep {
  readonly layerId: string;
  readonly x: number;
  readonly z: number;
  /** Where the cursor was last frame of this stroke, or null if it just began. */
  readonly from?: { readonly x: number; readonly z: number } | null;
  /** Called for a chunk the first time a cell in it is about to change. */
  readonly onTouchChunk?: (cx: number, cz: number) => void;
}

export function applyTerrainPaint(
  store: MapChunkStore,
  settings: PaintSettings,
  step: PaintStep,
): ChunkCoord[];
```

**Water is not paint**, and the palette is five rather than six. A material says
what ground is made of; `water` says where the ground sits relative to the flood
line, which is a different kind of fact and is why `classify` and
`resculptMaterial` both decide it from `height <= waterLevel` before anything
else. Both directions are a lie the renderer would draw: `buildWater` puts the
quad at `layer.waterLevel`, so water painted on high ground is a surface buried
under the terrain that carries it, and sand painted on a lake bed deletes the
surface while leaving the ground below the flood line — a dry hole in a lake.

For the same reason **water is refused in both directions**: a cell already
stored as water keeps it, and so does one below the flood line. Both checks are
needed, because they disagree — stored water is what the renderer actually puts a
surface over, while `classify` decided it from a sample height and this guard
measures the mean of four jittered corners, so a cell can be stored water with
its corners averaging above the level. That pair is what keeps paint and the
height brush from contradicting each other: paint never writes a material the
next height stroke would immediately revoke. A cell with no ground in it
(`solid === 0`) refuses too; there is nothing there to be made of anything.

### The soft edge is dithered, and the dither belongs to the ground

One material per cell, never blended — `types.ts` says so, and spec 043 gives the
reason: hard boundaries are the art direction, a shoreline is a line. So a
falloff cannot fade a material the way it fades a height, and the only soft edge
available on a hard-quantized field is a stochastic one. A cell takes the paint
when the brush's weight there beats a threshold:

```ts
export function cellDither(col: number, row: number, seed: number): number;  // [0, 1)
// painted  <=>  brushWeight(distance, radius, falloff) > cellDither(col, row, seed)
```

The threshold is `hashUnit2` of the cell's **own coordinates**, not a draw from a
stroke RNG, and that is the whole of the design. A per-frame roll would fill the
rim in by itself: a cell at weight 0.1 is painted with probability
`1 - 0.9^60 ≈ 99.8%` after one second of holding the brush still, so the feathered
edge it draws survives exactly as long as you keep moving. Hashing the cell
instead makes the speckle a property of the ground — holding still changes
nothing, painting the same place twice is idempotent, and a second stroke over
the same rim leaves the same cells, so a boundary you go back over does not creep
outward. Spec 125's rock erosion is the same shape, and for the same reason.

`falloff = 0` makes `brushWeight` 1 inside the radius and 0 outside, so the same
knob still gives a hard circle when the edge is meant to be deliberate.

### A stroke is a capsule, not a string of stamps

The footprint is the distance to the **segment** from `from` to `(x, z)`, so a
drag paints the swept circle exactly. Not a stamp per frame: a fast drag would
otherwise leave a dotted line of circles, and how dotted would depend on the
frame rate. Measured at the cell's centre, because a cell is what is being
written — `brushCorners` measures at corners because a height brush moves
corners.

This is what makes a paint stroke **a function of where the cursor went and not
of how fast it got there**, which the height brush cannot be: it integrates a
rate over `dtSeconds`, and paint has no rate to integrate. `from` is dropped
whenever the cursor leaves the terrain, so a pick that lands somewhere else does
not paint the line between.

### What a stroke costs (`editor/view.ts`)

A re-mesh of exactly the chunks whose cells changed, and a document revision.
Nothing else, and this is the first edit in the editor for which that is true:

- **no nav re-bake** — walkability is ground, solidity and the water line
  (`nav.ts:67`), and none of them moved;
- **no prop-field rebuild** — a prop's colour comes from its own part's tone,
  never from the ground it stands on, and nothing moved for it to stand on;
- **no marker refresh** — markers sit at a height.

`onTouchChunk` fires on the first *write* into a chunk rather than for every
chunk the footprint covers, so a stroke dragged back over ground it already
painted opens no history entry and returns no dirty chunks. `setCellMaterial`
leaves solidity and tone alone, and tone is left deliberately:
`toneVariant(x, z, seed)` is a pure function of position, so a painted cell keeps
exactly the mottle a rebake would have given it and painted ground is
indistinguishable from baked ground.

### The panel (`editor/panel.ts`, `editor/tools.ts`)

A `Paint` folder with a five-button strip whose armed button is filled in the
material's own `TERRAIN_COLORS` tone — only the armed one, as in every other
strip here, because which is on has to read at a glance. `cursorColor` returns
that colour too, following `ROCK_TOOL_COLORS.stair`, which is already the warm
dirt of the tread it lays. `visibleGroups` gains `paint` and `falloff`, and the
falloff slider moves up beside `radius` since both brushes share it.

## Invariants tested

- **The palette is the vocabulary minus water**: `PAINT_MATERIALS` is
  `TERRAIN_MATERIALS` with `water` removed, in the same order, so a seventh
  material appears in the palette without anyone editing a list.
- **Paint writes the material and nothing else**: every corner height, every
  solidity flag and every tone in the touched chunks is byte-identical after a
  stroke.
- **Water is never overwritten**, and a cell at or below the layer's water level
  keeps what it had; a non-solid cell keeps what it had.
- **The centre is solid**: with any falloff, every cell whose centre is inside
  `radius * (1 - falloff)` is painted, because `brushWeight` is 1 there and
  `cellDither` is strictly below 1.
- **Nothing outside the radius is touched**, for either endpoint or anywhere
  along the segment.
- **The edge is dithered when `falloff > 0`**: some cells inside the radius are
  left unpainted, and they are the ones near the rim — the painted fraction falls
  monotonically with distance across the taper, measured in bands.
- **`falloff = 0` is a hard circle**: every cell inside the radius painted, none
  outside.
- **Idempotent**: a second identical step changes nothing, returns no chunks and
  calls `onTouchChunk` for none. Holding the brush still for sixty steps paints
  exactly what one step painted.
- **Path-defined, not rate-defined**: one step from A to B paints the same cells
  as the same distance walked in ten steps, and a swept segment paints a superset
  of both its endpoints' discs.
- **Deterministic**: the same store, settings and path produce the same cells
  every run; changing the seed changes the rim and never the core.
- **`onTouchChunk` fires once per chunk and only for chunks that change**, and
  the returned chunk list is exactly those.
- **A degenerate stroke is a no-op**: zero radius, a non-finite point, an unknown
  layer, a point off the layer's grid.
- Undo restores the materials, since a `ChunkSnapshot` already copies the array —
  asserted through `history.ts` rather than assumed.
- **A painted map saves and loads back the same**, through the document path the
  editor's Save and the server's boot both take: the point of the tool is ground
  that stays painted.
- **The picture** (`npx tsx scripts/preview-paint.ts`), measured off the pixels of
  the real editor: the mode arms and shows its own folder, every material has a
  swatch and water has none, a press lays ground that is brighter for snow and
  warmer for dirt, coverage falls off from the middle to the rim rather than
  stopping dead, Ctrl+Z gives the ground back, a second press over the same place
  changes nothing, and a drag paints a footprint elongated along the path it
  swept.

## Out of scope

- **Blending or a weight per material.** One material per cell is spec 043's
  decision and the reason the boundaries read; this paints within it rather than
  replacing it.
- **An eyedropper.** Worth having, and a separate gesture rather than a mode.
- **Painting water, or an editor for the layer's water level.** Both are the flood
  line, and the flood line is a property of the layer.
- **Protecting paint from the height brush.** `resculptMaterial` still turns a
  freshly-raised cliff to rock over whatever was painted there; that rule is spec
  050's and unchanged. Paint the slope after you have shaped it.
- **`region` tags.** Spec 048 dropped `TerrainRegion` from the document because
  baked materials are authoritative, and this is the tool that makes that true
  rather than a reason to bring it back.
