# Effects with no visual representation (audit, 2026-08-18)

> **Status, 2026-08-19.** Finding 1 is **closed** by spec 185: eight of the
> twelve statuses now ride a tenth entity field and are drawn as marks over the
> body, on the stun icon's stateless pattern. The other four are withheld
> deliberately and the note below is now the record of *why*. Finding 2 is
> **one step shorter** -- `aurasFor`'s `statuses` parameter can now be fed, but
> the tracker is still mounted by nothing. Everything else stands.

Traced against `main` at 70b1134. A map of *what the sim does that nothing
draws*, not a spec — every finding below is a statement about the code as it
stands, with the file and line that supports it.

The organising fact, which explains most of the list: **the progression system
spec 147 built is almost entirely status-driven, and there is no status on the
wire.** Everything downstream of that is a consequence.

---

## 1. The status layer is invisible end to end

`src/server/sim/statuses.ts` defines twelve status ids plus a per-ability
`adapt:<id>` family. `ServerMessageType` (`net/protocol.ts:139-238`) has
twenty-two entries and **none of them carries a status**. `ReplicatedEntity`
(`client/replica.ts:19-44`) has id, kind, typeId, position, facing, health,
maxHealth, activity, activityUntilTick, level, name, turnRate, poise, shield,
shieldUntilTick — and no status list.

`world/auras.ts:20-31` already says this in as many words, and has since spec
121: *"no status is replicated ... there is no buff or debuff list on the wire
at all."*

So every one of these was a live mechanic with no picture, no icon, no readout
and no wire field. **Spec 185 has since replicated the eight marked "now shown"
below**; the four marked "withheld" stay off by the rule that the wire carries
conditions somebody could point at, not the timers the sim keeps for itself:

| Status | Attribute | What it does | Seen by |
|---|---|---|---|
| `flow` (now shown) | Agility | Stacking backswing cut, damage reduction, weak-point chance | nobody |
| `momentum` (now shown) | Str+Agi | A break shortens the next wind-up | nobody |
| `prepared` (now shown) | Intelligence | Stillness primes the next cast (halves wind-up at the milestone) | nobody |
| `exposed` (now shown) | Perception | Target takes +15% from **everyone** | nobody |
| `vulnerable` (now shown) | Perception | A committed enemy takes double weak-point chance | nobody |
| `sundered` (now shown) | Str+Int | Armour reduced | nobody |
| `attuned` (now shown) | Wisdom | Stacking cost reduction on the next cast | nobody |
| `adapt:<ability>` (now shown, collapsed) | Wisdom | Stacking resistance to a repeated ability, up to 30% | nobody |
| `secondWind.spent` (withheld) | Constitution | Whether the comeback heal has re-armed | nobody |
| `perfectExit.spent` (withheld) | Agility | Whether Perfect Exit has re-armed | nobody |
| `recentlyHit` (withheld) | Agility | The 0.2s window Perfect Exit reads | nobody |
| `inCombat` (withheld) | — | Gates resting | nobody |

Two of these are worse than the rest because they are **cross-player by
design**. `per.huntersEye` is described as *"What you have marked stays marked,
for everyone"* and the Weak-Point Study milestone as *"everything takes 15% more
damage against it"* — a party-wide debuff that no party member can see. The same
goes for `exposedTeamResource`.

Scale of the gap: 36 skills in `data/skills.ts`, of which **28 name a trigger**
rather than being passive; 18 milestones; 15 synergies. The great majority
resolve into one of the statuses above.

## 2. The aura system is built, tested, and mounted by nothing

Eight aura effects are authored — `library.ts:811-820`: `aura_selected`,
`aura_buff`, `aura_debuff`, `aura_poison`, `aura_shield`, `aura_heal`,
`aura_channel`, `aura_telegraph`. `world/auras.ts` holds the decision function
and the start/stop diffing.

**`aurasFor` and `AuraTracker` are called by no production file.** The only
references outside `auras.ts` itself are in `auras.test.ts` and
`vfx/library.test.ts`. Nothing in `scene.ts` or `view.ts` imports either.

This is worth separating from finding 1, because three of the eight need no
protocol change at all — `selected`, `channelling` and `telegraphing` are facts
this client already has, and `AuraFacts` is built around exactly that. The ring
under a selected target, the ring under a channelling body and the ring under an
incoming blast are all authored, all reachable, and all unplayed.

## 3. A weak point is indistinguishable from an ordinary hit

