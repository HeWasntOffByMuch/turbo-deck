# 022 — Chosen rewards, fusion tweaks & Burning Speed

## Problem

Wave 7 is near-impossible, so the player needs more agency and reach. Wave
rewards were random per offer; make Remove and Upgrade let the player *pick* the
card. Two fire fusions underperform: Blaze Aura ×2 changed behaviour (explosions)
instead of just getting stronger, and Fire Blast ×2 wants a bigger reach. And a
new fire card, Burning Speed, adds a high-tempo option with a burning payoff.

## Shape

### Rewards become a two-step pick (`src/game/spell-session.ts`, HUD)

The wave-clear panel still offers three actions, but Remove/Upgrade now open a
card picker instead of acting on a pre-rolled card. Add-fire stays a single
random-fire offer.

```ts
interface RewardOffer { kind: 'remove' | 'upgrade' | 'addFire'; cardId?: SpellId } // cardId only for addFire
interface RewardPick  { kind: 'remove' | 'upgrade'; candidates: SpellId[] }        // distinct deck ids
SpellGameState.pendingPick: RewardPick | null
SpellInput.chooseCard?: number  // index into pendingPick.candidates
```

- Choose Remove → `pendingPick` lists every distinct id in the deck.
- Choose Upgrade → `pendingPick` lists every distinct id **except attack & dash**.
- `chooseCard(i)` applies the edit to `candidates[i]` and clears the pick.
- Spawn Wave stays blocked while a reward or pick is open. Remove still refuses
  below a full hand (spec 021 floor).

### Fusion tweaks (`src/cards/synergy.ts`)

- Blaze Aura ×2 stays an **aura** (no behaviour change): bigger radius + more
  pulse damage, same duration/cadence.
- Fire Blast ×2 gets a **longer, wider cone and more damage**.

### Burning Speed — new fire card (`src/cards/spells.ts`, `synergy.ts`, sim)

A self-haste with a burning cost and an area payoff when it ends. Tiers by copies
(1/2/3): haste **30 / 42 / 45%**, foe-burn **3 / 8 / 9s**; you always suffer
Burning (7s, −4hp/s) while it runs; at the end nearby foes catch Burning.

```ts
SpellSpec: { kind:'burningSpeed'; hasteMult; durationTicks; selfBurnDps;
             foeBurnRadius; foeBurnDps; foeBurnDurationTicks }
```

New sim state (identity defaults): the player gains a move-haste multiplier +
expiry, a self-Burning drain + expiry, and a pending end-of-effect burn burst;
enemies gain an optional `burningUntilTick` + `burningDps`. Burning ticks on a
shared 0.5s cadence (deterministic integer damage); self-burn cannot drop the
player below 1 HP, enemy burn can kill.

## Invariants tested

- `resolveSynergies`: Blaze Aura ×2 is an `aura` with radius/pulseDamage above
  the single tier; Fire Blast ×2 has range/damage above the single tier; Burning
  Speed resolves to `burningSpeed` with 30/42/45% haste and 3/8/9s foe burn.
- Sim: a Burning Speed cast hastes the walk; self-burn drains health on cadence
  but never below 1; when the effect ends, foes in radius gain burning; a burning
  enemy loses health over time and can die from it. Determinism holds.
- Session: choosing Remove/Upgrade opens a pick with the right candidates
  (Upgrade excludes attack & dash); `chooseCard` applies it and clears the pick;
  Spawn Wave is ignored while a pick is open; same seed + inputs replay identically.

## Out of scope

- No change to wave scaling numbers; the extra player agency/reach is the lever.
- Add-fire reward stays random (only Remove/Upgrade are chosen).
- Upgrade still scales damage only; for Burning Speed it scales the foe-burn dps.
