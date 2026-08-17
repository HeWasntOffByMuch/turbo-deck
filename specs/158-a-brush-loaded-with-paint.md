# 158 — A brush loaded with paint

## Problem

Every effect in this library is built out of **solids seen from every side**: the
flame is a lathe, the impact is a faceted crystal, the smoke is a lumpy sphere,
the debris is an icosahedron pushed about. Spec 123 chose that on purpose, and
the reason it gives is still right — a billboard cannot intersect anything, and
overlapping solids are what make a dozen particles read as one churning mass.

It is also the *only* thing this library can say. The shape vocabulary is nine
convex lumps, and a convex lump lit from one side is a lump whatever else you
were hoping it would be. Ask for a painterly game and the answer comes back as
circles, and there is nowhere in the format to write down "a mark somebody made
with a brush" — an asymmetric, tapering, slightly bent, unevenly wide silhouette
with a frayed end. `meshes.ts` says so itself: "a hundred distinct lumpy spheres
would be a hundred draw calls, and at this resolution nobody can tell them from
one sphere seen from a hundred angles."

That last clause is exactly what stops being true for a brush stroke. A stroke's
whole identity *is* its outline, no two of a handful may look alike, and a batch
of identical ones is the failure mode rather than the optimisation.

Two effects are asked for in that language — a blood hit and an explosion — and
neither can be authored today.

## Shape

### 1. The stroke, as geometry (`vfx/stroke.ts`, pure, tested in Node)

One generator. A stroke is a **spine** with a **width sampled along it**, turned
into a ribbon whose left and right edges carry *independent* noise:

```ts
export interface StrokeSpec {
  readonly seed: number;
  readonly segments: number;     // spine spans; the source of segmented curvature
  readonly width: number;        // peak half-width, as a fraction of length
  readonly profile: 'taper' | 'lens';
  readonly shoulder: number;     // where along the stroke the peak sits
  readonly tipPower: number;     // how hard it tapers to the tip
  readonly curve: number;        // lateral bend over the whole stroke
  readonly kink: number;         // per-node spine jitter: a bend with corners in it
  readonly edgeNoise: number;    // low-frequency, independent per edge
  readonly jagged: number;       // high-frequency, quantized: the ragged edge
  readonly skips: number;        // dry-brush gaps that break the mark in two
  readonly rootCut: number;      // how abruptly the butt starts
}

export function brushStrokeMesh(spec: StrokeSpec): StrokeMeshData;
```

`StrokeMeshData` is `MeshData` plus one extra per-vertex attribute,
`strokeUv: vec4 = (along, signedHalfOffset, sideX, sideY)`, and `position` holds
the **spine point** rather than the finished vertex. That split is the whole
design: it hands the GPU everything it needs to re-derive the outline, so a
second layer of variation can be applied *per instance* without a second
geometry.

Authored along **+Y**, in the local XY plane, origin at the butt — the same
convention `shard` uses, so `ORIENT.velocity` already means "point the way you
went".

### 2. The same stroke, varied per instance (`batches.ts`)

`MeshParticleBatch` already uploads `iSeed`. Under `#define VFX_STROKE` the mesh
vertex shader rebuilds the outline from the baked spine:

```glsl
vec2 local = spine + side * bend(seed) * along * along
                   + side * signedHalfOffset * widthGain(along, seed);
```

so one geometry and one draw call produce strokes that differ in width envelope,
in where they are fattest, in how far they bend, and in where the tip breaks up.
Nothing is rebuilt on the CPU, per frame or per spawn.

### 3. Two orientations that keep a flat mark legible (`meshes.ts`, `batches.ts`)

A stroke is flat, and a flat thing edge-on is nothing. Two new `ORIENT` values,
both building their basis from the camera:

- `card` — the stroke's plane is the screen's, rolled by `iRotation`.
- `cardVelocity` — the same plane, with the stroke's +Y along the **screen
  projection** of its velocity. A mark thrown across the view is drawn across
  the view; one thrown at the camera foreshortens, exactly as `stretched`
  already does for a spark.

This is why the effects read from any camera angle rather than in spite of it.

