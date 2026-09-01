# The Perception branch, reviewed

A review of Perception's progression track as it stands on `main` at 1cd0734: what
the six specializations and three milestones do, which of them reach the sim,
how they compose, and how strong the build gets.

Everything numbered below was **measured through the real `step`**, not read off
the tables. Where a claim is about a number, the instrument that produced it is
named.

## The track

```
  PERCEPTION  5 ──── 10 ──── 20 ──── 25 ──── 35 ──── 40 ──── 50
                      │       │       │       │       │       │
                      │    (auto)     │    (auto)     │    (auto)
                      ├ Weak-Point Study ●●●          │       │
                      ├ Opening Read ●●●──────────────┘       │
                      │               ├ Steady Aim ●●●        │
                      │               ├ Hunter's Eye ●●●      │
                      │               └ Exploit ●●●           │
                      │                        Resource Sense ●┘
```

Six specializations (16 buyable tiers), three automatic milestones. Alongside them
the attribute itself scales four quantities with no purchase at all — weak-point
chance (0.006/pt), weak-point multiplier (1.5 + 0.012/pt), crit (0.004/pt, capped
at 50%) and Exposed duration (60 ticks + 1.8/pt).

At PER 60 the automatic half alone is **36% weak-point chance, a 2.22x weak-point
multiplier, 24% crit, and a 2.8s Exposed mark**.

## Does it work?

Every Perception trait has a live consumer in `sim/blow.ts` — there is no trait
here that resolves into nothing, which is more than the Intelligence track can say.
`npm run audit:progression` reports all 96 Perception tier/context cells `ACTIVE`
and zero `INERT`.

That report is wrong about one of them, and the way it is wrong is the most
useful thing in this review.

### Steady Aim does nothing. At all.

`per.steadyAim` is three tiers at PER 25 granting `steadyAimPct` 0.12 each. The
payoff is real and the consumer is real:

```ts
// sim/blow.ts:246
const still = tick - attacker.stillSinceTick >= A.steadyAimTicks ? A.steadyAimPct : 0;
damage *= A.weakPointMultiplier * (1 + still);
```

The gate is unsatisfiable. Two lines put `stillSinceTick` beyond reach:

- `sim/abilities.ts:732` — `startCast` sets `stillSinceTick: tick` unconditionally.
- `sim/world.ts:1628` — `advanceProgression` computes `busy = moved || entity.cast !== null`
  and re-stamps `stillSinceTick = tick` on every tick of a cast.

`advanceProgression` runs in pass 1c; casts resolve in pass 3 of the *same* tick.
So at the instant `resolveBlow` reads it, the attacker has been mid-cast since the
wind-up began and `tick - stillSinceTick` is **0**. It needs 30.

Measured, at PER 60 with all three tiers bought (`steadyAimPct` 0.36):

| weapon | blows landed | stillness at impact | Steady Aim fired |
|---|---|---|---|
| sword, 60s continuous | 36 weak points | min 0, max 0 | **0** |
| bow @ 100 units | 30 arrows | max 0 | **0** |
| bow @ 250 units | 29 arrows | max 0 | **0** |
| bow @ 400 units | 29 arrows | max 0 | **0** |
| bow @ 415 units (max range) | 29 arrows | max 0 | **0** |

Not rare — impossible. There is no weapon, range, tier or attribute value at which
this fires. Three progression points buy nothing, at the one threshold where the
specialization first becomes purchasable.

This is precisely the class of fault spec 239 fixed for `per.openingRead` (a factor
of 0) and `wis.adaptation` (a missing window), and it survives the spec 241 audit
because **the audit checks that a trait moves, not that the condition guarding it
can ever be true.** `steadyAimPct` moves 0 → 0.36, so all twelve cells read `ACTIVE`.

The fix is already the repo's own idiom: spec 221 snapshots `targetInReach` at the
tick the wind-up begins because the release is the wrong place to ask. Stillness is
the same shape of question — `CastState.windupStartTick` exists, and the answer
wants taking there.

Two smaller things sit beside it. The grant carries `steadyAimTicks: 0`, which is
the no-op delta spec 239 stripped from `wis.discipline` for saying nothing. And the
`0.5s` window would be the wrong number even if it were read at the right moment:
the measured idle gap between consecutive attacks tops out at **29 ticks**, one
short of the 30 required.

### Perception does nothing for the four skills you equip

```ts
// sim/blow.ts:180
const mayWeakPoint = isBasicAttack || A.abilityWeakPoints > 0;
```

