# 230 — A swing you can see

## Problem

Nothing in this game draws a swing. `slash_arc` has been in the library since
spec 121 — an `arc` emitter of stretched sparks, authored, compiled, asserted to
exist — and has never had a caller. Every melee skill in the table is a blood
spatter that appears on a body, with no gesture in front of it: Guard Break,
Stunning Blow, Crippling Strike, Rending Cut and Test Statuses send no effect
message at all, and Whirlwind — *"one turn, all the way round, blade out"* — is
a 160-unit sweep drawn as `scene.addEffect`'s orange debug ring.

The painted vocabulary is the house style for combat (specs 158-161: blood,
explosions, afflictions, shots are all brush marks) and it has no way to say
"a stroke swept along an arc". Two things stop it, and both are in the engine
rather than in the authoring:

**`ORIENT.ground` cannot follow a sweep.** `orientOf` is a pure function of the
mesh shape, and `brush-mark` is hard-wired to ground orientation, whose yaw
comes from the `rotation` *curve* — one curve per emitter, shared by every
particle it spawns. So an `arc` emitter of brush marks lays them along the
curve all pointing the same way: a fence, not a swing.

**And `groundBasis(iRotation)` ignores the instance rotation.** `system.ts`
turns an emitter's `offset` and its spawn *direction* by the effect's rotation
about Y, and never touches `pool.rot`. Positions rotate, yaws do not. Nothing
has caught it because the only ground-oriented effect in the game is
`order_move`, which is a click mark played at rotation 0 — but an aimed swing
is the case that needs it.

## Shape

**One new orientation mode**, which is the whole engine change:

```ts
// vfx/meshes.ts
export const ORIENT = {
  /* … */
  ground: 6,
  /** Flat in the ground plane, yawed by the ground track of its velocity. */
  groundVelocity: 7,
};
```

```glsl
// vfx/batches.ts — reusing groundBasis rather than building a second basis
mat3 groundVelocityBasis(vec3 vel) {
  vec2 flat = vec2(vel.x, vel.z);
  float speed = length(flat);
  vec2 dir = speed > 0.0001 ? flat / speed : vec2(0.0, 1.0);
  // groundBasis' local +Y is (sin, 0, -cos), so this is the yaw that puts it
  // along `dir`. One basis definition, so handedness cannot drift between them.
  return groundBasis(atan2(dir.x, -dir.y));
}
```

`ORIENT.ground`'s own doc says *"a placed mark has no velocity to be aimed by"*,
which is true of a cross somebody clicked and is exactly what a swept mark is
not. Both problems close at once, because the `arc` emitter shape already
writes a **tangent** spawn direction (`shapes.ts`, `SHAPE.arc`) and `system.ts`
already turns that direction by the instance rotation — so the mark follows the
curve *and* the whole arc aims, with nothing else touched.

**One new mesh shape**, `brush-sweep`, carrying `brush-mark`'s geometry — the
centred stroke with no flecks — and this orientation. Centred is right for the
same reason it is right for the cross: a sweep mark is placed *at* a point on a
path rather than thrown from one. A shape rather than a flag on the emitter,
because `orientOf` is how this codebase already decides orientation and a second
mechanism beside it would be two answers to one question.

**One builder**, in the painted vocabulary beside `brushCross`:

```ts
// vfx/brush.ts
export interface BrushArcParams {
  readonly id: string;
  /** How far from the origin the marks are laid. */
  readonly radius: number;
  /** Total angle covered, centred on the effect's own bearing. Radians. */
  readonly sweep: number;
  readonly marks?: number;
  readonly length?: number;
  readonly lifetimeTicks?: number;
  readonly bright?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}
export function brushArc(params: BrushArcParams): EffectDefinition;
```

One `arc` emitter with a `burst`, not one emitter per mark: `SHAPE.arc` reads
the particle's index *within its burst* to place it, so marks laid over several
spawns would restart that index and scramble the order. The gesture still reads
in sequence, because `VFX_STROKE` draws every mark out along its own path
(specs 158-159) and a blade covers its arc in about six ticks regardless.

A small tangential `speed` and **no gravity**: the velocity is what the yaw is
read from, so zero speed would fall back to a fixed bearing, and a vertical
component would be integrated into a `vel.y` the ground basis correctly ignores
while the mark drifted upward out of the ground plane.

