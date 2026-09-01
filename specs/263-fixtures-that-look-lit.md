# 263 — Fixtures that look lit

## Problem

Two of the three light fixtures spec 250 built do not read as lights.

**A standing torch is a cone.** Spec 250 took the campfire's static flame out
for a stated reason -- *a fire is the one prop whose subject moves, so a solid
can only ever be a picture of one instant of it* -- and replaced it with paint
(`fire_camp`, played by `world/fire-vfx.ts`). The torch stand kept its
`ConeGeometry(9, 24, 5)`, so the one prop in this game that is *literally* a
burning brand is the one still drawn as a cream traffic cone. `brush.ts` says in
as many words what the fix is: *"a brazier or a lit torch is a second row at a
smaller `scale` and nothing else."*

**A lamp post's mantle is unlit, and unlit by its own lamp.** props.ts argues
that the burning parts "are standing inside their own point light, which is what
actually makes them the brightest thing in the frame". That is exactly backwards
for a point light at the part's own centre: for every outward-facing triangle of
the mantle the vector to the light points *inward*, so `N·L` is negative and the
face takes nothing. The light is hung at `y = 122`; the mantle box spans 110 to
134 about it, so its top face has the lamp below it, its bottom face has the lamp
above it and its four sides have the lamp behind them. **Every face of a lamp's
mantle is lit by ambient alone** -- a grey box at the top of a pole, over a
brightly lit street. The game already knows this: the *carried* torch's core at
`scene.ts:1998` is a `MeshBasicMaterial`, and `palette.ts` says the core tones
are "the unlit meshes at each light's centre". The world fixtures are the one
place that rule was not applied.

## Shape

**A part may emit.**

```ts
interface PropPart {
  /** sRGB hex, three's own `MeshLambertMaterial.emissive`. */
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}
```

Applied in `buildPropField`'s `build()`, where the part is already in hand. It
costs **no new batch and no new draw call**: a batch already makes its own
`MeshLambertMaterial` (spec 181 -- materials are deliberately not shared), and
`emissive` is a uniform on the material this file already builds. That is what
makes this the version of "unlit core" the prop field can afford, where the
`MeshBasicMaterial` the carried torch uses would be a fifth kind of batch.

**What a fixture emits is the colour it lights with.** The lamp's mantle and the
torch's ember core take `FIXTURE_LIGHTS[kind].color` rather than a second hex, so
retuning a lamp's light retunes the thing the light comes out of. The intensity
is under 1 so the sum with ambient stays warm instead of clipping to white.

**A torch burns.** `FIXTURE_ART` stops being `kind -> effect id` and becomes
`kind -> { id, scale, root }`:

```ts
interface FixtureFire {
  readonly id: string;
  /** The fire's width, as a fraction of the fixture's footprint. */
  readonly scale: number;
  /** Where the flame's root sits, as a fraction of the height its light hangs at. */
  readonly root: number;
}
```

`root` is a fraction of `RegionLight.y` (which is already ground + the row's
height, scaled by the prop's own scale) rather than a world number, so a torch
placed at twice the size burns out of its own bowl rather than out of its shaft,
and the flame is tied to the light by one number instead of by two constants in
two files that agree until one is edited. A campfire's root is `0` -- the ground,
byte for byte what it plays today.

`brushFire` gains one knob:

```ts
/** Multiplies every world-unit velocity: how tall this fire is. */
readonly reach?: number;
```

`scale` at play time multiplies a mark's size and its birth offset and
deliberately **not** its speed, so a fire played small is small marks thrown at
full-size velocities -- a 7-unit flame mark climbing the campfire's fifty units.
`reach` multiplies the speeds, the updraft, the ember gravity and the turbulence
together, which scales every *distance* in the effect and no *duration*: apex is
`v²/2g`, so `k²/k = k`, while time to apex is `v/g` and does not move.

The torch's cone becomes a small ember core in its bowl -- the campfire's ember
bed one prop over, and for its reason: it is what is left when the paint is
culled, and what the paint's root sits in.

## Invariants tested

- Every part with an `emissive` reaches the material `buildPropField` builds,
  and no part without one does.
- The lamp's mantle and the torch's core emit their own fixture's light colour.
- A burning fixture's `root` is at most 1: a flame's root is never above the
  light hung in it.
- A torch plays a fire, at a height derived from its light rather than from the
  ground, and scaled with the prop.
- A campfire's fire is unmoved: same id, same scale, same `y` as before.
- `reach` scales every velocity, acceleration and turbulence amplitude by the
  same factor and leaves lifetimes, sizes, counts and alphas alone.
- The registry still compiles into the same batch ceiling: a second `brushFire`
  row adds no draw call.

## Out of scope

- The campfire's own look. Its ember bed is genuinely lit by its own lamp (the
  light is 34 up and the bed is on the ground, so the bed's top face faces it),
  and spec 250 tuned that pair through `preview-fixtures.ts`.
- Emissive on anything that is not a light fixture.
- Sound. `fire_torch` plays no audio event; the catalog has no fixture bus.
- Shadows, which spec 250 removed on purpose.
