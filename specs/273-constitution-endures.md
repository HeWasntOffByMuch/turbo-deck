# 273 — Constitution endures

## Problem

`docs/constitution-progression-review.md` measured the Constitution track end to
end. It is mechanically sound — all nine nodes reach the sim, and none of
`audit:progression`'s findings are on it — and three things are wrong with it.

**Guard regeneration is a switch, not a slope.** `regenPoise` zeroes the rate on
any tick the body moved unless `poiseRegenMoving` is granted, and **nothing in
the game grants it**: the branch's comment points at the Agility+Constitution
pair spec 244 deleted. So Steady Frame's three ranks and the CON 20 milestone
that deepens them are worth exactly zero to a repositioning body, in a game whose
thesis is committing to a blow and withdrawing from it. Neither tooltip mentions
movement; only the character sheet's stat hint does.

**Second Wind fights the tier it shares a threshold with.** It bypasses
`applyHealing` entirely, so the track's largest single heal takes neither the
`healingScale` nor the desperation surge Constitution itself bought, and its
overflow is discarded rather than becoming Overflow Vitality's shield. And it
fires at 30% and lands at 61%, which is *above* the Hard to Kill window and above
the desperation window the same threshold armed. Two purchases at CON 25, and one
switches the other off.

**The track finishes at level 18.** 55 attribute points to the cap plus sixteen
tiers is 71 of the 242 a level-60 character has, and there is no Constitution
purchase at level 40 that a level-18 character has not already made.

Constitution means **endure**. The loop it should read as is *take pressure →
recover Guard → survive the breaking point → stabilize at low health → convert
healing into future durability → outlast*, and two of those arrows are currently
broken.

## Shape

### Movement reduces recovery; it does not switch it off

`poiseRegenMoving` stops being a flag and becomes the **fraction of the base rate
a moving body keeps**.

```ts
// sim/poise.ts
if (staggered)                 rate *= traits.poiseRegenStaggered;
else if (resoluteCalm)         rate *= 1 + traits.poiseRegenCalm;  // new, mastery
else if (moving)               rate *= traits.poiseRegenMoving;    // was `rate = 0`
else if (entity.cast === null) rate *= 1 + traits.poiseRegenCalm;
```

```ts
// data/scaling.ts, constitution
poiseRegenMovingBase: 0.3,   // what any body with a Constitution derivation keeps
poiseRegenMovingCap:  0.75,  // and never more, so standing always wins
dangerBelow: 0.3,            // the one low-health threshold, named once
```

`deriveTraits` resolves it as `clamp(base + t.poiseRegenMoving, 0, cap)`.
**`NEUTRAL_TRAITS` keeps 0, so `monsterTraits` is untouched** — a monster that
regenerated Guard while chasing would be a broad enemy rebalance and a nerf to
Strength's stagger pressure, and this spec is not that.

Steady Frame grants `poiseRegenMoving: 0.05` a rank beside its existing
`poiseRegenPct: 0.4`, so the specialization deepens the state it is named for.

### Second Wind stabilizes inside the danger band

`applyHealing` gains one optional argument — a **health ceiling for this heal**,
defaulting to `maxHealth`, so all three existing callers are byte-identical.

```ts
export function applyHealing(
  entity: ServerEntity, amount: number, tick: number, ceiling?: number,
): HealResult
```

`room` is measured against `min(maxHealth, ceiling)`; everything the ceiling
leaves is `overheal` and cascades exactly as it does today — Constitution's
shield, then Wisdom's conversion, then Wisdom's salvage.

`advanceProgression` then routes Second Wind through it:

```ts
applyHealing(entity, maxHealth * secondWindHeal, tick, maxHealth * dangerBelow)
```

The ceiling is `SCALING.constitution.dangerBelow` and **not a number of its
own**: it is the same 0.3 that `resoluteBelow`, `staggerImmuneBelow` and
`secondWindBelow` are, and `isResolute` compares with `<=`, so stabilizing lands
the body exactly at the top of the band the same threshold armed rather than out
of it. Hard to Kill stays on, the stagger immunity stays on, the desperation
surge (0.4) stays on — and the part of the heal that will not fit becomes a
shield, which is durability rather than health, so it cannot eject the player
either. The four literal `0.3`s in `derived.ts` and `milestones.ts` collapse onto
that constant.

Second Wind stays bounded exactly as it is: `SecondWindSpent` is held until a
rest or a death, and nothing else clears it.

### Late depth: three mastery specializations at CON 50

Constitution-only, on the existing threshold the Overflow Vitality milestone
already sits on — `TrackNode` has always allowed a node to carry both. Priced
above 1 through `costPerTier`, which has been on `SpecializationDefinition` since
spec 244 with no row using it.

| Row | Ranks | Cost/rank | Grants |
|---|---|---|---|
| `con.unbroken` — Steady Frame mastery | 3 | 2 | `poiseRegenMoving +0.1` |
| `con.deathsDoor` — Hard to Kill mastery | 1 | 4 | `resoluteRegenCalm: 1` |
| `con.deepWell` — Overflow Vitality mastery | 3 | 2 | `overhealShieldPct +0.08` |