**Two callers.**

*Whirlwind* needs no call-site change at all. `landArea` already sends
`skill.whirlwind.impact` at the caster's own feet, before the target loop, so it
fires on a sweep that caught nobody — which is what a swing is. A registry entry
under that id is the whole of it, at `sweep: 2π` and the skill's own radius.

*The melee skills* need a driver, and it does **not** go in `effectsForBlow`.
Two reasons, and the first is the design one: **a swing happens whether or not
it connects**, and `effectsForBlow` runs only on a hit, so a whiffed Rending Cut
would draw nothing while a landed one drew a sweep. The second is budget — that
function is at its `MAX_BLOW_EFFECTS` of three on a bleeding body, and a swing
is not the thing that should evict the element.

So `world/swing-vfx.ts`, in the shape `shot-vfx.ts` and `affliction-vfx.ts`
already share: pure, handed a snapshot rather than a `GameClient`, holding the
diff itself.

```ts
export interface SwingBody {
  readonly entityId: number;
  readonly x: number; readonly y: number; readonly z: number;
  /** Which way the body is pointing, which is what the swing sweeps across. */
  readonly facing: number;
  readonly abilityId: string;
  readonly releaseTick: number;
}
/** Which melee abilities draw a sweep, and how wide. Absent draws none. */
export const SWING_ART: Readonly<Record<string, { effect: string }>>;
export class SwingVfx {
  step(bodies: readonly SwingBody[], tick: number): void;
  forget(entityId: number): void;
}
```

It fires on an **edge** — the release tick crossing — which makes it a *contact*
in `stagger-flinch.ts`'s sense rather than a *state* in `stun-icon.ts`'s: a body
that walks into view mid-swing has no release for this client to have watched,
and inventing one would draw a blade that already fell. It holds no handle,
because a sweep is a one-shot with a duration of its own and there is nothing to
stop.

## Invariants tested

- `groundVelocityBasis` puts a mark's own +Y along the ground track of its
  velocity, and its +Z along world up — asserted as a matrix against
  `groundBasis` at the equivalent yaw, so the two cannot drift apart.
- A zero or purely vertical velocity falls back to a fixed bearing rather than
  producing a NaN basis, which is what a division by a zero-length `flat` gives
  and what would silently delete the mark.
- `orientOf('brush-sweep')` is `ORIENT.groundVelocity`, and every other shape's
  orientation is unchanged — the mapping is asserted whole, so adding a shape
  cannot quietly re-point an existing one.
- `brush-sweep` is a `strokeShape`, so it is unlit and gets the `VFX_STROKE`
  path, like every other mark in the painted vocabulary.
- `brushArc` lays its marks along the arc **in emission order** and within
  `radius` of the origin, at the authored count.
- Its emitters carry no gravity and a non-zero speed, since the yaw is read off
  the velocity — asserted directly, because a later tune that zeroed the speed
  would silently return every mark to one bearing and still look plausible.
- `skill.whirlwind.impact` is in the registry, so `scene.addEffect` takes the
  authored branch rather than the debug ring.
- `SwingVfx` plays once per release and not again while the same cast runs on.
- A body first seen mid-swing draws nothing; the next swing it starts draws.
- `forget` stops a despawned body from drawing a swing it had queued, and a body
  that is forgotten and comes back may swing again.
- Every id in `SWING_ART` exists in the registry, and every ability it names is
  `kind: 'melee'` — a sweep on a projectile would be a blade swung at nothing.

## Out of scope

- **Repainting `slash_arc`.** It stays as it is, still uncalled: it is a
  particle effect and this spec's callers want paint, and deleting it is a
  decision for whoever finds a use for a spark sweep.
- **The remaining `.impact` fallback rings** — Arc Lash, Rime Touch, Blight,
  Ember Toss, Scorched Earth. Specs 231 and 232.
- **Aimed cone and lane pictures.** Acid Spray and Arc Lash need a rotation on
  the effect message, which is spec 231. This spec's aiming works because a
  swing's origin is a body whose facing is already replicated.
- **A trail that follows the weapon mesh.** The arc is authored at a radius, not
  sampled from where the blade actually went; `weapon-rig.ts` parents the weapon
  into the pose graph and nothing samples it per frame on purpose (spec 140).
