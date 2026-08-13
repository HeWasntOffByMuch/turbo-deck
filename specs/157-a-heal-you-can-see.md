# 157 — A heal you can see

## Problem

Healing is drawn as **blood**. Every heal in this game arrives at the client as a
hit against yourself with negative damage — `collectMote` says so in as many
words ("reported as a hit against itself with negative damage, the same shape
every other heal in the game uses, so the client already draws it"), and
`castSelfHeal` emits the same event. `effectsForBlow` never looks at the sign, so
picking up a vitality mote or casting Mend throws a red spatter off your own
chest and stains the ground under you.

The number floating off the body is already right — `hud.addDamage` reads the
sign, writes `+12` and colours it green. The effect beside it is the one thing
saying the opposite.

Two smaller things fall out of the same event:

- A heal has **no direction**, and `effectsForBlow` steps the contact point back
  along the blow. Self-healing survives that by accident (attacker and target are
  the same body, so the vector is zero); a heal cast *on* somebody would draw
  itself off-centre, on the face the healer is standing on.
- Both self-heal abilities also send an `Effect` message named `self.mend.self` /
  `self.hearthdraught.self`. The registry has no such entry, so `scene.addEffect`
  falls through to its debug disc: a flat **orange** circle at the caster's feet,
  under the green heal, for half a second.

## Shape

### The effect

One new entry in the library, played at the healed body's **feet** — a heal comes
up out of the ground, so its origin is the ground and not the chest a blow lands
on. Three layers, which is the three things the brief asks for:

```ts
// render/iso3d/vfx/library.ts
{
  id: 'heal_restore',
  emitters: [
    ...waveEmitters(9, 'auraHeal', 'auraBuff'), // a small green shockwave at the feet
    streaks,                                    // vertical ribbons, rising
    plusses,                                    // plus signs, rising slower
  ],
}
```

- **The shockwave** is `waveEmitters`, the same wavefront a walk order and a
  shockwave already use — green, and smaller than the selection ring (peak radius
  ~22 world units against that ring's 34), so a heal never reads as a status.
- **The streaks** are ribbons on a near-vertical cone: born on a disc about a
  body wide, thrown straight up, no gravity. A ribbon draws the path a particle
  actually flew (spec 139), so straight up is a straight vertical streak.
- **The plusses** are billboards on a new 7x7 sprite, rising slower than the
  streaks so they are still climbing when the streaks have gone.

### The sprite

```ts
// render/iso3d/vfx/textures.ts
case 'plus': // a 7x7 cross, arms three texels wide, every texel on or off
```

Authored in texels rather than as a shape with an edge. At the gameplay zoom the
frame is 760x300 over roughly 900 world units, so a 13-unit plus lands on about
eleven pixels — an antialiased or dithered cross at that size is a green smudge,
and a hard 3-texel bar is a plus. It is drawn `dither-cutout`, so its fade is a
thinning weave of solid pixels rather than a translucent smear the retro pass
then bands.

### The wiring

```ts
// render/iso3d/world/vfx-wire.ts
export const HEAL_EFFECT = 'heal_restore';

/** Server effect ids the blow already draws, so nothing draws them twice. */
export const REDUNDANT_SERVER_EFFECTS: ReadonlySet<string>;
```

`effectsForBlow` branches on `facts.damage < 0` before it works out a contact
point, and returns exactly one request, centred on the body and at ground level.
No direction, no debris, no death variant, no crit — a heal is not a blow read
quietly, it is a different event that happens to travel on the blow's message.

`view.ts` drops an `Effect` message whose id is in `REDUNDANT_SERVER_EFFECTS`
rather than falling through to the debug disc.

## Invariants tested

- A heal (negative damage) plays `heal_restore` and **never** `hit_blood`,
  `death_blood` or any damage-type impact — including when the flags say killed,
  critical or blocked, which a heal event has no business setting but the wire
  cannot stop it from carrying.
- A heal is drawn at the target's own position and at ground level: the contact
  offset and lift a blow gets are not applied to it, whoever cast it.
- A heal plays exactly one effect, and its seed is still a function of where and
  when (`blowSeed`), so two clients watching one heal see one picture.
- Damage of zero is still a blow, not a heal — the sign test is `< 0`.
- `heal_restore` is in the registry, is green (every colour stop is one of the
  heal/buff palette entries), and carries all three layers: a `ring`-shaped mesh
  emitter, a `ribbon` emitter and an emitter drawing the `plus` sheet.
- The `plus` sheet is square, has one frame, and is a real cross: its centre
  texel and the four edge-midpoint texels are opaque and its corners are clear.
- Every id in `REDUNDANT_SERVER_EFFECTS` is a self-heal ability's effect id, and
  each names an ability that actually heals.
- The library-wide checks that already exist (no duplicate ids, sprite sheets
  that exist with the right frame counts, every emitter visible, the whole
  library plays for a hundred ticks without leaking, batches stay under the
  ceiling) cover the new entry for free.

## Out of scope

- **The sim does not move.** No new event, no protocol change, no `heal` message
  — the negative-damage hit stays exactly the shape it is, and this is entirely
  a decision about what it looks like.
- **Overheal, shields and Focus motes.** A mote that restores resource emits no
  hit event at all, so nothing here draws it; the shield Constitution grants
  already has `aura_shield`.
- **Naming the healer.** A heal cast on somebody else draws on the target and
  says nothing about where it came from. The beam that would say so is a
  projectile-shaped effect and belongs with the ability that fires it.
- **A big heal drawn louder.** Scale stays 1: the client is told an amount, not a
  fraction of a maximum, and "louder" against an absolute number would read
  differently for every build.
