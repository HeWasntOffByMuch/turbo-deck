# 079 — Withdrawing from a blow, and shots that travel

*Renumbered twice while this branch waited: the map's spawners took 076, and the
lobed canopy tree took 077.*

## Problem

Two gaps either side of the same idea: a wind-up you can be seen entering, and a
blow whose arrival is a thing in the world rather than a number on a clock.

1. **A wind-up can only be withdrawn from with `Esc`.** The server zeroes a
   caster's movement components for as long as `cast !== null` (`world.ts`), and
   `intent.ts` mirrors that by refusing to steer while `castAim` is set. So the
   only way out of a commitment is a dedicated key that does nothing else.
   Feinting — showing the wind-up, reading the answer, and stepping out of it —
   is the other half of the decision this game is built on, and it is currently
   unreachable. Walking away from a swing is how a player says "not that one".

2. **Every basic attack is melee.** `bolt.arcane` and `bolt.lob` prove a
   projectile can travel, but both are cursor-aimed hotbar abilities that fly at
   a *patch of ground* and expire at their range. Nothing shoots at a unit, so
   there is no ranged auto-attack, and a shot cannot miss because the target
   moved — it can only miss because it was aimed at the wrong place to begin
   with. A shot whose flight decides when it lands is a different mechanic from
   a swing that resolves on a scheduled tick, and it is the one worth having:
   run out of the way and the arrow arrives late, or not at all.

## Shape

### 1. A move order withdraws from a wind-up

One rule, in the sim, applying to every body that casts:

> An entity that asks to move while holding a cancellable cast withdraws from
> it, and moves on that same tick.

Cancellable is not a new judgement — it is exactly where `cancelCast` already
says it is: the `Turning` phase, any tick before `releaseTick`, or a live
channel. So the refund is the one `Esc` gives: the cost back, the cooldown
cleared, and the only thing spent is the time. Past the release there is nothing
to withdraw from and the input is an ordinary walk away from a blow that landed.

In `step`'s movement pass, before the intent is stripped of its movement
components:

```ts
// world.ts -- the root now yields to a move order rather than outranking it
const withdrawing = current.cast !== null && asksToMove(rawIntent);
```

The cancel is applied there rather than deferred to the cast pass, so the step
out is immediate: withdrawing and walking are the same tick, which is what makes
the feint read as one motion instead of a stutter.

This is a sim rule, not a client one, so a monster obeys it too — one that has
committed to a swing and whose quarry then walks out of reach breaks off and
chases, instead of winding up at air it will miss.

Three mirrors, so the client predicts what the server is about to do:

- `moveIntent` (`intent.ts`): `castAim` stops outranking a direction. When
  something is asked for, the walk wins and the body faces where it is going;
  with nothing asked for it roots and turns into the aim exactly as now.
- `GameClient.sendInput`: an input carrying a move vector drops `selfRoot` —
  both halves of it, the cast the server confirmed and the one this client has
  only asked for. A client that kept rooting itself would predict a stand while
  the server walked.
- `autoAttack` (`target.ts`): no chase while `rooted`, which is what its own
  doc comment already claims and what the code does not do. Without it, a target
  that stepped back during a wind-up would cancel the swing through the chase,
  and the feint would be something the client did rather than something the
  player did.

### 2. A basic attack that shoots

No new field on `AbilityDefinition`: a ranged basic attack is a
`kind: 'projectile'` ability carrying `basicAttack: true`, so its cadence comes
from `attackSpeed` like any other swing and `startCast` refuses it beyond its
range like any other point-targeted cast. Two of them, one per travel type:

| id | | arc | speed | wind-up |
|---|---|---|---|---|
| `ranged.shot` | Hunting Shot | lobbed | 900 | 0.35s |
| `ranged.star` | Throwing Star | flat | 1150 | 0.2s |

### The switch

Three main hands and one attack each is only worth having if it can be swapped
without editing a save, so the HUD grows a **weapon switch** at the bottom left,
clear of the hotbar:

```ts
// render/iso3d/world/hud.ts
export const WEAPON_SWITCH: readonly {
  readonly itemId: string; readonly name: string; readonly abilityId: string;
}[];
HudHandle.onEquip(handler: (itemId: string) => void): void;
```

Derived from `ALL_ITEMS`, one entry per *distinct* `basicAttackId`, so a
crossbow added to the table turns up in the switch without the HUD being told.
A click is an ordinary `Equip` on `mainHand` — the path that already exists —
and which button is lit is read back off `stats.basicAttackId`, never off the
click, so an equip the server refuses leaves the old one lit rather than a
button that lies. `bow.hunting` and `stars.weighted` drop to level 1, because a
switch that refuses two of its three buttons is not a switch.

