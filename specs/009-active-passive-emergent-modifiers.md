# 009 — Active/passive cards and emergent modifiers

## Problem

Synergies (spec 002) were declarative: named rules that fire on tag
combinations and hand out a multiplier. That makes "synergy" an explicit,
pre-authored thing rather than something players discover. This spec replaces
it with **emergent** synergy: cards change actual game mechanics, and combos
arise from how those mechanics stack — nothing is named or announced.

Two card kinds:

- **Active** — the existing one-shot: played for an immediate effect, costs
  mana, and refills its slot from the deck (spec 004).
- **Passive** — its effect applies **while the card is held** (in a hand slot
  or the bonus slot). Playing a passive is how you *retire* it: it leaves the
  hand and its effect ends, and the slot refills like any other play. Passives
  cost no mana to retire.

Passives are **mechanic modifiers**, aggregated across every held card into a
single `Modifiers` value that the game layer passes into the sim each tick. The
sim applies them to real mechanics, so emergent strategies appear on their own,
e.g. "enemy attacks faster but for less" + "heal when you take damage" = a
sustain build; "+flat strike damage" + "every 2nd strike +20%" = a burst build.
The declarative `SynergyDef`/`getActiveSynergies` layer is removed.

## Shape

`src/cards/types.ts` — `CardDef` becomes a discriminated union on `kind`:
```ts
type ActiveEffect =
  | { kind:'damage'; amount } | { kind:'heal'; amount }
  | { kind:'buffDamage'; amount; durationTicks };

type PassiveEffect =
  | { kind:'attackDamage'; amount }                       // flat + per strike
  | { kind:'nthStrikeDamage'; everyN; bonusFraction }     // every Nth strike +x%
  | { kind:'healthRegen'; perSecond }
  | { kind:'manaRegen'; perSecond }
  | { kind:'healOnHurt'; amount }                         // heal when you take damage
  | { kind:'enemyTempo'; speedMultiplier; damageMultiplier }; // <1 speed = faster

type CardDef =
  | { id; name; tags; cost; kind:'active';  effect: ActiveEffect }
  | { id; name; tags; cost; kind:'passive'; passive: PassiveEffect };
```
`SynergyDef`/`SynergyEffect` and `src/cards/synergy.ts` are deleted.

`src/sim/types.ts` — `PlayerState` gains `strikeCount`. New `Modifiers` value
(all-identity `IDENTITY_MODIFIERS`) with: `attackDamageBonus`,
`nthStrikeEveryN`, `nthStrikeBonusFraction`, `healthRegenPerTick`,
`manaRegenPerTick`, `healOnHurt`, `enemySpeedMultiplier`,
`enemyDamageMultiplier`. New `SimEvent` `playerHealed`.

`src/sim/combat.ts` — `step(state, input, mods = IDENTITY_MODIFIERS)`:
- Each swing increments `strikeCount`; strike damage is
  `base + buffs + attackDamageBonus`, ×`(1+nthStrikeBonusFraction)` when the
  strike count lands on `nthStrikeEveryN`.
- Enemy phase durations are scaled by `enemySpeedMultiplier` at each transition;
  enemy hit damage is scaled by `enemyDamageMultiplier`.
- On taking damage (and surviving), heal `healOnHurt` → `playerHealed`.
- Regen adds `healthRegenPerTick` / `manaRegenPerTick` each tick, clamped.
Identity modifiers reproduce spec 007/008 behaviour exactly.

`src/game/session.ts` — `stepGame(state, input, catalog)` (no synergy arg):
computes `Modifiers` by folding the `PassiveEffect`s of all held cards (hand +
bonus slot), applies active vs passive play semantics, and passes the mods to
`step`. Aggregation: flats/regens/heals sum; enemy multipliers multiply;
`nthStrikeEveryN` = smallest positive `everyN`, its fraction = sum of fractions.
This is the only place cards become sim `Modifiers` / `ExternalEffect`.

Renderer shows the held passives (not a named synergy), flags each hand card as
active/passive, and flashes/logs `playerHealed`. Balance bot **holds** passives
and only plays actives, so archetypes express their held modifiers.

## Invariants tested

- Deck conservation / hand ≤ 3 (spec 002) and replay determinism (spec 003)
  still hold; identity-mods sim behaviour is unchanged.
- Holding a passive changes sim output (e.g. `vigor` regenerates health;
  `attackDamage` raises strike damage; `nthStrikeDamage` boosts exactly every
  Nth strike; `enemyTempo` shortens windup and lowers enemy damage;
  `healOnHurt` heals and emits `playerHealed`).
- Playing a passive removes it from hand and reverts its modifier next tick.
- An active card still applies its one-shot effect and spends mana; a passive
  costs no mana to retire.

## Out of scope

- Rebalancing numbers to equalise archetype win rates.
- Passive effects that need new sim state beyond a strike counter (e.g. stacks,
  timed passives) — the six above cover the requested examples.
- Any UI that pre-names a "synergy"; discovery is the point.
