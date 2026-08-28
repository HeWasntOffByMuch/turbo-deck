# 218 — the shot the staff throws

## Problem

The **Emberwood Staff** is the only main hand in `data/items.ts` whose whole
identity is `spellPower`, and it is also the only one that changes nothing about
attacking. `basicAttackId` has existed since spec 076 and exactly two rows use
it -- `bow.hunting` and `stars.weighted`, both level 1, both common. So the
rare, level-4, Intelligence weapon a player buys from the vendor at 95 coin is
picked up and *swung like a stick*, at `melee.slash`'s 50 units, and the only
thing it does that a sword does not is raise a number on the character sheet.

Its `attackRange: 20` is the tell. `EffectiveStats.attackRange` is read by the
character sheet and the item tooltip and by nothing else that matters: a
player's reach is `abilityById(stats.basicAttackId).range`, which is what
`autoAttack` is handed and what `startCast` gates on. A weapon that names a shot
has no use for the field at all, which is why `bow.hunting` does not carry one
and says so in a comment. The staff carries one and nothing has ever read it.

One table over there is a second gap of the same kind, and it is the one that
decides how this is drawn. **The painted explosion has no caller.** Specs 158
and 159 authored four presets -- `explosion_brush`, `_small`, `_large`,
`_smoulder` -- and `brushExplosionRequest` to choose between them, and nothing
in `src/` plays any of them outside `brush.test.ts`. That is the failure spec
215's bidirectional test was written to close, sitting in the neighbouring
table: authored, tested, previewed, and never once on screen in a game.

The reason is worth writing down, because it is also the thing this spec has to
fix to use them. `scene.addEffect` is the one path a server `Effect` message
takes, and it has two branches: play the id when the registry knows it, draw a
flat orange debug ring when it does not. **The first branch has never fired.**
The server can send 46 effect ids (`${ability.id}.impact` and
`${ability.id}.self` over `ALL_ABILITIES`) and the registry holds none of them,
so every ability in this game has drawn the same debug ring since spec 062.

## Shape

### The row, and the weapon that names it

`ProjectileLook` gains a fourth member:

```ts
export type ProjectileLook = 'orb' | 'arrow' | 'shuriken' | 'ember';
```

and `data/abilities.ts` a row:

```ts
{
  id: 'ranged.ember',
  name: 'Ember Shot',
  kind: 'projectile',
  targeting: 'point',
  windupTicks: seconds(0.7),
  backswingTicks: seconds(0.3),
  cooldownTicks: seconds(1),
  cost: 0,
  range: 330,
  damage: 0,
  projectile: { speed: 700, arc: 0.25, radius: 9, lifetimeTicks: seconds(1.5), look: 'ember' },
  basicAttack: true,
  description: 'A knot of fire, shaken off the charred head of the staff.',
}
```

`staff.emberwood` names it and **drops `attackRange: 20`**, following the bow
row exactly: the field describes what a melee swing would have reached, and a
weapon that names a shot never melees.

### One thing that falls out: the weapon switch narrows

`WEAPON_SWITCH` is derived from the item table -- one entry per distinct
auto-attack a main hand can name -- and its own comment promises that "a
crossbow added there turns up here without this file being told". Two tests have
asserted since spec 126 that every entry is level 1 and every entry is in the
starting kit, and **nothing enforced either**: they held because the only two
weapons that named a shot were level-1 commons in the kit.

A rare level-4 staff makes the promise come due. Derived as it was, the ember
shot turns up as a fourth button that equips nothing, refuses silently and has
no icon. So the derivation reads `STARTING_KIT`, which makes both rules true *by
construction* instead of by luck, and means the next weapon naming an attack a
starting character cannot hold adds no button rather than a dead one. Nothing is
lost: the staff is bought from a vendor and equipped out of the bag like
everything else, and `admin:giveItem` plus `admin:setLevel` is how a probe
reaches it -- the developer path that already exists, rather than a new one.

Three numbers are the design and the rest follow from them.

**330, against the bow's 420 and the star's 300.** Shorter than the bow is the
request; longer than the star is the rarity. It is the reach `autoAttack` chases
to and `startCast` refuses past, which is the whole of why the row carries it
rather than the item.

**Speed 700, against the arrow's 900 and the star's 1150.** A ball of fire is
the slowest thing anybody throws here, which is what makes it a shot you can see
coming and step out of -- the same argument spec 094 makes about wind-ups, moved
into the flight. The lifetime is `seconds(1.5)`, and the reach invariant
`stats.test.ts` already asserts holds with room: `700 / 60 * 90 = 1050` against
a 330 range.