Which attack a body swings with becomes a property of the body rather than a
module constant:

```ts
// state/types.ts -- EffectiveStats
/** The ability this body's auto-attack uses. '' for something that never attacks. */
readonly basicAttackId: string;
```

Derived like every other effective stat: for a player, from the main hand
(`ItemDefinition.basicAttackId`, absent on every existing weapon and therefore
`melee.slash`); for a monster, from its row. `MonsterDefinition.ability` is
**removed** in favour of it — two places naming a monster's swing is one too
many, and `monsterIntent` already had to reach past the entity to find it.

New content to hold the other end: `bow.hunting` and `stars.weighted` as main
hands, and a `slinger` monster that opens at range. `monsterIntent`'s standoff
is `swing.range * STANDOFF_FRACTION`, so a slinger keeps its distance without a
line of AI written for it.

The id rides the existing `0x44 Stats` message (`str basicAttackId` after the
stat block); `PROTOCOL_VERSION` goes to **9**. The client reads it there and
stops importing `BASIC_ATTACK_ID` — which stays, as the default a character
with empty hands falls back to.

### 3. Shots that track, and can be disjointed

```ts
// sim/types.ts -- ProjectileState
/** The body this shot is chasing, or 0 for a shot thrown at a patch of ground. */
readonly targetEntityId: number;
```

`totalDistance` keeps its name and loses its permanence: it is re-stamped every
tick as `travelled + what is left to run`, so `progress = travelled /
totalDistance` still runs 0 → 1 and still drives `arcHeightAt`. For a shot at a
fixed point nothing about it moves, and every existing projectile behaves as it
does today.

Each tick, in the projectile pass — which runs *after* movement, so a shot
chases where its target is now rather than where it was:

1. **Aim.** Target alive and present: at it. Target dead, despawned, or never
   named: the shot keeps the aim it last had and flies on to that point. That is
   the disjoint, and it is the whole of it — nothing was scheduled, so there is
   nothing to un-schedule.
2. **Step** `speed` along the aim, clamped to arrival.
3. **Height** is the terrain plus `arcHeightAt(progress, arcHeight)`, unchanged.
4. **Resolve.** A shot that *named* a body resolves against that body and
   nothing else — the same rule melee has had since spec 070, for the same
   reason: an attack is single-target, and the bystander who wandered into the
   line is a bystander. A shot thrown at a patch of ground (the cursor-aimed
   bolts) takes the first hostile thing it overlaps, as it always has.

   **`arcHeight` is a look and nothing more.** Whether a shot rises on its way
   is what tells an arrow from a star at a glance; it buys no mechanical
   difference, so both reach the same body on the same tick. A travel type that
   changed what could stop it would be a real mechanic and would need its own
   spec entry, its own tuning, and a reason.
5. Blast radius and lifetime expiry are untouched.

Damage lands when the shot arrives. A target that ran is hit later; one that ran
far enough outlives the shot's `lifetimeTicks` and is not hit at all.

`launchProjectile` passes `cast.targetEntityId` through, and a shot that names a
target is aimed at the target rather than at a point `range` away along the aim.

### Reach to a body is measured to its edge, on both ends

Found by playing the above: a ranged auto-attack walked in and then stood there.
The client stopped chasing at `range + radius` while `startCast` gates a
point-targeted cast at `range` from the caster, so the last body-radius of every
approach was a band the player could reach and never be allowed to shoot from.
Melee never hit it because a direction-targeted cast has no range gate at all.

Both ends move to the same number:

- `CastAttempt.targetRadius`, filled by the sim from the *server's* entity, so a
  named cast is gated at `range + radius` — the reach `landOnTarget` already
  allows. A cast at a patch of ground has no edge and is unchanged.
- `autoAttack` gets a *second* fraction. The chase still walks to
  `reach * STANDOFF_FRACTION` (0.8, the standoff a monster keeps); the swing is
  allowed out to `reach * HOLD_FRACTION` (0.9), which is looser.

  Collapsing them into one — the obvious-looking fix for a body that came to
  rest on the edge of its reach — produces a worse bug, and did: `moveIntent`
  stops within `ARRIVE_EPS` of a destination, so a body that has to be *at* the
  destination to swing parks a few units outside its own threshold and stands
  there for good. Not walking, because it has arrived; not attacking, because it
  has not. The gap between the fractions is what makes that impossible, and it
  doubles as the hysteresis a moving target needs — at one threshold a shuffling
  grazer flips the decision every tick, and every flip would now cancel a
  wind-up.

### A dead target calls off the wind-up

