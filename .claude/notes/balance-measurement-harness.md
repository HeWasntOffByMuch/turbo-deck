# The balance/measurement harness family, for writing a new probe

Traced 2026-09-04 against `integration` branch. Read source before trusting
line numbers for edits — these scripts get touched often.

There is no single "harness library" — each script (`balance-builds.ts`,
`probe-constitution.ts`, `balance-perception.ts`, `observed-effects.ts`) hand-rolls
its own copy of the same ~40-line pattern: build a `PersistedPlayer` record,
run it through `computeEffectiveStats`, `spawnEntity` it into a
`createWorldState`, drive `step()` in a loop with a hand-built `ServerInput`,
sample the returned entity/events. No abstraction extracts this — each script
just copies and adapts the previous one. A new probe should do the same:
copy `probe-constitution.ts`'s `fight()` shape rather than trying to import a
shared driver that doesn't exist.

## 1. `npm run balance` → `scripts/balance-builds.ts` (NOT `balance.ts`)

package.json:31 `"balance": "tsx scripts/balance-builds.ts"`. 1225 lines.

- Fights `BUILD_PRESETS` (`src/server/data/presets.ts:140-366`) one at a time
  against one `monsterById(monsterId)` (default `ravager`), `seconds` long
  (default 30), on flat terrain, both bodies stationary at one spot each tick
  (`fight()`, balance-builds.ts:417-610).
- Presets: 6 pure attribute (`pure.strength`...`pure.wisdom`), 6 hybrid pairs
  (`pair.strCon` etc.), 4 `spend.*` (tierShare axis), 4 Constitution `spend.*`,
  6 `wisdomFocus` rows + `wis.full`, `spend.generalist`. `fullSpreadOf`
  (presets.ts:417-514) is the deal-points-round-robin allocator; `tierShare`
  decides what fraction goes to specialization tiers vs. raw attribute points,
  gated per tier by `specialization.requires` (milestone threshold).
- Prints 5 sections: main table (KILLS/DPS/HP-KILL/STAG-K/WEAK%/ABSORB%/RES x/
  ROOT%/CC%/ALIVE), commitment table (spec 271, `--foes`), sustain/health-economy
  table (spec 156, NET/K etc.), Mobile Offense (spec 254), Wisdom (spec 275),
  Intelligence (spec 270). `--seconds=`, `--monster=`, `--seed=`, `--preset=`,
  `--foes=`, `--arc=` flags (flag() helper, balance-builds.ts:104-107).
- Loadout: `harnessSigilsFor` (line 690) ranks all `skill`-slot sigils by
  `resolvedDamage` against the build's own stats and takes the top 4 — not
  hand-picked. `bestReady` (745) picks the heaviest ready+affordable non-basic
  ability ≥2x weapon damage, else falls back to the weapon.
- **The Wisdom section's `WisdomProbe`/`sampleWisdom`/`cheapestCost`
  (lines 335-415) is the closest existing prior art to a resource-economy
  probe** — it already tracks `minResource`, `ticksStarved` (via
  `cheapestCost`, the min `resourceCostFor` over the carried skill bar), mastery
  stack ticks, cooldown seconds saved. It's inline and Wisdom-specific, sampled
  once per tick from outside the sim (not part of `BuildMetrics`).

## 2. `src/server/sim/metrics.ts` — `BuildMetrics` (24-118), pure fold over `ServerSimEvent[]`

**No resource-starvation field.** `resourceSpent`/`resourceRestored` exist
(`foldResource`, 308-328, sampled before/after per tick — spending is silent,
not an event) but nothing counts "could this body not afford anything." That
concept only exists ad hoc in balance-builds.ts's `WisdomProbe` above. Full
field list: `ticks, damageDealt, damageTaken, damageAbsorbed, healingReceived,
hits, weakPoints, criticals, staggersCaused, staggersTaken, ticksStaggered,
resourceSpent, resourceRestored, castsCommitted, castsWithdrawn,
castsInterrupted, ticksRooted, backswingsCancelled, mobileOffenseTriggers,
cooldownTicksRefunded, cooldownRefundedByAbility, kills, deaths, abilityUses,
restorationEarned, motesGenerated, motesGuaranteed, motesCollected, motesLost,
restorationCollected, restorationWasted, fallbackUsed, restorationSources`.
`foldMetrics(into, entityId, tick, events, reasons)` (190) folds one tick's
`result.events` into one body's row; `foldPosture` (295) and `foldResource`
(308) are separate because rootedness and resource movement aren't events.
`summarise()` (409) turns raw counts into per-second/per-kill ratios.

