# 225 — Seeing a building before you place it

## Problem

Spec 224 gives the structure tool a press and a size slider, and both are
worse than they look once somebody actually lays out a village.

**You cannot see what you are about to place.** The cursor ring is the
building's footprint, which says where it will stand and nothing about which
way it faces, how tall it is, or whether its eaves will come down over the
well beside it. Facing is a number in a panel; a hut is a shape on the ground.
So the loop is place, look, undo, adjust the slider, place again.

**And the size is in the wrong place.** `structureScale` is a slider you set
*before* pressing, in units of nothing -- 1.15 means nothing until there is a
hut on the ground next to another hut. Every other radius in this editor is
dragged out under the cursor.

## Shape

Nothing new about what a structure *is*. Two changes to how one is put down.

**A ghost.** `src/render/iso3d/editor/structure-ghost.ts`, three.js, beside
`cursor.ts` and `marker-view.ts`:

```ts
export interface StructureGhostHandle {
  readonly object: THREE.Object3D;
  /** Stand the ghost at a world point, on the ground, turned and sized. */
  showAt(
    kind: StructureKind, x: number, z: number,
    yawRadians: number, scale: number,
    groundAt: (x: number, z: number) => number,
  ): void;
  hide(): void;
  dispose(): void;
}
export function createStructureGhost(): StructureGhostHandle;
```

Built by `buildPropField` -- the same function the map's own props go through
-- so what is previewed is what lands, rather than a second description of a
hut that agrees until one is edited. Its materials are made translucent, which
is safe because `props.ts` makes **one material per batch**: a ghost's
materials are its own, and a shared one turned see-through would take every
tree in the world with it.

Built **once per kind, at the origin**, and moved by a group transform. A
prop's placement is exactly `T(x, ground, z) · R(yaw) · S(scale)` applied to
its parts' local offsets -- which is what `buildRegionInstances` composes, term
for term -- so following the cursor is a matrix rather than a rebuild.

**Press, drag, release.** `structure.ts` gains the arithmetic:

```ts
export const STRUCTURE_SCALE_MIN = 0.5;
export const STRUCTURE_SCALE_MAX = 2;
/** The footprint radius of one of these at scale 1. */
export function baseFootprint(kind: StructureKind): number;
/**
 * The scale a drag of this length means, or null for a drag too short to be
 * one -- in which case the panel's size stands and the gesture is a click.
 */
export function dragScale(kind: StructureKind, distance: number): number | null;
```

The drag distance **is** the footprint radius: the ring stays under the cursor.
Clamped to the same pair of constants the panel's slider is built from, so the
two controls cannot disagree about which sizes exist. Sizing engages once the
drag leaves the *smallest* ring -- derived rather than chosen, so the scale is
continuous from the moment it engages and there is no jump to be surprised by.

`view.ts` moves the placement from the press to the release, which is the cost
of a drag gesture and is stated here rather than discovered. A press with no
drag still places at the panel's size, so a plain click behaves exactly as it
did in 224. The dragged size is written back into the panel on release, so the
next building is the size of the last one and the slider says so.

## Invariants tested

- `dragScale` answers null below the engage distance and a clamped scale above
  it, and in the band between the clamps it is exactly `distance / base` --
  the ring is under the cursor.
- It is continuous where it engages: the engage distance is the smallest ring,
  so the first scale it ever returns is `STRUCTURE_SCALE_MIN`.
- The panel's slider bounds are the same two constants the drag clamps to.
- A press with no drag places at the panel's size; a press with a drag places
  at the dragged size, at the **press point** rather than where the cursor
  ended up.
- The ghost's transform reproduces the placed prop exactly: a ghost shown at
  `(x, z, yaw, scale)` has the same world-space vertices as
  `buildPropField([prop])` for the prop that press would place.
- The ghost's materials are not the prop field's, and are translucent.
- The ghost is hidden wherever `placeStructure` would refuse, so the preview
  going away *is* the refusal, seen before the click rather than after it.
- Switching kind swaps which ghost is shown and builds each one once.

## Out of scope

- **Dragging to rotate.** Facing stays on the slider. One gesture, one
  quantity: a drag that set both would make it impossible to change either
  without changing the other.
- **A ghost for the other tools.** The scatter and the fence paint many props
  from a moving brush and have nothing single to preview; the marker already
  draws a billboard.
- **Previewing what the building would collide with or cover.** The ring is
  the footprint and that is the whole of what is promised.