A blow aimed at a body that is no longer there is withdrawn from rather than
thrown at the corpse. `advanceCast` checks the named target while the cast is
still cancellable — the `Turning` phase or before the release — and ends it with
`Cancelled` and a withdrawal's refund, because that is what it is: nothing was
thrown, so nothing was spent but the time.

**Only up to the release.** A shot already in the air is its own entity and
finishes its flight. Reaching back to un-launch it would be exactly the schedule
this design exists to not have — the travel decides, and a target that died
after the loose simply is not there to be hit.

## Invariants tested

- **A move order withdraws.** A move vector during `Turning` or during the
  wind-up ends the cast with `Cancelled`, refunds the cost, clears the cooldown,
  and the body has moved by the end of that same tick.
- **After the release it does not.** A move vector on or after the release tick
  leaves the blow landed and the cast ended `Released`.
- **Standing still still commits.** A cast with no movement asked for runs to
  its release exactly as it does today, turn phase included.
- **A monster breaks off** when its quarry leaves reach mid-wind-up, and its
  cost and cooldown come back with it.
- `moveIntent` walks while `castAim` is set whenever a direction is asked for,
  and still roots and turns into the aim when none is.
- `autoAttack` asks for no chase while `rooted`, in reach or out of it.
- **A ranged auto-attack is the same shape**: out of range chases, in range
  commits, winds up, and spawns a projectile on the release tick — with no
  damage anywhere before the shot arrives.
- **A shot tracks.** A target that moves after the release is hit later than one
  that stood still, and the further it ran the later the hit tick.
- **A shot can be outrun**: a target fast enough to outlast `lifetimeTicks`
  takes nothing, and the projectile despawns.
- **A shot is disjointed** by its target dying or despawning mid-flight: it
  flies on to its last aim and expires without damage.
- **A body walked into range of can be shot.** A named target between `range`
  and `range + radius` is committed to rather than refused `outOfRange`, and
  `autoAttack`'s chase comes to rest inside `range` for both ranged weapons.
- **A body that stops walking is a body that swings.** For every basic attack
  against the smallest body in the game, the gap between `STANDOFF_FRACTION` and
  `HOLD_FRACTION` exceeds `ARRIVE_EPS` — and walking a body in from three times
  its range ends in a swing rather than a stand.
- **The whole order works, not just its halves.** A standing attack order driven
  through the real tick — `autoAttack` deciding, `moveIntent` steering, `step`
  answering — closes the gap and kills a grazer with each of the three weapons
  and with empty hands, refusing nothing and withdrawing from nothing. Both pure
  halves passed while the seam between them stood still, so the seam is what is
  tested.
- **A dead target calls off the wind-up**: no hit, no `attackMissed`, one
  `castEnded(Cancelled)`, and the cost and cooldown come back.
- **A shot in the air is never called back.** With the cast already released,
  the target dying leaves the projectile flying its course to expiry.
- **A named shot is single-target however it flew.** With a hostile body
  standing between archer and mark, both the flat shot and the arcing one pass
  it and land on the mark.
- **The arc changes nothing but the picture.** The same shot with `arcHeight`
  imposed on it mid-flight reaches its target on the same tick as one flying
  level.
- `arcHeightAt` still peaks at the midpoint of a shot whose target never moved,
  and a tracked shot's `progress` never goes backwards.
- `EffectiveStats.basicAttackId` comes from the main hand, defaults to
  `melee.slash`, and round-trips the codec; `PROTOCOL_VERSION` is 9.
- **A slinger opens at range** and a stalker still closes to melee, off the same
  intent code.
- **Determinism survives**: the same seed and inputs — a withdrawn wind-up and
  tracked shots included — replay to bit-identical state and events.

## Out of scope

- **Predicting a projectile client-side.** A shot is a replicated entity and is
  drawn from the deltas, as it has been since spec 062.
- **Projectiles colliding with terrain, walls or props.** A shot is stopped by a
  body or by its lifetime, and by nothing else.
- **A feint animation.** Withdrawing plays the cast-ended the client already
  draws; whether a body should visibly abort a swing is an animation question.
- **Retuning anything existing.** No `windupTicks`, damage or range in the
  current table moves; the new rows are there to exercise the two travel types.
- **Making the arc mechanical.** Flying over a body that would stop a flat shot
  is the obvious thing an arc could buy, and it is deliberately not bought here:
  the height is a look for now.
- **A real inventory.** The switch is three buttons over the equip path that
  already exists, not a bag, a paper doll, or a place items come from.
- **Ammunition, reloads, or a minimum range.** A bow is a weapon that names a
  different swing, and nothing more.
- **Bringing back the recovery lock** so that withdrawing has a cost beyond the
  time. Spec 068 removed it deliberately and this does not reopen it.
