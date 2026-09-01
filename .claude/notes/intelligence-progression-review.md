# Intelligence progression review (specs 147 / 238 / 239 / 244)

Reviewed 2026-09-01. Companion traces: `damage-scaling.md`, `intelligence-mechanics.md`.
Read the code before trusting this — it is a summary, not a source.

Evidence: `npm run audit:progression -- --all`, `npm run balance`, and a derived-stat
harness driven through the real `computeEffectiveStats`.

## The one-line finding

Every Intelligence trait field has a live consumer in the sim, but **three of the
six specializations are priced in a resource the attribute itself makes free**,
the signature row is the only one in the game the audit calls backwards, and the
tree's largest multiplier is silently spent by the auto-attack.

## Findings, by severity

### 1. A basic attack consumes Prepared for no benefit  (live bug)

`windupScaleFor` applies `preparedWindupScale` only when `!ability.basicAttack`
(`sim/abilities.ts:289`). The clear at the attack point has no such guard
(`sim/abilities.ts:1394`). `autoAttack` is a standing order, so banking Prepared
and letting one swing through burns a 0.22x wind-up — the biggest multiplier in
the track — for nothing. Fix is to guard the clear with the condition that gates
the benefit.

### 2. The resource economy is not a constraint, so three specializations are idle

`maxResource = 20 + 2*INT + 1*WIS`; `resourceRegen = (2 + 0.12*WIS)/60`.
**Intelligence buys pool and no regen.** At INT 60: 145 pool, 2.6/s regen.
Ability costs are 3-7. Four slots all firing off cooldown drain 2.22/s against
2.60/s regen; the harness measures Pure Intelligence at `RES x` **0.90**.

- `int.overflow` (capstone, INT 40 / milestone 50) fires only on an empty pool.
  The attribute that unlocks it guarantees it is never empty.
- `int.shaping`'s cost premium is inert against that pool.
- `int.efficientConstruction` pays off a premium nobody notices.

Overflow is also the least discoverable thing in the tree: no `StatusId`, no wire
flag, no VFX/sound, no `GRANT_LABELS` row. The health write bypasses `resolveBlow`,
so it reuses the take-a-hit flash with no floating number. Its rate and 40%-of-
current-health cap appear in prose only in the *milestone's* flavour line.

Note `maxResource` uses the raw attribute, not `above()` — against the baseline
rule `data/scaling.ts` states for every other scale.

### 3. Spell Shaping is the only BACKWARDS row in the game

All 15 of the audit's 15 BACKWARDS cells are `int.shaping`. The design (geometry
at a premium, antidote elsewhere) is fine; the **ordering** is not — Shaping is
T1 at INT 10, Efficient Construction is T2 at INT 25. Fifteen attribute points
where the signature row is a net loss with no way to pay it off.

| EC tiers | relief | premium left | tier delivered |
|---|---|---|---|
| 0 | 0% | 40% | — |
| 1 | 40% | 24% | 16 pp |
| 2 | 80% | 8% | 16 pp |
| 3 | 100% | 0% | **8 pp** |

Two consequences: EC tier 3 delivers half a tier because `clamp(relief, 0, 1)`
eats the overshoot from 1.2 (the "bought into a filled cap" fault spec 239 fixed
four times elsewhere — the audit's `TRAIT_DIRECTION` checks direction, not
magnitude); and past 3 tiers the premium is exactly 0 at every Shaping level, so
the drawback stops existing for any completed build.

### 4. Three payoffs live in the sim, unreachable from content

Of the 22 fields spec 244's synergy removal orphaned (`docs/progression-model.md`):

| field | live code | lost with |
|---|---|---|
| `appliesSundered` | `sim/blow.ts:509` | STR/INT pair |
| `preparedMastery` | `abilities.ts:371, 407` | INT/WIS pair |
| `spellbladeHandling` | `abilities.ts:281` | AGI/INT pair |
| `SCALING.intelligence.spellPowerPer` | **read by nothing** | spec 238 |

