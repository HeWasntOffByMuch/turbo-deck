# 095 — A unit is its body and the ground under it

## Problem

Spec 071 made target picking forgiving, and it went too far. A unit is picked
today by four tests: its model, its projected screen bounding box, its footprint
widened by a 12-unit apron, and anything within 22 CSS pixels of that box. The
last two are aiming assistance measured in a currency the player cannot see, and
because `issueOrder` asks `pickUnitAt` *before* it falls back to a ground move
(`view.ts`), every pixel of that assistance is a pixel of ground the player can
no longer walk to. Two monsters standing a stride apart have overlapping aprons
and touching 22-pixel snap zones, so the gap between them — which is bare ground
the sim will happily walk through, since nothing in `src/server/sim` collides one
entity against another — cannot be *ordered*. Right-clicking the gap attacks a
monster instead of stepping between them.

The white hover outline has the same shape of problem in the other direction: it
is a hard, loud, unmissable frame around a body, drawn by inflated back-face
shells, and it says "this is selected" in a game where hovering selects nothing.
It is also what the screen-box test measures against, so the outline literally
made the target area bigger than the unit.

Two changes, one idea: **a unit's target area is the unit.** Its body, and the
patch of ground it is standing on. Nothing else.

## Shape

### Hover reads as brightness, not as a border

`render/iso3d/outline.ts` goes away; `render/iso3d/highlight.ts` replaces it with
the same handle shape.

```ts
// render/iso3d/highlight.ts
/** How much of its own colour a highlighted unit emits on top of its shading. */
export const HOVER_BRIGHTNESS = 0.35;

export interface HighlightHandle {
  /** Brighten or un-brighten the whole rig. Rigs start un-highlighted. */
  setHighlighted(on: boolean): void;
  /** The materials this handle owns, for tests and for disposal. */
  readonly materials: readonly THREE.MeshLambertMaterial[];
}

/** The emissive term that lifts `base` by `brightness` without shifting its hue. */
export function highlightEmissive(base: THREE.Color, brightness: number): THREE.Color;

export function attachHighlight(
  root: THREE.Object3D,
  brightness?: number,
): HighlightHandle;
```

The lift is `emissive = colour × brightness`: proportional, so it keeps the hue
and the flat-shaded facets rather than washing them into a silhouette, and it
brightens the shadowed side too, so a unit reads as hovered from any camera
angle.

`attachHighlight` **clones** each lit material it finds, once per distinct
material instance, and re-points the meshes at its copies. This is not an
optimisation detail, it is the whole reason the function exists: `flatMaterial`
in `meshes.ts` is a module-level cache keyed on colour alone, so every mech rig,
tree and prop that happens to be the same brown shares one material object.
Writing an emissive term into that object would light up the scenery. The cost
is that a rig whose colours are changed after the fact (`CritterRig.setCoat`) is
writing to materials nothing draws any more — which is fine here, because
`setCoat` belongs to the two tuning sandboxes and the Play tab never calls it.

### A pick is the body or the ground under it

`pickHoveredUnit` drops to two tests, and neither of them is measured in pixels:

| # | Test | What it means |
|---|---|---|
| 1 | the body — the rig's meshes, or the cylinder they stand in | the cursor is *on* the unit |
| 2 | its footprint, at exactly `radius` | the cursor is on the ground it occupies |

```ts
// render/iso3d/hover.ts
export interface HoverTarget {
  readonly id: number;
  readonly object: THREE.Object3D;
  readonly position: Vec2;   // where it stands, world XZ
  readonly radius: number;   // its footprint, world units
  readonly base: number;     // the ground height under its feet
  readonly height: number;   // how tall its body stands above that
}

export function pickHoveredUnit(
  raycaster: THREE.Raycaster,
  targets: readonly HoverTarget[],
  groundCursor: Vec2 | null,
): number | null;

/** Where the ray enters a unit's body volume, or null when it misses. */
export function rayBodyDistance(ray: THREE.Ray, target: HoverTarget): number | null;
```

`ScreenBox`, `distanceToBox`, `SNAP_PIXELS` and `FOOTPRINT_PAD` are deleted, and
with them `WorldScene.screenBoxOf` and the eight-corner projection it did per
body per click.

The **cylinder** is what keeps this from being a regression rather than just a
revert. Spec 071's real complaint was that a ray aimed squarely at a spider slips
between its legs and hits the ground behind it; the fix for that is not a
bounding box in screen space, it is to notice that the space between a unit's
legs is *inside the unit*. So the body test is the nearer of two hits: the rig's
meshes, and the vertical cylinder of `radius` × `height` standing on the unit's
feet. Both are world-space, both are depth-ordered, so overlapping units still
settle by whichever body is in front — which a screen-space box never could.

Nothing about the *consequences* of a pick changes: `view.ts` still refuses to
attack itself, a corpse or a projectile, and a right-click that picks nothing is
still a move order. It is just that far more right-clicks now pick nothing, which
is the point.

## Invariants tested

- `highlightEmissive` scales each channel by `brightness` and leaves the hue
  alone; at `0` it is black, so un-highlighting restores the unlit look exactly.
- `attachHighlight` gives a rig materials of its own: two rigs built from the
  same cached `flatMaterial` colour do not share a material afterwards, and
  highlighting one leaves the other's colour and emissive untouched.
- Every lit mesh under the root is covered, and the unlit ground decals a rig
  carries (its heading arrow) are left alone.
- `setHighlighted(false)` returns every material to the emissive it started with.
- `rayBodyDistance` is null for a ray that misses the cylinder, and the entry
  distance for one that crosses it — including a ray that enters through the
  side and one aimed over the top, which misses.
- A ray that passes through a gap in a rig's meshes but through the body cylinder
  still picks the unit.
- Of two units the ray crosses, the nearer to the camera is picked.
- The footprint reaches exactly `radius`: a ground cursor at `radius - ε` picks
  the unit and one at `radius + ε` picks nothing.
- **The squeeze.** Two units standing `2 × radius + gap` apart, with the cursor
  on the bare ground midway between them and the ray missing both bodies, picks
  nothing — so the same click is a move order into the gap.
- A caller that omits the ground cursor still gets the body tests.

## Out of scope

- **Unit-vs-unit collision.** There is none in `src/server/sim` today — entities
  overlap freely — and this spec does not add any. "Squeezing through" is a
  question about what a click *orders*, not about what the sim permits.
- **Per-unit selection volumes in the content tables.** The cylinder is derived
  from the radius each unit already has and the headroom the scene already
  measured for its health bar; no new content field.
- **Sticky targeting or hysteresis** as the cursor crosses between two bodies,
  same as spec 071 left it.
- **A cursor shape** that says a click would attack. The brightness is the only
  signal, as the outline was.