`ServerSimEvent`'s `hit` carries `weakPoint` (`sim/types.ts:617-622`), with a
comment explaining precisely why it is not the same as a crit: *"a crit is a
bigger number, a weak point is a bigger number and an opening left behind that
anybody can use."*

`CombatResultMessage.flags` is `u8` with three bits defined
(`net/messages.ts:798`): `bit 0 = killing blow, bit 1 = critical, bit 2 =
blocked`. `server.ts:2356-2357` builds it from `killed`/`critical`/`blocked`
only. **`weakPoint` is dropped at the wire.**

Consequences: `per.weakPointStudy`, `per.openingRead`, `per.exploit`,
`per.resourceSense`, `flowWeakPoint`, `abilityWeakPoints`,
`vulnerableWeakPointFactor` and `attunedFromWeakPoints` all resolve to a number
that looks like every other number. Perception is the one attribute whose entire
identity is a per-blow event, and the blow message cannot express it. The bit is
free — `flags` has five spare.

## 4. Shield is replicated and nothing draws it

`ReplicatedEntity.shield` and `.shieldUntilTick` are on the delta
(`client/replica.ts:41-43`). Grepping `src/render/` and `src/ui/` for `.shield`
returns **no production reference at all** — not in `hud.ts`, not in
`pool-bars.ts`, not in `health-bar.ts`, not in `scene.ts`.

