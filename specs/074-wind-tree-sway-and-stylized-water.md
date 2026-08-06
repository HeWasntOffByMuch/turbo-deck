# 074 — Wind-driven tree sway and stylized water

## Problem

The world is still. A thousand trees stand rigid, and the water is a single
translucent plane per layer with one flat colour — the only surface in a
deliberately posterized scene that reads as a modern renderer's default rather
than as art direction.

This adds one weather system, shared by both: a wind vector that bends the
trees on a travelling wave and scrolls a faint streak layer across the ground
and the sea, and a water surface of exactly four hard-edged colours whose
shallow band, isolines and shoreline foam are all driven by the same clock.

Both are shaders. There is **no per-frame CPU animation**: one `uTime` uniform
is written per frame and nothing else moves.

## What the renderer already is (established before designing this)

- **three.js 0.160**, `MeshLambertMaterial` everywhere, vertex colours, no
  `ShaderMaterial` and no `onBeforeCompile` anywhere in the repo today. One
  post-process pass exists (`RetroPass`, spec 038) and no more are added here.
- **Trees are `InstancedMesh`**, bucketed *per region × species × part*
  (`props.ts`, `REGION_SIZE = 1100`) — deliberately not one world-spanning
  batch, because a world-spanning bounding sphere can never be culled. A tree
  is a box trunk plus 3-4 `ConeGeometry` tiers, each its own batch.
- **Terrain is per-chunk vertex-coloured geometry** (`terrain-mesh.ts`), meshed
  from `TerrainChunk`s that arrive over the wire (spec 072) and are patched in
  one at a time through `TerrainMeshHandle.rebuild`. A chunk already carries
  `materials: Uint8Array` per cell, and index 0 is `water`.
- **The frame is drawn at a fixed low internal resolution** (`RENDER_H = 300`,
  `MAX_RENDER_W = 760`) and CSS-upscaled with `image-rendering: pixelated`. So
  the "snap world position to a grid" clause of the water brief does not apply:
  the pixel grid *is* the low-res buffer.

## Shape

### One config, two shaders

`src/render/iso3d/wind.ts` — pure (no three.js, no DOM, no clock), so the
numbers are testable in Node and there is exactly one source of truth:

```ts
export interface WindConfig {
  readonly dirX: number;      // unit vector on the XZ plane
  readonly dirZ: number;
  readonly strength: number;  // radians of lean at |wind| = 1
  readonly travel: number;    // radians of phase per world unit along the wind
  readonly streakSpeed: number;   // world units/second the streak layer scrolls
  readonly streakScale: number;   // world units per streak noise feature
  readonly streakContrast: number;
}
export const WIND: WindConfig;

/** The shader's `wind()`, in TypeScript. Same expression, term for term. */
export function windAt(config: WindConfig, x: number, z: number, t: number): number;
/** Lean angle for one vertex of one tree. */
export function bendAngle(config: WindConfig, wind: number, stiffness: number, bend: number): number;
/** 1 / (1 + trunkRadius / height). */
export function stiffness(trunkRadius: number, height: number): number;

export const WATER: {
  readonly deep: number; readonly mid: number;
  readonly shallow: number; readonly foam: number;
  readonly shoreRange: number;   // world units the R8 shore field encodes
  readonly midEdge: number; readonly shallowEdge: number;  // world units from shore
  ...
};

export const GLSL_WIND: string;   // wind(), shared verbatim by every shader
export const GLSL_NOISE: string;  // n2(), field(), bayer4()
```

`src/render/iso3d/wind-uniforms.ts` holds the three.js side: one shared
`THREE.IUniform` object per value, handed *by reference* into every material,
plus `advanceWind(seconds)`. Sharing the uniform objects rather than copying
their values is what makes "one source of truth" mechanical.

### Tree sway (vertex shader only)

- `aBend` is baked into each tree part's geometry at generation, in `props.ts`:
  `aBend = (partOffsetY + localY) / speciesHeight`, clamped to `[0, 1]`. It is
  scale-free (offset, local Y and species height all scale together), so one
  baked attribute serves every instance size.