**Wind-up 0.7 and backswing 0.3.** 60 ticks against `BASE_ATTACK_TIME_TICKS`'s
72, so the cadence stays the stat's answer (spec 088) and the commitment sits
between the bow's 0.8 and the star's 0.45.

The arc is `0.25` and it is a **look and nothing else** -- `projectileHits` is a
flat 2D overlap with no height term (spec 191 found the comment that says
otherwise, on this very table). A quarter arc peaks 21 units over a full-range
throw, which is enough that the ball clears the grass and the smoke behind it
bends.

`damage: 0`, which is the whole table's convention since spec 217: a basic
attack's damage is **the weapon's own range**, rolled in `resolveBlow`, and
`melee.slash`, `ranged.shot` and `ranged.star` all carry a zero here for the
same reason. What an Ember Shot hits for lives on the staff.

### The staff's damage range moves, and the row says why it has to

Spec 216 gave `staff.emberwood` `scaling: { strength: E, agility: -,
intelligence: A }` and spec 217 gave it `damage: { min: 1, max: 2 }` -- the
weakest range in the table, chosen under a premise this spec removes:

> Barely a weapon, and meant to be: what this row is for is the +3 Intelligence
> and the spell power, and hitting somebody with it is the fallback rather than
> the plan.

Hitting somebody with it *is* the plan now, so the range becomes **`{2, 5}`**:
above the bow's `{2, 4}` because this is a level-4 rare against a level-1
common, and short of the level-5 melee rares (`{3, 6}` and `{4, 11}`) because it
out-ranges every one of them by three hundred units. Three wide, which is the
keen blade's spread rather than the maul's seven: a thrown ball of fire carries
a fixed payload, so what varies is where it catches you and not how hard it was
swung.

The **scaling letters do not move**, and that is deliberate rather than
overlooked. `intelligence: A` was chosen for a stick swung by a magus and this
makes it literal: the thing the staff throws is fire, and the attribute that
decides how much of it is the one the row already named. The `E` in Strength was
justified as *"hitting something with a stick is still worth marginally more to
a strong body"*, which is now a sentence about an attack this weapon no longer
makes -- but it is the bottom of the ladder, the arm still swings the staff to
throw, and re-lettering another spec's row for a coefficient nobody can feel is
churn rather than a fix. `spellPower: 0.2` and `intelligence: 3` are untouched:
what they buy is skills, which is the weapon's identity.

### What it draws as: a mesh core and paint over it

`ShotRig` gains an `ember` case, and the one decision in it is that **the mesh
is smaller than the shot**:

```ts
// projectile-shape.ts
export const EMBER_CORE_SCALE = 0.5;
export function emberCoreRadius(radius: number): number;
```

An arrow and a star are objects and their mesh is the whole of them. A ball of
fire is not: the silhouette is the *paint*, and a mesh drawn at the full
collision radius would be an orange bead with flames stuck to the outside of it.
So the mesh is the heat at the middle -- 4.5 units against a 9-unit shot, in
`PALETTE.emberCore` behind an `emberRim` shell, the same core-and-rim pair a
mote already uses to survive being small against grass.

It is a mesh rather than paint alone for one reason, and it is not aesthetics:
`VfxLayer.play` **returns 0 on refusal** -- unknown id, over budget, past
`cullDistance`, and `Effects: Off` skips the simulation outright rather than
hiding it. A projectile that existed only as particles would be an invisible
shot, which is a gameplay failure and not a presentation one.

It leaves **no `Trail`**. The ribbon is the shuriken's, it is a strip of flat
geometry across the ground plane, and a grey ribbon is not smoke.

### The paint: one builder, three layers

`vfx/brush.ts` gains `brushShot`, in the register `brushAffliction` set -- a
*state* that is played once, attached to a moving body, and stopped once:

```ts
export interface BrushShotParams {
  readonly id: string;
  /** Marks held on the ball, per second. */
  readonly core?: number;
  /** Additive licks over them, per second. */
  readonly licks?: number;
  /** Marks laid down and left behind, per second. */
  readonly trail?: number;
  readonly trailLife?: readonly [number, number];
  readonly hot: PaletteKey;
  readonly mid: PaletteKey;
  readonly deep: PaletteKey;
  readonly trailFrom: PaletteKey;
  readonly trailTo: PaletteKey;
  ...
}
export function brushShot(params: BrushShotParams): EffectDefinition;
```

registered once as `shot_ember`. Three emitters, and the split between them is
the same one `brushAffliction` draws, one system along:

