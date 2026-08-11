# 120 — A decal belongs to a chunk

## Problem

Spec 119 makes splats. Nothing puts them on the ground, and the obvious way to
do it leaks forever.

The plan's finding (`docs/vfx-plan.md` §3c) is that **the client never evicts a
map chunk**: `StreamedMap.add` inserts and nothing removes. So a decal field that
frees its decals "when the chunk streams out" is hung off an event that is never
fired — it reviews as correct and grows without bound in play. The lifetime has
to be owned here, with the chunk-eviction path written and left unconnected until
there is something to connect it to.

Two other things a naive decal gets wrong in this renderer specifically. It
z-fights the terrain, because the ground is a heightfield and a flat quad laid on
it intersects it. And it acquires an ink outline, because the outline pass runs
over anything that writes depth — a bloodstain is not a form.

## Shape

**Pure** (`src/render/iso3d/vfx/decals.ts`), tested in Node:

```ts
/** Where a decal is, what it looks like, and how long it has been there. */
interface Decal {
  x: number; y: number; z: number;   // world; y is the surface it sits on
  size: number;
  rotation: number;                   // about the surface normal
  nx: number; ny: number; nz: number; // the surface it was laid on
  seed: number;                       // which splat, via generateSplat
  fluid: FluidKind;
  age: number;                        // ticks
  fadeFrom: number;                   // tick at which it starts fading, or -1
}

class DecalField {
  constructor(opts: { perChunk: number; total: number; chunkSize: number; fadeTicks: number });

  /** Returns false when the decal was refused. */
  add(decal: DecalInput): boolean;
  update(ticks: number): void;
  /** Called when a chunk goes away. Nothing calls it yet -- see the problem. */
  dropChunk(cx: number, cz: number): void;
  /** Buckets whose contents changed since the last call, so a view rebuilds few. */
  takeDirty(): readonly ChunkKey[];
  bucket(cx: number, cz: number): readonly Decal[];
  readonly count: number;
}
```

Plus the two projections, both pure:

```ts
/** Height samples across a decal's footprint, so it follows the heightfield. */
function decalGrid(decal: Decal, resolution: number, ground: (x, z) => number): Float32Array;

/** Box projection onto a surface, rejecting faces that face too far away. */
function acceptsProjection(nx, ny, nz, dirX, dirY, dirZ, maxAngle): boolean;
```

**three.js** (`decal-view.ts`): one merged geometry per bucket, rebuilt only when
that bucket is dirty — the region-invalidation pattern `props.ts` already uses for
the prop field (spec 086). `depthWrite: false` and `polygonOffset`, which is also
what keeps decals out of `HikeBuffers` and therefore un-inked.

**The system hook**: an emitter's `collision` gains `decal`, and `VfxHooks` gains
`decal(x, y, z, seed, fluid, dirX, dirZ)`. Blood particles that hit the ground
leave a stain at the contact point; the sim stays pure because the hook is
injected.

**The gore setting**: `setGore(0..2)`. At `0` the field refuses everything and the
view holds no geometry — the work is not done, not merely hidden.

## Invariants tested

- **Per-chunk cap.** A bucket never exceeds `perChunk`; over it, the *oldest*
  decal begins fading and is removed when the fade completes. It fades rather
  than popping.
- **Global cap.** Over `total`, whole buckets are evicted furthest-from-the-
  viewpoint first, never the nearest.
- **Bucketing is by world position** and agrees with the terrain's own chunk size
  (28 cells × 22 units = 616), so a decal and the ground under it belong to the
  same chunk.
- **`dropChunk` frees exactly one bucket** and leaves its neighbours alone.
- **Dirty tracking is minimal**: adding one decal marks one bucket, and
  `takeDirty` reports each bucket at most once and clears.
- **Fitting follows the heightfield.** Every grid sample sits on the ground the
  sampler reports, so a decal on a slope does not float at one end or sink at the
  other. Asserted against a real slope and a real ridge.
- **Normal rejection.** A face turned more than `maxAngle` from the projection
  direction is refused, so blood does not wrap onto the underside of a rock.
- **Gore off is off.** At 0, `add` refuses, `count` stays zero, and no bucket is
  ever marked dirty — nothing to rebuild, nothing to draw.
- **Determinism.** The same seeds and the same sequence of adds produce an
  identical field.
- **Presentation only.** The sibling of `presentation-only.test.ts`: same seed
  and inputs with the decal field driven and absent, identical authoritative
  state.

## Out of scope

- **Unit staining.** The two candidate approaches are evaluated and one is
  recommended in `docs/vfx-plan.md` §5d, and neither is implemented here: it
  needs a per-unit render target and a change to the unit shader, which is a
  bigger surface than the ground and the props put together and deserves its own
  spec rather than a corner of this one.
- Fire, smoke, auras and the remaining hit effects.
- The Studio VFX tab.