Two new traits. `resoluteRegenCalm` is a **capability flag**, the pattern spec
239 settled on: while Resolute, Guard recovers at the calm rate whatever the body
is doing, so a character who survives the danger band comes out of it with a
guard rather than an empty pool. `overhealShieldPct` raises the shield's ceiling
fraction, so the convert-healing-into-durability loop has somewhere to go.

Sixteen further points, and the spec does not pretend that solves saturation.

`fullSpreadOf` in `data/presets.ts` charges one point a tier regardless of
`costPerTier`; it must charge `costOfNextTier`, or every preset under-pays for a
mastery rank.

### Truthful text

- Steady Frame's `trigger` becomes `'always -- most while holding ground'`,
  because `poiseRegenPct` multiplies the base rate in every state.
- The CON 20 milestone's `effect` names holding ground rather than only casting.
- `GRANT_LABELS` gains `poiseRegenMoving`, so the derived description says what
  the new grant does instead of dropping the line.
- The CON 50 milestone's `effect` reads as the delta it is (`+8s`), not as a
  total that is wrong the moment the CON 40 tier is also held.
- `attributes.ts` stops claiming Constitution does not own healing efficiency:
  Wisdom is the primary owner, Constitution adds a smaller share through
  `healingPer` and owns the desperation surge outright.
- The stale premises on `pair.strCon` and `pair.conWis` describe pair bonuses
  spec 244 deleted; they are rewritten, not re-implemented.

### Measurement

`data/presets.ts` gains Constitution rows the harness has never had — the twelve
`pure`/`pair` presets spend nothing on tiers, and all four `spend.*` rows are
Strength. New: `spend.con`, `spend.conFull`, `spend.conStr`, `pair.conPer`,
`pair.conInt`.

`scripts/probe-constitution.ts` gains the loop sheet: Guard breaks suffered,
Guard regenerated by state, ticks spent moving/casting/staggered, time below the
danger threshold, Second Wind triggers with raw/effective/overheal/shield, and
shield uptime — sampled per tick off the real entity.

## Invariants tested

**Moving Guard regen**
- A standing body recovers the full rate; a moving body recovers a nonzero
  fraction of it; moving is strictly below standing at every legal build.
- Casting and staggered behaviour are unchanged.
- The moving fraction is `poiseRegenMovingBase` plus what is granted, clamped at
  `poiseRegenMovingCap`, and the cap is strictly below 1.
- `monsterTraits` still answers 0, so no monster gains Guard while chasing.

**Steady Frame**
- Every rank moves both the base rate and the moving fraction.
- No rank is worth zero while moving.
- The derived description names the moving grant, and the trigger does not claim
  a condition the grant does not have.

**Deep Reserves** — health and Guard capacity unchanged; max-health-scaled
restoration still scales with it.

**Second Wind**
- Fires only at or below the threshold, and only once until a rest or a death —
  asserted by crossing the threshold repeatedly.
- Goes through `applyHealing`: `healingScale`, the desperation surge and Decay's
  suppression all apply.
- Stabilized health never exceeds `maxHealth * dangerBelow`.
- The body is still Resolute and still stagger-immune after it fires.
- Its overheal reaches Overflow Vitality's shield, and is capped by `maxShield`.
- `applyHealing` with no ceiling is byte-identical to today.

**Hard to Kill** — the reduction applies only inside the band; the stagger
immunity is granted by the milestone and by nothing else; purchasable ranks
never grant it.

**Sustained Effort** — Guard recovery while staggered still works and every rank
moves it; Stagger itself is not bypassed.

**Overflow Vitality** — the cap is `maxHealth * (shieldFraction + overhealShieldPct)`;
durations stack additively and the milestone's text is a delta; Wisdom's
conversion still takes what the shield leaves.

**Mastery** — every new tier is reachable, moves a trait the sim reads, is not
swallowed by a cap, and costs `costPerTier` points in `fullSpreadOf` as well as
in `buySpecializationTier`.

**Healing ownership** — Constitution's contribution to `healingScale` stays
strictly smaller than Wisdom's at equal investment.

## Out of scope

- The other five attributes. No threshold, milestone or specialization outside
  Constitution moves.
- Explicit stat-pair synergies. The hybrid presets are systemic tests, not a
  restored `synergies.ts`.
- Monster Guard regeneration, enemy rebalancing, the healing system at large, the
  resource economy, and the global progression-point budget. Saturation is
  *reduced* here, not solved; whether 242 points is too many is a question about
  every track and wants a spec of its own.
- A downed/revive system, wounds, and any second Guard-recovery subsystem.
- Sustained Effort's real value. A guard break refills the pool whole
  (`applyPoiseDamage`), so `poiseRegenStaggered` only reaches poise drained by
  blows landing *inside* the stagger window. That is measured and reported here
  rather than redesigned.