1. **`core`** -- `brush-blot` in `alpha`, born on a tight sphere shell,
   `worldSpace: false`. **That flag is the whole of "it clings"**: the compiled
   default is `true`, attaching an effect moves only the emission *origin*, and
   a mark born on the ball and left in world space is a mark the ball flies out
   of within one tick. Short-lived (7-12 ticks), so the ball is continuously
   *renewed* rather than growing a beard.
2. **`licks`** -- `brush-slash` in `additive`, also clinging, three or four
   ticks, `hot` only. Light rather than pigment, and the one layer that says
   *burning* instead of *orange*.
3. **`trail`** -- `brush-blot` in `alpha`, **world space**, which is the same
   flag read the other way: a mark laid down at the ball's position and left
   there is a trail, by construction and with nothing tracking anything. Short
   life on purpose -- the request is a *very short* trail -- and at 273 units a
   second (700 through `PROJECTILE_SPEED_SCALE`) a 14-tick life is about 64
   units of smoke behind a 9-unit ball, seven shot-radii and gone.

**No new draw calls.** A batch is keyed `family:blend:sheet:meshShape` and the
compiled registry is sitting on exactly 25 batches against `library.test.ts`'s
cap of 25. `mesh:alpha:brush-blot` and `mesh:additive:brush-slash` both already
exist -- the first from the explosion's smoke and the afflictions, the second
from the explosion's flash -- so all three layers are free. Any fourth mark or
any other blend would fail that test, which is the constraint that chose these
three and is worth stating rather than rediscovering.

Every length is authored in **shot radii** and the driver plays with
`scale: radius`, so the definition is a fireball at any size; speed, gravity and
turbulence stay world units, which is `brushAffliction`'s stated asymmetry and
is correct for the same reason -- a big fireball's smoke does not rise faster.

### Three things the numbers could not settle

Every version below scored clean on stipple and on connectedness and looked
wrong, which is why the sheet exists. Each is recorded in the builder beside the
number it produced.

**The fire has to outnumber the smoke.** Authored the other way round -- more
trail marks than core ones, at similar sizes and similar alpha -- it photographs
as a swarm of dark specks with a red dab in front. Against a mid-green field an
orange mark is a highlight and a near-black one is a *hole*, and there were
twice as many holes.

**The trail has to be cooler and lighter than the fire.** `smokeDark` (0x3c3733)
is not a dark mass on grass, it is a hole, and a dozen holes read as flies.
Warming it to `paintBurnt` fixed the value and broke the hue: a brown plume
behind an orange ball reads as leaves blowing past it, because nothing separates
the two. Pale grey does both jobs.

**The ball is mostly `mid`.** Holding the pale `fireCore` reads as light rather
than as fire; reaching `fireDeep` early reads as an ember going out. At
twenty-five pixels a flame is a saturated orange mass with something brighter
inside it -- and in the game that brighter thing is the `ShotRig` core, which no
paint sheet can show.

### The driver: `world/shot-vfx.ts`

Pure, in the register `affliction-vfx.ts` set, and for the same reasons:

```ts
export const SHOT_ART: Readonly<Partial<Record<ProjectileLook, string>>>;
export function shotArtFor(look: ProjectileLook | null): string | null;

export interface ShotBody { entityId; x; y; z; radius; look }
export class ShotVfx {
  step(body: ShotBody): void;
  forget(entityId: number): void;
  entities(): readonly number[];
  clear(): void;
}
```

Three rules carried over from spec 215 because they were learned there and the
failure modes are identical:

- **It holds a handle, not an id.** `play` returns 0 on refusal, and a driver
  that recorded ids could not tell "wanted, asked for, did not start" from
  "started", so a shot refused under budget pressure would fly the rest of its
  life unpainted.
- **`isLive` is asked every frame.** A full instance pool does not refuse, it
  *evicts* the lowest-priority furthest instance and bumps its generation, so a
  held handle goes stale where it sits.
- **`forget` is called from the despawn sweep**, beside `afflictions.forget`.
  Nothing in the particle system stops itself when the body it is attached to
  goes away: the attach hook answers false, the instance stays where it last
  resolved, and a `durationTicks: 0` effect hangs in the air forever holding one
  of 128 slots. A shot lives a second and a half, so that is a leak that would
  run at the rate of the shooting.

`SHOT_ART` is a **table and not a naming convention**, for the reason
`naming.ts` and `AFFLICTION_ART` are tables: a built id is a second invisible
answer every boundary has to re-derive, it has nowhere to say that `arrow`,
`shuriken` and `orb` deliberately have no paint, and a typo in it survives as an
effect that silently plays nothing.

### The impact: `addEffect` plays an authored effect at its authored size

