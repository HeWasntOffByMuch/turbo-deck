# 259 — Water in the same light

## Problem

The sea is the one surface in the frame that is not lit.

`water-material.ts` is a bespoke `ShaderMaterial` that computes four palette
colours and writes them straight out — `gl_FragColor = vec4(col, 1.0)`, with no
light uniform anywhere in the shader. Everything around it is a
`MeshLambertMaterial` lit by the key and ambient the day/night ramp drives
(`scene.ts`'s `applyCycleSun`). So the ground follows the clock and the water
sits on a permanent noon.

Measured through the real `skyAt()` ramp, against the irradiance a flat,
up-facing surface receives — which is exactly what the water quad is,
everywhere, always:

| hour | vs the default frame (r/g/b) |
|---|---|
| 12:00 | 1.227 1.210 1.185 |
| 18:00 | 0.192 0.170 0.334 |
| 00:00 | 0.055 0.086 0.185 |

At midnight the ground is drawn at a twelfth of its daytime light and the water
at full. It misses the night's colour as well as its level: the ratio is more
than three times higher in blue than in red, and none of that reaches the sea.

The second half is not about the clock at all. Unlit means unlit by *point*
lights too, so the fixture pool spec 250 built — the campfires and lamps that
pool light on the ground — throws nothing onto water standing beside it.

## Shape

The water becomes a lit material like everything else: a `MeshLambertMaterial`
with an `onBeforeCompile` patch that writes the bands into `diffuseColor`, in
the register `patchTerrainStreak`, `patchTerrainDetail` and `patchTerrainLiving`
already use on the ground.

```ts
/** The GLSL the patch injects, with every art-direction constant substituted. */
export function waterFragmentChunk(): string;

/** Is this mesh one of ours? Backed by the same table the dispose path reads. */
export function isWaterQuad(mesh: THREE.Object3D): boolean;

/** Unchanged. */
export function buildWaterQuad(opt: WaterQuadOptions): THREE.Mesh;
export function disposeWaterQuad(mesh: THREE.Mesh): void;
```

That is the whole point of the change rather than a detail of it: after it there
is **one description of how bright it is right now**, and the water cannot drift
from the ground again, because neither of them is deciding.

### The palette becomes an albedo

The four hexes in `WATER` were authored as *lit output* under the fixed daylight
— they are what the sea looks like in the frame spec 074 tuned it in. Handing
them to a lighting model unchanged would multiply them by the irradiance a
second time. So they are divided by the light they were authored under, once, at
module load:

```
scale = PI / ( ambient·intensity + key·intensity·dotNL )
```

`PI` because three's `BRDF_Lambert` is `RECIPROCAL_PI * diffuseColor`; the
irradiance in linear working space, because that is where three does the
arithmetic and where `new THREE.Color(hex)` has already put the palette.

The reference is **`DEFAULT_LIGHT_OFFSET` under `FIXED_DAYLIGHT`** — the frame
the game opens on, since the cycle ships off — and not the ramp's noon. Its
elevation is 41.995°, so `dotNL` is 0.669065 and `shadowFillBoost` contributes
nothing. It is *derived* from those two modules rather than written down as a
literal, so retuning the fixed daylight moves the reference with it and "the
palette is what the sea looks like in the default frame" stays true by
construction.

### One program, one palette, one clock

Each chunk keeps its own material because each chunk has its own shore texture,
and `customProgramCacheKey` returns `'water'` for all of them so there is still
one compiled program behind the lot. The wind uniforms and the palette are
assigned into `shader.uniforms` by reference, exactly as they are today, so the
"a second source of truth cannot be introduced by writing to the wrong one"
property survives the move.

The patch **assigns** `onBeforeCompile` rather than composing onto a previous
one, unlike the four ground patches. That is safe only because this material is
built here and carries no other patch; the ground's rule holds the moment a
second one is added.

`material.uniforms` is gone with the `ShaderMaterial`, and the shore texture has
to outlive it for the dispose path, so a module-level `WeakMap` keyed by mesh
holds it. `isWaterQuad` reads the same table, which is what stops "is this one
of ours" being answered twice — `terrain-mesh.test.ts` currently answers it with
`instanceof THREE.ShaderMaterial`, which this change would silently break.

## Invariants tested

- Every authored `WATER` colour, taken through the albedo scale and lit by the
  reference frame's own irradiance, comes back **exactly** the colour it was
  authored as. The default frame does not move.
- The scale is derived: it tracks `FIXED_DAYLIGHT` rather than a literal.
- The injected GLSL leaves no identifier undeclared, substitutes every use of a
  constant rather than the first, and declares the wind chunk it was handed —
  the existing checks, against the chunk instead of a whole shader.
- It bands with `step` and never `smoothstep`, and reads nothing view-dependent.
- It writes `diffuseColor`, and does so *after* `<color_fragment>`, so three
  lights what the bands produced.
- One shore texture per chunk; one shared clock, palette and compiled program
  across chunks.
- A disposed quad frees its own shore texture, and `isWaterQuad` stops answering
  for it.
- Water still neither casts nor receives the sun's shade.

## Out of scope

- **The retro pass.** At a twentieth of the daytime light the four bands
  compress against the quantizer's twelve steps per channel and the coastline
  read may flatten at night. Deliberately not addressed here: this spec is about
  the sea being in the same light as the land, and a `WATER.lightResponse` knob
  or a night palette key is a look decision with its own pass.
- **A night probe.** Nothing in `scripts/` drives the Play tab's clock —
  `preview-fixtures.ts` fakes night in its own rasteriser — so there is no
  browser check of this at a night hour yet. It wants driving the Time slider
  the way `probe-vfx-settings.ts` drives panels.
- The look itself. No band edge, wobble, foam, isoline or streak constant moves.
