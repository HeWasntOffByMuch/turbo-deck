# 045 — Scene look pass: low camera, cast shadows, a real canopy

## Problem

The isometric view draws a correct world that does not read as a *place*. Four
things account for most of it, and all four are cosmetic:

1. **The camera looks down, not across.** `DEFAULT_CAMERA_ORBIT` opens at 45°
   of elevation. At that pitch a tree is a green disc and a 200-unit terraced
   mesa is a pattern on the floor: the vertical faces the terrain system exists
   to produce are edge-on and contribute nothing. The reference look is a
   three-quarter view nearer 25-30°, where cliff risers and tree flanks are
   most of what you see.

2. **Nothing casts a shadow.** The renderer never touches `shadowMap`,
   `castShadow` or `receiveShadow`; lighting is one `DirectionalLight` plus an
   `AmbientLight`. Without contact shadows, every prop floats: a tree on a
   slope and a tree on a plain are the same image, and there is no cue that
   the mesa stands *above* the ground beside it.

3. **The canopy never closes.** `scatterInBounds` places 460 trees over a
   4400x4100 world — one tree per ~39,000 square units, an average spacing near
   200 against a crown radius of 34. The `spacing: 76` rejection rule barely
   ever fires at that density; the trees are far apart because there are few of
   them and they are spread *evenly*. Even sprinkling is the real problem: it
   produces no groves and no clearings, just noise, and ground shows between
   every tree.

4. **One tree, stamped everywhere.** Every tree is the same three 7-segment
   cones over a 10x26 trunk box that the bottom tier hides completely, so the
   trunk is never seen. Reference conifer forests read on two things this has
   neither of: a dark trunk rising *through* the foliage, and asymmetric,
   drooping fronds that break the perfect cone.

All of it lives in `src/render/iso3d/` except the scatter, which is discussed
under "What this costs the sim" below.

## Shape

### Camera (`view-settings.ts`)

`DEFAULT_CAMERA_ORBIT` drops to 27° of elevation. The `Height` slider already
spans 10-85°, so this is a default, not a new control.

The orbit's `distance` and the camera's near/far planes have to move with it.
Orthographic framing is set by the zoom, never by the distance, so distance
only decides what survives clipping — and a lower pitch pushes the visible
ground much further along the view axis:

```
visible ground either side of the target ≈ halfHeight / sin(elevation)
```

At the widest zoom (`MAX_VIEW_HALF_WIDTH` 1400, `halfHeight` 875) that is
±1237 units at 45° and ±1927 at 27°. The near plane already clips slightly at
45°; at 27° it would cut a visible band out of the foreground. So:

- `DEFAULT_CAMERA_ORBIT.distance`: 800 → 5000. Costs nothing to framing, and
  lifts the camera clear of the 460-unit northern range at any slider pitch.
- Ortho `near`/`far`: `1 / 4000` → `1 / 12000`, sized to hold the world at the
  widest zoom and the shallowest pitch the slider allows.

These become named constants beside the orbit rather than literals in the
scene, since the two sandbox views build the same camera.

### Shadows (`shadow.ts`, new, + `scene.ts`)

The sun becomes a shadow caster with an orthographic shadow camera that
follows the view and resizes with the zoom. The framing maths is pure and
lives in a new `shadow.ts` next to `view-frame.ts`:

```ts
export const SHADOW_MAP_SIZE = 1024;

export interface ShadowFrame {
  readonly radius: number;      // ortho half-extent of the shadow camera
  readonly distance: number;    // how far up the light vector it sits
  readonly near: number;
  readonly far: number;
  readonly normalBias: number;  // derived from the world size of one texel
  readonly texelSize: number;
}

export function shadowFrame(viewHalfWidth: number): ShadowFrame;
```

The scene reads the light *direction* from the controls, places the sun at
`target + direction * frame.distance`, aims `sun.target` at the same point,
and rewrites the shadow camera's extents whenever the zoom moves enough to
matter.

Deliberate choices:

- **`BasicShadowMap`, 1024²**. Unfiltered and low-resolution, so shadow edges
  come out hard and chunky. A soft PCF edge is the wrong texture next to a
  posterized, dithered, `image-rendering: pixelated` frame.
- **`normalBias` derived from texel size, not a fixed `bias`.** The terraced
  cliff risers are near-vertical faces meeting near-horizontal shelves, which
  is the classic acne case; offsetting the lookup along the surface normal by
  ~1.5 texels fixes it without the peter-panning a depth bias large enough to
  do the same job would cause.
- **Terrain both casts and receives.** A cliff throwing its shape onto the
  ground below is most of the point; without it the mesa still reads flat.
  Water does neither.

### Canopy (`terrain/vegetation.ts`)

