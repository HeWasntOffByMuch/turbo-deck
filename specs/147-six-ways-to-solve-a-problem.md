# 147 — Six ways to solve a problem

## Problem

There are four stats, they are `strength`, `dexterity`, `intelligence`,
`vitality`, and every one of them is a coefficient. `HP_PER_STRENGTH * strength`,
`CRIT_PER_DEXTERITY * dexterity`, `SPELL_DAMAGE_PER_INTELLIGENCE * intelligence`,
`HP_PER_VITALITY * vitality`. Nothing a player can spend a point on changes what
they are able to *do*; it changes how big a number is. A character sheet with
four sliders on it that all mean "slightly more" is not a build system, and the
question it asks the player is "how much?" rather than "how?".

They are also not allocatable. `DEFAULT_BASE_STATS` is five of each and there is
no message that changes it -- the only progression a character has is
`unspentSkillPoints` against a twelve-row tree whose two outer branches lock each
other out, which is the opposite of a system that rewards unusual combinations.

This spec replaces the four with six, makes them allocatable and respecable
server-side, and -- the part that matters -- gives each one a small number of
**mechanics** rather than coefficients: things that change what happens, when it
happens, what may be cancelled, what a blow does besides subtract health, and
what a build's route to staying alive actually is.

The rule the whole thing is reviewed against:

> **Every attribute must be viable when heavily invested in, and every pair must
> create at least one interaction that is not "both numbers are big".**

The player-facing question is not "what class are you" but **how do you want to
solve problems**.

---

## A. Existing architecture findings

Read before designing. What is already here, and where this plugs in.

| System | File | What it already does | Extension point |
|---|---|---|---|
| Base stats | `state/types.ts` `BaseStats` | four numbers, persisted verbatim, never recomputed | becomes six; still the *input* to the pipeline |
| Derivation | `player/stats.ts` `computeEffectiveStats` | one pure pass: base stats + summed modifiers -> `EffectiveStats` | one more pure stage after it |
| Modifier currency | `data/modifiers.ts` `StatModifier` | flat bundle summed field-wise; skills and items both speak it | new fields; milestones and synergies speak it too |
| Skill rules | `player/skills.ts` | budget / tier gate / branch lock, all server-side, rejection leaves the record byte-identical | copied wholesale for attributes and stat skills |
| Recalculation funnel | `player/player-manager.ts` `recalculate` | the *only* place a stat is written; login/equip/unequip/spend | two more callers: allocate, respec |
| Attack timing | `sim/attack-timing.ts` | HoN model: interval, attack point, backswing, one factor | the seam Agility acts through |
| Cast lifecycle | `sim/abilities.ts` | `startCast` / `advanceCast` / `cancelCast`, windup vs backswing cancellation | cost, range, geometry, hyper-armour, follow-ups |
| Damage | `sim/abilities.ts` `applyDamage` | the **one** place a blow lands: crit roll, armour, death | weak points, poise, shields, statuses |
| Tick | `sim/world.ts` `step` | movement pass, cast pass, projectiles, sweep | one new pass for timers |
| Wire | `net/messages.ts` `StatsMessage` | level, xp, unspent points, skills, `EffectiveStats` | + base stats, + attribute points, + traits |
| Client read model | `world/character-model.ts` | turns replicated facts into `CharacterView`; calls the *server's* `validateSkillSpend` so a greyed button and a refusal cannot disagree | same trick for attributes |

Two repository rules constrain everything below. `player/`, `data/`, `sim/`,
`state/` are the deterministic core -- no clock, no randomness except the passed
`Rng`, lint-enforced. And `src/ui/` may not import the sim at all, so anything a
screen needs has to be turned into plain rows by `world/character-model.ts`.

### What replaces the branch tree

Spec 056's `SKILLS` tree -- Might, Finesse, Arcane, where investing in one of the
outer two permanently forecloses the other -- **is deleted**, and the 36 attuned
skills are the only tree. Keeping both was considered and is wrong twice over: a
system whose whole premise is that unusual combinations should be discoverable
cannot also tell a player which third of it they may never have, and two skill
systems sharing one budget is two sets of rules to keep honest for no benefit a
player can name. A save holding `might.*` rows loads with them dropped by
`sanitizeSkills` and the points returned as `unspentSkillPoints`.

---

## B. Six attributes

`dexterity` becomes `agility` and `vitality` becomes `constitution` -- a rename,
not a redesign, because having the code say `dexterity` while the sheet says
Agility is exactly the drift this repo does not tolerate. `perception` and
`wisdom` are new.

Each entry below lists what the attribute owns, how a character built on it stays
alive (**routes to sustainability** -- every build needs one and they must not be
the same one), and what it deliberately does not own.