`ranged.ember.impact` is registered as
`brushExplosion({ radius: EMBER_BURST_RADIUS, smoke: 0, ... })` and reached by
the seam the server has had since spec 062, with nothing added to the wire and
nothing added to a call site -- `sim/world.ts` already pushes
`{ kind: 'effect', effectId: `${ability.id}.impact`, ... }` on a projectile's
direct hit. **Adding an impact for a new ability is a row in the ability table
and an entry in the library**, which is the acceptance criterion `vfx-wire.ts`
states for the whole arc.

For that to draw the right size, one line in `scene.addEffect` changes: an
authored effect is played at **scale 1**.

```ts
- scale: Math.max(0.25, radius / 40),
+ scale: 1,   // and the radius keeps sizing the fallback ring below
```

The old rule cannot be right, and not by a little. `scale` multiplies the
shape's local coordinates and the size curve and **nothing else** -- a
particle's speed, the constant push on it and its turbulence are integrated in
world units -- so an explosion authored at radius R and played at 0.25 draws
quarter-sized marks thrown at full-sized speeds, which is a scatter and not a
burst. And 0.25 is not an edge case: the radius a *direct hit* carries is the
shot's own collision radius, 6 to 12 units against a nominal 40, so every
direct-hit impact in the game is on the floor. The message's radius means two
different things on its two branches -- the blast for a burst, the shot for a
hit -- and one conversion cannot serve both.

Changing it is free, because the branch has never run: the registry holds none
of the 46 ids the server can send. The day a *burst* wants its picture sized by
its blast, the honest way is `brushExplosionRequest`, which already exists,
already treats a radius as a length, and already picks the preset nearest the
size asked for so the scale stays near 1.

`smoke: 0` is the request read literally, and `brushExplosion` already omits the
emitter entirely at zero. `debris` stays at 2: the transitional layer is burnt
orange going to brown, drawn *among* the fire, and it is what makes a painted
explosion painted rather than a radial star. With the smoke gone there is no
`paintSoot` anywhere in the picture. `light` stays **off**, and that is a
finding rather than a preference: a light's radius is written straight into the
light buffer and is the one authored length `scale` does not touch, so a lit
preset is a light sized for whatever radius it was authored at.

The hit animation does not move, and does not need to: `attackTriggerFor` raises
`shoot` for `look === 'arrow'` and `attack` for everything else, so a staff
throwing fire keeps the swing it already plays.

## Invariants tested

**The row and the weapon**

- `staff.emberwood` names `ranged.ember`, and `computeEffectiveStats` returns it
  as `basicAttackId` for a player holding the staff.
- The staff carries no `attackRange`, and the shot it names out-reaches
  `melee.slash` -- the assertion `stats.test.ts` already makes for the bow.
- `ranged.ember`'s range is strictly between `ranged.star`'s and
  `ranged.shot`'s. Written as a comparison rather than as `330`, because what
  the spec was asked for is an ordering.
- The staff's damage range out-rolls the bow's and is out-rolled by both level-5
  melee rares -- again an ordering, so a retune of any of the four moves them
  together.
- `windupTicks + backswingTicks < BASE_ATTACK_TIME_TICKS`, so the cadence stays
  the stat's.
- The weapon switch offers only attacks a fresh character can reach, and the
  two rules it has asserted since spec 126 -- level 1, and in the bag -- now
  hold by construction. Asserted with a third: that the set it offers is
  strictly smaller than the set the item table can name, so the narrowing is
  doing something rather than passing on an empty difference.
- It satisfies the table's existing sweeps unchanged: the structural gate in
  `sim/abilities.test.ts`, the reach invariant in `stats.test.ts`
  (`speed / tickRate * lifetimeTicks >= range`), and every rule
  `description.test.ts` applies to a generated Technical Description.
- Its projectile is slower than both weapons that already throw one.

**What it draws as**

- `appearanceOf({ kind: Projectile, typeId: 'ranged.ember' }).look` is `'ember'`
  and its radius is the row's.
- `emberCoreRadius` is strictly less than the collision radius it is given, and
  floors on a zero or a non-finite one the way `arrowProfile` does.
- A `ShotRig` built for `'ember'` builds meshes, leaves `trace` null, and
  disposes everything it built.

**The paint**

- `shot_ember` is in the compiled registry, and `SHOT_ART` names only ids the
  registry holds -- and every `shot_` effect in the registry is named by
  `SHOT_ART`. Both directions, so the two sets are the same set and an effect
  authored and reached by nothing fails in Node.
