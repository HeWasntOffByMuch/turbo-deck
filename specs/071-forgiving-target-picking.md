# 071 — Forgiving target picking

## Problem

Spec 070 made a right-click on a unit an attack order, and picks that unit with
spec 041's hover test: raycast the models, and fall back to a circle on the
ground the size of the body. Both are *exact*, and exactness is the wrong
property here. The question a click asks is not "which pixel is under the
cursor" but "which unit did the player mean", and the two stop being the same
thing as soon as the view is zoomed out — a twenty-unit body is forty pixels at
the default framing and nine at the far end of the wheel, which is smaller than
the mouse moves while the button goes down.

Three ways it misses today, all of them things a player would call a bug:

- **Through a gap.** The cursor is squarely on a spider, but between two legs,
  so the ray hits nothing and the ground behind it is bare.
- **Just off the body.** A pixel past the shoulder. Nothing is picked, and
  because the same click is also the move order, the player *walks* instead —
  the worst possible failure, since it takes them out of position rather than
  doing nothing.
- **Above the head.** The footprint is a circle around the *feet*, and the
  camera looks down at an angle, so pointing at the top of a body puts the
  ground ray well behind it.

## Shape

Four tests, in order of how sure each is. The first one to answer wins, so a
body the cursor is genuinely on always beats one it is merely near:

| # | Test | What it means |
|---|---|---|
| 1 | the model, by raycast | the cursor is *on* the unit |
| 2 | inside its drawn box | pointing at it; the ray found a gap |
| 3 | its footprint + `FOOTPRINT_PAD` | standing on the ground it occupies |
| 4 | within `SNAP_PIXELS` of its drawn box | beside it |

```ts
// render/iso3d/hover.ts
/** How far past its body a unit's ground footprint picks it up, world units. */
export const FOOTPRINT_PAD = 12;
/** How far from a unit's drawn silhouette the cursor may be, in CSS pixels. */
export const SNAP_PIXELS = 22;

/** A unit's drawn extent on screen, in CSS pixels within the canvas. */
export interface ScreenBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface HoverTarget {
  // ...as before, plus:
  /** Where it is drawn; absent or null skips tests 2 and 4. */
  readonly screen?: ScreenBox | null;
}

export function pickHoveredUnit(
  raycaster: THREE.Raycaster,
  targets: readonly HoverTarget[],
  groundCursor: Vec2 | null,
  cursorPixels?: Vec2 | null,   // new, optional
): number | null;

/** Pixel distance from a point to a rectangle; zero when it is inside. */
export function distanceToBox(point: Vec2, box: ScreenBox): number;
```

Two units of measure on purpose. The **apron** is world units, because "the
ground under a mob belongs to it" is a fact about the world and should not
change with the camera. The **snap** is pixels, because aiming error is a
property of the hand and the mouse, so a fixed pixel budget is the same amount
of help at every zoom — which in world terms means more help exactly when the
target is smaller. A world-space snap radius does the opposite of that.

`WorldScene` supplies `screen` by projecting each body's world bounding box,
corner by corner, inside `pickUnitAt`. A projected centre with an assumed size
would not do: a rig is much taller than it is wide, and the isometric camera
leans, so a circle around the feet is not the shape the player sees. It is
computed in the pick rather than during the frame so that a click never depends
on a hover having happened first.

Nothing about the *consequences* of a pick changes. The view still refuses to
attack itself, a corpse or a projectile, and a right-click that picks nothing is
still a move order.

## Invariants tested

- `distanceToBox` is zero inside the box and the true Euclidean distance
  outside it, including diagonally past a corner.
- A cursor inside a unit's drawn box picks it even when the ray passes through
  a gap and hits nothing.
- A cursor within `SNAP_PIXELS` of the box picks it; one comfortably past that
  picks nothing.
- The ground apron reaches `radius + FOOTPRINT_PAD` and no further.
- Precedence holds in both directions: a box the cursor is *inside* beats
  another unit's footprint underneath it, and a footprint the cursor is *on*
  beats a third unit it is merely near.
- Of two boxes the cursor is inside, the one whose middle it is nearest wins;
  of two it is near, the nearer wins.
- Omitting `cursorPixels` reproduces spec 041's model-and-footprint pick
  exactly, so a caller that has projected nothing still works.
- End to end in a browser: a right-click 40 CSS pixels beside a body — well
  outside it, and well short of the next one — still names it as the target.

## Out of scope

- **Priority by kind.** A nearby enemy does not outrank a nearby ally or your
  own body; the pick answers "which unit", and the view decides what may be
  attacked, exactly as it does now.
- **Sticky targeting.** No preference for the unit already targeted, and no
  hysteresis on the outline as the cursor crosses between two bodies.
- **Cursor-shape feedback.** The outline is the only signal that a click would
  attack rather than move.
- **A per-unit selection volume in the content tables.** The apron is one
  constant for every body, scaled only by the radius each already has.
