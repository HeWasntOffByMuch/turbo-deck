# 154 — The health you carry between fights

## Problem

Health in this game is already persistent, and that is the whole of the health
system. A player walks out of a fight at whatever they walked out at, and the
only ways back up are `self.mend` on a ten-second cooldown, a synergy that fires
once every twenty seconds, and dying. There is no answer to the question the
game is actually about between encounters:

> **Can I maintain momentum?**

So the loop is: fight, lose health, fight again with less, and eventually stop —
not because a decision went wrong but because arithmetic ran out. Nothing a
player *does well* changes that. A flawless fight and a sloppy one both end with
less health than they started with, and by roughly the same amount, because
nothing in the game converts combat competence into expedition sustainability.

This spec adds the missing half: **HP + kill sustain + limited fallback
healing**. Fight, spend health, kill, recover some, continue.

The design target, stated as a number so it can be checked rather than felt: a
competent player is slightly health-negative over an ordinary encounter, an
excellent player is neutral to modestly positive, and a reckless one burns
through the fallback and has to leave. Nobody returns to full for free.

## Out of scope

- **No downed state, no revive, no party resurrection.** Death semantics do not
  move: a player who reaches 0 is dead, waits `RESPAWN_DELAY_TICKS`, and comes
  back at Hearthstead at full health, exactly as in spec 145.
- **No wound or injury subsystem.** Nothing accumulates across deaths.
- **No consumable-drinking system.** `potion.minor` still does nothing;
  consuming an item is still its own spec. The fallback heal here is an
  *ability*, not an item, precisely so that this spec does not have to invent
  one (§ D).
- **No threat table.** Assist credit is read off marks the blow already leaves,
  not off a damage ledger (§ C).

---

# A. Current architecture

Where the pieces this spec has to join already live.

| Question | Where it is answered today |
|---|---|
| How much health does a body have | `ServerEntity.health`, clamped to `stats.maxHealth` |
| Where does health persist | `PersistedPlayer.health`, synced every tick by `server.ts` |
| What takes health away | `sim/blow.ts` — the one blow, in one order |
| What gives it back | `sim/abilities.ts` `applyHealing` — the *only* place healing is scaled and the only place overheal goes anywhere |
| How does something die | `blow.ts` pushes `died`; `world.ts` step 4 sweeps the body |
| What does a kill already pay | `server.ts` `dispatchEvents` grants `MONSTERS[id].experience` |
| How do entities come and go | `world.ts` `spawnEntity` / the death sweep; `EntityKindValue` |
| How does a client hear about them | `net/delta.ts` per-connection diff over the chunk interest set |
| Where do per-body timers live | `sim/statuses.ts` — one map, expiry by comparison, deterministic order |
| Where do stat coefficients live | `data/scaling.ts`, applied once in `player/derived.ts` |

Four of those are load-bearing for what follows and are worth stating as
decisions rather than as facts:

1. **`applyHealing` is already the chokepoint.** Wisdom's scale, Constitution's
   overheal shield and Wisdom's conversion all live in it. A mote and a flask
   that go through it inherit all three and add nothing.
2. **A projectile is an entity.** Spec 062 made that choice explicitly so that
   interest management, delta tracking and replication would apply to it
   unchanged. A restorative mote gets the same treatment for the same reason.
3. **`statuses.ts` is a general timer map** with deterministic iteration and
   expiry-on-read. Anti-farm decay, the elite guarantee window and assist marks
   are all "remember this about a body for N ticks", which is what it is.
4. **A monster row already says what it is worth.** `experience` is the
   authored difficulty budget. Restoration weights off it rather than off a
   second number nobody could tune against the first — the same rule
   `withTraits` follows for poise.

---

# B. The health-economy loop