### Strength — Overpower

- **Owns**: poise damage dealt (`staggerPower`), stagger duration, hyper-armour
  during committed attacks, attack damage, a little health.
- **Sustain route**: *ends the fight*. Staggered enemies do not attack; a poise
  break interrupts a cast outright. Overkill and executions convert force back
  into resource. Strength survives by removing the thing that was hurting it.
- **Does not own**: health pools (Constitution), attack rate (nothing does --
  spec 091 took the cadence off the weapon and 144 built over that), armour.

### Agility — Outmaneuver

- **Owns**: animation length -- the attack point and the backswing -- weapon
  handling (projectile wind-ups), move speed, turn rate, and `flow`.
- **Sustain route**: *is not there*. Agility never shortens the attack
  **interval**; it shortens the fraction of the interval the body is rooted for.
  A high-Agility character attacks exactly as often as anyone else and spends far
  less of each cycle unable to move.
- **Does not own**: crit (moved to Perception), attack speed, damage.

The single most important line in this spec: **Agility shortens the animation,
never the interval.** The brief's "do not make Agility the mandatory universal
DPS stat" is not a balance target here, it is a structural property -- there is no
field Agility writes that `intervalTicks` reads.

### Intelligence — Manipulate

- **Owns**: spell power, spell *geometry* (radius and range), `prepared` casting,
  catalysis (damage against afflicted targets), and arcane overflow -- paying for
  a cast with health.
- **Sustain route**: *changes the encounter*. Bigger blasts and longer range mean
  fewer things reach you; `sundered` and `exposed` make everything you and your
  allies throw land harder, so fights are shorter without more damage per hit.
- **Does not own**: general resource efficiency (Wisdom's), cooldowns (Wisdom's),
  healing.

### Constitution — Endure

- **Owns**: max health, poise pool and poise regen, stagger resistance, shields,
  and low-health behaviour changes.