**`abilityWeakPoints` is granted by nothing** — no specialization, no milestone, no
item in `data/items.ts`. So every weak point in the game comes from a basic attack,
and the entire Perception branch is switched off for the four active skills a
character equips in `skill1..skill4`.

That is a structural ceiling rather than a tuning one. It means Perception cannot
combine with the skill system at all, and a Perception character's rotation is
"auto-attack, and do not press anything".

### Dead sockets

Fields declared in `data/modifiers.ts`, read (or readable) by the sim, granted by
no content row:

| field | read by | consequence |
|---|---|---|
| `abilityWeakPoints` | `blow.ts:180` | weak points are basic-attack-only, forever |
| `flowWeakPoint` | `blow.ts:186` | Flow cannot buy weak-point chance |
| `exploitPoiseFactor` | `blow.ts:349` | weak points cannot amplify poise damage |
| `exposedTeamResource` | `blow.ts:503` | the `EXPOSED_BOUNTY` status is never applied |
| `weakPointPayoffPct` | `derived.ts:288` | nothing deepens the weak-point multiplier |
| `attunedFromWeakPoints` | `blow.ts:547` | the PER→WIS attunement bridge is dead |

Four of those six are spec 244's removed pair synergies leaving their readers behind.
Two of them are still being described to the user as if they worked:

```
AGI/PER  'The ranger. Handling shortens projectile cooldowns; Flow buys weak-point chance.'
STR/PER  'The executioner. Weak points double poise damage; ...'
```

`npm run balance` prints both premises every run. Neither has been true since
`synergies.ts` was deleted.

### Everything else works

Verified firing in a real fight at PER 60 with every tier bought:

- **Weak-Point Study** — 4% weak-point rate without Perception, **50–81%** with it.
- **Opening Read** — 28/54 melee blows and 42/52 bow blows landed inside a live
  Vulnerable window. `applyStatus(Vulnerable)` fires from a constant on every body
  that commits, so the tell is a fact about the world rather than about the reader.
- **Hunter's Eye** — Exposed runs 168 → **258 ticks** (4.3s) at three tiers.
- **Exploit** — fired on 18 of 36 weak points; correctly reads the exposure that
  existed *before* the blow, so the hit that applies the mark can never cash it in.
- **Resource Sense** — the dominant restoration source for the build. The balance
  harness attributes `weakPoint 1303` of Pure Perception's healing, against
  `overkill 233` and `untouched 198`.
- **Exposed is a team buff and genuinely is one** — `blow.ts:257` reads
  `statusOf(target, Exposed).magnitude` for *any* attacker, so the exposer's 15%
  is paid to everyone hitting that body.

## How the pieces compose

**With each other.** The branch is a genuine two-step engine and the couplings are
real: Opening Read multiplies Weak-Point Study's chance; Hunter's Eye extends the
window Exploit spends; Resource Sense converts the frequency the first two bought
into sustain. Nothing here is an isolated stat stick.

**Against each other — the 0.95 clamp.** Weak-point chance resolves as

```ts
Math.min(0.95, (A.weakPointChance + flowStacks * A.flowWeakPoint) * (vulnerable ? A.vulnerableWeakPointFactor : 1))
```

Weak-Point Study and Opening Read therefore buy shares of the *same* clamped number,
and past a point they cancel:

| PER | Study | Opening Read | raw | actual | wasted |
|---|---|---|---|---|---|
| 40 | ×3 | ×3 | 0.882 | 0.882 | — |
| 50 | ×3 | ×3 | 1.029 | 0.950 | 8% |
| 60 | ×0 | ×3 | 0.882 | 0.882 | — |
| 60 | ×3 | ×0 | 0.960 | 0.950 | 1% |
| **60** | **×3** | **×3** | **1.176** | **0.950** | **19%** |

A fully-committed Perception character throws away **19% of its own weak-point
investment** during exactly the window it bought Opening Read to create. The clamp
starts binding at PER 45 with both lines maxed. Nothing on the character sheet says
so.

Note also that `weakPointCap` (0.6) — the trait's own documented ceiling — is
unreachable: PER 60 plus three tiers of Study is 0.48. The real ceiling is the
0.95 in `blow.ts`, and it is only visible while a target is Vulnerable.

**With the rest of the game.** `SCALING_ATTRIBUTES` is
`['strength', 'agility', 'intelligence']` — **Perception is not a weapon-scaling
attribute.** It contributes nothing to the three addends a blow is made of. It is
pure multiplier: crit, weak-point multiplier, Exposed, Exploit all scale a base
number that some *other* attribute has to provide.

