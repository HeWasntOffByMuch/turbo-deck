# 121 — A weapon you can see

## Problem

Every player carries a weapon and no player has ever held one. `sword.worn` is
in `equipment.mainHand` from the first tick, six weapons sit in the item table,
the HUD has a switch that changes between them, and the body on screen is
empty-handed through all of it. The weapon is real everywhere except where a
person is looking: it moves damage, reach and swing cadence, and the only way to
know which one you picked is to read the tooltip on the button you pressed.

Spec 120 removed the last structural excuse. The player is drawn from an
authored unit (`pig_a_pose_full`), that unit's skeleton now derives its sockets,
and `weapon.main` names `R_Hand` — a real bone on the real rig. There is a hand
to put a sword in and nothing that can put one there: `UnitRig` loads a mesh and
poses it, and has no way to hang anything off a bone.

The wire is the other half. The entity record replicates position, facing,
health, activity and level, and says nothing about what a body is holding. A
client knows its *own* `basicAttackId` because `Stats` derives it, and knows
nothing at all about anybody else's weapon — so even with an attach API, every
other player would be unarmed.

## Shape

### The wire

One new field on the entity record, in the delta's existing bitmask:

| Bit | Field | Payload |
|---|---|---|
| `0x40` | MainHand | `str itemId` |

Empty string means empty-handed, which is what a monster with no weapon and a
player who unequipped both send. Written on spawn and on change, like every
other field — the bitmask *is* the delta, so a body that has not switched
weapons contributes no bytes.

The main hand only. Off-hand, armour and trinkets are out of scope below, and
adding them later is another bit rather than a reshaping.

### Attaching

`UnitAssets` gains what the loader already has in hand from the bundle:

```ts
/** Socket id -> the bone name the skeleton document gives it. */
readonly sockets?: Readonly<Record<string, string>>;
```

and `UnitRig` gains:

```ts
/**
 * Hangs `object` off `socketId`, replacing whatever was there.
 * Returns false when the rig has no such socket or the bone is missing.
 */
attach(socketId: string, object: THREE.Object3D | null): boolean;

/** Socket ids this rig can actually attach to, resolved against the loaded bones. */
get attachable(): readonly string[];
```

Two rules the implementation is *about*, both learned already in this codebase:

- **The bone is found in the loaded rig, never taken from the document.** three
  sanitises `mixamorig:RightHand` to `mixamorigRightHand` in the scene it
  builds, so a name read from the skeleton JSON matches no node, attaches
  nothing, and returns a clean `false` that looks like "this rig has no hands".
  Resolution goes through `boneKey` from spec 120, which is the function that
  already exists for exactly this.
- **An attached object is authored in world units.** The model is scaled by
  `importScale` (~32× for a rig authored at human height), and a child of a bone
  inherits that whole chain. A sword built at a believable 40 units and parented
  raw comes out a quarter-mile long. `attach` counter-scales by the inverse, so
  callers build weapons the same size they build props and projectiles.

### The shape of a weapon

`src/render/iso3d/world/weapon-shape.ts`, pure and in the mould of
`projectile-shape.ts`: where the vertices go, no three.js, tested in Node.
`scene.ts` turns a profile into buffers.

```ts
export type WeaponKind = 'sword' | 'maul' | 'staff' | 'bow' | 'thrown';
export interface WeaponProfile { /* blade/haft/head lengths and radii, grip offset */ }
export function weaponKindFor(itemId: string): WeaponKind | null;
export function weaponProfile(kind: WeaponKind): WeaponProfile;
```

`weaponKindFor` is a table keyed by item id, in the style of
`unit-catalog.ts`: a seam with a row per item, defaulting to `null` (draw
nothing) rather than guessing from the id's prefix. An item added to the server
table without a row here is unarmed on screen, which is visible and fixable;
an id parsed for `sword.` is a rule that breaks silently the first time
something is called `greatsword` or `sword_of_x`.

The grip offset is part of the profile because a hand closes around a hilt, not
around a blade's centre: the profile says where along its own length the weapon
meets the bone.

## Invariants tested

- A `MainHand` field survives a round trip through encode/decode, empty string
  included, and an entity that did not change weapons contributes no bytes to
  its record.
- Equipping through `0x04 Equip` puts the new item id in the next delta for
  *every* client that can see that body, not only the owner's.
- `attach` resolves a socket whose document name is `mixamorig:RightHand`
  against a loaded rig whose node is `mixamorigRightHand` — the sanitisation
  case, asserted in both spellings.
- `attach` returns false, and changes nothing, for an unknown socket id and for
  a socket naming a bone the loaded rig does not have.
- An attached object's **world** scale is independent of `importScale`: the
  same object attached to a rig imported at 1× and at 32× measures the same
  size in the scene.
- Attaching to an occupied socket removes the previous occupant from the scene
  graph rather than stacking two swords in one hand.
- `attach(id, null)` empties the socket.
- Every item in the server's table with `slot: 'mainHand'` either has a
  `weaponKindFor` row or is deliberately absent — asserted against the real
  `ITEMS` table, so adding a weapon server-side fails this test rather than
  silently drawing nothing.
- A weapon profile's total length is within a plausible band of the rig's
  canonical height, so a sword that reads as a lamppost fails in Node.
- The pig's `weapon.main` socket is in `attachable` once loaded, driven through
  the real `.glb` — the check that would have caught this whole class of thing
  being broken.
- Presentation-only: the same seed and inputs with weapons drawn and with them
  suppressed produce identical authoritative state.

## Out of scope

- **Off-hand, armour, trinkets.** One slot, one bit. The other slots replicate
  the same way when something wants them.
- **Weapon models as assets.** These are procedural shapes like the arrow and
  the shuriken, not authored `.glb`s. A generated weapon is a Studio question
  and a spend.
- **Swing animation driven by the weapon.** The clip is the clip; a maul does
  not yet swing slower than a sword on screen, only in the numbers.
- **Trails, glow, or hit sparks off the blade.** Spec 087 owns what a shot
  leaves behind, and a melee equivalent is its own decision.
- **The 5° bind-pose asymmetry** spec 120 surfaced. A weapon hangs off one hand
  and does not care that the other one sits slightly differently.