```
  damage  ──▶ blow.ts marks the victim: dmg:<attackerId>  (assist window)
              and, on the killing blow, stamps the kill's qualities on `died`
                                │
  kill    ──▶ world.ts step 3c: restoration
              │
              ├── killer:   base × farm × (1 + Σ bonuses)  ──▶ meter
              ├── assists:  base × assistFraction          ──▶ their meters
              └── elite:    guaranteed motes, once per spawner per window
                                │
  meter   ──▶ crosses threshold ──▶ N motes spawned at the corpse
              excess carries over
                                │
  motes   ──▶ world.ts step 3d: attract, collect, expire
              owner only, magnetised only toward a deficit it can fill
                                │
  heal    ──▶ applyHealing  ──▶ health, then shield (CON 50) or resource (WIS 50)
              waste ──▶ salvage back to the meter (Wisdom)
```

And beside it, never inside it:

```
  flask   ──▶ UseAbility('self.hearthdraught') ──▶ startCast spends a charge
              wind-up (punishable, cancellable — a cancel refunds the charge)
              ──▶ applyHealing
  rest    ──▶ standing in a `rest` zone, out of combat
              ──▶ health regenerates, charges refill one at a time
```

**Orbs are the economy. The flask is insurance.** The two never touch: no orb
grants a charge, no charge feeds the meter.

---

# C. Deterministic rules

## The meter

Server-side, per body, one number: `ServerEntity.restoration`. The client never
sees it in absolute terms — it is replicated as a *fraction*, because the only
question a bar asks is "how full".

```
base        = experience × progressPerExperience × threatFactor
farm        = max(farmFloor, 1 − stacks × farmDecayPerKill)
bonuses     = Σ qualifying actions, clamped to bonusCap
progress    = base × farm × (1 + bonuses)

meter      += progress
motes       = floor(meter / threshold)
meter       = meter − motes × threshold        ← excess carries over, always
```

`motes` is a floor rather than a boolean, so a single large kill that crosses
the threshold twice produces two motes and the remainder still carries. That is
tested directly; a rule that produced one and discarded the rest would make a
big kill worth *less* than the two small ones it replaced.

`threatFactor` is the least-intrusive anti-farm rule available: a monster whose
row says it will not fight back (`passive` and no `aggroRange`) contributes
`passiveFactor` of its weight, and a row worth no experience contributes
nothing at all. That covers the grazer and the training dummy without a new
authored field.

## Carry-over and the meter's boundaries

- Excess **always** carries, between kills. It is not persisted (§ E), so a
  fresh login starts at zero, and it is **cleared on death**, alongside the
  full-health, full-flask return the respawn already did. Both follow from the
  same reading: the meter is momentum inside an expedition rather than a
  possession. A persisted one would be a thing to bank by logging out at 99, and
  a death that kept it would make dying the cheapest way to reset a fight.
- The client cannot address the meter. There is no client message that reaches
  it, and the only thing that moves it is a kill the server resolved.

## Anti-farm

Two mechanisms, both keyed on the *spawner* — which is the only thing in this
world that repeats.

- **Diminishing returns per spawner.** A status `farm:<spawnerId>` on the
  killer, `farmWindowTicks` long, up to `farmMaxStacks`. Each stack removes
  `farmDecayPerKill` of the contribution, floored at `farmFloor`. A body with no
  spawner — admin-conjured, or placed by a scripted encounter — is keyed by its
  *type* instead, so nothing escapes by having no home and a varied wave still
  pays what it is worth. (One shared key for all of them was the first version
  and was wrong in exactly that way: five different monsters would have decayed
  as though one spawner had been farmed five times.)
- **One elite guarantee per spawner per window.** A status
  `elite:<spawnerId>` on the killer, `eliteGuaranteeTicks` long. Inside it, an
  elite kill still pays meter progress and pays no guarantee. This is what stops
  a boss with a reset loop, or a re-pulled champion, from being a recovery
  fountain.

Neither is a global cooldown on restoration: killing *different* things is
never penalised, which is the behaviour a player expects and the behaviour that
makes clearing an area feel different from farming one corner of it.

## Elite guarantee

Elite is derived, not authored: `experience >= eliteExperience`. The ravager is
elite, the slinger is not, and a row added later classifies itself. An elite
kill produces at least `eliteMotes` motes — the meter's own output counts toward
that total, and any top-up is a *bonus* that does not touch the meter, so a
guarantee cannot be laundered into carry-over.

## Qualifying actions

