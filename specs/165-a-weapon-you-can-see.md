# 165 — A weapon you can see

## Problem

Spec 140 built the whole held-object format: a weapon document, `grip.ts`'s
canonical weapon space, `weapon-rig.ts`'s three-node chain, `weapon-assets.ts`
discovering the roster off disk, a calibrated `weapon.main` socket on the pig,
and a full set of green tests over all of it.

**Nothing in the game ever called any of it.** The only caller was
`AuthoredUnit`, which is the *sandbox*. In the Play tab `scene.ts` built a
`UnitRig`, never called `setSockets`, never built a `WeaponRig`, and drew every
player empty-handed — while holding a sword, while swinging it, and while
shooting a bow that spec 164 had just animated.

There was also no bow to hold. `assets/items/` had a jian and a knotted stick,
and `weapon.off` — the left hand, where a bow goes — was a socket with a bone
and no calibration at all.

## Shape

**`assets/items/bow_recurve/`** — the supplied mesh and its document. 644
triangles, three materials, ten mesh nodes, no skin and no animation, which is
what a `weapondef` is for. The grip is measured rather than assumed: the limbs
run along Z (±0.955), the six `WrapBand` cylinders are the handle so the palm is
at x 0.189, and `flat` is +Y because Y is the axis the bow is thin in. The
`String` mesh sits 0.4 behind the grip, which is the fact that decides which way
round it goes in the hand.

No `stowSocket`. `weapon.stow` is calibrated for a sword across the back, and a
bow hung at that angle would be visibly wrong — an absent socket is honest and a
wrong one is not.

**`scripts/solve-socket.ts`** — the calibration, solved instead of swept.
`weapon.main` was found by putting four candidate rotations side by side in
`preview-weapon.ts` and picking one, which is slow and only ever answers "which
of these four". This states the requirement in the frame it is about — *where
the weapon's own axes should point, in the body's axes* — and answers in one
matrix multiply:

```
bone · pivot = target      →      pivot = boneᵀ · target
```

`WANT=point:up,edge:back AT=anchor` puts the limbs vertical and the string
toward the archer; the answer is `[156.2, -61.3, 61.2]` with a residual of 0.05
degrees. Run with no `WANT` it *reports* instead, which is the measurement
nobody had: the sword's blade at the guard comes back "forward and 20 degrees
up", which is exactly what `aim-blade.ts` says it authored, so the tool is
checked against a known-good answer before it is trusted with a new one.

The pose is an input rather than a convenience, because spec 143's lesson is
that a calibration is exact at one pose and approximate everywhere else. The
report prints every key so the spread is visible: the bow stays within 24
degrees of vertical across the whole draw, because the bow arm is the one this
clip holds still.

**`src/render/iso3d/world/weapon-look.ts`** — which model an equipped item is
drawn with. A table, because the mapping is not one-to-one in either direction:
two swords share a model, and two items have none. **An item with no row draws
empty hands**, which is what every item did before — the iron maul and the
weighted stars have no mesh, and drawing the maul as the knotted stick would be
a lie the player reads as a fact about their gear.

**`scene.ts`** calls `setSockets`, and `syncHeldWeapon` keeps the local player's
hand in step with `view.equipment.mainHand`. Only the local player, because only
the local player's equipment is on the wire — a remote player's `mainHand` is
not replicated, and drawing one would mean inventing what they are carrying.

Two things make it a per-frame call rather than an event. The body's mesh and
the weapon's mesh are independent fetches and `attach` needs a *bone*, so the
attach is retried until it takes. And `weaponId` is written before the load
starts and re-checked after it resolves, so a bow arriving after the player has
switched back is disposed rather than drawn.

## Invariants tested

`weapon-look.test.ts`, in Node: every row names an item that exists, a weapon
document that exists, and a `mainHand` slot; two swords share a model; an
unknown id, a null and a modelless item all give empty hands; and every model's
socket exists on the biped **and carries a `rotationDeg`** — an uncalibrated
socket is the bind pose's idea of a hand, which is how the bow first came out
lying along the arm like a lance.

`scripts/probe-held-weapon.ts` is the half that only exists in a browser, and it
is the whole point: everything above was green while the game drew nobody
holding anything. It drives the shipped build, reads `data-held-weapons` —
published from **what is attached**, not from what was wanted, so a weapon
fetched and attached to nothing reads as absent — and asserts:

- a fresh character arrives holding `weapon.main=sword_jian`;
- clicking the bow gives `weapon.off=bow_recurve`;
- clicking the stars gives empty hands, so "nothing drawn" is a checked outcome
  rather than the same silence a broken attach produces;
- switching sword → bow inside a fetch still ends holding the bow.

That last one found a real bug. Two loads of the same weapon can be in flight at
once — switch away and back inside one fetch and both carry the same `wanted`,
so both pass the staleness test — and assigning over the first left it attached
to the bone with nothing holding a reference to detach it. The resolve handler
drops whatever is held first, unconditionally.

It also found a bug in itself, which is worth recording: it settled on "two
consecutive polls agree", and an equip round trip plus a mesh fetch fits inside
that, so it reported empty hands for a bow that arrived 200ms later. **A probe
that lies toward "broken" is worse than no probe**, because the bug it invents
gets fixed. It now waits for the expected value *and* re-reads after a beat,
because one of the expectations is empty hands and an impatient poll for `""`
would be satisfied by the instant between a drop and the wrong thing arriving.

## Out of scope

- **Remote players' weapons.** Equipment is replicated for the local player
  only. Putting it on the wire for everyone is a protocol change and its own
  spec.
- **A drawn string.** The bow's string is part of a rigid mesh, so it stays
  straight while the draw hand goes back. Bending it needs a bone in the weapon,
  which is the thing a `weapondef` exists to *not* have.
- **Sheathing.** `weapon.stow` is still the sword's calibration and the bow has
  no stow socket; nothing in the Play tab sheathes anything.
- **A maul and a star.** No meshes, so no rows. They draw as they always have.
