# 190 — Damage over time: what is already in the blood

## Problem

Every point of damage this game has ever dealt arrives at the instant a blow
lands. `resolveBlow` is the only path (`blow.ts:103`), a `hit` event is the only
way a number reaches a client, and the only thing in the sim that repeats is a
**channel** — which is caster-bound: it needs the caster to still be standing
there holding it (`abilities.ts:1284-1315`). There is no way for a body to be
carrying something that hurts it after the thing that did it has walked away.

That closes off a whole register of decision. A wound you have to disengage from
is different from one you have to out-heal, and both are different from one that
gets worse the longer you keep fighting. None of the three is expressible today.

`sim/statuses.ts` is nearly the right home already — it is *"everything the
progression needs to remember about a body between ticks"*, with an expiry, a
stack count and a magnitude captured from whoever applied it. What it cannot
say is **who** put it there and **when it first landed**, and both of those are
load-bearing the moment a status can kill you.

## Shape

### One mechanic, seven rows

An affliction is `a rate + a cadence + a length`, and everything past that is a
**rider that reaches into a system this game already has**. So there is one
table, `data/damage-over-time.ts`, and one pass, `sim/damage-over-time.ts`.

```ts
export interface DotDefinition {
  readonly id: string;            // a StatusId, and the id on the wire
  readonly name: string;
  /** Damage a second, per stack, before the ramp and before the applier. */
  readonly damagePerSecond: number;
  /** How lumpy it arrives. The axis that separates a trickle from a burst. */
  readonly intervalTicks: number;
  /** How many pulses one application is worth. Duration is derived from these. */
  readonly pulses: number;
  readonly maxStacks: number;

  // --- the riders, one system each ------------------------------------
  /** Frostbite. The rate gains this fraction of itself per second held. */
  readonly rampPerSecond?: number;
  readonly rampCap?: number;
  /** Bleed. What a pulse is worth while the body is moving or committed. */
  readonly exertionScale?: number;
  /** Burn, Shock. How far a pulse looks for somebody to pass this on to. */
  readonly spreadRadius?: number;
  /** Corrosion. Guard taken a second, and the armour it strips while held. */
  readonly guardPerSecond?: number;
  readonly sunderMagnitude?: number;
  /** Decay. What healing is multiplied by while this is on. */
  readonly healingScale?: number;
}
```

Three numbers are derived and never authored, because two of them were where
the off-by-one lived:

```ts
dotPulseDamage(row)   = row.damagePerSecond * row.intervalTicks / SERVER_TICK_RATE
dotDurationTicks(row) = row.pulses * row.intervalTicks + 1
dotTotalDamage(row)   = dotPulseDamage(row) * row.pulses
```

The `+ 1` is the whole of the arithmetic. A pulse fires when
`elapsed > 0 && elapsed % intervalTicks === 0`, and `statusOf` refuses an entry
at `tick >= expiresAtTick` — so a duration of exactly `pulses * interval` loses
its last pulse to the expiry comparison. One tick of slack, stated once in the
derivation, is what makes "eight pulses of 4.5" mean eight.

### The cadence is a comparison, never a countdown

`StatusState` gains two fields:

```ts
/** Who applied it. 0 for a status nobody is responsible for. */
readonly sourceId: number;
/** The tick it FIRST landed. Kept across a refresh, reset by a fresh one. */
readonly appliedAtTick: number;
```

`sourceId` is the same argument `magnitude` already makes at the top of
`statuses.ts` — a status belongs to somebody else's stats — carried one step
further: an affliction can now *kill*, and `died.killerId` has nowhere else to
come from. It follows the magnitude rather than the clock: whoever's
application set the number that is actually doing the damage owns the kill, so
the credit and the number always describe the same body.

`appliedAtTick` is what makes the pulse a comparison rather than a stored
countdown, in exactly the shape the file's header already commits to for
expiry. It is kept across a refresh, which is three properties at once:

* refreshing a poison **cannot delay its next pulse** — a spammed refresh would
  otherwise push the cadence out forever and the affliction would never tick;
* refreshing a poison **cannot double-tick** it either;
* Frostbite's ramp measures from when the cold got in, so *"becomes dangerous
  if exposure continues"* is the refresh doing nothing to the escalation.

### A pulse is not a blow