## 3. `scripts/probe-constitution.ts` — the model to copy. 674 lines.

Structure (five/six sheets, each a `console.log` block):
- `CONTEXT: StepContext` built once (80-94): flat world, 13x13 chunk grid of
  `activeChunks` around `ORIGIN`, `spawnRateMultiplier: 0` (no ambient spawns).
- `recordAt(attributeValue, specializations)` (123-144) — builds a bare
  `PersistedPlayer` at one attribute value + explicit tier list, `STARTER_EQUIPMENT`,
  level 20. `tiersAt(value)` (106) fills in every specialization on that
  attribute's track whose `requires` threshold is met, at max tier.
- `bodyAt(record, healthFraction)` (147-160) — one-shot: `computeEffectiveStats`
  → `spawnEntity` → return the entity at a given health%, *no tick loop*. Used
  for sheets 1-4 (static derivation, e.g. calling `regenPoise`/`applyPoiseDamage`/
  `applyHealing` directly against a constructed entity, no `step()`).
- `fight(record, ticks, scenario)` (381-540) — **the real per-tick loop**:
  spawns self + N monsters (`spawnEntity`, ring-arranged, each given a distinct
  `spawnerId` to dodge the anti-farm decay), then for each tick: reads `before`,
  builds a `ServerInput` (policy `'hold'` stands still and auto-attacks;
  `'kite'` circles at `KITE_PACE=0.3` of full speed via
  `moveX/moveY: cos/sin(tick/40)*pace`), calls `step(state, [input], CONTEXT)`,
  reads `after`, diffs `before`/`after` by hand into a local accumulator
  (`Loop`: kills, taken, breaks, regen split by posture, secondWind, shield).
  Posture is read off `before.activity`/`before.cast`/position-delta, **not**
  off events. Second Wind is caught via a status-edge check
  (`hasStatus(before/after.statuses, StatusId.SecondWindSpent, tick)`).
- `LADDER` (554-561) = named attribute-value/tier-set contenders;
  `SCENARIOS` (563-568) = named `Scenario` objects (`{foes?, policy?,
  startHealth?}`) run against every ladder entry, printed as one table per
  scenario. Final "hybrids" section reuses `BUILD_PRESETS`/`fullSpreadOf` from
  presets.ts directly rather than its own ladder.

## 4. `npm run audit:progression` → `scripts/audit-progression.ts` (335 lines) — three passes

1. **Tier audit** — `auditProgression()` (`src/server/player/progression-audit.ts:561`)
   → `AuditReport{tiers, milestones, growth}`. Per specialization tier, per legal
   attribute value: does the purchase move a field on `EffectiveStats`/`TraitStats`?
   Verdicts `ACTIVE|REDUNDANT|INERT|BACKWARDS` (`Verdict`, progression-audit.ts:265),
   direction judged against the hand-written `TRAIT_DIRECTION` table (76).
2. **Reachability audit** — `auditReachability()` (progression-audit.ts:726) →
   `ReachabilityAudit[]`. Per `TraitGate` (631): can any row in the content
   tables (abilities/items/monsters) satisfy the gate a consumer reads?
   `unreachableTraits()` (750) filters to dead ones.
3. **Conditional-effect observation** — `observeAll()`
   (`src/server/sim/observed-effects.ts:526`) → `Observation[]`. **This is the
   API to copy for a resource-starvation scenario.** A `ConditionalProbe`
   (113-135) is: `{id, gate: string, attributes, specializations, equipment?,
   monster?: string (default 'dummy'), plan: Plan, observe: (frame, selfId) => boolean}`.
   `Plan` (84-111): `{ticks, attackWith, waitTicks?, moving?, startHealth?}`.
   Add a scenario by pushing one object literal onto `CONDITIONAL_PROBES`
   (380-524); `observeProbe()` (236) runs it (spawns self + one indestructible
   monster already engaged via `targetId`, loops `plan.ticks` calling `step()`,
   calls `probe.observe(frame, selfId)` every tick where `frame: {tick, self,
   previous, target, events}` — `previous` is pre-step, for gates that are a
   *change* (Guard regen, shield creation) not a state). Reports
   `{observed: count>0, count, blows, taken}` — `blows`/`taken` let a reader
   distinguish "never fired" from "scenario never attacked/was never hit", which
   is the check against false-negative noise the whole pass is designed around.