Intelligence's case differs from the other 19: **`int.catalysis` still authors
`appliesSundered: 0` in its own row** — a socket inside a specialization a player
spends points on. And `data/presets.ts` still advertises two of the dead
mechanics in premises `npm run balance` prints every run (INT/WIS "refunds its
cooldown"; AGI/INT "winds up at weapon speed").

### 5. Prepared cannot compose with Agility; a crowd resets it

`attackTimingFor`: a non-basic ability's wind-up has **no `attackPointScale`
term**; a basic attack's has no Prepared. They sit on opposite branches of
`ability.basicAttack` and can never appear in one product. Combined with the dead
`spellbladeHandling`, AGI/INT has no mechanical support.

`moved` is an **exact float comparison** (`sim/world.ts:1050`), so an ORCA nudge
from `resolveCrowding` resets the stillness clock — hardest to hold in exactly
the massed fight the AoE kit wants. `busy = moved || entity.cast !== null` counts
the whole wind-up and follow-through, so the clock restarts after every cast:
Prepared is an opener, not a rotation tool. Being hit resets it (`sim/blow.ts:322`).

What it gets right: granted with effectively infinite duration (banked, not
clocked) and it has a full `StatusVisual` row.

### 6. One Intelligence-scaling weapon, shop-only

Five of six weapons author `intelligence: ScalingGrade.None`. `staff.emberwood`
(grade A, level 4, rare) is the exception and is in no loot table — shop only.
Nothing in the starting kit (`sword.worn`, `sigil.guardBreak`) scales with
Intelligence; the affliction sigils are rare at 4-5 and exceptional at 6.

## Strength estimate

Harness (30s stationary duel vs one ravager, `tierShare: 0` — no tiers bought):

| build | kills | dps | hp/kill | root% | res x |
|---|---|---|---|---|---|
| Pure Intelligence | 4 | 5.7 | 17.6 | **85.7** | 0.90 |
| INT/WIS | 4 | 5.3 | 14.3 | **87.6** | 1.00 |
| AGI/INT | 4 | 5.0 | 12.5 | 67.9 | 1.00 |
| Pure Strength | 5 | 6.4 | 10.8 | 75.0 | 0.00 |
| STR/PER (best) | 7 | 10.2 | 9.1 | 75.0 | 0.00 |

Two caveats: every attribute preset spends nothing on tiers, and **all four
`spend.*` presets are Strength-flavoured — no Intelligence build that buys its
own tree has ever been fought by the harness.**

Computed at full kit (INT 65 eff, spellPower 1.50), before crit/weak point/armour:

| skill | direct | affliction | per target | max targets | burst | cd |
|---|---|---|---|---|---|---|
| arcLash | 13.9 | 24.6 | 38.5 | 4 | **154** | 9s |
| emberToss | 11.3 | 21.3 | 32.5 | blast r112 | — | 8s |
| acidSpray | 12.9 | 17.9 | 30.8 | cone | — | 10s |
| rimeTouch | 12.9 | 11.9 | 24.8 | 5 | 124 | 11s |
| blight | 12.9 | 9.9 | 22.8 | blast r176 | — | 12s |

Roster for scale: grazer 3, spider 6, slinger 9, stalker 10, sheep 18,
ravager 35, warden 56. **The affliction is 43-65% of every skill's damage.**
At +60% radius / +39% range, Arc Lash is a 480-unit line and Blight reaches 528.

**Verdict:** strongest group-clear in the game (one Arc Lash kills four
full-health ravagers; only Whirlwind is comparable AoE), ~56% of the best build's
single-target DPS, and last in survivability — 106 HP against an INT/CON
hybrid's 272, no armour route, no self-heal, highest rooted fraction in the
table. A glass artillery piece, which is a coherent identity. The problems are
in the economy, not the damage.

## Synergy / anti-synergy

**Composes:** Catalysis is self-enabling (all six INT skills apply an affliction,
so `vsAfflictedPct` +24% is live from the second cast); Shaping feeds Catalysis
(more radius, more afflicted bodies); an ability's INT letter raises the direct
hit *and* the affliction magnitude (5.0x at full kit) through one term with no
double-count; Prepared rewards the stance an 85.7%-rooted build already has;
`restoreAbilityKillPct` gave Pure INT 308 restoration, the largest single route
of any build.

**Fights itself:** pool scaling vs Overflow; the shaping premium vs the same
pool; drawback at INT 10 vs antidote at INT 25; Prepared vs auto-attack; Prepared
vs crowd nudges; Prepared vs Agility.

## Recommended, ranked

1. Guard the Prepared clear with the condition that gates its benefit. One line;
   bug fix, no spec needed.
2. Decide what the pool is for before touching Overflow — regen + smaller pool,
   or higher costs, or move Overflow off the pure-INT capstone.
3. Swap the Shaping / Efficient Construction thresholds (kills all 15 BACKWARDS
   cells with no coefficient change); retune `shapingCostRelief` to ~0.34/tier so
   tier 3 is not half-eaten by the clamp.
4. Resolve `appliesSundered` — give `int.catalysis` a real magnitude, or drop the
   field from the row.
5. Delete `spellPowerPer`; correct the INT/WIS and AGI/INT preset premises.
6. Add an Intelligence spending preset and a multi-target scenario to the harness.
   Either would have surfaced findings 2 and 3 without this review.
7. Put an epsilon on `moved`; give an overflow cast a cue distinct from being hit.

Published write-up: https://claude.ai/code/artifact/18e4670e-1611-4bc0-a037-0e4a487a9cd2