Five, all of them already computed inside `resolveBlow` at the moment of the
killing blow, all of them additive fractions of the base, and the sum capped at
`bonusCap`. Additive-then-capped, never multiplicative, is the rule that makes
an unbounded healing loop unexpressible.

| Action | Detected by | Route |
|---|---|---|
| Weak-point kill | `weakPoint && killed` | Perception |
| Overkill | damage ≥ remaining × (1 + `overkillFraction`) | Strength |
| Execution | target was `Stunned` when it died | Strength |
| Untouched kill | killer carries no `RecentlyHit` | Agility |
| Killed with an ability | `!ability.basicAttack` | Intelligence |

None can be spammed. Overkill and execution need the fight to have been won
decisively; untouched needs the player to actually not have been hit inside
half a second; the ability kill costs resource. And every one of them is *the
kill*, so the rate is bounded by the supply of things to kill.

## Motes

- **Which kind.** Deterministic, by the collector's larger fractional deficit at
  the moment of generation: vitality if `1 − health/max ≥ 1 − resource/max`,
  focus otherwise, and always vitality for a body with no resource pool. A
  player short of health gets health. There is no roll.
- **Value.** A fraction of the collector's own maximum (`moteHealthFraction`,
  `moteResourceFraction`), so a mote is worth the same *proportion* to every
  build and Wisdom's `healingScale` is the thing that makes it worth more.
