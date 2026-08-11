# 127 — The ground a formation stands on

## Problem

The cutaway (spec 126) opens a porthole through the rock in front of a body, and
what shows through it is whatever the ground under the formation happens to be —
meadow, usually. So a unit standing behind a tier appears in a small green
clearing that it cannot walk out of, and the only thing on screen saying "rock"
is the wall around the hole that the porthole just removed.

Two more elaborate answers were considered and both are bigger than the problem.
Drawing the rock's **outlines** through the porthole means the depth prepass and
the colour pass deliberately disagree about the world, and the outline pass is a
hike-look switch that is off by default. An **x-ray silhouette** of the body over
intact rock is another pass, another render target and a depth trick per body.

The cheap answer is that the premise is wrong. The ground under a formation is
not meadow. It is rock, and always was.

## Shape

```ts
// src/terrain/rock.ts — pure.

export function paintGroundUnder(
  store: MapChunkStore,
  layerId: string,
  footprint: MapRect,
  material?: TerrainMaterial, // default 'rock'
): ChunkCoord[];
```

Baked into the document at authoring time, not derived at render time. A derived
answer would mean the mesher asking, per ground cell, whether any other layer is
solid above it — a cross-layer lookup on every rebuild, to compute something that
does not change once a tier is drawn.

`addRock` calls it on the same layer it already clears props from, in the same
stroke. The ground chunks are already captured for undo by the prop clearing, so
one Ctrl+Z takes back the tier, the trees and the paint together and there is
nothing new to record.

Only cells that are actually solid ground are painted, and only where the
material would change — so the returned chunk list is exactly what needs
re-meshing, and a second drag over the same footprint reports nothing.

### Carving leaves the stone

`carveRock` does not put the meadow back. It could not honestly: the material a
cell had before is not recorded anywhere, and re-deriving it would mean running
the classifier over ground that has since been edited by hand. It is also the
right answer — ground that had a formation on it is rocky ground, and a bare
patch of stone where one was removed reads as what it is.

Undo is unaffected; it restores the chunk whole.

## Invariants tested

- Ground under a tier's footprint reads `rock` after the tier is drawn.
- Ground outside the footprint is untouched.
- The call reports the chunks it changed, and nothing else.
- One undo restores the document byte for byte — tier, trees and paint.
- A tier drawn with no ground layer named leaves the ground entirely alone.

## Out of scope

- **Repainting on carve.** See above: the stone stays.
- **A material brush.** There is no tool for painting terrain materials by hand,
  and this does not add one. An author who wants the meadow back undoes.
- **Stairs.** A stair is walkable, so the ground under it is not a wall and must
  not be dressed as one.
- **Anything the shader does.** This is one field in the document; the renderer
  draws it exactly as it draws every other rocky cell.
