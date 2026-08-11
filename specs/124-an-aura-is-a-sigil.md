# 124 — An aura is a sigil, not a spray

## Problem

The status auras from spec 121 are a dithered ring stamped twelve times a second
with a few motes orbiting it. Reviewed against the reference, the verdict was that
the particle look is not usable. The reference is a **runed magic circle**: a
crisp ground sigil with an outer band, an inner band, rune marks between them,
shafts of light standing on the ring, and a few diamonds floating above it.

Three separate things are wrong with what is there:

- **A stipple is not a line.** `dither-cutout` on a ground quad dissolves the
  ring's edge into the frame's weave. That is the right treatment for a smoke
  halo and the wrong one for a drawn symbol, which wants the ink-line definition
  the rest of the art direction asks for.
- **The ring is a *stream*.** It is re-stamped on a `rate` emitter because size
  is a curve over a particle's own life and that was the only way to make it
  pulse. Two stamps are alive at once at slightly different radii, which is
  survivable for a stipple and reads as a doubled line for a solid.
- **There is no sigil.** A featureless annulus has nothing to read. Runes, shafts
  and diamonds are what make it look authored rather than emitted.

Spec 123 already built the thing this needs: instanced solids with their own
draw call. An aura is the case that wants them most, because everything in it is
a *shape* rather than a haze.

## Shape

**Three more generated meshes** (`vfx/meshes.ts`, pure, tested in Node):

```ts
type MeshShape = 'blob' | 'tongue' | 'rune-ring' | 'diamond' | 'shaft';

/** A flat sigil in the XZ plane: outer band, inner band, rune marks between. */
function runeRingMesh(runes: number, thin: boolean): MeshData;
/** An octahedron, a little taller than wide. The floating motes. */
function diamondMesh(): MeshData;
/** A tapering spike standing on +Y. A shaft of light. */
function shaftMesh(sides: number): MeshData;
```

**Orientation becomes a property of the shape, not a boolean.** The mesh batch
has `uUpright`, which picks between a free tumble and yaw-only. A sigil needs a
third answer: *exactly* the rotation it was given, with no per-seed jitter, or
the ring's runes sit at a random angle. `uOrient` replaces it — 0 tumble,
1 yaw plus a seed jitter, 2 yaw exactly.

**An aura is held, not stamped.** The ring becomes a single particle with a very
long life, constant size and constant alpha, spun by `angularVelocity` rather
than by a rotation curve (a rotation curve is sampled from life fraction and
would over-write the spin every tick). The pulse goes away with the stamping: a
drawn sigil that breathes is a particle affectation, and what the two auras that
used it needed — *do not miss this* — is better said with more shafts and a
brighter ring.

**`EffectDefinition.hardStop`.** A held particle that outlives its own effect is
a ten-minute ghost. `stop(handle)` currently lets particles finish, which is
right for a fire trail and wrong for a thing that is *shown* rather than
*thrown*. Auras set it, and `stop` kills their particles at once regardless of
the caller's flag.

## Invariants tested

- **The sigil is flat**: every vertex of `runeRingMesh` is at y = 0, and its
  normals all point +Y, because anything else is a ring that catches light from
  the side and stops reading as ink on the ground.
- **The sigil has bands and marks**: geometry exists in the outer band, in the
  inner band, and in the gap between them, and the rune marks are `runes` in
  number and evenly spaced.
- **The rings still separate**: the existing radii and `ringsSeparated` are
  unchanged, so two statuses at once are still two readable rings.
- **The ring is held, not stamped**: burst of one, life longer than any fight,
  constant size and alpha, spin from `angularVelocity` and no rotation curve.
- **Auras stop hard**: `hardStop` is set on every aura, and stopping one leaves
  no particles behind on the next tick.
- **Orientation is exact for the sigil**: `uOrient` is 2 for `rune-ring`, so two
  auras on one unit do not have their runes at two random angles.
- Plus the spec-123 geometry invariants for the three new shapes: closed, in
  range, no degenerate triangles, unit normals, deterministic.

## Out of scope

- Nothing still drives auras. Statuses are not replicated (see
  `docs/vfx-plan.md` §5e), so this is reachable from the Studio tab and from
  `AuraTracker` and from nowhere else. That is unchanged by this spec.
- Fire, smoke, sparks, blood and decals.
- Light shafts as real volumetrics. These are additive solids that taper, which
  is what the reference actually shows.
