# 270 — Intelligence as artillery: the stance, the magazine and the weave

## Problem

Spec 269's review measured the Intelligence track end to end. Every trait field
it grants reaches the sim, and the damage is competitive. What is wrong is the
*economy the track is written in*, and one live bug:

1. **A basic attack spends Prepared for nothing.** `windupScaleFor` applies
   `preparedWindupScale` only when `!ability.basicAttack`; the clear at the
   attack point has no such guard. `autoAttack` is a standing order, so the
   largest multiplier in the tree is routinely thrown away.
2. **Prepared is not a stance.** `busy = moved || entity.cast !== null` and
   `startCast` stamps `stillSinceTick`, so casting destroys the stance the cast
   was prepared for; at full investment the setup is 0.6s, which is a passive
   proc rather than a decision. And `moved` is exact float equality on position,
   which is the wrong predicate for "did the player choose to move".
3. **Resource is not a constraint.** Pool is `20 + 2*INT + 1*WIS` and
   regeneration is a flat 2/s that Intelligence does not touch. At INT 60 that
   is 145 points against a four-slot rotation drawing 2.2/s — measured `RES x`
   0.90. So the shaping premium cannot be felt, Efficient Construction buys back
   nothing, and Arcane Overflow — the capstone — needs an empty pool the
   attribute guarantees is never empty.
4. **Two specializations are not behaviour.** `int.potency` is +5% spell power a
   tier, which is what advancing Intelligence already does. `int.efficientConstruction`
   exists only to delete `int.shaping`'s drawback, and does so completely at
   three tiers (`clamp(relief, 0, 1)` also eats half of tier 3).
5. **`int.catalysis` authors `appliesSundered: 0`** — a socket in a row players
   spend points on, orphaned when spec 244 removed the pairs.

## The shape

**Intelligence = glass artillery.** Two purchasable playstyles rather than six
variations of standing still:

- **Prepared** — plant, build a stance, fire one very fast committed cast.
- **Arcane Weaving** — rotate through *different* abilities rather than pressing one.

Both spend from a magazine Intelligence makes large and Wisdom makes sustainable.

### Prepared, as a stance

`advanceProgression` gains a `stepDistance` argument and breaks the stance on
`stepDistance > SCALING.intelligence.stanceMoveEpsilon` rather than on `moved`.
`moved` keeps its meaning everywhere else (Activity, poise regen) — this is a
second, narrower predicate, not a redefinition.

- Casting no longer breaks the stance: `busy` drops the `cast !== null` term and
  `startCast` stops stamping `stillSinceTick`.
- Consuming Prepared re-stamps `stillSinceTick`, so the interval restarts and one
  preparation can never accelerate every later cast. No new field.
- Being hit still resets it (`blow.ts` already stamps `stillSinceTick`).
- Setup is `SCALING.intelligence.prepareTicks`, raised so full investment lands
  near **2s** instead of 0.6s, with a floor that keeps it a stance.

`preparedApplies(ability)` is the one answer to "does this cast use Prepared",
read by both `windupScaleFor` and the consume site.

### The magazine

Intelligence keeps `resourcePer`. The flat `RESOURCE_REGEN_PER_SECOND` drops and
`SCALING.wisdom.regenPer` rises, so a high-Wisdom character regenerates *more*
than today and a low-Wisdom one much less. Exact values are chosen against the
harness, to the target: **sustained aggressive casting empties a pure-Intelligence
pool in tens of seconds**, and INT/WIS extends that materially.

### Shaping and Efficient Construction

The premium stays and becomes real. `shapingCostRelief` is clamped to
`SCALING.intelligence.shapingReliefCap` (< 1), and the per-tier value is chosen
so three tiers reach that cap exactly — every tier delivers its whole step and a
shaped cast is still more expensive than an unshaped one at maximum investment.

`shapingCostPct` rising with a Spell Shaping tier is an **intentional tradeoff**,
declared in `progression-audit.ts` rather than tuned away.

### Arcane Weaving

`int.potency` is removed. `int.weaving` replaces it: committing a non-basic
ability whose id differs from the last one woven adds a `StatusId.Weave` stack
and refreshes the window; repeating the same ability does neither. Stacks raise
the **magnitude of afflictions this caster applies** — manipulation, not another
damage multiplier, and it composes with Catalysis rather than duplicating it.

`ServerEntity.lastWovenAbilityId` is the only new entity field.

### Catalysis

`appliesSundered` becomes real: `blow.ts`'s gate changes from "this was a basic
attack" to "the target already carries an affliction", which is Catalysis's own
trigger. The field stops being a socket.

### Overdraw

The existing shortfall-to-health conversion is already the requested model; what
it lacked was a reachable trigger (fixed by the magazine) and any way to see it.
It gains `StatusId.Overdrawn` — replicated, with a `StatusVisual` row — so a
spell eating your health does not read as an enemy hitting you. The 40%-of-current
-health cap and the `Math.max(1, ...)` floor are retained.

## Data shape

New `TraitStats` / `TraitModifier` fields, appended to `TRAIT_WIRE_ORDER`:
`grantsWeave`, `weaveEffectPct`, `weaveMaxStacks`, `weaveTicks`.

New `SCALING.intelligence` keys: `stanceMoveEpsilon`, `shapingReliefCap`,
`weaveTicks`, `weaveMaxStacks`. `spellPowerPer` is deleted — nothing reads it.

New status ids: `Weave`, `Overdrawn`.

## Invariants (tested)

**Prepared** — a basic attack neither benefits from nor consumes it; an eligible
ability does both; movement past the epsilon resets the stance and displacement
under it does not; the configured duration is required; casting while planted
does not reset the stance; it rebuilds after consumption while still planted.

**Resource** — a pure-Intelligence build depletes under sustained casting;
raising Intelligence grants no regeneration; raising Wisdom improves sustain.

**Shaping** — a shaped cast costs more; geometry applies; every Efficient
Construction tier moves the premium; the premium is never zero.

**Weaving** — different abilities advance it, the same one does not; every tier
moves the affliction magnitude; the window expires.

**Overdraw** — only on a shortfall; resource is spent first; health covers the
rest; resource never goes negative; the cap refuses rather than partially casts;
the caster survives; the status is applied.

**Audit** — no legally purchasable Intelligence tier is inert, capped, or
backwards except the declared shaping tradeoff.

## Out of scope

- The other five attributes, and any explicit stat-pair synergy system.
- Weapon/loot availability. Exactly one weapon in the game scales with
  Intelligence (`staff.emberwood`, grade A, shop-only, in no loot table). Real,
  and a content task rather than this one.
- Broad deletion of the twenty-two orphaned wire traits. `preparedMastery` and
  `spellbladeHandling` stay dormant — neither is needed by this design, and
  removing a field from `TraitStats` is a protocol change.
- Enemy rebalancing, new resources, weapon scaling, and the active-ability table
  beyond what the economy requires.
