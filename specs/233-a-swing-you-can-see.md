# 233 — A swing you can see

## Problem

Nothing in this game draws a swing. `slash_arc` has been in the library since
spec 121 — an `arc` emitter of stretched sparks, authored, compiled, asserted to
exist — and has never had a caller. Every melee skill in the table is a blood
spatter that appears on a body with no gesture in front of it, and Whirlwind —
*"one turn, all the way round, blade out"* — is drawn as `scene.addEffect`'s
orange debug disc, which is what every skill in the table draws.

## The false start, because it decides everything below

The first implementation of this spec invented a `brush-sweep` mesh shape and an
`ORIENT.groundVelocity` to go with it, and laid the marks **flat on the ground**
along an arc. It shipped green: 6975 tests, typecheck and lint clean.

It was wrong in the way that matters. The vocabulary this game paints combat in
is marks **in the air** — `bloodHit` throws `brush-slash` at `cardVelocity`,
`brushExplosion` composes lobes of them, the afflictions cling to a body — and a
flat ring on the floor is the same object as the debug disc it replaced, only in
paint. Whirlwind at a full turn was literally a painted circle on the ground.

Two lessons are worth more than the code:

- **Reason from the effect you are sitting beside, not the nearest builder.** It
  was modelled on `brushCross`, which correctly lies flat because a click marker
  is a mark on the floor. A swing is not.
- **A green suite says nothing about a picture.** This is the one spec in the
  tree whose acceptance is an image, so the image is a deliverable rather than a
  courtesy — `preview-brush-vfx.ts` grows a sheet, and it is looked at before
  anything is pushed.

## Shape

**No engine change at all.** `fan` already throws marks along a bearing and
lifts them out of the ground plane, and its `bearing` field already lets several
fans compose a shape — which is exactly how `brushExplosion` gets its lobes. The
whole feature is one builder in the existing vocabulary.

```ts
// vfx/brush.ts
export interface BrushSwingParams {
  readonly id: string;
  /** How far the blade reaches. The one size knob. */
  readonly reach: number;
  /** Total angle covered, centred on the effect's bearing. Radians. */
  readonly sweep: number;
  readonly lobes?: number;
  readonly lifetimeTicks?: number;
  /** How high off the ground the blade passes. A chest, not a pair of boots. */
  readonly lift?: number;
  readonly bright?: PaletteKey;
  readonly mid?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}
export function brushSwing(params: BrushSwingParams): EffectDefinition;
```

Three decisions in it, each visible on the sheet:

**Lobes, not a spread.** `brushExplosion` states the argument and it holds along
an arc: a single wide fan samples uniformly, so however different the marks are
the silhouette comes out an even star. Every other lobe is a dominant
`brush-slash` and the rest are `brush-flick` company — the first render was
all-flick and read as **petals** rather than as an edge.

**Born out on the arc, not at the body.** Each lobe is `offset` to 72% of the
reach, so the marks are where the blade was rather than streaming out of the
caster's chest. `system.ts` turns an emitter's offset by the effect's rotation,
so the composition aims with nothing else to do — the same mechanism that points
a blood hit away from its attacker.

**The lift belongs to the effect, not the call site.** `offset.y` is
`reach * 0.22`, so a caller plays a swing at ground level and the height a blade
passes at is a property of the definition. Every call site adding its own lift
is how the ground version happened.

**Two callers.**

*Whirlwind* needs no call-site change at all: `landArea` already sends
`skill.whirlwind.impact` at the caster's own feet, **before** the target loop, so
it draws on a turn that caught nobody — which is what a swing is. Registering
the id is the whole of the wiring.

*The melee skills* need a driver, and it does **not** go in `effectsForBlow`.
**A swing happens whether or not it connects**, and that function runs only on a
hit, so a whiffed Rending Cut would draw nothing while a landed one drew a
sweep. It is also already at its `MAX_BLOW_EFFECTS` of three on a bleeding body,
and a sweep is not what should evict the element.

So `world/swing-vfx.ts`, in the shape `shot-vfx.ts` and `affliction-vfx.ts`
share: pure, handed a snapshot rather than a `GameClient`, holding the diff
itself. It fires on the **release-tick edge** — a *contact* in
`stagger-flinch.ts`'s sense rather than a *state* in `stun-icon.ts`'s, because a
body that walks into view mid-swing has no release this client watched. It holds
no handle: a sweep is a one-shot the system retires itself, so the three rules
spec 215 and 218 are built on do not apply and pretending they did would be
bookkeeping guarding nothing.

## Invariants tested

- `brushSwing` composes one emitter per lobe, each thrown along its own bearing,
  and every lobe's marks are a stroke shape.
- Its lobes are lifted out of the ground plane, asserted on the offset — the
  regression that would put the swing back on the floor.
- A full-turn sweep does not stack its last lobe on its first; a partial sweep is
  centred on the effect's own bearing.
- `skill.whirlwind.impact` is in the registry, so `scene.addEffect` takes the
  authored branch rather than the debug ring.
- `SwingVfx` plays once per release and not again while the same cast runs on.
- A body first seen after its release draws nothing more that swing.
- `forget` stops a despawned body drawing, and a forgotten body may swing again.
- Every id in `SWING_ART` exists in the registry, and every ability it names is
  `kind: 'melee'` — a sweep on a projectile is a blade swung at nothing.
- Whirlwind is **absent** from `SWING_ART`, because its own impact message draws
  it and a row there as well would paint the turn twice.

## Out of scope

- **The remaining debug rings.** Ember Toss wants a painted explosion, Arc Lash
  an electric arc, Rime Touch a frost burst, Blight a rot cloud, Scorched Earth
  an ignition. Each is its own authored effect and its own look decision; a
  blanket route of every unregistered `.impact` into `spawnBrushExplosion` would
  draw a fire blast for a frost skill, which is worse than the ring.
- **`slash_arc`.** Left as it is and still uncalled: it is a particle effect and
  these callers want paint. Deleting it is for whoever finds a use for a spark
  sweep.
- **A trail sampled from the weapon mesh.** The sweep is authored at a reach, not
  taken from where the blade actually went; `weapon-rig.ts` parents the weapon
  into the pose graph and nothing samples it per frame on purpose (spec 140).