## 5. `npm run balance:perception` → `scripts/balance-perception.ts` (493 lines)

Five scenarios (`type Scenario = 'duel'|'mobile'|'pack'|'team'|'stream'`,
`run(build, scenario)`, 231-415), all built from **one** `run()` function keyed
on the scenario string (not five separate loops): `duel` = 1 durable monster
(`durability=40x` health so it survives the whole fight); `mobile` = same but
self circles when not ready to swing; `pack` = 5 monsters spread on a ring;
`team` = adds a second, Perception-less ally entity (spawned separately,
`allyId`) to see whether it benefits from Exposed the reader applied; `stream`
= `durability=1` (ordinary health) and respawns a fresh monster on death, the
only scenario where kills — and so Resource Sense's weak-point-kill heal —
actually happen. `BUILDS` (104-119) is a flat array of
`{name, attributes, tiers: Record<specializationId, tier>, weapon?, skill?,
patient?}`; `record(build)` (121) turns one into a `PersistedPlayer` (level 60,
flat baseStats merged with overrides). Per-tick counters are a plain `Counts`
object (168-204), incremented by hand from `result.events` (esp. `event.kind
=== 'hit'`, filtering `event.periodic` afflictions out of weak-point stats) —
same shape as probe-constitution's `Loop`, no shared type.

## 6. Minimal recipe for a new tick-driven probe (verified working shape)

```ts
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { createWorldState, spawnEntity, step, replaceEntity } from '../src/server/sim/world.js';
import { EntityKindValue, type ServerInput } from '../src/server/sim/types.js';
import { resourceCostFor } from '../src/server/sim/abilities.js';
// PersistedPlayer: id/displayName/baseStats(6 attrs)/specializations
// ([{specializationId,tier}])/equipment(EQUIP_SLOTS incl. skill1..4 = 'sigil.x'
// ids, mainHand = 'sword.worn')/inventory(emptyInventory())/position/facing/
// currentZone/level/experience/unspentProgressionPoints/health:0/resource:0/coins:0
const stats = computeEffectiveStats(record);          // -> EffectiveStats
let state = createWorldState(seed);                   // seeded, deterministic
const { state: s2, entity } = spawnEntity(state, {
  kind: EntityKindValue.Player, typeId: 'player', ownerPlayerId: record.id,
  position: {x,y,z:0}, stats, radius: 16, zoneId: 'greenmarch',
});
// per tick: build a ServerInput (all 15 fields — see ServerInput,
// src/server/sim/types.ts:778), castAbilityId:'' unless pressing, then:
const result = step(state, [input], context);          // -> {state, events}
const after = result.state.entities.get(selfId);       // read resource/health/cast here
```

`resourceCostFor(ability, {stats, statuses}, tick)` is the affordability check
(the minimal `TimingSubject = {stats, statuses?}`, abilities.ts:102-105) —
`balance-builds.ts`'s `cheapestCost()` (364-372) is exactly `min over
self.stats.skillAbilityIds of resourceCostFor(...)`, used as the "starved"
threshold. `regenerated(resource, regenPerTick, maxResource, ticks)`
(`src/server/sim/resource.ts:15`) is the closed-form regen curve if a probe
wants to project forward without stepping.

`StepContext` needs `world: DEFAULT_WORLD` (`src/sim/collision.js`),
`terrain: FLAT_TERRAIN`, `zones: new ZoneManager()`,
`config: {...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0}`, `activeChunks` (a
`Set<ChunkKey>` covering the fight — every existing script builds a ~13x13
`chunkKeyOf` grid around one origin), `chunkSize`, `spawnPoints: []`.

See `.claude/notes/ability-cost-cooldown-economy.md` for the full resource
cost/regen/cooldown pipeline arithmetic (`resourceCostFor`, `attackTimingFor`,
`traits.resourceCostScale`, `maxResource`/`resourceRegen` formulas) — that
note already has the Wisdom-side numbers a resource probe would compare
against.

No architecture violations found in any of these five files: all live under
`scripts/` (Node tooling, not linted as deterministic core but conventionally
kept pure) or `src/server/{sim,player,data}` (the deterministic core itself),
use only the seeded `createWorldState(seed)` PRNG, no `Math.random`/`Date.now`.
