# Strength: Brutal Follow-Through / Heavy Handling / Overkill trace

Traced 2026-09-01. Re-read source before relying on line numbers for edits.
Companion to `strength-poise-progression.md` (Crushing Blows, Committed
Swing, Unstoppable) and `combat.md` (general lifecycle) — this covers the
other three Strength T2 specializations: `str.followThrough`,
`str.heavyHandling`, `str.overkill` (`data/specializations.ts:101-109`).

Same pipeline as the poise note: `perTier` scaled by tier count
(`progression.ts:80 scaleModifier` — **every** numeric field in `traits`,
including tick counts, is multiplied by tiers held, not just percentages)
→ summed → `player/derived.ts:199 deriveTraits` applies the one clamp/derive
step per field → `TraitStats` on `ServerEntity.stats.traits`.

## HEADLINE FINDING: Heavy Handling is unreachable by any content today

`sim/abilities.ts:284`: `if (ability.damage >= HEAVY_ABILITY_DAMAGE) scale *=
traits.heavyWindupScale;` — live code, runs every cast. But
`HEAVY_ABILITY_DAMAGE = 6` (`abilities.ts:245`) and **every row in
`data/abilities.ts`'s `DEFINITIONS` table has `damage` between 0 and 4**
(max is `skill.whirlwind` at 4; grep of every `damage:` field confirms it,
28 rows). Zero rows satisfy `>= 6`. There is no `heavy: boolean` field on
`AbilityDefinition` anywhere — "heavy" is *only* this damage threshold.

This is a regression, not an original design gap, and it's traceable:
- Spec 217 (commit `86391ffe`) rescaled ability damage /7 and moved
  `HEAVY_ABILITY_DAMAGE` 40→6 *specifically so `melee.heavy` (damage 6 post-
  rescale) would still clear it* — comment at `abilities.ts:242-244`: "Left
  at 40 it would be a threshold no ability in the table could reach, so
  Strength's Heavy Handling would silently stop applying to anything."
  `melee.heavy` was the *only* row ever at/above the line (verified via
  `git show 86391ffe:src/server/data/abilities.ts` — `damage: 6` exactly).
