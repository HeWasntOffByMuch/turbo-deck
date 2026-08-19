# 184 — Active skills, assembled rather than written

## Problem

The game has a complete cast lifecycle — commit, turn, wind up, attack point,
backswing, withdraw — and every ability in it is a *fixed* row: one number for
damage, and whatever `landAbility`'s five-way switch does with it. There is no
way to say "and apply Slow for two seconds", no way for a skill to cost
anything but pool and flask charges, no way to aim a circle at the caster's own
feet, and — the one that matters most — **no check anywhere that a player is
allowed to cast what they asked for.** `STARTING_ABILITIES` has been exported
and read by nothing since spec 062, so any client can send `ground.quake` on
its first tick.

The four slots along the bottom of the HUD have been empty since spec 164 and
say so on purpose: "a slot with nothing in it is a place a skill will go". This
is the spec that puts something in them.

## Shape

An active skill is **an ability the player carries as an item**. Nothing new is
introduced that an existing system already answers:

| The brief asks for | What answers it |
|---|---|
| damage | `resolveBlow` (`sim/blow.ts`), unchanged |
| attack wind-up / `castTime` | `AbilityDefinition.windupTicks`, unchanged |
| `castAngle` | `facesAim`'s existing epsilon, made per-ability |
| targeting | `AbilityTargeting`, plus a new `area` block for shapes |
| cooldowns | `ServerEntity.cooldowns`, unchanged |
| pool cost | `AbilityDefinition.cost` + `resourceCostFor`, unchanged |
| Guard | poise (`EntityField.Poise` is *called* "Guard left") |
| Stun | the poise break's `ActivityValue.Stunned` window |
| Slow | one new id in the existing `Statuses` map |
| inventory / trade / loot | `ItemDefinition` + `applyMove`, unchanged |
| networking | `UseAbility` and `MoveItem`, unchanged |

### The definition

`AbilityDefinition` gains four optional fields. Every existing row leaves all
four absent and behaves exactly as it does today.

```ts
/** How closely the caster must be pointing before the wind-up may start. */
readonly castAngleDeg?: number;
/** Costs beside pool and charges. Spent at the commit, refunded by a withdrawal. */
readonly costs?: SkillCosts;      // { health?: number; poise?: number }
/** Who a landing picks, when the answer is a shape rather than a body. */
readonly area?: SkillArea;
/** What happens to each of them. Absent means "the damage, as before". */
readonly effects?: readonly SkillEffect[];
```

and one new `AbilityKind`, `'area'`, whose landing reads `area`.

```ts
export type SkillArea =
  | { shape: 'circle'; origin: 'caster' | 'aim'; radius: number; maxTargets?: number }
  | { shape: 'cone';   angleDeg: number; range: number; maxTargets?: number }
  | { shape: 'line';   width: number;   range: number; maxTargets?: number };

export type SkillEffect =
  | { kind: 'damage';       amount?: number; multiplier?: number }
  | { kind: 'poiseDamage';  amount: number }
  | { kind: 'stun';         ticks: number }
  | { kind: 'applyStatus';  statusId: string; durationTicks: number; magnitude?: number; maxStacks?: number }
  | { kind: 'removeStatus'; statusId: string }
  | { kind: 'heal';         amount?: number; fraction?: number }
  | { kind: 'resource';     amount: number }   // + restores, - consumes
  | { kind: 'poise';        amount: number };  // + restores, - breaks guard
```

An effect is a *verb over an existing system* and nothing else. `damage` hands
`resolveBlow` the same row with its damage replaced, so crit, weak points,
armour, adaptation, shields, poise and the whole aftermath apply to a skill
exactly as they apply to a swing. `stun` and `poiseDamage` both end at
`sim/poise.ts`'s `stagger`, which is spec 147's break lifted out of `blow.ts`
so that the two callers cannot come to different answers about what a stagger
does.

### The item

A skill item is an `ItemDefinition` with `slot: 'skill'` and an
`activeSkillId` — the same shape `bow.hunting` already uses to name
`ranged.shot`, and for the same stated reason: a bow is a row in a table rather
than a class.

`EquipSlot` gains `skill1..skill4`, appended (the order is the wire order).
`ItemDefinition.slot` widens to `EquipSlot | 'skill' | null`, and
`equipRefusal` compares slot *families*, so one `slot: 'skill'` item fits any
of the four and nothing else fits any of them.

Everything else about carrying a skill is already built: it drops through
`data/loot.ts`, trades through `player/trade.ts`, moves through `applyMove`,
and persists in `Equipment` because that is what `Equipment` is.

### Authority

`EffectiveStats` gains `skillAbilityIds` — derived from the four slots exactly
as `basicAttackId` is derived from the main hand, replicated on the same
message, never read from a client. `startCast` refuses an ability that names
itself a skill and is not in that list. **This is the first ownership check the
ability system has ever had**, and it closes `ground.quake`-on-request too:
every ability with `skill: true` is gated, and the ungated remainder is the
basic attacks and the flask.

### Swapping

Four slots, and a swap is not free:

* refused outright while the outgoing skill is on **cooldown**, while dead, or
  while another swap is in flight;