`sim/damage-over-time.ts` is a new pass and does **not** call `resolveBlow`,
and that is the design rather than an omission. A pulse that went through the
blow pipeline would roll a crit sixty times a second (the Rng draw count is
protocol), refresh `RecentlyHit` continuously and deny Perfect Exit for the
whole duration, stack Adaptation per tick against an ability that does not
exist, and `provoke` a body that has already been provoked by the blow that
applied it.

What a pulse does instead, in order:

1. **asks whether the source may still hurt this body at all** — see below;
2. shield before health, the same absorb `resolveBlow` does;
3. **no armour, no adaptation, no resolve, no reads** — an affliction is
   already inside, and being the answer to a high-armour target is a role worth
   having;
4. a `hit` event, so the number floats, the metrics count it and the balance
   harness can see it (`foldMetrics` reads damage off `hit` and nothing else) —
   marked `periodic`, see below;
5. `InCombat`, so a burning player cannot walk into town and rest it off;
6. on a kill: **drops the cast the body was holding and announces it**, then a
   `died` event with `killerId: sourceId`, so `creditDeaths` pays the
   restoration, the assists and the loot exactly as a blow's kill does.

### The three things a pulse must not inherit, and the two it must

Which of `resolveBlow`'s side effects a pulse keeps is the whole of the design,
and three of the five decisions below were got wrong first and found by review.

**Hostility is re-asked every pulse, not only where the affliction landed.**
`isHostile` between two players requires *both* to be standing in a pvp zone,
and `world.ts` states why at length: reading only the attacker's zone lets
somebody reach into Hearthstead, and reading only the target's lets a target
retreat into safety mid-swing. Every blow and every projectile is measured at
the instant it lands, against where both bodies are then. An affliction is the
first damage in this game that outlives its own delivery, so it is the first
that could carry a wilderness fight across a safe-zone line — light somebody
up, follow them into town, watch them die there. An affliction with *no* source
— one a developer trigger applied — has no side to be measured against and
keeps ticking, because refusing it would make the trigger inert.

**Death drops the cast.** This is the first death in the game that is not a
blow, and `resolveBlow` clears `cast` and emits `castEnded` for a stated
reason: a client roots itself while it believes it is casting. Missing it was
not cosmetic. A player's entity survives death, the cast pass refuses a corpse
so nothing advances or cancels what it was holding, and `respawn` rewrites
eleven fields without touching `cast` — so a wind-up somebody died in came back
with them and **landed from the spawn pad on their first living tick**, at the
coordinates they had aimed at before dying, stamping the cooldown a second
time. Until it resolved, every attack they pressed was refused as
`alreadyCasting`.

**A pulse does not shout.** The `hit` event carries a sim-only `periodic` flag
and `rally` skips it. That function's whole bound is *"one hop per actual
blow"*; a poison ticking twenty times would raise twenty calls for the nest,
each from wherever the applier had walked to by then, so one dart would drag a
nest across the map for ten seconds. It is the same argument that keeps a pulse
away from `provoke`: the blow that applied the affliction already called
everyone it was going to call.

What a pulse **does** inherit is the assist mark — a player whose poison did
the work helped kill it — and `InCombat`, which is what stops the affliction
being rested off.

It draws **nothing from the Rng.** Spread picks the nearest eligible body and
breaks ties on entity id — the rule `crowd.ts` already uses — so adding an
affliction to a fight cannot shift a single draw in the world after it.

### Where it runs

A new pass, `3c`, between the projectiles and the kill credit. It has to be
after everything that can *apply* an affliction and before `creditDeaths`,
which is driven off this tick's `died` events. Corpses, projectiles, motes,
drops and bodies in chunks nobody is simulating are skipped, like every other
pass in the tick.

### The riders

Each one is a reader in the system it belongs to, never arithmetic in the DoT
pass:

| Rider | Reaches | Where |
|---|---|---|
| Bleed's exertion | `ActivityValue` | the replicated activity: `Moving` or `Casting` is exertion, `Idle` is not |
| Corrosion's armour | `StatusId.Sundered` | the DoT applies the status the game already has, so there is one armour-reduction reader and not two |
| Corrosion's guard | the poise pool | written directly and clamped at zero, so it **cannot break** — spec 188's `poise` effect, same argument. Authored against *regeneration* rather than against the pool: a monster gets back 6 guard a second, so the first cut's 6 a second cancelled exactly and the rider did nothing at all to a stationary body, which is the only body anybody would use it on |
| Decay's suppression | `applyHealing` | one multiplier at `healing.ts:57`, plus the three sites that bypass it |
| Burn / Shock's spread | `isHostile` | the nearest body hostile to the **source**, so a player's fire spreads through the pack and never back onto the player |