That single fact explains the strength table below.

## How strong is it?

180s against a stalker, level-60 budget (242 points), starter sword unless stated.
Measured through the real sim.

| build | points | kills | DPS | weak-point % | damage taken/kill |
|---|---|---|---|---|---|
| PER 60, no tiers | 55 | 46 | 2.9 | 54.7 | 9.1 |
| PER 60 + all PER tiers | 71 | 58 | 4.8 | 69.3 | 6.4 |
| PER 60 + tiers, **bow** | 71 | 69 | **7.1** | 80.8 | 4.8 |
| PER 60 + CON 55 + tiers | 118 | 61 | 5.7 | 82.0 | 0.4 |
| **PER 60 + STR 60 + tiers** | 126 | **106** | **12.9** | 43.3 | 0.0 |
| STR 60, no tiers *(reference)* | 55 | 76 | 7.4 | 4.0 | 0.0 |
| STR 60 + CON 60 *(reference)* | 110 | 76 | 7.4 | 4.0 | 0.0 |

And against the tanky elite:

| build | points | kills (vs ravager) | DPS |
|---|---|---|---|
| PER 60, no tiers | 55 | 12 | 1.0 |
| PER 60 + all tiers | 71 | 19 | 3.1 |
| PER 60 + tiers, bow | 71 | 24 | 4.2 |
| PER 60 + STR 60 + tiers | 126 | 48 | 12.4 |
| STR 60, no tiers | 55 | 30 | 4.5 |

The repo's own `npm run balance` agrees from the other direction: Pure Perception
runs 51 kills at 3.7 DPS with the highest weak-point rate in the game (50.3%) and
the **second-worst net health per kill of any build** (−6.5, beaten only by Pure
Wisdom), while **STR/PER is the strongest row in the table at 93 kills and 9.9 DPS**.

### The estimate

- **As a solo attribute: weak.** At equal cost, PER 60 delivers **39% of bare
  Strength's DPS** (2.9 vs 7.4) and 22% against an elite. Buying the whole tree
  lifts it to 65%, still behind an attribute that spent nothing on tiers.
- **With the right weapon: competitive.** A bow takes it to 7.1 DPS — level with
  bare Strength for 16 more points. The bow is not a preference; it is the
  difference between the build working and not.
- **As a multiplier on a real damage source: the best in the game.** PER+STR is
  **12.9 DPS and 106 kills — 74% above bare Strength**, and takes zero damage per
  kill. Nothing else measured comes close.
- **Ceiling: high, but only as a second attribute.** And that ceiling is reached
  *without* the branch's own top-end paying full value — Steady Aim contributes
  nothing, 19% of the weak-point investment is clamped away, and the four equipped
  skills are outside the system entirely.

The shape is consistent and, mostly, correct design: Perception is a force
multiplier that reads openings and converts precision into sustain. The problem is
that a player who commits to it alone is multiplying a number nobody gave them.

## Findings, in the order I would fix them

1. **Steady Aim never fires.** Snapshot stillness at `windupStartTick` the way spec
   221 snapshots `targetInReach`, and re-tune the 0.5s window against the measured
   29-tick inter-attack gap. Drop the no-op `steadyAimTicks: 0` from the grant.
2. **`abilityWeakPoints` is granted by nothing**, so the branch is invisible to the
   four equipped skills. Either grant it (the T3 milestone is the natural home) or
   delete the field and state that weak points are a basic-attack mechanic.
3. **Two preset premises describe deleted mechanics.** `flowWeakPoint` and
   `exploitPoiseFactor` have no granter; `npm run balance` narrates both as real.
   Fix the strings, or restore the grants.
4. **The 0.95 clamp is invisible.** Two purchasable lines compete for it and the
   sheet says nothing. Worth surfacing, or worth splitting so they compose.
5. **The audit has a blind spot.** `audit-progression.ts` proves a trait moves; it
   cannot prove the gate reading that trait can open. Steady Aim scores twelve
   clean `ACTIVE` cells while doing nothing. A "the guard was satisfied at least
   once in a real fight" check would have caught this and would catch the next one.
6. **Four remaining dead sockets** (`weakPointPayoffPct`, `exposedTeamResource`,
   `attunedFromWeakPoints`, and `weakPointCap`'s unreachable 0.6) — each is the
   thing CLAUDE.md keeps recording being rediscovered a hundred specs later.