- Its `core` and `licks` emitters are `worldSpace: false` and its `trail` is
  not. This is the one property the whole look rests on and the one that is
  invisible in a still frame.
- The trail's longest life, at the shot's real speed through
  `PROJECTILE_SPEED_SCALE`, lays less than a stated number of world units of
  smoke -- "very short" as an assertion rather than as an adjective.
- `REGISTRY.batches.length` is still at or under 25.

**The driver**

- Idempotent: the same body on the next frame starts nothing and stops nothing.
- A refused `play` (0) is retried on the following frame; a handle that stops
  being live is dropped and restarted.
- A look with no art plays nothing at all, and an id the registry does not hold
  plays nothing -- `playCue`'s rule, never `addEffect`'s debug ring.
- `forget` stops what it holds; `clear` stops everything.
- Driven end to end in Node against a recording player, with no three.js.

**The impact**

- `ranged.ember.impact` is in the registry, has no `smoke` emitter and no
  emitter whose colour reaches `paintSoot`, and carries no `light`.
- It is authored at the radius it is drawn at, which is now the same statement.
- `presentation-only.test.ts` keeps its standing assertion with the shot and its
  paint driven: same seed, same inputs, twice, once with the presentation layer
  running and once without, and the authoritative state identical.

**The pictures** (not CI; a person or an agent looks at these)

- `scripts/preview-shots.ts` gains the ember beside the arrow, the star and the
  orb, through the real `ShotRig` on a real flight.
- `scripts/preview-brush-vfx.ts` gains a third sheet, `brush-shot.png`, measured
  by the four numbers it already computes -- isolated-pixel fraction, largest
  connected mass, ink area and variation between seeds -- and the live particle
  count at every sampled tick, because the way this fails silently is an emitter
  that spawns nothing.

  Two things about that sheet are decisions rather than settings. It needs
  **motion**, which the judging rig could not do: `brush-scene.ts` gains a
  `shot(id, ...)` beside its `affliction(id, ...)` and a `step` that carries the
  flight forward *one tick at a time*, because `update(n)` runs n ticks against
  one emission origin and a trail advanced in a single call is laid down as a
  heap at the far end of the flight. And it carries a **rest-against-speed row**
  -- the same effect, the same seed, the same tick, at 0 and at 273 units a
  second -- which is the one comparison that can fail while every other tile
  looks right: at rest the trail is laid on top of the ball and the whole thing
  is a bonfire. Measured, the moving pair carries three to six times the ink.

  The frame is much tighter than the blood and blast sheets', for the reason
  `preview-afflictions-vfx.ts` gives about its own: a blast is a hundred units
  across and this is an 18-unit ball, and framed like a blast it is half a
  percent of the tile -- *less subject than the seed check needs difference*, so
  every number would be a number about grass.

  The bearings row deliberately carries **no bearings check**. That check asks
  whether the ink survives being looked at from anywhere, which is right about a
  blast and wrong about a thing with a direction: seen down the line of flight a
  trail is behind the ball and hidden by it, exactly as an arrow's streak is.

## Out of scope

- **`CombatResult` still carries no damage type**, so a blow from this shot
  draws `vfx-wire.ts`'s `physical` hit and its blood, exactly as an Arcane Bolt
  does today. `CombatFacts.damageType` is documented as "derived client-side
  from the ability or weapon, the way `ProjectileLook` already is", and it
  cannot be: the message carries the attacker, the target, the damage and three
  flags, and nothing that says which ability threw it. `hit_fire` and the whole
  `DAMAGE_EFFECTS` table are waiting on a protocol change and this spec does not
  make one.
- **`EffectiveStats.attackRange` still lies for every ranged weapon.** The
  character sheet's Range row says "how far your weapon reaches" and reports
  `PLAYER_ATTACK_RANGE + bonus` while a bow reaches 420 and this staff reaches
  330. Dropping the staff's inert modifier makes it no worse and no better; the
  fix is to derive the row from the named basic attack, which changes what a
  replicated field means for every weapon and belongs in its own spec.
- **No blast.** `ability.radius` stays absent, so this is single-target and the
  explosion is the picture of a hit rather than an area. Giving it one is a
  balance change nobody asked for and would move it onto the burst branch.
- **No new animation.** The staff keeps the swing `attackTriggerFor` already
  gives it, and no `shoot` clip is authored for a stave.
- **No held-weapon change.** `staff.emberwood` still draws as `stick_knot`.
- **The other three painted explosion presets stay uncalled.** This spec gives
  the vocabulary its first caller; wiring `bolt.lob`'s firepot and the two
  ground abilities to `brushExplosionRequest` is the obvious next step and is
  not this one.