- Spec 237 (`specs/237-the-abilities-nothing-grants.md`) then deleted
  `melee.heavy` entirely as unreachable-by-content (nothing granted it as a
  skill/basic-attack; it was leftover from spec 062's demo set). Spec 237's
  own text calls out an analogous cooldown-clamp finding but says **nothing**
  about `HEAVY_ABILITY_DAMAGE`/Heavy Handling — this consequence looks
  undiscovered.
- Net effect: the one ability that ever satisfied the threshold is gone, the
  threshold never moved, nothing new was authored above it.
- `npm run audit:progression` (`player/progression-audit.ts`) will **not**
  catch this: its `ACTIVE` verdict only checks whether a purchase moves a
  value on `TraitStats`/`EffectiveStats` (it does — `heavyWindupScale` moves
  from 1.0 toward 0.55 at max tier). It does not simulate the gating
  condition (`ability.damage >= 6`) against the content table, so this
  passes that audit clean while doing nothing in play.
- Secondary, non-gameplay confirmation: `render/iso3d/world/view.ts:1858`
  reads the *same* `(ability?.damage ?? 0) >= HEAVY_ABILITY_DAMAGE` to decide
  whether to play a "heavy swing" sound cue — that cue is equally
  unreachable, corroborating from the presentation side.

Fix is a data change (either lower `HEAVY_ABILITY_DAMAGE`, or author a skill
row at/above it, or both), not a sim change — flagging here rather than
fixing since it's a balance decision.

## Brutal Follow-Through (`momentumTicks`/`momentumWindupScale`) — LIVE, wired

Grant: `sim/blow.ts:429-457 rewardBreak(attacker, tick)`, called from
`resolveBlow`'s poise section at `blow.ts:377`, **only** inside
`if (poised.broke)` (`poised` from `sim/poise.ts`'s `applyPoiseDamage`,
called at `blow.ts:350`). Fires for *any* attacker whose blow breaks the
*target's* poise — generic guard-break, not restricted to `skill.guardBreak`
— but only entities with `momentumTicks > 0 && momentumWindupScale > 0` do
anything (monsters default to 0 via `NEUTRAL_TRAITS`, so in practice this is
a player-only payout since only players buy specializations):

```
if (A.momentumTicks > 0 && A.momentumWindupScale > 0) {
  next = { ...next, statuses: applyStatus(next.statuses, StatusId.Momentum, tick,
    A.momentumTicks, { magnitude: A.momentumWindupScale }) };
}
```

Consume: `sim/abilities.ts:286-287`, inside `windupScaleFor` — `scale *= 1 -
momentum.magnitude`. This only ever runs as part of computing
`baseAttackPointTicks` (the wind-up), snapshotted **once**, at cast start
(`startCast` → `attackTimingFor` → `windupScaleFor`, `abilities.ts:672`
comment: "Snapshotted here and never recomputed... a buff that lands halfway
through a wind-up belongs to the next attack, not this one"). Cleared
unconditionally at the next cast's attack-point/commit tick regardless of
ability (`abilities.ts:1400-1401`, inside the block literally commented
`--- the attack point: COMMIT ---`), or simply expires after `momentumTicks`
if no cast commits first. Net effect: functions as "your very next attack to
commit gets a shorter wind-up," not a persistent buff you can spend on
purpose — and if a *different*, already-in-flight cast commits before you
start a new one, momentum is silently discarded unread (started before the
status existed, so its snapshot never saw it; then cleared anyway at that
cast's commit).

**Does not touch the interval — confirmed, does not buy attacks/sec.**
`attackTimingFor`'s basic-attack branch (`abilities.ts:220-238`):
`baseAttackTimeTicks: entity.stats.baseAttackTimeTicks` (untouched by
`shaped`/momentum) vs. `baseAttackPointTicks: ability.windupTicks * shaped *
...` (the only field `shaped` reaches). `resolveAttackTiming` divides `bat`
(→ `intervalTicks`) and `point` (→ `attackPointTicks`) by the *same*
attack-speed `factor`, but `shaped` is baked into `point` before that
division and never into `bat`. So momentum shrinks the wind-up only; the
next-attack-allowed tick (`intervalTicks` from cast start) is unaffected,
and the backswing gets to run longer (more of the interval left over) rather
than the attack becoming more frequent. Same structural rule CLAUDE.md states
for Agility, holding here by construction, not by convention.

Arithmetic (tier register `perTier`, ×tiers-held via `scaleModifier`, `SCALING.agility.flowTicks = seconds(1.2) = 72`):
- `momentumTicks` = `round(72 * 0.5)` = 36/tier → 36/72/**108** ticks
  (0.6s/1.2s/**1.8s**) at tier 1/2/3. `derived.ts:349`: `max(0, round(...))`,
  no upper cap.
- `momentumWindupScale` = 0.12/tier → 0.12/0.24/**0.36** at tier 1/2/3.
  `derived.ts:350`: `clamp(t.momentumWindupScale, 0, 0.9)` — cap never bites
  (max reachable is 0.36). Consumed as `1 - magnitude`, i.e. wind-up ×0.64 at
  max tier.

No test file references `momentumTicks`/`momentumWindupScale`/`Momentum`'s
guard-break mechanic by name (only generic every-`StatusId` sweep tests
touch `StatusId.Momentum` — visuals/semantics tables, not the reward logic).

## Overkill (`overkillResource`) — LIVE, but conditionally useless without a slotted skill

Detect: `blow.ts:309`, inside `resolveBlow` itself (not a separate module):
```
const overkill = killed && toHealth >= targetIn.health * (1 + SCALING.combat.overkillFraction);
```
`SCALING.combat.overkillFraction = 0.25` (`data/scaling.ts:311`) — `toHealth`
is post-shield damage actually applied to health; `targetIn.health` is the
target's health *before* this blow. So: killing blow's health-damage must be
≥125% of what remained.

Consume (the trait in question): `blow.ts:564`, inside `rewardAttacker`
(also called from `resolveBlow`, same function graph as the detect):
```
if (outcome.overkill && A.overkillResource > 0) resource += A.overkillResource;
```
capped at `next.stats.maxResource` two lines later. Arithmetic: 4/tier, no
other cap — 4/8/**12** resource per qualifying kill at tier 1/2/3
(`derived.ts:348`: `Math.max(0, t.overkillResource)`).

**Does the `overkill` boolean reach `creditDeaths`? Yes, but not this
trait.** `overkill` also rides `qualities.overkill` on the `died` event
(`blow.ts:407-409`), which `world.ts:1785 creditDeaths` → `creditKill` reads
via `sim/restoration.ts:291`: `if (qualities.overkill) add('overkill',
B.overkill + traits.restoreOverkillPct)`. That's a *separate* trait
(`restoreOverkillPct`, presumably Constitution-side, not traced here) feeding
the restoration/health-economy meter — unrelated to `overkillResource`.
Two independent consumers of one shared boolean; don't conflate them.

**Resource is not an Intelligence-exclusive pool.** `player/stats.ts:291-301`:
`maxResource = BASE_RESOURCE(20) + 2*INT + 1*WIS + bonus`; regen =
`(2 + 0.12*WIS)/60 + bonus` per tick — every character has the 20-point base
regardless of build. Spent by `resourceCostFor` (`abilities.ts:391-411`,
`0` if `ability.cost <= 0`) at cast start (`abilities.ts:718`:
`resource: Math.max(0, entity.resource - cost)`). Basic attacks
(`melee.slash`/`ranged.*`) and the flask (`self.hearthdraught`) are all
`cost: 0`. But several `skill.*` rows with clear Strength/Agility flavor
have real costs and are equally equippable by any build (the 4 skill slots
are equipment, not attribute-gated): `skill.guardBreak` cost 3,
`skill.cripplingStrike` cost 4, `skill.rendingCut` cost 3,
`skill.stunningBlow` cost 6, `skill.whirlwind` cost 9. So a pure-Strength
character *does* have a use for the resource **iff they slot one of those**
— e.g. `skill.guardBreak` is the natural pairing with Brutal Follow-Through
(cast it, break the guard, get Momentum + Overkill-funded resource to cast
it again). A build that only ever swings the free basic attack and slots no
skill has nothing to spend Overkill's grant on — resource just sits at/near
`maxResource`. This is a loadout-dependent conditional, not a structural
content gap like Heavy Handling's.
