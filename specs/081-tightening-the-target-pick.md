# 081 — Tightening the target pick

## Problem

Spec 071 widened the pick to answer "which unit did the player mean" rather
than "which pixel is under the cursor", and it overshot. In play the cursor
grabs a body from further away than the player is pointing: a click meant for
the ground beside a mob names the mob, and two bodies a stride apart both claim
the earth between them. Forgiveness that reaches past what the player is
looking at stops being forgiveness and becomes a click the player did not make.

The player's own body is the same problem in its worst form. It is the one unit
the cursor is guaranteed to be near — the camera keeps it in the middle of the
frame — so it is outlined constantly, and every outline is a lie: a right-click
on yourself can never be an attack (`attackable` has always refused it), so the
white shell promises an order that will not be given, and the click that follows
does nothing rather than the move order it plainly meant.

## Shape

Two constants come down by a quarter, and the local player leaves the candidate
set:

```ts
// render/iso3d/hover.ts
export const FOOTPRINT_PAD = 9;    // was 12, world units
export const SNAP_PIXELS = 16;     // was 22, CSS pixels
```

```ts
// render/iso3d/world/scene.ts, syncBodies
// Everything but the local player is pickable; a corpse and a projectile were
// already out.
if (body.outline && !dead && !isSelf) this.hoverTargets.push({ ... });
```

Nothing else moves. The four tests, their order, and the two units of measure
are spec 071's — this is the same pick, asked to be less generous, minus one
candidate that could never have been acted on.

Dropping self from `hoverTargets` does two things at once, and the second is the
point: it is what removes the outline, and it is also what lets a right-click on
your own feet fall through to being an ordinary move order instead of being
swallowed by a pick the view then refuses.

A quarter is a first guess, not a derived number. The constants stay named and
exported precisely so the next pass is an edit to two lines.

## Invariants tested

- Spec 071's picking tests still hold, stated against the constants rather than
  against their values: the apron reaches `radius + FOOTPRINT_PAD` and no
  further, and the snap reaches `SNAP_PIXELS` and no further.
- The pick is strictly tighter than before: a cursor at the old apron's edge
  (`radius + 12`) or the old snap's edge (22px) now picks nothing.
- The local player is never returned by `pickUnitAt`, so its outline never
  shows and a right-click on it is a move order. Checked on screen rather than
  in Node: `hoverTargets` is built inside `WorldScene`, which is the three.js
  half, and a one-line condition there is not worth a seam to test it through.
  `scripts/preview-world.ts` parks the cursor on the player's own body before
  anything has been targeted and commits the frame as `world-hover-self.png`,
  so "nothing lit up" is a thing on the branch to look at.
- The same harness stops asserting a guessed pixel threshold and *reports* one:
  it widens a deliberately-sloppy right-click until the pick forgives it, and
  prints the widest miss that still names the body. That number is what the
  next pass at these constants gets to argue with.

## Out of scope

- **Which of the four tests to cut.** All four still fire; only their slack
  changes. If the pick is still loose after this, the next question is whether
  test 4 earns its place at all, and that is a separate change.
- **A per-unit selection volume in the content tables.** Still one constant for
  every body, scaled only by the radius each already has.
- **The silhouette box's own generosity.** It is the rig's axis-aligned drawn
  extent, which is wider than the rig; narrowing it is a change to what
  "pointing at it" means, not to how much slack surrounds that.
