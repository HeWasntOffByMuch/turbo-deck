# 096 — A damage number that stays where it landed

## Problem

A damage number is pinned to the body it belongs to: `hud.ts` remembers the
target's entity id and, every frame, looks that id up in the frame's
`ScreenAnchor` list. That is wrong in two ways, and the second is the one you
see.

While the body lives, the number rides it -- a monster walking away drags its
own damage along, so a number that is meant to mark *where the blow landed*
instead reports where the victim is now.

When the body dies the anchor stops arriving, and the old code simply left the
number at the last screen pixel it was given. A screen pixel is not a place:
pan the camera and it stays put on the glass, so the killing blow's number
slides across the map and follows the player around. That is the reported bug,
and the last number in a fight is exactly the one you want to read.

Both are the same mistake -- the number is stored in the wrong space. It should
be a **world** point, taken once when the blow lands and projected fresh every
frame, so it stays over the patch of ground where it happened whatever the
camera or the victim does next.

## Shape

A new pure module, `src/render/iso3d/world/damage-popup.ts`, owns the floating
numbers' whole life and none of their DOM:

```ts
/** A point in the world a number is nailed to: ground x/z, plus a height. */
export interface WorldAnchor {
  readonly x: number;
  readonly y: number;
  readonly lift: number;
}

/** Projects a world point to a canvas pixel -- `WorldScene.projectPoint`. */
export type Projector = (
  x: number,
  y: number,
  lift: number,
) => { readonly x: number; readonly y: number; readonly onScreen: boolean };

export interface PopupPlacement {
  readonly id: number;
  readonly left: number;
  readonly top: number;
  readonly opacity: number;
  readonly onScreen: boolean;
}

export class DamagePopups {
  /** `group` only fans lanes out; `at` is where in the world it happened. */
  add(group: number, at: WorldAnchor): { id: number; expired: readonly number[] };
  /** Advance one frame. `expired` is what the caller should now delete. */
  step(project: Projector): {
    live: readonly PopupPlacement[];
    expired: readonly number[];
  };
}
```

`WorldScene` gains the other half of it, beside `projectPoint` (spec 076):

```ts
/** Where a body is standing and how far over its head a number hangs. */
bodyAnchor(id: number): WorldAnchor | null;
```

Read at the moment the `CombatResult` arrives, which is *before* the frame that
drops a despawned body -- so a killing blow is anchored to where the victim was
last drawn, and then never asks about it again.

`hud.ts` keeps only the element: `addDamage(entityId, at, damage, crit)` builds
the SVG and hands the anchor over; `createHud(project)` takes the projector once
at construction, since it is the same function every frame.

## Invariants tested

- A popup's screen position is the projection of the world point it was given,
  plus its lane offset and its rise. Pan the projector and the popup moves with
  the world, not with the glass.
- The only world point ever projected for a popup is the one handed to `add`.
  Nothing about the target is consulted again -- a dead, despawned or moved body
  changes nothing.
- A popup rises and fades over `NUMBER_LIFE` frames and is reported as expired
  on the frame it runs out, exactly once.
- Numbers landing on one group cycle through the lanes; once a group's numbers
  have all expired its lane counter is dropped, so a fresh burst starts centred
  and the counter map does not grow with every entity ever hit.
- Adding past the capacity evicts the oldest and reports its id, so no element
  is orphaned.
- A popup whose world point is off screen is reported `onScreen: false` rather
  than placed at a nonsense pixel.

## Out of scope

- The rise and the lane fan stay in CSS pixels: they are how the number reads on
  the glass, not where it happened. Only the anchor is in world space.
- No change to what the server sends, when a number appears, or what it says.
- The health and cast bars still ride their bodies by `ScreenAnchor`, which is
  right: a bar is a property of a unit, and vanishes with it.