`scatterInBounds` stops sprinkling and starts clustering. Cluster centres are
drawn across the bounds, and each prop picks a centre and a jittered radial
offset biased toward it, so the world comes out as groves with meadows between
them. A stray fraction is still placed uniformly, so single trees stand in the
open. Counts rise to fill the groves (trees 460 → 1400, bushes 340 → 700).

The flat `spacing: 76` rejection becomes footprint-aware:

```ts
// reject when: distance < footprintRadius(a) + footprintRadius(b) + walkGap
readonly walkGap: number;   // clear ground left between two trunks
```

`walkGap` defaults to `2 * PLAYER_RADIUS`, which is *stricter* than what ships
today: a flat 76 lets two full-size trees (footprint 36 each) stand with 4
units between them, which no body can pass. Scaling the rule to the props
being placed lets small trees pack tightly into a grove while guaranteeing
every gap in the world is walkable.

The module stays what it is: pure, seeded-PRNG only, no `Math.random`, no DOM,
no three.js, same seed → same arrangement.

`scatterProps` — the play area's own sparse stand — is **not touched**. The
fight is staged on exactly the trees it is staged on today.

### Tree silhouette (`props.ts`)

- The trunk rises through the canopy: taller, tapered, and the bottom foliage
  tier lifts off the ground so the trunk reads under it as well as above.
- A second species, so the same outline is not stamped world-wide: the current
  **fir** (a tight stack of tiers) alongside a **pine** (a long bare trunk
  under a few wide fronds high up).
- Per-instance variation in tier count, lateral offset and tier lean, derived
  from a pure hash of the prop's position — deterministic, and independent of
  `tint` so species and autumn colour don't correlate.

Instances are bucketed by (region, species, tier count) so each bucket is one
`InstancedMesh` per part, keeping the batching and the tight per-region bounds
the current field relies on.

`makeTree`/`makeBush` in `meshes.ts` are deleted. They are unreferenced, and
`props.ts` carries a comment promising it matches `makeTree` exactly — a
promise this spec breaks and that nothing checks.

### Pinned seeds (`seed.ts`, new)

All three views seed themselves from `Date.now()`, so no two screenshots are
of the same world and a look change cannot be compared before and after. A
`?seed=` query parameter overrides it. Renderer-only: the sim is handed a
number and does not know where it came from.

## What this costs the sim

Since spec 044 the vegetation list is world data, not decoration: the same
array the renderer batches is what `vegetationColliders` hands the sim. So a
denser world scatter *is* visible to the sim, and "renderer-only" cannot be
literally true for change 3. What is preserved instead:

- The **play area is untouched** — `scatterProps` and its defaults are
  unchanged, so the staged fight has exactly the trees it has today.
- **No sim code changes.** No rule, constant or module under `src/sim/` or
  `src/cards/` is edited.
- **Traversability improves rather than degrades.** The footprint-aware gap
  guarantees a body-width channel between any two props, which the flat
  spacing did not.

The denser surrounding world does mean more circles for the nav grid to
rasterize (~2100 vs ~800), once per body radius per world, cached thereafter.

## Invariants tested

- `shadowFrame` grows the shadow camera monotonically with the view span, and
  its `radius` covers the ground the view frames at the shallowest pitch the
  camera slider allows.
- `shadowFrame`'s `near`/`far` contain the whole world depth for every span in
  `[MIN_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH]`.
- `shadowFrame`'s `normalBias` scales with the world size of one shadow texel.
- The default camera orbit's elevation is in the 25-30° band, and its near/far
  planes contain the world at `MAX_VIEW_HALF_WIDTH` and at the slider's
  shallowest elevation.
- `scatterInBounds` is deterministic: same seed and bounds → identical props.
- `scatterInBounds` respects the footprint-aware gap for **every** pair, and
  never places a prop the predicate rejected.
- `scatterInBounds` clusters: the mean nearest-neighbour distance is
  materially below the uniform-Poisson expectation for the same count and
  area.
- `scatterProps` output is byte-identical to what it produces today (the play
  area is unchanged).
- `viewSeed` returns the parsed value for `?seed=N`, and a clock-derived
  32-bit value when the parameter is absent or unparseable.

## Out of scope

- **Terrain height reaching the sim.** `collision.ts` and `pathfinding.ts`
  have no terrain references and the world is built inside the renderer; real
  in-arena cliffs would be game rules and need the world to become sim-owned
  data first. Its own spec.
- God rays, bloom, ambient occlusion.
- Waterfalls and water motion — the water plane stays a flat translucent quad.
- New prop kinds: boulders, logs, bridges.
- Shadows in the movement/debug sandboxes. They share `view-settings.ts` and
  pick up the camera default, but keep their single unshadowed light.