- **Attraction.** Within `attractRadius` (plus Perception's bonus) a mote
  accelerates toward its owner and is collected inside `pickupRadius`. It is
  never attracted toward a deficit it cannot fill — a vitality mote ignores a
  player at full health — so nothing is wasted by walking over it.
- **Full-resource behaviour.** A mote whose resource is full is simply not
  collected. It waits, visible, until it expires. Two things follow: there is no
  banking (the lifetime is `moteLifetimeTicks`, and it is short), and there is
  no reason to avoid collecting one, because a collected mote at full is one you
  chose to spend. A player who *does* have an overheal outlet — Constitution's
  shield, Wisdom's conversion — collects it and `applyHealing` does the rest.
- **Waste.** Wisdom's `restoreSalvagePct` puts a fraction of any overheal back
  into the meter, capped per event. It lives inside `applyHealing`, so it
  reaches a mote, the flask and `self.mend` alike, and it is applied to what the
  *other* outlets did not take — Constitution's shield and Wisdom's own
  conversion get first refusal, so nothing is paid for twice. The only path from
  healing to the meter, and bounded twice, so it cannot run away.

---

# D. Fallback healing

**The flask is an ability.** `self.hearthdraught`, in `data/abilities.ts` like
everything else, and that single decision is what makes the rest of this section
short: it gets the wind-up, the commitment, the cancellation rules, the
replication, the cast bar and the hotbar slot for free, and Wisdom's
`cooldownScale` and `healingScale` reach it without a line of new code.

| Property | Value |
|---|---|
| Charges | `fallbackCharges` base, plus Constitution's |
| Amount | `healingFraction` of max health, through `applyHealing` |
| Wind-up | `0.9s` — long enough to be punished for using it badly |
| Cooldown | `12s`, shortened by Wisdom |
| Cost | one charge, spent **at commit** |
| Cancellation | a withdrawal before the attack point refunds the charge |
| Refill | resting in a `rest` zone, and respawn |

The charge is spent at commit and refunded by a withdrawal, which is exactly
what `startCast`/`cancelWindup` already do with resource — so a feint costs the
time and nothing else, and a flask that landed can never be un-drunk.

`AbilityDefinition` gains one field, `chargeCost`, so a second flask is a row
rather than a special case. `healingFraction` gains beside `healing` for the
same reason: a heal proportional to the drinker is a thing the table should be
able to say.

## Refill: rest

`ZoneDefinition` gains `rest: boolean`. Hearthstead has it; nothing else does.
Standing in a rest zone with no `InCombat` mark:

- health regenerates at `restHealthPerSecond` of maximum,
- one charge returns every `restChargeTicks`.

Deliberately a *place* rather than a timer, so the refill is a decision to
disengage and walk back. Deliberately gated on not being in a fight, so it
cannot be used by a player who dragged something into town. Deliberately not
available in the wilds, which is where the fallback has to be insurance rather
than a rest button.

`InCombat` is a **new, wider status** rather than the existing `RecentlyHit`,
and the difference is load-bearing. `RecentlyHit` is a reaction window half a
second wide, which is what Perfect Exit and the untouched-kill bonus both need
it to be; a ravager swings every 2.25 seconds, so gating a refill on it let a
player heal between the blows of the thing killing them. An existing session
test caught it, because the default spawn point is inside Hearthstead.

---

# E. Multiplayer ownership

**Motes are personal, and invisible to everybody else.** A mote entity carries
`ownerEntityId`; `server.ts` filters it out of every other connection's delta,
so a teammate cannot see one, cannot walk over one, and cannot be blamed for
one. That is stronger than an ownership check on pickup, and it costs one line
in `broadcastDeltas`.

**Credit is shared, motes are not.** The killer gets the full contribution and
the motes. Every *other* player who damaged the victim inside `assistTicks` gets
`assistFraction` of the **base** — no bonuses, no elite guarantee, no motes of
their own from this kill — into their own meter, where it may cross their own
threshold and produce their own motes at their own feet.

Read off the `dmg:<attackerId>` marks the blow already leaves on the victim, so
there is no threat table and no new bookkeeping.

What this buys, and why it is the rule:

- **A teammate cannot steal your survival economy.** Last-hitting takes the
  motes but never the assist, and the assist is the part that keeps a
  non-killer going.
- **Sustain does not multiply with party size.** The monster supply is fixed by
  the map's spawners. Four players clearing one camp split the same kills:
  each takes a quarter of them at full credit and three quarters at
  `assistFraction`, which is *less* per player than clearing it alone — while
  clearing it far faster and splitting the incoming damage. Cooperation buys
  efficiency, never a bigger economy.
- **Solo is the baseline, not the degraded case.** A solo player is the killer
  of every kill and takes 100% of everything. Nothing here has a party
  requirement, and no build is a healer.

## PvP

The wilds are `pvp: true`, so this has to be answered rather than deferred.

- **Player kills generate restoration**, at `pvp.scale` of a monster of the
  same weight, and **never an elite guarantee**.
- **Feeding is impossible**: a status `pvpKill:<victimEntityId>` on the killer
  makes a repeat kill on the same victim worth nothing for `pvp.victimTicks`.
- **Snowballing is bounded** because the flask is the only *large* recovery and
  it has a wind-up that another player can punish. A kill does not reset a
  fight; it advances a meter.
- **Assists apply in PvP too**, so a 2v1 does not hand the whole economy to
  whoever landed last.
- Every PvP number is its own block in the config, not an exception buried in
  the sim.

---

# F. Six-stat integration

Every stat has a *route*, none of them is "+X% healing received", and the
brief's rule holds: Wisdom is the natural owner of efficiency and Constitution
is useful without being mandatory.

| Stat | Route | Exact hook |
|---|---|---|
| **Strength** | Overpower it | `restoreOverkillPct` — overkill and execution bonuses scale with Strength. A body that dies decisively pays more. |
| **Agility** | Never be there | `restoreEvasivePct` — the untouched-kill bonus scales with Agility. No direct healing at all; the route is that Agility spends less. |
| **Intelligence** | Solve it with a spell | `restoreAbilityKillPct` — an ability kill's bonus scales with Intelligence. Manipulation, not more healing. |
| **Constitution** | Forgiveness | `fallbackCharges` — more insurance; and `healingSurge` from Constitution, so every restorative is worth more below `desperationBelow` health. |
| **Perception** | Exploit it | `restoreWeakPointPct` on the weak-point-kill bonus, and `moteAttractRadius` — motes come to you from further away. |
| **Wisdom** | Waste nothing | `restoreSalvagePct` — overheal goes back into the meter; plus the existing `healingScale` and `cooldownScale`, which reach every mote and the flask. |

Constitution's surge reuses `healingSurge`/`healingSurgeBelow`, which already
exist and already run inside `applyHealing`. That is deliberate: a second
mechanism meaning "heal more when low" would be a second place to get the
threshold wrong.

A low-Wisdom build loses the salvage and nothing else — motes still fill the
bar, the flask still works, the meter still fills at the same rate.

---

# G. Abuse analysis

| Loop | Why it does not work |
|---|---|
| Farm one respawning spawner forever | `farm:<spawnerId>` decays to `farmFloor` in a handful of kills and takes `farmWindowTicks` to clear |
| Farm grazers / a training dummy | `passiveFactor` on a body that will not fight; zero experience contributes zero |
| Kill a boss's adds, or reset a boss | Adds are ordinary rows; the elite guarantee is once per spawner per `eliteGuaranteeTicks` |
| Cross the threshold, bank the excess, log out | The meter is not persisted |
| Feed kills to a friend in the wilds | `pvpKill:<victimEntityId>` makes a repeat kill on the same body worth nothing |
| Stack players for exponential sustain | Motes are personal; assists are a fraction of a *shared* kill supply |
| Last-hit a teammate's fight | Assists are unstealable; the motes go to the killer and the credit does not |
| Feint the flask to fish for a heal | The charge is spent at commit; a withdrawal refunds it and no heal happened |
| Spam the flask | Charges, plus a 12s cooldown, plus a wind-up |
| Refill charges by killing trash | Charges come from rest zones and respawn only. Nothing in combat grants one |
| Drink in town mid-fight | Rest is gated on `RecentlyHit`, and Hearthstead is the only rest zone |
| Stand at full health hoovering motes to waste them | Motes are not attracted toward a deficit they cannot fill |
| Hoard motes until a burst window | `moteLifetimeTicks` is short and there is no inventory to hold one in |
| Overheal-salvage loop (heal → meter → mote → heal) | Salvage is a capped fraction of *overheal only*, and a mote that overheals is a mote that was already nearly wasted |
| Client claims a pickup | Pickup is a distance check inside the sim; there is no pickup message |
| Client claims a heal | The flask is `UseAbility`, gated by the same `startCast` the server runs |

---

# Invariants (what the tests assert)

1. `meter'` = `meter + progress − motes × threshold`, for any sequence — carry-over is exact and never negative.
2. One event may cross the threshold more than once, and does.
3. An elite kill always yields ≥ `eliteMotes` motes; a second elite kill on the same spawner inside the window yields no guarantee.
4. Bonuses sum, and the sum is clamped at `bonusCap`; no combination exceeds it.
5. A passive zero-aggro monster contributes `passiveFactor`; a zero-experience body contributes nothing.
6. A monster killed by another monster generates nothing.
7. A mote is only ever collected by its owner, only inside `pickupRadius`, and only when it has something to fill.
8. A mote expires, and expiring costs nothing.
9. The flask spends a charge at commit, refunds it on withdrawal, and is refused with no charges.
10. Rest refills charges and health; it does not fire with `InCombat` live, or outside a rest zone.
11. A fixed seed and a fixed input sequence produce bit-identical restoration state, every run.
12. Death behaviour is unchanged: same respawn delay, same full-health return, same `died` event.
13. Presentation is not consulted: the same fight with the restoration message driven and not driven leaves identical authoritative state.
14. Twenty flawless kills leave a player health-positive; twenty reckless ones exhaust the flask.

## Instrumentation

`sim/metrics.ts` gains restoration columns — progress earned, by source; motes
generated, collected and wasted; flask charges spent; net health delta — and
`npm run balance` prints them in a second table, so the six routes are legible
beside the one that already proves the six builds are different.

The signature to watch for there, because it reads as the opposite of what it
is: **every build at exactly net zero health per kill is over-generation, not
balance.** It means the economy is producing more than a fight costs and the
only thing holding it down is the health bar's own ceiling. Read MOTE% beside
it — a low one says most of what was generated was thrown away.

`npx tsx scripts/probe-restoration.ts` is the other half. It prices every
monster in the table under five kinds of play and prints the derivation line by
line — the answer to *why did this player get this much* — then runs the seven
players of the balance review below through twenty kills each. It also lists the
admin levers: `meter`, `charges` and `elite` on `admin:triggerEvent`, beside the
`raid` and `clear` that were already there.