`healingScaleOf(statuses, tick)` is built to `moveScaleOf`'s shape and for its
stated reason: `EffectiveStats` is derived on equip, so a timed state living
there would either be recomputed per tick or go stale.

Health goes up in six places and only three of them go through `applyHealing`,
so the suppression is read at three sites rather than one — `applyHealing`
itself (which covers the flask, Mend, a skill's heal and a collected mote),
**Second Wind**, and the **weak-point-kill heal**. A suppression that only
covered the first would stop working at exactly the moment a Constitution build
needs it, which is the one moment anybody would notice.

Resting is deliberately *not* a fourth site, and it is not an omission: a pulse
stamps `InCombat`, and `advanceRest` already refuses outright while that is
live. A burning player cannot walk into town and heal it off — not at a reduced
rate, at no rate. That is stronger than a multiplier would have been, and it is
true of every affliction rather than only of Decay.

### Spread is one rule with two radii

Burn's *"can spread"* and Shock's *"can jump to nearby targets"* are the same
question — how does an affliction reach the body next to it — and a second
propagation system would be two answers to it. So there is one field,
`spreadRadius`, and Burn carries 90 while Shock carries 150.

On a pulse, the affliction passes **what is left of itself** to the nearest
body within that radius that is hostile to its source and is not already
carrying it. That single sentence is also the bound: a hop is taken on a pulse,
so it is always strictly shorter than its parent, and the chain therefore
terminates by construction with no generation counter, no hop limit and no
roll. Fire that has almost burnt out spreads almost nothing.

### Reaching it: the effect verb, and a stranded path closed

`SkillEffect` gains one member, and it carries one field:

```ts
| { readonly kind: 'applyDot'; readonly dotId: string }
```

No per-skill duration, no per-skill rate. **The row is the affliction, whole.**
An affliction whose numbers depend on which skill happened to apply it is one
the player carrying it cannot reason about, and "content is data" means the
data is the content. What *does* vary is the applier: their `spellPower` is
captured into `magnitude` at the moment it lands, the way Exposed already
captures the exposer's own coefficient.

Two paths in `sim/abilities.ts` silently drop `ability.effects` today, and both
have to be closed or half the new skills are dead rows:

* **`kind: 'projectile'`** — impacts resolve in `world.ts` and call
  `applyDamage` directly (`world.ts:1214`, `:1224`), never the effects seam.
  Spec 188 listed this as out of scope; Poison Dart is a ranged skill, so it is
  in scope now. `applyToTarget` is exported and both call sites go through it.
* **`kind: 'self'`** — `landSelf` reads `healing` and `healingFraction` and
  nothing else. A self-targeted skill's effect list runs now.

And `aimShape` gains a case for `ability.area`, which it has never read: an
`area` skill aimed at a point or a direction drew no telegraph at all, which
made the one skill kind that *is* a shape the one kind you could not see.

### Seven skills, because seven afflictions with no applier is seven dead rows

One sigil each, one loot entry each, and between them they exercise every
landing path — which is the point: if a landing path cannot deliver an
affliction, that is a stranded path and this spec exists to not leave any.

| Skill | Kind | Affliction |
|---|---|---|
| Poison Dart | projectile, `unit` | Poison — a stack, and the clock refreshed |
| Ember Toss | projectile with a burst | Burn |
| Rending Cut | melee, `unit` | Bleed |
| Acid Spray | melee cone, `direction` | Corrosion |
| Arc Lash | area line, `direction` | Shock |
| Rime Touch | area circle at the caster | Frostbite |
| Blight | ground, `point` | Decay |

### The test row that marks everything

`skill.testStatuses` — the other spec 190, merged while this was being written —
exists to put **every mark the client can draw** on one body in one press, and
its own note says a new row in `STATUS_VISUALS` is a new line in it. Seven new
rows, so it gains seven lines.

They are the one group in that row applied through `applyDot` rather than
`applyStatus`, and both reasons are that row's own rules read back. An
affliction written through `applyStatus` draws a mark and never pulses — a body
drawn burning that is not burning, which is the `Slowed`-at-full-speed lie those
magnitudes were chosen to avoid, in its worst form. And an affliction has a
source, a cadence and a first-landed tick that only `applyDot` establishes.

So they arrive **whole**, at their own lengths rather than the row's shared
window: a test Burn is the Burn, because "the row is the affliction" is what
lets anybody reason about one, and a weakened private Burn would be a mark for
something the game does not have. What it costs is real damage over time, which
a training dummy's hundred thousand health absorbs without noticing.

### Respawn

`respawn` never cleared `statuses`, which nothing had ever noticed because no
status could hurt you. A player who died burning would have come back burning
and taken the next pulse on the spawn pad. Afflictions are cleared there —
afflictions only, so a player does not lose the Flow or the Attunement they
built, which is not what death is meant to cost.

## Invariants tested

* A pulse lands every `intervalTicks` and never on the tick the affliction was
  applied; an application is worth exactly `pulses` pulses and
  `dotTotalDamage(row)` in total.
* Refreshing an affliction moves its expiry, adds a stack up to `maxStacks`,
  and **does not** move its `appliedAtTick` — so the cadence and the ramp both
  survive a refresh, and a refresh every tick neither delays nor duplicates a
  pulse.
* An affliction that has fully expired and is applied again is a fresh one: the
  ramp restarts and the stack count starts at one.
* Stacks multiply the rate; the ramp multiplies it and is capped; exertion
  multiplies it only while the body is `Moving` or `Casting`.
* A pulse spends shield before health, and is reduced by **no** armour,
  adaptation, resolve or flow.
* A pulse emits a `hit` event whose `attackerId` is the source, so the number
  floats and `foldMetrics` counts it as damage dealt and damage taken.
* A pulse that kills emits `died` with the source as `killerId`, and the kill
  is credited, looted and paid exactly as a blow's kill is.
* A pulse draws nothing from the Rng: the same seed and inputs produce
  bit-identical state with afflictions in play, and the draw count is unchanged
  from the same fight without them.
* A corpse, a projectile, a mote, a drop and a body in an unsimulated chunk
  never pulse.
* A pulse whose source may no longer hurt the target — the target reached a safe
  zone — deals nothing, and stops dealing anything for as long as that holds; an
  affliction with no source at all keeps pulsing.
* A pulse that kills a body holding a cast clears that cast and emits
  `castEnded`, so a respawned player cannot fire the wind-up they died in.
* `rally` answers a blow and ignores a pulse, judged over one world so the flag
  is the only difference between the two.
* Corrosion's guard drain outruns poise regeneration in a real tick, and still
  never breaks the guard.
* Spread reaches the nearest body hostile to the **source**, never the source's
  own side, never a body already carrying it, and never more than one body per
  pulse; every hop is strictly shorter than its parent, so a fire in a crowd
  goes out.
* Decay multiplies healing at `applyHealing`, at Second Wind and at the
  weak-point-kill heal, and never to zero.
* A body carrying any affliction cannot rest, because a pulse stamps
  `InCombat`.
* Corrosion applies `Sundered` and takes guard without ever breaking it.
* `applyDot` is the only way a skill applies one, and it applies the row whole.
* A `kind: 'projectile'` skill's effect list runs on impact — both on a direct
  hit and inside a burst.
* A `kind: 'self'` skill's effect list runs.
* Every `skill: true` ability is named by exactly one sigil, and every
  `activeSkillId` names a real ability row.
* Every DoT id has a `STATUS_VISUALS` row, a distinct wire index and a glyph.
* Respawning clears afflictions and leaves boons alone.
* The test row still leaves **every** `STATUS_VISUALS` mark live on one body,
  with the nine it authors sharing one window and the seven afflictions each
  holding the length their own row states.
* `presentation-only` still holds with afflictions in play.

## Out of scope

* **Resistances by damage type.** There is no type channel anywhere — `hit`
  carries no ability and `view.ts` hard-codes `damageType: 'physical'` for
  every blow — and inventing one for seven rows would be a second mitigation
  system beside `armor`. Adaptation is per *ability*, and an affliction has no
  ability, so it is deliberately not adapted to either.
* **Cleansing.** `removeStatus` already exists as an effect verb and reaches
  every one of these; a cure item, a dispel priority or "the rain puts it out"
  are content decisions, not a mechanic this needs.
* **A per-blow damage-source channel on the wire.** A burn's floating number
  looks like any other number, because `CombatResult` has no room to say
  otherwise and widening it is its own spec. The mark over the head is what
  says which affliction is running.
* **Afflictions on monsters' own attacks.** Every row here is reachable through
  a skill; a monster that applies one is a row in `MONSTERS` and needs nothing
  new.
* **Stacking `magnitude` between two appliers.** It is a max, as it has been
  since spec 147. Two poisoners do not add.