### 4. A dissolve for solids (`batches.ts`)

`BLEND['dither-cutout']` has been accepted, stored and compiled for mesh
emitters since spec 123 and has never done anything — `uCutout` exists only in
the quad fragment shader. The mesh shader gets the same 4x4 Bayer discard, so a
paint mark breaks up into the frame's own weave instead of smearing translucently
through the mark behind it.

### 5. A direction the ground plane can carry (`shapes.ts`, `types.ts`, `compile.ts`)

`{ kind: 'fan'; angle; radius; rise }`. Every existing directional shape is
either about local +Y (`cone`) or radial in the ground plane (`circle`), so
"thrown away from the attacker, mostly, and a bit upward" cannot be written down
— which is precisely the directional bias a spatter needs. Centred on local +X,
the axis `arc` already established as the one the effect's `rotation` turns.

### 6. The two effects (`vfx/brush.ts`)

Builders, not copies, in the style `fire`, `puff`, `aura` and `burst` set:
`bloodHit(params)` and `brushExplosion(params)`, each returning an
`EffectDefinition`, with presets registered in `registry.ts`.

Blood, four layers: one primary flick along the blow, secondary fragments biased
to it, chunky dabs, and a fine spatter. Explosion, four layers: a very short
white-hot flash of short thick strokes, 8–20 radial tapered strokes, darker
debris that travels further and spins, and smoke as overlapping chunky blots
rather than soft transparent puffs.

### 7. The API

```ts
layer.spawnBloodHit({ x, y, z, normal, incoming, intensity, seed });
layer.spawnBrushExplosion({ x, y, z, radius, intensity, seed });
```

on `VfxLayer`, over pure request builders in `brush.ts` that a test can hold to
account. `effectsForBlow` plays the brush blood for anything that bleeds, so the
effect is spawned by every hit that lands on a valid target and nothing at the
call site changes.

## Invariants tested

- **A stroke is not a rectangle.** Width varies along it by more than a stated
  fraction, its two edges disagree (the left and right half-widths are not each
  other's mirror), and its widest point is not its middle.
- **A stroke tapers.** The last tenth is thinner than the first quarter, for
  every seed in a sweep of fifty.
- **A stroke bends.** The spine's midpoint is off the chord between its ends by a
  distance the arithmetic can state, so a straight chain fails.
- **A stroke is deterministic**: same spec, byte-identical arrays; and one
  changed seed changes the outline.
- Every vertex carries a unit `side`, and `along` runs 0→1 monotonically per
  spine node.
- `skips` actually breaks the mark: at least one interior sample is pinched below
  a threshold the un-skipped stroke never reaches.
- Geometry is bounded: vertex and index counts are a stated function of
  `segments`, and every index is in range.
- `orientOf` returns a card mode for every brush shape, `shadedShape` is false
  for all of them (paint is not lit), and `needsVelocity` is true for exactly the
  velocity-aimed ones. (The stub `RENDER.ribbon` was, asserted against.)
- Both effects compile, emit, name real palette keys and dangle no sub-effect;
  the explosion's radial count sits in 8–20; both finish inside their stated
  windows (blood 0.25–0.8s, explosion 0.7–1.5s at 60Hz).
- `effectsForBlow` plays the brush blood for a bleeding target, and the loud
  variant for a killing blow.
- Nothing allocates per frame: the existing `alloc.test.ts` discipline covers the
  new batches, since they add no per-particle object.
- The picture: `npx tsx scripts/preview-brush-vfx.ts` renders both effects at
  four camera azimuths, at two intensities, with six different seeds each,
  through the game's own `RetroPass` at the game's own virtual resolution.

## Out of scope

- Re-authoring the existing library in this language. `burst`, `fire` and the
  rest stay as they are; this adds a vocabulary rather than replacing one.
- Blood *decals*. The brush hit throws no stain — the ground mark is spec 120's
  splat generator and has its own art direction. `death_blood` still pools.
- Lighting a stroke. Paint is flat colour by decision, not by omission.
- A stroke that is a `ribbon`. Two mechanisms for one look is one too many, and
  the ribbon's shape is the path a particle flew rather than a mark somebody
  made.
