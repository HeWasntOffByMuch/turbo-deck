# 139 — Blood takes the light, and a streak bends

## Problem

Two complaints against the blood, both from looking at it in the Play tab, and
`death_blood` shows each of them worst because it is the loud one.

**A stain on the ground ignores every shadow it lies in.** `DecalView` draws with
a raw `ShaderMaterial` whose fragment shader ends `gl_FragColor = vec4(vTint, 1.0)`
(`decal-view.ts`). That is a constant. The ground under it is a
`MeshLambertMaterial` that takes the sun, the ambient, the day/night ramp and the
shadow map, so a decal in the shadow of a cliff is drawn at full daylight tint on
top of ground that is not — and the brighter the shadow, the more it reads as a
sticker laid over the world rather than a mark on it. It is not a shadow *bias*
problem or a z-fight; the material was never in the lit pipeline at all.

**Blood in flight is a straight pipe.** Every blood emitter renders `stretched`,
which is one camera-facing quad aligned to the particle's *instantaneous*
velocity, of length `size * (1 + screenSpeed * stretch)`. For `death_blood/spray`
that is `4 * (1 + 340 * 0.05)` ≈ 72 world units of rigid, constant-width rectangle
— longer than a player is tall, straight, hard-ended at both ends, and at full
length on the very first tick of its life. A drop of blood is a comet: it starts
short, it is drawn out by its own travel, it is *bent* by gravity, and it thins
towards its tail.

The mode that draws that already exists in the format and has never drawn
anything. `RENDER.ribbon` compiles, `familyOf` gives it a batch of its own, the
sim claims a trail track per particle and pushes distance-gated samples into it
every tick (`pool.ts`, `system.ts`) — and then `modeCode` falls through its
`default` and returns `0`, the billboard. This is precisely the failure spec 123
found in `RenderMode.mesh`: a value accepted, stored, compiled and quietly
ignored one layer below, with the whole round trip green.

## Shape

**Pure** (`src/render/iso3d/vfx/ribbon.ts`), tested in Node:

```ts
/** Floats per segment written by `ribbonSegments`: from, to, widthFrom, widthTo. */
export const SEGMENT_STRIDE = 8;

/**
 * Chain one ribbon particle's trail into segments, oldest first, tapering.
 * Returns how many segments were written into `out`.
 */
export function ribbonSegments(
  samples: Float32Array, base: number, held: number,
  headX: number, headY: number, headZ: number,
  width: number, taper: number,
  out: Float32Array,
): number;

/** The one-segment fallback for a particle that never got a trail track. */
export function fallbackSegment(
  x, y, z, vx, vy, vz, width, taper, out: Float32Array,
): number;
```

**The draw** (`batches.ts`): one new `iMode` branch, `4`, and no new attribute.
A segment instance re-uses the existing row — `iOffset` is the segment's start,
`iVelocity` is the segment *vector* rather than a velocity, `iSize` is the width
at the start and `iStretch` the width at the end. Length comes from the vector's
own screen-space length, so a segment pointing at the camera foreshortens for the
same reason a stretched spark does. `ParticleBatch.writeSegment(at, …)` writes one.

**The authored knob** (`types.ts`, `compile.ts`, the Studio field table):

```ts
/** Width at the tail as a fraction of the head, for `ribbon`. Default 0.15. */
readonly ribbonTaper?: number;
```

**The stain** (`decals.ts`, `decal-view.ts`): a pure `decalGridNormals` beside
`decalGrid`, and a `MeshLambertMaterial` patched through `onBeforeCompile` in the
style `patchTerrainCurvature` established — the atlas coverage and the ordered
fade become discards spliced in ahead of the lighting, and the per-vertex tint
replaces `diffuseColor`. `transparent: true` and `depthWrite: false` are kept
exactly as they are, because that pair is what holds decals out of `HikeBuffers`
and therefore out of the ink.

## Invariants tested

- `ribbonSegments` returns `held` segments for a trail of `held` samples (the
  chain plus the head), and their ends meet exactly: segment *n*'s `to` is
  segment *n+1*'s `from`.
- Width falls monotonically from head to tail and reaches `width * taper` at the
  oldest sample, never zero and never negative.
- A ballistic trail comes back **bent**: the middle sample is off the straight
  line between the ends by a distance the arithmetic can state, so a straight
  chain fails.
- An empty or single-sample trail yields the fallback segment, aligned to
  velocity — so a particle that lost the race for a track still draws.
- `modeCode(RENDER.ribbon)` is 4, not 0. (The stub, asserted against.)
- Every blood emitter that renders `ribbon` is in a batch of its own family, and
  the whole registry still compiles, emits and plays for a hundred ticks.
- `decalGridNormals` gives a flat patch `+Y` and tilts on a slope, in the
  direction of the slope, with unit length everywhere.
- The decal material receives shadows: measured in a browser by
  `scripts/preview-blood.ts`, which lights a real scene with a real shadow map,
  puts identical stains inside and outside a cast shadow, and asserts the ones
  inside are darker. The old flat material fails it.

## Out of scope

- Blood on *units*. `docs/vfx-plan.md` §5d recommends the hybrid and it needs a
  change to the unit shader; nothing here touches it.
- Every other `stretched` emitter. A spark is a chip of light travelling in a
  straight line over its own short life, and it reads correctly; only the fluids
  become ribbons.
- Lighting the *particles*. A droplet in the air is 3 pixels; it takes the
  gradient it is authored with, as before.
- The decal atlas, the splat generator, the chunk field and the gore setting, all
  unchanged.
