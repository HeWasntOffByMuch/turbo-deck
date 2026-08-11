# 123 — Smoke is a solid

## Problem

The fire and smoke that landed with spec 121 read as "particles" rather than as
fire and smoke, and the reference images say why in one line: they are made of
flat camera-facing quads, and what the look wants is **volume**.

- **Smoke and poison clouds** should be overlapping semi-transparent 3D masses
  that intersect each other and read as one churning body. A billboard cannot
  intersect anything; two of them just stack up as two decals.
- **Fire** should be **stacked solid tongues with a clear silhouette** and a hot
  core — shapes, not soft additive haze. A dithered flipbook has no silhouette to
  read at all.

Both want the same missing thing. `RenderMode.mesh` exists in the format and is a
**stub**: `modeCode` maps it to `0`, the billboard, so every effect that asked
for a mesh silently got a quad. That is the whole gap.

Sparks stay exactly as they are. They are a chip of light, a quad is the right
answer for one, and they are the effect this direction is *not* about.

## Shape

**Pure** (`src/render/iso3d/vfx/meshes.ts`), tested in Node — geometry as
arrays, no three.js:

```ts
interface MeshData {
  readonly positions: Float32Array;   // xyz per vertex
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}
/** A lumpy low-poly sphere. One shared geometry; variety comes from orientation. */
function blobMesh(subdivisions: number, lumpiness: number, seed: number): MeshData;
/** A flame tongue: round at the base, pinched, tapering to a point. */
function tongueMesh(radialSegments: number, rings: number, seed: number): MeshData;

type MeshShape = 'blob' | 'tongue';
```

**Format**: `Emitter.mesh?: { shape: MeshShape }`. The batch key gains the shape,
so one draw call per (shape, blend).

**three.js** (`batches.ts`): a `MeshParticleBatch` — an `InstancedBufferGeometry`
over the generated mesh with per-instance offset, size, rotation, colour, alpha
and seed. The vertex shader orients each instance (a fixed tumble hashed from its
seed, so a hundred blobs are not one blob repeated) and applies a cheap lambert
term against a fixed light, which is what makes a blob read as round rather than
as a flat silhouette.

**Sorting**: alpha-blended mesh batches are drawn back-to-front. Insertion sort
over a preallocated index array — the order is nearly sorted frame to frame, so
it costs about O(n), and it allocates nothing.

**The families, re-authored**: `puff` emits blobs; `fire` becomes a stack of
tongues plus a solid core, with the smoke column also blobs. Tint still carries.

## Invariants tested

- **The geometry is closed and sane**: every index is in range, no degenerate
  triangles, normals are unit length, and the blob's radius stays inside its
  lumpiness bound.
- **Deterministic**: the same seed gives byte-identical geometry.
- **The tongue points up**: its highest vertex is on the axis and its base is
  the widest ring, so a flame has a tip rather than a bulge.
- **`mesh` is no longer a stub**: `modeCode` maps it to its own code, and a
  registry containing a mesh emitter produces a mesh batch rather than folding
  into the quad batch.
- **Batch keys separate shapes**: blobs and tongues never share a draw call, and
  the whole registry still compiles to a handful.
- **Every mesh emitter names a shape**, asserted across the library, since an
  emitter that asks for `mesh` and gives no shape is the stub failure again.
- **Sorting is a permutation**: every live particle appears exactly once, and the
  result is ordered by view depth.

## Out of scope

- Auras. The reference for those (a runed circle with light shafts) is a
  different piece of work and nobody asked for it yet; it is noted in
  `docs/vfx-plan.md` and not built.
- Sparks, blood, decals and the hit vocabulary — unchanged.
- Real volumetric rendering. These are intersecting solids, which is what the
  references actually show; a raymarched volume is a different renderer.