- **Sustain route**: *absorbs*. The only route that is literally "take the hit".
- **Does not own**: healing efficiency (Wisdom's), armour cap, damage.

Constitution must not be a tax. The gate on that is mechanical: **nothing in the
six routes requires it**, and the milestone-gated survival tools of the other five
(stagger, flow, shaping, exposure, adaptation) are all reachable at zero
Constitution.

### Perception — Exploit

- **Owns**: weak points -- chance, payoff, and the `exposed` status they apply --
  `vulnerable` reads on enemies that have just committed an attack, crit, and
  resource recovered from precision.
- **Sustain route**: *acts first and takes the fight's tempo*. `vulnerable` is
  information: it says an enemy has committed and cannot answer for 0.75s.
  Perception's restoration comes from landing precisely rather than from a heal.
- **Does not own**: how fast you can act (Agility), damage scaling, movement.

Perception is separate from Agility on purpose, and the split is stated as a
sentence anyone can check a mechanic against: **Agility is how quickly you can
act; Perception is knowing where and when to.** A high-Agility character is not
automatically the best sniper because nothing Agility grants touches
`weakPointChance`.

### Wisdom — Sustain

- **Owns**: resource cost, cooldown length, healing received, `attuned` (efficiency
  from landing things), `adaptation` (resistance that grows against a repeated
  source), and conversion between resources.
- **Sustain route**: *stretches what it has*. The same pool goes further, the same
  heal goes further, and the same enemy hurts less the third time it does the
  thing.
- **Does not own**: the size of the pool (Intelligence's), health, damage.

---

## C. Thirty-six foundational skills

Six per attribute, three tiers (unlocked at attribute 10 / 25 / 40), max level 3
except tier 3 which is 1. All spend `unspentSkillPoints`. No branch locks. The
`requires` on each is an **attribute threshold**, never another class's absence.

Tabulated: **trigger** (when it fires), **effect**, **scaling** (per level),
**threshold** (attribute needed), **PvP** note, and the **abuse risk** it was
designed against.

### Strength

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Crushing Blows | every blow | +18% poise damage per level | 10 | staggers players too; stagger is 0.5s not a stun-lock | chain-stagger — guarded by `staggerImmuneTicks`, a target that just broke cannot break again for 2s |
| 2 | Committed Swing | during a basic attack's wind-up | poise damage taken ×(1 − 0.20/level) | 10 | you cannot be poked out of your commit | permanent hyper-armour — only during wind-up, never idle |
| 3 | Brutal Follow-Through | on causing a poise break | grants self `momentum` 1.5s: next attack's wind-up ×0.6 | 25 | strong, and readable: the target is visibly staggered | infinite momentum — one stack, does not refresh from the same break |
| 4 | Heavy Handling | passive | −15%/level of the wind-up penalty on abilities over 60 damage | 25 | none | none: it removes a penalty, it does not add speed |
| 5 | Overkill | on a killing blow with ≥25% damage overkill | restores 4 resource/level, and staggers others within 120u | 25 | requires a kill | pet-killing for resource — restricted to hostile kills, which is all `isHostile` allows anyway |
| 6 | Unstoppable | while committed to any cast | poise damage taken ×0.1 | 40 | cannot be interrupted mid-commitment | passive CC immunity — **only while `cast !== null`**, and withdrawing ends it that tick |

### Agility

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Quick Recovery | passive | backswing ×(1 − 0.10/level) | 10 | shorter rooted window | none — interval untouched |
| 2 | Mobile Offense | on cancelling a backswing | grants `flow` 1.2s (stacks 3): +5% move each | 10 | mobility, not damage | flow farming — a stack needs a *landed* attack behind it |
| 3 | Lightfoot | passive | +6 move speed, +0.008 armour per level | 25 | small | none |
| 4 | Rapid Handling | casting an ability with a projectile | wind-up ×(1 − 0.12/level) | 25 | faster draw, same fire rate | ranged DPS — the interval and the cooldown are untouched |
| 5 | Flow | while `flow` held | each stack also −6% backswing | 25 | rewards continuous play | permanent uptime — `flow` decays in 1.2s and is *lost entirely* on being staggered |
| 6 | Perfect Exit | withdrawing from a wind-up within 12 ticks of taking a hit | full `flow` (3 stacks) + 5 resource | 40 | a real read; punishes committing into a feint | free resource — gated on *having been hit*, and 4s internal cooldown |

### Intelligence

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Arcane Potency | passive | +0.05 spell power per level | 10 | numbers | none |
| 2 | Spell Shaping | ground/blast abilities | +8%/level radius, +5%/level range, **+10%/level cost** | 10 | bigger telegraphs are still telegraphs | free area — the cost premium is the price, and only Efficient Construction removes it |
| 3 | Prepared Casting | 2s without moving, attacking or casting | grants `prepared`; next non-basic cast's wind-up ×0.5 | 25 | opens fights, does nothing in one | pre-cast stacking — one charge, consumed on use |
| 4 | Catalysis | hitting a target with any status | +8%/level damage; your abilities apply `sundered` (−10% armour, 4s) | 25 | strong with a team | double-dipping — `sundered` does not stack with itself |
| 5 | Efficient Construction | passive | removes 40%/level of Spell Shaping's cost premium | 25 | none | becoming "all spells cost less" — it can only ever cancel the premium, floored at the unshaped cost |
| 6 | Arcane Overflow | casting with insufficient resource | pay the shortfall at 2 health per point | 40 | you can always cast; you can also kill yourself | suicide-casting for value — capped at 40% of *current* health, refused below that |

### Constitution

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Deep Reserves | passive | +25 health, +8 poise per level | 10 | bulk | none |
| 2 | Steady Frame | while not casting | +40%/level poise regen | 10 | rewards patience | none |
| 3 | Second Wind | dropping below 30% health | heal 12%/level of max health | 25 | one comeback per fight | heal-tanking — 20s internal cooldown, and it cannot fire twice without crossing back above 30% |
| 4 | Hard to Kill | below 30% health | grants `resolute`: stagger immunity + 8%/level damage reduction | 25 | the execute range is where it turns on | permanent DR — the threshold is on *current* health, so it is off whenever you are healthy |
| 5 | Sustained Effort | passive | poise regen also applies while staggered, at 50% | 25 | shortens your own stagger's aftermath | none |
| 6 | Overflow Vitality | healing above max health | overheal becomes shield, up to 25% max health, 8s | 40 | a buffer, not more health | infinite shield — capped by `maxShield` and decays whole |

### Perception

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Weak-Point Study | every blow | +0.04/level weak-point chance | 10 | reliable, not burst | none |
| 2 | Opening Read | an enemy entering backswing | that enemy is `vulnerable` 0.75s: your weak-point chance ×2 against it | 10 | reads commitment — the core PvP skill | always-on crit — it needs the enemy to have *committed*, which is a choice they made |
| 3 | Steady Aim | not having moved for 0.5s | +12%/level weak-point payoff | 25 | standing still in PvP is a real cost | passive crit — it is not passive |
| 4 | Hunter's Eye | passive | `exposed` lasts +0.5s/level and is visible to every client | 25 | information for the whole team | none |
| 5 | Exploit | weak-point hit on an `exposed` target | +25%/level damage and 1.5× poise damage | 25 | the payoff for setting up | self-chaining — the first hit applies `exposed`, so the bonus only ever lands on a *second* hit |
| 6 | Resource Sense | weak-point hit | restore 3 resource; on a kill, 6% max health | 40 | sustain from precision | trash-farming — resource only, health only on a kill |

### Wisdom

| # | Skill | Trigger | Effect / scaling | Thr | PvP | Abuse risk & guard |
|---|---|---|---|---|---|---|
| 1 | Resource Discipline | passive | −6%/level ability cost | 10 | numbers | cost to zero — `RESOURCE_COST_FLOOR` 0.4× |
| 2 | Measured Recovery | receiving healing | +12%/level healing received | 10 | sustain | none |
| 3 | Mastery | passive | **unlocks tier-3 stat skills of every attribute at 3 points below their threshold** | 25 | none directly | trivialising thresholds — 3 points, once, and Mastery itself is tier 2 |
| 4 | Conservation | landing an ability that damages or heals | `attuned` (stacks 3, 6s): −7%/level cost each | 25 | rewards not wasting casts | spamming a free ability — `attuned` needs a cast that *connected* |
| 5 | Adaptation | taking damage from an ability you have taken before | stacking resistance to that ability id: 4%/level, max 30% | 25 | huge against a repeated combo | resisting everything — it is per ability id, decays in 10s, capped |
| 6 | Conversion | healing above max health | overheal becomes resource, 1:1, up to 15 per event | 40 | a second economy | heal-loop — capped per event, and healing has a cooldown of its own |

---

## D. Fifteen pairs

Every pair, the interaction it gets, why it is interesting, and why it is not
multiplicative optimisation. All fifteen require **25 in both**.

| Pair | Interaction | Why interesting | Why not just "+X%" |
|---|---|---|---|
| STR+CON | **Juggernaut** — below 50% health, wind-up hyper-armour applies to *every* cast, not only basic attacks | turns the dangerous part of the fight into your window | it changes *which casts* are protected, a set, not a number |
| STR+AGI | **Momentum** — a poise break halves the next wind-up | heavy weapons that reposition between blows | grants a status and a timing change, no coefficient |
| STR+INT | **Impact Casting** — abilities deal poise damage equal to half your `staggerPower`; basic attacks apply `sundered` | spells that stagger; a mage who opens with a swing | gives abilities a property they did not have |
| STR+PER | **Executioner** — weak-point hits deal double poise damage; a staggered target under 25% health takes execute damage | deliberate, one-big-hit monster hunting | conditional on two states co-occurring |
| STR+WIS | **Disciplined Force** — a poise break restores 5 resource and cuts 10% off live cooldowns | martial sustain with no healing at all | converts a combat *event* into economy |
| AGI+CON | **Duelist** — each `flow` stack grants 4% damage reduction; poise regenerates while moving | survivability that requires moving well | defence sourced from an offensive-play status |
| AGI+INT | **Spellblade** — cancelling a backswing makes the next non-basic cast use `handlingScale` on its wind-up | movement-triggered casting; attack-cancel into spell | unlocks a scale on abilities that normally ignore Agility |
| AGI+PER | **Ranger** — `handlingScale` also shortens projectile cooldowns; +8% weak-point chance while `flow` is held | the mobile precision archer | one of the two effects is a *new domain* for an existing scale |
| AGI+WIS | **Flow State** — each `flow` stack cuts 6% ability cost; `flow` lasts 50% longer | monk-like chaining; casting paid for by moving | ties resource economy to a movement status |
| INT+CON | **Battlemage** — Arcane Overflow's health cost halves; 10% of ability damage dealt becomes shield | health as a mana bar, refilled by casting | a loop with two caps, not a multiplier |
| INT+PER | **Spell Sniper** — abilities may score weak points (normally attacks only); `exposed` adds a further 10% ability damage taken | targeted elemental exploitation | extends *eligibility*, which no amount of either stat alone does |
| INT+WIS | **Archmage** — `prepared` also waives the shaping cost premium and refunds 25% of the cooldown | the high-complexity, low-waste caster | changes what a status does |
| CON+PER | **Survivor** — `vulnerable` enemies deal 15% less damage to you; being hit below 50% health guarantees your next weak point | reading attacks *while* absorbing them | a guaranteed roll is not a chance increase |
| CON+WIS | **Enduring** — healing below 50% health is doubled; `adaptation` caps at 45% | attrition specialist | raises a cap and gates a multiplier on a state |
| PER+WIS | **Tactician** — `exposed` targets grant resource to *everyone* who hits them; weak points grant `attuned` | the support that makes a party's economy work | a team-wide effect, which no single-stat scaling can produce |

Nothing in this table is "you have both stats so both numbers are bigger". Each
row names a **trigger** that requires both halves to be true.

---

## E. Pure specialisation review

For each: what it does best, its loop, its weakness, and how the weakness is
compensated. Six characters at attribute 50 in one and 5 in everything else.

**Pure Strength.** Best at: removing a thing from the fight. Loop: swing, break
poise, the target is stunned 0.5s and its cast is gone, swing again with
`momentum`; Overkill refunds resource on the kill. Weakness: a pool of ~35
resource, no armour, no mobility, no way to catch a runner. Compensation: nothing
that is staggered runs; the enemies it cannot catch are the ones it did not need
to fight. Consumables and a shield item cover the pool. **Intentionally supported**:
Unstoppable at 40 means it is never interrupted, which is the whole fantasy.

**Pure Agility.** Best at: not being where the blow landed. Loop: attack, cancel
the backswing the instant the blow commits, move, `flow` climbs, the rooted
fraction of each interval falls toward a quarter. Weakness: the *lowest* damage of
the six and no burst — it out-lasts, it does not out-trade. Compensation: it takes
almost no damage. It is the only build that can disengage from a losing fight.

**Pure Intelligence.** Best at: changing the shape of the encounter. Loop:
`prepared` opener at half wind-up, a Quake at +30% radius, everything is
`sundered`, Catalysis makes every follow-up land harder. Weakness: 190 health,
no poise, dies to anything that reaches it; Arcane Overflow makes that worse on
purpose. Compensation: range and radius mean the reaching is the hard part, and
Overflow means it never runs dry — it converts the health it does not want to
spend anyway.

**Pure Constitution.** Best at: still being there. Loop: stand in it, poise never
breaks, Second Wind at 30%, `resolute` for the rest, Overflow Vitality turns every
heal into a shield. Weakness: kills nothing quickly — the longest time-to-kill of
the six by a wide margin. Compensation: it does not need to. A Constitution build
solo-clears anything with enough patience and is the only build that can hold a
position while somebody else does the work. **This is the build most at risk of
being boring**, so its milestones are all *behaviour changes* (immunity below a
threshold, shields from overheal, regen while staggered) rather than more health.

**Pure Perception.** Best at: turning enemy commitment into damage. Loop: wait for
the backswing, `vulnerable` doubles weak-point chance, weak point applies
`exposed`, the next weak point gets Exploit's +25% and 1.5× poise, Resource Sense
pays for it. Weakness: 200 health, no poise, and against an enemy that never
commits it has ~30% weak-point chance and nothing else. Compensation: everything
in the game has a wind-up; that is the game's premise. Player skill translates
almost linearly here, which is exactly what the fantasy claims.

**Pure Wisdom.** Best at: never running out. Loop: `attuned` from every landed
ability drives cost toward the 0.4× floor, cooldowns at 0.75×, `adaptation`
against whatever keeps hitting you, Conversion turning overheal into resource.
Weakness: no damage identity at all — it makes *tools* better and brings no tools.
Compensation: it is the strongest hybrid partner in the game and a genuinely
strong solo attrition build, because a character that can cast twice as often as
the table intended is a character casting twice as much. **This is the build most
at risk of feeling like a support tax**, so Mastery (tier-3 access at 3 points
under threshold) makes it the *enabler* stat rather than the healer stat.

---

## F. Derived-stat formulas

One direction, no cycles:

```
persisted BaseStats (allocated)
  + StatModifier grants from skills, stat skills and items
     -> effective attribute values          (attributes.ts)
        -> milestones met, synergies met     (milestones.ts, synergies.ts)
           -> a second StatModifier bundle
              -> TraitStats + EffectiveStats (derived.ts)
                 -> the sim reads it; nothing writes back
```

Ordering is fixed and asserted: **flat additions sum first, percentages apply
after, caps and floors last.** Attribute grants are resolved before milestones,
so an item that grants +5 Strength can push you over a threshold; milestone and
synergy grants are resolved *after*, so they cannot cascade into another
milestone. That is a deliberate one-hop rule -- it makes the graph acyclic by
construction rather than by hoping no one writes a loop.

Three curve helpers, all pure, all in `data/scaling.ts` with every coefficient:

```ts
above(attr)                        = max(0, attr - startingAttribute)
linear(attr, per)                  = attr * per
softCap(attr, per, knee, falloff)  = attr <= knee ? attr * per
                                     : (knee + (attr - knee) * falloff) * per
reciprocal(attr, per, floor)       = max(floor, 1 / (1 + attr * per))
```

`reciprocal` is how every "less of a thing" stat is written -- cost, cooldown,
animation length. It cannot reach zero, it has no negative branch, and 0.5 means
"half" rather than "-50% which is not the same as two -25%s".

**The baseline rule**, learned in implementation and worth stating first because
it changes every row below. Every attribute *starts* at 5, so a coefficient on
the raw value means a brand-new character already carries five points of every
scale: their wind-ups shorter than the ability table says, their costs lower,
their cooldowns shorter. Every authored number in `data/abilities.ts` would
describe a character who does not exist. So the **scales** -- every `reciprocal`,
and movement -- are measured through `above()`, and a fresh character is exactly
1.0x on all of them. The **quantities** that predate this spec (health, the pool,
armour, turn rate, spell power) stay measured from zero, because their baselines
are load-bearing elsewhere and re-basing them would move numbers this spec has no
business moving. The evidence that this is right: the whole of
`abilities.test.ts` and `attack-cancel.test.ts` passes untouched.

The table (all coefficients live in `SCALING` in one file):

| Derived | Formula | Notes |
|---|---|---|
| `maxHealth` | `170 + 14·CON + 2·STR + 8·(level−1) + flat` then `×(1+pct)` | Constitution's |
| `maxPoise` | `40 + 2.2·CON + 0.8·STR` | new |
| `poiseRegen` | `(4 + 0.35·CON)/60` per tick | doubled while not casting at CON 20 |
| `staggerPower` | `softCap(STR, 0.9, knee 40, falloff 0.5) + 8` | poise damage per blow |
| `staggerTicks` | `30 + 0.2·STR`, capped 48 | 0.5s..0.8s |
| `attackPointScale` | `reciprocal(AGI, 0.010, floor 0.5)` | wind-up only |
| `backswingScale` | `reciprocal(AGI, 0.018, floor 0.25)` | follow-through only |
| `handlingScale` | `reciprocal(AGI, 0.012, floor 0.5)` | projectile wind-ups |
| `moveSpeed` | `base + 0.9·AGI`, clamped to the world bounds | |
| `turnRate` | `base + 1.6·AGI` | existing coefficient |
| `attackDamage` | `base + 0.6·STR + 0.15·AGI + flat` then `×(1+pct)` | |
| `weaponPower` | `attackDamage / PLAYER_ATTACK_DAMAGE` | **new, and load-bearing** |
| `spellPower` | `1 + 0.02·INT` | |
| `spellRadiusPct` | `0.006·INT` (gated on the INT 20 milestone) | geometry |
| `spellRangePct` | `0.004·INT` (same gate) | geometry |
| `maxResource` | `20 + 2·INT + 1·WIS` | INT owns the pool |
| `resourceRegen` | `(2 + 0.12·WIS)/60` per tick | WIS owns the flow |
| `resourceCostScale` | `reciprocal(WIS, 0.010, floor 0.4)` | |
| `cooldownScale` | `reciprocal(WIS, 0.006, floor 0.5)` | non-basic only |
| `healingScale` | `1 + 0.012·WIS + 0.006·CON` | |
| `weakPointChance` | `0.006·PER + flat`, cap 0.6 | |
| `weakPointMultiplier` | `1.5 + 0.012·PER` | |
| `exposeTicks` | `60 + 1.8·PER` | how long `exposed` lasts |
| `critChance` | `0.004·PER + flat`, cap 0.5 | **moved off Agility** |
| `armor` | `0.004·CON + 0.002·AGI + flat`, cap `MAX_DAMAGE_REDUCTION` | |
| `maxShield` | `0.25 · maxHealth` | the cap on every shield source |

`EffectiveStats` keeps its existing fields untouched and gains **one** nested
field, `traits: TraitStats`, holding everything new. Existing readers do not
change; the wire gains one fixed block.

### Snapshot vs dynamic

### The hole `attackDamage` was sitting in

Found while implementing, and it changes what Strength needed: **`applyDamage`
multiplied every blow by `spellPower` and read `attackDamage` nowhere at all.**
It has been that way since spec 062 -- the stat is derived, replicated, printed
on the character sheet, and reaches nothing. Strength's damage coefficient was
decorative, so "a pure Strength build must be viable" was not achievable by
tuning: there was no path from the attribute to a damage number.

`traits.weaponPower` closes it, as a multiplier on a **basic attack** the way
`spellPower` is one on an ability. Derived *from* `attackDamage` against the
unarmed reference rather than added beside it, so there is still exactly one
number meaning "how hard do I hit" and the sheet's Damage row is that number.
Monsters keep `weaponPower: 1` through `monsterTraits`, so nothing in the
existing content is re-tuned by this.

### What Flow does not do

The Agility 20 milestone was specified as "+5% movement per stack" and does not
grant it. Flow is a **status**, statuses are not replicated, and a body moving
15% faster than its replicated `moveSpeed` would diverge from its own client's
prediction on every tick it held a stack -- a correction per tick, for the build
most likely to notice. Agility's raw speed lives on `moveSpeed`, which is
replicated and predicted; Flow keeps the follow-through, the cost, the damage
reduction and the weak-point chance, all of which are resolved server-side and
need no prediction. The field was deleted rather than left unwired.

- **Snapshotted at commit** (already the rule, spec 144): attack timing. Extended
  to cost, cooldown scale and hyper-armour — a buff landing mid-wind-up belongs to
  the next attack.
- **Evaluated at the moment it lands**: weak-point roll, poise damage, `exposed`,
  armour, adaptation. These are properties of the *blow*, and the blow happens at
  the attack point.
- **Per tick**: poise regen, status expiry, shield decay, `prepared` accrual.

---

## G. Networking model

Server-owned, and never read from a client: base stats, unspent attribute points,
allocation legality, respec legality and cost, which milestones are met, which
synergies are active, every derived value, poise, stagger, shields, statuses,
weak-point rolls, cost, cooldowns, and eligibility for every one of the above.

Replicated:

| Message | Adds | Why |
|---|---|---|
| `Stats` (0x44) | `baseStats` (six varuints), `unspentAttributePoints`, `statSkills`, `traits` | the sheet cannot be drawn without them |
| `Delta` (0x41) | two new fields behind two new bits: `poiseFraction` (u8, 0..255) and `shield` (f32) | stagger and shields are visible on a body |

Client -> server, two new messages:

| Message | Payload | Server checks |
|---|---|---|
| `AllocateAttribute` (0x16) | attribute key (u8 ordinal) | logged in, points available, not at hard cap, key is real |
| `RespecAttributes` (0x17) | nothing | logged in, can afford `RESPEC_COST` coins, has something to refund |

A rejection leaves the record byte-identical and is reported through the existing
`reportAction` path, which the client already surfaces in the refusal stack
(spec 143). There is no client-computed value anywhere in the flow: the client
sends *which button was pressed*, and reads back the whole truth.

The client's preview of legality goes through the server's own
`validateAttributeSpend`, the same trick `character-model.ts` already uses for
skills, so a greyed-out button and a refusal cannot disagree.

---

## Invariants tested

**Allocation and persistence**
- A point spent raises exactly one attribute by exactly one and decrements the
  budget by exactly one.
- Spending with no points, on an unknown key, or at the hard cap is refused and
  leaves the record byte-identical.
- Attribute allocation survives a save/load round trip through the store.
- Respec returns every point above the starting value, charges `RESPEC_COST`, and
  is refused when the purse is short; a refused respec changes nothing.
- A save written before this spec loads with `dexterity`/`vitality` mapped onto
  `agility`/`constitution` and the two new attributes at the starting value, and
  nobody loses a point.
- Levelling grants `ATTRIBUTE_POINTS_PER_LEVEL` per level.

**Derivation**
- `computeEffectiveStats` is a pure function of the record: same record twice,
  deep-equal stats, no clock, no RNG.
- Ordering: flat before percentage, caps last. Asserted with a case where the
  order changes the answer.
- No milestone or synergy grant can push a character over another milestone
  threshold (the one-hop rule).
- Every attribute at 0 produces finite, positive, in-bounds stats.
- Every attribute at the hard cap produces stats inside every documented cap.
- `reciprocal` never returns 0 or a negative, at any input including NaN.

**Milestones and skills**
- Each milestone activates at exactly its threshold and not one point below.
- A stat skill is refused below its attribute threshold and accepted at it.
- Mastery lowers tier-3 thresholds by exactly 3 and only tier 3.
- Stat skills and branch skills draw from the same budget: spending one leaves
  one fewer for the other.
- Every one of the 36 skills is reachable by some legal allocation (a table-driven
  sweep, so a typo'd threshold fails CI).

**Mechanics**
- Poise damage accumulates, breaks at zero, staggers for `staggerTicks`,
  interrupts a live cast, refills the pool, and cannot break again inside
  `STAGGER_IMMUNE_TICKS`.
- Hyper-armour reduces poise damage only while `cast !== null`, and only in the
  phases the granting milestone names.
- `attackPointScale`/`backswingScale` shorten the animation and **leave
  `intervalTicks` bit-identical** — asserted directly, because it is the property
  the whole Agility design rests on.
- A weak-point hit applies `exposed`; a second hit on an `exposed` target gets
  Exploit's bonus and the first does not.
- Arcane Overflow is refused when the health cost would exceed 40% of current
  health, and spends exactly `2 × shortfall`.
- Shields absorb before health, never exceed `maxShield`, and expire whole.
- `adaptation` is per ability id, caps at its maximum, and decays.
- Statuses expire on the exact tick, deterministically.

**Replication and anti-cheat**
- A `Stats` message round-trips through the codec byte-identically, traits
  included.
- An `AllocateAttribute` for an unknown ordinal is rejected without touching the
  record.
- No message exists that sets a derived value; asserted by a test that walks the
  client message union.
- The client read model's `canAllocate` agrees with the server's validator over an
  exhaustive sweep of budgets and attribute values.

**Determinism**
- The full six-stat sim replays bit-identically from a seed and an input
  sequence, with poise, statuses and weak-point rolls all live.
- Presentation-only: the existing `presentation-only.test.ts` property still
  holds — driving the animation layer changes no authoritative state.

**Build viability (the design rule, as a test)**
- All six pure builds and six named hybrids are constructible from the preset
  table and produce legal, finite, in-bounds stats.
- Every pure build has a non-empty set of active milestones at level 25.
- All 15 synergies are reachable, and each names two attributes that both have a
  milestone below the synergy threshold (so a pair is always *additive* to two
  identities rather than a replacement for them).

## What implementation changed, in one list

Kept honest because a spec that disagrees with its code is worse than no spec.

1. **The baseline rule** above: scales measured from the starting attribute.
2. **`weaponPower`**, because `attackDamage` reached nothing.
3. **Flow grants no movement**, for the prediction reason above.
4. **`Vulnerable` is a constant window**, not the reader's `openingReadTicks`.
   Whether an enemy has just committed is a fact about the world rather than
   about who is looking at it; what Perception buys is the ability to *use* the
   window (`vulnerableWeakPointFactor`), which is the difference between an
   information mechanic and a hidden damage buff.
5. **Second Wind re-arms on recovery**, not on a timer alone -- otherwise a
   character parked at 29% health gets a heartbeat every twenty seconds.
6. **`Prepared` and `Momentum` are consumed at the attack point**, not at the
   commit, so "the attack did not happen" is true of the charges as well as of
   the cost and there is no state for a withdrawal to put back.
7. **A pure build at level 20 cannot spend its whole budget** -- 62 points, 55
   places -- so `spreadOf` reports what it could not place instead of silently
   comparing builds with different budgets.
8. **The branch tree is deleted, not kept beside.** See above. `statSkills`
   merged back into `skills`, `SpendStatSkillPoint` merged back into
   `SpendSkillPoint`, and `data/skills.ts` is now the attuned table.
9. **The sheet never names a pair.** The design doc names all fifteen; the
   *screen* names none of them, and two tests sweep the rendered strings to keep
   it that way. Naming them makes them a menu.
10. **Every stat row carries a one-line hint, including "not implemented".**
   `Attack speed` is a socket nothing plugs into (specs 091, 144) and the sheet
   says exactly that rather than describing a number that never moves. The rows
   have carried a `tooltip()` since spec 128 and nothing ever asked them; the
   sheet now has a live `Tooltip` in the same layer as the bag's.
11. **A tooltip belongs to one tab, and always describes.** Two rules the sheet
   was shipped without. A tab switched away is *hidden*, never destroyed (spec
   124), so its rows keep `visible` true and keep the rectangle they were last
   arranged into -- three tabs of rows therefore stacked at the same coordinates
   and a hover was answered by whichever list was walked first; the hit test
   walks the ancestor chain now. And the attribute tooltip returned the
   *refusal* in place of the description, so a character with nothing to spend
   -- which is every character between two level-ups -- read "no unspent
   attribute points" on all six rows. The description is unconditional and comes
   off `ATTRIBUTES.owns`; the refusal is appended, exactly as a skill row's is.
12. **No admin path applies a preset.** `npm run balance -- --preset=<id>` builds
   and fights any of the twelve; a wire message that made a character level 20
   is not a thing to ship, and a manager method nothing calls is dead code.
13. **Momentum grants `momentum`, not `flow`** (corrected in spec 168). The
   effect string had promised "two Flow stacks and halves the next wind-up" and
   the grant was `momentumTicks`/`momentumWindupScale` all along -- a separate
   status, consumed at a different place. The wind-up half was always true; the
   Flow half described a line of code that was never written. Corrected in the
   text rather than in the grant, because a second source of Flow stacks that
   costs nothing to trigger is a balance change and this was a typo.

## Out of scope

- Downed/revive. At 0 health the existing death behaviour is untouched.
- Equipment stat *requirements*. The brief prefers soft costs to hard gates and
  this spec has no room to redesign `items.ts`; `Heavy Handling` is the pattern
  a later spec should follow.
- Retiring the branch-locked `SKILLS` tree.
- Rebalancing monsters against the new player power curve. `MONSTERS` rows get
  poise from their existing stats and nothing else changes.
- New abilities. Every mechanic here acts on the ten rows already in
  `data/abilities.ts`.
- A visual language for statuses beyond what the HUD already draws. The wire
  carries poise and shield; drawing them well is a render spec.