* delayed by `SKILL_SWAP.durationTicks`, served from a queue on the connection
  the way spec 172's drop is, so it cannot be instantaneous in a fight;
* answered with a status — `SKILL_SWAP.statusId`, `Vulnerable` today, an
  existing status with an existing reader — so being caught with your pack open
  costs something.

### A swap is a commitment, not a timer

The first cut made a swap *take* a second and a half and showed none of it: the
player clicked, nothing happened, and the bag changed later. A delay nobody can
see is not a cost, it is a bug report waiting to be filed — so the wait is a
**state the body is in** and it is visible in all three places the change is
about.

`ActivityValue.Swapping` is that state. It rides the field `activity` already
rides, so every client sees it and nothing new is replicated for it, and it is
a **claim on the body**: anything that takes the body takes the swap with it.
Walking away drops it (the movement pass, exactly as asking to move withdraws
from a wind-up), a poise break writes `Stunned` over it, a cast writes
`Casting`, and death writes `Dead`. `serveSwaps` watches for the claim going
away rather than enumerating those causes, so a fifth cause arriving later
cannot silently fail to cancel anything.

What each surface shows, and why they differ:

| Surface | Shows | Driven by |
|---|---|---|
| the bag's cells | which two slots, and the **direction** — red leaving, green arriving | `pendingSwap`, owner-only |
| the action bar | which slot, and the **word**: `EQUIPPING` / `SWAPPING` / `REMOVING` | `pendingSwap`, owner-only |
| the body | *that* a change is happening, and how far through | `activity`, everyone |

The split is deliberate. Which slot and which direction are facts about a bag,
and a bag is its owner's business; that a player is busy is a fact about the
world. `SkillSwapKind` — `Equip` / `Swap` / `Unequip` — is derived on the
server from its own containers and never chosen by a client.

`PendingSkillSwap` rides on `Inventory`, which is the message that already
carries containers whole: a swap being asked for, landing, or being given up
are all container events, and two messages for one event is two things to keep
in step. It carries both ticks rather than a fraction, so the client fills a
bar by comparison the way the loot reveal does, with no ticking message and no
clock of its own.

**One ordering is load-bearing.** `expireActivity` drops the claim on the tick
`activityUntilTick` is reached, and `serveSwaps` runs after the sim in that same
tick — so the claim must be checked only *while the clock is still running*, or
every swap is given up on the tick it was due to land.

## Invariants tested

* A skill on cooldown cannot be cast, and the refusal names the cooldown.
* A skill cannot be cast without the pool, the health or the poise it costs,
  and each refusal names which.
* Every cost is consumed at the commit and **refunded whole by a withdrawal**,
  poise and health included.
* A `targeting: 'unit'` skill with no target, with a dead target, or with a
  target out of range is refused or misses — at the stage the existing code
  already checks it (commit for range, release for the target being gone).
* `castAngleDeg` decides whether a cast starts in `Turning` or in `Windup`, and
  a body outside the angle does not begin its wind-up until it has come round.
* An area skill hits only hostile candidates inside its shape, honours
  `maxTargets`, and never hits its caster.
* The cooldown is stamped **at the attack point and nowhere else**: a
  withdrawal leaves the skill ready, a landed cast does not.
* An interrupted channel still leaves the cooldown running.
* Statuses are applied and removed through `sim/statuses.ts` and nowhere else.
* A skill ability not in `stats.skillAbilityIds` is refused server-side even
  when the client asks for it directly.
* A skill slot holding a skill on cooldown refuses every move that would empty
  it — into the bag, into another slot, or by swapping something else in.
* A swap does not take effect on the tick it is asked for, and the player
  carries the swap status while it is in flight.
* The body is in a replicated `Swapping` state for the whole change and free
  again once it lands.
* Walking away gives the swap up, and the skill stays where it was however long
  the clock is left to run.
* The client is told what is in flight — which slots, which kind, both ticks —
  and told nothing once it ends.
* The kind is `Equip` into an empty slot, `Unequip` out of one, and `Swap` when
  the destination is occupied or both ends are skill slots.
* Progress is clamped at both ends, so a drawn tick either side of the server's
  cannot draw a bar past full or below empty.
* A cell accepts a **family**: one `slot: 'skill'` sigil fits any of the four
  skill slots, a sword fits none of them, and a sigil fits no weapon slot.
* An item that is not a skill cannot go in a skill slot, and a skill cannot go
  in a weapon slot.
* Determinism: the same seed and inputs produce the same state with skills in
  play, and `presentation-only` still holds.

## Out of scope

* **Knockback.** There is no forced-movement system in the sim — position is
  written by `resolveMovement` from an intent — and inventing one inside an
  effect list would be the "one-off gameplay code" this spec exists to avoid.
  The effect vocabulary has room for it the day the system exists.
* **Projectile-delivered effect lists.** `kind: 'projectile'` still resolves as
  it does today; an effect list on one would have to ride the projectile
  entity. The four initial skills do not need it.
* **A skill tree, ranks, or affixes.** A skill is a definition id, exactly as
  every other item in this game is.
* **Dragging a skill from the bag with a mouse into the HUD bar.** The bag's
  four slots are the interface; the HUD's four mirror them.
