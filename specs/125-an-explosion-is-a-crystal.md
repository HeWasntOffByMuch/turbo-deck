# 125 — An explosion is a crystal

## Problem

The hit vocabulary from spec 121 is a dithered halo with a hard core in it. It
was the right answer for "something landed" at three ticks, and the reference for
impacts says it is the wrong answer for *what* landed: a burst should be a
**crystal** — a bright faceted star at the middle and a fan of long tapered spikes
radiating out of it, with rocks thrown clear and dust at the base.

Everything in that description is a solid, and specs 123 and 124 built the
machinery for solids. One thing is missing, and it is the thing that makes a
burst read as a burst: **a spike must point the way it is travelling.** The quad
batch has velocity alignment (`stretched`); the mesh batch has tumble, upright
and exact, and none of those can aim a shard outward from a centre.

Hits have a second, unrelated fault the same work can fix: they play at the
target's own position, which is inside the target. A blow lands on the *face* the
attacker is on.

## Shape

**Three more generated meshes** (`vfx/meshes.ts`, pure, tested in Node):

```ts
type MeshShape = … | 'shard' | 'starburst' | 'chunk';

/** A tapered spike: a short back pyramid, a waist, and a long point at +Y. */
function shardMesh(sides: number, back: number, waist: number): MeshData;
/** The core: spikes fused into a ball, on a Fibonacci lattice. */
function starburstMesh(spikes: number, seed: number): MeshData;
/** An angular rock: an icosahedron pushed about hard, twenty faces, no subdivision. */
function chunkMesh(seed: number): MeshData;
```

**A fourth orientation**: `ORIENT.velocity`. The mesh batch gains `iVelocity` and
builds a basis whose +Y is the direction of travel, plus a per-seed roll about
that axis so a fan of shards does not show the same facet twice. Direction rather
than speed, because a spike is thrown hard and stopped by drag within a few ticks
and must not swing round as it slows.

**A `burst()` builder** in `library.ts`, parameterized the way `fire`, `puff` and
`aura` are, so every impact in the game is one call with different numbers:

```ts
burst({ id, scale, hot, warm, cool, spikes?, chunks?, spread?, flat?,
        dust?, glow?, light?, priority?, durationTicks? })
```

Layers: the starburst core, the spike fan, a few detached shards that fly on and
fall, rocks that bounce, dust at the base, and a warm pool on the ground.

**The library, re-authored**: `explosion_large`, `explosion_small`,
`explosion_directed` (a jet rather than a ball) and `explosion_ground` (flat,
along the floor) are new; every `hit_<type>`, `impact_flash`, `hit_critical` and
`impact_physical` becomes a small burst in its own damage-type colours. **The ids
do not change**, so nothing at any call site changes — that is the acceptance
criterion the whole arc is built on.

**Contact point** (`world/vfx-wire.ts`): a blow plays on the target's surface
facing the attacker rather than at its centre, and a little above the ground.

## Invariants tested

- **The shard points at +Y**: its far tip is on the axis, its widest ring is
  near the base, and nothing reaches past `y = 1`, so `size` is reach.
- **The starburst is spiky**: its farthest vertices are several times its
  nearest, and the spikes are spread over the sphere rather than bunched — no
  two within a small angle of each other.
- **The chunk is angular**: twenty faces, and its radius varies by much more
  than a blob's, because a smooth rock is a pebble.
- Plus the spec-123 geometry invariants for all three: closed, in range, no
  degenerate triangles, unit normals, deterministic in the seed.
- **Velocity orientation is a shape's property**, `orientOf('shard')`, and the
  mesh batch uploads `iVelocity` only where it is used.
- **Every burst names its shapes**, so a spike emitter that forgot `mesh` is
  caught the way spec 123's stub was.
- **The blow lands outside the body**: `effectsForBlow` places its requests
  toward the attacker by about a body radius, and falls back to the target's own
  position only when the two are stacked.
- **Ids are unchanged**: every id `DAMAGE_EFFECTS` and `DAMAGE_DEBRIS` name still
  resolves, and the existing per-effect table tests still pass.

## Out of scope

- Scorch decals. Blood owns the decal field (spec 120) and a burn mark wants its
  own splat profile; the burst leaves a fading warm pool instead, and the decal
  is noted in `docs/vfx-plan.md` rather than built.
- Screen shake, and anything else that is not a particle.
- Auras, fire, smoke, blood — unchanged.