So `con.overflowVitality` ("Healing past full becomes a shield, up to a quarter
of your health, for 8s") and Intelligence's `damageToShield` produce an absorb
pool that changes how much damage you take and is drawn nowhere — while
`aura_shield` sits authored and unplayed in the library. This is the cheapest
fix in the audit: the data is already at the client.

## 5. Five of the six damage types cannot be reached

`vfx-wire.ts:72-90` defines `DAMAGE_EFFECTS` over six types and `DAMAGE_DEBRIS`
beside it. The single production call site, `view.ts:932-946`, hardcodes:

```ts
damageType: 'physical',
...
bleeds: true,
```

Both are constants at the only place `effectsForBlow` is ever called. So
`hit_fire`, `hit_poison`, `hit_ice`, `hit_lightning` and `hit_arcane` are
authored and unreachable — and because the debris branch is
`if (debris && !facts.bleeds)`, so is `impact_physical`. Six authored effects
behind two hardcoded literals.

This is the seam the module's own header says the arc was built around
(*"adding an effect for a new damage type is an entry in `DAMAGE_EFFECTS`"*).
The table is fine; nothing fills in its argument.

## 6. `blocked` means "armour reduced this" and is drawn as a guard

`sim/blow.ts:232` sets `blocked: armor > 0 && damage < raw` — true for *any*
blow against *any* armoured body. The ravager has `armor: 0.18` and the stalker
`0.05` (`data/monsters.ts:163,188`); a player's armour comes from Constitution
and Agility (`derived.ts:414-417`).

`vfx-wire.ts:210-214` treats it as a parry and **returns early**:

```ts
if (facts.blocked) {
  out.push(at('hit_block', 1, 0.85));
  return out;
}
```

So every hit on a ravager draws the block flash and **no blood, no debris, and
no `hit_critical`** — a crit on an armoured target is visually a non-crit. Two
mechanics (bleeding, critical) are suppressed by a third that is being drawn as
something it isn't. Either the flag needs renaming to what it measures, or the
visual needs to stop being an early return.

## 7. Every ability impact falls through to the debug disc

The server emits `` `${ability.id}.impact` `` (`sim/abilities.ts:1339`,
`sim/world.ts:884,917`) and `` `${ability.id}.self` `` (`abilities.ts:1380`).
The eleven ability ids are `melee.slash`, `melee.heavy`, `ranged.shot`,
`ranged.star`, `bolt.arcane`, `bolt.lob`, `bolt.seek`, `ground.quake`,
`self.mend`, `self.hearthdraught`, `channel.drain`.

**Not one dotted id exists in the VFX library.** `LIBRARY` holds 45 effects and
none of them is ability-shaped. `scene.addEffect` (`scene.ts:1074-1100`)
therefore takes its fallback branch: a `CircleGeometry` in `PALETTE.torchCore`
at opacity 0.4, flat on the ground.

The two `.self` heal ids are correctly suppressed by `REDUNDANT_SERVER_EFFECTS`
(`vfx-wire.ts:119-122`, filtered at `view.ts:966`). The `.impact` ids are not.
So `ground.quake`'s 140-unit blast, `bolt.lob`'s 90-unit burst and every arrow
landing draw an orange debug circle. `explosion_ground`, `explosion_small`,
`explosion_large`, `explosion_directed` and `shockwave_ring` are all authored
and unplayed.

## 8. A miss produces nothing at all

`sim/abilities.ts:1262,1318` emit `{ kind: 'attackMissed', attackerId }` when a
swing connects with nothing. `server.ts:2482-2484` handles it with a bare
`break`, there is no wire message for it, and no render file mentions it.

A whiffed swing and a swing that never happened are the same picture. Given that
the wind-up is the decision this whole game is built on, the moment it *fails*
is arguably the single most important thing to draw.

## 9. `poiseBroken` carries a breaker nobody tells

`sim/blow.ts:258` emits it. Nothing dispatches it — only `sim/metrics.ts:179`
reads it, and that is the offline balance harness.

The **victim's** side is fine and deliberate: a break always writes
`activity: Stunned` and `activityUntilTick` (`blow.ts:248-251`), both
replicated, and spec 173's `stagger-flinch.ts` and `stun-icon.ts` draw off
exactly that. What is lost is `breakerId` — the body that *caused* the break
gets no feedback for it, which is the payoff half of Strength's whole identity
(`str.crushingBlows`, `breakResource`, `breakCooldownRefund`, and the Momentum
synergy that keys off it).

## 10. The restoration event's reasons never leave the server

The meter and charges do reach the client, by a separate polling path
(`server.ts:1431-1437`, `ServerMessageType.Restoration`), and the charges are
drawn on the vial (`hud.ts:1229-1237`).

The `restoration` **sim event** (`sim/world.ts:1232-1242`) is a different thing
and is dispatched nowhere. It carries `progress`, `sources`, `guaranteed` and
`assist` — the five qualifying actions `sim/restoration.ts` computes a kill's
worth from. A player can see the meter move and can never see *why* it moved by
that much, which is the readable-decision property the rest of the combat design
is built on.

Note that the meter being a readout line rather than a bar is **deliberate and
stated** (`hud.ts:1366-1369`, spec 156): a client that knew the absolute
threshold could work out which kill produces the next mote. That one is not a
defect.

## 11. Authored effects nothing plays

Twenty of the library's 45 top-level effects have no production caller. Beyond
the aura and damage-type ones already counted:

- **Fire**: `fire_burning_unit`, `fire_ground_patch`, `fire_trail`, `fire_ignite`
- **Explosions**: `explosion_large`, `explosion_small`, `explosion_directed`, `explosion_ground`, `shockwave_ring`
- **Death**: `death_dissolve`, `death_collapse`, `death_ash` (only `death_blood`, from `registry.ts:198`, is played)
- **Footfall and motion**: `puff_footstep`, `puff_footstep_sand`, `puff_footstep_snow`, `puff_splash`, `puff_landing`, `puff_teleport`, `puff_debris`, `puff_steam`
- **Other**: `cloud_poison`, `smoke_extinguish`, `slash_arc`, `impact_flash`

`slash_arc` is the notable one: a melee swing has no arc drawn through it, and
the effect for it exists.

---

## Deliberate, listed so it is not re-flagged

- **Synergies are never named on the sheet** — a stated rule with tests behind
  it in two places (CLAUDE.md, `progression-tables.test.ts`). Discovery is the
  feature. Worth separating from "a synergy firing has no *in-world* tell at
  all", which is finding 1 and is not deliberate.
- **The aggro `Alert` state is not replicated** — CLAUDE.md states the tell is
  "the body turning to face you and standing still, and facing already
  replicates" (spec 163).
- **The restoration meter is a readout, not a bar** — see finding 10.
- **`self.mend.self` / `self.hearthdraught.self`** are suppressed on purpose.

## The cheap end

Ordered by cost, not by importance:

1. **Shield** — data is already at the client; needs a bar and/or `aura_shield`.
2. **`weakPoint`** — one spare bit in a `u8` that is already sent.
3. **Mount the auras** — three of the eight need no protocol change.
4. **`damageType` / `bleeds`** — two hardcoded literals at one call site;
   `ItemDefinition`/`AbilityDefinition` are shared code, so the client can
   derive both the way `ProjectileLook` already is.
5. **`attackMissed`** — one message, or fold it into the existing cast-ended path.
6. **`.impact` ids** — either author them or add them to
   `REDUNDANT_SERVER_EFFECTS`, so the debug disc stops shipping.
7. **`blocked`** — decide whether it means armour or a guard, and stop it
   early-returning past blood and crit.
8. ~~**The status layer**~~ — **done** (spec 185). Protocol 18 carries eight of
   the twelve on a tenth entity field, drawn as marks on the stun icon's
   stateless pattern.
