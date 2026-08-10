# 118 — A particle is a row in an array

## Problem

Two effects exist and both allocate per spawn: `Poofs` (`rigs.ts`) builds a
`Group` and three materials on every footfall and disposes them on death, and
`WorldScene.addEffect` builds a `CircleGeometry` and a material on every blast.
Neither is configurable, both are one hardcoded look, and adding a third means
writing a fourth class. Meanwhile `EffectMessage` has carried an `effectId`
string since spec 062 and the renderer throws it away.

This spec is the core the rest of the VFX arc is authored on: a particle system
where an effect is **data in a registry**, a particle is a row in a typed array,
and the update loop allocates nothing. It covers the simulation and the registry;
the effect library that uses it is spec 119 onward, and the authoring tab is its
own spec after that.

The constraint that shapes the whole thing is the resolution. The frame is at
most 760x300 (`view-frame.ts`), so the system needs few large crisp particles
rather than many small soft ones — which is what makes a CPU simulation over flat
arrays the right answer, and what makes it testable in Node.

## Shape

Two halves, split the way the rest of `src/render/` already splits.

**Pure** (`src/render/iso3d/vfx/`, linted as part of `PURE_RENDER`, tested in Node):

```ts
// rng.ts — mutable, non-allocating. NOT the sim's Rng, which returns a new
// instance per draw and therefore cannot be used in this loop at all.
class VfxRng {
  constructor(seed: number);
  reset(seed: number): void;
  float(): number;              // [0, 1)
  range(min: number, max: number): number;
}

// curve.ts — piecewise-linear over normalized life, compiled to flat arrays.
interface Curve { readonly keys: readonly (readonly [number, number])[] }
interface Gradient { readonly stops: readonly (readonly [number, PaletteKey])[] }
function compileCurve(c: Curve): Float32Array;      // [t0,v0, t1,v1, ...]
function sampleCurve(flat: Float32Array, t: number): number;
function compileGradient(g: Gradient): Float32Array; // [t,r,g,b, ...]
function sampleGradient(flat: Float32Array, t: number, out: Float32Array, at: number): void;

// types.ts — EffectDefinition / Emitter, as in docs/vfx-plan.md section 2.
// compile.ts — freeze a definition into flat arrays, once, at module load.
// shapes.ts — sampleShape(shape, rng, out, at): the emission volumes.
// noise.ts — deterministic value noise for turbulence. No tables fetched.
// pool.ts — the SoA particle store: one Float32Array per field, an Int32Array
//           free list, swap-with-last removal. Fixed capacity, never grows.
// system.ts — VfxSystem: play/stop/update/budget/priority/LOD/time scale.
```

```ts
class VfxSystem {
  constructor(opts: {
    capacity: number;
    registry: CompiledRegistry;
    ground: (x: number, z: number) => number;   // injected; no terrain import
    limits: VfxLimits;
  });

  play(id: string, opts: PlayOptions): number;  // returns an instance handle, 0 = refused
  stop(handle: number, hard?: boolean): void;   // soft = stop emitting, let live particles finish
  update(ticks: number): void;                  // whole 60Hz steps, never wall time
  setIntensity(intensity: 0 | 1 | 2 | 3): void;
  setTimeScale(scale: number): void;
  setPaused(paused: boolean): void;
  readonly stats: VfxStats;                     // live particles, instances, culled, dropped
}

interface PlayOptions {
  x: number; y: number; z: number;
  rotation?: number;
  attach?: AttachSpec;
  tint?: PaletteKey;
  scale?: number;
  seed: number;                                  // required: the look is a function of it
}
```

**three.js** (`vfx/batches.ts`, `vfx/textures.ts`, `vfx/layer.ts`): one
`InstancedMesh`-style batch per (blend mode, render mode family), per-instance
attributes uploaded from the pool's arrays, billboarding done in the vertex
shader. Materials are `transparent: true, depthWrite: false`, which is also what
keeps them out of the outline buffers (`hike-buffers.ts:358`).

Nothing is added to the render pass chain. The layer's root is an `Object3D` in
`WorldScene.scene`, so it is inside the low-resolution target by construction.

## Invariants tested

Headlessly, in Node, with no GL context:

- **Seed reproduces the look.** Two systems built with the same registry, played
  with the same id, options and seed, and advanced the same number of ticks, hold
  bit-identical particle arrays. Asserted field by field, not by sampling.
- **Ticks, not wall time.** Advancing 60 ticks in one `update(60)` call and in 60
  `update(1)` calls yields identical state.
- **The update loop allocates nothing.** Heap growth across 10,000 ticks of a
  saturated system stays under a per-tick threshold that a single per-particle
  object would blow through by two orders of magnitude.
- **Capacity is never exceeded.** Emitting past the pool's capacity refuses new
  particles rather than growing an array; the pool's free list stays consistent
  after arbitrary interleaved spawn/kill sequences.
- **Degradation order.** Over budget, priority 0 is refused before 1 before 2,
  and priority 3 is never refused while capacity remains. A refused `play`
  returns 0 and spawns nothing.
- **Curves and gradients are clamped, not extrapolated.** `t` outside the key
  range returns the end value; an empty curve returns a documented default; keys
  are read in order regardless of how they were authored.
- **Shapes stay inside their volume.** Every sampled point from a sphere, cone,
  box, circle or arc lies within that shape's bounds, over many seeds.
- **Collision conserves the contract.** A particle with `restitution: 0` and a
  ground under it comes to rest on the ground and does not sink; `maxBounces` is
  honoured exactly; `onCollide` fires once per bounce, never per tick.
- **Sub-emitter depth is capped at 2.** A definition that names itself as its own
  sub-effect terminates rather than recursing.
- **Time scale and pause.** `setPaused(true)` freezes state exactly;
  `setTimeScale(0.5)` over 2N ticks matches `1.0` over N ticks for a linear
  emitter.
- **Gameplay is untouched.** A sibling of `presentation-only.test.ts`: the same
  seed and inputs, once with the VFX system driven and once with it absent, and
  the authoritative state must be identical.

## Out of scope

- The effect library. Sparks land in spec 119 with the low-resolution
  verification probe and the glow comparison; fire, blood, auras, smoke and the
  remaining hit effects follow it.
- Decals of any kind, including the per-chunk blood buckets. They are their own
  spec, because the chunk lifetime question is (`docs/vfx-plan.md` section 3c) a
  design problem rather than a rendering one.
- The Studio VFX tab.
- Audio. The sound hook is a typed sink with no implementation behind it, because
  there is no audio system to wire it to (`music.ts` is note data with no player).
- Any protocol change. Damage type is derived client-side from the ability table,
  the way `ProjectileLook` already is.