- Two **instanced** attributes carry what the wind is sampled with:
  `aWindBase` (`vec3`, the tree's ground point in world space) and `aWindTune`
  (`vec2`: stiffness, and a position-hashed phase offset). The wind is
  therefore evaluated **once per tree**, never per vertex — the same value for
  the trunk and for every cone above it, which is what stops the canopy
  shearing off the trunk.
- The displacement is applied by replacing the `project_vertex` chunk via
  `onBeforeCompile`, *after* `instanceMatrix` and before `modelViewMatrix`, as
  an arc about the base:
  `p.xz += dir * (h * sin(angle)); p.y = h * cos(angle)` — so trunk length is
  constant under lean.
- The identical patch is applied to a `customDepthMaterial` and a
  `customDistanceMaterial` on every tree batch, so the sun's shadow map and the
  torch's cube shadow bend with the trees instead of standing still.
- Each batch's bounding sphere is computed and then inflated by the maximum tip
  displacement, so a swaying crown cannot be culled while it is still on screen.

### Water (fragment shader only, opaque, one quad per chunk)

- `src/render/iso3d/shore-sdf.ts` — pure. A BFS distance transform over the
  water/not-water mask of one chunk **plus a 12-cell apron read from
  neighbouring chunks**, clamped to `WATER.shoreRange` and packed to `R8`.
  Cells in chunks that have not streamed in yet read as *unknown* and are
  treated as water, so an absent neighbour never fabricates a shoreline; the
  mesher re-bakes a chunk's field when any of its eight neighbours lands.
  Distance is horizontal distance to the nearest dry cell — **not**
  `waterLevel - height`, which collapses to nothing against a cliff.
- `MeshLayer` gains `materialAt(col, row): number | null` (global cell grid,
  `null` outside what is held) so the SDF can cross chunk boundaries.
- One quad per chunk at the layer's water level, skipped entirely for chunks
  with no water cell. Opaque, depth-tested, no blending — land above the water
  level occludes it for free, which is what shapes the coastline.
- Every noise sample is taken at **world XZ**, never chunk-local UV.
- Four colours, `step()` boundaries, a 4×4 Bayer offset on the band threshold,
  isolines of a domain-warped field, and foam thresholded on shore distance
  modulated by a travelling sine. No fresnel, no reflection, no transparency.

### Shared streak layer

`GLSL_STREAK` multiplies albedo by `1 ± streakContrast` sampled at
`worldXZ - windDir * uTime * streakSpeed`, patched into the terrain surface and
wall materials with `onBeforeCompile` and compiled into the water shader from
the same string.

## Invariants tested

- `windAt` is a pure function of `(config, x, z, t)` — same inputs, same value,
  and it never leaves `[-1.15, 1.15]`.
- The dominant term of `windAt` has a period of 1/0.35 s ± 1%, and the gust
  envelope a period of 1/0.04 s ± 5% (measured by zero crossings, not asserted
  against the constants).
- Two points separated along the wind axis are **out of phase**: the lag
  between their wind maxima equals `distance * travel / 2.2` seconds.
- Two points separated *across* the wind axis are exactly in phase.
- `bendAngle` is 0 at `aBend = 0` (base pinned) and grows monotonically to the
  tip; peak tip lean is within 5°–7°.
- The arc preserves length: `|(h sin a, h cos a)| == h` for every `a`.
- `stiffness` falls as the trunk thickens and is scale-invariant.
- Baked `aBend` over a real tree's parts starts at 0 at the trunk's foot, ends
  at 1 at the crown tip, and is non-decreasing with world height.
- Every tree batch carries `aBend`, `aWindBase` and `aWindTune`, has a
  `customDepthMaterial` and a `customDistanceMaterial`, and has a bounding
  sphere at least `maxTipDisplacement` larger than its rigid one.
- `shoreDistance` on a hand-built mask equals the true horizontal distance to
  the nearest dry cell (checked against a brute-force O(n²) reference).
- An unknown (unstreamed) neighbour never produces a shore closer than the
  known geometry allows: distances are monotonically non-increasing as
  neighbours arrive.
- Two chunks that share an edge agree on the shore distance along that edge to
  within one quantization step — the seam test.
- A chunk with no water cell produces no water mesh; a chunk with water
  produces exactly one, at the layer's water level, opaque and not blended.
- Both terrain and water read the *same* wind uniform objects: writing
  `advanceWind` once moves every material.

## Measured, and where the numbers disagree with the brief

Everything answerable by arithmetic is asserted in `wind.test.ts`,
`shore-sdf.test.ts`, `sway.test.ts`, `water-material.test.ts` and
`terrain-mesh.test.ts`. Everything that is only about the *frame* is measured by
`scripts/preview-wind.ts` against a real GL context. Three results need saying
out loud rather than filing as passes.

**The travelling wave is at this world's scale, not the brief's.** The brief
specifies `travel = dot(originXZ, uWindDir) * 0.06` and asks that two trees ~20
*world units* apart visibly lag. Both assume roughly metric units. Here a
full-grown fir is 128 units tall, so 0.06/unit gives a 105-unit wavelength —
narrower than one crown — and a grove would shimmer at random rather than lean
together, which is the opposite of the reference. The wavelength is 600 units
instead (`WAVE_LENGTH` in `wind.ts`, one constant). At 20 units apart the
measured lag is 0.095s — five frames at 60Hz, and visible; at the ~200 units the
scatter actually settles at it is 0.95s, a third of a cycle.

**"Exactly four colours" and the rest of the brief cannot both hold.** The
bands are four colours with `step()` edges and nothing between them. But the
brief's own shader skeleton then multiplies isoline pixels by 1.22, and part 3
multiplies a continuous streak into albedo — so a colour picker over the water
finds four dominant tones covering 86% of it, four more from the isolines, and a
low-amplitude spread from the streak. Measured: the four palette colours are the
top four by area; through the shipped retro pass (spec 038), which quantizes the
whole frame anyway, the water resolves to 49 colours across the entire lake
including its shoreline and the sand behind it.

**Arc versus translation is not visible at this lean, only correct.** At 5.7°
the difference between rotating the crown about the base and sliding it sideways
is 0.2 world units of trunk length — a fifth of a pixel. The invariant is
asserted exactly in `wind.test.ts` rather than photographed, because no
screenshot at any zoom this game uses could tell them apart.

## Out of scope

- Water transparency, depth fog, reflections, refraction, caustics, render
  targets, normal maps, and any new post-process pass.
- Per-leaf or per-branch flutter, skeletons, physics, and player-interaction
  bending. The tree bends as one curve or not at all.
- Billboard LODs. There are none today, so there is no LOD transition to
  match.
- Streaming the shore field over the wire. It is derived on the client from the
  per-cell materials the chunk already carries, so the protocol, the map
  document and `maps/arena.json` are all untouched.
- Wind on bushes, fences and rocks. Trees only.
